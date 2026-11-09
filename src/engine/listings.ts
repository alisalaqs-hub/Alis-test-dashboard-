/**
 * Listing supply: everything that turns outside data into Streetkey listings.
 *
 *  1. Owner / landlord posts      → buildListing() + complianceChecks()
 *  2. Agent CRM feeds (BLM v3)    → parseBLM()      (the bulk format CRMs already export to portals)
 *  3. Links found on other sites  → extractListing() (user-pasted text, kept PRIVATE, links back)
 *  4. Merging the same home from several sources → dedupe()
 *  5. "Search everywhere" deep links → externalSearchLinks()
 *
 * We never fetch or copy content from other portals. Agent feeds arrive with
 * the agent's consent; pasted listings are user-provided and private.
 */
import { PROPERTIES, type ListingSource, type Property } from '../data/properties';
import { regionFromPostcode, type Condition, type Era, type PropertyType, type RegionKey } from './refurb';
import type { Nation } from './tax';

/* ---------- geography (offline fallback; production uses ONS Postcode Directory / postcodes.io) ---------- */
const REGION_CENTROID: Record<RegionKey, [number, number]> = {
  'central-london': [51.51, -0.12], 'outer-london': [51.5, -0.1], 'south-east': [51.3, -0.8], east: [52.2, 0.6], 'south-west': [50.9, -3.2],
  'west-midlands': [52.48, -1.9], 'east-midlands': [52.9, -1.2], 'north-west': [53.48, -2.5], yorkshire: [53.8, -1.5], 'north-east': [54.9, -1.6],
  wales: [51.7, -3.4], scotland: [55.9, -4.0], 'northern-ireland': [54.6, -5.9],
};
export function locate(postcode: string): { lat: number; lng: number; nation: Nation; district: string; precise: boolean } {
  const pc = postcode.trim().toUpperCase();
  const district = pc.split(' ')[0] || pc.slice(0, -3);
  const known = PROPERTIES.find((p) => p.district === district && !p.source);
  const region = regionFromPostcode(pc) ?? 'south-west';
  const nation: Nation = region === 'wales' ? 'wales' : region === 'scotland' ? 'scotland' : region === 'northern-ireland' ? 'northern-ireland' : 'england';
  if (known) return { lat: known.lat, lng: known.lng, nation, district, precise: false };
  const [lat, lng] = REGION_CENTROID[region];
  return { lat, lng, nation, district, precise: false };
}
export const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
export const normalisePostcode = (s: string) => { const m = s.toUpperCase().match(POSTCODE_RE); return m ? `${m[1]} ${m[2]}` : s.toUpperCase().trim(); };

/* ---------- evidence for price checks ---------- */
export function areaEvidence(postcode: string) {
  const district = normalisePostcode(postcode).split(' ')[0];
  const region = regionFromPostcode(postcode);
  const resi = PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial' && !p.source);
  const near = resi.filter((p) => p.district === district);
  const pool = near.length ? near : resi.filter((p) => regionFromPostcode(p.postcode) === region);
  if (!pool.length) return null;
  const perM2 = (p: Property) => p.price / p.floorArea;
  const asIsPerM2 = pool.reduce((s, p) => s + perM2(p), 0) / pool.length;
  const refurbishedPerM2 = pool.reduce((s, p) => s + p.estGdv / p.floorArea, 0) / pool.length;
  const lets = PROPERTIES.filter((p) => p.listing === 'rent' && !p.source && regionFromPostcode(p.postcode) === region);
  const rentPerM2 = lets.length ? lets.reduce((s, p) => s + p.price / p.floorArea, 0) / lets.length : (asIsPerM2 * 0.045) / 12;
  return { asIsPerM2, refurbishedPerM2, rentPerM2, n: pool.length, scope: near.length ? `postcode district ${district}` : 'the wider region', district };
}

/* ---------- 1. build a listing from any input ---------- */
export interface ListingInput {
  id?: string;
  listing: 'sale' | 'rent';
  title?: string;
  addressLine: string;
  town: string;
  postcode: string;
  type: PropertyType;
  tenure: Property['tenure'];
  leaseYears?: number;
  beds: number; baths: number; floorArea: number;
  era?: Era; condition?: Condition;
  price: number;
  epc?: string;
  councilTax?: string;
  serviceChargeAnnual?: number; groundRentAnnual?: number;
  features: string[];
  description?: string;
  photos?: string[];
  source: ListingSource;
  visibility?: 'public' | 'private';
  status?: Property['status'];
  geo?: { lat: number; lng: number };
}

