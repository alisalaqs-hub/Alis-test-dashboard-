import { describe, expect, it } from 'vitest';
import { SAMPLE_BLM } from '../../src/data/sampleFeed';
import { config } from '../src/config';
import { q } from '../src/db';
import { client, getApp, jpegWithExif, lastMail, makeAdmin, multipart, signUp, tokenIn } from './helpers';
import { fakeHosts } from './setup';

/** Room redesign (image generation) needs a confirmed email address. */
async function verifiedUser() {
  const s = await signUp();
  await s.c.post('/api/auth/verify', { token: tokenIn(lastMail(s.email)!.text) });
  return s;
}

/** A minimal BLM v3 file: one row per [ref, price, postcode, photo urls]. */
function blm(rows: [ref: string, price: number, postcode: string, photos: string[]][]) {
  const fields = ['AGENT_REF', 'ADDRESS_1', 'ADDRESS_2', 'TOWN', 'POSTCODE1', 'POSTCODE2', 'SUMMARY', 'DESCRIPTION', 'BEDROOMS', 'BATHROOMS', 'PRICE', 'PROP_SUB_ID', 'TENURE_TYPE_ID', 'TRANS_TYPE_ID', 'STATUS_ID', 'MEDIA_IMAGE_00', 'MEDIA_IMAGE_01', 'MEDIA_IMAGE_02'];
  const data = rows.map(([ref, price, pc, photos]) => {
    const [a, b] = pc.split(' ');
    return [ref, `${ref.length} Feed Street`, '', 'London', a, b, `Two-bedroom flat ${ref}`, 'A bright flat with a balcony. EPC rating C. Council tax band B.', '2', '1', String(price), '8', '2', '1', '0', photos[0] ?? '', photos[1] ?? '', photos[2] ?? ''].join('^') + '^';
  });
  return `#HEADER#\nVersion : 3\nEOF : '^'\nEOR : '~'\n#DEFINITION#\n${fields.join('^')}^~\n#DATA#\n${data.join('~\n')}~\n#END#`;
}

