import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { refurbInputFor } from '../engine/insights';
import {
  boqCsv, DEFAULT_INPUT, estimateRefurb, hiddenDefectRisks, REGIONS, regionFromPostcode, scenarios, VAT_RATES,
  type Access, type Condition, type Era, type Estimate, type PropertyType, type RefurbInput, type Spec, type VatTreatment,
} from '../engine/refurb';
import { download, gbp, gbpK, Meter, Section, Seg, Stacked, Stat, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { aiPost, pollJob, useAi, useAiAction } from '../lib/ai/core';
import { ACTION_LABEL, applyPhotoScope, photoDetailsKey, photoFactsFrom, type RefurbExplainResult, type RefurbPhotoFacts, type RefurbPhotosResult, type ScopeBasis } from '../lib/ai/property';
import '../components/ai/property.css';

/** Allocate measured lines to rooms: item-specific trades go to their room, area-based work is shared by room area. */
function byRoom(e: Estimate, i: RefurbInput) {
  const rooms: { name: string; share: number }[] = [
    { name: 'Living room', share: 0.2 }, { name: 'Kitchen / dining', share: 0.18 },
    ...Array.from({ length: i.bedrooms }, (_, k) => ({ name: `Bedroom ${k + 1}`, share: (k === 0 ? 0.16 : 0.11) })),
    { name: 'Bathroom(s)', share: 0.07 }, { name: 'Hall, stairs & landing', share: 0.1 },
  ];
  const totalShare = rooms.reduce((s, r) => s + r.share, 0);
  const out = new Map<string, number>(rooms.map((r) => [r.name, 0]));
  const whole = new Map<string, number>();
  for (const l of e.lines) {
    if (l.trade === 'Kitchen') out.set('Kitchen / dining', out.get('Kitchen / dining')! + l.total);
    else if (l.trade === 'Bathroom') out.set('Bathroom(s)', out.get('Bathroom(s)')! + l.total);
    else if (['Roofing', 'External works', 'Extension', 'Loft conversion', 'Structural', 'Strip-out & waste', 'Damp & timber'].includes(l.trade) || l.code === 'WINDOW' || l.code === 'EXT_DOOR' || l.code === 'ASHP' || l.code === 'BOILER' || l.code === 'IWI' || l.code === 'INSULATION' || l.code === 'ELEC_PARTIAL' || l.code === 'ROOF_REPAIR')
      whole.set(l.trade, (whole.get(l.trade) ?? 0) + l.total);
    else for (const r of rooms) out.set(r.name, out.get(r.name)! + (l.total * r.share) / totalShare);
  }
  return { rooms: [...out.entries()].map(([name, total]) => ({ name, total })), whole: [...whole.entries()].map(([name, total]) => ({ name, total })) };
}

const SURVEY_RULES: { re: RegExp; label: string; apply: (s: RefurbInput['scope']) => Partial<RefurbInput['scope']> }[] = [
  { re: /rising damp|penetrating damp|damp/i, label: 'Damp noted → damp remediation added', apply: () => ({ damp: true }) },
  { re: /rewir|wiring|consumer unit|eicr/i, label: 'Electrics flagged → full rewire', apply: () => ({ rewire: true }) },
  { re: /boiler|heating system|radiator/i, label: 'Heating flagged → full heating replacement', apply: () => ({ heating: 'full' }) },
  { re: /roof|slates?|tiles? slipped|flashing/i, label: 'Roof defects → roof overhaul', apply: () => ({ roof: 'repair' }) },
  { re: /re-?roof|roof covering at end of life/i, label: 'Roof at end of life → re-cover', apply: () => ({ roof: 'recover' }) },
  { re: /window|glazing|rot(ten)? (frame|sash)/i, label: 'Windows flagged → replacement windows', apply: () => ({ windows: true }) },
  { re: /plaster|hollow|blown/i, label: 'Blown plaster → full re-plaster', apply: () => ({ replaster: 'full' }) },
];

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field">{label}{children}</label>; }

/* ───────────────────────── AI: estimate from photos ───────────────────────── */
const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
/** All photos go in one upload; hosting accepts about 6 MB per request, so stay well under it. */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const PHOTO_SIDE = 1280;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const SOURCE_LABEL: Record<ScopeBasis['source'], string> = { photos: 'From photos', assumed: 'Assumed', yours: 'Your choice' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Resize in the browser before upload: faster and cheaper, keeps the whole set within the upload limit,
 * and re-encoding drops location metadata. 1280px still shows cracks, sockets and damp staining.
 */
async function shrinkPhoto(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return file; }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const encode = (q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    let blob = await encode(0.8);
    if (blob && blob.size > 700 * 1024) blob = (await encode(0.65)) ?? blob; // very detailed photos
    return blob && blob.size < file.size ? new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' }) : file;
  } catch { return file; } // the browser can't decode it: the server will explain
}

function AiList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><div className="ai-prop-h">{title}</div><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

interface Picked { id: string; file: File; url: string }

function PhotoEstimate({ input, onApply, onUndo }: { input: RefurbInput; onApply: (next: RefurbInput) => void; onUndo: (() => void) | null }) {
  const { available, reason, signedIn } = useAi();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [sentThumbs, setSentThumbs] = useState<string[]>([]);
  /** The property details the last analysis was worked out for. */
  const [analysedFor, setAnalysedFor] = useState<string | null>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u); }, []);
  const job = useAiAction(async (files: File[], facts: RefurbPhotoFacts) => {
    const form = new FormData();
    form.append('consent', 'true');
    form.append('facts', JSON.stringify(facts));
    files.forEach((f, k) => form.append('photos', f, f.name || `photo-${k + 1}.jpg`));
    const { jobId } = await aiPost<{ jobId: string }>('/api/ai/refurb/from-photos', form, 120_000);
    return pollJob<RefurbPhotosResult>(jobId, { onProgress: (j) => setProgress(j.progress), timeoutMs: 6 * 60_000 });
  });

  const add = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    const room = Math.max(0, MAX_PHOTOS - picked.length);
    const issues: string[] = [];
    if (chosen.length > room) issues.push(`You can add up to ${MAX_PHOTOS} photos, so ${chosen.length - room} ${chosen.length - room === 1 ? 'wasn’t' : 'weren’t'} added.`);
    const next: Picked[] = [];
    let total = picked.reduce((n, p) => n + p.file.size, 0);
    for (const f of chosen.slice(0, room)) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { issues.push(`${f.name}: use a JPEG, PNG or WebP photo.`); continue; }
      const small = await shrinkPhoto(f);
      if (small.size > MAX_PHOTO_BYTES) { issues.push(`${f.name}: too large (the limit is 2 MB per photo).`); continue; }
      if (total + small.size > MAX_TOTAL_BYTES) { issues.push(`${f.name}: not added, as the photos would come to more than ${mb(MAX_TOTAL_BYTES)} in total. Remove a photo or use a smaller one.`); continue; }
      total += small.size;
      const url = URL.createObjectURL(small);
      urls.current.add(url);
      next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file: small, url });
    }
    setPicked((p) => [...p, ...next].slice(0, MAX_PHOTOS));
    setNotes(issues);
  };
  const analyse = () => {
    setApplied(false); setProgress(null);
    setSentThumbs(picked.map((p) => p.url));
    setAnalysedFor(photoDetailsKey(input));
    void job.run(picked.map((p) => p.file), photoFactsFrom(input));
  };
  const r = job.data;
  const canAnalyse = picked.length > 0 && consent;
  const stale = !!r && analysedFor != null && analysedFor !== photoDetailsKey(input);

  return (
    <Section title="Estimate from photos" kicker="Step 4 · optional" right={<AiLabel />}>
      <p className="small muted" style={{ marginTop: 0 }}>Add up to {MAX_PHOTOS} photos of the rooms and the outside. Streetkey AI describes what it can see and suggests a scope of works; Streetkey’s cost engine prices it, using the property details above.</p>
      {!available || !signedIn ? <AiUnavailable reason={reason} signedOut={available && !signedIn} feature="Estimating from photos" /> : <>
        <label className="dropzone pe-drop">
          <input className="sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={job.busy || picked.length >= MAX_PHOTOS}
            onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
          {picked.length >= MAX_PHOTOS ? `You’ve added ${MAX_PHOTOS} photos (the maximum).` : `Choose photos (JPEG, PNG or WebP). They’re resized in your browser; up to ${mb(MAX_TOTAL_BYTES)} in total.`}
        </label>
        {picked.length > 0 && <ul className="pe-thumbs" aria-label="Photos to analyse">{picked.map((p, k) => (
          <li key={p.id}>
            <img src={p.url} alt={`Photo ${k + 1}: ${p.file.name}`} />
            <span className="pe-n" aria-hidden="true">{k + 1}</span>
            <button type="button" className="pe-remove" aria-label={`Remove photo ${k + 1}`} disabled={job.busy} onClick={() => setPicked((x) => x.filter((y) => y.id !== p.id))}><Icon name="x" size={14} /></button>
          </li>
        ))}</ul>}
        {notes.length > 0 && <ul className="ticks small" role="alert" style={{ marginTop: 8 }}>{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <label className="check" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I’m happy for these photos to be sent to Streetkey’s AI provider (OpenAI) for analysis. They’re deleted once analysed. Please avoid photos showing people or documents.</span>
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <AiButton busy={job.busy} disabled={!picked.length || !consent} onClick={analyse}>{picked.length ? `Analyse ${picked.length} photo${picked.length === 1 ? '' : 's'}` : 'Analyse photos'}</AiButton>
          {!consent && picked.length > 0 && <span className="xs muted">Tick the box above to continue.</span>}
        </div>
        {job.busy && <AiThinking label={progress ?? 'Uploading your photos'} />}
        <AiErrorNote error={job.error} onRetry={canAnalyse ? analyse : undefined} />
        {r && !job.busy && <PhotoResult r={r} input={input} thumbs={sentThumbs} applied={applied} stale={stale}
          onReanalyse={canAnalyse ? analyse : null}
          onApply={() => { onApply(r.scope); setApplied(true); }}
          onUndo={onUndo ? () => { onUndo(); setApplied(false); } : null} />}
      </>}
    </Section>
  );
}

function PhotoResult({ r, input, thumbs, applied, stale, onReanalyse, onApply, onUndo }: {
  r: RefurbPhotosResult; input: RefurbInput; thumbs: string[]; applied: boolean; stale: boolean;
  onReanalyse: (() => void) | null; onApply: () => void; onUndo: (() => void) | null;
}) {
  // Priced live by the engine: the photo scope on top of the estimator's current details and plans.
  const est = useMemo(() => estimateRefurb(applyPhotoScope(input, r.scope)), [input, r.scope]);
  return (
    <div style={{ marginTop: 12 }}>
      <AiCard title="What the AI saw" footer={<AiDisclaimer>{r.label} Not a survey, valuation or quote.</AiDisclaimer>}>
        {stale && <div className="callout small ai-prop-stale" role="status">
          You’ve changed the property details since these photos were analysed. The total below uses your current details, but the suggested scope was worked out for the earlier ones.
          {onReanalyse && <> <button type="button" className="btn ghost sm" onClick={onReanalyse}>Analyse again</button></>}
        </div>}
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="num" style={{ fontSize: 26, lineHeight: 1.1 }}>{gbp(est.total)}</div>
            <div className="xs muted">Streetkey engine estimate for this scope with your current details and plans, likely {gbp(est.low)} – {gbp(est.high)}</div>
          </div>
          <div className="ai-chips">
            <span className="ai-chip">Condition <b>{r.overall.condition}</b></span>
            <span className="ai-chip">Confidence <b>{r.overall.confidence}</b></span>
            <span className="ai-chip"><b>{r.overall.photosUsed}</b> of {r.overall.photosSent} photos used</span>
          </div>
        </div>
        <div className="row" aria-live="polite">
          {applied
            ? <><span className="small"><b>Scope applied.</b> The estimator now uses it: fine-tune anything above.</span>{onUndo && <button type="button" className="btn ghost sm" onClick={onUndo}>Undo</button>}</>
            : <><button type="button" className="btn accent sm" onClick={onApply}>Apply this scope to the estimator</button><span className="xs muted">Updates the condition, bathrooms and scope of works; your property details and plans stay as they are.</span></>}
        </div>
        <div className="ai-prop-h">Photo by photo</div>
        <ul className="pe-obs">{r.observations.map((o) => (
          <li key={o.photo} className={thumbs[o.photo - 1] ? '' : 'no-thumb'}>
            {thumbs[o.photo - 1] && <img src={thumbs[o.photo - 1]} alt="" />}
            <div className="small">
              <b>Photo {o.photo}: {o.room}</b>{' '}
              <span className="xs muted">{!o.analysed ? 'couldn’t be analysed' : !o.isProperty ? 'doesn’t show the property, ignored' : `${o.condition} condition · ${o.confidence} confidence`}</span>
              {o.items.length > 0 && <ul>{o.items.map((it, k) => <li key={k}><b>{cap(it.element)}</b>: {it.observation} <span className={`pe-act ${it.likelyAction}`}>{ACTION_LABEL[it.likelyAction]}</span></li>)}</ul>}
            </div>
          </li>
        ))}</ul>
        <details>
          <summary className="small" style={{ cursor: 'pointer' }}>How the scope was set ({r.basis.length} items)</summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="How the scope was set" style={{ marginTop: 6 }}>
            <table className="pe-basis">
              <thead><tr><th scope="col">Item</th><th scope="col">Priced as</th><th scope="col">Source</th></tr></thead>
              <tbody>{r.basis.map((b) => <tr key={b.item}><td>{b.item}{b.note && <div className="xs muted">{b.note}</div>}</td><td>{b.value}</td><td><span className={`pe-src ${b.source}`}>{SOURCE_LABEL[b.source]}</span></td></tr>)}</tbody>
            </table>
          </div>
        </details>
        <AiList title="Questions for your surveyor or builder" items={r.questionsForSurveyor} />
        <AiList title="Keep in mind" items={r.caveats} />
      </AiCard>
    </div>
  );
}

/* ───────────────────────── AI: explain this estimate ───────────────────────── */
function ExplainEstimate({ input, total }: { input: RefurbInput; total: number }) {
  const { available, reason } = useAi();
  const [asked, setAsked] = useState<string | null>(null);
  const ex = useAiAction((i: RefurbInput, t: number) => aiPost<{ explanation: RefurbExplainResult }>('/api/ai/refurb/explain', { input: i, estimate: { total: t } }).then((r) => r.explanation));
  const key = JSON.stringify(input);
  const run = () => { setAsked(key); void ex.run(input, total); };
  const x = ex.data;
  if (reason === 'checking') return null;
  if (!available) return <AiCard tone="quiet" title="Explain this estimate"><AiUnavailable reason={reason} feature="The AI explanation" /></AiCard>;
  return (
    <AiCard title="Explain this estimate" footer={x && !ex.busy ? <AiDisclaimer>{x.disclaimer}</AiDisclaimer> : undefined}>
      {!x && !ex.busy && <>
        <p className="small muted" style={{ margin: 0 }}>A plain-English walk-through of what drives this total, ways to save and what could push it up. The figures come from Streetkey’s cost engine.</p>
        <div><AiButton onClick={run}>Explain this estimate</AiButton></div>
      </>}
      {ex.busy && <AiThinking label="Reading the estimate" />}
      <AiErrorNote error={ex.error} onRetry={run} />
      {x && !ex.busy && <>
        {asked !== key && <div className="callout small ai-prop-stale" role="status">You’ve changed the inputs since this explanation. <button type="button" className="btn ghost sm" onClick={run}>Explain again</button></div>}
        <AiText text={x.summary} />
        <div className="ai-prop-cols">
          <AiList title="Biggest costs" items={x.biggestCosts} />
          <AiList title="Ways to save" items={x.waysToSave} />
          <AiList title="What could push it up" items={x.risks} />
          <AiList title="Next steps" items={x.nextSteps} />
        </div>
        {x.removedClaims > 0 && <p className="ai-prop-note">{x.removedClaims} statement{x.removedClaims === 1 ? ' was' : 's were'} left out because {x.removedClaims === 1 ? 'it quoted a figure' : 'they quoted figures'} not in Streetkey’s estimate.</p>}
      </>}
    </AiCard>
  );
}

export default function Estimator() {
  const [params] = useSearchParams();
  const prop = getProperty(params.get('property') ?? '');
  const [input, setInput] = useState<RefurbInput>(() => (prop ? refurbInputFor(prop) : DEFAULT_INPUT));
  const [beforeAi, setBeforeAi] = useState<RefurbInput | null>(null);
  const [view, setView] = useState<'trade' | 'room' | 'boq'>('trade');
  const [files, setFiles] = useState<{ name: string; kind: string }[]>([]);
  const [findings, setFindings] = useState<string[]>([]);
  const est = useMemo(() => estimateRefurb(input), [input]);
  const scen = useMemo(() => scenarios(input), [input]);
  const rooms = useMemo(() => byRoom(est, input), [est, input]);
  const set = <K extends keyof RefurbInput>(k: K, v: RefurbInput[K]) => setInput((s) => ({ ...s, [k]: v }));
  const scope = <K extends keyof RefurbInput['scope']>(k: K, v: RefurbInput['scope'][K]) => setInput((s) => ({ ...s, scope: { ...s.scope, [k]: v } }));
  const region = regionFromPostcode(input.postcode);
  const maxTrade = Math.max(...est.byTrade.map((t) => t.total), 1);

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const arr = [...list];
    setFiles((f) => [...f, ...arr.map((x) => ({ name: x.name, kind: x.type.startsWith('image') ? 'Photo' : /pdf/.test(x.type) ? 'PDF' : 'Document' }))]);
    const found: string[] = [];
    for (const f of arr) {
      if (!/text|json|csv|markdown/.test(f.type) && !/\.(txt|md|csv)$/i.test(f.name)) continue;
      const text = await f.text();
      let patch: Partial<RefurbInput['scope']> = {};
      for (const r of SURVEY_RULES) if (r.re.test(text)) { found.push(r.label); patch = { ...patch, ...r.apply(input.scope) }; }
      if (/asbestos/i.test(text)) found.push('Asbestos mentioned → survey & removal remain an exclusion — obtain specialist quote');
      if (/subsidence|movement|crack/i.test(text)) found.push('Structural movement mentioned → structural engineer inspection recommended before pricing');
      setInput((s) => ({ ...s, scope: { ...s.scope, ...patch } }));
    }
    setFindings((x) => [...x, ...found]);
  };

  const loadSampleSurvey = () => {
    const sample = new File(['RICS Level 3 extract (sample): Evidence of rising damp to front reception. Wiring appears original with rewireable fuses; recommend full rewire and EICR. Roof: several slipped slates and defective lead flashing. Windows: rot to rear sash frames. Hollow plaster noted throughout ground floor. Textured ceiling coating may contain asbestos.'], 'sample-survey.txt', { type: 'text/plain' });
    const dt = new DataTransfer(); dt.items.add(sample); void onFiles(dt.files);
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI regional refurbishment cost engine</div>
          <h2 style={{ marginTop: 6 }}>Refurbishment cost estimator</h2>
          <p className="muted" style={{ marginTop: 6 }}>Elemental UK estimate: measured works × regional, condition, era and access factors, plus preliminaries, overheads & profit, contingency, professional fees and VAT.{prop && <> Prefilled from <Link to={`/property/${prop.id}`}>{prop.title}</Link>.</>}</p>
        </div>
        <div className="row"><Tag kind="est" /><Tag kind="demo">{est.basis.version}</Tag><Tag kind="neutral">Pricing date {est.basis.basisDate}</Tag></div>
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 14 }}>
          <Section title="Property" kicker="Step 1">
            <div className="grid g2" style={{ gap: 10 }}>
              <Field label="Postcode"><input className="input mono" value={input.postcode} onChange={(e) => set('postcode', e.target.value)} /></Field>
              <Field label="Region (auto)"><div className="input small" style={{ background: 'var(--surface-2)' }}>{region ? `${REGIONS[region].label} ×${REGIONS[region].factor}` : 'Unknown — UK avg'}</div></Field>
              <Field label="Type"><select className="input" value={input.propertyType} onChange={(e) => set('propertyType', e.target.value as PropertyType)}>{['terraced', 'semi-detached', 'detached', 'flat', 'bungalow'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Floor area (m² GIA)"><input className="input num" type="number" value={input.floorArea} onChange={(e) => set('floorArea', Math.max(20, Number(e.target.value) || 0))} /></Field>
              <Field label="Bedrooms"><input className="input num" type="number" min={0} value={input.bedrooms} onChange={(e) => set('bedrooms', Math.max(0, Number(e.target.value)))} /></Field>
              <Field label="Bathrooms to fit"><input className="input num" type="number" min={0} value={input.bathrooms} onChange={(e) => set('bathrooms', Math.max(0, Number(e.target.value)))} /></Field>
              <Field label="Storeys"><input className="input num" type="number" min={1} max={5} value={input.storeys} onChange={(e) => set('storeys', Math.max(1, Number(e.target.value)))} /></Field>
              <Field label="Construction era"><select className="input" value={input.era} onChange={(e) => set('era', e.target.value as Era)}>{['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Condition"><select className="input" value={input.condition} onChange={(e) => set('condition', e.target.value as Condition)}>{['good', 'fair', 'poor', 'derelict'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Site access"><select className="input" value={input.access} onChange={(e) => set('access', e.target.value as Access)}><option value="easy">Easy (driveway)</option><option value="restricted">Restricted (on-street, CPZ)</option><option value="difficult">Difficult (no parking, upper floor, no lift)</option></select></Field>
            </div>
          </Section>
          <Section title="Project type" kicker="Step 2">
            <Seg value={input.propertyType === 'commercial' ? (input.scope.officeToResiArea ? 'o2r' : 'fitout') : 'resi'} onChange={(v) => setInput((s) => v === 'resi'
              ? { ...s, propertyType: s.propertyType === 'commercial' ? 'terraced' : s.propertyType, scope: { ...s.scope, fitOut: 'none', officeToResiArea: 0 } }
              : v === 'fitout' ? { ...s, propertyType: 'commercial', vat: 'standard', scope: { ...s.scope, fitOut: 'cat-a', officeToResiArea: 0, kitchen: false, damp: false } }
              : { ...s, propertyType: 'commercial', vat: 'reduced-conversion', scope: { ...s.scope, fitOut: 'none', officeToResiArea: s.floorArea, kitchen: false, damp: false } })}
              options={[{ value: 'resi', label: 'Residential refurbishment' }, { value: 'fitout', label: 'Commercial fit-out' }, { value: 'o2r', label: 'Office → residential' }]} />
            {input.propertyType === 'commercial' && <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
              <Field label="Fit-out level"><select className="input" value={input.scope.fitOut ?? 'none'} onChange={(e) => scope('fitOut', e.target.value as 'none')}><option value="none">None</option><option value="cat-a">Cat A</option><option value="cat-a+b">Cat A + Cat B</option></select></Field>
              <Field label="Area converted to resi (m²)"><input className="input num" type="number" min={0} value={input.scope.officeToResiArea ?? 0} onChange={(e) => scope('officeToResiArea', Math.max(0, Number(e.target.value)))} /></Field>
            </div>}
          </Section>
          <Section title="Scope of works" kicker="Step 3">
            <div className="grid g2" style={{ gap: 2 }}>
              {([['stripOut', 'Strip-out & waste'], ['rewire', 'Full rewire'], ['kitchen', 'New kitchen'], ['windows', 'Replace windows & doors'], ['flooring', 'Floor finishes'], ['decoration', 'Decoration & joinery'], ['damp', 'Damp remediation'], ['external', 'External works'], ['insulation', 'Loft insulation'], ['solidWallInsulation', 'Solid-wall insulation']] as const).map(([k, l]) => (
                <label key={k} className="check"><input type="checkbox" checked={input.scope[k] as boolean} onChange={(e) => scope(k, e.target.checked)} />{l}</label>
              ))}
            </div>
            <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
              <Field label="Heating"><select className="input" value={input.scope.heating} onChange={(e) => scope('heating', e.target.value as RefurbInput['scope']['heating'])}><option value="none">No change</option><option value="boiler">Boiler only</option><option value="full">Full system</option><option value="heat-pump">Air source heat pump</option></select></Field>
              <Field label="Plastering"><select className="input" value={input.scope.replaster} onChange={(e) => scope('replaster', e.target.value as RefurbInput['scope']['replaster'])}><option value="none">None</option><option value="skim">Skim</option><option value="full">Hack off & re-plaster</option></select></Field>
              <Field label="Roof"><select className="input" value={input.scope.roof} onChange={(e) => scope('roof', e.target.value as RefurbInput['scope']['roof'])}><option value="none">None</option><option value="repair">Overhaul</option><option value="recover">Strip & re-cover</option></select></Field>
              <Field label="Structural openings (RSJ)"><input className="input num" type="number" min={0} value={input.scope.structuralOpenings} onChange={(e) => scope('structuralOpenings', Math.max(0, Number(e.target.value)))} /></Field>
              <Field label={`Extension: ${input.scope.extensionArea}m²`}><input type="range" min={0} max={40} value={input.scope.extensionArea} onChange={(e) => scope('extensionArea', Number(e.target.value))} /></Field>
              <Field label={`Loft conversion: ${input.scope.loftArea}m²`}><input type="range" min={0} max={40} value={input.scope.loftArea} onChange={(e) => scope('loftArea', Number(e.target.value))} /></Field>
              <Field label="Groundworks area (m²)"><input className="input num" type="number" min={0} value={input.scope.groundworksArea ?? 0} onChange={(e) => scope('groundworksArea', Math.max(0, Number(e.target.value)))} /></Field>
              <Field label="New en-suites"><input className="input num" type="number" min={0} value={input.scope.ensuites} onChange={(e) => scope('ensuites', Math.max(0, Number(e.target.value)))} /></Field>
              <Field label="VAT treatment"><select className="input" value={input.vat} onChange={(e) => set('vat', e.target.value as VatTreatment)}>{Object.entries(VAT_RATES).map(([k, v]) => <option key={k} value={k}>{v.label.split(' (')[0].split(' —')[0]}{k.startsWith('reduced') ? ` (${k === 'reduced-empty-2yrs' ? 'empty 2+ yrs' : 'conversion'})` : ''}</option>)}</select></Field>
            </div>
            <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={input.includeProfessionalFees} onChange={(e) => set('includeProfessionalFees', e.target.checked)} />Include professional fees (architect, engineer, building control, party wall)</label>
          </Section>
          <PhotoEstimate input={input}
            onApply={(photoScope) => { setBeforeAi(input); setInput((cur) => applyPhotoScope(cur, photoScope)); }}
            onUndo={beforeAi ? () => { setInput((cur) => applyPhotoScope(cur, beforeAi)); setBeforeAi(null); } : null} />
          <Section title="Plans & surveys" kicker="Step 5 · optional" right={<Tag kind="neutral">Read in your browser</Tag>}>
            <label className="dropzone pe-drop">
              <input type="file" multiple className="sr-only" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} accept="image/*,.pdf,.txt,.md,.csv" />
              Add floor plans or a survey (a .txt survey is read in your browser)
            </label>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={loadSampleSurvey}>Load sample survey extract</button>
            {files.length > 0 && <ul className="clean small" style={{ marginTop: 10 }}>{files.map((f, i) => <li key={i}><Tag kind="neutral">{f.kind}</Tag> {f.name}</li>)}</ul>}
            {findings.length > 0 && <div className="callout info" style={{ marginTop: 10 }}><b>Survey interpretation</b> (scope updated — please confirm):<ul className="ticks" style={{ marginTop: 6 }}>{findings.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
            <p className="xs muted" style={{ marginTop: 8 }}>Files here stay in your browser: survey text is matched against simple rules and the scope is updated for you to confirm. For photos, use “Estimate from photos” above.</p>
          </Section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card ink">
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Estimated total, incl. {Math.round(VAT_RATES[input.vat].rate * 100)}% VAT</div>
                <div className="num" style={{ fontSize: 'clamp(2.4rem, 6vw, 3.6rem)', lineHeight: 1.05, marginTop: 6 }}>{gbp(est.total)}</div>
                <div className="muted small" style={{ marginTop: 4 }}>Likely range {gbp(est.low)} – {gbp(est.high)} · <b style={{ color: 'inherit' }}>{est.confidence}</b> confidence</div>
              </div>
              <div className="grid g3" style={{ gap: 18, minWidth: 260 }}>
                <Stat label="Per m² (ex VAT)" value={gbp(est.costPerM2)} />
                <Stat label="Programme" value={`${est.programmeWeeks} wks`} />
                <Stat label="Labour / materials" value={`${Math.round((est.labourAllowance / Math.max(1, est.measuredWorks)) * 100)}/${Math.round((est.materialsAllowance / Math.max(1, est.measuredWorks)) * 100)}`} sub="% of measured works" />
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <Stacked parts={[
                { label: 'Measured works', value: est.measuredWorks, color: '#e9e3d6' },
                { label: 'Prelims', value: est.preliminaries, color: '#a9b8c6' },
                { label: 'OH&P', value: est.overheadsProfit, color: '#7fa9d4' },
                { label: 'Contingency', value: est.contingency, color: '#d9ad55' },
                { label: 'Fees', value: est.professionalFees, color: '#6fb79b' },
                { label: 'VAT', value: est.vat, color: '#e0775a' },
              ]} />
            </div>
          </div>

          <div className="grid g3">
            {scen.map(({ spec, estimate }) => (
              <button key={spec} onClick={() => set('spec', spec as Spec)} className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: spec === input.spec ? 'var(--ink)' : undefined, borderWidth: spec === input.spec ? 2 : 1 }}>
                <div className="row between"><span className="eyebrow">{spec}</span>{spec === input.spec && <Tag kind="neutral">Selected</Tag>}</div>
                <div className="num" style={{ fontSize: 24, marginTop: 6 }}>{gbpK(estimate.total)}</div>
                <div className="xs muted">{gbp(estimate.costPerM2)}/m² · {spec === 'budget' ? 'Trade-counter kitchen, laminate, uPVC' : spec === 'standard' ? 'Mid-range kitchen, LVT/carpet, A-rated uPVC' : 'Bespoke kitchen, engineered oak, timber windows'}</div>
              </button>
            ))}
          </div>

          <ExplainEstimate input={input} total={est.total} />

          <Section title="Breakdown" right={<>
            <Seg value={view} onChange={setView} options={[{ value: 'trade', label: 'By trade' }, { value: 'room', label: 'By room' }, { value: 'boq', label: 'Bill of quantities' }]} />
            <button className="btn ghost sm" onClick={() => download(`streetkey-boq-${input.postcode.replace(/\s/g, '')}.csv`, boqCsv(est))}>Export BoQ (CSV)</button>
          </>}>
            {view === 'trade' && est.byTrade.map((t) => <Meter key={t.trade} label={t.trade} value={t.total} max={maxTrade} display={gbpK(t.total)} />)}
            {view === 'room' && <>
              {rooms.rooms.map((r) => <Meter key={r.name} label={r.name} value={r.total} max={Math.max(...rooms.rooms.map((x) => x.total), ...rooms.whole.map((x) => x.total))} display={gbpK(r.total)} color="var(--blue)" />)}
              <div className="eyebrow" style={{ margin: '12px 0 4px' }}>Whole-house items</div>
              {rooms.whole.map((r) => <Meter key={r.name} label={r.name} value={r.total} max={Math.max(...rooms.rooms.map((x) => x.total), ...rooms.whole.map((x) => x.total))} display={gbpK(r.total)} color="var(--gold)" />)}
              <p className="xs muted" style={{ marginTop: 8 }}>Measured works only (before prelims, OH&P, contingency, fees, VAT). Area-based trades are apportioned by typical room area.</p>
            </>}
            {view === 'boq' && <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>#</th><th>Description</th><th className="r">Qty</th><th>Unit</th><th className="r">Rate</th><th className="r">Total</th></tr></thead>
              <tbody>{est.lines.map((l, i) => <tr key={l.code}><td className="muted">{i + 1}</td><td>{l.description}<div className="xs muted">{l.trade} · {l.quantityBasis}</div></td><td className="r num">{l.quantity}</td><td>{l.unit}</td><td className="r num">{gbp(l.rate)}</td><td className="r num">{gbp(l.total)}</td></tr>)}</tbody>
              <tfoot>
                {([['Measured works', est.measuredWorks], ['Preliminaries', est.preliminaries], ['Overheads & profit', est.overheadsProfit], ['Contingency', est.contingency], ['Professional fees', est.professionalFees], ['VAT', est.vat], ['Total', est.total]] as const).map(([l, v]) => <tr key={l}><td /><td colSpan={4}>{l}</td><td className="r num">{gbp(v)}</td></tr>)}
              </tfoot>
            </table></div>}
          </Section>

          <div className="grid g2">
            <Section title="Adjustment factors">
              <dl className="kv">{est.factors.map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd className="mono small">{f.value}</dd></Fragment>)}</dl>
              <div className="hr" />
              <div className="eyebrow" style={{ marginBottom: 6 }}>Assumptions</div>
              <ul className="ticks small">{est.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            </Section>
            <Section title="Hidden defect risks" kicker="Allow for these" right={<Tag kind="est" />}>
              <ul className="clean small">{hiddenDefectRisks(input).map((r) => <li key={r.risk}><Tag kind={r.likelihood === 'high' ? 'warn' : r.likelihood === 'medium' ? 'demo' : 'neutral'}>{r.likelihood}</Tag> {r.risk} <span className="xs muted">· {r.allowance}</span></li>)}</ul>
              <p className="xs muted" style={{ marginTop: 8 }}>Confidence falls as these risks rise; contingency is sized accordingly. Intrusive surveys narrow the range.</p>
            </Section>
            <Section title="Exclusions & compliance">
              <ul className="ticks small">{est.exclusions.map((a) => <li key={a}>{a}</li>)}</ul>
              <div className="hr" />
              <ul className="ticks small">{est.compliance.map((a) => <li key={a}>{a}</li>)}</ul>
            </Section>
          </div>
          <div className="callout info small">
            <b>Pricing basis:</b> {est.basis.source} Basis date {est.basis.basisDate}. This is a budget estimate for feasibility, not a tender price. Obtain at least three quotations against the exported scope — <Link to="/marketplace">compare them here</Link>. <Link to={`/invest?${prop ? `property=${prop.id}&` : ''}refurb=${est.total}&label=${encodeURIComponent('whole-house estimate')}`}>Use this estimate in the investment analyser →</Link> Each verified quote (with consent) recalibrates the regional rate library.
          </div>
        </div>
      </div>
    </div>
  );
}
