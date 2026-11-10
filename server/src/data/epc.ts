/**
 * Energy Performance Certificates for England and Wales, from the government's
 * "Get energy performance of buildings data" service (the replacement for
 * epc.opendatacommunities.org, which closed in 2026). Needs a free bearer token: sign in at
 * get-energy-performance-data.communities.gov.uk with GOV.UK One Login and copy it from
 * "My account" into EPC_API_TOKEN.
 *
 * Certificates are address-level records, so they count as personal data. Streetkey only looks a
 * certificate up for a home that is being listed (by its lister, or to show the rating on the
 * live advert, which the law requires anyway) and never offers a browsable register.
 */
import { epcExpired, isEpcBand, type EpcCertificate, type EpcSummary } from '../../../src/engine/evidence';
import { normalisePostcode, POSTCODE_RE } from '../../../src/engine/listings';
import { config } from '../config';
import { cachedData, DAY } from './cache';
import { DataError, fetchJSON } from './http';

export const epcConfigured = () => !!config.data.epcToken && !config.data.disabled;

async function epcGet<T>(path: string) {
  if (!epcConfigured()) throw new DataError('epc', 'Energy certificate lookups aren’t set up on this site yet.', 503, 'epc_not_configured');
  const r = await fetchJSON<T>(`${config.data.epcUrl}${path}`, { source: 'epc', timeoutMs: 8000, headers: { Authorization: `Bearer ${config.data.epcToken}` } });
  if (r.status === 401 || r.status === 403) throw new DataError('epc', 'The energy certificate register refused Streetkey’s access token. An admin needs to check EPC_API_TOKEN.', 503, 'epc_token');
  if (r.status === 429) throw new DataError('epc', 'The energy certificate register is busy. Please try again in a minute.', 503, 'epc_busy');
  return r;
}

