/**
 * Stand-ins for the official data services, for tests: postcodes.io, HM Land Registry's SPARQL
 * endpoint, the Environment Agency's flood map and flood-monitoring services, and the EPC API.
 * Each answers in the real service's format, records what it was asked, and can be told to
 * misbehave (refuse, fail, hang) the way the real ones do.
 */
import { config } from '../src/config';
import { fakeHosts } from './setup';

export interface FakeSale { tx: string; postcode: string; paon?: string; saon?: string; street?: string; town?: string; district?: string; amount: number; date: string; ptype?: string; newBuild?: boolean; estate?: string; category?: string }
export interface FakePostcode { postcode: string; lat: number; lng: number; country?: string; district?: string; code?: string }

const hang = (init?: RequestInit) => new Promise<Response>((_res, rej) => {
  const fail = () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
  if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener('abort', fail);
});
const metres = (aLat: number, aLng: number, bLat: number, bLng: number) => Math.round(Math.hypot((bLat - aLat) * 111_320, (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180)));

export function fakeOfficial(o: {
  postcodes?: FakePostcode[];
  places?: { name: string; lat: number; lng: number; type?: string }[];
  sales?: FakeSale[];
  /** Monthly average prices, newest first, keyed by local authority code. */
  hpi?: Record<string, { month: string; avg: number; annual?: number; det?: number; semi?: number; terr?: number; flat?: number }[]>;
  /** Risk bands found by the map for each layer, by search radius: `wide` for the 100 m reading, `close` for the 15 m one. */
  flood?: { riversAndSea?: { wide: string[]; close: string[] }; surfaceWater?: { wide: string[]; close: string[] } };
  warnings?: { severityLevel: number; severity: string; description: string; message: string }[];
  warningAreas?: string[];
  epc?: { search?: Record<string, unknown[]>; certificates?: Record<string, Record<string, unknown>>; token?: string };
} = {}) {
  const calls = { postcodes: [] as string[], landRegistry: [] as string[], floodMaps: [] as string[], floodNow: [] as string[], epc: [] as string[] };
  const state = { landRegistry: 'ok' as 'ok' | 'down' | { refuse: number }, floodMaps: 'ok' as 'ok' | 'down' | { hangFirst: number } | { failLayer: string }, epcStatus: 200, lrBusy: 0, lrMaxBusy: 0 };
  const pcs = o.postcodes ?? [];
  const wasDisabled = config.data.disabled;
  config.data.disabled = false;

  const pcJson = (p: FakePostcode, from?: { lat: number; lng: number }) => ({
    postcode: p.postcode, outcode: p.postcode.split(' ')[0], latitude: p.lat, longitude: p.lng, country: p.country ?? 'England',
    admin_district: p.district ?? 'Waltham Forest', codes: { admin_district: p.code ?? 'E09000031' }, ...(from ? { distance: metres(from.lat, from.lng, p.lat, p.lng) } : {}),
  });

  fakeHosts.set('api.postcodes.io', (url, init) => {
    const u = new URL(url);
    calls.postcodes.push(u.pathname + u.search);
    if (init?.method === 'POST') {
      const { postcodes } = JSON.parse(String(init.body)) as { postcodes: string[] };
      return Response.json({ result: postcodes.map((q) => ({ query: q, result: { latitude: 51.58, longitude: -0.02, outcode: q.split(' ')[0] } })) });
    }
    if (u.pathname === '/postcodes' && u.searchParams.has('lat')) {
      const lat = Number(u.searchParams.get('lat')), lng = Number(u.searchParams.get('lon')), radius = Number(u.searchParams.get('radius')), limit = Number(u.searchParams.get('limit'));
      const near = pcs.map((p) => pcJson(p, { lat, lng })).filter((p) => p.distance! <= radius).sort((a, b) => a.distance! - b.distance!).slice(0, limit);
      return Response.json({ status: 200, result: near.length ? near : null });
    }
    if (u.pathname.startsWith('/postcodes/')) {
      const want = decodeURIComponent(u.pathname.slice('/postcodes/'.length));
      const p = pcs.find((x) => x.postcode === want);
      // Unknown postcodes get a plain London answer when no list was given, as the default test stand-in does.
      if (!p && !o.postcodes) return Response.json({ status: 200, result: { postcode: want, latitude: 51.5843, longitude: -0.0197, outcode: want.split(' ')[0], country: 'England', admin_district: 'Waltham Forest', codes: { admin_district: 'E09000031' } } });
      return p ? Response.json({ status: 200, result: pcJson(p) }) : Response.json({ status: 404, error: 'Invalid postcode' }, { status: 404 });
    }
    if (u.pathname.startsWith('/outcodes/')) {
      const oc = decodeURIComponent(u.pathname.slice('/outcodes/'.length));
      const inside = pcs.filter((p) => p.postcode.startsWith(`${oc} `));
      if (!inside.length) return Response.json({ status: 404, error: 'Outcode not found' }, { status: 404 });
      const lat = inside.reduce((t, p) => t + p.lat, 0) / inside.length, lng = inside.reduce((t, p) => t + p.lng, 0) / inside.length;
      return Response.json({ status: 200, result: { outcode: oc, latitude: lat, longitude: lng, admin_district: [inside[0].district ?? 'Waltham Forest'], country: [inside[0].country ?? 'England'] } });
    }
    if (u.pathname === '/places') {
      const qv = (u.searchParams.get('q') ?? '').toLowerCase();
      return Response.json({ status: 200, result: (o.places ?? []).filter((p) => p.name.toLowerCase().includes(qv)).map((p) => ({ name_1: p.name, latitude: p.lat, longitude: p.lng, local_type: p.type ?? 'Town', country: 'England' })) });
    }
    return Response.json({ status: 404 }, { status: 404 });
  });

  const uri = (kind: 'common' | 'ppi', v: string) => `http://landregistry.data.gov.uk/def/${kind}/${v}`;
  fakeHosts.set('landregistry.data.gov.uk', async (_url, init) => {
    const query = decodeURIComponent(String(init?.body ?? '').replace(/^query=/, ''));
    calls.landRegistry.push(query);
    state.lrBusy++; state.lrMaxBusy = Math.max(state.lrMaxBusy, state.lrBusy);
    await new Promise((r) => setTimeout(r, 5));
    state.lrBusy--;
    if (state.landRegistry === 'down') return new Response('<html>502</html>', { status: 502 });
    if (typeof state.landRegistry === 'object') {
      if (state.landRegistry.refuse > 0) { state.landRegistry.refuse--; return new Response('<html>429 Too Many Requests</html>', { status: 429 }); }
      state.landRegistry = 'ok';
    }
    const csv = (rows: (string | number)[][]) => new Response(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } });
    if (query.includes('ukhpi:refRegion')) {
      const code = query.match(/statistical-geography\/([A-Z]\d{8})/)?.[1] ?? '';
      const rows = o.hpi?.[code] ?? [];
      return csv([['month', 'avg', 'annual', 'det', 'semi', 'terr', 'flat'], ...rows.map((r) => [r.month, r.avg, r.annual ?? '', r.det ?? '', r.semi ?? '', r.terr ?? '', r.flat ?? ''])]);
    }
    const wanted = new Set([...query.matchAll(/"([A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2})"/g)].map((m) => m[1]));
    const since = query.match(/\?date >= "(\d{4}-\d{2}-\d{2})"/)?.[1] ?? '1900-01-01';
    const rows = (o.sales ?? []).filter((s) => wanted.has(s.postcode) && s.date >= since);
    return csv([
      ['tx', 'postcode', 'paon', 'saon', 'street', 'locality', 'town', 'district', 'amount', 'date', 'ptype', 'newBuild', 'estate', 'category'],
      ...rows.map((s) => [s.tx, s.postcode, s.paon ?? '', s.saon ?? '', s.street ?? '', '', s.town ?? 'LONDON', s.district ?? 'WALTHAM FOREST', s.amount, s.date,
        uri('common', s.ptype ?? 'terraced'), String(!!s.newBuild), uri('common', s.estate ?? 'freehold'), uri('ppi', s.category ?? 'standardPricePaidTransaction')]),
    ]);
  });

  let mapCalls = 0;
  fakeHosts.set('environment.data.gov.uk', (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes('/spatialdata/')) {
      calls.floodMaps.push(u.pathname + u.search);
      mapCalls++;
      const layer = u.searchParams.get('layers') ?? '';
      if (state.floodMaps === 'down') return new Response('oops', { status: 503 });
      if (typeof state.floodMaps === 'object' && 'hangFirst' in state.floodMaps && mapCalls <= state.floodMaps.hangFirst) return hang(init);
      if (typeof state.floodMaps === 'object' && 'failLayer' in state.floodMaps && layer === state.floodMaps.failLayer) return new Response('oops', { status: 503 });
      const set = layer === 'rofsw' ? o.flood?.surfaceWater : o.flood?.riversAndSea;
      const bands = (Number(u.searchParams.get('buffer')) >= 40 ? set?.wide : set?.close) ?? [];
      return Response.json({ type: 'FeatureCollection', features: bands.map((b, i) => ({ type: 'Feature', id: `${layer}.${i}`, properties: { risk_band: b } })) });
    }
    calls.floodNow.push(u.pathname + u.search);
    if (u.pathname.endsWith('/id/floods')) return Response.json({ items: (o.warnings ?? []).map((w) => ({ ...w, timeMessageChanged: '2026-11-10T09:00:00' })) });
    if (u.pathname.endsWith('/id/floodAreas')) return Response.json({ items: (o.warningAreas ?? []).map((label) => ({ label, riverOrSea: 'River Lea' })) });
    return Response.json({ items: [] });
  });

  const epcHost = new URL(config.data.epcUrl).host;
  const hadToken = config.data.epcToken;
  if (o.epc) config.data.epcToken = o.epc.token ?? 'test-epc-token';
  fakeHosts.set(epcHost, (url, init) => {
    const u = new URL(url);
    calls.epc.push(u.pathname + u.search);
    const auth = new Headers(init?.headers).get('authorization');
    if (state.epcStatus !== 200) return Response.json({ error: 'nope' }, { status: state.epcStatus });
    if (auth !== `Bearer ${config.data.epcToken}`) return Response.json({ error: 'unauthorised' }, { status: 401 });
    if (u.pathname === '/api/domestic/search') {
      const rows = o.epc?.search?.[u.searchParams.get('postcode') ?? ''];
      return rows?.length ? Response.json({ data: rows, pagination: { totalRecords: rows.length, currentPage: 1, totalPages: 1 } }) : Response.json({ error: 'No certificates found' }, { status: 404 });
    }
    if (u.pathname === '/api/certificate') {
      const c = o.epc?.certificates?.[u.searchParams.get('certificate_number') ?? ''];
      return c ? Response.json({ data: c }) : Response.json({ error: 'Certificate not found' }, { status: 404 });
    }
    return Response.json({}, { status: 404 });
  });

  return {
    calls, state,
    restore: () => {
      for (const h of ['api.postcodes.io', 'landregistry.data.gov.uk', 'environment.data.gov.uk', epcHost]) fakeHosts.delete(h);
      config.data.disabled = wasDisabled; config.data.epcToken = hadToken;
    },
  };
}
