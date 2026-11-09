/**
 * Admin: review listings before they go live (with trust checks: AI when it's on, Streetkey's automatic rules
 * always), see live listings changed after approval, verify agencies, manage roles, read the audit trail and see
 * how Streetkey AI is being used. Without AI (switched off, paused, or a call fails) the review queue still works.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { AiButton, AiDisclaimer, AiErrorNote, AiLabel, AiThinking } from '../components/ai/Ai';
import '../components/ai/trust.css';
import { gbp, Section, Tag } from '../components/ui';
import { api, ApiError, mediaUrl } from '../lib/api';
import { announce, useAi } from '../lib/ai/core';
import {
  aiOverview, approveNeedsConfirm, coverage, FLAG_LABEL, JOBS_MODE_INFO, purposeLabel, RISK_LABEL, ROLE_INFO, seriousFlags, SEVERITY_LABEL, sortByRisk, trustApi,
  type AiOverview, type TrustEditedItem, type TrustFailedCheck, type TrustQueue, type TrustReview,
} from '../lib/ai/trust';
import { useServer } from '../lib/server';
import { NeedsServer, SignIn } from './Account';

type Queue = Awaited<ReturnType<typeof api.admin.listings>>['items'];
type QueueListing = Queue[number];
type Tab = 'review' | 'agencies' | 'users' | 'audit' | 'ai';
type Decision = 'approve' | 'reject' | 'ownership';

const fmt = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString('en-GB');
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const asApiError = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, fallback));
/** Agency feed photos are hosted on the agency's own website (the server marks them). */
const isExternal = (p: QueueListing['photos'][number]) => !!(p as { external?: boolean }).external;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Moves focus to an element that isn't normally focusable (a heading), so keyboard and screen-reader users keep their place. */
function focusById(id: string) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (!el.matches('a[href],button,input,select,textarea,[tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus();
  return true;
}

/**
 * Something couldn't be loaded: say so (never an empty list that looks like "nothing to do") and offer a retry.
 * The retry moves focus to the section heading first, because this note disappears when the retry starts.
 */
function LoadFailed({ what, error, onRetry }: { what: string; error: ApiError; onRetry: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const retry = () => {
    const head = box.current?.closest<HTMLElement>('section, .card, [data-admin-panel]')?.querySelector<HTMLElement>('h2, h3');
    if (head) { if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1'); head.focus(); }
    onRetry();
  };
  return (
    <div className="callout error small admin-load-failed" role="alert" ref={box}>
      <span>{what} couldn’t be loaded{error.message ? `: ${error.message.replace(/\.$/, '')}` : ''}. </span>
      <button type="button" className="linkish" onClick={retry}>Try again</button>
    </div>
  );
}

export default function Admin() {
  const { status, user } = useServer();
  if (status === 'checking') return <p className="muted small">Connecting…</p>;
  if (status === 'offline') return <NeedsServer what="The admin area" />;
  if (!user) return <SignIn heading="Sign in as an admin" />;
  if (user.role !== 'admin') return <div className="card"><h2>Admins only</h2><p className="muted">Your account doesn’t have admin access.</p></div>;
  return <AdminInner />;
}

function AdminInner() {
  const [tab, setTab] = useState<Tab>('review');
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.admin.summary>> | null>(null);
  const [summaryError, setSummaryError] = useState<ApiError | null>(null);
  /** Re-reads the tiles and tab counts (after a decision, so they match the queue). */
  const refreshSummary = useCallback(() => api.admin.summary()
    .then((s) => { setSummary(s); setSummaryError(null); })
    .catch((e) => setSummaryError(asApiError(e, 'Couldn’t load the summary.'))), []);
  useEffect(() => { void refreshSummary(); }, [tab, refreshSummary]);
  const label = (t: Tab) => t === 'review' ? `Review${summary?.listings.pending ? ` (${summary.listings.pending})` : ''}`
    : t === 'agencies' ? `Agencies${summary?.orgsAwaitingVerification ? ` (${summary.orgsAwaitingVerification})` : ''}`
    : t === 'ai' ? 'AI' : t[0].toUpperCase() + t.slice(1);
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">Admin</div><h2 style={{ marginTop: 6 }}>Streetkey operations</h2></div><Link to="/account" className="btn ghost sm">My account</Link></div>
      {summaryError && !summary && <div data-admin-panel><LoadFailed what="The summary" error={summaryError} onRetry={() => void refreshSummary()} /></div>}
      {summary && <div className="grid g4 keep2">
        <div className="card"><div className="eyebrow">Awaiting review</div><div className="num" style={{ fontSize: 28 }}>{summary.listings.pending ?? 0}</div></div>
        <div className="card"><div className="eyebrow">Live listings</div><div className="num" style={{ fontSize: 28 }}>{(summary.listings.live ?? 0) + (summary.listings.under_offer ?? 0)}</div></div>
        <div className="card"><div className="eyebrow">Users (new 7d)</div><div className="num" style={{ fontSize: 28 }}>{summary.users.total} <span className="small muted">+{summary.users.d7}</span></div></div>
        <div className="card"><div className="eyebrow">Enquiries 7d · AI images 7d</div><div className="num" style={{ fontSize: 28 }}>{summary.enquiries7d} · {summary.aiImages7d}</div></div>
      </div>}
      {summary && summary.emailsFailed7d > 0 && <div className="callout">{summary.emailsFailed7d} emails failed to send in the last 7 days. Check RESEND_API_KEY and EMAIL_FROM.</div>}
      <div className="seg" role="group" aria-label="Admin sections">{(['review', 'agencies', 'users', 'audit', 'ai'] as const).map((t) => <button key={t} type="button" className={tab === t ? 'on' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>{label(t)}</button>)}</div>
      {tab === 'review' && <Review refreshSummary={refreshSummary} />}
      {tab === 'agencies' && <Agencies />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'ai' && <AiOps />}
    </div>
  );
}

/* ───────────────────────── review queue ───────────────────────── */
const QUEUE_HEAD = 'admin-queue-head';
/** Why AI listing checks aren't running (from the server, which knows about pauses and budgets). */
const AI_OFF_NOTE: Record<string, string> = {
  paused: 'AI checks are paused just now (the OpenAI account is out of credit) and restart by themselves.',
  budget: 'AI checks are paused for today: the daily AI budget is used up.',
  disabled: 'AI checks are switched off on this site.', no_key: 'AI checks aren’t set up on this site yet.',
};
const titleId = (ref: string) => `title-${ref}`;
/** Why an edited listing is back in the queue (from the server, which records each hold). */
const HELD_NOTE: Record<'rules' | 'review' | 'limit', string> = {
  rules: 'Edited after it was approved. Streetkey’s automatic rules found a new concern in the changes, so it was taken off the site until you review it.',
  review: 'Edited after it was approved. The check of the new version found a new concern, so it was taken off the site until you review it.',
  limit: 'Edited after it was approved, more often today than Streetkey checks with AI, so it was taken off the site until you review it.',
};

function Review({ refreshSummary }: { refreshSummary: () => void }) {
  const ai = useAi();
  const [items, setItems] = useState<Queue | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [trust, setTrust] = useState<TrustQueue | null>(null);
  const [trustError, setTrustError] = useState<ApiError | null>(null);
  const [reviews, setReviews] = useState<Record<string, TrustReview | null>>({});
  const [failed, setFailed] = useState<Record<string, TrustFailedCheck | null>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, ApiError | null>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [reasonError, setReasonError] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<Record<string, Decision>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, ApiError | null>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showExternal, setShowExternal] = useState<Record<string, boolean>>({});
  /** The last decision's outcome, shown next to where focus lands (and announced). */
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warn'; near: string | null } | null>(null);
  const focusNext = useRef<string | null>(null);
  const polls = useRef<AbortController | null>(null);
  useEffect(() => () => polls.current?.abort(), []);
  /** The server applies Streetkey's rules even with AI off; whether this page can offer AI re-checks. */
  const aiOn = ai.available && trust?.aiEnabled !== false;

  /** Runs a check (a new one, or one already in progress) for a listing and shows its result. */
  const watch = useCallback((ref: string, label: string, run: (signal: AbortSignal) => Promise<TrustReview | null>) => {
    const signal = (polls.current ??= new AbortController()).signal;
    setBusy((b) => ({ ...b, [ref]: label }));
    setErrors((e) => ({ ...e, [ref]: null }));
    setDone((d) => ({ ...d, [ref]: '' }));
    run(signal)
      .then((r) => {
        if (signal.aborted) return;
        if (r) setReviews((m) => ({ ...m, [ref]: r }));
        setFailed((f) => ({ ...f, [ref]: null }));
        setDone((d) => ({ ...d, [ref]: !r ? 'Check finished.'
          : r.rulesOnly ? (r.aiProblem && /couldn’t|could not|unexpected/i.test(r.aiProblem) ? `The AI review couldn’t run, so Streetkey’s automatic rules were used: ${RISK_LABEL[r.risk].toLowerCase()}.` : `Automatic rules finished: ${RISK_LABEL[r.risk].toLowerCase()}.`)
          : `AI check finished: ${RISK_LABEL[r.risk].toLowerCase()}, score ${r.score} out of 100.` }));
      })
      .catch((e) => { if (!signal.aborted) setErrors((x) => ({ ...x, [ref]: asApiError(e, 'The check couldn’t finish. Please try again.') })); })
      .finally(() => { if (!signal.aborted) setBusy((b) => { const n = { ...b }; delete n[ref]; return n; }); });
  }, []);

  const load = useCallback(async () => {
    polls.current?.abort();
    polls.current = new AbortController();
    // The listings and the checks load separately: either can fail without hiding the other.
    const [list, queue] = await Promise.all([
      api.admin.listings('pending').then((r) => ({ items: r.items, error: null }), (e: unknown) => ({ items: null, error: asApiError(e, 'Please try again.') })),
      trustApi.queue().then((r) => ({ queue: r, error: null }), (e: unknown) => ({ queue: null, error: asApiError(e, 'Please try again.') })),
    ]);
    if (list.items) setItems(list.items);
    setLoadError(list.error);
    setTrustError(queue.error);
    if (queue.queue || !queue.error) setTrust(queue.queue);
    if (queue.queue) {
      setReviews(Object.fromEntries(queue.queue.items.map((i) => [i.ref, i.review])));
      setFailed(Object.fromEntries(queue.queue.items.map((i) => [i.ref, i.lastCheckFailed ?? null])));
    }
    setBusy({});
    // Checks started when the listing was submitted or edited may still be running: follow them.
    for (const i of queue.queue?.items ?? []) if (i.checking) { const jobId = i.checking.jobId; watch(i.ref, 'Check in progress', (signal) => trustApi.waitFor(i.ref, jobId, { signal })); }
  }, [watch]);
  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => (items ? sortByRisk(items, (ref) => reviews[ref]) : null), [items, reviews]);
  /** The server's queue entry per listing (whether an edit took it off the site, and why). */
  const queued = useMemo(() => new Map((trust?.items ?? []).map((i) => [i.ref, i])), [trust]);

  // After a decision the card goes away: move focus to the next card's title (or the queue heading), never to the page.
  useEffect(() => {
    const target = focusNext.current;
    if (!target || !sorted) return;
    focusNext.current = null;
    requestAnimationFrame(() => { if (!(target !== QUEUE_HEAD && focusById(titleId(target)))) focusById(QUEUE_HEAD); });
  }, [sorted]);

  const act = (ref: string, kind: Decision, run: () => Promise<unknown>, success: string) => {
    if (acting[ref]) return;
    const order = sorted?.map((x) => x.ref) ?? [];
    const i = order.indexOf(ref);
    // Approving or sending back removes the card: the next one (or the one before) takes its place.
    const next = kind === 'ownership' ? ref : order[i + 1] ?? order[i - 1] ?? null;
    setActing((m) => ({ ...m, [ref]: kind }));
    setActionErrors((m) => ({ ...m, [ref]: null }));
    setNotice(null);
    run()
      .then(() => {
        setNotice({ text: success, tone: 'ok', near: next });
        announce(success);
        focusNext.current = next ?? QUEUE_HEAD;
        if (kind === 'reject') setReason((r) => { const n = { ...r }; delete n[ref]; return n; });
        refreshSummary();
        void load();
      })
      .catch((e: unknown) => {
        const err = asApiError(e, 'That didn’t work. Please try again.');
        if (err.status === 409) {
          // Someone else (or another tab) has dealt with it: refresh so the outdated card goes away, and say so.
          const text = `${ref}: ${err.message.replace(/\.$/, '')}. The queue has been refreshed.`;
          setNotice({ text, tone: 'warn', near: next });
          announce(text, 'assertive');
          focusNext.current = next ?? QUEUE_HEAD;
          refreshSummary();
          void load();
        } else setActionErrors((m) => ({ ...m, [ref]: err }));
      })
      .finally(() => setActing((m) => { const n = { ...m }; delete n[ref]; return n; }));
  };

  const approve = (l: QueueListing) => {
    if (busy[l.ref] || acting[l.ref]) return;
    if (approveNeedsConfirm(reviews[l.ref], false) && confirming !== l.ref) { setConfirming(l.ref); return; }
    if (confirming === l.ref) {
      // The confirmation closes: keep focus on the Approve button (now "Publishing…") until the card goes.
      setConfirming(null);
      requestAnimationFrame(() => focusById(`approve-${l.ref}`));
    }
    act(l.ref, 'approve', () => api.admin.approve(l.ref), `${l.ref} is live.`);
  };
  const cancelConfirm = (ref: string) => {
    setConfirming(null);
    requestAnimationFrame(() => focusById(`approve-${ref}`));
  };
  const requestChanges = (l: QueueListing) => {
    const text = (reason[l.ref] ?? '').trim();
    if (text.length < 5) {
      setReasonError((m) => ({ ...m, [l.ref]: 'Write a reason the lister can act on (at least 5 characters).' }));
      focusById(`reason-${l.ref}`);
      return;
    }
    act(l.ref, 'reject', () => api.admin.reject(l.ref, text), `${l.ref} was sent back to the lister with your reason.`);
  };

  /** Try loading again; the error note goes away, so focus goes to the queue heading once the queue is back. */
  const retryLoad = () => { focusNext.current = QUEUE_HEAD; void load(); };
  /** The outcome of the last decision, shown where focus lands (it is also announced to screen readers). */
  const noticeBox = notice && <p className={`callout small${notice.tone === 'ok' ? ' ok' : ''}`}>{notice.text}</p>;

  if (!sorted) return loadError ? <div data-admin-panel><h3 id={QUEUE_HEAD} tabIndex={-1}>Waiting for review</h3><LoadFailed what="The review queue" error={loadError} onRetry={retryLoad} /></div>
    : <p className="muted small" role="status">Loading…</p>;
  const edited = trust?.recentlyEdited ?? [];
  return (
    <div className="stack" data-admin-panel>
      <div className="row between">
        <h3 id={QUEUE_HEAD} tabIndex={-1} style={{ margin: 0 }}>Waiting for review ({sorted.length})</h3>
        <button type="button" className="btn ghost sm" onClick={() => { setNotice(null); void load(); }}>Refresh</button>
      </div>
      {loadError && <LoadFailed what="The latest queue" error={loadError} onRetry={retryLoad} />}
      {!aiOn && ai.reason !== 'checking' && <p className="trust-note">{AI_OFF_NOTE[trust?.aiReason ?? (ai.reason === 'paused' ? 'paused' : 'disabled')]} Streetkey’s automatic rules still check every listing: contact details, payment requests, scam wording, notes aimed at reviewers, prices far below the area and duplicated text.</p>}
      {trustError
        ? <p className="trust-note" role="alert">Automatic checks couldn’t be loaded just now, so listings are shown in the order they arrived. <button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>
        : trust && <p className="trust-note">{aiOn && <><AiLabel /> </>}Sorted by risk, highest first{aiOn ? '' : ' (Streetkey’s automatic rules)'}. Automatic approval of low-risk listings is <b>{trust.autoApprove.enabled ? 'on' : 'off'}</b>{trust.autoApprove.enabled ? ` (AI score under ${trust.autoApprove.maxScore}, verified email and every check passed; see the AI tab for what was published)` : ''}.</p>}
      {notice && !sorted.some((l) => l.ref === notice.near) && noticeBox}
      {sorted.length === 0 && !loadError ? <p className="muted">Nothing waiting for review.</p> : sorted.map((l) => {
        const review = reviews[l.ref] ?? null;
        const text = reason[l.ref] ?? '';
        const aiWorded = !!review?.suggestedReason && text === review.suggestedReason;
        const checking = !!busy[l.ref];
        const deciding = acting[l.ref];
        const external = l.photos.filter(isExternal);
        const showExt = !!showExternal[l.ref];
        const fieldError = reasonError[l.ref] ?? '';
        const describedBy = [`reason-hint-${l.ref}`, fieldError ? `reason-error-${l.ref}` : '', aiWorded ? `reason-ai-${l.ref}` : ''].filter(Boolean).join(' ');
        const entry = queued.get(l.ref);
        return (
          <article key={l.ref} className="card stack" aria-labelledby={titleId(l.ref)}>
            {notice?.near === l.ref && noticeBox}
            <div className="row between"><h4 id={titleId(l.ref)} tabIndex={-1} style={{ margin: 0, fontSize: 16 }}>{l.title ?? `${l.beds}-bed ${l.type}`}</h4><span className="num">{l.channel === 'rent' ? `${gbp(l.price)} pcm` : gbp(l.price)}</span></div>
            <span className="small muted">{l.addressLine}, {l.town} {l.postcode} · listed by {l.lister ?? 'unknown'} ({l.source.kind}) · ownership {l.ownershipDeclared ? 'declared' : 'NOT declared'}{l.ownershipVerified ? ', verified' : ''} · ref {l.ref}</span>
            {entry?.held && <p className="trust-stale">{HELD_NOTE[entry.heldBy ?? 'review']}</p>}
            {l.photos.length > 0 && <div className="row" style={{ gap: 6 }}>{l.photos.slice(0, 6).map((p) => (isExternal(p) && !showExt
              ? <span key={p.id} className="admin-thumb admin-thumb-ext" aria-hidden="true">Agency photo</span>
              : <img key={p.id} src={mediaUrl(p.url)} alt={p.alt ?? ''} className="admin-thumb" loading="lazy" referrerPolicy="no-referrer" />))}</div>}
            {external.length > 0 && <p className="small muted" style={{ margin: 0 }}>
              {plural(external.length, 'photo is', 'photos are')} on the agency’s own website{showExt ? '' : ' and not loaded yet: loading shares your IP address with that site'}.{' '}
              <button type="button" className="linkish" aria-pressed={showExt} onClick={() => setShowExternal((m) => ({ ...m, [l.ref]: !showExt }))}>{showExt ? 'Hide agency photos' : 'Show agency photos'}</button>
            </p>}
            {l.description && <p className="small">{l.description}</p>}
            <div className="row admin-checks">{l.checks.filter((c) => !c.ok).map((c) => <Tag key={c.id} kind={c.severity === 'block' ? 'warn' : 'neutral'}>{c.message}</Tag>)}{l.checks.every((c) => c.ok) && <Tag kind="ok">All checks pass</Tag>}</div>
            {trust && <TrustPanel listingRef={l.ref} review={review} busy={busy[l.ref] ?? ''} error={errors[l.ref] ?? null} done={done[l.ref] ?? ''} failed={failed[l.ref] ?? null} aiOn={aiOn}
              onRecheck={() => watch(l.ref, aiOn ? (review ? 'Re-checking with AI' : 'Checking with AI') : 'Running the automatic rules', (signal) => trustApi.recheck(l.ref, { signal }))}
              onUseWording={() => {
                if (!review?.suggestedReason) return;
                setReason((r) => ({ ...r, [l.ref]: review.suggestedReason! }));
                setReasonError((m) => ({ ...m, [l.ref]: '' }));
                requestAnimationFrame(() => document.getElementById(`reason-${l.ref}`)?.focus());
              }} />}
            <div className="trust-decide">
              <label htmlFor={`reason-${l.ref}`}>Reason for changes (sent to the lister)</label>
              <p id={`reason-hint-${l.ref}`} className="trust-note">Needed for “Request changes”: a reason the lister can act on, at least 5 characters. It’s emailed to them.</p>
              <textarea id={`reason-${l.ref}`} className="input" rows={3} maxLength={1000} value={text} aria-describedby={describedBy} aria-invalid={fieldError ? true : undefined}
                onChange={(e) => { const v = e.target.value; setReason((r) => ({ ...r, [l.ref]: v })); if (fieldError && v.trim().length >= 5) setReasonError((m) => ({ ...m, [l.ref]: '' })); }} />
              {fieldError && <p id={`reason-error-${l.ref}`} className="field-error small" role="alert">{fieldError}</p>}
              {aiWorded && <p id={`reason-ai-${l.ref}`} className="trust-note">{review?.rulesOnly ? 'Suggested by Streetkey’s automatic rules.' : 'Drafted by AI, with any points from Streetkey’s automatic rules added.'} Check and edit it before sending.</p>}
            </div>
            {confirming === l.ref && review && <ConfirmApprove listingRef={l.ref} review={review} typedReason={!!text.trim()} onConfirm={() => approve(l)} onCancel={() => cancelConfirm(l.ref)} />}
            {actionErrors[l.ref] && <div className="callout error small" role="alert">{actionErrors[l.ref]!.message}</div>}
            <div className="row">
              <button type="button" id={`approve-${l.ref}`} className="btn accent sm" aria-disabled={checking || !!deciding || undefined} aria-busy={deciding === 'approve' || undefined}
                aria-describedby={checking ? `approve-wait-${l.ref}` : undefined} onClick={() => approve(l)}>{deciding === 'approve' ? 'Publishing…' : 'Approve & publish'}</button>
              {!l.ownershipVerified && <button type="button" className="btn ghost sm" aria-disabled={!!deciding || undefined}
                onClick={() => act(l.ref, 'ownership', () => api.admin.verifyOwnership(l.ref), `Ownership of ${l.ref} marked verified.`)}>{deciding === 'ownership' ? 'Saving…' : 'Mark ownership verified'}</button>}
              <button type="button" className="btn ghost sm" aria-disabled={!!deciding || undefined} aria-describedby={`reason-hint-${l.ref}`} onClick={() => requestChanges(l)}>{deciding === 'reject' ? 'Sending…' : 'Request changes'}</button>
            </div>
            {checking && <p id={`approve-wait-${l.ref}`} className="trust-note">A check is running: wait for it to finish before approving.</p>}
          </article>
        );
      })}
      {edited.length > 0 && <EditedList items={edited} />}
    </div>
  );
}

/** "Publish anyway?" for a listing whose check found something, or that changed since it was checked. */
function ConfirmApprove({ listingRef, review, typedReason, onConfirm, onCancel }: { listingRef: string; review: TrustReview; typedReason: boolean; onConfirm: () => void; onCancel: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  const flags = seriousFlags(review).slice(0, 6);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
  return (
    <div className="admin-confirm" role="group" aria-labelledby={`confirm-${listingRef}`} onKeyDown={onKey}>
      <h5 id={`confirm-${listingRef}`} ref={head} tabIndex={-1}>Publish {listingRef} anyway?</h5>
      <p className="small">
        {review.risk !== 'low' && <>The check rated it <b>{RISK_LABEL[review.risk].toLowerCase()}</b>{review.rulesOnly ? ' (Streetkey’s automatic rules)' : ''}. </>}
        {review.stale && 'The listing has changed since it was checked, so the check may be out of date. '}
        {flags.length > 0 ? 'Concerns found:' : ''}
      </p>
      {flags.length > 0 && <ul className="small admin-confirm-flags">{flags.map((f, i) => <li key={i}><b>{SEVERITY_LABEL[f.severity]}</b> · {FLAG_LABEL[f.type] ?? f.type}{f.source === 'ai' ? ' (AI)' : ''}: {f.detail}</li>)}</ul>}
      {typedReason && <p className="small">The reason you typed for the lister won’t be sent.</p>}
      <div className="row">
        <button type="button" className="btn accent sm" onClick={onConfirm}>Publish anyway</button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Private listings that are live now and were edited after their latest approval (risky edits go back to the queue above). */
function EditedList({ items }: { items: TrustEditedItem[] }) {
  return (
    <Section title="Changed since approval" kicker="Live listings edited in the last 14 days">
      <p className="small muted" style={{ marginTop: 0 }}>Live now, edited after approval. Edits that add a new concern take a listing off the site and back to the queue above, so open these if anything looks off.</p>
      <ul className="clean">{items.map((e) => {
        // Older servers only send the last update time, which approvals and status changes also move.
        const changed = e.editedAt ? `edited ${when(e.editedAt)}` : e.editedAt === undefined ? `updated ${when(e.updatedAt)}` : '';
        return (
        <li key={e.ref} className="row between" style={{ gap: 8 }}>
          <span><Link to={`/property/${e.ref}`}>{e.title ?? e.ref}</Link> <span className="aiops-code">{e.ref} · {e.status.replace('_', ' ')}{changed ? ` · ${changed}` : ''}</span></span>
          <span className="row" style={{ gap: 6 }}>
            {e.review && <span className={`ai-risk ${e.review.risk}`}>{RISK_LABEL[e.review.risk]}</span>}
            {e.checking ? <span className="small muted">Checking…</span>
              : e.review?.stale ? <Tag kind="warn">Changed since its last check</Tag>
              : e.review && <span className="small muted">Checked {when(e.review.createdAt)}{e.review.rulesOnly ? ' (automatic rules only)' : ''}</span>}
          </span>
        </li>
        );
      })}</ul>
    </Section>
  );
}

function TrustPanel({ listingRef, review, busy, error, done, failed, aiOn, onRecheck, onUseWording }: {
  listingRef: string; review: TrustReview | null; busy: string; error: ApiError | null; done: string; failed: TrustFailedCheck | null; aiOn: boolean; onRecheck: () => void; onUseWording: () => void;
}) {
  const byAi = !!review && !review.rulesOnly;
  const checkedHow = review ? (review.autoApproved ? 'Auto-approved' : review.triggeredBy === 'admin' ? 'Re-checked' : review.triggeredBy === 'edited' ? 'Checked after an edit' : 'Checked') : '';
  return (
    <section className="trust-panel" aria-label={`Automatic check for ${listingRef}`}>
      <div className="trust-head">
        {byAi || (!review && aiOn) ? <AiLabel>AI check</AiLabel> : <b className="small">Automatic check</b>}
        {review && <span className={`ai-risk ${review.risk}`}>{RISK_LABEL[review.risk]}</span>}
        {review && (review.rulesOnly
          ? <span className="trust-score trust-rules">Streetkey’s automatic rules only, not scored by AI</span>
          : <span className="trust-score">Risk score <b>{review.score}</b> out of 100</span>)}
        {review && <span className="trust-meta">{checkedHow} {when(review.createdAt)}</span>}
      </div>
      {busy && <AiThinking label={busy} />}
      {failed && !busy && <p className="trust-stale">The latest automatic check couldn’t finish ({failed.error.replace(/\.$/, '')}). {aiOn ? 'Re-check with AI' : 'Re-run the automatic rules'} to try again.</p>}
      {review ? <>
        {review.stale && <p className="trust-stale">This listing has changed since it was checked. Re-check to review the latest version.</p>}
        {review.summary && <p className="trust-summary">{review.summary}</p>}
        {review.rulesOnly && review.aiProblem && <p className="trust-note">Why AI wasn’t used: {review.aiProblem}</p>}
        {review.flags.length > 0
          ? <ul className="trust-flags" aria-label="Concerns found">{review.flags.map((f, i) => (
            <li key={i} className={`trust-flag sev-${f.severity}`}>
              <div className="trust-flag-h"><span className="trust-sev">{SEVERITY_LABEL[f.severity]}</span><b>{FLAG_LABEL[f.type] ?? f.type}</b><span className="trust-src">{f.source === 'rules' ? 'Automatic rule' : 'AI'}</span></div>
              <p className="trust-detail">{f.detail}</p>
              {f.evidence ? <p className="trust-ev"><b>Evidence</b>{f.evidence}</p>
                : f.source === 'ai' && <p className="trust-ev none">No quote from the listing backs this up, so check it yourself.</p>}
            </li>
          ))}</ul>
          : <p className="trust-note">No concerns found.</p>}
        <p className="trust-cover">Checked: {coverage(review.checks).join(' · ')}.</p>
      </> : !busy && <p className="trust-note">Not checked yet.</p>}
      <p className={done && !busy ? 'trust-done' : 'sr-only'} role="status" aria-live="polite">{busy ? '' : done}</p>
      <AiErrorNote error={error} onRetry={onRecheck} />
      <div className="trust-actions">
        {review?.suggestedReason && <button type="button" className="btn ghost sm" onClick={onUseWording}>{review.rulesOnly ? 'Use suggested wording' : 'Use AI wording'}</button>}
        {aiOn
          ? <AiButton kind="ghost" busy={!!busy} onClick={onRecheck}>{review ? 'Re-check with AI' : 'Check with AI'}</AiButton>
          // Without AI this re-runs Streetkey's own rules: a plain button (it isn't AI), focusable while busy.
          : <button type="button" className="btn ghost sm" aria-disabled={!!busy || undefined} aria-busy={!!busy || undefined} onClick={() => { if (!busy) onRecheck(); }}>{busy ? 'Running…' : 'Re-run automatic rules'}</button>}
      </div>
      {byAi
        ? <AiDisclaimer>AI-assisted check to help you prioritise. It can be wrong, and it isn’t legal advice: you decide whether to approve or ask for changes.</AiDisclaimer>
        : <p className="trust-note">Streetkey’s automatic rules flag common problems to help you prioritise. They can miss things: you decide whether to approve or ask for changes.</p>}
    </section>
  );
}

/* ───────────────────────── AI operations ───────────────────────── */
const OFF_STATUS: Record<string, { label: string; sub: string }> = {
  disabled: { label: 'Off', sub: 'Switched off (AI_DISABLED)' }, no_key: { label: 'Off', sub: 'No OpenAI key set' },
  paused: { label: 'Paused', sub: 'OpenAI account out of credit' }, budget: { label: 'Paused', sub: 'Daily token budget used up' },
};

function AiOps() {
  const [data, setData] = useState<AiOverview | null>(null);
  const [trust, setTrust] = useState<TrustQueue | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // The listing-check settings come from the review queue, which works with AI off too.
    Promise.all([aiOverview(), trustApi.queue().catch(() => null)])
      .then(([o, t]) => { setData(o); setTrust(t); })
      .catch((e) => setError(asApiError(e, 'Couldn’t load the AI overview. Please try again.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <AiErrorNote error={error} onRetry={load} /> : <p className="muted small" role="status">Loading…</p>;
  const u = data.last24h ?? { calls: 0, tokens: 0, images: 0, failures: 0 };
  const budgetPct = data.dailyTokenBudget ? Math.min(100, Math.round((Number(u.tokens) / data.dailyTokenBudget) * 100)) : null;
  const failPct = u.calls ? Math.round((u.failures / u.calls) * 100) : 0;
  const totalTokens = data.byPurpose.reduce((s, p) => s + Number(p.tokens), 0);
  const off = !data.enabled ? OFF_STATUS[data.reason ?? ''] ?? { label: 'Off', sub: 'Built-in rules only' } : null;
  const paused = data.reason === 'paused' || data.reason === 'budget';
  const topUsers = data.topUsers ?? [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Section title="Streetkey AI" kicker="Last 24 hours" right={<button type="button" className="btn ghost sm" onClick={load} aria-disabled={loading || undefined} aria-busy={loading || undefined}>{loading ? 'Refreshing…' : 'Refresh'}</button>}>
        <div className="stack">
          {error && <AiErrorNote error={error} onRetry={load} />}
          {data.notice
            ? <div className={`callout small${paused ? '' : ' info'}`}><b>{paused ? 'AI is paused. ' : 'AI is off. '}</b>{data.notice} Every page uses Streetkey’s built-in rules meanwhile, and listing checks keep running on the automatic rules.</div>
            : !data.enabled && <div className="callout small">AI is switched off or not set up on this server (check OPENAI_API_KEY and AI_DISABLED). Every page uses Streetkey’s built-in rules instead.</div>}
          <div className="aiops-kpis">
            <div className="aiops-kpi"><div className="eyebrow">Status</div><span className="num">{off ? off.label : 'On'}</span><span className="sub">{off ? off.sub : 'AI features available'}{data.pause?.until ? ` · retries at ${new Date(data.pause.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</span></div>
            <div className="aiops-kpi"><div className="eyebrow">AI calls</div><span className="num">{fmt(u.calls)}</span><span className="sub">{u.failures ? `${fmt(u.failures)} failed (${failPct}%)` : 'No failures'}</span></div>
            <div className="aiops-kpi"><div className="eyebrow">Tokens</div><span className="num">{fmt(u.tokens)}</span>
              {budgetPct != null
                ? <><span className="sub">{budgetPct}% of the daily budget</span><div className={`aiops-bar${budgetPct >= 80 ? ' warn' : ''}`} aria-hidden="true"><i style={{ width: `${Math.max(2, budgetPct)}%` }} /></div></>
                : <span className="sub">No daily cap</span>}</div>
            <div className="aiops-kpi"><div className="eyebrow">Images</div><span className="num">{fmt(u.images)}</span><span className="sub">Room redesigns</span></div>
          </div>
        </div>
      </Section>

      <Section title="Settings" kicker="From the server’s environment">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="AI settings"><table className="t">
          <caption className="sr-only">AI settings</caption>
          <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">What it means</th></tr></thead>
          <tbody>
            <tr><td>AI features</td><td>{data.enabled ? <Tag kind="ok">On</Tag> : <Tag kind="warn">{off?.label ?? 'Off'}</Tag>}</td><td className="small">{data.enabled ? 'OpenAI is connected.' : paused ? 'Paused for now; it switches back on by itself.' : 'Set OPENAI_API_KEY (and leave AI_DISABLED unset) to switch AI on.'}</td></tr>
            <tr><td>Background jobs</td><td className="num">{data.jobsMode}</td><td className="small">{JOBS_MODE_INFO[data.jobsMode] ?? 'Custom mode'}</td></tr>
            <tr><td>Daily token budget</td><td className="num">{data.dailyTokenBudget ? fmt(data.dailyTokenBudget) : 'No cap'}</td><td className="small">AI pauses for the day when this many tokens have been used (AI_DAILY_TOKEN_BUDGET). Safety checks keep a reserve.</td></tr>
            {data.dailyTokensPerUser != null && <tr><td>Daily tokens per account</td><td className="num">{data.dailyTokensPerUser ? fmt(data.dailyTokensPerUser) : 'No cap'}</td><td className="small">The most one signed-in person can use in a day. Listing checks and enquiry screening aren’t counted.</td></tr>}
            {data.dailyTokensPerIp != null && <tr><td>Daily tokens per visitor</td><td className="num">{data.dailyTokensPerIp ? fmt(data.dailyTokensPerIp) : 'No cap'}</td><td className="small">The most one visitor’s network can use in a day without signing in.</td></tr>}
            <tr><td>Auto-approve low-risk listings</td><td>{trust ? (trust.autoApprove.enabled ? <Tag kind="ok">On</Tag> : <Tag kind="neutral">Off</Tag>) : <span className="small muted">Unknown</span>}</td>
              <td className="small">{trust?.autoApprove.enabled ? `Listings the AI scored under ${trust.autoApprove.maxScore}, rated low risk, from a verified email and passing every check, go live without waiting. AI never rejects a listing.` : 'Every private listing waits for a person (AI_AUTO_APPROVE_LOW_RISK). AI never rejects a listing.'}</td></tr>
          </tbody>
        </table></div>
      </Section>

      {topUsers.length > 0 && <Section title="Heaviest users" kicker="Last 24 hours, anonymised">
        <p className="small muted" style={{ marginTop: 0 }}>All AI work done for each person, including listing checks and enquiry screening (which don’t count towards their daily cap).</p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Heaviest AI users"><table className="t">
          <caption className="sr-only">The five heaviest AI users in the last 24 hours, without names</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Who</th><th scope="col" className="r">Calls</th><th scope="col" className="r">Tokens</th></tr></thead>
          <tbody>{topUsers.map((t, i) => <tr key={i}><td className="num">{i + 1}</td><td>{t.kind === 'account' ? 'A signed-in account' : 'A visitor (not signed in)'}</td><td className="r num">{fmt(t.calls)}</td><td className="r num">{fmt(t.tokens)}</td></tr>)}</tbody>
        </table></div>
      </Section>}

      <Section title="Models in use" kicker="Chosen automatically from the OpenAI account unless set in the environment">
        {data.models ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Models in use"><table className="t">
          <caption className="sr-only">Models in use by role</caption>
          <thead><tr><th scope="col">Role</th><th scope="col">Model</th><th scope="col">Used for</th></tr></thead>
          <tbody>{Object.entries(data.models).map(([role, model]) => <tr key={role}><td>{role[0].toUpperCase() + role.slice(1)}</td><td className="num">{model}</td><td className="small">{ROLE_INFO[role] ?? '—'}</td></tr>)}</tbody>
        </table></div> : <p className="muted small">Models are chosen once AI is switched on.</p>}
      </Section>

      <Section title="Usage by feature" kicker="Last 24 hours">
        {data.byPurpose.length === 0 ? <p className="muted small">No AI calls in the last 24 hours.</p> : <div className="table-wrap" tabIndex={0} role="region" aria-label="AI usage by feature"><table className="t">
          <caption className="sr-only">AI calls and tokens by feature in the last 24 hours</caption>
          <thead><tr><th scope="col">Feature</th><th scope="col">Task</th><th scope="col" className="r">Calls</th><th scope="col" className="r">Tokens</th><th scope="col" className="r">Share of tokens</th></tr></thead>
          <tbody>{data.byPurpose.map((p) => { const l = purposeLabel(p.purpose); return (
            <tr key={p.purpose}><td>{l.feature}</td><td className="small">{l.task || '—'} <span className="aiops-code">({p.purpose})</span></td><td className="r num">{fmt(p.calls)}</td><td className="r num">{fmt(p.tokens)}</td><td className="r num">{totalTokens ? `${Math.round((Number(p.tokens) / totalTokens) * 100)}%` : '—'}</td></tr>
          ); })}</tbody>
        </table></div>}
      </Section>

      {trust && <Section title="Published by auto-approval" kicker="Last 14 days">
        {trust.recentAutoApproved.length === 0 ? <p className="muted small">No listings have been published automatically.</p> : <div className="table-wrap" tabIndex={0} role="region" aria-label="Listings published by auto-approval"><table className="t">
          <caption className="sr-only">Listings published by auto-approval in the last 14 days</caption>
          <thead><tr><th scope="col">Listing</th><th scope="col" className="r">Risk score</th><th scope="col">Published</th><th scope="col">Status now</th></tr></thead>
          <tbody>{trust.recentAutoApproved.map((r) => <tr key={r.ref}><td><Link to={`/property/${r.ref}`}>{r.title ?? r.ref}</Link> <span className="aiops-code">{r.ref}</span></td><td className="r num">{r.score}</td><td className="small">{when(r.approvedAt)}</td><td className="small">{r.status.replace('_', ' ')}</td></tr>)}</tbody>
        </table></div>}
      </Section>}
    </div>
  );
}

/* ───────────────────────── agencies, users, audit ───────────────────────── */
function Agencies() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.admin.orgs>>['items'] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(() => api.admin.orgs().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(asApiError(e, 'Please try again.'))), []);
  useEffect(() => { void load(); }, [load]);
  const verify = (id: string, verified: boolean) => {
    if (busyId) return;
    setBusyId(id);
    setActionError('');
    api.admin.verifyOrg(id, verified)
      .then((r) => { announce(verified ? `Organisation verified${r.released ? `: ${plural(r.released, 'listing')} published` : ''}.` : 'Organisation unverified.'); return load(); })
      .catch((e) => setActionError(asApiError(e, 'That didn’t work. Please try again.').message))
      .finally(() => setBusyId(null));
  };
  return (
    <Section title="Organisations" kicker="Verify redress scheme membership before approving">
      {error && <LoadFailed what="The organisations" error={error} onRetry={() => void load()} />}
      {actionError && <div className="callout error small" role="alert">{actionError}</div>}
      {!items ? (!error && <p className="muted small" role="status">Loading…</p>)
        : items.length === 0 ? <p className="muted small">No organisations yet.</p>
        : <div className="table-wrap" tabIndex={0} role="region" aria-label="Organisations"><table className="t"><caption className="sr-only">Organisations</caption><thead><tr><th scope="col">Name</th><th scope="col">Redress</th><th scope="col">Owner</th><th scope="col" className="r">Listings</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{items.map((o) => <tr key={o.id}><td>{o.name} <span className="xs muted">{o.kind}</span></td><td className="small">{o.redressScheme ?? '—'}</td><td className="small">{o.owners ?? '—'}</td><td className="r num">{o.listings}</td>
            <td><button type="button" className={`btn sm${o.verified ? ' ghost' : ''}`} aria-disabled={busyId === o.id || undefined} aria-busy={busyId === o.id || undefined}
              aria-label={`${o.verified ? 'Unverify' : 'Verify'} ${o.name}`} onClick={() => verify(o.id, !o.verified)}>{busyId === o.id ? 'Saving…' : o.verified ? 'Unverify' : 'Verify'}</button></td></tr>)}</tbody></table></div>}
    </Section>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.admin.users>>['items'] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState('');
  const load = (term = q) => api.admin.users(term).then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(asApiError(e, 'Please try again.')));
  useEffect(() => { void load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setRole = (id: string, email: string, role: 'member' | 'admin') => {
    setActionError('');
    api.admin.setRole(id, role).then(() => { announce(`${email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`); return load(); })
      .catch((e) => { setActionError(asApiError(e, 'That didn’t work. Please try again.').message); void load(); });
  };
  return (
    <Section title="Users">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void load(); }}><input className="input" style={{ maxWidth: 320 }} aria-label="Search users" placeholder="Email or name" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn sm">Search</button></form>
      {error && <div style={{ marginTop: 10 }}><LoadFailed what="The users" error={error} onRetry={() => void load()} /></div>}
      {actionError && <div className="callout error small" role="alert" style={{ marginTop: 10 }}>{actionError}</div>}
      {!items ? (!error && <p className="muted small" role="status">Loading…</p>)
        : items.length === 0 ? <p className="muted small" style={{ marginTop: 10 }}>{q ? 'No users match that search.' : 'No users yet.'}</p>
        : <div className="table-wrap" tabIndex={0} role="region" aria-label="Users" style={{ marginTop: 10 }}><table className="t"><caption className="sr-only">Users</caption><thead><tr><th scope="col">User</th><th scope="col">Type</th><th scope="col">Verified</th><th scope="col">Role</th></tr></thead>
          <tbody>{items.map((u) => <tr key={u.id}><td className="small">{u.name}<div className="xs muted">{u.email}</div></td><td className="small">{u.accountType}</td><td className="small">{u.emailVerified ? 'Yes' : 'No'}</td>
            <td><select className="input" aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => setRole(u.id, u.email, e.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin">Admin</option></select></td></tr>)}</tbody></table></div>}
    </Section>
  );
}

function Audit() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.admin.audit>>['items'] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => api.admin.audit().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(asApiError(e, 'Please try again.'))), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section title="Audit trail" kicker="Most recent 100 actions">
      {error && <LoadFailed what="The audit trail" error={error} onRetry={() => void load()} />}
      {!items ? (!error && <p className="muted small" role="status">Loading…</p>)
        : items.length === 0 ? <p className="muted small">Nothing recorded yet.</p>
        : <div className="table-wrap" tabIndex={0} role="region" aria-label="Audit trail"><table className="t"><caption className="sr-only">Audit trail</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Subject</th></tr></thead>
          <tbody>{items.map((a) => <tr key={a.id}><td className="xs">{new Date(a.at).toLocaleString('en-GB')}</td><td className="xs">{a.actor ?? 'system'}</td><td className="xs">{a.action}</td><td className="xs">{a.subject}</td></tr>)}</tbody></table></div>}
    </Section>
  );
}
