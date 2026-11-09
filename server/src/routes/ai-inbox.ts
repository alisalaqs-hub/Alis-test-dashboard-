/**
 * AI for listers' inboxes and listing performance:
 *   - spam/scam screen for new enquiries (setEnquiryScreener);
 *   - triage of each enquiry in the background (job 'inbox.triage', on enquiryCreated / new enquirer messages).
 *     Enquirers can't drive AI use: a refresh waits 10 minutes after the last triage, each enquiry is
 *     triaged at most 6 times a day, each lister's enquiries at most 300 times a day, and each sender
 *     sets off at most SENDER_AI_PER_DAY AI actions a day (screening and triage, across all listings).
 *     A message that arrives during the wait, or past a cap, is picked up when the lister next opens
 *     the conversation. Held-back (filtered) conversations are never triaged;
 *   - GET  /api/ai/inbox                      triage for all of the lister's conversations (for the inbox list);
 *                                             queues a few recent ones that have none
 *   - GET  /api/ai/inbox/:id                  triage for one conversation (lister only)
 *   - POST /api/ai/inbox/:id/suggest-reply    an editable, grounded reply draft (lister only; never sent;
 *                                             not for held-back conversations)
 *   - POST /api/ai/inbox/:id/unfilter         "Not spam": release a held-back conversation and email its held messages to the lister
 *   - GET  /api/ai/listings/:ref/insights     performance explained from code-computed stats (cached 12h)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiAvailable, cached } from '../ai/core';
import { aiAccess, aiCharge, aiGuard } from '../ai/guard';
import { on, setEnquiryScreener } from '../ai/hooks';
import { enqueue, processJob, registerJob } from '../ai/jobs';
import { enquiryScreener } from '../ai/inbox/screen';
import { runTriage, TRIAGE_SELECT, triageDTO, type TriageRow } from '../ai/inbox/triage';
import { REPLY_INTENTS, REPLY_TONES, suggestReply } from '../ai/inbox/reply';
import { computeStats, explainInsights, type ListingInsights } from '../ai/inbox/insights';
import { listerAccess, listerEmails, senderAiAllowed, titleOf } from '../ai/inbox/shared';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { audit, HttpError, parse, requireUser } from '../services/http';
import { enforce, hit } from '../services/ratelimit';
import { editable, orgIdsFor } from './listings';

const ReplyBody = z.object({
  intent: z.enum(REPLY_INTENTS),
  tone: z.enum(REPLY_TONES).default('friendly'),
  notes: z.string().trim().max(800, 'Keep notes under 800 characters.').optional().nullable(),
});

const INSIGHT_STATUSES = ['live', 'under_offer'];
/** "Not spam" emails the held messages together; a long run of them is summarised. */
const HELD_IN_EMAIL = 10;
const INSIGHTS_TTL = 12 * 3600;

/* Limits on background triage, which enquirers (not listers) set off by writing. */
const TRIAGE_COOLDOWN = '10 minutes';
const TRIAGES_PER_ENQUIRY_DAY = 6;
const TRIAGES_PER_LISTER_DAY = 300;

/**
 * Whether a triage may be queued for an enquiry now. A first triage is always allowed (within the
 * daily caps); a refresh only once the current one is 10 minutes old. No other triage may be queued
 * or running, at most 6 a day per enquiry, at most 300 a day across one lister's enquiries and, when
 * an enquirer's message set it off (senderKey), within that sender's daily AI allowance.
 */
export async function triageAllowed(enquiryId: string, senderKey?: string | null): Promise<boolean> {
  const r = await one<{ has: boolean; fresh: boolean; today: number; active: number; owner: string | null; org: string | null }>(
    `SELECT a.enquiry_id IS NOT NULL AS has, coalesce(a.updated_at > now() - interval '${TRIAGE_COOLDOWN}', false) AS fresh,
            count(j.id) FILTER (WHERE j.created_at > now() - interval '24 hours')::int AS today,
            count(j.id) FILTER (WHERE j.status IN ('queued', 'running'))::int AS active,
            l.owner_user_id AS owner, l.organisation_id AS org
       FROM enquiries e JOIN listings l ON l.id = e.listing_id
       LEFT JOIN enquiry_ai a ON a.enquiry_id = e.id
       LEFT JOIN ai_jobs j ON j.kind = 'inbox.triage' AND j.subject = 'enquiry:' || e.id::text
      WHERE e.id = $1 GROUP BY a.enquiry_id, a.updated_at, l.owner_user_id, l.organisation_id`, [enquiryId]);
  if (!r || (r.has && r.fresh) || r.active > 0 || r.today >= TRIAGES_PER_ENQUIRY_DAY) return false;
  if (senderKey && !(await senderAiAllowed(senderKey))) return false;
  const lister = r.owner ? `u:${r.owner}` : r.org ? `o:${r.org}` : null;
  if (lister && !(await hit(`ai.inbox.triage.lister:${lister}`, TRIAGES_PER_LISTER_DAY, 86_400)).ok) return false;
  return true;
}

