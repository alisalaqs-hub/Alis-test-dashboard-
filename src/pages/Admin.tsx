/**
 * Admin: review listings before they go live (with AI trust checks when AI is on), verify agencies,
 * manage roles, read the audit trail and see how Streetkey AI is being used.
 * Without AI (switched off, or a call fails) the review queue works exactly as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AiButton, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/trust.css';
import { gbp, Section, Tag } from '../components/ui';
import { api, ApiError, mediaUrl } from '../lib/api';
import { useAi } from '../lib/ai/core';
import {
  aiOverview, coverage, FLAG_LABEL, JOBS_MODE_INFO, purposeLabel, RISK_LABEL, ROLE_INFO, SEVERITY_LABEL, sortByRisk, trustApi,
  type AiOverview, type TrustFailedCheck, type TrustQueue, type TrustReview,
} from '../lib/ai/trust';
import { useServer } from '../lib/server';
import { NeedsServer, SignIn } from './Account';

type Queue = Awaited<ReturnType<typeof api.admin.listings>>['items'];
type Tab = 'review' | 'agencies' | 'users' | 'audit' | 'ai';

const fmt = (n: number | null | undefined) => Number(n ?? 0).toLocaleString('en-GB');
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const asApiError = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, fallback));

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
  useEffect(() => { api.admin.summary().then(setSummary).catch(() => {}); }, [tab]);
  const label = (t: Tab) => t === 'review' ? `Review${summary?.listings.pending ? ` (${summary.listings.pending})` : ''}`
    : t === 'agencies' ? `Agencies${summary?.orgsAwaitingVerification ? ` (${summary.orgsAwaitingVerification})` : ''}`
    : t === 'ai' ? 'AI' : t[0].toUpperCase() + t.slice(1);
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">Admin</div><h2 style={{ marginTop: 6 }}>Streetkey operations</h2></div><Link to="/account" className="btn ghost sm">My account</Link></div>
      {summary && <div className="grid g4 keep2">
        <div className="card"><div className="eyebrow">Awaiting review</div><div className="num" style={{ fontSize: 28 }}>{summary.listings.pending ?? 0}</div></div>
        <div className="card"><div className="eyebrow">Live listings</div><div className="num" style={{ fontSize: 28 }}>{(summary.listings.live ?? 0) + (summary.listings.under_offer ?? 0)}</div></div>
        <div className="card"><div className="eyebrow">Users (new 7d)</div><div className="num" style={{ fontSize: 28 }}>{summary.users.total} <span className="small muted">+{summary.users.d7}</span></div></div>
        <div className="card"><div className="eyebrow">Enquiries 7d · AI 7d</div><div className="num" style={{ fontSize: 28 }}>{summary.enquiries7d} · {summary.aiImages7d}</div></div>
      </div>}
      {summary && summary.emailsFailed7d > 0 && <div className="callout">{summary.emailsFailed7d} emails failed to send in the last 7 days. Check RESEND_API_KEY and EMAIL_FROM.</div>}
      <div className="seg" role="group" aria-label="Admin sections">{(['review', 'agencies', 'users', 'audit', 'ai'] as const).map((t) => <button key={t} type="button" className={tab === t ? 'on' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>{label(t)}</button>)}</div>
      {tab === 'review' && <Review />}
      {tab === 'agencies' && <Agencies />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'ai' && <AiOps />}
    </div>
  );
}

/* ───────────────────────── review queue ───────────────────────── */
function Review() {
  const ai = useAi();
  const [items, setItems] = useState<Queue | null>(null);
  const [trust, setTrust] = useState<TrustQueue | null>(null);
  const [trustFailed, setTrustFailed] = useState(false);
  const [reviews, setReviews] = useState<Record<string, TrustReview | null>>({});
  const [failed, setFailed] = useState<Record<string, TrustFailedCheck | null>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, ApiError | null>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const polls = useRef<AbortController | null>(null);
  useEffect(() => () => polls.current?.abort(), []);

  /** Runs an AI check (a new one, or one already in progress) for a listing and shows its result. */
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
        setDone((d) => ({ ...d, [ref]: !r ? 'AI check finished.'
          : r.rulesOnly ? `The AI review couldn’t run, so Streetkey’s automatic rules were used: ${RISK_LABEL[r.risk].toLowerCase()}.`
          : `AI check finished: ${RISK_LABEL[r.risk].toLowerCase()}, score ${r.score} out of 100.` }));
      })
      .catch((e) => { if (!signal.aborted) setErrors((x) => ({ ...x, [ref]: asApiError(e, 'The AI check couldn’t finish. Please try again.') })); })
      .finally(() => { if (!signal.aborted) setBusy((b) => { const n = { ...b }; delete n[ref]; return n; }); });
  }, []);

  const load = useCallback(async () => {
    polls.current?.abort();
    polls.current = new AbortController();
    const [list, queue] = await Promise.all([
      api.admin.listings('pending').then((r) => r.items).catch(() => [] as Queue),
      ai.available ? trustApi.queue().catch(() => null) : Promise.resolve(null),
    ]);
    setItems(list);
    setTrust(queue);
    setTrustFailed(ai.available && !queue);
    setReviews(Object.fromEntries((queue?.items ?? []).map((i) => [i.ref, i.review])));
    setFailed(Object.fromEntries((queue?.items ?? []).map((i) => [i.ref, i.lastCheckFailed ?? null])));
    setBusy({});
    // Checks started when the listing was submitted may still be running: follow them.
    for (const i of queue?.items ?? []) if (i.checking) { const jobId = i.checking.jobId; watch(i.ref, 'AI check in progress', (signal) => trustApi.waitFor(i.ref, jobId, { signal })); }
  }, [ai.available, watch]);
  useEffect(() => { void load(); }, [load]);

  const act = (p: Promise<unknown>, text: string) => p.then(() => { setMsg(text); void load(); }).catch((e: ApiError) => setMsg(e.message));
  const sorted = useMemo(() => (items ? sortByRisk(items, (ref) => reviews[ref]) : null), [items, reviews]);
  const showAi = ai.available && !!trust;

  if (!sorted) return <p className="muted small" role="status">Loading…</p>;
  return (
    <div className="stack">
      {msg && <div className="callout ok small" role="status">{msg}</div>}
      {!ai.available ? <AiUnavailable reason={ai.reason} feature="The AI listing check" />
        : trustFailed ? <p className="trust-note">AI checks couldn’t be loaded just now, so listings are shown in the order they arrived.</p>
        : trust && <p className="trust-note"><AiLabel /> Sorted by AI risk, highest first. Automatic approval of low-risk listings is <b>{trust.autoApprove.enabled ? 'on' : 'off'}</b>{trust.autoApprove.enabled ? ` (score under ${trust.autoApprove.maxScore}, verified email and every check passed; see the AI tab for what was published)` : ''}.</p>}
      {sorted.length === 0 ? <p className="muted">Nothing waiting for review.</p> : sorted.map((l) => {
        const review = reviews[l.ref] ?? null;
        const text = reason[l.ref] ?? '';
        const aiWorded = !!review?.suggestedReason && text === review.suggestedReason;
        return (
          <article key={l.ref} className="card stack" aria-labelledby={`title-${l.ref}`}>
            <div className="row between"><b id={`title-${l.ref}`}>{l.title ?? `${l.beds}-bed ${l.type}`}</b><span className="num">{l.channel === 'rent' ? `${gbp(l.price)} pcm` : gbp(l.price)}</span></div>
            <span className="small muted">{l.addressLine}, {l.town} {l.postcode} · listed by {l.lister ?? 'unknown'} ({l.source.kind}) · ownership {l.ownershipDeclared ? 'declared' : 'NOT declared'}{l.ownershipVerified ? ', verified' : ''} · ref {l.ref}</span>
            {l.photos.length > 0 && <div className="row" style={{ gap: 6 }}>{l.photos.slice(0, 6).map((p) => <img key={p.id} src={mediaUrl(p.url)} alt={p.alt ?? ''} className="admin-thumb" />)}</div>}
            {l.description && <p className="small">{l.description}</p>}
            <div className="row">{l.checks.filter((c) => !c.ok).map((c) => <Tag key={c.id} kind={c.severity === 'block' ? 'warn' : 'neutral'}>{c.message}</Tag>)}{l.checks.every((c) => c.ok) && <Tag kind="ok">All checks pass</Tag>}</div>
            {showAi && <TrustPanel listingRef={l.ref} review={review} busy={busy[l.ref] ?? ''} error={errors[l.ref] ?? null} done={done[l.ref] ?? ''} failed={failed[l.ref] ?? null}
              onRecheck={() => watch(l.ref, review ? 'Re-checking with AI' : 'Checking with AI', (signal) => trustApi.recheck(l.ref, { signal }))}
              onUseWording={() => {
                if (!review?.suggestedReason) return;
                setReason((r) => ({ ...r, [l.ref]: review.suggestedReason! }));
                requestAnimationFrame(() => document.getElementById(`reason-${l.ref}`)?.focus());
              }} />}
            <div className="trust-decide">
              <label htmlFor={`reason-${l.ref}`}>Reason for changes (sent to the lister)</label>
              <textarea id={`reason-${l.ref}`} className="input" rows={3} maxLength={1000} value={text} aria-describedby={aiWorded ? `reason-hint-${l.ref}` : undefined}
                onChange={(e) => setReason({ ...reason, [l.ref]: e.target.value })} />
              {aiWorded && <p id={`reason-hint-${l.ref}`} className="trust-note">{review?.rulesOnly ? 'Suggested by Streetkey’s automatic rules.' : 'Drafted by AI.'} Check and edit it before sending.</p>}
            </div>
            <div className="row">
              <button type="button" className="btn accent sm" onClick={() => act(api.admin.approve(l.ref), `${l.ref} is live.`)}>Approve & publish</button>
              {!l.ownershipVerified && <button type="button" className="btn ghost sm" onClick={() => act(api.admin.verifyOwnership(l.ref), 'Ownership marked verified.')}>Mark ownership verified</button>}
              <button type="button" className="btn ghost sm" disabled={text.trim().length < 5} onClick={() => act(api.admin.reject(l.ref, text.trim()), 'Sent back to the lister.')}>Request changes</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TrustPanel({ listingRef, review, busy, error, done, failed, onRecheck, onUseWording }: {
  listingRef: string; review: TrustReview | null; busy: string; error: ApiError | null; done: string; failed: TrustFailedCheck | null; onRecheck: () => void; onUseWording: () => void;
}) {
  return (
    <section className="trust-panel" aria-label={`AI check for ${listingRef}`}>
      <div className="trust-head">
        <AiLabel>AI check</AiLabel>
        {review && <span className={`ai-risk ${review.risk}`}>{RISK_LABEL[review.risk]}</span>}
        {review && (review.rulesOnly
          ? <span className="trust-score trust-rules">Automatic rules only, not scored by AI</span>
          : <span className="trust-score">Risk score <b>{review.score}</b> out of 100</span>)}
        {review && <span className="trust-meta">{review.autoApproved ? 'Auto-approved' : review.triggeredBy === 'admin' ? 'Re-checked' : 'Checked'} {when(review.createdAt)}</span>}
      </div>
      {busy && <AiThinking label={busy} />}
      {failed && !busy && <p className="trust-stale">The latest automatic check couldn’t finish ({failed.error.replace(/\.$/, '')}). Re-check with AI to try again.</p>}
      {review ? <>
        {review.stale && <p className="trust-stale">This listing has changed since it was checked. Re-check to review the latest version.</p>}
        {review.summary && <p className="trust-summary">{review.summary}</p>}
        {review.rulesOnly && review.aiProblem && <p className="trust-note">Why the AI review didn’t run: {review.aiProblem}</p>}
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
      </> : !busy && <p className="trust-note">Not checked by AI yet.</p>}
      <p className={done && !busy ? 'trust-done' : 'sr-only'} role="status" aria-live="polite">{busy ? '' : done}</p>
      <AiErrorNote error={error} onRetry={onRecheck} />
      <div className="trust-actions">
        {review?.suggestedReason && <button type="button" className="btn ghost sm" onClick={onUseWording}>{review.rulesOnly ? 'Use suggested wording' : 'Use AI wording'}</button>}
        <AiButton kind="ghost" busy={!!busy} onClick={onRecheck}>{review ? 'Re-check with AI' : 'Check with AI'}</AiButton>
      </div>
      <AiDisclaimer>AI-assisted check to help you prioritise. It can be wrong, and it isn’t legal advice: you decide whether to approve or ask for changes.</AiDisclaimer>
    </section>
  );
}

/* ───────────────────────── AI operations ───────────────────────── */
function AiOps() {
  const ai = useAi();
  const [data, setData] = useState<AiOverview | null>(null);
  const [trust, setTrust] = useState<TrustQueue | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([aiOverview(), ai.available ? trustApi.queue().catch(() => null) : Promise.resolve(null)])
      .then(([o, t]) => { setData(o); setTrust(t); })
      .catch((e) => setError(asApiError(e, 'Couldn’t load the AI overview. Please try again.')))
      .finally(() => setLoading(false));
  }, [ai.available]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <AiErrorNote error={error} onRetry={load} /> : <p className="muted small" role="status">Loading…</p>;
  const u = data.last24h ?? { calls: 0, tokens: 0, images: 0, failures: 0 };
  const budgetPct = data.dailyTokenBudget ? Math.min(100, Math.round((Number(u.tokens) / data.dailyTokenBudget) * 100)) : null;
  const failPct = u.calls ? Math.round((u.failures / u.calls) * 100) : 0;
  const totalTokens = data.byPurpose.reduce((s, p) => s + Number(p.tokens), 0);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Section title="Streetkey AI" kicker="Last 24 hours" right={<button type="button" className="btn ghost sm" onClick={load} disabled={loading} aria-busy={loading || undefined}>{loading ? 'Refreshing…' : 'Refresh'}</button>}>
        <div className="stack">
          {error && <AiErrorNote error={error} onRetry={load} />}
          {!data.enabled && <div className="callout small">AI is switched off or not set up on this server (check OPENAI_API_KEY and AI_DISABLED). Every page uses Streetkey’s built-in rules instead.</div>}
          <div className="aiops-kpis">
            <div className="aiops-kpi"><div className="eyebrow">Status</div><span className="num">{data.enabled ? 'On' : 'Off'}</span><span className="sub">{data.enabled ? 'AI features available' : 'Built-in rules only'}</span></div>
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
            <tr><td>AI features</td><td>{data.enabled ? <Tag kind="ok">On</Tag> : <Tag kind="warn">Off</Tag>}</td><td className="small">{data.enabled ? 'OpenAI is connected.' : 'Set OPENAI_API_KEY (and leave AI_DISABLED unset) to switch AI on.'}</td></tr>
            <tr><td>Background jobs</td><td className="num">{data.jobsMode}</td><td className="small">{JOBS_MODE_INFO[data.jobsMode] ?? 'Custom mode'}</td></tr>
            <tr><td>Daily token budget</td><td className="num">{data.dailyTokenBudget ? fmt(data.dailyTokenBudget) : 'No cap'}</td><td className="small">AI pauses for the day when this many tokens have been used (AI_DAILY_TOKEN_BUDGET).</td></tr>
            <tr><td>Auto-approve low-risk listings</td><td>{trust ? (trust.autoApprove.enabled ? <Tag kind="ok">On</Tag> : <Tag kind="neutral">Off</Tag>) : <span className="small muted">Unknown</span>}</td>
              <td className="small">{trust?.autoApprove.enabled ? `Listings scored under ${trust.autoApprove.maxScore}, rated low risk, from a verified email and passing every check, go live without waiting. AI never rejects a listing.` : 'Every private listing waits for a person (AI_AUTO_APPROVE_LOW_RISK). AI never rejects a listing.'}</td></tr>
          </tbody>
        </table></div>
      </Section>

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
  const load = () => api.admin.orgs().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  if (!items) return <p className="muted small">Loading…</p>;
  return (
    <Section title="Organisations" kicker="Verify redress scheme membership before approving">
      {items.length === 0 ? <p className="muted small">No organisations yet.</p> : <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Name</th><th>Redress</th><th>Owner</th><th className="r">Listings</th><th /></tr></thead>
        <tbody>{items.map((o) => <tr key={o.id}><td>{o.name} <span className="xs muted">{o.kind}</span></td><td className="small">{o.redressScheme ?? '—'}</td><td className="small">{o.owners ?? '—'}</td><td className="r num">{o.listings}</td>
          <td>{o.verified ? <button className="btn ghost sm" onClick={() => void api.admin.verifyOrg(o.id, false).then(load)}>Unverify</button> : <button className="btn sm" onClick={() => void api.admin.verifyOrg(o.id, true).then(load)}>Verify</button>}</td></tr>)}</tbody></table></div>}
    </Section>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.admin.users>>['items']>([]);
  const load = () => api.admin.users(q).then((r) => setItems(r.items)).catch(() => {});
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section title="Users">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void load(); }}><input className="input" style={{ maxWidth: 320 }} aria-label="Search users" placeholder="Email or name" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn sm">Search</button></form>
      <div className="table-wrap" tabIndex={0} style={{ marginTop: 10 }}><table className="t"><thead><tr><th>User</th><th>Type</th><th>Verified</th><th>Role</th></tr></thead>
        <tbody>{items.map((u) => <tr key={u.id}><td className="small">{u.name}<div className="xs muted">{u.email}</div></td><td className="small">{u.accountType}</td><td className="small">{u.emailVerified ? 'Yes' : 'No'}</td>
          <td><select className="input" aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => void api.admin.setRole(u.id, e.target.value as 'member' | 'admin').then(load).catch((er: ApiError) => alert(er.message))}><option value="member">Member</option><option value="admin">Admin</option></select></td></tr>)}</tbody></table></div>
    </Section>
  );
}

function Audit() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.admin.audit>>['items']>([]);
  useEffect(() => { api.admin.audit().then((r) => setItems(r.items)).catch(() => {}); }, []);
  return (
    <Section title="Audit trail" kicker="Most recent 100 actions">
      <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th></tr></thead>
        <tbody>{items.map((a) => <tr key={a.id}><td className="xs">{new Date(a.at).toLocaleString('en-GB')}</td><td className="xs">{a.actor ?? 'system'}</td><td className="xs">{a.action}</td><td className="xs">{a.subject}</td></tr>)}</tbody></table></div>
    </Section>
  );
}
