/**
 * Development potential — rules-based screening, not planning advice.
 *
 * Encodes simplified England permitted-development (PD) and policy heuristics
 * as configured Nov 2026. Each option returns its status, the constraints
 * that drove it, and the professional checks required. Outcomes are
 * "screening" only: a planning consultant / LPA must confirm.
 */
import type { Property } from '../data/properties';
import { estimateRefurb } from './refurb';
import { refurbInputFor } from './insights';

export type DevStatus = 'likely under PD' | 'needs planning permission' | 'prior approval route' | 'constrained' | 'not applicable';
export interface DevOption {
  id: string; name: string; status: DevStatus; summary: string;
  constraints: string[]; checks: string[];
  cost?: number; valueUplift?: number; units?: number;
}

/** Nationally Described Space Standard minimum GIAs (m²), single-storey dwellings. */
export const NDSS = { studio: 37, '1b2p': 50, '2b4p': 70, '3b5p': 86 } as const;

export function developmentOptions(p: Property): DevOption[] {
  const out: DevOption[] = [];
  const house = p.type !== 'flat' && p.type !== 'commercial';
  const ca = p.risks.conservationArea; const listed = p.risks.listed; const a4 = p.risks.article4;
  const base = refurbInputFor(p);
  const cost = (scope: Partial<typeof base.scope>) => estimateRefurb({ ...base, bathrooms: 0, condition: 'fair', scope: { ...base.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', kitchen: false, windows: false, roof: 'none', flooring: false, decoration: false, damp: false, external: false, insulation: false, structuralOpenings: 0, ensuites: 0, ...scope } }).total;
  const commonChecks = ['Structural engineer (Part A)', 'Building Control approval', 'Party Wall Act notices (if shared walls)'];

  // Loft
  if (!house) out.push({ id: 'loft', name: 'Loft conversion', status: 'not applicable', summary: 'Flats and commercial buildings have no PD rights for loft conversions.', constraints: [], checks: [] });
  else {
    const status: DevStatus = listed ? 'constrained' : ca ? 'needs planning permission' : p.loftPotential === 'none' ? 'constrained' : 'likely under PD';
    const area = Math.round(Math.min(32, Math.max(18, (p.floorArea / p.storeys) * 0.55)));
    out.push({ id: 'loft', name: 'Loft conversion (rear dormer)', status, summary: status === 'likely under PD' ? `Rear dormer within PD volume limits (${p.type === 'terraced' ? 40 : 50}m³) appears feasible.` : 'PD unlikely to apply — planning permission or consent route required.',
      constraints: [ca ? 'Conservation area: PD for roof extensions removed' : '', listed ? 'Listed building: consent needed for almost all works' : '', p.loftPotential === 'none' ? 'Insufficient roof void headroom (needs ≥2.2m at ridge)' : '', 'No dormer on principal elevation fronting a highway under PD'].filter(Boolean),
      checks: ['Measured headroom survey', ...commonChecks, 'Fire strategy (Part B) for 3-storey dwelling'], cost: cost({ loftArea: area }), valueUplift: Math.round(p.estGdv * (p.loftPotential === 'strong' ? 0.16 : 0.11)) });
  }
  // Rear extension
  if (!house) out.push({ id: 'rear', name: 'Rear extension', status: p.type === 'commercial' ? 'needs planning permission' : 'not applicable', summary: p.type === 'commercial' ? 'Commercial extensions require full planning permission.' : 'Flats have no householder PD rights.', constraints: [], checks: [] });
  else {
    const depth = p.type === 'detached' ? 4 : 3; const larger = p.type === 'detached' ? 8 : 6;
    const status: DevStatus = listed ? 'constrained' : p.extensionPotential === 'none' ? 'constrained' : 'likely under PD';
    const area = p.extensionPotential === 'strong' ? 18 : 12;
    out.push({ id: 'rear', name: 'Single-storey rear extension', status, summary: `PD allows ${depth}m depth (up to ${larger}m via the larger home extension prior approval) for a ${p.type} house, max 4m high.`,
      constraints: [listed ? 'Listed building consent required' : '', p.extensionPotential === 'none' ? 'Limited garden depth in demo data' : '', 'Must not exceed 50% of curtilage including existing outbuildings'].filter(Boolean),
      checks: [...commonChecks, 'Drainage: build-over agreement if near a public sewer'], cost: cost({ extensionArea: area, structuralOpenings: 1 }), valueUplift: Math.round(p.estGdv * (area / p.floorArea) * 0.85) });
  }
  // Side extension
  if (house) {
    const status: DevStatus = p.type === 'terraced' ? (p.features.some((f) => /side return/i.test(f)) ? 'likely under PD' : 'constrained') : ca ? 'needs planning permission' : 'likely under PD';
    out.push({ id: 'side', name: p.type === 'terraced' ? 'Side-return infill' : 'Single-storey side extension', status, summary: 'PD side extensions: single storey, max 4m high, width no more than half the original house.', constraints: [ca ? 'Conservation area: side extensions removed from PD' : ''].filter(Boolean), checks: commonChecks, cost: cost({ extensionArea: 8, structuralOpenings: 1 }), valueUplift: Math.round(p.estGdv * 0.045) });
  }
  // Subdivision into flats
  if (p.type !== 'flat' && p.type !== 'commercial') {
    const units = Math.max(1, Math.floor((p.floorArea * 0.82) / ((NDSS['1b2p'] + NDSS['2b4p']) / 2)));
    const status: DevStatus = units < 2 ? 'constrained' : 'needs planning permission';
    const unitValue = p.comparables.filter((c) => c.kind === 'sold' && c.beds <= 2 && c.refurbished).map((c) => c.price);
    const avgUnit = unitValue.length ? unitValue.reduce((a, b) => a + b, 0) / unitValue.length : p.estGdv / Math.max(2, units) * 1.1;
    const conv = estimateRefurb({ ...base, condition: p.condition, vat: 'reduced-conversion', scope: { ...base.scope, stripOut: true, rewire: true, heating: 'full', replaster: 'full', kitchen: true, flooring: true, decoration: true, structuralOpenings: units } }).total * (1 + 0.25 * (units - 1)) * 0.85;
    out.push({ id: 'subdivide', name: `Subdivide into ${units} flats`, status, units, summary: `${Math.round(p.floorArea * 0.82)}m² net usable ÷ NDSS-compliant unit sizes ≈ ${units} units. Change of use from one dwelling to flats needs full planning permission.`,
      constraints: [p.risks.article4 ? 'Article 4 direction present — check its scope' : '', 'Many LPAs protect family housing (e.g. minimum 3-bed unit on ground floor)', 'Separate fire compartmentation (Part B) and sound insulation (Part E) required'].filter(Boolean),
      checks: ['Planning consultant pre-application advice', 'Architect: NDSS-compliant layouts', 'Fire engineer', ...commonChecks], cost: Math.round(conv), valueUplift: Math.round(units * avgUnit - p.estGdv) });
  }
  // Office-to-residential (Class MA)
  if (p.type === 'commercial') {
    const units = Math.floor((p.floorArea * 0.78) / 58);
    const status: DevStatus = a4 ? 'constrained' : 'prior approval route';
    out.push({ id: 'classma', name: `Office to residential (Class MA) — ~${units} units`, status, units, summary: 'Class E → C3 via prior approval: building must have been vacant for 3 continuous months; every unit must meet NDSS and have adequate natural light.',
      constraints: [a4 ? 'Article 4 direction pending/in force removing Class MA — likely needs full planning' : '', 'Prior approval assesses transport, contamination, flooding, noise, light, fire safety and loss of services', 'Building Safety Act gateways apply if 18m+/7+ storeys'].filter(Boolean),
      checks: ['Planning consultant', 'Fire engineer', 'Daylight/sunlight assessment', 'Acoustic report', 'Asbestos refurbishment survey'], cost: Math.round(p.floorArea * 1_650 * 1.2), valueUplift: Math.round(units * 290_000 - p.price) });
  }
  // Energy
  out.push({ id: 'energy', name: 'Energy efficiency upgrade', status: listed ? 'needs planning permission' : 'likely under PD', summary: `EPC ${p.epc.current} → potential ${p.epc.potential}. Most insulation and heat-pump works are PD (heat pumps subject to MCS 020 noise/siting limits).`, constraints: [ca ? 'External wall insulation and visible solar may need consent in a conservation area' : '', listed ? 'Listed building consent for most fabric changes' : ''].filter(Boolean), checks: ['Retrofit assessment (PAS 2035) for grant-funded works', 'Ventilation strategy (avoid condensation)'] });
  return out;
}

/* ---------- Developer: residual appraisal & unit-mix demand ---------- */
export interface UnitType { key: 'studio' | '1b' | '2b' | '3b'; label: string; size: number; price: number; rent: number }
export interface DemandSignal { key: UnitType['key']; demandIndex: number; monthlyAbsorption: [number, number] }

export function residualAppraisal(a: { units: { key: string; count: number; size: number; price: number }[]; buildCostPerM2: number; netToGross: number; feesPct: number; contingencyPct: number; financeRate: number; months: number; profitOnGdv: number; salesPct: number; cil: number }) {
  const gdv = a.units.reduce((s, u) => s + u.count * u.price, 0);
  const nia = a.units.reduce((s, u) => s + u.count * u.size, 0);
  const gia = nia / a.netToGross;
  const build = gia * a.buildCostPerM2;
  const fees = build * a.feesPct; const contingency = build * a.contingencyPct;
  const finance = (build + fees + contingency) * 0.5 * a.financeRate * (a.months / 12); // S-curve approx: half drawn on average
  const sales = gdv * a.salesPct; const profit = gdv * a.profitOnGdv;
  const residual = gdv - build - fees - contingency - finance - sales - profit - a.cil;
  return { gdv, nia, gia, build, fees, contingency, finance, sales, profit, cil: a.cil, residual, rlvPerUnit: residual / Math.max(1, a.units.reduce((s, u) => s + u.count, 0)) };
}

/** Allocate N units to maximise value subject to demand-led caps (no more units of a type than ~ 6 months' absorption × uplift). */
export function suggestMix(total: number, types: UnitType[], demand: DemandSignal[]) {
  const caps = Object.fromEntries(demand.map((d) => [d.key, Math.max(1, Math.round(d.monthlyAbsorption[1] * 6))]));
  const score = (t: UnitType) => (demand.find((d) => d.key === t.key)!.demandIndex / 100) * (t.price / t.size);
  const order = [...types].sort((a, b) => score(b) - score(a));
  const mix: Record<string, number> = Object.fromEntries(types.map((t) => [t.key, 0]));
  let left = total;
  // Floor of 10% family units (3b) where policy usually expects a mix.
  const fam = types.find((t) => t.key === '3b'); if (fam) { const n = Math.min(left, Math.ceil(total * 0.1)); mix['3b'] = n; left -= n; }
  while (left > 0) {
    const next = order.find((t) => mix[t.key] < caps[t.key]) ?? order[0];
    mix[next.key]++; left--;
  }
  return mix;
}
