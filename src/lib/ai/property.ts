/**
 * Streetkey AI for renovation costs, investment analysis and homeowners: the shared part.
 *
 * Pure TypeScript (no React, no network). The website imports it for the rule-based figures
 * and fallbacks it shows; the server imports it so the figures it hands the AI (and checks the
 * AI's answer against) are exactly the same. Every number here comes from Streetkey's engines:
 * the AI only explains, prioritises and words things.
 */
import { PROPERTIES, type Property } from '../../data/properties';
import { developmentOptions } from '../../engine/development';
import { epcPathway, loftScenario, ownershipForecast, refurbInputFor } from '../../engine/insights';
import { analyse, breakEven, scenario, type InvestmentInput, type InvestmentResult, type ScenarioName, type Strategy } from '../../engine/investment';
import { estimateRefurb, REGIONS, regionFromPostcode, type Condition, type Era, type Estimate, type PropertyType, type RefurbInput } from '../../engine/refurb';
import { rentalScenario } from '../../engine/valuation';

/* ───────────────────────── formatting ───────────────────────── */
/** £ with thousands separators, whole pounds ("−£1,250" for negatives). */
export const money = (n: number) => (Number.isFinite(n) ? `${n < 0 ? '−' : ''}£${Math.round(Math.abs(n)).toLocaleString('en-GB')}` : 'n/a');
export const pc = (n: number, dp = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : 'n/a');
const r1k = (n: number) => Math.round(n / 1000) * 1000;
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

export type Confidence = 'low' | 'medium' | 'high';
export const CONDITIONS = ['good', 'fair', 'poor', 'derelict'] as const satisfies readonly Condition[];
export const ERAS = ['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'] as const satisfies readonly Era[];

/* ───────────────────────── 1. renovation from photos ───────────────────────── */
export const PHOTO_ACTIONS = ['keep', 'refresh', 'replace', 'investigate'] as const;
export type PhotoAction = (typeof PHOTO_ACTIONS)[number];
export const ACTION_LABEL: Record<PhotoAction, string> = { keep: 'Keep', refresh: 'Refresh', replace: 'Replace', investigate: 'Check' };

/** Building elements the photo analysis reports on (each maps to the cost engine's scope in code). */
export const PHOTO_ELEMENTS = [
  'kitchen units', 'bathroom suite', 'windows', 'external doors', 'roof covering', 'gutters & roofline', 'external walls',
  'wiring', 'heating', 'boiler', 'plaster', 'damp signs', 'flooring', 'decoration', 'joinery', 'structure', 'insulation',
  'garden & boundaries', 'other',
] as const;
export type PhotoElement = (typeof PHOTO_ELEMENTS)[number];

export interface PhotoItem { element: PhotoElement; observation: string; likelyAction: PhotoAction }
export interface PhotoObservation {
  /** 1-based, in upload order. */
  photo: number;
  /** false when the AI returned nothing usable for this photo. */
  analysed: boolean;
  isProperty: boolean;
  room: string;
  condition: Condition | null;
  confidence: Confidence;
  items: PhotoItem[];
}

/** What the person tells us about the property (everything in RefurbInput except the scope and condition, which come from the photos). */
export interface RefurbPhotoFacts {
  postcode: string; propertyType: PropertyType; floorArea: number; bedrooms: number; bathrooms: number; storeys: number;
  era: Era; access: RefurbInput['access']; spec: RefurbInput['spec']; vat: RefurbInput['vat']; includeProfessionalFees: boolean;
  /** Design choices photos can't show (kept exactly as the person set them). */
  planned: Pick<RefurbInput['scope'], 'structuralOpenings' | 'extensionArea' | 'loftArea' | 'ensuites' | 'solidWallInsulation'> & Pick<RefurbInput['scope'], 'groundworksArea' | 'fitOut' | 'officeToResiArea'>;
}

/** How each part of the priced scope was decided. */
export interface ScopeBasis { item: string; value: string; source: 'photos' | 'assumed' | 'yours'; note: string | null }

export interface RefurbPhotosResult {
  observations: PhotoObservation[];
  overall: { condition: Condition; confidence: Confidence; photosUsed: number; photosSent: number };
  /** Ready to load into the estimator (the cost engine's input). */
  scope: RefurbInput;
  /** estimateRefurb(scope), computed by Streetkey's engine. */
  estimate: Estimate;
  basis: ScopeBasis[];
  assumptions: string[];
  caveats: string[];
  questionsForSurveyor: string[];
  label: string;
}

