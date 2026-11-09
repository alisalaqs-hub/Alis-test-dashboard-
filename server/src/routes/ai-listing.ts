/**
 * AI for people listing a property (sellers and landlords):
 *   POST /api/ai/listing/describe         "Write it for me" from the form's facts (rules enforced in code)
 *   POST /api/ai/listing/photos/preview   check up to 6 photos still in the browser (one vision call; consent required).
 *                                         Each result comes with a signed token: uploading the same file with it stores
 *                                         the result, so the photo isn't checked again (ai/listing/previewToken.ts).
 *   GET|PUT /api/ai/listing/photos/consent  the person's consent to photos being sent to our AI provider (give or withdraw)
 *   GET  /api/ai/listing/:ref/photos      stored photo analysis, suggested order and tips (lister, their agency, admin;
 *                                         no AI call, so it works while AI is off and doesn't use the AI allowance)
 *   POST /api/ai/listing/:ref/photos/check  (re)run the photo check for an existing listing (same; consent required)
 *   POST /api/ai/listing/price-guide      range from Streetkey's area evidence + AI explanation (no new figures)
 *   POST /api/ai/listing/precheck         compliance checks + wording rules + AI review, merged
 * Uploaded photos are checked in the background ('listing.photos' job, triggered by the photosUploaded hook), but only
 * for people who have consented ('ai_image_processing' in consents) and within a per-person daily allowance.
 * The AI allowance (per minute, per hour and daily) is charged only once a request is valid, the listing is the
 * person's own and the answer isn't already cached: rejected forms, refused uploads and cached answers cost nothing.
 */
import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { config } from '../config';
import { one, q } from '../db';
import { AiError, aiAvailable, cached } from '../ai/core';
import { aiAccess, aiCharge } from '../ai/guard';
import { on } from '../ai/hooks';
import { enqueue, jobDTO, registerJob, type JobRow } from '../ai/jobs';
import { describeListing, DescribeBody } from '../ai/listing/describe';
import { analyseBatch, imagesHash, isPlaceholderAlt, photoTips, PriorSchema, suggestOrder, type ImageIn, type PhotoAnalysis, type Summarisable } from '../ai/listing/photos';
import { precheck, PrecheckBody } from '../ai/listing/precheck';
import { PRICE_TIMING, PriceGuideBody, priceNarrative, priceRange } from '../ai/listing/price';
import { bytesHash, signPreview } from '../ai/listing/previewToken';
import { altTextProblem } from '../../../src/engine/listings';
import { audit, HttpError, parse, requireUser } from '../services/http';
import { enforce, hit } from '../services/ratelimit';
import { sniffImage } from '../services/images';
import { fetchableExternal, getFile } from '../services/storage';
import { editable } from './listings';

const PREVIEW_MAX_FILES = 6;
const PREVIEW_MAX_BYTES = 1.5 * 1024 * 1024;
/** Upper bound on photos one job run will check (listings allow 30). */
const JOB_MAX_PHOTOS = 40;
const JOB_BATCH = 4;
const CheckBody = z.object({ recheck: z.boolean().optional(), consent: z.boolean().optional() });
const DESCRIBE_LIMITS = { perMinute: 6, perHour: 40 };
const PREVIEW_LIMITS = { perMinute: 6, perHour: 40 };
const CHECK_LIMITS = { perMinute: 3, perHour: 20 };
const PRICE_LIMITS = { perMinute: 10, perHour: 60 };
const PRECHECK_LIMITS = { perMinute: 6, perHour: 40 };
const ConsentBody = z.object({ consent: z.boolean() });

/*
 * ---------- consent: photos are only sent to the AI provider with the person's explicit consent ----------
 * The listing photo check relies on a standing consent ("photos I add to my listings are checked too"), so it is
 * recorded as 'ai_image_processing' with its own wording version. One-off consents other features record for a single
 * upload (version '1', e.g. the Estimator) don't switch on background checks of listing photos.
 */
