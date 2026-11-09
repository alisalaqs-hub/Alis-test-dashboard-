/**
 * AI briefing for a professional dashboard: the person presses "Generate briefing" (never
 * automatic, to keep costs predictable), Streetkey AI reads a snapshot of what the dashboard
 * shows and returns a headline, priorities, risks, opportunities and questions. On the server,
 * statements whose £/% figures don't match the snapshot are removed. With no server or AI switched off,
 * the dashboard's rule-based `fallback` is shown instead.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAi, useAiAction } from '../../lib/ai/core';
import { requestBriefing, snapshotKey, type Briefing, type BriefingKind, type BriefingSnapshot } from '../../lib/ai/briefing';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from './Ai';
import './briefing.css';

type Source = 'dashboard' | 'live';

export interface AiBriefingProps {
  kind: Exclude<BriefingKind, 'my-agency'>;
  snapshot: BriefingSnapshot;
  title?: string;
  /** One line on what the briefing covers. */
  intro?: ReactNode;
  /** Rule-based content shown when AI isn't available or fails. */
  fallback?: ReactNode;
  /** Offer "My agency (live)" to signed-in agency members (agent dashboard). */
  allowMyAgency?: boolean;
  /** Internal link for an item the briefing mentions (e.g. a listing page). */
  linkFor?: (id: string) => string | null;
}

const IMPACT: Record<Briefing['priorities'][number]['impact'], string> = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };

export function AiBriefing({ kind, snapshot, title = 'AI briefing', intro, fallback, allowMyAgency, linkFor }: AiBriefingProps) {
  const { available, reason, signedIn } = useAi();
  const headingId = useId();
  const [source, setSource] = useState<Source>('dashboard');
  const [hasAgency, setHasAgency] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [used, setUsed] = useState<{ key: string; source: Source } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const key = useMemo(() => snapshotKey(snapshot), [snapshot]);

  const gen = useAiAction((k: BriefingKind, s: BriefingSnapshot | null, signal: AbortSignal) =>
    requestBriefing(k, s, { signal, onProgress: (job) => setProgress(job.progress) }));

  // Agency members can brief on their live listings instead of the demo dashboard.
  useEffect(() => {
    if (!allowMyAgency || !available || !signedIn) { setHasAgency(false); setSource('dashboard'); return; }
    let live = true;
    api.me.orgs().then((r) => { if (live) setHasAgency(r.items.some((o) => o.kind === 'agency')); }).catch(() => { if (live) setHasAgency(false); });
    return () => { live = false; };
  }, [allowMyAgency, available, signedIn]);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    abort.current?.abort();
    const ctrl = new AbortController(); abort.current = ctrl;
    setProgress(null); setAnnounce('');
    const b = await gen.run(source === 'live' ? 'my-agency' : kind, source === 'live' ? null : snapshot, ctrl.signal);
    if (ctrl.signal.aborted) return;
    if (b) {
      setUsed({ key, source });
      const dropped = b.grounding.dropped ? ` ${b.grounding.dropped} statement${b.grounding.dropped === 1 ? ' was' : 's were'} left out because their figures weren’t in the data.` : '';
      setAnnounce(`Briefing ready: ${b.priorities.length} priorit${b.priorities.length === 1 ? 'y' : 'ies'}.${dropped}`);
    } else setAnnounce('');
  };

  const choose = (s: Source) => { if (s !== source) { setSource(s); gen.reset(); setUsed(null); setAnnounce(''); } };
  const onSourceKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const next: Source = source === 'dashboard' ? 'live' : 'dashboard';
      choose(next);
      (e.currentTarget.querySelector(`[data-src="${next}"]`) as HTMLButtonElement | null)?.focus();
    }
  };

  const b = gen.data;
  const stale = !!b && !!used && used.source === 'dashboard' && used.key !== key;
  const canLive = allowMyAgency && hasAgency;

  return (
    <section className="card aib" aria-labelledby={headingId}>
      <div className="aib-head">
        <div><div className="eyebrow">Streetkey AI</div><h3 id={headingId}>{title}</h3></div>
        <AiLabel>AI briefing</AiLabel>
      </div>
      {intro && <p className="small muted aib-intro">{intro}</p>}

      {!available ? (
        <div className="aib-fallback">
          <AiUnavailable reason={reason} feature="The AI briefing" />
          {fallback}
        </div>
      ) : (
        <>
          <div className="aib-controls">
            {canLive && (
              <div className="aib-src" role="radiogroup" aria-label="What to brief on" onKeyDown={onSourceKey}>
                {([['dashboard', 'This dashboard'], ['live', 'My agency (live)']] as const).map(([v, label]) => (
                  <button key={v} type="button" role="radio" data-src={v} aria-checked={source === v} tabIndex={source === v ? 0 : -1} onClick={() => choose(v)}>{label}</button>
                ))}
              </div>
            )}
            <AiButton busy={gen.busy} onClick={generate}>{b && !stale ? 'Generate again' : 'Generate briefing'}</AiButton>
          </div>
          <p className="xs muted aib-note">
            {source === 'live'
              ? 'Streetkey AI reads your agency’s live listing figures (views, saves, enquiries, days live); enquirers’ details are never included. Nothing is published, sent to anyone or changed.'
              : 'Streetkey AI reads only the figures on this dashboard. Nothing is published, sent to anyone or changed.'}
          </p>
          {gen.busy && <AiThinking label={progress ?? 'Preparing your briefing'} />}
          {gen.error && <><AiErrorNote error={gen.error} onRetry={generate} />{fallback}</>}
          {stale && <p className="aib-stale">The dashboard has changed since this briefing. Generate it again to include the latest figures.</p>}
          {b && <BriefingView b={b} snapshot={used?.source === 'dashboard' ? snapshot : null} linkFor={linkFor} />}
        </>
      )}
      <p className="sr-only" aria-live="polite">{announce}</p>
    </section>
  );
}

