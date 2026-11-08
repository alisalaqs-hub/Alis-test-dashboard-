/** Landlord assistant skills over (demo) portfolio records. Deterministic. */
import type { Skill } from './assistant';

export interface UnitRecord { id: string; name: string; rent: number; marketRent: number; marketEvidence: number; voidDays12m: number; voids12m: number; maintenance12m: number; boilerAge: number; roofAge: number; epc: string; lastRefurbYear: number; value: number }
export const PORTFOLIO: UnitRecord[] = [
  { id: 'U1', name: 'Arnside Terrace, L15', rent: 1_050, marketRent: 1_095, marketEvidence: 4, voidDays12m: 12, voids12m: 1, maintenance12m: 1_420, boilerAge: 11, roofAge: 35, epc: 'D', lastRefurbYear: 2016, value: 175_000 },
  { id: 'U2', name: 'Lace Market Yard, NG1', rent: 1_250, marketRent: 1_275, marketEvidence: 3, voidDays12m: 0, voids12m: 0, maintenance12m: 610, boilerAge: 0, roofAge: 0, epc: 'B', lastRefurbYear: 2021, value: 205_000 },
  { id: 'U3', name: 'Cranwell Street HMO, M14', rent: 3_625, marketRent: 3_750, marketEvidence: 6, voidDays12m: 46, voids12m: 3, maintenance12m: 6_880, boilerAge: 14, roofAge: 60, epc: 'C', lastRefurbYear: 2014, value: 330_000 },
  { id: 'U4', name: 'Bramwell Mount, LS6', rent: 1_250, marketRent: 1_225, marketEvidence: 2, voidDays12m: 18, voids12m: 1, maintenance12m: 2_150, boilerAge: 8, roofAge: 90, epc: 'D', lastRefurbYear: 2012, value: 240_000 },
];
const g = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const net = (u: UnitRecord) => u.rent * 12 * (1 - u.voidDays12m / 365) - u.maintenance12m;

/** Predictive maintenance: component age vs typical life → expected spend in next 24 months. */
export function maintenanceForecast(units = PORTFOLIO) {
  return units.flatMap((u) => [
    { unit: u.id, item: 'Boiler replacement', due: u.boilerAge >= 12 ? 'within 12 months' : u.boilerAge >= 10 ? '12–24 months' : null, cost: 3_200 },
    { unit: u.id, item: 'Roof overhaul', due: u.roofAge >= 60 ? '12–24 months' : null, cost: 2_400 },
    { unit: u.id, item: 'Kitchen/bathroom refresh', due: 2026 - u.lastRefurbYear >= 12 ? 'within 24 months' : null, cost: 9_500 },
    { unit: u.id, item: 'EICR remedials (5-yearly)', due: 'per certificate', cost: 450 },
  ]).filter((x) => x.due);
}

export const landlordSkills: Skill<UnitRecord[]>[] = [
  { id: 'underperf', label: 'Which properties are underperforming?', match: /underperform|worst|weak/i, run: (u) => {
    const r = [...u].map((x) => ({ x, y: net(x) / x.value })).sort((a, b) => a.y - b.y);
    return { confidence: 'high', tools: ['portfolio.netYield'], text: `Lowest net yield: ${r[0].x.name} at ${(r[0].y * 100).toFixed(1)}% after voids and maintenance, versus a portfolio best of ${(r[r.length - 1].y * 100).toFixed(1)}% (${r[r.length - 1].x.name}).`, evidence: r.map(({ x, y }) => `${x.id} ${x.name}: ${(y * 100).toFixed(1)}% net · ${x.voidDays12m} void days · ${g(x.maintenance12m)} maintenance`), assumptions: ['Values are owner-entered estimates (demo)', 'Excludes finance and tax'], verify: ['Up-to-date valuations'] };
  } },
  { id: 'voids', label: 'What is my average void period?', match: /void/i, run: (u) => {
    const total = u.reduce((s, x) => s + x.voidDays12m, 0); const events = u.reduce((s, x) => s + x.voids12m, 0);
    return { confidence: 'high', tools: ['portfolio.voids'], text: `${events} void periods in the last 12 months averaging ${events ? Math.round(total / events) : 0} days each (${total} void days in total, costing about ${g(u.reduce((s, x) => s + (x.rent * 12 * x.voidDays12m) / 365, 0))} in lost rent).`, evidence: u.map((x) => `${x.id}: ${x.voids12m} void(s), ${x.voidDays12m} days`), assumptions: ['HMO room voids counted per room'], verify: [] };
  } },
  { id: 'maint', label: 'Which properties have the highest maintenance costs?', match: /maint|repair|cost/i, run: (u) => {
    const r = [...u].sort((a, b) => b.maintenance12m / b.rent - a.maintenance12m / a.rent);
    return { confidence: 'high', tools: ['portfolio.maintenance', 'maintenance.forecast'], text: `${r[0].name} has the highest maintenance spend: ${g(r[0].maintenance12m)} (${((r[0].maintenance12m / (r[0].rent * 12)) * 100).toFixed(0)}% of rent). Predicted spend over the next 24 months across the portfolio is about ${g(maintenanceForecast(u).reduce((s, x) => s + x.cost, 0))}.`, evidence: r.map((x) => `${x.id}: ${g(x.maintenance12m)} · boiler ${x.boilerAge} yrs · last refurb ${x.lastRefurbYear}`), assumptions: ['Component lives: boiler 12–15 yrs, kitchen/bath 12–15 yrs'], verify: ['Condition at next inspection'] };
  } },
  { id: 'refurb', label: 'What refurbishment would improve rental appeal?', match: /refurb|appeal|improve|upgrade/i, run: (u) => {
    const old = u.filter((x) => 2026 - x.lastRefurbYear >= 10);
    return { confidence: 'medium', tools: ['design.designCost', 'portfolio'], text: `${old.map((x) => x.name).join(' and ')} ${old.length > 1 ? 'are' : 'is'} 10+ years since refurbishment. A “Budget rental” kitchen and bathroom refresh (≈£9–12k incl. VAT per unit) plus EPC improvements to C typically reduces voids; use the design studio to cost a scheme.`, evidence: old.map((x) => `${x.id}: refurbished ${x.lastRefurbYear}, EPC ${x.epc}, ${x.voidDays12m} void days`), assumptions: ['Durable mid-spec finishes'], verify: ['Letting agent view on local tenant expectations'], link: { label: 'Open design studio', to: '/studio?property=liv-007&style=rental&tier=budget' } };
  } },
  { id: 'rent', label: 'How competitive is my asking rent?', match: /rent|competit|market/i, run: (u) => ({
    confidence: 'medium', tools: ['valuation.rentalScenario'], text: u.map((x) => `${x.id} ${g(x.rent)} vs market ${g(x.marketRent)} (${x.rent < x.marketRent ? 'below' : x.rent > x.marketRent ? 'above' : 'at'} market)`).join('; ') + '. Any increase must follow the section 13 process (once a year, 2 months’ notice).',
    evidence: u.map((x) => `${x.id}: ${x.marketEvidence} let comparable(s)`), assumptions: ['Market rents from demo let comparables'], verify: ['Two agent rental appraisals', 'Tenant affordability and retention value'] }) },
];
