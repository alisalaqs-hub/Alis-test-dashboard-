/**
 * Deterministic investment calculators. No AI here: the AI layer may
 * *suggest* inputs (e.g. a rent estimate) but every number shown to users
 * is produced by these pure functions so it is reproducible and auditable.
 */
import { nonResidentialTax, transactionTax, type BuyerType, type Nation } from './tax';
export type { BuyerType, Nation };

export type Strategy = 'btl' | 'brrr' | 'flip' | 'hmo' | 'commercial';

export interface InvestmentInput {
  strategy: Strategy;
  price: number;
  nation: Nation;
  buyer: BuyerType;
  companyPurchase: boolean;
  legalFees: number;
  surveyFees: number;
  refurbCost: number;
  refurbMonths: number;
  // Finance
  depositPct: number;        // of purchase price
  mortgageRate: number;      // annual, e.g. 0.055
  interestOnly: boolean;
  termYears: number;
  lenderFeePct: number;
  bridgingRateMonthly: number; // used for BRRR & flip during works
  // Income
  monthlyRent: number;       // whole property (BTL/BRRR) or total of rooms (HMO)
  voidPct: number;
  managementPct: number;
  maintenancePct: number;
  insuranceAnnual: number;
  serviceChargeAnnual: number;
  hmoBillsMonthly: number;   // utilities/council tax/broadband borne by landlord in HMO
  licensingAnnual: number;
  // Exit / refinance
  gdv: number;               // post-works value
  refinanceLtv: number;
  sellingCostsPct: number;
  holdingMonthly: number;    // council tax/utilities/insurance while empty
}

export interface InvestmentResult {
  acquisition: { price: number; tax: number; taxName: string; fees: number; total: number };
  cashInvested: number;
  loan: number;
  annualRent: number;
  annualCosts: number;
  annualFinance: number;
  monthlyCashflow: number;
  grossYield: number;
  netYield: number;           // NOI / total cost
  cashOnCash: number;
  // BRRR
  refinanceLoan: number;
  moneyLeftIn: number;
  // Flip
  flipProfit: number;
  profitOnCost: number;
  annualisedRoi: number;
  // Lender stress (BTL ICR)
  icr: number;
  icrPass: boolean;
  icrRequired: number;
  stressRate: number;
  maxLoanByIcr: number;
  breakdown: { label: string; value: number }[];
  warnings: string[];
}

const pmt = (rate: number, n: number, pv: number) => (rate === 0 ? pv / n : (pv * rate) / (1 - Math.pow(1 + rate, -n)));

