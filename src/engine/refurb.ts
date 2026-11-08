/**
 * Streetkey Refurbishment Cost Engine — v0.1 (deterministic).
 *
 * Structure mirrors how a UK quantity surveyor builds an elemental estimate:
 *   measured works (quantity × unit rate × spec × regional × condition/age/access)
 *   + preliminaries + overheads & profit + contingency + professional fees + VAT.
 *
 * IMPORTANT: unit rates in RATE_LIBRARY are Streetkey demonstration rates
 * compiled for prototyping (UK national average, Q4 2026 basis). They are
 * NOT BCIS, Spon's or any licensed price book. Production replaces this
 * table with a versioned rate library calibrated from verified contractor
 * quotations and invoices (see docs/02-architecture.md §Pricing data loop).
 */

export const PRICING_BASIS = {
  version: 'streetkey-demo-rates-0.1',
  basisDate: '2026-11-01',
  source: 'Demonstration rates (national average). Not calibrated against verified quotations.',
};

export type Spec = 'budget' | 'standard' | 'premium';
export type Condition = 'good' | 'fair' | 'poor' | 'derelict';
export type Era = 'pre-1919' | '1919-1944' | '1945-1979' | '1980-1999' | '2000+';
export type PropertyType = 'terraced' | 'semi-detached' | 'detached' | 'flat' | 'bungalow' | 'commercial';
export type Access = 'easy' | 'restricted' | 'difficult';

export type RegionKey =
  | 'central-london' | 'outer-london' | 'south-east' | 'east' | 'south-west'
  | 'west-midlands' | 'east-midlands' | 'north-west' | 'yorkshire' | 'north-east'
  | 'wales' | 'scotland' | 'northern-ireland';

/** Regional labour+materials index vs UK average = 1.00. Demo values. */
export const REGIONS: Record<RegionKey, { label: string; factor: number }> = {
  'central-london': { label: 'Central London', factor: 1.32 },
  'outer-london': { label: 'Outer London', factor: 1.16 },
  'south-east': { label: 'South East', factor: 1.10 },
  east: { label: 'East of England', factor: 1.04 },
  'south-west': { label: 'South West', factor: 1.00 },
  'west-midlands': { label: 'West Midlands', factor: 0.95 },
  'east-midlands': { label: 'East Midlands', factor: 0.94 },
  'north-west': { label: 'North West', factor: 0.93 },
  yorkshire: { label: 'Yorkshire & Humber', factor: 0.92 },
  'north-east': { label: 'North East', factor: 0.89 },
  wales: { label: 'Wales', factor: 0.92 },
  scotland: { label: 'Scotland', factor: 0.96 },
  'northern-ireland': { label: 'Northern Ireland', factor: 0.84 },
};

/** Crude postcode-area → region mapping (outward code prefix). */
const POSTCODE_REGION: [RegExp, RegionKey][] = [
  [/^(EC\d[A-Z]?|WC\d[A-Z]?|W1[A-Z]?|SW1[A-Z]?|SE1|N1|NW1|E1) /i, 'central-london'],
  [/^(E|N|NW|SE|SW|W|BR|CR|DA|EN|HA|IG|KT|RM|SM|TW|UB)\d/i, 'outer-london'],
  [/^(BN|CT|GU|ME|MK|OX|PO|RG|RH|SL|SO|TN|HP)\d/i, 'south-east'],
  [/^(AL|CB|CM|CO|IP|LU|NR|PE|SG|SS|WD)\d/i, 'east'],
  [/^(BA|BH|BS|DT|EX|GL|PL|SN|SP|TA|TQ|TR)\d/i, 'south-west'],
  [/^(B|CV|DY|HR|ST|TF|WR|WS|WV)\d/i, 'west-midlands'],
  [/^(DE|DN|LE|LN|NG|NN|S)\d/i, 'east-midlands'],
  [/^(BB|BL|CA|CH|CW|FY|L|LA|M|OL|PR|SK|WA|WN)\d/i, 'north-west'],
  [/^(BD|HD|HG|HU|HX|LS|WF|YO)\d/i, 'yorkshire'],
  [/^(DH|DL|NE|SR|TS)\d/i, 'north-east'],
  [/^(CF|LD|LL|NP|SA|SY)\d/i, 'wales'],
  [/^(AB|DD|DG|EH|FK|G|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)\d/i, 'scotland'],
  [/^BT\d/i, 'northern-ireland'],
];

