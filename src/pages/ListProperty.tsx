import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, ApiError, mediaUrl } from '../lib/api';
import type { ListingStatus, PhotoDTO } from '../lib/apiTypes';
import { useServer } from '../lib/server';
import { SignIn } from './Account';
import { EpcLookup, PriceEvidence, useRealRange, useSoldNear } from '../components/official/ListingForm';
import { altTextProblem, areaEvidence, buildListing, complianceChecks, normalisePostcode, placeFieldProblem, POSTCODE_RE, streetOnly, type Check, type ListingInput } from '../engine/listings';
import type { Condition, Era, PropertyType } from '../engine/refurb';
import { PROPERTIES, type Property } from '../data/properties';
import { regionFromPostcode } from '../engine/refurb';
import { gbp, gbpK, HouseArt, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { useStore } from '../store';
import { pollJob, runAsAiClick, signInPath, useAi, useAiAction } from '../lib/ai/core';
import { ACCOUNT_CHANGED_EVENT } from '../lib/server';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import {
  checkListingPhotos, clearDraft, dataUrlBytes, describeListing, factsFrom, featuresToAdd, FIELD_LABEL, FLAG_LABEL, getPhotoConsent, ISSUE_LABEL, isEnforced, LISTING_DRAFT_KEY, listingPhotos, loadDraft, loadDraftPhotos,
  PHOTO_CONSENT_TEXT, PHOTO_MAX_BYTES, photoInsightsFrom, precheckListing, PREVIEW_BATCH_FILES, previewPhotos, priceGuide, priorOf, roomLabel, saveDraft, savePhotoConsent, setPhotoAlt,
  saveDraftPhotos, setPhotoOrder, severityClass, severityLabel, sizeBatches, TONES, UPLOAD_BATCH_BYTES,
  type DescribeResult, type ListingPhotosResult, type PhotoAnalysis, type PhotoJobOutput, type PrecheckResult, type PriceGuideResult, type PriorItem, type Tone,
} from '../lib/ai/listing';
import '../components/ai/listing.css';

const STEPS = ['Basics', 'Address', 'Details', 'Photos', 'Price', 'Description', 'Review'];
const FEATURES = ['Garden', 'Parking', 'Garage', 'Balcony', 'Chain free', 'Period features', 'New kitchen', 'En-suite', 'Pets considered', 'Furnished', 'Close to station', 'Loft potential'];
const STAGED = 'Contains virtually staged images';
/** Which compliance checks belong to which step (for the step bar and the inline notes). */
const STEP_CHECKS: Record<number, string[]> = {
  1: ['postcode', 'tenure', 'lease', 'charges', 'address', 'town'], 2: ['ctax', 'epc', 'epc-let'], 3: ['photo-min', 'photos'], 4: ['price'],
  5: ['discrim', 'bidding', 'fees', 'contact', 'payment', 'scam'],
};
const PHOTO_LIMIT = { online: 30, offline: 10 };

/** Resize an uploaded image in the browser (small for the on-device preview; for the live site, under the upload and AI check limits). */
function compress(file: File, max = 900, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      let q = quality, url = c.toDataURL('image/jpeg', q);
      while (dataUrlBytes(url) > PHOTO_MAX_BYTES && q > 0.45) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
      resolve(url);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error(`${file.name} couldn’t be read`)); };
    img.src = URL.createObjectURL(file);
  });
}

