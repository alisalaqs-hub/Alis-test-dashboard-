/**
 * AI feature routes: property (renovation costs, investment analysis, homeowners).
 *
 *   POST /api/ai/refurb/from-photos  signed in, email confirmed · multipart (≤ 8 photos, ≤ 2 MB each, ≤ 4.5 MB in all) → 202 { jobId }
 *   POST /api/ai/refurb/explain      anyone · { input } → explanation of the recomputed estimate
 *   POST /api/ai/invest/explain      anyone · { propertyId?, strategy, inputs, scenario } → verdict
 *   POST /api/ai/my-home/plan        anyone · { home, goals, budget? } → ordered, costed plan
 *
 * Figures always come from Streetkey's engines; the AI only describes, explains and orders.
 * The AI allowance (per minute, per hour and daily) is charged only once a request is valid and
 * about to reach the model: rejected forms, cached answers and plans with nothing to cost are free.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { q } from '../db';
import { aiGuard, requireAi, type GuardOpts } from '../ai/guard';
import { enqueue, registerJob } from '../ai/jobs';
import { audit, HttpError, parse, requireUser } from '../services/http';
import { enforce } from '../services/ratelimit';
import { cleanImage, sniffImage, type ImageType } from '../services/images';
import { newKey, putFile } from '../services/storage';
import { explainEstimate } from '../ai/property/explain';
import { homePlan } from '../ai/property/home';
import { HomePlanZ, InvestExplainZ, PhotoFactsZ, RefurbExplainZ } from '../ai/property/inputs';
import { investVerdict } from '../ai/property/invest';
import { MAX_PHOTO_BYTES, MAX_PHOTOS, MAX_TOTAL_PHOTO_BYTES, PHOTOS_JOB, PHOTOS_MAX_ATTEMPTS, runPhotosJob } from '../ai/property/photos';

const MB = Math.round(MAX_PHOTO_BYTES / 1048576);
const TOTAL_MB = Math.round((MAX_TOTAL_PHOTO_BYTES / 1048576) * 10) / 10;

/** Photo analysis uses the vision model at high detail: only for accounts whose email is confirmed. */
export const VERIFY_EMAIL_MESSAGE = 'Confirm your email address to estimate from photos. We’ve sent you a link (check your spam folder too).';
const PHOTO_LIMITS: GuardOpts = { auth: true, verified: true, perMinute: 3, perHour: 12 };

/** Charges the person's AI allowance for `purpose` when called (see AiMeta.charge). */
const chargeFor = (req: FastifyRequest, purpose: string, o: GuardOpts) => async () => { await aiGuard(req, purpose, o); };

