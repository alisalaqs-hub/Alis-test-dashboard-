/**
 * AI search:
 *   POST /api/ai/search/intent        natural language → the engine's SearchQuery (+ chips, follow-up question)
 *   GET  /api/ai/search/similar/:id   up to 6 similar homes (live or demo) with code-written reasons
 *   POST /api/ai/search/rank          semantic re-ranking of candidate ids for a query
 * plus the 'search.embed' job that keeps live listings' embeddings current.
 * All three are anonymous-friendly and rate limited by aiGuard; the website falls back to its
 * built-in rules whenever these are unavailable.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEARCH_MODES, MAX_QUERY_CHARS } from '../../../src/lib/ai/search';
import { aiAvailable } from '../ai/core';
import { aiGuard } from '../ai/guard';
import { on } from '../ai/hooks';
import { enqueue, registerJob } from '../ai/jobs';
import { invalidateLiveRegistry } from '../ai/registry';
import { searchIntent } from '../ai/search/intent';
import { rankByQuery, similarHomes } from '../ai/search/similar';
import { EMBED_BATCH, embedListings, TEXT_COLUMNS } from '../ai/search/vectors';
import { notFound, parse } from '../services/http';

const IntentBody = z.object({
  q: z.string().trim().min(1, 'Type what you’re looking for.').max(MAX_QUERY_CHARS, `Keep it under ${MAX_QUERY_CHARS} characters.`),
  mode: z.enum(SEARCH_MODES).nullish(),
});
const RankBody = z.object({
  q: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  ids: z.array(z.string().trim().regex(/^[a-z0-9-]{2,40}$/i, 'Not a listing id.')).min(1).max(60),
});
const PROPERTY_ID = /^[a-z0-9-]{2,40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EmbedInput = z.object({ listingIds: z.array(z.string().regex(UUID)).max(EMBED_BATCH), queue: z.array(z.string().regex(UUID)).max(5000).default([]) });

/** Queue embedding work: one job per batch of 50, each job hands the remainder to the next. */
async function queueEmbedding(listingIds: string[]) {
  const ids = [...new Set(listingIds)].filter((id) => UUID.test(id)).slice(0, 5000);
  if (!ids.length || !aiAvailable()) return;
  // Cheap to repeat: the job skips listings whose text hasn't changed.
  await enqueue('search.embed', { listingIds: ids.slice(0, EMBED_BATCH), queue: ids.slice(EMBED_BATCH) }, { subject: ids.length === 1 ? `search.embed:${ids[0]}` : null });
}

export async function aiSearchRoutes(app: FastifyInstance) {
  registerJob('search.embed', async (job, ctx) => {
    const input = EmbedInput.parse(job.input);
    const r = await embedListings(input.listingIds, { purpose: 'search.embed', userId: null });
    if (input.queue.length) {
      await ctx.progress(`${input.queue.length} more listing${input.queue.length === 1 ? '' : 's'} queued`);
      await queueEmbedding(input.queue);
    }
    return r;
  }, { maxAttempts: 3, leaseSec: 300, inlineSafe: true });

  on('listingsPublished', async ({ listingIds }) => {
    invalidateLiveRegistry();
    await queueEmbedding(listingIds);
  });
  on('listingUpdated', async ({ listingId, fields }) => {
    invalidateLiveRegistry();
    if (fields.some((f) => TEXT_COLUMNS.has(f))) await queueEmbedding([listingId]);
  });

  app.post('/api/ai/search/intent', async (req) => {
    const g = await aiGuard(req, 'search.intent', { perMinute: 20 });
    const b = parse(IntentBody, req.body);
    return searchIntent(b.q, b.mode ?? null, { userId: g.userId });
  });

  app.get('/api/ai/search/similar/:id', async (req) => {
    const g = await aiGuard(req, 'search.similar', { perMinute: 30 });
    const { id } = req.params as { id: string };
    if (!PROPERTY_ID.test(id)) throw notFound('That listing');
    return similarHomes(id, { userId: g.userId });
  });

  app.post('/api/ai/search/rank', async (req) => {
    const g = await aiGuard(req, 'search.rank', { perMinute: 20 });
    const b = parse(RankBody, req.body);
    return rankByQuery(b.q, b.ids, { userId: g.userId });
  });
}
