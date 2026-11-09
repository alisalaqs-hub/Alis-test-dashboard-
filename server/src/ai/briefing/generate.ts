/**
 * AI briefings for professional dashboards, and AI proposals for the automation agents.
 * The model reads a bounded snapshot of what the dashboard shows and explains, ranks and
 * words it. It never supplies figures: every £ or % it writes is checked against the same
 * kind of figure in the snapshot (see grounding.ts) and anything it can't back up is removed.
 */
import { normTitle } from '../../../../src/ai/agents';
import { chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { Grounding } from './grounding';
import { clip, itemIds, LIMITS, type SnapshotT } from './snapshot';

export type BriefingKind = 'agent' | 'landlord' | 'developer' | 'my-agency';
export interface GroundingReport { checked: number; dropped: number; withheld: number }
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
  /** Labels of the snapshot items the priorities refer to (id → label), for display. */
  labels: Record<string, string>;
  /**
   * How many £/% figures were checked, how many statements were removed because a figure wasn't in
   * the data, and how many were withheld under the content rules (guarantees, protected characteristics).
   */
  grounding: GroundingReport;
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
    'Look for: listings with views but few enquiries, unanswered enquiries, long days live, recent price changes, few photos.',
    'Good actions: answer new enquiries, improve photos and material information, send the vendor an update.',
    'The snapshot has no price evidence (no sold prices or comparables). Never say a price is high, low or out of line with the area, and never suggest a price or a price change; where interest is weak, suggest the agency checks its own comparable evidence.',
    'priceChanges is null where price history isn’t recorded (agent-feed listings): never read that as “never reduced”.',
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
  'Never describe, rank or target areas, homes or people by who they are or who lives nearby (race, ethnicity, nationality, religion, sexual orientation, gender reassignment, age, disability), and never suggest marketing to or away from any group. Statements that do are removed automatically.',
].join('\n');

/**
 * Serialise data for an untrusted block. Runs of "<" or ">" are collapsed first, so no text in
 * the data can rebuild the block's "<<<"/">>>" delimiters (core's untrusted() strips them in a
 * single pass, so ">><<<>" would otherwise come out as ">>>").
 */
export function dataBlock(label: string, data: unknown, max: number) {
  return untrusted(label, JSON.stringify(data).replace(/<{2,}/g, '<').replace(/>{2,}/g, '>'), max);
}

/** Ask the model for a briefing, then keep only what the snapshot supports. */
export async function generateBriefing(kind: BriefingKind, snapshot: SnapshotT, meta: { userId?: string | null; source: Briefing['source'] }): Promise<Briefing> {
  const out = await chatJSON<BriefingOutT>([
    { role: 'system', content: `${HOUSE_RULES}\n\n${RULES}\n\n${AUDIENCE[kind]}` },
    { role: 'user', content: `Dashboard snapshot (JSON):\n${dataBlock('snapshot', snapshot, LIMITS.chars + 500)}` },
  ], BriefingOut, 'dashboard_briefing', { purpose: `briefing.${kind}`, userId: meta.userId ?? null, role: 'main', maxTokens: 2500, effort: 'low', timeoutMs: 90_000 });
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
  const labels = Object.fromEntries(snapshot.items.filter((i) => priorities.some((p) => p.relatedIds.includes(i.id))).map((i) => [i.id, i.label]));
  return {
    kind, headline, summary: g.prose(line(out.summary, 900)), priorities, labels,
    risks: short(out.risks, 5, 240), opportunities: short(out.opportunities, 5, 240), questions: short(out.questions, 4, 200),
    grounding: g.report, source, generatedAt: new Date().toISOString(),
  };
}

/* ───────────────────────── automation proposals ───────────────────────── */

export const ProposalsOut = S.obj({
  proposals: S.arr(S.obj({
    title: S.str('Imperative action title starting with its verb, under 90 characters.'),
    detail: S.str('What exactly would be prepared, one or two sentences.'),
    consequential: S.bool('True if it publishes, contacts anyone, books, spends money or changes records.'),
    rationale: S.str('Why, citing the findings. One or two sentences.'),
  }), 'One to four proposals.'),
});
type ProposalsOutT = Infer<typeof ProposalsOut>;

export interface AgentContext { id: string; name: string; serves: string; permissions: string[]; findings: string[]; toolsCalled: string[]; ruleProposals: { title: string; detail: string; consequential: boolean }[] }
export interface AiProposal { id: string; agent: string; title: string; detail: string; consequential: boolean; rationale: string }

