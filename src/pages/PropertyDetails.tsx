import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProperty, photosFor, type Property } from '../data/properties';
import { dealScore, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { rentalScenario, valuationScenario } from '../engine/valuation';
import { getConsent, setConsent, track } from '../engine/tracking';
import { propertySkills } from '../ai/skills';
import { onMarketLine } from '../engine/history';
import { AssistantPanel } from '../components/Assistant';
import { SimilarHomes } from '../components/ai/SimilarHomes';
import { PriceHistory, ReducedTag } from '../components/ListingHistory';
import { gbp, gbpK, HouseArt, sceneFor, Section, Stat, streetName, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { useStore } from '../store';
import { api, ApiError } from '../lib/api';
import { isServerRef } from '../lib/listingAdapter';
import { listingMeta, usePageMeta } from '../lib/meta';
import { EpcValue, FloodValue, OfficialListingPanel, useOfficialListing } from '../components/official/ListingData';
import { useServer } from '../lib/server';
import { useAi } from '../lib/ai/core';
import { slugPlace } from '../lib/meta';
import '../components/floorplan.css';

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

/** True on phone-width screens, where the contact box moves up the page and a contact bar stays in reach. */
function useNarrow(query = '(max-width: 900px)') {
  const [is, setIs] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setIs(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return is;
}

/** Viewing request / question for a live Streetkey listing: goes to the lister by email and into both inboxes. */
function EnquiryBox({ listingRef, rental, lister }: { listingRef: string; rental: boolean; lister: string }) {
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
      {err && <div className="callout small" role="alert">{err.message}{Object.values(err.fields).filter((m): m is string => typeof m === 'string').map((m) => <div key={m}>• {m}</div>)}</div>}
      {/* The lister hasn't published viewing times, so none are offered: the person says what suits them. */}
      {kind === 'viewing' && <label className="field">Which days and times suit you?<input className="input" maxLength={80} value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value })} placeholder="For example weekday evenings, or Saturday morning" /></label>}
      <label className="field">Your name<input className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
      <label className="field">Email<input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
      <label className="field">Phone (optional)<input className="input" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label className="field">Message<textarea className="input" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder={kind === 'viewing' ? (rental ? 'For example when you would like to move in and who will live there' : 'Anything they should know before the viewing?') : 'What would you like to know?'} required={kind === 'question'} /></label>
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} name="website" />
      <button className="btn accent" disabled={busy || !f.name || !f.email || (kind === 'question' && !f.message.trim())}>{busy ? 'Sending…' : kind === 'viewing' ? 'Request a viewing' : 'Send question'}</button>
      <p className="xs muted">Your details go only to {lister}. See our <Link to="/privacy">privacy notice</Link>.</p>
    </form>
  );
}

/**
 * The listing's own floor plan at full size, as a dialog: focus moves to Close, Tab stays inside,
 * Escape or a click outside closes it, and focus goes back to the button that opened it.
 */