/** The facts the photo endpoint needs, taken from the estimator's current input. */
export function photoFactsFrom(i: RefurbInput): RefurbPhotoFacts {
  const s = i.scope;
  return {
    postcode: i.postcode, propertyType: i.propertyType, floorArea: i.floorArea, bedrooms: i.bedrooms, bathrooms: i.bathrooms, storeys: i.storeys,
    era: i.era, access: i.access, spec: i.spec, vat: i.vat, includeProfessionalFees: i.includeProfessionalFees,
    planned: { structuralOpenings: s.structuralOpenings, extensionArea: s.extensionArea, loftArea: s.loftArea, ensuites: s.ensuites, solidWallInsulation: s.solidWallInsulation, groundworksArea: s.groundworksArea ?? 0, fitOut: s.fitOut ?? 'none', officeToResiArea: s.officeToResiArea ?? 0 },
  };
}

/* ───────────────────────── 2. explain an estimate ───────────────────────── */
export interface RefurbExplainResult {
  summary: string; biggestCosts: string[]; waysToSave: string[]; risks: string[]; nextSteps: string[];
  /** Recomputed on the server from the input (client figures are never trusted). */
  estimate: { total: number; low: number; high: number; confidence: Confidence };
  /** Statements dropped because they quoted £ figures that aren't in the estimate. */
  removedClaims: number;
  disclaimer: string;
}

/* ───────────────────────── 3. investment verdict ───────────────────────── */
export type Verdict = 'strong' | 'workable' | 'marginal' | 'weak';
export const VERDICTS = ['weak', 'marginal', 'workable', 'strong'] as const satisfies readonly Verdict[];
export const VERDICT_LABEL: Record<Verdict, string> = { strong: 'Strong', workable: 'Workable', marginal: 'Marginal', weak: 'Weak' };
export const STRATEGY_LABEL: Record<Strategy, string> = { btl: 'Buy-to-let', brrr: 'BRRR (buy, refurbish, refinance, rent)', flip: 'Flip (buy, refurbish, sell)', hmo: 'HMO (house in multiple occupation)', commercial: 'Commercial' };

/**
 * Streetkey's rule-based rating of a scenario, from the computed numbers only. The AI may be
 * more cautious than this (e.g. for a short lease), never more optimistic.
 */
export function ruleVerdict(strategy: Strategy, r: InvestmentResult, down: InvestmentResult): { verdict: Verdict; reasons: string[] } {
  if (strategy === 'flip') {
    const reasons = [
      `Profit ${money(r.flipProfit)} after all costs (${pc(r.profitOnCost)} on cost), pre-tax; development lenders typically look for 15–20%.`,
      `In the downside case the profit is ${money(down.flipProfit)}.`,
    ];
    const verdict: Verdict = r.flipProfit <= 0 ? 'weak' : r.profitOnCost < 0.1 || down.flipProfit < 0 ? 'marginal' : r.profitOnCost < 0.2 ? 'workable' : 'strong';
    return { verdict, reasons };
  }
  const cf = r.monthlyCashflow;
  const coc = r.cashOnCash;
  const reasons = [
    `Monthly cash flow ${money(cf)} after finance and running costs (pre-tax).`,
    Number.isFinite(coc) ? `Cash-on-cash return ${pc(coc)} on ${money(r.cashInvested)} left in.` : 'All of the cash comes back out on refinance, so cash-on-cash isn’t meaningful.',
    `Downside case: ${money(down.monthlyCashflow)} a month.`,
  ];
  if (strategy === 'commercial') {
    reasons.push(`Net yield ${pc(r.netYield)} on the all-in cost.`);
    const verdict: Verdict = cf < 0 ? 'weak' : down.monthlyCashflow < 0 || r.netYield < 0.05 ? 'marginal' : r.netYield >= 0.08 && (!Number.isFinite(coc) || coc >= 0.08) ? 'strong' : 'workable';
    return { verdict, reasons };
  }
  reasons.splice(1, 0, `Lender stress test ${r.icrPass ? 'passes' : 'fails'}: rent covers stressed interest ${pc(r.icr, 0)} vs ${pc(r.icrRequired, 0)} required.`);
  const verdict: Verdict = cf < 0 ? 'weak'
    : !r.icrPass || down.monthlyCashflow < 0 || (Number.isFinite(coc) && coc < 0.03) ? 'marginal'
    : (!Number.isFinite(coc) || coc >= 0.08) && down.monthlyCashflow > 0 ? 'strong' : 'workable';
  return { verdict, reasons };
}

