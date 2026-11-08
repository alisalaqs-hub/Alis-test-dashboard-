/**
 * Background AI jobs (image editing, photo analysis, listing review, embeddings…).
 *
 *   registerJob('listing.photos', async (job, ctx) => { … return output })
 *   const job = await enqueue('listing.photos', { ref }, { userId, subject: `listing:${ref}` })
 *   // the browser polls GET /api/ai/jobs/:id
 *
 * Where jobs run (config.jobs.mode):
 *   sync    — before the request returns (tests)
 *   inline  — in this process, right after the response (long-lived Node server)
 *   netlify — a Netlify Background Function (up to 15 minutes), triggered over HTTP
 * A scheduled sweep re-dispatches anything stuck, and polling "kicks" a queued job too.
 */
import { config } from '../config';
import { one, q } from '../db';
import { AiError } from './core';

export interface JobRow { id: string; kind: string; user_id: string | null; subject: string | null; status: 'queued' | 'running' | 'done' | 'failed'; input: any; output: any; error: string | null; attempts: number; progress: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface JobCtx { progress: (text: string) => Promise<void> }
interface Handler { run: (job: JobRow, ctx: JobCtx) => Promise<unknown>; maxAttempts: number; leaseSec: number; inlineSafe: boolean }
const handlers = new Map<string, Handler>();

/**
 * @param o.inlineSafe the job reliably finishes in < 20s, so it may run inside a normal request
 *        when no background worker picked it up (e.g. text analysis). Image work must leave this false.
 */
export function registerJob(kind: string, run: Handler['run'], o: { maxAttempts?: number; leaseSec?: number; inlineSafe?: boolean } = {}) {
  handlers.set(kind, { run, maxAttempts: o.maxAttempts ?? 2, leaseSec: o.leaseSec ?? 600, inlineSafe: o.inlineSafe ?? false });
}
export const isInlineSafe = (kind: string) => handlers.get(kind)?.inlineSafe ?? false;
export const jobKinds = () => [...handlers.keys()];

export async function enqueue(kind: string, input: unknown, o: { userId?: string | null; subject?: string | null; dedupe?: boolean } = {}) {
  if (!handlers.has(kind)) throw new Error(`no handler for job ${kind}`);
  if (o.dedupe && o.subject) {
    const existing = await one<JobRow>(`SELECT * FROM ai_jobs WHERE kind = $1 AND subject = $2 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`, [kind, o.subject]);
    if (existing) return existing;
  }
  const job = (await one<JobRow>('INSERT INTO ai_jobs (kind, user_id, subject, input) VALUES ($1, $2, $3, $4) RETURNING *', [kind, o.userId ?? null, o.subject ?? null, JSON.stringify(input ?? {})]))!;
  await dispatch(job.id);
  return config.jobs.mode === 'sync' ? (await getJob(job.id))! : job;
}

export const getJob = (id: string) => one<JobRow>('SELECT * FROM ai_jobs WHERE id = $1', [id]);

/** Start processing a job using the configured mode. Never throws. */
export async function dispatch(id: string) {
  try {
    if (config.jobs.mode === 'sync') { await processJob(id); return; }
    if (config.jobs.mode === 'inline') { setImmediate(() => { void processJob(id); }); return; }
    const base = process.env.DEPLOY_URL || process.env.URL || config.publicUrl;
    await fetch(`${base}/.netlify/functions/ai-worker-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-streetkey-worker': await workerSecret() },
      body: JSON.stringify({ id }), signal: AbortSignal.timeout(6000),
    });
  } catch { /* left queued: polling or the scheduled sweep picks it up */ }
}

let secretCache = '';
export async function workerSecret() {
  if (config.jobs.workerSecret) return config.jobs.workerSecret;
  if (!secretCache) secretCache = (await one<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ai_worker_secret'`))?.value ?? '';
  return secretCache;
}

/** Claim and run one job. Safe to call concurrently: only one caller wins the claim. */
export async function processJob(id: string): Promise<JobRow | null> {
  const peek = await getJob(id);
  if (!peek) return null;
  const h = handlers.get(peek.kind);
  if (!h) { await q(`UPDATE ai_jobs SET status = 'failed', error = 'This job type is no longer supported.', finished_at = now() WHERE id = $1 AND status = 'queued'`, [id]); return getJob(id); }
  const job = await one<JobRow>(
    `UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, started_at = now(), lease_until = now() + make_interval(secs => $2), progress = NULL
      WHERE id = $1 AND attempts < $3 AND (status = 'queued' OR (status = 'running' AND lease_until < now())) RETURNING *`, [id, h.leaseSec, h.maxAttempts]);
  if (!job) {
    // Out of attempts while still marked running/queued: close it out.
    await q(`UPDATE ai_jobs SET status = 'failed', error = coalesce(error, 'This took too long. Please try again.'), finished_at = now() WHERE id = $1 AND attempts >= $2 AND status IN ('queued') `, [id, h.maxAttempts]);
    return getJob(id);
  }
  try {
    const output = await h.run(job, { progress: async (text) => { await q('UPDATE ai_jobs SET progress = $2 WHERE id = $1', [id, text.slice(0, 200)]); } });
    await q(`UPDATE ai_jobs SET status = 'done', output = $2, error = NULL, progress = NULL, finished_at = now(), lease_until = NULL WHERE id = $1`, [id, JSON.stringify(output ?? null)]);
  } catch (e) {
    const ai = e instanceof AiError;
    const retriable = ai ? ['ai_timeout', 'ai_network', 'ai_upstream', 'ai_busy'].includes((e as AiError).code) : false;
    const message = ai ? (e as AiError).userMessage : 'Something went wrong while the AI was working. Please try again.';
    if (retriable && job.attempts < h.maxAttempts) {
      await q(`UPDATE ai_jobs SET status = 'queued', error = $2, lease_until = NULL WHERE id = $1`, [id, message]);
      if (config.jobs.mode !== 'sync') await dispatch(id); else await processJob(id);
    } else {
      await q(`UPDATE ai_jobs SET status = 'failed', error = $2, finished_at = now(), lease_until = NULL WHERE id = $1`, [id, message]);
    }
    if (!config.isTest) console.warn(`[ai-job ${job.kind}] ${ai ? (e as AiError).code : 'error'}: ${(e as Error).message.slice(0, 300)}`);
  }
  return getJob(id);
}

/** Process queued work until the queue is empty or the time budget is spent (background worker). */
export async function drain(budgetMs: number) {
  const until = Date.now() + budgetMs;
  let n = 0;
  while (Date.now() < until) {
    const next = await one<{ id: string }>(`SELECT id FROM ai_jobs WHERE status = 'queued' OR (status = 'running' AND lease_until < now()) ORDER BY created_at LIMIT 1`);
    if (!next) break;
    await processJob(next.id); n++;
  }
  return n;
}

/** Re-dispatch jobs that were never picked up or whose worker died (scheduled function). */
export async function sweep() {
  const stuck = await q<{ id: string }>(`SELECT id FROM ai_jobs WHERE (status = 'queued' AND created_at < now() - interval '30 seconds') OR (status = 'running' AND lease_until < now()) ORDER BY created_at LIMIT 20`);
  for (const s of stuck) await dispatch(s.id);
  await q(`DELETE FROM ai_jobs WHERE finished_at < now() - interval '30 days'`);
  return stuck.length;
}

/** Shape returned to the browser. */
export const jobDTO = (j: JobRow) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, output: j.status === 'done' ? j.output : null, error: j.status === 'failed' ? j.error : null, createdAt: j.created_at.toISOString() });
