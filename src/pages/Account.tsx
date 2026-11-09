import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/inbox.css';
import { Icon } from '../components/Icons';
import { gbp, Section, Tag } from '../components/ui';
import { STYLES } from '../engine/design';
import { api, ApiError, mediaUrl, type MyListing } from '../lib/api';
import { safeNextPath, signInPath, useAi, useAiAction, useSignInPath } from '../lib/ai/core';
import { listingDraftAccountType } from '../lib/ai/listing';
import { defaultIntent, inboxAi, isLive, REPLY_INTENTS, REPLY_TONES, ruleInsights, unfilled, type ListingInsights, type ReplyIntent, type ReplyTone, type SuggestedReply, type Triage, type TriageResponse } from '../lib/ai/inbox';
import type { AiImageDTO, EnquirySummaryDTO, MessageDTO, SavedSearchDTO } from '../lib/apiTypes';
import { useServer } from '../lib/server';

/* ---------- shared bits ---------- */
const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, 'Something went wrong.'));
function useForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  return { busy, error, run, fieldError: (k: string) => error?.fields?.[k] };
}
function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const extra = Object.entries(error.fields ?? {}).filter(([k]) => !['email', 'password', 'name', 'current', 'retryAfter'].includes(k));
  return <div className="callout" role="alert"><b>{error.message}</b>{extra.length > 0 && <ul className="clean small" style={{ marginTop: 6 }}>{extra.map(([k, v]) => <li key={k}>• {v}</li>)}</ul>}</div>;
}
function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return <label className="field">{label}{children}{hint && !error && <span className="xs muted">{hint}</span>}{error && <span className="xs field-error" role="alert">{error}</span>}</label>;
}
export function NeedsServer({ what }: { what: string }) {
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <Tag kind="demo">Preview</Tag>
      <h2>{what} works on the live Streetkey site</h2>
      <p className="muted">You’re looking at a static preview, which has no server behind it. On the live site (served by the Streetkey server) you can create an account, list a property with photos, message sellers and use the AI room designer.</p>
      <Link className="btn ghost" to="/">Back to the preview</Link>
    </div>
  );
}
function Checking() { return <p className="muted small" style={{ padding: 20 }}>Connecting to Streetkey…</p>; }

/** Moves focus to an element that isn't normally focusable (a heading or a status message). */
function focusQuietly(el: HTMLElement | null) {
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus();
}
/** The page's own heading: where focus goes when the control that had it is about to be replaced. */
const focusPageHeading = () => focusQuietly(document.querySelector<HTMLElement>('.page-head h2'));

/** Something couldn't be loaded: say so (never "you have nothing") and offer another go. */
function LoadError({ what, error, onRetry }: { what: string; error: ApiError; onRetry: () => void }) {
  return (
    <div className="callout stack" role="alert" style={{ gap: 8 }}>
      <b>We couldn’t load {what}.</b>
      <span className="small">{error.message}</span>
      {/* This message is replaced when the retry starts: focus waits on the page heading meanwhile. */}
      <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { focusPageHeading(); onRetry(); }}>Try again</button>
    </div>
  );
}

function AccountShell({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  const { user } = useServer();
  const { pathname } = useLocation();
  const tabs = [['/account', 'Overview'], ['/account/listings', 'My listings'], ['/account/inbox', 'Inbox'], ['/account/searches', 'Alerts'], ['/account/designs', 'AI designs'], ['/account/privacy', 'Privacy & security'], ...(user?.accountType === 'agent' ? [['/account/agency', 'Agency & feeds']] : []), ...(user?.role === 'admin' ? [['/admin', 'Admin']] : [])];
  // A conversation (/account/inbox/:id) belongs to the Inbox tab; Overview is only ever /account itself.
  const current = (to: string) => (to === '/account' ? pathname === to : pathname === to || pathname.startsWith(`${to}/`));
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">{kicker ?? 'Your account'}</div><h2 style={{ marginTop: 6 }}>{title}</h2></div></div>
      <nav className="acct-tabs" aria-label="Account">{tabs.map(([to, l]) => <Link key={to} to={to} className={current(to) ? 'on' : ''} aria-current={current(to) ? 'page' : undefined}>{l}</Link>)}</nav>
      {children}
    </div>
  );
}

/** Wraps account pages: needs a server and a signed-in person. */
function Gate({ children, what = 'Your account' }: { children: ReactNode; what?: string }) {
  const { status, user } = useServer();
  if (status === 'checking') return <Checking />;
  if (status === 'offline') return <NeedsServer what={what} />;
  if (!user) return <SignIn />;
  return <>{children}</>;
}

/* ---------- sign in / create account ---------- */
/**
 * Where to go after signing in (/account?next=/studio?room=kitchen): an internal page only, never
 * another site and never the account page itself.
 */
function returnPath(raw: string | null): string | null {
  const p = safeNextPath(raw);
  return p && !/^\/account\/?(?:[?#]|$)/.test(p) ? p : null;
}

export type AccountType = 'buyer' | 'owner' | 'landlord' | 'investor' | 'agent' | 'developer';

/**
 * The sign-in and create-account form.
 * defaultAccountType: what "I’m mainly here to…" starts on (default 'buyer'; coming back to an unsent listing, 'owner' or 'landlord').
 */
export function SignIn({ heading = 'Sign in to Streetkey', after, defaultAccountType }: { heading?: string; after?: () => void; defaultAccountType?: AccountType }) {
  const { setUser } = useServer();
  const [params] = useSearchParams();
  // Signing in from /account?next=…: AccountHome takes them back once they're signed in.
  const next = after ? null : returnPath(params.get('next'));
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [f, setF] = useState(() => {
    // On the way back to the listing form, a new account starts as a seller or landlord, not a buyer.
    const accountType: AccountType = defaultAccountType ?? (next && /^\/list(?:[/?#]|$)/.test(next) ? listingDraftAccountType() : 'buyer');
    return { email: '', password: '', name: '', accountType, marketingOptIn: false, acceptTerms: false };
  });
  const form = useForm();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.busy) return;
    void form.run(async () => {
      const r = mode === 'in' ? await api.auth.login(f.email, f.password) : await api.auth.register(f);
      setUser(r.user); after?.();
    });
  };
  return (
    <div className="auth-wrap">
      <form className="card stack auth-card" onSubmit={submit} noValidate>
        <h2>{mode === 'in' ? heading : 'Create your Streetkey account'}</h2>
        {next && <p className="small muted" style={{ margin: 0 }}>Afterwards, we’ll take you straight back to the page you were on.</p>}
        <div className="seg" role="group" aria-label="Sign in or create an account">
          <button type="button" className={mode === 'in' ? 'on' : ''} aria-pressed={mode === 'in'} onClick={() => setMode('in')}>Sign in</button>
          <button type="button" className={mode === 'up' ? 'on' : ''} aria-pressed={mode === 'up'} onClick={() => setMode('up')}>Create account</button>
        </div>
        <ErrorBox error={form.error} />
        {mode === 'up' && <Field label="Your name" error={form.fieldError('name')}><input className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>}
        <Field label="Email" error={form.fieldError('email')}><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Password" error={form.fieldError('password')} hint={mode === 'up' ? 'At least 10 characters. A few random words works well.' : undefined}>
          <input className="input" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </Field>
        {mode === 'up' && <>
          <Field label="I’m mainly here to…"><select className="input" value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value as AccountType })}>
            <option value="buyer">Buy or rent a home</option><option value="owner">Sell my home</option><option value="landlord">Let property (landlord)</option>
            <option value="investor">Invest in property</option><option value="agent">List as an estate or letting agent</option><option value="developer">Develop property</option>
          </select></Field>
          <label className="check"><input type="checkbox" checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} />I agree to the <Link to="/terms">terms</Link> and have read the <Link to="/privacy">privacy notice</Link>.</label>
          {form.fieldError('acceptTerms') && <span className="xs field-error" role="alert">{form.fieldError('acceptTerms')}</span>}
          <label className="check"><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} />Send me occasional Streetkey news (optional)</label>
        </>}
        {/* aria-disabled (not disabled) while busy, so focus stays on the button. */}
        <button className="btn accent" aria-disabled={form.busy || undefined}>{form.busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
        {mode === 'in' && <Link to={next ? `/account/forgot?next=${encodeURIComponent(next)}` : '/account/forgot'} className="small">Forgotten your password?</Link>}
      </form>
    </div>
  );
}