const EPC_SCORE: Record<string, number> = { A: 94, B: 84, C: 72, D: 61, E: 47, F: 30, G: 15 };
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function buildListing(i: ListingInput): Property {
  const pc = normalisePostcode(i.postcode);
  const loc = locate(pc);
  const ev = areaEvidence(pc);
  const epc = (i.epc ?? 'D').toUpperCase().slice(0, 1);
  const area = Math.max(15, i.floorArea || Math.round(25 + i.beds * 22));
  const id = i.id ?? `${i.source.kind}-${pc.replace(/\s/g, '').toLowerCase()}-${Math.abs(hue(i.addressLine + i.price + i.beds))}-${Date.now().toString(36)}`;
  return {
    id, title: i.title?.trim() || `${i.beds ? `${i.beds}-bed ` : ''}${i.type}${i.listing === 'rent' ? ' to rent' : ' for sale'} in ${i.town}`,
    street: i.addressLine, district: loc.district, postcode: pc, town: i.town, nation: loc.nation,
    lat: i.geo?.lat ?? loc.lat + ((hue(id) % 20) - 10) / 1000, lng: i.geo?.lng ?? loc.lng + ((hue(id + 'x') % 20) - 10) / 1000,
    listing: i.listing, price: i.price, type: i.type, tenure: i.tenure, leaseYears: i.leaseYears,
    beds: i.beds, baths: Math.max(1, i.baths), floorArea: area, storeys: i.type === 'flat' || i.type === 'bungalow' ? 1 : 2,
    era: i.era ?? '1945-1979', condition: i.condition ?? 'fair',
    epc: { current: epc, potential: epc <= 'C' ? epc : 'C', score: EPC_SCORE[epc] ?? 60 }, councilTax: i.councilTax ?? 'Not stated',
    features: i.features.filter(Boolean),
    loftPotential: i.type === 'flat' ? 'none' : 'possible', extensionPotential: i.type === 'flat' ? 'none' : 'possible',
    estRentPcm: i.listing === 'rent' ? i.price : Math.round(((ev?.rentPerM2 ?? 14) * area) / 25) * 25,
    estGdv: ev ? Math.round(ev.refurbishedPerM2 * area / 1000) * 1000 : Math.round(i.price * 1.1),
    commute: { to: 'Nearest centre', minutes: 0, mode: 'Not yet calculated' }, station: { name: 'Not yet calculated', walkMins: 0 },
    schools: [], risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: new Date().toISOString().slice(0, 7), price: i.price, event: 'Listed' }],
    areaIndex: PROPERTIES.find((p) => p.district === loc.district && !p.source)?.areaIndex ?? Array.from({ length: 24 }, (_, k) => 100 + k * 0.15),
    rentDemand: 70, comparables: [], planningNearby: [], agent: i.source.name, daysOnMarket: 0, photoHue: hue(id),
    serviceChargeAnnual: i.serviceChargeAnnual, groundRentAnnual: i.groundRentAnnual,
    documents: [epc ? 'EPC (stated)' : 'EPC (required)', 'Floor plan (requested)'],
    source: i.source, visibility: i.visibility ?? 'public', photos: i.photos, description: i.description, status: i.status ?? 'live', createdAt: new Date().toISOString(),
  };
}

/* ---------- 2. compliance checks for owner/landlord posts ---------- */
export interface Check { id: string; ok: boolean; severity: 'block' | 'warn'; message: string }
const DISCRIMINATORY = /\b(no (dss|benefits|housing benefit|universal credit)|professionals only|no children|no kids|no families|no students|no pets ever)\b/i;
const BIDDING = /\b(offers? (over|in excess|above)|best offer|bids?|highest offer)\b/i;

