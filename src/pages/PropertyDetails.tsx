import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProperty, photosFor, PROPERTIES } from '../data/properties';
import { dealScore, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { rentalScenario, valuationScenario } from '../engine/valuation';
import { getConsent, recentEvents, setConsent, track } from '../engine/tracking';
import { propertySkills } from '../ai/skills';
import { AssistantPanel } from '../components/Assistant';
import { gbp, gbpK, HouseArt, Section, Stat, Tag } from '../components/ui';
import { useStore } from '../store';

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

export default function PropertyDetails() {
  const { id = 'wal-001' } = useParams();
  const p = getProperty(id) ?? PROPERTIES[0];
  const { saved, compare, toggleSaved, toggleCompare, requestViewing, viewings } = useStore();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [consent, setC] = useState(getConsent());
  const [events, setEvents] = useState(recentEvents());
  const [slot, setSlot] = useState('');
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const photos = photosFor(p);
  const ds = useMemo(() => dealScore(p), [p]);
  const est = useMemo(() => estimateRefurb(refurbInputFor(p)), [p]);
  const val = useMemo(() => valuationScenario(p), [p]);
  const rent = useMemo(() => rentalScenario(p), [p]);
  const rental = p.listing === 'rent';
  useEffect(() => { track('listing_view', p.id); const h = () => setEvents(recentEvents()); window.addEventListener('brixo-track', h); h(); return () => window.removeEventListener('brixo-track', h); }, [p.id, consent]);
  const slots = ['Sat 14 Nov 10:00', 'Sat 14 Nov 11:30', 'Mon 16 Nov 17:30', 'Wed 18 Nov 18:00'];
  const myViewing = viewings.find((v) => v.propertyId === p.id);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row small muted"><Link to="/search">← Search</Link><span>/</span><span>{p.town}</span></div>
      <div className="gallery">
        {photos.slice(0, 5).map((ph, i) => (
          <button key={ph.id} onClick={() => { setLightbox(i); track('photo_enlarge', p.id, { photo: ph.label }); }} aria-label={`Enlarge ${ph.label}`}>
            <HouseArt hue={(p.photoHue + i * 23) % 360} type={i === 0 ? p.type : i % 2 ? 'flat' : p.type} seed={i} after={i > 0 && i % 2 === 0} />
            <span className="cap">{ph.label}</span>
          </button>
        ))}
      </div>
      <p className="xs muted" style={{ marginTop: -10 }}>Illustrations stand in for listing photography in this prototype.</p>
      {lightbox != null && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Photo viewer">
          <div onClick={(e) => e.stopPropagation()}>
            <div style={{ borderRadius: 16, overflow: 'hidden', aspectRatio: '16/10' }}><HouseArt hue={(p.photoHue + lightbox * 23) % 360} type={p.type} seed={lightbox} /></div>
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
            <div className="row"><Tag kind="demo">Fictional listing</Tag>{p.listing === 'auction' && <Tag kind="warn">Auction</Tag>}{p.type === 'commercial' && <Tag kind="neutral">Commercial</Tag>}<Tag kind="neutral">{p.tenure}{p.leaseYears ? ` · ${p.leaseYears} yrs` : ''}</Tag></div>
            <h2>{p.title}</h2>
            <div className="muted">{p.street}, {p.town} · {p.postcode}</div>
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
            <div className="card-head"><div><div className="eyebrow">BRIXO intelligence</div><h3>See beyond this property</h3></div><Link className="btn sm" to={`/property/${p.id}/intelligence`}>Full intelligence profile →</Link></div>
            <div className="grid g4 keep2">
              <Link to={`/property/${p.id}/intelligence`} style={{ textDecoration: 'none' }}><Stat label={<>Price check <Tag kind="est" /></>} value={val.verdict} sub={`As-is ${gbpK(val.asIs.low)}–${gbpK(val.asIs.high)}`} /></Link>
              <Link to={`/estimate?property=${p.id}`} style={{ textDecoration: 'none' }} onClick={() => track('refurb_sim', p.id)}><Stat label="Refurb estimate" value={gbpK(est.total)} sub={`${gbpK(est.low)}–${gbpK(est.high)}`} /></Link>
              <Link to={`/invest?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Rent potential" value={p.type === 'commercial' ? '—' : `${gbp(rent.mid)} pcm`} sub={p.type === 'commercial' ? 'See development' : `${rent.evidence} let comp(s)`} /></Link>
              <Link to={`/studio?property=${p.id}`} style={{ textDecoration: 'none' }}><Stat label="Deal score" value={`${ds.total} · ${ds.grade}`} sub="Visualise improvements →" /></Link>
            </div>
          </section>}

          <Section title="About this property">
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
        </div>

        <div className="stack sticky" style={{ gap: 16 }}>
          <Section title={rental ? 'Book a viewing' : 'Arrange a viewing'} kicker={p.agent}>
            {myViewing ? <div className="callout ok small">Viewing requested for <b>{myViewing.slot}</b>. The agent confirms in the app. (Demo: nothing is sent.)</div> : <>
              <div className="stack" style={{ gap: 6 }}>{slots.map((s) => <label key={s} className="check"><input type="radio" name="slot" checked={slot === s} onChange={() => setSlot(s)} />{s}</label>)}</div>
              <button className="btn" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} disabled={!slot} onClick={() => { requestViewing(p.id, slot); track('viewing_request', p.id); }}>Request viewing</button>
            </>}
          </Section>
          <Section title="Contact the agent">
            {sent ? <div className="callout ok small">Message queued. (Demo: no message is sent; production routes via the agent’s CRM.)</div> : <>
              <textarea className="input" rows={3} placeholder="I'd like to know about…" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!msg.trim()} onClick={() => { setSent(true); track('enquiry', p.id); }}>Send enquiry</button>
            </>}
          </Section>
          <Section title="Your privacy" kicker="What BRIXO records">
            <p className="small">With your consent, BRIXO records anonymous interactions (e.g. photo enlarged, floor plan opened) to give owners <b>aggregated</b> insights. Groups under 10 people are never shown.</p>
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