function PlanViewer({ plan, onClose }: { plan: { url: string; alt: string }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = [...(box.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? [])];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus(); };
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-label="Floor plan, full size" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 10 }}>
          <b style={{ color: '#fff' }}>Floor plan</b>
          <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        <div className="fp-shown-full" tabIndex={0} role="group" aria-label="Floor plan (scrolls)"><img src={plan.url} alt={plan.alt} /></div>
      </div>
    </div>
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
  usePageMeta(p ? listingMeta(p, isServerRef(p.id)) : { title: 'Property', index: false });
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
  // Real listings get official data (sold prices, flood risk, the energy certificate); demo homes keep their demo figures.
  const official = useOfficialListing(p.id, live);
  const { saved, compare, toggleSaved, toggleCompare, requestViewing, viewings } = useStore();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const closePlan = useCallback(() => setPlanOpen(false), []);
  const [consent, setC] = useState(getConsent());
  const [slot, setSlot] = useState('');
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const photos = p.photos?.length ? p.photos.map((_, i) => ({ id: `${p.id}-u${i}`, label: i === 0 ? 'Lead photo' : `Photo ${i + 1}`, index: i })) : photosFor(p);
  const ds = useMemo(() => dealScore(p), [p]);
  const est = useMemo(() => estimateRefurb(refurbInputFor(p)), [p]);
  const val = useMemo(() => valuationScenario(p), [p]);
  const rent = useMemo(() => rentalScenario(p), [p]);
  const rental = p.listing === 'rent';
  /*
   * A real listing is shown with its lister's facts and official records only. Streetkey's own models (price
   * verdicts, deal scores, rent and refurbishment figures) run on example data, so they are kept to example
   * listings; on a real home the visitor is offered the tools to work things out for themselves.
   */
  const real = isServerRef(p.id);
  const needsWork = p.condition === 'poor' || p.condition === 'derelict';
  const ai = useAi();
  const narrow = useNarrow();
  // Real listings carry Streetkey's record of the listing (first listed, days on the market, price changes); example listings keep their own figures.
  const history = real ? p.history : undefined;
  const offMarket = p.status === 'withdrawn'; // sold, let or withdrawn
  const priceLabel = rental ? 'Rent' : p.listing === 'auction' ? 'Guide price' : 'Asking price';
  useEffect(() => { track('listing_view', p.id); }, [p.id, consent]);
  const slots = useMemo(() => nextSlots(), []);
  const myViewing = viewings.find((v) => v.propertyId === p.id);

  /** Scrolls to the contact box and puts the cursor in its first field. */
  const toContact = () => {
    const box = document.getElementById('enquire');
    box?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    box?.querySelector<HTMLElement>('input:not(.hp), textarea, button')?.focus({ preventScroll: true });
  };
  const contact = (
    <div id="enquire" className="stack" style={{ gap: 16 }}>
      {live ? (
        <Section title={rental ? 'Book a viewing' : 'Arrange a viewing'} kicker={p.agent}>
          <EnquiryBox listingRef={p.id} rental={rental} lister={p.agent} />
          {p.agentId && <p className="small" style={{ marginTop: 10 }}><Link to={`/agent/${p.agentId}`}>More homes from {p.agent}</Link></p>}
        </Section>
      ) : real ? (
        <Section title="Get in touch"><p className="small muted">Enquiries can’t be sent right now. Please try again in a little while.</p></Section>
      ) : (
        <>
          <Section title={rental ? 'Book a viewing' : 'Arrange a viewing'} kicker={p.agent}>
            {myViewing ? <div className="callout ok small" role="status">Viewing requested for <b>{myViewing.slot}</b>. This is an example listing, so nothing has been sent.</div> : <>
              <div className="stack" style={{ gap: 6 }}>{slots.map((sl) => <label key={sl} className="check"><input type="radio" name="slot" checked={slot === sl} onChange={() => setSlot(sl)} />{sl}</label>)}</div>
              <button className="btn" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} disabled={!slot} onClick={() => { requestViewing(p.id, slot); track('viewing_request', p.id); }}>Request viewing</button>
            </>}
          </Section>
          <Section title="Contact the agent">
            {sent ? <div className="callout ok small" role="status">This is an example listing, so no message has been sent.</div> : <>
              <textarea className="input" rows={3} aria-label="Your message" placeholder="I'd like to know about…" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!msg.trim()} onClick={() => { setSent(true); track('enquiry', p.id); }}>Send enquiry</button>
            </>}
          </Section>
        </>
      )}
    </div>
  );

  return (
    <div className="stack lp" style={{ gap: 18 }}>
      <div className="row small muted"><Link to="/search">← Search</Link><span>/</span><span>{p.town}</span></div>
      <div className={`gallery g${Math.min(5, photos.length)}`}>
        {photos.slice(0, 5).map((ph, i) => (
          <button key={ph.id} onClick={() => { setLightbox(i); track('photo_enlarge', p.id, { photo: ph.label }); }} aria-label={`Enlarge ${ph.label}`}>
            {p.photos?.[i] ? <img src={p.photos[i]} alt={ph.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <HouseArt hue={p.photoHue} type={p.type} scene={sceneFor(ph.label)} />}
            <span className="cap">{ph.label}</span>
          </button>
        ))}
      </div>
      <p className="xs muted" style={{ marginTop: -10 }}>{p.photos?.length ? `${p.photos.length} photo${p.photos.length > 1 ? 's' : ''} from the ${p.source?.kind === 'landlord' ? 'landlord' : p.source?.kind === 'agent-feed' ? 'agent' : 'owner'}${p.features.includes('Contains virtually staged images') ? ' · some images are virtually staged' : ''}` : 'Illustration only. This is an example listing, not a home for sale.'}</p>
      {lightbox != null && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Photo viewer">
          <div onClick={(e) => e.stopPropagation()}>
            <div style={{ borderRadius: 16, overflow: 'hidden', aspectRatio: '16/10' }}>{p.photos?.[lightbox] ? <img src={p.photos[lightbox]} alt={photos[lightbox].label} style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} /> : <HouseArt hue={p.photoHue} type={p.type} scene={sceneFor(photos[lightbox].label)} />}</div>
            <div className="row between" style={{ color: '#fff', marginTop: 10 }}>
              <button className="btn ghost sm" style={{ color: '#fff' }} onClick={() => setLightbox((lightbox + photos.length - 1) % photos.length)}>← Prev</button>
              <span>{photos[lightbox].label} · {lightbox + 1}/{photos.length}</span>
              <button className="btn ghost sm" style={{ color: '#fff' }} onClick={() => { const n = (lightbox + 1) % photos.length; setLightbox(n); track('photo_enlarge', p.id, { photo: photos[n].label }); }}>Next →</button>
            </div>
          </div>
        </div>
      )}

      {planOpen && p.floorPlan && <PlanViewer plan={p.floorPlan} onClose={closePlan} />}

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              {p.source ? <Tag kind={p.source.kind === 'agent-feed' ? 'ok' : 'neutral'}>{p.source.name}</Tag> : <Tag kind="demo">Example listing</Tag>}
              {p.visibility === 'private' && <Tag kind="neutral">Private to you</Tag>}
              {p.status === 'under offer' && <Tag kind="warn">{rental ? 'Let agreed' : 'Under offer'}</Tag>}
              {p.listing === 'auction' && <Tag kind="warn">Auction</Tag>}
              {p.type === 'commercial' && <Tag kind="neutral">Commercial</Tag>}
              {!rental && <Tag kind="neutral">{p.tenure}{p.leaseYears ? ` · ${p.leaseYears} yrs` : ''}</Tag>}
            </div>
            <h2>{p.title}</h2>
            <div className="muted">{streetName(p.street)}, {p.town} · {p.postcode}</div>
            {p.source?.url && <a href={p.source.url} target="_blank" rel="noopener noreferrer" className="small">View the original listing ↗</a>}
            {p.alsoListedBy?.length ? <div className="xs muted">Also listed by {p.alsoListedBy.join(', ')}</div> : null}
            <div className="row" style={{ alignItems: 'flex-end', gap: 22 }}>
              <Stat big label={history ? <>{priceLabel} <ReducedTag history={history} rental={rental} /></> : priceLabel} value={rental ? `${gbp(p.price)} pcm` : gbp(p.price)}
                sub={<>{rental ? 'To let by' : 'Listed by'} {p.agentId ? <Link to={`/agent/${p.agentId}`}>{p.agent}</Link> : p.agent} · {history ? onMarketLine(history.daysOnMarket, offMarket) : `${p.daysOnMarket} days`}</>} />
              <div className="row">
                <button className={`save-btn${saved.includes(p.id) ? ' on' : ''}`} onClick={() => { toggleSaved(p.id); track('save', p.id); }}>{saved.includes(p.id) ? '♥ Saved' : '♡ Save'}</button>
                <button className={`save-btn${compare.includes(p.id) ? ' on' : ''}`} onClick={() => { toggleCompare(p.id); track('compare_add', p.id); }}>{compare.includes(p.id) ? '✓ Comparing' : '+ Compare'}</button>
                <button className="save-btn" onClick={() => { try { void navigator.clipboard?.writeText(window.location.href); } catch { /* ignore */ } }}>Share link</button>
              </div>
            </div>
          </div>

          <div className="grid g4 keep2">
            {/* A real listing's energy rating is the letter its lister gave; only example homes carry a score. */}
            {([['bed', 'Bedrooms', p.beds || 'Studio'], ['bath', 'Bathrooms', p.baths], ['area', 'Floor area', `${p.floorArea} m²`], ['bolt', 'Energy rating', real ? (p.epc.current || 'Not given') : `${p.epc.current} (${p.epc.score})`]] as const).map(([ic, a, b]) => <div key={a} className="fact-tile"><span className="trust-ic"><Icon name={ic} size={20} /></span><span><span className="xs muted">{a}</span><span className="num">{b}</span></span></div>)}
          </div>

          {!real && !rental && <section className="card ai-card">
            <div className="card-head"><div><div className="eyebrow">Streetkey intelligence · example figures</div><h3>See beyond this property</h3></div><Link className="btn sm" to={`/property/${p.id}/intelligence`}>Full intelligence profile →</Link></div>
            <div className="grid g4 keep2">
              <Link to={`/property/${p.id}/intelligence`} style={{ textDecoration: 'none' }}><Stat label={<>Price check <Tag kind="est" /></>} value={val.verdict} sub={`As-is ${gbpK(val.asIs.low)}–${gbpK(val.asIs.high)}`} /></Link>
              <Link to={`/estimate?property=${p.id}`} style={{ textDecoration: 'none' }} onClick={() => track('refurb_sim', p.id)}><Stat label="Refurb estimate" value={gbpK(est.total)} sub={`${gbpK(est.low)}–${gbpK(est.high)}`} /></Link>
              <Link to={`/invest?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Rent potential" value={p.type === 'commercial' ? '—' : `${gbp(rent.mid)} pcm`} sub={p.type === 'commercial' ? 'See development' : `${rent.evidence} let comp(s)`} /></Link>
              <Link to={`/studio?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Deal score" value={`${ds.total} · ${ds.grade}`} sub="Visualise improvements →" /></Link>
            </div>
          </section>}

          {/* A real home for sale: no verdicts from Streetkey, only the tools to work things out. */}
          {real && !rental && <section className="card" aria-labelledby="lp-tools-h">
            <h3 id="lp-tools-h" style={{ marginBottom: 12 }}>Work it out for this home</h3>
            <div className="tool-links">
              <Link to={`/sold-prices/${slugPlace(p.district || p.postcode)}`} className="tool-link"><span className="trust-ic"><Icon name="pound" size={20} /></span><span><b>Sold prices nearby</b><small>Every sale registered with HM Land Registry in {p.district || p.postcode}.</small></span></Link>
              <Link to={`/estimate?property=${p.id}`} className="tool-link" onClick={() => track('refurb_sim', p.id)}><span className="trust-ic"><Icon name="tools" size={20} /></span><span><b>Cost the works</b><small>{needsWork ? `The lister says this home needs work. A starting estimate is ${gbpK(est.low)} to ${gbpK(est.high)}: change the rooms and finish to suit.` : 'Planning a new kitchen, a loft room or a refurbishment? Price it room by room.'}</small></span></Link>
              <Link to={`/invest?property=${p.id}`} className="tool-link"><span className="trust-ic"><Icon name="chart" size={20} /></span><span><b>Work out the returns</b><small>Enter the rent you expect to see the yield, cash flow and stamp duty.</small></span></Link>
            </div>
          </section>}

          <Section title="About this property">
            {p.description && <p style={{ marginBottom: 10 }}>{p.description}</p>}
            <ul className="ticks">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            {p.photoFeatures?.length ? (
              <div className="seen-in">
                <span className="seen-in-h"><Icon name="spark" size={15} stroke={2.2} /> Seen in the photos</span>
                <ul className="chips">{p.photoFeatures.map((f) => <li key={f} className="chip static">{f}</li>)}</ul>
                <p className="xs muted">Spotted by Streetkey AI in this listing’s photos, so check them yourself before relying on them.</p>
              </div>
            ) : null}
            {!real && p.commute.minutes > 0 && p.station.walkMins > 0 && <p className="small muted" style={{ marginTop: 10 }}>{p.station.name} is a {p.station.walkMins}-minute walk.</p>}
          </Section>

          {/* On a phone the contact box comes straight after the description, not at the foot of the page. */}
          {narrow && contact}

          <div className="grid g2">
            <Section title="Floor plan" right={p.floorPlan ? <button className="btn ghost sm" onClick={() => { track('floorplan_open', p.id); setPlanOpen(true); }}>Open full size</button> : undefined}>
              {p.floorPlan ? <img className="fp-shown" src={p.floorPlan.url} alt={p.floorPlan.alt} />
                // A real home is never given a made-up layout: until its lister adds a plan, the page says so.
                : real ? <p className="muted small">{p.agent} hasn’t added a floor plan yet. Ask for one when you get in touch.</p>
                  : <FloorPlan beds={p.beds} type={p.type} area={p.floorArea} />}
            </Section>
            <Section title="Key facts">
              <dl className="kv">
                {!rental && <><dt>Tenure</dt><dd>{p.tenure}{p.leaseYears ? ` (${p.leaseYears} yrs)` : ''}</dd></>}
                <dt>Council tax</dt><dd>{p.councilTax ? `Band ${p.councilTax}` : 'Ask the lister'}</dd>
                {!rental && p.serviceChargeAnnual != null && <><dt>Service charge</dt><dd>{gbp(p.serviceChargeAnnual)} p.a.</dd></>}
                {!rental && p.groundRentAnnual != null && <><dt>Ground rent</dt><dd>{gbp(p.groundRentAnnual)} p.a.</dd></>}
                <dt>Flood risk</dt><dd>{live ? <FloodValue official={official} /> : p.risks.flood}</dd>
                {!real && <><dt>Conservation area</dt><dd>{p.risks.conservationArea ? 'Yes' : 'No'}</dd></>}
                <dt>Energy rating</dt><dd>{live ? <EpcValue entered={p.epc.current} official={official} /> : real ? (p.epc.current || 'Not given') : <>{p.epc.current} → potential {p.epc.potential}</>}</dd>
              </dl>
            </Section>
          </div>

          {history && <PriceHistory history={history} rental={rental} closed={offMarket} />}

          <OfficialListingPanel official={official} price={p.price} rental={rental} where={p.postcode || p.district} />

          {!real && <Section title="Documents">
            <ul className="clean">{(p.documents ?? ['EPC', 'Floor plan']).map((d) => <li key={d} className="row between"><span className="small">{d}</span>{/requested/.test(d) ? <Tag kind="neutral">Requested</Tag> : <button className="btn ghost sm" onClick={() => { track('document_open', p.id, { doc: d }); if (d === 'Floor plan' && p.floorPlan) setPlanOpen(true); }}>View</button>}</li>)}</ul>
            <p className="xs muted" style={{ marginTop: 8 }}>Example listings have no files to open.</p>
          </Section>}

          {/* Questions about a real home are answered by AI from its listing, or not offered at all: never from example figures. */}
          {(!real || (ai.available && !rental)) && <AssistantPanel title="Ask about this property" kicker="Property AI" skills={propertySkills} ctx={p} onAnswer={(skill) => track('ai_question', p.id, { topic: skill })} />}

          <SimilarHomes property={p} />

          <div className="privacy-bar">
            <p className="small"><b>Your privacy.</b> With your consent, Streetkey records anonymous activity on listings (such as a photo being enlarged) to show owners totals only. Groups under 10 people are never shown.</p>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className={`save-btn${consent === 'granted' ? ' on' : ''}`} aria-pressed={consent === 'granted'} onClick={() => { setConsent('granted'); setC('granted'); }}>Allow</button>
              <button className={`save-btn${consent === 'denied' ? ' on' : ''}`} aria-pressed={consent === 'denied'} onClick={() => { setConsent('denied'); setC('denied'); }}>Essential only</button>
            </div>
          </div>
        </div>

        {!narrow && <div className="stack sticky" style={{ gap: 16 }}>{contact}</div>}
      </div>

      {/* Phones: the way to get in touch stays in reach while reading. */}
      <div className="lp-actions" role="group" aria-label="Get in touch">
        <button type="button" className={`icon-btn${saved.includes(p.id) ? ' saved' : ''}`} aria-pressed={saved.includes(p.id)} aria-label={saved.includes(p.id) ? 'Saved' : 'Save this home'} onClick={() => { toggleSaved(p.id); track('save', p.id); }}><Icon name="heart" /></button>
        <button type="button" className="btn accent" onClick={toContact}>{live ? 'Request a viewing' : 'Arrange a viewing'}</button>
      </div>
    </div>
  );
}
