/**
 * AI briefings for professional dashboards (agents, landlords, developers) and AI proposals
 * for the automation agents.
 *
 *   POST /api/ai/briefing          { kind, snapshot }   → { briefing, cached, jobId }
 *     kind 'agent' | 'landlord' | 'developer': grounded in the snapshot the dashboard sends
 *     kind 'my-agency': signed-in agency members; the snapshot is built here from their live listings
 *     Results are cached for an hour per snapshot. Generation runs as a background job
 *     (202 + jobId to poll at /api/ai/jobs/:id) unless it is already cached.
 *
 *   POST /api/ai/automation/run    { agent, context? }  → { proposals, findings, … }
 *     Runs the agent's deterministic tools (src/ai/agents.ts, demo data), then asks the AI to
 *     propose next actions. Nothing is executed. Every AI proposal needs approval unless it is
 *     clearly read-only (see needsApproval in ai/briefing/generate.ts).
 *     Signed-in people may add a bounded context snapshot; visitors get demo data only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENTS } from '../../../src/ai/agents';
import { cached } from '../ai/core';
import { aiGuard } from '../ai/guard';
import { enqueue, registerJob } from '../ai/jobs';
import { agencySnapshot } from '../ai/briefing/agency';
import { generateBriefing, generateProposals, type AgentContext, type Briefing, type BriefingKind } from '../ai/briefing/generate';
import { clip, hashOf, Snapshot, type SnapshotT } from '../ai/briefing/snapshot';
import { HttpError, parse, requireUser } from '../services/http';

const TTL_SEC = 3600;
// v2: type-aware figure grounding and approval-by-default for AI proposals (older cached results are not reused).
const VERSION = 'v2';
const JOB = 'ai.briefing';
const AGENT_IDS = AGENTS.map((a) => a.id);

const BriefingBody = z.strictObject({
  kind: z.enum(['agent', 'landlord', 'developer', 'my-agency']),
  snapshot: Snapshot.optional(),
}).superRefine((b, ctx) => {
  if (b.kind !== 'my-agency' && !b.snapshot) ctx.addIssue({ code: 'custom', path: ['snapshot'], message: 'Send the dashboard snapshot to brief on.' });
});

const AutomationBody = z.strictObject({
  agent: z.string().trim().max(40).refine((id) => AGENT_IDS.includes(id), { message: `Choose one of the Streetkey agents: ${AGENT_IDS.join(', ')}.` }),
  context: Snapshot.optional(),
});

interface BriefingJobInput { kind: BriefingKind; snapshot: SnapshotT; key: string; source: Briefing['source'] }

/** Read the cache without computing (null when there is no fresh entry). */
const MISS = Symbol('miss');
async function peek<T>(key: string): Promise<T | null> {
  try { return await cached<T>(key, TTL_SEC, async () => { throw MISS; }); } catch (e) { if (e === MISS) return null; throw e; }
}

export async function aiBriefingRoutes(app: FastifyInstance) {
  registerJob(JOB, async (job, ctx) => {
    const input = job.input as BriefingJobInput;
    const snapshot = Snapshot.parse(input.snapshot);
    await ctx.progress('Reading your dashboard');
    return cached(input.key, TTL_SEC, () => generateBriefing(input.kind, snapshot, { userId: job.user_id, source: input.source }));
  }, { maxAttempts: 2, leaseSec: 180 });

  app.post('/api/ai/briefing', async (req, reply) => {
    const { userId } = await aiGuard(req, 'briefing', { perMinute: 6, perHour: 40 });
    const b = parse(BriefingBody, req.body ?? {});
    let snapshot: SnapshotT;
    let source: Briefing['source'] = 'dashboard';
    let scope = 'dashboard';
    if (b.kind === 'my-agency') {
      // Never trust the browser for live figures: build them from the agency's own listings.
      const u = requireUser(req);
      const built = await agencySnapshot(u.id);
      if (built.empty) throw new HttpError(409, 'Your agency has no live listings on Streetkey yet. Once listings are live, the briefing uses their views, saves and enquiries.', 'no_live_listings');
      snapshot = built.snapshot; source = 'live'; scope = `org:${[...built.orgIds].sort().join(',')}`;
    } else {
      snapshot = b.snapshot!;
    }
    const hash = hashOf(snapshot);
    const key = `briefing:${VERSION}:${b.kind}:${scope}:${hash}`;
    const hit = await peek<Briefing>(key);
    if (hit) return { briefing: hit, cached: true, jobId: null };

    const input: BriefingJobInput = { kind: b.kind, snapshot, key, source };
    const job = await enqueue(JOB, input, { userId, subject: userId ? `briefing:${userId}:${hash.slice(0, 24)}` : `anon:briefing:${hash.slice(0, 24)}`, dedupe: true });
    if (job.status === 'done') return { briefing: job.output as Briefing, cached: false, jobId: job.id };
    if (job.status === 'failed') throw new HttpError(502, job.error ?? 'The AI couldn’t write a briefing just now. Please try again.', 'ai_failed');
    return reply.code(202).send({ briefing: null, cached: false, jobId: job.id });
  });

  app.post('/api/ai/automation/run', async (req) => {
    const { userId } = await aiGuard(req, 'automation', { perMinute: 6, perHour: 40 });
    const b = parse(AutomationBody, req.body ?? {});
    const def = AGENTS.find((a) => a.id === b.agent)!;
    const run = def.run(); // deterministic tools over Streetkey's demo data
    const agent: AgentContext = {
      id: def.id, name: def.name, serves: def.serves, permissions: def.permissions, toolsCalled: run.toolsCalled,
      findings: run.findings.slice(0, 20).map((f) => clip(f, 240)),
      ruleProposals: run.proposals.slice(0, 6).map((p) => ({ title: clip(p.title, 160), detail: clip(p.detail, 300), consequential: p.consequential })),
    };
    // Visitors get demo data only; signed-in people may add a bounded snapshot of what they see.
    const context: SnapshotT | null = userId ? b.context ?? null : null;
    let fresh = false;
    const key = `automation:${VERSION}:${def.id}:${hashOf({ agent, context })}`;
    const out = await cached(key, TTL_SEC, async () => { fresh = true; return generateProposals(agent, context, { userId }); });
    // New ids every run, so repeated runs can sit side by side in the approval queue.
    const stamp = Date.now().toString(36);
    return {
      agent: def.id, basis: context ? 'demo+context' : 'demo', cached: !fresh,
      findings: run.findings, toolsCalled: run.toolsCalled,
      proposals: out.proposals.map((p, i) => ({ ...p, id: `ai-${def.id}-${stamp}-${i}` })),
      grounding: out.grounding,
    };
  });
}
