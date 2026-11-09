import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buildListing, normalisePostcode, POSTCODE_RE } from '../engine/listings';
import { SAMPLE_PASTE } from '../data/sampleFeed';
import type { PropertyType } from '../engine/refurb';
import type { Property } from '../data/properties';
import { gbp, Section, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { AiDisclaimer, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { useStore } from '../store';
import { aiPost, useAi } from '../lib/ai/core';
import { ApiError } from '../lib/api';
import { combineFlags, combineQuestions, foundOf, isRuleQuestion, missingOf, rulesOnlyResult, type FieldKey, type ImportResult, type ImportValues, type RedFlag } from '../lib/ai/importer';
import '../components/ai/studio.css';

const MAX_TEXT = 15_000;
const SEVERITY_TEXT: Record<RedFlag['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

export default function ImportListing() {
  const ai = useAi();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [res, setRes] = useState<ImportResult | null>(null);
  const [readText, setReadText] = useState('');
  const [fields, setFields] = useState<ImportValues>({});
  const [edited, setEdited] = useState<Set<FieldKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const headRef = useRef<HTMLSpanElement>(null);
  const { trackListing, tracked, untrack } = useStore();
  const nav = useNavigate();
  const uid = useId();

  const run = async () => {
    const t = text.slice(0, MAX_TEXT);
    const u = url.trim();
    setBusy(true); setCopied(false);
    let r: ImportResult;
    if (ai.available) {
      try { r = await aiPost<ImportResult>('/api/ai/import/extract', { text: t, url: u || undefined }, 40_000); }
      catch (e) {
        r = rulesOnlyResult(t, u);
        r.note = `${e instanceof ApiError ? e.message : 'Streetkey AI couldn’t read it.'} Streetkey’s built-in reader was used instead, so please check the details carefully.`;
      }
    } else r = rulesOnlyResult(t, u);
    setRes(r); setFields(r.values); setReadText(t); setEdited(new Set()); setBusy(false);
    requestAnimationFrame(() => headRef.current?.focus());
  };

  // Flags and questions follow the facts as people correct them (rules re-run; the AI's extras stay).
  const flags = useMemo(() => (res ? combineFlags(fields, readText, res.redFlags.filter((f) => f.source === 'ai')) : []), [res, fields, readText]);
  const questions = useMemo(() => (res ? combineQuestions(fields, flags, res.questionsToAsk.filter((q) => !isRuleQuestion(q))) : []), [res, fields, flags]);
  const missing = missingOf(fields);
  const found = foundOf(fields);
  const ok = !!fields.price && !!fields.postcode && POSTCODE_RE.test(fields.postcode) && fields.beds != null;

  const set = <K extends FieldKey>(k: K, v: ImportValues[K & keyof ImportValues]) => {
    setFields((f) => ({ ...f, [k]: v }));
    setEdited((e) => new Set(e).add(k));
  };
  const save = () => {
    const site = fields.sourceSite ?? 'another website';
    const p = buildListing({
      listing: fields.listing ?? 'sale', title: fields.title, addressLine: fields.addressLine || 'Address on original listing', town: fields.town || normalisePostcode(fields.postcode!).split(' ')[0],
      postcode: fields.postcode!, type: (fields.type ?? 'terraced') as PropertyType, tenure: fields.tenure ?? 'freehold', leaseYears: fields.leaseYears,
      beds: fields.beds ?? 0, baths: fields.baths ?? 1, floorArea: fields.floorArea ?? 0, era: fields.era, condition: fields.condition, price: fields.price!, epc: fields.epc,
      councilTax: fields.councilTax, serviceChargeAnnual: fields.serviceChargeAnnual, groundRentAnnual: fields.groundRentAnnual, features: fields.features ?? [],
      source: { kind: 'external-link', name: `Listed on ${site}`, url: /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined, licence: 'Private analysis of user-provided details; content not republished', verified: false },
      visibility: 'private',
    });
    trackListing(p); nav(`/property/${p.id}/intelligence`);
  };
  const copyQuestions = async () => {
    try { await navigator.clipboard?.writeText(questions.map((q, i) => `${i + 1}. ${q}`).join('\n')); setCopied(true); } catch { setCopied(false); }
  };

  /** Where a value came from, announced with its field (plain render helpers, so inputs keep focus). */
  const prov = (k: FieldKey, id: string) => {
    const info = res?.fields[k];
    const value = fields[k as keyof ImportValues];
    let body: ReactNode;
    if (edited.has(k)) body = <span className="sk-pill edited">Edited by you</span>;
    else if (!info || value === undefined || value === '') body = <span className="sk-pill missing">Not found</span>;
    else body = <><span className={`sk-pill ${info.confidence}`}>{info.confidence === 'stated' ? 'Stated' : 'Inferred: please check'}</span>{info.evidence && <q>{info.evidence}</q>}</>;
    return <span className="sk-prov" id={id}>{body}</span>;
  };
  const field = (k: FieldKey, label: string, control: (id: string, describedBy: string) => ReactNode) => {
    const id = `${uid}-${k}`;
    return <div className="sk-field" key={k}><label className="field" htmlFor={id}>{label}{control(id, `${id}-p`)}</label>{prov(k, `${id}-p`)}</div>;
  };
  const num = (k: 'price' | 'beds' | 'baths' | 'floorArea' | 'leaseYears' | 'serviceChargeAnnual' | 'groundRentAnnual', label: string) =>
    field(k, label, (id, d) => <input id={id} aria-describedby={d} className="input num" type="number" min={0} inputMode="numeric" value={fields[k] ?? ''} onChange={(e) => set(k, e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))} />);
  const leasehold = fields.tenure === 'leasehold' || fields.tenure === 'share-of-freehold';

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Check any listing</div><h2 style={{ marginTop: 6 }}>Found a home on another website? Get Streetkey intelligence on it.</h2>
          <p className="muted" style={{ marginTop: 6 }}>Paste the listing link and its key details. Streetkey reads them, flags what to check, prices the works and runs the numbers: privately, just for you.</p></div>
        <Tag kind="neutral">Private to you · not republished</Tag>
      </div>
      <div className="split">
        <Section title="1. Paste the listing" kicker="From Rightmove, Zoopla, OnTheMarket, an agent’s site…">
          <label className="field">Listing link (optional: we link back to it, we never visit it)<input className="input" type="url" inputMode="url" value={url} maxLength={500} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></label>
          <label className="field" style={{ marginTop: 10 }}>Listing details: select all on the listing page, copy and paste here
            <textarea className="input" rows={9} value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)} placeholder="Price, address with postcode, bedrooms, tenure, EPC…" aria-describedby={`${uid}-count`} />
          </label>
          <div className="xs muted" id={`${uid}-count`} style={{ marginTop: 4 }}>{text.length.toLocaleString('en-GB')} of {MAX_TEXT.toLocaleString('en-GB')} characters</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn accent" onClick={() => void run()} disabled={!text.trim() || busy} aria-busy={busy || undefined}><Icon name="spark" size={16} /> {busy ? 'Reading…' : 'Read it'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setText(SAMPLE_PASTE); setUrl('https://www.example-portal.co.uk/listing/123456'); }}>Use a sample</button>
          </div>
          {busy && <AiThinking label="Streetkey AI is reading the listing" />}
          {ai.available ? <p className="xs muted" style={{ marginTop: 10 }}>Streetkey AI reads only what you paste, and the built-in reader double-checks it. The link is never visited or copied, and the result stays private to you.</p>
            : <AiUnavailable reason={ai.reason} feature="The AI listing reader" />}
          <p className="xs muted" style={{ marginTop: 6 }}>Streetkey never visits or copies other websites. It only reads what you paste, keeps the result private and links back to the original listing.</p>
        </Section>

        <div className="stack" style={{ gap: 16 }}>
          {res ? <>
            <Section title={<span ref={headRef} tabIndex={-1}>2. Check what we found</span>} kicker={`${found.length} details found · ${res.engine === 'ai' ? 'read by Streetkey AI' : 'built-in reader'}`} right={res.engine === 'ai' ? <AiLabel>Read by AI: please confirm</AiLabel> : <Tag kind="inf">Extracted: please confirm</Tag>}>
              {res.note && <p className="callout info small" role="status" style={{ marginBottom: 10 }}>{res.note}</p>}
              <p className="sk-legend"><span><span className="sk-pill stated">Stated</span> written in the listing</span><span><span className="sk-pill inferred">Inferred: please check</span> worked out from clues</span><span><span className="sk-pill missing">Not found</span></span></p>
              {missing.length > 0 && <div className="callout small" style={{ marginBottom: 10 }}>Couldn’t find: <b>{missing.join(', ')}</b>. Fill them in below.</div>}
              <div className="grid g3" style={{ gap: 12 }}>
                {field('listing', 'For', (id, d) => <select id={id} aria-describedby={d} className="input" value={fields.listing ?? 'sale'} onChange={(e) => set('listing', e.target.value as 'sale' | 'rent')}><option value="sale">Sale</option><option value="rent">Rent (pcm)</option></select>)}
                {num('price', fields.listing === 'rent' ? 'Rent £ pcm' : 'Price £')}
                {field('postcode', 'Postcode', (id, d) => <input id={id} aria-describedby={d} className="input mono" value={fields.postcode ?? ''} maxLength={9} autoComplete="off" onChange={(e) => set('postcode', e.target.value.toUpperCase())} />)}
                {num('beds', 'Bedrooms')}{num('baths', 'Bathrooms')}{num('floorArea', 'Floor area m²')}
                {field('type', 'Type', (id, d) => <select id={id} aria-describedby={d} className="input" value={fields.type ?? ''} onChange={(e) => set('type', (e.target.value || undefined) as PropertyType | undefined)}><option value="">Not stated</option>{['terraced', 'semi-detached', 'detached', 'flat', 'bungalow'].map((t) => <option key={t} value={t}>{t}</option>)}</select>)}
                {field('tenure', 'Tenure', (id, d) => <select id={id} aria-describedby={d} className="input" value={fields.tenure ?? ''} onChange={(e) => set('tenure', (e.target.value || undefined) as Property['tenure'] | undefined)}><option value="">Not stated</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="share-of-freehold">Share of freehold</option></select>)}
                {field('epc', 'EPC rating', (id, d) => <select id={id} aria-describedby={d} className="input" value={fields.epc ?? ''} onChange={(e) => set('epc', e.target.value || undefined)}><option value="">Not stated</option>{'ABCDEFG'.split('').map((x) => <option key={x} value={x}>{x}</option>)}</select>)}
                {field('councilTax', 'Council tax band', (id, d) => <select id={id} aria-describedby={d} className="input" value={fields.councilTax ?? ''} onChange={(e) => set('councilTax', e.target.value || undefined)}><option value="">Not stated</option>{'ABCDEFGHI'.split('').map((x) => <option key={x} value={x}>{x}</option>)}</select>)}
                {leasehold && <>{num('leaseYears', 'Lease years left')}{num('serviceChargeAnnual', 'Service charge £/yr')}{fields.tenure === 'leasehold' && num('groundRentAnnual', 'Ground rent £/yr')}</>}
              </div>
              {(fields.features?.length ?? 0) > 0 && <div className="small" style={{ marginTop: 12 }}>Features: {fields.features!.join(', ')}</div>}
              {(fields.priceQualifier || fields.saleMethod) && <div className="small" style={{ marginTop: 6 }}>{[fields.priceQualifier, fields.saleMethod && fields.saleMethod !== 'private treaty' ? `Sale method: ${fields.saleMethod}` : null].filter(Boolean).join(' · ')}</div>}
              {fields.sourceSite && <div className="xs muted" style={{ marginTop: 6 }}>Original listing: {fields.sourceSite}</div>}
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn" disabled={!ok} onClick={save}>Save &amp; see price check and intelligence →</button>
                {!ok && <span className="xs muted">Add the price, a full postcode and the bedrooms to continue.</span>}
              </div>
              {res.engine === 'ai' && <AiDisclaimer>Read by AI from the text you pasted, and checked against Streetkey’s rules. Confirm the details with the agent before relying on them.</AiDisclaimer>}
            </Section>

            <Section title={`Things to check (${flags.length})`} kicker="Before you view or offer" right={flags.some((x) => x.source === 'ai') ? <AiLabel>Includes AI findings</AiLabel> : undefined}>
              {flags.length === 0 ? <p className="small muted">Nothing stood out in what you pasted. Still ask for the EPC, floor plan and, for leasehold homes, the lease and charges.</p> :
                <ul className="sk-flags">{flags.map((x) => (
                  <li key={x.id} className={`sk-flag ${x.severity}`}>
                    <span className={`ai-risk ${x.severity}`}><span className="sr-only">Priority: </span>{SEVERITY_TEXT[x.severity]}</span>
                    <span className="sk-flag-t">{x.title}{x.source === 'ai' && <AiLabel />}</span>
                    <span className="sk-flag-d">{x.detail}</span>
                    {x.evidence && <span className="sk-flag-q">From the listing: <q>{x.evidence}</q></span>}
                  </li>))}
                </ul>}
              <p className="xs muted" style={{ marginTop: 10 }}>General information, not legal or financial advice. A solicitor or conveyancer can check the lease, title and legal pack for you.</p>
            </Section>

            <Section title="Questions to ask the agent" kicker="Copy and send" right={<button type="button" className="btn ghost sm" onClick={() => void copyQuestions()} disabled={!questions.length}>{copied ? 'Copied' : 'Copy questions'}</button>}>
              <ol className="sk-qs">{questions.map((q) => <li key={q}>{q}</li>)}</ol>
              <span className="sr-only" role="status">{copied ? 'Questions copied to the clipboard.' : ''}</span>
            </Section>
          </> : <div className="card flat small muted">The details we read will appear here for you to check, with what to ask the agent. {ai.available ? 'Streetkey AI reads the text; the built-in reader double-checks it.' : 'This uses Streetkey’s built-in reader.'}</div>}

          <Section title={`Listings you’re tracking (${tracked.length})`}>
            {tracked.length === 0 ? <p className="small muted">None yet.</p> : <ul className="clean small">{tracked.map((t) => <li key={t.id} className="row between"><Link to={`/property/${t.id}/intelligence`}>{t.title} · {t.listing === 'rent' ? `${gbp(t.price)} pcm` : gbp(t.price)}</Link><button type="button" className="btn ghost sm" onClick={() => untrack(t.id)} aria-label={`Stop tracking ${t.title}`}>Remove</button></li>)}</ul>}
          </Section>
        </div>
      </div>
    </div>
  );
}
