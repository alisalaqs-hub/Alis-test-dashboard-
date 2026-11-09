/**
 * AI room redesign as a background job.
 *
 *   POST /api/ai/room-image stores the photo, inserts an ai_images row (running) and enqueues
 *   'studio.room_image' → this handler restyles the photo with OpenAI image editing, stores the
 *   result and marks the row done (or failed, with a message that is safe to show).
 *   The browser polls GET /api/ai/jobs/:id.
 */
import type { AiImageDTO } from '../../../../src/lib/apiTypes';
import { config } from '../../config';
import { one, pool, q, type Q } from '../../db';
import { HttpError } from '../../services/http';
import { sniffImage } from '../../services/images';
import { editRoomImage } from '../../services/openai';
import { getFile, newKey, putFile } from '../../services/storage';
import { AiError } from '../core';
import { registerJob, type JobRow } from '../jobs';

export const ROOM_IMAGE_JOB = 'studio.room_image';
export const ROOM_IMAGE_LABEL = 'AI-generated concept. Not a photo of a finished room.';
const MAX_ATTEMPTS = 2;
/** Mirrors the job runner: these failures are retried while attempts remain. */
const RETRIABLE = new Set(['ai_timeout', 'ai_network', 'ai_upstream', 'ai_busy']);

export type ImageRow = { id: string; user_id: string | null; room: string; style: string; brief: string | null; prompt: string; status: AiImageDTO['status']; result_key: string | null; result_url: string | null; source_key: string | null; model: string; error: string | null; created_at: Date; finished_at: Date | null };

export const imageDTO = (r: ImageRow): AiImageDTO => ({
  id: r.id, room: r.room, style: r.style, brief: r.brief, status: r.status, url: r.result_url,
  sourceUrl: r.source_key ? (config.storage.driver === 's3' ? `${config.storage.s3.publicBaseUrl}/${r.source_key}` : `/media/${r.source_key}`) : null,
  model: r.model, error: r.error, createdAt: r.created_at.toISOString(),
});

/** Designs that count towards today's limit (running or done in the last 24 hours). */
export async function imagesUsedToday(userId: string, db: Q = pool) {
  return (await one<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE user_id = $1 AND status <> 'failed' AND created_at > now() - interval '24 hours'`, [userId], db))!.n;
}

/** Designs started across the whole site in the last 24 hours (failed ones don't count). */
export async function imagesUsedSite(db: Q = pool) {
  return (await one<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE status <> 'failed' AND created_at > now() - interval '24 hours'`, [], db))!.n;
}

/** Seconds until the oldest design counted in a 24-hour window drops out of it (at least a minute). */
async function secondsUntilFree(userId: string | null, db: Q) {
  const r = await one<{ s: number | null }>(`SELECT ceil(extract(epoch FROM min(created_at) + interval '24 hours' - now()))::int s FROM ai_images
    WHERE ($1::uuid IS NULL OR user_id = $1) AND status <> 'failed' AND created_at > now() - interval '24 hours'`, [userId], db);
  return Math.max(60, r?.s ?? 3600);
}
const inAbout = (sec: number) => {
  const mins = Math.ceil(sec / 60);
  return mins < 60 ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : `in about ${Math.ceil(mins / 60)} hour${Math.ceil(mins / 60) === 1 ? '' : 's'}`;
};

/**
 * Throws 429 when this person has used today's designs ('quota') or the whole site has
 * ('site_quota', a cost safety net), with retryAfter in seconds. Returns the person's count.
 */
export async function assertImageAllowance(userId: string, db: Q = pool) {
  const used = await imagesUsedToday(userId, db);
  const limit = config.ai.dailyImagesPerUser;
  if (used >= limit) {
    const s = await secondsUntilFree(userId, db);
    throw new HttpError(429, `You’ve used today’s ${limit} AI designs. You can create another ${inAbout(s)}.`, 'quota', { retryAfter: String(s) });
  }
  if (config.ai.dailyImagesSite > 0 && (await imagesUsedSite(db)) >= config.ai.dailyImagesSite) {
    const s = await secondsUntilFree(null, db);
    throw new HttpError(429, `Streetkey’s AI designer has reached its limit for today across the whole site. Please try again ${inAbout(s)}. The colour preview and costs still work.`, 'site_quota', { retryAfter: String(s) });
  }
  return used;
}

