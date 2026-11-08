import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icons';
import { gbp, Section, Tag } from '../components/ui';
import { api, ApiError, mediaUrl, type MyListing } from '../lib/api';
import type { EnquirySummaryDTO, MessageDTO, SavedSearchDTO } from '../lib/apiTypes';
import { useServer } from '../lib/server';

/* ---------- shared bits ---------- */
function useForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'Something went wrong.')); } finally { setBusy(false); }
  };
  return { busy, error, run, fieldError: (k: string) => error?.fields?.[k] };
}
function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const extra = Object.entries(error.fields ?? {}).filter(([k]) => !['email', 'password', 'name', 'current'].includes(k));
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

function AccountShell({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  const { user } = useServer();
  const { pathname } = useLocation();
  const tabs = [['/account', 'Overview'], ['/account/listings', 'My listings'], ['/account/inbox', 'Inbox'], ['/account/searches', 'Alerts'], ['/account/designs', 'AI designs'], ['/account/privacy', 'Privacy & security'], ...(user?.accountType === 'agent' ? [['/account/agency', 'Agency & feeds']] : []), ...(user?.role === 'admin' ? [['/admin', 'Admin']] : [])];
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">{kicker ?? 'Your account'}</div><h2 style={{ marginTop: 6 }}>{title}</h2></div></div>
      <nav className="acct-tabs" aria-label="Account">{tabs.map(([to, l]) => <Link key={to} to={to} className={pathname === to ? 'on' : ''} aria-current={pathname === to ? 'page' : undefined}>{l}</Link>)}</nav>
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
export function SignIn({ heading = 'Sign in to Streetkey', after }: { heading?: string; after?: () => void }) {
  const { setUser } = useServer();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [f, setF] = useState({ email: '', password: '', name: '', accountType: 'buyer', marketingOptIn: false, acceptTerms: false });
  const form = useForm();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.run(async () => {
      const r = mode === 'in' ? await api.auth.login(f.email, f.password) : await api.auth.register(f);
      setUser(r.user); after?.();
    });
  };
  return (
    <div className="auth-wrap">
      <form className="card stack auth-card" onSubmit={submit} noValidate>
        <h2>{mode === 'in' ? heading : 'Create your Streetkey account'}</h2>
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
          <Field label="I’m mainly here to…"><select className="input" value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value })}>
            <option value="buyer">Buy or rent a home</option><option value="owner">Sell my home</option><option value="landlord">Let property (landlord)</option>
            <option value="investor">Invest in property</option><option value="agent">List as an estate or letting agent</option><option value="developer">Develop property</option>
          </select></Field>
          <label className="check"><input type="checkbox" checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} />I agree to the <Link to="/terms">terms</Link> and have read the <Link to="/privacy">privacy notice</Link>.</label>
          {form.fieldError('acceptTerms') && <span className="xs field-error" role="alert">{form.fieldError('acceptTerms')}</span>}
          <label className="check"><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} />Send me occasional Streetkey news (optional)</label>
        </>}
        <button className="btn accent" disabled={form.busy}>{form.busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
        {mode === 'in' && <Link to="/account/forgot" className="small">Forgotten your password?</Link>}
      </form>
    </div>
  );
}

export function Forgot() {
  const { status } = useServer();
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
        <Link to="/account" className="small">Back to sign in</Link>
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
      {state === 'done' && <><h2>Email confirmed</h2><p className="muted">Thanks. Search alerts and replies will reach you now.</p><Link className="btn" to={user ? '/account' : '/account'}>Go to your account</Link></>}
      {state === 'failed' && <><h2>That link didn’t work</h2><p className="muted">{msg}</p>{user && <button className="btn" onClick={() => void api.auth.resendVerification().then(() => setMsg('We’ve sent a new link.'))}>Send a new link</button>}</>}
    </div></div>
  );
}

