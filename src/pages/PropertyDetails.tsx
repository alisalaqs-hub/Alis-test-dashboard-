import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProperty, photosFor, type Property } from '../data/properties';
import { dealScore, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { rentalScenario, valuationScenario } from '../engine/valuation';
import { getConsent, recentEvents, setConsent, track } from '../engine/tracking';
import { propertySkills } from '../ai/skills';
import { AssistantPanel } from '../components/Assistant';
import { SimilarHomes } from '../components/ai/SimilarHomes';
import { gbp, gbpK, HouseArt, Section, Stat, Tag } from '../components/ui';
import { useStore } from '../store';
import { api, ApiError } from '../lib/api';
import { isServerRef } from '../lib/listingAdapter';
import { useServer } from '../lib/server';

/** The next few viewing slots: Saturday mornings and weekday evenings. */
function nextSlots(n = 4) {
  const out: string[] = []; const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 1; out.length < n && i < 21; i++) {
    const day = new Date(d.getTime() + i * 86_400_000); const dow = day.getDay();
    const label = day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    if (dow === 6) out.push(`${label} 10:00`, `${label} 11:30`);
    else if (dow >= 1 && dow <= 4 && out.length < n - 1) out.push(`${label} 17:30`);
  }
  return out.slice(0, n);
}

/** Viewing request / question for a live Streetkey listing: goes to the lister by email and into both inboxes. */
function EnquiryBox({ listingRef, rental, slots, lister }: { listingRef: string; rental: boolean; slots: string[]; lister: string }) {
  const { user } = useServer();
  const [kind, setKind] = useState<'viewing' | 'question'>('viewing');
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', message: '', slot: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => { if (user) setF((x) => ({ ...x, name: x.name || user.name, email: x.email || user.email, phone: x.phone || user.phone || '' })); }, [user]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.listings.enquire(listingRef, { name: f.name, email: f.email, phone: f.phone || undefined, kind, message: f.message || (kind === 'viewing' ? `I’d like to view this ${rental ? 'rental' : 'home'}.` : ''), preferredSlot: kind === 'viewing' ? f.slot || undefined : undefined, website: f.website });
      setSent(true); track(kind === 'viewing' ? 'viewing_request' : 'enquiry', listingRef);
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  if (sent) return <div className="callout ok small" role="status"><b>Sent to {lister}.</b> They’ll reply by email{user ? <> and in your <Link to="/account/inbox">inbox</Link></> : ''}. Never pay a deposit or holding fee before you’ve viewed the property.</div>;
  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="seg" role="group" aria-label="What would you like to do?">
        <button type="button" className={kind === 'viewing' ? 'on' : ''} aria-pressed={kind === 'viewing'} onClick={() => setKind('viewing')}>Request a viewing</button>
        <button type="button" className={kind === 'question' ? 'on' : ''} aria-pressed={kind === 'question'} onClick={() => setKind('question')}>Ask a question</button>
      </div>
      {err && <div className="callout small" role="alert">{err.message}{Object.values(err.fields).map((m) => <div key={m}>• {m}</div>)}</div>}
      {kind === 'viewing' && <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}><legend className="xs muted">Preferred time (the lister confirms)</legend>{slots.map((s) => <label key={s} className="check"><input type="radio" name="slot" checked={f.slot === s} onChange={() => setF({ ...f, slot: s })} />{s}</label>)}</fieldset>}
      <label className="field">Your name<input className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
      <label className="field">Email<input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
      <label className="field">Phone (optional)<input className="input" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label className="field">Message<textarea className="input" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder={kind === 'viewing' ? 'Anything the seller should know?' : 'What would you like to know?'} required={kind === 'question'} /></label>
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} name="website" />
      <button className="btn accent" disabled={busy || !f.name || !f.email || (kind === 'question' && !f.message.trim())}>{busy ? 'Sending…' : kind === 'viewing' ? 'Request viewing' : 'Send question'}</button>
      <p className="xs muted">Your details go only to {lister}. See our <Link to="/privacy">privacy notice</Link>.</p>
    </form>
  );
}

