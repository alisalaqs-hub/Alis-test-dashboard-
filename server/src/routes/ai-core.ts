/** AI status (what's switched on) and background job polling. */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { one, q } from '../db';
import { aiAvailable, aiCan, aiOffReason, aiPause, aiProvider, modelsInUse, refreshAiState } from '../ai/core';
import { AI_OFF_MESSAGE } from '../ai/guard';
import { getJob, dispatch, isInlineSafe, jobDTO, processJob } from '../ai/jobs';
import { forbidden, notFound, requireAdmin } from '../services/http';

export async function aiCoreRoutes(app: FastifyInstance) {
  app.get('/api/ai/status', async (req) => {
    await refreshAiState().catch(() => {});
    const on = aiAvailable();
    const off = aiOffReason();
    const used = req.user ? await one<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE user_id = $1 AND status <> 'failed' AND created_at > now() - interval '24 hours'`, [req.user.id]) : null;
    return {
      enabled: on, imagesEnabled: on && aiCan('image'), signedIn: !!req.user,
      dailyLimit: config.ai.dailyImagesPerUser, usedToday: used?.n ?? 0,
      reason: off,
      note: off ? AI_OFF_MESSAGE[off] : null,
    };
  });

  /** Admins: which models are in use (auto-selected from the account unless overridden) and today's usage. */
  app.get('/api/ai/admin/overview', async (req) => {
    requireAdmin(req);
    const usage = await one<{ calls: number; tokens: number; images: number; failures: number }>(`SELECT count(*)::int calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint tokens,
      coalesce(sum(images), 0)::int images, count(*) FILTER (WHERE NOT ok)::int failures FROM ai_usage WHERE at > now() - interval '24 hours'`);
    const byPurpose = await one<{ rows: unknown }>(`SELECT coalesce(json_agg(x ORDER BY x.calls DESC), '[]') AS rows FROM (SELECT purpose, count(*)::int calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint tokens FROM ai_usage WHERE at > now() - interval '24 hours' GROUP BY purpose) x`);
    await refreshAiState(true).catch(() => {});
    const off = aiOffReason();
    // Only admins see the billing detail: the public message just says AI is temporarily unavailable.
    const pause = aiPause();
    const untilTime = pause ? new Date(pause.until).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
    const notice = pause?.reason === 'quota' ? `The OpenAI account has run out of credit, so AI is paused until ${untilTime} and will retry automatically. Add credit at platform.openai.com → Billing.`
      : pause?.reason === 'limit' ? `${aiProvider()} says its allowance is used up for now (on a free plan this is usually the daily limit), so AI is paused until ${untilTime} and will retry automatically. The site uses its built-in rules meanwhile.`
      : off === 'budget' ? 'Today’s AI token budget (AI_DAILY_TOKEN_BUDGET) is used up, so ordinary AI features are paused; safety checks keep a reserve.' : off ? AI_OFF_MESSAGE[off] : null;
    const topUsers = await q(`SELECT CASE WHEN actor LIKE 'u:%' THEN 'account' ELSE 'visitor' END AS kind, count(*)::int calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint tokens
      FROM ai_usage WHERE at > now() - interval '24 hours' AND actor IS NOT NULL GROUP BY actor ORDER BY tokens DESC LIMIT 5`).catch(() => []);
    return { enabled: aiAvailable(), reason: off, notice, pause, provider: aiProvider(), models: config.ai.openaiKey && !config.ai.disabled ? await modelsInUse() : null, last24h: usage, byPurpose: byPurpose?.rows ?? [], topUsers,
      dailyTokenBudget: config.ai.dailyTokenBudget, dailyTokensPerUser: config.ai.dailyTokensPerUser, dailyTokensPerIp: config.ai.dailyTokensPerIp, jobsMode: config.jobs.mode };
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
