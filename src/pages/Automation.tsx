import { useState } from 'react';
import { AGENTS, type AgentRun, type Permission } from '../ai/agents';
import { Section, Tag } from '../components/ui';
import { useStore } from '../store';

const ALL_PERMS: Permission[] = ['listings:read', 'listings:propose-edit', 'engagement:read-aggregate', 'messages:draft', 'reports:generate', 'estimates:run', 'quotes:read', 'portfolio:read', 'compliance:read', 'maintenance:propose', 'market:read', 'documents:read'];

export default function Automation() {
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const { queue, decide, enqueue, audit, log } = useStore();
  const run = (id: string) => {
    const a = AGENTS.find((x) => x.id === id)!;
    const r = a.run();
    setRuns((x) => ({ ...x, [id]: r }));
    log(`agent:${id}`, 'run', `${r.toolsCalled.join(', ')} → ${r.findings.length} findings, ${r.proposals.length} proposals`);
    enqueue(r.proposals);
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI agents & automation</div><h2 style={{ marginTop: 6 }}>Eight role-based agents. Humans approve what matters.</h2>
          <p className="muted" style={{ marginTop: 6 }}>Each agent has an explicit permission scope, a schedule and deterministic tools. They monitor, analyse and draft — publishing, messaging and spending always wait for approval, and every step is logged.</p></div>
        <div className="row"><button className="btn" onClick={() => AGENTS.forEach((a) => run(a.id))}>Run all agents now</button></div>
      </div>

      <div className="grid g4 keep2">
        {AGENTS.map((a) => (
          <div key={a.id} className="card ai-card stack" style={{ gap: 8 }}>
            <div className="row between"><b>{a.name}</b><Tag kind="ai">{a.serves}</Tag></div>
            <div className="xs muted">⏱ {a.schedule}</div>
            <div className="row" style={{ gap: 4 }}>{a.permissions.map((p) => <span key={p} className="mono xs" style={{ background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5 }}>{p}</span>)}</div>
            <button className="btn sm" onClick={() => run(a.id)}>Run now</button>
            {runs[a.id] && <div className="answer xs">
              <b>Findings</b><ul>{runs[a.id].findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
              {runs[a.id].proposals.length > 0 && <><b>Proposed</b><ul>{runs[a.id].proposals.map((p) => <li key={p.id}>{p.title} {p.consequential ? <Tag kind="warn">needs approval</Tag> : <Tag kind="ok">auto</Tag>}</li>)}</ul></>}
              <div className="muted" style={{ marginTop: 4 }}>tools: {runs[a.id].toolsCalled.join(', ')}</div>
            </div>}
          </div>
        ))}
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Approval queue" kicker="Consequential actions" right={<Tag kind="neutral">{queue.length} pending</Tag>}>
            {queue.length === 0 ? <p className="small muted">Run an agent to see its proposals here.</p> : <ul className="clean">{queue.map((q) => (
              <li key={q.id} className="row between card flat" style={{ padding: 10, flexWrap: 'nowrap' }}>
                <div className="small"><b>{q.title}</b><div className="xs muted">{q.agent} · {q.detail}</div></div>
                <div className="row" style={{ flexWrap: 'nowrap' }}><button className="btn sm" onClick={() => decide(q.id, true)}>Approve</button><button className="btn ghost sm" onClick={() => decide(q.id, false)}>Reject</button></div>
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
              <li>Agents call deterministic tools; LLM text is checked so every figure traces to a tool result.</li>
              <li>Consequential actions (publish, message, book, spend, change tenancy records) require a named human approver.</li>
              <li>Tenant eligibility decisions are never made by agents.</li>
              <li>Per-agent rate limits, kill switch and full replay from the audit log.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
