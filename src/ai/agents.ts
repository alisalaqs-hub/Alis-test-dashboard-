/**
 * Streetkey multi-agent runtime (prototype).
 *
 * Each agent has: a role, an explicit permission set, a schedule, and a run()
 * that calls deterministic tools and returns findings + proposed actions.
 * Proposed actions classed "consequential" (publishing, contacting people,
 * spending money, changing tenancy records) are NEVER executed by the agent:
 * they enter an approval queue and are logged.
 *
 * Production: runs on a job scheduler (e.g. Temporal); an LLM plans which
 * tools to call within the agent's permission scope; every tool call and
 * approval is written to the immutable audit log.
 */
import { baseListings, type Property } from '../data/properties';
import { benchmark, engagementFor, insightsFor, totals } from '../engine/engagement';
import { dealScore, refurbInputFor } from '../engine/insights';
import { compareQuotes, DEFAULT_INPUT, estimateRefurb } from '../engine/refurb';
import { developmentOptions } from '../engine/development';
import { valuationScenario } from '../engine/valuation';
import { weeklyOwnerReport } from '../engine/reports';

export type Permission =
  | 'listings:read' | 'listings:propose-edit' | 'engagement:read-aggregate' | 'messages:draft' | 'reports:generate'
  | 'estimates:run' | 'quotes:read' | 'portfolio:read' | 'compliance:read' | 'maintenance:propose' | 'market:read' | 'documents:read';

export interface ProposedAction { id: string; agent: string; title: string; detail: string; consequential: boolean; payload?: string }
export interface AgentRun { agent: string; ranAt: string; findings: string[]; proposals: ProposedAction[]; toolsCalled: string[] }
export interface AgentDef { id: string; name: string; serves: string; permissions: Permission[]; schedule: string; run: () => AgentRun }

const now = () => new Date().toISOString();
const street = (p: Property) => p.street.replace(' (fictional)', '');
/**
 * The agents only ever run over Streetkey's fictional demonstration homes. The shared listing
 * registry also holds real listings once the website has loaded them, and those must never get
 * simulated engagement, "low conversion" findings or proposals.
 */
const demo = () => baseListings();
const sale = () => demo().filter((p) => p.listing !== 'rent');