function FloorPlan({ beds, type, area }: { beds: number; type: string; area: number }) {
  const rooms = type === 'commercial'
    ? [['Open-plan office', 0, 0, 200, 110], ['Core / WCs', 200, 0, 80, 50], ['Meeting', 200, 50, 80, 60], ['Reception', 0, 110, 120, 50], ['Plant', 120, 110, 160, 50]]
    : [['Living', 0, 0, 140, 80], ['Kitchen / dining', 140, 0, 140, 80], ['Hall', 0, 80, 60, 80], ['Bath', 60, 80, 60, 40], ...Array.from({ length: Math.max(1, beds) }, (_, i) => [`Bed ${i + 1}`, 120 + (i % 2) * 80, 80 + Math.floor(i / 2) * 40, 80, 40] as const)].slice(0, 8);
  return (
    <svg viewBox="-4 -4 288 172" width="100%" role="img" aria-label="Indicative floor plan">
      {rooms.map(([n, x, y, w, h]) => <g key={n as string}><rect x={x as number} y={y as number} width={w as number} height={h as number} fill="var(--surface)" stroke="var(--ink)" strokeWidth={2} /><text x={(x as number) + 6} y={(y as number) + 16} fontSize={10} fill="var(--ink)" fontFamily="var(--sans)">{n}</text></g>)}
      <text x={280} y={164} fontSize={9} textAnchor="end" fill="var(--muted)">Indicative · {area}m² GIA</text>
    </svg>
  );
}

/**
 * A listing page. Demo listings and ones already loaded are in the shared registry; a live Streetkey
 * listing opened from a link (an email, an alert, a shared URL) is fetched here and kept in this
 * page's own state, so the page shows it as soon as it arrives.
 */
export default function PropertyDetails() {
  const { id = 'wal-001' } = useParams();
  const { online, status, loadListing } = useServer();
  // Re-render when the store's listings change (they are registered while the store renders).
  useStore();
  const [fetched, setFetched] = useState<{ id: string; p: Property | null } | null>(null);
  const registered = getProperty(id);
  const loaded = fetched?.id === id ? fetched.p : null;
  const p = registered ?? loaded ?? undefined;
  const needsFetch = !registered && isServerRef(id) && online;
  useEffect(() => {
    if (!needsFetch) return;
    let live = true;
    void loadListing(id).then((r) => { if (live) setFetched({ id, p: r }); }, () => { if (live) setFetched({ id, p: null }); });
    return () => { live = false; };
  }, [id, needsFetch, loadListing]);
  if (!p) {
    if (isServerRef(id) && (status === 'checking' || (needsFetch && fetched?.id !== id))) return <p className="muted small" role="status" style={{ padding: 20 }}>Loading listing…</p>;
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h2>Listing not found</h2>
        <p className="muted">{isServerRef(id) && status === 'offline' ? 'This listing is on the live Streetkey site and can’t be loaded right now. Please try again later.' : 'It may have been sold, let or withdrawn.'}</p>
        <Link className="btn" to="/search">Search homes</Link>
      </div>
    );
  }
  return <PropertyDetailsInner key={p.id} property={p} />;
}

