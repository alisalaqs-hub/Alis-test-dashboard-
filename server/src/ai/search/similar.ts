/**
 * "Similar homes" and semantic re-ranking.
 *
 * Similar: hard constraints in code (same channel, ±35% price, ±1 bed, commercial with
 * commercial), then cosine similarity of listing embeddings blended with structural closeness.
 * Each card's reason is written in code from the facts, so it is free, instant and true.
 * If embeddings are unavailable the structural ranking is returned (semantic: false).
 *
 * Rank: orders candidate ids by similarity to the query's embedding; the website blends this
 * with the engine's own fit score.
 */
import { getProperty, PROPERTIES, type Property } from '../../../../src/data/properties';
import { isLiveRef, isPublic, similarOk, similarReason, structuralSimilarity, toSimilarItem, type RankResult, type SimilarResult } from '../../../../src/lib/ai/search';
import { q } from '../../db';
import { notFound } from '../../services/http';
import { AiError, cosine } from '../core';
import { ensureLiveRegistry } from '../registry';
import { queryVector, vectorsFor } from './vectors';

/** Candidates considered for "similar" before embeddings (bounds the embedding work). */
const POOL = 60;
const SEMANTIC_WEIGHT = 0.6;

/** Lead photo URLs (public /media/... paths) for live listings, by ref. */
async function leadPhotos(refs: string[]) {
  if (!refs.length) return new Map<string, string>();
  const rows = await q<{ ref: string; url: string }>(
    `SELECT DISTINCT ON (p.listing_id) l.ref, p.url FROM listing_photos p JOIN listings l ON l.id = p.listing_id
      WHERE l.ref = ANY($1) ORDER BY p.listing_id, p.position, p.created_at`, [refs]);
  return new Map(rows.map((r) => [r.ref, r.url]));
}

export async function similarHomes(id: string, meta: { userId: string | null }, limit = 6): Promise<SimilarResult> {
  await ensureLiveRegistry();
  const target = getProperty(id);
  if (!target || !isPublic(target)) throw notFound('That listing');
  const pool = PROPERTIES.filter((p) => isPublic(p) && similarOk(target, p))
    .map((p) => ({ p, s: structuralSimilarity(target, p) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, POOL);
  if (!pool.length) return { items: [], semantic: false };

  let vecs = new Map<string, number[]>();
  let semantic = false;
  try {
    vecs = await vectorsFor([target, ...pool.map((x) => x.p)], { purpose: 'search.similar', userId: meta.userId });
    semantic = vecs.has(target.id);
  } catch (e) {
    if (!(e instanceof AiError)) throw e; // degrade to structural ranking when the AI is unavailable
  }
  const tv = vecs.get(target.id);
  const scored = pool.map(({ p, s }) => {
    const v = vecs.get(p.id);
    const sem = tv && v ? Math.max(0, cosine(tv, v)) : null;
    return { p, score: sem == null ? s : SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * s };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  const photos = await leadPhotos(scored.filter((x) => isLiveRef(x.p.id)).map((x) => x.p.id));
  return {
    semantic,
    items: scored.map(({ p, score }) => toSimilarItem(p, similarReason(target, p), score, isLiveRef(p.id) ? photos.get(p.id) ?? null : p.photos?.[0] ?? null)),
  };
}

export async function rankByQuery(text: string, ids: string[], meta: { userId: string | null }): Promise<RankResult> {
  await ensureLiveRegistry();
  const unique = [...new Set(ids)];
  const props = unique.map((id) => getProperty(id)).filter((p): p is Property => !!p && isPublic(p));
  const known = new Set(props.map((p) => p.id));
  const missing = unique.filter((id) => !known.has(id));
  if (!props.length) return { items: [], missing };
  const m = { purpose: 'search.rank', userId: meta.userId };
  const [qv, vecs] = await Promise.all([queryVector(text, m), vectorsFor(props, m)]);
  const items = props
    .filter((p) => vecs.has(p.id))
    .map((p) => ({ id: p.id, score: Math.round(cosine(qv, vecs.get(p.id)!) * 10_000) / 10_000 }))
    .sort((a, b) => b.score - a.score);
  return { items, missing: [...missing, ...props.filter((p) => !vecs.has(p.id)).map((p) => p.id)] };
}
