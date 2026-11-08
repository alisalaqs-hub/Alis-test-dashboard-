// Hourly: saved-search alert emails, stuck AI job recovery, and (03:00 UTC) clean-up.
import '../../server/src/netlify/env';
import type { Config } from '@netlify/functions';
import { getApp } from '../../server/src/netlify/handler';
import { runAlerts, runCleanup } from '../../server/src/jobs/run';
import { sweep } from '../../server/src/ai/jobs';

export default async () => {
  await getApp();
  const alerts = await runAlerts().catch((e) => ({ error: (e as Error).message }));
  const jobs = await sweep().catch(() => 0);
  const cleanup = new Date().getUTCHours() === 3 ? await runCleanup().catch(() => null) : null;
  console.log('[scheduled]', JSON.stringify({ alerts, jobs, cleanup }));
};

export const config: Config = { schedule: '@hourly' };
