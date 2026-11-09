/**
 * Shared building blocks for AI output, so every AI feature looks and behaves the same:
 * clearly labelled, accessible while working, honest when unavailable.
 *
 * Accessibility built in here (pages get it by using these components):
 * - AiButton stays focusable while busy (aria-disabled, clicks ignored), and if a page replaces it
 *   while it has focus, focus moves to the nearest sensible place instead of the page body.
 * - AiThinking and useAiAction announce progress and results through one shared live region.
 * - AiCard titles are real headings; pass focusKey={result} to move focus to the heading when a
 *   result the person asked for arrives.
 * - AiErrorNote explains what went wrong and only offers "Try again" when trying again can work.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icons';
import { api, type ApiError } from '../../lib/api';
import { useServer } from '../../lib/server';
import { announce, clearAiClick, describeAiError, ensureAnnouncer, fieldLabel, formatResetTime, recentAiClick, runAsAiClick, safeNextPath, useSignInPath, type AiOffReason } from '../../lib/ai/core';
import '../../styles/ai.css';

/** "AI" chip: marks content written or chosen by AI. */
export function AiLabel({ children = 'AI' }: { children?: ReactNode }) {
  return <span className="ai-label" title="Created by Streetkey AI"><Icon name="spark" size={12} />{children}</span>;
}

/**
 * Work in progress. The label is announced to screen readers through the shared live region
 * (a region inserted already filled is often not read). Progress updates are announced once they settle.
 */
export function AiThinking({ label = 'Thinking', announce: speak = true }: { label?: string; announce?: boolean }) {
  const first = useRef(true);
  useEffect(() => { ensureAnnouncer(); }, []);
  useEffect(() => {
    if (!speak) return;
    const delay = first.current ? 0 : 1500;
    first.current = false;
    const t = setTimeout(() => announce(`${label}…`), delay);
    return () => clearTimeout(t);
  }, [label, speak]);
  return <div className="ai-thinking"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{label}…</div>;
}

/* ───────────── Focus helpers ───────────── */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]';
const focusLost = () => { const a = document.activeElement; return !a || a === document.body || !a.isConnected; };
function focusEl(el: HTMLElement) {
  if (!el.matches(FOCUSABLE)) el.setAttribute('tabindex', '-1');
  el.focus();
}

/**
 * `el` (which has focus) is about to disappear. Once it has, if nothing else took focus, move it to the
 * nearest sensible place: the AI card's heading, an "unavailable" or error note, a heading, or the section.
 */
function rescueFocus(el: HTMLElement) {
  const chain: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) chain.push(p);
  requestAnimationFrame(() => {
    if (!focusLost()) return;
    for (const anc of chain) {
      if (!anc.isConnected) continue;
      const target = anc.querySelector<HTMLElement>('.ai-card2-t, .ai-btn:not([disabled]), .ai-unavailable, .ai-error, h2, h3, h4')
        ?? (anc.matches('section, .card, main') ? anc : null);
      if (target) { focusEl(target); return; }
    }
  });
}

/**
 * When `key` changes to a result the person asked for (with an AiButton), move focus to `target`
 * if focus was lost, is inside `scope`, or is still on the button they pressed. Never steals focus
 * from somewhere else, and never on page load.
 */
export function useResultFocus(key: unknown, target: RefObject<HTMLElement | null>, scope?: RefObject<HTMLElement | null>) {
  const prev = useRef<unknown>(undefined);
  useEffect(() => {
    const was = prev.current;
    prev.current = key;
    if (!key || key === was) return;
    const click = recentAiClick();
    const head = target.current;
    const box = scope?.current ?? head;
    if (!click || !head || !box) return;
    const related = box.contains(click.el) || !click.el.isConnected || !!click.scope?.contains(box);
    if (!related) return;
    const id = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!focusLost() && !box.contains(a) && a !== click.el) return;
      focusEl(head);
      clearAiClick();
    });
    return () => cancelAnimationFrame(id);
  }, [key, target, scope]);
}

/* ───────────── Errors ───────────── */

/**
 * Explains an AI error and offers only what can help: field-by-field problems for invalid input,
 * a resend link when the email address isn't confirmed, a sign-in or free-account link, when a
 * limit resets, and "Try again" only for problems a retry can fix (after any short wait).
 */