/* Approval rule for AI proposals. Approval is the default: a proposal is treated as needing a
 * person's approval unless its title starts with a read-only verb (summarise, compare, check,
 * review, prepare, draft, generate…) AND neither title nor detail mentions anything that books,
 * contacts, publishes, spends or changes records. The model may add caution, never remove it. */

/** Inflected forms of a verb, including e-dropping and consonant-doubling ("reduce" → "reducing", "cancel" → "cancelling"). */
function forms(v: string): string[] {
  const out = new Set([v, `${v}s`, `${v}es`, `${v}d`, `${v}ed`, `${v}ing`]);
  if (v.endsWith('e')) out.add(`${v.slice(0, -1)}ing`);
  if (/[^aeiou]y$/.test(v)) { out.add(`${v.slice(0, -1)}ies`); out.add(`${v.slice(0, -1)}ied`); }
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(v)) { out.add(`${v}${v.at(-1)}ing`); out.add(`${v}${v.at(-1)}ed`); }
  return [...out];
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[- ]/g, '[- ]?');

/** Verbs that send, contact, publish, book, spend, sign or change something, in any form. */
const RISKY_VERBS = [
  // contacting people
  'send', 'e-mail', 'sms', 'whatsapp', 'notify', 'call', 'phone', 'respond', 'forward', 'invite', 'inform', 'tell', 'ask', 'chase', 'remind',
  'confirm', 'introduce', 'refer',
  // publishing and marketing
  'publish', 'advertise', 'relist', 'delist', 'unlist', 'upload', 'launch', 'promote', 'boost',
  // booking and instructing
  'book', 'arrange', 'instruct', 'hire', 'appoint', 'engage', 'assign', 'allocate', 'dispatch', 'inspect',
  // spending, agreeing, legal steps
  'pay', 'spend', 'invest', 'accept', 'reject', 'approve', 'authorise', 'authorize', 'renew', 'submit', 'serve', 'lodge', 'evict', 'terminate',
  'cancel', 'withdraw', 'proceed', 'execute', 'implement', 'deduct', 'withhold', 'retain', 'distribute', 'circulate', 'syndicate',
  // choosing between people or options on someone's behalf
  'pick', 'choose', 'select', 'shortlist',
  // changing records or listings
  'amend', 'edit', 'modify', 'alter', 'adjust', 'replace', 'remove', 'delete', 'archive', 'rename', 'refresh', 'swap', 'install',
];
/** Verbs that are often nouns here ("service charge", "open issues", "maintenance schedule", "under offer"): risky with an object. */
const RISKY_WITH_OBJECT = [
  'email', 'message', 'text', 'contact', 'reply', 'ring', 'share', 'post', 'list', 'visit', 'schedule', 'commission', 'order', 'buy', 'purchase',
  'bid', 'offer', 'fund', 'refund', 'charge', 'invoice', 'bill', 'discount', 'sell', 'transfer', 'decline', 'sign', 'apply', 'issue', 'file',
  'register', 'protect', 'request', 'change', 'update', 'lower', 'reduce', 'cut', 'increase', 'raise', 'decrease', 'complete', 'add', 'mark',
  'upgrade', 'downgrade', 'switch', 'fix', 'repair',
];
const IRREGULAR = ['sent', 'paid', 'bought', 'spent', 'sold', 'told', 'rang', 'rung', 'chose', 'chosen', 'withheld'];
const OBJECT = String.raw`(?:the|a|an|it|this|that|these|those|them|its|their|his|her|your|our|all|any|each|every|both|some|more|new|missing|U\d+|\d|to|by|on|as|with|price|prices|rent|rents|asking|listings?|descriptions?|photos?|images?|status|records?|tenanc(?:y|ies)|deposits?|notices?|section|lead|licen[cs]es?|quotes?|contracts?|viewings?|slots?|appointments?|works?|repairs?|engineers?|contractors?|tenants?|vendors?|buyers?|landlords?|applicants?|replacements?)`;
const PEOPLE = 'vendors?|sellers?|buyers?|purchasers?|tenants?|landlords?|applicants?|enquirers?|contractors?|engineers?|owners?|clients?|lenders?|solicitors?|conveyancers?|councils?|agents?|surveyors?|occupiers?|sharers?|residents?|neighbours?';
const alt = (xs: string[]) => [...new Set(xs)].map(esc).join('|');
/** Base and -ing forms, for "…and schedule viewings", "…then reducing the price". */
const plain = (v: string) => [v, `${v}ing`, ...(v.endsWith('e') ? [`${v.slice(0, -1)}ing`] : [])];
/** Anything in a proposal that reaches outside Streetkey or changes a record. */
export const RISKY = new RegExp([
  String.raw`\b(?:${alt([...RISKY_VERBS.flatMap(forms), ...IRREGULAR])})\b`,
  String.raw`\b(?:${alt(RISKY_WITH_OBJECT.flatMap(forms))})\s+${OBJECT}\b`,
  // a second action joined on: "review the listing and schedule viewings"
  String.raw`\b(?:and|then|or|to|before|after)\s+(?:${alt([...RISKY_VERBS, ...RISKY_WITH_OBJECT].flatMap(plain))})\b`,
  String.raw`\bappl(?:y|ies|ied|ying)\s+for\b|\bwrit(?:e|es|ing)\s+to\b|\bwrote\s+to\b|\bfollow(?:s|ed|ing)?[- ]?up\s+(?:with|on)\b|\bput\s+(?:it|the|this|them)\s+(?:\w+\s+){0,3}?(?:on|up)\b`,
  // talking with someone: "review price with the vendor", "an update to the tenant"
  String.raw`\b(?:with|to)\s+(?:the\s+|your\s+|a\s+|an\s+|each\s+|every\s+|all\s+|both\s+)?(?:[A-Za-z0-9]+\s+)?(?:${PEOPLE})\b`,
  // putting a listing live: "go live", "prepare the go-live", "make the listing live"
  String.raw`\bgo(?:es|ing)?[- ]?live\b|\bwent[- ]live\b|\bmak(?:e|es|ing)\s+(?:it|them|this|that|U\d+|(?:the|your|its|their)\s+(?:\w+\s+){0,2}?(?:listings?|ads?|adverts?|advertisements?|homes?|propert(?:y|ies)|units?|rooms?|flats?))\s+live\b|\bput\s+(?:\w+\s+){0,3}?live\b`,
  // legal steps and money taken from a deposit, whatever the wording: "an eviction plan", "a deposit deduction"
  String.raw`\bevict(?:ion|ions)?\b|\bpossession\s+(?:claims?|orders?|proceedings?|notices?|hearings?)\b|\bsection\s?(?:8|13|21)\b|\bdeductions?\b|\bwithholding\b`,
].join('|'), 'i');
/** Read-only starts: work that only prepares something for a person to look at. */
const READ_ONLY_START = /^(?:summari[sz](?:e|ing)|compar(?:e|ing)|(?:re-?)?check(?:ing)?|review(?:ing)?|prepar(?:e|ing)|draft(?:ing)?|generat(?:e|ing)|compil(?:e|ing)|collat(?:e|ing)|analy[sz](?:e|ing)|assess(?:ing)?|estimat(?:e|ing)|calculat(?:e|ing)|identif(?:y|ying)|highlight(?:ing)?|monitor(?:ing)?|track(?:ing)?|watch(?:ing)?|read(?:ing)?|outlin(?:e|ing)|research(?:ing)?)\b/i;

