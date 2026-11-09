import { Fragment, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProperty, PROPERTIES, type Property } from '../data/properties';
import { dealScore, epcPathway, loftScenario, ownershipForecast, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { transactionTax } from '../engine/tax';
import { gbp, gbpK, HouseArt, Meter, pct, Section, Spark, Stat, Tag } from '../components/ui';
import { valuationScenario, rentalScenario } from '../engine/valuation';
import { developmentOptions } from '../engine/development';
import { engagementFor, insightsFor, totals, benchmark } from '../engine/engagement';
import { AssistantPanel } from '../components/Assistant';
import { propertySkills } from '../ai/skills';
import { KnowledgeGraph } from '../components/KnowledgeGraph';

function extensionScenario(p: Property) {
  if (p.extensionPotential === 'none' || p.type === 'flat') return null;
  const area = p.extensionPotential === 'strong' ? 18 : 12;
  const base = refurbInputFor(p);
  const e = estimateRefurb({ ...base, bathrooms: 0, condition: 'fair', scope: { ...base.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', kitchen: false, windows: false, roof: 'none', flooring: false, decoration: false, damp: false, external: false, insulation: false, structuralOpenings: 1, ensuites: 0, extensionArea: area } });
  const valueUplift = Math.round(p.estGdv * (area / p.floorArea) * 0.85);
  return { area, cost: e.total, valueUplift, net: valueUplift - e.total };
}

function offerRange(p: Property) {
  const soldComps = p.comparables.filter((c) => c.kind === 'sold' && !c.refurbished);
  const anchor = soldComps.length ? soldComps.reduce((s, c) => s + c.price, 0) / soldComps.length : p.price * 0.97;
  const leverage = Math.min(0.06, p.daysOnMarket / 1500 + (p.priceHistory.some((h) => h.event === 'Reduced') ? 0.015 : 0));
  const low = Math.round(Math.min(anchor, p.price * (1 - leverage - 0.03)) / 1000) * 1000;
  const high = Math.round(p.price * (1 - leverage / 2) / 1000) * 1000;
  return { low, high, leverage };
}

function useCtx(p: Property) {
  return useMemo(() => {
    const est = estimateRefurb(refurbInputFor(p));
    const ds = dealScore(p);
    return { est, ds, loft: loftScenario(p), ext: extensionScenario(p), epc: epcPathway(p), offer: offerRange(p), own: ownershipForecast(p) };
  }, [p]);
}

export default function PropertyPage() {
  const { id = 'wal-001' } = useParams();
  const p = getProperty(id) ?? PROPERTIES[0];
  const ctx = useCtx(p);
  const val = useMemo(() => valuationScenario(p), [p]);
  const rent = useMemo(() => rentalScenario(p), [p]);
  const dev = useMemo(() => developmentOptions(p), [p]);
  const eng = useMemo(() => ({ t: totals(engagementFor(p)), bm: benchmark(p), ins: insightsFor(p) }), [p]);
  const tax = transactionTax(p.price, p.nation, 'additional');
  const rental = p.listing === 'rent';
  const { est, ds } = ctx;
  const plays = [
    { name: 'Refurbish & resell / refinance', cost: est.total, uplift: p.estGdv - p.price, net: ds.uplift },
    ctx.loft && { name: `+ Loft conversion (~${ctx.loft.area}m²)`, cost: ctx.loft.cost, uplift: ctx.loft.valueUplift, net: ctx.loft.net },
    ctx.ext && { name: `+ Rear/side extension (~${ctx.ext.area}m²)`, cost: ctx.ext.cost, uplift: ctx.ext.valueUplift, net: ctx.ext.net },
  ].filter(Boolean) as { name: string; cost: number; uplift: number; net: number }[];
  const own = ctx.own;
  // A listing someone imported from another site (or keeps private) has no Streetkey visitors: no engagement figures for it.
  const imported = p.source?.kind === 'external-link';
  const showEngagement = !rental && !imported && p.visibility !== 'private';
  const originalUrl = p.source?.url && /^https?:\/\//i.test(p.source.url) ? p.source.url : null;
  const ownMax = Math.max(...own.map((y) => y.mortgage + y.councilTax + y.energy + y.maintenance + y.insurance));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row small muted"><Link to="/search">← Search</Link><span>/</span><Link to={`/property/${p.id}`}>Listing</Link><span>/</span><span>Intelligence profile</span></div>
      <div className="grid g2" style={{ gap: 20 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', minHeight: 260 }}><HouseArt hue={p.photoHue} type={p.type} /></div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="row">{p.source ? <Tag kind={p.source.kind === 'agent-feed' ? 'ok' : 'neutral'}>{p.source.name}</Tag> : <Tag kind="demo">Fictional listing</Tag>}{p.source && !p.source.verified && !imported && <Tag kind="demo">Verification pending</Tag>}{p.visibility === 'private' && <Tag kind="neutral">Private to you</Tag>}{p.listing === 'auction' && <Tag kind="warn">Auction · guide price</Tag>}<Tag kind="neutral">{p.tenure}{p.leaseYears ? ` · ${p.leaseYears} yrs` : ''}</Tag><Tag kind="neutral">Council tax {p.councilTax}</Tag></div>
          <h2>{p.title}</h2>
          <div className="muted">{p.street}, {p.town} · {p.postcode}</div>
          {originalUrl && <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="small">View the original listing ↗<span className="sr-only"> (opens in a new tab)</span></a>}
          {imported && <p className="xs muted" style={{ margin: 0 }}>Imported by you from another website and private to you. Figures below are Streetkey estimates from the details you checked, not the original listing’s.</p>}
          <div className="row" style={{ alignItems: 'flex-end', gap: 18 }}>
            <Stat big label={rental ? 'Rent' : p.listing === 'auction' ? 'Guide price' : 'Asking price'} value={rental ? `${gbp(p.price)}` : gbp(p.price)} sub={rental ? 'per calendar month' : `${gbp(p.price / p.floorArea)}/m² · ${p.daysOnMarket} days on market`} />
            {!rental && <div className="row" style={{ gap: 10 }}><div className={`grade grade-${ds.grade}`} style={{ width: 64, height: 64, fontSize: '2rem' }}>{ds.grade}</div><div><div className="num" style={{ fontSize: 22 }}>{ds.total}/100</div><div className="xs muted">Streetkey deal score</div></div></div>}
          </div>
          <div className="grid g3" style={{ gap: 10 }}>
            <div className="card flat" style={{ padding: 12 }}><div className="xs muted">Beds / baths</div><div className="num">{p.beds} / {p.baths}</div></div>
            <div className="card flat" style={{ padding: 12 }}><div className="xs muted">Floor area</div><div className="num">{p.floorArea}m²</div></div>
            <div className="card flat" style={{ padding: 12 }}><div className="xs muted">EPC</div><div className="num">{p.epc.current} → {p.epc.potential}</div></div>
          </div>
          <div className="row">
            <Link className="btn" to={`/estimate?property=${p.id}`}>Refine refurb estimate</Link>
            <Link className="btn ghost" to={`/invest?property=${p.id}`}>Underwrite investment</Link>
            <Link className="btn ghost" to={`/studio?property=${p.id}`}>Visualise</Link>
          </div>
        </div>
      </div>

      {!rental && (
        <div className="grid g4 keep2">
          <div className="card"><Stat label={<>Refurb estimate <Tag kind="est" /></>} value={gbpK(est.total)} sub={`${gbpK(est.low)}–${gbpK(est.high)} · ${est.confidence} confidence`} /></div>
          <div className="card"><Stat label={<>Post-works value <Tag kind="est" /></>} value={gbpK(p.estGdv)} sub="From refurbished sold comparables" /></div>
          <div className="card"><Stat label="Indicative value-add" value={gbpK(ds.uplift)} tone={ds.uplift >= 0 ? 'pos' : 'neg'} sub={`After refurb & ≈4% purchase costs`} /></div>
          <div className="card"><Stat label="Gross yield (all-in)" value={pct(ds.grossYield)} sub={`Est. rent ${gbp(p.estRentPcm)} pcm`} /></div>
        </div>
      )}

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          {!rental && <Section title="Value-add plays" kicker="Engine-costed scenarios" right={<Tag kind="est" />}>
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Play</th><th className="r">Cost (incl. VAT)</th><th className="r">Value uplift</th><th className="r">Net</th></tr></thead>
              <tbody>{plays.map((pl) => <tr key={pl.name}><td>{pl.name}</td><td className="r num">{gbpK(pl.cost)}</td><td className="r num">{gbpK(pl.uplift)}</td><td className={`r num ${pl.net >= 0 ? 'pos' : 'neg'}`}>{gbpK(pl.net)}</td></tr>)}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 10 }}>Value uplift for lofts/extensions uses a demo heuristic (share of GDV) pending a calibrated hedonic model from Land Registry + EPC floor-area data. Costs from {est.basis.version}.</p>
          </Section>}

          {!rental && p.type !== 'commercial' && <Section title="Valuation scenarios" kicker="Is it overpriced?" right={<Tag kind="est">Indicative · not RICS</Tag>}>
            <div className="grid g3">
              <Stat label="As-is range" value={`${gbpK(val.asIs.low)}–${gbpK(val.asIs.high)}`} sub={`Mid ${gbpK(val.asIs.mid)}`} />
              <Stat label="Post-works range" value={`${gbpK(val.postWorks.low)}–${gbpK(val.postWorks.high)}`} sub={`Mid ${gbpK(val.postWorks.mid)}`} />
              <Stat label="Asking vs as-is mid" value={`${val.askingVsMid >= 0 ? '+' : ''}${pct(val.askingVsMid)}`} tone={val.verdict === 'above range' ? 'neg' : val.verdict === 'below range' ? 'pos' : undefined} sub={`${val.verdict} · ${val.confidence} confidence`} />
            </div>
            <div style={{ position: 'relative', height: 34, margin: '18px 0 6px', background: 'var(--surface-2)', borderRadius: 8 }}>
              {(() => { const lo = Math.min(val.asIs.low, p.price) * 0.95; const hi = Math.max(val.postWorks.high, p.price) * 1.02; const x = (n: number) => `${((n - lo) / (hi - lo)) * 100}%`; return <>
                <div title="As-is range" style={{ position: 'absolute', left: x(val.asIs.low), width: `calc(${x(val.asIs.high)} - ${x(val.asIs.low)})`, top: 6, height: 22, background: 'var(--blue-soft)', border: '1px solid var(--blue)', borderRadius: 6 }} />
                <div title="Post-works range" style={{ position: 'absolute', left: x(val.postWorks.low), width: `calc(${x(val.postWorks.high)} - ${x(val.postWorks.low)})`, top: 6, height: 22, background: 'var(--sage-soft)', border: '1px solid var(--sage)', borderRadius: 6 }} />
                <div title="Asking" style={{ position: 'absolute', left: x(p.price), top: 0, bottom: 0, width: 3, background: 'var(--accent)' }} />
              </>; })()}
            </div>
            <div className="row xs" style={{ gap: 12 }}><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--blue)', borderRadius: 2 }} /> As-is</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--sage)', borderRadius: 2 }} /> Post-works</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--accent)', borderRadius: 2 }} /> Asking {gbpK(p.price)}</span><span className="muted">Rent {gbp(rent.low)}–{gbp(rent.high)} pcm ({rent.basis})</span></div>
            <ul className="ticks small muted" style={{ marginTop: 10 }}>{val.method.map((m) => <li key={m}>{m}</li>)}</ul>
          </Section>}

          <section className="card" id="development">
            <div className="card-head"><div><div className="eyebrow">Development potential</div><h3>What could this property become?</h3></div><Tag kind="warn">Screening only — not a planning opinion</Tag></div>
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Option</th><th>Status</th><th className="r">Cost</th><th className="r">Value uplift</th></tr></thead>
              <tbody>{dev.map((o) => <tr key={o.id}><td><b className="small">{o.name}</b><div className="xs muted">{o.summary}</div>{o.constraints.length > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>⚠ {o.constraints.join(' · ')}</div>}{o.checks.length > 0 && <div className="xs muted">Verify: {o.checks.join(', ')}</div>}</td>
                <td><Tag kind={o.status === 'likely under PD' || o.status === 'prior approval route' ? 'ok' : o.status === 'needs planning permission' ? 'demo' : o.status === 'constrained' ? 'warn' : 'neutral'}>{o.status}</Tag></td>
                <td className="r num">{o.cost != null ? gbpK(o.cost) : '—'}</td><td className={`r num ${(o.valueUplift ?? 0) - (o.cost ?? 0) >= 0 ? 'pos' : 'neg'}`}>{o.valueUplift != null ? gbpK(o.valueUplift) : '—'}</td></tr>)}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>England permitted-development rules (GPDO) simplified as configured Nov 2026; planning layers are demo data. Structural, legal and planning matters need professional verification.</p>
          </section>

          {showEngagement && <Section title="Market response" kicker="Engagement (aggregated, simulated)" right={<Link className="btn ghost sm" to="/owner">Owner dashboard →</Link>}>
            <div className="grid g4 keep2">
              <Stat label="Views (28d)" value={eng.t.views.toLocaleString('en-GB')} />
              <Stat label="Unique visitors" value={eng.t.unique.toLocaleString('en-GB')} />
              <Stat label="Saves" value={eng.t.saves} />
              <Stat label="Conversion" value={pct(eng.t.enquiryRate.p)} sub={`Comparables ${pct(eng.bm.rate.p)}`} tone={eng.t.enquiryRate.high < eng.bm.rate.low ? 'neg' : undefined} />
            </div>
            <ul className="clean small" style={{ marginTop: 12 }}>{eng.ins.slice(0, 4).map((i) => <li key={i.id}><Tag kind={i.kind === 'observed' ? 'obs' : i.kind === 'inferred' ? 'inf' : 'rec'} /> {i.title}</li>)}</ul>
          </Section>}

          <Section title="Property knowledge graph" kicker="What Streetkey connects for this property" right={<Tag kind="neutral">Access-controlled</Tag>}>
            <KnowledgeGraph p={p} />
          </Section>

          {!rental && <Section title="Why this score?" kicker="Explainable deal scoring">
            {ds.components.map((c) => (
              <div key={c.label} style={{ marginBottom: 8 }}>
                <Meter label={`${c.label} · ${Math.round(c.weight * 100)}%`} value={c.score} max={100} display={Math.round(c.score)} color={c.score >= 65 ? 'var(--sage)' : c.score >= 45 ? 'var(--gold)' : 'var(--accent)'} />
                <div className="xs muted" style={{ marginLeft: 2 }}>{c.detail}</div>
              </div>
            ))}
          </Section>}

          <div className="grid g2">
            <Section title="Comparables" kicker="Evidence" right={<Tag kind="demo" />}>
              <div className="table-wrap" tabIndex={0}><table className="t">
                <thead><tr><th>Address</th><th className="r">Price</th><th>Date</th></tr></thead>
                <tbody>{p.comparables.map((c) => <tr key={c.address}><td>{c.address}<div className="xs muted">{c.beds} bed · {c.distanceM}m · {c.kind}{c.refurbished ? ' · refurbished' : ''}</div></td><td className="r num">{c.kind === 'let' ? `${gbp(c.price)} pcm` : gbpK(c.price)}</td><td className="small">{c.date}</td></tr>)}</tbody>
              </table></div>
              {p.comparables.length === 0 && <p className="small muted">No comparables in demo set.</p>}
              <div className="hr" />
              <div className="row between small"><span className="muted">Area price index, 24m</span><span className="num">{(p.areaIndex[23] - 100).toFixed(1)}%</span></div>
              <Spark data={p.areaIndex} />
              <div className="xs muted">Production source: HM Land Registry Price Paid + UK HPI (OGL).</div>
            </Section>
            <Section title="Constraints & risk" kicker="Planning · environment">
              <dl className="kv">
                <dt>Flood (rivers & sea)</dt><dd><Tag kind={p.risks.flood === 'medium' || p.risks.flood === 'high' ? 'warn' : 'ok'}>{p.risks.flood}</Tag></dd>
                <dt>Subsidence (shrink-swell)</dt><dd><Tag kind={p.risks.subsidence === 'low' ? 'ok' : 'warn'}>{p.risks.subsidence}</Tag></dd>
                <dt>Radon</dt><dd><Tag kind={p.risks.radon === 'low' ? 'ok' : 'warn'}>{p.risks.radon}</Tag></dd>
                <dt>Conservation area</dt><dd>{p.risks.conservationArea ? <Tag kind="warn">Yes</Tag> : <Tag kind="ok">No</Tag>}</dd>
                <dt>Article 4 direction</dt><dd>{p.risks.article4 ? <Tag kind="warn">Yes</Tag> : <Tag kind="ok">No</Tag>}</dd>
                <dt>Listed building</dt><dd>{p.risks.listed ? <Tag kind="warn">Yes</Tag> : <Tag kind="ok">No</Tag>}</dd>
              </dl>
              <div className="hr" />
              <div className="eyebrow" style={{ marginBottom: 6 }}>Nearby planning</div>
              <ul className="clean small">{p.planningNearby.map((a) => <li key={a.ref}><span className="mono xs">{a.ref}</span> · {a.desc} · <b className={a.decision === 'Approved' ? 'pos' : a.decision === 'Refused' ? 'neg' : ''}>{a.decision}</b> <span className="muted">({a.distanceM}m)</span></li>)}{!p.planningNearby.length && <li className="muted">None in demo data.</li>}</ul>
              <div className="callout" style={{ marginTop: 10 }}>Not a planning opinion. Constraint layers are demo values; production uses EA flood maps, BGS GeoSure, Historic England, planning.data.gov.uk and LPA feeds. Seek a planning consultant / architect before relying on development potential.</div>
            </Section>
          </div>

          <div className="grid g2">
            <Section title="EPC upgrade pathway" kicker="Energy" right={<Tag kind="est" />}>
              <div className="table-wrap" tabIndex={0}><table className="t">
                <thead><tr><th>Measure (cheapest per SAP point first)</th><th className="r">Cost</th><th className="r">Band</th></tr></thead>
                <tbody>
                  <tr><td className="muted">Today</td><td /><td className="r num">{p.epc.current} ({p.epc.score})</td></tr>
                  {ctx.epc.steps.map((s) => <tr key={s.measure}><td>{s.measure}</td><td className="r num">{gbpK(s.cost)}</td><td className="r num">{s.band} ({s.cumulative})</td></tr>)}
                </tbody>
              </table></div>
              <p className="xs muted" style={{ marginTop: 8 }}>Indicative SAP gains; a retrofit assessment (PAS 2035) is needed for grant-funded works.</p>
            </Section>
            <Section title="10-year cost of ownership" kicker="Forecast" right={<Tag kind="est" />}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 150 }}>
                {own.map((y) => {
                  const parts = [[y.mortgage, 'var(--ink)'], [y.councilTax, 'var(--blue)'], [y.energy, 'var(--accent)'], [y.maintenance, 'var(--gold)'], [y.insurance, 'var(--sage)']] as const;
                  return <div key={y.year} title={`${y.year}`} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', gap: 1, height: '100%' }}>
                    {parts.map(([v, c], k) => <div key={k} style={{ height: `${(v / ownMax) * 100}%`, background: c, borderRadius: 2 }} />)}
                  </div>;
                })}
              </div>
              <div className="row between xs muted" style={{ marginTop: 4 }}><span>2027</span><span>2036</span></div>
              <div className="row xs" style={{ marginTop: 8, gap: 10 }}>{[['Mortgage (75% LTV, 4.7%)', 'var(--ink)'], ['Council tax', 'var(--blue)'], ['Energy', 'var(--accent)'], ['Maintenance', 'var(--gold)'], ['Insurance', 'var(--sage)']].map(([l, c]) => <span key={l} className="row" style={{ gap: 4 }}><i style={{ width: 8, height: 8, background: c, borderRadius: 2, display: 'inline-block' }} />{l}</span>)}</div>
              <div className="small" style={{ marginTop: 8 }}>10-year total ≈ <b className="num">{gbpK(own.reduce((s, y) => s + y.mortgage + y.councilTax + y.energy + y.maintenance + y.insurance, 0))}</b></div>
            </Section>
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <AssistantPanel title="Ask anything about this property" kicker="Property intelligence AI" skills={propertySkills} ctx={p} />
          {!rental && <Section title="Offer preparation" kicker="Negotiation" right={<Tag kind="est" />}>
            <div className="row between"><Stat label="Opening" value={gbpK(ctx.offer.low)} /><Stat label="Walk-away" value={gbpK(ctx.offer.high)} /></div>
            <p className="xs muted" style={{ marginTop: 8 }}>From unrefurbished comparables, days on market and price history. Not a valuation.</p>
          </Section>}
          {!rental && <Section title={`${tax.tax} if bought as an additional property`} kicker="Transaction tax">
            <div className="num" style={{ fontSize: 24 }}>{gbp(tax.total)}</div>
            <div className="xs muted">Effective {pct(tax.effectiveRate, 2)} · first-time buyer: {gbp(transactionTax(p.price, p.nation, 'first-time').total)} · mover: {gbp(transactionTax(p.price, p.nation, 'home-mover').total)}</div>
          </Section>}
          <Section title="Location" kicker="Access">
            <dl className="kv">
              <dt>Commute</dt><dd>{p.commute.minutes} min to {p.commute.to}</dd>
              <dt>Mode</dt><dd>{p.commute.mode}</dd>
              <dt>Station</dt><dd>{p.station.name} · {p.station.walkMins} min walk</dd>
              {p.schools.map((s) => <Fragment key={s.name}><dt>{s.name}</dt><dd>{s.rating} · {s.distanceKm}km</dd></Fragment>)}
              <dt>Rental demand</dt><dd className="num">{p.rentDemand}/100</dd>
            </dl>
            <div className="xs muted" style={{ marginTop: 8 }}>Listed by {p.agent}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}