export function AiErrorNote({ error, onRetry, fieldLabels, retryLabel = 'Try again' }: { error: ApiError | null; onRetry?: () => void; fieldLabels?: Record<string, string>; retryLabel?: string }) {
  const { user, online } = useServer();
  const signIn = useSignInPath();
  const ref = useRef<HTMLDivElement>(null);
  const receivedAt = useMemo(() => Date.now(), [error]); // eslint-disable-line react-hooks/exhaustive-deps
  const advice = useMemo(() => (error ? describeAiError(error, { signedIn: !!user, now: receivedAt }) : null), [error, user, receivedAt]);
  const waitUntil = advice?.retry && advice.waitSec > 0 ? receivedAt + advice.waitSec * 1000 : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!waitUntil) return;
    const t = setInterval(() => { const n = Date.now(); setNow(n); if (n >= waitUntil) clearInterval(t); }, 1000);
    return () => clearInterval(t);
  }, [waitUntil]);
  const [resend, setResend] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  useEffect(() => { setResend('idle'); }, [error]);

  if (!error || !advice || advice.kind === 'cancelled') return null;
  const left = waitUntil ? Math.max(0, Math.ceil((waitUntil - Math.max(now, receivedAt)) / 1000)) : 0;
  const canRetry = !!onRetry && advice.retry;

  const retry = () => {
    if (!onRetry || left > 0) return;
    // This note disappears when the retry starts: keep focus on the feature's button (or heading) instead.
    const scope = ref.current?.closest<HTMLElement>('.ai-card2, section, .card');
    const target = scope?.querySelector<HTMLElement>('.ai-btn:not([disabled])') ?? scope?.querySelector<HTMLElement>('.ai-card2-t, h2, h3, h4');
    if (target) focusEl(target);
    onRetry();
  };
  const sendLink = async () => {
    if (resend === 'sending') return;
    setResend('sending');
    try { await api.auth.resendVerification(); setResend('sent'); } catch { setResend('failed'); }
  };
  const fields = advice.fields.map((f) => ({ ...f, label: fieldLabels ? fieldLabel(f.key, fieldLabels) : f.label }));

  return (
    <div className="ai-error" ref={ref}>
      <div className="ai-error-msg" role="alert">
        <span>{advice.kind === 'invalid' && fields.length ? error.message.replace(/\.$/, ':') : error.message}</span>
        {fields.length > 0 && <ul className="ai-error-fields">{fields.map((f) => <li key={f.key}><b>{f.label}</b>: {f.message}</li>)}</ul>}
        {advice.resetAt && <span> Available again {formatResetTime(advice.resetAt, receivedAt)}.</span>}
      </div>
      {(canRetry || advice.kind === 'verify_email' || advice.kind === 'sign_in' || advice.suggestAccount) && (
        <div className="ai-error-actions">
          {advice.kind === 'verify_email' && <>
            <button type="button" className="linkish" onClick={() => void sendLink()} aria-disabled={resend === 'sending' || undefined}>{resend === 'sent' ? 'Send it again' : 'Send the confirmation link again'}</button>
            <span role="status" className="xs">
              {resend === 'sending' ? 'Sending…' : resend === 'sent' ? 'We’ve sent a new link. Check your inbox and spam folder.' : resend === 'failed' ? <>Couldn’t send it just now. <Link to="/account">Go to your account</Link> to try again.</> : ''}
            </span>
          </>}
          {advice.kind === 'sign_in' && online && <Link to={signIn}>Sign in</Link>}
          {advice.suggestAccount && online && <Link to={signIn}>Create a free account</Link>}
          {canRetry && (left > 0
            ? <button type="button" className="linkish" aria-disabled="true" onClick={retry}>{retryLabel} in {left}s</button>
            : <button type="button" className="linkish" onClick={retry}>{retryLabel}</button>)}
        </div>
      )}
    </div>
  );
}

export function AiDisclaimer({ children }: { children?: ReactNode }) {
  return <p className="ai-disclaimer"><Icon name="spark" size={12} /> {children ?? 'AI-generated from the information available. Check important details before relying on them.'}</p>;
}

/** 'The AI photo check' → 'the AI photo check' for use mid-sentence; 'AI analysis' stays as it is. */
export const inlineFeatureName = (feature: string) => (/^[A-Z][a-z]/.test(feature) ? feature.charAt(0).toLowerCase() + feature.slice(1) : feature);

/**
 * Explains why an AI feature isn't available, and what still works.
 * Signed out: links to sign in and come back to this page (or calls onSignIn, e.g. to show an inline sign-in form).
 * noFallback: the feature has no rule-based alternative, so don't claim one (say what to do instead with `fallback`).
 */
