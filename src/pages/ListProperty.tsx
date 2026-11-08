import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { areaEvidence, buildListing, complianceChecks, normalisePostcode, POSTCODE_RE, type ListingInput } from '../engine/listings';
import type { Condition, Era, PropertyType } from '../engine/refurb';
import type { Property } from '../data/properties';
import { gbp, gbpK, HouseArt, Seg, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { useStore } from '../store';

const STEPS = ['Basics', 'Address', 'Details', 'Photos', 'Price', 'Description', 'Review'];
const FEATURES = ['Garden', 'Parking', 'Garage', 'Balcony', 'Chain free', 'Period features', 'New kitchen', 'En-suite', 'Pets considered', 'Furnished', 'Close to station', 'Loft potential'];

/** Resize an uploaded image in the browser (keeps the prototype's local storage small). */
function compress(file: File, max = 900): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.72)); URL.revokeObjectURL(img.src);
    };
    img.onerror = reject; img.src = URL.createObjectURL(file);
  });
}

function draftDescription(i: ListingInput): string {
  const kind = i.listing === 'rent' ? 'available to rent' : 'for sale';
  const typeWord = i.type === 'flat' ? 'flat' : `${i.type} house`;
  const feats = i.features.slice(0, 4).map((f) => f.toLowerCase());
  return [
    `A ${i.beds ? `${i.beds}-bedroom ` : ''}${typeWord} ${kind} in ${i.town}${i.floorArea ? `, offering around ${i.floorArea}m² (${Math.round(i.floorArea * 10.764)} sq ft)` : ''}.`,
    feats.length ? `Highlights include ${feats.join(', ')}.` : '',
    i.condition === 'poor' || i.condition === 'derelict' ? 'The property would benefit from modernisation — Streetkey shows buyers a costed renovation estimate on the listing.' : i.condition === 'good' ? 'Presented in good condition throughout.' : '',
    i.listing === 'rent' ? `Rent ${gbp(i.price)} per month. EPC ${i.epc ?? '—'}, council tax band ${i.councilTax ?? '—'}.` : `${i.tenure.replace(/-/g, ' ')}${i.leaseYears ? ` with ${i.leaseYears} years remaining` : ''}. EPC ${i.epc ?? '—'}, council tax band ${i.councilTax ?? '—'}.`,
  ].filter(Boolean).join(' ');
}

