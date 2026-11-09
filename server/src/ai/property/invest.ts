/**
 * AI verdict on an investment scenario. The numbers are recomputed here with Streetkey's investment
 * engine (client figures are never trusted); the model reads them, and its verdict can be more
 * cautious than Streetkey's rule-based rating but never more optimistic. A more cautious verdict has
 * to say why (cautionReason); without a reason it may only be one step more cautious.
 *
 * For live listings only what the lister actually supplied is sent as a fact: the registry's
 * placeholders (flood and subsidence "low", not listed, "fair" condition, demo-evidence rent and
 * value estimates) are sent as "not assessed" / "not stated" so the model never presents them as facts.
 */
import type { InvestNumbers, InvestVerdictResult, Verdict } from '../../../../src/lib/ai/property';
import { investFacts, money, STRATEGY_LABEL, VERDICTS } from '../../../../src/lib/ai/property';
import type { Property } from '../../../../src/data/properties';
import { SCENARIO_SHIFTS, sensitivity, type InvestmentInput, type ScenarioName, type Strategy } from '../../../../src/engine/investment';
import { one } from '../../db';
import { findHome, isDemo } from '../assistant/tools';
import { cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { ensureLiveRegistry } from '../registry';
import { S, type Infer } from '../schema';
import { figuresInText, finite, hashOf, percentsIn, round, scrubList, scrubText, type AiMeta } from './figures';

const Out = S.obj({
  verdict: S.enum(VERDICTS),
  headline: S.str('One sentence, under 25 words'),
  strengths: S.arr(S.str()),
  risks: S.arr(S.str()),
  whatMustBeTrue: S.arr(S.str()),
  questionsToAsk: S.arr(S.str()),
  stressTestReading: S.str('2 sentences on what the stress test and sensitivity grid show'),
  cautionReason: S.nullable(S.str('Only when your verdict is more cautious than RULE_RATING: one sentence on why, from the DATA. Otherwise null.')),
});
type OutT = Infer<typeof Out>;

const SYSTEM = [
  HOUSE_RULES,
  'You review a UK property investment scenario whose figures were computed by Streetkey’s deterministic calculators. Explain what the numbers show; do not recommend buying or not buying, and do not call it a good or bad investment for the person.',
  'verdict: strong, workable, marginal or weak. Start from RULE_RATING. You may choose a more cautious verdict when the property facts or warnings justify it, never a more optimistic one. If you do, cautionReason must say why in one sentence that points to the DATA; otherwise cautionReason is null.',
  'Fields marked "not assessed" or "not stated" are unknown: do not describe them, and never say a risk is low or absent unless the DATA says so.',
  'Use only figures in the DATA, as given (you may round to the nearest £10, £100 or £1,000, and quote percentages as given). Never add, subtract or combine figures, and never introduce other prices, rents, values, rates or taxes.',
  'strengths and risks: up to 4 each. whatMustBeTrue: up to 4 assumptions the result depends on (rent achieved, refurb cost, refinance value, interest rates). questionsToAsk: up to 4 questions for an agent, lender, surveyor or solicitor. stressTestReading: what the lender stress test and the sensitivity grid show.',
  'Each list item is one sentence. Mention tax only as the data does (cash flow is pre-tax). No headings, no markdown.',
  'Do not make claims about local demand, the area, the market or future prices or rents unless they are in the DATA, and never about the people who live there.',
].join('\n');

const order = (v: Verdict) => VERDICTS.indexOf(v);
const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'not meaningful');

const NOT_ASSESSED = 'not assessed';
const NOT_STATED = 'not stated';

/** What the lister of a live listing actually supplied (the registry fills the gaps with placeholders). */
export interface ListerFacts { conditionGiven: boolean; epcGiven: boolean; daysOnMarket: number | null }
const NOTHING_SUPPLIED: ListerFacts = { conditionGiven: false, epcGiven: false, daysOnMarket: null };

async function listerFacts(ref: string): Promise<ListerFacts> {
  const r = await one<{ condition: string | null; epc: string | null; published_at: Date | null }>(
    `SELECT condition, epc, published_at FROM listings WHERE ref = $1 AND status IN ('live', 'under_offer')`, [ref],
  ).catch(() => null);
  if (!r) return NOTHING_SUPPLIED;
  const at = r.published_at ? new Date(r.published_at) : null;
  return { conditionGiven: !!r.condition, epcGiven: !!r.epc, daysOnMarket: at ? Math.max(0, Math.floor((Date.now() - at.getTime()) / 86_400_000)) : null };
}

