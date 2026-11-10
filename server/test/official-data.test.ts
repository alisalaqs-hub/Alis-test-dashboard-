/** Official open data: sold prices and the house price index (HM Land Registry), flood risk (Environment Agency), energy certificates. */
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { q } from '../src/db';
import { addressKey, epcForAddress } from '../src/data/epc';
import { parseCsv } from '../src/data/http';
import { fetchSales, formatAddress } from '../src/data/landRegistry';
import { client, jpegWithExif, LISTING, makeAdmin, multipart, signUp } from './helpers';
import { fakeOfficial, type FakePostcode, type FakeSale } from './official-fakes';

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const HOME = { lat: 51.5906, lng: -0.0185 };
const north = (m: number) => HOME.lat + m / 111_320;
const POSTCODES: FakePostcode[] = [
  { postcode: 'E17 4PP', ...HOME },
  { postcode: 'E17 4PW', lat: north(100), lng: HOME.lng },
  { postcode: 'E17 4PN', lat: north(250), lng: HOME.lng },
  { postcode: 'E17 4QH', lat: north(-150), lng: HOME.lng },
  { postcode: 'E17 9ZZ', lat: north(3000), lng: HOME.lng },
  { postcode: 'EH1 1YZ', lat: 55.9503, lng: -3.193, country: 'Scotland', district: 'City of Edinburgh', code: 'S12000036' },
];
const SALES: FakeSale[] = [
  { tx: 'T1', postcode: 'E17 4PP', paon: '615', street: 'FOREST ROAD', amount: 450_000, date: ago(20), ptype: 'terraced' },
  { tx: 'T2', postcode: 'E17 4PW', paon: '17', saon: 'FLAT 2', street: 'CHINGFORD ROAD', amount: 300_000, date: ago(60), ptype: 'flat-maisonette', estate: 'leasehold' },
  { tx: 'T3', postcode: 'E17 4PN', paon: '117A', street: "ST MARY'S ROAD", amount: 600_000, date: ago(200), ptype: 'terraced' },
  { tx: 'T4', postcode: 'E17 4PN', paon: '9', street: 'CHINGFORD ROAD', amount: 500_000, date: ago(400), ptype: 'terraced' },
  { tx: 'T5', postcode: 'E17 4PP', paon: 'UNIT 1', street: 'FOREST ROAD', amount: 2_000_000, date: ago(30), ptype: 'otherPropertyType' },
  { tx: 'T6', postcode: 'E17 4PP', paon: '617', street: 'FOREST ROAD', amount: 90_000, date: ago(40), ptype: 'terraced', category: 'additionalPricePaidTransaction' },
  { tx: 'T7', postcode: 'E17 4PP', paon: '619', street: 'FOREST ROAD', amount: 250_000, date: ago(365 * 7), ptype: 'terraced' },
  { tx: 'T8', postcode: 'E17 9ZZ', paon: '1', street: 'FAR ROAD', amount: 999_000, date: ago(10), ptype: 'detached' },
  ...Array.from({ length: 6 }, (_, i) => ({ tx: `Q${i}`, postcode: 'E17 4QH', paon: String(20 + i), street: 'ELM ROAD', amount: 480_000 + i * 20_000, date: ago(100 + i * 30), ptype: 'terraced' })),
];
const HPI = { E09000031: [{ month: '2026-08', avg: 532_212, annual: 0.7, det: 1_048_493, semi: 810_106, terr: 629_993, flat: 390_968 }, { month: '2026-07', avg: 528_111, annual: 2.6 }] };
const official = (extra: Parameters<typeof fakeOfficial>[0] = {}) => fakeOfficial({ postcodes: POSTCODES, sales: SALES, hpi: HPI, places: [{ name: 'Walthamstow', lat: HOME.lat, lng: HOME.lng, type: 'Other Settlement' }], ...extra });

beforeEach(async () => { await q('TRUNCATE sold_prices, sold_price_fetches, data_cache'); });