export function regionFromPostcode(postcode: string): RegionKey | null {
  let pc = postcode.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!pc.includes(' ') && pc.length >= 5) pc = `${pc.slice(0, -3)} ${pc.slice(-3)}`;
  else if (!pc.includes(' ')) pc = `${pc} `; // outward code only
  for (const [re, region] of POSTCODE_REGION) if (re.test(pc)) return region;
  return null;
}

export type Unit = 'm²' | 'item' | 'nr' | 'm' | 'lm' | 'sum';
export type Trade =
  | 'Strip-out & waste' | 'Structural' | 'Roofing' | 'Windows & doors' | 'Plastering'
  | 'Electrical' | 'Plumbing & heating' | 'Kitchen' | 'Bathroom' | 'Joinery'
  | 'Flooring' | 'Decoration' | 'External works' | 'Damp & timber' | 'Extension' | 'Loft conversion'
  | 'Energy & insulation' | 'Groundworks' | 'Commercial fit-out' | 'Conversion';

export interface RateItem {
  code: string;
  trade: Trade;
  description: string;
  unit: Unit;
  /** Standard-spec NET trade rate (labour + materials + plant), national average, ex VAT,
   *  excluding main-contractor preliminaries and OH&P (added separately). */
  rate: number;
  /** Labour share, used for regional sensitivity reporting. */
  labour: number;
  specMultipliers?: Partial<Record<Spec, number>>;
}

const SPEC_DEFAULT: Record<Spec, number> = { budget: 0.72, standard: 1, premium: 1.65 };

