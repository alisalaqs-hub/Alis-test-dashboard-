/**
 * "Ask Streetkey": the AI chat inside the Ask sheet, plus the sheet's contents
 * (Ask AI / Search homes tabs) and the ways to open it. When AI isn't available the sheet is
 * the plain SmartSearch.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { useAi } from '../../lib/ai/core';
import {
  askStreetkey, cardFor, CHAT_KEY, isInternal, loadChat, MAX_CHARS, PROPERTY_STARTS, QUICK_STARTS, saveChat, tidyReply, toTurns, uid,
  type ChatContext, type ChatMsg, type HomeCard,
} from '../../lib/ai/assistant';
import { Icon } from '../Icons';
import { destination, SmartSearch } from '../SmartSearch';
import { gbp, Tag } from '../ui';
import { AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking } from './Ai';
import './assistant.css';

const priceLabel = (h: HomeCard) => (h.listing === 'rent' ? `${gbp(h.price)} pcm` : h.listing === 'auction' ? `Guide ${gbp(h.price)}` : gbp(h.price));

export function HomeCards({ ids, homes }: { ids: string[]; homes: HomeCard[] }) {
  const cards = ids.map((id) => cardFor(id, homes)).filter((h): h is HomeCard => !!h);
  if (!cards.length) return null;
  return (
    <ul className="ask-homes" aria-label="Homes mentioned">
      {cards.map((h) => (
        <li key={h.id}>
          <Link to={`/property/${h.id}`} className="ask-home">
            <span className="ask-home-t">{h.title}</span>
            <span className="ask-home-s">{h.town} · {priceLabel(h)}{h.beds ? ` · ${h.beds} bed` : ''}</span>
            {h.demo && <Tag kind="demo" />}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SourcesLine({ sources, grounding }: { sources: string[]; grounding?: string }) {
  if (!sources.length && grounding !== 'trimmed') return null;
  return <p className="ask-sources">{sources.length > 0 && <>Based on: {sources.join(' · ')}.</>}{grounding === 'trimmed' && ' A figure that couldn’t be checked was left out.'}</p>;
}

function AssistantMessage({ m, latest, busy, onAsk }: { m: ChatMsg; latest: boolean; busy: boolean; onAsk: (q: string) => void }) {
  const x = m.extras;
  return (
    <div className="ask-msg ai">
      <div className="ask-who"><AiLabel>Streetkey AI</AiLabel></div>
      <AiText text={tidyReply(m.content)} />
      {x && <HomeCards ids={x.propertyIds} homes={x.homes} />}
      {x && x.actions.length > 0 && (
        <div className="ask-actions">{x.actions.filter((a) => isInternal(a.to)).map((a) => <Link key={a.to} to={a.to} className="btn sm ghost">{a.label}<Icon name="arrow" size={14} /></Link>)}</div>
      )}
      {x && <SourcesLine sources={x.sources} grounding={x.grounding} />}
      {latest && x && x.followUps.length > 0 && (
        <div className="ai-chips ask-followups" role="group" aria-label="Suggested next questions">
          {x.followUps.map((f) => <button key={f} type="button" className="chip ask-chip" disabled={busy} onClick={() => onAsk(f)}>{f}</button>)}
        </div>
      )}
    </div>
  );
}

/**
 * The chat. Conversation is kept for this browser session; replies that arrive after the
 * sheet is closed are still saved, so they're there when it's opened again.
 */
export function AskChat({ context, onNavigate, autoFocus, storageKey = CHAT_KEY }: { context?: ChatContext; onNavigate?: () => void; autoFocus?: boolean; storageKey?: string }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => loadChat(storageKey));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const inputId = useId();
  const hintId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { saveChat(msgs, storageKey); }, [msgs, storageKey]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [msgs.length, busy, error]);

  const request = async (convo: ChatMsg[]) => {
    setBusy(true); setError(null);
    const lastId = convo[convo.length - 1]?.id;
    try {
      const r = await askStreetkey(toTurns(convo), context);
      const { reply, ...extras } = r;
      const msg: ChatMsg = { id: uid(), role: 'assistant', content: reply, at: Date.now(), extras };
      if (mounted.current) setMsgs((m) => [...m, msg]);
      else { const stored = loadChat(storageKey); if (stored[stored.length - 1]?.id === lastId) saveChat([...stored, msg], storageKey); }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const send = (raw: string) => {
    const q = raw.trim().slice(0, MAX_CHARS);
    if (!q || busy) return;
    const next: ChatMsg[] = [...msgs, { id: uid(), role: 'user', content: q, at: Date.now() }];
    setMsgs(next); setText('');
    void request(next);
    inputRef.current?.focus();
  };
  const retry = () => { if (msgs[msgs.length - 1]?.role === 'user') void request(msgs); };
  const clear = () => { setMsgs([]); setError(null); setText(''); inputRef.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };

  const lastQuestion = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lastAi = msgs.length - 1 - [...msgs].reverse().findIndex((m) => m.role === 'assistant');
  const starts = context?.propertyId ? [...PROPERTY_STARTS.slice(0, 3), QUICK_STARTS[1]] : QUICK_STARTS;

  return (
    <div className="ask-chat">
      {/* Links inside answers close the sheet (even when only the query string changes). */}
      <div className="ask-scroll" ref={scrollRef} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) onNavigate?.(); }}>
        {msgs.length === 0 && (
          <div className="ask-welcome">
            <p><b>Hi, I’m Streetkey AI.</b> Ask me to find homes, explain a listing, or work out costs such as stamp duty, refurbishment or a mortgage. I use Streetkey’s own calculators for every figure.</p>
            <div className="ai-chips" role="group" aria-label="Try asking">
              {starts.map((s) => <button key={s} type="button" className="chip ask-chip" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        <div className="ask-log" role="log" aria-label="Conversation with Streetkey AI" aria-relevant="additions">
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={m.id} className="ask-msg user"><span className="ask-who">You</span><p className="ask-bubble-u">{m.content}</p></div>
            : <AssistantMessage key={m.id} m={m} latest={i === lastAi && i === msgs.length - 1} busy={busy} onAsk={send} />)}
        </div>
        {busy && <AiThinking label="Streetkey AI is working on it" />}
        {error && !busy && (
          <div className="ask-fail">
            <AiErrorNote error={error} onRetry={msgs[msgs.length - 1]?.role === 'user' ? retry : undefined} />
            {lastQuestion && <Link className="btn sm ghost" to={destination('buy', lastQuestion)}><Icon name="search" size={14} />Search homes for this instead</Link>}
          </div>
        )}
      </div>

      <form className="ask-composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor={inputId} className="sr-only">Message Streetkey AI</label>
        <textarea
          id={inputId} ref={inputRef} className="input ask-input" value={text} maxLength={MAX_CHARS} enterKeyHint="send" aria-describedby={hintId}
          rows={Math.min(4, Math.max(1, text.split('\n').length))} placeholder="Ask about homes, costs or an area…"
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        />
        <button type="submit" className="btn accent ask-send" disabled={busy || !text.trim()} aria-label="Send message"><Icon name="arrow" size={18} /></button>
      </form>
      <div className="ask-foot">
        <span id={hintId} className="sr-only">Press Enter to send, Shift and Enter for a new line.</span>
        <AiDisclaimer>AI-generated, not advice. Figures come from Streetkey’s calculators; demo listings are illustrations. Check before relying on them.</AiDisclaimer>
        {msgs.length > 0 && <button type="button" className="linkish ask-new" onClick={clear}>New chat</button>}
      </div>
    </div>
  );
}

