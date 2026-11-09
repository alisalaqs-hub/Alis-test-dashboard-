import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, mediaUrl } from '../lib/api';
import type { PhotoDTO } from '../lib/apiTypes';
import { useServer } from '../lib/server';
import { SignIn } from './Account';
import { areaEvidence, buildListing, complianceChecks, normalisePostcode, POSTCODE_RE, type ListingInput } from '../engine/listings';
import type { Condition, Era, PropertyType } from '../engine/refurb';
import { PROPERTIES, type Property } from '../data/properties';
import { regionFromPostcode } from '../engine/refurb';
import { gbp, gbpK, HouseArt, Seg, Tag } from '../components/ui';
import { Icon } from '../components/Icons';
import { useStore } from '../store';
import { pollJob, useAi, useAiAction } from '../lib/ai/core';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import {
  checkListingPhotos, describeListing, factsFrom, FIELD_LABEL, FLAG_LABEL, getPhotoConsent, ISSUE_LABEL, listingPhotos, PHOTO_CONSENT_TEXT, photoInsightsFrom,
  precheckListing, previewPhotos, priceGuide, priorOf, roomLabel, savePhotoConsent, setPhotoAlt, setPhotoOrder, SEVERITY_LABEL, shrinkForCheck, storedIndexes, TONES,
  type DescribeResult, type ListingPhotosResult, type PhotoAnalysis, type PhotoJobOutput, type PrecheckResult, type PriceGuideResult, type PriorItem, type Tone,
} from '../lib/ai/listing';
import '../components/ai/listing.css';

const STEPS = ['Basics', 'Address', 'Details', 'Photos', 'Price', 'Description', 'Review'];
const FEATURES = ['Garden', 'Parking', 'Garage', 'Balcony', 'Chain free', 'Period features', 'New kitchen', 'En-suite', 'Pets considered', 'Furnished', 'Close to station', 'Loft potential'];
const STAGED = 'Contains virtually staged images';

/** Resize an uploaded image in the browser (small for the on-device preview; full size for the live site). */
function compress(file: File, max = 900, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality)); URL.revokeObjectURL(img.src);
    };
    img.onerror = reject; img.src = URL.createObjectURL(file);
  });
}