export const AGENTS: AgentDef[] = [
  { id: 'buyer', name: 'Buyer agent', serves: 'Property buyers', schedule: 'On new listing · daily 07:00', permissions: ['listings:read', 'estimates:run', 'messages:draft'], run: () => {
    const hits = sale().filter((p) => p.beds >= 3 && p.price <= 500_000 && p.type !== 'commercial').map((p) => ({ p, ds: dealScore(p) })).sort((a, b) => b.ds.total - a.ds.total).slice(0, 3);
    return { agent: 'buyer', ranAt: now(), toolsCalled: ['search.runSearch', 'insights.dealScore'], findings: hits.map((h) => `${street(h.p)} matches saved search “3-bed under £500k” — deal score ${h.ds.total}`), proposals: [{ id: `buyer-${Date.now()}`, agent: 'buyer', title: `Request viewing at ${street(hits[0].p)}`, detail: 'Draft viewing request to the listing agent with three time slots.', consequential: true }] };
  } },
  { id: 'seller', name: 'Seller agent', serves: 'Property owners', schedule: 'Weekly · Monday 08:00', permissions: ['engagement:read-aggregate', 'reports:generate', 'listings:propose-edit'], run: () => {
    const p = demo()[0]; const ins = insightsFor(p);
    return { agent: 'seller', ranAt: now(), toolsCalled: ['engagement.insightsFor', 'reports.weeklyOwnerReport'], findings: ins.slice(0, 3).map((i) => i.title), proposals: ins.filter((i) => i.kind === 'recommendation').map((i, k) => ({ id: `seller-${k}-${Date.now()}`, agent: 'seller', title: i.title, detail: i.evidence.join('; '), consequential: true })) };
  } },
  { id: 'estate-agent', name: 'Agency agent', serves: 'Estate agents', schedule: 'Daily 07:30', permissions: ['engagement:read-aggregate', 'reports:generate', 'messages:draft', 'listings:propose-edit'], run: () => {
    const weak = sale().filter((p) => p.type !== 'commercial').map((p) => ({ p, t: totals(engagementFor(p)), bm: benchmark(p) })).filter((x) => x.t.enquiryRate.high < x.bm.rate.low);
    return { agent: 'estate-agent', ranAt: now(), toolsCalled: ['engagement.totals', 'engagement.benchmark', 'reports.weeklyOwnerReport'], findings: [`${weak.length} listing(s) with conversion clearly below comparables`, ...weak.map((w) => street(w.p))],
      proposals: weak.slice(0, 2).map((w, k) => ({ id: `agency-${k}-${Date.now()}`, agent: 'estate-agent', title: `Send weekly report to owner of ${street(w.p)}`, detail: 'Draft report generated; email to vendor requires approval.', consequential: true, payload: weeklyOwnerReport(w.p, 'agent-draft') })) };
  } },
  { id: 'landlord', name: 'Landlord agent', serves: 'Landlords', schedule: 'Daily 06:00', permissions: ['portfolio:read', 'compliance:read', 'maintenance:propose', 'messages:draft'], run: () => ({ agent: 'landlord', ranAt: now(), toolsCalled: ['compliance.calendar'], findings: ['Gas safety certificate for U3 due in 11 days', 'U2 EICR due in 22 days', 'U4 void for 18 days'], proposals: [{ id: `ll-${Date.now()}`, agent: 'landlord', title: 'Book Gas Safe engineer for U3 (Cranwell St)', detail: 'Request slots from 2 verified engineers; tenant access notice drafted (24h minimum).', consequential: true }] }) },
  { id: 'investor', name: 'Investor agent', serves: 'Investors', schedule: 'On new listing', permissions: ['listings:read', 'estimates:run', 'reports:generate'], run: () => {
    const best = sale().map((p) => ({ p, ds: dealScore(p) })).sort((a, b) => b.ds.total - a.ds.total)[0];
    return { agent: 'investor', ranAt: now(), toolsCalled: ['insights.dealScore', 'investment.analyse'], findings: [`Highest-scoring opportunity: ${street(best.p)} (${best.ds.total}/100, ${best.ds.grade})`], proposals: [{ id: `inv-${Date.now()}`, agent: 'investor', title: `Generate investment pack for ${street(best.p)}`, detail: 'PDF with underwriting, scenarios and sensitivity.', consequential: false }] };
  } },
  { id: 'developer', name: 'Developer agent', serves: 'Developers', schedule: 'Weekly', permissions: ['listings:read', 'market:read', 'estimates:run'], run: () => {
    const opps = demo().flatMap((p) => developmentOptions(p).filter((o) => (o.id === 'subdivide' || o.id === 'classma') && (o.valueUplift ?? 0) > 0).map((o) => ({ p, o })));
    return { agent: 'developer', ranAt: now(), toolsCalled: ['development.developmentOptions'], findings: opps.map(({ p, o }) => `${street(p)}: ${o.name} — ${o.status}`), proposals: [] };
  } },
  { id: 'contractor', name: 'Contractor agent', serves: 'Contractors', schedule: 'On quote received', permissions: ['quotes:read', 'estimates:run'], run: () => {
    const est = estimateRefurb(DEFAULT_INPUT);
    const [c] = compareQuotes(est, [{ contractor: 'Forest Gate Renovations (demo)', programmeWeeks: 12, verified: true, lines: Object.fromEntries(est.byTrade.filter((t) => t.trade !== 'Damp & timber').map((t) => [t.trade, t.total * (t.trade === 'Electrical' ? 0.6 : 1)])) }]);
    return { agent: 'contractor', ranAt: now(), toolsCalled: ['refurb.compareQuotes'], findings: [`Quote from ${c.contractor}: ${c.missing.length} trade(s) missing (${c.missing.join(', ')})`, ...c.rows.filter((r) => r.flag === 'low' || r.flag === 'high').map((r) => `${r.trade} ${Math.round((r.variance ?? 0) * 100)}% vs benchmark`)], proposals: [{ id: `con-${Date.now()}`, agent: 'contractor', title: 'Ask contractor to clarify electrical scope & missing damp works', detail: 'Draft clarification message.', consequential: true }] };
  } },
  { id: 'manager', name: 'Property manager agent', serves: 'Property managers', schedule: 'Hourly', permissions: ['portfolio:read', 'maintenance:propose', 'documents:read'], run: () => {
    const missing = sale().filter((p) => !p.documents || !p.documents.some((d) => /EPC/.test(d)));
    const v = valuationScenario(demo()[0]); void refurbInputFor;
    return { agent: 'manager', ranAt: now(), toolsCalled: ['documents.checklist', 'maintenance.triage'], findings: [`${missing.length} listings missing an uploaded EPC document`, 'Mould report M-1039 open 5 days — escalate', `Valuation evidence for Ashcombe Grove: ${v.evidenceCount} comps`], proposals: [{ id: `pm-${Date.now()}`, agent: 'manager', title: 'Request missing EPC documents from 8 owners', detail: 'Templated request email.', consequential: true }] };
  } },
];

/* ───────────── approval queue (shared by the website store and the server) ───────────── */

/** The most proposals that can wait for approval at once. Nothing pending is ever dropped to make room. */
export const QUEUE_CAP = 50;

/** Normalised proposal title: case, quotes, punctuation, articles and spacing don't make a new proposal. */
export function normTitle(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[‘’'`"“”]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9£%]+/g, ' ')
    .replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Two proposals from the same agent with the same normalised title are the same proposal. */
export const proposalKey = (agent: string, title: string) => `${agent}|${normTitle(title)}`;

export interface QueueMerge {
  queue: ProposedAction[];
  /** Consequential proposals added to the queue. */
  added: ProposedAction[];
  /** Consequential proposals not added because the same one is already waiting (or repeated in this batch). */
  duplicates: ProposedAction[];
  /** Consequential proposals not added because the queue is full. */
  full: ProposedAction[];
  /** Proposals that need no approval (recorded, never queued). */
  other: ProposedAction[];
}

/**
 * Add proposals to the approval queue: only consequential ones are queued, a proposal already
 * waiting is not queued twice, and when the queue is full new ones are turned away rather
 * than older pending ones being dropped without a decision.
 */
export function mergeQueue(queue: ProposedAction[], incoming: ProposedAction[], cap = QUEUE_CAP): QueueMerge {
  const seen = new Set(queue.map((q) => proposalKey(q.agent, q.title)));
  const out: QueueMerge = { queue, added: [], duplicates: [], full: [], other: [] };
  for (const a of incoming) {
    if (!a.consequential) { out.other.push(a); continue; }
    const k = proposalKey(a.agent, a.title);
    if (seen.has(k)) { out.duplicates.push(a); continue; }
    if (queue.length + out.added.length >= cap) { out.full.push(a); continue; }
    seen.add(k);
    out.added.push(a);
  }
  out.queue = out.added.length ? [...out.added, ...queue] : queue;
  return out;
}