/** Does this proposal need a person's approval? True unless it is clearly read-only. */
export function needsApproval(title: string, detail: string): boolean {
  const t = title.trim();
  // Joined with a separator, so a verb at the end of the title can't take the detail's first word as its object.
  return !READ_ONLY_START.test(t) || RISKY.test(`${t} | ${detail}`);
}

/**
 * Choosing, ranking, accepting or turning down applicants or tenants. Agents never make these
 * decisions, so such proposals are withheld outright rather than queued for approval (an approval
 * would make the AI's pick look like a recommendation). Repairs or requests from a tenant don't match:
 * "approve the tenant's repair request" is about the request, not the person.
 */
const PICK_VERB = String.raw`(?:pick|choos|chose|select|shortlist|accept|reject|refus|decline|approv|rank|vet|prefer|favou?r|turn(?:s|ed|ing)?\s+down|rule(?:s|d)?\s+out)\w*`;
const APPLICANT = String.raw`(?:applicants?|applications?|candidates?|tenants?|prospective\s+tenants?|renters?|households?|occupiers?|lodgers?|sharers?)(?!['’]s)`;
const SELECTS_PEOPLE = new RegExp([
  String.raw`\b${PICK_VERB}\s+(?:(?:the|a|an|one|which|this|that|these|those|best|strongest|weakest|top|preferred|successful|unsuccessful|new|prospective|suitable|unsuitable|right|most|least|ideal|tenancy|rental|their|your)\s+){0,3}${APPLICANT}\b`,
  // offering the home to one particular applicant
  String.raw`\b(?:offer|let|rent|give)(?:s|ed|ing)?\s+(?:(?:it|them|the\s+\w+|U\d+)\s+)?to\s+(?:the\s+|an?\s+)?(?:applicant|candidate|household)s?\b`,
  String.raw`\b(?:who|which\s+(?:applicant|tenant|household)s?)\s+(?:to|should)\s+(?:let|rent|offer|accept|choose|pick|select)\b`,
].join('|'), 'i');
export const selectsPeople = (title: string, detail: string, rationale = '') => SELECTS_PEOPLE.test(`${title} | ${detail} | ${rationale}`);