const dataUrlToBlob = (u: string) => { const [head, b64] = u.split(','); const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: head.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg' }); };

/** The built-in template (used when AI isn't available). */
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

/** Stable key for "has this input changed since the AI looked at it?" */
const keyOf = (v: unknown) => JSON.stringify(v);

/** Demonstration lettings in the postcode's region: what the price check's rent per m² is averaged from (0 = estimated from sale values). */
const rentalComparables = (postcode: string) => {
  const region = regionFromPostcode(postcode);
  return PROPERTIES.filter((p) => p.listing === 'rent' && !p.source && regionFromPostcode(p.postcode) === region).length;
};
/** The gross yield the price check assumes when a region has no rental comparables (src/engine/listings.ts). */
const ASSUMED_YIELD_PCT = 4.5;

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

/* ───────────────────────── AI: tone picker (radio group, arrow keys) ───────────────────────── */
function ToneSelect({ value, onChange }: { value: Tone; onChange: (t: Tone) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + TONES.length) % TONES.length;
    onChange(TONES[n].value); refs.current[n]?.focus();
  };
  return (
    <div className="ail-row">
      <span className="ail-legend" id="ail-tone-label">Tone</span>
      <div className="seg ail-seg" role="radiogroup" aria-labelledby="ail-tone-label">
        {TONES.map((t, i) => (
          <button key={t.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={t.value === value} tabIndex={t.value === value ? 0 : -1}
            className={t.value === value ? 'on' : ''} onClick={() => onChange(t.value)} onKeyDown={(e) => move(e, i)}>{t.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── AI: description ───────────────────────── */
function DescribeAssist({ f, setF, photoInsights }: { f: ListingInput; setF: (fn: (x: ListingInput) => ListingInput) => void; photoInsights: string[] }) {
  const ai = useAi();
  const aiOk = ai.available && ai.signedIn;
  const [tone, setTone] = useState<Tone>('warm');
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState<DescribeResult | null>(null);
  const [undo, setUndo] = useState<{ title?: string; description?: string } | null>(null);
  const [kf, setKf] = useState('');
  const [added, setAdded] = useState(false);
  const write = useAiAction((facts: ReturnType<typeof factsFrom>, t: Tone, n: string, ins: string[]) => describeListing(facts, t, n, ins));

  const useTemplate = () => { setUndo({ title: f.title, description: f.description }); setDraft(null); setF((x) => ({ ...x, description: draftDescription(x) })); };
  const run = async () => {
    if (!aiOk) { useTemplate(); return; }
    const r = await write.run(factsFrom(f), tone, notes, photoInsights);
    if (!r) return;
    setUndo({ title: f.title, description: f.description });
    setDraft(r); setKf(r.keyFeatures.join('\n')); setAdded(false);
    setF((x) => ({ ...x, title: r.headline || x.title, description: r.description || x.description }));
  };
  const addFeatures = () => {
    const lines = kf.split('\n').map((l) => l.replace(/^[-•*\s]+/, '').trim().slice(0, 60)).filter(Boolean);
    setF((x) => {
      const have = new Set(x.features.map((y) => y.toLowerCase()));
      return { ...x, features: [...x.features, ...lines.filter((l) => !have.has(l.toLowerCase()))].slice(0, 30) };
    });
    setAdded(true);
  };

  return (
    <div className="ail-assist">
      {aiOk ? <>
        <ToneSelect value={tone} onChange={setTone} />
        <label className="field">Your notes for the AI (optional)
          <textarea className="input" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. new boiler 2023, loft room used as a study, 8 minutes’ walk to the station" />
        </label>
        <p className="ail-note">The AI uses only your answers and notes{photoInsights.length ? ' (plus what the photo check saw)' : ''}. It won’t add prices, schools, transport or anything you haven’t told it.</p>
      </> : <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} feature="The AI description writer" />}
      <div className="ail-row">
        <AiButton busy={write.busy} onClick={() => void run()}>{aiOk ? (draft ? 'Write it again' : 'Write it for me') : 'Write it for me'}</AiButton>
        {aiOk && <button type="button" className="btn ghost sm" onClick={useTemplate}>Use the basic template</button>}
        {undo && <button type="button" className="linkish" onClick={() => { setF((x) => ({ ...x, title: undo.title, description: undo.description ?? '' })); setUndo(null); setDraft(null); }}>Undo</button>}
      </div>
      {write.busy && <AiThinking label="Writing your description" />}
      <AiErrorNote error={write.error} onRetry={() => void run()} />
      {write.error && <button type="button" className="btn ghost sm" onClick={useTemplate}>Use the basic template instead</button>}
      {draft && !write.busy && (
        <AiCard title="Draft written" footer={<AiDisclaimer>{draft.label}</AiDisclaimer>}>
          <div role="status" className="ail-note">Your headline and description have been filled in below ({draft.wordCount} words). Edit anything you like.</div>
          {draft.keyFeatures.length > 0 && <label className="field">Key features (one per line)
            <textarea className="input" rows={Math.min(8, draft.keyFeatures.length + 1)} value={kf} onChange={(e) => { setKf(e.target.value); setAdded(false); }} />
          </label>}
          {draft.keyFeatures.length > 0 && <div className="ail-row"><button type="button" className="btn ghost sm" onClick={addFeatures}>Add these to my features</button>{added && <span className="xs muted" role="status">Added to your features.</span>}</div>}
          {draft.materialInfo.length > 0 && <div><p className="ail-sub">Material information (from your answers, shown on the listing)</p><ul className="ail-list">{draft.materialInfo.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          {draft.wordingWarnings.length > 0 && <div className="ail-warn" role="note"><b>Wording to check</b><ul>{draft.wordingWarnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {draft.missingInfo.length > 0 && <div><p className="ail-sub">People will also want to know</p><ul className="ail-list">{draft.missingInfo.map((m) => <li key={m}>{m}</li>)}</ul></div>}
        </AiCard>
      )}
    </div>
  );
}

/* ───────────────────────── AI: photo check (photos still in the browser) ───────────────────────── */
type Checks = Map<string, PhotoAnalysis>;
function PhotoCheck({ photos, checks, setChecks, advice, setAdvice, onOrder, staged, consent }: {
  photos: string[]; checks: Checks; setChecks: Dispatch<SetStateAction<Checks>>;
  advice: { order: string[]; tips: string[] } | null; setAdvice: (a: { order: string[]; tips: string[] } | null) => void;
  onOrder: (order: string[]) => void; staged: boolean; consent: boolean;
}) {
  const ai = useAi();
  const aiOk = ai.available && ai.signedIn;
  const [progress, setProgress] = useState('');
  const unchecked = photos.filter((p) => !checks.has(p));
  // The current results are passed in (useAiAction keeps the first version of this function).
  const action = useAiAction(async (list: string[], known: Checks, consented: boolean) => {
    if (!consented) return null; // nothing leaves the browser without consent
    const found: Checks = new Map(known);
    let keys = list.filter((p) => found.has(p));
    let prior: PriorItem[] = keys.map((k) => priorOf(found.get(k)));
    const todo = list.filter((p) => !found.has(p));
    let last: { order: string[]; tips: string[] } | null = null;
    for (let i = 0; i < todo.length; i += 6) {
      const chunk = todo.slice(i, i + 6);
      setProgress(todo.length > 6 ? `Checking photos ${i + 1}–${Math.min(todo.length, i + 6)} of ${todo.length}` : 'Checking your photos');
      const blobs = await Promise.all(chunk.map((p) => shrinkForCheck(p)));
      const r = await previewPhotos(blobs, prior);
      const fresh = new Map<string, PhotoAnalysis>();
      r.photos.forEach((p) => { if (p.analysis && chunk[p.index]) fresh.set(chunk[p.index], p.analysis); });
      fresh.forEach((a, k) => found.set(k, a));
      keys = [...keys, ...chunk];
      prior = [...prior, ...chunk.map((k) => priorOf(found.get(k)))];
      last = { order: r.suggestedOrder.map((n) => keys[n]).filter(Boolean), tips: r.tips };
      // Merge, so alt text edited meanwhile is kept.
      setChecks((prev) => { const n = new Map(prev); fresh.forEach((a, k) => { if (!n.has(k)) n.set(k, a); }); return n; });
    }
    if (last) setAdvice(last);
    return last;
  });
  if (!photos.length) return null;
  if (!aiOk && !checks.size) return <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} feature="The AI photo check" />;
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
      </> : <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} feature="The AI photo check" />}
      {checks.size > 0 && (
        <AiCard title="Photo check" footer={<AiDisclaimer>Room labels and alt text are suggestions. Alt text is saved with your photos when you publish.</AiDisclaimer>}>
          {advice && inOrder.length > 1 && (
            <div className="ail-row">
              <button type="button" className="btn ghost sm" disabled={alreadyOrdered} onClick={() => onOrder([...inOrder, ...photos.filter((p) => !inOrder.includes(p))])}>{alreadyOrdered ? 'Photos are in the suggested order' : 'Apply suggested order'}</button>
              <span className="xs muted">Lead photo: the best exterior or living space.</span>
            </div>
          )}
          {advice && advice.tips.length > 0 && <div><p className="ail-sub">Tips</p><ul className="ail-list">{advice.tips.map((t) => <li key={t}>{t}{/virtually staged/.test(t) && staged ? ' (You’ve ticked the box.)' : ''}</li>)}</ul></div>}
          <ol className="ail-photo-list">
            {photos.map((p, i) => {
              const a = checks.get(p);
              return (
                <li key={i} className="ail-photo-row">
                  <img src={p} alt="" />
                  <div className="ail-photo-body">
                    {a ? <>
                      <div className="ail-photo-head"><b>Photo {i + 1}{i === 0 ? ' (lead)' : ''}: {roomLabel(a.room)}</b><span className="ail-score">Quality {a.quality.score}/10</span>
                        {a.quality.issues.map((x) => <span key={x} className="ai-chip">{ISSUE_LABEL[x]}</span>)}
                        {a.flags.map((x) => <span key={x} className="ail-flag">{FLAG_LABEL[x]}</span>)}</div>
                      {a.features.length > 0 && <span className="xs muted">Seen: {a.features.join(', ')}</span>}
                      <label className="field">Alt text for photo {i + 1}<input className="input" maxLength={160} value={a.alt} onChange={(e) => setAlt(p, e.target.value)} /></label>
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

/* ───────────────────────── AI: photo check for photos already on the live listing (editing) ───────────────────────── */
function ExistingPhotoCheck({ editRef, existing, setExisting, consent }: { editRef: string; existing: PhotoDTO[]; setExisting: (p: PhotoDTO[]) => void; consent: boolean }) {
  const ai = useAi();
  const [data, setData] = useState<ListingPhotosResult | null>(null);
  const [note, setNote] = useState('');
  const [alts, setAlts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, 'saving' | 'saved' | 'error' | undefined>>({});
  const [progress, setProgress] = useState('');
  // Consent is passed in (useAiAction keeps the first version of this function); without it nothing is sent for checking.
  const load = useAiAction(async (recheck: boolean, consented: boolean) => {
    setProgress('Loading the photo check');
    let r = await listingPhotos(editRef);
    let msg = '';
    const running = r.job?.status === 'queued' || r.job?.status === 'running';
    if (consented && (recheck || (r.pending && !running))) {
      setProgress('Checking your photos');
      try {
        const started = await checkListingPhotos(editRef, recheck);
        if (started.job) msg = jobNote(started.job.status === 'done' ? started.job.output : await pollJob<PhotoJobOutput>(started.job.id, { onProgress: (j) => j.progress && setProgress(j.progress) }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 429) throw e;
        msg = e.message; // today's limit: show what has been checked so far
      }
      r = await listingPhotos(editRef);
    } else if (r.pending && r.job && running) {
      msg = jobNote(await pollJob<PhotoJobOutput>(r.job.id, { onProgress: (j) => j.progress && setProgress(j.progress) }));
      r = await listingPhotos(editRef);
    }
    setData(r); setNote(msg); setAlts(Object.fromEntries(r.photos.map((p) => [p.id, p.alt || p.analysis?.alt || ''])));
    return r;
  });
  if (!ai.available || !ai.signedIn || !existing.length) return null;
  const byId = new Map(data?.photos.map((p) => [p.id, p]) ?? []);
  const order = data?.suggestedOrder.filter((id) => existing.some((e) => e.id === id)) ?? [];
  const ordered = order.length < 2 || order.every((id, i) => existing[i]?.id === id);
  const saveAlt = async (id: string) => {
    setSaved((s) => ({ ...s, [id]: 'saving' }));
    try { await setPhotoAlt(editRef, id, alts[id] ?? ''); setSaved((s) => ({ ...s, [id]: 'saved' })); setExisting(existing.map((e) => (e.id === id ? { ...e, alt: alts[id] ?? '' } : e))); } catch { setSaved((s) => ({ ...s, [id]: 'error' })); }
  };
  const applyOrder = async () => {
    const ids = [...order, ...existing.map((e) => e.id).filter((id) => !order.includes(id))];
    try { await setPhotoOrder(editRef, ids); setExisting(ids.map((id) => existing.find((e) => e.id === id)!).filter(Boolean)); } catch { /* order unchanged; the list stays as it was */ }
  };
  return (
    <div className="ail-assist">
      <div className="ail-row">
        <AiButton busy={load.busy} disabled={!consent} onClick={() => void load.run(false, consent)}>{data ? 'Refresh photo check' : 'Check these photos with AI'}</AiButton>
        {data && !load.busy && <button type="button" className="btn ghost sm" disabled={!consent} onClick={() => void load.run(true, consent)}>Check them all again</button>}
        {!consent && <span className="xs muted">{CONSENT_HINT}</span>}
      </div>
      {load.busy && <AiThinking label={progress || 'Checking your photos'} />}
      <AiErrorNote error={load.error} onRetry={consent ? () => void load.run(false, consent) : undefined} />
      {data && !load.busy && (
        <AiCard title="Photo check" footer={<AiDisclaimer>Room labels and alt text are suggestions; nothing changes until you save.</AiDisclaimer>}>
          {note && <p className="ail-note" role="status">{note}</p>}
          {order.length > 1 && <div className="ail-row"><button type="button" className="btn ghost sm" disabled={ordered} onClick={() => void applyOrder()}>{ordered ? 'Photos are in the suggested order' : 'Apply suggested order'}</button></div>}
          {data.tips.length > 0 && <div><p className="ail-sub">Tips</p><ul className="ail-list">{data.tips.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          <ol className="ail-photo-list">
            {existing.map((e, i) => {
              const a = byId.get(e.id)?.analysis;
              return (
                <li key={e.id} className="ail-photo-row">
                  <img src={mediaUrl(e.url)} alt="" />
                  <div className="ail-photo-body">
                    <div className="ail-photo-head"><b>Photo {i + 1}{a ? `: ${roomLabel(a.room)}` : ''}</b>{a && <span className="ail-score">Quality {a.quality.score}/10</span>}
                      {a?.quality.issues.map((x) => <span key={x} className="ai-chip">{ISSUE_LABEL[x]}</span>)}
                      {a?.flags.map((x) => <span key={x} className="ail-flag">{FLAG_LABEL[x]}</span>)}
                      {!a && <span className="xs muted">{byId.get(e.id)?.checked ? 'Couldn’t be checked' : 'Not checked yet'}</span>}</div>
                    <div className="ail-row">
                      <label className="field" style={{ flex: 1, minWidth: 180 }}>Alt text for photo {i + 1}<input className="input" maxLength={160} value={alts[e.id] ?? ''} onChange={(ev) => { setAlts((s) => ({ ...s, [e.id]: ev.target.value })); setSaved((s) => ({ ...s, [e.id]: undefined })); }} /></label>
                      <button type="button" className="btn ghost sm" disabled={saved[e.id] === 'saving'} onClick={() => void saveAlt(e.id)} aria-label={`Save alt text for photo ${i + 1}`}>Save</button>
                      {saved[e.id] && <span className="xs muted" role="status">{saved[e.id] === 'saved' ? 'Saved' : saved[e.id] === 'saving' ? 'Saving…' : 'Couldn’t save. Try again.'}</span>}
                    </div>
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
function PriceExplain({ f, localRange }: { f: ListingInput; localRange: { low: number; high: number } | null }) {
  const ai = useAi();
  const aiOk = ai.available && ai.signedIn;
  const body = { postcode: f.postcode, type: f.type, beds: f.beds, floorArea: f.floorArea, condition: f.condition ?? 'fair', channel: f.listing, askingPrice: f.price > 0 ? f.price : null };
  const key = keyOf(body);
  const [result, setResult] = useState<{ key: string; r: PriceGuideResult } | null>(null);
  const action = useAiAction(async (b: typeof body, k: string) => { const r = await priceGuide(b); setResult({ key: k, r }); return r; });
  if (!localRange || f.floorArea < 10) return null;
  if (!aiOk) return <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} feature="The AI price explanation" />;
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
        <AiCard title="What the price guide means" footer={<AiDisclaimer>{r.label ?? 'Indicative only, not a valuation.'}</AiDisclaimer>}>
          <p className="small" style={{ margin: 0 }} role="status">{r.narrative.explanation}</p>
          {r.narrative.position && <p className="small" style={{ margin: 0 }}>{r.narrative.position}</p>}
          {r.narrative.advice.length > 0 && <div><p className="ail-sub">Positioning ideas</p><ul className="ail-list">{r.narrative.advice.map((a) => <li key={a}>{a}</li>)}</ul></div>}
          {r.low != null && r.high != null && r.basis && <p className="xs muted" style={{ margin: 0 }}>Range used: <span className="num">{money(r.low)}–{money(r.high)}{unit}</span>. {r.basis.method}</p>}
        </AiCard>
      ) : <p className="ail-note" role="status">{r.note ?? 'There isn’t enough evidence to explain a price guide here yet.'}</p>)}
    </div>
  );
}

/* ───────────────────────── page ───────────────────────── */
export default function ListProperty() {
  const { publishListing, myListings } = useStore();
  const { online, user, refreshListings } = useServer();
  const ai = useAi();
  const [params] = useSearchParams();
  const editRef = online ? params.get('edit') : null;
  const [existing, setExisting] = useState<PhotoDTO[]>([]);
  const [serverDone, setServerDone] = useState<{ ref: string; status: string; note?: string } | null>(null);
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const [step, setStep] = useState(0);
  const [who, setWho] = useState<'owner' | 'landlord' | 'agent'>('owner');
  const [staged, setStaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<string>('');
  const [declared, setDeclared] = useState({ owner: false, accurate: false });
  const [done, setDone] = useState<Property | null>(null);
  const [photoChecks, setPhotoChecks] = useState<Checks>(() => new Map());
  const [photoAdvice, setPhotoAdvice] = useState<{ order: string[]; tips: string[] } | null>(null);
  const [pre, setPre] = useState<{ key: string; r: PrecheckResult } | null>(null);
  // Consent to photos being sent to the AI provider (stored on the server, so it also covers background checks of uploads).
  const [photoConsent, setPhotoConsent] = useState(false);
  const [consentNote, setConsentNote] = useState('');
  const aiPhotos = online && ai.available && ai.signedIn;
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
  const [f, setF] = useState<ListingInput>({
    listing: 'sale', addressLine: '', town: '', postcode: '', type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 90,
    era: '1919-1944', condition: 'fair', price: 0, epc: '', councilTax: '', features: [], photos: [], description: '',
    source: { kind: 'owner', name: 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false },
  });
  const set = <K extends keyof ListingInput>(k: K, v: ListingInput[K]) => setF((x) => ({ ...x, [k]: v }));
  // Editing a listing on the live site: load it into the form.
  useEffect(() => {
    if (!editRef) return;
    api.listings.get(editRef).then(({ listing: d }) => {
      setF((x) => ({ ...x, listing: d.channel, title: d.title ?? '', addressLine: d.addressLine, town: d.town, postcode: d.postcode, type: d.type as PropertyType, tenure: d.tenure,
        leaseYears: d.leaseYears ?? undefined, beds: d.beds, baths: d.baths, floorArea: d.floorArea, era: (d.era ?? x.era) as Era, condition: (d.condition ?? x.condition) as Condition,
        price: d.price, epc: d.epc ?? '', councilTax: d.councilTax ?? '', serviceChargeAnnual: d.serviceChargeAnnual ?? undefined, groundRentAnnual: d.groundRentAnnual ?? undefined,
        features: d.features.filter((t) => t !== STAGED), description: d.description ?? '', photos: [] }));
      setStaged(d.features.includes(STAGED));
      setExisting(d.photos); setDeclared({ owner: true, accurate: true });
      if (d.source.kind === 'landlord') setWho('landlord');
    }).catch((e: ApiError) => setServerError(e));
  }, [editRef]);
  const ev = useMemo(() => (POSTCODE_RE.test(f.postcode) ? areaEvidence(f.postcode) : null), [f.postcode]);
  const rentLets = useMemo(() => (ev && f.listing === 'rent' ? rentalComparables(f.postcode) : 0), [ev, f.listing, f.postcode]);
  const condAdj = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 }[f.condition ?? 'fair'];
  const range = ev ? (f.listing === 'rent'
    ? { low: Math.round((ev.rentPerM2 * f.floorArea * 0.92) / 25) * 25, high: Math.round((ev.rentPerM2 * f.floorArea * 1.08) / 25) * 25 }
    : { low: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 0.92) / 1000) * 1000, high: Math.round((ev.refurbishedPerM2 * f.floorArea * condAdj * 1.08) / 1000) * 1000 }) : null;
  const checks = complianceChecks({ ...f, description: f.description, photos: [...existing.map((p) => p.url), ...(f.photos ?? [])] });
  const blocking = checks.filter((c) => !c.ok && c.severity === 'block');
  const canPublish = blocking.length === 0 && declared.owner && declared.accurate;
  const preview = useMemo(() => buildListing({ ...f, id: 'preview' }), [f]);
  const photoInsights = useMemo(() => photoInsightsFrom((f.photos ?? []).map((p) => photoChecks.get(p))), [f.photos, photoChecks]);
  const customFeatures = f.features.filter((x) => !FEATURES.includes(x));
  // Shown once, next to the first photo check on the page.
  const consentBox = <PhotoConsent value={photoConsent} onChange={(v) => void changePhotoConsent(v)} note={consentNote} />;

  // AI pre-check: what will be published, so the review matches the listing.
  const preFacts = factsFrom(f, { fullPostcode: true, staged });
  const preDescription = f.description || draftDescription(f);
  const preCount = existing.length + (f.photos?.length ?? 0);
  const preKey = keyOf([preFacts, preDescription, preCount]);
  const precheck = useAiAction(async (facts: typeof preFacts, d: string, n: number, k: string) => { const r = await precheckListing(facts, d, n); setPre({ key: k, r }); return r; });
  const preFresh = pre && pre.key === preKey ? pre.r : null;
  const preExtra = preFresh?.issues.filter((i) => i.source !== 'checks') ?? [];

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

  /** Saves the alt text from the photo check onto the photos just uploaded (best effort: never blocks publishing). */
  const saveAlts = async (ref: string, sent: string[], up: { added: { id: string }[]; rejected: string[] }) => {
    const alts = sent.map((p) => photoChecks.get(p)?.alt?.trim() ?? '');
    if (!alts.some(Boolean)) return 0;
    const idx = storedIndexes(sent.length, up.added.length, up.rejected);
    if (!idx) return 0;
    const results = await Promise.allSettled(idx.map((src, k) => (alts[src] ? setPhotoAlt(ref, up.added[k].id, alts[src]) : Promise.resolve(null))));
    return results.filter((r) => r.status === 'rejected').length;
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
      const r = editRef ? await api.listings.update(editRef, body) : await api.listings.create(body);
      const ref = r.listing.ref;
      let note: string | undefined;
      if (f.photos?.length) {
        const up = await api.listings.uploadPhotos(ref, f.photos.map(dataUrlToBlob));
        const failed = await saveAlts(ref, f.photos, up).catch(() => 1);
        if (failed) note = 'Some photo alt text couldn’t be saved. You can add it later from the listing editor.';
      }
      const status = ['draft', 'rejected', 'withdrawn'].includes(r.listing.status) ? (await api.listings.submit(ref)).status : r.listing.status;
      await refreshListings();
      setServerDone({ ref, status, note });
    } catch (e) { setServerError(e instanceof ApiError ? e : new ApiError(0, 'Something went wrong.')); } finally { setBusy(false); }
  };

  const publish = () => {
    if (online) { void publishToServer(); return; }
    const p = buildListing({ ...f, description: f.description || draftDescription(f), features: staged ? [...f.features, STAGED] : f.features,
      source: { kind: who === 'landlord' ? 'landlord' : 'owner', name: who === 'landlord' ? 'Private landlord' : 'Private seller', licence: 'Posted by the owner on Streetkey', verified: false } });
    publishListing(p); setDone(p);
  };

  /** Photo list changes keep the AI results for photos that are still there. */
  const setPhotos = (photos: string[]) => {
    set('photos', photos);
    if (photoChecks.size) { const n: Checks = new Map(); for (const p of photos) { const a = photoChecks.get(p); if (a) n.set(p, a); } setPhotoChecks(n); }
  };

  if (who === 'agent') return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      <h2>Agents: connect your CRM instead</h2>
      <p className="muted">You don’t need to retype listings. Add Streetkey as a portal destination in your CRM (BLM or API feed) and every listing, price change and status update flows in automatically.</p>
      <div className="row"><Link to={online ? '/account/agency' : '/sources'} className="btn">Connect a listing feed</Link><button className="btn ghost" onClick={() => setWho('owner')}>I’m a private seller or landlord</button></div>
    </div>
  );

  if (serverDone) return (
    <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
      {serverDone.status === 'live'
        ? <div className="callout ok" role="status"><b>Your listing is live on Streetkey.</b> It now appears in search with a full intelligence profile.</div>
        : <div className="callout ok" role="status"><b>Thanks, your listing has been sent for review.</b> We check every private listing before it goes live, usually within a working day, and we’ll email you as soon as it’s published.</div>}
      {serverDone.note && <p className="small muted">{serverDone.note}</p>}
      <div className="row">
        {serverDone.status === 'live' && <Link to={`/property/${serverDone.ref}`} className="btn">View my listing</Link>}
        <Link to="/account/listings" className="btn ghost">Manage my listings</Link>
        <Link to="/account/inbox" className="btn ghost">Inbox</Link>
      </div>
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

      <div className="steps" aria-label="Progress">{STEPS.map((s, i) => <button key={s} className={`step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}><span>{i < step ? '✓' : i + 1}</span>{s}</button>)}</div>

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
            <div className="field">Features<div className="chips">{FEATURES.map((x) => <button key={x} type="button" aria-pressed={f.features.includes(x)} className={`save-btn${f.features.includes(x) ? ' on' : ''}`} onClick={() => set('features', f.features.includes(x) ? f.features.filter((y) => y !== x) : [...f.features, x])}>{x}</button>)}
              {customFeatures.map((x) => <button key={x} type="button" className="save-btn on" aria-label={`Remove feature: ${x}`} onClick={() => set('features', f.features.filter((y) => y !== x))}>{x} <span aria-hidden="true">×</span></button>)}</div></div>
            <p className="xs muted">Don’t know your EPC? Find it free on the government EPC register (find-energy-certificate.service.gov.uk). It’s a legal requirement before marketing.</p>
          </>}
          {step === 3 && <>
            <h3>Photos</h3>
            {existing.length > 0 && <div className="photo-grid">{existing.map((p, i) => (
              <div key={p.id} className="photo-item"><img src={mediaUrl(p.url)} alt={p.alt ?? `Photo ${i + 1}`} />{i === 0 && <span className="cap-lead">Lead</span>}
                <div className="row photo-actions"><button className="btn ghost sm" onClick={() => { if (editRef) void api.listings.deletePhoto(editRef, p.id).then(() => setExisting((x) => x.filter((y) => y.id !== p.id))); }}>Remove</button></div>
              </div>))}</div>}
            {aiPhotos && editRef && existing.length > 0 && consentBox}
            {editRef && <ExistingPhotoCheck editRef={editRef} existing={existing} setExisting={setExisting} consent={photoConsent} />}
            <label className="dropzone" style={{ display: 'block' }}>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={async (e) => { const files = [...(e.target.files ?? [])].slice(0, (online ? 30 : 10) - (f.photos?.length ?? 0) - existing.length); setBusy(true); try { const imgs = await Promise.all(files.map((x) => (online ? compress(x, 2000, 0.85) : compress(x)))); setPhotos([...(f.photos ?? []), ...imgs]); } finally { setBusy(false); } }} />
              <Icon name="home" /> {busy ? 'Processing…' : `Tap to add photos (up to ${online ? 30 : 10}). The first photo is your lead image.`}
            </label>
            {(f.photos?.length ?? 0) > 0 && <div className="photo-grid">{f.photos!.map((src, i) => (
              <div key={i} className="photo-item"><img src={src} alt={photoChecks.get(src)?.alt || `Photo ${i + 1}`} />{i === 0 && <span className="cap-lead">Lead</span>}
                <div className="row photo-actions">{i > 0 && <button className="btn ghost sm" onClick={() => { const a = [...f.photos!]; [a[0], a[i]] = [a[i], a[0]]; setPhotos(a); }}>Make lead</button>}<button className="btn ghost sm" onClick={() => setPhotos(f.photos!.filter((_, k) => k !== i))}>Remove</button></div>
              </div>))}</div>}
            {aiPhotos && !(editRef && existing.length > 0) && (f.photos?.length ?? 0) > 0 && consentBox}
            {online && <PhotoCheck photos={f.photos ?? []} checks={photoChecks} setChecks={setPhotoChecks} advice={photoAdvice} setAdvice={setPhotoAdvice} onOrder={setPhotos} staged={staged} consent={photoConsent} />}
            <label className="check"><input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />Some photos are virtually staged or edited (they will be labelled — required by consumer protection law)</label>
            <p className="xs muted">Tip: the Streetkey Design Studio can create a labelled “what it could look like” concept for rooms that need work.</p>
          </>}
          {step === 4 && <>
            <h3>{f.listing === 'rent' ? 'Monthly rent' : 'Asking price'}</h3>
            <div className="input-prefix"><span>£</span><input className="input num" style={{ fontSize: 22 }} type="number" aria-label={f.listing === 'rent' ? 'Monthly rent in pounds' : 'Asking price in pounds'} value={f.price || ''} placeholder={f.listing === 'rent' ? 'e.g. 1650' : 'e.g. 450000'} onChange={(e) => set('price', Number(e.target.value) || 0)} /></div>
            <div className="callout info small">
              <b><Icon name="spark" size={14} /> Streetkey price check</b>{' '}
              {range ? <>{f.listing === 'rent'
                ? (rentLets
                  ? <>Similar rentals in the wider region suggest <b className="num">{gbp(range.low)}–{gbp(range.high)} pcm</b> for {f.floorArea}m² ({rentLets} demo rental comparable{rentLets === 1 ? '' : 's'}).</>
                  : <>There are no rental comparables for this region yet, so this uses sale prices in {ev!.scope} ({ev!.n} demo comparable{ev!.n === 1 ? '' : 's'}) at an assumed {ASSUMED_YIELD_PCT}% gross yield: <b className="num">{gbp(range.low)}–{gbp(range.high)} pcm</b> for {f.floorArea}m².</>)
                : <>Similar homes in {ev!.scope} suggest <b className="num">{gbpK(range.low)}–{gbpK(range.high)}</b> for {f.floorArea}m² in {f.condition} condition ({ev!.n} demo comparable{ev!.n === 1 ? '' : 's'}).</>}
                {f.price > 0 && <> Your price is <b>{f.price > range.high ? 'above' : f.price < range.low ? 'below' : 'within'}</b> that range.{f.price > range.high * 1.05 ? ' Homes priced above the evidence tend to get views but few enquiries.' : ''}</>}</> : 'Add a valid postcode to see a price check.'}
              <div className="xs muted" style={{ marginTop: 6 }}>Indicative only — not a valuation. Production uses HM Land Registry sold prices.</div>
            </div>
            {online && <PriceExplain f={f} localRange={range} />}
            {f.listing === 'rent' && <p className="xs muted">Rental adverts must show a fixed rent. You can’t invite or accept offers above it.</p>}
          </>}
          {step === 5 && <>
            <h3>Description</h3>
            <label className="field">Headline (optional)<input className="input" maxLength={120} value={f.title ?? ''} placeholder={preview.title} onChange={(e) => set('title', e.target.value)} /></label>
            <DescribeAssist f={f} setF={setF} photoInsights={photoInsights} />
            <label className="field">Description<textarea className="input" rows={8} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Describe what makes it special…" /></label>
            <p className="xs muted">The AI draft only uses facts you entered. Material information (tenure, council tax, EPC, charges) is shown from your answers, not generated.</p>
          </>}
          {step === 6 && <>
            <h3>Review & publish</h3>
            <ul className="clean small">
              {checks.map((c) => <li key={c.id} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><span aria-hidden="true">{c.ok ? '✅' : c.severity === 'block' ? '⛔' : '⚠️'}</span><span className="sr-only">{c.ok ? 'Done:' : c.severity === 'block' ? 'Must fix:' : 'Check:'}</span><span style={{ color: c.ok ? 'var(--muted)' : undefined }}>{c.message}</span></li>)}
              {preExtra.map((i, k) => (
                <li key={`ai-${k}`} className="ail-check-item">
                  <span className={`ail-sev ${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span>
                  <span className="ail-check-text"><span>{i.message}</span><span className="ail-field">{FIELD_LABEL[i.field] ?? 'General'} · {i.source === 'ai' ? <AiLabel>AI review</AiLabel> : 'Wording check'}</span></span>
                </li>
              ))}
            </ul>
            {online && (ai.available && ai.signedIn ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="ail-row">
                  <AiButton kind="ghost" busy={precheck.busy} onClick={() => void precheck.run(preFacts, preDescription, preCount, preKey)}>{preFresh ? 'Check again with AI' : 'Check my listing with AI'}</AiButton>
                  {pre && !preFresh && !precheck.busy && <span className="ail-stale">Your listing has changed since the last AI check.</span>}
                </div>
                {precheck.busy && <AiThinking label="Reviewing your listing" />}
                <AiErrorNote error={precheck.error} onRetry={() => void precheck.run(preFacts, preDescription, preCount, preKey)} />
                {preFresh && !precheck.busy && <p className="ail-note" role="status">{preExtra.length
                  ? `Streetkey AI added ${preExtra.length} point${preExtra.length === 1 ? '' : 's'} to the list above.`
                  : 'Streetkey AI found nothing more to fix in your wording.'}{preFresh.aiNote ? ` ${preFresh.aiNote}` : ''}</p>}
                {preFresh && <AiDisclaimer>AI suggestions help you avoid misleading or unlawful wording. They aren’t legal advice; the rule-based checks above decide whether you can publish.</AiDisclaimer>}
              </div>
            ) : <AiUnavailable reason={ai.reason} signedOut={ai.available && !ai.signedIn} feature="The AI listing check" />)}
            <label className="check"><input type="checkbox" checked={declared.owner} onChange={(e) => setDeclared({ ...declared, owner: e.target.checked })} />I own this property or am authorised to {f.listing === 'rent' ? 'let' : 'sell'} it</label>
            <label className="check"><input type="checkbox" checked={declared.accurate} onChange={(e) => setDeclared({ ...declared, accurate: e.target.checked })} />The information is accurate and I’ll keep it up to date</label>
            {serverError && <div className="callout" role="alert"><b>{serverError.message}</b>{Object.values(serverError.fields).length > 0 && <ul className="clean small" style={{ marginTop: 6 }}>{Object.values(serverError.fields).map((m) => <li key={m}>• {m}</li>)}</ul>}</div>}
            {online && !user ? <SignIn heading="Sign in to publish your listing" /> : <>
              <button className="btn accent" disabled={!canPublish || busy} onClick={publish} style={{ opacity: canPublish ? 1 : 0.5 }}>{busy ? 'Publishing…' : editRef ? 'Save changes' : online ? 'Submit listing' : 'Publish listing'}</button>
              {!canPublish && <div className="xs muted">{blocking.length ? `${blocking.length} item${blocking.length > 1 ? 's' : ''} to fix before publishing.` : 'Confirm both declarations to publish.'}</div>}
              {online && canPublish && <div className="xs muted">Private listings are checked by our team before they go live. You’ll get an email when it’s published.</div>}
            </>}
          </>}
          <div className="row between" style={{ marginTop: 6 }}>
            <button className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)} style={{ visibility: step === 0 ? 'hidden' : 'visible' }}>← Back</button>
            {step < STEPS.length - 1 && <button className="btn" onClick={() => setStep(step + 1)}>Next →</button>}
          </div>
        </section>

        <aside className="stack sticky" style={{ gap: 12 }}>
          <div className="eyebrow">Live preview</div>
          <article className="pcard">
            <div className="pcard-img">{existing[0] || f.photos?.[0] ? <img src={existing[0] ? mediaUrl(existing[0].url) : f.photos![0]} alt={existing[0]?.alt || photoChecks.get(f.photos?.[0] ?? '')?.alt || 'Lead photo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <HouseArt hue={preview.photoHue} type={f.type} />}</div>
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
