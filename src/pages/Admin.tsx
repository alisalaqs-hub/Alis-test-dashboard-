/** Admin: review listings before they go live, verify agencies, manage roles, read the audit trail. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gbp, Section, Tag } from '../components/ui';
import { api, ApiError, mediaUrl } from '../lib/api';
import { useServer } from '../lib/server';
import { NeedsServer, SignIn } from './Account';

type Queue = Awaited<ReturnType<typeof api.admin.listings>>['items'];

export default function Admin() {
  const { status, user } = useServer();
  if (status === 'checking') return <p className="muted small">Connecting…</p>;
  if (status === 'offline') return <NeedsServer what="The admin area" />;
  if (!user) return <SignIn heading="Sign in as an admin" />;
  if (user.role !== 'admin') return <div className="card"><h2>Admins only</h2><p className="muted">Your account doesn’t have admin access.</p></div>;
  return <AdminInner />;
}

function AdminInner() {
  const [tab, setTab] = useState<'review' | 'agencies' | 'users' | 'audit'>('review');
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.admin.summary>> | null>(null);
  useEffect(() => { api.admin.summary().then(setSummary).catch(() => {}); }, [tab]);
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
      <div className="seg" role="group" aria-label="Admin sections">{(['review', 'agencies', 'users', 'audit'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'review' ? `Review${summary?.listings.pending ? ` (${summary.listings.pending})` : ''}` : t === 'agencies' ? `Agencies${summary?.orgsAwaitingVerification ? ` (${summary.orgsAwaitingVerification})` : ''}` : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      {tab === 'review' && <Review />}
      {tab === 'agencies' && <Agencies />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Review() {
  const [items, setItems] = useState<Queue | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const load = () => api.admin.listings('pending').then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  const act = (p: Promise<unknown>, text: string) => p.then(() => { setMsg(text); void load(); }).catch((e: ApiError) => setMsg(e.message));
  if (!items) return <p className="muted small">Loading…</p>;
  return (
    <div className="stack">
      {msg && <div className="callout ok small" role="status">{msg}</div>}
      {items.length === 0 ? <p className="muted">Nothing waiting for review.</p> : items.map((l) => (
        <article key={l.ref} className="card stack">
          <div className="row between"><b>{l.title ?? `${l.beds}-bed ${l.type}`}</b><span className="num">{l.channel === 'rent' ? `${gbp(l.price)} pcm` : gbp(l.price)}</span></div>
          <span className="small muted">{l.addressLine}, {l.town} {l.postcode} · listed by {l.lister ?? 'unknown'} ({l.source.kind}) · ownership {l.ownershipDeclared ? 'declared' : 'NOT declared'}{l.ownershipVerified ? ', verified' : ''}</span>
          {l.photos.length > 0 && <div className="row" style={{ gap: 6 }}>{l.photos.slice(0, 6).map((p) => <img key={p.id} src={mediaUrl(p.url)} alt={p.alt ?? ''} className="admin-thumb" />)}</div>}
          {l.description && <p className="small">{l.description}</p>}
          <div className="row">{l.checks.filter((c) => !c.ok).map((c) => <Tag key={c.id} kind={c.severity === 'block' ? 'warn' : 'neutral'}>{c.message}</Tag>)}{l.checks.every((c) => c.ok) && <Tag kind="ok">All checks pass</Tag>}</div>
          <div className="row">
            <button className="btn accent sm" onClick={() => act(api.admin.approve(l.ref), `${l.ref} is live.`)}>Approve & publish</button>
            {!l.ownershipVerified && <button className="btn ghost sm" onClick={() => act(api.admin.verifyOwnership(l.ref), 'Ownership marked verified.')}>Mark ownership verified</button>}
            <input className="input" style={{ maxWidth: 360 }} placeholder="Reason for changes (sent to the lister)" aria-label={`Reason for rejecting ${l.ref}`} value={reason[l.ref] ?? ''} onChange={(e) => setReason({ ...reason, [l.ref]: e.target.value })} />
            <button className="btn ghost sm" disabled={(reason[l.ref] ?? '').trim().length < 5} onClick={() => act(api.admin.reject(l.ref, reason[l.ref]), 'Sent back to the lister.')}>Request changes</button>
          </div>
        </article>
      ))}
    </div>
  );
}

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