export const RATE_LIBRARY: Record<string, RateItem> = {
  STRIP: { code: 'STRIP', trade: 'Strip-out & waste', description: 'Soft strip, skip hire & licensed waste removal', unit: 'm²', rate: 27, labour: 0.75, specMultipliers: { budget: 1, standard: 1, premium: 1.1 } },
  RSJ: { code: 'RSJ', trade: 'Structural', description: 'Remove load-bearing wall, install steel beam incl. padstones & building control', unit: 'nr', rate: 3_000, labour: 0.6, specMultipliers: { budget: 1, standard: 1, premium: 1.15 } },
  ROOF_RECOVER: { code: 'ROOF_RECOVER', trade: 'Roofing', description: 'Strip & re-cover pitched roof (tiles/slates, membrane, battens)', unit: 'm²', rate: 83, labour: 0.55 },
  ROOF_REPAIR: { code: 'ROOF_REPAIR', trade: 'Roofing', description: 'Roof overhaul: replace slipped tiles, repoint ridge, renew flashings', unit: 'sum', rate: 1_200, labour: 0.7 },
  WINDOW: { code: 'WINDOW', trade: 'Windows & doors', description: 'Replace window, A-rated uPVC double glazed (timber at premium)', unit: 'nr', rate: 560, labour: 0.3, specMultipliers: { budget: 0.8, standard: 1, premium: 2.1 } },
  EXT_DOOR: { code: 'EXT_DOOR', trade: 'Windows & doors', description: 'External door set incl. frame & ironmongery', unit: 'nr', rate: 1_050, labour: 0.3 },
  INT_DOOR: { code: 'INT_DOOR', trade: 'Joinery', description: 'Internal door, lining, architrave & ironmongery', unit: 'nr', rate: 245, labour: 0.5 },
  SKIRT: { code: 'SKIRT', trade: 'Joinery', description: 'Skirting & architrave renewal', unit: 'lm', rate: 17, labour: 0.6 },
  REPLASTER: { code: 'REPLASTER', trade: 'Plastering', description: 'Hack off & re-plaster walls; skim ceilings', unit: 'm²', rate: 29, labour: 0.8 },
  SKIM: { code: 'SKIM', trade: 'Plastering', description: 'Skim coat to walls & ceilings', unit: 'm²', rate: 14, labour: 0.85 },
  REWIRE: { code: 'REWIRE', trade: 'Electrical', description: 'Full rewire, new consumer unit, EICR & Part P certification', unit: 'm²', rate: 52, labour: 0.7 },
  ELEC_PARTIAL: { code: 'ELEC_PARTIAL', trade: 'Electrical', description: 'Consumer unit upgrade, additional sockets, EICR remedials', unit: 'sum', rate: 1_000, labour: 0.7 },
  HEATING_FULL: { code: 'HEATING_FULL', trade: 'Plumbing & heating', description: 'New combi boiler, radiators & pipework, Gas Safe commissioning', unit: 'm²', rate: 46, labour: 0.55 },
  BOILER: { code: 'BOILER', trade: 'Plumbing & heating', description: 'Replace boiler only, incl. flue & system flush', unit: 'nr', rate: 2_050, labour: 0.4 },
  ASHP: { code: 'ASHP', trade: 'Energy & insulation', description: 'Air source heat pump incl. cylinder & emitter upgrades (pre-grant)', unit: 'nr', rate: 9_700, labour: 0.4, specMultipliers: { budget: 0.9, standard: 1, premium: 1.2 } },
  KITCHEN: { code: 'KITCHEN', trade: 'Kitchen', description: 'Kitchen supply & fit incl. worktops, appliances, tiling & services', unit: 'item', rate: 7_550, labour: 0.35, specMultipliers: { budget: 0.55, standard: 1, premium: 2.4 } },
  BATHROOM: { code: 'BATHROOM', trade: 'Bathroom', description: 'Bathroom supply & fit incl. sanitaryware, tiling, extract & services', unit: 'nr', rate: 5_200, labour: 0.5, specMultipliers: { budget: 0.62, standard: 1, premium: 2.0 } },
  ENSUITE: { code: 'ENSUITE', trade: 'Bathroom', description: 'Shower en-suite, new formation incl. drainage', unit: 'nr', rate: 4_600, labour: 0.55, specMultipliers: { budget: 0.65, standard: 1, premium: 1.9 } },
  FLOOR: { code: 'FLOOR', trade: 'Flooring', description: 'Floor finishes (carpet/LVT/engineered timber by spec) incl. screed prep', unit: 'm²', rate: 35, labour: 0.35, specMultipliers: { budget: 0.6, standard: 1, premium: 2.2 } },
  DECOR: { code: 'DECOR', trade: 'Decoration', description: 'Prepare & decorate walls, ceilings & woodwork (mist + 2 coats)', unit: 'm²', rate: 10, labour: 0.85 },
  DAMP: { code: 'DAMP', trade: 'Damp & timber', description: 'Damp remediation: diagnosis-led (ventilation, drainage, injected DPC where justified)', unit: 'lm', rate: 68, labour: 0.6 },
  EXTERNAL: { code: 'EXTERNAL', trade: 'External works', description: 'Repointing, gutters & downpipes, front garden/boundary tidy', unit: 'sum', rate: 3_450, labour: 0.7 },
  LANDSCAPE: { code: 'LANDSCAPE', trade: 'External works', description: 'Rear garden: patio, turf, fencing', unit: 'm²', rate: 61, labour: 0.6 },
  EXTENSION: { code: 'EXTENSION', trade: 'Extension', description: 'Single-storey rear extension shell & fit-out (excl. kitchen)', unit: 'm²', rate: 1_950, labour: 0.5, specMultipliers: { budget: 0.85, standard: 1, premium: 1.35 } },
  LOFT: { code: 'LOFT', trade: 'Loft conversion', description: 'Rear dormer loft conversion incl. stairs, fire strategy, shower room', unit: 'm²', rate: 1_250, labour: 0.55, specMultipliers: { budget: 0.88, standard: 1, premium: 1.3 } },
  GROUND: { code: 'GROUND', trade: 'Groundworks', description: 'Groundworks: excavation, drainage connections, hardstanding', unit: 'm²', rate: 140, labour: 0.6 },
  CAT_A: { code: 'CAT_A', trade: 'Commercial fit-out', description: 'Cat A office fit-out: raised floor, suspended ceiling, LED lighting, M&E distribution', unit: 'm²', rate: 520, labour: 0.5, specMultipliers: { budget: 0.85, standard: 1, premium: 1.3 } },
  CAT_B: { code: 'CAT_B', trade: 'Commercial fit-out', description: 'Cat B fit-out: partitions, finishes, kitchenette, furniture & AV', unit: 'm²', rate: 640, labour: 0.45, specMultipliers: { budget: 0.75, standard: 1, premium: 1.6 } },
  O2R: { code: 'O2R', trade: 'Conversion', description: 'Office-to-residential: strip-out, new partitions, compartmentation, M&E, kitchens & bathrooms per flat', unit: 'm²', rate: 1_150, labour: 0.5, specMultipliers: { budget: 0.88, standard: 1, premium: 1.25 } },
  INSULATION: { code: 'INSULATION', trade: 'Energy & insulation', description: 'Loft insulation to 270mm + draught-proofing', unit: 'm²', rate: 13, labour: 0.5 },
  IWI: { code: 'IWI', trade: 'Energy & insulation', description: 'Internal wall insulation to solid external walls', unit: 'm²', rate: 97, labour: 0.55 },
};