/** Everything the investment verdict is grounded in, computed by the investment engine. */
export function investFacts(inputs: InvestmentInput, s: ScenarioName) {
  const active = scenario(inputs, s);
  const result = analyse(active);
  const all = { downside: analyse(scenario(inputs, 'downside')), base: analyse(scenario(inputs, 'base')), optimistic: analyse(scenario(inputs, 'optimistic')) };
  const be = breakEven(active);
  const rule = ruleVerdict(inputs.strategy, result, all.downside);
  return { active, result, all, be, rule };
}

/** Key numbers the verdict was based on (finite or null, so they survive JSON). */
export interface InvestNumbers {
  monthlyCashflow: number; cashInvested: number; grossYield: number; netYield: number; cashOnCash: number | null;
  icr: number | null; icrPass: boolean; icrRequired: number; stressRate: number; flipProfit: number; profitOnCost: number;
  transactionTax: number; taxName: string; downsideMonthlyCashflow: number; downsideFlipProfit: number;
  breakEvenRent: number | null; breakEvenSalePrice: number | null;
}

export interface InvestVerdictResult {
  verdict: Verdict; headline: string; strengths: string[]; risks: string[]; whatMustBeTrue: string[]; questionsToAsk: string[]; stressTestReading: string;
  ruleVerdict: Verdict; ruleReasons: string[];
  /** true when the AI's verdict was more optimistic than the numbers support and was lowered. */
  verdictCapped: boolean;
  strategy: Strategy; scenario: ScenarioName; numbers: InvestNumbers;
  removedClaims: number; disclaimer: string;
}

/* ───────────────────────── 4. my home ───────────────────────── */
export const HOME_GOALS = [
  { id: 'add-value', label: 'Add value' }, { id: 'cut-bills', label: 'Cut energy bills' }, { id: 'more-space', label: 'More space' },
  { id: 'sell-soon', label: 'Sell soon' }, { id: 'rent-out', label: 'Rent it out' },
] as const;
export type HomeGoal = (typeof HOME_GOALS)[number]['id'];
export const HOME_GOAL_IDS = HOME_GOALS.map((g) => g.id) as unknown as readonly [HomeGoal, ...HomeGoal[]];
export type HomeType = Exclude<PropertyType, 'commercial'>;
export const EPC_BANDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type EpcBand = (typeof EPC_BANDS)[number];
export interface HomeFacts { postcode: string; type: HomeType; beds: number; area: number; era: Era; condition: Condition; epc: EpcBand }

const EPC_SCORE: Record<EpcBand, number> = { A: 94, B: 84, C: 72, D: 61, E: 47, F: 30, G: 15 };

/** A Property-shaped record for someone's own home (or a property described by its facts), so the same engines apply. */
export function factsProperty(f: { postcode: string; type: PropertyType; beds: number; baths?: number; area: number; storeys?: number; era: Era; condition: Condition; epc?: EpcBand }, o: { estGdv?: number; estRentPcm?: number } = {}): Property {
  const district = f.postcode.trim().toUpperCase().split(' ')[0];
  const epc = f.epc ?? 'D';
  return {
    id: 'my-home', title: 'My home', street: 'Your address', district, postcode: f.postcode.toUpperCase(), town: district,
    nation: /^(CF|LD|LL|NP|SA|SY)\d/.test(district) ? 'wales' : regionFromPostcode(f.postcode) === 'scotland' ? 'scotland' : regionFromPostcode(f.postcode) === 'northern-ireland' ? 'northern-ireland' : 'england',
    lat: 0, lng: 0, listing: 'sale', price: 0, type: f.type, tenure: f.type === 'flat' ? 'leasehold' : 'freehold', beds: f.beds, baths: f.baths ?? 1, floorArea: f.area,
    storeys: f.storeys ?? (f.type === 'flat' || f.type === 'bungalow' ? 1 : 2),
    era: f.era, condition: f.condition, epc: { current: epc, potential: 'B', score: EPC_SCORE[epc] ?? 60 }, councilTax: 'D', features: f.type === 'terraced' ? ['Side return'] : [],
    loftPotential: f.type === 'flat' || f.type === 'commercial' ? 'none' : 'possible', extensionPotential: f.type === 'flat' || f.type === 'commercial' ? 'none' : 'possible',
    estRentPcm: o.estRentPcm ?? 0, estGdv: o.estGdv ?? 0,
    commute: { to: '', minutes: 0, mode: '' }, station: { name: '', walkMins: 0 }, schools: [],
    risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [], areaIndex: [], rentDemand: 0, comparables: [], planningNearby: [], agent: '', daysOnMarket: 0, photoHue: 20,
  };
}