export const LISTING_PHOTO_CONSENT = 'listing-photos-1';
const CONSENT_MESSAGE = 'Please confirm you’re happy for your photos to be checked by our AI provider.';
export async function hasPhotoConsent(userId: string | null | undefined) {
  if (!userId) return false;
  return !!(await one(`SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing' AND version = $2 AND withdrawn_at IS NULL LIMIT 1`, [userId, LISTING_PHOTO_CONSENT]));
}
async function recordPhotoConsent(userId: string) {
  await q(`INSERT INTO consents (user_id, purpose, version) SELECT $1, 'ai_image_processing', $2
           WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing' AND version = $2 AND withdrawn_at IS NULL)`, [userId, LISTING_PHOTO_CONSENT]);
}
async function withdrawPhotoConsent(userId: string) {
  await q(`UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND purpose = 'ai_image_processing' AND version = $2 AND withdrawn_at IS NULL`, [userId, LISTING_PHOTO_CONSENT]);
}

/* ---------- per-person allowance for listing photo checks (vision calls in the last 24 hours) ---------- */
/** Each call checks up to 4 photos, so 20 calls is about 80 photos a day. Mutable so tests can lower it. */
export const photoLimits = { callsPerDay: 20 };
async function photoCallsLeft(userId: string | null | undefined) {
  if (!userId) return 0;
  const used = (await one<{ n: number }>(`SELECT count(*)::int n FROM ai_usage WHERE user_id = $1 AND purpose = 'listing.photos' AND at > now() - interval '24 hours'`, [userId]))?.n ?? 0;
  return Math.max(0, photoLimits.callsPerDay - used);
}
const LIMIT_MESSAGE = 'You’ve reached today’s limit for AI photo checks. Please try again tomorrow.';

/** Errors about the photos themselves (the model refused or couldn't describe one): retried photo by photo, never retried as a whole. */
const PER_PHOTO_ERRORS = new Set(['ai_refused', 'ai_bad_output', 'ai_truncated', 'ai_bad_request']);
const photoSpecific = (e: unknown) => e instanceof AiError && PER_PHOTO_ERRORS.has(e.code);

type PhotoRow = { id: string; url: string; alt: string | null; position: number; storage_key: string; content_type: string; ai_room: string | null; ai_alt: string | null; ai_quality: { score: number; issues: string[] } | null; ai_features: string[] | null; ai_flags: string[] | null; ai_checked_at: Date | null };

const analysisOf = (r: PhotoRow): PhotoAnalysis | null => (r.ai_room
  ? { room: r.ai_room as PhotoAnalysis['room'], alt: r.ai_alt ?? '', quality: { score: r.ai_quality?.score ?? 5, issues: (r.ai_quality?.issues ?? []) as PhotoAnalysis['quality']['issues'] }, features: r.ai_features ?? [], flags: (r.ai_flags ?? []) as PhotoAnalysis['flags'] }
  : null);
const summarisable = (a: PhotoAnalysis | null): Summarisable => ({ room: a?.room ?? null, score: a?.quality.score ?? null, issues: a?.quality.issues ?? [], flags: a?.flags ?? [] });

/** Images larger than this aren't sent to the vision model (the browser already resizes uploads to ~2,000px). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Total image bytes per vision call (base64 inflates this by a third). */
const BATCH_BYTES = 24 * 1024 * 1024;

/** External (agent feed) photos are only fetched from public HTTPS hosts (enforced again inside getFile). */
export { fetchableExternal };

/**
 * Check every not-yet-checked photo of a listing, up to 4 per vision call, storing results as each batch finishes.
 * Runs only for a person who has consented, and stops (leaving the rest unchecked) when their daily allowance is used up.
 * A photo the model refuses or can't describe is tried on its own once, then marked "couldn't be checked", so it never
 * blocks the rest of the listing.
 */