/**
 * Queue a triage for an enquiry if the limits allow it (quick: the job does the AI work). Never throws.
 * senderKey: the enquirer whose message set it off; their allowance is checked and the usage charged to them.
 */
async function queueTriage(enquiryId: string, senderKey?: string | null) {
  if (!aiAvailable()) return null;
  try {
    if (!(await triageAllowed(enquiryId, senderKey))) return null;
    return await enqueue('inbox.triage', { enquiryId }, { subject: `enquiry:${enquiryId}`, dedupe: true, ...(senderKey ? { actor: senderKey } : {}) });
  } catch { return null; }
}
/** Held-back conversations are only triaged once the lister releases them. */
const isFiltered = async (enquiryId: string) => (await one<{ filtered: boolean }>('SELECT filtered FROM enquiries WHERE id = $1', [enquiryId]))?.filtered ?? true;

interface TriageJobState { id: string; status: 'queued' | 'running' | 'done' | 'failed'; stuck: boolean; retry_due: boolean; failures: number }
/** The latest triage job for an enquiry, and whether it is stuck (never picked up, or its worker died). */
const latestTriageJob = (enquiryId: string) => one<TriageJobState>(
  `SELECT id, status,
          (status = 'queued' AND created_at < now() - interval '10 seconds') OR (status = 'running' AND lease_until < now()) AS stuck,
          (status = 'failed' AND finished_at < now() - interval '5 minutes') AS retry_due,
          (SELECT count(*)::int FROM ai_jobs f WHERE f.kind = 'inbox.triage' AND f.subject = $1 AND f.status = 'failed' AND f.created_at > now() - interval '24 hours') AS failures
     FROM ai_jobs WHERE kind = 'inbox.triage' AND subject = $1 ORDER BY created_at DESC LIMIT 1`, [`enquiry:${enquiryId}`]);

/**
 * Background functions aren't available on every Netlify plan, and a worker can die. Triage is
 * quick and registered inlineSafe, so a stuck job is run here, inside the lister's request.
 */
async function unstick(enquiryId: string, job: TriageJobState | null) {
  if (!job?.stuck) return job;
  await processJob(job.id).catch(() => null);
  // Out of attempts while still marked running: close it so it can be retried later.
  await q(`UPDATE ai_jobs SET status = 'failed', error = coalesce(error, 'This took too long.'), finished_at = now(), lease_until = NULL
            WHERE id = $1 AND status = 'running' AND lease_until < now() AND attempts >= 2`, [job.id]);
  return latestTriageJob(enquiryId);
}

/** The stored triage misses enquirer messages that arrived during the cooldown, and is old enough to refresh. */
async function triageStale(enquiryId: string) {
  const r = await one<{ stale: boolean }>(
    `SELECT a.messages_seen < (SELECT count(*) FROM enquiry_messages m WHERE m.enquiry_id = a.enquiry_id AND m.author = 'enquirer')
            AND a.updated_at < now() - interval '${TRIAGE_COOLDOWN}' AS stale
       FROM enquiry_ai a WHERE a.enquiry_id = $1`, [enquiryId]);
  return !!r?.stale;
}

/* Catching up on missing triage from the inbox list: only the lister's most recent conversations, a few per visit. */
const BACKFILL_WINDOW = 20;
const BACKFILL_PER_VISIT = 5;
/**
 * Queues triage for the lister's recent, not held-back conversations that have none, and returns their ids.
 * Skipped: one with a triage job queued, running, failed or skipped in the last day (opening it retries
 * a failure), unless that job's triage was stored and has since been removed. Charged to the lister,
 * rate-limited like opening a conversation, and inside the per-enquiry and per-lister caps. Never throws.
 */
