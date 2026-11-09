import { useRef, useState } from 'react';
import { AGENTS, type AgentRun, type Permission } from '../ai/agents';
import { AiButton, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/briefing.css';
import { Section, Tag } from '../components/ui';
import { ApiError } from '../lib/api';
import { announce, useAi } from '../lib/ai/core';
import { queueContext, runAgentWithAi, toProposedActions, type AutomationResult } from '../lib/ai/briefing';
import { useStore, type EnqueueResult } from '../store';

const ALL_PERMS: Permission[] = ['listings:read', 'listings:propose-edit', 'engagement:read-aggregate', 'messages:draft', 'reports:generate', 'estimates:run', 'quotes:read', 'portfolio:read', 'compliance:read', 'maintenance:propose', 'market:read', 'documents:read'];

/** An AI run and what the approval queue did with its proposals. */
interface AiRunState { r: AutomationResult; queue: EnqueueResult }
const NOTHING_QUEUED: EnqueueResult = { added: [], duplicates: [], full: [] };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence on what happened to proposals sent to the approval queue ('' when nothing was sent). */
function queueSummary(q: EnqueueResult, alreadyLeftOut = 0): string {
  const waiting = q.duplicates.length + alreadyLeftOut;
  return [
    q.added.length ? `${q.added.length} added to the approval queue.` : '',
    waiting ? `${waiting} already waiting for your approval, so not added again.` : '',
    q.full.length ? `${q.full.length} not added because the approval queue is full: approve or reject some waiting items first.` : '',
  ].filter(Boolean).join(' ');
}

export default function Automation() {
  const [runs, setRuns] = useState<Record<string, { run: AgentRun; queue: EnqueueResult }>>({});
  const [aiRuns, setAiRuns] = useState<Record<string, AiRunState>>({});
  const [aiErrors, setAiErrors] = useState<Record<string, ApiError | null>>({});
  const [aiBusy, setAiBusy] = useState<Record<string, boolean>>({});
  const busy = useRef(new Set<string>());
  const { queue, decide, enqueue, audit, log } = useStore();
  const ai = useAi();

  /** Built-in run: deterministic tools over demo data (always available). */
  const run = (id: string) => {
    const a = AGENTS.find((x) => x.id === id)!;
    const r = a.run();
    log(`agent:${id}`, 'run', `${r.toolsCalled.join(', ')} → ${r.findings.length} findings, ${r.proposals.length} proposals`);
    const q = enqueue(r.proposals);
    setRuns((x) => ({ ...x, [id]: { run: r, queue: q } }));
    return { a, r, q };
  };
  const runOne = (id: string) => {
    const { a, r, q } = run(id);
    announce(`${a.name}: ${plural(r.findings.length, 'finding')}. ${queueSummary(q) || 'Nothing sent to the approval queue.'}`);
  };
  const runAll = () => {
    const results = AGENTS.map((a) => run(a.id));
    const added = results.reduce((n, x) => n + x.q.added.length, 0);
    const waiting = results.reduce((n, x) => n + x.q.duplicates.length, 0);
    announce(`All ${AGENTS.length} agents ran. ${added ? `${added} proposals added to the approval queue.` : 'No new proposals for the approval queue.'}${waiting ? ` ${waiting} already waiting.` : ''}`);
  };

  /** AI run: the same tools on the server, then the AI proposes next steps. It never executes anything. */
  const runAi = async (id: string) => {
    if (busy.current.has(id)) return; // already running: the button stays focusable while busy, so ignore repeat presses
    const a = AGENTS.find((x) => x.id === id)!;
    busy.current.add(id);
    setAiBusy((x) => ({ ...x, [id]: true }));
    setAiErrors((x) => ({ ...x, [id]: null }));
    try {
      const r = await runAgentWithAi(id, queueContext(queue, id));
      const queued = toProposedActions(r); // only proposals that need approval
      log(`agent:${id}`, 'AI run', `${r.toolsCalled.join(', ')} → ${r.proposals.length} AI proposals (${queued.length} need approval)`);
      // Suggestions that need no approval are never carried out: record them as suggestions, not as completed work.
      r.proposals.filter((p) => !p.consequential).forEach((p) => log(`agent:${id}`, 'AI suggestion (not executed)', p.title));
      const q = queued.length ? enqueue(queued) : NOTHING_QUEUED;
      setAiRuns((x) => ({ ...x, [id]: { r, queue: q } }));
      const summary = queueSummary(q, r.alreadyWaiting ?? 0);
      announce(`${a.name}: ${plural(r.proposals.length, 'AI proposal')}.${summary ? ` ${summary}` : ''} Nothing has been sent, booked or changed.`);
    } catch (e) {
      // AiErrorNote announces the problem itself (role="alert").
      setAiErrors((x) => ({ ...x, [id]: e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.') }));
    } finally {
      busy.current.delete(id);
      setAiBusy((x) => ({ ...x, [id]: false }));
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI agents & automation</div><h2 style={{ marginTop: 6 }}>Eight role-based agents. Humans approve what matters.</h2>
          <p className="muted" style={{ marginTop: 6 }}>Each agent has an explicit permission scope, a schedule and deterministic tools. They monitor, analyse and draft — publishing, messaging and spending always wait for approval, and every step is logged.</p>
          {ai.available
            ? <p className="small muted" style={{ marginTop: 6 }}><b>Run with AI</b> uses the same tools, then Streetkey AI proposes next steps from the findings. Anything beyond preparing something for you to read goes to the approval queue; the rest are suggestions only. The AI never sends, books or changes anything.</p>
            : <AiUnavailable reason={ai.reason} feature="AI planning for agents" />}
        </div>
        <div className="row"><button className="btn" onClick={runAll}>Run all agents now</button></div>
      </div>

      {/* One column on phones: AI proposals need the full width to stay readable. */}
      <div className="grid g4">
        {AGENTS.map((a) => (
          <div key={a.id} className="card ai-card stack" style={{ gap: 8 }}>
            <div className="row between"><b>{a.name}</b><Tag kind="neutral">{a.serves}</Tag></div>
            <div className="xs muted">⏱ {a.schedule}</div>
            <div className="row" style={{ gap: 4 }}>{a.permissions.map((p) => <span key={p} className="mono xs" style={{ background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5 }}>{p}</span>)}</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" aria-label={`Run now: ${a.name} (built-in rules)`} onClick={() => runOne(a.id)}>Run now</button>
              {ai.available && (
                <AiButton size="sm" busy={!!aiBusy[a.id]} aria-label={`Run with AI: ${a.name}`} onClick={() => void runAi(a.id)}>Run with AI</AiButton>
              )}
            </div>
            {aiBusy[a.id] && <AiThinking label={`${a.name} is working with Streetkey AI`} />}
            <AiErrorNote error={aiErrors[a.id] ?? null} onRetry={() => void runAi(a.id)} />
            {aiErrors[a.id] && <p className="xs muted" style={{ margin: 0 }}>“Run now” still works with the built-in rules.</p>}
            {runs[a.id] && <BuiltInRunView run={runs[a.id].run} queue={runs[a.id].queue} />}
            {aiRuns[a.id] && <AiRunView r={aiRuns[a.id].r} queue={aiRuns[a.id].queue} />}
          </div>
        ))}
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Approval queue" kicker="Consequential actions" right={<Tag kind="neutral">{queue.length} pending</Tag>}>
            {queue.length === 0 ? <p className="small muted">Run an agent to see its proposals here.</p> : <ul className="clean">{queue.map((q) => (
              <li key={q.id} className="row between card flat" style={{ padding: 10, flexWrap: 'nowrap' }}>
                <div className="small"><b>{q.title}</b> {q.id.startsWith('ai-') && <AiLabel>AI proposal</AiLabel>}<div className="xs muted">{q.agent} · {q.detail}</div></div>
                <div className="row" style={{ flexWrap: 'nowrap' }}><button className="btn sm" aria-label={`Approve: ${q.title}`} onClick={() => decide(q.id, true)}>Approve</button><button className="btn ghost sm" aria-label={`Reject: ${q.title}`} onClick={() => decide(q.id, false)}>Reject</button></div>
              </li>
            ))}</ul>}
            <p className="xs muted" style={{ marginTop: 8 }}>Prototype: approving records the decision only. Production executes the approved action with the approver’s identity attached. A proposal already waiting isn’t added twice, and nothing waiting is ever dropped to make room.</p>
          </Section>
          <Section title="Permission matrix" kicker="Least privilege">
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Permission</th>{AGENTS.map((a) => <th key={a.id} className="r" title={a.name}>{a.name.split(' ')[0]}</th>)}</tr></thead>
              <tbody>{ALL_PERMS.map((p) => <tr key={p}><td className="mono xs">{p}</td>{AGENTS.map((a) => <td key={a.id} className="r">{a.permissions.includes(p) ? '●' : ''}</td>)}</tr>)}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>No agent can read individual visitor data, tenant personal data or another organisation’s records; engagement access is aggregate-only.</p>
          </Section>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Audit log" kicker="Immutable in production">
            {audit.length === 0 ? <p className="small muted">No events yet.</p> : (
              // Focusable, so keyboard users can scroll it in every browser.
              <div tabIndex={0} role="region" aria-label="Audit log" style={{ maxHeight: 420, overflow: 'auto' }}>
                <ul className="clean xs mono">{audit.slice(0, 40).map((a, i) => <li key={i}>{a.at.slice(5, 19).replace('T', ' ')} <b>{a.actor}</b> {a.action} — {a.detail}</li>)}</ul>
              </div>
            )}
          </Section>
          <Section title="Guardrails">
            <ul className="ticks small">
              <li>Agents call deterministic tools. AI text is checked: a £ or % figure must match a money or percentage figure in the tool results, and statements whose figures don’t match are removed. Check important figures before acting.</li>
              <li>Consequential actions (publish, message, book, spend, change tenancy records) require a named human approver. AI proposals need approval unless they only prepare something for you to read; the AI can add that requirement, never remove it.</li>
              <li>Tenant eligibility decisions are never made by agents: AI proposals that choose, rank, accept or reject applicants or tenants are removed.</li>
              <li>Per-agent rate limits, kill switch and full replay from the audit log.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}

function BuiltInRunView({ run, queue }: { run: AgentRun; queue: EnqueueResult }) {
  const summary = queueSummary(queue);
  return (
    <div className="answer xs">
      <b>Findings</b><ul>{run.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
      {run.proposals.length > 0 && <><b>Proposed</b><ul>{run.proposals.map((p) => <li key={p.id}>{p.title} {p.consequential ? <Tag kind="warn">needs approval</Tag> : <Tag kind="ok">auto</Tag>}</li>)}</ul></>}
      {summary && <p className="muted" style={{ margin: '4px 0 0' }}>{summary}</p>}
      <div className="muted" style={{ marginTop: 4 }}>tools: {run.toolsCalled.join(', ')}</div>
    </div>
  );
}

function AiRunView({ r, queue }: { r: AutomationResult; queue: EnqueueResult }) {
  const needApproval = r.proposals.filter((p) => p.consequential).length;
  const suggestions = r.proposals.length - needApproval;
  const summary = queueSummary(queue, r.alreadyWaiting ?? 0);
  const withheld = r.grounding.withheld ?? 0;
  const suggestionText = suggestions === 0 ? ''
    : needApproval === 0
      ? `${suggestions === 1 ? 'This is a suggestion' : `These ${suggestions} are suggestions`} only and ${suggestions === 1 ? 'hasn’t' : 'haven’t'} been carried out.`
      : `${suggestions === 1 ? 'The other is a suggestion' : `The other ${suggestions} are suggestions`} only and ${suggestions === 1 ? 'hasn’t' : 'haven’t'} been carried out.`;
  return (
    <div className="answer xs aib-run">
      <div className="row between"><AiLabel>AI proposals</AiLabel><span className="muted">{r.basis === 'demo' ? 'From demo data' : 'Demo data + your queue'}</span></div>
      {r.proposals.length === 0
        ? <p className="muted" style={{ margin: 0 }}>{r.alreadyWaiting ? 'Everything the AI proposed is already waiting for your approval.' : 'The AI had nothing it could back up from these findings.'}</p>
        : <ul>{r.proposals.map((p) => (
          <li key={p.id}>
            <b>{p.title}</b> {p.consequential ? <Tag kind="warn">needs approval</Tag> : <Tag kind="neutral">suggestion only</Tag>}
            <p className="muted">{p.rationale}</p>
          </li>
        ))}</ul>}
      {r.grounding.dropped > 0 && <p className="muted" style={{ margin: 0 }}>{r.grounding.dropped} AI suggestion{r.grounding.dropped === 1 ? ' was' : 's were'} removed because their figures weren’t in the findings.</p>}
      {withheld > 0 && <p className="muted" style={{ margin: 0 }}>{withheld} AI suggestion{withheld === 1 ? ' was' : 's were'} removed under Streetkey’s rules (for example, choosing between applicants or tenants).</p>}
      {(r.proposals.length > 0 || summary) && (
        <p className="muted" style={{ margin: 0 }}>
          {[summary || (needApproval > 0 ? '' : 'Nothing needed the approval queue.'), suggestionText, 'Nothing has been sent, booked or changed.'].filter(Boolean).join(' ')}
        </p>
      )}
    </div>
  );
}
