import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { route, type AiAnswer, type Skill } from '../ai/assistant';
import { propertySkills } from '../ai/skills';
import { ApiError } from '../lib/api';
import { useAi } from '../lib/ai/core';
import { askStreetkey, assistantPropertyId, isInternal, tidyReply, type ChatReply, type Turn } from '../lib/ai/assistant';
import { AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from './ai/Ai';
import { HomeCards, SourcesLine } from './ai/AskChat';
import { Icon } from './Icons';
import { Tag } from './ui';
import './ai/assistant.css';

/** An answer in the panel: Streetkey AI (when available), or the built-in rule-based skills. */
type Entry =
  | { id: number; kind: 'ai'; q: string; r: ChatReply }
  | { id: number; kind: 'rule'; q: string; a: AiAnswer & { skill: string }; aiError?: ApiError };

/** Plain names for the calculations a built-in answer used (internal ids are never shown). */
const TOOL_NAMES: Record<string, string> = {
  'valuation.valuationScenario': 'Value range', 'valuation.rentalScenario': 'Rent estimate', 'refurb.estimateRefurb': 'Refurbishment estimator',
  'insights.dealScore': 'Deal score', 'insights.loftScenario': 'Loft conversion estimate', 'insights.epcPathway': 'EPC upgrade plan',
  'studio.designToCost': 'Design studio', 'development.developmentOptions': 'Development options', 'investment.analyse': 'Investment analyser',
  constraints: 'Risk and planning data', 'engagement.insightsFor': 'Listing engagement', 'engagement.benchmark': 'Comparable listings',
  'engagement.engagementFor': 'Listing engagement', 'engagement.totals': 'Listing engagement', 'reports.weeklyOwnerReport': 'Weekly report',
};
export const toolNames = (ids: string[]) => [...new Set(ids.map((t) => TOOL_NAMES[t]).filter(Boolean))];

/** A built-in (rule-based) answer: Streetkey's own calculations, labelled as such, never as AI. */
export function AnswerView({ a }: { a: AiAnswer }) {
  const used = toolNames(a.tools);
  return (
    <div className="answer">
      <div className="row between" style={{ marginBottom: 6 }}>
        <Tag kind="neutral" title="From Streetkey’s built-in calculations, not AI">Built-in answer</Tag>
        <span className="xs muted">confidence: <b>{a.confidence}</b></span>
      </div>
      <p>{a.text}</p>
      {a.evidence.length > 0 && <><h4>Evidence</h4><ul>{a.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {a.assumptions.length > 0 && <><h4>Assumptions</h4><ul>{a.assumptions.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {a.verify.length > 0 && <><h4>Verify before relying on this</h4><ul>{a.verify.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
      {used.length > 0 && <p className="xs muted" style={{ marginTop: 8 }}>Based on: {used.join(' · ')}.</p>}
      {a.link && <Link to={a.link.to} className="btn sm" style={{ marginTop: 10 }}>{a.link.label} →</Link>}
    </div>
  );
}

function AiAnswerView({ r, latest, busy, onAsk, exclude }: { r: ChatReply; latest: boolean; busy: boolean; onAsk: (q: string) => void; exclude?: string }) {
  return (
    <AiCard title="Streetkey AI" tone="quiet" headingLevel={4}>
      <div className="ask-answer">
        <AiText text={tidyReply(r.reply)} />
        {/* The home on this page needs no card linking back to itself. */}
        <HomeCards ids={r.propertyIds} homes={r.homes} exclude={exclude} />
        {r.actions.length > 0 && <div className="ask-actions">{r.actions.filter((a) => isInternal(a.to)).map((a) => <Link key={a.to} to={a.to} className="btn sm ghost">{a.label}<Icon name="arrow" size={14} /></Link>)}</div>}
        <SourcesLine sources={r.sources} grounding={r.grounding} />
        {latest && r.followUps.length > 0 && (
          <div className="ai-chips" role="group" aria-label="Suggested next questions">
            {/* Kept focusable while an answer is on its way (clicks are ignored), so keyboard focus isn't lost. */}
            {r.followUps.map((f) => <button key={f} type="button" className="chip ask-chip" aria-disabled={busy || undefined} onClick={() => onAsk(f)}>{f}</button>)}
          </div>
        )}
      </div>
    </AiCard>
  );
}

/** "Owner AI assistant" → "Owner assistant", "Property AI" → "Property assistant": for panels AI isn't answering. */
export function withoutAi(kicker: string): string {
  const s = kicker.replace(/\bAI\b\s*/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!s) return 'Built-in assistant';
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t.split(' ').length < 2 ? `${t} assistant` : t;
}

let seq = 0;

/**
 * Assistant panel used on property pages (and owner, agent and landlord pages with their own skills).
 * On property pages (the property skills, or `ai` set), with Streetkey AI available and a home the
 * server knows, the box takes any question about the home (answers grounded in Streetkey's engines);
 * the skill chips become quick prompts. Otherwise, or if the AI can't answer, questions go to the
 * built-in rule-based skills exactly as before, and the panel says so (it never labels them AI).
 * The owner, agent and landlord panels stay rule-based: their answers use engagement and portfolio
 * data the AI has no tools for.
 */
export function AssistantPanel<C>({ title, kicker, skills, ctx, onAnswer, placeholder, propertyId, ai }: { title: string; kicker: string; skills: Skill<C>[]; ctx: C; onAnswer?: (skill: string, q: string) => void; placeholder?: string; propertyId?: string; ai?: boolean }) {
  const { available, reason } = useAi();
  const { pathname } = useLocation();
  const wantsAi = ai ?? (skills as unknown) === propertySkills;
  const pid = wantsAi ? propertyId ?? assistantPropertyId(ctx) : undefined;
  const aiOn = available && !!pid;
  const [msgs, setMsgs] = useState<Entry[]>([]); // newest first
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const askRules = (text: string, aiError?: ApiError) => {
    const a = route(skills, ctx, text);
    setMsgs((m) => [{ id: ++seq, kind: 'rule' as const, q: text, a, aiError }, ...m].slice(0, 6));
    onAnswer?.(a.skill, text);
  };
  const askAi = async (text: string) => {
    // Earlier AI answers in this panel give the model the thread (oldest first, last five exchanges).
    const turns: Turn[] = msgs.filter((m): m is Extract<Entry, { kind: 'ai' }> => m.kind === 'ai').slice(0, 5).reverse()
      .flatMap((m) => [{ role: 'user' as const, content: m.q }, { role: 'assistant' as const, content: m.r.reply, propertyIds: m.r.propertyIds }]);
    setBusy(true);
    try {
      const r = await askStreetkey([...turns, { role: 'user', content: text }], { propertyId: pid, page: pathname });
      setMsgs((m) => [{ id: ++seq, kind: 'ai' as const, q: text, r }, ...m].slice(0, 6));
      onAnswer?.('ai', text);
    } catch (e) {
      askRules(text, e instanceof ApiError ? e : new ApiError(0, 'Streetkey AI couldn’t answer just now.'));
    } finally { setBusy(false); }
  };
  const ask = (text: string) => {
    const t = text.trim().slice(0, 2000);
    if (!t || busy) return;
    setQ('');
    if (aiOn) void askAi(t); else askRules(t);
  };
  const label = aiOn ? 'Ask anything about this home' : title;

  return (
    <section className={aiOn ? 'card ai-card' : 'card'}>
      <div className="card-head">
        <div><div className="eyebrow" style={{ marginBottom: 4 }}>{aiOn ? kicker : withoutAi(kicker)}</div><h3>{title}</h3></div>
        {aiOn ? <AiLabel>Grounded AI</AiLabel> : <Tag kind="neutral" title="Answers come from Streetkey’s built-in calculations, not AI">Built-in answers</Tag>}
      </div>
      <form className="ask-panel-form" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input ref={inputRef} className="input" value={q} maxLength={2000} placeholder={aiOn ? 'Ask anything about this home…' : placeholder ?? 'Ask a question…'} onChange={(e) => setQ(e.target.value)} aria-label={label} enterKeyHint="send" />
        {/* Never disabled (that would drop keyboard focus to the page when the question is sent): ask() ignores an empty box or a second question while busy. */}
        <button type="submit" className="btn sm" aria-disabled={busy || !q.trim() || undefined} aria-busy={busy || undefined}>Ask</button>
      </form>
      <div className="chips" style={{ marginTop: 10 }} role="group" aria-label={aiOn ? 'Quick questions' : 'Suggested questions'}>
        {skills.map((s) => <button key={s.id} type="button" className="chip xs" aria-disabled={busy || undefined} onClick={() => ask(s.label)}>{s.label}</button>)}
      </div>
      {busy && <div style={{ marginTop: 10 }}><AiThinking label="Streetkey AI is looking into it" /></div>}
      <div className="stack" style={{ marginTop: 12 }} aria-live="polite" aria-relevant="additions">
        {msgs.map((m, i) => (
          <div key={m.id} className="stack" style={{ gap: 6 }}>
            <div className="msg user"><span className="sr-only">You asked: </span>{m.q}</div>
            {m.kind === 'ai'
              ? <AiAnswerView r={m.r} latest={i === 0} busy={busy} onAsk={ask} exclude={pid} />
              : <>
                {m.aiError && (
                  <div className="ask-fallback-note">
                    {/* "Ask again" only when another go can work (not after a daily limit, or with AI paused). */}
                    <AiErrorNote error={m.aiError} retryLabel="Ask Streetkey AI again" onRetry={aiOn && i === 0 ? () => { inputRef.current?.focus(); ask(m.q); } : undefined} />
                    <span>Here’s Streetkey’s built-in answer instead.</span>
                  </div>
                )}
                <AnswerView a={m.a} />
              </>}
          </div>
        ))}
      </div>
      {aiOn
        ? <AiDisclaimer>AI-generated, not advice. Answers use Streetkey’s calculations for this home; demo listings are illustrations. Check important details with a professional.</AiDisclaimer>
        : <div className="ask-builtin-note">
          {wantsAi && <AiUnavailable reason={reason} feature="Streetkey AI" noFallback />}
          <p className="xs muted" style={{ marginTop: 10 }}>Answers come from Streetkey’s built-in calculations for this page. They are estimates, not advice: check important details with a professional.</p>
        </div>}
    </section>
  );
}