describe('sold prices (HM Land Registry)', () => {
  it('returns real sales around a postcode, newest first, with a summary and the house price index', async () => {
    const f = official();
    try {
      const r = await client().get('/api/data/sold?q=e17%204pp');
      expect(r.status).toBe(200);
      expect(r.json.place).toMatchObject({ kind: 'postcode', label: 'E17 4PP', district: 'Waltham Forest', country: 'England' });
      expect(r.json.coverage).toBe('england-wales');
      // nearby postcodes only; "other" property types, additional transactions and sales older than 5 years are left out
      expect(r.json.sales.map((s: { id: string }) => s.id)).toEqual(['T1', 'T2', 'Q0', 'Q1', 'Q2', 'Q3', 'T3', 'Q4', 'Q5', 'T4']);
      expect(r.json.sales[0]).toMatchObject({ address: '615 Forest Road', postcode: 'E17 4PP', price: 450_000, type: 'terraced', tenure: 'freehold', newBuild: false, distanceM: 0, town: 'London' });
      expect(r.json.sales[1]).toMatchObject({ address: 'Flat 2, 17 Chingford Road', type: 'flat', tenure: 'leasehold' });
      expect(r.json.sales.find((s: { id: string }) => s.id === 'T3').address).toBe("117A St Mary's Road");
      expect(r.json.totalSales).toBe(10);
      expect(r.json.stats.count).toBe(9); // within the last 12 months
      expect(r.json.stats.byType.map((t: { type: string; count: number }) => [t.type, t.count])).toEqual([['terraced', 8], ['flat', 1]]);
      expect(r.json.hpi).toMatchObject({ district: 'Waltham Forest', month: '2026-08', averagePrice: 532_212, annualChangePct: 0.7 });
      expect(r.json.hpi.series).toEqual([{ month: '2026-07', averagePrice: 528_111 }, { month: '2026-08', averagePrice: 532_212 }]);
      expect(r.json.partial).toBe(false);
      expect(r.json.attribution.join(' ')).toMatch(/HM Land Registry data © Crown copyright/);
    } finally { f.restore(); }
  });

  it('asks HM Land Registry once for the whole area, then answers from the database for 30 days', async () => {
    const f = official();
    try {
      const c = client();
      expect((await c.get('/api/data/sold?q=E17%204PP')).json.totalSales).toBe(10);
      const sales = f.calls.landRegistry.filter((x) => x.includes('lrppi:pricePaid'));
      expect(sales).toHaveLength(1); // one query for every nearby postcode
      expect(sales[0]).toContain('"E17 4PP" "E17 4PW"');
      const before = f.calls.landRegistry.length;
      expect((await c.get('/api/data/sold?q=E17%204PP')).json.totalSales).toBe(10);
      expect(f.calls.landRegistry.length).toBe(before); // sold prices and the index both came from the database
      await q(`UPDATE sold_price_fetches SET fetched_at = now() - interval '31 days'`);
      await c.get('/api/data/sold?q=E17%204PP');
      expect(f.calls.landRegistry.filter((x) => x.includes('lrppi:pricePaid'))).toHaveLength(2); // refreshed after a month
    } finally { f.restore(); }
  });

  it('waits its turn: retries when refused (429) and never runs two queries at once', async () => {
    const f = official();
    try {
      f.state.landRegistry = { refuse: 2 };
      const [a, b] = await Promise.all([client().get('/api/data/sold?q=E17%204PP'), client().get('/api/data/sold?q=E17%204QH')]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.json.partial).toBe(false);
      expect(a.json.totalSales).toBe(10);
      expect(f.state.lrMaxBusy).toBe(1);
    } finally { f.restore(); }
  });

  it('says so when HM Land Registry can’t be reached, and still shows what is stored', async () => {
    const f = official();
    try {
      f.state.landRegistry = 'down';
      const empty = await client().get('/api/data/sold?q=E17%204PP');
      expect(empty.status).toBe(200);
      expect(empty.json).toMatchObject({ partial: true, totalSales: 0, hpi: null });
      f.state.landRegistry = 'ok';
      expect((await client().get('/api/data/sold?q=E17%204PP')).json).toMatchObject({ partial: false, totalSales: 10 });
      await q(`UPDATE sold_price_fetches SET fetched_at = now() - interval '31 days'`);
      f.state.landRegistry = 'down';
      expect((await client().get('/api/data/sold?q=E17%204PP')).json).toMatchObject({ partial: true, totalSales: 10 }); // older answers are kept
    } finally { f.restore(); }
  });

  it('understands postcode districts and towns, and refuses unknown places and anything that isn’t a place', async () => {
    const f = official();
    try {
      const c = client();
      const district = await c.get('/api/data/sold?q=E17');
      expect(district.json.place).toMatchObject({ kind: 'outcode', label: 'E17' });
      expect(district.json.totalSales).toBeGreaterThan(0);
      expect((await c.get('/api/data/sold?q=walthamstow')).json.place).toMatchObject({ kind: 'place', label: 'Walthamstow', district: 'Waltham Forest' });
      for (const bad of ['Nowhereville', 'ZZ99 9ZZ', 'E17 4PP" } UNION { ?s ?p ?o', '<script>', '12345']) {
        const r = await c.get(`/api/data/sold?q=${encodeURIComponent(bad)}`);
        expect([r.status, r.json.error.code], bad).toEqual([404, 'place_not_found']);
      }
      expect((await c.get('/api/data/sold?q=E')).status).toBe(400);
      expect((await c.get('/api/data/sold?q=E17&radius=99999')).status).toBe(400);
      // only real postcodes ever reach a query
      expect(await fetchSales(['E17 4PP" } UNION {', 'not a postcode'], '2020-01-01')).toEqual([]);
      expect(f.calls.landRegistry.every((x) => !x.includes('UNION'))).toBe(true);
    } finally { f.restore(); }
  });

  it('reports Scotland as not covered without asking for sales', async () => {
    const f = official();
    try {
      const r = await client().get('/api/data/sold?q=EH1%201YZ');
      expect(r.json).toMatchObject({ coverage: 'not-covered', sales: [], totalSales: 0, place: { country: 'Scotland' } });
      expect(f.calls.landRegistry.filter((x) => x.includes('lrppi:pricePaid'))).toHaveLength(0);
    } finally { f.restore(); }
  });

  it('is switched off by OFFICIAL_DATA_DISABLED', async () => {
    const f = official();
    try {
      config.data.disabled = true;
      const r = await client().get('/api/data/sold?q=E17%204PP');
      expect([r.status, r.json.error.code]).toEqual([503, 'data_disabled']);
      expect((await client().get('/api/data/status')).json).toMatchObject({ enabled: false, soldPrices: false, flood: false });
    } finally { f.restore(); }
  });
});

