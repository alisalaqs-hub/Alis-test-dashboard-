/**
 * An estate or letting agent's public page (/agent/<id>): who they are, what they have on the market,
 * a short form to ask them for a valuation, and their live listings.
 *
 * "Book a valuation" asks only how to reach the person, where the property is and whether they want to
 * sell or let it. It never asks about their money (funds, a mortgage or income): that is a product rule.
 * The request goes to the agent by email and into their account, and nowhere else.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Seg, Tag } from '../components/ui';
import { PropertyCard } from '../components/PropertyCard';
import { api, ApiError } from '../lib/api';
import type { AgentProfileDTO } from '../lib/apiTypes';
import { dtoToProperty } from '../lib/listingAdapter';
import { usePageMeta } from '../lib/meta';
import { useServer } from '../lib/server';
import '../styles/agent.css';

type Agent = AgentProfileDTO['agent'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND: Record<Agent['kind'], string> = { agency: 'Estate and letting agent', landlord: 'Landlord', developer: 'Property developer', contractor: 'Contractor' };
const countsLine = (c: Agent['counts']) => `${c.sale} for sale · ${c.rent} to rent`;

function NotFoundCard() {
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <h1 className="agent-h1">Agent not found</h1>
      <p className="muted" style={{ margin: 0 }}>This agent’s page isn’t available. They may no longer be on Streetkey, or the link may be mistyped.</p>
      <div className="row"><Link className="btn" to="/search">Search homes</Link></div>
    </div>
  );
}

/** The short form behind "Book a valuation". Mounted afresh for each agent, so nothing typed for one is sent to another. */
function ValuationForm({ agent }: { agent: Agent }) {
  const { user } = useServer();
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', postcode: '', message: '', website: '' });
  const [intent, setIntent] = useState<'sell' | 'let'>('sell');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [sent, setSent] = useState(false);
  const done = useRef<HTMLDivElement>(null);
  const uid = useId();
  // Signing in (or the session loading) after the page opened fills in what is still empty.
  useEffect(() => { if (user) setF((x) => ({ ...x, name: x.name || user.name, email: x.email || user.email, phone: x.phone || user.phone || '' })); }, [user]);
  // The form is replaced by the confirmation: focus goes to it, so it is read out and not lost.
  useEffect(() => { if (sent) done.current?.focus(); }, [sent]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.agents.requestValuation(agent.id, { name: f.name, email: f.email, phone: f.phone || undefined, postcode: f.postcode, intent, message: f.message.trim() || undefined, website: f.website });
      setSent(true);
    } catch (e) { setErr(e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.')); } finally { setBusy(false); }
  };

  if (sent) return <div ref={done} tabIndex={-1} className="callout ok small" role="status"><b>Sent to {agent.name}.</b> They’ll contact you to arrange a visit.</div>;

  /** What the server said about one box. Shown inside the box's label, so it is read out with the label. */
  const problem = (k: string) => (err?.fields?.[k] ? <span className="xs field-error">{err.fields[k]}</span> : null);
  const invalid = (k: string) => (err?.fields?.[k] ? true : undefined);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { const v = e.target.value; setF((x) => ({ ...x, [k]: v })); };

  return (
    <form className="stack agent-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {err && <div className="callout small" role="alert">{err.message}</div>}
      <label className="field">Your name<input className="input" name="name" autoComplete="name" maxLength={80} value={f.name} onChange={set('name')} required aria-invalid={invalid('name')} />{problem('name')}</label>
      <label className="field">Email<input className="input" name="email" type="email" autoComplete="email" maxLength={254} value={f.email} onChange={set('email')} required aria-invalid={invalid('email')} />{problem('email')}</label>
      <label className="field">Phone (optional)<input className="input" name="phone" type="tel" autoComplete="tel" maxLength={30} value={f.phone} onChange={set('phone')} aria-invalid={invalid('phone')} />{problem('phone')}</label>
      <label className="field">Postcode of the property<input className="input agent-postcode" name="postcode" autoComplete="postal-code" autoCapitalize="characters" maxLength={10} value={f.postcode} onChange={set('postcode')} required aria-invalid={invalid('postcode')} />{problem('postcode')}</label>
      <div className="field">
        <span id={`${uid}-intent`}>I want to</span>
        <Seg aria-labelledby={`${uid}-intent`} value={intent} onChange={setIntent} options={[{ value: 'sell', label: 'Sell' }, { value: 'let', label: 'Let' }]} />
        {problem('intent')}
      </div>
      <label className="field">Message (optional)<textarea className="input" name="message" rows={3} maxLength={1000} value={f.message} onChange={set('message')} placeholder="For example the type of property, or when you would like a visit." aria-invalid={invalid('message')} />{problem('message')}</label>
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={set('website')} name="website" />
      <button className="btn accent" disabled={busy}>{busy ? 'Sending…' : 'Request a valuation'}</button>
      <p className="xs muted" style={{ margin: 0 }}>Your details go only to {agent.name}. Streetkey deletes the request after 12 months. See our <Link to="/privacy">privacy notice</Link>.</p>
    </form>
  );
}

function AgentPage({ profile }: { profile: AgentProfileDTO }) {
  const { agent } = profile;
  const homes = useMemo(() => profile.listings.map(dtoToProperty), [profile.listings]);
  const onMarket = agent.counts.sale + agent.counts.rent;
  const since = new Date(`${agent.since}T00:00:00Z`);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <header className="stack agent-head">
        <div className="eyebrow">{KIND[agent.kind] ?? 'Agent'}</div>
        <h1 className="agent-h1">{agent.name}</h1>
        {(agent.verified || agent.redressScheme) && (
          <div className="row">
            {agent.verified && <Tag kind="ok" title="Checked by Streetkey">Verified</Tag>}
            {agent.redressScheme && <span className="small muted">Redress scheme: {agent.redressScheme}</span>}
          </div>
        )}
        <p className="agent-counts">{countsLine(agent.counts)}{agent.counts.soldOrLet12m > 0 ? ` · ${agent.counts.soldOrLet12m} sold or let in the last 12 months` : ''}</p>
        {!Number.isNaN(since.getTime()) && <p className="xs muted" style={{ margin: 0 }}>On Streetkey since {since.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p>}
      </header>

      <div className={`agent-layout${agent.kind === 'agency' ? '' : ' no-form'}`}>
        {/* Valuations are what estate and letting agents do; a landlord's or developer's page shows their homes only. */}
        {agent.kind === 'agency' && (
          <section className="card stack agent-valuation" aria-labelledby="agent-valuation-h">
            <div>
              <h2 id="agent-valuation-h" className="agent-h2">Book a valuation</h2>
              <p className="small muted" style={{ margin: '6px 0 0' }}>Thinking of selling or letting? Ask {agent.name} to visit and tell you what your property could achieve.</p>
            </div>
            <ValuationForm key={agent.id} agent={agent} />
          </section>
        )}

        <section className="stack" aria-labelledby="agent-homes-h">
          <h2 id="agent-homes-h" className="agent-h2">Homes from {agent.name}</h2>
          {homes.length === 0 ? <p className="muted" style={{ margin: 0 }}>{agent.name} has no homes on Streetkey right now. <Link to="/search">Search all homes</Link></p> : (
            <>
              <div className="hgrid">{homes.map((p, i) => <PropertyCard key={p.id} p={p} eager={i < 3} />)}</div>
              {onMarket > homes.length && <p className="xs muted" style={{ margin: 0 }}>Showing the {homes.length} newest of {onMarket}. <Link to="/search">Search all homes</Link></p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AgentProfile() {
  const { id = '' } = useParams();
  const { status, online } = useServer();
  const [loaded, setLoaded] = useState<{ id: string; profile: AgentProfileDTO | null; failed: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wanted = online && UUID.test(id);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api.agents.get(id).then(
      (profile) => { if (live) setLoaded({ id, profile, failed: false }); },
      // Only "there is no such agent" is treated as not found; anything else may work on another go.
      (e: unknown) => { if (live) setLoaded({ id, profile: null, failed: !(e instanceof ApiError && e.status === 404) }); },
    );
    return () => { live = false; };
  }, [wanted, id, attempt]);
  const now = wanted && loaded?.id === id ? loaded : null;
  const profile = now?.profile ?? null;

  // Offered to search engines only when the agent has homes on the market.
  usePageMeta(profile
    ? {
      title: `${profile.agent.name}: homes for sale and to rent`,
      description: `${profile.agent.name} on Streetkey: ${countsLine(profile.agent.counts)}. See their homes or book a valuation.`,
      index: profile.listings.length > 0, canonical: `/agent/${profile.agent.id}`,
    }
    : { title: status === 'checking' || (wanted && !now) ? 'Estate agent' : 'Agent not found', index: false });

  if (status === 'checking' || (wanted && !now)) return <p className="muted small" role="status" style={{ padding: 20 }}>Loading agent…</p>;
  if (profile) return <AgentPage profile={profile} />;
  if (now?.failed) {
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h1 className="agent-h1">We couldn’t load this agent</h1>
        <p className="muted" role="alert" style={{ margin: 0 }}>Something went wrong on the way. Please try again.</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => { setLoaded(null); setAttempt((n) => n + 1); }}>Try again</button>
          <Link className="btn ghost" to="/search">Search homes</Link>
        </div>
      </div>
    );
  }
  return <NotFoundCard />;
}
