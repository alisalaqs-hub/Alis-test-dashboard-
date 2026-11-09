/**
 * "Explain this estimate": the estimate is recomputed here from the input (client figures are never
 * trusted), the model explains it using only those figures, and any £ amount it writes that isn't one
 * of them is removed before the answer leaves the server.
 */
import type { RefurbExplainResult } from '../../../../src/lib/ai/property';
import { money } from '../../../../src/lib/ai/property';
import { estimateRefurb, hiddenDefectRisks, REGIONS, scenarios, VAT_RATES, type RefurbInput } from '../../../../src/engine/refurb';
import { cached, chatJSON, HOUSE_RULES } from '../core';
import { S, type Infer } from '../schema';
import { figuresInText, hashOf, scrubList, scrubText } from './figures';

const Out = S.obj({
  summary: S.str('2 to 4 plain sentences'),
  biggestCosts: S.arr(S.str()),
  waysToSave: S.arr(S.str()),
  risks: S.arr(S.str()),
  nextSteps: S.arr(S.str()),
});
type OutT = Infer<typeof Out>;

const SYSTEM = [
  HOUSE_RULES,
  'You explain a renovation cost estimate produced by Streetkey’s cost engine, for a homeowner or investor in plain, friendly British English.',
  'Use only the figures in the ESTIMATE data, as given (you may round to the nearest £100 or £1,000). Never add, subtract or combine figures, and never introduce any other cost, saving, value, grant or price.',
  'summary: what the total covers and the likely range, in 2 to 4 sentences, saying once that it is a budget estimate, not a quote or a survey.',
  'biggestCosts: the 3 to 4 largest trades or items and why they cost what they do. waysToSave: up to 4 options, using the savings listed in the data where relevant. risks: up to 4 things that could push the cost up (hidden defects, condition, era). nextSteps: up to 4 practical actions (surveys, quotes, approvals).',
  'Each list item is one sentence. No headings, no markdown.',
].join('\n');

/** Savings Streetkey's engine computes by removing or downgrading one scope item at a time. */
function savingsFor(i: RefurbInput, total: number) {
  const s = i.scope;
  const tries: { label: string; input: RefurbInput }[] = [];
  const withScope = (label: string, patch: Partial<RefurbInput['scope']>) => tries.push({ label, input: { ...i, scope: { ...s, ...patch } } });
  if (s.kitchen) withScope('Keep the existing kitchen', { kitchen: false });
  if (s.rewire) withScope('Partial electrical upgrade instead of a full rewire (only if an EICR allows)', { rewire: false });
  if (s.heating === 'full') withScope('Replace the boiler only instead of the whole heating system', { heating: 'boiler' });
  if (s.replaster === 'full') withScope('Skim instead of hacking off and re-plastering', { replaster: 'skim' });
  if (s.roof === 'recover') withScope('Roof overhaul instead of a full re-cover (if a roofer agrees)', { roof: 'repair' });
  if (s.windows) withScope('Keep the existing windows and doors', { windows: false });
  if (s.external) withScope('Leave external works for later', { external: false });
  if (s.solidWallInsulation) withScope('Leave solid-wall insulation out', { solidWallInsulation: false });
  if (s.extensionArea > 0) withScope('Leave out the extension', { extensionArea: 0 });
  if (s.loftArea > 0) withScope('Leave out the loft conversion', { loftArea: 0 });
  if (i.bathrooms > 1) tries.push({ label: 'Refit one bathroom fewer', input: { ...i, bathrooms: i.bathrooms - 1 } });
  if (i.vat === 'standard' && i.propertyType !== 'commercial') tries.push({ label: `If eligible: ${VAT_RATES['reduced-empty-2yrs'].label}`, input: { ...i, vat: 'reduced-empty-2yrs' } });
  return tries.map((t) => ({ option: t.label, saving: total - estimateRefurb(t.input).total })).filter((t) => t.saving > 0).sort((a, b) => b.saving - a.saving).slice(0, 6);
}

