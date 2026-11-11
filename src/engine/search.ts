/**
 * Natural-language property search — prototype interpreter.
 *
 * In production the LLM's ONLY job here is to translate the user's words
 * into a validated `SearchQuery` (via tool/function calling with a JSON
 * schema). Retrieval, filtering, financial maths and ranking stay
 * deterministic, so the AI cannot invent listings or numbers.
 *
 * This prototype uses a rule-based parser that produces the same
 * structure, so the UI and ranking pipeline are real and testable offline.
 */
import { PROPERTIES, type Property } from '../data/properties';
import { dealScore, loftScenario } from './insights';

export interface SearchQuery {
  intent: 'buy' | 'rent' | 'invest';
  minBeds?: number;
  maxPrice?: number;
  locations: string[];
  districts: string[];
  maxCommuteMins?: number;
  commuteTo?: string;
  types: Property['type'][];
  wantsLoft?: boolean;
  wantsExtension?: boolean;
  wantsGarden?: boolean;
  minRefurbProfit?: number;
  minYield?: number;
  hmo?: boolean;
  auction?: boolean;
  chainFree?: boolean;
  goodSchools?: boolean;
  conversion?: boolean;
  lowServiceCharge?: boolean;
  needsRefurb?: boolean;
  goodReturn?: boolean;
  rentalDemand?: boolean;
  commercial?: boolean;
  unsupported: string[];
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const BED_N = '(\\d|one|two|three|four|five|six|seven|eight|nine|ten)';
const BED_WORD = '(?:\\+\\s*)?(?:bed(?:room)?s?|br)\\b';
const BED_RANGE = new RegExp(`\\b${BED_N}\\s*(?:-|–|to|or|and)\\s*${BED_N}[- ]?${BED_WORD}`);
const BED_ANY = new RegExp(`\\b${BED_N}[- ]?${BED_WORD}`, 'g');
/** "up to 4 beds": 4 is a ceiling, not a minimum. */
const BED_CEILING = /\b(?:up to|max(?:imum)?(?:\s+of)?|no more than|not more than|at most)\s*$/;
/** "fewer than 4 bedrooms": at most 3. */
const BED_BELOW = /\b(?:fewer than|less than|under|below)\s*$/;
const bedNumber = (s: string) => WORD_NUM[s] ?? parseInt(s, 10);

/**
 * The bedrooms someone asked for, read from their words:
 * "3 bed" → min 3 · "2 to 3 beds" / "2-3 bed" → min 2, max 3 · "up to 4 beds" → max 4 (not "4+") · "fewer than 4 bedrooms" → max 3.
 */
export function bedroomRange(text: string): { min?: number; max?: number } {
  const t = ` ${text.toLowerCase()} `;
  const range = t.match(BED_RANGE);
  if (range) {
    const a = bedNumber(range[1]); const b = bedNumber(range[2]);
    if (a > 0 && b >= a) return { min: a, max: b };
  }
  const out: { min?: number; max?: number } = {};
  for (const m of t.matchAll(BED_ANY)) {
    const before = t.slice(0, m.index);
    const v = bedNumber(m[1]);
    if (BED_CEILING.test(before)) { if (out.max == null) out.max = v; }
    else if (BED_BELOW.test(before)) { if (out.max == null && v > 1) out.max = v - 1; }
    else if (out.min == null) out.min = v;
  }
  if (out.min != null && out.max != null && out.max < out.min) delete out.max;
  return out;
}

/**
 * Phrases that contain rent words but mean buying or investing: "buy to let", a "sitting tenant",
 * "tenants in place", "a flat with tenants". Removed before the rent words are tested.
 * (Plain replaces rather than lookbehind: Safari before 16.4 can't parse lookbehind and the site wouldn't start.)
 */
const NOT_RENTING = [
  /\bbuy[- ]to[- ]let\b/g, /\bsitting tenants?\b/g, /\btenants?\s+in\s+(?:situ|place)\b/g,
  // "with tenants" / "with a long-term tenant" (but not "with other tenants", someone renting a room).
  /\bwith\s+(?:(?:an?|the|its|existing|current|long[- ]term|good|reliable|paying)\s+){0,2}tenants?\b/g,
];
/**
 * Words that say the person wants to rent: "to rent", "for rent", "to let", "rental(s)", "pcm", "per month",
 * "tenant", "£300 a week". Not "to rent out" (investing), "rental demand / yield / income" (investment measures)
 * or a "rental property / investment" (something to buy). Test with {@link rentCue}, which removes NOT_RENTING first.
 */
export const RENT_WORDS = /\b(?:to rent(?!\s+(?:it\s+|them\s+)?out)|for rent|renting(?!\s+(?:it\s+|them\s+)?out)|per month|pcm|p\/m|to[- ]let|tenants?)\b|\brentals?\b(?!\s+(?:demand|yields?|income|returns?|potential|market|values?|growth|property|properties|flats?|houses?|homes?|investments?|portfolios?|business(?:es)?|units?|opportunit\w*))|(?:£\s?\d[\d,.]*|\b\d{2,}[\d,.]*)\s*(?:a week|per week|pw|p\/w|weekly)\b/;
/** Words that say the person is buying ("rental property to buy", "buy a rental flat"): rent words then don't decide. */
export const PURCHASE_WORDS = /\b(?:buy|buying|purchas\w*|for sale)\b/;
/** Words that say the person is investing. */
export const INVEST_WORDS = /\b(invest\w*|yield|btl|buy[- ]to[- ]let|brrr+|flip\w*|hmo|portfolio|profit|rent(?:ing)? (?:it |them )?out|rentals? (?:property|properties|investments?|portfolios?|business(?:es)?|units?))\b/;
const withoutNotRenting = (text: string) => NOT_RENTING.reduce((s, re) => s.replace(re, ' '), ` ${text.toLowerCase()} `);
/** The text has an explicit rent word (whether or not it also says buy). */
export const rentCue = (text: string) => RENT_WORDS.test(withoutNotRenting(text));
/** The text has an explicit purchase word (not "buy to let", which is investing). */
export const purchaseCue = (text: string) => PURCHASE_WORDS.test(withoutNotRenting(text));
/** The person is renting: an explicit rent word and no purchase word ("rental property to buy" is buying). */
export const saysRent = (text: string) => rentCue(text) && !purchaseCue(text);

const PLACE_ALIASES: Record<string, string[]> = {
  london: ['London'], manchester: ['Manchester'], leeds: ['Leeds'], bristol: ['Bristol'], birmingham: ['Birmingham'],
  liverpool: ['Liverpool'], sheffield: ['Sheffield'], cardiff: ['Cardiff'], wales: ['Cardiff'], glasgow: ['Glasgow'],
  scotland: ['Glasgow'], nottingham: ['Nottingham'], north: ['Manchester', 'Leeds', 'Liverpool', 'Sheffield'],
  midlands: ['Birmingham', 'Nottingham'],
  croydon: ['Croydon'], walthamstow: ['Walthamstow'], leyton: ['Leyton'], watford: ['Watford'], fallowfield: ['Fallowfield'], headingley: ['Headingley'],
  clifton: ['Clifton'], bishopston: ['Bishopston'], wavertree: ['Wavertree'], ecclesall: ['Ecclesall'], roath: ['Roath'], shawlands: ['Shawlands'], 'selly oak': ['Selly Oak'], hertfordshire: ['Hertfordshire'],
};

function money(raw: string): number {
  const m = raw.replace(/[£,\s]/g, '').replace(/\.+$/, '').toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2] === 'k' ? n * 1_000 : m[2] === 'm' ? n * 1_000_000 : n;
}

