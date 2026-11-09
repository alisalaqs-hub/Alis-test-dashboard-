/**
 * Enquiries: buyers and tenants message listers, and the conversation continues in the inbox.
 *
 * Every message from an enquirer is screened for spam and scams (the AI inbox feature provides the
 * screener; without it, nothing is held). A held-back conversation is kept but not emailed to the
 * lister, and later messages in it are held too, until the lister chooses "Not spam". The enquirer
 * is never told: their message is accepted the same way either way.
 *
 * Limits: 5 enquiries a minute and 30 a day per network, 3 an hour per email address per listing.
 * Admins can read any conversation (for safety reviews) but can't post in it.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EnquirySummaryDTO, MessageDTO } from '../../../src/lib/apiTypes';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { audit, HttpError, notFound, parse, requireUser } from '../services/http';
import { PUBLIC_STATUSES, streetOnly } from '../services/listings';
import { orgIdsFor } from './listings';
import { anonId, enforce, limit } from '../services/ratelimit';
import { emit, screenEnquiry } from '../ai/hooks';
import { UUID_RE } from '../ai/inbox/shared';

const Enquiry = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(80),
  email: z.email('Enter a valid email address.').max(254),
  phone: z.string().trim().max(30).regex(/^[+\d\s()-]*$/, 'Use digits, spaces and + only.').optional().nullable(),
  kind: z.enum(['viewing', 'question', 'offer']),
  message: z.string().trim().min(2, 'Add a short message.').max(3000),
  preferredSlot: z.string().trim().max(80).optional().nullable(),
  website: z.string().max(0).optional(), // honeypot: real people never fill this in
});

/** Enquiries from one network in a day: plenty for anyone house-hunting, and a ceiling on what a script can send. */
const ENQUIRIES_PER_DAY = 30;
const dailyEnquiryCap = async (req: FastifyRequest) => {
  await enforce(req, 'enquiry.create.d', ENQUIRIES_PER_DAY, 86_400, 'ip', 'You’ve sent a lot of messages today. Please try again tomorrow.');
};

/** Who receives enquiries for a listing: the lister, or the agency's members. */
async function listerEmails(listing: { owner_user_id: string | null; organisation_id: string | null }) {
  return (await q<{ email: string }>(
    `SELECT DISTINCT u.email FROM users u WHERE u.deleted_at IS NULL AND (u.id = $1 OR u.id IN (SELECT user_id FROM memberships WHERE organisation_id = $2 AND role IN ('owner', 'admin')))`,
    [listing.owner_user_id, listing.organisation_id])).map((r) => r.email);
}

/**
 * Emails go out after the enquiry or message is stored. A failure here must not turn a stored
 * message into an error (the sender would retry and send it twice): it is logged, without content.
 */
async function notify(req: FastifyRequest, what: string, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { req.log.warn({ what, code: (e as { code?: string }).code ?? 'error' }, 'enquiry notification failed'); }
}

type Row = { filtered: boolean; filter_reason: string | null; id: string; listing_id: string; from_user_id: string | null; email: string; name: string; phone: string | null; kind: EnquirySummaryDTO['kind']; status: EnquirySummaryDTO['status']; preferred_slot: string | null; created_at: Date;
  ref: string; title: string | null; address_line: string; town: string; price: number; channel: 'sale' | 'rent'; owner_user_id: string | null; organisation_id: string | null };

/**
 * The conversation and the caller's part in it: 'lister' (listing owner or agency member), 'enquirer'
 * (who sent it, or the verified owner of its email address), or 'admin' (a site admin who is neither:
 * read-only, so nothing they write can appear to come from the buyer).
 */
async function access(req: FastifyRequest, id: string) {
  const u = requireUser(req);
  if (!UUID_RE.test(id)) throw notFound('That conversation');
  const e = await one<Row>(`SELECT e.*, l.ref, l.title, l.address_line, l.town, l.price, l.channel, l.owner_user_id, l.organisation_id FROM enquiries e JOIN listings l ON l.id = e.listing_id WHERE e.id = $1`, [id]);
  if (!e) throw notFound('That conversation');
  const orgs = await orgIdsFor(u.id);
  const lister = e.owner_user_id === u.id || (!!e.organisation_id && orgs.includes(e.organisation_id));
  const enquirer = e.from_user_id === u.id || (!!u.email_verified_at && e.email.toLowerCase() === u.email.toLowerCase());
  if (!lister && !enquirer && u.role !== 'admin') throw new HttpError(403, 'This conversation isn’t available to your account.', 'forbidden');
  return { e, role: (lister ? 'lister' : enquirer ? 'enquirer' : 'admin') as 'lister' | 'enquirer' | 'admin' };
}

