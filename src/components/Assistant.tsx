import { useState } from 'react';
import { Link } from 'react-router-dom';
import { route, type AiAnswer, type Skill } from '../ai/assistant';
import { Tag } from './ui';

type Msg = { q: string; a: AiAnswer & { skill: string } };

export function AnswerView({ a }: { a: AiAnswer }) {
  return (
    <div className="answer">
      <div className="row between" style={{ marginBottom: 6 }}><Tag kind="ai">Brixo AI</Tag><span className="xs muted">confidence: <b>{a.confidence}</b>{a.tools.length ? ` · tools: ${a.tools.join(', ')}` : ''}</span></div>
      <p>{a.text}</p>
      {a.evidence.length > 0 && <><h4>Evidence</h4><ul>{a.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {a.assumptions.length > 0 && <><h4>Assumptions</h4><ul>{a.assumptions.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {a.verify.length > 0 && <><h4>Verify before relying on this</h4><ul>{a.verify.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {a.link && <Link to={a.link.to} className="btn sm" style={{ marginTop: 10 }}>{a.link.label} →</Link>}
    </div>
  );
}

export function AssistantPanel<C>({ title, kicker, skills, ctx, onAnswer, placeholder }: { title: string; kicker: string; skills: Skill<C>[]; ctx: C; onAnswer?: (skill: string, q: string) => void; placeholder?: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const ask = (text: string) => {
    if (!text.trim()) return;
    const a = route(skills, ctx, text);
    setMsgs((m) => [{ q: text, a }, ...m].slice(0, 6));
    onAnswer?.(a.skill, text);
    setQ('');
  };
  return (
    <section className="card ai-card">
      <div className="card-head"><div><div className="eyebrow" style={{ marginBottom: 4 }}>{kicker}</div><h3>{title}</h3></div><Tag kind="ai">Grounded AI</Tag></div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input" value={q} placeholder={placeholder ?? 'Ask a question…'} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(q)} aria-label={title} />
        <button className="btn sm" onClick={() => ask(q)}>Ask</button>
      </div>
      <div className="chips" style={{ marginTop: 10 }}>{skills.map((s) => <button key={s.id} className="chip xs" onClick={() => ask(s.label)}>{s.label}</button>)}</div>
      <div className="stack" style={{ marginTop: 12 }}>
        {msgs.map((m, i) => <div key={i} className="stack" style={{ gap: 6 }}><div className="msg user">{m.q}</div><AnswerView a={m.a} /></div>)}
      </div>
      <p className="xs muted" style={{ marginTop: 10 }}>Prototype: questions are routed to Brixo skills by pattern; production uses an LLM choosing the same skills via tool-calling, with a check that every figure in its prose came from a tool.</p>
    </section>
  );
}
