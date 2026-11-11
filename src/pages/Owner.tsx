import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MyListing } from '../lib/api';
import { inboxAi, isLive, priceEvidence, type ListingStats } from '../lib/ai/inbox';
import { useServer } from '../lib/server';
import { ListingInsightsPanel } from './Account';
import { getProperty } from '../data/properties';
import { benchmark, comparableSet, engagementFor, insightsFor, K_ANON, PERIOD_DAYS, suppress, totals, type Insight } from '../engine/engagement';
import { valuationScenario } from '../engine/valuation';
import { weeklyOwnerReport } from '../engine/reports';
import { ownerSkills } from '../ai/skills';
import { AssistantPanel } from '../components/Assistant';
import { download, gbp, gbpK, Meter, pct, Section, Stat, Tag } from '../components/ui';

const MINE = ['wal-001', 'cro-013', 'ley-014'];

export function InsightList({ items }: { items: Insight[] }) {
  return (
    <ul className="clean" style={{ gap: 10 }}>
      {items.map((i) => (
        <li key={i.id} className="card flat" style={{ padding: 12 }}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div className="row" style={{ gap: 6 }}><Tag kind={i.kind === 'observed' ? 'obs' : i.kind === 'inferred' ? 'inf' : 'rec'} /><b className="small">{i.title}</b></div>
            <span className="xs muted">confidence: {i.confidence}</span>
          </div>
          <ul className="ticks xs muted" style={{ marginTop: 6 }}>{i.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
          {i.caveat && <div className="xs" style={{ marginTop: 6, color: 'var(--gold)' }}>ⓘ {i.caveat}</div>}
          {i.action?.to && <Link to={i.action.to} className="btn ghost sm" style={{ marginTop: 8 }}>{i.action.label} →</Link>}
        </li>
      ))}
    </ul>
  );
}

export function TrendChart({ days }: { days: { date: string; views: number; enquiries: number; viewingRequests: number }[] }) {
  const max = Math.max(...days.map((d) => d.views), 1);
  const maxE = Math.max(...days.map((d) => d.enquiries + d.viewingRequests), 1);
  return (
    <div>
      <div className="chart-bars" aria-label="Daily views">
        {days.map((d) => <div key={d.date} title={`${d.date}: ${d.views} views, ${d.enquiries + d.viewingRequests} enquiries/viewings`} style={{ height: `${(d.views / max) * 100}%`, background: 'var(--ink)', opacity: 0.8 }} />)}
      </div>
      <svg viewBox={`0 0 ${days.length * 10} 40`} width="100%" height="40" preserveAspectRatio="none" aria-hidden>
        <polyline fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" points={days.map((d, i) => `${i * 10 + 5},${38 - ((d.enquiries + d.viewingRequests) / maxE) * 34}`).join(' ')} />
      </svg>
      <div className="row between xs muted"><span>{days[0].date}</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--ink)' }} /> views · <i style={{ display: 'inline-block', width: 9, height: 2, background: 'var(--accent)', verticalAlign: 'middle' }} /> enquiries + viewing requests</span><span>{days[days.length - 1].date}</span></div>
    </div>
  );
}

/**
 * Owner dashboard. Signed in with live listings on Streetkey: real figures for the chosen listing
 * plus insights (AI when available, built-in rules otherwise). Otherwise the simulated demo.
 */
export default function Owner() {
  const { status, user } = useServer();
  const [mine, setMine] = useState<MyListing[] | null>(null);
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    if (status !== 'online' || !user) { setMine([]); return; }
    let live = true;
    setMine(null);
    api.me.listings().then((r) => { if (live) setMine(r.items.filter((l) => isLive(l.status))); }).catch(() => { if (live) setMine([]); });
    return () => { live = false; };
  }, [status, user]);
  if (status === 'online' && user && mine === null) return <p className="muted small" style={{ padding: 20 }} role="status">Checking your listings…</p>;
  if (mine?.length && !demo) return <LiveOwner listings={mine} onDemo={() => setDemo(true)} />;
  return <DemoOwner onBack={mine?.length ? () => setDemo(false) : undefined} />;
}