export const CONDITION_FACTOR: Record<Condition, number> = { good: 0.94, fair: 1, poor: 1.06, derelict: 1.15 };
export const ERA_FACTOR: Record<Era, number> = { 'pre-1919': 1.08, '1919-1944': 1.04, '1945-1979': 1.0, '1980-1999': 0.97, '2000+': 0.95 };
export const ACCESS_FACTOR: Record<Access, number> = { easy: 1, restricted: 1.05, difficult: 1.12 };
const CONTINGENCY: Record<Condition, number> = { good: 0.05, fair: 0.08, poor: 0.12, derelict: 0.18 };
const ERA_CONTINGENCY_UPLIFT: Record<Era, number> = { 'pre-1919': 0.02, '1919-1944': 0.01, '1945-1979': 0.01, '1980-1999': 0, '2000+': 0 };

export type VatTreatment = 'standard' | 'reduced-empty-2yrs' | 'reduced-conversion' | 'none';
export const VAT_RATES: Record<VatTreatment, { rate: number; label: string }> = {
  standard: { rate: 0.2, label: 'Standard rate 20% (typical refurbishment of occupied/recent dwelling)' },
  'reduced-empty-2yrs': { rate: 0.05, label: 'Reduced rate 5% — dwelling empty for 2+ years (evidence required, VAT Notice 708)' },
  'reduced-conversion': { rate: 0.05, label: 'Reduced rate 5% — changing number of dwellings / non-residential to residential' },
  none: { rate: 0, label: 'Excluded (contractor not VAT registered or user override)' },
};

export interface RefurbInput {
  postcode: string;
  propertyType: PropertyType;
  floorArea: number;    // m² GIA
  bedrooms: number;
  bathrooms: number;    // number to (re)fit
  storeys: number;
  era: Era;
  condition: Condition;
  access: Access;
  spec: Spec;
  scope: {
    stripOut: boolean;
    rewire: boolean;
    heating: 'none' | 'boiler' | 'full' | 'heat-pump';
    replaster: 'none' | 'skim' | 'full';
    kitchen: boolean;
    windows: boolean;
    roof: 'none' | 'repair' | 'recover';
    flooring: boolean;
    decoration: boolean;
    damp: boolean;
    external: boolean;
    structuralOpenings: number;
    extensionArea: number; // m², 0 = none
    loftArea: number;      // m², 0 = none
    insulation: boolean;
    solidWallInsulation: boolean;
    ensuites: number;
    groundworksArea?: number;
    fitOut?: 'none' | 'cat-a' | 'cat-a+b';
    officeToResiArea?: number;
  };
  vat: VatTreatment;
  includeProfessionalFees: boolean;
}

export interface EstimateLine {
  code: string;
  trade: Trade;
  description: string;
  unit: Unit;
  quantity: number;
  rate: number;    // adjusted rate
  total: number;
  quantityBasis: string;
}

export interface Estimate {
  lines: EstimateLine[];
  labourAllowance: number;
  materialsAllowance: number;
  byTrade: { trade: Trade; total: number }[];
  measuredWorks: number;
  preliminaries: number;
  overheadsProfit: number;
  contingency: number;
  professionalFees: number;
  subtotalExVat: number;
  vat: number;
  total: number;
  low: number;
  high: number;
  confidence: 'low' | 'medium' | 'high';
  costPerM2: number;
  programmeWeeks: number;
  factors: { label: string; value: string }[];
  assumptions: string[];
  exclusions: string[];
  compliance: string[];
  basis: typeof PRICING_BASIS;
  region: RegionKey;
}

const round = (n: number, to = 1) => Math.round(n / to) * to;

