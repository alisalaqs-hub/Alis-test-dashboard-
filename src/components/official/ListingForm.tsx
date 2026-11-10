/**
 * Official data inside "List a property":
 *   - PriceEvidence: what homes like this sold for nearby (HM Land Registry), and where the asking price sits
 *   - EpcLookup: find the home's certificate on the EPC register and use its rating
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { evidenceRange, soldTypeFor, type EpcCertificate, type EpcSummary, type EvidenceRange } from '../../engine/evidence';
import type { PropertyType } from '../../engine/refurb';
import { api, ApiError } from '../../lib/api';
import type { SoldPricesDTO } from '../../lib/apiTypes';
import { useServer } from '../../lib/server';
import { gbpK } from '../ui';
import { Attribution, EvidenceRangeCard, fmtDate, SoldTable, SourceTag } from './Official';

export type SoldNear = { status: 'off' | 'loading' | 'ready' | 'failed'; data: SoldPricesDTO | null };

/** Sold prices around a postcode, fetched while `enabled`. */
export function useSoldNear(postcode: string, enabled: boolean): SoldNear {
  const [state, setState] = useState<SoldNear>({ status: 'off', data: null });
  useEffect(() => {
    if (!enabled) { setState({ status: 'off', data: null }); return; }
    let live = true;
    setState({ status: 'loading', data: null });
    api.data.sold(postcode, { years: 3 }).then(
      (data) => { if (live) setState({ status: 'ready', data }); },
      () => { if (live) setState({ status: 'failed', data: null }); },
    );
    return () => { live = false; };
  }, [postcode, enabled]);
  return state;
}

/** The range for a sale listing from real sold prices, or null when there isn't enough evidence (or it isn't loaded). */
export function useRealRange(near: SoldNear, type: PropertyType, price: number): EvidenceRange | null {
  return useMemo(() => {
    if (near.status !== 'ready' || !near.data || near.data.coverage !== 'england-wales') return null;
    const r = evidenceRange(near.data.sales, { type: soldTypeFor(type), price: price > 0 ? price : null });
    return r.basis === 'none' ? null : r;
  }, [near, type, price]);
}

/** Step 4 of the form, for a sale: the sold-price evidence. */
export function PriceEvidence({ near, range, type, price }: { near: SoldNear; range: EvidenceRange; type: PropertyType; price: number }) {
  const d = near.data!;
  const same = soldTypeFor(type);
  const like = range.basis === 'same-type' && same ? d.sales.filter((s) => s.type === same) : d.sales;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {price > 0 ? <EvidenceRangeCard range={range} price={price} /> : (
        <div className="card">
          <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}><h4 className="od-h" style={{ margin: 0 }}>What homes like this sold for nearby</h4><SourceTag>HM Land Registry</SourceTag></div>
          <p className="od-verdict" style={{ marginBottom: 0 }}>The middle half sold for <b className="num">{gbpK(range.low!)}</b> to <b className="num">{gbpK(range.high!)}</b> (median <b className="num">{gbpK(range.mid!)}</b>). Enter your price to see where it sits.</p>
          <p className="xs muted" style={{ margin: '8px 0 0' }}>{range.method[0]} Sold prices don’t record size or condition. Not a valuation.</p>
        </div>
      )}
      <details className="od-method">
        <summary>See the {Math.min(like.length, 10)} most recent sales</summary>
        <div style={{ marginTop: 8 }}><SoldTable sales={like.slice(0, 10)} first={10} caption="Recent sales near your postcode" /></div>
      </details>
      <Attribution lines={d.attribution} />
    </div>
  );
}

type Found = { status: 'idle' | 'searching' | 'list' | 'reading' | 'done' | 'error'; items: EpcSummary[]; message?: string; certificate?: EpcCertificate };
const numbersIn = (s: string) => (s.toUpperCase().match(/\b\d+[A-Z]?\b/g) ?? []).sort().join(' ');

/**
 * Step 2 of the form: look the home up on the EPC register. Only offered on the live site, to
 * signed-in people, when the site has access to the register. Picking a certificate fills in
 * the rating; nothing is filled in without the person choosing their address.
 */
