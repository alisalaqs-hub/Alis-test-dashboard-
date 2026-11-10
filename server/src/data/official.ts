/**
 * Official data, put together for the two things the site asks for:
 *   - sold prices around a place someone searched for
 *   - everything known about a live listing's location (sold prices nearby, where the asking
 *     price sits against them, flood risk, and the home's energy certificate)
 *
 * Privacy: a private seller's house number and full postcode are never public, and the public
 * map position is rounded to about 200 m. Official data for their listing is centred on that
 * same rounded position, sales carry no distances, and the certificate number is withheld, so
 * nothing here narrows down where the home is beyond what the advert already shows.
 */
import { ATTRIBUTION, evidenceRange, soldStats, soldTypeFor, type SoldSale } from '../../../src/engine/evidence';
import type { OfficialListingDTO, SoldPricesDTO } from '../../../src/lib/apiTypes';
import type { ListingRow } from '../services/listings';
import { epcConfigured, epcForAddress } from './epc';
import { floodRisk } from './flood';
import { ensureSales, houseHpi, storedSales } from './landRegistry';
import { nearestPostcodes, type NearbyPostcode, type Place } from './postcodes';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return iso(d); };
const metres = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const rad = Math.PI / 180, dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
};
const COVERED = (country: string | null) => !country || country === 'England' || country === 'Wales';
const MAX_LISTED = 300;

/**
 * The postcodes to ask about. A full postcode: the nearest 100 within the radius. A district or
 * a town: five overlapping circles (the centre and 450 m north, south, east and west), because
 * the postcode service returns at most 100 postcodes per point and a town centre is dense.
 */
async function postcodesAround(place: Pick<Place, 'lat' | 'lng' | 'kind'>, radiusM: number): Promise<{ items: NearbyPostcode[]; district: string | null; districtCode: string | null; country: string | null }> {
  const centre = await nearestPostcodes(place.lat, place.lng, radiusM, 100);
  if (place.kind === 'postcode') return centre;
  const step = 450 / 111_320, stepLng = step / Math.cos((place.lat * Math.PI) / 180);
  const around = await Promise.allSettled([[step, 0], [-step, 0], [0, stepLng], [0, -stepLng]].map(([dLat, dLng]) => nearestPostcodes(place.lat + dLat, place.lng + dLng, radiusM, 100)));
  const all = new Map<string, NearbyPostcode>();
  for (const r of [centre, ...around.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []))]) {
    for (const p of r.items) {
      const d = p.lat != null && p.lng != null ? metres(place.lat, place.lng, p.lat, p.lng) : p.distanceM;
      if (!all.has(p.postcode)) all.set(p.postcode, { ...p, distanceM: d });
    }
  }
  return { ...centre, items: [...all.values()].sort((a, b) => a.distanceM - b.distanceM) };
}

export async function soldAround(place: Place, o: { radiusM?: number; years?: number } = {}): Promise<SoldPricesDTO> {
  const years = Math.max(1, Math.min(10, o.years ?? 5));
  const radiusM = Math.max(100, Math.min(1500, o.radiusM ?? (place.kind === 'postcode' ? 400 : 500)));
  const head = { place: { kind: place.kind, label: place.label, district: place.district, country: place.country }, years, attribution: [ATTRIBUTION.landRegistry, ATTRIBUTION.postcodes] };
  if (!COVERED(place.country)) {
    return { ...head, coverage: 'not-covered', radiusM, sales: [], totalSales: 0, stats: soldStats([]), hpi: await houseHpi(place.districtCode, place.district).catch(() => null), partial: false };
  }
  const near = await postcodesAround(place, radiusM);
  const since = yearsAgo(years);
  const [complete, hpi] = await Promise.all([
    ensureSales(near.items.map((p) => p.postcode), since).catch(() => false),
    houseHpi(place.districtCode ?? near.districtCode, place.district ?? near.district).catch(() => null),
  ]);
  const sales = await storedSales(near.items, since);
  const reach = near.items.length ? Math.max(...near.items.map((p) => p.distanceM)) : radiusM;
  return { ...head, coverage: 'england-wales', radiusM: Math.max(50, Math.round(reach / 10) * 10), sales: sales.slice(0, MAX_LISTED), totalSales: sales.length, stats: soldStats(sales), hpi, partial: !complete };
}

const isAgent = (r: ListingRow) => r.source_kind === 'agent-feed' || r.source_kind === 'agent';

/** Everything official about a live listing's location. Each part fails on its own: a slow flood map never hides the sold prices. */
export async function officialForListing(r: ListingRow): Promise<OfficialListingDTO> {
  const full = isAgent(r);
  const attribution = [ATTRIBUTION.landRegistry, ATTRIBUTION.environmentAgency, ATTRIBUTION.postcodes];
  const base: OfficialListingDTO = { ref: r.ref, sold: null, range: null, flood: null, epc: null, epcStatus: epcConfigured() ? 'no-match' : 'not-configured', attribution };
  if (r.lat == null || r.lng == null) return base;
  // The same rounding the public listing uses for private sellers (about 200 m).
  const lat = full ? r.lat : Math.round(r.lat * 500) / 500, lng = full ? r.lng : Math.round(r.lng * 500) / 500;
  const near = await nearestPostcodes(lat, lng, full ? 400 : 600, 100).catch(() => null);
  const country = near?.country ?? null;

  const soldPart = (async () => {
    if (!near || !COVERED(country)) return null;
    const years = 5, since = yearsAgo(years);
    const [complete, hpi] = await Promise.all([ensureSales(near.items.map((p) => p.postcode), since).catch(() => false), houseHpi(near.districtCode, near.district).catch(() => null)]);
    const all = await storedSales(near.items, since);
    const sales: SoldSale[] = full ? all : all.map((s) => ({ ...s, distanceM: null }));
    const reach = near.items.length ? Math.max(...near.items.map((p) => p.distanceM)) : 400;
    return {
      sold: { coverage: 'england-wales' as const, radiusM: Math.round(reach / 10) * 10, years, sales: sales.slice(0, 40), totalSales: sales.length, stats: soldStats(sales), hpi, partial: !complete },
      range: r.channel === 'sale' ? evidenceRange(all, { type: soldTypeFor(r.property_type), price: r.price }) : null,
    };
  })().catch(() => null);

  // Flood risk is read at the home's own postcode centre (only the bands leave the server).
  const floodPart = floodRisk(r.lat, r.lng, { country, approximate: true }).catch(() => null);

  const epcPart = (async (): Promise<Pick<OfficialListingDTO, 'epc' | 'epcStatus'>> => {
    if (!epcConfigured()) return { epc: null, epcStatus: 'not-configured' };
    try {
      const c = await epcForAddress(r.postcode, r.address_line);
      if (!c) return { epc: null, epcStatus: 'no-match' };
      return {
        epcStatus: 'ok',
        epc: { band: c.band, potentialBand: c.potentialBand, score: c.score, registeredOn: c.registeredOn, expired: c.expired, floorAreaM2: c.floorAreaM2, certificateNumber: full ? c.certificateNumber : null, matchesListing: r.epc && c.band ? r.epc === c.band : null },
      };
    } catch { return { epc: null, epcStatus: 'unavailable' }; }
  })();

  const [sold, flood, epc] = await Promise.all([soldPart, floodPart, epcPart]);
  return { ...base, sold: sold?.sold ?? null, range: sold?.range ?? null, flood, ...epc, attribution: epc.epc ? [...attribution, ATTRIBUTION.epc] : attribution };
}