/** Derived quantities — transparent, simple geometry a QS would sense-check. */
export function deriveQuantities(i: RefurbInput) {
  const storeyHeight = 2.5;
  const footprint = i.floorArea / Math.max(1, i.storeys);
  const perimeter = 4 * Math.sqrt(footprint) * 1.15; // allow for non-square plan
  const rooms = i.bedrooms + 2 + Math.max(0, i.bathrooms); // + living, kitchen, baths
  const internalWallArea = i.floorArea * 2.6; // wall area to both faces, rule of thumb
  const plasterArea = internalWallArea + i.floorArea; // walls + ceilings
  const windows = Math.max(4, Math.round(i.floorArea / 11));
  const pitchFactor = i.propertyType === 'flat' ? 0 : i.propertyType === 'commercial' ? 1.02 : i.propertyType === 'bungalow' ? 1.35 : 1.25;
  const roofArea = footprint * pitchFactor;
  const externalWallArea = perimeter * storeyHeight * i.storeys * (i.propertyType === 'terraced' ? 0.45 : i.propertyType === 'semi-detached' ? 0.72 : i.propertyType === 'flat' ? 0.35 : 1);
  return {
    footprint: round(footprint), perimeter: round(perimeter), rooms,
    plasterArea: round(plasterArea), windows, roofArea: round(roofArea),
    externalWallArea: round(externalWallArea),
    intDoors: rooms + 1,
    skirting: round(perimeter * i.storeys * 2.2),
    dampLm: round(perimeter * 0.35),
    gardenArea: i.propertyType === 'flat' ? 0 : round(footprint * 0.9),
  };
}

