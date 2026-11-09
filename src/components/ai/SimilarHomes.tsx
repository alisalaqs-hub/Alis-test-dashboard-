/**
 * "Similar homes" on a property page.
 * With Streetkey AI: listings matched by meaning (description and features) within hard limits
 * (same market, ±35% price, ±1 bedroom, the same area or city unless fewer than 3 local homes
 * qualify). Without it (static preview, AI off, or a failure): the same limits ranked by location,
 * price and size in the browser. Each card's reason is written in code from the facts, never by
 * the model, and a home in another city says which city it is in.
 *
 * Cost: the AI is asked only once the section is about to scroll into view, only for listings
 * the server can know (live Streetkey listings and the demo set), and at most once per listing
 * per visit, so browsing doesn't use up anyone's daily AI allowance.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { baseListings, PROPERTIES, type Property } from '../../data/properties';
import { aiGet, useAi } from '../../lib/ai/core';
import { isLiveRef, placeLabel, ruleSimilar, type SimilarItem, type SimilarResult } from '../../lib/ai/search';
import { mediaUrl } from '../../lib/api';
import { gbp, HouseArt, Section } from '../ui';
import { AiLabel, AiThinking } from './Ai';
import './search.css';

const TYPE: Record<Property['type'], string> = { terraced: 'terraced', 'semi-detached': 'semi', detached: 'detached', flat: 'flat', bungalow: 'bungalow', commercial: 'commercial' };
const price = (it: SimilarItem) => (it.listing === 'rent' ? `${gbp(it.price)} pcm` : it.listing === 'auction' ? `${gbp(it.price)} guide` : gbp(it.price));

/** Answers already fetched this visit, by listing id (small and bounded). */
const answers = new Map<string, SimilarResult>();
const remember = (id: string, r: SimilarResult) => { if (answers.size >= 40) answers.delete(answers.keys().next().value!); answers.set(id, r); };

/** Listings the server has: live Streetkey listings and the demo set (not ones only this browser knows). */
const serverKnows = (p: Property) => isLiveRef(p.id) || (!p.source && baseListings().some((b) => b.id === p.id));

export function SimilarHomes({ property }: { property: Property }) {
  const { available } = useAi();
  const registrySize = PROPERTIES.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fallback = useMemo(() => ruleSimilar(property, PROPERTIES), [property, registrySize]);
  const [ai, setAi] = useState<{ id: string; r: SimilarResult } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Which listing's section has come near the viewport (reset when the page shows another listing).
  const [nearId, setNearId] = useState<string | null>(null);
  const near = nearId === property.id;
  const boxRef = useRef<HTMLDivElement>(null);
  const wantAi = available && property.visibility !== 'private' && serverKnows(property);

  // Start loading when the section is about to come into view.
  useEffect(() => {
    if (!wantAi || near) return;
    const el = boxRef.current;
    const id = property.id;
    if (!el || typeof IntersectionObserver === 'undefined') { setNearId(id); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNearId(id); io.disconnect(); } }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [wantAi, near, property.id]);

  useEffect(() => {
    if (!wantAi || !near) return;
    const hit = answers.get(property.id);
    if (hit) { setAi({ id: property.id, r: hit }); return; }
    let live = true;
    aiGet<SimilarResult>(`/api/ai/search/similar/${encodeURIComponent(property.id)}`, 15_000)
      .then((r) => { remember(property.id, r); if (live) setAi({ id: property.id, r }); })
      .catch(() => { if (live) setFailed(property.id); });
    return () => { live = false; };
  }, [wantAi, near, property.id]);

  const answer = ai?.id === property.id ? ai.r : null;
  const waiting = wantAi && !answer && failed !== property.id;
  const fromAi = !!answer && answer.items.length > 0;
  const items = fromAi ? answer!.items : fallback;
  const semantic = fromAi && answer!.semantic;

  return (
    <div className="aisr-similar" ref={boxRef}>
      <Section title={<span className="aisr-similar-h">Similar homes{semantic && <AiLabel>AI match</AiLabel>}</span>}>
        {waiting ? (near ? <AiThinking label="Finding similar homes" /> : <div className="aisr-similar-wait" aria-hidden="true" />) : items.length === 0 ? (
          <p className="small muted aisr-similar-empty">No close matches right now. <Link to="/search">Search all homes</Link></p>
        ) : (
          <>
            <ul className="carousel" aria-label={`Homes similar to ${property.title}`}>
              {items.map((it, i) => (
                <li key={it.id} className="pcard">
                  <Link to={`/property/${it.id}`} className="pcard-img" tabIndex={-1} aria-hidden="true">
                    {it.photo ? <img src={mediaUrl(it.photo)} alt="" loading="lazy" /> : <HouseArt hue={it.photoHue} type={it.type} seed={i + 2} />}
                  </Link>
                  <Link to={`/property/${it.id}`} className="pcard-body">
                    <span className="num" style={{ fontSize: 19 }}>{price(it)}</span>
                    <span className="small" style={{ fontWeight: 600 }}>{it.beds ? `${it.beds} bed ` : ''}{TYPE[it.type] ?? it.type} · {placeLabel(property, it)}</span>
                    <span className="aisr-reason">{it.reason}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="xs muted" style={{ marginTop: 6 }}>
              {semantic
                ? 'Matched by Streetkey AI on each listing’s description and features, within 35% of the price and one bedroom either way.'
                : 'Matched on location, price (within 35%) and bedrooms (one either way). Homes in other cities are shown only when there are few nearby.'}
            </p>
          </>
        )}
      </Section>
    </div>
  );
}