describe('flood risk (Environment Agency)', () => {
  const FLOOD = { riversAndSea: { wide: ['High', 'Low', 'Very low'], close: ['Low'] }, surfaceWater: { wide: [], close: [] } };

  it('reads long-term risk from rivers and the sea and from surface water, plus live warnings', async () => {
    const f = official({ flood: FLOOD, warnings: [{ severityLevel: 3, severity: 'Flood alert', description: 'Lower River Lee', message: 'River levels are rising.' }, { severityLevel: 4, severity: 'Warning no longer in force', description: 'Elsewhere', message: 'Over.' }], warningAreas: ['Lower River Lee at Hackney and Walthamstow'] });
    try {
      const r = await client().get('/api/data/flood?q=E17%204PP');
      expect(r.status).toBe(200);
      expect(r.json.flood).toMatchObject({
        coverage: 'england', approximate: true, overall: 'low',
        riversAndSea: { here: 'low', nearby: 'high' },
        surfaceWater: { here: 'very low', nearby: 'very low' }, // nothing mapped within 100 m
        warningAreas: ['Lower River Lee at Hackney and Walthamstow'],
      });
      expect(r.json.flood.warnings).toEqual([expect.objectContaining({ level: 3, severity: 'Flood alert', area: 'Lower River Lee' })]); // "no longer in force" is left out
      expect(r.json.attribution.join(' ')).toMatch(/Environment Agency/);
      // surface water needed one map request (nothing nearby), rivers and sea two
      expect(f.calls.floodMaps.filter((u) => u.includes('rofsw'))).toHaveLength(1);
      expect(f.calls.floodMaps.filter((u) => u.includes('rofrs_4band'))).toHaveLength(2);
      const before = f.calls.floodMaps.length;
      await client().get('/api/data/flood?q=E17%204PP');
      expect(f.calls.floodMaps.length).toBe(before); // kept for 30 days
    } finally { f.restore(); }
  });

  it('asks again when a map request hangs, and answers anyway', async () => {
    const f = official({ flood: FLOOD });
    try {
      f.state.floodMaps = { hangFirst: 2 };
      const r = await client().get('/api/data/flood?q=E17%204PP');
      expect(r.json.flood).toMatchObject({ riversAndSea: { here: 'low', nearby: 'high' }, surfaceWater: { here: 'very low' } });
    } finally { f.restore(); }
  });

  it('shows the part it could read when one map fails, and tries the other again next time', async () => {
    const f = official({ flood: FLOOD });
    try {
      f.state.floodMaps = { failLayer: 'rofsw' };
      const first = await client().get('/api/data/flood?q=E17%204PP');
      expect(first.json.flood).toMatchObject({ riversAndSea: { here: 'low', nearby: 'high' }, surfaceWater: null, overall: 'low' });
      f.state.floodMaps = 'ok';
      expect((await client().get('/api/data/flood?q=E17%204PP')).json.flood.surfaceWater).toEqual({ here: 'very low', nearby: 'very low' });
      f.state.floodMaps = 'down';
      await q(`DELETE FROM data_cache WHERE key LIKE 'flood:%'`);
      expect((await client().get('/api/data/flood?q=E17%204PP')).json.flood).toMatchObject({ riversAndSea: null, surfaceWater: null, overall: null });
    } finally { f.restore(); }
  });

  it('says a place outside England isn’t covered, without asking the Environment Agency', async () => {
    const f = official({ flood: FLOOD });
    try {
      const r = await client().get('/api/data/flood?q=EH1%201YZ');
      expect(r.json.flood).toMatchObject({ coverage: 'not-covered', country: 'Scotland', riversAndSea: null, overall: null });
      expect(f.calls.floodMaps.length + f.calls.floodNow.length).toBe(0);
    } finally { f.restore(); }
  });
});