export function Forgot() {
  const { status } = useServer();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const form = useForm();
  if (status === 'offline') return <NeedsServer what="Password reset" />;
  return (
    <div className="auth-wrap">
      <form className="card stack auth-card" onSubmit={(e) => { e.preventDefault(); void form.run(async () => { await api.auth.forgot(email); setSent(true); }); }}>
        <h2>Reset your password</h2>
        {sent ? <div className="callout ok" role="status">If there’s an account for <b>{email}</b>, we’ve emailed a link to reset the password. It works for one hour.</div> : <>
          <ErrorBox error={form.error} />
          <Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <button className="btn accent" disabled={form.busy}>Email me a reset link</button>
        </>}
        <Link to={signInPath(returnPath(params.get('next')))} className="small">Back to sign in</Link>
      </form>
    </div>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { setUser, status } = useServer();
  const [pw, setPw] = useState('');
  const form = useForm();
  if (status === 'offline') return <NeedsServer what="Password reset" />;
  return (
    <div className="auth-wrap">
      <form className="card stack auth-card" onSubmit={(e) => { e.preventDefault(); void form.run(async () => { const r = await api.auth.reset(params.get('token') ?? '', pw); setUser(r.user); nav('/account'); }); }}>
        <h2>Choose a new password</h2>
        <ErrorBox error={form.error} />
        <Field label="New password" error={form.fieldError('password')} hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
        <button className="btn accent" disabled={form.busy}>Save and sign in</button>
        <p className="xs muted">For your security, this signs you out on every other device.</p>
      </form>
    </div>
  );
}

export function Verify() {
  const [params] = useSearchParams();
  const { status, user, setUser } = useServer();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (status !== 'online') return;
    api.auth.verify(params.get('token') ?? '').then(async () => { setState('done'); const me = await api.auth.me(); setUser(me.user); })
      .catch((e: ApiError) => { setState('failed'); setMsg(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  if (status === 'offline') return <NeedsServer what="Email confirmation" />;
  return (
    <div className="auth-wrap"><div className="card stack auth-card" role="status">
      {state === 'working' && <p>Confirming your email…</p>}
      {state === 'done' && <><h2>Email confirmed</h2><p className="muted">Thanks. Search alerts and replies will reach you now.</p><Link className="btn" to="/account">Go to your account</Link></>}
      {state === 'failed' && <><h2>That link didn’t work</h2><p className="muted">{msg}</p>{user && <button className="btn" onClick={() => void api.auth.resendVerification().then(() => setMsg('We’ve sent a new link.'), (e) => setMsg(asApiError(e).message))}>Send a new link</button>}</>}
    </div></div>
  );
}

/* ---------- overview ---------- */
export function AccountHome() {
  const { user } = useServer();
  const [params] = useSearchParams();
  const next = returnPath(params.get('next'));
  // Signed in (just now, or already) after following a "Sign in" link: back to the page they came from.
  if (user && next) return <Navigate to={next} replace />;
  return <Gate><Overview /></Gate>;
}
function Overview() {
  const { user, signOut, health } = useServer();
  const nav = useNavigate();
  const [inbox, setInbox] = useState<{ unread: number; total: number } | 'error' | null>(null);
  const [mine, setMine] = useState<MyListing[] | 'error' | null>(null);
  const [resent, setResent] = useState<'idle' | 'sent' | 'failed'>('idle');
  useEffect(() => {
    api.me.inbox().then((r) => setInbox({ unread: r.unread, total: r.items.length })).catch(() => setInbox('error'));
    api.me.listings().then((r) => setMine(r.items)).catch(() => setMine('error'));
  }, []);
  if (!user) return null;
  return (
    <AccountShell title={`Hi, ${user.name.split(' ')[0]}`}>
      {!user.emailVerified && <div className="callout" role="status">Please confirm your email address. We sent a link to <b>{user.email}</b>. {resent === 'sent' ? 'A new link is on its way.' : <>{resent === 'failed' && 'That didn’t work just now. '}<button className="linkish" onClick={() => void api.auth.resendVerification().then(() => setResent('sent'), () => setResent('failed'))}>Send it again</button></>}</div>}
      <div className="grid g3">
        <Link to="/account/listings" className="card acct-tile"><Icon name="tag" /><b>My listings</b><span className="small muted">{mine === 'error' ? 'Open to see your listings' : mine ? `${mine.length} listing${mine.length === 1 ? '' : 's'}${mine.some((m) => m.status === 'pending') ? ' · awaiting review' : ''}` : '…'}</span></Link>
        <Link to="/account/inbox" className="card acct-tile"><Icon name="spark" /><b>Inbox</b><span className="small muted">{inbox === 'error' ? 'Open to see your messages' : inbox ? `${inbox.total} conversation${inbox.total === 1 ? '' : 's'}${inbox.unread ? ` · ${inbox.unread} new` : ''}` : '…'}</span></Link>
        <Link to="/saved" className="card acct-tile"><Icon name="heart" /><b>Saved homes</b><span className="small muted">Synced to your account</span></Link>
        <Link to="/account/searches" className="card acct-tile"><Icon name="search" /><b>Search alerts</b><span className="small muted">Emails when new homes match</span></Link>
        <Link to="/account/designs" className="card acct-tile"><Icon name="palette" /><b>AI room designs</b><span className="small muted">{health?.features.aiImages ? 'Your generated concepts' : 'Not switched on yet'}</span></Link>
        <Link to="/account/privacy" className="card acct-tile"><Icon name="key" /><b>Privacy & security</b><span className="small muted">Password, your data, delete account</span></Link>
      </div>
      <div className="row"><Link to="/list" className="btn accent">List a property</Link><button className="btn ghost" onClick={() => void signOut().then(() => nav('/'))}>Sign out</button></div>
    </AccountShell>
  );
}

/* ---------- my listings ---------- */
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', pending: 'Awaiting review', live: 'Live', under_offer: 'Under offer', sold: 'Sold', let: 'Let', withdrawn: 'Withdrawn', rejected: 'Changes needed' };
export function MyListings() { return <Gate what="Managing listings"><MyListingsInner /></Gate>; }
function MyListingsInner() {
  const [items, setItems] = useState<MyListing[] | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<{ ref: string; text: string; ok?: boolean } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { refreshListings } = useServer();
  const ai = useAi();
  const load = useCallback(() => api.me.listings().then((r) => { setItems(r.items); setLoadErr(null); }).catch((e) => setLoadErr(asApiError(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = async (ref: string, fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ ref, text: ok, ok: true }); await load(); await refreshListings(); } catch (e) { const er = asApiError(e); setMsg({ ref, text: [er.message, ...Object.values(er.fields ?? {})].join(' ') }); }
  };
  return (
    <AccountShell title="My listings">
      {items === null ? (loadErr ? <LoadError what="your listings" error={loadErr} onRetry={() => void load()} /> : <Checking />) : items.length === 0 ? <div className="card stack"><p>You haven’t listed anything yet.</p><Link to="/list" className="btn accent">List a property</Link></div> :
        items.map((l) => (
          <article key={l.ref} className="card my-listing">
            <div className="ml-photo">{l.photos[0] ? <img src={mediaUrl(l.photos[0].url)} alt="" /> : <span className="xs muted">No photo</span>}</div>
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <div className="row between"><b>{l.title ?? `${l.beds}-bed ${l.type} in ${l.town}`}</b><span className={`status-pill s-${l.status}`}>{STATUS_LABEL[l.status]}</span></div>
              <span className="small muted">{l.addressLine}, {l.town} {l.postcode} · {l.channel === 'rent' ? `${gbp(l.price)} pcm` : gbp(l.price)}</span>
              {l.status === 'rejected' && l.rejectionReason && <div className="callout small"><b>Reviewer’s note:</b> {l.rejectionReason}</div>}
              {(l.status === 'draft' || l.status === 'rejected') && l.checks.some((c) => !c.ok) && <ul className="clean xs">{l.checks.filter((c) => !c.ok).map((c) => <li key={c.id}>{c.severity === 'block' ? '⛔' : '⚠️'} {c.message}</li>)}</ul>}
              <span className="xs muted">{l.stats.views30d} views (30 days) · {l.stats.saves} saves · {l.stats.enquiries} enquiries{l.stats.newEnquiries ? ` (${l.stats.newEnquiries} new)` : ''}</span>
              <div className="row">
                {['draft', 'rejected', 'withdrawn'].includes(l.status) && <button className="btn sm accent" onClick={() => void act(l.ref, () => api.listings.submit(l.ref), 'Submitted.')}>Submit for review</button>}
                {['draft', 'rejected', 'pending', 'live', 'under_offer'].includes(l.status) && <Link className="btn sm ghost" to={`/list?edit=${l.ref}`}>Edit</Link>}
                {['live', 'under_offer', 'sold', 'let'].includes(l.status) && <Link className="btn sm ghost" to={`/property/${l.ref}`}>View</Link>}
                {isLive(l.status) && <button type="button" className="btn sm ghost insights-toggle" aria-expanded={!!open[l.ref]} aria-controls={`insights-${l.ref}`} onClick={() => setOpen((o) => ({ ...o, [l.ref]: !o[l.ref] }))}><Icon name="spark" size={14} />{ai.available ? 'AI insights' : 'Insights'}</button>}
                {l.status === 'live' && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, 'under_offer'), 'Marked under offer.')}>Under offer</button>}
                {(l.status === 'live' || l.status === 'under_offer') && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, l.channel === 'rent' ? 'let' : 'sold'), l.channel === 'rent' ? 'Marked let.' : 'Marked sold.')}>{l.channel === 'rent' ? 'Mark let' : 'Mark sold'}</button>}
                {l.status === 'under_offer' && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, 'live'), 'Back on the market.')}>Back on market</button>}
                {l.status !== 'withdrawn' && <button className="btn sm ghost" onClick={() => { if (confirm(l.status === 'draft' ? 'Delete this draft?' : 'Withdraw this listing from Streetkey?')) void act(l.ref, () => api.listings.remove(l.ref), l.status === 'draft' ? 'Deleted.' : 'Withdrawn.'); }}>{l.status === 'draft' ? 'Delete' : 'Withdraw'}</button>}
              </div>
              {msg?.ref === l.ref && <div className={`small ${msg.ok ? 'ok-text' : 'field-error'}`} role="status">{msg.text}</div>}
              {/* Once opened, the panel stays mounted (just hidden) so closing and reopening doesn't ask again. */}
              {isLive(l.status) && <div id={`insights-${l.ref}`} className="insights-panel" hidden={!open[l.ref]}>{open[l.ref] !== undefined && <ListingInsightsPanel key={`${l.ref}:${l.updatedAt}`} listing={l} />}</div>}
            </div>
          </article>
        ))}
    </AccountShell>
  );
}