export function parseQuery(text: string): SearchQuery {
  const t = ` ${text.toLowerCase()} `;
  const q: SearchQuery = { intent: 'buy', locations: [], districts: [], types: [], unsupported: [] };

  // "Buy to let flat, tenants pay £1,100 pcm" is an investment: the rent words describe the tenants.
  if (saysRent(t) && !/\b(?:buy[- ]to[- ]let|btl)\b/.test(t)) q.intent = 'rent';
  else if (INVEST_WORDS.test(t)) q.intent = 'invest';

  const beds = bedroomRange(text);
  if (beds.min) q.minBeds = beds.min;

  // A price needs £, a k/m suffix, at least 4 digits or a weekly marker ("up to 4 beds" is not £4; "under 250pw" is a rent).
  const price = t.match(/\b(?:under|below|less than|max(?:imum)?|up to|budget(?: of)?)\s*(£\s?[\d,.]+\s?[km]?|[\d,.]+\s?[km]\b|\d[\d,]{3,}(?:\.\d+)?|\d{2,}(?=\s*(?:(?:a|per)\s+week|pw|p\/w|weekly)\b))(?!\s*(?:-|\s)?(?:bed|bath|br\b|min|mile|year|week|storey|floor))/);
  if (price) {
    const v = money(price[1]);
    // Rents are compared per calendar month: "under £300 a week" is £1,300 pcm.
    const weekly = /^\s*(?:(?:a|per)\s+week|pw|p\/w|weekly)\b/.test(t.slice((price.index ?? 0) + price[0].length));
    if (Number.isFinite(v) && v >= 100) q.maxPrice = weekly ? Math.round(v * 52 / 12) : v;
  }

  const commute = t.match(/within\s+(\d+)\s*(?:min(?:ute)?s?)\s+(?:of|from|to)\s+([a-z\s]+?)(?:,|\.|\bunder\b|\bwith\b|\band\b|\bfor\b|\bthat\b|$)/);
  if (commute) { q.maxCommuteMins = parseInt(commute[1], 10); q.commuteTo = commute[2].trim(); }

  for (const [k, v] of Object.entries(PLACE_ALIASES)) if (new RegExp(`\\b${k}\\b`).test(t)) q.locations.push(...v);
  if (/near london|around london|london commuter|home counties|hertfordshire|watford/.test(t)) q.locations.push('Watford', 'Hertfordshire');
  q.locations = [...new Set(q.locations)];
  // Postcode districts (outward codes) e.g. E17, CR0, M14, LS6
  for (const m of t.matchAll(/\b([a-z]{1,2}\d{1,2}[a-z]?)\b/g)) if (!/^\d/.test(m[1]) && !/^(k|m)\d+$/.test(m[1]) || /^m\d{1,2}$/.test(m[1])) q.districts.push(m[1].toUpperCase());
  q.districts = [...new Set(q.districts)].filter((d) => /^[A-Z]{1,2}\d{1,2}[A-Z]?$/.test(d));

  if (/\bterrace/.test(t)) q.types.push('terraced');
  if (/\bsemi\b|semi-detached/.test(t)) q.types.push('semi-detached');
  if (/\bdetached\b/.test(t) && !/semi-detached/.test(t)) q.types.push('detached');
  if (/\b(flat|apartment|maisonette|tenement)\b/.test(t)) q.types.push('flat');
  if (/\bhouse\b/.test(t) && q.types.length === 0) q.types.push('terraced', 'semi-detached', 'detached');

  if (/\bloft\b/.test(t)) q.wantsLoft = true;
  if (/\bextension|extend|side return\b/.test(t)) q.wantsExtension = true;
  if (/\bgarden\b/.test(t)) q.wantsGarden = true;
  if (/\bhmo\b/.test(t)) q.hmo = true;
  if (/\bauction\b/.test(t)) q.auction = true;
  if (/chain[- ]free/.test(t)) q.chainFree = true;
  if (/\bschools?\b/.test(t)) q.goodSchools = true;
  if (/convert(ed)? into (multiple )?flats|multiple flats|subdivi|split into flats|flat conversion/.test(t)) q.conversion = true;
  if (/low service charge/.test(t)) q.lowServiceCharge = true;
  if (/requires? refurb|needs? (refurb|work|modernis)|renovation project|fixer/.test(t)) q.needsRefurb = true;
  if (/investment return|good return|good investment/.test(t)) { q.goodReturn = true; if (q.intent === 'buy') q.intent = 'invest'; }
  if (/rental demand|easy to let/.test(t)) q.rentalDemand = true;
  if (/\b(office|commercial|retail|industrial|class ma|office-to-residential)\b/.test(t)) q.commercial = true;

  const profit = t.match(/(?:profit|uplift|equity)(?:\s+of)?(?:\s+(?:at least|over|above|minimum))?\s*(£?\s?[\d,.]+\s?[km]?)/) || t.match(/(£\s?[\d,.]+\s?[km]?)\s+(?:refurb(?:ishment)?\s+)?(?:profit|uplift)/);
  if (profit) q.minRefurbProfit = money(profit[1]);

  const yieldM = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:gross\s+)?yield|yield\s+(?:of|over|above|at least)?\s*(\d+(?:\.\d+)?)\s*%/);
  if (yieldM) q.minYield = parseFloat(yieldM[1] ?? yieldM[2]) / 100;

  if (/\b(crime|safe|quiet)\b/.test(t)) q.unsupported.push('Crime/safety — police.uk open data integration planned (not in demo).');
  if (/\b(broadband|fibre)\b/.test(t)) q.unsupported.push('Broadband speeds — Ofcom Connected Nations data planned.');
  if (/\bnew[- ]build\b/.test(t)) q.unsupported.push('New-build filter — requires developer feed.');
  return q;
}

