/**
 * Property-level derived intelligence: refurb scope inference, deal score,
 * EPC upgrade model, ownership-cost forecast. Deterministic & explainable.
 */
import type { Property } from '../data/properties';
import { DEFAULT_INPUT, estimateRefurb, type RefurbInput } from './refurb';

export function refurbInputFor(p: Property, overrides: Partial<RefurbInput['scope']> = {}): RefurbInput {
  const heavy = p.condition === 'poor' || p.condition === 'derelict';
  const medium = p.condition === 'fair';
  return {
    ...DEFAULT_INPUT,
    postcode: p.postcode, propertyType: p.type, floorArea: p.floorArea, bedrooms: p.beds, bathrooms: p.baths,
    storeys: p.storeys, era: p.era, condition: p.condition,
    access: p.town.includes('London') ? 'restricted' : 'easy',
    scope: {
      stripOut: heavy, rewire: heavy, heating: heavy ? 'full' : medium ? 'boiler' : 'none',
      replaster: p.condition === 'derelict' ? 'full' : heavy ? 'skim' : 'none', kitchen: heavy || medium,
      windows: p.condition === 'derelict' || p.epc.current >= 'F',
      roof: heavy ? 'repair' : 'none', flooring: heavy || medium, decoration: true, damp: heavy && p.era === 'pre-1919',
      external: heavy, structuralOpenings: 0, extensionArea: 0, loftArea: 0,
      insulation: p.type !== 'flat', solidWallInsulation: false, ensuites: 0, ...overrides,
    },
  };
}

/** Loft conversion add-on: engine-costed, value uplift heuristic (adds a bedroom/bath). */
export function loftScenario(p: Property) {
  if (p.loftPotential === 'none' || p.type === 'flat') return null;
  const area = Math.round(Math.min(32, Math.max(18, (p.floorArea / p.storeys) * 0.55)));
  const base = refurbInputFor(p);
  const e = estimateRefurb({
    ...base, bathrooms: 0, condition: 'fair',
    scope: { ...base.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', kitchen: false, windows: false, roof: 'none', flooring: false, decoration: false, damp: false, external: false, insulation: false, structuralOpenings: 0, ensuites: 0, loftArea: area },
  });
  const valueUplift = Math.round(p.estGdv * (p.loftPotential === 'strong' ? 0.16 : 0.11));
  return { area, cost: e.total, valueUplift, net: valueUplift - e.total };
}

export interface ScoreComponent { label: string; score: number; weight: number; detail: string }
export interface DealScore { total: number; grade: string; components: ScoreComponent[]; refurbEstimate: number; uplift: number; grossYield: number }

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function dealScore(p: Property): DealScore {
  const refurb = p.listing === 'rent' ? 0 : estimateRefurb(refurbInputFor(p)).total;
  const purchaseCostsApprox = p.price * 0.04; // tax + fees rough cut for ranking only
  const uplift = p.estGdv - p.price - refurb - purchaseCostsApprox;
  const upliftPct = p.price ? uplift / p.price : 0;
  const grossYield = p.listing === 'rent' ? 0 : (p.estRentPcm * 12) / (p.price + refurb);
  const riskPenalty =
    (p.risks.flood === 'high' ? 30 : p.risks.flood === 'medium' ? 15 : 0) +
    (p.risks.subsidence === 'high' ? 15 : p.risks.subsidence === 'medium' ? 7 : 0) +
    (p.risks.listed ? 12 : 0) + (p.risks.conservationArea ? 5 : 0) +
    (p.tenure === 'leasehold' && (p.leaseYears ?? 999) < 85 ? 25 : 0);
  const epcGap = p.epc.current.charCodeAt(0) - p.epc.potential.charCodeAt(0);

  const components: ScoreComponent[] = [
    { label: 'Value-add uplift', weight: 0.32, score: clamp(50 + upliftPct * 250), detail: `Est. post-works value £${fmtK(p.estGdv)} vs all-in ≈ £${fmtK(p.price + refurb + purchaseCostsApprox)} → ${upliftPct >= 0 ? '+' : ''}${(upliftPct * 100).toFixed(1)}% on price.` },
    { label: 'Rental yield', weight: 0.22, score: clamp((grossYield - 0.03) * 1_400), detail: `Gross yield on all-in cost ${(grossYield * 100).toFixed(1)}% (est. rent £${p.estRentPcm.toLocaleString('en-GB')} pcm).` },
    { label: 'Tenant demand', weight: 0.14, score: p.rentDemand, detail: `Demand index ${p.rentDemand}/100 (demo index: enquiries per listing, days-to-let).` },
    { label: 'Area momentum', weight: 0.1, score: clamp(50 + (p.areaIndex[23] - p.areaIndex[0]) * 6), detail: `Area index ${(p.areaIndex[23] - 100).toFixed(1)}% over 24 months (demo).` },
    { label: 'Negotiation leverage', weight: 0.08, score: clamp(p.daysOnMarket * 1.1 + (p.priceHistory.some((h) => h.event === 'Reduced') ? 25 : 0)), detail: `${p.daysOnMarket} days on market${p.priceHistory.some((h) => h.event === 'Reduced') ? ', already reduced' : ''}.` },
    { label: 'Energy upgrade headroom', weight: 0.06, score: clamp(epcGap * 30), detail: `EPC ${p.epc.current} → potential ${p.epc.potential}.` },
    { label: 'Risk & constraints', weight: 0.08, score: clamp(100 - riskPenalty), detail: riskPenalty ? 'Penalised for: ' + [p.risks.flood !== 'very low' && p.risks.flood !== 'low' ? `${p.risks.flood} flood risk` : '', p.risks.subsidence !== 'low' ? `${p.risks.subsidence} subsidence` : '', p.risks.listed ? 'listed building' : '', p.risks.conservationArea ? 'conservation area' : ''].filter(Boolean).join(', ') : 'No major constraints flagged in demo datasets.' },
  ];
  const total = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0));
  const grade = total >= 75 ? 'A' : total >= 62 ? 'B' : total >= 50 ? 'C' : total >= 38 ? 'D' : 'E';
  return { total, grade, components, refurbEstimate: refurb, uplift, grossYield };
}