export function complianceChecks(i: ListingInput): Check[] {
  const text = `${i.title ?? ''} ${i.description ?? ''} ${i.features.join(' ')}`;
  const c: Check[] = [
    { id: 'price', ok: i.price > 0, severity: 'block', message: i.listing === 'rent' ? 'State the monthly rent.' : 'State the asking price.' },
    { id: 'postcode', ok: POSTCODE_RE.test(i.postcode), severity: 'block', message: 'Enter a full UK postcode (e.g. E17 4QH).' },
    { id: 'tenure', ok: !!i.tenure, severity: 'block', message: 'Tenure is required material information.' },
    { id: 'lease', ok: i.tenure !== 'leasehold' || (i.leaseYears ?? 0) > 0, severity: 'block', message: 'Leasehold: state the remaining lease length, service charge and ground rent.' },
    { id: 'charges', ok: i.tenure !== 'leasehold' || i.serviceChargeAnnual != null, severity: 'warn', message: 'Leasehold: add the annual service charge (material information).' },
    { id: 'ctax', ok: !!i.councilTax && i.councilTax !== 'Not stated', severity: 'block', message: 'Council tax band is required material information.' },
    { id: 'epc', ok: !!i.epc, severity: 'block', message: 'An EPC is legally required before marketing. Add the rating (and upload the certificate).' },
    { id: 'epc-let', ok: i.listing !== 'rent' || !i.epc || i.epc.toUpperCase() <= 'E', severity: 'block', message: 'Rented homes in England & Wales must have EPC E or better (unless a registered exemption applies).' },
    { id: 'photos', ok: (i.photos?.length ?? 0) >= 3, severity: 'warn', message: 'Listings with 3+ photos get far more engagement. Virtually staged images must be labelled.' },
    { id: 'discrim', ok: !DISCRIMINATORY.test(text), severity: 'block', message: 'Remove discriminatory wording (e.g. “No DSS”, “no children”) — unlawful in rental adverts.' },
    { id: 'bidding', ok: i.listing !== 'rent' || !BIDDING.test(text), severity: 'block', message: 'Rental adverts must state a fixed rent; inviting bids above it is prohibited.' },
  ];
  return c;
}

/* ---------- 3. extract a listing pasted from another website ---------- */
export interface Extracted { fields: Partial<ListingInput> & { sourceSite?: string }; found: string[]; missing: string[] }
export function extractListing(text: string, url = ''): Extracted {
  const t = text.replace(/\s+/g, ' ');
  const f: Extracted['fields'] = { features: [] };
  const found: string[] = [];
  try { if (url) f.sourceSite = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const rent = t.match(/£\s?([\d,]+)\s?(pcm|per month|p\/m|pw|per week|p\/w)/i);
  const price = t.match(/(?:£|GBP\s?)([\d,]{4,})(?!\s?(pcm|per month|pw|per week))/i);
  if (rent) { const v = Number(rent[1].replace(/,/g, '')); f.listing = 'rent'; f.price = /w/i.test(rent[2]) ? Math.round((v * 52) / 12) : v; found.push('rent'); }
  else if (price) { f.listing = 'sale'; f.price = Number(price[1].replace(/,/g, '')); found.push('price'); }
  const beds = t.match(/(\d+|one|two|three|four|five|six)[\s-]*(?:double\s|single\s)?bed(room)?s?\b/i);
  const W: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  if (beds) { f.beds = W[beds[1].toLowerCase()] ?? Number(beds[1]); found.push('bedrooms'); } else if (/\bstudio\b/i.test(t)) { f.beds = 0; found.push('bedrooms'); }
  const baths = t.match(/(\d+)\s*bath(room)?s?\b/i); if (baths) { f.baths = Number(baths[1]); found.push('bathrooms'); }
  const pc = t.match(POSTCODE_RE); if (pc) { f.postcode = `${pc[1].toUpperCase()} ${pc[2].toUpperCase()}`; found.push('postcode'); }
  const sqft = t.match(/([\d,]{3,5})\s?(sq\.?\s?ft|sqft|square feet)/i);
  const sqm = t.match(/([\d,.]{2,5})\s?(sq\.?\s?m|m²|m2|square met)/i);
  if (sqm) { f.floorArea = Math.round(Number(sqm[1].replace(/,/g, ''))); found.push('floor area'); }
  else if (sqft) { f.floorArea = Math.round(Number(sqft[1].replace(/,/g, '')) * 0.0929); found.push('floor area'); }
  const type = /semi[- ]detached/i.test(t) ? 'semi-detached' : /\bdetached\b/i.test(t) ? 'detached' : /terrace/i.test(t) ? 'terraced' : /bungalow/i.test(t) ? 'bungalow' : /\b(flat|apartment|maisonette|studio)\b/i.test(t) ? 'flat' : undefined;
  if (type) { f.type = type; found.push('property type'); }
  const tenure = /share of freehold/i.test(t) ? 'share-of-freehold' : /leasehold/i.test(t) ? 'leasehold' : /freehold/i.test(t) ? 'freehold' : undefined;
  if (tenure) { f.tenure = tenure; found.push('tenure'); }
  const lease = t.match(/(\d{2,3})\s*years?\s*(remaining|left|on the lease)/i); if (lease) { f.leaseYears = Number(lease[1]); found.push('lease length'); }
  const epc = t.match(/EPC(?:\s*rating)?\s*[:\-]?\s*([A-G])\b/i); if (epc) { f.epc = epc[1].toUpperCase(); found.push('EPC'); }
  const ct = t.match(/council tax(?:\s*band)?\s*[:\-]?\s*([A-H])\b/i); if (ct) { f.councilTax = ct[1].toUpperCase(); found.push('council tax'); }
  const sc = t.match(/service charge[^£]{0,20}£\s?([\d,]+)/i); if (sc) { f.serviceChargeAnnual = Number(sc[1].replace(/,/g, '')); found.push('service charge'); }
  for (const feat of ['garden', 'parking', 'garage', 'balcony', 'chain free', 'loft', 'cellar', 'period features', 'needs modernisation', 'extension']) if (new RegExp(feat, 'i').test(t)) f.features!.push(feat.replace(/^./, (c) => c.toUpperCase()));
  if (/needs? (modernis|updating|work|refurb)|in need of|renovation project|probate/i.test(t)) f.condition = 'poor';
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 8 && l.length < 120 && !/£/.test(l));
  if (first) f.title = first;
  const required = ['price', 'bedrooms', 'postcode', 'property type', 'tenure'];
  return { fields: f, found, missing: required.filter((r) => !found.includes(r) && !(r === 'price' && found.includes('rent'))) };
}

