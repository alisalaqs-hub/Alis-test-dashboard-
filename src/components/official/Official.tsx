/**
 * How Streetkey shows official open data: sold prices and the house price index (HM Land
 * Registry), flood risk (Environment Agency) and energy certificates. These are facts from
 * public registers, so they carry a "source" tag (never the AI or estimate tags) and the
 * attribution each licence asks for.
 */
import { useState, type ReactNode } from 'react';
import { FLOOD_BAND_MEANING, SOLD_TYPE_LABEL, type EvidenceRange, type FloodBand, type FloodResult, type FloodSource, type HpiSummary, type SoldSale, type SoldStats } from '../../engine/evidence';
import { gbp, gbpK, Spark, Stat } from '../ui';
import '../../styles/official.css';

export const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtMonth = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const distance = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1609.34).toFixed(1)} miles`);

/** The tag for facts from an official register. */
export function SourceTag({ children }: { children: ReactNode }) {
  return <span className="tag tag-source" title="From an official public register, not an estimate">{children}</span>;
}

/** Licence wording, shown wherever the data is. */
export function Attribution({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <p className="od-attribution xs muted">{lines.join(' ')}</p>;
}

/** The three headline figures for the last 12 months. */
export function SoldSummary({ stats, where }: { stats: SoldStats; where: string }) {
  return (
    <div className="grid g3">
      <div className="card"><Stat label="Sales in the last 12 months" value={stats.count} sub={where} /></div>
      <div className="card"><Stat label="Median sold price (12 months)" value={stats.median != null ? gbpK(stats.median) : '—'} sub={stats.median != null ? 'Half sold for more, half for less' : 'No sales in the last 12 months'} /></div>
      <div className="card"><Stat label="Middle half of sales" value={stats.low != null && stats.high != null ? `${gbpK(stats.low)} – ${gbpK(stats.high)}` : '—'} sub="A quarter sold below this range and a quarter above" /></div>
    </div>
  );
}

/** Median by property type and by year. */
export function SoldBreakdown({ stats }: { stats: SoldStats }) {
  const years = stats.byYear.slice(-6);
  const top = Math.max(1, ...years.map((y) => y.median));
  return (
    <div className="grid g2">
      <div className="card">
        <h3 className="od-h">By property type <span className="xs muted">last 12 months</span></h3>
        {stats.byType.length === 0 ? <p className="small muted">No sales in the last 12 months.</p> : (
          <table className="t"><thead><tr><th>Type</th><th className="r">Sales</th><th className="r">Median price</th></tr></thead>
            <tbody>{stats.byType.map((t) => <tr key={t.type}><td>{SOLD_TYPE_LABEL[t.type]}</td><td className="r num">{t.count}</td><td className="r num">{gbp(t.median)}</td></tr>)}</tbody></table>
        )}
      </div>
      <div className="card">
        <h3 className="od-h">Year by year <span className="xs muted">median of all sales found</span></h3>
        {years.length === 0 ? <p className="small muted">No sales found.</p> : (
          <ul className="od-years" aria-label="Median sold price by year">
            {years.map((y) => (
              <li key={y.year}>
                <span className="od-year num">{y.year}</span>
                <span className="od-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, (y.median / top) * 100)}%` }} /></span>
                <span className="num">{gbpK(y.median)}</span>
                <span className="xs muted">{y.count} sale{y.count === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The official House Price Index for the local authority. */
export function HpiCard({ hpi }: { hpi: HpiSummary }) {
  const change = hpi.annualChangePct;
  return (
    <div className="card od-hpi">
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <h3 className="od-h" style={{ margin: 0 }}>{hpi.district}: average price</h3>
        <SourceTag>UK House Price Index</SourceTag>
      </div>
      <div className="od-hpi-main">
        <div>
          <div className="od-big num">{gbp(hpi.averagePrice)}</div>
          <div className="small muted">{fmtMonth(hpi.month)}{change != null && <> · <b className={change >= 0 ? 'od-up' : 'od-down'}>{change >= 0 ? 'up' : 'down'} {Math.abs(change).toFixed(1)}%</b> in a year</>}</div>
        </div>
        {hpi.series.length > 2 && <div className="od-spark" role="img" aria-label={`Average price over ${hpi.series.length} months, from ${gbpK(hpi.series[0].averagePrice)} to ${gbpK(hpi.series[hpi.series.length - 1].averagePrice)}`}><Spark data={hpi.series.map((s) => s.averagePrice)} height={44} /></div>}
      </div>
      {hpi.byType.length > 0 && <dl className="od-types">{hpi.byType.map((t) => <div key={t.type}><dt>{SOLD_TYPE_LABEL[t.type]}</dt><dd className="num">{gbpK(t.averagePrice)}</dd></div>)}</dl>}
      <p className="xs muted" style={{ margin: '8px 0 0' }}>The whole local authority, all sales, as published by HM Land Registry and the Office for National Statistics.</p>
    </div>
  );
}

/** The list of sales. Shows `first` rows, with a button for the rest. */
export function SoldTable({ sales, first = 25, showDistance = true, caption }: { sales: SoldSale[]; first?: number; showDistance?: boolean; caption: string }) {
  const [shown, setShown] = useState(first);
  const rows = sales.slice(0, shown);
  const anyDistance = showDistance && sales.some((s) => s.distanceM != null);
  return (
    <>
      <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
        <table className="t od-sales">
          <caption className="sr-only">{caption}</caption>
          <thead><tr><th>Address</th><th>Type</th><th className="r">Sold for</th><th>Date</th>{anyDistance && <th className="r">Distance</th>}</tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><b>{s.address}</b><div className="xs muted">{[s.town, s.postcode].filter(Boolean).join(' · ')}</div></td>
                <td className="small">{SOLD_TYPE_LABEL[s.type]}<div className="xs muted">{[s.tenure === 'leasehold' ? 'Leasehold' : s.tenure === 'freehold' ? 'Freehold' : null, s.newBuild ? 'New build' : null].filter(Boolean).join(' · ')}</div></td>
                <td className="r num">{gbp(s.price)}</td>
                <td className="small od-nowrap">{fmtDate(s.date)}</td>
                {anyDistance && <td className="r small od-nowrap">{s.distanceM != null ? distance(s.distanceM) : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < sales.length && <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShown((n) => n + 50)}>Show {Math.min(50, sales.length - shown)} more</button>}
    </>
  );
}

/** Where an asking price sits against nearby sold prices. */
export function EvidenceRangeCard({ range, price }: { range: EvidenceRange; price: number }) {
  if (range.basis === 'none' || range.low == null || range.mid == null || range.high == null) {
    return <div className="card"><h3 className="od-h">Asking price against sold prices</h3><p className="small muted" style={{ margin: 0 }}>{range.method[0]}</p></div>;
  }
  const lo = Math.min(range.low, price) * 0.94, hi = Math.max(range.high, price) * 1.06;
  const at = (v: number) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const vs = range.askingVsMid ?? 0;
  const verdict = range.position === 'above' ? 'above the middle half of nearby sales' : range.position === 'below' ? 'below the middle half of nearby sales' : 'within the middle half of nearby sales';
  return (
    <div className="card od-range">
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <h3 className="od-h" style={{ margin: 0 }}>Asking price against sold prices</h3>
        <SourceTag>HM Land Registry</SourceTag>
      </div>
      <p className="od-verdict">The asking price of <b className="num">{gbp(price)}</b> is <b>{verdict}</b>{Math.abs(vs) >= 0.005 && <> ({Math.abs(vs * 100).toFixed(0)}% {vs > 0 ? 'above' : 'below'} the median)</>}.</p>
      <div className="od-scale" role="img" aria-label={`Middle half of nearby sales: ${gbp(range.low)} to ${gbp(range.high)}, median ${gbp(range.mid)}. Asking price ${gbp(price)}.`}>
        <i className="od-band" style={{ left: at(range.low), width: `calc(${at(range.high)} - ${at(range.low)})` }} />
        <i className="od-mid" style={{ left: at(range.mid) }} />
        <i className={`od-ask ${range.position}`} style={{ left: at(price) }} />
      </div>
      <div className="od-scale-labels small"><span><span className="num">{gbpK(range.low)}</span> – <span className="num">{gbpK(range.high)}</span> <span className="muted">middle half</span></span><span><span className="muted">median</span> <span className="num">{gbpK(range.mid)}</span></span></div>
      <p className="xs muted" style={{ margin: '8px 0 0' }}>
        {range.basis === 'all-types'
          ? `A rough guide: too few ${range.type ? SOLD_TYPE_LABEL[range.type].toLowerCase() : 'similar'} homes sold nearby, so this compares with ${range.count} homes of all types sold in the last ${range.months} months.`
          : `Compared with ${range.count} ${range.type ? SOLD_TYPE_LABEL[range.type].toLowerCase() : ''} homes sold nearby in the last ${range.months} months.`}
        {' '}Sold prices don’t record size or condition. Not a valuation.
      </p>
      <details className="od-method"><summary>How this is worked out</summary><ul>{range.method.map((m) => <li key={m}>{m}</li>)}</ul></details>
    </div>
  );
}

const BAND_LABEL: Record<FloodBand, string> = { high: 'High', medium: 'Medium', low: 'Low', 'very low': 'Very low' };
export function FloodBandTag({ band }: { band: FloodBand }) {
  return <span className={`od-flood od-flood-${band.replace(' ', '-')}`}>{BAND_LABEL[band]}</span>;
}
function FloodRow({ title, about, source }: { title: string; about: string; source: FloodSource | null }) {
  return (
    <div className="od-flood-row">
      <div><b>{title}</b><div className="xs muted">{about}</div></div>
      {source ? (
        <div className="od-flood-bands">
          <div><FloodBandTag band={source.here} /><div className="xs muted">here: {FLOOD_BAND_MEANING[source.here]}</div></div>
          {source.nearby !== source.here && <div><FloodBandTag band={source.nearby} /><div className="xs muted">highest within 100 m</div></div>}
        </div>
      ) : <div className="small muted">The Environment Agency’s map couldn’t be read just now. Try again later.</div>}
    </div>
  );
}

/** Long-term flood risk and any warnings in force. */
export function FloodCard({ flood, where }: { flood: FloodResult; where?: string }) {
  if (flood.coverage === 'not-covered') {
    return (
      <div className="card od-floodcard">
        <h3 className="od-h">Flood risk</h3>
        <p className="small" style={{ margin: 0 }}>The Environment Agency’s flood maps cover England only. For {flood.country ?? 'this area'}, check {flood.country === 'Wales' ? 'Natural Resources Wales' : flood.country === 'Scotland' ? 'SEPA’s flood maps' : flood.country === 'Northern Ireland' ? 'the Department for Infrastructure’s flood maps' : 'the national flood maps'}.</p>
      </div>
    );
  }
  return (
    <div className="card od-floodcard">
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <h3 className="od-h" style={{ margin: 0 }}>Flood risk{where ? ` at ${where}` : ''}</h3>
        <SourceTag>Environment Agency</SourceTag>
      </div>
      {flood.warnings.length > 0 && (
        <div className="callout od-warning" role="status">
          {flood.warnings.map((w) => <p key={w.area + w.severity} style={{ margin: '0 0 4px' }}><b>{w.severity}: {w.area}.</b> {w.message}</p>)}
        </div>
      )}
      <FloodRow title="Rivers and the sea" about="Long-term risk, taking flood defences into account" source={flood.riversAndSea} />
      <FloodRow title="Surface water" about="Heavy rain that can’t drain away fast enough" source={flood.surfaceWater} />
      {flood.warnings.length === 0 && <p className="small" style={{ margin: '10px 0 0' }}>No flood alerts or warnings are in force nearby.</p>}
      {flood.warningAreas.length > 0 && <p className="xs muted" style={{ margin: '6px 0 0' }}>Flood warning areas within about 1 km: {flood.warningAreas.join('; ')}.</p>}
      <p className="xs muted" style={{ margin: '8px 0 0' }}>
        {flood.approximate ? 'Read at the centre of the postcode, not at the building itself. ' : ''}
        Long-term risk is the chance of flooding in any year, from the Environment Agency’s national assessment. It isn’t a survey: for a purchase, ask your conveyancer for a flood report.
      </p>
    </div>
  );
}