export interface HomeEvidence { refurbishedPerM2: number; rentPerM2: number; n: number; scope: string }
/** Indicative £/m² from listings in the same postcode district, else the same region. Honest about coverage. */
export function homeEvidence(postcode: string, pool: Property[] = PROPERTIES): HomeEvidence | null {
  const district = postcode.trim().toUpperCase().split(' ')[0];
  const region = regionFromPostcode(postcode);
  const resi = pool.filter((p) => p.listing !== 'rent' && p.type !== 'commercial' && p.floorArea > 0 && p.estGdv > 0);
  const near = resi.filter((p) => p.district === district);
  const used = near.length ? near : region ? resi.filter((p) => regionFromPostcode(p.postcode) === region) : [];
  if (!used.length) return null;
  const rents = used.filter((p) => p.estRentPcm > 0);
  return {
    refurbishedPerM2: avg(used.map((p) => p.estGdv / p.floorArea)),
    rentPerM2: rents.length ? avg(rents.map((p) => p.estRentPcm / p.floorArea)) : 0,
    n: used.length,
    scope: near.length ? `postcode district ${district}` : region ? REGIONS[region].label : 'region',
  };
}

const COND_ADJ: Record<Condition, number> = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 };
function valueBand(ev: HomeEvidence, area: number, condition: Condition) {
  const mid = ev.refurbishedPerM2 * area * COND_ADJ[condition];
  const spread = ev.n >= 3 ? 0.08 : 0.12;
  return { low: r1k(mid * (1 - spread)), mid: r1k(mid), high: r1k(mid * (1 + spread)) };
}