export function EpcLookup({ postcode, addressLine, valid, onUse }: { postcode: string; addressLine: string; valid: boolean; onUse: (c: EpcCertificate) => void }) {
  const { online, user } = useServer();
  const [configured, setConfigured] = useState(false);
  const [found, setFound] = useState<Found>({ status: 'idle', items: [] });
  const [picked, setPicked] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  const name = useId();
  useEffect(() => { if (online) api.data.status().then((s) => setConfigured(s.epc), () => setConfigured(false)); }, [online]);
  // A different postcode means a different list.
  useEffect(() => { setFound({ status: 'idle', items: [] }); setPicked(''); }, [postcode]);
  if (!online || !configured) return null;
  if (!user) return <p className="xs muted">Sign in and Streetkey can find your certificate on the EPC register for you.</p>;

  const fail = (e: unknown) => setFound((f) => ({ ...f, status: 'error', message: e instanceof ApiError ? e.message : 'Couldn’t reach the EPC register. Please try again.' }));
  const search = async () => {
    setFound({ status: 'searching', items: [] });
    try {
      const { items } = await api.data.epcSearch(postcode);
      // Pre-select the address whose house and flat numbers match what was typed, when exactly one does.
      const want = numbersIn(addressLine);
      const match = want ? items.filter((i) => numbersIn(i.address.split(', ').slice(0, 2).join(' ')) === want) : [];
      setPicked(match.length === 1 ? match[0].certificateNumber : '');
      setFound({ status: 'list', items });
      requestAnimationFrame(() => status.current?.focus());
    } catch (e) { fail(e); }
  };
  const use = async () => {
    if (!picked) return;
    setFound((f) => ({ ...f, status: 'reading' }));
    try {
      const { certificate } = await api.data.epcCertificate(picked);
      setFound((f) => ({ ...f, status: 'done', certificate }));
      onUse(certificate);
      requestAnimationFrame(() => status.current?.focus());
    } catch (e) { fail(e); }
  };

  const c = found.certificate;
  return (
    <div className="card flat od-epc">
      <div className="row between" style={{ gap: 8 }}><b className="small">Find your certificate</b><SourceTag>EPC register</SourceTag></div>
      {(found.status === 'idle' || found.status === 'error' || found.status === 'searching') && (
        <>
          <p className="xs muted" style={{ margin: '6px 0 8px' }}>Streetkey can look up the energy certificates registered at {valid ? postcode : 'your postcode'} so you can pick yours.</p>
          <button type="button" className="btn ghost sm" aria-disabled={!valid || found.status === 'searching'} onClick={() => { if (valid && found.status !== 'searching') void search(); }}>
            {found.status === 'searching' ? 'Looking…' : 'Find my certificate'}
          </button>
          {!valid && <span className="xs muted" style={{ marginLeft: 8 }}>Enter your full postcode in step 1 first.</span>}
        </>
      )}
      {found.status === 'error' && <p className="small" role="alert" style={{ margin: '8px 0 0' }}>{found.message}</p>}
      {(found.status === 'list' || found.status === 'reading') && (found.items.length === 0 ? (
        <p ref={status} tabIndex={-1} className="small" style={{ margin: '8px 0 0' }}>No certificates are registered at {postcode}. If the home has never had one, it needs one before it can be marketed.</p>
      ) : (
        <>
          <p ref={status} tabIndex={-1} className="small" style={{ margin: '8px 0 6px' }}>{found.items.length} certificate{found.items.length === 1 ? '' : 's'} at {postcode}. Choose your address:</p>
          <div role="radiogroup" aria-label="Addresses with a certificate" className="od-epc-list">
            {found.items.map((i) => (
              <label key={i.certificateNumber} className="od-epc-item">
                <input type="radio" name={name} value={i.certificateNumber} checked={picked === i.certificateNumber} onChange={() => setPicked(i.certificateNumber)} />
                <span><b>{i.address}</b><span className="xs muted"> · rated {i.band ?? '?'}{i.registeredOn ? ` · ${fmtDate(i.registeredOn)}` : ''}</span></span>
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn sm" aria-disabled={!picked || found.status === 'reading'} onClick={() => { if (picked && found.status !== 'reading') void use(); }}>{found.status === 'reading' ? 'Reading…' : 'Use this certificate'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setFound({ status: 'idle', items: [] }); setPicked(''); }}>Cancel</button>
          </div>
        </>
      ))}
      {found.status === 'done' && c && (
        <p ref={status} tabIndex={-1} className="small" style={{ margin: '8px 0 0' }}>
          <b>Rating {c.band ?? 'not given'}{c.score != null ? ` (${c.score})` : ''}</b>{c.potentialBand ? `, potential ${c.potentialBand}` : ''}{c.registeredOn ? `, registered ${fmtDate(c.registeredOn)}` : ''}.
          {c.band ? ' The rating above has been filled in.' : ''}
          {c.expired && <> <b>This certificate is more than 10 years old and has expired:</b> you need a new one before marketing.</>}
          {' '}<button type="button" className="linkish" onClick={() => { setFound({ status: 'idle', items: [] }); setPicked(''); }}>Choose a different address</button>
        </p>
      )}
    </div>
  );
}