/* ---------- overview ---------- */
export function AccountHome() {
  return <Gate><Overview /></Gate>;
}
function Overview() {
  const { user, signOut, health } = useServer();
  const nav = useNavigate();
  const [inbox, setInbox] = useState<{ unread: number; total: number } | null>(null);
  const [mine, setMine] = useState<MyListing[] | null>(null);
  const [resent, setResent] = useState(false);
  useEffect(() => {
    api.me.inbox().then((r) => setInbox({ unread: r.unread, total: r.items.length })).catch(() => {});
    api.me.listings().then((r) => setMine(r.items)).catch(() => {});
  }, []);
  if (!user) return null;
  return (
    <AccountShell title={`Hi, ${user.name.split(' ')[0]}`}>
      {!user.emailVerified && <div className="callout" role="status">Please confirm your email address. We sent a link to <b>{user.email}</b>. {resent ? 'A new link is on its way.' : <button className="linkish" onClick={() => void api.auth.resendVerification().then(() => setResent(true))}>Send it again</button>}</div>}
      <div className="grid g3">
        <Link to="/account/listings" className="card acct-tile"><Icon name="tag" /><b>My listings</b><span className="small muted">{mine ? `${mine.length} listing${mine.length === 1 ? '' : 's'}${mine.some((m) => m.status === 'pending') ? ' · awaiting review' : ''}` : '…'}</span></Link>
        <Link to="/account/inbox" className="card acct-tile"><Icon name="spark" /><b>Inbox</b><span className="small muted">{inbox ? `${inbox.total} conversation${inbox.total === 1 ? '' : 's'}${inbox.unread ? ` · ${inbox.unread} new` : ''}` : '…'}</span></Link>
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
  const [msg, setMsg] = useState<{ ref: string; text: string; ok?: boolean } | null>(null);
  const { refreshListings } = useServer();
  const load = () => api.me.listings().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  const act = async (ref: string, fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ ref, text: ok, ok: true }); await load(); await refreshListings(); } catch (e) { const er = e as ApiError; setMsg({ ref, text: [er.message, ...Object.values(er.fields ?? {})].join(' ') }); }
  };
  return (
    <AccountShell title="My listings">
      {items === null ? <Checking /> : items.length === 0 ? <div className="card stack"><p>You haven’t listed anything yet.</p><Link to="/list" className="btn accent">List a property</Link></div> :
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
                {l.status === 'live' && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, 'under_offer'), 'Marked under offer.')}>Under offer</button>}
                {(l.status === 'live' || l.status === 'under_offer') && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, l.channel === 'rent' ? 'let' : 'sold'), l.channel === 'rent' ? 'Marked let.' : 'Marked sold.')}>{l.channel === 'rent' ? 'Mark let' : 'Mark sold'}</button>}
                {l.status === 'under_offer' && <button className="btn sm ghost" onClick={() => void act(l.ref, () => api.listings.setStatus(l.ref, 'live'), 'Back on the market.')}>Back on market</button>}
                {l.status !== 'withdrawn' && <button className="btn sm ghost" onClick={() => { if (confirm(l.status === 'draft' ? 'Delete this draft?' : 'Withdraw this listing from Streetkey?')) void act(l.ref, () => api.listings.remove(l.ref), l.status === 'draft' ? 'Deleted.' : 'Withdrawn.'); }}>{l.status === 'draft' ? 'Delete' : 'Withdraw'}</button>}
              </div>
              {msg?.ref === l.ref && <div className={`small ${msg.ok ? 'ok-text' : 'field-error'}`} role="status">{msg.text}</div>}
            </div>
          </article>
        ))}
    </AccountShell>
  );
}

