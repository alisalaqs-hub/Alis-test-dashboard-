import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { describeQuery, runSearch, type SearchHit, type SearchQuery } from '../engine/search';
import { gbp, gbpK, HouseArt, Seg, Tag, UKMap } from '../components/ui';
import { useStore } from '../store';
import { externalSearchLinks } from '../engine/listings';
import { publicListings, type Property } from '../data/properties';
import { aiPost, useAi } from '../lib/ai/core';
import { applyExtras, fromRules, MAX_QUERY_CHARS, SEARCH_MODES, withoutChips, type IntentResult, type RankResult, type SearchMode } from '../lib/ai/search';
import { AiLabel, AiThinking } from '../components/ai/Ai';
import { Icon } from '../components/Icons';
import '../components/ai/search.css';

function sourceLabel(p: Property) {
  if (!p.source) return { text: 'Streetkey demo', tone: 'demo' as const };
  if (p.source.kind === 'agent-feed') return { text: p.source.name.replace(' (agent feed)', ''), tone: 'ok' as const };
  return { text: p.source.name, tone: 'neutral' as const };
}

function narrate(q: SearchQuery, hits: SearchHit[]): string[] {
  const out: string[] = [];
  if (!hits.length) return ['Nothing in the current dataset meets the hard constraints (type, budget, beds, location/commute). Try widening the budget, commute or area.'];
  const best = hits[0];
  out.push(`I found ${hits.length} propert${hits.length === 1 ? 'y' : 'ies'} meeting your hard constraints, ranked by fit and underwritten potential (refurb cost from the Streetkey engine, value from comparables, risk and demand).`);
  if (q.minRefurbProfit) {
    const meeting = hits.filter((h) => h.estProfit >= q.minRefurbProfit!);
    if (meeting.length) out.push(`${meeting.length} clear your £${Math.round(q.minRefurbProfit / 1000)}k profit target on base-case assumptions.`);
    else { const gap = q.minRefurbProfit - best.estProfit; out.push(`Honest answer: none clear £${Math.round(q.minRefurbProfit / 1000)}k on base-case numbers. The closest is ≈£${Math.round(best.estProfit / 1000)}k; you’d need to buy at about ${gbp(best.property.price - gap)} to reach it.`); }
  }
  if (q.conversion) out.push('Conversion potential is a screening result, not a planning opinion — check local policy on loss of family housing and space standards.');
  out.push(`Top pick: ${best.property.title} — ${best.reasons.slice(0, 2).join('; ') || 'best overall fit'}.`);
  if (best.cautions.length) out.push(`Watch out: ${best.cautions.join('; ')}.`);
  return out;
}

/** AI relevance (from /rank) blended 50:50 with the engine's fit score; unranked results keep their order after. */
function blend(hits: SearchHit[], scores: Map<string, number>): SearchHit[] {
  const ranked = hits.filter((h) => scores.has(h.property.id));
  if (ranked.length < 2) return hits;
  const fit = ranked.map((h) => h.score);
  const sem = ranked.map((h) => scores.get(h.property.id)!);
  const norm = (v: number, all: number[]) => { const lo = Math.min(...all); const hi = Math.max(...all); return hi > lo ? (v - lo) / (hi - lo) : 0.5; };
  const value = new Map(ranked.map((h) => [h.property.id, 0.5 * norm(h.score, fit) + 0.5 * norm(scores.get(h.property.id)!, sem)]));
  return [...ranked.sort((a, b) => value.get(b.property.id)! - value.get(a.property.id)!), ...hits.filter((h) => !scores.has(h.property.id))];
}

const orList = (items: string[]) => {
  try { return new Intl.ListFormat('en-GB', { style: 'long', type: 'disjunction' }).format(items); } catch { return items.join(', '); }
};

type Channel = 'any' | 'buy' | 'rent' | 'commercial';
type Sort = 'fit' | 'price' | 'score' | 'ai';

/** The example search shown when the page opens without ?q. The built-in rules read it well, so it never costs an AI request. */
const EXAMPLE_QUERY = 'Find me a three-bedroom house within 45 minutes of central London for under £500,000 that requires refurbishment but has potential for a good investment return.';
/** AI readings already fetched this visit (so going back to a search doesn't ask again). */
const readings = new Map<string, IntentResult>();
const rememberReading = (key: string, r: IntentResult) => { if (readings.size >= 30) readings.delete(readings.keys().next().value!); readings.set(key, r); };

