/**
 * Shared building blocks for AI output, so every AI feature looks and behaves the same:
 * clearly labelled, accessible while working, honest when unavailable.
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icons';
import type { ApiError } from '../../lib/api';
import '../../styles/ai.css';

/** "AI" chip: marks content written or chosen by AI. */
export function AiLabel({ children = 'AI' }: { children?: ReactNode }) {
  return <span className="ai-label" title="Created by Streetkey AI"><Icon name="spark" size={12} />{children}</span>;
}

/** Announces work in progress to screen readers; dots respect reduced motion. */
export function AiThinking({ label = 'Thinking' }: { label?: string }) {
  return <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{label}…</div>;
}

export function AiErrorNote({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="ai-error" role="alert"><span>{error.message}</span>{onRetry && <button type="button" className="linkish" onClick={onRetry}>Try again</button>}</div>;
}

export function AiDisclaimer({ children }: { children?: ReactNode }) {
  return <p className="ai-disclaimer"><Icon name="spark" size={12} /> {children ?? 'AI-generated from the information available. Check important details before relying on them.'}</p>;
}

/** Explains why an AI feature isn't available, and what still works. */
export function AiUnavailable({ reason, signedOut, feature = 'This AI feature' }: { reason: 'checking' | 'offline' | 'disabled' | null; signedOut?: boolean; feature?: string }) {
  if (reason === 'checking') return null;
  if (signedOut) return <p className="ai-unavailable small"><Link to="/account">Sign in or create a free account</Link> to use {feature.toLowerCase()}.</p>;
  if (reason === 'offline') return <p className="ai-unavailable small">{feature} runs on the live Streetkey site. This preview uses Streetkey’s built-in rules instead.</p>;
  if (reason === 'disabled') return <p className="ai-unavailable small">{feature} isn’t switched on yet. Streetkey’s built-in rules are used instead.</p>;
  return null;
}

export function AiCard({ title, children, footer, tone }: { title?: ReactNode; children: ReactNode; footer?: ReactNode; tone?: 'quiet' }) {
  return (
    <section className={`ai-card2${tone === 'quiet' ? ' quiet' : ''}`}>
      {title && <div className="ai-card2-h"><AiLabel />{typeof title === 'string' ? <b>{title}</b> : title}</div>}
      <div className="ai-card2-b">{children}</div>
      {footer && <div className="ai-card2-f">{footer}</div>}
    </section>
  );
}

export function AiButton({ busy, children, onClick, disabled, kind = 'accent', type = 'button' }: { busy?: boolean; children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'accent' | 'ghost' | 'plain'; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={`btn ${kind === 'plain' ? '' : kind} ai-btn`} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined}>
      <Icon name="spark" size={16} />{busy ? 'Working…' : children}
    </button>
  );
}

/**
 * Renders simple AI text safely (no HTML): paragraphs, "- " / "• " bullet lists, **bold**,
 * and [link text](/internal/path) for internal links only.
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
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<b key={k++}>{m[1]}</b>); else out.push(<Link key={k++} to={m[3]}>{m[2]}</Link>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