export async function aiPropertyRoutes(app: FastifyInstance) {
  registerJob(PHOTOS_JOB, runPhotosJob, { maxAttempts: PHOTOS_MAX_ATTEMPTS, leaseSec: 600 });

  /* ---------- 1. renovation estimate from photos (background job) ---------- */
  app.post('/api/ai/refurb/from-photos', async (req, reply) => {
    // Cheap checks first, before reading the upload; nothing is charged to the AI allowance yet.
    await requireAi();
    const user = requireUser(req);
    if (!user.email_verified_at) throw new HttpError(403, VERIFY_EMAIL_MESSAGE, 'verify_email');
    // Uploads are throttled on their own key so a burst of rejected uploads never uses up the AI allowance.
    await enforce(req, 'property.photo_uploads.m', 10, 60, 'user', 'You’re uploading photos a bit fast. Please wait a moment and try again.');
    if (!req.isMultipart()) throw new HttpError(400, 'Send the photos as a form upload.', 'not_multipart');

    const photos: { buf: Buffer; type: ImageType }[] = [];
    const fields: Record<string, string> = {};
    let total = 0;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS, fields: 6, fieldSize: 8_000 } })) {
        if (part.type === 'file') {
          const name = String((part as MultipartFile).filename ?? 'photo').slice(0, 60);
          const buf = await (part as MultipartFile).toBuffer();
          const type = sniffImage(buf);
          if (!type) throw new HttpError(400, `“${name}” isn’t a JPEG, PNG or WebP photo.`, 'bad_photo', { photos: 'Use JPEG, PNG or WebP photos.' });
          total += buf.length;
          if (total > MAX_TOTAL_PHOTO_BYTES) throw new HttpError(413, `These photos add up to more than ${TOTAL_MB} MB. Remove a photo or two, or use smaller ones.`, 'too_large', { photos: `Up to ${TOTAL_MB} MB in total.` });
          photos.push({ buf, type });
        } else fields[part.fieldname] = String(part.value);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `Each photo must be ${MB} MB or smaller.`, 'too_large', { photos: `Each photo must be ${MB} MB or smaller.` });
      if (code === 'FST_FILES_LIMIT') throw new HttpError(413, `Add up to ${MAX_PHOTOS} photos at a time.`, 'too_many', { photos: `Up to ${MAX_PHOTOS} photos.` });
      if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') throw new HttpError(400, 'That upload had unexpected extra fields.', 'bad_request');
      throw e;
    }
    if (fields.consent !== 'true') throw new HttpError(400, 'Please confirm you’re happy for these photos to be analysed by our AI provider.', 'consent_required', { consent: 'Please tick to confirm.' });
    if (!photos.length) throw new HttpError(400, 'Add at least one photo of the property.', 'no_photos', { photos: 'Add at least one photo.' });
    let factsJson: unknown;
    try { factsJson = JSON.parse(fields.facts ?? ''); } catch { throw new HttpError(400, 'Some details about the property are missing.', 'invalid', { facts: 'Missing property details.' }); }
    const facts = parse(PhotoFactsZ, factsJson);

    // Valid: now charge the allowance (and re-check AI is on and the email is confirmed).
    const { userId } = await aiGuard(req, 'property.refurb_photos', PHOTO_LIMITS);
    if (!userId) throw new HttpError(401, 'Please sign in to continue.', 'auth_required');
    const stored = await Promise.all(photos.map(async (p) => {
      const s = await putFile(newKey('ai/refurb', p.type), cleanImage(p.buf, p.type), p.type); // location metadata stripped
      return { key: s.key, type: p.type };
    }));
    await q(`INSERT INTO consents (user_id, purpose) SELECT $1, 'ai_image_processing' WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing' AND withdrawn_at IS NULL)`, [userId]);
    const job = await enqueue(PHOTOS_JOB, { photos: stored, facts }, { userId, subject: `refurb-photos:${userId}` });
    await audit(req, 'ai.refurb_photos', `ai_job:${job.id}`, { photos: stored.length });
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /* ---------- 2. explain an estimate ---------- */
  app.post('/api/ai/refurb/explain', async (req) => {
    await requireAi();
    const { input } = parse(RefurbExplainZ, req.body);
    return { explanation: await explainEstimate(input, { userId: req.user?.id ?? null, charge: chargeFor(req, 'property.refurb_explain', { perMinute: 6, perHour: 40 }) }) };
  });

  /* ---------- 3. investment verdict ---------- */
  app.post('/api/ai/invest/explain', async (req) => {
    await requireAi();
    const body = parse(InvestExplainZ, req.body);
    return { verdict: await investVerdict(body, { userId: req.user?.id ?? null, charge: chargeFor(req, 'property.invest_explain', { perMinute: 6, perHour: 40 }) }) };
  });

  /* ---------- 4. my home plan ---------- */
  app.post('/api/ai/my-home/plan', async (req) => {
    await requireAi();
    const body = parse(HomePlanZ, req.body);
    const meta = { userId: req.user?.id ?? null, charge: chargeFor(req, 'property.home_plan', { perMinute: 6, perHour: 30 }) };
    return { plan: await homePlan({ home: body.home, goals: body.goals, budget: body.budget ?? null }, meta) };
  });
}
