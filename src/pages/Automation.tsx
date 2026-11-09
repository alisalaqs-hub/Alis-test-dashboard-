import { useState } from 'react';
import { AGENTS, type AgentRun, type Permission } from '../ai/agents';
import { Icon } from '../components/Icons';
import { AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/briefing.css';
import { Section, Tag } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAi } from '../lib/ai/core';
import { queueContext, runAgentWithAi, toProposedActions, type AutomationResult } from '../lib/ai/briefing';
import { useStore } from '../store';

const ALL_PERMS: Permission[] = ['listings:read', 'listings:propose-edit', 'engagement:read-aggregate', 'messages:draft', 'reports:generate', 'estimates:run', 'quotes:read', 'portfolio:read', 'compliance:read', 'maintenance:propose', 'market:read', 'documents:read'];

export default function Automation() {
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [aiRuns, setAiRuns] = useState<Record<string, AutomationResult>>({});
  const [aiErrors, setAiErrors] = useState<Record<string, ApiError | null>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const { queue, decide, enqueue, audit, log } = useStore();
  const ai = useAi();

  /** Built-in run: deterministic tools over demo data (always available). */
  const run = (id: string) => {
    const a = AGENTS.find((x) => x.id === id)!;
    const r = a.run();
    setRuns((x) => ({ ...x, [id]: r }));
    log(`agent:${id}`, 'run', `${r.toolsCalled.join(', ')} → ${r.findings.length} findings, ${r.proposals.length} proposals`);
    enqueue(r.proposals);
  };

  /** AI run: the same tools on the server, then the AI proposes next steps. It never executes anything. */
  const runAi = async (id: string) => {
    setAiBusy(id);
    setAiErrors((x) => ({ ...x, [id]: null }));
    try {
      const r = await runAgentWithAi(id, queueContext(queue, id));
      setAiRuns((x) => ({ ...x, [id]: r }));
      const queued = toProposedActions(r); // only proposals that need approval
      log(`agent:${id}`, 'AI run', `${r.toolsCalled.join(', ')} → ${r.proposals.length} AI proposals (${queued.length} sent for approval)`);
      // Suggestions that need no approval are never carried out: record them as suggestions, not as completed work.
      r.proposals.filter((p) => !p.consequential).forEach((p) => log(`agent:${id}`, 'AI suggestion (not executed)', p.title));
      if (queued.length) enqueue(queued);
    } catch (e) {
      setAiErrors((x) => ({ ...x, [id]: e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.') }));
    } finally {
      setAiBusy(null);
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
        <div className="row"><button className="btn" onClick={() => AGENTS.forEach((a) => run(a.id))}>Run all agents now</button></div>
      </div>

      <div className="grid g4 keep2">
        {AGENTS.map((a) => (
          <div key={a.id} className="card ai-card stack" style={{ gap: 8 }}>
            <div className="row between"><b>{a.name}</b><Tag kind="ai">{a.serves}</Tag></div>
            <div className="xs muted">⏱ {a.schedule}</div>
            <div className="row" style={{ gap: 4 }}>{a.permissions.map((p) => <span key={p} className="mono xs" style={{ background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5 }}>{p}</span>)}</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" aria-label={`Run now: ${a.name} (built-in rules)`} onClick={() => run(a.id)}>Run now</button>
              {ai.available && (
                <button className="btn sm accent ai-btn" aria-label={aiBusy === a.id ? `Working: ${a.name}` : `Run with AI: ${a.name}`} onClick={() => runAi(a.id)} disabled={!!aiBusy} aria-busy={aiBusy === a.id || undefined}>
                  <Icon name="spark" size={14} />{aiBusy === a.id ? 'Working…' : 'Run with AI'}
                </button>
              )}
            </div>
            {aiBusy === a.id && <AiThinking label={`${a.name} is working with Streetkey AI`} />}
            <AiErrorNote error={aiErrors[a.id] ?? null} onRetry={() => runAi(a.id)} />
            {aiErrors[a.id] && <p className="xs muted" style={{ margin: 0 }}>“Run now” still works with the built-in rules.</p>}
            {runs[a.id] && <div className="answer xs">
              <b>Findings</b><ul>{runs[a.id].findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
              {runs[a.id].proposals.length > 0 && <><b>Proposed</b><ul>{runs[a.id].proposals.map((p) => <li key={p.id}>{p.title} {p.consequential ? <Tag kind="warn">needs approval</Tag> : <Tag kind="ok">auto</Tag>}</li>)}</ul></>}
              <div className="muted" style={{ marginTop: 4 }}>tools: {runs[a.id].toolsCalled.join(', ')}</div>
            </div>}
            {aiRuns[a.id] && <AiRunView r={aiRuns[a.id]} />}
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
            <p className="xs muted" style={{ marginTop: 8 }}>Prototype: approving records the decision only. Production executes the approved action with the approver’s identity attached.</p>
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
            {audit.length === 0 ? <p className="small muted">No events yet.</p> : <ul className="clean xs mono" style={{ maxHeight: 420, overflow: 'auto' }}>{audit.slice(0, 40).map((a, i) => <li key={i}>{a.at.slice(5, 19).replace('T', ' ')} <b>{a.actor}</b> {a.action} — {a.detail}</li>)}</ul>}
          </Section>
          <Section title="Guardrails">
            <ul className="ticks small">
              <li>Agents call deterministic tools. AI text is checked: a £ or % figure must match a money or percentage figure in the tool results, and statements whose figures don’t match are removed. Check important figures before acting.</li>
              <li>Consequential actions (publish, message, book, spend, change tenancy records) require a named human approver. AI proposals need approval unless they only prepare something for you to read; the AI can add that requirement, never remove it.</li>
              <li>Tenant eligibility decisions are never made by agents.</li>
              <li>Per-agent rate limits, kill switch and full replay from the audit log.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}

function AiRunView({ r }: { r: AutomationResult }) {
  const queued = r.proposals.filter((p) => p.consequential).length;
  const suggestions = r.proposals.length - queued;
  return (
    <div className="answer xs aib-run">
      <div className="row between"><AiLabel>AI proposals</AiLabel><span className="muted">{r.basis === 'demo' ? 'From demo data' : 'Demo data + your queue'}</span></div>
      {r.proposals.length === 0
        ? <p className="muted" style={{ margin: 0 }}>The AI had nothing it could back up from these findings.</p>
        : <ul>{r.proposals.map((p) => (
          <li key={p.id}>
            <b>{p.title}</b> {p.consequential ? <Tag kind="warn">needs approval</Tag> : <Tag kind="neutral">suggestion only</Tag>}
            <p className="muted">{p.rationale}</p>
          </li>
        ))}</ul>}
      {r.grounding.dropped > 0 && <p className="muted" style={{ margin: 0 }}>{r.grounding.dropped} AI suggestion{r.grounding.dropped === 1 ? ' was' : 's were'} removed because their figures weren’t in the findings.</p>}
      {r.proposals.length > 0 && (
        <p className="muted" style={{ margin: 0 }}>
          {queued > 0 ? `${queued} added to the approval queue.` : 'Nothing needed the approval queue.'}
          {suggestions > 0 ? ` ${suggestions === 1 ? 'The other is a suggestion' : `The other ${suggestions} are suggestions`} only and ${suggestions === 1 ? 'hasn’t' : 'haven’t'} been carried out.` : ''}
          {' '}Nothing has been sent, booked or changed.
        </p>
      )}
    </div>
  );
}