export function analyse(i: InvestmentInput): InvestmentResult {
  const warnings: string[] = [];
  const taxRes = i.strategy === 'commercial' ? nonResidentialTax(i.price, i.nation) : transactionTax(i.price, i.nation, i.companyPurchase ? 'additional' : i.buyer);
  if (i.companyPurchase && i.nation !== 'scotland' && i.price > 500_000) warnings.push('Company purchases over £500k may attract the 17% SDLT flat rate unless a relief (e.g. property rental business) applies.');

  const fees = i.legalFees + i.surveyFees;
  const acquisitionTotal = i.price + taxRes.total + fees;

  const isBridged = i.strategy === 'brrr' || i.strategy === 'flip';
  const loan = i.price * (1 - i.depositPct);
  const lenderFee = loan * i.lenderFeePct;
  const worksFinance = isBridged ? loan * i.bridgingRateMonthly * (i.refurbMonths + (i.strategy === 'flip' ? 3 : 1)) : 0; // + sale/refi period
  const holding = i.holdingMonthly * (i.refurbMonths + (i.strategy === 'flip' ? 3 : 0));
  const cashBeforeRefi = acquisitionTotal - loan + i.refurbCost + lenderFee + worksFinance + holding;

  // Income & costs (stabilised year)
  const annualRent = i.monthlyRent * 12;
  const effectiveRent = annualRent * (1 - i.voidPct);
  const annualCosts =
    effectiveRent * (i.managementPct + i.maintenancePct) + i.insuranceAnnual + i.serviceChargeAnnual +
    (i.strategy === 'hmo' ? i.hmoBillsMonthly * 12 + i.licensingAnnual : i.licensingAnnual);
  const noi = effectiveRent - annualCosts;

  // Long-term finance
  let refinanceLoan = 0;
  let ltLoan = loan;
  if (i.strategy === 'brrr') {
    refinanceLoan = i.gdv * i.refinanceLtv;
    ltLoan = refinanceLoan;
    if (refinanceLoan < loan) warnings.push('Refinance loan is below the bridging loan — you would need to inject cash to redeem the bridge.');
    warnings.push('Most lenders require 6 months of ownership before refinancing at the new valuation; check product criteria.');
  }
  const annualFinance = i.strategy === 'flip' ? 0
    : i.interestOnly ? ltLoan * i.mortgageRate
    : pmt(i.mortgageRate / 12, i.termYears * 12, ltLoan) * 12;

  const cashflowAnnual = i.strategy === 'flip' ? 0 : noi - annualFinance;
  const moneyLeftIn = i.strategy === 'brrr' ? cashBeforeRefi - (refinanceLoan - loan) - refinanceLoan * i.lenderFeePct : cashBeforeRefi;
  const cashInvested = Math.max(0, moneyLeftIn);

  // Flip
  const saleCosts = i.gdv * i.sellingCostsPct;
  const flipProfit = i.gdv - saleCosts - loan - cashBeforeRefi;
  const totalCost = acquisitionTotal + i.refurbCost + lenderFee + worksFinance + holding + saleCosts;
  const profitOnCost = totalCost ? flipProfit / totalCost : 0;
  const months = i.refurbMonths + 3;
  const annualisedRoi = cashBeforeRefi > 0 ? Math.pow(1 + flipProfit / cashBeforeRefi, 12 / months) - 1 : 0;

  // Lender ICR stress test (typical PRA-style underwriting for BTL)
  const stressRate = Math.max(0.055, i.mortgageRate + 0.02);
  const icrRequired = i.companyPurchase ? 1.25 : 1.45; // basic-rate/Ltd 125%, higher-rate taxpayer 145%
  const stressedInterest = ltLoan * stressRate;
  const icr = stressedInterest ? annualRent / stressedInterest : Infinity;
  const maxLoanByIcr = annualRent / (icrRequired * stressRate);
  if (i.strategy === 'commercial') warnings.push('Commercial lenders underwrite on tenant covenant, lease length (WAULT) and debt-service cover; residential ICR shown for reference only.');
  if (i.strategy !== 'flip' && i.strategy !== 'commercial' && icr < icrRequired) warnings.push(`Fails a typical lender stress test: ICR ${(icr * 100).toFixed(0)}% vs ${(icrRequired * 100).toFixed(0)}% at ${(stressRate * 100).toFixed(1)}%. Max loan ≈ £${Math.round(maxLoanByIcr).toLocaleString('en-GB')}.`);
  if (i.strategy === 'hmo') warnings.push('HMOs with 5+ occupiers need a mandatory licence; check Article 4 directions and additional/selective licensing for the local authority.');
  if (!i.companyPurchase && i.strategy !== 'flip' && i.strategy !== 'commercial') warnings.push('Individual landlords: mortgage interest is relieved only as a 20% tax credit (Section 24). Cash flow shown is pre-tax.');

  const allIn = acquisitionTotal + i.refurbCost;
  return {
    acquisition: { price: i.price, tax: taxRes.total, taxName: taxRes.tax, fees, total: acquisitionTotal },
    cashInvested, loan, annualRent, annualCosts, annualFinance,
    monthlyCashflow: cashflowAnnual / 12,
    grossYield: annualRent / (i.strategy === 'btl' ? i.price : allIn),
    netYield: noi / allIn,
    cashOnCash: cashInvested > 0 ? cashflowAnnual / cashInvested : cashflowAnnual > 0 ? Infinity : 0,
    refinanceLoan, moneyLeftIn,
    flipProfit, profitOnCost, annualisedRoi,
    icr, icrPass: icr >= icrRequired, icrRequired, stressRate, maxLoanByIcr,
    breakdown: [
      { label: 'Deposit', value: i.price - loan },
      { label: taxRes.tax, value: taxRes.total },
      { label: 'Legal & survey', value: fees },
      { label: 'Refurbishment', value: i.refurbCost },
      { label: 'Lender fees', value: lenderFee },
      { label: 'Bridging interest', value: worksFinance },
      { label: 'Holding costs', value: holding },
    ].filter((b) => b.value > 0),
    warnings,
  };
}