export function estimateRefurb(i: RefurbInput): Estimate {
  const region = regionFromPostcode(i.postcode) ?? 'south-west';
  const regionF = REGIONS[region].factor;
  const condF = CONDITION_FACTOR[i.condition];
  const eraF = ERA_FACTOR[i.era];
  const accessF = ACCESS_FACTOR[i.access];
  const q = deriveQuantities(i);
  const lines: EstimateLine[] = [];

  const add = (code: string, quantity: number, quantityBasis: string, opts: { conditionSensitive?: boolean; eraSensitive?: boolean } = {}) => {
    if (quantity <= 0) return;
    const item = RATE_LIBRARY[code];
    const specM = item.specMultipliers?.[i.spec] ?? SPEC_DEFAULT[i.spec];
    const cs = opts.conditionSensitive ?? true;
    const es = opts.eraSensitive ?? true;
    const rate = item.rate * specM * regionF * accessF * (cs ? condF : 1) * (es ? eraF : 1);
    lines.push({ code, trade: item.trade, description: item.description, unit: item.unit, quantity: round(quantity, item.unit === 'm²' || item.unit === 'lm' ? 1 : 1), rate: round(rate, 1), total: round(rate * quantity, 1), quantityBasis });
  };

  const s = i.scope;
  if (s.stripOut) add('STRIP', i.floorArea, 'GIA');
  if (s.structuralOpenings > 0) add('RSJ', s.structuralOpenings, 'User input', { conditionSensitive: false });
  if (s.roof === 'recover') add('ROOF_RECOVER', q.roofArea, `Footprint ${q.footprint}m² × pitch factor`);
  if (s.roof === 'repair') add('ROOF_REPAIR', 1, 'Provisional sum');
  if (s.windows) { add('WINDOW', q.windows, '≈ 1 window per 11m² GIA'); add('EXT_DOOR', i.propertyType === 'flat' ? 1 : 2, 'Front + rear', { conditionSensitive: false }); }
  if (s.replaster === 'full') add('REPLASTER', q.plasterArea, 'GIA × 2.6 walls + ceilings');
  if (s.replaster === 'skim') add('SKIM', q.plasterArea, 'GIA × 2.6 walls + ceilings');
  if (s.rewire) add('REWIRE', i.floorArea, 'GIA'); else add('ELEC_PARTIAL', 1, 'Provisional sum');
  if (s.heating === 'full') add('HEATING_FULL', i.floorArea, 'GIA');
  if (s.heating === 'boiler') add('BOILER', 1, 'Item', { conditionSensitive: false });
  if (s.heating === 'heat-pump') add('ASHP', 1, 'Item — before Boiler Upgrade Scheme grant', { conditionSensitive: false });
  if (s.kitchen) add('KITCHEN', 1, 'Item', { conditionSensitive: false });
  if (i.bathrooms > 0) add('BATHROOM', i.bathrooms, 'User input');
  if (s.ensuites > 0) add('ENSUITE', s.ensuites, 'User input');
  if (s.decoration || s.replaster !== 'none') { add('INT_DOOR', q.intDoors, 'Rooms + 1', { conditionSensitive: false }); add('SKIRT', q.skirting, 'Perimeter × storeys × 2.2'); }
  if (s.flooring) add('FLOOR', i.floorArea * 0.85, 'GIA less 15% tiled wet areas');
  if (s.decoration) add('DECOR', q.plasterArea, 'Plastered area');
  if (s.damp) add('DAMP', q.dampLm, '35% of ground-floor perimeter (survey to confirm)');
  if (s.external) { add('EXTERNAL', 1, 'Provisional sum'); if (q.gardenArea) add('LANDSCAPE', q.gardenArea * 0.5, '50% of est. rear garden'); }
  if (s.extensionArea > 0) add('EXTENSION', s.extensionArea, 'User input', { conditionSensitive: false, eraSensitive: false });
  if (s.loftArea > 0) add('LOFT', s.loftArea, 'User input', { conditionSensitive: false });
  if (s.insulation) add('INSULATION', q.footprint, 'Footprint', { conditionSensitive: false, eraSensitive: false });
  if (s.solidWallInsulation) add('IWI', q.externalWallArea, 'Est. exposed external wall', { conditionSensitive: false });
  if (s.groundworksArea) add('GROUND', s.groundworksArea, 'User input', { conditionSensitive: false, eraSensitive: false });
  if (s.fitOut && s.fitOut !== 'none') { add('CAT_A', i.floorArea * 0.85, 'NIA ≈ 85% of GIA', { eraSensitive: false }); if (s.fitOut === 'cat-a+b') add('CAT_B', i.floorArea * 0.85, 'NIA ≈ 85% of GIA', { conditionSensitive: false, eraSensitive: false }); }
  if (s.officeToResiArea) add('O2R', s.officeToResiArea, 'User input (GIA converted)', { eraSensitive: false });

  const measuredWorks = lines.reduce((t, l) => t + l.total, 0);
  const hasMajor = s.extensionArea > 0 || s.loftArea > 0 || s.structuralOpenings > 0 || !!s.officeToResiArea;
  const hasNewSpace = s.extensionArea > 0 || s.loftArea > 0 || !!s.officeToResiArea;
  const prelimRate = (i.access === 'difficult' ? 0.14 : 0.11) + (hasMajor ? 0.02 : 0);
  const preliminaries = measuredWorks * prelimRate;
  const ohpRate = 0.12;
  const overheadsProfit = (measuredWorks + preliminaries) * ohpRate;
  const contRate = CONTINGENCY[i.condition] + ERA_CONTINGENCY_UPLIFT[i.era] + (hasNewSpace ? 0.02 : 0);
  const contingency = (measuredWorks + preliminaries + overheadsProfit) * contRate;
  const feeRate = !i.includeProfessionalFees ? 0 : hasNewSpace ? 0.12 : hasMajor ? 0.06 : 0.035;
  const professionalFees = (measuredWorks + preliminaries + overheadsProfit) * feeRate;
  const subtotalExVat = measuredWorks + preliminaries + overheadsProfit + contingency + professionalFees;
  const vatRate = VAT_RATES[i.vat].rate;
  const vat = subtotalExVat * vatRate;
  const total = subtotalExVat + vat;

  // Confidence band: wider for older, poorer properties and bigger structural scope.
  let spread = 0.12;
  if (i.condition === 'poor') spread += 0.05;
  if (i.condition === 'derelict') spread += 0.1;
  if (i.era === 'pre-1919') spread += 0.04;
  if (hasMajor) spread += 0.04;
  const confidence = spread <= 0.14 ? 'high' : spread <= 0.22 ? 'medium' : 'low';

  const tradeMap = new Map<Trade, number>();
  for (const l of lines) tradeMap.set(l.trade, (tradeMap.get(l.trade) ?? 0) + l.total);
  const byTrade = [...tradeMap.entries()].map(([trade, t]) => ({ trade, total: round(t) })).sort((a, b) => b.total - a.total);

  const programmeWeeks = Math.max(2, Math.round(measuredWorks / (i.spec === 'premium' ? 9_000 : 11_000) + (hasMajor ? 4 : 0)));

  const assumptions = [
    `Quantities derived from ${i.floorArea}m² GIA across ${i.storeys} storey(s); verify against measured survey.`,
    `Regional index ${REGIONS[region].label} ×${regionF.toFixed(2)} from postcode "${i.postcode.toUpperCase()}".`,
    `Preliminaries ${(prelimRate * 100).toFixed(0)}%, overheads & profit ${(ohpRate * 100).toFixed(0)}%, contingency ${(contRate * 100).toFixed(0)}%.`,
    'Works undertaken by a single main contractor under a JCT Minor Works / Homeowner contract.',
    'Property vacant during works; normal working hours; no out-of-hours premium.',
    s.heating === 'heat-pump' ? 'Heat pump cost shown before the £7,500 Boiler Upgrade Scheme grant (England & Wales, eligibility applies).' : 'Existing gas supply adequate for proposed heating.',
  ];
  const exclusions = [
    'Asbestos survey and removal (mandatory survey before refurbishment of pre-2000 buildings).',
    'Party Wall Act awards, planning and building control application fees (beyond allowance in fees).',
    'Furniture, white goods beyond kitchen allowance, window dressings.',
    'Utility upgrades (new supplies, meter relocation), drainage diversions, Japanese knotweed.',
    'Finance costs, holding costs, council tax & insurance during works — see Investment analysis.',
  ];
  const compliance = [
    'Electrical work notifiable under Part P — require EIC/Minor Works certificates from a registered electrician.',
    s.heating !== 'none' ? 'Gas/heating work must be by a Gas Safe registered engineer; heat pumps by MCS-certified installer for BUS grant.' : '',
    s.windows ? 'Replacement windows: FENSA/CERTASS certificate or Building Control notification (Part L, Part F trickle vents).' : '',
    s.structuralOpenings > 0 ? 'Structural alterations need structural engineer calcs and Building Control approval (Part A).' : '',
    s.loftArea > 0 ? 'Loft conversion: Building Regs (fire escape Part B, stairs Part K, insulation Part L); check permitted development / planning.' : '',
    s.extensionArea > 0 ? 'Extension: confirm permitted development limits or planning permission; Party Wall notices likely on terraced/semi.' : '',
    i.era !== '2000+' ? 'Pre-2000 building: refurbishment & demolition asbestos survey required before intrusive works (CAR 2012).' : '',
    'Principal Designer/Contractor duties under CDM 2015 apply (domestic client duties pass to contractor).',
  ].filter(Boolean);

  const labourAllowance = round(lines.reduce((t, l) => t + l.total * RATE_LIBRARY[l.code].labour, 0));
  return {
    lines, byTrade, labourAllowance, materialsAllowance: round(measuredWorks - labourAllowance),
    measuredWorks: round(measuredWorks), preliminaries: round(preliminaries), overheadsProfit: round(overheadsProfit),
    contingency: round(contingency), professionalFees: round(professionalFees), subtotalExVat: round(subtotalExVat),
    vat: round(vat), total: round(total, 100),
    low: round(total * (1 - spread * 0.7), 500), high: round(total * (1 + spread), 500),
    confidence, costPerM2: round(subtotalExVat / i.floorArea), programmeWeeks,
    factors: [
      { label: 'Region', value: `${REGIONS[region].label} ×${regionF.toFixed(2)}` },
      { label: 'Condition', value: `${i.condition} ×${condF.toFixed(2)}` },
      { label: 'Construction era', value: `${i.era} ×${eraF.toFixed(2)}` },
      { label: 'Site access', value: `${i.access} ×${accessF.toFixed(2)}` },
      { label: 'Specification', value: i.spec },
    ],
    assumptions, exclusions, compliance, basis: PRICING_BASIS, region,
  };
}

