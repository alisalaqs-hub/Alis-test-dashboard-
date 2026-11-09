/**
 * "Your AI plan" for homeowners. Streetkey's engines cost the options for the chosen goals
 * (refresh, renovation, loft, extensions, EPC measures, lettings and sale preparation); the model
 * picks and orders them and explains why. Costs and value figures on each step are attached in code
 * from the option the step refers to: the model never writes them.
 */
import { homeModel, money, planOptions, type HomeFacts, type HomeGoal, type HomePlanResult, type PlanOption, type PlanStep } from '../../../../src/lib/ai/property';
import { cached, chatJSON, HOUSE_RULES } from '../core';
import { ensureLiveRegistry } from '../registry';
import { S } from '../schema';
import { figuresInText, hashOf, scrubList, scrubText } from './figures';

const schemaFor = (optionIds: string[]) => S.obj({
  summary: S.str('2 to 3 sentences'),
  steps: S.arr(S.obj({
    optionId: S.nullable(S.enum(optionIds.length ? optionIds : ['none']), 'The option this step carries out, or null for advice with no cost'),
    title: S.str('Short step title, no figures'),
    why: S.str('One or two sentences on why, for this home and these goals'),
    effort: S.enum(['low', 'medium', 'high'] as const),
    order: S.int('1 = do first'),
  })),
  quickWins: S.arr(S.str()),
  avoid: S.arr(S.str()),
});
interface Out { summary: string; steps: { optionId: string | null; title: string; why: string; effort: 'low' | 'medium' | 'high'; order: number }[]; quickWins: string[]; avoid: string[] }

const SYSTEM = [
  HOUSE_RULES,
  'You are helping a UK homeowner plan improvements. Streetkey’s engines have already costed the OPTIONS for their goals. Choose the options that best fit the goals and budget, put them in a sensible order, and explain why in plain, friendly British English.',
  'Use only figures in the DATA, as given (you may round to the nearest £100 or £1,000). Never add, subtract or combine figures, and never introduce other costs, values, savings, rents or grants. Step titles contain no figures.',
  'steps: 3 to 6, each linked to an option by optionId where one applies (optionId null for advice such as getting quotes). Respect the budget: if an option costs more than the budget, say so rather than recommending it as affordable.',
  'quickWins: up to 3 small, low-cost actions. avoid: up to 3 things that commonly waste money for these goals.',
  'Development options are screening only, not planning advice; energy figures are indicative. Do not make claims about the neighbourhood or the people who live there.',
].join('\n');

const optionForAi = (o: PlanOption) => ({ id: o.id, title: o.title, detail: o.detail, cost: o.cost, valueImpact: o.valueImpact, annualBillSaving: o.billsSaving, rentPcm: o.rentPcm, effort: o.effort, withinBudget: o.withinBudget, goals: o.goals });

export async function homePlan(body: { home: HomeFacts; goals: HomeGoal[]; budget: number | null }, meta: { userId: string | null }): Promise<HomePlanResult> {
  await ensureLiveRegistry().catch(() => {});
  const m = homeModel(body.home);
  const options = planOptions(m, body.goals, body.budget).slice(0, 10);
  const byId = new Map(options.map((o) => [o.id, o]));
  const figures = { value: m.value, rent: m.rent ? { low: m.rent.low, mid: m.rent.mid, high: m.rent.high } : null, evidence: m.ev ? `${m.ev.n} listing${m.ev.n === 1 ? '' : 's'} in ${m.ev.scope}` : null };
  const disclaimer = 'AI plan built on Streetkey’s indicative costs and values. Not a valuation, survey or planning advice: get quotes and check planning and building regulations before you start.';
  if (!options.length) {
    // Nothing costed to plan with (e.g. a flat and only "more space"): say so without calling the AI.
    return { summary: 'Streetkey has no costed options for these goals for this home (flats, for example, have no loft or extension options). Try another goal.', steps: [], quickWins: [], avoid: [], figures, goals: body.goals, budget: body.budget, removedClaims: 0, disclaimer };
  }
  const pack = {
    home: { ...body.home, region: m.ev?.scope ?? null },
    goals: body.goals, budget: body.budget,
    valueToday: m.value ? { ...m.value, basis: `Indicative, from ${figures.evidence}; not a valuation` } : 'No local evidence in Streetkey’s data',
    rentEstimatePcm: body.goals.includes('rent-out') && m.rent ? { low: m.rent.low, mid: m.rent.mid, high: m.rent.high, basis: m.rent.basis } : null,
    annualEnergyCostNow: m.energyNow,
    OPTIONS: options.map(optionForAi),
  };
  const allowed = [
    ...options.flatMap((o) => [o.cost, o.valueImpact, o.billsSaving, o.rentPcm].filter((n): n is number => n != null)),
    ...(m.value ? [m.value.low, m.value.mid, m.value.high] : []), ...(m.rent ? [m.rent.low, m.rent.mid, m.rent.high] : []),
    m.energyNow, m.full.low, m.full.high, ...(body.budget != null ? [body.budget] : []),
    ...figuresInText(options.flatMap((o) => [o.title, o.detail])),
  ];

  return cached(`prop:home-plan:v2:${hashOf(pack)}`, 86_400, async () => {
    const out = await chatJSON<Out>([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `DATA (computed by Streetkey’s engines; amounts in £):\n${JSON.stringify(pack)}` },
    ], schemaFor(options.map((o) => o.id)), 'home_plan', { purpose: 'property.home_plan', userId: meta.userId, role: 'main', maxTokens: 2200, effort: 'low' });

    let removed = 0;
    const used = new Set<string>();
    const steps: PlanStep[] = [];
    for (const s of [...out.steps].sort((a, b) => a.order - b.order)) {
      const opt = s.optionId ? byId.get(s.optionId) ?? null : null;
      if (opt && used.has(opt.id)) continue;
      if (opt) used.add(opt.id);
      const title = scrubText(s.title, [], 120); // titles carry no figures
      const why = scrubText(s.why, allowed, 400);
      removed += title.removed + why.removed;
      const t = title.text || opt?.title || '';
      if (!t) continue;
      steps.push({
        order: steps.length + 1, title: t, why: why.text || opt?.detail || '',
        cost: opt?.cost ?? null, valueImpact: opt?.valueImpact ?? null, billsSaving: opt?.billsSaving ?? null,
        effort: opt?.effort ?? s.effort, optionId: opt?.id ?? null, withinBudget: opt?.withinBudget ?? null,
      });
      if (steps.length === 6) break;
    }
    const summary = scrubText(out.summary, allowed, 600);
    const quick = scrubList(out.quickWins, allowed, { max: 3 });
    const avoid = scrubList(out.avoid, allowed, { max: 3 });
    removed += summary.removed + quick.removed + avoid.removed;
    const top = options[0];
    return {
      summary: summary.text || `For your goals, Streetkey’s engines suggest starting with: ${top.title.toLowerCase()}${top.cost != null ? ` (about ${money(top.cost)})` : ''}.`,
      steps: steps.length ? steps : options.slice(0, 4).map((o, k) => ({ order: k + 1, title: o.title, why: o.detail, cost: o.cost, valueImpact: o.valueImpact, billsSaving: o.billsSaving, effort: o.effort, optionId: o.id, withinBudget: o.withinBudget })),
      quickWins: quick.items, avoid: avoid.items, figures, goals: body.goals, budget: body.budget, removedClaims: removed, disclaimer,
    };
  });
}