export interface SearchHit { property: Property; score: number; reasons: string[]; cautions: string[]; dealGrade: string; estProfit: number }

/** Commute to a named hub: demo uses the listing's own commute record; production uses TfL/NaPTAN + routing (e.g. OpenTripPlanner). */
function commuteOk(p: Property, q: SearchQuery) {
  if (!q.maxCommuteMins) return { ok: true, note: '' };
  const hub = q.commuteTo ?? '';
  const matchesHub = /london/.test(hub) ? p.town.includes('London') : p.commute.to.toLowerCase().includes(hub.split(' ').pop() ?? '') || p.town.toLowerCase().includes(hub.split(' ').pop() ?? '');
  if (!matchesHub) return { ok: false, note: '' };
  // Listings whose journey times haven't been calculated yet can't be said to meet a limit.
  if (!p.commute.minutes || /not yet calculated/i.test(p.commute.mode)) return { ok: false, note: '' };
  // Add station walk time to door-to-door estimate.
  const door = p.commute.minutes + p.station.walkMins;
  return { ok: door <= q.maxCommuteMins, note: `≈${door} min door-to-door to ${p.commute.to} (${p.commute.mode})` };
}

export function runSearch(q: SearchQuery, pool = PROPERTIES): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const p of pool) {
    if (p.visibility === 'private' || p.status === 'withdrawn' || p.status === 'pending') continue;
    const reasons: string[] = [];
    const cautions: string[] = [];
    if (q.intent === 'rent' ? p.listing !== 'rent' : p.listing === 'rent') continue;
    if (q.minBeds && p.beds < q.minBeds) continue;
    if (q.maxPrice && p.price > q.maxPrice) continue;
    if (q.types.length && !q.types.includes(p.type)) continue;
    if (q.auction && p.listing !== 'auction') continue;
    if (q.commercial ? p.type !== 'commercial' : p.type === 'commercial') continue;
    if (q.conversion && (p.conversionPotential ?? 'none') === 'none') continue;
    if (q.lowServiceCharge && p.type === 'flat' && p.serviceChargeAnnual == null) continue;
    const c = commuteOk(p, q);
    if (!c.ok) continue;
    if (q.districts.length && !q.districts.includes(p.district.toUpperCase())) continue;
    if (!q.maxCommuteMins && !q.districts.length && q.locations.length && !q.locations.some((l) => p.town.includes(l))) continue;

    const ds = dealScore(p);
    let score = ds.total;
    if (c.note) reasons.push(c.note);
    if (q.minBeds) reasons.push(`${p.beds} bedrooms`);
    if (q.maxPrice) reasons.push(`£${p.price.toLocaleString('en-GB')} — £${(q.maxPrice - p.price).toLocaleString('en-GB')} under budget`);
    if (q.wantsLoft) {
      if (p.loftPotential === 'strong') { score += 12; reasons.push('Strong loft potential: unconverted roof void, similar dormers approved nearby'); }
      else if (p.loftPotential === 'possible') { score += 4; reasons.push('Loft conversion possible — headroom to be measured'); }
      else { score -= 25; cautions.push('No realistic loft potential'); }
    }
    if (q.wantsExtension) {
      if (p.extensionPotential !== 'none') { score += p.extensionPotential === 'strong' ? 8 : 3; reasons.push(`Extension potential: ${p.extensionPotential}`); }
      else { score -= 15; cautions.push('Limited extension potential'); }
    }
    if (q.wantsGarden && !p.features.some((f) => /garden/i.test(f))) { score -= 10; cautions.push('No private garden listed'); }
    if (q.hmo) {
      if (p.risks.article4) cautions.push('Article 4 direction: C3→C4 HMO needs full planning permission');
      if (p.beds < 4) { score -= 15; cautions.push('Fewer than 4 bedrooms before reconfiguration'); }
    }
    if (q.chainFree && !p.features.some((f) => /chain/i.test(f))) { score -= 8; cautions.push('Not advertised as chain-free'); }
    if (q.goodSchools) {
      const good = p.schools.filter((s) => /Outstanding|Good/.test(s.rating));
      if (good.length) reasons.push(`Schools nearby: ${good.map((s) => `${s.name} — ${s.rating}`).join('; ')}`);
      else cautions.push('No Good/Outstanding schools in demo data within 1.5km');
    }

    // Refurbishment profit uses the deterministic cost engine + loft uplift if requested.
    let estProfit = ds.uplift;
    const loft = q.wantsLoft ? loftScenario(p) : null;
    if (loft && loft.net > 0) { estProfit += loft.net; reasons.push(`Loft (~${loft.area}m²): engine cost £${Math.round(loft.cost / 1000)}k vs value uplift ≈ £${Math.round(loft.valueUplift / 1000)}k`); }
    if (q.minRefurbProfit) {
      if (estProfit >= q.minRefurbProfit) { score += 10; reasons.push(`Indicative refurb profit ≈ £${Math.round(estProfit / 1_000)}k (target £${Math.round(q.minRefurbProfit / 1_000)}k)`); }
      else { score -= 20; cautions.push(`Indicative profit ≈ £${Math.round(estProfit / 1_000)}k — below £${Math.round(q.minRefurbProfit / 1_000)}k target`); }
    }
    if (q.conversion) { score += p.conversionPotential === 'strong' ? 15 : 5; reasons.push(`Conversion potential: ${p.conversionPotential}${p.planningNearby.some((a) => /flats|Class MA/i.test(a.desc) && a.decision === 'Approved') ? ' — similar conversion approved nearby' : ''}`); if (p.planningNearby.some((a) => /flats/i.test(a.desc) && a.decision === 'Refused')) cautions.push('A nearby conversion was refused — check local policy on family-housing loss'); }
    if (q.lowServiceCharge) { if (p.serviceChargeAnnual != null && p.serviceChargeAnnual <= 1_500) { score += 10; reasons.push(`Service charge £${p.serviceChargeAnnual.toLocaleString('en-GB')} p.a.`); } else if (p.type === 'flat') cautions.push('Service charge not disclosed / above £1,500'); }
    if (q.needsRefurb) { if (p.condition === 'poor' || p.condition === 'fair' || p.condition === 'derelict') { score += 6; reasons.push(`Condition: ${p.condition} — refurbishment estimate ≈ £${Math.round(ds.refurbEstimate / 1000)}k`); } else { score -= 20; cautions.push('Already in good condition'); } }
    if (q.rentalDemand) { if (p.rentDemand >= 80) { score += 8; reasons.push(`Rental demand index ${p.rentDemand}/100`); } else cautions.push(`Rental demand index only ${p.rentDemand}/100`); }
    if (q.goodReturn) { if (ds.total >= 55) reasons.push(`Deal score ${ds.total}/100 (${ds.grade})`); else { score -= 10; cautions.push(`Deal score ${ds.total}/100 — returns look thin at asking price`); } }
    if (q.minYield && ds.grossYield < q.minYield) { score -= 15; cautions.push(`Gross yield ${(ds.grossYield * 100).toFixed(1)}% below ${(q.minYield * 100).toFixed(1)}%`); }
    else if (q.minYield) reasons.push(`Gross yield ${(ds.grossYield * 100).toFixed(1)}%`);

    if (p.risks.flood === 'medium' || p.risks.flood === 'high') cautions.push(`Flood risk: ${p.risks.flood}`);
    if (p.risks.subsidence !== 'low') cautions.push(`Subsidence susceptibility: ${p.risks.subsidence}`);
    hits.push({ property: p, score, reasons, cautions, dealGrade: ds.grade, estProfit });
  }
  return hits.sort((a, b) => b.score - a.score);
}

