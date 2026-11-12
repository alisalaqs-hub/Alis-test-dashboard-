/**
 * npm run job -- alerts | cleanup | hourly
 *   alerts   email saved-search matches (digests, and whatever the instant alerts didn't get to)
 *   cleanup  remove expired sessions/links and analytics older than 13 months
 *   hourly   alerts every run, plus cleanup in the 03:00 UTC run (one scheduled job does both)
 */
import { pool } from '../db';
import { runAlerts, runCleanup } from '../jobs/run';
import { sweep } from '../ai/jobs';

const job = process.argv[2];
const jobs: Record<string, () => Promise<unknown>> = {
  alerts: runAlerts,
  cleanup: runCleanup,
  hourly: async () => ({ jobs: await sweep(), alerts: await runAlerts(), cleanup: await runCleanup({ ifDue: true }) }),
};
const fn = jobs[job];
if (!fn) { console.error('Usage: npm run job -- alerts|cleanup|hourly'); process.exit(1); }
fn().then((r) => { console.log(job, JSON.stringify(r)); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