async function backfillTriage(req: FastifyRequest, userId: string, orgs: string[]): Promise<string[]> {
  if (!aiAvailable()) return [];
  try {
    const missing = await q<{ id: string }>(
      `WITH recent AS (
         SELECT e.id, e.created_at FROM enquiries e JOIN listings l ON l.id = e.listing_id
          WHERE (l.owner_user_id = $1 OR l.organisation_id = ANY($2)) AND NOT e.filtered
          ORDER BY e.created_at DESC LIMIT ${BACKFILL_WINDOW})
       SELECT r.id FROM recent r
        WHERE NOT EXISTS (SELECT 1 FROM enquiry_ai a WHERE a.enquiry_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.kind = 'inbox.triage' AND j.subject = 'enquiry:' || r.id::text
                AND j.created_at > now() - interval '1 day'
                AND NOT (j.status = 'done' AND coalesce(j.output->>'stored', '') = 'true'))
        ORDER BY r.created_at DESC LIMIT ${BACKFILL_PER_VISIT}`, [userId, orgs]);
    if (!missing.length) return [];
    await aiGuard(req, 'inbox.triage', { auth: true, perMinute: 20 });
    const queued: string[] = [];
    for (const { id } of missing) {
      const job = await queueTriage(id);
      if (job?.status === 'queued' || job?.status === 'running') queued.push(id);
    }
    return queued;
  } catch { return []; }
}