export function AiUnavailable({ reason, signedOut, feature = 'This AI feature', onSignIn, noFallback, fallback }: {
  reason: AiOffReason; signedOut?: boolean; feature?: string; onSignIn?: () => void; noFallback?: boolean; fallback?: ReactNode;
}) {
  const signIn = useSignInPath();
  if (reason === 'checking') return null;
  const instead = (rules: string) => (fallback ? <> {fallback}</> : noFallback ? null : <> {rules}</>);
  if (signedOut) {
    const cta = 'Sign in or create a free account';
    return <p className="ai-unavailable small">{onSignIn ? <button type="button" className="linkish" onClick={onSignIn}>{cta}</button> : <Link to={signIn}>{cta}</Link>} to use {inlineFeatureName(feature)}.</p>;
  }
  if (reason === 'offline') return <p className="ai-unavailable small">{feature} runs on the live Streetkey site.{instead('This preview uses Streetkey’s built-in rules instead.')}</p>;
  if (reason === 'disabled') return <p className="ai-unavailable small">{feature} isn’t switched on yet.{instead('Streetkey’s built-in rules are used instead.')}</p>;
  if (reason === 'paused') return <p className="ai-unavailable small">{feature} is temporarily unavailable.{instead('Streetkey’s built-in rules are used instead.')}</p>;
  return null;
}

type HeadingLevel = 2 | 3 | 4 | 5 | 6;

/**
 * A labelled AI result. The title is a real heading (h3 by default: pass headingLevel to fit the page's outline).
 * focusKey: pass the result (e.g. focusKey={data}); when it arrives after the person pressed an AiButton,
 * focus moves to this heading so keyboard and screen-reader users land on the answer.
 * label={false} when a surrounding header already shows the AI badge.
 */
export function AiCard({ title, children, footer, tone, headingLevel = 3, label = true, focusKey, id, headingId, className }: {
  title?: ReactNode; children: ReactNode; footer?: ReactNode; tone?: 'quiet'; headingLevel?: HeadingLevel; label?: boolean; focusKey?: unknown; id?: string; headingId?: string; className?: string;
}) {
  const H = `h${headingLevel}` as const;
  const box = useRef<HTMLElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useResultFocus(focusKey, head, box);
  return (
    <section ref={box} id={id} className={`ai-card2${tone === 'quiet' ? ' quiet' : ''}${className ? ` ${className}` : ''}`}>
      {title && <div className="ai-card2-h">{label && <AiLabel />}<H ref={head} id={headingId} className="ai-card2-t" tabIndex={-1}>{title}</H></div>}
      <div className="ai-card2-b">{children}</div>
      {footer && <div className="ai-card2-f">{footer}</div>}
    </section>
  );
}

/**
 * The button that starts an AI action. While busy it stays focusable (aria-disabled, clicks ignored) so
 * keyboard focus isn't lost; `disabled` is only for "can't be used yet".
 */
export function AiButton({ busy, children, onClick, disabled, kind = 'accent', type = 'button', size, busyLabel = 'Working…', id, className, ref, 'aria-label': ariaLabel, 'aria-describedby': describedBy, 'aria-controls': controls }: {
  busy?: boolean; children: ReactNode; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; kind?: 'accent' | 'ghost' | 'plain'; type?: 'button' | 'submit';
  size?: 'sm'; busyLabel?: string; id?: string; className?: string; ref?: Ref<HTMLButtonElement>; 'aria-label'?: string; 'aria-describedby'?: string; 'aria-controls'?: string;
}) {
  const own = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback((el: HTMLButtonElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) (ref as { current: HTMLButtonElement | null }).current = el;
  }, [ref]);
  // If the page removes this button while it has focus (e.g. replaces it with the result), don't drop focus to the page body.
  useLayoutEffect(() => {
    const el = own.current;
    return () => { if (el && document.activeElement === el) rescueFocus(el); };
  }, []);
  const cls = `btn ${kind === 'plain' ? '' : kind}${size === 'sm' ? ' sm' : ''} ai-btn${className ? ` ${className}` : ''}`;
  return (
    <button
      ref={setRef} id={id} type={type} className={cls} disabled={disabled}
      aria-disabled={busy || undefined} aria-busy={busy || undefined}
      aria-label={ariaLabel ? (busy ? `${busyLabel} ${ariaLabel}` : ariaLabel) : undefined}
      aria-describedby={describedBy} aria-controls={controls}
      onClick={(e) => {
        if (busy || disabled) { e.preventDefault(); return; }
        const el = e.currentTarget;
        runAsAiClick(el, () => onClick?.(e));
      }}
    >
      <Icon name="spark" size={16} />{busy ? busyLabel : children}
    </button>
  );
}

/**
 * Renders simple AI text safely (no HTML): paragraphs, "- " / "• " bullet lists, **bold**,
 * and [link text](/internal/path) for internal links only (anything else shows as plain text).
 */
export function AiText({ text, className }: { text: string; className?: string }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className={`ai-text${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const items = lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return <p key={i}>{lines.map((l, k) => <Fragment key={k}>{k > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
}
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Links must start with a single "/" ("//host" and "/\host" are other sites to a browser).
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]*)\)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<b key={k++}>{m[1]}</b>);
    else {
      const to = safeNextPath(m[3]);
      out.push(to ? <Link key={k++} to={to}>{m[2]}</Link> : m[2]);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
