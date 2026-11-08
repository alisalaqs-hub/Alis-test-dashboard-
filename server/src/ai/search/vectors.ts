/**
 * Embeddings for semantic search: one vector per listing, built from public facts only
 * (never the private address or full postcode).
 *
 * - Live listings: stored in listing_embeddings, refreshed by the 'search.embed' job when a
 *   listing is published or its text changes (skipped when the text hash is unchanged).
 *   Any live listing still missing a vector is embedded on first use.
 * - Demo listings: embedded lazily once, batched into one call, cached per property id +
 *   text hash with cached() for 30 days.
 * - Queries: cached per normalised text for 24h.
 */
import { createHash } from 'node:crypto';
import type { Property } from '../../../../src/data/properties';
import { isLiveRef, normaliseQuery } from '../../../../src/lib/ai/search';
import { q } from '../../db';
import { LISTING_SELECT, type ListingRow } from '../../services/listings';
import { cached, embed, modelFor } from '../core';
import { rowToProperty } from '../registry';

const DEMO_TTL = 30 * 24 * 3600;
const QUERY_TTL = 24 * 3600;
export const EMBED_BATCH = 50;

/** Listing fields whose change alters the embedding text. */
export const TEXT_COLUMNS = new Set(['title', 'description', 'features', 'property_type', 'beds', 'baths', 'floor_area', 'town', 'postcode', 'district', 'channel', 'tenure', 'era', 'condition', 'epc']);

const typeWords = (t: Property['type']) => (t === 'flat' ? 'flat' : t === 'bungalow' ? 'bungalow' : t === 'commercial' ? 'commercial property' : `${t} house`);

/** The text a listing is embedded from: public facts and description, no street or postcode. */
export function propertyText(p: Property): string {
  const channel = p.listing === 'rent' ? 'to rent' : p.listing === 'auction' ? 'for sale by auction' : 'for sale';
  const lines = [
    p.title.replace(/\s*\(fictional\)/gi, ''),
    `${p.beds ? `${p.beds}-bedroom ` : ''}${typeWords(p.type)} ${channel} in ${p.town} (${p.district})`,
    `${p.baths} bathroom${p.baths === 1 ? '' : 's'}, ${p.floorArea} m², ${p.tenure}, built ${p.era}, ${p.condition} condition, EPC ${p.epc.current}`,
    p.features.length ? `Features: ${p.features.join(', ')}` : '',
    !p.source && p.loftPotential !== 'none' ? `Loft potential: ${p.loftPotential}` : '',
    !p.source && p.extensionPotential !== 'none' ? `Extension potential: ${p.extensionPotential}` : '',
    p.description ? p.description.slice(0, 1500) : '',
  ];
  return lines.filter(Boolean).join('\n');
}
export const textHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
/** Vectors are stored rounded: smaller rows and cache entries, same similarity. */
const compact = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);

interface Meta { purpose: string; userId?: string | null }

/* ───────────────────────── demo listings ───────────────────────── */

const memo = new Map<string, number[]>();
const remember = (key: string, v: number[]) => { if (memo.size > 500) memo.clear(); memo.set(key, v); return v; };

/**
 * Vectors for demo listings. Each is cached under its own key (id + text hash), but every
 * miss in one call is embedded in a single batched request.
 */
async function demoVectors(props: Property[], meta: Meta): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!props.length) return out;
  const model = await modelFor('embedding');
  const texts = props.map(propertyText);
  const keys = props.map((p, i) => `search.vec:v1:${model}:${p.id}:${textHash(texts[i])}`);
  const todo: number[] = [];
  props.forEach((p, i) => { const hit = memo.get(keys[i]); if (hit) out.set(p.id, hit); else todo.push(i); });
  if (!todo.length) return out;

  // Every key goes through cached(); misses park here until all keys have been looked up, then embed together.
  const waiting: { i: number; resolve: (v: number[]) => void; reject: (e: unknown) => void }[] = [];
  let reached = 0;
  let release!: () => void;
  const allReached = new Promise<void>((r) => { release = r; });
  const arrive = () => { if (++reached === todo.length) release(); };
  const lookups = todo.map((i) => {
    let missed = false;
    return cached(keys[i], DEMO_TTL, () => new Promise<number[]>((resolve, reject) => { missed = true; waiting.push({ i, resolve, reject }); arrive(); }))
      .then((v) => { if (!missed) arrive(); out.set(props[i].id, remember(keys[i], v)); }, (e) => { if (!missed) arrive(); throw e; });
  });
  await allReached;
  if (waiting.length) {
    try {
      const vecs = await embed(waiting.map((w) => texts[w.i]), meta);
      waiting.forEach((w, k) => (vecs[k] ? w.resolve(compact(vecs[k])) : w.reject(new Error('missing embedding'))));
    } catch (e) { waiting.forEach((w) => w.reject(e)); }
  }
  await Promise.all(lookups);
  return out;
}

