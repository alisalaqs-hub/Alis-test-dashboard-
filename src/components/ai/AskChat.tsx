/**
 * "Ask Streetkey": the AI chat inside the Ask sheet, plus the sheet's contents
 * (Ask AI / Search homes tabs) and the ways to open it. When AI isn't available the sheet is
 * the plain SmartSearch, and says so.
 *
 * The conversation lives in a small store outside React (src/lib/ai/assistant.ts), so closing the
 * sheet while an answer is on its way loses nothing: reopening it shows the thinking state and
 * then the reply.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../../lib/api';
import { describeAiError, useAi } from '../../lib/ai/core';
import {
  cardFor, CHAT_KEY, chatAlternative, clearChat, isInternal, MAX_CHARS, PROPERTY_STARTS, QUICK_STARTS, retryChat, sendChat, tidyReply, useChat,
  type ChatContext, type ChatMsg, type HomeCard,
} from '../../lib/ai/assistant';
import { Icon } from '../Icons';
import { SmartSearch } from '../SmartSearch';
import { gbp, Tag } from '../ui';
import { AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from './Ai';
import './assistant.css';

const priceLabel = (h: HomeCard) => (h.listing === 'rent' ? `${gbp(h.price)} pcm` : h.listing === 'auction' ? `Guide ${gbp(h.price)}` : gbp(h.price));

/** Cards for homes an answer mentions. `exclude`: the home the person is already looking at (no link to the same page). */
export function HomeCards({ ids, homes, exclude }: { ids: string[]; homes: HomeCard[]; exclude?: string }) {
  const cards = ids.filter((id) => id !== exclude).map((id) => cardFor(id, homes)).filter((h): h is HomeCard => !!h);
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

function AssistantMessage({ m, latest, busy, onAsk, exclude }: { m: ChatMsg; latest: boolean; busy: boolean; onAsk: (q: string) => void; exclude?: string }) {
  const x = m.extras;
  return (
    <div className="ask-msg ai">
      <div className="ask-who"><AiLabel>Streetkey AI</AiLabel></div>
      <AiText text={tidyReply(m.content)} />
      {x && <HomeCards ids={x.propertyIds} homes={x.homes} exclude={exclude} />}
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

/** Where to go instead when the AI can't answer: a home search only for questions that look like one, else the right calculator. */
function Alternative({ question }: { question: string }) {
  const alt = chatAlternative(question);
  if (!alt) return null;
  return <Link className="btn sm ghost" to={alt.to}><Icon name={alt.icon} size={14} />{alt.label}</Link>;
}

/**
 * Whether asking an earlier, unanswered question again could work now. Not while something stops
 * every question: a limit (until it resets, or during a short wait), AI being paused or switched
 * off, or a sign-in or email-confirmation step. A problem with the latest question itself (too
 * long, say) doesn't stop the earlier ones. The latest error's note says why and when it resets.
 */
function useCanAskAgain(error: ApiError | null): boolean {
  const { signedIn } = useAi();
  const at = useMemo(() => Date.now(), [error]); // eslint-disable-line react-hooks/exhaustive-deps
  const advice = useMemo(() => (error ? describeAiError(error, { signedIn, now: at }) : null), [error, signedIn, at]);
  const waitUntil = advice?.kind === 'limit' && advice.retry ? at + advice.waitSec * 1000 : 0;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (!waitUntil) return;
    const t = setTimeout(() => setWaited(true), Math.max(0, waitUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [waitUntil]);
  if (!advice) return true;
  if (advice.kind === 'unavailable' || advice.kind === 'verify_email' || advice.kind === 'sign_in') return false;
  if (advice.kind === 'limit') return advice.retry && (waited || Date.now() >= waitUntil);
  return true;
}

/**
 * The chat. The conversation is kept for this browser session (and forgotten when someone signs
 * out or another account signs in); an answer that arrives while the sheet is closed is there
 * when it opens again.
 */
export function AskChat({ context, onNavigate, autoFocus, storageKey = CHAT_KEY }: { context?: ChatContext; onNavigate?: () => void; autoFocus?: boolean; storageKey?: string }) {
  const { msgs, busy, error } = useChat(storageKey);
  const again = useCanAskAgain(error);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const hintId = useId();
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [msgs.length, busy, error]);
  // The box grows with what's typed, wrapped lines included (up to the CSS max-height, then it scrolls).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), 140)}px`;
  }, [text]);

  const send = (raw: string) => {
    if (!sendChat(raw, context, storageKey)) return;
    // A suggested question never wipes a half-typed draft: only the box's own text is cleared.
    if (raw === text) setText('');
    inputRef.current?.focus();
  };
  // Focus stays in the composer while the question is asked again (the error note it came from goes away).
  const retry = () => { inputRef.current?.focus(); retryChat(context, storageKey); };
  const clear = () => { clearChat(storageKey); setText(''); inputRef.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };

  const last = msgs[msgs.length - 1];
  const waiting = last?.role === 'user' && !busy; // the last question has no answer (failed, or lost when the page reloaded)
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
            ? (
              <div key={m.id} className="ask-msg user">
                <span className="ask-who">You</span>
                <p className="ask-bubble-u">{m.content}</p>
                {/* An earlier question that was never answered (the latest one gets the full note below). */}
                {/* No "Ask again" while a limit, a pause or a sign-in step would stop it too (the note below says when). */}
                {m.failed && i < msgs.length - 1 && (
                  again
                    ? <span className="ask-unanswered">Not answered · <button type="button" className="linkish" disabled={busy} onClick={() => send(m.content)}>Ask again</button></span>
                    : <span className="ask-unanswered">Not answered</span>
                )}
              </div>
            )
            : <AssistantMessage key={m.id} m={m} latest={i === lastAi && i === msgs.length - 1} busy={busy} onAsk={send} exclude={context?.propertyId} />)}
        </div>
        {busy && <AiThinking label="Streetkey AI is working on it" />}
        {waiting && (
          <div className="ask-fail">
            {error
              ? <AiErrorNote error={error} onRetry={retry} />
              : (
                <p className="ask-unanswered" role="status">
                  {last.failed ? 'Not answered.' : 'No answer received.'}{' '}
                  <button type="button" className="linkish" onClick={retry}>Try again</button>
                </p>
              )}
            <Alternative question={last.content} />
          </div>
        )}
      </div>

      <form className="ask-composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor={inputId} className="sr-only">Message Streetkey AI</label>
        <textarea
          id={inputId} ref={inputRef} className="input ask-input" value={text} maxLength={MAX_CHARS} enterKeyHint="send" aria-describedby={hintId}
          rows={1} placeholder="Ask about homes, costs or an area…"
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        />
        <button type="submit" className="btn accent ask-send" disabled={busy || !text.trim()} aria-label={busy ? 'Send message (waiting for the answer)' : 'Send message'}><Icon name="arrow" size={18} /></button>
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
/** Starts with 'streetkey-ask' so it is forgotten with the conversation when the account in this tab changes (src/lib/server.tsx). */
const TAB_KEY = 'streetkey-ask-tab';
const readTab = (): Tab => { try { return sessionStorage.getItem(TAB_KEY) === 'search' ? 'search' : 'ask'; } catch { return 'ask'; } };

