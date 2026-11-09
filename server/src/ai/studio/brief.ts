/**
 * Design brief → structured plan for the design studio.
 *
 * The model reads the brief and chooses the room, a style from Streetkey's STYLES, a tier and the
 * key materials (in words). Every figure comes from the design-to-cost engine: the model is given
 * the engine's totals per tier to choose sensibly, and the server re-checks the choice against the
 * budget and recomputes the costs itself. Falls back to the rule-based brief parser.
 */
import { createHash } from 'node:crypto';
import { designCost, fitBudget, parseDesignBrief, STYLES, TIERS, type DesignCost, type Dims, type RoomType, type Tier } from '../../../../src/engine/design';
import { regionFromPostcode, REGIONS } from '../../../../src/engine/refurb';
import { AiError, cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { clean, noMoney, numberIn, numbersIn } from '../importer/validate';

export const ROOMS = ['kitchen', 'bathroom', 'living', 'bedroom'] as const satisfies readonly RoomType[];
export const STYLE_IDS = STYLES.map((s) => s.id);
export const DEFAULT_DIMS: Dims = { width: 4.2, length: 3.4, height: 2.5 };
const ROOM_LABEL: Record<RoomType, string> = { kitchen: 'kitchen', bathroom: 'bathroom', living: 'living room', bedroom: 'bedroom' };

export const BriefSchema = S.obj({
  room: S.enum(ROOMS, 'The room the brief is about; the current room if it doesn’t say'),
  styleId: S.enum(STYLE_IDS, 'One of Streetkey’s style ids'),
  tier: S.enum(TIERS, 'Specification tier'),
  budget: S.nullable(S.num('The budget in pounds, only if the brief states one')),
  priorities: S.arr(S.str(), 'Up to 4 short phrases: what matters most to the person'),
  keep: S.arr(S.str(), 'Things the person wants to keep (empty if none)'),
  materials: S.arr(S.obj({ item: S.str('e.g. Worktop'), spec: S.str('e.g. Quartz 20mm'), why: S.str('Why it suits the brief, one short sentence') }), '3 to 6 key materials or fittings, words only'),
  notes: S.str('One or two sentences of design advice, no prices'),
});
type Brief = Infer<typeof BriefSchema>;

export interface BriefInput { text: string; room?: RoomType; budget?: number | null; postcode?: string; dims?: Dims; staged?: boolean }
export interface CostSummary { total: number; materials: number; labour: number; prelimsOhp: number; contingency: number; vat: number; weeks: number; regionLabel: string }
export interface BriefResult {
  engine: 'ai' | 'rules';
  room: RoomType; styleId: string; styleName: string; tier: Tier; budget: number | null;
  priorities: string[]; keep: string[]; materials: { item: string; spec: string; why: string }[]; notes: string;
  /** From the design-to-cost engine (indicative, incl. VAT). */
  cost: CostSummary;
  fitsBudget: boolean | null;
  /** The tier was lowered so the design fits the budget. */
  tierAdjusted: boolean;
  /** A plain summary built from the engine's figures. */
  message: string;
  note: string | null;
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const summary = (c: DesignCost): CostSummary => ({ total: c.total, materials: c.materials, labour: c.labour, prelimsOhp: c.prelimsOhp, contingency: c.contingency, vat: c.vat, weeks: c.weeks, regionLabel: c.regionLabel });
const furnished = (room: RoomType, staged: boolean) => (room === 'living' || room === 'bedroom') && staged;

/** The highest tier at or below `start` whose engine total fits the budget (null if none does). */
function tierWithin(room: RoomType, start: Tier, budget: number, dims: Dims, postcode: string, furniture: boolean): Tier | null {
  for (let i = TIERS.indexOf(start); i >= 0; i--) if (designCost(room, TIERS[i], dims, postcode, { furniture }).total <= budget) return TIERS[i];
  return null;
}

function message(room: RoomType, styleName: string, tier: Tier, cost: DesignCost, budget: number | null, fits: boolean | null, adjustedFrom: Tier | null) {
  const what = `${styleName} ${ROOM_LABEL[room]}, ${tier} specification`;
  if (budget == null) return `${what}: about ${gbp(cost.total)} incl. VAT (indicative).`;
  if (!fits) return `Even the budget specification for this ${ROOM_LABEL[room]} comes to about ${gbp(cost.total)} incl. VAT, ${gbp(cost.total - budget)} over your ${gbp(budget)}. Consider decoration and lighting only, or a smaller scope.`;
  return `${adjustedFrom ? `To fit your budget, the specification is ${tier} rather than ${adjustedFrom}. ` : ''}${what}: about ${gbp(cost.total)} incl. VAT, ${gbp(budget - cost.total)} within your ${gbp(budget)} budget.`;
}

/** The rule-based plan (offline parser + engine budget fit). */
export function rulesBrief(i: BriefInput, note: string | null = null): BriefResult {
  const p = parseDesignBrief(i.text);
  const dims = i.dims ?? DEFAULT_DIMS;
  const postcode = i.postcode ?? '';
  const room: RoomType = p.room ?? i.room ?? 'living';
  const furniture = furnished(room, i.staged ?? true);
  const budget = i.budget ?? (p.budget && p.budget >= 300 && p.budget <= 1_000_000 ? p.budget : null);
  let style = STYLES.find((s) => s.id === p.style) ?? null;
  let fits: boolean | null = null;
  if (budget != null) {
    const f = fitBudget(room, budget, dims, postcode, furniture);
    // fitBudget's `best` is undefined when nothing fits (its type says otherwise).
    const chosen: { style: (typeof STYLES)[number] } | undefined = (style ? f.fits.find((x) => x.style.id === style!.id) : undefined) ?? (f.best || undefined);
    style = chosen?.style ?? f.cheapest.style;
    fits = chosen !== undefined;
  }
  style ??= STYLES[0];
  const tier = fits === false ? 'budget' : style.tier;
  const cost = designCost(room, tier, dims, postcode, { furniture });
  return {
    engine: 'rules', room, styleId: style.id, styleName: style.name, tier, budget, priorities: [], keep: [],
    materials: cost.lines.filter((l) => l.code !== 'STAGE').slice(0, 6).map((l) => ({ item: l.name, spec: l.spec, why: 'From Streetkey’s cost catalogue for this specification.' })),
    notes: '', cost: summary(cost), fitsBudget: fits, tierAdjusted: false, message: message(room, style.name, tier, cost, budget, fits, null), note,
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);

export async function designBrief(i: BriefInput, o: { userId: string | null }): Promise<BriefResult> {
  const dims = i.dims ?? DEFAULT_DIMS;
  const postcode = i.postcode ?? '';
  const staged = i.staged ?? true;
  const parsed = parseDesignBrief(i.text);
  const likelyRoom: RoomType = parsed.room ?? i.room ?? 'living';
  // Engine facts the model chooses from (it never invents a cost).
  const costByTier = Object.fromEntries(ROOMS.map((r) => [r, Object.fromEntries(TIERS.map((t) => [t, designCost(r, t, dims, postcode, { furniture: furnished(r, staged) }).total]))]));
  const specsForLikelyRoom = Object.fromEntries(TIERS.map((t) => [t, designCost(likelyRoom, t, dims, postcode).lines.map((l) => `${l.name}: ${l.spec}`)]));
  const region = REGIONS[regionFromPostcode(postcode) ?? 'south-west'].label;
  const context = {
    currentRoom: i.room ?? null, budgetChosenOnPage: i.budget ?? null, region,
    styles: STYLES.map((s) => ({ id: s.id, name: s.name, note: s.note, usualTier: s.tier })),
    totalIncVatByRoomAndTier: costByTier, catalogueSpecsByTier: { room: likelyRoom, specs: specsForLikelyRoom },
  };
  const system = [
    HOUSE_RULES,
    'You are Streetkey’s interior design assistant. Turn a short design brief into a structured plan for the design studio.',
    '- room: the room the brief names; if it names none, use currentRoom (or living if that is null).',
    '- styleId: one of the style ids given. tier: one of budget, standard, premium, luxury.',
    '- If the brief states a budget, pick the highest tier whose total in totalIncVatByRoomAndTier is within it; otherwise use the style’s usual tier unless the brief asks for something plainer or grander.',
    '- budget: the figure the brief states, in pounds (e.g. "£5k" is 5000), or null if it states none.',
    '- materials: words only, consistent with the catalogue specs for the chosen tier where they apply.',
    '- Never write prices, costs or other figures in materials, priorities or notes: Streetkey’s cost engine adds them.',
    '- Don’t describe who the home suits or mention people’s characteristics.',
  ].join('\n');
  try {
    const key = `design.brief:v1:${sha(JSON.stringify({ t: i.text, r: i.room ?? null, b: i.budget ?? null, p: postcode.slice(0, 4), d: dims, s: staged }))}`;
    const ai = await cached(key, 24 * 3600, () => chatJSON<Brief>([
      { role: 'system', content: system },
      { role: 'user', content: `Engine data:\n${JSON.stringify(context)}\n\nThe brief:\n${untrusted('brief', i.text, 1000)}` },
    ], BriefSchema, 'design_brief', { purpose: 'design.brief', userId: o.userId, role: 'fast', maxTokens: 1600 }));
    return groundBrief(ai, i);
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    return rulesBrief(i, `${e.userMessage} Streetkey’s built-in brief reader was used instead.`);
  }
}

/** Validate the model's plan and attach engine figures. Exported for tests. */
export function groundBrief(ai: Brief, i: BriefInput): BriefResult {
  const dims = i.dims ?? DEFAULT_DIMS;
  const postcode = i.postcode ?? '';
  const parsed = parseDesignBrief(i.text);
  const room: RoomType = (ROOMS as readonly string[]).includes(ai.room) ? ai.room : parsed.room ?? i.room ?? 'living';
  const style = STYLES.find((s) => s.id === ai.styleId) ?? STYLES.find((s) => s.id === parsed.style) ?? null;
  if (!style) return rulesBrief(i);
  const furniture = furnished(room, i.staged ?? true);
  // Budget: what the page sent, else what the brief itself says (checked against the text).
  const nums = numbersIn(i.text);
  const aiBudget = ai.budget != null && ai.budget >= 300 && ai.budget <= 1_000_000 && numberIn(ai.budget, nums) ? Math.round(ai.budget) : null;
  const budget = i.budget ?? aiBudget ?? (parsed.budget && parsed.budget >= 300 && parsed.budget <= 1_000_000 ? parsed.budget : null);
  let tier: Tier = TIERS.includes(ai.tier) ? ai.tier : style.tier;
  let fits: boolean | null = null;
  let adjustedFrom: Tier | null = null;
  if (budget != null) {
    const within = tierWithin(room, tier, budget, dims, postcode, furniture);
    if (within) { if (within !== tier) adjustedFrom = tier; tier = within; fits = true; }
    else { tier = 'budget'; fits = false; }
  }
  const cost = designCost(room, tier, dims, postcode, { furniture });
  const words = (s: string, max: number) => noMoney(clean(s, max * 2)).slice(0, max).trim();
  const list = (xs: string[], n: number, max: number) => [...new Set(xs.map((x) => words(x, max)).filter((x) => x.length >= 2))].slice(0, n);
  return {
    engine: 'ai', room, styleId: style.id, styleName: style.name, tier, budget,
    priorities: list(ai.priorities, 4, 80), keep: list(ai.keep, 5, 80),
    materials: ai.materials.slice(0, 6).map((m) => ({ item: words(m.item, 60), spec: words(m.spec, 90), why: words(m.why, 180) })).filter((m) => m.item && m.spec),
    notes: words(ai.notes, 400),
    cost: summary(cost), fitsBudget: fits, tierAdjusted: !!adjustedFrom, message: message(room, style.name, tier, cost, budget, fits, adjustedFrom), note: null,
  };
}