export type ScenarioName = 'downside' | 'base' | 'optimistic';
export const SCENARIO_SHIFTS: Record<ScenarioName, { rent: number; gdv: number; refurb: number; rate: number; voids: number }> = {
  downside: { rent: -0.08, gdv: -0.07, refurb: 0.15, rate: 0.01, voids: 0.04 },
  base: { rent: 0, gdv: 0, refurb: 0, rate: 0, voids: 0 },
  optimistic: { rent: 0.05, gdv: 0.04, refurb: -0.05, rate: -0.005, voids: -0.02 },
};

export function scenario(i: InvestmentInput, s: ScenarioName): InvestmentInput {
  const d = SCENARIO_SHIFTS[s];
  return {
    ...i,
    monthlyRent: i.monthlyRent * (1 + d.rent),
    gdv: i.gdv * (1 + d.gdv),
    refurbCost: i.refurbCost * (1 + d.refurb),
    mortgageRate: Math.max(0, i.mortgageRate + d.rate),
    voidPct: Math.max(0, i.voidPct + d.voids),
  };
}

/** Two-way sensitivity grid: rows = interest rate shifts, cols = rent shifts → monthly cash flow (or flip profit). */
export function sensitivity(i: InvestmentInput) {
  const rateShifts = [-0.01, -0.005, 0, 0.005, 0.01, 0.015];
  const colShifts = [-0.1, -0.05, 0, 0.05, 0.1];
  const metric = (r: InvestmentResult) => (i.strategy === 'flip' ? r.flipProfit : r.monthlyCashflow);
  return {
    rowLabel: i.strategy === 'flip' ? 'Refurb overrun' : 'Interest rate',
    colLabel: i.strategy === 'flip' ? 'Sale price (GDV)' : 'Rent',
    rows: rateShifts.map((dr, ri) => ({
      shift: i.strategy === 'flip' ? [-0.1, -0.05, 0, 0.1, 0.2, 0.3][ri] : dr,
      cells: colShifts.map((dc) => {
        const adj = i.strategy === 'flip'
          ? { ...i, refurbCost: i.refurbCost * (1 + [-0.1, -0.05, 0, 0.1, 0.2, 0.3][ri]), gdv: i.gdv * (1 + dc) }
          : { ...i, mortgageRate: Math.max(0, i.mortgageRate + dr), monthlyRent: i.monthlyRent * (1 + dc) };
        return metric(analyse(adj));
      }),
    })),
    cols: colShifts,
  };
}

export const DEFAULT_INVESTMENT: InvestmentInput = {
  strategy: 'brrr', price: 435_000, nation: 'england', buyer: 'additional', companyPurchase: false,
  legalFees: 1_950, surveyFees: 750, refurbCost: 68_000, refurbMonths: 4,
  depositPct: 0.25, mortgageRate: 0.0499, interestOnly: true, termYears: 25, lenderFeePct: 0.02, bridgingRateMonthly: 0.0085,
  monthlyRent: 2_450, voidPct: 0.04, managementPct: 0.1, maintenancePct: 0.06, insuranceAnnual: 520, serviceChargeAnnual: 0, hmoBillsMonthly: 0, licensingAnnual: 0,
  gdv: 575_000, refinanceLtv: 0.75, sellingCostsPct: 0.02, holdingMonthly: 320,
};

/** Break-even points for the stabilised position (deterministic). */
export function breakEven(i: InvestmentInput) {
  const r = analyse(i);
  const fixed = i.insuranceAnnual + i.serviceChargeAnnual + (i.strategy === 'hmo' ? i.hmoBillsMonthly * 12 : 0) + i.licensingAnnual;
  const variableShare = (1 - i.voidPct) * (1 - i.managementPct - i.maintenancePct);
  // rent R/month such that 12R·variableShare − fixed − finance = 0
  const rent = (fixed + r.annualFinance) / (12 * Math.max(0.01, variableShare));
  // occupancy such that 12·rent·occ·(1−mgmt−maint) − fixed − finance = 0
  const occ = (fixed + r.annualFinance) / (12 * i.monthlyRent * Math.max(0.01, 1 - i.managementPct - i.maintenancePct));
  // interest rate (interest-only) at which cash flow = 0
  const noi = r.annualRent * (1 - i.voidPct) - r.annualCosts;
  const loan = i.strategy === 'brrr' ? r.refinanceLoan : r.loan;
  const rate = loan > 0 ? noi / loan : Infinity;
  // flip: sale price at which profit = 0
  const salePrice = i.gdv - r.flipProfit / (1 - i.sellingCostsPct);
  return { rent, occupancy: occ, rate, salePrice };
}