async function agencyWithKeys(n = 1) {
  const agent = await signUp({ accountType: 'agent' });
  const admin = await signUp(); await makeAdmin(admin.email);
  const org = (await agent.c.post('/api/orgs', { name: `Branch Agency ${Date.now()}`, kind: 'agency' })).json;
  await admin.c.post(`/api/admin/orgs/${org.id}/verify`, { verified: true });
  const keys: string[] = [];
  for (let i = 0; i < n; i++) keys.push((await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: `Branch ${i + 1}` })).json.key);
  const app = await getApp();
  const send = async (body: string, k = keys[0]) => { const r = await app.inject({ method: 'POST', url: '/api/feeds/blm', payload: body, headers: { authorization: `Bearer ${k}`, 'content-type': 'text/plain' } }); return { status: r.statusCode, json: r.json() }; };
  return { org, keys, send, agent };
}
const listingsOf = (orgId: string) => q<{ id: string; source_ref: string; status: string; price: number }>('SELECT id, source_ref, status, price FROM listings WHERE organisation_id = $1 ORDER BY source_ref', [orgId]);
const photosOf = (listingId: string) => q<{ id: string; url: string }>('SELECT id, url FROM listing_photos WHERE listing_id = $1 ORDER BY position', [listingId]);

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

  it('imports a feed set-based: one row per reference, unsafe photo links dropped and reported, unchanged photos kept', async () => {
    const { org, send } = await agencyWithKeys();
    const good = 'https://images.agency-cdn.example.com/a1.jpg';
    const first = await send(blm([
      ['A1', 300000, 'E17 4QH', [good, 'https://127.0.0.1:9443/probe.jpg', 'http://images.agency-cdn.example.com/plain.jpg']],
      ['A2', 410000, 'E10 5AB', ['https://metadata.internal/x.jpg']],
      ['A2', 415000, 'E10 5AB', []], // repeated reference: the last row wins
    ]));
    expect(first.status).toBe(200);
    expect(first.json.accepted).toBe(2);
    const reasons = first.json.rejected.map((r: { ref: string; reason: string }) => `${r.ref}: ${r.reason}`);
    // (plain http links are already left out by the BLM reader)
    expect(reasons.sort()).toEqual([
      'A1: Photo 2 skipped (127.0.0.1:9443): photos must be on a public https web address',
      'A2: Listed more than once in this file: the last one was used',
    ]);
    const rows = await listingsOf(org.id);
    expect(rows.map((r) => [r.source_ref, r.status, r.price])).toEqual([['A1', 'live', 300000], ['A2', 'live', 415000]]);
    const photos = await photosOf(rows[0].id);
    expect(photos.map((p) => p.url)).toEqual([good]);
    expect(await photosOf(rows[1].id)).toEqual([]);
    const run = (await q<{ rejected: unknown[] }>('SELECT rejected FROM feed_runs WHERE organisation_id = $1', [org.id]))[0];
    expect(run.rejected).toHaveLength(2);

    // the same photos again: the stored rows (and any checks on them) are kept; a price change is recorded once
    const second = await send(blm([['A1', 290000, 'E17 4QH', [good]], ['A2', 415000, 'E10 5AB', []]]));
    expect(second.json).toMatchObject({ accepted: 2, withdrawn: 0, rejected: [] });
    expect((await photosOf(rows[0].id)).map((p) => p.id)).toEqual(photos.map((p) => p.id));
    const audits = await q<{ subject: string; detail: { priceFrom: number; priceTo: number; via: string } }>(`SELECT subject, detail FROM audit_log WHERE action = 'listing.updated' AND detail->>'via' = 'feed'`);
    expect(audits.filter((a) => a.detail.priceFrom === 300000)).toHaveLength(1);
    expect(audits.find((a) => a.detail.priceFrom === 300000)!.detail.priceTo).toBe(290000);

    // a changed photo list replaces the external photos
    await send(blm([['A1', 290000, 'E17 4QH', ['https://images.agency-cdn.example.com/a1-new.jpg', good]], ['A2', 415000, 'E10 5AB', []]]));
    expect((await photosOf(rows[0].id)).map((p) => p.url)).toEqual(['https://images.agency-cdn.example.com/a1-new.jpg', good]);
  });

  it('withdraws missing stock only among the listings the same key sent, so each branch can use its own key', async () => {
    const { org, keys, send } = await agencyWithKeys(2);
    expect((await send(blm([['N1', 250000, 'E17 4QH', []], ['N2', 260000, 'E17 4QH', []]]), keys[0])).json.accepted).toBe(2);
    expect((await send(blm([['S1', 350000, 'E10 5AB', []]]), keys[1])).json.accepted).toBe(1);
    // branch 1 drops N2: only N2 is withdrawn; branch 2's S1 stays live
    const again = await send(blm([['N1', 250000, 'E17 4QH', []]]), keys[0]);
    expect(again.json.withdrawn).toBe(1);
    expect((await listingsOf(org.id)).map((r) => [r.source_ref, r.status])).toEqual([['N1', 'live'], ['N2', 'withdrawn'], ['S1', 'live']]);
  });

  it('gives listings imported before keys were remembered to the key that sent the last file, so a new branch key withdraws none of them', async () => {
    const { org, keys, send } = await agencyWithKeys(2);
    await send(blm([['N1', 250000, 'E17 4QH', []], ['N2', 260000, 'E17 4QH', []]]), keys[0]);
    await q('UPDATE listings SET feed_key_id = NULL WHERE organisation_id = $1', [org.id]); // as imported before migration 013
    // the agency follows the size advice: branch 2's first file, with its own key
    const branch2 = await send(blm([['S1', 350000, 'E10 5AB', []]]), keys[1]);
    expect(branch2.json.withdrawn).toBe(0);
    expect((await listingsOf(org.id)).map((r) => [r.source_ref, r.status])).toEqual([['N1', 'live'], ['N2', 'live'], ['S1', 'live']]);
    const keyIds = await q<{ id: string; label: string }>('SELECT id, label FROM feed_keys WHERE organisation_id = $1', [org.id]);
    const owners = await q<{ source_ref: string; feed_key_id: string }>('SELECT source_ref, feed_key_id FROM listings WHERE organisation_id = $1 ORDER BY source_ref', [org.id]);
    const label = (id: string) => keyIds.find((k) => k.id === id)?.label;
    expect(owners.map((o) => [o.source_ref, label(o.feed_key_id)])).toEqual([['N1', 'Branch 1'], ['N2', 'Branch 1'], ['S1', 'Branch 2']]);
    // the original key's next file still withdraws what it dropped
    expect((await send(blm([['N1', 250000, 'E17 4QH', []]]), keys[0])).json.withdrawn).toBe(1);
    expect((await listingsOf(org.id)).map((r) => r.status)).toEqual(['live', 'withdrawn', 'live']);
  });

  it('lets a replacement key take over a revoked key’s listings when it is the agency’s only working key', async () => {
    const { org, send, agent } = await agencyWithKeys(1);
    await send(blm([['A1', 300000, 'E17 4QH', []], ['A2', 310000, 'E17 4QH', []]]));
    const old = (await q<{ id: string }>('SELECT id FROM feed_keys WHERE organisation_id = $1', [org.id]))[0].id;
    expect((await agent.c.del(`/api/orgs/${org.id}/feed-keys/${old}`)).status).toBe(200);
    expect((await send(blm([['A1', 300000, 'E17 4QH', []]]))).status).toBe(401);
    const replacement = (await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: 'New CRM key' })).json.key as string;
    // a second working key (another branch) exists: the revoked key's listings are left alone
    expect((await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: 'Branch 2' })).status).toBe(201);
    expect((await send(blm([['A1', 300000, 'E17 4QH', []]]), replacement)).json.withdrawn).toBe(0);
    const branchId = (await q<{ id: string }>(`SELECT id FROM feed_keys WHERE organisation_id = $1 AND label = 'Branch 2'`, [org.id]))[0].id;
    await agent.c.del(`/api/orgs/${org.id}/feed-keys/${branchId}`);
    // now the replacement is the only working key: A2 (sent last by the revoked key, missing from this file) is withdrawn
    expect((await send(blm([['A1', 300000, 'E17 4QH', []]]), replacement)).json.withdrawn).toBe(1);
    expect((await listingsOf(org.id)).map((r) => [r.source_ref, r.status])).toEqual([['A1', 'live'], ['A2', 'withdrawn']]);
  });
});

describe('AI room redesign', () => {
  const photo = () => multipart([{ field: 'photo', name: 'kitchen.jpg', type: 'image/jpeg', data: jpegWithExif() }], { room: 'kitchen', style: 'scandi', brief: 'Pale oak, sage green', consent: 'true' });
  const send = async (cookie: string, m = photo()) => (await getApp()).inject({ method: 'POST', url: '/api/ai/room-image', payload: m.payload, headers: { ...m.headers, cookie } });

  it('needs a configured key and sign-in', async () => {
    const { c } = await verifiedUser();
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
      const { c } = await verifiedUser();
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
      const { c } = await verifiedUser();
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