export function scenarios(i: RefurbInput) {
  return (['budget', 'standard', 'premium'] as Spec[]).map((spec) => ({ spec, estimate: estimateRefurb({ ...i, spec }) }));
}

/** Bill of quantities as CSV (NRM2-style columns, simplified). */
export function boqCsv(e: Estimate): string {
  const rows = [['Ref', 'Trade', 'Description', 'Qty', 'Unit', 'Rate (£)', 'Total (£)', 'Quantity basis']];
  e.lines.forEach((l, idx) => rows.push([`${idx + 1}`, l.trade, l.description, `${l.quantity}`, l.unit, `${l.rate}`, `${l.total}`, l.quantityBasis]));
  rows.push(['', '', 'Measured works', '', '', '', `${e.measuredWorks}`, '']);
  rows.push(['', '', 'Preliminaries', '', '', '', `${e.preliminaries}`, '']);
  rows.push(['', '', 'Overheads & profit', '', '', '', `${e.overheadsProfit}`, '']);
  rows.push(['', '', 'Contingency', '', '', '', `${e.contingency}`, '']);
  rows.push(['', '', 'Professional fees', '', '', '', `${e.professionalFees}`, '']);
  rows.push(['', '', 'VAT', '', '', '', `${e.vat}`, '']);
  rows.push(['', '', 'TOTAL', '', '', '', `${e.total}`, `Pricing basis ${e.basis.version} @ ${e.basis.basisDate}`]);
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}

