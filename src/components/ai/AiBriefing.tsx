/**
 * AI briefing for a professional dashboard: the person presses "Generate briefing" (never
 * automatic, to keep costs predictable), Streetkey AI reads a snapshot of what the dashboard
 * shows and returns a headline, priorities, risks, opportunities and questions. On the server,
 * statements whose £/% figures don't match the snapshot, or that break Streetkey's content rules,
 * are removed. With no server or AI switched off, the dashboard's rule-based `fallback` is shown.
 *
 * One briefing is kept per source ("This dashboard" and, for agency members, "My agency (live)"),
 * so switching between them or leaving the page and coming back doesn't throw it away. Switching
 * source cancels a briefing still being written for the other one. The server keeps a briefing for
 * an hour while its figures stay the same, so the button is only offered when asking again can give
 * something new.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { announce, useAi, useAiAction, useSignInPath } from '../../lib/ai/core';
import {
  BRIEFING_TTL_MS, briefingAnnouncement, briefingOwner, fetchBriefing, forgetBriefingsExcept, saveBriefing, savedBriefing, snapshotFingerprint,
  type Briefing, type BriefingKind, type BriefingSnapshot, type SavedBriefing,
} from '../../lib/ai/briefing';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from './Ai';
import './briefing.css';

type Source = 'dashboard' | 'live';
const SOURCES: readonly (readonly [Source, string])[] = [['dashboard', 'This dashboard'], ['live', 'My agency (live)']];

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
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function AiBriefing({ kind, snapshot, title = 'AI briefing', intro, fallback, allowMyAgency, linkFor }: AiBriefingProps) {
  const { available, reason, signedIn, user } = useAi();
  const signIn = useSignInPath();
  const headingId = useId();
  const owner = briefingOwner(user?.id);
  const [source, setSource] = useState<Source>('dashboard');
  const [hasAgency, setHasAgency] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const load = () => ({ dashboard: savedBriefing(owner, kind, 'dashboard') ?? undefined, live: savedBriefing(owner, kind, 'live') ?? undefined });
  const [saved, setSaved] = useState<Partial<Record<Source, SavedBriefing>>>(load);
  const [, setTick] = useState(0);
  /** The briefing that arrived after the person asked for it (focus moves to it; a restored one never takes focus). */
  const [arrived, setArrived] = useState<Briefing | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const key = useMemo(() => snapshotFingerprint(snapshot), [snapshot]);

  // Whoever is signed in sees only their own saved briefings; anyone else's are forgotten.
  useEffect(() => {
    if (signedIn) forgetBriefingsExcept(owner);
    setSaved(load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, kind, signedIn]);

  const gen = useAiAction(
    (k: BriefingKind, s: BriefingSnapshot | null, signal: AbortSignal) => fetchBriefing(k, s, { signal, onProgress: (job) => setProgress(job.progress) }),
    { announce: false }, // announced below, once we know whether anything changed
  );

  /** Stop a briefing that is still being written (its result would belong to another source or person). */
  const cancel = () => { abort.current?.abort(); abort.current = null; gen.reset(); setProgress(null); };

  // Agency members can brief on their live listings instead of the demo dashboard.
  useEffect(() => {
    if (!allowMyAgency || !available || !signedIn) { setHasAgency(false); return; }
    let live = true;
    api.me.orgs().then((r) => { if (live) setHasAgency(r.items.some((o) => o.kind === 'agency')); }).catch(() => { if (live) setHasAgency(false); });
    return () => { live = false; };
  }, [allowMyAgency, available, signedIn, owner]);
  useEffect(() => {
    if (!hasAgency && source === 'live') { cancel(); setSource('dashboard'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAgency, source]);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    const src = source;
    const who = owner;
    const asked = src === 'live' ? '' : key;
    abort.current?.abort();
    const ctrl = new AbortController(); abort.current = ctrl;
    setProgress(null);
    const r = await gen.run(src === 'live' ? 'my-agency' : kind, src === 'live' ? null : snapshot, ctrl.signal);
    // Ignore a run that was cancelled or replaced, or that finished after the person changed.
    if (!r || ctrl.signal.aborted || abort.current !== ctrl || ownerRef.current !== who) return;
    abort.current = null;
    const prev = savedBriefing(who, kind, src);
    const entry: SavedBriefing = { briefing: r.briefing, key: asked, cached: r.cached, same: !!prev && prev.key === asked && prev.briefing.generatedAt === r.briefing.generatedAt };
    saveBriefing(who, kind, src, entry);
    setSaved((x) => ({ ...x, [src]: entry }));
    setArrived(entry.briefing);
    announce(briefingAnnouncement(entry));
  };

  const choose = (s: Source) => { if (s !== source) { cancel(); setSource(s); } };
  const onSourceKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const next: Source = source === 'dashboard' ? 'live' : 'dashboard';
      choose(next);
      (e.currentTarget.querySelector(`[data-src="${next}"]`) as HTMLButtonElement | null)?.focus();
    }
  };

  const current = saved[source];
  const stale = source === 'dashboard' && !!current && current.key !== key;
  const expires = current ? Date.parse(current.briefing.generatedAt) + BRIEFING_TTL_MS : 0;
  // Asking again for the same dashboard figures within the hour can only return the same briefing.
  const upToDate = source === 'dashboard' && !!current && !stale && expires > Date.now();
  useEffect(() => {
    if (!upToDate) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(BRIEFING_TTL_MS, Math.max(1000, expires - Date.now() + 1000)));
    return () => clearTimeout(t);
  }, [upToDate, expires]);
  const canLive = !!allowMyAgency && hasAgency;
  const buttonLabel = !current ? 'Generate briefing' : source === 'live' ? 'Check for new activity' : stale ? 'Generate a new briefing' : 'Generate again';

  return (
    <section className="card aib" aria-labelledby={headingId}>
      <div className="aib-head">
        <div><div className="eyebrow">Streetkey AI</div><h3 id={headingId}>{title}</h3></div>
        {available && <AiLabel>AI briefing</AiLabel>}
      </div>
      {intro && <p className="small muted aib-intro">{intro}</p>}

      {reason === 'checking' ? (
        // Same space as the controls, so nothing jumps once we know whether AI is available.
        <div aria-hidden="true" style={{ minHeight: allowMyAgency ? 102 : 72 }} />
      ) : !available ? (
        <div className="aib-fallback">
          <AiUnavailable reason={reason} feature="The AI briefing" />
          {fallback}
        </div>
      ) : (
        <>
          <div className="aib-controls">
            {canLive && (
              <div className="aib-src" role="radiogroup" aria-label="What to brief on" onKeyDown={onSourceKey}>
                {SOURCES.map(([v, label]) => (
                  <button key={v} type="button" role="radio" data-src={v} aria-checked={source === v} tabIndex={source === v ? 0 : -1} onClick={() => choose(v)}>{label}</button>
                ))}
              </div>
            )}
            {upToDate && !gen.busy
              ? <p className="small muted" style={{ margin: 0 }}>Up to date with this dashboard’s figures.</p>
              : <AiButton busy={gen.busy} onClick={generate}>{buttonLabel}</AiButton>}
          </div>
          <p className="xs muted aib-note">
            {source === 'live'
              ? 'Streetkey AI reads your agency’s live listing figures (views, saves, enquiries, days live); enquirers’ details are never included. Nothing is published, sent to anyone or changed.'
              : 'Streetkey AI reads only the figures on this dashboard. Nothing is published, sent to anyone or changed.'}
          </p>
          {allowMyAgency && !signedIn && (
            <p className="xs muted aib-note">Estate agents: <Link to={signIn}>sign in with your agency account</Link> to brief on your live Streetkey listings instead.</p>
          )}
          {gen.busy && <AiThinking label={progress ?? (source === 'live' ? 'Reading your live listings' : 'Preparing your briefing')} />}
          {gen.error && <AiErrorNote error={gen.error} onRetry={generate} />}
          {/* The built-in rules describe this dashboard, never an agency's live listings. */}
          {gen.error && source === 'dashboard' && fallback}
          {stale && !gen.busy && <p className="aib-stale">The dashboard has changed since this briefing. Generate a new one to include the latest figures.</p>}
          {current && <BriefingView b={current.briefing} snapshot={source === 'dashboard' ? snapshot : null} linkFor={linkFor} aiLabel={false} cached={current.cached} same={current.same} focusKey={arrived === current.briefing ? arrived : null} />}
        </>
      )}
    </section>
  );
}

