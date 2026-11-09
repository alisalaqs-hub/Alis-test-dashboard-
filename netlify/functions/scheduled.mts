// Hourly: recover stuck AI jobs first, refresh the AI model list, send saved-search alerts (time-boxed),
// and run the daily clean-up when it's due. Netlify gives scheduled functions about 30 seconds.
import '../../server/src/netlify/env';
import type { Config } from '@netlify/functions';
import { getApp } from '../../server/src/netlify/handler';
import { runAlerts, runCleanup } from '../../server/src/jobs/run';
import { sweep } from '../../server/src/ai/jobs';
import { refreshModels } from '../../server/src/ai/core';

export default async () => {
  const started = Date.now();
  await getApp();
  const jobs = await sweep().catch(() => 0);
  await refreshModels().catch(() => null); // keeps the model list fresh so requests never wait for it
  const alerts = await runAlerts(new Date(), { deadline: started + 20_000 }).catch((e) => ({ error: (e as Error).message }));
  const cleanup = Date.now() - started < 24_000 ? await runCleanup({ ifDue: true }).catch(() => null) : null;
  console.log('[scheduled]', JSON.stringify({ jobs, alerts, cleanup }));
};

export const config: Config = { schedule: '@hourly' };
