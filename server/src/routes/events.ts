/**
 * Listing engagement, only from visitors who accepted analytics. Stores the listing,
 * the event name and a random per-session id: no IP address, no account, no free text.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db';
import { limit } from '../services/ratelimit';

const Event = z.object({
  listing: z.string().regex(/^sk-[a-z0-9]{7}$/),
  name: z.enum(['listing_view', 'photo_open', 'floorplan_open', 'save', 'share', 'viewing_request', 'enquiry', 'ai_question', 'refurb_sim', 'design_style']),
  session: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  consent: z.literal(true),
});

export async function eventRoutes(app: FastifyInstance) {
  app.post('/api/events', { preHandler: limit('events', 120, 60) }, async (req, reply) => {
    const r = Event.safeParse(req.body);
    if (!r.success) return reply.code(202).send({ ok: false }); // never break the page over analytics
    const l = await one<{ id: string }>(`SELECT id FROM listings WHERE ref = $1 AND status IN ('live', 'under_offer')`, [r.data.listing]);
    if (!l) return reply.code(202).send({ ok: false });
    // One view per session per listing per hour is enough.
    if (r.data.name === 'listing_view') {
      const dup = await one(`SELECT 1 FROM engagement_events WHERE listing_id = $1 AND session_id = $2 AND name = 'listing_view' AND occurred_at > now() - interval '1 hour'`, [l.id, r.data.session]);
      if (dup) return reply.code(202).send({ ok: true });
    }
    await q('INSERT INTO engagement_events (listing_id, session_id, name) VALUES ($1, $2, $3)', [l.id, r.data.session, r.data.name]);
    return reply.code(202).send({ ok: true });
  });
}