type Tab = 'ask' | 'search';
const TAB_KEY = 'streetkey-ask-tab';
const readTab = (): Tab => { try { return sessionStorage.getItem(TAB_KEY) === 'search' ? 'search' : 'ask'; } catch { return 'ask'; } };

/** Contents of the Ask sheet: header, then AI chat and search tabs (or just search without AI). */
export function AskSheet({ onClose, page }: { onClose: () => void; page: string }) {
  const { available } = useAi();
  const [tab, setTab] = useState<Tab>(readTab);
  const switched = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const propertyId = page.match(/^\/property\/([^/]+)/)?.[1];
  const context: ChatContext = { page, ...(propertyId ? { propertyId: decodeURIComponentSafe(propertyId) } : {}) };
  const choose = (t: Tab) => { switched.current = true; setTab(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* storage unavailable */ } };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: Tab = e.key === 'Home' ? 'ask' : e.key === 'End' ? 'search' : tab === 'ask' ? 'search' : 'ask';
    choose(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus());
  };
  const intro = <p className="small muted" style={{ margin: '4px 0 12px' }}>A place, a postcode, or what you want in your own words.</p>;

  return (
    <>
      <div className="row between"><h2 className="sheet-h" id="ask-sheet-title">Ask Streetkey</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      {available ? (
        <>
          <div className="seg ask-tabs" role="tablist" aria-label="Ask or search" ref={tabsRef} onKeyDown={onTabKey}>
            {([['ask', 'Ask AI', 'spark'], ['search', 'Search homes', 'search']] as const).map(([id, label, icon]) => (
              <button key={id} type="button" role="tab" data-tab={id} id={`ask-tab-${id}`} aria-selected={tab === id} aria-controls={`ask-panel-${id}`} tabIndex={tab === id ? 0 : -1}
                className={tab === id ? 'on' : ''} onClick={() => choose(id)}><Icon name={icon} size={14} />{label}</button>
            ))}
          </div>
          {tab === 'ask'
            ? <div role="tabpanel" id="ask-panel-ask" aria-labelledby="ask-tab-ask"><AskChat context={context} onNavigate={onClose} autoFocus={!switched.current} /></div>
            : <div role="tabpanel" id="ask-panel-search" aria-labelledby="ask-tab-search">{intro}<SmartSearch autoFocus={!switched.current} onDone={onClose} /></div>}
        </>
      ) : (
        <>{intro}<SmartSearch autoFocus onDone={onClose} /></>
      )}
    </>
  );
}

function decodeURIComponentSafe(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

/** Any page can open the Ask sheet with `window.dispatchEvent(new Event(ASK_EVENT))`. */
export const ASK_EVENT = 'streetkey:ask';

/**
 * Opens the Ask sheet: listens for ASK_EVENT, and shows an "Ask Streetkey AI" button on wide
 * screens (phones have Ask in the tab bar). It stays mounted while the sheet is open (under the
 * scrim) so focus can return to it when the sheet closes.
 */
export function AskLauncher({ onOpen }: { onOpen: () => void }) {
  const latest = useRef(onOpen);
  useEffect(() => { latest.current = onOpen; });
  useEffect(() => {
    const open = () => latest.current();
    window.addEventListener(ASK_EVENT, open);
    return () => window.removeEventListener(ASK_EVENT, open);
  }, []);
  return (
    <button type="button" className="ask-launch desktop-only" aria-haspopup="dialog" onClick={onOpen}>
      <Icon name="spark" size={18} /><span>Ask Streetkey AI</span>
    </button>
  );
}