export function BriefingView({ b, snapshot, linkFor }: { b: Briefing; snapshot: BriefingSnapshot | null; linkFor?: (id: string) => string | null }) {
  const label = (id: string) => b.labels?.[id] ?? snapshot?.items.find((i) => i.id === id)?.label ?? id;
  const lists: [string, string[]][] = [['Risks', b.risks], ['Opportunities', b.opportunities], ['Questions to check', b.questions]];
  return (
    <AiCard
      title={<b className="aib-headline">{b.headline}</b>}
      footer={<AiDisclaimer>{b.source === 'live' ? 'AI-generated from your live listings.' : 'AI-generated from the figures on this dashboard.'} Statements quoting £ or % figures that don’t match that data are removed, but the AI can still misread figures. Not a valuation, survey, or financial, legal or tax advice: check important details before acting.</AiDisclaimer>}
    >
      {b.summary && <p className="aib-summary">{b.summary}</p>}
      {b.priorities.length > 0 && (
        <div>
          <h4 className="aib-h">Priorities</h4>
          <ol className="aib-pris">
            {b.priorities.map((p, i) => (
              <li key={i} className="aib-pri">
                <div className="aib-pri-top"><b>{p.title}</b><span className={`ai-risk ${p.impact}`}>{IMPACT[p.impact]}</span></div>
                {p.why && <p>{p.why}</p>}
                <p><b>Next step:</b> {p.action}</p>
                {p.relatedIds.length > 0 && (
                  <div className="ai-chips" aria-label="Related items">
                    {p.relatedIds.map((id) => {
                      const to = linkFor?.(id);
                      return to ? <Link key={id} to={to} className="ai-chip aib-chip">{label(id)}</Link> : <span key={id} className="ai-chip aib-chip">{label(id)}</span>;
                    })}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {lists.some(([, xs]) => xs.length > 0) && (
        <div className="aib-cols">
          {lists.filter(([, xs]) => xs.length > 0).map(([h, xs]) => (
            <div key={h}><h4 className="aib-h">{h}</h4><ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          ))}
        </div>
      )}
      {!b.summary && b.priorities.length === 0 && <p className="small muted">The AI didn’t find anything it could back up with the figures available. The dashboard’s own alerts still apply.</p>}
      <div className="aib-meta">
        <span>{b.source === 'live' ? 'Live listings' : 'This dashboard’s figures'} · {new Date(b.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        {b.grounding.dropped > 0 && <span>{b.grounding.dropped} AI statement{b.grounding.dropped === 1 ? ' was' : 's were'} removed because their figures weren’t in the data.</span>}
      </div>
    </AiCard>
  );
}

/** Small rule-based list for a dashboard's fallback (shown when AI isn't available). */
export function BriefingFallback({ title = 'From Streetkey’s built-in rules', items }: { title?: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="callout info small aib-fb">
      <b>{title}</b>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}