/* ---------- AI listing insights (also used on the owner dashboard) ---------- */
/**
 * How a live listing is doing and what would most improve it. Uses Streetkey AI when it's
 * available (explaining figures the server computes), otherwise Streetkey's built-in rules.
 * Give it key={listing.ref} when the listing can change, so a new listing starts fresh.
 */
export function ListingInsightsPanel({ listing }: { listing: MyListing }) {
  const ai = useAi();
  const insights = useAiAction((ref: string) => inboxAi.insights(ref), { label: 'Listing insights' });
  const rules = useMemo(() => ruleInsights(listing), [listing]);
  useEffect(() => { if (ai.available) void insights.run(listing.ref); }, [ai.available, listing.ref]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ai.reason === 'checking') return <AiThinking label="Checking what’s available" />;
  if (ai.available && insights.data) return <InsightsView data={insights.data} source="ai" />;
  if (ai.available && !insights.error) return <AiThinking label="Looking at how your listing is doing" />;
  return (
    <div className="stack">
      {ai.available && insights.error && <AiErrorNote error={insights.error} onRetry={() => void insights.run(listing.ref)} />}
      {!ai.available && <AiUnavailable reason={ai.reason} feature="AI analysis" />}
      <InsightsView data={rules} source="rules" />
    </div>
  );
}