/* ───────────────────────── live listings ───────────────────────── */

async function upsert(listingId: string, model: string, hash: string, vector: number[]) {
  await q(`INSERT INTO listing_embeddings (listing_id, model, text_hash, embedding, updated_at) VALUES ($1, $2, $3, $4::real[], now())
           ON CONFLICT (listing_id) DO UPDATE SET model = EXCLUDED.model, text_hash = EXCLUDED.text_hash, embedding = EXCLUDED.embedding, updated_at = now()`,
  [listingId, model, hash, compact(vector)]);
}

/** Stored vectors for live listings (by ref); any that are missing are embedded now (bounded by the caller). */
async function liveVectors(props: Property[], meta: Meta): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!props.length) return out;
  const model = await modelFor('embedding');
  const rows = await q<{ id: string; ref: string; model: string | null; embedding: number[] | null }>(
    `SELECT l.id, l.ref, e.model, e.embedding FROM listings l LEFT JOIN listing_embeddings e ON e.listing_id = l.id
      WHERE l.ref = ANY($1) AND l.status IN ('live', 'under_offer')`, [props.map((p) => p.id)]);
  const missing: { id: string; p: Property; text: string }[] = [];
  for (const r of rows) {
    const p = props.find((x) => x.id === r.ref)!;
    if (r.embedding?.length && r.model === model) out.set(r.ref, r.embedding.map(Number));
    else missing.push({ id: r.id, p, text: propertyText(p) });
  }
  if (missing.length) {
    const vecs = await embed(missing.map((m) => m.text), meta);
    await Promise.all(missing.map(async (m, i) => {
      if (!vecs[i]) return;
      out.set(m.p.id, compact(vecs[i]));
      await upsert(m.id, model, textHash(m.text), vecs[i]).catch(() => {});
    }));
  }
  return out;
}

/** Vectors for any mix of live and demo listings, keyed by property id. */
export async function vectorsFor(props: Property[], meta: Meta): Promise<Map<string, number[]>> {
  const live = props.filter((p) => isLiveRef(p.id));
  const demo = props.filter((p) => !isLiveRef(p.id));
  const [a, b] = await Promise.all([liveVectors(live, meta), demoVectors(demo, meta)]);
  return new Map([...a, ...b]);
}

/** Vector for a search phrase (cached per normalised text). */
export async function queryVector(text: string, meta: Meta): Promise<number[]> {
  const model = await modelFor('embedding');
  const norm = normaliseQuery(text);
  const key = `search.qvec:v1:${model}:${textHash(norm)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const v = await cached(key, QUERY_TTL, async () => compact((await embed([norm], meta))[0] ?? []));
  if (!v.length) throw new Error('empty query embedding');
  return remember(key, v);
}

/* ───────────────────────── the job ───────────────────────── */

/** Embeds up to EMBED_BATCH live listings, skipping those whose text (and model) hasn't changed. */
export async function embedListings(listingIds: string[], meta: Meta) {
  const ids = [...new Set(listingIds)].slice(0, EMBED_BATCH);
  if (!ids.length) return { embedded: 0, skipped: 0 };
  const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE l.id = ANY($1) AND l.status IN ('live', 'under_offer')`, [ids]);
  if (!rows.length) return { embedded: 0, skipped: 0 };
  const model = await modelFor('embedding');
  const have = new Map((await q<{ listing_id: string; model: string; text_hash: string }>(
    'SELECT listing_id, model, text_hash FROM listing_embeddings WHERE listing_id = ANY($1)', [rows.map((r) => r.id)])).map((r) => [r.listing_id, r]));
  const todo = rows.map((r) => { const text = propertyText(rowToProperty(r)); return { id: r.id, text, hash: textHash(text) }; })
    .filter((t) => { const h = have.get(t.id); return !h || h.text_hash !== t.hash || h.model !== model; });
  if (todo.length) {
    const vecs = await embed(todo.map((t) => t.text), meta);
    await Promise.all(todo.map((t, i) => (vecs[i] ? upsert(t.id, model, t.hash, vecs[i]) : null)));
  }
  return { embedded: todo.length, skipped: rows.length - todo.length };
}