function PropertyDetailsInner({ property: p }: { property: Property }) {
  const { online } = useServer();
  const live = online && isServerRef(p.id);
  const { saved, compare, toggleSaved, toggleCompare, requestViewing, viewings } = useStore();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [consent, setC] = useState(getConsent());
  const [events, setEvents] = useState(recentEvents());
  const [slot, setSlot] = useState('');
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const photos = p.photos?.length ? p.photos.map((_, i) => ({ id: `${p.id}-u${i}`, label: i === 0 ? 'Lead photo' : `Photo ${i + 1}`, index: i })) : photosFor(p);
  const ds = useMemo(() => dealScore(p), [p]);
  const est = useMemo(() => estimateRefurb(refurbInputFor(p)), [p]);
  const val = useMemo(() => valuationScenario(p), [p]);
  const rent = useMemo(() => rentalScenario(p), [p]);
  const rental = p.listing === 'rent';
  useEffect(() => { track('listing_view', p.id); const h = () => setEvents(recentEvents()); window.addEventListener('streetkey-track', h); h(); return () => window.removeEventListener('streetkey-track', h); }, [p.id, consent]);
  const slots = useMemo(() => nextSlots(), []);
  const myViewing = viewings.find((v) => v.propertyId === p.id);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row small muted"><Link to="/search">← Search</Link><span>/</span><span>{p.town}</span></div>
      <div className="gallery">
        {photos.slice(0, 5).map((ph, i) => (
          <button key={ph.id} onClick={() => { setLightbox(i); track('photo_enlarge', p.id, { photo: ph.label }); }} aria-label={`Enlarge ${ph.label}`}>
            {p.photos?.[i] ? <img src={p.photos[i]} alt={ph.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <HouseArt hue={(p.photoHue + i * 23) % 360} type={i === 0 ? p.type : i % 2 ? 'flat' : p.type} seed={i} after={i > 0 && i % 2 === 0} />}
            <span className="cap">{ph.label}</span>
          </button>
        ))}
      </div>
      <p className="xs muted" style={{ marginTop: -10 }}>{p.photos?.length ? `${p.photos.length} photo${p.photos.length > 1 ? 's' : ''} from the ${p.source?.kind === 'landlord' ? 'landlord' : 'owner'}${p.features.includes('Contains virtually staged images') ? ' · some images are virtually staged' : ''}` : 'Illustrations stand in for listing photography in this prototype.'}</p>
      {lightbox != null && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Photo viewer">
          <div onClick={(e) => e.stopPropagation()}>
            <div style={{ borderRadius: 16, overflow: 'hidden', aspectRatio: '16/10' }}>{p.photos?.[lightbox] ? <img src={p.photos[lightbox]} alt={photos[lightbox].label} style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} /> : <HouseArt hue={(p.photoHue + lightbox * 23) % 360} type={p.type} seed={lightbox} />}</div>
            <div className="row between" style={{ color: '#fff', marginTop: 10 }}>
              <button className="btn ghost sm" style={{ color: '#fff' }} onClick={() => setLightbox((lightbox + photos.length - 1) % photos.length)}>← Prev</button>
              <span>{photos[lightbox].label} · {lightbox + 1}/{photos.length}</span>
              <button className="btn ghost sm" style={{ color: '#fff' }} onClick={() => { const n = (lightbox + 1) % photos.length; setLightbox(n); track('photo_enlarge', p.id, { photo: photos[n].label }); }}>Next →</button>
            </div>
          </div>
        </div>
      )}

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">{p.source ? <Tag kind={p.source.kind === 'agent-feed' ? 'ok' : 'neutral'}>{p.source.name}</Tag> : <Tag kind="demo">Fictional listing</Tag>}{p.source && !p.source.verified && p.source.kind !== 'external-link' && <Tag kind="demo">Verification pending</Tag>}{p.visibility === 'private' && <Tag kind="neutral">Private to you</Tag>}{p.listing === 'auction' && <Tag kind="warn">Auction</Tag>}{p.type === 'commercial' && <Tag kind="neutral">Commercial</Tag>}<Tag kind="neutral">{p.tenure}{p.leaseYears ? ` · ${p.leaseYears} yrs` : ''}</Tag></div>
            <h2>{p.title}</h2>
            <div className="muted">{p.street}, {p.town} · {p.postcode}</div>
            {p.source?.url && <a href={p.source.url} target="_blank" rel="noopener noreferrer" className="small">View the original listing ↗</a>}
            {p.alsoListedBy?.length ? <div className="xs muted">Also listed by {p.alsoListedBy.join(', ')}</div> : null}
            <div className="row" style={{ alignItems: 'flex-end', gap: 22 }}>
              <Stat big label={rental ? 'Rent' : p.listing === 'auction' ? 'Guide price' : 'Asking price'} value={rental ? `${gbp(p.price)} pcm` : gbp(p.price)} sub={`Listed by ${p.agent} · ${p.daysOnMarket} days`} />
              <div className="row">
                <button className={`save-btn${saved.includes(p.id) ? ' on' : ''}`} onClick={() => { toggleSaved(p.id); track('save', p.id); }}>{saved.includes(p.id) ? '♥ Saved' : '♡ Save'}</button>
                <button className={`save-btn${compare.includes(p.id) ? ' on' : ''}`} onClick={() => { toggleCompare(p.id); track('compare_add', p.id); }}>{compare.includes(p.id) ? '✓ Comparing' : '+ Compare'}</button>
                <button className="save-btn" onClick={() => { try { void navigator.clipboard?.writeText(window.location.href); } catch { /* ignore */ } }}>Share link</button>
              </div>
            </div>
          </div>

          <div className="grid g4 keep2">
            {[['Bedrooms', p.beds || '—'], ['Bathrooms', p.baths], ['Floor area', `${p.floorArea}m²`], ['EPC', `${p.epc.current} (${p.epc.score})`]].map(([a, b]) => <div key={a as string} className="card flat" style={{ padding: 12 }}><div className="xs muted">{a}</div><div className="num">{b}</div></div>)}
          </div>

          {!rental && <section className="card ai-card">
            <div className="card-head"><div><div className="eyebrow">Streetkey intelligence</div><h3>See beyond this property</h3></div><Link className="btn sm" to={`/property/${p.id}/intelligence`}>Full intelligence profile →</Link></div>
            <div className="grid g4 keep2">
              <Link to={`/property/${p.id}/intelligence`} style={{ textDecoration: 'none' }}><Stat label={<>Price check <Tag kind="est" /></>} value={val.verdict} sub={`As-is ${gbpK(val.asIs.low)}–${gbpK(val.asIs.high)}`} /></Link>
              <Link to={`/estimate?property=${p.id}`} style={{ textDecoration: 'none' }} onClick={() => track('refurb_sim', p.id)}><Stat label="Refurb estimate" value={gbpK(est.total)} sub={`${gbpK(est.low)}–${gbpK(est.high)}`} /></Link>
              <Link to={`/invest?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Rent potential" value={p.type === 'commercial' ? '—' : `${gbp(rent.mid)} pcm`} sub={p.type === 'commercial' ? 'See development' : `${rent.evidence} let comp(s)`} /></Link>
              <Link to={`/studio?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Deal score" value={`${ds.total} · ${ds.grade}`} sub="Visualise improvements →" /></Link>
            </div>
          </section>}

          <Section title="About this property">
            {p.description && <p style={{ marginBottom: 10 }}>{p.description}</p>}
            <ul className="ticks">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            <p className="small muted" style={{ marginTop: 10 }}>{p.commute.minutes} minutes to {p.commute.to} ({p.commute.mode}); {p.station.name} is a {p.station.walkMins}-minute walk.</p>
          </Section>

          <div className="grid g2">
            <Section title="Floor plan" right={<button className="btn ghost sm" onClick={() => track('floorplan_open', p.id)}>Open full size</button>}><FloorPlan beds={p.beds} type={p.type} area={p.floorArea} /></Section>
            <Section title="Material information" kicker="NTSELAT parts A–C">
              <dl className="kv">
                <dt>Tenure</dt><dd>{p.tenure}{p.leaseYears ? ` (${p.leaseYears} yrs)` : ''}</dd>
                <dt>Council tax</dt><dd>{p.councilTax}</dd>
                {p.serviceChargeAnnual != null && <><dt>Service charge</dt><dd>{gbp(p.serviceChargeAnnual)} p.a.</dd></>}
                {p.groundRentAnnual != null && <><dt>Ground rent</dt><dd>{gbp(p.groundRentAnnual)} p.a.</dd></>}
                <dt>Flood risk</dt><dd>{p.risks.flood}</dd>
                <dt>Conservation area</dt><dd>{p.risks.conservationArea ? 'Yes' : 'No'}</dd>
                <dt>EPC</dt><dd>{p.epc.current} → potential {p.epc.potential}</dd>
              </dl>
            </Section>
          </div>

          <Section title="Documents" right={<Tag kind="live">Document vault</Tag>}>
            <ul className="clean">{(p.documents ?? ['EPC', 'Floor plan']).map((d) => <li key={d} className="row between"><span className="small">📄 {d}</span>{/requested/.test(d) ? <Tag kind="demo">Requested</Tag> : <button className="btn ghost sm" onClick={() => track('document_open', p.id, { doc: d })}>View</button>}</li>)}</ul>
            <p className="xs muted" style={{ marginTop: 8 }}>The AI can read uploaded documents (leases, surveys, legal packs) and flag missing items. Document files are not included in this prototype.</p>
          </Section>

          <AssistantPanel title="Ask about this property" kicker="Property AI" skills={propertySkills} ctx={p} onAnswer={(skill) => track('ai_question', p.id, { topic: skill })} />

          <SimilarHomes property={p} />
        </div>

        <div className="stack sticky" style={{ gap: 16 }}>
          {live ? <Section title={rental ? 'Book a viewing' : 'Arrange a viewing'} kicker={p.agent}><EnquiryBox listingRef={p.id} rental={rental} slots={slots} lister={p.agent} /></Section> : <>
          <Section title={rental ? 'Book a viewing' : 'Arrange a viewing'} kicker={p.agent}>
            {myViewing ? <div className="callout ok small">Viewing requested for <b>{myViewing.slot}</b>. The agent confirms in the app. (Demo: nothing is sent.)</div> : <>
              <div className="stack" style={{ gap: 6 }}>{slots.map((s) => <label key={s} className="check"><input type="radio" name="slot" checked={slot === s} onChange={() => setSlot(s)} />{s}</label>)}</div>
              <button className="btn" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} disabled={!slot} onClick={() => { requestViewing(p.id, slot); track('viewing_request', p.id); }}>Request viewing</button>
            </>}
          </Section>
          <Section title={p.source?.kind === 'owner' || p.source?.kind === 'landlord' ? 'Message the owner' : p.source?.kind === 'external-link' ? 'Contact via the original listing' : 'Contact the agent'}>
            {sent ? <div className="callout ok small">Message queued. (Demo: no message is sent; production routes via the agent’s CRM.)</div> : <>
              <textarea className="input" rows={3} placeholder="I'd like to know about…" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!msg.trim()} onClick={() => { setSent(true); track('enquiry', p.id); }}>Send enquiry</button>
            </>}
          </Section>
          </>}
          <Section title="Your privacy" kicker="What Streetkey records">
            <p className="small">With your consent, Streetkey records anonymous interactions (e.g. photo enlarged, floor plan opened) to give owners <b>aggregated</b> insights. Groups under 10 people are never shown.</p>
            <div className="row" style={{ marginTop: 8 }}>
              <button className={`save-btn${consent === 'granted' ? ' on' : ''}`} onClick={() => { setConsent('granted'); setC('granted'); }}>Allow analytics</button>
              <button className={`save-btn${consent === 'denied' ? ' on' : ''}`} onClick={() => { setConsent('denied'); setC('denied'); setEvents([]); }}>Essential only</button>
            </div>
            <div className="xs muted" style={{ marginTop: 8 }}>{consent === 'granted' ? `${events.length} event(s) this session:` : 'No interaction events are being recorded.'}</div>
            {consent === 'granted' && <ul className="clean xs mono" style={{ marginTop: 6, maxHeight: 140, overflow: 'auto' }}>{events.slice(0, 8).map((e, i) => <li key={i}>{e.at.slice(11, 19)} {e.name}{e.props ? ` ${JSON.stringify(e.props)}` : ''}</li>)}</ul>}
          </Section>
        </div>
      </div>
    </div>
  );
}