export default function Search() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? EXAMPLE_QUERY;
  const [text, setText] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const [active, setActive] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const modeParam = params.get('mode');
  const mode: SearchMode | null = (SEARCH_MODES as readonly string[]).includes(modeParam ?? '') ? (modeParam as SearchMode) : null;
  const [channel, setChannel] = useState<Channel>(modeParam === 'rent' ? 'rent' : modeParam === 'commercial' ? 'commercial' : 'any');
  const [maxPrice, setMaxPrice] = useState<number | ''>('');
  const [minBeds, setMinBeds] = useState<number | ''>('');
  const [sort, setSort] = useState<Sort>('fit');
  const { saved, compare, toggleSaved, toggleCompare, savedSearches, toggleSavedSearch, addRecent, myListings, feedListings, serverListings } = useStore();
  const [src, setSrc] = useState<'all' | 'agents' | 'private'>('all');
  const searchSaved = savedSearches.some((s) => s.q === submitted);
  const ai = useAi();
  const inputRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  /* What the search means: Streetkey AI when available, else (and until it answers) the built-in parser. */
  const readingKey = `${mode ?? ''}|${submitted}`;
  const rules = useMemo(() => fromRules(submitted, mode), [submitted, mode]);
  const [aiReading, setAiReading] = useState<{ key: string; r: IntentResult } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const text = submitted.trim().slice(0, MAX_QUERY_CHARS);
    if (!ai.available || !text || submitted === EXAMPLE_QUERY) return;
    const hit = readings.get(readingKey);
    if (hit) { setAiReading({ key: readingKey, r: hit }); return; }
    let live = true;
    setPending(readingKey);
    aiPost<IntentResult>('/api/ai/search/intent', { q: text, mode }, 15_000)
      .then((r) => { rememberReading(readingKey, r); if (live) setAiReading({ key: readingKey, r }); })
      .catch(() => { /* silent: the built-in parser's results are already showing */ })
      .finally(() => { if (live) setPending((p) => (p === readingKey ? null : p)); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.available, readingKey]);
  const reading = aiReading?.key === readingKey ? aiReading.r : rules;
  const usingAi = reading.source === 'ai';
  const understanding = ai.available && pending === readingKey && !usingAi;

  // Chips people removed (for this search only).
  const [removedFor, setRemovedFor] = useState<{ key: string; keys: string[] }>({ key: '', keys: [] });
  const removed = removedFor.key === readingKey ? removedFor.keys : [];
  // Focus stays with the chips after removing one or undoing; the search box if no chips are left.
  const refocus = () => requestAnimationFrame(() => (chipsRef.current ?? inputRef.current)?.focus());
  const removeChip = (k: string) => { setRemovedFor({ key: readingKey, keys: [...removed, k] }); refocus(); };
  const undoRemoved = () => { setRemovedFor({ key: readingKey, keys: [] }); refocus(); };
  const state = useMemo(() => withoutChips(reading, removed), [reading, removed]);

  const q = useMemo(() => {
    const base: SearchQuery = { ...state.query, locations: [...state.query.locations], districts: [...state.query.districts], types: [...state.query.types], unsupported: [...state.query.unsupported] };
    if (channel === 'rent') base.intent = 'rent';
    if (channel === 'buy' && base.intent === 'rent') base.intent = 'buy';
    if (channel === 'commercial') { base.commercial = true; base.types = []; }
    if (maxPrice !== '') base.maxPrice = maxPrice;
    if (minBeds !== '') base.minBeds = minBeds;
    return base;
  }, [state, channel, maxPrice, minBeds]);
  const fitHits = useMemo(() => applyExtras(runSearch(q), state.extras),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q, state.extras, myListings.length, feedListings.length, serverListings.length]);

  /* Optional AI relevance sort: re-rank the top 60 by meaning, blended with the engine's fit. */
  const wantAiSort = sort === 'ai' && ai.available;
  const candidates = useMemo(() => fitHits.slice(0, 60).map((h) => h.property.id), [fitHits]);
  const rankKey = `${submitted}|${candidates.join(',')}`;
  const [rank, setRank] = useState<{ key: string; scores: Map<string, number> } | null>(null);
  const [rankFailed, setRankFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!wantAiSort || !candidates.length || rank?.key === rankKey) return;
    let live = true;
    aiPost<RankResult>('/api/ai/search/rank', { q: submitted.trim().slice(0, MAX_QUERY_CHARS), ids: candidates }, 15_000)
      .then((r) => { if (live) setRank({ key: rankKey, scores: new Map(r.items.map((i) => [i.id, i.score])) }); })
      .catch(() => { if (live) setRankFailed(rankKey); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantAiSort, rankKey]);
  const rankReady = wantAiSort && rank?.key === rankKey;
  const rankBusy = wantAiSort && !rankReady && rankFailed !== rankKey && candidates.length > 1;

  const hits = useMemo(() => {
    if (sort === 'price') return [...fitHits].sort((a, b) => a.property.price - b.property.price);
    if (sort === 'score') return [...fitHits].sort((a, b) => a.dealGrade.localeCompare(b.dealGrade) || b.score - a.score);
    if (rankReady && rank) return blend(fitHits, rank.scores);
    return fitHits;
  }, [fitHits, sort, rankReady, rank]);
  const shown = hits.filter((h) => src === 'all' || (src === 'agents' ? h.property.source?.kind === 'agent-feed' || !h.property.source : h.property.source?.kind === 'owner' || h.property.source?.kind === 'landlord'));
  const place = q.locations[0] ?? q.districts[0] ?? '';
  const external = externalSearchLinks(place, q.intent === 'rent' ? 'rent' : 'sale');
  const narrative = useMemo(() => narrate(q, hits), [q, hits]);

  const run = (next: string) => { setSubmitted(next); setParams({ q: next }); addRecent(next, channel === 'rent' ? 'rent' : 'buy'); };
  const submit = () => run(text);
  const refine = (extra: string) => { const next = `${submitted.trim()} ${extra.trim()}`.slice(0, 500); setText(next); run(next); };

  // Filters on the page override the matching chips, so those chips are hidden while a filter is set.
  const overridden = new Set([...(maxPrice !== '' ? ['maxPrice'] : []), ...(minBeds !== '' ? ['minBeds'] : []), ...(channel !== 'any' ? ['intent'] : [])]);
  const chips = reading.understood.filter((c) => !removed.includes(c.key) && !overridden.has(c.key));
  const sortValue: Sort = sort === 'ai' && !ai.available ? 'fit' : sort;
  const extrasShown = state.extras.minPrice != null || state.extras.maxBeds != null || state.extras.mustHaves.length > 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head desktop-only">
        <div><div className="eyebrow">AI property search</div><h2 style={{ marginTop: 6 }}>Describe what you want</h2></div>
        <div className="row"><Tag kind="demo">{publicListings().length} listings (demo + feeds + owner posts)</Tag><Tag kind="live">Licensed feeds: agent CRMs · auction partners · owner listings</Tag></div>
      </div>
      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card ai-card search-head">
            <form className="smart-box" style={{ boxShadow: 'none' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} aria-label="Search Streetkey" enterKeyHint="search" placeholder="Place or describe it" />
              <button className="smart-go" type="submit">Search</button>
            </form>
            <div className="row between" style={{ marginTop: 10, flexWrap: 'nowrap', gap: 8 }}>
              <b className="small" aria-live="polite">{shown.length} result{shown.length === 1 ? '' : 's'}</b>
              <button className={`save-btn${searchSaved ? ' on' : ''}`} onClick={() => toggleSavedSearch(submitted, channel === 'rent' ? 'rent' : 'buy')}>{searchSaved ? '♥ Saved' : '♡ Save search'}</button>
            </div>

            {understanding && <div className="aisr-busy"><AiThinking label="Streetkey AI is reading your search" /></div>}
            {/* Always mounted, so what the AI understood, its question and notes are announced when they appear. */}
            <div className="aisr-reading" aria-live="polite">
              {!understanding && (chips.length > 0 || removed.length > 0) && (
                <div className="aisr-understood" ref={chipsRef} tabIndex={-1} role="group" aria-label={usingAi ? 'What Streetkey AI understood' : 'What you searched for'}>
                  <span className="aisr-understood-h">{usingAi ? <AiLabel>AI understood</AiLabel> : 'Searching for'}</span>
                  {chips.length > 0 ? (
                    <ul className="ai-chips">
                      {chips.map((c) => (
                        <li key={c.key} className={`ai-chip aisr-chip${c.removable ? '' : ' fixed'}`}>
                          <span>{c.label}</span>
                          {c.removable && <button type="button" className="aisr-chip-x" aria-label={`Remove ${c.label}`} title="Remove and search again" onClick={() => removeChip(c.key)}><Icon name="x" size={14} /></button>}
                        </li>
                      ))}
                    </ul>
                  ) : <span className="small aisr-understood-none">No filters from your words are left.</span>}
                  {removed.length > 0 && <button type="button" className="linkish small" onClick={undoRemoved}>Undo</button>}
                </div>
              )}
              {!understanding && reading.clarify && (
                <div className="aisr-clarify callout info">
                  <p className="small"><AiLabel /> {reading.clarify.question}</p>
                  {reading.clarify.answers.length > 0
                    ? <div className="chips">{reading.clarify.answers.map((a) => <button key={a} type="button" className="chip" onClick={() => refine(a)} aria-label={`Search again ${a}`}>+ {a}</button>)}</div>
                    : <div><button type="button" className="btn ghost sm" onClick={() => inputRef.current?.focus()}>Add to my search</button></div>}
                </div>
              )}
              {!understanding && reading.unsupported.length > 0 && <p className="small aisr-note">We can’t filter on {orList(reading.unsupported)} yet.</p>}
              {!understanding && reading.policyNote && <p className="callout info small aisr-policy" role="note">{reading.policyNote}</p>}
            </div>

            <div className="msg ai" style={{ maxWidth: '100%', marginTop: 10 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Tag kind="ai">AI</Tag><p className="small">{narrative[narrative.length > 2 && /^Honest/.test(narrative[1]) ? 1 : 0]}</p></div>
              <details className="why"><summary>Why these results?</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>{narrative.map((n, i) => <p key={i} className="small">{n}</p>)}</div>
                {q.unsupported.length > 0 && <div className="callout info small" style={{ marginTop: 10 }}><b>Not yet covered:</b> {q.unsupported.join(' ')}</div>}
                <div className="parsed" style={{ marginTop: 10 }}>{describeQuery(q).map((d) => <span key={d}>{d}</span>)}</div>
                <p className="xs muted" style={{ marginTop: 8 }}>{usingAi ? 'Streetkey AI turned your words into these filters; the listings, prices and scores come from Streetkey’s own data and engines.' : 'Streetkey’s built-in rules turned your words into these filters.'}</p>
                <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} structured query</button>
                {showJson && <pre tabIndex={0} className="code" style={{ marginTop: 10 }}>{`${usingAi ? '// Built by Streetkey AI from your words (JSON-schema validated, numbers range-checked).' : '// Built by Streetkey’s rule-based parser.'}\n// Filtering, costing and ranking are deterministic.\nsearch_properties(${JSON.stringify(q, null, 2)})${extrasShown ? `\n// Also applied: ${JSON.stringify(state.extras)}` : ''}`}</pre>}
              </details>
            </div>
          </div>

          <details className="card flat filters-wrap" open={typeof window !== 'undefined' && window.innerWidth > 900}><summary className="filters-sum">Filters & sort</summary><div className="filters">
            <label className="field">Market<Seg value={channel} onChange={setChannel} options={[{ value: 'any', label: 'From query' }, { value: 'buy', label: 'Buy' }, { value: 'rent', label: 'Rent' }, { value: 'commercial', label: 'Commercial' }]} /></label>
            <label className="field">Max price<select className="input" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value === '' ? '' : Number(e.target.value))}><option value="">From query</option>{[250_000, 350_000, 500_000, 750_000, 1_000_000, 2_000_000].map((v) => <option key={v} value={v}>{gbpK(v)}</option>)}</select></label>
            <label className="field">Min beds<select className="input" value={minBeds} onChange={(e) => setMinBeds(e.target.value === '' ? '' : Number(e.target.value))}><option value="">From query</option>{[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}+</option>)}</select></label>
            <label className="field">Listed by<select className="input" value={src} onChange={(e) => setSrc(e.target.value as typeof src)}><option value="all">Everyone</option><option value="agents">Estate agents</option><option value="private">Private sellers & landlords</option></select></label>
            <label className="field">Sort<select className="input" value={sortValue} onChange={(e) => setSort(e.target.value as Sort)}><option value="fit">Best match</option>{ai.available && <option value="ai">Best match + AI relevance</option>}<option value="score">Deal grade</option><option value="price">Price (low–high)</option></select></label>
          </div></details>

          {sortValue === 'ai' && (rankBusy ? <AiThinking label="Ranking by relevance" />
            : rankReady ? <p className="xs aisr-sortnote"><AiLabel /> Sorted by how closely each listing matches your words, blended with Streetkey’s best-match score.</p>
              : rankFailed === rankKey ? <p className="xs aisr-sortnote" role="status">AI relevance isn’t available right now, so these are in Streetkey’s best-match order.</p> : null)}

          <div className="stack aisr-results" style={{ gap: 16 }} aria-busy={understanding || rankBusy || undefined}>
          {shown.map((h, i) => (
            <div key={h.property.id} className={`listing${active === h.property.id ? ' hl' : ''}`} onMouseEnter={() => setActive(h.property.id)}>
              <Link to={`/property/${h.property.id}`} className="ph"><HouseArt hue={h.property.photoHue} type={h.property.type} seed={i} /></Link>
              <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <Link to={`/property/${h.property.id}`} style={{ minWidth: 0, textDecoration: 'none' }}>
                    <div className="num" style={{ fontSize: 22 }}>{h.property.listing === 'rent' ? `${gbp(h.property.price)} pcm` : gbp(h.property.price)}{h.property.listing === 'auction' && <span className="xs muted"> guide</span>}</div>
                    <div style={{ fontWeight: 600 }}>{h.property.title}</div>
                    <div className="small muted">{h.property.street}, {h.property.town} · {h.property.beds ? `${h.property.beds} bed · ` : ''}{h.property.floorArea}m² · EPC {h.property.epc.current}</div>
                  </Link>
                  {h.property.listing !== 'rent' && <div className={`grade grade-${h.dealGrade}`} title="Streetkey deal grade">{h.dealGrade}</div>}
                </div>
                <ul className="ticks">{h.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                {h.cautions.length > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>⚠ {h.cautions.slice(0, 2).join(' · ')}</div>}
                <div className="row" style={{ gap: 6 }}>
                  <button className={`save-btn${saved.includes(h.property.id) ? ' on' : ''}`} onClick={() => toggleSaved(h.property.id)}>{saved.includes(h.property.id) ? '♥ Saved' : '♡ Save'}</button>
                  <button className={`save-btn${compare.includes(h.property.id) ? ' on' : ''}`} onClick={() => toggleCompare(h.property.id)}>{compare.includes(h.property.id) ? '✓ Comparing' : '+ Compare'}</button>
                  <Link className="save-btn" to={`/property/${h.property.id}/intelligence`} style={{ textDecoration: 'none' }}>Intelligence →</Link>
                  <Tag kind={sourceLabel(h.property).tone}>{sourceLabel(h.property).text}</Tag>
                  {h.property.alsoListedBy?.length ? <span className="xs muted">also listed by {h.property.alsoListedBy.join(', ')}</span> : null}
                  {h.property.listing !== 'rent' && <Tag kind="est">Indicative value-add {gbpK(h.estProfit)}</Tag>}
                </div>
              </div>
            </div>
          ))}
          </div>
        </div>
        <div className="sticky stack">
          <section className="card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Search everywhere</div>
            {external.length ? <>
              <p className="small">See {place} on other sites too:</p>
              <div className="row" style={{ marginTop: 8 }}>{external.map((l) => <a key={l.site} className="btn ghost sm" href={l.url} target="_blank" rel="noopener noreferrer">{l.site} ↗</a>)}</div>
            </> : <p className="small">Add a place to your search to open it on other property sites too.</p>}
            <div className="hr" />
            <p className="small"><b>Found one you like elsewhere?</b> Paste it into Streetkey for a price check, renovation cost and investment view.</p>
            <Link to="/import" className="btn sm" style={{ marginTop: 8 }}>Check any listing →</Link>
          </section>
          <UKMap pins={shown.map((h) => ({ id: h.property.id, lat: h.property.lat, lng: h.property.lng, label: h.property.town.split(',')[0], active: active === h.property.id }))} onPin={setActive} />
          {compare.length > 0 && <Link to="/compare" className="btn">Compare {compare.length} selected →</Link>}
          <div className="card flat small">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Data provenance</div>
            <ul className="ticks muted">
              <li>Listings: fictional demo set. Production: agent CRM feeds, auction partners and owner-submitted listings — never scraped portals.</li>
              <li>Commute: stored per listing. Production: TfL Unified API, NaPTAN, BODS + routing.</li>
              <li>Schools: Ofsted / Estyn / Education Scotland open data (planned).</li>
              <li>Sold prices: HM Land Registry Price Paid (OGL) — planned.</li>
              <li>Search understanding: Streetkey AI turns your words into filters when it’s available; it never chooses listings, prices or scores.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
