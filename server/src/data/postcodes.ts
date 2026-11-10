/**
 * Places and postcodes (postcodes.io: open data from ONS, Ordnance Survey and Royal Mail).
 * Turns what a person typed (a full postcode, a postcode district such as "E17", or a place
 * name) into a location, and finds the postcodes around a point.
 */
import { normalisePostcode, POSTCODE_RE } from '../../../src/engine/listings';
import { config } from '../config';
import { cachedData, DAY } from './cache';
import { DataError, fetchJSON } from './http';

export interface Place {
  kind: 'postcode' | 'outcode' | 'place';
  /** How to name it to people, e.g. "E17 4PP", "E17" or "Walthamstow". */
  label: string;
  postcode: string | null;
  outcode: string | null;
  lat: number;
  lng: number;
  /** Local authority, e.g. "Waltham Forest", and its statistics code (used for the House Price Index). */
  district: string | null;
  districtCode: string | null;
  country: string | null;
}
export interface NearbyPostcode { postcode: string; distanceM: number; lat?: number; lng?: number }

interface PcResult {
  postcode: string; outcode: string; latitude: number | null; longitude: number | null; country: string | null;
  admin_district: string | null; codes?: { admin_district?: string | null }; distance?: number;
}
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const base = () => config.data.postcodesUrl;
const get = <T>(path: string) => fetchJSON<{ status: number; result: T | null }>(`${base()}${path}`, { source: 'postcodes', timeoutMs: 5000 });

const fromPc = (r: PcResult, kind: Place['kind'] = 'postcode', label?: string): Place => ({
  kind, label: label ?? r.postcode, postcode: kind === 'postcode' ? r.postcode : null, outcode: r.outcode ?? null,
  lat: r.latitude!, lng: r.longitude!, district: r.admin_district ?? null, districtCode: r.codes?.admin_district ?? null, country: r.country ?? null,
});

/** A full postcode → its centre and local authority. null when the postcode doesn't exist. */
export async function lookupPostcode(postcode: string): Promise<Place | null> {
  const pc = normalisePostcode(postcode);
  if (!POSTCODE_RE.test(pc)) return null;
  const c = await cachedData<Place | null>(`pc:${pc}`, 90 * DAY, async () => {
    const { status, json } = await get<PcResult>(`/postcodes/${encodeURIComponent(pc)}`);
    if (status === 404) return null;
    if (status !== 200 || !json?.result || json.result.latitude == null) throw new DataError('postcodes', 'Couldn’t look up that postcode just now. Please try again.');
    return fromPc(json.result);
  });
  return c.value;
}

/** The postcodes around a point, nearest first (at most 100, within at most 2 km), plus the local authority there. */
export async function nearestPostcodes(lat: number, lng: number, radiusM = 400, limit = 100): Promise<{ items: NearbyPostcode[]; district: string | null; districtCode: string | null; country: string | null }> {
  const r = Math.max(50, Math.min(2000, Math.round(radiusM))), n = Math.max(1, Math.min(100, limit));
  const key = `near:${lat.toFixed(4)},${lng.toFixed(4)}:${r}:${n}`;
  const c = await cachedData(key, 60 * DAY, async () => {
    const { status, json } = await get<PcResult[]>(`/postcodes?lon=${lng.toFixed(6)}&lat=${lat.toFixed(6)}&radius=${r}&limit=${n}`);
    if (status !== 200 || !json) throw new DataError('postcodes', 'Couldn’t find the postcodes around there just now. Please try again.');
    const rows = json.result ?? [];
    return {
      items: rows.map((x) => ({ postcode: x.postcode, distanceM: Math.round(x.distance ?? 0), ...(x.latitude != null && x.longitude != null ? { lat: x.latitude, lng: x.longitude } : {}) })),
      district: rows[0]?.admin_district ?? null, districtCode: rows[0]?.codes?.admin_district ?? null, country: rows[0]?.country ?? null,
    };
  });
  return c.value;
}

/**
 * What a person typed → a place. Understands a full postcode ("E17 4PP"), a postcode district
 * ("E17") and place names ("Walthamstow", "Leeds"). null when nothing matches.
 */
export async function resolvePlace(input: string): Promise<Place | null> {
  const text = input.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!text) return null;
  if (POSTCODE_RE.test(text) && text.replace(/\s/g, '').length <= 8) return lookupPostcode(text);
  if (OUTCODE_RE.test(text)) {
    const oc = text.toUpperCase();
    const c = await cachedData<Place | null>(`oc:${oc}`, 90 * DAY, async () => {
      const { status, json } = await get<{ outcode: string; latitude: number | null; longitude: number | null; admin_district: string[]; country: string[] }>(`/outcodes/${encodeURIComponent(oc)}`);
      if (status === 404) return null;
      if (status !== 200 || !json?.result || json.result.latitude == null) throw new DataError('postcodes', 'Couldn’t look up that postcode district just now. Please try again.');
      const o = json.result;
      // The district's own local authority and code come from the nearest postcode to its centre.
      const near = await nearestPostcodes(o.latitude!, o.longitude!, 600, 1).catch(() => null);
      return { kind: 'outcode' as const, label: o.outcode, postcode: null, outcode: o.outcode, lat: o.latitude!, lng: o.longitude!, district: near?.district ?? o.admin_district?.[0] ?? null, districtCode: near?.districtCode ?? null, country: near?.country ?? o.country?.[0] ?? null };
    });
    return c.value;
  }
  if (!/^[\p{L}][\p{L} .,'’&-]{1,60}$/u.test(text)) return null;
  const key = `place:${text.toLowerCase()}`;
  const c = await cachedData<Place | null>(key, 90 * DAY, async () => {
    const { status, json } = await get<{ name_1: string; latitude: number; longitude: number; local_type: string; country: string | null }[]>(`/places?q=${encodeURIComponent(text)}&limit=5`);
    if (status !== 200 || !json) throw new DataError('postcodes', 'Couldn’t look up that place just now. Please try again.');
    const rows = json.result ?? [];
    // Prefer a settlement whose name matches exactly, then cities and towns over hamlets and suburbs.
    const rank = (t: string) => ['City', 'Town', 'Other Settlement', 'Suburban Area', 'Village', 'Hamlet'].indexOf(t);
    const exact = rows.filter((x) => x.name_1.toLowerCase() === text.toLowerCase());
    const best = (exact.length ? exact : rows).sort((a, b) => (rank(a.local_type) < 0 ? 9 : rank(a.local_type)) - (rank(b.local_type) < 0 ? 9 : rank(b.local_type)))[0];
    if (!best) return null;
    const near = await nearestPostcodes(best.latitude, best.longitude, 1000, 1).catch(() => null);
    return { kind: 'place' as const, label: best.name_1, postcode: null, outcode: near?.items[0]?.postcode.split(' ')[0] ?? null, lat: best.latitude, lng: best.longitude, district: near?.district ?? null, districtCode: near?.districtCode ?? null, country: near?.country ?? best.country ?? null };
  });
  return c.value;
}