/** Everything My Home shows, from the engines (shared by the page and the AI plan). */
export function homeModel(f: HomeFacts, pool: Property[] = PROPERTIES) {
  const ev = homeEvidence(f.postcode, pool);
  const p = factsProperty(f, ev ? { estGdv: r1k(ev.refurbishedPerM2 * f.area), estRentPcm: ev.rentPerM2 ? Math.round((ev.rentPerM2 * f.area) / 25) * 25 : 0 } : {});
  // Full renovation = whole-house scope (as for a 'needs work' home), priced at the home's actual condition.
  const full = estimateRefurb({ ...refurbInputFor({ ...p, condition: 'poor' }), condition: f.condition });
  const b = refurbInputFor(p);
  const light = estimateRefurb({ ...b, bathrooms: 0, spec: 'standard', scope: { ...b.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', windows: false, roof: 'none', damp: false, external: false, structuralOpenings: 0, kitchen: false, flooring: true, decoration: true, insulation: true } });
  const dev = developmentOptions(p).filter((o) => o.status !== 'not applicable' && o.id !== 'energy');
  const epc = epcPathway(p);
  const loft = loftScenario(p);
  const value = ev ? valueBand(ev, f.area, f.condition) : null;
  const valueAfterWorks = ev ? valueBand(ev, f.area, 'good') : null;
  const rent = p.estRentPcm > 0 ? rentalScenario(p) : null;
  return { ev, p, full, light, dev, epc, loft, value, valueAfterWorks, rent, energyNow: energyCost(p, f.epc) };
}
export type HomeModel = ReturnType<typeof homeModel>;

/** Annual energy cost for a home at an EPC band (the ownership forecast's year-one figure). */
export const energyCost = (p: Property, band: string) => ownershipForecast({ ...p, epc: { ...p.epc, current: band } })[0].energy;

export interface PlanOption {
  id: string; title: string; detail: string;
  cost: number | null; valueImpact: number | null; billsSaving: number | null; rentPcm: number | null;
  effort: 'low' | 'medium' | 'high'; goals: HomeGoal[]; withinBudget: boolean | null;
}

/** Costed options for the chosen goals, best first (the rule-based plan, and what the AI chooses from). */
export function planOptions(m: HomeModel, goals: HomeGoal[], budget: number | null): PlanOption[] {
  const out: Omit<PlanOption, 'withinBudget'>[] = [];
  const f = m.p;
  out.push({ id: 'refresh', title: 'Light refresh: decorate, new floor finishes and loft insulation', detail: `About ${m.light.programmeWeeks} weeks (${m.light.confidence} confidence estimate).`, cost: m.light.total, valueImpact: null, billsSaving: null, rentPcm: null, effort: 'medium', goals: ['sell-soon', 'rent-out', 'add-value'] });
  if (f.condition !== 'good') {
    const uplift = m.value && m.valueAfterWorks ? m.valueAfterWorks.mid - m.value.mid : null;
    out.push({ id: 'renovate', title: 'Full renovation', detail: `Likely ${money(m.full.low)}–${money(m.full.high)}, about ${m.full.programmeWeeks} weeks.`, cost: m.full.total, valueImpact: uplift && uplift > 0 ? uplift : null, billsSaving: null, rentPcm: null, effort: 'high', goals: ['add-value'] });
  }
  const devLoft = m.dev.find((o) => o.id === 'loft');
  if (m.loft && devLoft && devLoft.status !== 'constrained') {
    out.push({ id: 'loft', title: 'Loft conversion', detail: `About ${m.loft.area} m² of new space; screening says: ${devLoft.status}.`, cost: m.loft.cost, valueImpact: f.estGdv > 0 ? m.loft.valueUplift : null, billsSaving: null, rentPcm: null, effort: 'high', goals: ['more-space', 'add-value'] });
  }
  for (const id of ['rear', 'side'] as const) {
    const o = m.dev.find((d) => d.id === id);
    if (o && o.status !== 'constrained' && o.cost) out.push({ id, title: o.name, detail: `Screening says: ${o.status}. ${o.summary}`, cost: o.cost, valueImpact: f.estGdv > 0 && o.valueUplift ? o.valueUplift : null, billsSaving: null, rentPcm: null, effort: 'high', goals: ['more-space', 'add-value'] });
  }
  let band = f.epc.current;
  m.epc.steps.slice(0, 4).forEach((s, k) => {
    const saving = energyCost(f, band) - energyCost(f, s.band);
    const neededToLet = band > 'E';
    out.push({ id: `epc-${k + 1}`, title: s.measure, detail: `EPC ${band} → about ${s.band} after this step (indicative).`, cost: s.cost, valueImpact: null, billsSaving: saving > 0 ? saving : null, rentPcm: null, effort: s.cost < 1000 ? 'low' : s.cost < 8000 ? 'medium' : 'high', goals: neededToLet ? ['cut-bills', 'rent-out'] : ['cut-bills'] });
    band = s.band;
  });
  out.push({ id: 'lettings-ready', title: 'Get lettings-ready', detail: 'A valid EPC (E or better to let in England and Wales), gas safety check, electrical safety report (EICR), smoke and carbon monoxide alarms, and deposit protection. Rules differ in Scotland and Northern Ireland.', cost: null, valueImpact: null, billsSaving: null, rentPcm: m.rent?.mid ?? null, effort: 'low', goals: ['rent-out'] });
  out.push({ id: 'sale-ready', title: 'Get sale-ready', detail: 'Have your EPC, council tax band, tenure and any lease details ready (material information buyers must be told), fix small defects and declutter before photos.', cost: null, valueImpact: null, billsSaving: null, rentPcm: null, effort: 'low', goals: ['sell-soon'] });

  const want = new Set(goals);
  const score = (o: PlanOption) => o.goals.filter((g) => want.has(g)).length * 10 + (o.withinBudget === false ? -6 : 0) + (o.cost == null ? 2 : 0)
    + (o.valueImpact && o.cost ? Math.min(3, o.valueImpact / o.cost) : 0) + (o.billsSaving && o.cost ? Math.min(3, (o.billsSaving * 10) / o.cost) : 0);
  return out
    .map((o) => ({ ...o, withinBudget: budget == null || o.cost == null ? (budget == null ? null : true) : o.cost <= budget }))
    .filter((o) => o.goals.some((g) => want.has(g)))
    .sort((a, b) => score(b) - score(a));
}

export interface PlanStep {
  order: number; title: string; why: string;
  /** Engine-derived figures for the option this step uses, or null (the AI never writes these). */
  cost: number | null; valueImpact: number | null; billsSaving: number | null;
  effort: 'low' | 'medium' | 'high'; optionId: string | null; withinBudget: boolean | null;
}
export interface HomePlanResult {
  summary: string; steps: PlanStep[]; quickWins: string[]; avoid: string[];
  figures: { value: { low: number; mid: number; high: number } | null; rent: { low: number; mid: number; high: number } | null; evidence: string | null };
  goals: HomeGoal[]; budget: number | null; removedClaims: number; disclaimer: string;
}
