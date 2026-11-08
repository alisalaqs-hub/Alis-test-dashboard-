/**
 * AI feature routes: import ("Check any listing").
 *
 *   POST /api/ai/import/extract  {text, url?}  anyone (rate limited)
 *
 * Reads listing text a person pasted from another website. The link is only used to name the
 * site we link back to: Streetkey never visits or copies other websites.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiGuard } from '../ai/guard';
import { extractImport, MAX_TEXT } from '../ai/importer/extract';
import { parse } from '../services/http';

const Body = z.object({
  text: z.string({ error: 'Paste the listing details.' }).trim()
    .min(20, 'Paste a little more of the listing: at least the price, address and a few details.')
    .max(MAX_TEXT, `That’s too long. Paste up to ${MAX_TEXT.toLocaleString('en-GB')} characters (the main details are enough).`),
  url: z.string().trim().max(500, 'That link is too long.').optional().nullable(),
});

export async function aiImportRoutes(app: FastifyInstance) {
  app.post('/api/ai/import/extract', async (req) => {
    const g = await aiGuard(req, 'import.extract', { perMinute: 6, perHour: 30 });
    const b = parse(Body, req.body ?? {});
    return extractImport(b.text, b.url ?? '', { userId: g.userId });
  });
}
