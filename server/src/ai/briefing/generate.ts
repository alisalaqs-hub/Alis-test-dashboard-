/**
 * AI briefings for professional dashboards, and AI proposals for the automation agents.
 * The model reads a bounded snapshot of what the dashboard shows and explains, ranks and
 * words it. It never supplies figures: every £ or % it writes is checked against the
 * snapshot (see grounding.ts) and anything it can't back up is removed.
 */
import { chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { Grounding } from './grounding';
import { clip, itemIds, LIMITS, type SnapshotT } from './snapshot';

export type BriefingKind = 'agent' | 'landlord' | 'developer' | 'my-agency';
export const CLIENT_KINDS = ['agent', 'landlord', 'developer'] as const;

/* ───────────────────────── briefing ───────────────────────── */

const Priority = S.obj({
  title: S.str('Short imperative title, under 80 characters.'),
  why: S.str('One or two sentences citing the snapshot evidence.'),
  action: S.str('The concrete next step, one sentence.'),
  impact: S.enum(['high', 'medium', 'low'] as const),
  relatedIds: S.arr(S.str(), 'Ids of the snapshot items this priority concerns.'),
});
export const BriefingOut = S.obj({
  headline: S.str('One sentence, under 120 characters.'),
  summary: S.str('Two to four sentences.'),
  priorities: S.arr(Priority, 'Three to five priorities, most important first.'),
  risks: S.arr(S.str(), 'Up to four short risks.'),
  opportunities: S.arr(S.str(), 'Up to four short opportunities.'),
  questions: S.arr(S.str(), 'Up to three questions the user should check or answer.'),
});
type BriefingOutT = Infer<typeof BriefingOut>;

export interface BriefingPriority { title: string; why: string; action: string; impact: 'high' | 'medium' | 'low'; relatedIds: string[] }
export interface Briefing {
  kind: BriefingKind;
  headline: string;
  summary: string;
  priorities: BriefingPriority[];
  risks: string[];
  opportunities: string[];
  questions: string[];
  /** How many £/% figures were checked, and how many statements were removed because a figure wasn't in the data. */
  grounding: { checked: number; dropped: number };
  source: 'dashboard' | 'live';
  generatedAt: string;
}

const AUDIENCE: Record<BriefingKind, string> = {
  agent: [
    'Audience: an estate agency branch manager reviewing their listings.',
    'Look for: listings converting below comparables, falling interest, long time on market, weak listing quality, price evidence, and approvals waiting.',
    'Good actions: refresh or test the lead photo, complete material information, review price with the vendor using the evidence shown, follow up enquiries promptly, send the vendor an update.',
    'Never suggest pressuring buyers, inventing urgency, or wording that could mislead (Consumer Protection from Unfair Trading Regulations 2008 / DMCC Act 2024).',
  ].join('\n'),
  'my-agency': [
    'Audience: an estate agency team looking at their own live Streetkey listings (real, not demo data).',
    'Look for: listings with views but few enquiries, unanswered enquiries, long days live, price position against the area range, recent price changes, few photos.',
    'Good actions: answer new enquiries, improve photos and material information, review price with the vendor using the area range, send the vendor an update.',
    'Never suggest pressuring buyers, inventing urgency, or wording that could mislead (Consumer Protection from Unfair Trading Regulations 2008 / DMCC Act 2024).',
  ].join('\n'),
  landlord: [
    'Audience: a residential landlord in England under the Renters’ Rights Act regime (periodic tenancies, no section 21; rent increases only via section 13, once a year).',
    'Look for: compliance dates due soon or overdue (gas safety, EICR, EPC, deposit protection and prescribed information, right to rent, smoke and CO alarms), arrears, voids, damp and mould, maintenance, licensing.',
    'Damp and mould always ranks high. For arrears, suggest a supportive conversation and the proper pre-action steps; never shortcuts, harassment or unlawful eviction.',
    'Never suggest choosing or refusing tenants by protected characteristics, benefit status, children or similar, and never suggest charging fees banned by the Tenant Fees Act 2019.',
    'Refer to tenancies by unit id, not by tenant names.',
  ].join('\n'),
  developer: [
    'Audience: a residential developer screening a scheme with a residual land appraisal.',
    'Look for: residual land value against the land asking price, sensitivity to build cost and sales values, sell-out period against absorption, unit mix against demand, pipeline competition, planning and scheme risks.',
    'This is screening only, not a viability assessment: suggest a full appraisal by a viability consultant before bidding where relevant.',
  ].join('\n'),
};

const RULES = [
  'Write a short briefing from the dashboard snapshot. Only use what is in the snapshot.',
  'Figures: quote £ amounts and percentages exactly as they appear in the snapshot. Never calculate new totals, differences, averages, percentages or forecasts; compare in words instead ("below the comparables", "the highest of the four"). Statements with figures that are not in the snapshot are removed automatically.',
  'Counts and dates may be quoted from the snapshot. If something important is missing, add it to questions rather than guessing.',
  'priorities: 3 to 5, most important first; impact is high, medium or low; relatedIds lists the ids of snapshot items each one concerns (an empty list if it is portfolio-wide).',
  'Keep every string short and plain: no markdown, no lists inside strings, no emojis.',
  'Never promise outcomes (no guarantees), and never call anything a valuation, survey, or financial, legal or tax advice.',
].join('\n');

/** Ask the model for a briefing, then keep only what the snapshot supports. */
export async function generateBriefing(kind: BriefingKind, snapshot: SnapshotT, meta: { userId?: string | null; source: Briefing['source'] }): Promise<Briefing> {
  const out = await chatJSON<BriefingOutT>([
    { role: 'system', content: `${HOUSE_RULES}\n\n${RULES}\n\n${AUDIENCE[kind]}` },
    { role: 'user', content: `Dashboard snapshot (JSON):\n${untrusted('snapshot', JSON.stringify(snapshot), LIMITS.chars + 500)}` },
  ], BriefingOut, 'dashboard_briefing', { purpose: `briefing.${kind}`, userId: meta.userId ?? null, role: 'main', maxTokens: 1600, effort: 'low', timeoutMs: 90_000 });
  return groundBriefing(kind, snapshot, out, meta.source);
}

/** Apply length limits, figure grounding and id checks to the model's answer. */
export function groundBriefing(kind: BriefingKind, snapshot: SnapshotT, out: BriefingOutT, source: Briefing['source']): Briefing {
  const g = new Grounding(snapshot);
  const ids = itemIds(snapshot);
  const line = (s: string, max: number) => clip(s, max);
  const short = (xs: string[], n: number, max: number) => g.list(xs.map((x) => line(x, max)).filter(Boolean), (x) => [x]).slice(0, n);
  const priorities = g.list(
    out.priorities.map((p) => ({ title: line(p.title, 120), why: line(p.why, 420), action: line(p.action, 300), impact: p.impact, relatedIds: [...new Set(p.relatedIds)].filter((id) => ids.has(id)).slice(0, 8) })).filter((p) => p.title && p.action),
    (p) => [p.title, p.why, p.action],
  ).slice(0, 6);
  const headline = g.prose(line(out.headline, 200)) || (priorities.length ? `${priorities.length} priorit${priorities.length === 1 ? 'y' : 'ies'} from your dashboard` : 'Your dashboard briefing');
  return {
    kind, headline, summary: g.prose(line(out.summary, 900)), priorities,
    risks: short(out.risks, 5, 240), opportunities: short(out.opportunities, 5, 240), questions: short(out.questions, 4, 200),
    grounding: g.report, source, generatedAt: new Date().toISOString(),
  };
}

/* ───────────────────────── automation proposals ───────────────────────── */

export const ProposalsOut = S.obj({
  proposals: S.arr(S.obj({
    title: S.str('Imperative action title, under 90 characters.'),
    detail: S.str('What exactly would be prepared, one or two sentences.'),
    consequential: S.bool('True if it publishes, contacts anyone, books, spends money or changes records.'),
    rationale: S.str('Why, citing the findings. One or two sentences.'),
  }), 'One to four proposals.'),
});
type ProposalsOutT = Infer<typeof ProposalsOut>;

export interface AgentContext { id: string; name: string; serves: string; permissions: string[]; findings: string[]; toolsCalled: string[]; ruleProposals: { title: string; detail: string; consequential: boolean }[] }
export interface AiProposal { id: string; agent: string; title: string; detail: string; consequential: boolean; rationale: string }

/** Anything that reaches outside Streetkey or changes a record needs a human, whatever the model says. */
export const CONSEQUENTIAL = /\b(?:send|email|e-mail|message|contact|notify|call|phone|reply|respond|publish|relist|delist|book|schedule|instruct|pay|spend|purchase|buy|bid|offer|request|submit|serve|accept|reject|approve|change|update|amend|edit|reduce|increase|raise|cancel|terminate|evict|remove|delete|withdraw|chase|remind)(?:s|es|d|ed|ing)?\b/i;

export async function generateProposals(agent: AgentContext, context: SnapshotT | null, meta: { userId?: string | null }) {
  const system = [
    HOUSE_RULES,
    `You plan next actions for Streetkey’s “${agent.name}” (serves ${agent.serves}). It can only act within these permissions: ${agent.permissions.join(', ')}.`,
    'You never execute anything. You propose actions; a named person approves anything consequential (publishing, contacting anyone, booking, spending money, changing listing or tenancy records).',
    'Base proposals only on the findings and data given. Quote £ and % figures exactly as given; never calculate new ones. Proposals with unsupported figures are removed automatically.',
    'Propose one to four actions, most useful first. Plain British English, no markdown.',
    'Never propose discriminating between people, pressuring buyers or tenants, unlawful eviction steps, banned tenant fees, or misleading listing claims.',
  ].join('\n');
  const data = { agent: { id: agent.id, name: agent.name, permissions: agent.permissions, toolsCalled: agent.toolsCalled }, findings: agent.findings, ruleBasedProposals: agent.ruleProposals, ...(context ? { userContext: context } : {}) };
  const out = await chatJSON<ProposalsOutT>([
    { role: 'system', content: system },
    { role: 'user', content: `Agent findings and data (JSON):\n${untrusted('agent_run', JSON.stringify(data), LIMITS.chars + 6000)}` },
  ], ProposalsOut, 'agent_proposals', { purpose: `automation.${agent.id}`, userId: meta.userId ?? null, role: 'fast', maxTokens: 900, effort: 'low' });
  return groundProposals(agent, context, out);
}

export function groundProposals(agent: AgentContext, context: SnapshotT | null, out: ProposalsOutT) {
  const g = new Grounding({ findings: agent.findings, rules: agent.ruleProposals, context });
  const stamp = Date.now().toString(36);
  const proposals: AiProposal[] = g.list(
    out.proposals.map((p) => ({ title: clip(p.title, 120), detail: clip(p.detail, 400), rationale: clip(p.rationale, 400), consequential: p.consequential })).filter((p) => p.title),
    (p) => [p.title, p.detail, p.rationale],
  ).slice(0, 4).map((p, i) => ({
    id: `ai-${agent.id}-${stamp}-${i}`, agent: agent.id, title: p.title, detail: p.detail, rationale: p.rationale,
    // Never downgrade: the model may only add caution, not remove it.
    consequential: p.consequential || CONSEQUENTIAL.test(`${p.title} ${p.detail}`),
  }));
  return { proposals, grounding: g.report };
}
