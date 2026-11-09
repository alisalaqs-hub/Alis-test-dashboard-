/**
 * Input validation for the property AI endpoints. Everything a person sends is bounded here,
 * and engine inputs are rebuilt from these values (client-side figures are never trusted).
 * The numeric bounds and the postcode rule come from src/lib/ai/property.ts, which the website
 * also checks as people type, so a value the page accepts is never rejected here.
 */
import { z } from 'zod';
import {
  CONDITIONS, EPC_BANDS, ERAS, HOME_GOAL_IDS, HOME_LIMITS, INVEST_LIMITS, limitMessage, postcodeProblem, REFURB_LIMITS, type Limit,
} from '../../../../src/lib/ai/property';

/** A number within a shared limit, with the same friendly message the website shows. */
const num = (l: Limit) => {
  const msg = limitMessage(l);
  const base = z.number({ error: msg }).min(l.min, msg).max(l.max, msg);
  return l.whole ? base.int(msg) : base;
};

export const Postcode = z.string().trim().superRefine((s, ctx) => {
  const problem = postcodeProblem(s);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
export const PropertyTypeZ = z.enum(['terraced', 'semi-detached', 'detached', 'flat', 'bungalow', 'commercial']);
export const EraZ = z.enum(ERAS);
export const ConditionZ = z.enum(CONDITIONS);
const AccessZ = z.enum(['easy', 'restricted', 'difficult']);
const SpecZ = z.enum(['budget', 'standard', 'premium']);
const VatZ = z.enum(['standard', 'reduced-empty-2yrs', 'reduced-conversion', 'none']);
const FitOutZ = z.enum(['none', 'cat-a', 'cat-a+b']);

/** The refurb cost engine's input (RefurbInput), with sensible bounds. */
const R = REFURB_LIMITS;
export const RefurbInputZ = z.object({
  postcode: Postcode,
  propertyType: PropertyTypeZ,
  floorArea: num(R.floorArea),
  bedrooms: num(R.bedrooms),
  bathrooms: num(R.bathrooms),
  storeys: num(R.storeys),
  era: EraZ,
  condition: ConditionZ,
  access: AccessZ,
  spec: SpecZ,
  scope: z.object({
    stripOut: z.boolean(),
    rewire: z.boolean(),
    heating: z.enum(['none', 'boiler', 'full', 'heat-pump']),
    replaster: z.enum(['none', 'skim', 'full']),
    kitchen: z.boolean(),
    windows: z.boolean(),
    roof: z.enum(['none', 'repair', 'recover']),
    flooring: z.boolean(),
    decoration: z.boolean(),
    damp: z.boolean(),
    external: z.boolean(),
    structuralOpenings: num(R.structuralOpenings),
    extensionArea: num(R.extensionArea),
    loftArea: num(R.loftArea),
    insulation: z.boolean(),
    solidWallInsulation: z.boolean(),
    ensuites: num(R.ensuites),
    groundworksArea: num(R.groundworksArea).optional(),
    fitOut: FitOutZ.optional(),
    officeToResiArea: num(R.officeToResiArea).optional(),
  }),
  vat: VatZ,
  includeProfessionalFees: z.boolean(),
});

/** Property facts for "estimate from photos" (the scope comes from the photos; the person's condition, if given, is a floor for what nobody photographed). */
export const PhotoFactsZ = z.object({
  postcode: Postcode,
  propertyType: PropertyTypeZ,
  floorArea: num(R.floorArea),
  bedrooms: num(R.bedrooms),
  bathrooms: num(R.bathrooms),
  storeys: num(R.storeys).default(2),
  era: EraZ,
  condition: ConditionZ.optional(),
  access: AccessZ.default('easy'),
  spec: SpecZ.default('standard'),
  vat: VatZ.default('standard'),
  includeProfessionalFees: z.boolean().default(true),
  planned: z.object({
    structuralOpenings: num(R.structuralOpenings).default(0),
    extensionArea: num(R.extensionArea).default(0),
    loftArea: num(R.loftArea).default(0),
    ensuites: num(R.ensuites).default(0),
    solidWallInsulation: z.boolean().default(false),
    groundworksArea: num(R.groundworksArea).default(0),
    fitOut: FitOutZ.default('none'),
    officeToResiArea: num(R.officeToResiArea).default(0),
  }).default({ structuralOpenings: 0, extensionArea: 0, loftArea: 0, ensuites: 0, solidWallInsulation: false, groundworksArea: 0, fitOut: 'none', officeToResiArea: 0 }),
});
export type PhotoFactsIn = z.infer<typeof PhotoFactsZ>;

export const StrategyZ = z.enum(['btl', 'brrr', 'flip', 'hmo', 'commercial']);
/** The investment engine's input (InvestmentInput), with sensible bounds. */
const I = INVEST_LIMITS;
export const InvestmentInputZ = z.object({
  strategy: StrategyZ,
  price: num(I.price),
  nation: z.enum(['england', 'wales', 'scotland', 'northern-ireland']),
  buyer: z.enum(['first-time', 'home-mover', 'additional']),
  companyPurchase: z.boolean(),
  legalFees: num(I.legalFees),
  surveyFees: num(I.surveyFees),
  refurbCost: num(I.refurbCost),
  refurbMonths: num(I.refurbMonths),
  depositPct: num(I.depositPct),
  mortgageRate: num(I.mortgageRate),
  interestOnly: z.boolean(),
  termYears: num(I.termYears),
  lenderFeePct: num(I.lenderFeePct),
  bridgingRateMonthly: num(I.bridgingRateMonthly),
  monthlyRent: num(I.monthlyRent),
  voidPct: num(I.voidPct),
  managementPct: num(I.managementPct),
  maintenancePct: num(I.maintenancePct),
  insuranceAnnual: num(I.insuranceAnnual),
  serviceChargeAnnual: num(I.serviceChargeAnnual),
  hmoBillsMonthly: num(I.hmoBillsMonthly),
  licensingAnnual: num(I.licensingAnnual),
  gdv: num(I.gdv),
  refinanceLtv: num(I.refinanceLtv),
  sellingCostsPct: num(I.sellingCostsPct),
  holdingMonthly: num(I.holdingMonthly),
});

/**
 * A scenario that can be rated: a letting strategy needs some rent and a flip needs a sale value,
 * otherwise the ratios divide by zero (the website shows "Enter the rent" instead of a rating).
 */
export const InvestExplainZ = z.object({
  propertyId: z.string().trim().regex(/^[A-Za-z0-9-]{2,60}$/).optional(),
  strategy: StrategyZ,
  inputs: InvestmentInputZ,
  scenario: z.enum(['downside', 'base', 'optimistic']).default('base'),
}).superRefine((b, ctx) => {
  if (b.strategy === 'flip' && !(b.inputs.gdv > 0)) ctx.addIssue({ code: 'custom', path: ['inputs', 'gdv'], message: 'Enter the post-works value (GDV).' });
  if (b.strategy !== 'flip' && !(b.inputs.monthlyRent > 0)) ctx.addIssue({ code: 'custom', path: ['inputs', 'monthlyRent'], message: 'Enter the rent.' });
});

export const RefurbExplainZ = z.object({ input: RefurbInputZ });

export const HomeFactsZ = z.object({
  postcode: Postcode,
  type: z.enum(['terraced', 'semi-detached', 'detached', 'flat', 'bungalow']),
  beds: num(HOME_LIMITS.beds),
  area: num(HOME_LIMITS.area),
  era: EraZ,
  condition: ConditionZ,
  epc: z.enum(EPC_BANDS),
});
export const HomePlanZ = z.object({
  home: HomeFactsZ,
  goals: z.array(z.enum(HOME_GOAL_IDS)).min(1, 'Choose at least one goal.').max(5).transform((g) => [...new Set(g)]),
  budget: num(HOME_LIMITS.budget).nullable().optional(),
});
