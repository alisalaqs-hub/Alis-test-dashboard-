import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { refurbInputFor } from '../engine/insights';
import {
  boqCsv, DEFAULT_INPUT, estimateRefurb, hiddenDefectRisks, REGIONS, regionFromPostcode, scenarios, VAT_RATES,
  type Access, type Condition, type Era, type Estimate, type PropertyType, type RefurbInput, type Spec, type VatTreatment,
} from '../engine/refurb';
import { download, gbp, gbpK, Meter, NumberField, Section, Seg, Stacked, Stat, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { api } from '../lib/api';
import { aiPost, pollJob, useAi, useAiAction } from '../lib/ai/core';
import { ACCOUNT_CHANGED_EVENT, useServer } from '../lib/server';
import {
  ACTION_LABEL, applyPhotoScope, photoDetailsKey, photoFactsFrom, postcodeProblem, REFURB_LIMITS, refurbInputProblems,
  type Limit, type RefurbExplainResult, type RefurbPhotoFacts, type RefurbPhotosResult, type ScopeBasis,
} from '../lib/ai/property';
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

/* ───────────────────────── inputs ───────────────────────── */

/** NumberField limits from the table the server checks against (src/lib/ai/property.ts). */
const rules = (l: Limit) => ({ min: l.min, max: l.max, integer: l.whole, unit: l.unit === '£' ? undefined : l.unit, prefix: l.unit === '£' ? '£' : undefined });

/** Names for the details people can get wrong, for "fix these first" messages. */
const DETAIL_LABEL: Record<string, string> = {
  postcode: 'Postcode', floorArea: 'Floor area', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms to fit', storeys: 'Storeys', structuralOpenings: 'Structural openings',
  extensionArea: 'Extension', loftArea: 'Loft conversion', ensuites: 'New en-suites', groundworksArea: 'Groundworks area', officeToResiArea: 'Area converted to resi',
};

/** Which fields hold something that can't be used yet (reported by NumberField). */
function useFieldValidity() {
  const [bad, setBad] = useState<string[]>([]);
  const track = useCallback((name: string) => (valid: boolean) => setBad((b) => (valid ? b.filter((x) => x !== name) : b.includes(name) ? b : [...b, name])), []);
  return { bad, track };
}

function PostcodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const problem = postcodeProblem(value);
  // The message sits outside the <label>: it is the field's description, never part of its name.
  return (
    <div className="field">
      <label htmlFor={id}>Postcode</label>
      <input id={id} className="input mono" value={value} autoComplete="postal-code" spellCheck={false} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-err`} onChange={(e) => onChange(e.target.value)} />
      <span id={`${id}-err`} className="field-error xs" aria-live="polite" style={problem ? undefined : { position: 'absolute' }}>{problem ?? ''}</span>
    </div>
  );
}

/* ───────────────────────── keeping what people typed ───────────────────────── */
/**
 * The estimator's details are kept for this visit (sessionStorage), so going to sign in, following a link
 * or reloading never loses them. Per property, so another listing's figures never mix in.
 */
const DRAFT_PREFIX = 'streetkey-draft:estimate:';
const draftKey = (propertyId: string | null) => `${DRAFT_PREFIX}${propertyId ?? 'example'}`;
function readDraft(key: string, base: RefurbInput): RefurbInput | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RefurbInput> | null;
    if (!v || typeof v !== 'object' || typeof v.postcode !== 'string' || typeof v.floorArea !== 'number' || !v.scope || typeof v.scope !== 'object') return null;
    return { ...base, ...v, scope: { ...base.scope, ...v.scope } };
  } catch { return null; }
}
const writeDraft = (key: string, v: RefurbInput) => { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable: nothing kept */ } };
const dropDraft = (key: string) => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } };
/** Forgets every property's kept details in this tab. */
function dropAllDrafts() {
  try {
    const keys: string[] = [];
    for (let n = 0; n < sessionStorage.length; n++) { const k = sessionStorage.key(n); if (k?.startsWith(DRAFT_PREFIX)) keys.push(k); }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was kept */ }
}
// The details belong to whoever typed them: when this tab signs out or changes account they are forgotten, so the
// next person never sees them. Registered once, when the page is first opened, so it also covers a sign-out made elsewhere.
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_CHANGED_EVENT, dropAllDrafts);

/* ───────────────────────── files: choose or drop ───────────────────────── */
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** A file picker that also takes files dropped on it (the dashed box says it can). */
function DropZone({ children, onFiles, disabled, accept, multiple = true }: { children: ReactNode; onFiles: (list: FileList | null) => void; disabled?: boolean; accept?: string; multiple?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`dropzone pe-drop${over && !disabled ? ' is-over' : ''}`}
      onDragEnter={(e) => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } }}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFiles(e.dataTransfer.files); }}>
      <input className="sr-only" type="file" multiple={multiple} accept={accept} disabled={disabled} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      {children}
    </label>
  );
}

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
 * Returns null when the browser can't read the file as an image (it would only fail on the server).
 */
async function shrinkPhoto(file: File): Promise<File | null> {
  if (typeof createImageBitmap !== 'function') return file;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  try {
    if (!bmp.width || !bmp.height) return null;
    const scale = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file; // readable, just not resizable here
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const encode = (q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    let blob = await encode(0.8);
    if (blob && blob.size > 700 * 1024) blob = (await encode(0.65)) ?? blob; // very detailed photos
    return blob && blob.size < file.size ? new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' }) : file;
  } catch { return file; } finally { bmp.close(); }
}

/** A titled list in an AI result; the title is a heading one level below the card's. */
function AiList({ title, items, level = 4 }: { title: string; items: string[]; level?: 4 | 5 }) {
  if (!items.length) return null;
  const H = `h${level}` as const;
  return <div><H className="ai-prop-h">{title}</H><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

/** "Fix these first" for the AI features, or null when every detail can be sent. */
function blockedMessage(fields: string[]) {
  if (!fields.length) return null;
  const names = fields.map((f) => DETAIL_LABEL[f] ?? f);
  return `To use Streetkey AI, first fix ${names.length === 1 ? 'this detail' : 'these details'} above: ${names.join(', ')}.`;
}

/** Photo estimates need a confirmed email address (they use the most expensive AI). */
function ConfirmEmailNote() {
  const { setUser } = useServer();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed' | 'checking' | 'still'>('idle');
  const send = async () => {
    if (state === 'sending') return;
    setState('sending');
    try { await api.auth.resendVerification(); setState('sent'); } catch { setState('failed'); }
  };
  const check = async () => {
    setState('checking');
    const r = await api.auth.me().catch(() => null);
    if (r?.user?.emailVerified) setUser(r.user); else setState('still');
  };
  return (
    <div className="callout small" style={{ marginBottom: 10 }}>
      <b>Confirm your email address to estimate from photos.</b> Use the link we emailed you (check your spam folder too).
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="linkish" onClick={() => void send()} aria-disabled={state === 'sending' || undefined}>Send the link again</button>
        <button type="button" className="linkish" onClick={() => void check()} aria-disabled={state === 'checking' || undefined}>I’ve confirmed it</button>
        <span role="status" className="xs">
          {state === 'sending' ? 'Sending…' : state === 'sent' ? 'We’ve sent a new link.' : state === 'failed' ? <>Couldn’t send it just now. <Link to="/account">Go to your account</Link> to try again.</> : state === 'checking' ? 'Checking…' : state === 'still' ? 'Not confirmed yet. Open the link in the email, then try again.' : ''}
        </span>
      </div>
    </div>
  );
}

interface Picked { id: string; file: File; url: string }

function PhotoEstimate({ input, currentTotal, blocked, onApply, onUndo }: { input: RefurbInput; currentTotal: number; blocked: string | null; onApply: (next: RefurbInput) => void; onUndo: (() => void) | null }) {
  const { available, photos, reason, signedIn, user } = useAi();
  const { setUser } = useServer();
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
  }, { label: 'Photo estimate' });
  const unconfirmed = signedIn && !!user && !user.emailVerified;
  // The account may have been confirmed in another tab since this page loaded.
  useEffect(() => {
    if (!unconfirmed) return;
    let live = true;
    void api.auth.me().then((r) => { if (live && r.user?.emailVerified) setUser(r.user); }).catch(() => {});
    return () => { live = false; };
  }, [unconfirmed, setUser]);

  const add = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    job.clearError(); // an error about the earlier photos no longer applies
    const room = Math.max(0, MAX_PHOTOS - picked.length);
    const issues: string[] = [];
    if (chosen.length > room) issues.push(`You can add up to ${MAX_PHOTOS} photos, so ${chosen.length - room} ${chosen.length - room === 1 ? 'wasn’t' : 'weren’t'} added.`);
    const next: Picked[] = [];
    let total = picked.reduce((n, p) => n + p.file.size, 0);
    for (const f of chosen.slice(0, room)) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { issues.push(`${f.name}: use a JPEG, PNG or WebP photo.`); continue; }
      const small = await shrinkPhoto(f);
      if (!small) { issues.push(`${f.name}: we couldn’t read this photo. Try another one, or save it again as a JPEG.`); continue; }
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
  const remove = (id: string, k: number) => {
    job.clearError();
    setNotes([]);
    setPicked((x) => x.filter((y) => y.id !== id));
    // Keep focus in the list: the next photo's remove button, or the photo picker when none is left.
    requestAnimationFrame(() => {
      const btns = document.querySelectorAll<HTMLButtonElement>('.pe-thumbs .pe-remove');
      (btns[Math.min(k, btns.length - 1)] ?? document.querySelector<HTMLInputElement>('.pe-drop input[type=file]'))?.focus();
    });
  };
  const canAnalyse = picked.length > 0 && consent && !blocked && !unconfirmed;
  const analyse = () => {
    if (!canAnalyse) return;
    setApplied(false); setProgress(null);
    setSentThumbs(picked.map((p) => p.url));
    setAnalysedFor(photoDetailsKey(input));
    void job.run(picked.map((p) => p.file), photoFactsFrom(input));
  };
  const r = job.data;
  const stale = !!r && analysedFor != null && analysedFor !== photoDetailsKey(input);
  const hintId = useId();
  const why = blocked ?? (unconfirmed ? 'Confirm your email address first.' : !picked.length ? null : !consent ? 'Tick the box above to continue.' : null);

  return (
    <Section title="Estimate from photos" kicker="Step 4 · optional" right={<AiLabel />}>
      <p className="small muted" style={{ marginTop: 0 }}>Add up to {MAX_PHOTOS} photos of the rooms and the outside. Streetkey AI describes what it can see and suggests a scope of works; Streetkey’s cost engine prices it, using the property details above.</p>
      {!photos || !signedIn ? <AiUnavailable reason={available && !photos ? 'disabled' : reason} signedOut={photos && !signedIn} feature="Estimating from photos" noFallback fallback="Use Step 3 or a survey in Step 5 instead." /> : <>
        {unconfirmed && <ConfirmEmailNote />}
        <DropZone onFiles={(l) => void add(l)} disabled={job.busy || picked.length >= MAX_PHOTOS} accept="image/jpeg,image/png,image/webp">
          {picked.length >= MAX_PHOTOS ? `You’ve added ${MAX_PHOTOS} photos (the maximum).` : `Choose photos, or drop them here (JPEG, PNG or WebP). They’re resized in your browser; up to ${mb(MAX_TOTAL_BYTES)} in total.`}
        </DropZone>
        {picked.length > 0 && <ul className="pe-thumbs" aria-label="Photos to analyse">{picked.map((p, k) => (
          <li key={p.id}>
            <img src={p.url} alt={`Photo ${k + 1}: ${p.file.name}`} />
            <span className="pe-n" aria-hidden="true">{k + 1}</span>
            <button type="button" className="pe-remove" aria-label={`Remove photo ${k + 1}`} disabled={job.busy} onClick={() => remove(p.id, k)}><Icon name="x" size={14} /></button>
          </li>
        ))}</ul>}
        {notes.length > 0 && <ul className="ticks small" role="alert" style={{ marginTop: 8 }}>{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <label className="check" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I’m happy for these photos to be sent to Streetkey’s AI provider (OpenAI) for analysis. They’re deleted once analysed. Please avoid photos showing people or documents.</span>
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <AiButton busy={job.busy} disabled={!canAnalyse} onClick={analyse} busyLabel="Analysing…" aria-describedby={why ? hintId : undefined}>{picked.length ? `Analyse ${picked.length} photo${picked.length === 1 ? '' : 's'}` : 'Analyse photos'}</AiButton>
          {why && <span id={hintId} className="xs muted">{why}</span>}
        </div>
        {job.busy && <AiThinking label={progress ?? 'Uploading your photos'} />}
        <AiErrorNote error={job.error} onRetry={canAnalyse ? analyse : undefined} />
        {r && !job.busy && <PhotoResult r={r} input={input} currentTotal={currentTotal} thumbs={sentThumbs} applied={applied} stale={stale}
          onReanalyse={canAnalyse ? analyse : null}
          onApply={() => { onApply(r.scope); setApplied(true); }}
          onUndo={onUndo ? () => { onUndo(); setApplied(false); } : null} />}
      </>}
    </Section>
  );
}

function PhotoResult({ r, input, currentTotal, thumbs, applied, stale, onReanalyse, onApply, onUndo }: {
  r: RefurbPhotosResult; input: RefurbInput; currentTotal: number; thumbs: string[]; applied: boolean; stale: boolean;
  onReanalyse: (() => void) | null; onApply: () => void; onUndo: (() => void) | null;
}) {
  // Priced live by the engine: the photo scope on top of the estimator's current details and plans.
  const est = useMemo(() => estimateRefurb(applyPhotoScope(input, r.scope)), [input, r.scope]);
  const [confirming, setConfirming] = useState(false);
  const applyRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  /** Where focus goes after the next render (the control the person used is replaced). */
  const focusNext = useRef<'apply' | 'undo' | 'confirm' | null>(null);
  useEffect(() => {
    const t = focusNext.current;
    if (!t) return;
    focusNext.current = null;
    (t === 'apply' ? applyRef.current : t === 'undo' ? undoRef.current : confirmRef.current)?.focus();
  });
  const confirmId = useId();

  const diff = est.total - currentTotal;
  const drop = currentTotal > 0 ? -diff / currentTotal : 0;
  const lowConfidence = r.overall.confidence === 'low';
  const change = Math.abs(diff) < 1 ? `Same as your current estimate (${gbp(currentTotal)}).`
    : diff < 0 ? `Applying this lowers your estimate by ${gbp(-diff)}, from ${gbp(currentTotal)} to ${gbp(est.total)}.`
    : `Applying this raises your estimate by ${gbp(diff)}, from ${gbp(currentTotal)} to ${gbp(est.total)}.`;
  const checks = [
    lowConfidence && `The AI wasn’t confident about these photos${r.overall.photosUsed < r.overall.photosSent ? ` (only ${r.overall.photosUsed} of ${r.overall.photosSent} could be used)` : ''}.`,
    drop > 0.25 && `It would lower your estimate by ${Math.round(drop * 100)}%.`,
  ].filter((x): x is string => !!x);
  const apply = () => { setConfirming(false); focusNext.current = 'undo'; onApply(); };
  const startApply = () => { if (checks.length) { focusNext.current = 'confirm'; setConfirming(true); } else apply(); };
  const undo = onUndo ? () => { focusNext.current = 'apply'; onUndo(); } : null;

  return (
    <div style={{ marginTop: 12 }}>
      <AiCard title="What the AI saw" headingLevel={4} focusKey={r} footer={<AiDisclaimer>{r.label} Not a survey, valuation or quote.</AiDisclaimer>}>
        {stale && <div className="callout small ai-prop-stale" role="status">
          You’ve changed the property details since these photos were analysed. The total below uses your current details, but the suggested scope was worked out for the earlier ones.
          {onReanalyse && <> <AiButton kind="ghost" size="sm" onClick={onReanalyse}>Analyse again</AiButton></>}
        </div>}
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="num" style={{ fontSize: 26, lineHeight: 1.1 }}>{gbp(est.total)}</div>
            <div className="xs muted">Streetkey engine estimate for this scope with your current details and plans, likely {gbp(est.low)} – {gbp(est.high)}</div>
          </div>
          <div className="ai-chips">
            <span className="ai-chip">Condition <b>{r.overall.condition}</b>{r.overall.conditionFrom === 'yours' ? ' (as you gave it)' : ''}</span>
            <span className="ai-chip">Confidence <b>{r.overall.confidence}</b></span>
            <span className="ai-chip"><b>{r.overall.photosUsed}</b> of {r.overall.photosSent} photos used</span>
          </div>
        </div>
        {!applied && <p className="small" style={{ margin: 0 }}>{change}</p>}
        <div role="status" className="small">{applied ? <><b>Scope applied.</b> The estimator now uses it: fine-tune anything above.</> : null}</div>
        {applied ? (
          onUndo && <div className="row"><button ref={undoRef} type="button" className="btn ghost sm" onClick={undo ?? undefined}>Undo</button></div>
        ) : confirming ? (
          <div className="callout small stack" role="group" aria-labelledby={confirmId} style={{ gap: 8 }}>
            <p id={confirmId} ref={confirmRef} tabIndex={-1} style={{ margin: 0 }}><b>Check before applying.</b> {checks.join(' ')} It would replace your condition and scope of works; you can undo it.</p>
            <div className="row">
              <button type="button" className="btn accent sm" onClick={apply}>Apply anyway</button>
              <button type="button" className="btn ghost sm" onClick={() => { focusNext.current = 'apply'; setConfirming(false); }}>Keep my current scope</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button ref={applyRef} type="button" className="btn accent sm" onClick={startApply}>Apply this scope to the estimator</button>
            <span className="xs muted">Updates the condition, bathrooms and scope of works; your property details and plans stay as they are.</span>
          </div>
        )}
        <h5 className="ai-prop-h">Photo by photo</h5>
        <ul className="pe-obs">{r.observations.map((o) => (
          <li key={o.photo} className={thumbs[o.photo - 1] ? '' : 'no-thumb'}>
            {thumbs[o.photo - 1] && <img src={thumbs[o.photo - 1]} alt="" />}
            <div className="small">
              {!o.analysed
                ? <><b>Photo {o.photo}:</b> <span className="xs muted">couldn’t be analysed</span></>
                : <><b>Photo {o.photo}: {o.room}</b>{' '}<span className="xs muted">{!o.isProperty ? 'doesn’t show the property, ignored' : `${o.condition} condition · ${o.confidence} confidence`}</span></>}
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
        <AiList title="Questions for your surveyor or builder" items={r.questionsForSurveyor} level={5} />
        <AiList title="Keep in mind" items={r.caveats} level={5} />
      </AiCard>
    </div>
  );
}

/* ───────────────────────── AI: explain this estimate ───────────────────────── */
function ExplainEstimate({ input, blocked }: { input: RefurbInput; blocked: string | null }) {
  const { available, reason } = useAi();
  const [asked, setAsked] = useState<string | null>(null);
  const ex = useAiAction((i: RefurbInput) => aiPost<{ explanation: RefurbExplainResult }>('/api/ai/refurb/explain', { input: i }).then((r) => r.explanation), { label: 'Explanation' });
  const key = JSON.stringify(input);
  const { clearError } = ex;
  useEffect(() => { clearError(); }, [key, clearError]); // an error about earlier inputs no longer applies
  const run = () => { if (blocked) return; setAsked(key); void ex.run(input); };
  const x = ex.data;
  const hintId = useId();
  if (reason === 'checking') return null;
  if (!available) return <AiCard tone="quiet" title="Explain this estimate"><AiUnavailable reason={reason} feature="The AI explanation" /></AiCard>;
  return (
    <AiCard title="Explain this estimate" focusKey={x} footer={x && !ex.busy ? <AiDisclaimer>{x.disclaimer}</AiDisclaimer> : undefined}>
      {!x && <>
        <p className="small muted" style={{ margin: 0 }}>A plain-English walk-through of what drives this total, ways to save and what could push it up. The figures come from Streetkey’s cost engine.</p>
        <div className="row">
          <AiButton busy={ex.busy} disabled={!!blocked} onClick={run} busyLabel="Explaining…" aria-describedby={blocked ? hintId : undefined}>Explain this estimate</AiButton>
          {blocked && <span id={hintId} className="xs muted">{blocked}</span>}
        </div>
      </>}
      {ex.busy && <AiThinking label="Reading the estimate" />}
      <AiErrorNote error={ex.error} onRetry={blocked ? undefined : run} />
      {x && !ex.busy && <>
        <p className="small" style={{ margin: 0 }}><b>Explains {gbp(x.estimate.total)}</b> (likely {gbp(x.estimate.low)} – {gbp(x.estimate.high)}, {x.estimate.confidence} confidence).</p>
        {asked !== key && <div className="callout small ai-prop-stale" role="status">
          You’ve changed the inputs since this explanation, so it may not match the total above.{' '}
          <AiButton kind="ghost" size="sm" disabled={!!blocked} onClick={run}>Explain again</AiButton>
        </div>}
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

/** Starts the page afresh (no kept details, no AI answers) when the person using this tab signs out or the account changes. */
export default function Estimator() {
  const [person, setPerson] = useState(0);
  useEffect(() => {
    const next = () => setPerson((n) => n + 1);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, next);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, next);
  }, []);
  return <EstimatorPage key={person} restarted={person > 0} />;
}

function EstimatorPage({ restarted }: { restarted: boolean }) {
  const [params] = useSearchParams();
  // App.tsx starts this page afresh whenever ?property= changes, so the listing is read once.
  const [prop] = useState(() => getProperty(params.get('property') ?? '') ?? null);
  const key = draftKey(prop?.id ?? null);
  const start = useMemo(() => (prop ? refurbInputFor(prop) : DEFAULT_INPUT), [prop]);
  const [initial] = useState(() => { const d = readDraft(key, start); return { input: d ?? start, restored: !!d }; });
  const [input, setInput] = useState<RefurbInput>(initial.input);
  const [restored, setRestored] = useState(initial.restored);
  const [beforeAi, setBeforeAi] = useState<RefurbInput | null>(null);
  const [view, setView] = useState<'trade' | 'room' | 'boq'>('trade');
  const [files, setFiles] = useState<{ name: string; kind: string }[]>([]);
  const [findings, setFindings] = useState<string[]>([]);
  const { bad, track } = useFieldValidity();
  const headRef = useRef<HTMLHeadingElement>(null);
  const totalRef = useRef<HTMLDivElement>(null);
  const est = useMemo(() => estimateRefurb(input), [input]);
  const scen = useMemo(() => scenarios(input), [input]);
  const rooms = useMemo(() => byRoom(est, input), [est, input]);
  const set = <K extends keyof RefurbInput>(k: K, v: RefurbInput[K]) => setInput((s) => ({ ...s, [k]: v }));
  const scope = <K extends keyof RefurbInput['scope']>(k: K, v: RefurbInput['scope'][K]) => setInput((s) => ({ ...s, scope: { ...s.scope, [k]: v } }));
  const region = regionFromPostcode(input.postcode);
  const maxTrade = Math.max(...est.byTrade.map((t) => t.total), 1);
  const R = REFURB_LIMITS;
  // What the AI features can't send yet: details the server would refuse, and number boxes holding something unusable.
  const problems = useMemo(() => Object.keys(refurbInputProblems(input)), [input]);
  // Only boxes on screen count (the office-to-resi area is shown for commercial projects only).
  const badShown = bad.filter((k) => k !== 'officeToResiArea' || input.propertyType === 'commercial');
  const blocked = blockedMessage([...new Set([...problems, ...badShown])]);

  // Keep the details for this visit once they differ from the starting figures (nothing to keep otherwise).
  useEffect(() => {
    if (JSON.stringify(input) === JSON.stringify(start)) dropDraft(key); else writeDraft(key, input);
  }, [key, input, start]);
  const startAgain = () => {
    dropDraft(key);
    setInput(start); setBeforeAi(null); setRestored(false);
    requestAnimationFrame(() => headRef.current?.focus());
  };
  // Restarted after a sign-out or account change: if focus was in the page, it goes to the heading, not <body>.
  useEffect(() => {
    if (restarted && (!document.activeElement || document.activeElement === document.body)) headRef.current?.focus({ preventScroll: true });
  }, [restarted]);

  // A file dropped just outside a drop zone would otherwise open in the tab and lose everything here.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);

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
  const toTotal = () => { const el = totalRef.current; if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.focus({ preventScroll: true }); };
  const investLink = `/invest?${prop ? `property=${encodeURIComponent(prop.id)}&` : ''}refurb=${est.total}&from=estimate`;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI regional refurbishment cost engine</div>
          <h2 ref={headRef} tabIndex={-1} style={{ marginTop: 6 }}>Refurbishment cost estimator</h2>
          <p className="muted" style={{ marginTop: 6 }}>Elemental UK estimate: measured works × regional, condition, era and access factors, plus preliminaries, overheads & profit, contingency, professional fees and VAT.{prop && <> Prefilled from <Link to={`/property/${prop.id}`}>{prop.title}</Link>.</>}</p>
          {restored && <p className="callout info small" style={{ marginTop: 8 }}>We’ve kept the details you entered earlier in this visit. <button type="button" className="linkish" onClick={startAgain}>Start again{prop ? ' from the listing' : ''}</button></p>}
        </div>
        <div className="row"><Tag kind="est" /><Tag kind="demo">{est.basis.version}</Tag><Tag kind="neutral">Pricing date {est.basis.basisDate}</Tag></div>
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 14 }}>
          <Section title="Property" kicker="Step 1">
            <div className="grid g2" style={{ gap: 10 }}>
              <PostcodeField value={input.postcode} onChange={(v) => set('postcode', v)} />
              <div className="field"><span>Region (auto)</span><div className="input small" style={{ background: 'var(--surface-2)' }}>{region ? `${REGIONS[region].label} ×${REGIONS[region].factor}` : 'Unknown — UK avg'}</div></div>
              <Field label="Type"><select className="input" value={input.propertyType} onChange={(e) => set('propertyType', e.target.value as PropertyType)}>{['terraced', 'semi-detached', 'detached', 'flat', 'bungalow'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <NumberField label="Floor area (m² GIA)" value={input.floorArea} onChange={(v) => set('floorArea', v)} {...rules(R.floorArea)} onValidityChange={track('floorArea')} />
              <NumberField label="Bedrooms" value={input.bedrooms} onChange={(v) => set('bedrooms', v)} {...rules(R.bedrooms)} onValidityChange={track('bedrooms')} />
              <NumberField label="Bathrooms to fit" value={input.bathrooms} onChange={(v) => set('bathrooms', v)} {...rules(R.bathrooms)} onValidityChange={track('bathrooms')} />
              <NumberField label="Storeys" value={input.storeys} onChange={(v) => set('storeys', v)} {...rules(R.storeys)} onValidityChange={track('storeys')} />
              <Field label="Construction era"><select className="input" value={input.era} onChange={(e) => set('era', e.target.value as Era)}>{['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Condition"><select className="input" value={input.condition} onChange={(e) => set('condition', e.target.value as Condition)}>{['good', 'fair', 'poor', 'derelict'].map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Site access"><select className="input" value={input.access} onChange={(e) => set('access', e.target.value as Access)}><option value="easy">Easy (driveway)</option><option value="restricted">Restricted (on-street, CPZ)</option><option value="difficult">Difficult (no parking, upper floor, no lift)</option></select></Field>
            </div>
          </Section>
          <Section title={<span id="est-project-type">Project type</span>} kicker="Step 2">
            <Seg aria-labelledby="est-project-type" value={input.propertyType === 'commercial' ? (input.scope.officeToResiArea ? 'o2r' : 'fitout') : 'resi'} onChange={(v) => setInput((s) => v === 'resi'
              ? { ...s, propertyType: s.propertyType === 'commercial' ? 'terraced' : s.propertyType, scope: { ...s.scope, fitOut: 'none', officeToResiArea: 0 } }
              : v === 'fitout' ? { ...s, propertyType: 'commercial', vat: 'standard', scope: { ...s.scope, fitOut: 'cat-a', officeToResiArea: 0, kitchen: false, damp: false } }
              : { ...s, propertyType: 'commercial', vat: 'reduced-conversion', scope: { ...s.scope, fitOut: 'none', officeToResiArea: Math.min(s.floorArea, R.officeToResiArea.max), kitchen: false, damp: false } })}
              options={[{ value: 'resi', label: 'Residential refurbishment' }, { value: 'fitout', label: 'Commercial fit-out' }, { value: 'o2r', label: 'Office → residential', ariaLabel: 'Office to residential' }]} />
            {input.propertyType === 'commercial' && <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
              <Field label="Fit-out level"><select className="input" value={input.scope.fitOut ?? 'none'} onChange={(e) => scope('fitOut', e.target.value as 'none')}><option value="none">None</option><option value="cat-a">Cat A</option><option value="cat-a+b">Cat A + Cat B</option></select></Field>
              <NumberField label="Area converted to resi (m²)" value={input.scope.officeToResiArea ?? 0} onChange={(v) => scope('officeToResiArea', v)} {...rules(R.officeToResiArea)} onValidityChange={track('officeToResiArea')} />
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
              <NumberField label="Structural openings (RSJ)" value={input.scope.structuralOpenings} onChange={(v) => scope('structuralOpenings', v)} {...rules(R.structuralOpenings)} onValidityChange={track('structuralOpenings')} />
              <Field label={`Extension: ${input.scope.extensionArea}m²`}><input type="range" min={0} max={40} value={Math.min(40, input.scope.extensionArea)} onChange={(e) => scope('extensionArea', Number(e.target.value))} /></Field>
              <Field label={`Loft conversion: ${input.scope.loftArea}m²`}><input type="range" min={0} max={40} value={Math.min(40, input.scope.loftArea)} onChange={(e) => scope('loftArea', Number(e.target.value))} /></Field>
              <NumberField label="Groundworks area (m²)" value={input.scope.groundworksArea ?? 0} onChange={(v) => scope('groundworksArea', v)} {...rules(R.groundworksArea)} onValidityChange={track('groundworksArea')} />
              <NumberField label="New en-suites" value={input.scope.ensuites} onChange={(v) => scope('ensuites', v)} {...rules(R.ensuites)} onValidityChange={track('ensuites')} />
              <Field label="VAT treatment"><select className="input" value={input.vat} onChange={(e) => set('vat', e.target.value as VatTreatment)}>{Object.entries(VAT_RATES).map(([k, v]) => <option key={k} value={k}>{v.label.split(' (')[0].split(' —')[0]}{k.startsWith('reduced') ? ` (${k === 'reduced-empty-2yrs' ? 'empty 2+ yrs' : 'conversion'})` : ''}</option>)}</select></Field>
            </div>
            <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={input.includeProfessionalFees} onChange={(e) => set('includeProfessionalFees', e.target.checked)} />Include professional fees (architect, engineer, building control, party wall)</label>
          </Section>
          <PhotoEstimate input={input} currentTotal={est.total} blocked={blocked}
            onApply={(photoScope) => { setBeforeAi(input); setInput((cur) => applyPhotoScope(cur, photoScope)); }}
            onUndo={beforeAi ? () => { setInput((cur) => applyPhotoScope(cur, beforeAi)); setBeforeAi(null); } : null} />
          <Section title="Plans & surveys" kicker="Step 5 · optional" right={<Tag kind="neutral">Read in your browser</Tag>}>
            <DropZone onFiles={(l) => void onFiles(l)} accept="image/*,.pdf,.txt,.md,.csv">
              Add floor plans or a survey, or drop them here (a .txt survey is read in your browser)
            </DropZone>
            <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={loadSampleSurvey}>Load sample survey extract</button>
            {files.length > 0 && <ul className="clean small" style={{ marginTop: 10 }}>{files.map((f, i) => <li key={i}><Tag kind="neutral">{f.kind}</Tag> {f.name}</li>)}</ul>}
            {findings.length > 0 && <div className="callout info" style={{ marginTop: 10 }} role="status"><b>Survey interpretation</b> (scope updated — please confirm):<ul className="ticks" style={{ marginTop: 6 }}>{findings.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
            <p className="xs muted" style={{ marginTop: 8 }}>Files here stay in your browser: survey text is matched against simple rules and the scope is updated for you to confirm. For photos, use “Estimate from photos” above.</p>
          </Section>
          {/* Phones and tablets: the total sits below all the steps, so keep it in view while editing. */}
          <div className="est-sticky">
            <span className="small">Estimate <b className="num">{gbp(est.total)}</b> <span className="xs">likely {gbpK(est.low)}–{gbpK(est.high)}</span></span>
            <button type="button" className="linkish xs" onClick={toTotal}>See the breakdown</button>
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card ink" ref={totalRef} tabIndex={-1} id="est-total" role="region" aria-labelledby="est-total-label">
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="eyebrow" id="est-total-label" style={{ color: 'inherit', opacity: 0.6 }}>Estimated total, incl. {Math.round(VAT_RATES[input.vat].rate * 100)}% VAT</div>
                <div className="num" style={{ fontSize: 'clamp(2.4rem, 6vw, 3.6rem)', lineHeight: 1.05, marginTop: 6 }}>{gbp(est.total)}</div>
                <div className="muted small" style={{ marginTop: 4 }}>Likely range {gbp(est.low)} – {gbp(est.high)} · <b style={{ color: 'inherit' }}>{est.confidence}</b> confidence</div>
                {badShown.length > 0 && <div className="small" style={{ marginTop: 6 }}>A detail on the left needs fixing: this total uses the last figures that could be used.</div>}
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
              <button key={spec} type="button" aria-pressed={spec === input.spec} onClick={() => set('spec', spec as Spec)} className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: spec === input.spec ? 'var(--ink)' : undefined, borderWidth: spec === input.spec ? 2 : 1 }}>
                <div className="row between"><span className="eyebrow">{spec}</span>{spec === input.spec && <Tag kind="neutral">Selected</Tag>}</div>
                <div className="num" style={{ fontSize: 24, marginTop: 6 }}>{gbpK(estimate.total)}</div>
                <div className="xs muted">{gbp(estimate.costPerM2)}/m² · {spec === 'budget' ? 'Trade-counter kitchen, laminate, uPVC' : spec === 'standard' ? 'Mid-range kitchen, LVT/carpet, A-rated uPVC' : 'Bespoke kitchen, engineered oak, timber windows'}</div>
              </button>
            ))}
          </div>

          <ExplainEstimate input={input} blocked={blocked} />

          <Section title="Breakdown" right={<>
            <Seg aria-label="Breakdown view" value={view} onChange={setView} options={[{ value: 'trade', label: 'By trade' }, { value: 'room', label: 'By room' }, { value: 'boq', label: 'Bill of quantities' }]} />
            <button type="button" className="btn ghost sm" onClick={() => download(`streetkey-boq-${input.postcode.replace(/\s/g, '')}.csv`, boqCsv(est))}>Export BoQ (CSV)</button>
          </>}>
            {view === 'trade' && est.byTrade.map((t) => <Meter key={t.trade} label={t.trade} value={t.total} max={maxTrade} display={gbpK(t.total)} />)}
            {view === 'room' && <>
              {rooms.rooms.map((r) => <Meter key={r.name} label={r.name} value={r.total} max={Math.max(...rooms.rooms.map((x) => x.total), ...rooms.whole.map((x) => x.total))} display={gbpK(r.total)} color="var(--blue)" />)}
              <div className="eyebrow" style={{ margin: '12px 0 4px' }}>Whole-house items</div>
              {rooms.whole.map((r) => <Meter key={r.name} label={r.name} value={r.total} max={Math.max(...rooms.rooms.map((x) => x.total), ...rooms.whole.map((x) => x.total))} display={gbpK(r.total)} color="var(--gold)" />)}
              <p className="xs muted" style={{ marginTop: 8 }}>Measured works only (before prelims, OH&P, contingency, fees, VAT). Area-based trades are apportioned by typical room area.</p>
            </>}
            {view === 'boq' && <div className="table-wrap" tabIndex={0} role="region" aria-label="Bill of quantities"><table className="t">
              <thead><tr><th scope="col">#</th><th scope="col">Description</th><th scope="col" className="r">Qty</th><th scope="col">Unit</th><th scope="col" className="r">Rate</th><th scope="col" className="r">Total</th></tr></thead>
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
            <b>Pricing basis:</b> {est.basis.source} Basis date {est.basis.basisDate}. This is a budget estimate for feasibility, not a tender price. Obtain at least three quotations against the exported scope — <Link to="/marketplace">compare them here</Link>. <Link to={investLink}>Use this estimate in the investment analyser →</Link> Each verified quote (with consent) recalibrates the regional rate library.
          </div>
        </div>
      </div>
    </div>
  );
}