interface SearchRow { certificateNumber?: string; addressLine1?: string | null; addressLine2?: string | null; addressLine3?: string | null; addressLine4?: string | null; postcode?: string; postTown?: string | null; currentEnergyEfficiencyBand?: string | null; registrationDate?: string | null; uprn?: number | string | null }
const joinAddress = (parts: (string | null | undefined)[]) => parts.map((p) => (p ?? '').trim()).filter(Boolean).join(', ');
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/** Certificates registered at a postcode: the latest one for each address, newest first. */
export async function epcSearch(postcode: string): Promise<EpcSummary[]> {
  const pc = normalisePostcode(postcode);
  if (!POSTCODE_RE.test(pc)) return [];
  const c = await cachedData<EpcSummary[]>(`epc:pc:${pc}`, 14 * DAY, async () => {
    const { status, json } = await epcGet<{ data?: SearchRow[] | { certificates?: SearchRow[] } }>(`/api/domestic/search?postcode=${encodeURIComponent(pc)}&page_size=500`);
    if (status === 404) return [];
    if (status !== 200 || !json) throw new DataError('epc', 'Couldn’t read the energy certificate register just now. Please try again.');
    const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.data?.certificates) ? json.data.certificates : [];
    const latest = new Map<string, EpcSummary>();
    for (const r of rows) {
      if (!r.certificateNumber || !/^\d{4}-?\d{4}-?\d{4}-?\d{4}-?\d{4}$/.test(r.certificateNumber)) continue;
      const address = joinAddress([r.addressLine1, r.addressLine2, r.addressLine3, r.addressLine4]);
      const key = r.uprn ? `u:${r.uprn}` : `a:${addressKey(address)}`;
      const s: EpcSummary = { certificateNumber: r.certificateNumber, address, postcode: pc, band: isEpcBand(r.currentEnergyEfficiencyBand) ? r.currentEnergyEfficiencyBand : null, registeredOn: day(r.registrationDate) };
      const prev = latest.get(key);
      if (!prev || (s.registeredOn ?? '') > (prev.registeredOn ?? '')) latest.set(key, s);
    }
    return [...latest.values()].sort((a, b) => a.address.localeCompare(b.address, 'en-GB', { numeric: true }));
  });
  return c.value;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : v && typeof v === 'object' && 'value' in v ? Number((v as { value: unknown }).value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const sum = (xs: (number | null)[]) => (xs.every((x) => x == null) ? null : Math.round(xs.reduce<number>((t, x) => t + (x ?? 0), 0)));

/** The full certificate. null when the register doesn't have it. */
export async function epcCertificate(certificateNumber: string): Promise<EpcCertificate | null> {
  const n = certificateNumber.replace(/[^\d]/g, '');
  if (n.length !== 20) return null;
  const number = n.replace(/(\d{4})(?=\d)/g, '$1-');
  const c = await cachedData<EpcCertificate | null>(`epc:cert:${number}`, 180 * DAY, async () => {
    const { status, json } = await epcGet<{ data?: Record<string, unknown> }>(`/api/certificate?certificate_number=${number}`);
    if (status === 404) return null;
    if (status !== 200 || !json?.data) throw new DataError('epc', 'Couldn’t read that energy certificate just now. Please try again.');
    const d = json.data;
    const registeredOn = day(d.registration_date as string);
    const band = d.current_energy_efficiency_band, potential = d.potential_energy_efficiency_band;
    const improvements = Array.isArray(d.suggested_improvements) ? d.suggested_improvements as Record<string, unknown>[] : [];
    return {
      certificateNumber: number,
      address: joinAddress([d.address_line_1, d.address_line_2, d.address_line_3, d.address_line_4, d.post_town] as string[]),
      postcode: typeof d.postcode === 'string' ? normalisePostcode(d.postcode) : '',
      band: isEpcBand(band) ? band : null, registeredOn,
      score: num(d.energy_rating_current), potentialBand: isEpcBand(potential) ? potential : null, potentialScore: num(d.energy_rating_potential),
      floorAreaM2: num(d.total_floor_area), dwellingType: typeof d.dwelling_type === 'string' ? d.dwelling_type.slice(0, 80) : null, expired: epcExpired(registeredOn),
      yearlyCost: {
        current: sum([num(d.heating_cost_current), num(d.hot_water_cost_current), num(d.lighting_cost_current)]),
        potential: sum([num(d.heating_cost_potential), num(d.hot_water_cost_potential), num(d.lighting_cost_potential)]),
      },
      improvements: improvements.slice(0, 12).map((i) => ({ cost: typeof i.indicative_cost === 'string' ? i.indicative_cost.slice(0, 40) : null, saving: num(i.typical_saving) })),
    };
  });
  return c.value;
}

/** Letters and digits only, upper case: "Flat 2, 14 Example Rd." → "FLAT 2 14 EXAMPLE RD". */
export const addressKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const numbers = (s: string) => (addressKey(s).match(/\b\d+[A-Z]?\b/g) ?? []).sort().join(' ');

/**
 * The certificate for one address at a postcode, or null when none matches with confidence.
 * Matching is strict: the house and flat numbers must all agree (so "14" never matches
 * "Flat 2, 14"), or, for a named house with no number, the name must appear in the certificate's
 * address. When two different addresses both fit, nothing is returned.
 */
export async function epcForAddress(postcode: string, addressLine: string): Promise<EpcCertificate | null> {
  const want = addressKey(addressLine);
  if (!want) return null;
  const list = await epcSearch(postcode);
  const wantNumbers = numbers(addressLine);
  const firstWords = want.split(' ').slice(0, 2).join(' ');
  const hits = list.filter((s) => {
    const firstTwo = s.address.split(', ').slice(0, 2).join(' ');
    if (wantNumbers) return numbers(firstTwo) === wantNumbers;
    return firstWords.length >= 4 && addressKey(s.address).includes(firstWords);
  });
  if (hits.length !== 1) return null;
  return epcCertificate(hits[0].certificateNumber);
}