export interface ContractorQuote { contractor: string; lines: Partial<Record<Trade, number>>; programmeWeeks: number; verified: boolean }

/** Compare quotes against the Streetkey benchmark trade-by-trade; flag outliers > ±25%. */
export function compareQuotes(e: Estimate, quotes: ContractorQuote[]) {
  return quotes.map((q) => {
    const rows = e.byTrade.map(({ trade, total }) => {
      const quoted = q.lines[trade];
      const variance = quoted == null ? null : (quoted - total) / total;
      return { trade, benchmark: total, quoted: quoted ?? null, variance, flag: variance == null ? 'missing' : variance > 0.25 ? 'high' : variance < -0.25 ? 'low' : 'ok' };
    });
    const quotedTotal = Object.values(q.lines).reduce((a: number, b) => a + (b ?? 0), 0);
    return { ...q, rows, quotedTotal, missing: rows.filter((r) => r.flag === 'missing').map((r) => r.trade) };
  });
}

export const DEFAULT_INPUT: RefurbInput = {
  postcode: 'E17 4QH', propertyType: 'terraced', floorArea: 92, bedrooms: 3, bathrooms: 1, storeys: 2,
  era: 'pre-1919', condition: 'poor', access: 'restricted', spec: 'standard',
  scope: { stripOut: true, rewire: true, heating: 'full', replaster: 'full', kitchen: true, windows: true, roof: 'repair', flooring: true, decoration: true, damp: true, external: true, structuralOpenings: 1, extensionArea: 0, loftArea: 0, insulation: true, solidWallInsulation: false, ensuites: 0 },
  vat: 'standard', includeProfessionalFees: true,
};

/** Hidden-defect risk register — what commonly emerges on opening up, by era/condition/type. */
export function hiddenDefectRisks(i: RefurbInput): { risk: string; likelihood: 'low' | 'medium' | 'high'; allowance: string }[] {
  const out: { risk: string; likelihood: 'low' | 'medium' | 'high'; allowance: string }[] = [];
  const old = i.era === 'pre-1919' || i.era === '1919-1944';
  if (i.era !== '2000+') out.push({ risk: 'Asbestos-containing materials (textured coatings, floor tiles, boxing)', likelihood: i.era === '1945-1979' ? 'high' : 'medium', allowance: '£1.5k–£8k removal after R&D survey' });
  if (old) out.push({ risk: 'Timber decay to joists / suspended floors', likelihood: i.condition === 'poor' || i.condition === 'derelict' ? 'high' : 'medium', allowance: '£2k–£10k' });
  if (old) out.push({ risk: 'Lead water supply pipe', likelihood: 'medium', allowance: '£1k–£3k (water company may share cost)' });
  if (old) out.push({ risk: 'Lintel / bay movement, failed wall ties', likelihood: i.condition === 'poor' ? 'medium' : 'low', allowance: '£1.5k–£6k' });
  out.push({ risk: 'Drainage defects (collapsed/root-infested runs)', likelihood: old ? 'medium' : 'low', allowance: '£1k–£5k — CCTV drain survey £250' });
  if (i.scope.rewire === false && i.era !== '2000+') out.push({ risk: 'Unsafe existing wiring found during works', likelihood: 'medium', allowance: '£2k–£6k' });
  if (i.propertyType === 'flat' || i.propertyType === 'commercial') out.push({ risk: 'Fire-stopping & compartmentation deficiencies', likelihood: 'medium', allowance: '£2k–£15k+' });
  if (i.scope.loftArea > 0) out.push({ risk: 'Roof structure needs strengthening beyond design', likelihood: 'medium', allowance: '£2k–£6k' });
  return out;
}
