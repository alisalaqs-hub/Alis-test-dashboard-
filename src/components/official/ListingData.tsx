/**
 * Official data for a live listing: where the asking price sits against nearby sold prices,
 * what sold nearby, the area's average price, flood risk and the energy certificate.
 * Loaded once per listing from /api/data/listings/:ref; nothing here is an estimate.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { OfficialListingDTO } from '../../lib/apiTypes';
import { gbpK, Section, Stat } from '../ui';
import { Attribution, EvidenceRangeCard, FloodBandTag, FloodCard, fmtDate, HpiCard, SoldTable, SourceTag } from './Official';

export type OfficialState = { status: 'off' | 'loading' | 'ready' | 'failed'; data: OfficialListingDTO | null; message?: string; retry: () => void };

/** Fetches the listing's official data when `enabled` (a live listing on the live site). */
export function useOfficialListing(ref: string, enabled: boolean): OfficialState {
  const [state, setState] = useState<Omit<OfficialState, 'retry'>>({ status: enabled ? 'loading' : 'off', data: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ status: 'off', data: null }); return; }
    let live = true;
    setState({ status: 'loading', data: null });
    api.data.listing(ref).then(
      (data) => { if (live) setState({ status: 'ready', data }); },
      (e) => { if (live) setState({ status: 'failed', data: null, message: e instanceof ApiError ? e.message : 'Something went wrong.' }); },
    );
    return () => { live = false; };
  }, [ref, enabled, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** One line for the "Material information" list: the overall flood band, or what's happening. */
export function FloodValue({ official }: { official: OfficialState }) {
  if (official.status === 'loading') return <span className="muted">Checking…</span>;
  const f = official.data?.flood;
  if (!f) return <span className="muted">Not available just now</span>;
  if (f.coverage === 'not-covered') return <span className="muted">Not covered by the Environment Agency’s maps</span>;
  if (!f.overall) return <span className="muted">Not available just now</span>;
  return <><FloodBandTag band={f.overall} /> <span className="xs muted">Environment Agency</span></>;
}

/** The energy certificate line: what the lister entered, checked against the register when possible. */
export function EpcValue({ entered, official }: { entered: string; official: OfficialState }) {
  const e = official.data?.epc;
  if (!e || !e.band) return <>{entered} <span className="xs muted">as given by the lister</span></>;
  return (
    <>
      {e.band}{e.potentialBand && e.potentialBand !== e.band ? ` → potential ${e.potentialBand}` : ''}{' '}
      <span className="xs muted">EPC register{e.registeredOn ? `, ${fmtDate(e.registeredOn)}` : ''}{e.expired ? ' (expired: over 10 years old)' : ''}</span>
      {e.matchesListing === false && <div className="xs" style={{ color: 'var(--gold)' }}>The lister entered {entered}; the register shows {e.band}.</div>}
    </>
  );
}

/** The "Price check" figure on a real listing: where the asking price sits against nearby sold prices. */
export function PriceCheckStat({ official }: { official: OfficialState }) {
  const label = <>Price check <SourceTag>Sold prices</SourceTag></>;
  if (official.status === 'loading') return <Stat label={label} value="Checking…" sub="HM Land Registry sold prices" />;
  const r = official.data?.range;
  if (!r || r.basis === 'none' || r.low == null || r.high == null) return <Stat label={label} value="Not enough sales" sub="nearby to compare with" />;
  const value = r.position === 'above' ? 'Above local range' : r.position === 'below' ? 'Below local range' : 'Within local range';
  return <Stat label={label} value={value} sub={`Nearby sales ${gbpK(r.low)}–${gbpK(r.high)}${r.basis === 'all-types' ? ' (all types)' : ''}`} />;
}

export function OfficialListingPanel({ official, price, rental, where }: { official: OfficialState; price: number; rental: boolean; where: string }) {
  if (official.status === 'off') return null;
  if (official.status === 'loading') {
    return <Section title="Sold prices and flood risk" kicker="Official data"><p className="od-status" role="status">Getting sold prices from HM Land Registry and flood risk from the Environment Agency…</p></Section>;
  }
  if (official.status === 'failed' || !official.data) {
    return (
      <Section title="Sold prices and flood risk" kicker="Official data">
        <p className="small" style={{ margin: 0 }}>{official.message ?? 'This couldn’t be loaded just now.'}</p>
        <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={official.retry}>Try again</button>
      </Section>
    );
  }
  const d = official.data;
  const sold = d.sold;
  return (
    <>
      {!rental && d.range && <EvidenceRangeCard range={d.range} price={price} />}
      {sold && sold.coverage === 'england-wales' && (
        <Section title={`What sold nearby${sold.stats.median != null ? `: median ${gbpK(sold.stats.median)}` : ''}`} kicker={`${sold.totalSales} sale${sold.totalSales === 1 ? '' : 's'} in ${sold.years} years, within about ${sold.radiusM} m`} right={<SourceTag>HM Land Registry</SourceTag>}>
          {sold.totalSales === 0 ? <p className="small muted" style={{ margin: 0 }}>{sold.partial ? 'HM Land Registry couldn’t be reached just now.' : 'No sales were registered nearby in that time.'}</p> : (
            <>
              <SoldTable sales={sold.sales} first={8} caption={`Homes sold near ${where}, most recent first`} />
              <p className="xs muted" style={{ margin: '8px 0 0' }}>
                {sold.stats.count} sold in the last 12 months{sold.stats.low != null && sold.stats.high != null ? `; the middle half went for ${gbpK(sold.stats.low)} to ${gbpK(sold.stats.high)}` : ''}.
                Sold prices don’t record size or condition. <Link to={`/prices?q=${encodeURIComponent(where)}`}>More sold prices in this area</Link>
              </p>
            </>
          )}
        </Section>
      )}
      {sold?.hpi && <HpiCard hpi={sold.hpi} />}
      {d.flood && <FloodCard flood={d.flood} />}
      <Attribution lines={d.attribution} />
    </>
  );
}