/**
 * The listing facts the model may use. Demo listings are Streetkey's own illustrative data; for live
 * listings, only what the lister supplied (text wrapped as data), with everything else marked unknown.
 */
export function propertyFacts(p: Property, lister: ListerFacts | null) {
  if (isDemo(p) || !lister) {
    return {
      source: 'Streetkey demonstration listing (illustrative figures)',
      type: p.type, beds: p.beds, town: p.town, tenure: p.tenure, leaseYearsRemaining: p.leaseYears ?? null, epc: p.epc.current, condition: p.condition,
      daysOnMarket: p.daysOnMarket, risks: { flood: p.risks.flood, subsidence: p.risks.subsidence, listed: p.risks.listed, conservationArea: p.risks.conservationArea, article4: p.risks.article4 },
      listingModelEstimates: { rentPcm: p.estRentPcm, postWorksValue: p.estGdv },
    };
  }
  return {
    source: 'Live listing on Streetkey; details supplied by the lister',
    type: p.type, beds: p.beds, town: untrusted('listing town', p.town, 60), tenure: p.tenure, leaseYearsRemaining: p.leaseYears ?? null,
    epc: lister.epcGiven ? p.epc.current : NOT_STATED, condition: lister.conditionGiven ? p.condition : NOT_STATED,
    daysOnMarket: lister.daysOnMarket ?? NOT_STATED,
    risks: NOT_ASSESSED, // flood, subsidence, listing, conservation area and Article 4 haven't been checked for live listings
  };
}