/* ---------- 4. BLM v3 bulk listing feed (exported by UK agency CRMs) ---------- */
const BLM_TYPE: Record<string, PropertyType> = { '1': 'terraced', '2': 'terraced', '3': 'semi-detached', '4': 'detached', '5': 'terraced', '7': 'flat', '8': 'flat', '9': 'flat', '10': 'flat', '11': 'flat', '12': 'bungalow', '13': 'bungalow', '14': 'bungalow', '15': 'bungalow', '28': 'flat' };
const BLM_TENURE: Record<string, Property['tenure']> = { '1': 'freehold', '2': 'leasehold', '4': 'leasehold', '5': 'share-of-freehold' };

export interface FeedReport {
  accepted: Property[];
  /** The facts exactly as supplied (no defaults filled in), keyed by the agent's own reference — what a server stores. */
  inputs: (ListingInput & { ref: string })[];
  rejected: { ref: string; reason: string }[]; fields: number; version: string;
}

export function parseBLM(raw: string, agentName: string): FeedReport {
  const header = raw.match(/#HEADER#([\s\S]*?)#DEFINITION#/i)?.[1] ?? '';
  const eof = header.match(/EOF\s*:\s*'(.)'/i)?.[1] ?? '^';
  const eor = header.match(/EOR\s*:\s*'(.)'/i)?.[1] ?? '~';
  const version = header.match(/Version\s*:\s*([\d.]+)/i)?.[1] ?? 'unknown';
  const defBlock = raw.match(/#DEFINITION#([\s\S]*?)#DATA#/i)?.[1] ?? '';
  const fields = defBlock.split(eor)[0].trim().split(eof).map((x) => x.trim()).filter(Boolean);
  const dataBlock = raw.match(/#DATA#([\s\S]*?)#END#/i)?.[1] ?? '';
  const rows = dataBlock.split(eor).map((r) => r.trim()).filter(Boolean);
  const accepted: Property[] = []; const inputs: FeedReport['inputs'] = []; const rejected: FeedReport['rejected'] = [];
  for (const r of rows) {
    const row = r.endsWith(eof) ? r.slice(0, -1) : r;
    const vals = row.split(eof);
    const rec: Record<string, string> = Object.fromEntries(fields.map((f, k) => [f, (vals[k] ?? '').trim()]));
    const ref = rec.AGENT_REF || '(no ref)';
    if (vals.length !== fields.length) { rejected.push({ ref, reason: `Expected ${fields.length} fields, got ${vals.length}` }); continue; }
    if (rec.STATUS_ID && rec.STATUS_ID !== '0' && rec.STATUS_ID !== '1') { rejected.push({ ref, reason: `Status ${rec.STATUS_ID} is not available/under offer — skipped` }); continue; }
    const postcode = `${rec.POSTCODE1 ?? ''} ${rec.POSTCODE2 ?? ''}`.trim();
    const price = Number(rec.PRICE);
    if (!POSTCODE_RE.test(postcode)) { rejected.push({ ref, reason: 'Missing or invalid postcode' }); continue; }
    if (!price) { rejected.push({ ref, reason: 'Missing price' }); continue; }
    const lettings = rec.TRANS_TYPE_ID === '2';
    const features = Object.keys(rec).filter((k) => /^FEATURE\d+$/.test(k)).map((k) => rec[k]).filter(Boolean);
    const all = `${rec.SUMMARY ?? ''} ${rec.DESCRIPTION ?? ''} ${features.join(' ')}`;
    const ex = extractListing(all);
    const media = Object.keys(rec).filter((k) => /^MEDIA_IMAGE_\d+$/.test(k)).sort().map((k) => rec[k]).filter((v) => /^https:\/\//i.test(v));
    const input: ListingInput = {
      id: `feed-${agentName.toLowerCase().replace(/[^a-z]+/g, '-')}-${ref.toLowerCase()}`,
      listing: lettings ? 'rent' : 'sale', title: rec.SUMMARY?.slice(0, 90),
      addressLine: [rec.ADDRESS_1, rec.ADDRESS_2].filter(Boolean).join(' '), town: rec.TOWN || rec.ADDRESS_3 || 'Unknown', postcode,
      type: BLM_TYPE[rec.PROP_SUB_ID] ?? ex.fields.type ?? 'terraced', tenure: BLM_TENURE[rec.TENURE_TYPE_ID] ?? ex.fields.tenure ?? 'freehold',
      leaseYears: ex.fields.leaseYears, beds: Number(rec.BEDROOMS) || 0, baths: Number(rec.BATHROOMS) || 1, floorArea: ex.fields.floorArea ?? 0,
      condition: ex.fields.condition, price, epc: ex.fields.epc, councilTax: ex.fields.councilTax, serviceChargeAnnual: ex.fields.serviceChargeAnnual,
      features, description: rec.DESCRIPTION, photos: media.length ? media : undefined,
      source: { kind: 'agent-feed', name: `${agentName} (agent feed)`, licence: 'Displayed under agent feed agreement; agent retains ownership', verified: true },
      status: rec.STATUS_ID === '1' ? 'under offer' : 'live',
    };
    inputs.push({ ...input, ref });
    accepted.push(buildListing(input));
  }
  return { accepted, inputs, rejected, fields: fields.length, version };
}

/* ---------- 5. merge the same home from several sources ---------- */
const keyOf = (p: Property) => `${p.postcode.replace(/\s/g, '')}|${p.street.toLowerCase().replace(/\(fictional\)|[^a-z]/g, '').slice(0, 10)}|${p.beds}|${p.listing}`;
export function dedupe(list: Property[]): { merged: Property[]; duplicates: { kept: string; dropped: string }[] } {
  const map = new Map<string, Property>(); const duplicates: { kept: string; dropped: string }[] = [];
  for (const p of list) {
    const k = keyOf(p); const existing = map.get(k);
    if (existing && Math.abs(existing.price - p.price) / existing.price <= 0.05) {
      // Keep the first-seen record unless a verified agent feed replaces an unverified owner post.
      const keepNew = existing.source?.kind === 'owner' && p.source?.verified;
      const [keep, drop] = keepNew ? [p, existing] : [existing, p];
      keep.alsoListedBy = [...new Set([...(keep.alsoListedBy ?? []), drop.source?.name ?? drop.agent])];
      map.set(k, keep); duplicates.push({ kept: keep.id, dropped: drop.id });
    } else map.set(existing ? `${k}#${p.id}` : k, p);
  }
  return { merged: [...map.values()], duplicates };
}

/* ---------- 6. "Search everywhere" — deep links (we link out; we don't copy) ---------- */
export function externalSearchLinks(place: string, mode: 'sale' | 'rent') {
  const slug = place.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const title = place.trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, '-');
  if (!slug) return [];
  return [
    { site: 'Rightmove', url: `https://www.rightmove.co.uk/${mode === 'rent' ? 'property-to-rent' : 'property-for-sale'}/${title}.html` },
    { site: 'Zoopla', url: `https://www.zoopla.co.uk/${mode === 'rent' ? 'to-rent' : 'for-sale'}/property/${slug}/` },
    { site: 'OnTheMarket', url: `https://www.onthemarket.com/${mode === 'rent' ? 'to-rent' : 'for-sale'}/property/${slug}/` },
  ];
}