export async function generateProposals(agent: AgentContext, context: SnapshotT | null, meta: { userId?: string | null }) {
  const system = [
    HOUSE_RULES,
    `You plan next actions for Streetkey’s “${agent.name}” (serves ${agent.serves}). It can only act within these permissions: ${agent.permissions.join(', ')}.`,
    'You never execute anything. You propose actions; a named person approves anything consequential (publishing, contacting anyone, booking, spending money, changing listing or tenancy records).',
    'Base proposals only on the findings and data given. Quote £ and % figures exactly as given; never calculate new ones. Proposals with unsupported figures are removed automatically.',
    'userContext, when present, is extra data from the signed-in person (for example proposals already awaiting their approval): do not repeat proposals that are already waiting.',
    'Propose one to four actions, most useful first. Plain British English, no markdown.',
    'Never propose discriminating between people, pressuring buyers or tenants, unlawful eviction steps, banned tenant fees, or misleading listing claims.',
    'Never propose choosing, ranking, accepting or rejecting applicants or tenants: those decisions are made by people, never by agents. Proposals that do are removed automatically.',
  ].join('\n');
  const data = { agent: { id: agent.id, name: agent.name, permissions: agent.permissions, toolsCalled: agent.toolsCalled }, findings: agent.findings, ruleBasedProposals: agent.ruleProposals, ...(context ? { userContext: context } : {}) };
  const out = await chatJSON<ProposalsOutT>([
    { role: 'system', content: system },
    { role: 'user', content: `Agent findings and data (JSON):\n${dataBlock('agent_run', data, LIMITS.chars + 6000)}` },
  ], ProposalsOut, 'agent_proposals', { purpose: `automation.${agent.id}`, userId: meta.userId ?? null, role: 'fast', maxTokens: 1500, effort: 'low' });
  return groundProposals(agent, context, out);
}

export interface ProposalsResult { proposals: AiProposal[]; grounding: GroundingReport }

export function groundProposals(agent: AgentContext, context: SnapshotT | null, out: ProposalsOutT): ProposalsResult {
  const g = new Grounding({ findings: agent.findings, rules: agent.ruleProposals, context });
  const stamp = Date.now().toString(36);
  const seen = new Set<string>();
  const shaped = out.proposals.map((p) => ({ title: clip(p.title, 120), detail: clip(p.detail, 400), rationale: clip(p.rationale, 400), consequential: p.consequential })).filter((p) => {
    if (!p.title) return false;
    // The same proposal twice in one run (case, punctuation and articles aside) is shown once.
    const k = normTitle(p.title);
    if (seen.has(k)) return false;
    seen.add(k);
    // Agents never choose or reject applicants or tenants: withheld, not queued for approval.
    if (selectsPeople(p.title, p.detail, p.rationale)) { g.withhold(); return false; }
    return true;
  });
  const proposals: AiProposal[] = g.list(shaped, (p) => [p.title, p.detail, p.rationale]).slice(0, 4).map((p, i) => ({
    id: `ai-${agent.id}-${stamp}-${i}`, agent: agent.id, title: p.title, detail: p.detail, rationale: p.rationale,
    // Approval by default: the model may add caution, never remove it.
    consequential: p.consequential || needsApproval(p.title, p.detail),
  }));
  return { proposals, grounding: g.report };
}

/**
 * Proposals that are already waiting for approval (the titles the website sends as context) are
 * left out, whether or not the AI saw that context, so repeated runs never queue the same thing twice.
 */
export function withoutWaiting<T extends { title: string }>(proposals: T[], waitingTitles: string[]): { kept: T[]; repeats: number } {
  const waiting = new Set(waitingTitles.map(normTitle).filter(Boolean));
  const kept = proposals.filter((p) => !waiting.has(normTitle(p.title)));
  return { kept, repeats: proposals.length - kept.length };
}
