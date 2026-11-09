/**
 * Input validation for the property AI endpoints. Everything a person sends is bounded here,
 * and engine inputs are rebuilt from these values (client-side figures are never trusted).
 */
import { z } from 'zod';
import { CONDITIONS, EPC_BANDS, ERAS, HOME_GOAL_IDS } from '../../../../src/lib/ai/property';

const money = (max: number) => z.number().min(0).max(max);
const ratio = (max = 1) => z.number().min(0).max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const Postcode = z.string().trim().min(2, 'Enter a postcode.').max(10).regex(/^[A-Za-z0-9 ]+$/, 'Enter a UK postcode, e.g. E17 4QH.');
export const PropertyTypeZ = z.enum(['terraced', 'semi-detached', 'detached', 'flat', 'bungalow', 'commercial']);
export const EraZ = z.enum(ERAS);
export const ConditionZ = z.enum(CONDITIONS);
const AccessZ = z.enum(['easy', 'restricted', 'difficult']);
const SpecZ = z.enum(['budget', 'standard', 'premium']);
const VatZ = z.enum(['standard', 'reduced-empty-2yrs', 'reduced-conversion', 'none']);
const FitOutZ = z.enum(['none', 'cat-a', 'cat-a+b']);

/** The refurb cost engine's input (RefurbInput), with sensible bounds. */
export const RefurbInputZ = z.object({
  postcode: Postcode,
  propertyType: PropertyTypeZ,
  floorArea: z.number().min(15).max(20_000),
  bedrooms: int(0, 30),
  bathrooms: int(0, 20),
  storeys: int(1, 10),
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
    structuralOpenings: int(0, 20),
    extensionArea: z.number().min(0).max(500),
    loftArea: z.number().min(0).max(200),
    insulation: z.boolean(),
    solidWallInsulation: z.boolean(),
    ensuites: int(0, 10),
    groundworksArea: z.number().min(0).max(5_000).optional(),
    fitOut: FitOutZ.optional(),
    officeToResiArea: z.number().min(0).max(20_000).optional(),
  }),
  vat: VatZ,
  includeProfessionalFees: z.boolean(),
});

/** Property facts for "estimate from photos" (the scope and condition come from the photos). */
export const PhotoFactsZ = z.object({
  postcode: Postcode,
  propertyType: PropertyTypeZ,
  floorArea: z.number().min(15).max(20_000),
  bedrooms: int(0, 30),
  bathrooms: int(0, 20),
  storeys: int(1, 10).default(2),
  era: EraZ,
  access: AccessZ.default('easy'),
  spec: SpecZ.default('standard'),
  vat: VatZ.default('standard'),
  includeProfessionalFees: z.boolean().default(true),
  planned: z.object({
    structuralOpenings: int(0, 20).default(0),
    extensionArea: z.number().min(0).max(500).default(0),
    loftArea: z.number().min(0).max(200).default(0),
    ensuites: int(0, 10).default(0),
    solidWallInsulation: z.boolean().default(false),
    groundworksArea: z.number().min(0).max(5_000).default(0),
    fitOut: FitOutZ.default('none'),
    officeToResiArea: z.number().min(0).max(20_000).default(0),
  }).default({ structuralOpenings: 0, extensionArea: 0, loftArea: 0, ensuites: 0, solidWallInsulation: false, groundworksArea: 0, fitOut: 'none', officeToResiArea: 0 }),
});
export type PhotoFactsIn = z.infer<typeof PhotoFactsZ>;

export const StrategyZ = z.enum(['btl', 'brrr', 'flip', 'hmo', 'commercial']);
/** The investment engine's input (InvestmentInput), with sensible bounds. */
export const InvestmentInputZ = z.object({
  strategy: StrategyZ,
  price: z.number().min(1_000).max(100_000_000),
  nation: z.enum(['england', 'wales', 'scotland', 'northern-ireland']),
  buyer: z.enum(['first-time', 'home-mover', 'additional']),
  companyPurchase: z.boolean(),
  legalFees: money(1_000_000),
  surveyFees: money(1_000_000),
  refurbCost: money(50_000_000),
  refurbMonths: z.number().min(0).max(60),
  depositPct: ratio(),
  mortgageRate: ratio(0.3),
  interestOnly: z.boolean(),
  termYears: z.number().min(1).max(40),
  lenderFeePct: ratio(0.2),
  bridgingRateMonthly: ratio(0.1),
  monthlyRent: money(2_000_000),
  voidPct: ratio(),
  managementPct: ratio(),
  maintenancePct: ratio(),
  insuranceAnnual: money(1_000_000),
  serviceChargeAnnual: money(1_000_000),
  hmoBillsMonthly: money(200_000),
  licensingAnnual: money(200_000),
  gdv: money(200_000_000),
  refinanceLtv: ratio(),
  sellingCostsPct: ratio(0.5),
  holdingMonthly: money(500_000),
});

export const InvestExplainZ = z.object({
  propertyId: z.string().trim().regex(/^[A-Za-z0-9-]{2,60}$/).optional(),
  strategy: StrategyZ,
  inputs: InvestmentInputZ,
  scenario: z.enum(['downside', 'base', 'optimistic']).default('base'),
});

export const RefurbExplainZ = z.object({ input: RefurbInputZ });

export const HomeFactsZ = z.object({
  postcode: Postcode,
  type: z.enum(['terraced', 'semi-detached', 'detached', 'flat', 'bungalow']),
  beds: int(0, 12),
  area: z.number().min(20).max(2_000),
  era: EraZ,
  condition: ConditionZ,
  epc: z.enum(EPC_BANDS),
});
export const HomePlanZ = z.object({
  home: HomeFactsZ,
  goals: z.array(z.enum(HOME_GOAL_IDS)).min(1, 'Choose at least one goal.').max(5).transform((g) => [...new Set(g)]),
  budget: z.number().min(500).max(10_000_000).nullable().optional(),
});