function InsightsView({ data, source }: { data: ListingInsights; source: 'ai' | 'rules' }) {
  const body = (
    <>
      <p className="insights-h">{data.headline}</p>
      {data.whatsWorking.length > 0 && <><p className="insights-sub">What’s working</p><ul className="insights-working">{data.whatsWorking.map((w) => <li key={w}>{w}</li>)}</ul></>}
      {data.whatToImprove.length > 0 && <>
        <p className="insights-sub">What to improve</p>
        <ol className="insights-list">{data.whatToImprove.map((x) => (
          <li key={x.action}><b className="small">{x.action}</b><span className={`inbox-impact ${x.impact}`}>{x.impact === 'high' ? 'High impact' : x.impact === 'medium' ? 'Medium impact' : 'Low impact'}</span><span className="why">{x.why}</span></li>
        ))}</ol>
      </>}
      {data.priceNote && <><p className="insights-sub">Price</p><p className="small" style={{ margin: 0 }}>{data.priceNote}</p></>}
    </>
  );
  if (source === 'ai') {
    const asOf = data.generatedAt ? ` on ${new Date(data.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    return <AiCard title="Listing insights" footer={<AiDisclaimer>Written by AI from Streetkey’s figures{asOf}. Visitor numbers only count people who allowed analytics. An indicative guide, not a valuation or financial advice.</AiDisclaimer>}>{body}</AiCard>;
  }
  return (
    <section className="card flat stack" aria-label="Listing tips from Streetkey’s built-in rules">
      <div className="row"><Tag kind="neutral">Built-in rules</Tag><b className="small">Quick checks</b></div>
      {body}
      <p className="xs muted" style={{ margin: 0 }}>From Streetkey’s built-in rules and your listing’s figures. Price ranges are an indicative guide, not a valuation.</p>
    </section>
  );
}

/* ---------- inbox ---------- */
function TriageChips({ t, label = true }: { t: Triage; label?: boolean }) {
  if (!t.chips.length) return null;
  return (
    <span className="ai-chips inbox-chips">
      {label && <AiLabel />}<span className="sr-only">AI reading of this enquiry:</span>
      {t.chips.map((c) => <span key={c.label} className={`ai-chip inbox-chip ${c.tone}`}>{c.label}</span>)}
    </span>
  );
}
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const kindLabel = (k: string) => (k === 'viewing' ? 'Viewing request' : k === 'offer' ? 'Offer' : 'Question');

export function Inbox() { return <Gate what="Messages"><InboxInner /></Gate>; }
function InboxInner() {
  const ai = useAi();
  const [items, setItems] = useState<EnquirySummaryDTO[] | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [triage, setTriage] = useState<Record<string, Triage>>({});
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api.me.inbox().then((r) => { setItems(r.items); setLoadErr(null); }).catch((e) => setLoadErr(asApiError(e))), []);
  useEffect(() => { void load(); }, [load]);
  const hasLister = !!items?.some((i) => i.role === 'lister' && !i.filtered);
  useEffect(() => {
    if (!ai.available || !hasLister) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    const fetchChips = (retry: boolean) => inboxAi.triageAll().then((r) => {
      if (!live) return;
      setTriage(r.items);
      // Conversations the server has just started reading: fetch their chips once more, shortly.
      if (retry && r.pending?.length) again = setTimeout(() => { void fetchChips(false); }, 8000);
    }).catch(() => { /* chips are optional */ });
    void fetchChips(true);
    return () => { live = false; if (again) clearTimeout(again); };
  }, [ai.available, hasLister, items]);
  const held = (items ?? []).filter((i) => i.role === 'lister' && i.filtered);
  const shown = (items ?? []).filter((i) => !(i.role === 'lister' && i.filtered));
  const release = async (id: string) => {
    if (busy) return;
    setBusy(id); setNote(null);
    try {
      await inboxAi.unfilter(id);
      setNote({ text: 'Moved to your inbox. We’ve emailed it to you as well.', ok: true });
      // The "Not spam" button goes with its row: keep keyboard focus on the confirmation instead of the page body.
      focusQuietly(noteRef.current);
      await load();
    } catch (e) { setNote({ text: e instanceof ApiError ? e.message : 'That didn’t work. Please try again.', ok: false }); }
    finally { setBusy(null); }
  };
  return (
    <AccountShell title="Inbox">
      {items === null ? (loadErr ? <LoadError what="your messages" error={loadErr} onRetry={() => void load()} /> : <Checking />) : <>
        {loadErr && <p className="small field-error" role="alert" style={{ margin: 0 }}>We couldn’t refresh your messages, so this list may be out of date. <button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>}
        {shown.length === 0 ? <p className="muted">No messages yet. Viewing requests and questions about your listings, and replies to your enquiries, appear here.</p> :
          <ul className="clean inbox">{shown.map((e) => (
            <li key={e.id}><Link to={`/account/inbox/${e.id}`} className="card inbox-row">
              <div className="row between"><b>{e.role === 'lister' ? e.name : e.listing.title}</b>{e.status === 'new' && e.role === 'lister' && <span className="status-pill s-pending">New</span>}</div>
              <span className="small muted">{kindLabel(e.kind)} · {e.listing.title}{e.preferredSlot ? ` · ${e.preferredSlot}` : ''}</span>
              {e.role === 'lister' && triage[e.id] && <TriageChips t={triage[e.id]} />}
              {e.lastMessage && <span className="small">{e.lastMessage.author === (e.role === 'lister' ? 'lister' : 'enquirer') ? 'You: ' : ''}{e.lastMessage.body.slice(0, 140)}</span>}
              <span className="xs muted">{when(e.lastMessage?.at ?? e.createdAt)}</span>
            </Link></li>
          ))}</ul>}
        <div ref={noteRef} tabIndex={-1} role="status" aria-live="polite" className={`small ${note?.ok ? 'ok-text' : 'field-error'}`}>{note?.text}</div>
        {held.length > 0 && <FilteredSection items={held} busy={busy} onRelease={release} />}
      </>}
    </AccountShell>
  );
}

function FilteredSection({ items, busy, onRelease }: { items: EnquirySummaryDTO[]; busy: string | null; onRelease: (id: string) => Promise<void> }) {
  return (
    <details className="card inbox-filtered">
      <summary><span>Filtered ({items.length})</span><span className="xs muted">Held back as likely spam or scams</span></summary>
      <div className="inbox-filtered-body">
        <p className="small muted" style={{ margin: 0 }}>Streetkey’s automatic check held these back and didn’t email them to you. If one is genuine, choose “Not spam”: it moves to your inbox and we email it to you. Never send money or bank details to someone you haven’t met.</p>
        <ul className="clean stack">{items.map((e) => (
          <li key={e.id} className="inbox-filtered-row">
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <Link to={`/account/inbox/${e.id}`}><b>{e.name}</b> · {kindLabel(e.kind)} · {e.listing.title}</Link>
              {e.filterReason && <span className="reason">{e.filterReason}</span>}
              {e.lastMessage && <span className="snippet">“{e.lastMessage.body.slice(0, 160)}{e.lastMessage.body.length > 160 ? '…' : ''}”</span>}
              <span className="xs muted">{when(e.createdAt)}</span>
            </div>
            {/* aria-disabled (not disabled) while moving, so the button keeps keyboard focus. */}
            <button type="button" className="btn sm ghost" aria-disabled={busy === e.id || undefined} aria-label={`Not spam: move the message from ${e.name} to your inbox`} onClick={() => { if (!busy) void onRelease(e.id); }}>{busy === e.id ? 'Moving…' : 'Not spam'}</button>
          </li>
        ))}</ul>
      </div>
    </details>
  );
}

/** Pick one option (a row of toggle buttons with a visible group label). */
function ToggleGroup<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="seg">{options.map((o) => <button key={o.value} type="button" className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>
    </fieldset>
  );
}

/**
 * "Suggest a reply": fills the reply box with an editable draft. Never sends anything.
 * If the reply box already has text, it asks before drafting (so a draft is never paid for and then thrown away).
 */
function ReplyAssist({ id, kind, triage, getBody, onDraft }: { id: string; kind: string; triage: Triage | null; getBody: () => string; onDraft: (s: SuggestedReply) => void }) {
  const ai = useAi();
  const [intent, setIntent] = useState<ReplyIntent>(() => defaultIntent(kind, triage));
  const [chosen, setChosen] = useState(false);
  const [tone, setTone] = useState<ReplyTone>('friendly');
  const [notes, setNotes] = useState('');
  const [said, setSaid] = useState('');
  /** A draft that arrived after the lister changed their own reply: offered, never forced in. */
  const [waiting, setWaiting] = useState<SuggestedReply | null>(null);
  // The status line below says where the draft went (or why it didn't replace the reply), so the shared announcement is off.
  const draft = useAiAction((b: { intent: ReplyIntent; tone: ReplyTone; notes?: string }) => inboxAi.suggestReply(id, b), { label: 'Suggested reply', announce: false });
  useEffect(() => { if (!chosen) setIntent(defaultIntent(kind, triage)); }, [kind, triage, chosen]);
  if (!ai.available) return ai.reason === 'checking' ? null : <p className="xs muted" style={{ margin: 0 }}>{ai.reason === 'offline' ? 'Reply suggestions run on the live Streetkey site.' : 'Reply suggestions aren’t switched on right now.'} You can write your reply as normal.</p>;
  const go = async () => {
    setSaid(''); setWaiting(null);
    const before = getBody().trim();
    if (before && !confirm('Replace what you’ve written with a suggested reply?')) return;
    const r = await draft.run({ intent, tone, notes: notes.trim() || undefined });
    if (!r) return;
    const now = getBody().trim();
    if (now && now !== before) { setWaiting(r); setSaid('A suggested reply is ready. You changed your reply while it was being written, so it hasn’t replaced it.'); return; }
    onDraft(r);
    setSaid('A suggested reply is in the reply box. Check and edit it before sending.');
  };
  return (
    <section className="reply-assist" aria-labelledby={`assist-${id}`}>
      <div className="reply-assist-h"><AiLabel /><h3 id={`assist-${id}`} className="insights-h">Suggest a reply</h3></div>
      <ToggleGroup label="What should the reply do?" value={intent} options={REPLY_INTENTS} onChange={(v) => { setIntent(v); setChosen(true); }} />
      <ToggleGroup label="Tone" value={tone} options={REPLY_TONES} onChange={setTone} />
      <Field label="Anything to include? (optional)" hint="For example times you can do, or answers to their questions. Your full address is only used if you type it here.">
        <textarea className="input" rows={2} maxLength={800} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="row">
        <AiButton kind="ghost" busy={draft.busy} onClick={() => void go()}>Suggest a reply</AiButton>
        <span className="xs muted">Fills the reply box for you to edit. Nothing is sent until you press Send.</span>
      </div>
      {draft.busy && <AiThinking label="Drafting a reply" />}
      {waiting && <div className="row"><button type="button" className="btn sm ghost" onClick={() => { const w = waiting; setWaiting(null); onDraft(w); setSaid('The suggested reply is in the reply box. Check and edit it before sending.'); }}>Use the suggested reply instead</button></div>}
      <AiErrorNote error={draft.error} onRetry={() => void go()} />
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </section>
  );
}

/** The AI's reading of an enquiry, beside the conversation (lister only). */
function ThreadTriage({ res, stalled, onCheck }: { res: TriageResponse | null; stalled: boolean; onCheck: () => void }) {
  const ai = useAi();
  if (!ai.available || !res || res.filtered) return null;
  if (res.status === 'pending') {
    // Polling has stopped and the summary still isn't ready: say so quietly instead of spinning for ever.
    if (stalled) return (
      <AiCard title="Enquiry summary" tone="quiet">
        <p className="small muted" role="status" style={{ margin: 0 }}>The summary isn’t ready yet. Check back shortly.</p>
        <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={onCheck}>Check again</button>
      </AiCard>
    );
    return <AiCard title="Enquiry summary" tone="quiet"><AiThinking label="Summarising this enquiry" /></AiCard>;
  }
  if (!res.triage) return null;
  const t = res.triage;
  return (
    <AiCard title="Enquiry summary" footer={<AiDisclaimer>An AI summary of what they wrote. Check the messages before relying on it.</AiDisclaimer>}>
      {t.summary && <p className="small" style={{ margin: 0 }}>{t.summary}</p>}
      <TriageChips t={t} label={false} />
      {t.questions.length > 0 && <><p className="insights-sub">They asked</p><ul className="insights-working small">{t.questions.map((x) => <li key={x}>{x}</li>)}</ul></>}
    </AiCard>
  );
}

/** Why a conversation can't be shown, with a way back (and another go, when that can help). */
function ThreadUnavailable({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const signIn = useSignInPath();
  const [title, detail] = error.status === 403 ? ['This conversation isn’t available to your account.', 'It belongs to a different Streetkey account. If you sent the message, sign in with the email address you used.']
    : error.status === 404 ? ['Conversation not found.', 'The link may be wrong, or the conversation may have been deleted.']
    : error.status === 401 ? ['Please sign in again.', 'You’ve been signed out, so we couldn’t open this conversation.']
    : ['We couldn’t load this conversation.', error.message];
  const retry = error.status !== 403 && error.status !== 404 && error.status !== 401;
  return (
    <div className="card stack" role="alert" style={{ maxWidth: 640 }}>
      <b>{title}</b>
      <p className="small muted" style={{ margin: 0 }}>{detail}</p>
      <div className="row">
        {retry && <button type="button" className="btn sm ghost" onClick={() => { focusPageHeading(); onRetry(); }}>Try again</button>}
        {error.status === 401 && <Link className="btn sm ghost" to={signIn}>Sign in</Link>}
        <Link className="btn sm ghost" to="/account/inbox">Back to Inbox</Link>
      </div>
    </div>
  );
}

/** One conversation. Keyed by id, so moving between conversations always starts fresh (no draft or AI target carried over). */
export function Thread() {
  const { id = '' } = useParams();
  return <Gate what="Messages"><ThreadInner key={id} id={id} /></Gate>;
}
function ThreadInner({ id }: { id: string }) {
  const [t, setT] = useState<Awaited<ReturnType<typeof api.enquiries.get>> | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [body, setBody] = useState('');
  const [suggested, setSuggested] = useState<SuggestedReply | null>(null);
  const [tri, setTri] = useState<TriageResponse | null>(null);
  const [triStalled, setTriStalled] = useState(false);
  const [triCheck, setTriCheck] = useState(0);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [replyAnyway, setReplyAnyway] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const form = useForm();
  const load = useCallback(() => api.enquiries.get(id).then((r) => { setT(r); setLoadErr(null); }).catch((e) => setLoadErr(asApiError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  const isLister = t?.role === 'lister';
  const isAdmin = t?.role === 'admin';
  // Lister only: the AI triage and whether the screen held this message back (polls briefly while a triage is prepared).
  useEffect(() => {
    if (!isLister) return;
    let live = true, tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTriStalled(false);
    const fetchIt = () => inboxAi.triage(id).then((r) => {
      if (!live) return;
      setTri(r);
      if (r.status !== 'pending') return;
      if (tries++ < 5) timer = setTimeout(fetchIt, 3000);
      else setTriStalled(true);
    }).catch(() => { if (live && tries > 0) setTriStalled(true); /* optional */ });
    void fetchIt();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id, isLister, triCheck]);
  if (!t) return <AccountShell title="Conversation">{loadErr ? <ThreadUnavailable error={loadErr} onRetry={() => void load()} /> : <Checking />}</AccountShell>;

  // Held back by the spam/scam screen (the thread's own flag; the triage reply says the same when AI is on).
  const held = isLister && (t.filtered ?? tri?.filtered ?? false);
  const reason = t.filterReason ?? tri?.filterReason ?? null;
  const mine = (m: MessageDTO) => !isAdmin && m.author === t.role;
  const who = (m: MessageDTO) => isAdmin ? (m.author === 'enquirer' ? `${t.contact.name} (enquirer)` : 'Lister')
    : mine(m) ? 'You' : t.role === 'lister' ? t.contact.name : 'Seller / agent';
  const left = unfilled(body, suggested?.placeholders ?? []);
  const showForm = !isAdmin && (!held || replyAnyway);
  const say = (text: string, ok = true) => { setNote({ text, ok }); focusQuietly(noteRef.current); };

  const applyDraft = (s: SuggestedReply) => {
    setBody(s.reply); setSuggested(s);
    requestAnimationFrame(() => replyRef.current?.focus());
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (form.busy || !body.trim()) return;
    if (left.length && !confirm(`Your reply still contains ${left.join(', ')}. Send it anyway?`)) return;
    void form.run(async () => {
      await api.enquiries.reply(id, body);
      setBody(''); setSuggested(null); setNote({ text: 'Message sent.', ok: true });
      await load();
      replyRef.current?.focus();
    });
  };
  const markDone = () => {
    if (form.busy) return;
    void form.run(async () => {
      await api.enquiries.setStatus(id, 'closed');
      // The button goes once the conversation is done: keep focus on the confirmation.
      say('Marked as done.');
      await load();
    });
  };
  const release = async () => {
    if (releasing) return;
    setReleasing(true); setNote(null);
    try {
      await inboxAi.unfilter(id);
      say('Moved to your inbox and emailed to you. You can reply as normal now.');
      setReplyAnyway(false);
      await load();
      setTriCheck((n) => n + 1); // a triage starts now that it's released
    } catch (e) { say(e instanceof ApiError ? e.message : 'That didn’t work. Please try again.', false); }
    finally { setReleasing(false); }
  };

  return (
    <AccountShell title={t.listing.title} kicker={kindLabel(t.kind)}>
      <div className="split-r">
        <div className="card stack">
          {isAdmin && <div className="callout small">You’re viewing this conversation as a Streetkey admin. It’s read-only: admins can’t post in conversations, so nothing here can appear to come from the buyer or the lister.</div>}
          {held && (
            <div className="callout inbox-held">
              <span><b>{reason ?? 'Held back as possible spam.'}</b> Messages marked “held back” weren’t emailed to you. Never send money or bank details to someone you haven’t met.</span>
              <button type="button" className="btn sm ghost" aria-disabled={releasing || undefined} onClick={() => void release()}>{releasing ? 'Moving…' : 'Not spam'}</button>
            </div>
          )}
          {isAdmin && t.filtered && <div className="callout small"><b>{t.filterReason ?? 'Held back as possible spam.'}</b></div>}
          <div ref={noteRef} tabIndex={-1} role="status" aria-live="polite" className={`small ${note?.ok ? 'ok-text' : 'field-error'}`}>{note?.text}</div>
          {loadErr && <p className="small field-error" role="alert" style={{ margin: 0 }}>We couldn’t refresh this conversation, so it may be out of date. <button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>}
          <ol className="clean thread">{t.messages.map((m) => (
            <li key={m.id} className={isAdmin ? (m.author === 'lister' ? 'me' : 'them') : mine(m) ? 'me' : 'them'}>
              <div className="bubble">{m.body}</div>
              <span className="xs muted">{who(m)} · {when(m.at)}{m.held ? ' · held back, not emailed' : ''}</span>
            </li>
          ))}</ol>
          {isLister && t.status !== 'closed' && !held && <ReplyAssist id={id} kind={t.kind} triage={tri?.triage ?? null} getBody={() => bodyRef.current} onDraft={applyDraft} />}
          {isLister && held && (
            <div className="stack" style={{ gap: 6 }}>
              <p className="small muted" style={{ margin: 0 }}>Reply suggestions are off for held-back messages. Choose “Not spam” first if it’s genuine.</p>
              <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} aria-expanded={replyAnyway} aria-controls={`reply-${id}`}
                onClick={() => { const open = !replyAnyway; setReplyAnyway(open); if (open) requestAnimationFrame(() => replyRef.current?.focus()); }}>{replyAnyway ? 'Hide the reply box' : 'Reply anyway'}</button>
            </div>
          )}
          {!isAdmin && (
            // .stack sets display, which would override the hidden attribute on its own.
            <form id={`reply-${id}`} className="stack" onSubmit={send} hidden={!showForm} style={showForm ? undefined : { display: 'none' }}>
              <ErrorBox error={form.error} />
              <Field label="Reply"><textarea ref={replyRef} className="input" rows={suggested ? 8 : 3} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
              {suggested && body.trim() && <>
                {left.length > 0 && <p className="reply-fill" style={{ margin: 0 }}>Fill in before sending: {left.map((p, i) => <span key={p}>{i > 0 && ', '}<code>{p}</code></span>)}</p>}
                {suggested.warnings.length > 0 && <div className="callout small"><b>Check before sending</b><ul className="reply-warnings">{suggested.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {(suggested.aiNotes?.length ?? 0) > 0 && <div className="callout small"><span className="row" style={{ gap: 6 }}><AiLabel /><b>AI notes</b></span><ul className="reply-warnings">{suggested.aiNotes!.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                <AiDisclaimer>Suggested by AI from your listing and this conversation. You’re responsible for what you send: check facts, times and prices first.</AiDisclaimer>
              </>}
              <div className="row">
                <button className="btn accent" aria-disabled={form.busy || undefined} disabled={!form.busy && !body.trim()}>{form.busy ? 'Please wait…' : 'Send'}</button>
                {isLister && t.status !== 'closed' && <button type="button" className="btn ghost" aria-disabled={form.busy || undefined} onClick={markDone}>Mark as done</button>}
              </div>
              <p className="xs muted">We email the other person when you reply. Never send money or bank details through messages.</p>
            </form>
          )}
        </div>
        <div className="stack">
          <div className="card stack">
            <Link to={`/property/${t.listing.ref}`}><b>{t.listing.title}</b></Link>
            <span className="num">{t.listing.channel === 'rent' ? `${gbp(t.listing.price)} pcm` : gbp(t.listing.price)}</span>
            {t.preferredSlot && <span className="small">Preferred time: <b>{t.preferredSlot}</b></span>}
            {t.role === 'lister' && <><span className="small">{t.contact.name}</span>{t.contact.email && <a className="small" href={`mailto:${t.contact.email}`}>{t.contact.email}</a>}{t.contact.phone && <a className="small" href={`tel:${t.contact.phone.replace(/\s/g, '')}`}>{t.contact.phone}</a>}</>}
          </div>
          {isLister && <ThreadTriage res={tri} stalled={triStalled} onCheck={() => setTriCheck((n) => n + 1)} />}
        </div>
      </div>
    </AccountShell>
  );
}

/* ---------- saved searches ---------- */
export function Searches() { return <Gate what="Search alerts"><SearchesInner /></Gate>; }
function SearchesInner() {
  const [items, setItems] = useState<SavedSearchDTO[] | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string>('');
  const { user } = useServer();
  const load = useCallback(() => api.me.searches().then((r) => { setItems(r.items); setLoadErr(null); }).catch((e) => setLoadErr(asApiError(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = (fn: () => Promise<unknown>) => { setNote(''); void fn().then(load, (e) => setNote(asApiError(e).message)); };
  return (
    <AccountShell title="Search alerts">
      {!user?.emailVerified && <div className="callout small">Confirm your email address to start receiving alerts.</div>}
      <div role="status" aria-live="polite" className="small field-error">{note}</div>
      {items === null ? (loadErr ? <LoadError what="your saved searches" error={loadErr} onRetry={() => void load()} /> : <Checking />) : items.length === 0 ? <p className="muted">Save a search (the heart next to any search) and we’ll email you when new homes match.</p> :
        <ul className="clean stack">{items.map((s) => (
          <li key={s.id} className="card row between">
            {/* Reopens the search as it was saved: the saved mode goes with the link (a rental search opens as a rental search), and
                a sale search saved with its filters keeps the Market filter on "buy". Older searches (no filters) leave it to the words,
                because the site-wide search box always sends mode=buy. */}
            <div className="stack" style={{ gap: 2 }}><Link to={`/search?q=${encodeURIComponent(s.query)}&mode=${encodeURIComponent(s.mode)}${s.mode === 'buy' && s.filters ? '&market=buy' : ''}`}><b>{s.query}</b></Link><span className="xs muted">{s.mode === 'rent' ? 'To rent' : s.mode === 'commercial' ? 'Commercial' : s.mode === 'invest' ? 'Investment' : 'For sale'}</span></div>
            <div className="row">
              <label className="field" style={{ minWidth: 150 }}>Email me<select className="input" value={s.alertFrequency} onChange={(e) => act(() => api.me.setSearchAlert(s.id, e.target.value as SavedSearchDTO['alertFrequency']))}>
                <option value="instant">As soon as they’re listed</option><option value="daily">Once a day</option><option value="weekly">Once a week</option><option value="off">Never (just save it)</option>
              </select></label>
              <button className="btn sm ghost" aria-label={`Remove the saved search “${s.query}”`} onClick={() => { focusPageHeading(); act(() => api.me.removeSearch(s.id)); }}>Remove</button>
            </div>
          </li>
        ))}</ul>}
    </AccountShell>
  );
}

/* ---------- AI designs ---------- */
export function Designs() { return <Gate what="AI room designs"><DesignsInner /></Gate>; }
const roomName = (room: string) => (room === 'living' ? 'living room' : room);
/** The studio, set up to try a design again (the history stores the style's name; the studio takes its id). */
const studioAgain = (d: AiImageDTO) => {
  const style = STYLES.find((s) => s.name === d.style || s.id === d.style);
  return `/studio?${new URLSearchParams({ room: d.room, ...(style ? { style: style.id, tier: style.tier } : {}) })}`;
};
/** How long the page keeps checking on designs still being made (the server gives up on them after 30 minutes). */
/** The stored reason a design failed, minus what the card already says ("didn’t finish", "try again"). */
const failureDetail = (error: string | null) => {
  const rest = (error ?? '').replace(/^this design didn[’']t finish\.?\s*/i, '').trim();
  return /^(please )?try again\.?$/i.test(rest) ? '' : rest;
};
const DESIGN_POLL_MS = 5000;
const DESIGN_POLL_FOR_MS = 10 * 60_000;
function DesignsInner() {
  const [items, setItems] = useState<AiImageDTO[] | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [finished, setFinished] = useState('');
  const statuses = useRef<Map<string, AiImageDTO['status']>>(new Map());
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await api.ai.history();
      // Say when a design that was being made has finished (or failed) while the page was open.
      const changed = r.items.filter((d) => statuses.current.get(d.id) === 'running' && d.status !== 'running');
      if (changed.length) setFinished(changed.map((d) => `Your ${d.style} ${roomName(d.room)} design ${d.status === 'done' ? 'is ready' : 'didn’t finish'}.`).join(' '));
      statuses.current = new Map(r.items.map((d) => [d.id, d.status]));
      setItems(r.items); setLoadErr(null);
    } catch (e) { setLoadErr(asApiError(e)); }
    finally { inFlight.current = false; }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const running = !!items?.some((d) => d.status === 'running');
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => { if (Date.now() - started > DESIGN_POLL_FOR_MS) clearInterval(timer); else void load(); }, DESIGN_POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);
  return (
    <AccountShell title="AI room designs">
      <p className="sr-only" role="status" aria-live="polite">{finished}</p>
      {items === null ? (loadErr ? <LoadError what="your AI designs" error={loadErr} onRetry={() => void load()} /> : <Checking />) : items.length === 0 ? <div className="stack"><p className="muted">Upload a photo of a room in the Design studio and Streetkey AI redesigns it in the style you choose.</p><Link className="btn accent" to="/studio">Open the Design studio</Link></div> : <>
        {loadErr && <p className="small field-error" role="status" style={{ margin: 0 }}>We couldn’t check for updates just now. <button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>}
        <div className="grid g3">{items.map((d) => (
          <figure key={d.id} className="card ai-design">
            {d.status === 'done' && d.url ? <img src={mediaUrl(d.url)} alt={`AI concept: ${d.style} ${roomName(d.room)}`} />
              : d.status === 'failed' ? (
                <div className="ai-failed small"><div className="stack" style={{ gap: 6, padding: 14, textAlign: 'center' }}>
                  <b>This design didn’t finish</b>
                  {failureDetail(d.error) && <span className="muted">{failureDetail(d.error)}</span>}
                  <Link to={studioAgain(d)}>Try again in the studio</Link>
                </div></div>
              ) : <div className="ai-failed small muted"><AiThinking label="Designing" announce={false} /></div>}
            <figcaption className="stack" style={{ gap: 2 }}>
              <b className="small">{d.style} {roomName(d.room)}</b>
              <span className="xs muted">{new Date(d.createdAt).toLocaleDateString('en-GB')} · {d.status === 'done' ? 'AI-generated concept' : d.status === 'running' ? 'Being made: usually under a minute' : 'Not finished'}</span>
            </figcaption>
          </figure>
        ))}</div>
      </>}
    </AccountShell>
  );
}

/* ---------- privacy & security ---------- */
export function PrivacySettings() { return <Gate what="Privacy settings"><PrivacyInner /></Gate>; }
function PrivacyInner() {
  const { user, setUser } = useServer();
  const nav = useNavigate();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [del, setDel] = useState('');
  const [done, setDone] = useState('');
  const [problem, setProblem] = useState('');
  const pwForm = useForm(), delForm = useForm(), profile = useForm();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  if (!user) return null;
  return (
    <AccountShell title="Privacy & security">
      <div className="grid g2">
        <Section title="Your details">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void profile.run(async () => { const r = await api.me.update({ name, phone: phone || null }); setUser(r.user); setDone('Details saved.'); }); }}>
            <ErrorBox error={profile.error} />
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
            <Field label="Phone (shared only when you send an enquiry)" error={profile.fieldError('phone')}><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></Field>
            <label className="check"><input type="checkbox" checked={user.marketingOptIn} onChange={(e) => { setProblem(''); void api.me.update({ marketingOptIn: e.target.checked }).then((r) => setUser(r.user), (er) => setProblem(asApiError(er).message)); }} />Email me Streetkey news</label>
            <button className="btn" disabled={profile.busy}>Save details</button>
            {done && <span className="small ok-text" role="status">{done}</span>}
            <span className="small field-error" role="status">{problem}</span>
          </form>
        </Section>
        <Section title="Change password">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void pwForm.run(async () => { await api.auth.changePassword(pw.current, pw.next); setPw({ current: '', next: '' }); setDone('Password changed. Other devices have been signed out.'); }); }}>
            <ErrorBox error={pwForm.error} />
            <Field label="Current password" error={pwForm.fieldError('current')}><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label="New password" error={pwForm.fieldError('password')} hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <button className="btn" disabled={pwForm.busy}>Change password</button>
          </form>
        </Section>
        <Section title="Your data">
          <p className="small muted">Download everything Streetkey holds about you (UK GDPR right of access).</p>
          <button className="btn ghost" onClick={() => void api.me.exportData().then((d) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'streetkey-my-data.json'; a.click(); }, (er) => setProblem(asApiError(er).message))}>Download my data</button>
        </Section>
        <Section title="Delete account">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!confirm('Delete your account? Your listings will be withdrawn. This can’t be undone.')) return; void delForm.run(async () => { await api.me.deleteAccount(del); setUser(null); nav('/'); }); }}>
            <p className="small muted">Removes your account and personal details. Live listings are withdrawn. Messages others received keep their text but not your details.</p>
            <ErrorBox error={delForm.error} />
            <Field label="Confirm with your password" error={delForm.fieldError('password')}><input className="input" type="password" autoComplete="current-password" value={del} onChange={(e) => setDel(e.target.value)} /></Field>
            <button className="btn ghost danger" disabled={delForm.busy || !del}>Delete my account</button>
          </form>
        </Section>
      </div>
    </AccountShell>
  );
}

/* ---------- agency & feeds ---------- */
export function Agency() { return <Gate what="Agency feeds"><AgencyInner /></Gate>; }
function AgencyInner() {
  const [orgs, setOrgs] = useState<Awaited<ReturnType<typeof api.me.orgs>>['items'] | null>(null);
  const [f, setF] = useState({ name: '', redressScheme: 'The Property Ombudsman' });
  const [key, setKey] = useState('');
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.orgs.keys>>['items']>([]);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof api.orgs.runs>>['items']>([]);
  const form = useForm();
  const load = () => api.me.orgs().then((r) => { setOrgs(r.items); const o = r.items[0]; if (o) { void api.orgs.keys(o.id).then((k) => setKeys(k.items)); void api.orgs.runs(o.id).then((x) => setRuns(x.items)); } }).catch(() => setOrgs([]));
  useEffect(() => { void load(); }, []);
  const org = orgs?.[0];
  const endpoint = `${location.origin}/api/feeds/blm`;
  return (
    <AccountShell title="Agency & listing feeds">
      {orgs === null ? <Checking /> : !org ? (
        <form className="card stack" style={{ maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); void form.run(async () => { await api.orgs.create({ name: f.name, kind: 'agency', redressScheme: f.redressScheme }); await load(); }); }}>
          <h3>Set up your agency</h3>
          <ErrorBox error={form.error} />
          <Field label="Agency trading name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Redress scheme"><select className="input" value={f.redressScheme} onChange={(e) => setF({ ...f, redressScheme: e.target.value })}><option>The Property Ombudsman</option><option>Property Redress Scheme</option></select></Field>
          <button className="btn accent" disabled={form.busy}>Create agency</button>
          <p className="xs muted">An admin checks your redress scheme membership before your listings go live.</p>
        </form>
      ) : (
        <div className="grid g2">
          <Section title={org.name} right={org.verified ? <Tag kind="ok">Verified</Tag> : <Tag kind="warn">Awaiting verification</Tag>}>
            <p className="small">Send your full stock from your CRM as a BLM v3 file. New properties are added, changes updated, and anything missing from the file is withdrawn.</p>
            <pre className="code small">{`POST ${endpoint}\nAuthorization: Bearer <your feed key>\nContent-Type: text/plain\n\n<BLM file>`}</pre>
            <button className="btn" onClick={() => void api.orgs.createKey(org.id, 'CRM feed').then((r) => { setKey(r.key); void load(); })}>Create a feed key</button>
            {key && <div className="callout ok small" role="status">Copy this key now; it won’t be shown again:<br /><code className="inline" style={{ wordBreak: 'break-all' }}>{key}</code></div>}
            {keys.length > 0 && <ul className="clean small" style={{ marginTop: 10 }}>{keys.map((k) => <li key={k.id} className="row between"><span><code className="inline">{k.prefix}…</code> {k.label}{k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString('en-GB')}` : ''}</span>{k.revokedAt ? <span className="xs muted">Revoked</span> : <button className="btn sm ghost" onClick={() => void api.orgs.revokeKey(org.id, k.id).then(load)}>Revoke</button>}</li>)}</ul>}
          </Section>
          <Section title="Recent feed uploads">
            {runs.length === 0 ? <p className="small muted">No uploads yet.</p> : <ul className="clean small">{runs.map((r) => <li key={r.id}>{new Date(r.createdAt).toLocaleString('en-GB')}: {r.accepted} accepted, {r.withdrawn} withdrawn, {r.rejected.length} rejected{r.rejected.length > 0 && <ul className="clean xs muted">{r.rejected.slice(0, 5).map((x) => <li key={x.ref}>{x.ref}: {x.reason}</li>)}</ul>}</li>)}</ul>}
          </Section>
        </div>
      )}
    </AccountShell>
  );
}