export function BriefingView({ b, snapshot, linkFor, aiLabel = true, cached, same, focusKey }: {
  b: Briefing; snapshot: BriefingSnapshot | null; linkFor?: (id: string) => string | null;
  /** false when the surrounding panel already shows the AI badge. */
  aiLabel?: boolean;
  /** The briefing came from the server's hour-long cache; `same`: it is the one already shown before. */
  cached?: boolean; same?: boolean;
  /** Pass the briefing: focus moves to its heading when one the person asked for arrives. */
  focusKey?: unknown;
}) {
  const label = (id: string) => b.labels?.[id] ?? snapshot?.items.find((i) => i.id === id)?.label ?? id;
  const lists: [string, string[]][] = [['Risks', b.risks], ['Opportunities', b.opportunities], ['Questions to check', b.questions]];
  const withheld = b.grounding.withheld ?? 0;
  return (
    <AiCard
      label={aiLabel}
      focusKey={focusKey}
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
                  <div className="ai-chips" role="group" aria-label="Related items">
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
        <span>{b.source === 'live' ? 'Live listings' : 'This dashboard’s figures'} · {when(b.generatedAt)}</span>
        {same
          ? <span>Nothing has changed since {clock(b.generatedAt)}, so this is the same briefing.</span>
          : cached && <span>Saved briefing: Streetkey keeps each one for an hour while the figures stay the same.</span>}
        {b.grounding.dropped > 0 && <span>{b.grounding.dropped} AI statement{b.grounding.dropped === 1 ? ' was' : 's were'} removed because their figures weren’t in the data.</span>}
        {withheld > 0 && <span>{withheld} AI statement{withheld === 1 ? ' was' : 's were'} removed under Streetkey’s content rules.</span>}
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