const EPC = {
  search: {
    'E17 4QH': [
      { certificateNumber: '0000-0000-0000-0000-0001', addressLine1: '14 Elm Road', addressLine2: null, postcode: 'E17 4QH', postTown: 'LONDON', currentEnergyEfficiencyBand: 'D', registrationDate: '2021-03-01', uprn: 1 },
      { certificateNumber: '0000-0000-0000-0000-0002', addressLine1: '14 Elm Road', addressLine2: null, postcode: 'E17 4QH', postTown: 'LONDON', currentEnergyEfficiencyBand: 'E', registrationDate: '2011-03-01', uprn: 1 },
      { certificateNumber: '0000-0000-0000-0000-0003', addressLine1: 'Flat 2', addressLine2: '14 Elm Road', postcode: 'E17 4QH', postTown: 'LONDON', currentEnergyEfficiencyBand: 'C', registrationDate: '2022-06-01', uprn: 2 },
      { certificateNumber: '0000-0000-0000-0000-0004', addressLine1: 'Rose Cottage', addressLine2: 'Elm Road', postcode: 'E17 4QH', postTown: 'LONDON', currentEnergyEfficiencyBand: 'F', registrationDate: '2019-01-01', uprn: 3 },
      { certificateNumber: 'not-a-number', addressLine1: '99 Elm Road', postcode: 'E17 4QH' },
    ],
  },
  certificates: {
    '0000-0000-0000-0000-0001': {
      address_line_1: '14 Elm Road', post_town: 'London', postcode: 'E17 4QH', registration_date: '2021-03-01', current_energy_efficiency_band: 'D', energy_rating_current: 62,
      potential_energy_efficiency_band: 'B', energy_rating_potential: 84, total_floor_area: 92, dwelling_type: 'Mid-terrace house',
      heating_cost_current: 900.4, hot_water_cost_current: 150, lighting_cost_current: 80, heating_cost_potential: 600, hot_water_cost_potential: 100, lighting_cost_potential: 80,
      suggested_improvements: [{ sequence: 1, typical_saving: 120, indicative_cost: '£100 - £350', improvement_type: 'Z3' }],
    },
    '0000-0000-0000-0000-0002': { address_line_1: '14 Elm Road', postcode: 'E17 4QH', registration_date: '2011-03-01', current_energy_efficiency_band: 'E' },
    '0000-0000-0000-0000-0003': { address_line_1: 'Flat 2', address_line_2: '14 Elm Road', postcode: 'E17 4QH', registration_date: '2022-06-01', current_energy_efficiency_band: 'C' },
    '0000-0000-0000-0000-0004': { address_line_1: 'Rose Cottage', address_line_2: 'Elm Road', postcode: 'E17 4QH', registration_date: '2014-01-01', current_energy_efficiency_band: 'F' },
  },
};

