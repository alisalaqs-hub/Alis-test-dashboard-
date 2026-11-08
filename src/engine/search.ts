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
  unsupported: string[];
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

const PLACE_ALIASES: Record<string, string[]> = {
  london: ['London'], manchester: ['Manchester'], leeds: ['Leeds'], bristol: ['Bristol'], birmingham: ['Birmingham'],
  liverpool: ['Liverpool'], sheffield: ['Sheffield'], cardiff: ['Cardiff'], wales: ['Cardiff'], glasgow: ['Glasgow'],
  scotland: ['Glasgow'], nottingham: ['Nottingham'], north: ['Manchester', 'Leeds', 'Liverpool', 'Sheffield'],
  midlands: ['Birmingham', 'Nottingham'],
};

function money(raw: string): number {
  const m = raw.replace(/[£,\s]/g, '').replace(/\.+$/, '').toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2] === 'k' ? n * 1_000 : m[2] === 'm' ? n * 1_000_000 : n;
}

export function parseQuery(text: string): SearchQuery {
  const t = ` ${text.toLowerCase()} `;
  const q: SearchQuery = { intent: 'buy', locations: [], types: [], unsupported: [] };

  if (/\b(to rent|to let|renting|tenant|per month|pcm)\b/.test(t)) q.intent = 'rent';
  else if (/\b(invest|yield|btl|buy[- ]to[- ]let|brrr|flip|hmo|portfolio|profit)\b/.test(t)) q.intent = 'invest';

  const beds = t.match(/\b(\d|one|two|three|four|five|six|seven)[- ]?(?:\+\s*)?(?:bed(?:room)?s?|br)\b/);
  if (beds) q.minBeds = WORD_NUM[beds[1]] ?? parseInt(beds[1], 10);

  const price = t.match(/\b(?:under|below|less than|max(?:imum)?|up to|budget(?: of)?)\s*(£?\s?[\d,.]+\s?[km]?)\b/);
  if (price) q.maxPrice = money(price[1]);

  const commute = t.match(/within\s+(\d+)\s*(?:min(?:ute)?s?)\s+(?:of|from|to)\s+([a-z\s]+?)(?:,|\.|\bunder\b|\bwith\b|\band\b|$)/);
  if (commute) { q.maxCommuteMins = parseInt(commute[1], 10); q.commuteTo = commute[2].trim(); }

  for (const [k, v] of Object.entries(PLACE_ALIASES)) if (new RegExp(`\\b${k}\\b`).test(t)) q.locations.push(...v);
  q.locations = [...new Set(q.locations)];

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
  // Add station walk time to door-to-door estimate.
  const door = p.commute.minutes + p.station.walkMins;
  return { ok: door <= q.maxCommuteMins, note: `≈${door} min door-to-door to ${p.commute.to} (${p.commute.mode})` };
}

export function runSearch(q: SearchQuery, pool = PROPERTIES): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const p of pool) {
    const reasons: string[] = [];
    const cautions: string[] = [];
    if (q.intent === 'rent' ? p.listing !== 'rent' : p.listing === 'rent') continue;
    if (q.minBeds && p.beds < q.minBeds) continue;
    if (q.maxPrice && p.price > q.maxPrice) continue;
    if (q.types.length && !q.types.includes(p.type)) continue;
    if (q.auction && p.listing !== 'auction') continue;
    const c = commuteOk(p, q);
    if (!c.ok) continue;
    if (!q.maxCommuteMins && q.locations.length && !q.locations.some((l) => p.town.includes(l))) continue;

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
    if (q.minYield && ds.grossYield < q.minYield) { score -= 15; cautions.push(`Gross yield ${(ds.grossYield * 100).toFixed(1)}% below ${(q.minYield * 100).toFixed(1)}%`); }
    else if (q.minYield) reasons.push(`Gross yield ${(ds.grossYield * 100).toFixed(1)}%`);

    if (p.risks.flood === 'medium' || p.risks.flood === 'high') cautions.push(`Flood risk: ${p.risks.flood} (EA demo layer)`);
    if (p.risks.subsidence !== 'low') cautions.push(`Subsidence susceptibility: ${p.risks.subsidence} (BGS demo layer)`);
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
  return out;
}
