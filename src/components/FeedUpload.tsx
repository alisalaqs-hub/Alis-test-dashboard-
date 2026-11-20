/**
 * Upload a feed file by hand: an agency's owner or admin picks the BLM file their software exports and
 * Streetkey imports it, exactly as it imports a file sent with a feed key. The result says how many listings
 * were accepted and withdrawn, and names every listing that was not imported, with the reason.
 *
 * The file is read in the browser first (BLM files are usually Windows-1252, not UTF-8) and sent as text.
 */
import { useId, useRef, useState } from 'react';
import { decodeFeedBytes, feedLeftOutText, looksLikeBLM } from '../engine/listings';
import { api, ApiError } from '../lib/api';
import type { FeedIssueDTO, FeedResultDTO } from '../lib/apiTypes';
import './feedUpload.css';

export interface FeedUploadProps {
  /** The agency (organisation id) the file is for. The signed-in person must be one of its owners or admins. */
  orgId: string;
  /** Called once a file has been imported, with the result: for example to reload the list of recent uploads. */
  onUploaded?: (result: FeedResultDTO) => void;
}

const n = (count: number) => count.toLocaleString('en-GB');

/** Why an upload failed, in words for the person who chose the file. */
function problem(e: unknown): string {
  if (e instanceof ApiError) {
    // A host can turn an oversized file away before Streetkey sees it, with no message of its own.
    if (e.status === 413 && e.code !== 'feed_too_large') return 'That file is too large to upload. Larger agencies send each branch’s stock from their software with its own feed key.';
    return e.message;
  }
  return 'The file could not be read. Please choose it again.';
}

function Issues({ title, items, label }: { title: string; items: FeedIssueDTO[]; label: string }) {
  if (!items.length) return null;
  return (
    <div className="fu-issues">
      <p className="fu-sub">{title} ({n(items.length)})</p>
      {/* A long list scrolls inside its own box, which the keyboard can reach. */}
      <div className="fu-scroll" tabIndex={0} role="region" aria-label={label}>
        <ul className="clean small">
          {items.map((x, i) => <li key={`${i}-${x.ref}`}><code className="inline">{x.ref}</code> <span>{x.reason}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

export function FeedUpload({ orgId, onUploaded }: FeedUploadProps) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<'idle' | 'reading' | 'sending'>('idle');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ name: string; result: FeedResultDTO } | null>(null);
  const busy = step !== 'idle';

  const upload = async () => {
    if (busy) return;
    setError(''); setDone(null);
    if (!file) { setError('Choose a .blm file first.'); input.current?.focus(); return; }
    setStep('reading');
    try {
      const text = decodeFeedBytes(new Uint8Array(await file.arrayBuffer()));
      if (!looksLikeBLM(text)) { setError(`${file.name} doesn’t look like a BLM file. Choose the .blm file your agency software exports for property portals.`); return; }
      setStep('sending');
      const result = await api.orgs.uploadFeed(orgId, text);
      setDone({ name: file.name, result });
      onUploaded?.(result);
    } catch (e) {
      setError(problem(e));
    } finally {
      setStep('idle');
    }
  };

  const r = done?.result;
  const notImported = r?.rejected.filter((x) => !x.imported) ?? [];
  const leftOut = r?.rejected.filter((x) => x.imported) ?? [];

  return (
    <div className="fu" aria-busy={busy}>
      <p className="small fu-p" id={`${uid}-help`}>
        Choose the BLM file your agency software exports for property portals. It is treated as your full stock uploaded by hand:
        new listings are added, changed ones are updated, and listings from your last upload by hand that are not in this file are
        withdrawn. Listings sent with a feed key are not affected.
      </p>
      <label className="field" htmlFor={`${uid}-file`}>Listing file (.blm)
        <input ref={input} id={`${uid}-file`} className="input" type="file" accept=".blm" disabled={busy} aria-describedby={`${uid}-help`}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }} />
      </label>
      <div className="row"><button type="button" className="btn accent" disabled={busy} onClick={() => void upload()}>Upload</button></div>

      {error && <div className="callout error" role="alert">{error}</div>}

      {/* Always on the page, so screen readers announce the progress and then the result as they arrive. */}
      <div className="fu-status" role="status">
        {busy && file && (
          <div className="fu-progress">
            <progress className="fu-bar" aria-label={step === 'reading' ? 'Reading the file' : 'Uploading and importing'} />
            <span className="small">{step === 'reading' ? `Reading ${file.name}…` : `Uploading and importing ${file.name}. A large file can take a minute.`}</span>
          </div>
        )}
        {!busy && done && r && (
          <div className="fu-result">
            <p className="fu-head">Import finished: {done.name}</p>
            <dl className="fu-counts">
              <div><dt>Accepted</dt><dd className="num">{n(r.accepted)}</dd><dd className="xs muted">{n(r.accepted - r.updated)} new, {n(r.updated)} updated</dd></div>
              <div><dt>Withdrawn</dt><dd className="num">{n(r.withdrawn)}</dd><dd className="xs muted">from earlier uploads by hand</dd></div>
              <div><dt>Not imported</dt><dd className="num">{n(notImported.length)}</dd><dd className="xs muted">{notImported.length ? 'reasons below' : 'nothing rejected'}</dd></div>
            </dl>
            <p className="small fu-p">{r.note} The same report is emailed to your agency’s owners and admins.</p>
            <Issues title="Not imported" items={notImported} label="Listings that were not imported, with reasons" />
            <Issues title="Imported, with something left out" items={leftOut} label="Listings imported with something left out" />
            {feedLeftOutText(r.leftOut).map((t) => <p key={t} className="small fu-p">{t}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}

export default FeedUpload;