describe('energy certificates (EPC register)', () => {
  it('is for signed-in people only, and says when the site has no access token', async () => {
    const f = official();
    try {
      expect((await client().get('/api/data/epc/search?postcode=E17%204QH')).status).toBe(401);
      const { c } = await signUp();
      const r = await c.get('/api/data/epc/search?postcode=E17%204QH');
      expect([r.status, r.json.error.code]).toEqual([503, 'epc_not_configured']);
      expect((await c.get('/api/data/status')).json.epc).toBe(false);
      expect((await c.get('/api/data/epc/search?postcode=E17')).status).toBe(400);
    } finally { f.restore(); }
  });

  it('lists the latest certificate for each address and reads a full certificate', async () => {
    const f = official({ epc: EPC });
    try {
      const { c } = await signUp();
      expect((await c.get('/api/data/status')).json.epc).toBe(true);
      const list = await c.get('/api/data/epc/search?postcode=e17%204qh');
      expect(list.status).toBe(200);
      expect(list.json.items.map((i: { address: string; band: string; certificateNumber: string }) => [i.address, i.band, i.certificateNumber.slice(-1)])).toEqual([
        ['14 Elm Road', 'D', '1'], ['Flat 2, 14 Elm Road', 'C', '3'], ['Rose Cottage, Elm Road', 'F', '4'],
      ]);
      expect(list.json.attribution[0]).toMatch(/Royal Mail and Ordnance Survey/);
      const cert = await c.get('/api/data/epc/certificate?number=00000000000000000001');
      expect(cert.json.certificate).toMatchObject({
        certificateNumber: '0000-0000-0000-0000-0001', address: '14 Elm Road, London', postcode: 'E17 4QH', band: 'D', score: 62, potentialBand: 'B', potentialScore: 84,
        floorAreaM2: 92, dwellingType: 'Mid-terrace house', registeredOn: '2021-03-01', expired: false, yearlyCost: { current: 1130, potential: 780 },
        improvements: [{ cost: '£100 - £350', saving: 120 }],
      });
      expect((await c.get('/api/data/epc/certificate?number=0000-0000-0000-0000-0002')).json.certificate.expired).toBe(true); // more than 10 years old
      expect((await c.get('/api/data/epc/certificate?number=9999-9999-9999-9999-9999')).status).toBe(404);
      expect((await c.get('/api/data/epc/certificate?number=abc')).status).toBe(400);
      const before = f.calls.epc.length;
      await c.get('/api/data/epc/search?postcode=E17%204QH');
      expect(f.calls.epc.length).toBe(before); // cached
    } finally { f.restore(); }
  });

  it('explains a rejected token without leaking it', async () => {
    const f = official({ epc: { ...EPC, token: 'secret-token-value' } });
    try {
      f.state.epcStatus = 401;
      const { c } = await signUp();
      const r = await c.get('/api/data/epc/search?postcode=E17%204QH');
      expect([r.status, r.json.error.code]).toEqual([503, 'epc_token']);
      expect(JSON.stringify(r.json)).not.toContain('secret-token-value');
    } finally { f.restore(); }
  });

  it('only matches a certificate to an address when it is sure', async () => {
    const f = official({ epc: EPC });
    try {
      expect((await epcForAddress('E17 4QH', '14 Elm Road'))?.certificateNumber).toBe('0000-0000-0000-0000-0001');
      expect((await epcForAddress('e17 4qh', '14, ELM RD'))?.certificateNumber).toBe('0000-0000-0000-0000-0001');
      expect((await epcForAddress('E17 4QH', 'Flat 2, 14 Elm Road'))?.certificateNumber).toBe('0000-0000-0000-0000-0003');
      expect((await epcForAddress('E17 4QH', 'Rose Cottage, Elm Road'))?.certificateNumber).toBe('0000-0000-0000-0000-0004');
      expect(await epcForAddress('E17 4QH', '16 Elm Road')).toBeNull();          // no certificate for that house
      expect(await epcForAddress('E17 4QH', 'Flat 3, 14 Elm Road')).toBeNull();  // a different flat
      expect(await epcForAddress('E17 4QH', 'Elm Road')).toBeNull();             // too vague
      expect(await epcForAddress('E17 4PP', '14 Elm Road')).toBeNull();          // nothing at that postcode
      expect(addressKey('Flat 2, 14 Elm Rd.')).toBe('FLAT 2 14 ELM RD');
    } finally { f.restore(); }
  });
});

