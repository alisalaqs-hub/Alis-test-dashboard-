/**
 * HM Land Registry open data (Open Government Licence v3.0), through its public SPARQL endpoint:
 *   - Price Paid Data: every residential sale in England and Wales registered since 1995
 *   - UK House Price Index: average prices and yearly change for each local authority
 *
 * Sold prices are fetched per postcode, stored in `sold_prices`, and refreshed every 30 days
 * (HM Land Registry publishes new sales monthly). Searching a wide area by postcode prefix takes
 * the endpoint 15 seconds or more, so areas are always asked for as a list of exact postcodes.
 */
import type { HpiSummary, SoldSale, SoldType } from '../../../src/engine/evidence';
import { config } from '../config';
import { q } from '../db';
import { cachedData, DAY } from './cache';
import { DataError, fetchData, parseCsv } from './http';
import type { NearbyPostcode } from './postcodes';

const PREFIXES = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX ukhpi: <http://landregistry.data.gov.uk/def/ukhpi/>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;

/** Postcodes are put into queries as text, so only real postcode characters are allowed through. */
const SAFE_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_CODE = /^[A-Z]\d{8}$/;
const FRESH_DAYS = 30;
/** One query can ask about hundreds of postcodes (about 300 postcodes and 1,300 sales come back in under 2 s). */
const CHUNK = 500;
const MAX_ROWS = 12_000;

/**
 * The endpoint answers one request at a time per caller and refuses the rest with 429, so calls
 * from this server queue up behind each other, and a refusal is retried after a short wait.
 */
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Run a query and return its rows as objects keyed by column name. */
async function sparql(query: string, timeoutMs = 12_000): Promise<Record<string, string>[]> {
  const r = await inTurn(() => fetchData(config.data.landRegistryUrl, {
    source: 'land-registry', method: 'POST', accept: 'text/csv', timeoutMs, retries: 3, backoffMs: [700, 1500, 3000],
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `query=${encodeURIComponent(`${PREFIXES}\n${query}`)}`,
  }));
  if (r.status !== 200) throw new DataError('land-registry', 'HM Land Registry couldn’t answer that just now. Please try again in a moment.');
  const rows = parseCsv(await r.text());
  const head = rows.shift() ?? [];
  return rows.map((row) => Object.fromEntries(head.map((h, i) => [h, row[i] ?? ''])));
}

const tail = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const TYPE: Record<string, SoldType> = { detached: 'detached', 'semi-detached': 'semi-detached', terraced: 'terraced', 'flat-maisonette': 'flat', otherPropertyType: 'other' };

interface Row {
  tx_id: string; postcode: string; paon: string | null; saon: string | null; street: string | null; locality: string | null; town: string | null; district: string | null;
  price: number; sold_on: string; property_type: SoldType; new_build: boolean; tenure: string | null; standard: boolean;
}

/** Sales in these postcodes on or after `since`, straight from HM Land Registry. */
export async function fetchSales(postcodes: string[], since: string): Promise<Row[]> {
  const pcs = postcodes.filter((p) => SAFE_POSTCODE.test(p));
  if (!pcs.length || !SAFE_DATE.test(since)) return [];
  const rows = await sparql(`SELECT ?tx ?postcode ?paon ?saon ?street ?locality ?town ?district ?amount ?date ?ptype ?newBuild ?estate ?category WHERE {
  VALUES ?postcode { ${pcs.map((p) => `"${p}"`).join(' ')} }
  ?addr lrcommon:postcode ?postcode .
  ?t lrppi:propertyAddress ?addr ; lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:transactionId ?tx .
  FILTER(?date >= "${since}"^^xsd:date)
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
  OPTIONAL { ?addr lrcommon:locality ?locality }
  OPTIONAL { ?addr lrcommon:town ?town }
  OPTIONAL { ?addr lrcommon:district ?district }
  OPTIONAL { ?t lrppi:propertyType ?ptype }
  OPTIONAL { ?t lrppi:newBuild ?newBuild }
  OPTIONAL { ?t lrppi:estateType ?estate }
  OPTIONAL { ?t lrppi:transactionCategory ?category }
} LIMIT ${MAX_ROWS}`);
  const out = new Map<string, Row>();
  for (const r of rows) {
    const price = Number(r.amount);
    if (!r.tx || !SAFE_POSTCODE.test(r.postcode) || !SAFE_DATE.test(r.date) || !Number.isFinite(price) || price <= 0 || price > 2_000_000_000) continue;
    const estate = tail(r.estate ?? '');
    out.set(r.tx, {
      tx_id: r.tx, postcode: r.postcode, paon: r.paon || null, saon: r.saon || null, street: r.street || null, locality: r.locality || null, town: r.town || null, district: r.district || null,
      price: Math.round(price), sold_on: r.date, property_type: TYPE[tail(r.ptype ?? '')] ?? 'other', new_build: r.newBuild === 'true',
      tenure: estate === 'freehold' || estate === 'leasehold' ? estate : null, standard: tail(r.category ?? '') !== 'additionalPricePaidTransaction',
    });
  }
  return [...out.values()];
}