export function fmtK(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}m` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`;
}

/** EPC upgrade pathway — indicative measures, costs and SAP point gains. */
export function epcPathway(p: Property) {
  const measures = [
    { measure: 'Loft insulation to 270mm', cost: 650, sap: 4, applies: p.type !== 'flat' },
    { measure: 'Cavity wall insulation', cost: 1_800, sap: 8, applies: p.era === '1945-1979' || p.era === '1980-1999' },
    { measure: 'Internal wall insulation (solid walls)', cost: 11_500, sap: 10, applies: p.era === 'pre-1919' || p.era === '1919-1944' },
    { measure: 'Draught-proofing & secondary glazing', cost: 2_400, sap: 3, applies: p.risks.conservationArea || p.risks.listed },
    { measure: 'A-rated double glazing', cost: 7_800, sap: 4, applies: !p.risks.listed && !p.risks.conservationArea },
    { measure: 'Heat pump (after £7,500 BUS grant)', cost: 6_000, sap: 9, applies: p.type !== 'flat' && p.nation !== 'scotland' },
    { measure: 'Solar PV 3.5kWp', cost: 5_800, sap: 12, applies: p.type !== 'flat' && !p.risks.listed },
    { measure: 'LED lighting & smart heating controls', cost: 450, sap: 2, applies: true },
  ].filter((m) => m.applies);
  let score = p.epc.score;
  const steps = measures.sort((a, b) => a.cost / a.sap - b.cost / b.sap).map((m) => {
    score = Math.min(92, score + m.sap);
    return { ...m, cumulative: score, band: sapBand(score) };
  });
  return { start: p.epc.score, startBand: p.epc.current, steps };
}

export function sapBand(score: number) {
  return score >= 92 ? 'A' : score >= 81 ? 'B' : score >= 69 ? 'C' : score >= 55 ? 'D' : score >= 39 ? 'E' : score >= 21 ? 'F' : 'G';
}

/** 10-year cost of ownership forecast (nominal, demo assumptions). */
export function ownershipForecast(p: Property, mortgageRate = 0.047, ltv = 0.75) {
  const loan = p.price * ltv;
  const monthly = (loan * (mortgageRate / 12)) / (1 - Math.pow(1 + mortgageRate / 12, -300));
  const ctBand: Record<string, number> = { A: 1_450, B: 1_690, C: 1_930, D: 2_180, E: 2_660, F: 3_150, G: 3_630 };
  const ct = ctBand[p.councilTax[0]] ?? 2_000;
  const energy = { A: 900, B: 1_100, C: 1_400, D: 1_850, E: 2_300, F: 2_900, G: 3_400 }[p.epc.current] ?? 1_800;
  const maint = p.price * (p.era === 'pre-1919' ? 0.012 : 0.008);
  return Array.from({ length: 10 }, (_, y) => {
    const inflation = Math.pow(1.03, y);
    return {
      year: 2027 + y,
      mortgage: Math.round(monthly * 12),
      councilTax: Math.round(ct * Math.pow(1.049, y)),
      energy: Math.round(energy * inflation),
      maintenance: Math.round(maint * inflation),
      insurance: Math.round(420 * inflation),
    };
  });
}