export function describeQuery(q: SearchQuery): string[] {
  const out: string[] = [];
  out.push(q.intent === 'rent' ? 'Looking to rent' : q.intent === 'invest' ? 'Investment purchase' : 'Purchase');
  if (q.minBeds) out.push(`${q.minBeds}+ beds`);
  if (q.types.length) out.push(q.types.join(' / '));
  if (q.maxPrice) out.push(`≤ £${q.maxPrice.toLocaleString('en-GB')}`);
  if (q.maxCommuteMins) out.push(`≤ ${q.maxCommuteMins} min to ${q.commuteTo}`);
  if (q.districts.length) out.push(q.districts.join(', '));
  if (q.locations.length && !q.maxCommuteMins) out.push(q.locations.join(', '));
  if (q.wantsLoft) out.push('loft potential');
  if (q.wantsExtension) out.push('extension potential');
  if (q.wantsGarden) out.push('garden');
  if (q.minRefurbProfit) out.push(`refurb profit ≥ £${Math.round(q.minRefurbProfit / 1000)}k`);
  if (q.minYield) out.push(`yield ≥ ${(q.minYield * 100).toFixed(1)}%`);
  if (q.hmo) out.push('HMO');
  if (q.auction) out.push('auction');
  if (q.chainFree) out.push('chain-free');
  if (q.goodSchools) out.push('good schools');
  if (q.conversion) out.push('conversion to flats');
  if (q.lowServiceCharge) out.push('low service charge');
  if (q.needsRefurb) out.push('needs refurbishment');
  if (q.goodReturn) out.push('investment return');
  if (q.rentalDemand) out.push('strong rental demand');
  if (q.commercial) out.push('commercial');
  return out;
}