/**
 * Inside a transaction: serialise "count, then insert" for this person (and for the whole site
 * while the site-wide cap is on), so parallel uploads can't all pass the daily limits together.
 */
export async function lockImageAllowance(userId: string, db: Q) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('ai_images:u:' || $1::text, 0))`, [userId]);
  if (config.ai.dailyImagesSite > 0) await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('ai_images:site', 0))`);
}

/**
 * Close out designs whose job failed or never finished (e.g. no background worker picked it up),
 * so they show as failed and stop counting towards the daily limit.
 */
export async function settleStaleImages(userId: string) {
  await q(`UPDATE ai_images i SET status = 'failed', error = coalesce(j.error, 'This design didn’t finish. Please try again.'), finished_at = now()
             FROM ai_jobs j WHERE j.subject = 'ai_image:' || i.id::text AND j.kind = $2 AND j.status = 'failed' AND i.status = 'running' AND i.user_id = $1`, [userId, ROOM_IMAGE_JOB]);
  await q(`UPDATE ai_images SET status = 'failed', error = 'This design didn’t finish. Please try again.', finished_at = now()
            WHERE user_id = $1 AND status = 'running' AND created_at < now() - interval '30 minutes'`, [userId]);
}

/** Records (once) that the person agreed to their photos being processed by our AI provider. */
export async function recordImageConsent(userId: string) {
  await q(`INSERT INTO consents (user_id, purpose) SELECT $1, 'ai_image_processing' WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing' AND withdrawn_at IS NULL)`, [userId]);
}

async function run(job: JobRow, ctx: { progress: (t: string) => Promise<void> }) {
  const id = String(job.input?.imageId ?? '');
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await one<ImageRow>('SELECT * FROM ai_images WHERE id = $1', [id]) : null;
  if (!row || (job.user_id && row.user_id !== job.user_id)) throw new AiError('image row missing', 'This design request could no longer be found. Please try again.', 404, 'ai_missing');
  if (row.status === 'done' && row.result_url) return { image: imageDTO(row), label: ROOM_IMAGE_LABEL }; // already finished (e.g. a re-delivered job)
  const fail = async (message: string) => { await q(`UPDATE ai_images SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [row.id, message.slice(0, 300)]); };

  await q(`UPDATE ai_images SET status = 'running', error = NULL WHERE id = $1`, [row.id]);
  await ctx.progress('Designing your room… usually under a minute');
  const photo = row.source_key ? await getFile(row.source_key) : null;
  const type = photo ? sniffImage(photo) : null;
  if (!photo || !type) {
    const msg = 'The original photo is no longer available. Please upload it again.';
    await fail(msg);
    throw new AiError('source missing', msg, 410, 'ai_missing');
  }
  try {
    const out = await editRoomImage(photo, type, row.prompt, { userId: row.user_id });
    await ctx.progress('Saving your design…');
    const outType = sniffImage(out) ?? 'image/png';
    const stored = await putFile(newKey('ai/result', outType), out, outType);
    const done = await one<ImageRow>(`UPDATE ai_images SET status = 'done', result_key = $2, result_url = $3, error = NULL, finished_at = now() WHERE id = $1 RETURNING *`, [row.id, stored.key, stored.url]);
    return { image: imageDTO(done!), label: ROOM_IMAGE_LABEL };
  } catch (e) {
    const ai = e instanceof AiError ? e : null;
    const willRetry = !!ai && RETRIABLE.has(ai.code) && job.attempts < MAX_ATTEMPTS;
    // Only the safe, human message is stored (never the provider's raw error).
    if (!willRetry) await fail(ai ? ai.userMessage : 'Something went wrong creating the design. Please try again.');
    throw e;
  }
}

export function registerRoomImageJob() {
  registerJob(ROOM_IMAGE_JOB, run, { maxAttempts: MAX_ATTEMPTS, leaseSec: 900 }); // background functions run for up to 15 minutes
}
