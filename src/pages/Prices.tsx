import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Attribution, HpiCard, SoldBreakdown, SoldSummary, SoldTable, SourceTag } from '../components/official/Official';
import { gbp, gbpK, Section, Spark, Stat, Tag } from '../components/ui';
import { PROPERTIES } from '../data/properties';
import { SOLD_TYPE_LABEL, type SoldType } from '../engine/evidence';
import { api, ApiError } from '../lib/api';
import type { SoldPricesDTO } from '../lib/apiTypes';
import { useServer } from '../lib/server';

const EXAMPLES = ['E17 4PP', 'M20', 'Leeds', 'Bristol', 'Croydon', 'Cardiff'];
type State = { kind: 'idle' } | { kind: 'loading'; q: string } | { kind: 'done'; q: string; data: SoldPricesDTO } | { kind: 'error'; q: string; message: string; notFound: boolean };

/**
 * Sold prices: what homes actually sold for, from HM Land Registry's Price Paid Data, with the
 * official House Price Index for the local authority. On the static preview (no server) the page
 * falls back to the demonstration sales, clearly labelled.
 */
export default function Prices() {
  const { status } = useServer();
  const [params, setParams] = useSearchParams();
  const term = (params.get('q') ?? '').trim();
  const [q, setQ] = useState(term);
  useEffect(() => { setQ(term); }, [term]);
  const search = (text: string) => { const t = text.trim(); setParams(t ? { q: t } : {}); };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Sold prices</div>
          <h2 style={{ marginTop: 6 }}>What homes really sold for</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>Every sale registered with HM Land Registry in England and Wales, with the official average price for the area.</p>
        </div>
        <div className="row">{status === 'offline' ? <Tag kind="demo">Demo sales</Tag> : <SourceTag>HM Land Registry</SourceTag>}</div>
      </div>
      <form className="smart-box" style={{ maxWidth: 640 }} role="search" onSubmit={(e) => { e.preventDefault(); search(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={80} placeholder="Postcode, district or town, e.g. E17 4PP, E17 or Leeds" aria-label="Postcode, postcode district or town" autoComplete="postal-code" enterKeyHint="search" />
        <button className="smart-go" type="submit">Show prices</button>
      </form>
      <div className="chips" role="group" aria-label="Examples">{EXAMPLES.map((c) => <button key={c} type="button" className="chip" onClick={() => search(c)}>{c}</button>)}</div>
      {status === 'offline' ? <DemoSales term={term} /> : status === 'checking' ? <p className="od-status" role="status">Connecting…</p> : <LiveSales term={term} />}
    </div>
  );
}

function LiveSales({ term }: { term: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [type, setType] = useState<SoldType | 'all'>('all');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!term) { setState({ kind: 'idle' }); return; }
    let live = true;
    setState({ kind: 'loading', q: term }); setType('all');
    api.data.sold(term).then(
      (data) => { if (live) setState({ kind: 'done', q: term, data }); },
      (e) => { if (live) setState({ kind: 'error', q: term, notFound: e instanceof ApiError && e.code === 'place_not_found', message: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' }); },
    );
    return () => { live = false; };
  }, [term, attempt]);

  // When results arrive, move focus to their heading so keyboard and screen reader users land on them.
  const doneFor = state.kind === 'done' ? state.q : null;
  useEffect(() => { if (doneFor) heading.current?.focus({ preventScroll: true }); }, [doneFor]);

  const data = state.kind === 'done' ? state.data : null;
  const types = useMemo(() => (data ? [...new Set(data.sales.map((s) => s.type))] : []), [data]);
  const sales = useMemo(() => (data ? data.sales.filter((s) => type === 'all' || s.type === type) : []), [data, type]);

  if (state.kind === 'idle') return <p className="small muted">Enter a postcode, a postcode district or a town to see what homes there sold for.</p>;
  if (state.kind === 'loading') return <p className="od-status" role="status">Getting sold prices near “{state.q}” from HM Land Registry. The first look at an area can take a few seconds…</p>;
  if (state.kind === 'error') {
    return (
      <div className="callout" role="alert">
        <p style={{ margin: 0 }}>{state.message}</p>
        {!state.notFound && <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
      </div>
    );
  }
  const d = state.data;
  const where = d.place.kind === 'postcode' ? `within ${d.radiusM} m of ${d.place.label}` : `within about ${d.radiusM} m of the centre of ${d.place.label}`;

  if (d.coverage === 'not-covered') {
    return (
      <>
        <h3 ref={heading} tabIndex={-1} className="od-h" style={{ fontSize: 18 }}>{d.place.label}</h3>
        <div className="callout info">
          <p style={{ margin: 0 }}>HM Land Registry’s sold prices cover England and Wales. {d.place.country === 'Scotland' ? 'Sales in Scotland are recorded by Registers of Scotland.' : d.place.country === 'Northern Ireland' ? 'Sales in Northern Ireland are recorded by Land & Property Services.' : ''}</p>
        </div>
        {d.hpi && <HpiCard hpi={d.hpi} />}
        <Attribution lines={d.attribution} />
      </>
    );
  }

  return (
    <>
      <h3 ref={heading} tabIndex={-1} className="od-h" style={{ fontSize: 18, margin: 0 }}>
        Sold prices near {d.place.label}
        <span className="xs muted">{d.place.district ? `${d.place.district} · ` : ''}{where}</span>
      </h3>
      <p className="sr-only" role="status">{d.totalSales} sales found {where} in the last {d.years} years.</p>
      {d.partial && (
        <div className="callout" role="status">
          HM Land Registry couldn’t be reached for part of this area just now, so {d.totalSales === 0 ? 'no sales can be shown yet' : 'some sales may be missing'}.
          <button type="button" className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      )}
      <SoldSummary stats={d.stats} where={where} />
      <SoldBreakdown stats={d.stats} />
      {d.hpi && <HpiCard hpi={d.hpi} />}
      <Section title={`${d.totalSales} sale${d.totalSales === 1 ? '' : 's'} in the last ${d.years} years`} kicker="Most recent first" right={<SourceTag>HM Land Registry</SourceTag>}>
        {d.totalSales === 0 ? (
          <p className="small muted">{d.partial ? 'Nothing to show until HM Land Registry answers.' : 'No sales were registered here in that time. Try a nearby postcode or the town.'}</p>
        ) : (
          <>
            {types.length > 1 && (
              <div className="chips od-filter" role="group" aria-label="Show property type" style={{ marginBottom: 10 }}>
                {(['all', ...types] as (SoldType | 'all')[]).map((t) => <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>{t === 'all' ? 'All types' : SOLD_TYPE_LABEL[t]}</button>)}
              </div>
            )}
            <SoldTable key={`${d.place.label}-${type}`} sales={sales} caption={`Homes sold near ${d.place.label}, most recent first`} />
            {d.totalSales > d.sales.length && <p className="xs muted" style={{ marginTop: 8 }}>Showing the {d.sales.length} most recent of {d.totalSales} sales. The figures above use all of them.</p>}
          </>
        )}
      </Section>
      <p className="xs muted" style={{ margin: 0 }}>
        Sales appear here once HM Land Registry has registered them, usually two weeks to two months after completion. Commercial sales and transfers that weren’t ordinary sales are left out.
        Sold prices don’t record size or condition, so compare like with like. Not a valuation.
      </p>
      <Attribution lines={d.attribution} />
    </>
  );
}

/** The static preview has no server: show the demonstration sales, labelled as such. */
function DemoSales({ term }: { term: string }) {
  const t = term.toLowerCase();
  const rows = useMemo(() => PROPERTIES.filter((p) => !p.source).filter((p) => !t || p.town.toLowerCase().includes(t) || p.district.toLowerCase() === t || p.postcode.toLowerCase().startsWith(t)).flatMap((p) => [
    ...p.comparables.filter((c) => c.kind === 'sold').map((c) => ({ key: p.id + c.address, address: c.address, area: `${p.town.split(',')[0]} · ${p.district}`, beds: c.beds, price: c.price, date: c.date, note: c.refurbished ? 'Refurbished' : 'Unmodernised', near: p })),
    ...p.priceHistory.filter((h) => h.event === 'Sold').map((h) => ({ key: p.id + h.date, address: p.street, area: `${p.town.split(',')[0]} · ${p.district}`, beds: p.beds, price: h.price, date: h.date, note: 'Previous sale', near: p })),
  ]).sort((a, b) => b.date.localeCompare(a.date)), [t]);
  const recent = rows.filter((r) => r.date >= '2025-11');
  const sorted = [...recent].map((r) => r.price).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const idx = rows[0]?.near.areaIndex;
  return (
    <>
      <div className="callout info">This preview has no connection to the live site, so these are <b>demonstration sales</b> for fictional homes. The live site shows real sold prices from HM Land Registry.</div>
      <div className="grid g3">
        <div className="card"><Stat label="Sales in the last 12 months" value={recent.length} sub={term ? `in “${term}”` : 'all demo areas'} /></div>
        <div className="card"><Stat label="Median sold price (12m)" value={median ? gbpK(median) : '—'} /></div>
        <div className="card"><Stat label="Area trend (24m)" value={idx ? `${(idx[23] - 100).toFixed(1)}%` : '—'} />{idx && <Spark data={idx} height={36} />}</div>
      </div>
      <Section title={`${rows.length} demo sales`} kicker="Most recent first" right={<Tag kind="demo" />}>
        {rows.length === 0 ? <p className="small muted">No demo sales for that search. Try Walthamstow, Croydon, Manchester, Leeds, Bristol, Cardiff or Glasgow.</p> :
          <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Address</th><th>Beds</th><th className="r">Price</th><th>Date</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key}><td className="small"><b>{r.address.replace(' (fictional)', '')}</b><div className="xs muted">{r.area} · {r.note} · <Link to={`/property/${r.near.id}`}>nearby listing</Link></div></td><td className="num">{r.beds}</td><td className="r num">{gbp(r.price)}</td><td className="small">{r.date}</td></tr>)}</tbody></table></div>}
      </Section>
    </>
  );
}