/* ---------- inbox ---------- */
export function Inbox() { return <Gate what="Messages"><InboxInner /></Gate>; }
function InboxInner() {
  const [items, setItems] = useState<EnquirySummaryDTO[] | null>(null);
  useEffect(() => { api.me.inbox().then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  return (
    <AccountShell title="Inbox">
      {items === null ? <Checking /> : items.length === 0 ? <p className="muted">No messages yet. Viewing requests and questions about your listings, and replies to your enquiries, appear here.</p> :
        <ul className="clean inbox">{items.map((e) => (
          <li key={e.id}><Link to={`/account/inbox/${e.id}`} className="card inbox-row">
            <div className="row between"><b>{e.role === 'lister' ? e.name : e.listing.title}</b>{e.status === 'new' && e.role === 'lister' && <span className="status-pill s-pending">New</span>}</div>
            <span className="small muted">{e.kind === 'viewing' ? 'Viewing request' : e.kind === 'offer' ? 'Offer' : 'Question'} · {e.listing.title}{e.preferredSlot ? ` · ${e.preferredSlot}` : ''}</span>
            {e.lastMessage && <span className="small">{e.lastMessage.author === (e.role === 'lister' ? 'lister' : 'enquirer') ? 'You: ' : ''}{e.lastMessage.body.slice(0, 140)}</span>}
            <span className="xs muted">{new Date(e.lastMessage?.at ?? e.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </Link></li>
        ))}</ul>}
    </AccountShell>
  );
}

export function Thread() { return <Gate what="Messages"><ThreadInner /></Gate>; }
function ThreadInner() {
  const { id = '' } = useParams();
  const [t, setT] = useState<Awaited<ReturnType<typeof api.enquiries.get>> | null>(null);
  const [body, setBody] = useState('');
  const form = useForm();
  const load = () => api.enquiries.get(id).then(setT).catch(() => setT(null));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return <AccountShell title="Conversation"><Checking /></AccountShell>;
  const mine = (m: MessageDTO) => m.author === t.role;
  return (
    <AccountShell title={t.listing.title} kicker={t.kind === 'viewing' ? 'Viewing request' : t.kind === 'offer' ? 'Offer' : 'Question'}>
      <div className="split-r">
        <div className="card stack">
          <ol className="clean thread">{t.messages.map((m) => <li key={m.id} className={mine(m) ? 'me' : 'them'}><div className="bubble">{m.body}</div><span className="xs muted">{mine(m) ? 'You' : t.role === 'lister' ? t.contact.name : 'Seller / agent'} · {new Date(m.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span></li>)}</ol>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void form.run(async () => { await api.enquiries.reply(id, body); setBody(''); await load(); }); }}>
            <ErrorBox error={form.error} />
            <Field label="Reply"><textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
            <div className="row"><button className="btn accent" disabled={form.busy || !body.trim()}>Send</button>{t.role === 'lister' && t.status !== 'closed' && <button type="button" className="btn ghost" onClick={() => void api.enquiries.setStatus(id, 'closed').then(load)}>Mark as done</button>}</div>
            <p className="xs muted">We email the other person when you reply. Never send money or bank details through messages.</p>
          </form>
        </div>
        <div className="card stack">
          <Link to={`/property/${t.listing.ref}`}><b>{t.listing.title}</b></Link>
          <span className="num">{t.listing.channel === 'rent' ? `${gbp(t.listing.price)} pcm` : gbp(t.listing.price)}</span>
          {t.preferredSlot && <span className="small">Preferred time: <b>{t.preferredSlot}</b></span>}
          {t.role === 'lister' && <><span className="small">{t.contact.name}</span>{t.contact.email && <a className="small" href={`mailto:${t.contact.email}`}>{t.contact.email}</a>}{t.contact.phone && <a className="small" href={`tel:${t.contact.phone.replace(/\s/g, '')}`}>{t.contact.phone}</a>}</>}
        </div>
      </div>
    </AccountShell>
  );
}

/* ---------- saved searches ---------- */
export function Searches() { return <Gate what="Search alerts"><SearchesInner /></Gate>; }
function SearchesInner() {
  const [items, setItems] = useState<SavedSearchDTO[] | null>(null);
  const { user } = useServer();
  const load = () => api.me.searches().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  return (
    <AccountShell title="Search alerts">
      {!user?.emailVerified && <div className="callout small">Confirm your email address to start receiving alerts.</div>}
      {items === null ? <Checking /> : items.length === 0 ? <p className="muted">Save a search (the heart next to any search) and we’ll email you when new homes match.</p> :
        <ul className="clean stack">{items.map((s) => (
          <li key={s.id} className="card row between">
            <div className="stack" style={{ gap: 2 }}><Link to={`/search?q=${encodeURIComponent(s.query)}`}><b>{s.query}</b></Link><span className="xs muted">{s.mode === 'rent' ? 'To rent' : 'For sale'}</span></div>
            <div className="row">
              <label className="field" style={{ minWidth: 150 }}>Email me<select className="input" value={s.alertFrequency} onChange={(e) => void api.me.setSearchAlert(s.id, e.target.value as SavedSearchDTO['alertFrequency']).then(load)}>
                <option value="instant">As soon as they’re listed</option><option value="daily">Once a day</option><option value="weekly">Once a week</option><option value="off">Never (just save it)</option>
              </select></label>
              <button className="btn sm ghost" onClick={() => void api.me.removeSearch(s.id).then(load)}>Remove</button>
            </div>
          </li>
        ))}</ul>}
    </AccountShell>
  );
}

/* ---------- AI designs ---------- */
export function Designs() { return <Gate what="AI room designs"><DesignsInner /></Gate>; }
function DesignsInner() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.ai.history>>['items'] | null>(null);
  useEffect(() => { api.ai.history().then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  return (
    <AccountShell title="AI room designs">
      {items === null ? <Checking /> : items.length === 0 ? <div className="stack"><p className="muted">Upload a photo of a room in the Design studio and Streetkey AI redesigns it in the style you choose.</p><Link className="btn accent" to="/studio">Open the Design studio</Link></div> :
        <div className="grid g3">{items.map((d) => (
          <figure key={d.id} className="card ai-design">
            {d.url ? <img src={mediaUrl(d.url)} alt={`AI concept: ${d.style} ${d.room}`} /> : <div className="ai-failed small muted">{d.status === 'failed' ? 'This one didn’t work' : 'Working…'}</div>}
            <figcaption className="stack" style={{ gap: 2 }}><b className="small">{d.style} {d.room === 'living' ? 'living room' : d.room}</b><span className="xs muted">{new Date(d.createdAt).toLocaleDateString('en-GB')} · AI-generated concept</span></figcaption>
          </figure>
        ))}</div>}
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
            <label className="check"><input type="checkbox" checked={user.marketingOptIn} onChange={(e) => void api.me.update({ marketingOptIn: e.target.checked }).then((r) => setUser(r.user))} />Email me Streetkey news</label>
            <button className="btn" disabled={profile.busy}>Save details</button>
            {done && <span className="small ok-text" role="status">{done}</span>}
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
          <button className="btn ghost" onClick={() => void api.me.exportData().then((d) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'streetkey-my-data.json'; a.click(); })}>Download my data</button>
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
