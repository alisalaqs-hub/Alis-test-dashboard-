import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buildListing, extractListing, normalisePostcode, POSTCODE_RE, type Extracted } from '../engine/listings';
import { SAMPLE_PASTE } from '../data/sampleFeed';
import type { PropertyType } from '../engine/refurb';
import type { Property } from '../data/properties';
import { gbp, Section, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { useStore } from '../store';

export default function ImportListing() {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [ex, setEx] = useState<Extracted | null>(null);
  const [fields, setFields] = useState<Extracted['fields']>({});
  const { trackListing, tracked, untrack } = useStore();
  const nav = useNavigate();
  const run = () => { const e = extractListing(text, url); setEx(e); setFields(e.fields); };
  const ok = fields.price && fields.postcode && POSTCODE_RE.test(fields.postcode) && fields.beds != null;
  const save = () => {
    const site = fields.sourceSite ?? 'another website';
    const p = buildListing({
      listing: fields.listing ?? 'sale', title: fields.title, addressLine: 'Address on original listing', town: normalisePostcode(fields.postcode!).split(' ')[0],
      postcode: fields.postcode!, type: (fields.type ?? 'terraced') as PropertyType, tenure: fields.tenure ?? 'freehold', leaseYears: fields.leaseYears,
      beds: fields.beds ?? 0, baths: fields.baths ?? 1, floorArea: fields.floorArea ?? 0, condition: fields.condition, price: fields.price!, epc: fields.epc,
      councilTax: fields.councilTax, serviceChargeAnnual: fields.serviceChargeAnnual, features: fields.features ?? [],
      source: { kind: 'external-link', name: `Listed on ${site}`, url: url || undefined, licence: 'Private analysis of user-provided details; content not republished', verified: false },
      visibility: 'private',
    });
    trackListing(p); nav(`/property/${p.id}/intelligence`);
  };
  const num = (k: keyof Extracted['fields'], label: string) => <label className="field">{label}<input className="input num" type="number" value={(fields[k] as number | undefined) ?? ''} onChange={(e) => setFields({ ...fields, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Check any listing</div><h2 style={{ marginTop: 6 }}>Found a home on another website? Get BRIXO intelligence on it.</h2>
          <p className="muted" style={{ marginTop: 6 }}>Paste the listing link and its key details. BRIXO prices the works, checks the price and runs the numbers — privately, just for you.</p></div>
        <Tag kind="neutral">Private to you · not republished</Tag>
      </div>
      <div className="split">
        <Section title="1. Paste the listing" kicker="From Rightmove, Zoopla, OnTheMarket, an agent’s site…">
          <label className="field">Listing link (optional — we link back to it)<input className="input" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></label>
          <label className="field" style={{ marginTop: 10 }}>Listing details — select all on the listing page, copy and paste here<textarea className="input" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder="Price, address with postcode, bedrooms, tenure, EPC…" /></label>
          <div className="row" style={{ marginTop: 10 }}><button className="btn accent" onClick={run} disabled={!text.trim()}><Icon name="spark" size={16} /> Read it</button><button className="btn ghost sm" onClick={() => { setText(SAMPLE_PASTE); setUrl('https://www.example-portal.co.uk/listing/123456'); }}>Use a sample</button></div>
          <p className="xs muted" style={{ marginTop: 10 }}>BRIXO never visits or copies other websites. It only reads what you paste, keeps the result private to your account, and links back to the original listing.</p>
        </Section>
        <div className="stack" style={{ gap: 16 }}>
          {ex ? <Section title="2. Check what we found" kicker={`${ex.found.length} details found`} right={<Tag kind="ai">Extracted — please confirm</Tag>}>
            {ex.missing.length > 0 && <div className="callout small" style={{ marginBottom: 10 }}>Couldn’t find: <b>{ex.missing.join(', ')}</b>. Fill them in below.</div>}
            <div className="grid g3" style={{ gap: 10 }}>
              <label className="field">For<select className="input" value={fields.listing ?? 'sale'} onChange={(e) => setFields({ ...fields, listing: e.target.value as 'sale' | 'rent' })}><option value="sale">Sale</option><option value="rent">Rent (pcm)</option></select></label>
              {num('price', fields.listing === 'rent' ? 'Rent £ pcm' : 'Price £')}
              <label className="field">Postcode<input className="input mono" value={fields.postcode ?? ''} onChange={(e) => setFields({ ...fields, postcode: e.target.value })} /></label>
              {num('beds', 'Bedrooms')}{num('baths', 'Bathrooms')}{num('floorArea', 'Floor area m²')}
              <label className="field">Type<select className="input" value={fields.type ?? ''} onChange={(e) => setFields({ ...fields, type: e.target.value as PropertyType })}><option value="">—</option>{['terraced', 'semi-detached', 'detached', 'flat', 'bungalow'].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="field">Tenure<select className="input" value={fields.tenure ?? ''} onChange={(e) => setFields({ ...fields, tenure: e.target.value as Property['tenure'] })}><option value="">—</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="share-of-freehold">Share of freehold</option></select></label>
              <label className="field">EPC<input className="input" value={fields.epc ?? ''} onChange={(e) => setFields({ ...fields, epc: e.target.value.toUpperCase().slice(0, 1) })} /></label>
            </div>
            {(fields.features?.length ?? 0) > 0 && <div className="small" style={{ marginTop: 10 }}>Features: {fields.features!.join(', ')}</div>}
            {fields.sourceSite && <div className="xs muted" style={{ marginTop: 6 }}>Original listing: {fields.sourceSite}</div>}
            <button className="btn" style={{ marginTop: 12 }} disabled={!ok} onClick={save}>Save & see intelligence →</button>
          </Section> : <div className="card flat small muted">The details we read will appear here for you to check. Production uses an AI document reader for this step; this prototype uses a rules-based reader.</div>}
          <Section title={`Listings you’re tracking (${tracked.length})`}>
            {tracked.length === 0 ? <p className="small muted">None yet.</p> : <ul className="clean small">{tracked.map((t) => <li key={t.id} className="row between"><Link to={`/property/${t.id}/intelligence`}>{t.title} · {t.listing === 'rent' ? `${gbp(t.price)} pcm` : gbp(t.price)}</Link><button className="btn ghost sm" onClick={() => untrack(t.id)}>Remove</button></li>)}</ul>}
          </Section>
        </div>
      </div>
    </div>
  );
}