/** The engine's figures for this input, plus every amount the model is allowed to quote. */
export function explainPack(input: RefurbInput) {
  const e = estimateRefurb(input);
  const specs = scenarios(input).map((x) => ({ spec: x.spec, total: x.estimate.total, differenceFromCurrent: x.estimate.total - e.total }));
  const savings = savingsFor(input, e.total);
  const risks = hiddenDefectRisks(input);
  const lines = [...e.lines].sort((a, b) => b.total - a.total).slice(0, 8).map((l) => ({ item: l.description, trade: l.trade, quantity: l.quantity, unit: l.unit, total: l.total }));
  const pack = {
    property: { type: input.propertyType, floorAreaM2: input.floorArea, bedrooms: input.bedrooms, storeys: input.storeys, era: input.era, condition: input.condition, region: REGIONS[e.region].label, specification: input.spec, siteAccess: input.access, vat: VAT_RATES[input.vat].label },
    totals: { totalIncVat: e.total, likelyLow: e.low, likelyHigh: e.high, confidence: e.confidence, measuredWorks: e.measuredWorks, preliminaries: e.preliminaries, overheadsAndProfit: e.overheadsProfit, contingency: e.contingency, professionalFees: e.professionalFees, vat: e.vat, costPerM2ExVat: e.costPerM2, programmeWeeks: e.programmeWeeks },
    byTrade: e.byTrade.slice(0, 10),
    biggestLines: lines,
    specificationOptions: specs,
    savingsOptions: savings,
    hiddenDefectRisks: risks,
    exclusions: e.exclusions,
    compliance: e.compliance.slice(0, 5),
    assumptions: e.assumptions,
  };
  const allowed = [
    e.total, e.low, e.high, e.measuredWorks, e.preliminaries, e.overheadsProfit, e.contingency, e.professionalFees, e.vat, e.subtotalExVat, e.costPerM2,
    e.labourAllowance, e.materialsAllowance,
    ...e.byTrade.map((t) => t.total), ...e.lines.flatMap((l) => [l.total, l.rate]),
    ...specs.flatMap((x) => [x.total, x.differenceFromCurrent]), ...savings.map((x) => x.saving),
    ...figuresInText([...risks.map((r) => r.allowance), ...e.exclusions, ...e.compliance, ...e.assumptions, ...savings.map((x) => x.option)]),
  ];
  return { e, pack, allowed };
}

export async function explainEstimate(input: RefurbInput, meta: { userId: string | null }): Promise<RefurbExplainResult> {
  const { e, pack, allowed } = explainPack(input);
  return cached(`prop:refurb-explain:v2:${hashOf(pack)}`, 7 * 86_400, async () => {
    const out = await chatJSON<OutT>([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ESTIMATE (computed by Streetkey’s cost engine; amounts in £, including VAT unless stated):\n${JSON.stringify(pack)}` },
    ], Out, 'refurb_explanation', { purpose: 'property.refurb_explain', userId: meta.userId, role: 'fast', maxTokens: 1600 });
    const summary = scrubText(out.summary, allowed, 700);
    const lists = (['biggestCosts', 'waysToSave', 'risks', 'nextSteps'] as const).map((k) => scrubList(out[k], allowed, { max: 5 }));
    const fallback = `The estimate is ${money(e.total)} including VAT, with a likely range of ${money(e.low)} to ${money(e.high)} (${e.confidence} confidence). It’s a budget estimate from Streetkey’s cost engine, not a quote or a survey.`;
    return {
      summary: summary.text || fallback,
      biggestCosts: lists[0].items, waysToSave: lists[1].items, risks: lists[2].items, nextSteps: lists[3].items,
      estimate: { total: e.total, low: e.low, high: e.high, confidence: e.confidence },
      removedClaims: summary.removed + lists.reduce((s, l) => s + l.removed, 0),
      disclaimer: 'AI explanation of Streetkey’s budget estimate. Not a quote, survey or valuation: get at least three quotes before committing.',
    };
  });
}
