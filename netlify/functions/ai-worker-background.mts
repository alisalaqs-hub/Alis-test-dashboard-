// Background function (up to 15 minutes): runs queued AI jobs such as image editing and photo analysis.
// Triggered by the API right after a job is queued; only accepts calls carrying the worker secret,
// and checks that BEFORE any expensive start-up (migrations, building the app).
import '../../server/src/netlify/env';
import { timingSafeEqual } from 'node:crypto';
import { getApp } from '../../server/src/netlify/handler';
import { drain, processJob, workerSecret } from '../../server/src/ai/jobs';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async (req: Request) => {
  const started = Date.now();
  if (req.method !== 'POST') return;
  const given = req.headers.get('x-streetkey-worker') ?? '';
  if (!given) return;
  const secret = await workerSecret().catch(() => '');
  if (!secret || !same(given, secret)) return;
  await getApp(); // migrations + registers every job handler
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (id && /^[0-9a-f-]{36}$/i.test(id)) await processJob(id);
  // Pick up anything else that's waiting. Netlify stops background functions at 15 minutes,
  // so only start jobs that can finish before 14.
  await drain(0, started + 14 * 60_000);
};