const STATUS_LABEL: Record<string, string> = { live: 'Live', under_offer: 'Under offer' };
const shortDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function ViewsChart({ days }: { days: ListingStats['days'] }) {
  if (!days.length) return <p className="small muted">No figures yet.</p>;
  const max = Math.max(1, ...days.map((d) => d.views));
  const total = days.reduce((s, d) => s + d.views, 0);
  const best = days.reduce((a, d) => (d.views > a.views ? d : a), days[0]);
  return (
    <figure style={{ margin: 0 }}>
      <div className="owner-bars" aria-hidden="true">
        {days.map((d) => <span key={d.day} className={d.views ? '' : 'zero'} style={{ height: `${Math.max(3, (d.views / max) * 100)}%` }} title={`${shortDate(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}`} />)}
      </div>
      <figcaption className="row between xs muted" style={{ marginTop: 6 }}>
        <span>{shortDate(days[0].day)}</span>
        <span>{total ? `${total.toLocaleString('en-GB')} views in total · busiest day ${shortDate(best.day)} (${best.views})` : 'No tracked views yet'}</span>
        <span>{shortDate(days[days.length - 1].day)}</span>
      </figcaption>
    </figure>
  );
}

function LiveOwner({ listings, onDemo }: { listings: MyListing[]; onDemo: () => void }) {
  const [ref, setRef] = useState(listings[0].ref);
  const l = listings.find((x) => x.ref === ref) ?? listings[0];
  const [stats, setStats] = useState<ListingStats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setStats(null); setFailed(false);
    inboxAi.stats(l.ref).then((s) => { if (live) setStats(s); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [l.ref]);
  const rent = l.channel === 'rent';
  const price = (n: number) => (rent ? `${gbp(n)} pcm` : gbp(n));
  const views = stats?.totals.listing_view ?? l.stats.views30d;
  const saves = stats?.saves ?? l.stats.saves;
  // Messages the inbox held back as likely spam or scams aren't enquiries (the inbox doesn't count them either).
  const heldBack = l.stats.filtered ?? 0;
  const days = l.publishedAt ? Math.max(0, Math.floor((Date.now() - new Date(l.publishedAt).getTime()) / 86_400_000)) : null;
  const ev = useMemo(() => priceEvidence(l), [l]);
  const issues = l.checks.filter((c) => !c.ok);
  const name = (x: MyListing) => x.title ?? `${x.beds}-bed ${x.type} in ${x.town}`;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Property owner dashboard</div><h2 style={{ marginTop: 6 }}>How is my listing performing?</h2>
          <p className="muted" style={{ marginTop: 6 }}>Real figures from Streetkey for the last 30 days. Views and saves only count visitors who allowed analytics; enquiries are the messages sent to you.</p></div>
        <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
          {listings.length > 1 && <label className="field" style={{ minWidth: 220 }}>Choose listing<select className="input" value={l.ref} onChange={(e) => setRef(e.target.value)}>{listings.map((x) => <option key={x.ref} value={x.ref}>{name(x)} · {x.town}</option>)}</select></label>}
          <div className="row"><Tag kind="ok">Your live data</Tag><button type="button" className="btn sm ghost" onClick={onDemo}>See the demo dashboard</button></div>
        </div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Listing views (30 days)" value={views.toLocaleString('en-GB')} sub="Visitors who allowed analytics" /></div>
        <div className="card"><Stat label="Saved by" value={saves.toLocaleString('en-GB')} sub={`${saves === 1 ? 'person' : 'people'} with a Streetkey account`} /></div>
        <div className="card"><Stat label="Enquiries" value={(stats?.enquiries ?? l.stats.enquiries).toLocaleString('en-GB')} sub={<>
          {l.stats.newEnquiries ? <Link to="/account/inbox">{l.stats.newEnquiries} new in your inbox</Link> : 'All caught up'}
          {heldBack > 0 && <><br /><Link to="/account/inbox">{heldBack} held back as possible spam</Link> (not counted)</>}
        </>} /></div>
        <div className="card"><Stat label="Days on market" value={days ?? '—'} sub={STATUS_LABEL[l.status] ?? l.status} /></div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <ListingInsightsPanel key={`${l.ref}:${l.updatedAt}`} listing={l} />
          <Section title="Views over the last 30 days" kicker="Daily">
            {stats ? <ViewsChart days={stats.days} /> : failed ? <p className="small muted">The daily figures couldn’t be loaded just now.</p> : <p className="small muted" role="status">Loading figures…</p>}
            {stats?.note && <p className="xs muted" style={{ marginTop: 8 }}>{stats.note}</p>}
          </Section>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <Section title={name(l)} kicker="Your listing">
            <dl className="kv">
              <dt>{rent ? 'Rent' : 'Asking price'}</dt><dd className="num">{price(l.price)}</dd>
              {ev && <><dt>Indicative range</dt><dd className="num">{price(ev.low)}–{price(ev.high)}</dd></>}
              <dt>Photos</dt><dd className="num">{l.photos.length}</dd>
              <dt>Status</dt><dd>{STATUS_LABEL[l.status] ?? l.status}</dd>
            </dl>
            {ev && <p className="xs muted" style={{ marginTop: 8 }}>Range from {ev.scope} evidence ({ev.comparables} comparable{ev.comparables === 1 ? '' : 's'}, demo data). <Tag kind="est" /> Not a valuation.</p>}
            {issues.length > 0 && <ul className="clean xs" style={{ marginTop: 8 }}>{issues.map((c) => <li key={c.id}>{c.severity === 'block' ? 'Required: ' : 'Suggested: '}{c.message}</li>)}</ul>}
            <div className="row" style={{ marginTop: 10 }}>
              <Link className="btn sm ghost" to={`/property/${l.ref}`}>View listing</Link>
              <Link className="btn sm ghost" to={`/list?edit=${l.ref}`}>Edit</Link>
              <Link className="btn sm ghost" to="/account/inbox">Inbox</Link>
            </div>
          </Section>
          <Section title="Improve marketability" kicker="Next steps">
            <div className="stack">
              <Link className="btn ghost sm" to="/account/listings">Manage all your listings</Link>
              <Link className="btn ghost sm" to="/studio">Create an AI room concept (labelled as virtual)</Link>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function DemoOwner({ onBack }: { onBack?: () => void }) {
  const [id, setId] = useState(MINE[0]);
  const p = getProperty(id)!;
  const e = useMemo(() => engagementFor(p), [p]);
  const t = useMemo(() => totals(e), [e]);
  const bm = useMemo(() => benchmark(p), [p]);
  const ins = useMemo(() => insightsFor(p), [p]);
  const v = useMemo(() => valuationScenario(p), [p]);
  const comps = useMemo(() => comparableSet(p).slice(0, 5).map((c) => ({ c, t: totals(engagementFor(c)) })), [p]);
  const photos = [...e.photos].map((ph) => ({ ...ph, rate: ph.enlargements / Math.max(1, ph.impressions) }));
  const maxPhoto = Math.max(...photos.map((x) => x.rate));
  const funnel = [['Views', t.views], ['Unique visitors', t.unique], ['Floor plan opens', e.floorplan.opens], ['Saves', t.saves], ['Viewing requests', t.viewingRequests], ['Enquiries', t.enquiries]] as const;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {onBack && <div className="callout info row between"><span>You’re looking at an example dashboard with example figures.</span><button type="button" className="btn sm ghost" onClick={onBack}>Back to your listings</button></div>}
      <div className="page-head">
        <div><div className="eyebrow">Property owner dashboard</div><h2 style={{ marginTop: 6 }}>How is my property performing?</h2>
          <p className="muted" style={{ marginTop: 6 }}>Aggregated buyer engagement over the last {PERIOD_DAYS} days (visitor segments under {K_ANON} people are hidden), compared with similar listings. Facts are labelled <Tag kind="obs" />, interpretations <Tag kind="inf" />, suggestions <Tag kind="rec" />.</p></div>
        <div className="stack" style={{ gap: 6, alignItems: 'flex-end' }}>
          <select className="input" value={id} onChange={(ev) => setId(ev.target.value)} aria-label="Choose property">{MINE.map((m) => <option key={m} value={m}>{getProperty(m)!.street.replace(' (fictional)', '')}, {getProperty(m)!.town.split(',')[0]}</option>)}</select>
          <div className="row"><Tag kind="demo">Example data</Tag></div>
        </div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Listing views" value={t.views.toLocaleString('en-GB')} sub={`${t.unique.toLocaleString('en-GB')} unique · ${t.repeat.toLocaleString('en-GB')} repeat`} /></div>
        <div className="card"><Stat label="Saved by" value={t.saves} sub={`${pct(t.saveRate.p)} of visitors`} /></div>
        <div className="card"><Stat label="Viewing requests · enquiries" value={`${t.viewingRequests} · ${t.enquiries}`} sub={`Avg ${t.avgSeconds}s on listing`} /></div>
        <div className="card"><Stat label="Conversion vs similar listings" value={pct(t.enquiryRate.p)} tone={t.enquiryRate.high < bm.rate.low ? 'neg' : t.enquiryRate.low > bm.rate.high ? 'pos' : undefined} sub={`Comparables ${pct(bm.rate.p)} (${bm.n} listings)`} /></div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="What the evidence says" kicker="Property behaviour analysis" right={<Tag kind="neutral">Evidence-based</Tag>}><InsightList items={ins} /></Section>

          <Section title="Engagement over time" kicker="Daily, last 28 days"><TrendChart days={e.days} /></Section>

          <div className="grid g2">
            <Section title="Buyer journey" kicker="Funnel">
              <div className="funnel">{funnel.map(([l, n]) => <div key={l}><span>{l}</span><div className="bar"><i style={{ width: `${Math.max(1.5, (n / t.views) * 100)}%`, background: 'var(--ai)' }} /></div><span className="num" style={{ textAlign: 'right' }}>{n.toLocaleString('en-GB')}</span></div>)}</div>
              <p className="xs muted" style={{ marginTop: 8 }}>Interest is not intent: a save or photo enlargement is attention, not a commitment to buy.</p>
            </Section>
            <Section title="Photo performance" kicker="Enlargement rate">
              {photos.map((ph, i) => <Meter key={ph.photoId} label={<>{i === 0 && <Tag kind="neutral">Lead</Tag>} {ph.label}</>} value={ph.rate} max={maxPhoto} display={pct(ph.rate)} color={ph.rate === maxPhoto ? 'var(--accent)' : 'var(--ink)'} />)}
              <p className="xs muted" style={{ marginTop: 8 }}>{photos.reduce((s, x) => s + x.revisits, 0).toLocaleString('en-GB')} photo revisits · floor plan opened {e.floorplan.opens.toLocaleString('en-GB')} times (avg {e.floorplan.avgSeconds}s)</p>
            </Section>
          </div>

          <div className="grid g2">
            <Section title="Buyer questions & concerns" kicker="Questions asked to the AI (by topic)">
              {e.aiQuestions.map((q) => <Meter key={q.topic} label={q.topic} value={q.count} max={e.aiQuestions[0].count} display={suppress(q.count)} color="var(--ai)" />)}
              <p className="xs muted" style={{ marginTop: 8 }}>Topics only — the text of individual questions is never shown to owners.</p>
            </Section>
            <Section title="Renovation & design activity" kicker="Studio and cost-engine use">
              <div className="row between"><Stat label="Refurb simulations" value={e.refurbSimulations} /><Stat label="Comparisons" value={e.comparisons} /></div>
              <div className="eyebrow" style={{ margin: '12px 0 4px' }}>Styles explored</div>
              {e.designStyles.slice(0, 4).map((s) => <Meter key={s.style} label={s.style} value={s.count} max={e.designStyles[0].count} display={suppress(s.count)} color="var(--accent)" />)}
              <div className="eyebrow" style={{ margin: '12px 0 4px' }}>Budgets selected</div>
              {e.budgetBands.map((b) => <Meter key={b.band} label={b.band} value={b.count} max={Math.max(...e.budgetBands.map((x) => x.count))} display={suppress(b.count)} color="var(--gold)" />)}
            </Section>
          </div>

          <div className="grid g2">
            <Section title="Most explored features">
              {e.featureInterest.map((f) => <Meter key={f.feature} label={f.feature} value={f.interactions} max={e.featureInterest[0].interactions} display={f.interactions.toLocaleString('en-GB')} />)}
            </Section>
            <Section title="Marketing campaigns">
              <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Channel</th><th className="r">Clicks</th><th className="r">Enquiries</th><th className="r">Rate</th></tr></thead>
                <tbody>{e.campaigns.map((c) => <tr key={c.channel}><td className="small">{c.channel}{c.spend ? <div className="xs muted">£{c.spend} spend</div> : null}</td><td className="r num">{c.clicks}</td><td className="r num">{suppress(c.enquiries)}</td><td className="r num">{pct(c.enquiries / Math.max(1, c.clicks))}</td></tr>)}</tbody></table></div>
              <div className="eyebrow" style={{ margin: '12px 0 4px' }}>Aggregated search demand</div>
              <ul className="clean small">{e.searchDemand.map((s) => <li key={s.query} className="row between"><span>“{s.query}”</span><span className="num">{s.impressions.toLocaleString('en-GB')}</span></li>)}</ul>
            </Section>
          </div>

          <Section title="Against similar listings nearby" kicker="Local comparison">
            <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Listing</th><th className="r">Price</th><th className="r">Views</th><th className="r">Conversion</th><th className="r">Days</th></tr></thead>
              <tbody>
                <tr style={{ background: 'var(--accent-soft)' }}><td><b>Your property</b></td><td className="r num">{gbpK(p.price)}</td><td className="r num">{t.views}</td><td className="r num">{pct(t.enquiryRate.p)}</td><td className="r num">{p.daysOnMarket}</td></tr>
                {comps.map(({ c, t: ct }) => <tr key={c.id}><td className="small"><Link to={`/property/${c.id}`}>{c.street.replace(' (fictional)', '')}</Link><div className="xs muted">{c.beds} bed {c.type}</div></td><td className="r num">{gbpK(c.price)}</td><td className="r num">{ct.views}</td><td className="r num">{pct(ct.enquiryRate.p)}</td><td className="r num">{c.daysOnMarket}</td></tr>)}
              </tbody></table></div>
          </Section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <AssistantPanel title="Ask about your listing" kicker="Owner assistant" skills={ownerSkills} ctx={p} />
          <Section title="Weekly performance report" kicker="Automated">
            <p className="small muted">A plain-English report with evidence, caveats and recommended actions.</p>
            <button className="btn" style={{ marginTop: 10 }} onClick={() => download(`streetkey-report-${p.id}.md`, weeklyOwnerReport(p), 'text/markdown')}>Download this week’s report</button>
          </Section>
          <Section title="Valuation scenarios" kicker="Indicative · not RICS" right={<Tag kind="est" />}>
            <dl className="kv">
              <dt>Your asking price</dt><dd className="num">{gbp(p.price)}</dd>
              <dt>As-is range</dt><dd className="num">{gbpK(v.asIs.low)}–{gbpK(v.asIs.high)}</dd>
              <dt>After refurbishment</dt><dd className="num">{gbpK(v.postWorks.low)}–{gbpK(v.postWorks.high)}</dd>
              <dt>Position</dt><dd><Tag kind={v.verdict === 'above range' ? 'warn' : 'ok'}>{v.verdict}</Tag></dd>
            </dl>
            <p className="xs muted" style={{ marginTop: 8 }}>{v.evidenceCount} sold comparables · {v.confidence} confidence.</p>
          </Section>
          <Section title="Improve marketability" kicker="Refurbishment opportunities">
            <div className="stack">
              <Link className="btn ghost sm" to={`/studio?property=${p.id}&room=kitchen`}>Create an AI kitchen concept for the listing</Link>
              <Link className="btn ghost sm" to={`/estimate?property=${p.id}`}>Cost the works buyers are asking about</Link>
              <Link className="btn ghost sm" to={`/property/${p.id}/intelligence#development`}>See development potential</Link>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