export function investPack(inputs: InvestmentInput, s: ScenarioName, property: Property | null) {
  const { active, result: r, all, be, rule } = investFacts(inputs, s);
  const flip = inputs.strategy === 'flip';
  const sens = sensitivity(active);
  const cells = sens.rows.flatMap((row) => row.cells.map((v, k) => ({ row: row.shift, col: sens.cols[k], v })));
  const worst = cells.reduce((a, b) => (b.v < a.v ? b : a));
  const best = cells.reduce((a, b) => (b.v > a.v ? b : a));
  const negativeCells = cells.filter((c) => c.v < 0).length;
  const metric = (x: typeof r) => (flip ? { profit: round(x.flipProfit), profitOnCost: pct(x.profitOnCost) } : { monthlyCashflow: round(x.monthlyCashflow), netYield: pct(x.netYield), cashLeftIn: round(x.cashInvested), icr: pct(x.icr) });
  const pack = {
    strategy: STRATEGY_LABEL[inputs.strategy], scenario: s, scenarioShifts: SCENARIO_SHIFTS[s],
    RULE_RATING: rule.verdict, ruleReasons: rule.reasons,
    assumptions: {
      price: inputs.price, nation: inputs.nation, buyer: inputs.buyer, company: inputs.companyPurchase, refurbCost: round(active.refurbCost), refurbMonths: inputs.refurbMonths,
      depositPct: pct(inputs.depositPct), mortgageRate: pct(active.mortgageRate), interestOnly: inputs.interestOnly, rentPcm: round(active.monthlyRent), voids: pct(active.voidPct),
      managementPct: pct(inputs.managementPct), postWorksValue: round(active.gdv), refinanceLtv: pct(inputs.refinanceLtv),
    },
    results: {
      transactionTax: { name: r.acquisition.taxName, amount: round(r.acquisition.tax) }, acquisitionTotal: round(r.acquisition.total), loan: round(r.loan),
      cashInvested: round(r.cashInvested), annualRent: round(r.annualRent), annualRunningCosts: round(r.annualCosts), annualFinance: round(r.annualFinance),
      monthlyCashflow: round(r.monthlyCashflow), annualCashflow: round(r.monthlyCashflow * 12), grossYield: pct(r.grossYield), netYield: pct(r.netYield), cashOnCash: pct(r.cashOnCash),
      ...(inputs.strategy === 'brrr' ? { refinanceLoan: round(r.refinanceLoan), moneyLeftIn: round(r.moneyLeftIn) } : {}),
      ...(flip ? { flipProfit: round(r.flipProfit), profitOnCost: pct(r.profitOnCost), annualisedRoi: pct(r.annualisedRoi) } : {}),
      lenderStressTest: flip ? null : { icr: pct(r.icr), required: pct(r.icrRequired), stressRate: pct(r.stressRate), pass: r.icrPass, maxLoanByIcr: round(r.maxLoanByIcr) },
      breakEven: flip ? { salePrice: round(be.salePrice) } : { rentPcm: round(be.rent), occupancy: pct(be.occupancy), interestRate: pct(be.rate) },
    },
    scenarios: { downside: metric(all.downside), base: metric(all.base), optimistic: metric(all.optimistic) },
    sensitivity: {
      metric: flip ? 'profit' : 'monthly cash flow', rows: sens.rowLabel, cols: sens.colLabel,
      worst: { rowShift: pct(worst.row), colShift: pct(worst.col), value: round(worst.v) }, best: { rowShift: pct(best.row), colShift: pct(best.col), value: round(best.v) },
      cellsBelowZero: `${negativeCells} of ${cells.length}`,
    },
    warnings: r.warnings,
  };
  const results = [r, ...Object.values(all)];
  // Percentages the model may quote (in percent): every percentage in the DATA, the scenario shifts and the sensitivity grid's shifts.
  const fractions = [
    ...Object.values(SCENARIO_SHIFTS).flatMap((sh) => Object.values(sh)),
    ...sens.rows.map((row) => row.shift), ...sens.cols,
  ];
  const allowedPct = [...percentsIn(pack), ...fractions.map((f) => f * 100)].filter((n) => Number.isFinite(n));
  const allowed = [
    inputs.price, inputs.legalFees, inputs.surveyFees, inputs.refurbCost, active.refurbCost, inputs.monthlyRent, active.monthlyRent, inputs.gdv, active.gdv,
    inputs.insuranceAnnual, inputs.serviceChargeAnnual, inputs.hmoBillsMonthly, inputs.licensingAnnual, inputs.holdingMonthly,
    ...results.flatMap((x) => [x.acquisition.tax, x.acquisition.total, x.acquisition.fees, x.loan, x.cashInvested, x.annualRent, x.annualCosts, x.annualFinance, x.monthlyCashflow, x.monthlyCashflow * 12,
      x.refinanceLoan, x.moneyLeftIn, x.flipProfit, x.maxLoanByIcr, ...x.breakdown.map((b) => b.value)]),
    be.rent, be.salePrice, worst.v, best.v,
    ...(property ? [property.price, property.serviceChargeAnnual ?? 0, property.groundRentAnnual ?? 0] : []),
    ...(property && isDemo(property) ? [property.estRentPcm, property.estGdv] : []),
    ...figuresInText([...r.warnings, ...rule.reasons]),
  ].filter((n) => Number.isFinite(n));
  const numbers: InvestNumbers = {
    monthlyCashflow: round(r.monthlyCashflow), cashInvested: round(r.cashInvested), grossYield: r.grossYield, netYield: r.netYield, cashOnCash: finite(r.cashOnCash),
    icr: finite(r.icr), icrPass: r.icrPass, icrRequired: r.icrRequired, stressRate: r.stressRate, flipProfit: round(r.flipProfit), profitOnCost: r.profitOnCost,
    transactionTax: round(r.acquisition.tax), taxName: r.acquisition.taxName, downsideMonthlyCashflow: round(all.downside.monthlyCashflow), downsideFlipProfit: round(all.downside.flipProfit),
    breakEvenRent: flip ? null : finite(round(be.rent)), breakEvenSalePrice: flip ? finite(round(be.salePrice)) : null,
  };
  return { pack, allowed, allowedPct, rule, numbers, r, active };
}

/**
 * What the result depends on, written by Streetkey from the assumptions (used when the AI's answer was
 * more optimistic than the numbers support, so its own list isn't trusted).
 */
export function ruleAssumptions(inputs: InvestmentInput, active: InvestmentInput): string[] {
  const flip = inputs.strategy === 'flip';
  const works = active.refurbCost > 0 ? `The works cost no more than ${money(active.refurbCost)}${flip || inputs.strategy === 'brrr' ? ` and take about ${inputs.refurbMonths} month${inputs.refurbMonths === 1 ? '' : 's'}` : ''}.` : null;
  if (flip) return [`The home sells for about ${money(active.gdv)} once the works are done.`, works].filter((x): x is string => !!x);
  return [
    `Rent of ${money(active.monthlyRent)} a month is achieved${active.voidPct > 0 ? `, with voids of ${pct(active.voidPct)}` : ''}.`,
    `The mortgage rate is about ${pct(active.mortgageRate)}.`,
    works,
    inputs.strategy === 'brrr' ? `A lender values the home at about ${money(active.gdv)} after the works, for the refinance.` : null,
  ].filter((x): x is string => !!x);
}

/** One step down the scale (e.g. strong → workable). */
const oneStepBelow = (v: Verdict): Verdict => VERDICTS[Math.max(0, order(v) - 1)];

