/** AI status (what's switched on) and background job polling. */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { one, q } from '../db';
import { aiAvailable, modelsInUse } from '../ai/core';
import { getJob, dispatch, isInlineSafe, jobDTO, processJob } from '../ai/jobs';
import { forbidden, notFound, requireAdmin } from '../services/http';

export async function aiCoreRoutes(app: FastifyInstance) {
  app.get('/api/ai/status', async (req) => {
    const on = aiAvailable();
    const used = req.user ? await one<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE user_id = $1 AND status <> 'failed' AND created_at > now() - interval '24 hours'`, [req.user.id]) : null;
    return {
      enabled: on, imagesEnabled: on, signedIn: !!req.user,
      dailyLimit: config.ai.dailyImagesPerUser, usedToday: used?.n ?? 0,
      note: on ? null : config.ai.disabled ? 'AI is switched off on this site.' : 'AI is not set up on this server yet.',
    };
  });

  /** Admins: which models are in use (auto-selected from the account unless overridden) and today's usage. */
  app.get('/api/ai/admin/overview', async (req) => {
    requireAdmin(req);
    const usage = await one<{ calls: number; tokens: number; images: number; failures: number }>(`SELECT count(*)::int calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint tokens,
      coalesce(sum(images), 0)::int images, count(*) FILTER (WHERE NOT ok)::int failures FROM ai_usage WHERE at > now() - interval '24 hours'`);
    const byPurpose = await one<{ rows: unknown }>(`SELECT coalesce(json_agg(x ORDER BY x.calls DESC), '[]') AS rows FROM (SELECT purpose, count(*)::int calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint tokens FROM ai_usage WHERE at > now() - interval '24 hours' GROUP BY purpose) x`);
    return { enabled: aiAvailable(), models: aiAvailable() ? await modelsInUse() : null, last24h: usage, byPurpose: byPurpose?.rows ?? [], dailyTokenBudget: config.ai.dailyTokenBudget, jobsMode: config.jobs.mode };
  });

  /** Poll a background job. Also nudges it along if it hasn't been picked up yet. */
  app.get('/api/ai/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That job');
    let job = await getJob(id);
    if (!job) throw notFound('That job');
    if (job.user_id && job.user_id !== req.user?.id && req.user?.role !== 'admin') throw forbidden();
    if (!job.user_id && req.user?.role !== 'admin' && !job.subject?.startsWith('anon:')) throw forbidden();
    const ageSec = (Date.now() - job.created_at.getTime()) / 1000;
    if (job.status === 'queued' && ageSec > 8) {
      // The worker hasn't started it. Quick jobs can run right here; slow ones are re-sent to the
      // background worker, and fail with an explanation if no worker ever picks them up.
      if (config.jobs.mode !== 'netlify' || isInlineSafe(job.kind)) { await processJob(id); job = (await getJob(id))!; }
      else if (ageSec < 150) await dispatch(id);
      else {
        await q(`UPDATE ai_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'queued'`,
          [id, 'This AI task couldn’t start because background processing isn’t running on this site. Please try again later.']);
        console.warn('[ai-jobs] a job waited over 150s without a worker: check that Netlify Background Functions are available on this plan');
        job = (await getJob(id))!;
      }
    }
    return { job: jobDTO(job) };
  });
}