export default function ListProperty() {
  const { publishListing, myListings } = useStore();
  const [step, setStep] = useState(0);
  const [who, setWho] = useState<'owner' | 'landlord' | 'agent'>('owner');
  const [staged, setStaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<string>('');
  const [declared, setDeclared] = useState({ owner: false, accurate: false });
  const [done, setDone] = useState<Property | null>(null);
  const [f, setF] = useState<ListingInput>({
    listing: 'sale', addressLine: '', town: '', postcode: '', type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 90,
    era: '1919-1944', condition: 'fair', price: 0, epc: '', councilTax: '', features: [], photos: [], description: '',
    source: { kind: 'owner', name: 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false },
  });
  const set = <K extends keyof ListingInput>(k: K, v: ListingInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const ev = useMemo(() => (POSTCODE_RE.test(f.postcode) ? areaEvidence(f.postcode) : null), [f.postcode]);
  const condAdj = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 }[f.condition ?? 'fair'];
  const range = ev ? (f.listing === 'rent'
    ? { low: Math.round((ev.rentPerM2 * f.floorArea * 0.92) / 25) * 25, high: Math.round((ev.rentPerM2 * f.floorArea * 1.08) / 25) * 25 }
    : { low: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 0.92) / 1000) * 1000, high: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 1.08) / 1000) * 1000 }) : null;
  const checks = complianceChecks({ ...f, description: f.description });
  const blocking = checks.filter((c) => !c.ok && c.severity === 'block');
  const canPublish = blocking.length === 0 && declared.owner && declared.accurate;
  const preview = useMemo(() => buildListing({ ...f, id: 'preview' }), [f]);

  const findPostcode = async () => {
    const pc = normalisePostcode(f.postcode);
    if (!POSTCODE_RE.test(pc)) { setLookup('That doesn’t look like a full UK postcode.'); return; }
    set('postcode', pc); setLookup('Looking up…');
    try {
      // postcodes.io: free, open (OGL) postcode lookup with CORS support.
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
      const j = await r.json();
      if (j.status === 200) {
        setF((x) => ({ ...x, postcode: j.result.postcode, town: x.town || j.result.admin_district, geo: { lat: j.result.latitude, lng: j.result.longitude } }));
        setLookup(`✓ ${j.result.postcode} · ${j.result.admin_district}, ${j.result.region ?? j.result.country}`);
      } else setLookup('Postcode not found — please check it.');
    } catch { setLookup('Couldn’t reach the postcode service — enter the town manually; we’ll verify the postcode later.'); }
  };

  const publish = () => {
    const p = buildListing({ ...f, description: f.description || draftDescription(f), features: staged ? [...f.features, 'Contains virtually staged images'] : f.features,
      source: { kind: who === 'landlord' ? 'landlord' : 'owner', name: who === 'landlord' ? 'Private landlord' : 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false } });
    publishListing(p); setDone(p);
  };

  if (who === 'agent') return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      <h2>Agents: connect your CRM instead</h2>
      <p className="muted">You don’t need to retype listings. Add Streetkey as a portal destination in your CRM (BLM or API feed) and every listing, price change and status update flows in automatically.</p>
      <div className="row"><Link to="/sources" className="btn">Connect a listing feed</Link><button className="btn ghost" onClick={() => setWho('owner')}>I’m a private seller or landlord</button></div>
    </div>
  );

  if (done) return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      <div className="callout ok"><b>Your listing is live on Streetkey.</b> It now appears in search with a full intelligence profile.</div>
      <div className="card stack">
        <b>{done.title}</b><span className="small muted">{done.street}, {done.town} · {done.postcode}</span>
        <span className="num" style={{ fontSize: 22 }}>{done.listing === 'rent' ? `${gbp(done.price)} pcm` : gbp(done.price)}</span>
        <div className="row"><Tag kind="demo">Verification pending</Tag><span className="xs muted">Production: ID check + HM Land Registry title match before the “Verified owner” badge.</span></div>
      </div>
      <div className="row">
        <Link to={`/property/${done.id}`} className="btn">View my listing</Link>
        <Link to={`/property/${done.id}/intelligence`} className="btn ghost">See its intelligence profile</Link>
        <Link to="/saved" className="btn ghost">Manage my listings</Link>
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">List your property</div><h2 style={{ marginTop: 6 }}>Sell or let it yourself — with Streetkey intelligence built in</h2>
          <p className="muted" style={{ marginTop: 6 }}>Seven short steps. Your listing gets a price check, a renovation estimate for buyers and an AI-written description you can edit.</p></div>
        {myListings.length > 0 && <Link to="/saved" className="btn ghost sm">My listings ({myListings.length})</Link>}
      </div>

      <div className="steps" aria-label="Progress">{STEPS.map((s, i) => <button key={s} className={`step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} onClick={() => setStep(i)}><span>{i < step ? '✓' : i + 1}</span>{s}</button>)}</div>

      <div className="split-r">
        <section className="card stack" style={{ gap: 14 }}>
          {step === 0 && <>
            <h3>What are you listing?</h3>
            <label className="field">I want to<Seg value={f.listing} onChange={(v) => set('listing', v)} options={[{ value: 'sale', label: 'Sell' }, { value: 'rent', label: 'Let' }]} /></label>
            <label className="field">I am<Seg value={who} onChange={setWho} options={[{ value: 'owner', label: 'The owner' }, { value: 'landlord', label: 'A landlord' }, { value: 'agent', label: 'An estate agent' }]} /></label>
            <label className="field">Property type<Seg value={f.type} onChange={(v) => set('type', v as PropertyType)} options={[{ value: 'terraced', label: 'Terraced' }, { value: 'semi-detached', label: 'Semi' }, { value: 'detached', label: 'Detached' }, { value: 'flat', label: 'Flat' }, { value: 'bungalow', label: 'Bungalow' }]} /></label>
          </>}
          {step === 1 && <>
            <h3>Where is it?</h3>
            <label className="field">Postcode
              <div className="row" style={{ flexWrap: 'nowrap' }}><input className="input mono" value={f.postcode} placeholder="e.g. E17 4QH" onChange={(e) => set('postcode', e.target.value)} onBlur={() => f.postcode && findPostcode()} /><button className="btn sm" type="button" onClick={findPostcode}>Find</button></div>
            </label>
            {lookup && <div className="xs muted">{lookup}</div>}
            <label className="field">First line of address<input className="input" value={f.addressLine} placeholder="e.g. 12 Example Road" onChange={(e) => set('addressLine', e.target.value)} /></label>
            <label className="field">Town / area<input className="input" value={f.town} onChange={(e) => set('town', e.target.value)} /></label>
            <p className="xs muted">Only the street and area are shown publicly; the house number is shared with people you choose to give it to.</p>
            <label className="field">Tenure<Seg value={f.tenure} onChange={(v) => set('tenure', v)} options={[{ value: 'freehold', label: 'Freehold' }, { value: 'leasehold', label: 'Leasehold' }, { value: 'share-of-freehold', label: 'Share of freehold' }]} /></label>
            {f.tenure !== 'freehold' && <div className="grid g3" style={{ gap: 10 }}>
              <label className="field">Years left on lease<input className="input num" type="number" value={f.leaseYears ?? ''} onChange={(e) => set('leaseYears', Number(e.target.value) || undefined)} /></label>
              <label className="field">Service charge £/yr<input className="input num" type="number" value={f.serviceChargeAnnual ?? ''} onChange={(e) => set('serviceChargeAnnual', e.target.value === '' ? undefined : Number(e.target.value))} /></label>
              <label className="field">Ground rent £/yr<input className="input num" type="number" value={f.groundRentAnnual ?? ''} onChange={(e) => set('groundRentAnnual', e.target.value === '' ? undefined : Number(e.target.value))} /></label>
            </div>}
          </>}
          {step === 2 && <>
            <h3>Tell buyers about it</h3>
            <div className="grid g3" style={{ gap: 10 }}>
              <label className="field">Bedrooms<input className="input num" type="number" min={0} value={f.beds} onChange={(e) => set('beds', Math.max(0, Number(e.target.value) || 0))} /></label>
              <label className="field">Bathrooms<input className="input num" type="number" min={1} value={f.baths} onChange={(e) => set('baths', Math.max(1, Number(e.target.value) || 1))} /></label>
              <label className="field">Floor area m²<input className="input num" type="number" value={f.floorArea} onChange={(e) => set('floorArea', Number(e.target.value) || 0)} /></label>
              <label className="field">EPC rating<select className="input" value={f.epc} onChange={(e) => set('epc', e.target.value)}><option value="">Select…</option>{'ABCDEFG'.split('').map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="field">Council tax band<select className="input" value={f.councilTax} onChange={(e) => set('councilTax', e.target.value)}><option value="">Select…</option>{'ABCDEFGH'.split('').map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="field">Built<select className="input" value={f.era} onChange={(e) => set('era', e.target.value as Era)}>{['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'].map((x) => <option key={x}>{x}</option>)}</select></label>
            </div>
            <label className="field">Condition<Seg value={f.condition ?? 'fair'} onChange={(v) => set('condition', v as Condition)} options={[{ value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Needs work' }, { value: 'derelict', label: 'Major works' }]} /></label>
            <div className="field">Features<div className="chips">{FEATURES.map((x) => <button key={x} type="button" className={`save-btn${f.features.includes(x) ? ' on' : ''}`} onClick={() => set('features', f.features.includes(x) ? f.features.filter((y) => y !== x) : [...f.features, x])}>{x}</button>)}</div></div>
            <p className="xs muted">Don’t know your EPC? Find it free on the government EPC register (find-energy-certificate.service.gov.uk). It’s a legal requirement before marketing.</p>
          </>}
          {step === 3 && <>
            <h3>Photos</h3>
            <label className="dropzone" style={{ display: 'block' }}>
              <input type="file" accept="image/*" multiple hidden onChange={async (e) => { const files = [...(e.target.files ?? [])].slice(0, 10 - (f.photos?.length ?? 0)); setBusy(true); try { const imgs = await Promise.all(files.map((x) => compress(x))); set('photos', [...(f.photos ?? []), ...imgs]); } finally { setBusy(false); } }} />
              <Icon name="home" /> {busy ? 'Processing…' : 'Tap to add photos (up to 10). The first photo is your lead image.'}
            </label>
            {(f.photos?.length ?? 0) > 0 && <div className="photo-grid">{f.photos!.map((src, i) => (
              <div key={i} className="photo-item"><img src={src} alt={`Photo ${i + 1}`} />{i === 0 && <span className="cap-lead">Lead</span>}
                <div className="row photo-actions">{i > 0 && <button className="btn ghost sm" onClick={() => { const a = [...f.photos!]; [a[0], a[i]] = [a[i], a[0]]; set('photos', a); }}>Make lead</button>}<button className="btn ghost sm" onClick={() => set('photos', f.photos!.filter((_, k) => k !== i))}>Remove</button></div>
              </div>))}</div>}
            <label className="check"><input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />Some photos are virtually staged or edited (they will be labelled — required by consumer protection law)</label>
            <p className="xs muted">Tip: the Streetkey Design Studio can create a labelled “what it could look like” concept for rooms that need work.</p>
          </>}
          {step === 4 && <>
            <h3>{f.listing === 'rent' ? 'Monthly rent' : 'Asking price'}</h3>
            <div className="input-prefix"><span>£</span><input className="input num" style={{ fontSize: 22 }} type="number" value={f.price || ''} placeholder={f.listing === 'rent' ? 'e.g. 1650' : 'e.g. 450000'} onChange={(e) => set('price', Number(e.target.value) || 0)} /></div>
            <div className="callout info small">
              <b><Icon name="spark" size={14} /> Streetkey price check</b>{' '}
              {range ? <>Similar homes in {ev!.scope} suggest <b className="num">{f.listing === 'rent' ? `${gbp(range.low)}–${gbp(range.high)} pcm` : `${gbpK(range.low)}–${gbpK(range.high)}`}</b> for {f.floorArea}m² in {f.condition} condition ({ev!.n} demo comparable{ev!.n === 1 ? '' : 's'}).
                {f.price > 0 && <> Your price is <b>{f.price > range.high ? 'above' : f.price < range.low ? 'below' : 'within'}</b> that range.{f.price > range.high * 1.05 ? ' Homes priced above the evidence tend to get views but few enquiries.' : ''}</>}</> : 'Add a valid postcode to see a price check.'}
              <div className="xs muted" style={{ marginTop: 6 }}>Indicative only — not a valuation. Production uses HM Land Registry sold prices.</div>
            </div>
            {f.listing === 'rent' && <p className="xs muted">Rental adverts must show a fixed rent. You can’t invite or accept offers above it.</p>}
          </>}
          {step === 5 && <>
            <div className="row between"><h3>Description</h3><button className="btn sm" onClick={() => set('description', draftDescription(f))}><Icon name="spark" size={16} /> Write it for me</button></div>
            <textarea className="input" rows={8} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Describe what makes it special…" />
            <p className="xs muted">The AI draft only uses facts you entered. Material information (tenure, council tax, EPC, charges) is shown from your answers, not generated.</p>
          </>}
          {step === 6 && <>
            <h3>Review & publish</h3>
            <ul className="clean small">{checks.map((c) => <li key={c.id} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><span>{c.ok ? '✅' : c.severity === 'block' ? '⛔' : '⚠️'}</span><span style={{ color: c.ok ? 'var(--muted)' : undefined }}>{c.message}</span></li>)}</ul>
            <label className="check"><input type="checkbox" checked={declared.owner} onChange={(e) => setDeclared({ ...declared, owner: e.target.checked })} />I own this property or am authorised to {f.listing === 'rent' ? 'let' : 'sell'} it</label>
            <label className="check"><input type="checkbox" checked={declared.accurate} onChange={(e) => setDeclared({ ...declared, accurate: e.target.checked })} />The information is accurate and I’ll keep it up to date</label>
            <button className="btn accent" disabled={!canPublish} onClick={publish} style={{ opacity: canPublish ? 1 : 0.5 }}>Publish listing</button>
            {!canPublish && <div className="xs muted">{blocking.length ? `${blocking.length} item${blocking.length > 1 ? 's' : ''} to fix before publishing.` : 'Confirm both declarations to publish.'}</div>}
          </>}
          <div className="row between" style={{ marginTop: 6 }}>
            <button className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)} style={{ visibility: step === 0 ? 'hidden' : 'visible' }}>← Back</button>
            {step < STEPS.length - 1 && <button className="btn" onClick={() => setStep(step + 1)}>Next →</button>}
          </div>
        </section>

        <aside className="stack sticky" style={{ gap: 12 }}>
          <div className="eyebrow">Live preview</div>
          <article className="pcard">
            <div className="pcard-img">{f.photos?.[0] ? <img src={f.photos[0]} alt="Lead" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <HouseArt hue={preview.photoHue} type={f.type} />}</div>
            <div className="pcard-body">
              <span className="num" style={{ fontSize: 19 }}>{f.price ? (f.listing === 'rent' ? `${gbp(f.price)} pcm` : gbp(f.price)) : '£ —'}</span>
              <span className="small" style={{ fontWeight: 600 }}>{preview.title}</span>
              <span className="xs muted">{f.addressLine || 'Street'}, {f.town || 'Town'} · {f.floorArea}m² · EPC {f.epc || '—'}</span>
              <span className="row" style={{ gap: 6, marginTop: 4 }}><Tag kind="neutral">{who === 'landlord' ? 'Private landlord' : 'Private seller'}</Tag>{staged && <Tag kind="warn">Virtually staged images</Tag>}</span>
            </div>
          </article>
          <div className="card flat small">
            <b>What happens next</b>
            <ul className="ticks muted" style={{ marginTop: 6 }}>
              <li>Your listing appears in Streetkey search with an intelligence profile.</li>
              <li>You get the owner dashboard: views, saves, enquiries and what buyers ask.</li>
              <li>Enquiries come to you through Streetkey messaging; your contact details stay private.</li>
              <li>Production: identity check and HM Land Registry title match earn a “Verified owner” badge.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