async function checkListingPhotos(job: JobRow, progress: (t: string) => Promise<void>) {
  const listingId = String(job.input?.listingId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return { checked: 0, skipped: 0, failed: 0 };
  if (!(await hasPhotoConsent(job.user_id))) return { checked: 0, skipped: 0, failed: 0, consent: false }; // withdrawn since it was queued
  const total = (await one<{ n: number }>('SELECT count(*)::int n FROM listing_photos WHERE listing_id = $1 AND ai_checked_at IS NULL', [listingId]))?.n ?? 0;
  let checked = 0, skipped = 0, failed = 0, limited = false, withdrawn = false;
  const skip = async (ids: string[]) => { if (ids.length) { await q('UPDATE listing_photos SET ai_checked_at = now() WHERE id = ANY($1)', [ids]); skipped += ids.length; } };
  // Checked, but no usable analysis: shown as "Couldn't be checked" (any earlier analysis is cleared, as it may no longer apply).
  const fail = async (ids: string[]) => { if (ids.length) { await q('UPDATE listing_photos SET ai_checked_at = now(), ai_room = NULL, ai_alt = NULL, ai_quality = NULL, ai_features = NULL, ai_flags = NULL WHERE id = ANY($1)', [ids]); failed += ids.length; } };
  const meta = { purpose: 'listing.photos', userId: job.user_id };
  // Consent and the allowance are checked before every call, so withdrawing consent stops a long run between batches.
  const vision = async (imgs: ImageIn[]) => {
    if (!(await hasPhotoConsent(job.user_id))) { withdrawn = true; return null; }
    if ((await photoCallsLeft(job.user_id)) <= 0) { limited = true; return null; }
    return analyseBatch(imgs, meta, { timeoutMs: config.ai.timeoutMs });
  };
  // Loops until nothing is left, so photos added while the job runs are picked up too (bounded).
  while (checked + skipped + failed < JOB_MAX_PHOTOS && !limited && !withdrawn) {
    const rows = await q<PhotoRow>(`SELECT * FROM listing_photos WHERE listing_id = $1 AND ai_checked_at IS NULL ORDER BY position, created_at LIMIT ${JOB_BATCH}`, [listingId]);
    if (!rows.length) break;
    const loaded = await Promise.all(rows.map(async (r) => {
      const bytes = fetchableExternal(r.storage_key) ? await getFile(r.storage_key).catch(() => null) : null;
      const type = bytes && bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : null;
      return { r, img: bytes && type ? ({ bytes, type } as ImageIn) : null };
    }));
    // Files that can't be read (e.g. an external feed photo whose host is down) are marked so the job doesn't loop on them.
    await skip(loaded.filter((x) => !x.img).map((x) => x.r.id));
    const usable: { r: PhotoRow; img: ImageIn }[] = [];
    let bytes = 0;
    for (const x of loaded) {
      if (!x.img) continue;
      if (usable.length && bytes + x.img.bytes.length > BATCH_BYTES) break; // the rest wait for the next round
      usable.push({ r: x.r, img: x.img }); bytes += x.img.bytes.length;
    }
    if (!usable.length) continue;
    // One outcome per usable photo: an analysis, 'failed', or undefined (not tried: allowance used up).
    let outcomes: (PhotoAnalysis | 'failed' | undefined)[];
    try {
      const results = await vision(usable.map((u) => u.img));
      outcomes = results ? results.map((a) => a ?? 'failed') : [];
    } catch (e) {
      if (!photoSpecific(e)) throw e; // timeouts, outages and budget errors: the job is retried or fails as a whole
      outcomes = [];
      if (usable.length === 1) outcomes.push('failed');
      else for (const u of usable) {
        try {
          const single = await vision([u.img]);
          if (!single) break;
          outcomes.push(single[0] ?? 'failed');
        } catch (e2) {
          if (!photoSpecific(e2)) throw e2;
          outcomes.push('failed');
        }
      }
    }
    for (const [i, u] of usable.entries()) {
      const a = outcomes[i];
      if (a === undefined) continue;
      if (a === 'failed') { await fail([u.r.id]); continue; }
      // Alt text is public: never with contact details or links (e.g. read off a sign in the photo); the room name instead.
      if (altTextProblem(a.alt)) a.alt = a.room.charAt(0).toUpperCase() + a.room.slice(1);
      // Only fill alt text that is empty or a filename ("photo 3"); never overwrite what the lister wrote, even if they changed it meanwhile.
      await q(`UPDATE listing_photos SET ai_room = $2, ai_alt = $3, ai_quality = $4, ai_features = $5, ai_flags = $6, ai_checked_at = now(),
                 alt = CASE WHEN coalesce(btrim(alt), '') = '' OR ($7::boolean AND alt IS NOT DISTINCT FROM $8) THEN $3 ELSE alt END
               WHERE id = $1`, [u.r.id, a.room, a.alt, JSON.stringify(a.quality), a.features, a.flags, isPlaceholderAlt(u.r.alt), u.r.alt]);
      checked++;
    }
    await progress(`Checked ${checked + skipped + failed} of ${Math.max(total, checked + skipped + failed)} photos`);
  }
  return { checked, skipped, failed, ...(limited ? { limited: true } : {}), ...(withdrawn ? { consent: false as const } : {}) };
}

export async function aiListingRoutes(app: FastifyInstance) {
  registerJob('listing.photos', async (job, ctx) => checkListingPhotos(job, ctx.progress), { maxAttempts: 2, leaseSec: 900 });

  // New photos are checked in the background (one queued job per listing at a time), only with the uploader's
  // consent and within their daily allowance. Each queued check also counts as one request towards their daily AI limit.
  on('photosUploaded', async ({ listingId, ref, photoIds, userId }) => {
    if (!aiAvailable() || !userId) return;
    // Photos checked in the browser before upload arrive with their stored result: nothing left to check.
    if (photoIds.length && !(await one('SELECT 1 FROM listing_photos WHERE id = ANY($1) AND ai_checked_at IS NULL LIMIT 1', [photoIds]))) return;
    if (!(await hasPhotoConsent(userId))) return;
    if ((await photoCallsLeft(userId)) <= 0) return;
    if (!(await hit(`ai.daily:u:${userId}`, config.ai.dailyRequestsPerUser, 86_400)).ok) return; // same counter as aiGuard's daily limit
    await enqueue('listing.photos', { listingId, ref }, { userId, subject: `listing:${ref}`, dedupe: true });
  });

  /* ---------- consent (not an AI call, so it works even when AI is switched off: withdrawing must always be possible) ---------- */
  app.get('/api/ai/listing/photos/consent', async (req) => {
    const u = requireUser(req);
    await enforce(req, 'ai.listing.consent', 60, 60, 'user');
    return { consented: await hasPhotoConsent(u.id) };
  });
  app.put('/api/ai/listing/photos/consent', async (req) => {
    const u = requireUser(req);
    await enforce(req, 'ai.listing.consent', 60, 60, 'user');
    const { consent } = parse(ConsentBody, req.body);
    if (consent) await recordPhotoConsent(u.id);
    else await withdrawPhotoConsent(u.id);
    await audit(req, consent ? 'consent.ai_images_granted' : 'consent.ai_images_withdrawn', `user:${u.id}`);
    return { consented: consent };
  });

  /* ---------- 1. description ---------- */
  app.post('/api/ai/listing/describe', async (req) => {
    const { userId } = await aiAccess(req, { auth: true });
    const body = parse(DescribeBody, req.body);
    await aiCharge(req, 'listing.describe', DESCRIBE_LIMITS);
    const result = await describeListing(body, { userId });
    return { ...result, label: 'AI draft written only from the details you entered. Check it carefully before publishing.' };
  });

  /* ---------- 2. photos: preview before upload ---------- */
  app.post('/api/ai/listing/photos/preview', async (req) => {
    const { userId } = await aiAccess(req, { auth: true });
    // Uploads are throttled on their own key, so a burst of refused uploads never uses up the AI allowance.
    await enforce(req, 'listing.photo_previews.m', 10, 60, 'user', 'You’re checking photos a bit fast. Please wait a moment and try again.');
    if (!req.isMultipart()) throw new HttpError(400, 'Send the photos as a form upload.', 'not_multipart');
    const images: (ImageIn & { name: string })[] = [];
    let priorRaw = '', consentRaw = '';
    try {
      for await (const part of req.parts({ limits: { fileSize: PREVIEW_MAX_BYTES, files: PREVIEW_MAX_FILES, fields: 4, fieldSize: 20_000 } })) {
        if (part.type === 'file') {
          const buf = await (part as MultipartFile).toBuffer();
          const type = sniffImage(buf);
          if (!type) throw new HttpError(400, `${(part as MultipartFile).filename || 'A file'} isn’t a JPEG, PNG or WebP photo.`, 'bad_photo', { photos: 'Use JPEG, PNG or WebP photos.' });
          images.push({ bytes: buf, type, name: String((part as MultipartFile).filename ?? '').slice(0, 80) });
        } else if (part.fieldname === 'prior') priorRaw = String(part.value ?? '');
        else if (part.fieldname === 'consent') consentRaw = String(part.value ?? '');
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'Each photo must be 1.5 MB or smaller for the AI check.', 'too_large', { photos: 'Use smaller photos (1.5 MB each).' });
      if (code === 'FST_FILES_LIMIT') throw new HttpError(413, `Check up to ${PREVIEW_MAX_FILES} photos at a time.`, 'too_many', { photos: `Up to ${PREVIEW_MAX_FILES} photos at a time.` });
      if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_INVALID_JSON_FIELD_ERROR') throw new HttpError(400, 'That upload wasn’t valid.', 'bad_request');
      throw e;
    }
    if (consentRaw !== 'true') throw new HttpError(400, CONSENT_MESSAGE, 'consent_required', { consent: 'Please tick to confirm.' });
    if (!images.length) throw new HttpError(400, 'Add at least one photo to check.', 'no_photos', { photos: 'Add at least one photo.' });
    let prior: Summarisable[] = [];
    if (priorRaw) {
      let raw: unknown;
      try { raw = JSON.parse(priorRaw); } catch { throw new HttpError(400, 'That upload wasn’t valid.', 'invalid', { prior: 'Invalid JSON.' }); }
      prior = parse(PriorSchema, raw);
    }
    await recordPhotoConsent(userId!);
    // Same photos, same answer: cache by content hash for a day (no images or prompts are stored).
    const raw = await cached(`listing.preview:${imagesHash(images)}`, 86_400, async () => {
      await aiCharge(req, 'listing.photos_preview', PREVIEW_LIMITS);
      return analyseBatch(images, { purpose: 'listing.photos_preview', userId });
    });
    // Alt text is public: never with contact details or links (e.g. read off a sign in the photo); the room name instead.
    const analyses = raw.map((a) => (a && altTextProblem(a.alt) ? { ...a, alt: a.room.charAt(0).toUpperCase() + a.room.slice(1) } : a));
    const all = [...prior, ...analyses.map(summarisable)];
    // A signed token per result: uploading exactly this file with it stores the result instead of checking it again.
    const tokens = await Promise.all(analyses.map((a, i) => (a ? signPreview(userId!, bytesHash(images[i].bytes), a) : null)));
    return {
      photos: analyses.map((a, i) => ({ index: i, name: images[i].name || null, analysis: a, token: tokens[i] })),
      suggestedOrder: suggestOrder(all),
      tips: photoTips(all),
      label: 'AI photo check. Room labels and alt text are suggestions: edit them as you like.',
    };
  });

  /* ---------- 2b. photos: stored analysis for a listing ---------- */
  app.get('/api/ai/listing/:ref/photos', async (req) => {
    const { ref } = req.params as { ref: string };
    // Reads what is already stored: no AI call, so no AI guard (works while AI is off and uses none of the AI allowance).
    requireUser(req);
    await enforce(req, 'listing.photos_read', 30, 60, 'user');
    const row = await editable(req, ref);
    const rows = await q<PhotoRow>('SELECT * FROM listing_photos WHERE listing_id = $1 ORDER BY position, created_at', [row.id]);
    const analyses = rows.map(analysisOf);
    const order = suggestOrder(analyses.map(summarisable));
    const job = await one<JobRow>(`SELECT * FROM ai_jobs WHERE kind = 'listing.photos' AND subject = $1 ORDER BY created_at DESC LIMIT 1`, [`listing:${row.ref}`]);
    return {
      photos: rows.map((r, i) => ({ id: r.id, url: r.url, alt: r.alt, position: i, checked: !!r.ai_checked_at, analysis: analyses[i] })),
      suggestedOrder: order.map((i) => rows[i].id),
      tips: photoTips(analyses.map(summarisable)),
      pending: rows.some((r) => !r.ai_checked_at),
      job: job && (job.user_id === req.user!.id || req.user!.role === 'admin') ? jobDTO(job) : null,
      consented: await hasPhotoConsent(req.user!.id),
      aiEnabled: aiAvailable(),
      label: 'AI photo check. Room labels and alt text are suggestions.',
    };
  });

  app.post('/api/ai/listing/:ref/photos/check', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const { userId } = await aiAccess(req, { auth: true });
    const row = await editable(req, ref);
    const { recheck, consent } = parse(CheckBody, req.body ?? {});
    if (consent === true) await recordPhotoConsent(userId!);
    else if (!(await hasPhotoConsent(userId))) throw new HttpError(400, CONSENT_MESSAGE, 'consent_required', { consent: 'Please tick to confirm.' });
    const left = await photoCallsLeft(userId);
    const counts = (await one<{ total: number; unchecked: number }>(
      'SELECT count(*)::int AS total, count(*) FILTER (WHERE ai_checked_at IS NULL)::int AS unchecked FROM listing_photos WHERE listing_id = $1', [row.id]))!;
    // A re-check resets every photo, so it must fit in what is left of today's allowance (nothing is reset otherwise).
    if (recheck && counts.total && left < Math.ceil(counts.total / JOB_BATCH)) throw new HttpError(429, LIMIT_MESSAGE, 'rate_limited');
    if (!(recheck ? counts.total : counts.unchecked)) return reply.send({ job: null, note: 'All photos have already been checked.' });
    if (left <= 0) throw new HttpError(429, LIMIT_MESSAGE, 'rate_limited');
    // There is something to check: now it counts towards the AI allowance (before anything is reset).
    await aiCharge(req, 'listing.photos_check', CHECK_LIMITS);
    if (recheck) await q('UPDATE listing_photos SET ai_checked_at = NULL WHERE listing_id = $1', [row.id]);
    const job = await enqueue('listing.photos', { listingId: row.id, ref: row.ref }, { userId, subject: `listing:${row.ref}`, dedupe: true });
    return reply.code(202).send({ job: jobDTO(job) });
  });

  /* ---------- 4. price guide ---------- */
  app.post('/api/ai/listing/price-guide', async (req) => {
    const deadline = Date.now() + PRICE_TIMING.budgetMs; // one budget for the whole request (Netlify answers within 30 s)
    const { userId } = await aiAccess(req, { auth: true });
    const body = parse(PriceGuideBody, req.body);
    const range = priceRange(body);
    // No evidence, no AI call: nothing is charged.
    if (!range) return { low: null, high: null, basis: null, position: null, narrative: null, note: 'There isn’t enough comparable evidence for this postcode yet.' };
    const { narrative } = await priceNarrative(body, range, { userId, deadline, charge: () => aiCharge(req, 'listing.price_guide', PRICE_LIMITS) });
    return {
      low: range.low, high: range.high, basis: range.basis, position: range.position, askingVsMidPct: range.askingVsMidPct, narrative,
      label: 'AI explanation of Streetkey’s indicative range. Not a valuation: the figures come from demonstration comparables, not the AI.',
    };
  });

  /* ---------- 5. pre-submission check ---------- */
  app.post('/api/ai/listing/precheck', async (req) => {
    const { userId } = await aiAccess(req, { auth: true });
    const body = parse(PrecheckBody, req.body);
    return precheck(body, { userId, charge: () => aiCharge(req, 'listing.precheck', PRECHECK_LIMITS) });
  });
}
