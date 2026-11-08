import { Fragment, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProperty, PROPERTIES, type Property } from '../data/properties';
import { dealScore, epcPathway, loftScenario, ownershipForecast, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { transactionTax } from '../engine/tax';
import { gbp, gbpK, HouseArt, Meter, pct, Section, Spark, Stat, Tag } from '../components/ui';

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

function answer(p: Property, q: string, ctx: ReturnType<typeof useCtx>): string {
  const s = q.toLowerCase();
  if (/cost|refurb|budget|works/.test(s)) return `For a ${ctx.est.factors[1].value.split(' ')[0]}-condition ${p.era} ${p.type} of ${p.floorArea}m², the engine prices the inferred scope at ${gbp(ctx.est.total)} incl. VAT (range ${gbpK(ctx.est.low)}–${gbpK(ctx.est.high)}, ${ctx.est.confidence} confidence). Largest trades: ${ctx.est.byTrade.slice(0, 3).map((t) => `${t.trade} ${gbpK(t.total)}`).join(', ')}. Open the estimator to change the scope.`;
  if (/offer|negotiat|price/.test(s)) return `Evidence suggests an opening offer around ${gbp(ctx.offer.low)}, walking away above ${gbp(ctx.offer.high)}. Leverage: ${p.daysOnMarket} days on market${p.priceHistory.some((h) => h.event === 'Reduced') ? ', one price reduction already' : ''}. Lead with the refurb cost (${gbpK(ctx.est.total)}) and unrefurbished comparables, not the asking price. This is preparation, not valuation — a RICS valuation or survey should support your offer.`;
  if (/risk|flood|problem|issue|constraint/.test(s)) return `Flagged: flood risk ${p.risks.flood}; subsidence susceptibility ${p.risks.subsidence}; ${p.risks.conservationArea ? 'conservation area (permitted development restricted, materials controlled)' : 'not in a conservation area'}; ${p.risks.article4 ? 'Article 4 direction in force' : 'no Article 4 direction found'}; ${p.risks.listed ? 'listed building — consent needed for most works' : 'not listed'}. ${p.era === 'pre-1919' ? 'Pre-1919 solid walls: check for damp misdiagnosis and avoid non-breathable materials.' : ''} Commission a RICS Level 3 survey before exchange.`;
  if (/rent|let|btl|yield|invest/.test(s)) return `Estimated achievable rent ${gbp(p.estRentPcm)} pcm (demand index ${p.rentDemand}/100). On an all-in cost of ${gbpK(p.price + ctx.est.total)} that’s a ${pct(ctx.ds.grossYield)} gross yield. Use the investment dashboard to stress-test finance at today’s rates.`;
  if (/loft|extension|extend|planning/.test(s)) return `${ctx.loft ? `Loft (~${ctx.loft.area}m²): cost ≈ ${gbpK(ctx.loft.cost)}, value uplift ≈ ${gbpK(ctx.loft.valueUplift)} → net ${gbpK(ctx.loft.net)}.` : 'No realistic loft conversion.'} ${ctx.ext ? `Rear extension (~${ctx.ext.area}m²): cost ≈ ${gbpK(ctx.ext.cost)}, uplift ≈ ${gbpK(ctx.ext.valueUplift)}.` : ''} Nearby decisions: ${p.planningNearby.map((a) => `${a.desc} — ${a.decision}`).join('; ') || 'none on record in demo data'}. This is not a planning opinion; confirm permitted development rights with the LPA or a planning consultant.`;
  if (/epc|energy|insulat|heat pump/.test(s)) return `EPC ${p.epc.current} (${p.epc.score}) today. The cheapest path to C: ${ctx.epc.steps.filter((x) => x.cumulative <= 72).map((x) => x.measure).slice(0, 3).join(', ') || ctx.epc.steps.slice(0, 2).map((x) => x.measure).join(', ')}. Lettings currently need EPC E or above in England & Wales; plan for proposed tighter standards.`;
  return 'I can answer about refurbishment cost, offer strategy, risks & constraints, rental yield, loft/extension potential and EPC upgrades for this property. Answers are composed from engine outputs and the data shown on this page.';
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
  const [chat, setChat] = useState<{ role: 'user' | 'ai'; text: string }[]>([]);
  const [input, setInput] = useState('');
  const ask = (q: string) => { if (!q.trim()) return; setChat((c) => [...c, { role: 'user', text: q }, { role: 'ai', text: answer(p, q, ctx) }]); setInput(''); };
  const tax = transactionTax(p.price, p.nation, 'additional');
  const rental = p.listing === 'rent';
  const { est, ds } = ctx;
  const plays = [
    { name: 'Refurbish & resell / refinance', cost: est.total, uplift: p.estGdv - p.price, net: ds.uplift },
    ctx.loft && { name: `+ Loft conversion (~${ctx.loft.area}m²)`, cost: ctx.loft.cost, uplift: ctx.loft.valueUplift, net: ctx.loft.net },
    ctx.ext && { name: `+ Rear/side extension (~${ctx.ext.area}m²)`, cost: ctx.ext.cost, uplift: ctx.ext.valueUplift, net: ctx.ext.net },
  ].filter(Boolean) as { name: string; cost: number; uplift: number; net: number }[];
  const own = ctx.own;
  const ownMax = Math.max(...own.map((y) => y.mortgage + y.councilTax + y.energy + y.maintenance + y.insurance));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row small muted"><Link to="/search">← Discover</Link><span>/</span><span>{p.town}</span></div>
      <div className="grid g2" style={{ gap: 20 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden', minHeight: 260 }}><HouseArt hue={p.photoHue} type={p.type} /></div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="row"><Tag kind="demo">Fictional listing</Tag>{p.listing === 'auction' && <Tag kind="warn">Auction · guide price</Tag>}<Tag kind="neutral">{p.tenure}{p.leaseYears ? ` · ${p.leaseYears} yrs` : ''}</Tag><Tag kind="neutral">Council tax {p.councilTax}</Tag></div>
          <h2>{p.title}</h2>
          <div className="muted">{p.street}, {p.town} · {p.postcode}</div>
          <div className="row" style={{ alignItems: 'flex-end', gap: 18 }}>
            <Stat big label={rental ? 'Rent' : p.listing === 'auction' ? 'Guide price' : 'Asking price'} value={rental ? `${gbp(p.price)}` : gbp(p.price)} sub={rental ? 'per calendar month' : `${gbp(p.price / p.floorArea)}/m² · ${p.daysOnMarket} days on market`} />
            {!rental && <div className="row" style={{ gap: 10 }}><div className={`grade grade-${ds.grade}`} style={{ width: 64, height: 64, fontSize: '2rem' }}>{ds.grade}</div><div><div className="num" style={{ fontSize: 22 }}>{ds.total}/100</div><div className="xs muted">Plinth deal score</div></div></div>}
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
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Play</th><th className="r">Cost (incl. VAT)</th><th className="r">Value uplift</th><th className="r">Net</th></tr></thead>
              <tbody>{plays.map((pl) => <tr key={pl.name}><td>{pl.name}</td><td className="r num">{gbpK(pl.cost)}</td><td className="r num">{gbpK(pl.uplift)}</td><td className={`r num ${pl.net >= 0 ? 'pos' : 'neg'}`}>{gbpK(pl.net)}</td></tr>)}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 10 }}>Value uplift for lofts/extensions uses a demo heuristic (share of GDV) pending a calibrated hedonic model from Land Registry + EPC floor-area data. Costs from {est.basis.version}.</p>
          </Section>}

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
              <div className="table-wrap"><table className="t">
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
              <div className="table-wrap"><table className="t">
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
          <Section title="Ask about this property" kicker="Property copilot" right={<Tag kind="ai" />}>
            <div className="chat" style={{ maxHeight: 360 }}>
              {chat.length === 0 && <p className="small muted">Answers are composed only from the engine outputs and data on this page — the assistant can’t invent comparables or prices.</p>}
              {chat.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}</div>)}
            </div>
            <div className="chips" style={{ marginTop: 10 }}>{['What will the refurb cost?', 'What should I offer?', 'What are the risks?', 'Is it good for buy-to-let?', 'Loft or extension?', 'How do I improve the EPC?'].map((s) => <button key={s} className="chip xs" onClick={() => ask(s)}>{s}</button>)}</div>
            <div className="row" style={{ marginTop: 10, flexWrap: 'nowrap' }}>
              <input className="input" value={input} placeholder="Ask a question…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(input)} />
              <button className="btn sm" onClick={() => ask(input)}>Ask</button>
            </div>
          </Section>
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