const dataUrlToBlob = (u: string) => { const [head, b64] = u.split(','); const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: head.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg' }); };

/** The built-in template (used when AI isn't available). */
function draftDescription(i: ListingInput): string {
  const kind = i.listing === 'rent' ? 'available to rent' : 'for sale';
  const typeWord = i.type === 'flat' ? 'flat' : `${i.type} house`;
  const feats = i.features.slice(0, 4).map((f) => f.toLowerCase());
  const tenure = i.tenure === 'share-of-freehold' ? 'Share of freehold' : i.tenure.charAt(0).toUpperCase() + i.tenure.slice(1);
  return [
    `A ${i.beds ? `${i.beds}-bedroom ` : ''}${typeWord} ${kind} in ${i.town}${i.floorArea ? `, offering around ${i.floorArea}m² (${Math.round(i.floorArea * 10.764)} sq ft)` : ''}.`,
    feats.length ? `Highlights include ${feats.join(', ')}.` : '',
    i.condition === 'poor' || i.condition === 'derelict' ? 'The property would benefit from modernisation — Streetkey shows buyers a costed renovation estimate on the listing.' : i.condition === 'good' ? 'Presented in good condition throughout.' : '',
    i.listing === 'rent' ? `Rent ${gbp(i.price)} per month. EPC ${i.epc || '—'}, council tax band ${i.councilTax || '—'}.` : `${tenure}${i.tenure !== 'freehold' && i.leaseYears ? ` with ${i.leaseYears} years remaining` : ''}. EPC ${i.epc || '—'}, council tax band ${i.councilTax || '—'}.`,
  ].filter(Boolean).join(' ');
}

/** Stable key for "has this input changed since the AI looked at it?" */
const keyOf = (v: unknown) => JSON.stringify(v);

/** Moves focus to an element that isn't normally focusable (a heading or a message), once the page has updated. */
const focusSoon = (find: () => HTMLElement | null | undefined) => requestAnimationFrame(() => {
  const el = find();
  if (!el) return;
  if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus();
});

/** Demonstration lettings in the postcode's region: what the price check's rent per m² is averaged from (0 = estimated from sale values). */
const rentalComparables = (postcode: string) => {
  const region = regionFromPostcode(postcode);
  return PROPERTIES.filter((p) => p.listing === 'rent' && !p.source && regionFromPostcode(p.postcode) === region).length;
};
/** The gross yield the price check assumes when a region has no rental comparables (src/engine/listings.ts). */
const ASSUMED_YIELD_PCT = 4.5;

/* ───────────────────────── a labelled option group (radio group: one Tab stop, arrow keys move) ───────────────────────── */
function Choice<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : d ? (i + d + options.length) % options.length : -1;
    if (n < 0) return;
    e.preventDefault();
    onChange(options[n].value); refs.current[n]?.focus();
  };
  return (
    <div className="field lp-choice">
      <span id={id}>{label}</span>
      <div className="seg ail-seg" role="radiogroup" aria-labelledby={id}>
        {options.map((o, i) => (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={o.value === value} tabIndex={i === current ? 0 : -1}
            className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, i)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── AI: consent before any photo is sent to the AI provider ───────────────────────── */
function PhotoConsent({ value, onChange, note }: { value: boolean; onChange: (v: boolean) => void; note: string }) {
  return (
    <div className="ail-consent">
      <label className="check"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /><span>{PHOTO_CONSENT_TEXT}</span></label>
      {note && <p className="xs muted" role="status">{note}</p>}
    </div>
  );
}
const CONSENT_HINT = 'Tick the box above to use the AI photo check.';
/** A short note on what a background photo check couldn't do. */
function jobNote(out: PhotoJobOutput | null | undefined): string {
  if (!out) return '';
  if (out.consent === false) return 'AI photo checks are switched off, so no photos were sent.';
  const parts: string[] = [];
  if (out.failed) parts.push(`${out.failed === 1 ? '1 photo' : `${out.failed} photos`} couldn’t be checked by the AI.`);
  if (out.limited) parts.push('Some photos weren’t checked because you’ve reached today’s limit for AI photo checks. Try again tomorrow.');
  return parts.join(' ');
}

/* ───────────────────────── AI: description ───────────────────────── */
function DescribeAssist({ f, setF, photoInsights, onSignIn }: { f: ListingInput; setF: (fn: (x: ListingInput) => ListingInput) => void; photoInsights: string[]; onSignIn?: () => void }) {
  const ai = useAi();
  const aiOk = ai.available && ai.signedIn;
  const [tone, setTone] = useState<Tone>('warm');
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState<DescribeResult | null>(null);
  const [undo, setUndo] = useState<{ title?: string; description?: string } | null>(null);
  const [kf, setKf] = useState('');
  const [added, setAdded] = useState<number | null>(null);
  /** What the last button did, for screen readers (the template is never presented as AI). */
  const [said, setSaid] = useState('');
  const mainButton = useRef<HTMLButtonElement>(null);
  const write = useAiAction((facts: ReturnType<typeof factsFrom>, t: Tone, n: string, ins: string[]) => describeListing(facts, t, n, ins),
    { label: 'Description', announce: true, done: 'Your headline and description have been filled in. Edit anything you like.' });

  const applyTemplate = () => {
    setUndo({ title: f.title, description: f.description }); setDraft(null); setF((x) => ({ ...x, description: draftDescription(x) }));
    setSaid('Filled in from a basic template, not AI.');
  };
  const run = async () => {
    if (!aiOk) return;
    setSaid('');
    const r = await write.run(factsFrom(f), tone, notes, photoInsights);
    if (!r) return;
    setUndo({ title: f.title, description: f.description });
    // Bedrooms, tenure, EPC and the like are shown from your answers, so only the other key features are offered.
    setDraft(r); setKf(featuresToAdd(r.keyFeatures, r.structuredFeatures).join('\n')); setAdded(null);
    setF((x) => ({ ...x, title: r.headline || x.title, description: r.description || x.description }));
  };
  const addFeatures = () => {
    const lines = featuresToAdd(kf.split('\n'), draft?.structuredFeatures);
    let n = 0;
    setF((x) => {
      const have = new Set(x.features.map((y) => y.toLowerCase()));
      const fresh = lines.filter((l) => !have.has(l.toLowerCase()));
      n = Math.min(fresh.length, Math.max(0, 30 - x.features.length));
      return { ...x, features: [...x.features, ...fresh].slice(0, 30) };
    });
    setAdded(n);
  };

  const addable = draft ? featuresToAdd(draft.keyFeatures, draft.structuredFeatures) : [];
  return (
    <div className="ail-assist">
      {aiOk ? <>
        <Choice id="ail-tone-label" label="Tone" value={tone} onChange={setTone} options={TONES} />
        <label className="field">Your notes for the AI (optional)
          <textarea className="input" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. new boiler 2023, loft room used as a study, 8 minutes’ walk to the station" />
        </label>
        <p className="ail-note">The AI uses only your answers and notes{photoInsights.length ? ' (plus what the photo check saw)' : ''}. It won’t add prices, schools, transport or anything you haven’t told it.</p>
      </> : <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} onSignIn={onSignIn} feature="The AI description writer" fallback="You can fill in a basic template instead." />}
      <div className="ail-row">
        {/* Without AI, the button says what it really does: a plain template, never presented as AI. */}
        {aiOk
          ? <AiButton ref={mainButton} busy={write.busy} onClick={() => void run()}>{draft ? 'Write it again' : 'Write it for me'}</AiButton>
          : <button ref={mainButton} type="button" className="btn sm" onClick={applyTemplate}>Fill in a basic template</button>}
        {aiOk && <button type="button" className="btn ghost sm" onClick={applyTemplate}>Use the basic template</button>}
        {/* The Undo button goes once used: focus moves to the main button, not the page body. */}
        {undo && <button type="button" className="linkish" onClick={() => {
          setF((x) => ({ ...x, title: undo.title, description: undo.description ?? '' })); setUndo(null); setDraft(null);
          setSaid('Your earlier headline and description are back.'); focusSoon(() => mainButton.current);
        }}>Undo</button>}
        <span className="xs muted" role="status">{said}</span>
      </div>
      {write.busy && <AiThinking label="Writing your description" />}
      <AiErrorNote error={write.error} onRetry={() => void run()} />
      {write.error && <button type="button" className="btn ghost sm" onClick={applyTemplate}>Use the basic template instead</button>}
      {draft && !write.busy && (
        <AiCard title="Draft written" headingLevel={4} focusKey={draft} footer={<AiDisclaimer>{draft.label}</AiDisclaimer>}>
          <p className="ail-note">Your headline and description have been filled in below ({draft.wordCount} words). Edit anything you like.</p>
          {addable.length > 0 && <label className="field">Key features to add (one per line)
            <textarea className="input" rows={Math.min(8, Math.max(2, kf.split('\n').length + 1))} value={kf} onChange={(e) => { setKf(e.target.value); setAdded(null); }} />
          </label>}
          {draft.keyFeatures.length > 0 && <p className="xs muted">Bedrooms, bathrooms, floor area, tenure, EPC and council tax are shown on your listing from your answers, so they aren’t added as features.</p>}
          {addable.length > 0 && <div className="ail-row"><button type="button" className="btn ghost sm" disabled={!kf.trim()} onClick={addFeatures}>Add these to my features</button>
            <span className="xs muted" role="status">{added == null ? '' : added ? `Added ${added} to your features.` : 'They’re already in your features.'}</span></div>}
          {draft.materialInfo.length > 0 && <div><h5 className="ail-sub">Material information (from your answers, shown on the listing)</h5><ul className="ail-list">{draft.materialInfo.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          {draft.wordingWarnings.length > 0 && <div className="ail-warn" role="note"><b>Wording to check</b><ul>{draft.wordingWarnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {draft.missingInfo.length > 0 && <div><h5 className="ail-sub">People will also want to know</h5><ul className="ail-list">{draft.missingInfo.map((m) => <li key={m}>{m}</li>)}</ul></div>}
        </AiCard>
      )}
    </div>
  );
}

/* ───────────────────────── AI: photo check (photos still in the browser) ───────────────────────── */
/** An AI result for a photo still in the browser; token = the server's signed copy, sent with the upload. */
type Checked = PhotoAnalysis & { token?: string | null };
type Checks = Map<string, Checked>;
function PhotoCheck({ photos, checks, setChecks, advice, setAdvice, onOrder, staged, consent, onSignIn }: {
  photos: string[]; checks: Checks; setChecks: Dispatch<SetStateAction<Checks>>;
  advice: { order: string[]; tips: string[] } | null; setAdvice: (a: { order: string[]; tips: string[] } | null) => void;
  onOrder: (order: string[]) => void; staged: boolean; consent: boolean; onSignIn?: () => void;
}) {
  const ai = useAi();
  const aiOk = ai.photos && ai.signedIn;
  const [progress, setProgress] = useState('');
  const unchecked = photos.filter((p) => !checks.has(p));
  // The current results are passed in, so a run works from what it was started with.
  const action = useAiAction(async (list: string[], known: Checks, consented: boolean) => {
    if (!consented) return null; // nothing leaves the browser without consent
    const found: Checks = new Map(known);
    let keys = list.filter((p) => found.has(p));
    let prior: PriorItem[] = keys.map((k) => priorOf(found.get(k)));
    const todo = list.filter((p) => !found.has(p));
    let last: { order: string[]; tips: string[] } | null = null;
    // The exact files that will be uploaded (so the signed results match them), a few at a time.
    const chunks = sizeBatches(todo.map(dataUrlBytes), UPLOAD_BATCH_BYTES, PREVIEW_BATCH_FILES).map((b) => b.map((i) => todo[i]));
    let done = 0;
    for (const chunk of chunks) {
      setProgress(todo.length > chunk.length ? `Checking photos ${done + 1}–${done + chunk.length} of ${todo.length}` : 'Checking your photos');
      const r = await previewPhotos(chunk.map(dataUrlToBlob), prior);
      const fresh = new Map<string, Checked>();
      r.photos.forEach((p) => { if (p.analysis && chunk[p.index]) fresh.set(chunk[p.index], { ...p.analysis, token: p.token ?? null }); });
      fresh.forEach((a, k) => found.set(k, a));
      keys = [...keys, ...chunk];
      prior = [...prior, ...chunk.map((k) => priorOf(found.get(k)))];
      last = { order: r.suggestedOrder.map((n) => keys[n]).filter(Boolean), tips: r.tips };
      // Merge, so alt text edited meanwhile is kept.
      setChecks((prev) => { const n = new Map(prev); fresh.forEach((a, k) => { if (!n.has(k)) n.set(k, a); }); return n; });
      done += chunk.length;
    }
    if (last) setAdvice(last);
    return last;
  }, { label: 'Photo check', announce: true, done: (last) => (last ? 'Photo check ready.' : null) });
  if (!photos.length) return null;
  if (!aiOk && !checks.size) return <AiUnavailable reason={ai.available && !ai.photos ? 'disabled' : ai.reason} signedOut={ai.photos && !ai.signedIn} onSignIn={onSignIn} feature="The AI photo check" noFallback />;
  const inOrder = advice ? advice.order.filter((k) => photos.includes(k)) : [];
  const alreadyOrdered = advice ? inOrder.every((k, i) => photos[i] === k) : true;
  const setAlt = (key: string, alt: string) => setChecks((prev) => { const a = prev.get(key); if (!a) return prev; const n = new Map(prev); n.set(key, { ...a, alt }); return n; });

  return (
    <div className="ail-assist">
      {aiOk ? <>
        <div className="ail-row">
          <AiButton busy={action.busy} disabled={!unchecked.length || !consent} onClick={() => void action.run(photos, checks, consent)}>{unchecked.length === photos.length ? 'Check my photos with AI' : unchecked.length ? `Check ${unchecked.length} new photo${unchecked.length === 1 ? '' : 's'}` : 'All photos checked'}</AiButton>
          <span className="xs muted">{consent ? 'Labels each room, writes alt text for screen readers and spots dark, blurry or private details. Optional.' : CONSENT_HINT}</span>
        </div>
        {action.busy && <AiThinking label={progress || 'Checking your photos'} />}
        <AiErrorNote error={action.error} onRetry={consent ? () => void action.run(photos, checks, consent) : undefined} />
      </> : <AiUnavailable reason={ai.available && !ai.photos ? 'disabled' : ai.reason} signedOut={ai.photos && !ai.signedIn} onSignIn={onSignIn} feature="The AI photo check" noFallback />}
      {checks.size > 0 && (
        <AiCard title="Photo check" headingLevel={4} focusKey={action.data} footer={<AiDisclaimer>Room labels and alt text are suggestions. Alt text is saved with your photos when you submit.</AiDisclaimer>}>
          {advice && inOrder.length > 1 && (
            <div className="ail-row">
              {/* aria-disabled once applied (not disabled), so keyboard focus stays on the button. */}
              <button type="button" className="btn ghost sm" aria-disabled={alreadyOrdered || undefined} onClick={() => { if (!alreadyOrdered) onOrder([...inOrder, ...photos.filter((p) => !inOrder.includes(p))]); }}>{alreadyOrdered ? 'Photos are in the suggested order' : 'Apply suggested order'}</button>
              <span className="xs muted">Lead photo: the best exterior or living space.</span>
            </div>
          )}
          {advice && advice.tips.length > 0 && <div><h5 className="ail-sub">Tips</h5><ul className="ail-list">{advice.tips.map((t) => <li key={t}>{t}{/virtually staged/.test(t) && staged ? ' (You’ve ticked the box.)' : ''}</li>)}</ul></div>}
          <ol className="ail-photo-list">
            {photos.map((p, i) => {
              const a = checks.get(p);
              const problem = a ? altTextProblem(a.alt) : null;
              return (
                <li key={p} className="ail-photo-row">
                  <img src={p} alt="" />
                  <div className="ail-photo-body">
                    {a ? <>
                      <div className="ail-photo-head"><b>Photo {i + 1}{i === 0 ? ' (lead)' : ''}: {roomLabel(a.room)}</b><span className="ail-score">Quality {a.quality.score}/10</span>
                        {a.quality.issues.map((x) => <span key={x} className="ai-chip">{ISSUE_LABEL[x]}</span>)}
                        {a.flags.map((x) => <span key={x} className="ail-flag">{FLAG_LABEL[x]}</span>)}</div>
                      {a.features.length > 0 && <span className="xs muted">Seen: {a.features.join(', ')}</span>}
                      <label className="field">Alt text for photo {i + 1}<input className="input" maxLength={160} value={a.alt} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `alt-err-${i}` : undefined} onChange={(e) => setAlt(p, e.target.value)} /></label>
                      {problem && <p className="lp-error" id={`alt-err-${i}`}>{problem}</p>}
                    </> : <span className="xs muted">Photo {i + 1}: not checked yet.</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </AiCard>
      )}
    </div>
  );
}

/* ───────────────────────── AI: photo check for photos already on the listing (editing) ───────────────────────── */
function ExistingPhotoCheck({ editRef, existing, setExisting, consent }: { editRef: string; existing: PhotoDTO[]; setExisting: (p: PhotoDTO[]) => void; consent: boolean }) {
  const ai = useAi();
  const aiOk = ai.photos && ai.signedIn;
  const [data, setData] = useState<ListingPhotosResult | null>(null);
  const [note, setNote] = useState('');
  const [alts, setAlts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, 'saving' | 'saved' | 'error' | undefined>>({});
  const [orderNote, setOrderNote] = useState('');
  const [progress, setProgress] = useState('');
  // Consent is passed in (useAiAction keeps the first version of this function); without it nothing is sent for checking.
  // With AI off, the stored results are still shown (reading them makes no AI call).
  const load = useAiAction(async (recheck: boolean, consented: boolean, canCheck: boolean) => {
    setProgress('Loading the photo check');
    let r = await listingPhotos(editRef);
    let msg = '';
    const running = r.job?.status === 'queued' || r.job?.status === 'running';
    if (canCheck && consented && (recheck || (r.pending && !running))) {
      setProgress('Checking your photos');
      try {
        const started = await checkListingPhotos(editRef, recheck);
        if (started.job) msg = jobNote(started.job.status === 'done' ? started.job.output : await pollJob<PhotoJobOutput>(started.job.id, { onProgress: (j) => j.progress && setProgress(j.progress) }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 429) throw e;
        msg = e.message; // today's limit: show what has been checked so far
      }
      r = await listingPhotos(editRef);
    } else if (canCheck && r.pending && r.job && running) {
      msg = jobNote(await pollJob<PhotoJobOutput>(r.job.id, { onProgress: (j) => j.progress && setProgress(j.progress) }));
      r = await listingPhotos(editRef);
    }
    setData(r); setNote(msg); setAlts(Object.fromEntries(r.photos.map((p) => [p.id, p.alt || p.analysis?.alt || ''])));
    return r;
  }, { label: 'Photo check', announce: true });
  if (!ai.signedIn || !existing.length) return null;
  const byId = new Map(data?.photos.map((p) => [p.id, p]) ?? []);
  const order = data?.suggestedOrder.filter((id) => existing.some((e) => e.id === id)) ?? [];
  const ordered = order.length < 2 || order.every((id, i) => existing[i]?.id === id);
  const saveAlt = async (id: string) => {
    if (saved[id] === 'saving') return;
    // Retrying can't fix wording the rules refuse: leave the inline message as the only feedback and take the person to the field.
    if (altTextProblem(alts[id] ?? '')) { setSaved((s) => ({ ...s, [id]: undefined })); document.getElementById(`ex-alt-${id}`)?.focus(); return; }
    setSaved((s) => ({ ...s, [id]: 'saving' }));
    try { await setPhotoAlt(editRef, id, alts[id] ?? ''); setSaved((s) => ({ ...s, [id]: 'saved' })); setExisting(existing.map((e) => (e.id === id ? { ...e, alt: alts[id] ?? '' } : e))); } catch { setSaved((s) => ({ ...s, [id]: 'error' })); }
  };
  const applyOrder = async () => {
    const ids = [...order, ...existing.map((e) => e.id).filter((id) => !order.includes(id))];
    setOrderNote('Saving the new order…');
    try {
      await setPhotoOrder(editRef, ids);
      setExisting(ids.map((id) => existing.find((e) => e.id === id)!).filter(Boolean));
      setOrderNote('Photos reordered. The new order is live now.');
    } catch { setOrderNote('Couldn’t save the new order, so your photos are still in their old order. Please try again.'); }
  };
  return (
    <div className="ail-assist">
      {aiOk ? (
        <div className="ail-row">
          <AiButton busy={load.busy} disabled={!consent} onClick={() => void load.run(false, consent, true)}>{data ? 'Refresh photo check' : 'Check these photos with AI'}</AiButton>
          {/* Stays on the page while the check runs (aria-disabled), so keyboard focus isn't lost. */}
          {data && <button type="button" className="btn ghost sm" disabled={!consent} aria-disabled={load.busy || undefined} onClick={() => { if (!load.busy) void load.run(true, consent, true); }}>Check them all again</button>}
          {!consent && <span className="xs muted">{CONSENT_HINT}</span>}
        </div>
      ) : <>
        <AiUnavailable reason={ai.reason} feature="The AI photo check" noFallback />
        {/* Replaced by the results: focus then moves to their heading (see AiCard focusKey). */}
        {!data && <div className="ail-row"><button type="button" className="btn ghost sm" aria-disabled={load.busy || undefined}
          onClick={(e) => { if (!load.busy) runAsAiClick(e.currentTarget, () => void load.run(false, false, false)); }}>{load.busy ? 'Loading…' : 'Show the last photo check'}</button></div>}
      </>}
      {load.busy && <AiThinking label={progress || 'Checking your photos'} />}
      <AiErrorNote error={load.error} onRetry={consent ? () => void load.run(false, consent, aiOk) : undefined} />
      {data && !load.busy && (
        <AiCard title="Photo check" headingLevel={4} focusKey={data} footer={<AiDisclaimer>Room labels and alt text are suggestions. Alt text is saved with each Save button; reordering and removing photos apply straight away.</AiDisclaimer>}>
          {note && <p className="ail-note" role="status">{note}</p>}
          {order.length > 1 && <div className="ail-row"><button type="button" className="btn ghost sm" aria-disabled={ordered || undefined} onClick={() => { if (!ordered) void applyOrder(); }}>{ordered ? 'Photos are in the suggested order' : 'Apply suggested order'}</button>
            <span className="xs muted" role="status">{orderNote}</span></div>}
          {data.tips.length > 0 && <div><h5 className="ail-sub">Tips</h5><ul className="ail-list">{data.tips.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          <ol className="ail-photo-list">
            {existing.map((e, i) => {
              const a = byId.get(e.id)?.analysis;
              const problem = altTextProblem(alts[e.id] ?? '');
              return (
                <li key={e.id} className="ail-photo-row">
                  <img src={mediaUrl(e.url)} alt="" />
                  <div className="ail-photo-body">
                    <div className="ail-photo-head"><b>Photo {i + 1}{a ? `: ${roomLabel(a.room)}` : ''}</b>{a && <span className="ail-score">Quality {a.quality.score}/10</span>}
                      {a?.quality.issues.map((x) => <span key={x} className="ai-chip">{ISSUE_LABEL[x]}</span>)}
                      {a?.flags.map((x) => <span key={x} className="ail-flag">{FLAG_LABEL[x]}</span>)}
                      {!a && <span className="xs muted">{byId.get(e.id)?.checked ? 'Couldn’t be checked' : 'Not checked yet'}</span>}</div>
                    <div className="ail-row">
                      <label className="field" style={{ flex: 1, minWidth: 180 }}>Alt text for photo {i + 1}<input id={`ex-alt-${e.id}`} className="input" maxLength={160} value={alts[e.id] ?? ''} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `ex-alt-err-${i}` : undefined} onChange={(ev) => { setAlts((s) => ({ ...s, [e.id]: ev.target.value })); setSaved((s) => ({ ...s, [e.id]: undefined })); }} /></label>
                      <button type="button" className="btn ghost sm" aria-disabled={saved[e.id] === 'saving' || undefined} onClick={() => void saveAlt(e.id)} aria-label={`Save alt text for photo ${i + 1}`}>Save</button>
                      {saved[e.id] && <span className="xs muted" role="status">{saved[e.id] === 'saved' ? 'Saved' : saved[e.id] === 'saving' ? 'Saving…' : 'Couldn’t save. Try again.'}</span>}
                    </div>
                    {problem && <p className="lp-error" id={`ex-alt-err-${i}`}>{problem}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </AiCard>
      )}
    </div>
  );
}

/* ───────────────────────── AI: price explanation ───────────────────────── */
const NO_PRICE_EVIDENCE = 'There isn’t enough evidence to explain a price guide here yet.';
function PriceExplain({ f, localRange, onSignIn }: { f: ListingInput; localRange: { low: number; high: number } | null; onSignIn?: () => void }) {
  const ai = useAi();
  const aiOk = ai.available && ai.signedIn;
  const body = { postcode: f.postcode, type: f.type, beds: f.beds, floorArea: f.floorArea, condition: f.condition ?? 'fair', channel: f.listing, askingPrice: f.price > 0 ? f.price : null };
  const key = keyOf(body);
  const [result, setResult] = useState<{ key: string; r: PriceGuideResult } | null>(null);
  const action = useAiAction(async (b: typeof body, k: string) => { const r = await priceGuide(b); setResult({ key: k, r }); return r; },
    { label: 'Price guide explanation', announce: true, done: (r) => (r.narrative ? 'Price guide explanation ready.' : r.note ?? NO_PRICE_EVIDENCE) });
  if (!localRange || f.floorArea < 10) return null;
  if (!aiOk) return <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} onSignIn={onSignIn} feature="The AI price explanation" fallback="The Streetkey price check above still applies." />;
  const stale = result && result.key !== key;
  const r = result?.r;
  const unit = f.listing === 'rent' ? ' pcm' : '';
  const money = (n: number) => (f.listing === 'rent' ? gbp(n) : gbpK(n));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="ail-row">
        <AiButton kind="ghost" busy={action.busy} onClick={() => void action.run(body, key)}>{r && !stale ? 'Explain again' : 'Explain this price guide'}</AiButton>
        {stale && <span className="ail-stale">Your details have changed since the last explanation.</span>}
      </div>
      {action.busy && <AiThinking label="Explaining the price guide" />}
      <AiErrorNote error={action.error} onRetry={() => void action.run(body, key)} />
      {r && !stale && !action.busy && (r.narrative ? (
        <AiCard title="What the price guide means" headingLevel={4} focusKey={r} footer={<AiDisclaimer>{r.label ?? 'Indicative only, not a valuation.'}</AiDisclaimer>}>
          <p className="small" style={{ margin: 0 }}>{r.narrative.explanation}</p>
          {r.narrative.position && <p className="small" style={{ margin: 0 }}>{r.narrative.position}</p>}
          {r.narrative.advice.length > 0 && <div><h5 className="ail-sub">Positioning ideas</h5><ul className="ail-list">{r.narrative.advice.map((a) => <li key={a}>{a}</li>)}</ul></div>}
          {r.low != null && r.high != null && r.basis && <p className="xs muted" style={{ margin: 0 }}>Range used: <span className="num">{money(r.low)}–{money(r.high)}{unit}</span>. {r.basis.method}</p>}
        </AiCard>
      ) : <p className="ail-note">{r.note ?? NO_PRICE_EVIDENCE}</p>)}
    </div>
  );
}

/** What the pre-submission check added to the review list (shown, and read out when it arrives). */
function precheckSummary(r: PrecheckResult): string {
  const extra = r.issues.filter((i) => i.source !== 'checks');
  const nAi = extra.filter((i) => i.source === 'ai').length;
  const nWording = extra.length - nAi;
  const found = extra.length
    ? `${extra.length} more point${extra.length === 1 ? '' : 's'} added to the list above (${[nAi ? `AI review: ${nAi}` : '', nWording ? `wording checks: ${nWording}` : ''].filter(Boolean).join(', ')}).`
    : 'The AI review and wording checks found nothing more to fix.';
  return `${found}${r.aiNote ? ` ${r.aiNote}` : ''}`;
}

/* ───────────────────────── page ───────────────────────── */
/** A new form whenever the listing being edited changes (e.g. from editing a listing to "List a property"), so nothing carries over. */
export default function ListProperty() {
  const [params] = useSearchParams();
  return <ListPropertyForm key={params.get('edit') ?? ''} />;
}

const BLANK: ListingInput = {
  listing: 'sale', addressLine: '', town: '', postcode: '', type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 90,
  era: '1919-1944', condition: 'fair', price: 0, epc: '', councilTax: '', features: [], photos: [], description: '',
  source: { kind: 'owner', name: 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false },
};
/**
 * What is kept in this tab while the person signs in (new listings only; edits are saved on the server).
 * Cleared when the listing is sent, on "Start again", and on sign-out (src/lib/ai/listing.ts).
 */
interface Draft {
  f: ListingInput; step: number; seen: number; who: 'owner' | 'landlord' | 'agent'; staged: boolean; createdRef: string | null; photoCount: number;
  declared?: { owner: boolean; accurate: boolean };
}
const DRAFT_KEY = LISTING_DRAFT_KEY;

type EditState = 'none' | 'signin' | 'loading' | 'ready' | 'missing' | 'forbidden' | 'error' | 'offline';

function ListPropertyForm() {
  const { publishListing, myListings } = useStore();
  const { online, status: serverStatus, user, refreshListings } = useServer();
  const ai = useAi();
  const [params] = useSearchParams();
  const location = useLocation();
  const editParam = params.get('edit');
  const editRef = online ? editParam : null;
  // A new listing's unsent form, kept while the person signed in (restored once, on arrival).
  const [restored] = useState(() => {
    if (editParam) return null;
    const d = loadDraft<Draft>(DRAFT_KEY);
    if (!d) return null;
    const photos = loadDraftPhotos(DRAFT_KEY);
    return { ...d.data, f: { ...d.data.f, photos }, dropped: Math.max(0, (d.data.photoCount ?? 0) - photos.length) };
  });
  const [existing, setExisting] = useState<PhotoDTO[]>([]);
  const [serverDone, setServerDone] = useState<{ ref: string; status: string; note?: string; edited: boolean; held: boolean } | null>(null);
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const [step, setStep] = useState(restored?.step ?? 0);
  const [seen, setSeen] = useState(restored?.seen ?? 0);
  const [who, setWho] = useState<'owner' | 'landlord' | 'agent'>(restored?.who ?? 'owner');
  const [staged, setStaged] = useState(restored?.staged ?? false);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [photoError, setPhotoError] = useState<{ title: string; items: string[] } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [lookup, setLookup] = useState<string>('');
  const [declared, setDeclared] = useState({ owner: !!restored?.declared?.owner, accurate: !!restored?.declared?.accurate });
  const [done, setDone] = useState<Property | null>(null);
  const [photoChecks, setPhotoChecks] = useState<Checks>(() => new Map());
  const [photoAdvice, setPhotoAdvice] = useState<{ order: string[]; tips: string[] } | null>(null);
  const [pre, setPre] = useState<{ key: string; r: PrecheckResult } | null>(null);
  // The draft created on the first Submit, so a retry after a failed photo upload updates it instead of creating another.
  const [createdRef, setCreatedRef] = useState<string | null>(restored?.createdRef ?? null);
  const [edit, setEdit] = useState<EditState>(editParam ? 'loading' : 'none');
  const [editStatus, setEditStatus] = useState<ListingStatus | null>(null);
  const [reload, setReload] = useState(0);
  const [restoreNote, setRestoreNote] = useState(() => (!restored ? '' : restored.dropped
    ? `We kept the details you entered earlier, but ${restored.dropped === 1 ? 'one photo was' : `${restored.dropped} photos were`} too large to keep. Please add ${restored.dropped === 1 ? 'it' : 'them'} again.`
    : 'We kept the details you entered earlier.'));
  // Consent to photos being sent to the AI provider (stored on the server, so it also covers background checks of uploads).
  const [photoConsent, setPhotoConsent] = useState(false);
  const [consentNote, setConsentNote] = useState('');
  const aiPhotos = online && ai.available && ai.signedIn;
  const activeRef = editRef ?? createdRef;
  const photosHeading = useRef<HTMLHeadingElement>(null);
  const stepBar = useRef<HTMLDivElement>(null);
  const stepCard = useRef<HTMLElement>(null);
  /** Focus on the current step's heading (when the control that was pressed goes away, so focus never drops to the page body). */
  const focusStepHeading = () => focusSoon(() => stepCard.current?.querySelector<HTMLElement>('h3'));
  /** Photos that are too large to keep in this tab while the person signs in elsewhere. */
  const [photosKept, setPhotosKept] = useState(true);
  useEffect(() => {
    if (!aiPhotos) return;
    let live = true;
    getPhotoConsent().then((r) => { if (live) setPhotoConsent(r.consented); }).catch(() => { /* unknown: stays unticked, so nothing is sent */ });
    return () => { live = false; };
  }, [aiPhotos, user?.id]);
  const changePhotoConsent = async (v: boolean) => {
    setPhotoConsent(v); setConsentNote('');
    try {
      await savePhotoConsent(v);
      if (!v) setConsentNote('AI photo checks are off. Your photos won’t be sent to our AI provider.');
    } catch {
      setPhotoConsent(!v); setConsentNote('Couldn’t save that choice. Please try again.');
    }
  };
  const [f, setF] = useState<ListingInput>(() => (restored ? { ...BLANK, ...restored.f, source: BLANK.source } : BLANK));
  const set = <K extends keyof ListingInput>(k: K, v: ListingInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const goStep = (n: number) => { setStep(n); setSeen((s) => Math.max(s, n)); };

  // Keep a new listing's form in this tab, so signing in (which opens the account page) doesn't lose it.
  // (Saved straight away, not debounced, so the last keystrokes before following a sign-in link are kept; it's small without the photos.)
  useEffect(() => {
    if (editParam || done || serverDone) return;
    // An untouched form isn't kept (coming back to it shouldn't say "We kept the details you entered").
    const untouched = keyOf({ ...f, photos: [] }) === keyOf(BLANK) && !f.photos?.length && step === 0 && seen === 0 && who === 'owner'
      && !staged && !createdRef && !declared.owner && !declared.accurate;
    if (untouched) clearDraft(DRAFT_KEY);
    else saveDraft<Draft>(DRAFT_KEY, { f: { ...f, photos: [] }, step, seen, who, staged, createdRef, photoCount: f.photos?.length ?? 0, declared });
  }, [editParam, f, step, seen, who, staged, createdRef, declared, done, serverDone]);
  useEffect(() => {
    if (editParam || done || serverDone) return;
    setPhotosKept(saveDraftPhotos(DRAFT_KEY, f.photos ?? []));
  }, [editParam, f.photos, done, serverDone]);
  const startAgain = () => {
    clearDraft(DRAFT_KEY);
    setF(BLANK); setStep(0); setSeen(0); setWho('owner'); setStaged(false); setCreatedRef(null); setDeclared({ owner: false, accurate: false });
    setPhotoChecks(new Map()); setPhotoAdvice(null); setPre(null); setServerError(null); setPhotoError(null); setRestoreNote('');
  };
  // Signed out (or a different account now uses this tab): a new listing's unsent form belongs to the last person, so it is cleared.
  useEffect(() => {
    if (editParam) return;
    const forget = () => startAgain();
    window.addEventListener(ACCOUNT_CHANGED_EVENT, forget);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, forget);
  }, [editParam]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * Signed out, the AI areas offer to sign in. Usually that's the account page, which brings the person back here with the
   * form kept in this tab. When the photos are too large to keep, the Review step's sign-in form is used instead, so nothing is lost.
   */
  const signInHere = !photosKept && online && !user
    ? () => { goStep(STEPS.length - 1); focusSoon(() => stepCard.current?.querySelector<HTMLElement>('.auth-card h2')); }
    : undefined;

  // Editing a listing on the live site: load it into the form (only a listing this person may edit).
  useEffect(() => {
    if (!editParam) return;
    if (serverStatus === 'checking') { setEdit('loading'); return; }
    if (!online) { setEdit('offline'); return; }
    if (!user) { setEdit('signin'); return; }
    let live = true;
    setEdit('loading');
    api.listings.get(editParam).then(({ listing: d }) => {
      if (!live) return;
      if (!d.mine && user.role !== 'admin') { setEdit('forbidden'); return; }
      setF((x) => ({ ...x, listing: d.channel, title: d.title ?? '', addressLine: d.addressLine, town: d.town, postcode: d.postcode, type: d.type as PropertyType, tenure: d.tenure,
        leaseYears: d.leaseYears ?? undefined, beds: d.beds, baths: d.baths, floorArea: d.floorArea, era: (d.era ?? x.era) as Era, condition: (d.condition ?? x.condition) as Condition,
        price: d.price, epc: d.epc ?? '', councilTax: d.councilTax ?? '', serviceChargeAnnual: d.serviceChargeAnnual ?? undefined, groundRentAnnual: d.groundRentAnnual ?? undefined,
        features: d.features.filter((t) => t !== STAGED), description: d.description ?? '', photos: [] }));
      setStaged(d.features.includes(STAGED));
      setExisting(d.photos);
      setEditStatus(d.status);
      // Already confirmed when the owner first submitted it (someone else, e.g. an admin, confirms for themselves).
      if (d.mine) setDeclared({ owner: true, accurate: true });
      setSeen(STEPS.length - 1);
      if (d.source.kind === 'landlord') setWho('landlord');
      setEdit('ready');
    }).catch((e: unknown) => {
      if (!live) return;
      const err = e instanceof ApiError ? e : new ApiError(0, 'Couldn’t load that listing.');
      setEdit(err.status === 404 ? 'missing' : err.status === 403 ? 'forbidden' : 'error');
      setServerError(err);
    });
    return () => { live = false; };
  }, [editParam, online, serverStatus, user, reload]);

  // Keep the current step visible in the (scrollable) step bar.
  useEffect(() => {
    const el = stepBar.current?.querySelector<HTMLElement>('[aria-current="step"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [step]);

  const ev = useMemo(() => (POSTCODE_RE.test(f.postcode) ? areaEvidence(f.postcode) : null), [f.postcode]);
  const rentLets = useMemo(() => (ev && f.listing === 'rent' ? rentalComparables(f.postcode) : 0), [ev, f.listing, f.postcode]);
  const condAdj = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 }[f.condition ?? 'fair'];
  const range = ev ? (f.listing === 'rent'
    ? { low: Math.round((ev.rentPerM2 * f.floorArea * 0.92) / 25) * 25, high: Math.round((ev.rentPerM2 * f.floorArea * 1.08) / 25) * 25 }
    : { low: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 0.92) / 1000) * 1000, high: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 1.08) / 1000) * 1000 }) : null;
  // On the live site a sale is checked against real sold prices nearby (HM Land Registry); the demo evidence above is the fallback.
  const soldNear = useSoldNear(normalisePostcode(f.postcode), online && step === 4 && f.listing === 'sale' && POSTCODE_RE.test(f.postcode));
  const realRange = useRealRange(soldNear, f.type, f.price);
  // The same checks the server applies (on the live site a photo is required, as it is there).
  const addressProblem = placeFieldProblem(f.addressLine, 'addressLine');
  const townProblem = placeFieldProblem(f.town, 'town');
  const checks: Check[] = [
    ...complianceChecks({ ...f, description: f.description, photos: [...existing.map((p) => p.url), ...(f.photos ?? [])] }, { minPhotos: online ? 1 : 0 }),
    ...(addressProblem ? [{ id: 'address', ok: false, severity: 'block' as const, message: addressProblem }] : []),
    ...(townProblem ? [{ id: 'town', ok: false, severity: 'block' as const, message: townProblem }] : []),
  ];
  const blocking = checks.filter((c) => !c.ok && c.severity === 'block');
  const canPublish = blocking.length === 0 && declared.owner && declared.accurate;
  const preview = useMemo(() => buildListing({ ...f, id: 'preview' }), [f]);
  const photoInsights = useMemo(() => photoInsightsFrom((f.photos ?? []).map((p) => photoChecks.get(p))), [f.photos, photoChecks]);
  const customFeatures = f.features.filter((x) => !FEATURES.includes(x));
  const stepState = (i: number): 'todo' | 'done' | 'warn' => {
    if (i > seen || i === step) return 'todo';
    const ids = STEP_CHECKS[i] ?? [];
    return checks.some((c) => !c.ok && c.severity === 'block' && ids.includes(c.id)) ? 'warn' : 'done';
  };
  const failing = (i: number) => checks.filter((c) => !c.ok && (STEP_CHECKS[i] ?? []).includes(c.id));
  // Shown once, next to the first photo check on the page.
  const consentBox = <PhotoConsent value={photoConsent} onChange={(v) => void changePhotoConsent(v)} note={consentNote} />;
  const liveEdit = !!editRef && (editStatus === 'live' || editStatus === 'under_offer');

  // AI pre-check: what will be published, so the review matches the listing.
  const preFacts = factsFrom(f, { fullPostcode: true, staged });
  const preDescription = f.description || draftDescription(f);
  const preCount = existing.length + (f.photos?.length ?? 0);
  const preKey = keyOf([preFacts, preDescription, preCount]);
  const precheck = useAiAction(async (facts: typeof preFacts, d: string, n: number, k: string) => { const r = await precheckListing(facts, d, n); setPre({ key: k, r }); return r; },
    { label: 'Listing check', announce: true, done: precheckSummary });
  const preFresh = pre && pre.key === preKey ? pre.r : null;
  const preExtra = preFresh?.issues.filter((i) => i.source !== 'checks') ?? [];
  // Wording that could discriminate or steer people was found: the discrimination rule isn't shown as done.
  const steering = preExtra.some((i) => i.reason === 'discrimination' || i.reason === 'steering');

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

  /** Photo list changes keep the AI results for photos that are still there. */
  const setPhotos = (photos: string[]) => {
    set('photos', photos);
    setPhotoChecks((prev) => { if (!prev.size) return prev; const n: Checks = new Map(); for (const p of photos) { const a = prev.get(p); if (a) n.set(p, a); } return n; });
  };

  const addPhotoFiles = async (input: HTMLInputElement) => {
    const chosen = [...(input.files ?? [])];
    input.value = ''; // the same file can be chosen again
    if (!chosen.length) return;
    const limit = online ? PHOTO_LIMIT.online : PHOTO_LIMIT.offline;
    const room = Math.max(0, limit - (f.photos?.length ?? 0) - existing.length);
    const files = chosen.slice(0, room);
    const over = chosen.length - files.length;
    setProcessing(true); setPhotoError(null);
    try {
      const results = await Promise.allSettled(files.map((x) => (online ? compress(x, 1600, 0.8) : compress(x))));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const bad = results.flatMap((r, i) => (r.status === 'rejected' ? [files[i].name] : []));
      if (ok.length) setF((x) => { const photos = [...(x.photos ?? []), ...ok.filter((p) => !(x.photos ?? []).includes(p))]; return { ...x, photos }; });
      const items = [
        ...bad.map((n) => `${n} couldn’t be read. Use a JPEG, PNG or WebP photo.`),
        ...(over ? [`${over === 1 ? '1 photo was' : `${over} photos were`} left out: a listing can have up to ${limit} photos.`] : []),
      ];
      if (items.length) setPhotoError({ title: ok.length ? `Added ${ok.length} photo${ok.length === 1 ? '' : 's'}, but not all of them.` : 'No photos were added.', items });
    } finally { setProcessing(false); }
  };

  /** Focus back on a photo's Remove button once the confirmation row has gone (never the page body). */
  const focusRemove = (i: number) => requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[aria-label="Remove photo ${i + 1}"]`) ?? photosHeading.current)?.focus());
  const removeExisting = async (p: PhotoDTO, i: number) => {
    if (!activeRef) return;
    setPhotoError(null);
    try {
      await api.listings.deletePhoto(activeRef, p.id);
      setExisting((x) => x.filter((y) => y.id !== p.id));
      setRemoving(null);
      // Focus stays in the photos section (the button that was pressed has gone).
      requestAnimationFrame(() => photosHeading.current?.focus());
    } catch (e) {
      setRemoving(null);
      setPhotoError({ title: `Photo ${i + 1} wasn’t removed.`, items: [e instanceof ApiError ? (Object.values(e.fields)[0] ?? e.message) : 'Please try again.'] });
      focusRemove(i);
    }
  };

  /** Uploads the photos still in the browser, a few per request; stored ones move to the listing's photos (so a retry only sends the rest). */
  const uploadPending = async (ref: string) => {
    const photos = f.photos ?? [];
    if (!photos.length) return { left: 0, notes: [] as string[] };
    const batches = sizeBatches(photos.map(dataUrlBytes));
    const stored: PhotoDTO[] = [];
    const gone = new Set<string>();
    const notes: string[] = [];
    let sent = 0;
    try {
      for (const b of batches) {
        setUploadProgress(photos.length > 1 ? `Uploading photos ${sent + 1}–${sent + b.length} of ${photos.length}…` : 'Uploading your photo…');
        const meta = b.map((i) => { const c = photoChecks.get(photos[i]); return c ? { token: c.token ?? null, alt: altTextProblem(c.alt) ? null : c.alt.trim() || null } : null; });
        // Named by their place in the whole list, so any message about a photo names the right one.
        const files = b.map((i) => new File([dataUrlToBlob(photos[i])], `photo-${existing.length + i + 1}.jpg`, { type: 'image/jpeg' }));
        const up = await api.listings.uploadPhotos(ref, files, meta);
        const keptIdx = new Set<number>();
        up.added.forEach((a, k) => { const at = b[a.index ?? k]; keptIdx.add(at); stored.push({ id: a.id, url: a.url, alt: a.alt ?? null }); gone.add(photos[at]); });
        notes.push(...(up.notes ?? []));
        if (up.error && up.error.code !== 'no_photos') notes.push(up.error.message);
        // Photos the server refused for what they are (not a limit that stopped the upload) won't work on a retry either.
        else for (const i of b) if (!keptIdx.has(i)) { gone.add(photos[i]); }
        notes.push(...up.rejected);
        sent += b.length;
      }
    } finally {
      if (stored.length) setExisting((x) => [...x, ...stored]);
      if (gone.size) setPhotos(photos.filter((p) => !gone.has(p)));
      setUploadProgress('');
    }
    return { left: photos.filter((p) => !gone.has(p)).length, notes };
  };

  const publishToServer = async () => {
    setBusy(true); setServerError(null);
    try {
      const features = staged ? [...f.features, STAGED] : f.features;
      const body = {
        channel: f.listing, title: f.title || null, addressLine: f.addressLine, town: f.town, postcode: f.postcode, type: f.type, tenure: f.tenure,
        leaseYears: f.tenure === 'leasehold' ? f.leaseYears ?? null : null, beds: f.beds, baths: f.baths, floorArea: f.floorArea, era: f.era ?? null, condition: f.condition ?? null,
        price: f.price, epc: f.epc || null, councilTax: f.councilTax || null, serviceChargeAnnual: f.serviceChargeAnnual ?? null, groundRentAnnual: f.groundRentAnnual ?? null,
        features, description: f.description || draftDescription(f), ownershipDeclared: declared.owner,
      };
      let ref = activeRef;
      let status: string;
      let held = false;
      if (ref) { const r = await api.listings.update(ref, body); status = r.listing.status; held = !!r.held; }
      else { const r = await api.listings.create(body); ref = r.listing.ref; status = r.listing.status; setCreatedRef(ref); }
      const up = await uploadPending(ref);
      if (up.left) {
        throw new ApiError(0, `${up.left === 1 ? '1 photo wasn’t' : `${up.left} photos weren’t`} uploaded. Your listing is saved: press the button again to send the rest.`, 'upload_incomplete', Object.fromEntries(up.notes.map((n, i) => [`note${i}`, n])));
      }
      if (['draft', 'rejected', 'withdrawn'].includes(status)) status = (await api.listings.submit(ref)).status;
      await refreshListings();
      clearDraft(DRAFT_KEY);
      setServerDone({ ref, status, note: up.notes.join(' ') || undefined, edited: !!editRef, held: held || (liveEdit && status === 'pending') });
    } catch (e) { setServerError(e instanceof ApiError ? e : new ApiError(0, 'Something went wrong.')); } finally { setBusy(false); }
  };

  const publish = () => {
    if (online) { void publishToServer(); return; }
    const p = buildListing({ ...f, description: f.description || draftDescription(f), features: staged ? [...f.features, STAGED] : f.features,
      source: { kind: who === 'landlord' ? 'landlord' : 'owner', name: who === 'landlord' ? 'Private landlord' : 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false } });
    publishListing(p); setDone(p); clearDraft(DRAFT_KEY);
  };

  // When the form is replaced by a message (sent, saved in the preview, or the agents' page), focus moves to that message.
  const outcome = serverDone ? `sent:${serverDone.ref}` : done ? `saved:${done.id}` : who === 'agent' ? 'agent' : '';
  useEffect(() => { if (outcome) focusSoon(() => document.querySelector<HTMLElement>('[data-outcome]')); }, [outcome]);

  if (editParam && edit !== 'ready' && edit !== 'none') {
    const msg: Record<Exclude<EditState, 'ready' | 'none'>, { title: string; text: string }> = {
      loading: { title: 'Loading your listing…', text: '' },
      signin: { title: 'Sign in to edit your listing', text: 'Listings can only be changed by the person or agency who listed them.' },
      missing: { title: 'Listing not found', text: 'We couldn’t find that listing. It may have been deleted, or the link may be wrong.' },
      forbidden: { title: 'You can’t edit this listing', text: 'Only the person or agency who listed it can make changes. If it’s yours, sign in with the account you listed it from.' },
      error: { title: 'Couldn’t load your listing', text: serverError?.message ?? 'Please try again.' },
      offline: { title: 'Editing works on the live site', text: 'This preview has no server, so listings can’t be edited here.' },
    };
    const m = msg[edit];
    return (
      <div className="stack lp-page-msg" style={{ gap: 14 }}>
        <h2 tabIndex={-1}>{m.title}</h2>
        {edit === 'loading' ? <p className="small muted" role="status">Loading…</p> : <p className="muted" role={edit === 'error' ? 'alert' : undefined}>{m.text}</p>}
        <div className="row">
          {edit === 'signin' && <Link className="btn" to={signInPath(`${location.pathname}${location.search}`)}>Sign in</Link>}
          {/* This button goes while the listing loads again: focus waits on the heading. */}
          {edit === 'error' && <button type="button" className="btn" onClick={(e) => { e.currentTarget.closest('.lp-page-msg')?.querySelector<HTMLElement>('h2')?.focus(); setServerError(null); setReload((n) => n + 1); }}>Try again</button>}
          {edit !== 'loading' && <Link className="btn ghost" to={online ? '/account/listings' : '/saved'}>My listings</Link>}
          {edit !== 'loading' && <Link className="btn ghost" to="/list">List a property</Link>}
        </div>
      </div>
    );
  }

  if (who === 'agent') return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      {/* The option that was chosen has gone: focus moves to this heading, not the page body. */}
      <h2 tabIndex={-1} data-outcome>Agents: connect your CRM instead</h2>
      <p className="muted">You don’t need to retype listings. Add Streetkey as a portal destination in your CRM (BLM or API feed) and every listing, price change and status update flows in automatically.</p>
      <div className="row"><Link to={online ? '/account/agency' : '/sources'} className="btn">Connect a listing feed</Link><button className="btn ghost" onClick={() => { setWho('owner'); focusSoon(() => document.querySelector<HTMLElement>('[aria-labelledby="lp-who"] [aria-checked="true"]')); }}>I’m a private seller or landlord</button></div>
    </div>
  );

  if (serverDone) return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      {serverDone.held
        ? <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Your changes are saved.</b> Some of them need a quick check by our team, so the listing is hidden from search until then. We’ll email you when it’s back.</div>
        : serverDone.status === 'live' || serverDone.status === 'under_offer'
          ? (serverDone.edited
            ? <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Your changes are saved and live.</b> Edits to live listings are checked again automatically: if anything needs a closer look, we’ll pause the listing and email you.</div>
            : <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Your listing is live on Streetkey.</b> It now appears in search with a full intelligence profile.</div>)
          : serverDone.edited && serverDone.status === 'pending'
            ? <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Your changes are saved.</b> Your listing is still waiting for our review, and we’ll email you as soon as it’s published.</div>
            : <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Thanks, your listing has been sent for review.</b> We check every private listing before it goes live, usually within a working day, and we’ll email you as soon as it’s published.</div>}
      {serverDone.note && <p className="small muted">{serverDone.note}</p>}
      <div className="row">
        {(serverDone.status === 'live' || serverDone.status === 'under_offer') && <Link to={`/property/${serverDone.ref}`} className="btn">View my listing</Link>}
        <Link to="/account/listings" className="btn ghost">Manage my listings</Link>
        <Link to="/account/inbox" className="btn ghost">Inbox</Link>
      </div>
    </div>
  );

  if (done) return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      <div className="callout ok" role="status" tabIndex={-1} data-outcome><b>Saved in this preview.</b> Only you can see it, in this browser. On the live Streetkey site your listing would be checked and then appear in search.</div>
      <div className="card stack">
        <b>{done.title}</b><span className="small muted">{done.street}, {done.town} · {done.postcode}</span>
        <span className="num" style={{ fontSize: 22 }}>{done.listing === 'rent' ? `${gbp(done.price)} pcm` : gbp(done.price)}</span>
        <div className="row"><Tag kind="neutral">Verification pending</Tag><span className="xs muted">“Verified owner” badges, based on an identity check and an HM Land Registry title match, are coming soon.</span></div>
      </div>
      <div className="row">
        <Link to={`/property/${done.id}`} className="btn">View my listing</Link>
        <Link to={`/property/${done.id}/intelligence`} className="btn ghost">See its intelligence profile</Link>
        <Link to="/saved" className="btn ghost">Manage my listings</Link>
      </div>
    </div>
  );

  const limit = online ? PHOTO_LIMIT.online : PHOTO_LIMIT.offline;
  const photoCount = existing.length + (f.photos?.length ?? 0);
  const inlineChecks = (i: number) => {
    if (!(seen > i || (i === 5 && (f.description ?? '').trim()))) return null;
    const items = failing(i);
    return items.length > 0 && (
      <div className="ail-warn" role="note"><b>Before you publish</b><ul className="lp-inline-checks">{items.map((c) => <li key={c.id}>{c.message}</li>)}</ul></div>
    );
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">{editRef ? 'Edit your listing' : 'List your property'}</div><h2 style={{ marginTop: 6 }}>{editRef ? 'Update your listing' : 'Sell or let it yourself — with Streetkey intelligence built in'}</h2>
          <p className="muted" style={{ marginTop: 6 }}>Seven short steps. Your listing gets a price check, a renovation estimate for buyers and an AI-written description you can edit.</p></div>
        {myListings.length > 0 && <Link to="/saved" className="btn ghost sm">My listings ({myListings.length})</Link>}
      </div>
      {restoreNote && <div className="row small muted" style={{ gap: 8 }}><span role="status">{restoreNote}</span><button type="button" className="linkish" onClick={() => { startAgain(); focusStepHeading(); }}>Start again</button></div>}

      <div className="steps" aria-label="Progress" ref={stepBar}>{STEPS.map((s, i) => {
        const st = stepState(i);
        return (
          <button key={s} type="button" className={`step${i === step ? ' on' : ''}${st === 'done' ? ' done' : ''}${st === 'warn' ? ' warn' : ''}`} aria-current={i === step ? 'step' : undefined} onClick={() => goStep(i)}>
            <span aria-hidden="true">{st === 'done' ? '✓' : st === 'warn' ? '!' : i + 1}</span>{s}{st !== 'todo' && <span className="sr-only">{st === 'done' ? ' (complete)' : ' (needs attention)'}</span>}
          </button>
        );
      })}</div>

      <div className="split-r">
        <section className="card stack" style={{ gap: 14 }} ref={stepCard}>
          {step === 0 && <>
            <h3>What are you listing?</h3>
            <Choice id="lp-channel" label="I want to" value={f.listing} onChange={(v) => set('listing', v)} options={[{ value: 'sale', label: 'Sell' }, { value: 'rent', label: 'Let' }]} />
            <Choice id="lp-who" label="I am" value={who} onChange={setWho} options={[{ value: 'owner', label: 'The owner' }, { value: 'landlord', label: 'A landlord' }, { value: 'agent', label: 'An estate agent' }]} />
            <Choice id="lp-type" label="Property type" value={f.type} onChange={(v) => set('type', v as PropertyType)} options={[{ value: 'terraced', label: 'Terraced' }, { value: 'semi-detached', label: 'Semi' }, { value: 'detached', label: 'Detached' }, { value: 'flat', label: 'Flat' }, { value: 'bungalow', label: 'Bungalow' }]} />
          </>}
          {step === 1 && <>
            <h3>Where is it?</h3>
            <label className="field">Postcode
              <div className="row" style={{ flexWrap: 'nowrap' }}><input className="input mono" value={f.postcode} placeholder="e.g. E17 4QH" onChange={(e) => set('postcode', e.target.value)} onBlur={() => f.postcode && findPostcode()} /><button className="btn sm" type="button" onClick={findPostcode}>Find</button></div>
            </label>
            {lookup && <div className="xs muted" role="status">{lookup}</div>}
            <label className="field">First line of address<input className="input" value={f.addressLine} placeholder="e.g. 12 Example Road" aria-invalid={addressProblem ? true : undefined} aria-describedby={addressProblem ? 'lp-address-err' : undefined} onChange={(e) => set('addressLine', e.target.value)} /></label>
            {addressProblem && <p className="lp-error" id="lp-address-err">{addressProblem}</p>}
            <label className="field">Town / area<input className="input" value={f.town} aria-invalid={townProblem ? true : undefined} aria-describedby={townProblem ? 'lp-town-err' : undefined} onChange={(e) => set('town', e.target.value)} /></label>
            {townProblem && <p className="lp-error" id="lp-town-err">{townProblem}</p>}
            <p className="xs muted">Only the street and area are shown publicly; the house number is shared with people you choose to give it to.</p>
            <Choice id="lp-tenure" label="Tenure" value={f.tenure} onChange={(v) => set('tenure', v)} options={[{ value: 'freehold', label: 'Freehold' }, { value: 'leasehold', label: 'Leasehold' }, { value: 'share-of-freehold', label: 'Share of freehold' }]} />
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
            <Choice id="lp-condition" label="Condition" value={(f.condition ?? 'fair') as Condition} onChange={(v) => set('condition', v)} options={[{ value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Needs work' }, { value: 'derelict', label: 'Major works' }]} />
            <div className="field"><span id="lp-features">Features</span><div className="chips" role="group" aria-labelledby="lp-features">{FEATURES.map((x) => <button key={x} type="button" aria-pressed={f.features.includes(x)} className={`save-btn${f.features.includes(x) ? ' on' : ''}`} onClick={() => set('features', f.features.includes(x) ? f.features.filter((y) => y !== x) : [...f.features, x])}>{x}</button>)}
              {customFeatures.map((x) => <button key={x} type="button" className="save-btn on" aria-label={`Remove feature: ${x}`} onClick={() => set('features', f.features.filter((y) => y !== x))}>{x} <span aria-hidden="true">×</span></button>)}</div></div>
            <EpcLookup postcode={normalisePostcode(f.postcode)} addressLine={f.addressLine} valid={POSTCODE_RE.test(f.postcode)}
              onUse={(c) => { if (c.band) set('epc', c.band); }} />
            <p className="xs muted">Don’t know your EPC? Find it free on the government EPC register (find-energy-certificate.service.gov.uk). It’s a legal requirement before marketing.</p>
          </>}
          {step === 3 && <>
            <h3 ref={photosHeading} tabIndex={-1}>Photos</h3>
            {photoError && <div className="lp-alert" role="alert"><b>{photoError.title}</b><ul>{photoError.items.map((m) => <li key={m}>{m}</li>)}</ul></div>}
            {existing.length > 0 && <div className="photo-grid">{existing.map((p, i) => (
              <div key={p.id} className="photo-item"><img src={mediaUrl(p.url)} alt={p.alt ?? `Photo ${i + 1}`} />{i === 0 && <span className="cap-lead">Lead</span>}
                {removing === p.id
                  ? <div className="lp-confirm" role="group" aria-label={`Remove photo ${i + 1}?`}>
                    <span>{liveEdit ? 'Remove it from your live listing now?' : 'Remove this photo now?'}</span>
                    <button type="button" className="btn sm" autoFocus onClick={() => void removeExisting(p, i)}>Remove photo {i + 1}</button>
                    <button type="button" className="btn ghost sm" onClick={() => { setRemoving(null); focusRemove(i); }}>Keep it</button>
                  </div>
                  : <div className="row photo-actions"><button type="button" className="btn ghost sm" aria-label={`Remove photo ${i + 1}`} onClick={() => { setPhotoError(null); setRemoving(p.id); }}>Remove</button></div>}
              </div>))}</div>}
            {existing.length > 0 && <p className="xs muted">Photos already on your listing are removed straight away; new photos are added when you {editRef ? 'save your changes' : 'submit'}.</p>}
            {aiPhotos && activeRef && existing.length > 0 && consentBox}
            {activeRef && <ExistingPhotoCheck editRef={activeRef} existing={existing} setExisting={setExisting} consent={photoConsent} />}
            <label className="dropzone lp-dropzone" style={{ display: 'block' }}>
              <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" multiple aria-label={`Add photos (up to ${limit})`} aria-describedby="lp-photo-help" onChange={(e) => void addPhotoFiles(e.currentTarget)} />
              <Icon name="home" /> <span id="lp-photo-help">{processing ? 'Preparing your photos…' : photoCount >= limit ? `You’ve added ${limit} photos, the most a listing can have.` : `Choose photos to add (up to ${limit}). The first photo is your lead image.`}</span>
            </label>
            {processing && <span className="sr-only" role="status">Preparing your photos…</span>}
            {(f.photos?.length ?? 0) > 0 && <div className="photo-grid">{f.photos!.map((src, i) => (
              <div key={src} className="photo-item"><img src={src} alt={photoChecks.get(src)?.alt || `Photo ${existing.length + i + 1}`} />{existing.length + i === 0 && <span className="cap-lead">Lead</span>}
                <div className="row photo-actions">{i > 0 && <button type="button" className="btn ghost sm" aria-label={`Make photo ${existing.length + i + 1} the lead photo`} onClick={() => {
                  const a = [...f.photos!]; [a[0], a[i]] = [a[i], a[0]]; setPhotos(a);
                  // This photo becomes the lead (which has no "Make lead"): focus moves to the one that took its place.
                  focusSoon(() => document.querySelector<HTMLElement>(`[aria-label="Make photo ${existing.length + i + 1} the lead photo"]`) ?? photosHeading.current);
                }}>Make lead</button>}
                  <button type="button" className="btn ghost sm" aria-label={`Remove photo ${existing.length + i + 1}`} onClick={() => { setPhotos(f.photos!.filter((_, k) => k !== i)); requestAnimationFrame(() => photosHeading.current?.focus()); }}>Remove</button></div>
              </div>))}</div>}
            {aiPhotos && !(activeRef && existing.length > 0) && (f.photos?.length ?? 0) > 0 && consentBox}
            {online
              ? <PhotoCheck photos={f.photos ?? []} checks={photoChecks} setChecks={setPhotoChecks} advice={photoAdvice} setAdvice={setPhotoAdvice} onOrder={setPhotos} staged={staged} consent={photoConsent} onSignIn={signInHere} />
              : (f.photos?.length ?? 0) > 0 && <AiUnavailable reason="offline" feature="The AI photo check" noFallback />}
            <label className="check"><input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />Some photos are virtually staged or edited (they will be labelled — required by consumer protection law)</label>
            {online && photoCount === 0 && <p className="xs muted">Add at least one photo: listings need one before they can be published.</p>}
            <p className="xs muted">Tip: the Streetkey Design Studio can create a labelled “what it could look like” concept for rooms that need work.</p>
          </>}
          {step === 4 && <>
            <h3>{f.listing === 'rent' ? 'Monthly rent' : 'Asking price'}</h3>
            <div className="input-prefix"><span>£</span><input className="input num" style={{ fontSize: 22 }} type="number" aria-label={f.listing === 'rent' ? 'Monthly rent in pounds' : 'Asking price in pounds'} value={f.price || ''} placeholder={f.listing === 'rent' ? 'e.g. 1650' : 'e.g. 450000'} onChange={(e) => set('price', Number(e.target.value) || 0)} /></div>
            {soldNear.status === 'loading' && <p className="od-status" role="status">Getting sold prices near {normalisePostcode(f.postcode)} from HM Land Registry…</p>}
            {realRange ? <PriceEvidence near={soldNear} range={realRange} type={f.type} price={f.price} /> : soldNear.status !== 'loading' && (
              <div className="callout info small">
                <b><Icon name="spark" size={14} /> Streetkey price check</b>{' '}
                {range ? <>{f.listing === 'rent'
                  ? (rentLets
                    ? <>Similar rentals in the wider region suggest <b className="num">{gbp(range.low)}–{gbp(range.high)} pcm</b> for {f.floorArea}m² ({rentLets} demo rental comparable{rentLets === 1 ? '' : 's'}).</>
                    : <>There are no rental comparables for this region yet, so this uses sale prices in {ev!.scope} ({ev!.n} demo comparable{ev!.n === 1 ? '' : 's'}) at an assumed {ASSUMED_YIELD_PCT}% gross yield: <b className="num">{gbp(range.low)}–{gbp(range.high)} pcm</b> for {f.floorArea}m².</>)
                  : <>Similar homes in {ev!.scope} suggest <b className="num">{gbpK(range.low)}–{gbpK(range.high)}</b> for {f.floorArea}m² in {f.condition} condition ({ev!.n} demo comparable{ev!.n === 1 ? '' : 's'}).</>}
                  {f.price > 0 && <> Your price is <b>{f.price > range.high ? 'above' : f.price < range.low ? 'below' : 'within'}</b> that range.{f.price > range.high * 1.05 ? ' Homes priced above the evidence tend to get views but few enquiries.' : ''}</>}</> : 'Add a valid postcode to see a price check.'}
                <div className="xs muted" style={{ marginTop: 6 }}>Indicative only — not a valuation. This uses Streetkey’s demonstration comparables{online && f.listing === 'sale' ? ', because there aren’t enough recent sold prices near this postcode' : ''}.</div>
              </div>
            )}
            {online ? <PriceExplain f={f} localRange={realRange && realRange.low != null && realRange.high != null ? { low: realRange.low, high: realRange.high } : range} onSignIn={signInHere} /> : range && <AiUnavailable reason="offline" feature="The AI price explanation" fallback="The Streetkey price check above still applies." />}
            {f.listing === 'rent' && <p className="xs muted">Rental adverts must show a fixed rent. You can’t invite or accept offers above it.</p>}
          </>}
          {step === 5 && <>
            <h3>Description</h3>
            <label className="field">Headline (optional)<input className="input" maxLength={120} value={f.title ?? ''} placeholder={preview.title} onChange={(e) => set('title', e.target.value)} /></label>
            <DescribeAssist f={f} setF={setF} photoInsights={photoInsights} onSignIn={signInHere} />
            <label className="field">Description<textarea className="input" rows={8} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Describe what makes it special…" /></label>
            {inlineChecks(5)}
            <p className="xs muted">The AI draft only uses facts you entered. Material information (tenure, council tax, EPC, charges) is shown from your answers, not generated.</p>
          </>}
          {step === 6 && <>
            <h3>{editRef ? 'Review & save' : 'Review & publish'}</h3>
            <ul className="clean small">
              {checks.map((c) => {
                const looked = c.id === 'discrim' && c.ok && steering;
                const icon = looked ? '⚠️' : c.ok ? '✅' : c.severity === 'block' ? '⛔' : '⚠️';
                const sr = looked ? 'Check:' : c.ok ? 'Done:' : c.severity === 'block' ? 'Must fix:' : 'Check:';
                return <li key={c.id} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><span aria-hidden="true">{icon}</span><span className="sr-only">{sr}</span>
                  <span style={{ color: c.ok && !looked ? 'var(--muted)' : undefined }}>{looked ? 'Check the wording flagged below: describe the home, not who should live there.' : c.message}</span></li>;
              })}
              {preExtra.map((i, k) => (
                <li key={`ai-${k}`} className="ail-check-item">
                  <span className={`ail-sev ${severityClass(i)}`}>{severityLabel(i)}</span>
                  <span className="ail-check-text"><span>{i.message}</span><span className="ail-field">{FIELD_LABEL[i.field] ?? 'General'} · {i.source === 'ai' ? <AiLabel>AI review</AiLabel> : 'Wording check'}{i.severity === 'block' && !isEnforced(i) ? ' · advice: doesn’t stop you publishing' : ''}</span></span>
                </li>
              ))}
            </ul>
            {online ? (ai.available && ai.signedIn ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="ail-row">
                  <AiButton kind="ghost" busy={precheck.busy} onClick={() => void precheck.run(preFacts, preDescription, preCount, preKey)}>{preFresh ? 'Check again with AI' : 'Check my listing with AI'}</AiButton>
                  {pre && !preFresh && !precheck.busy && <span className="ail-stale">Your listing has changed since the last AI check.</span>}
                </div>
                {precheck.busy && <AiThinking label="Reviewing your listing" />}
                <AiErrorNote error={precheck.error} onRetry={() => void precheck.run(preFacts, preDescription, preCount, preKey)} />
                {/* Read out when the check finishes (useAiAction's announcement), so not a live region of its own. */}
                {preFresh && !precheck.busy && <p className="ail-note">{precheckSummary(preFresh)}</p>}
                {preFresh && <AiDisclaimer>AI suggestions help you avoid misleading or unlawful wording. They aren’t legal advice; the rule-based checks above decide whether you can publish.</AiDisclaimer>}
              </div>
            ) : <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} onSignIn={signInHere} feature="The AI listing check" fallback="The rule-based checks above still apply." />)
              : <AiUnavailable reason="offline" feature="The AI listing check" fallback="The rule-based checks above still apply." />}
            <label className="check"><input type="checkbox" checked={declared.owner} onChange={(e) => setDeclared({ ...declared, owner: e.target.checked })} />I own this property or am authorised to {f.listing === 'rent' ? 'let' : 'sell'} it</label>
            <label className="check"><input type="checkbox" checked={declared.accurate} onChange={(e) => setDeclared({ ...declared, accurate: e.target.checked })} />The information is accurate and I’ll keep it up to date</label>
            {serverError && <div className="callout" role="alert"><b>{serverError.message}</b>{Object.values(serverError.fields).length > 0 && <ul className="clean small" style={{ marginTop: 6 }}>{Object.values(serverError.fields).map((m) => <li key={m}>• {m}</li>)}</ul>}</div>}
            {uploadProgress && <p className="lp-progress" role="status">{uploadProgress}</p>}
            {online && !user ? <SignIn heading="Sign in to publish your listing" defaultAccountType={who === 'landlord' || f.listing === 'rent' ? 'landlord' : 'owner'} /> : <>
              {/* aria-disabled (not disabled) while sending, so keyboard focus stays on the button. */}
              <button className="btn accent" disabled={!canPublish} aria-disabled={busy || undefined} onClick={() => { if (!busy) publish(); }} style={{ opacity: canPublish ? 1 : 0.5 }}>{busy ? (editRef ? 'Saving…' : 'Publishing…') : editRef ? 'Save changes' : online ? (createdRef ? 'Submit listing again' : 'Submit listing') : 'Publish listing'}</button>
              {!canPublish && <div className="xs muted">{blocking.length ? `${blocking.length} item${blocking.length > 1 ? 's' : ''} to fix before publishing.` : 'Confirm both declarations to publish.'}</div>}
              {online && canPublish && (liveEdit
                ? <div className="xs muted">Changes to a live listing are checked again: if anything needs a closer look, the listing is paused until our team has reviewed it, and we’ll email you.</div>
                : editRef && editStatus === 'pending'
                  ? <div className="xs muted">Your listing is waiting for review; your changes are included in that review.</div>
                  : <div className="xs muted">Private listings are checked by our team before they go live. You’ll get an email when it’s published.</div>)}
              {!online && <div className="xs muted">This preview has no server: your listing is saved in this browser only.</div>}
            </>}
          </>}
          {step > 0 && step < 6 && step !== 5 && inlineChecks(step)}
          <div className="row between" style={{ marginTop: 6 }}>
            <button type="button" className="btn ghost" disabled={step === 0} onClick={() => { goStep(step - 1); if (step === 1) focusStepHeading(); }} style={{ visibility: step === 0 ? 'hidden' : 'visible' }}>← Back</button>
            {/* Back is hidden on the first step and Next on the last: when the pressed one goes, focus moves to the step's heading. */}
            {step < STEPS.length - 1 && <button type="button" className="btn" onClick={() => { goStep(step + 1); if (step + 1 === STEPS.length - 1) focusStepHeading(); }}>Next →</button>}
          </div>
        </section>

        <aside className="stack sticky" style={{ gap: 12 }}>
          <div className="eyebrow">Live preview</div>
          <article className="pcard">
            <div className="pcard-img">{existing[0] || f.photos?.[0] ? <img src={existing[0] ? mediaUrl(existing[0].url) : f.photos![0]} alt={existing[0]?.alt || photoChecks.get(f.photos?.[0] ?? '')?.alt || 'Lead photo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <HouseArt hue={preview.photoHue} type={f.type} />}</div>
            <div className="pcard-body">
              <span className="num" style={{ fontSize: 19 }}>{f.price ? (f.listing === 'rent' ? `${gbp(f.price)} pcm` : gbp(f.price)) : '£ —'}</span>
              <span className="small" style={{ fontWeight: 600 }}>{preview.title}</span>
              {/* What the public sees: the street, never the house number. */}
              <span className="xs muted">{(f.addressLine && streetOnly(f.addressLine)) || 'Street'}, {f.town || 'Town'} · {f.floorArea}m² · EPC {f.epc || '—'}</span>
              <span className="row" style={{ gap: 6, marginTop: 4 }}><Tag kind="neutral">{who === 'landlord' ? 'Private landlord' : 'Private seller'}</Tag>{staged && <Tag kind="warn">Virtually staged images</Tag>}</span>
            </div>
          </article>
          <div className="card flat small">
            <b>What happens next</b>
            <ul className="ticks muted" style={{ marginTop: 6 }}>
              <li>Your listing appears in Streetkey search with an intelligence profile.</li>
              <li>You get the owner dashboard: views, saves, enquiries and what buyers ask.</li>
              <li>Enquiries come to you through Streetkey messaging; your contact details stay private.</li>
              <li>“Verified owner” badges, based on an identity check and an HM Land Registry title match, are coming soon.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