async function store(rows: Row[], postcodes: string[], since: string) {
  if (rows.length) {
    await q(`INSERT INTO sold_prices (tx_id, postcode, paon, saon, street, locality, town, district, price, sold_on, property_type, new_build, tenure, standard)
      SELECT tx_id, postcode, paon, saon, street, locality, town, district, price, sold_on, property_type, new_build, tenure, standard
      FROM jsonb_to_recordset($1::jsonb) AS x(tx_id text, postcode text, paon text, saon text, street text, locality text, town text, district text, price integer, sold_on date, property_type text, new_build boolean, tenure text, standard boolean)
      ON CONFLICT (tx_id) DO UPDATE SET postcode = EXCLUDED.postcode, paon = EXCLUDED.paon, saon = EXCLUDED.saon, street = EXCLUDED.street, locality = EXCLUDED.locality, town = EXCLUDED.town,
        district = EXCLUDED.district, price = EXCLUDED.price, sold_on = EXCLUDED.sold_on, property_type = EXCLUDED.property_type, new_build = EXCLUDED.new_build, tenure = EXCLUDED.tenure,
        standard = EXCLUDED.standard, fetched_at = now()`, [JSON.stringify(rows)]);
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.postcode, (counts.get(r.postcode) ?? 0) + 1);
  await q(`INSERT INTO sold_price_fetches (postcode, since, rows) SELECT pc, $2::date, n FROM unnest($1::text[], $3::int[]) AS t(pc, n)
           ON CONFLICT (postcode) DO UPDATE SET since = least(sold_price_fetches.since, EXCLUDED.since), rows = EXCLUDED.rows, fetched_at = now()`,
    [postcodes, since, postcodes.map((p) => counts.get(p) ?? 0)]);
}

/**
 * Make sure sales since `since` are stored for these postcodes, fetching any that are missing or
 * more than 30 days old. Returns false when HM Land Registry couldn't be reached for some of them
 * (what is already stored is still usable).
 */
export async function ensureSales(postcodes: string[], since: string): Promise<boolean> {
  const pcs = [...new Set(postcodes)].filter((p) => SAFE_POSTCODE.test(p));
  if (!pcs.length) return true;
  const have = new Set((await q<{ postcode: string }>(
    `SELECT postcode FROM sold_price_fetches WHERE postcode = ANY($1) AND since <= $2::date AND fetched_at > now() - make_interval(days => $3)`, [pcs, since, FRESH_DAYS])).map((r) => r.postcode));
  const missing = pcs.filter((p) => !have.has(p));
  if (!missing.length) return true;
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
  let complete = true;
  for (const c of chunks) {
    try {
      const rows = await fetchSales(c, since);
      // A full page means the answer was cut short: keep the sales but don't mark these postcodes as complete.
      if (rows.length >= MAX_ROWS) { await store(rows, [], since); complete = false; } else await store(rows, c, since);
    } catch { complete = false; }
  }
  return complete;
}

