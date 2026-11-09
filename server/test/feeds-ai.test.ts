import { describe, expect, it } from 'vitest';
import { SAMPLE_BLM } from '../../src/data/sampleFeed';
import { config } from '../src/config';
import { client, getApp, jpegWithExif, makeAdmin, multipart, signUp } from './helpers';
import { fakeHosts } from './setup';

describe('agent feeds', () => {
  it('ingests a BLM file with an agency key, releases on verification and withdraws missing stock', async () => {
    const agent = await signUp({ accountType: 'agent' });
    const admin = await signUp(); await makeAdmin(admin.email);
    const org = await agent.c.post('/api/orgs', { name: 'Lea Valley Homes', kind: 'agency', redressScheme: 'The Property Ombudsman' });
    expect(org.status).toBe(201);
    const key = (await agent.c.post(`/api/orgs/${org.json.id}/feed-keys`, { label: 'Reapit' })).json.key;
    expect(key).toMatch(/^skf_/);
    const app = await getApp();
    const send = (body: string, k = key) => app.inject({ method: 'POST', url: '/api/feeds/blm', payload: body, headers: { authorization: `Bearer ${k}`, 'content-type': 'text/plain' } });

    expect((await send(SAMPLE_BLM, 'skf_wrong')).statusCode).toBe(401);
    const first = (await send(SAMPLE_BLM)).json();
    expect(first.accepted).toBeGreaterThan(0);
    expect(first.note).toMatch(/awaiting verification/);
    expect((await client().get('/api/listings')).json.total).toBe(0);

    const v = await admin.c.post(`/api/admin/orgs/${org.json.id}/verify`, { verified: true });
    expect(v.json.released).toBe(first.accepted);
    const live = await client().get('/api/listings');
    expect(live.json.total).toBe(first.accepted);
    expect(live.json.items[0].source).toMatchObject({ kind: 'agent-feed', name: 'Lea Valley Homes', verified: true });

    // remove the first data row → that listing is withdrawn on the next upload
    const [head, data] = SAMPLE_BLM.split('#DATA#');
    const rows = data.split('~').filter((r) => r.trim() && !r.includes('#END#'));
    const second = (await send(`${head}#DATA#${rows.slice(1).join('~')}~\n#END#`)).json();
    expect(second.withdrawn).toBe(1);
    expect((await client().get('/api/listings')).json.total).toBe(first.accepted - 1);
    const runs = await agent.c.get(`/api/orgs/${org.json.id}/feed-runs`);
    expect(runs.json.items).toHaveLength(2);
  });
});

describe('AI room redesign', () => {
  const photo = () => multipart([{ field: 'photo', name: 'kitchen.jpg', type: 'image/jpeg', data: jpegWithExif() }], { room: 'kitchen', style: 'scandi', brief: 'Pale oak, sage green', consent: 'true' });
  const send = async (cookie: string, m = photo()) => (await getApp()).inject({ method: 'POST', url: '/api/ai/room-image', payload: m.payload, headers: { ...m.headers, cookie } });

  it('needs a configured key and sign-in', async () => {
    const { c } = await signUp();
    expect((await send(c.cookie)).statusCode).toBe(503);
    expect((await c.get('/api/ai/status')).json.imagesEnabled).toBe(false);
    config.ai.openaiKey = 'sk-test';
    try {
      expect((await send('')).statusCode).toBe(401);
    } finally { config.ai.openaiKey = ''; }
  });

  it('queues the photo and brief as a job, stores the result and enforces the daily limit', async () => {
    config.ai.openaiKey = 'sk-test';
    config.ai.dailyImagesPerUser = 2;
    const calls: { prompt: string; fidelity: string | null; model: string | null; hasImage: boolean; auth: string | null }[] = [];
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4be0000000049454e44ae426082', 'hex');
    fakeHosts.set('api.openai.com', async (url, init) => {
      if (!url.endsWith('/images/edits')) return Response.json({ data: [] });
      const form = init!.body as FormData;
      calls.push({ prompt: String(form.get('prompt')), fidelity: form.get('input_fidelity') as string | null, model: form.get('model') as string | null, hasImage: form.get('image') instanceof Blob, auth: new Headers(init!.headers).get('authorization') });
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    });
    try {
      const { c } = await signUp();
      const noConsent = multipart([{ field: 'photo', name: 'k.jpg', type: 'image/jpeg', data: jpegWithExif() }], { room: 'kitchen', style: 'scandi' });
      expect((await send(c.cookie, noConsent)).statusCode).toBe(400);
      const r = await send(c.cookie);
      expect(r.statusCode).toBe(202);
      const body = r.json();
      expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.label).toMatch(/AI-generated/);
      // jobs run synchronously in tests, so the job has finished by the time we poll
      const job = (await c.get(`/api/ai/jobs/${body.jobId}`)).json.job;
      expect(job.status).toBe('done');
      expect(job.output.image.status).toBe('done');
      expect(job.output.image.url).toMatch(/^\/media\/ai\/result\/.+\.png$/);
      expect(calls[0]).toMatchObject({ model: 'gpt-image-1', fidelity: 'high', hasImage: true, auth: 'Bearer sk-test' });
      expect(calls[0].prompt).toMatch(/Scandinavian/);
      expect(calls[0].prompt).toMatch(/Keep the room’s architecture/);
      expect(calls[0].prompt).toMatch(/Pale oak, sage green/);
      const img = await (await getApp()).inject({ method: 'GET', url: job.output.image.url });
      expect(img.statusCode).toBe(200);
      expect((await send(c.cookie)).statusCode).toBe(202);
      const third = await send(c.cookie);
      expect(third.statusCode).toBe(429);
      expect((await c.get('/api/ai/room-images')).json.items).toHaveLength(2);
    } finally {
      fakeHosts.delete('api.openai.com');
    }
  });

  it('retries without input_fidelity for models that do not support it, and explains provider errors', async () => {
    config.ai.openaiKey = 'sk-test';
    config.ai.dailyImagesPerUser = 10;
    let n = 0;
    fakeHosts.set('api.openai.com', async (url, init) => {
      if (!url.endsWith('/images/edits')) return Response.json({ data: [] });
      n++;
      const form = init!.body as FormData;
      if (form.get('input_fidelity')) return Response.json({ error: { message: 'Unknown parameter: input_fidelity' } }, { status: 400 });
      return Response.json({ error: { message: 'Incorrect API key provided: sk-abc123***wxyz. You can find your API key at https://platform.openai.com/account/api-keys.' } }, { status: 401 });
    });
    try {
      const { c } = await signUp();
      const r = await send(c.cookie);
      expect(r.statusCode).toBe(202);
      const job = (await c.get(`/api/ai/jobs/${r.json().jobId}`)).json.job;
      expect(n).toBe(2);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/OPENAI_API_KEY/);
      expect(job.error).not.toMatch(/abc123/);
      const hist = (await c.get('/api/ai/room-images')).json.items;
      expect(hist[0].status).toBe('failed');
      expect(JSON.stringify(hist)).not.toMatch(/abc123/); // rejected keys are never stored
    } finally {
      fakeHosts.delete('api.openai.com');
      config.ai.openaiKey = '';
    }
  });
});
