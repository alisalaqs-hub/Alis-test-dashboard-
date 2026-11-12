import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import { slugPlace, unslugPlace, usePageMeta } from '../lib/meta';
import { describeQuery, runSearch, type SearchHit, type SearchQuery } from '../engine/search';
import { gbp, gbpK, HouseArt, Seg, streetName, Tag, UKMap } from '../components/ui';
import { useStore } from '../store';
import { pointInPolygon, type LngLat } from '../engine/geo';
import { latestPriceMove } from '../engine/history';
import type { Property } from '../data/properties';
import { ApiError } from '../lib/api';
import { aiPost, useAi } from '../lib/ai/core';
import {
  applyExtras, fromRules, MAX_QUERY_CHARS, modeOfQuery, mustHavesIn, rankText, SEARCH_MODES, savedFilters, withoutChips,
  type IntentResult, type RankResult, type SearchChip, type SearchMode,
} from '../lib/ai/search';
import { AiErrorNote, AiLabel, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { Icon } from '../components/Icons';
import '../components/ai/search.css';

function sourceLabel(p: Property) {
  if (!p.source) return { text: 'Example listing', tone: 'demo' as const };
  if (p.source.kind === 'agent-feed') return { text: p.source.name.replace(' (agent feed)', ''), tone: 'ok' as const };
  return { text: p.source.name, tone: 'neutral' as const };
}

/** Streetkey's own summary of the results, written in code from the engine's figures (never by AI). */
function narrate(q: SearchQuery, hits: SearchHit[]): string[] {
  const out: string[] = [];
  if (!hits.length) return ['Nothing in the current dataset meets the hard constraints (type, budget, beds, location/commute). Try widening the budget, commute or area.'];
  const best = hits[0];
  out.push(`${hits.length} propert${hits.length === 1 ? 'y meets' : 'ies meet'} your hard constraints, ranked by fit and underwritten potential (refurb cost from the Streetkey engine, value from comparables, risk and demand).`);
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

/** The street map is a large library: it loads only when the search page opens. */
const MapSearch = lazy(() => import('../components/MapSearch'));

const orList = (items: string[]) => {
  try { return new Intl.ListFormat('en-GB', { style: 'long', type: 'disjunction' }).format(items); } catch { return items.join(', '); }
};

type Channel = 'any' | 'buy' | 'rent' | 'commercial';
type Sort = 'fit' | 'price' | 'score' | 'ai';
const CHANNELS: readonly Channel[] = ['any', 'buy', 'rent', 'commercial'];
const PRICE_OPTIONS = [250_000, 350_000, 500_000, 750_000, 1_000_000, 2_000_000];
const BED_OPTIONS = [1, 2, 3, 4, 5];
/** Removed chips kept in the URL: at most this many, each a short key. */
const MAX_REMOVED = 20;

/** The example search shown when the page opens without ?q. The built-in rules read it well, so it never costs an AI request. */
const EXAMPLE_QUERY = 'Find me a three-bedroom house within 45 minutes of central London for under £500,000 that requires refurbishment but has potential for a good investment return.';
/** AI readings already fetched this visit (so going back to a search doesn't ask again). */
const readings = new Map<string, IntentResult>();
const rememberReading = (key: string, r: IntentResult) => { if (readings.size >= 30) readings.delete(readings.keys().next().value!); readings.set(key, r); };
/** Limits that mean the AI reading can't come back on a retry soon: the page says so instead of failing silently. */
const isLimit = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 429 || e.code === 'rate_limited' || e.code === 'ai_user_limit' || e.code === 'ai_budget');

/** The page's filters (Market, Max price, Min beds) applied on top of what the words say. */
function withPageFilters(query: SearchQuery, channel: Channel, maxPrice: number | '', minBeds: number | ''): SearchQuery {
  const base: SearchQuery = { ...query, locations: [...query.locations], districts: [...query.districts], types: [...query.types], unsupported: [...query.unsupported] };
  if (channel === 'rent') base.intent = 'rent';
  if (channel === 'buy' && base.intent === 'rent') base.intent = 'buy';
  if (channel === 'commercial') { base.commercial = true; base.types = []; }
  if (maxPrice !== '') base.maxPrice = maxPrice;
  if (minBeds !== '') base.minBeds = minBeds;
  return base;
}

const choice = <T extends number>(raw: string | null, allowed: readonly T[]): T | '' => { const n = Number(raw); return raw && (allowed as readonly number[]).includes(n) ? (n as T) : ''; };

export default function Search() {
  /*
   * The URL is the source of truth: q (the words), mode (the search box tab they came from), market,
   * max and beds (page filters) and without (chips removed). Back, Forward, reloads, shared links and
   * a search from the Ask sheet while this page is open all show exactly the search in the address bar.
   */
  const [params, setParams] = useSearchParams();
  // A place page (/for-sale/leeds, /to-rent/e17) is a ready-made search with its own address; ?q= still wins.
  const { place } = useParams();
  const toRent = !!useMatch('/to-rent/:place');
  const placeName = place ? unslugPlace(place) : '';
  const qParam = params.get('q') ?? (placeName ? `Homes ${toRent ? 'to rent' : 'for sale'} in ${placeName}` : null);
  const fullText = qParam ?? EXAMPLE_QUERY;
  // Both readings (AI and built-in rules) use the same, length-limited text, so they can't disagree.
  const submitted = fullText.slice(0, MAX_QUERY_CHARS);
  const shortened = fullText.trim().length > MAX_QUERY_CHARS;
  const modeParam = params.get('mode') ?? (placeName ? (toRent ? 'rent' : 'buy') : null);
  const mode: SearchMode | null = (SEARCH_MODES as readonly string[]).includes(modeParam ?? '') ? (modeParam as SearchMode) : null;
  const defaultChannel: Channel = mode === 'rent' ? 'rent' : mode === 'commercial' ? 'commercial' : 'any';
  const marketParam = params.get('market');
  const channel: Channel = (CHANNELS as readonly string[]).includes(marketParam ?? '') ? (marketParam as Channel) : defaultChannel;
  const maxPrice = choice(params.get('max'), PRICE_OPTIONS);
  const minBeds = choice(params.get('beds'), BED_OPTIONS);
  const withoutKey = params.getAll('without').join('\n');
  const removed = useMemo(() => [...new Set(withoutKey ? withoutKey.split('\n') : [])].filter((k) => k && k.length <= 80).slice(0, MAX_REMOVED), [withoutKey]);

  /** Changes some parameters, keeping the rest. Filter changes replace the history entry; new searches add one. */
  const update = (patch: Record<string, string | string[] | null>, replace = true) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v != null && v !== '') next.set(k, v);
    }
    return next;
  }, { replace });

  const [text, setText] = useState(fullText);
  // A new search in the address bar (Back, Forward, the Ask sheet, a link) shows its words in the box.
  useEffect(() => { setText(fullText.slice(0, MAX_QUERY_CHARS)); }, [fullText]);
  const [active, setActive] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [sort, setSort] = useState<Sort>('fit');
  const { saved, compare, toggleSaved, toggleCompare, savedSearches, toggleSavedSearch, addRecent, myListings, feedListings, serverListings } = useStore();
  const [src, setSrc] = useState<'all' | 'agents' | 'private'>('all');
  /** The area drawn on the map (its corners), the map having failed to start, and list or map on small screens. */
  const [area, setArea] = useState<LngLat[] | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const searchSaved = savedSearches.some((s) => s.q === submitted);
  const ai = useAi();
  // Arriving with a search the person just made (from the header, Home or the Ask sheet) counts as
  // asking for it, so "reading your search" is announced; a reload, Back or Forward stays quiet.
  const arrivedBySearch = useNavigationType() === 'PUSH';
  const inputRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLElement>(null);

  /* What the search means: Streetkey AI when available, else (and until it answers) the built-in parser. */
  const readingKey = `${mode ?? ''}|${submitted}`;
  const rules = useMemo(() => fromRules(submitted, mode), [submitted, mode]);
  const [aiReading, setAiReading] = useState<{ key: string; r: IntentResult } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [limited, setLimited] = useState<{ key: string; error: ApiError } | null>(null);
  useEffect(() => {
    const words = submitted.trim();
    if (!ai.available || !words || submitted === EXAMPLE_QUERY) return;
    const hit = readings.get(readingKey);
    if (hit) { setAiReading({ key: readingKey, r: hit }); return; }
    let live = true;
    setPending(readingKey);
    aiPost<IntentResult>('/api/ai/search/intent', { q: words, mode }, 15_000)
      .then((r) => { rememberReading(readingKey, r); if (live) setAiReading({ key: readingKey, r }); })
      .catch((e: unknown) => {
        // A daily or rate limit: say why the AI reading isn't here (the built-in rules' results already show).
        // Anything else (network, timeouts, a model error) stays silent: the built-in reading is just as usable.
        if (live && isLimit(e)) setLimited({ key: readingKey, error: e });
      })
      .finally(() => { if (live) setPending((p) => (p === readingKey ? null : p)); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.available, readingKey]);
  const reading = aiReading?.key === readingKey ? aiReading.r : rules;
  const usingAi = reading.source === 'ai';
  const understanding = ai.available && pending === readingKey && !usingAi;
  const limitError = limited?.key === readingKey && !usingAi ? limited.error : null;

  // Focus stays with the chips after removing one or undoing; the search box if no chips are left.
  const refocus = () => requestAnimationFrame(() => (chipsRef.current ?? inputRef.current)?.focus());
  const removeChip = (k: string) => { update({ without: [...removed.filter((x) => x !== k), k] }); refocus(); };
  const undoLast = () => { update({ without: removed.slice(0, -1) }); refocus(); };
  const restoreAll = () => { update({ without: null }); refocus(); };
  const state = useMemo(() => withoutChips(reading, removed), [reading, removed]);

  const q = useMemo(() => withPageFilters(state.query, channel, maxPrice, minBeds), [state, channel, maxPrice, minBeds]);
  const fitHits = useMemo(() => applyExtras(runSearch(q), state.extras),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q, state.extras, myListings.length, feedListings.length, serverListings.length]);

  // Filters on the page override the matching chips, so those chips are hidden while a filter is set.
  const overridden = new Set([...(maxPrice !== '' ? ['maxPrice'] : []), ...(minBeds !== '' ? ['minBeds'] : []), ...(channel !== 'any' ? ['intent'] : [])]);
  const chips = reading.understood.filter((c) => !removed.includes(c.key) && !overridden.has(c.key));
  const filterChips = chips.filter((c) => c.kind !== 'preference');
  const prefChips = chips.filter((c) => c.kind === 'preference');
  const labelOf = (key: string) => reading.understood.find((c) => c.key === key)?.label ?? key.replace(/^[a-z]+:/i, '');

  /*
   * Optional AI relevance sort: re-rank the top 60 by meaning, blended with the engine's fit.
   * It embeds the chips still in force (never the raw words), so removed chips and anything about
   * who lives somewhere can't change the order, and it isn't offered for a search that asked about that.
   */
  const rankWords = rankText(chips);
  const canRank = ai.available && !reading.policyNote && rankWords.length > 0;
  const wantAiSort = sort === 'ai' && canRank;
  const candidates = useMemo(() => fitHits.slice(0, 60).map((h) => h.property.id), [fitHits]);
  const rankKey = `${rankWords}|${candidates.join(',')}`;
  const [rank, setRank] = useState<{ key: string; scores: Map<string, number> } | null>(null);
  const [rankFailed, setRankFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!wantAiSort || !candidates.length || rank?.key === rankKey) return;
    let live = true;
    aiPost<RankResult>('/api/ai/search/rank', { q: rankWords, ids: candidates }, 15_000)
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
  // Place pages are offered to search engines only when they show real homes: example listings never are.
  const realHits = hits.filter((h) => !!h.property.source).length;
  usePageMeta(placeName
    ? { title: `Homes ${toRent ? 'to rent' : 'for sale'} in ${placeName}`, description: `${realHits || 'Search'} homes ${toRent ? 'to rent' : 'for sale'} in ${placeName} on Streetkey, each with sold prices nearby, flood risk, its energy rating and the cost of works.`, index: realHits > 0 && !params.get('q'), canonical: `/${toRent ? 'to-rent' : 'for-sale'}/${slugPlace(placeName)}` }
    : { title: 'Search homes for sale and to rent', index: false });
  const matched = hits.filter((h) => src === 'all' || (src === 'agents' ? h.property.source?.kind === 'agent-feed' || !h.property.source : h.property.source?.kind === 'owner' || h.property.source?.kind === 'landlord'));
  // An area drawn on the map narrows the results to the homes inside it.
  const shown = area ? matched.filter((h) => pointInPolygon([h.property.lng, h.property.lat], area)) : matched;
  const narrative = useMemo(() => narrate(q, hits), [q, hits]);

  /** A new search: its own history entry, keeping the box mode and page filters (removed chips belong to the old words). */
  const run = (next: string) => {
    const words = next.trim().slice(0, MAX_QUERY_CHARS);
    if (!words) return;
    update({ q: words, without: null }, words === submitted.trim() && !removed.length);
    addRecent(words, modeOfQuery(withPageFilters(fromRules(words, mode).query, channel, maxPrice, minBeds)));
  };
  const submit = () => run(text);
  /**
   * A clarifying answer: added to the words (shortening the original, never the answer). The question and
   * chips disappear while the new reading loads, so focus moves to the results count (always there, and
   * announced) rather than being lost.
   */
  const refine = (extra: string) => {
    const add = extra.trim().slice(0, 60);
    const room = Math.max(0, MAX_QUERY_CHARS - add.length - 1);
    const next = `${submitted.trim().slice(0, room).trim()} ${add}`.trim();
    setText(next);
    run(next);
    requestAnimationFrame(() => countRef.current?.focus());
  };

  /**
   * Saves the words with the filters shown (so alerts run exactly this search), in the mode they mean.
   * The account sync (src/lib/server.tsx) sends both to the account when signed in, or at the next sign-in.
   */
  const toggleSave = () => toggleSavedSearch(submitted, modeOfQuery(q), savedFilters(q, state.extras));

  const sortValue: Sort = sort === 'ai' && !canRank ? 'fit' : sort;
  const extrasShown = state.extras.minPrice != null || state.extras.maxBeds != null || state.extras.mustHaves.length > 0;
  const nearLimit = text.length >= MAX_QUERY_CHARS - 40;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head desktop-only">
        <div><div className="eyebrow">{ai.available ? 'AI property search' : 'Property search'}</div><h2 style={{ marginTop: 6 }}>Describe what you want</h2></div>
      </div>
      <div className="view-switch chips" role="group" aria-label="Show results as">
        <button type="button" className="chip" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        <button type="button" className="chip" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
      </div>
      <div className={`split-r search-cols show-${view}`}>
        <div className="stack results-col" style={{ gap: 16 }}>
          <div className="card ai-card search-head">
            <form className="smart-box" style={{ boxShadow: 'none' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <span className="smart-icon smart-icon-ai" aria-hidden="true"><Icon name="spark" stroke={2.2} /></span>
              <input ref={inputRef} value={text} maxLength={MAX_QUERY_CHARS} onChange={(e) => setText(e.target.value)} aria-label="Search Streetkey" aria-describedby={nearLimit ? 'search-count' : undefined} enterKeyHint="search" placeholder="Place or describe it" />
              <button className="smart-go" type="submit">Search</button>
            </form>
            {nearLimit && <p id="search-count" className="xs muted aisr-count" aria-live="polite">{MAX_QUERY_CHARS - text.length} of {MAX_QUERY_CHARS} characters left</p>}
            {shortened && <p className="xs muted aisr-note" role="note">Only the first {MAX_QUERY_CHARS} characters of this search were used.</p>}
            <div className="row between" style={{ marginTop: 10, flexWrap: 'nowrap', gap: 8 }}>
              <b className="small aisr-count-n" ref={countRef} tabIndex={-1} aria-live="polite">{shown.length} result{shown.length === 1 ? '' : 's'}{area ? ' in your area' : ''}</b>
              <button className={`save-btn${searchSaved ? ' on' : ''}`} onClick={toggleSave}>{searchSaved ? '♥ Saved' : '♡ Save search'}</button>
            </div>

            {!ai.available && <AiUnavailable reason={ai.reason} feature="Streetkey AI search" />}
            {limitError && (
              <div className="aisr-limit">
                <AiErrorNote error={limitError} />
                <p className="xs muted">Your search was read without AI this time.</p>
              </div>
            )}
            {understanding && <div className="aisr-busy"><AiThinking label="Streetkey AI is reading your search" announce={arrivedBySearch || 'auto'} /></div>}
            {/* Always mounted, so what the AI understood, its question and notes are announced when they appear. */}
            <div className="aisr-reading" aria-live="polite">
              {!understanding && (chips.length > 0 || removed.length > 0) && (
                <div className="aisr-understood" ref={chipsRef} tabIndex={-1} role="group" aria-label={usingAi ? 'What Streetkey AI understood' : 'What you searched for'}>
                  <span className="aisr-understood-h">{usingAi ? <AiLabel>AI understood</AiLabel> : 'Searching for'}</span>
                  {filterChips.length > 0 ? (
                    <ul className="ai-chips">
                      {filterChips.map((c) => (
                        <li key={c.key} className={`ai-chip aisr-chip${c.removable ? '' : ' fixed'}`}>
                          <span>{c.label}</span>
                          {c.removable && <button type="button" className="aisr-chip-x" aria-label={`Remove ${c.label}`} title="Remove and search again" onClick={() => removeChip(c.key)}><Icon name="x" size={14} /></button>}
                        </li>
                      ))}
                    </ul>
                  ) : <span className="small aisr-understood-none">No filters from your words are left.</span>}
                  {removed.length > 0 && <button type="button" className="linkish small" onClick={undoLast} aria-label={`Undo: put back ${labelOf(removed[removed.length - 1])}`}>Undo</button>}
                  {removed.length > 1 && <button type="button" className="linkish small" onClick={restoreAll}>Restore all ({removed.length})</button>}
                </div>
              )}
              {!understanding && prefChips.length > 0 && <Preferences chips={prefChips} hits={shown} onRemove={removeChip} />}
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

            {/* Written by Streetkey's code from the engine's results, so it is never labelled as AI. */}
            <div className="msg sk-summary" style={{ maxWidth: '100%', marginTop: 10 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}><Tag kind="neutral">Streetkey summary</Tag><p className="small">{narrative[narrative.length > 2 && /^Honest/.test(narrative[1]) ? 1 : 0]}</p></div>
              <details className="why"><summary>Why these results?</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>{narrative.map((n, i) => <p key={i} className="small">{n}</p>)}</div>
                {q.unsupported.length > 0 && <div className="callout info small" style={{ marginTop: 10 }}><b>Not yet covered:</b> {q.unsupported.join(' ')}</div>}
                <div className="parsed" style={{ marginTop: 10 }}>{describeQuery(q).map((d) => <span key={d}>{d}</span>)}</div>
                <p className="xs muted" style={{ marginTop: 8 }}>{usingAi ? 'Streetkey AI turned your words into these filters; the listings, prices, scores and this summary come from Streetkey’s own data and engines.' : 'Streetkey turned your words into these filters; the listings, prices, scores and this summary come from Streetkey’s own data and engines.'}</p>
                <button className="btn ghost sm" style={{ marginTop: 10 }} aria-expanded={showJson} onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} structured query</button>
                {showJson && <pre tabIndex={0} className="code" style={{ marginTop: 10 }}>{`${usingAi ? '// Built by Streetkey AI from your words (JSON-schema validated, numbers checked against what you typed).' : '// Built by Streetkey’s rule-based parser.'}\n// Filtering, costing and ranking are deterministic.\nsearch_properties(${JSON.stringify(q, null, 2)})${extrasShown ? `\n// Also applied: ${JSON.stringify(state.extras)}` : ''}`}</pre>}
              </details>
            </div>
          </div>

          <details className="card flat filters-wrap" open={typeof window !== 'undefined' && window.innerWidth > 900}><summary className="filters-sum">Filters & sort</summary><div className="filters">
            <div className="field"><span id="search-market">Market</span><Seg aria-labelledby="search-market" value={channel} onChange={(v) => update({ market: v === defaultChannel ? null : v })} options={[{ value: 'any', label: 'From query' }, { value: 'buy', label: 'Buy' }, { value: 'rent', label: 'Rent' }, { value: 'commercial', label: 'Commercial' }]} /></div>
            <label className="field">Max price<select className="input" value={maxPrice} onChange={(e) => update({ max: e.target.value || null })}><option value="">From query</option>{PRICE_OPTIONS.map((v) => <option key={v} value={v}>{gbpK(v)}</option>)}</select></label>
            <label className="field">Min beds<select className="input" value={minBeds} onChange={(e) => update({ beds: e.target.value || null })}><option value="">From query</option>{BED_OPTIONS.map((v) => <option key={v} value={v}>{v}+</option>)}</select></label>
            <label className="field">Listed by<select className="input" value={src} onChange={(e) => setSrc(e.target.value as typeof src)}><option value="all">Everyone</option><option value="agents">Estate agents</option><option value="private">Private sellers & landlords</option></select></label>
            <label className="field">Sort<select className="input" value={sortValue} onChange={(e) => setSort(e.target.value as Sort)}><option value="fit">Best match</option>{canRank && <option value="ai">Best match + AI relevance</option>}<option value="score">Deal grade</option><option value="price">Price (low–high)</option></select></label>
          </div></details>

          {sortValue === 'ai' && (rankBusy ? <AiThinking label="Ranking by relevance" />
            : rankReady ? <p className="xs aisr-sortnote"><AiLabel /> Sorted by how closely each listing matches what you’re searching for, blended with Streetkey’s best-match score.</p>
              : rankFailed === rankKey ? <p className="xs aisr-sortnote" role="status">AI relevance isn’t available right now, so these are in Streetkey’s best-match order.</p> : null)}

          <div className="stack aisr-results" style={{ gap: 16 }} aria-busy={understanding || rankBusy || undefined}>
          {shown.map((h, i) => (
            <div key={h.property.id} id={`hit-${h.property.id}`} className={`listing${active === h.property.id ? ' hl' : ''}`} onMouseEnter={() => setActive(h.property.id)}>
              <Link to={`/property/${h.property.id}`} className="ph" tabIndex={-1} aria-hidden="true"><HouseArt hue={h.property.photoHue} type={h.property.type} seed={i} /></Link>
              <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <Link to={`/property/${h.property.id}`} style={{ minWidth: 0, textDecoration: 'none' }}>
                    <div className="num" style={{ fontSize: 22 }}>{h.property.listing === 'rent' ? `${gbp(h.property.price)} pcm` : gbp(h.property.price)}{h.property.listing === 'auction' && <span className="xs muted"> guide</span>}</div>
                    <div style={{ fontWeight: 600 }}>{h.property.title}</div>
                    <div className="small muted">{streetName(h.property.street)}, {h.property.town} · {h.property.beds ? `${h.property.beds} bed · ` : ''}{h.property.floorArea}m² · EPC {h.property.epc.current}</div>
                  </Link>
                  {h.property.listing !== 'rent' && <div className={`grade grade-${h.dealGrade}`} title="Streetkey deal grade">{h.dealGrade}</div>}
                </div>
                <ul className="ticks">{h.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                {h.cautions.length > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>⚠ {h.cautions.slice(0, 2).join(' · ')}</div>}
                <div className="row" style={{ gap: 6 }}>
                  <button className={`save-btn${saved.includes(h.property.id) ? ' on' : ''}`} aria-label={`${saved.includes(h.property.id) ? 'Saved' : 'Save'}: ${h.property.title}`} onClick={() => toggleSaved(h.property.id)}>{saved.includes(h.property.id) ? '♥ Saved' : '♡ Save'}</button>
                  <button className={`save-btn${compare.includes(h.property.id) ? ' on' : ''}`} aria-label={`${compare.includes(h.property.id) ? 'Comparing' : 'Compare'}: ${h.property.title}`} onClick={() => toggleCompare(h.property.id)}>{compare.includes(h.property.id) ? '✓ Comparing' : '+ Compare'}</button>
                  <Link className="save-btn" to={`/property/${h.property.id}/intelligence`} style={{ textDecoration: 'none' }} aria-label={`Intelligence: ${h.property.title}`}>Intelligence →</Link>
                  <Tag kind={sourceLabel(h.property).tone}>{sourceLabel(h.property).text}</Tag>
                  {/* Real listings: Streetkey's own record of the listing, which the big portals don't show. */}
                  {h.property.history && h.property.history.daysOnMarket <= 7 && <Tag kind="ok">New</Tag>}
                  {latestPriceMove(h.property.history) === 'reduced' && <Tag kind="warn">Reduced</Tag>}
                  {h.property.alsoListedBy?.length ? <span className="xs muted">also listed by {h.property.alsoListedBy.join(', ')}</span> : null}
                  {h.property.listing !== 'rent' && <Tag kind="est">Indicative value-add {gbpK(h.estProfit)}</Tag>}
                </div>
              </div>
            </div>
          ))}
          </div>
        </div>
        <div className="sticky stack map-col">
          <section className="card">
            <p className="small" style={{ margin: 0 }}><b>Found one you like elsewhere?</b> Paste it into Streetkey for a price check, renovation cost and investment view.</p>
            <Link to="/import" className="btn sm" style={{ marginTop: 8 }}>Check any listing →</Link>
          </section>
          {mapFailed
            ? <div className="map-block">{<UKMap pins={shown.map((h) => ({ id: h.property.id, lat: h.property.lat, lng: h.property.lng, label: h.property.town.split(',')[0], active: active === h.property.id }))} onPin={setActive} />}</div>
            : <Suspense fallback={<div className="map-block"><div className="map-real map-loading" role="status">Loading the map…</div></div>}>
                <MapSearch homes={shown.map((h) => ({ id: h.property.id, lat: h.property.lat, lng: h.property.lng, label: h.property.title, price: h.property.listing === 'rent' ? `${gbp(h.property.price)} pcm` : gbpK(h.property.price) }))}
                  active={active} onPick={(id) => { setActive(id); setView('list'); requestAnimationFrame(() => document.getElementById(`hit-${id}`)?.scrollIntoView({ block: 'nearest' })); }} area={area} onArea={setArea} onFail={() => setMapFailed(true)} />
              </Suspense>}
          {compare.length > 0 && <Link to="/compare" className="btn">Compare {compare.length} selected →</Link>}
        </div>
      </div>
    </div>
  );
}

/**
 * Must-haves the engine can't filter on ("balcony", "driveway"): homes whose own description or
 * features mention them come first. Shown apart from the filters, with how many results mention each,
 * because they never hide a home.
 */
function Preferences({ chips, hits, onRemove }: { chips: SearchChip[]; hits: SearchHit[]; onRemove: (key: string) => void }) {
  const counts = useMemo(() => new Map(chips.map((c) => {
    const term = c.key.slice('must:'.length);
    return [c.key, hits.filter((h) => mustHavesIn(h.property, [term]).length > 0).length] as const;
  })), [chips, hits]);
  return (
    <div className="aisr-understood aisr-prefs" role="group" aria-labelledby="search-prefs-h" aria-describedby="search-prefs-d">
      <span className="aisr-understood-h" id="search-prefs-h">Preferences</span>
      <ul className="ai-chips">
        {chips.map((c) => (
          <li key={c.key} className="ai-chip aisr-chip aisr-pref">
            <span>Prefer: {c.label}{hits.length > 0 && <span className="aisr-pref-n"> · {counts.get(c.key) ?? 0} of {hits.length} mention it</span>}</span>
            <button type="button" className="aisr-chip-x" aria-label={`Remove preference ${c.label}`} title="Remove" onClick={() => onRemove(c.key)}><Icon name="x" size={14} /></button>
          </li>
        ))}
      </ul>
      <p id="search-prefs-d" className="xs muted aisr-prefs-d">Homes that mention these come first. They don’t hide other homes.</p>
    </div>
  );
}