/** Contents of the Ask sheet: header, then AI chat and search tabs (or just search, saying why, without AI). */
export function AskSheet({ onClose, page }: { onClose: () => void; page: string }) {
  const { available, reason } = useAi();
  const [tab, setTab] = useState<Tab>(readTab);
  // Only the first panel shown when the sheet opens takes focus: switching tabs, or AI becoming
  // available while the sheet is open, never pulls focus away from where the person is.
  const settled = useRef(false);
  useEffect(() => { settled.current = true; }, []);
  // If AI becomes available (or is paused) while the sheet is open, the panel that had focus is
  // replaced: put focus in the new panel's box rather than leaving it on the page behind.
  useEffect(() => {
    const a = document.activeElement;
    if (a && a !== document.body) return;
    document.getElementById('ask-sheet-title')?.closest('[role="dialog"]')?.querySelector<HTMLElement>('textarea, input')?.focus();
  }, [available]);
  const tabsRef = useRef<HTMLDivElement>(null);
  const propertyId = page.match(/^\/property\/([^/]+)/)?.[1];
  const context: ChatContext = { page, ...(propertyId ? { propertyId: decodeURIComponentSafe(propertyId) } : {}) };
  const choose = (t: Tab) => { settled.current = true; setTab(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* storage unavailable */ } };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: Tab = e.key === 'Home' ? 'ask' : e.key === 'End' ? 'search' : tab === 'ask' ? 'search' : 'ask';
    choose(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus());
  };
  const intro = <p className="small muted" style={{ margin: '4px 0 12px' }}>A place, a postcode, or what you want in your own words.</p>;
  const focusNow = !settled.current;

  return (
    <>
      <div className="row between"><h2 className="sheet-h" id="ask-sheet-title">{available ? 'Ask Streetkey' : 'Search Streetkey'}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      {available ? (
        <>
          <div className="seg ask-tabs" role="tablist" aria-label="Ask or search" ref={tabsRef} onKeyDown={onTabKey}>
            {([['ask', 'Ask AI', 'spark'], ['search', 'Search homes', 'search']] as const).map(([id, label, icon]) => (
              <button key={id} type="button" role="tab" data-tab={id} id={`ask-tab-${id}`} aria-selected={tab === id} aria-controls={`ask-panel-${id}`} tabIndex={tab === id ? 0 : -1}
                className={tab === id ? 'on' : ''} onClick={() => choose(id)}><Icon name={icon} size={14} />{label}</button>
            ))}
          </div>
          {tab === 'ask'
            ? <div role="tabpanel" id="ask-panel-ask" className="ask-panel" aria-labelledby="ask-tab-ask"><AskChat context={context} onNavigate={onClose} autoFocus={focusNow} /></div>
            : <div role="tabpanel" id="ask-panel-search" aria-labelledby="ask-tab-search">{intro}<SmartSearch autoFocus={focusNow} onDone={onClose} inlineList /></div>}
        </>
      ) : (
        <>
          <AiUnavailable reason={reason} feature="Ask Streetkey AI" fallback="You can still search homes here." />
          {intro}
          <SmartSearch autoFocus={focusNow} onDone={onClose} inlineList />
        </>
      )}
    </>
  );
}

function decodeURIComponentSafe(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

/** Any page can open the Ask sheet with `window.dispatchEvent(new Event(ASK_EVENT))`. */
export const ASK_EVENT = 'streetkey:ask';

/**
 * Opens the Ask sheet: listens for ASK_EVENT, and shows a launcher button on wide screens (phones
 * have Ask in the tab bar). It says "Ask Streetkey AI" only when AI can answer, otherwise "Search
 * Streetkey". It stays mounted while the sheet is open (under the scrim) so focus can return to it
 * when the sheet closes.
 */
export function AskLauncher({ onOpen }: { onOpen: () => void }) {
  const { available } = useAi();
  const latest = useRef(onOpen);
  useEffect(() => { latest.current = onOpen; });
  useEffect(() => {
    const open = () => latest.current();
    window.addEventListener(ASK_EVENT, open);
    return () => window.removeEventListener(ASK_EVENT, open);
  }, []);
  return (
    <button type="button" className="ask-launch desktop-only" aria-haspopup="dialog" onClick={onOpen}>
      <Icon name={available ? 'spark' : 'search'} size={18} /><span>{available ? 'Ask Streetkey AI' : 'Search Streetkey'}</span>
    </button>
  );
}