describe('official data for a listing', () => {
  async function liveListing(over: Record<string, unknown> = {}) {
    const seller = await signUp({ accountType: 'owner' });
    const admin = await signUp(); await makeAdmin(admin.email);
    const ref = (await seller.c.post('/api/listings', { ...LISTING, ...over })).json.listing.ref as string;
    const m = multipart([{ field: 'photos', name: 'front.jpg', type: 'image/jpeg', data: jpegWithExif() }]);
    expect((await seller.c.raw('POST', `/api/listings/${ref}/photos`, m.payload, m.headers)).status).toBe(201);
    return { ...seller, admin, ref };
  }
  const publish = async (l: Awaited<ReturnType<typeof liveListing>>) => {
    expect((await l.c.post(`/api/listings/${l.ref}/submit`)).json.status).toBe('pending');
    expect((await l.admin.c.post(`/api/admin/listings/${l.ref}/approve`)).json.status).toBe('live');
  };

  it('gives sold prices nearby, where the asking price sits, flood risk and the certificate, without pinpointing a private seller', async () => {
    const f = official({ epc: EPC, flood: { riversAndSea: { wide: [], close: [] }, surfaceWater: { wide: ['Medium'], close: [] } } });
    try {
      const l = await liveListing({ price: 700_000 });
      // not public yet: strangers can't see it, the owner can
      expect((await client().get(`/api/data/listings/${l.ref}`)).status).toBe(404);
      expect((await l.c.get(`/api/data/listings/${l.ref}`)).status).toBe(200);
      await publish(l);
      const r = await client().get(`/api/data/listings/${l.ref}`);
      expect(r.status).toBe(200);
      expect(r.json.sold.totalSales).toBeGreaterThanOrEqual(6);
      expect(r.json.sold.sales.every((s: { distanceM: number | null }) => s.distanceM === null)).toBe(true); // no distances for a private seller
      expect(r.json.range).toMatchObject({ basis: 'same-type', type: 'terraced', position: 'above' });
      expect(r.json.range.count).toBeGreaterThanOrEqual(5);
      expect(r.json.flood).toMatchObject({ coverage: 'england', overall: 'very low', surfaceWater: { here: 'very low', nearby: 'medium' }, riversAndSea: { here: 'very low', nearby: 'very low' } });
      expect(r.json.epcStatus).toBe('ok');
      expect(r.json.epc).toMatchObject({ band: 'D', potentialBand: 'B', score: 62, registeredOn: '2021-03-01', expired: false, floorAreaM2: 92, matchesListing: true, certificateNumber: null });
      expect(JSON.stringify(r.json)).not.toContain('14 Elm Road'); // the house number never leaves the server
      expect(JSON.stringify(r.json)).not.toContain('E17 4QH"}');
      expect(r.json.attribution.join(' ')).toMatch(/HM Land Registry.*Environment Agency/s);
    } finally { f.restore(); }
  });

  it('copes without an EPC token, with an unknown address and with a rental', async () => {
    const f = official();
    try {
      const l = await liveListing({ addressLine: '16 Elm Road', channel: 'rent', price: 1800 });
      await publish(l);
      const r = await client().get(`/api/data/listings/${l.ref}`);
      expect(r.json).toMatchObject({ epc: null, epcStatus: 'not-configured', range: null });
      expect(r.json.sold.totalSales).toBeGreaterThan(0);
      expect((await client().get('/api/data/listings/nope')).status).toBe(404);
      expect((await client().get('/api/data/listings/..%2f..')).status).toBe(404);
    } finally { f.restore(); }
    const g = official({ epc: EPC });
    try {
      const l = await liveListing({ addressLine: '16 Elm Road' });
      await publish(l);
      expect((await client().get(`/api/data/listings/${l.ref}`)).json).toMatchObject({ epc: null, epcStatus: 'no-match' });
    } finally { g.restore(); }
  });
});

describe('helpers', () => {
  it('reads CSV with quotes, commas and line breaks inside fields', () => {
    expect(parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,"two\nlines"\r\n')).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', 'two\nlines']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('only')).toEqual([['only']]);
  });
  it('writes addresses the way people do', () => {
    expect(formatAddress({ paon: '615', saon: null, street: 'FOREST ROAD' })).toBe('615 Forest Road');
    expect(formatAddress({ paon: 'BRAITHWAITE HOUSE, 6', saon: 'FLAT 22', street: 'TROUBRIDGE SQUARE' })).toBe('Flat 22, Braithwaite House, 6 Troubridge Square');
    expect(formatAddress({ paon: '12A', saon: null, street: "ST MARY'S ROAD" })).toBe("12A St Mary's Road");
    expect(formatAddress({ paon: null, saon: null, street: null })).toBe('Address not recorded');
  });
});