export async function aiInboxRoutes(app: FastifyInstance) {
  /* ───────── background work and hooks ───────── */
  registerJob('inbox.triage', async (job) => runTriage(String(job.input?.enquiryId ?? '')), { maxAttempts: 2, leaseSec: 120, inlineSafe: true });
  setEnquiryScreener(enquiryScreener);
  on('enquiryCreated', async ({ enquiryId, senderKey }) => {
    if (!aiAvailable() || (await isFiltered(enquiryId))) return;
    await queueTriage(enquiryId, senderKey);
  });
  // A follow-up from the enquirer refreshes the triage, within the limits above (the lister's own replies never do).
  on('enquiryMessage', async ({ enquiryId, author, senderKey }) => {
    if (author !== 'enquirer' || !aiAvailable() || (await isFiltered(enquiryId))) return;
    await queueTriage(enquiryId, senderKey);
  });

  /* ───────── triage ───────── */
  /**
   * Triage for every conversation the signed-in person handles as lister (the inbox chips). Recent
   * conversations without a triage (from before triage existed, or whose stored triage was dropped
   * when the checks got stricter) are queued here, a few per visit and within the lister's limits,
   * so the chips come back without opening each one. `pending`: queued ones still being read.
   */
  app.get('/api/ai/inbox', async (req) => {
    const u = requireUser(req);
    const orgs = await orgIdsFor(u.id);
    const pending = await backfillTriage(req, u.id, orgs);
    const rows = await q<TriageRow>(
      `${TRIAGE_SELECT} JOIN listings l ON l.id = e.listing_id
        WHERE (l.owner_user_id = $1 OR l.organisation_id = ANY($2)) AND NOT e.filtered
        ORDER BY e.created_at DESC LIMIT 200`, [u.id, orgs]);
    const items = Object.fromEntries(rows.map((r) => [r.enquiry_id, triageDTO(r)]));
    return { items, pending: pending.filter((id) => !(id in items)) };
  });

  app.get('/api/ai/inbox/:id', async (req) => {
    const { e } = await listerAccess(req, (req.params as { id: string }).id);
    const on = aiAvailable();
    const base = { filtered: e.filtered, filterReason: e.filtered ? e.filter_reason : null, aiAvailable: on };
    const load = () => one<TriageRow>(`${TRIAGE_SELECT} WHERE a.enquiry_id = $1`, [e.id]);
    const unavailable = { ...base, status: 'unavailable', triage: null };
    const pending = { ...base, status: 'pending', triage: null };
    const ready = (r: TriageRow) => ({ ...base, status: 'ready', triage: triageDTO(r) });
    /** An AI request made on the lister's behalf (first open, a retry or a refresh): rate-limited like any other. */
    const guarded = async () => { try { await aiGuard(req, 'inbox.triage', { auth: true, perMinute: 20 }); return true; } catch { return false; } };

    let job = on && !e.filtered ? await unstick(e.id, await latestTriageJob(e.id)) : null;
    const active = job?.status === 'queued' || job?.status === 'running';
    let row = await load();
    if (row) {
      // Messages that arrived during the cooldown: refresh now that the lister is looking.
      if (on && !e.filtered && !active && (await triageStale(e.id)) && (await guarded()) && (await queueTriage(e.id))) row = (await load()) ?? row;
      return ready(row);
    }
    if (e.filtered) return { ...base, status: 'filtered', triage: null };
    if (!on) return unavailable;
    if (active) return pending;
    // A failed triage is retried once, after a pause; after that it stays unavailable until the enquirer writes again.
    if (job?.status === 'failed' && !(job.retry_due && job.failures < 2)) return unavailable;
    // Conversations from before triage existed (or a retry): triage once, on open.
    if (!(await guarded())) return unavailable;
    if (!(await queueTriage(e.id))) return unavailable;
    row = await load();
    if (row) return ready(row);
    job = await latestTriageJob(e.id);
    return job?.status === 'failed' ? unavailable : pending;
  });

  /* ───────── reply drafts ───────── */
  app.post('/api/ai/inbox/:id/suggest-reply', async (req) => {
    const { userId } = await aiAccess(req, { auth: true });
    const { e } = await listerAccess(req, (req.params as { id: string }).id);
    // A held-back message is never sent to the model or drafted for (and no AI allowance is used).
    if (e.filtered) throw new HttpError(409, 'Move this message to your inbox (choose “Not spam”) before drafting a reply.', 'filtered');
    const b = parse(ReplyBody, req.body ?? {});
    // Valid, and the lister's own conversation: now it counts towards the AI allowance.
    await aiCharge(req, 'inbox.reply', { perMinute: 10, perHour: 80 });
    const out = await suggestReply(e, { intent: b.intent, tone: b.tone, notes: b.notes }, userId!);
    return { reply: out.reply, placeholders: out.placeholders, warnings: out.warnings, aiNotes: out.aiNotes };
  });

  /* ───────── "Not spam" ───────── */
  app.post('/api/ai/inbox/:id/unfilter', async (req) => {
    await enforce(req, 'inbox.unfilter', 30, 60, 'user');
    const { e } = await listerAccess(req, (req.params as { id: string }).id);
    const out = await tx(async (c) => {
      const released = await one<{ id: string }>('UPDATE enquiries SET filtered = false, filter_reason = NULL WHERE id = $1 AND filtered RETURNING id', [e.id], c);
      if (!released) return null;
      const held = await q<{ id: string; body: string; created_at: Date }>(`UPDATE enquiry_messages SET held = false WHERE enquiry_id = $1 AND held RETURNING id, body, created_at`, [e.id], c);
      const first = await one<{ id: string; body: string; created_at: Date }>(`SELECT id, body, created_at FROM enquiry_messages WHERE enquiry_id = $1 AND author = 'enquirer' ORDER BY created_at LIMIT 1`, [e.id], c);
      return { held: held.sort((a, b) => a.created_at.getTime() - b.created_at.getTime()), first };
    });
    if (!out) return { ok: true, filtered: false, emailed: 0 };
    // Every message the screen held back (from the first one, or from the follow-up it caught), in one email.
    const held = out.held.length ? out.held : out.first ? [out.first] : [];
    const opening = !!out.first && held.some((m) => m.id === out.first!.id);
    const shown = held.slice(0, HELD_IN_EMAIL);
    const text = [shown.map((m) => m.body).join('\n\n'), held.length > shown.length ? `(${held.length - shown.length} more message${held.length - shown.length === 1 ? '' : 's'} in your inbox.)` : ''].filter(Boolean).join('\n\n');
    const to = await listerEmails(e);
    for (const addr of to) {
      if (opening) await mails.enquiryToLister(addr, titleOf(e), e.ref, e.name, e.kind, text, e.preferred_slot);
      else await mails.replyToLister(addr, titleOf(e), text);
    }
    await audit(req, 'enquiry.unfiltered', `listing:${e.ref}`, { enquiry: e.id });
    await queueTriage(e.id);
    return { ok: true, filtered: false, emailed: to.length };
  });

  /* ───────── listing performance ───────── */
  /*
   * The AI allowance is charged only when a new explanation is written: an unknown or someone else's listing, one that
   * isn't live yet, and a cached explanation cost nothing (reading the stats has its own, generous limit).
   */
  app.get('/api/ai/listings/:ref/insights', async (req) => {
    const { userId } = await aiAccess(req, { auth: true });
    await enforce(req, 'inbox.insights_read', 60, 60, 'user');
    const { ref } = req.params as { ref: string };
    if (!/^[A-Za-z0-9-]{3,40}$/.test(ref)) throw new HttpError(404, 'That listing could not be found.', 'not_found');
    const row = await editable(req, ref);
    if (!INSIGHT_STATUSES.includes(row.status)) throw new HttpError(409, 'Insights are available once the listing is live.', 'not_live');
    const stats = await computeStats(row);
    // One explanation per listing version for 12 hours (edits and photo changes start a fresh one).
    const key = `inbox.insights:v1:${row.id}:${row.updated_at.getTime()}:${stats.photoCount}`;
    const out = await cached<ListingInsights>(key, INSIGHTS_TTL, async () => {
      await aiCharge(req, 'inbox.insights', { perMinute: 20, perHour: 120 });
      return explainInsights(row, stats, userId!);
    });
    return out;
  });
}