/** `meta.charge` runs only when the AI is actually called (not for a cached answer). */
export async function investVerdict(body: { propertyId?: string; strategy: Strategy; inputs: InvestmentInput; scenario: ScenarioName }, meta: AiMeta): Promise<InvestVerdictResult> {
  const inputs: InvestmentInput = { ...body.inputs, strategy: body.strategy };
  let property: Property | null = null;
  let lister: ListerFacts | null = null;
  if (body.propertyId) {
    await ensureLiveRegistry().catch(() => {});
    // Public homes only: never a private, pending or withdrawn listing.
    property = findHome(body.propertyId);
    if (property && !isDemo(property)) lister = await listerFacts(property.id);
  }
  const { pack, allowed, allowedPct, rule, numbers, r, active } = investPack(inputs, body.scenario, property);
  const facts = property ? { property: propertyFacts(property, lister) } : {};
  return cached(`prop:invest:v3:${hashOf([pack, facts, property?.title ?? null])}`, 86_400, async () => {
    await meta.charge?.();
    const out = await chatJSON<OutT>([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [
        `DATA (computed by Streetkey’s investment engine; amounts in £, cash flow pre-tax):\n${JSON.stringify({ ...pack, ...facts })}`,
        property ? `Listing title (from the listing, may be marketing language):\n${untrusted('listing title', property.title, 200)}` : 'No specific property was selected: these are the person’s own assumptions.',
      ].join('\n\n') },
    ], Out, 'investment_verdict', { purpose: 'property.invest_explain', userId: meta.userId, role: 'main', maxTokens: 2000, effort: 'low' });

    const capped = order(out.verdict) > order(rule.verdict);
    // Every £ amount and every percentage must be one Streetkey computed.
    const caution = order(out.verdict) < order(rule.verdict) && out.cautionReason ? scrubText(out.cautionReason, allowed, 300, allowedPct) : null;
    const cautionReason = caution?.text || null;
    // A more cautious verdict needs a reason; without one (or if the reason quoted made-up figures) it may only be one step down.
    const verdict = capped ? rule.verdict : order(out.verdict) < order(rule.verdict) - 1 && !cautionReason ? oneStepBelow(rule.verdict) : out.verdict;
    const headline = scrubText(out.headline, allowed, 220, allowedPct);
    const reading = scrubText(out.stressTestReading, allowed, 500, allowedPct);
    const [strengths, risks, mustBeTrue, questions] = (['strengths', 'risks', 'whatMustBeTrue', 'questionsToAsk'] as const).map((k) => scrubList(out[k], allowed, { max: 5, pct: allowedPct }));
    const flip = inputs.strategy === 'flip';
    const fallbackHeadline = flip
      ? `Profit of ${money(r.flipProfit)} on these assumptions (${(r.profitOnCost * 100).toFixed(1)}% on cost), before tax.`
      : `Cash flow of ${money(r.monthlyCashflow)} a month on these assumptions, before tax.`;
    const fallbackReading = flip ? 'See the sensitivity grid for how profit changes with the sale price and refurb overruns.'
      : `The lender stress test ${r.icrPass ? 'passes' : 'fails'} (rent covers stressed interest ${Number.isFinite(r.icr) ? `${(r.icr * 100).toFixed(0)}%` : 'fully'} vs ${(r.icrRequired * 100).toFixed(0)}% required).`;
    // An answer more optimistic than the numbers isn't trusted for its upbeat parts: its headline, strengths,
    // assumptions and stress-test reading are replaced by Streetkey's own. Its risks and questions are kept.
    const shown = capped ? [risks, questions] : [headline, reading, strengths, risks, mustBeTrue, questions, ...(caution ? [caution] : [])];
    return {
      verdict, headline: capped || !headline.text ? fallbackHeadline : headline.text,
      strengths: capped ? [] : strengths.items, risks: risks.items,
      whatMustBeTrue: capped ? ruleAssumptions(inputs, active) : mustBeTrue.items, questionsToAsk: questions.items,
      stressTestReading: capped || !reading.text ? fallbackReading : reading.text,
      ruleVerdict: rule.verdict, ruleReasons: rule.reasons, verdictCapped: capped,
      cautionReason: order(verdict) < order(rule.verdict) ? cautionReason : null,
      strategy: inputs.strategy, scenario: body.scenario, numbers,
      removedClaims: shown.reduce((s, l) => s + l.removed, 0),
      disclaimer: 'AI reading of Streetkey’s calculations. Not financial, mortgage or tax advice: speak to an FCA-regulated mortgage adviser and a qualified tax adviser before you decide.',
    };
  });
}