/** How a conversation refers to the home: never with the house number (the enquirer may not have it). */
const titleOf = (e: Pick<Row, 'title' | 'address_line' | 'town'>) => e.title || `${streetOnly(e.address_line)}, ${e.town}`;
const reasonOf = (reason: string | undefined) => (reason ?? 'Held back as likely spam.').slice(0, 300);

export async function enquiryRoutes(app: FastifyInstance) {
  app.post('/api/listings/:ref/enquiries', { preHandler: [limit('enquiry.create', 5, 60), dailyEnquiryCap] }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const b = parse(Enquiry, req.body);
    if (b.website) return reply.code(201).send({ ok: true }); // quietly drop bots
    const l = await one<{ id: string; ref: string; title: string | null; address_line: string; town: string; status: string; owner_user_id: string | null; organisation_id: string | null }>(
      'SELECT id, ref, title, address_line, town, status, owner_user_id, organisation_id FROM listings WHERE ref = $1', [ref]);
    if (!l || !PUBLIC_STATUSES.includes(l.status as never)) throw notFound('That listing');
    if (req.user && l.owner_user_id === req.user.id) throw new HttpError(409, 'This is your own listing.', 'own_listing');
    const recent = await one<{ n: number }>(`SELECT count(*)::int n FROM enquiries WHERE listing_id = $1 AND email = $2 AND created_at > now() - interval '1 hour'`, [l.id, b.email]);
    if (recent!.n >= 3) throw new HttpError(429, 'You’ve already sent a few messages about this home. The lister will reply by email.', 'rate_limited');

    // Screen first, then store the enquiry already marked, so a held-back message is never visible
    // unfiltered in the lister's inbox while the screen runs, and nothing can fail after it's stored.
    const senderKey = req.user ? `u:${req.user.id}` : anonId(req.ip);
    const id = randomUUID();
    const verdict = await screenEnquiry({ enquiryId: id, listingId: l.id, name: b.name, email: b.email, message: b.message, kind: b.kind, senderKey });
    await tx(async (c) => {
      await q(`INSERT INTO enquiries (id, listing_id, from_user_id, name, email, phone, kind, preferred_slot, filtered, filter_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, l.id, req.user?.id ?? null, b.name, b.email, b.phone || null, b.kind, b.preferredSlot || null, verdict.filter, verdict.filter ? reasonOf(verdict.reason) : null], c);
      await q(`INSERT INTO enquiry_messages (enquiry_id, author, author_user_id, body, held) VALUES ($1, 'enquirer', $2, $3, $4)`, [id, req.user?.id ?? null, b.message, verdict.filter], c);
    });
    // Held-back enquiries are kept (the lister sees them under "Filtered") but not emailed.
    if (!verdict.filter) await notify(req, 'enquiry_received', async () => { for (const to of await listerEmails(l)) await mails.enquiryToLister(to, titleOf(l), l.ref, b.name, b.kind, b.message, b.preferredSlot); });
    await audit(req, 'enquiry.created', `listing:${ref}`, { kind: b.kind, enquiry: id });
    await emit('enquiryCreated', { enquiryId: id, listingId: l.id, senderKey });
    return reply.code(201).send({ ok: true, id });
  });

  /** Conversations about your listings (as lister) and the ones you started (as enquirer). */
  app.get('/api/me/inbox', async (req) => {
    const u = requireUser(req);
    const orgs = await orgIdsFor(u.id);
    const rows = await q<Row & { messages: number; last_body: string | null; last_author: 'enquirer' | 'lister' | null; last_at: Date | null; is_lister: boolean }>(
      `SELECT e.*, l.ref, l.title, l.address_line, l.town, l.price, l.channel, l.owner_user_id, l.organisation_id,
              (l.owner_user_id = $1 OR l.organisation_id = ANY($2)) AS is_lister,
              (SELECT count(*)::int FROM enquiry_messages m WHERE m.enquiry_id = e.id) AS messages,
              lm.body AS last_body, lm.author AS last_author, lm.created_at AS last_at
         FROM enquiries e JOIN listings l ON l.id = e.listing_id
         LEFT JOIN LATERAL (SELECT body, author, created_at FROM enquiry_messages m WHERE m.enquiry_id = e.id ORDER BY created_at DESC LIMIT 1) lm ON true
        WHERE l.owner_user_id = $1 OR l.organisation_id = ANY($2) OR e.from_user_id = $1 OR ($3::boolean AND e.email = $4)
        ORDER BY coalesce(lm.created_at, e.created_at) DESC LIMIT 200`, [u.id, orgs, !!u.email_verified_at, u.email]);
    const items: EnquirySummaryDTO[] = rows.map((r) => ({
      id: r.id, kind: r.kind, status: r.status, role: r.is_lister ? 'lister' : 'enquirer',
      filtered: r.is_lister ? r.filtered : false, filterReason: r.is_lister ? r.filter_reason : null,
      listing: { ref: r.ref, title: titleOf(r), price: r.price, channel: r.channel },
      name: r.name, email: r.is_lister ? r.email : null, phone: r.is_lister ? r.phone : null, preferredSlot: r.preferred_slot,
      lastMessage: r.last_body ? { body: r.last_body, author: r.last_author!, at: r.last_at!.toISOString() } : null,
      messages: r.messages, createdAt: r.created_at.toISOString(),
    }));
    return { items, unread: items.filter((i) => i.role === 'lister' && i.status === 'new' && !i.filtered).length };
  });

  app.get('/api/enquiries/:id', async (req) => {
    const { e, role } = await access(req, (req.params as { id: string }).id);
    const msgs = await q<{ id: string; author: MessageDTO['author']; body: string; held: boolean; created_at: Date }>('SELECT id, author, body, held, created_at FROM enquiry_messages WHERE enquiry_id = $1 ORDER BY created_at', [e.id]);
    const lister = role === 'lister';
    return {
      role, status: e.status, kind: e.kind, preferredSlot: e.preferred_slot,
      // Only the lister learns that the screen held the conversation back (never the enquirer).
      ...(lister ? { filtered: e.filtered, filterReason: e.filtered ? e.filter_reason : null } : {}),
      listing: { ref: e.ref, title: titleOf(e), price: e.price, channel: e.channel },
      contact: lister ? { name: e.name, email: e.email, phone: e.phone } : { name: e.name },
      messages: msgs.map((m) => ({ id: m.id, author: m.author, body: m.body, at: m.created_at.toISOString(), ...(lister && m.held ? { held: true } : {}) })),
    };
  });

  app.post('/api/enquiries/:id/messages', { preHandler: limit('enquiry.reply', 20, 60, 'user-or-ip') }, async (req, reply) => {
    const { e, role } = await access(req, (req.params as { id: string }).id);
    if (role === 'admin') throw new HttpError(403, 'Admins can read this conversation but can’t post in it.', 'forbidden');
    const { body } = parse(z.object({ body: z.string().trim().min(1, 'Write a message.').max(3000) }), req.body);
    const u = req.user!;
    const senderKey = `u:${u.id}`;
    // An enquirer's follow-up is screened like a new enquiry. In a held-back conversation it is held
    // too: the lister isn't emailed until they choose "Not spam".
    let held = false;
    let reason: string | null = null;
    if (role === 'enquirer') {
      if (e.filtered) held = true;
      else {
        const verdict = await screenEnquiry({ enquiryId: e.id, listingId: e.listing_id, name: e.name, email: e.email, message: body, kind: e.kind, senderKey, followUp: true });
        if (verdict.filter) { held = true; reason = reasonOf(verdict.reason); }
      }
    }
    await tx(async (c) => {
      await q(`INSERT INTO enquiry_messages (enquiry_id, author, author_user_id, body, held) VALUES ($1, $2, $3, $4, $5)`, [e.id, role, u.id, body, held], c);
      if (reason) await q('UPDATE enquiries SET filtered = true, filter_reason = $2 WHERE id = $1 AND NOT filtered', [e.id, reason], c);
      if (role === 'lister') await q(`UPDATE enquiries SET status = 'replied' WHERE id = $1 AND status = 'new'`, [e.id], c);
    });
    if (reason) await audit(req, 'enquiry.filtered', `listing:${e.ref}`, { enquiry: e.id, followUp: true });
    await emit('enquiryMessage', { enquiryId: e.id, author: role, senderKey });
    if (role === 'lister') await notify(req, 'enquiry_reply', () => mails.replyToEnquirer(e.email, titleOf(e), body));
    else if (!held) await notify(req, 'enquiry_followup', async () => { for (const to of await listerEmails(e)) await mails.replyToLister(to, titleOf(e), body); });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/enquiries/:id', async (req) => {
    const { e, role } = await access(req, (req.params as { id: string }).id);
    if (role !== 'lister' && role !== 'admin') throw new HttpError(403, 'Only the lister can change the status of this conversation.', 'forbidden');
    const { status } = parse(z.object({ status: z.enum(['new', 'replied', 'closed']) }), req.body);
    await q('UPDATE enquiries SET status = $2 WHERE id = $1', [e.id, status]);
    return { status };
  });
}