/** "ST MARY'S ROAD" → "St Mary's Road", "O'BRIEN COURT" → "O'Brien Court", "12a" → "12A". */
const titleCase = (s: string) => s.toLowerCase()
  .replace(/(^|[\s\-/(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
  .replace(/(['’])([a-z])(?=[a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
  .replace(/\b(\d+)([a-z])\b/g, (_m, n: string, l: string) => n + l.toUpperCase());
/** "FLAT 2" + "615" + "FOREST ROAD" → "Flat 2, 615 Forest Road". */
export function formatAddress(r: { paon: string | null; saon: string | null; street: string | null }): string {
  const building = [r.paon, r.street].filter(Boolean).map((x) => titleCase(x!)).join(' ');
  return [r.saon ? titleCase(r.saon) : null, building].filter(Boolean).join(', ') || 'Address not recorded';
}

/** Stored sales for these postcodes since a date, newest first. Standard residential sales only unless `all`. */
export async function storedSales(postcodes: NearbyPostcode[], since: string, opts: { all?: boolean; limit?: number } = {}): Promise<SoldSale[]> {
  if (!postcodes.length) return [];
  const dist = new Map(postcodes.map((p) => [p.postcode, p.distanceM]));
  const rows = await q<Row & { sold_on: Date | string }>(
    `SELECT tx_id, postcode, paon, saon, street, town, price, to_char(sold_on, 'YYYY-MM-DD') AS sold_on, property_type, new_build, tenure, standard
     FROM sold_prices WHERE postcode = ANY($1) AND sold_on >= $2::date ${opts.all ? '' : `AND standard AND property_type <> 'other'`} ORDER BY sold_on DESC, tx_id LIMIT $3`,
    [[...dist.keys()], since, opts.limit ?? 4000]);
  return rows.map((r) => ({
    id: r.tx_id, address: formatAddress(r), street: r.street ? titleCase(r.street) : null, town: r.town ? titleCase(r.town) : null, postcode: r.postcode,
    price: r.price, date: String(r.sold_on), type: r.property_type, newBuild: r.new_build, tenure: (r.tenure as SoldSale['tenure']) ?? null, distanceM: dist.get(r.postcode) ?? null,
  }));
}

/* ───────────────────────── UK House Price Index ───────────────────────── */

/** Average prices and yearly change for a local authority, by its statistics code (e.g. E09000031). null when it isn't published. */
export async function houseHpi(districtCode: string | null, districtName: string | null): Promise<HpiSummary | null> {
  if (!districtCode || !SAFE_CODE.test(districtCode)) return null;
  const c = await cachedData<HpiSummary | null>(`hpi:${districtCode}`, 3 * DAY, async () => {
    const rows = await sparql(`SELECT ?month ?avg ?annual ?det ?semi ?terr ?flat WHERE {
  ?region owl:sameAs <http://statistics.data.gov.uk/id/statistical-geography/${districtCode}> .
  ?obs ukhpi:refRegion ?region ; ukhpi:refMonth ?month ; ukhpi:averagePrice ?avg .
  OPTIONAL { ?obs ukhpi:percentageAnnualChange ?annual }
  OPTIONAL { ?obs ukhpi:averagePriceDetached ?det }
  OPTIONAL { ?obs ukhpi:averagePriceSemiDetached ?semi }
  OPTIONAL { ?obs ukhpi:averagePriceTerraced ?terr }
  OPTIONAL { ?obs ukhpi:averagePriceFlatMaisonette ?flat }
} ORDER BY DESC(?month) LIMIT 25`, 10_000);
    const ok = rows.filter((r) => /^\d{4}-\d{2}/.test(r.month) && Number(r.avg) > 0);
    if (!ok.length) return null;
    const latest = ok[0];
    const num = (s: string | undefined) => (s && Number.isFinite(Number(s)) ? Number(s) : null);
    const byType = ([['detached', latest.det], ['semi-detached', latest.semi], ['terraced', latest.terr], ['flat', latest.flat]] as [SoldType, string][])
      .map(([type, v]) => ({ type, averagePrice: Math.round(num(v) ?? 0) })).filter((t) => t.averagePrice > 0);
    return {
      district: districtName ?? 'This area', month: latest.month.slice(0, 7), averagePrice: Math.round(Number(latest.avg)), annualChangePct: num(latest.annual), byType,
      series: ok.slice(0, 24).reverse().map((r) => ({ month: r.month.slice(0, 7), averagePrice: Math.round(Number(r.avg)) })),
    };
  });
  return c.value;
}
