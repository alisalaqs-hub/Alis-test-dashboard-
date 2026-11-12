/** Admin: review listings, verify agencies and ownership, manage roles, read the audit trail. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { historyFor, recordHistory } from '../services/history';
import { audit, HttpError, notFound, parse, requireAdmin } from '../services/http';
import { checksFor, LISTING_SELECT, photosFor, toDTO, type ListingRow } from '../services/listings';
import { emit } from '../ai/hooks';
import { latestReview } from '../ai/trust/store';

/** What the automatic check said when an admin decided (kept in the audit trail, so overrides can be reviewed later). */
async function reviewContext(listingId: string) {
  const r = await latestReview(listingId).catch(() => null);
  return r ? { reviewId: r.id, risk: r.risk, score: r.score, rulesOnly: r.rulesOnly, stale: r.stale, ruleConcerns: r.ruleConcerns } : { reviewId: null };
}

const RefParams = z.object({ ref: z.string().trim().min(3).max(40).regex(/^[a-z0-9-]+$/i, 'That isn’t a listing reference.') });
const IdParams = z.object({ id: z.uuid('That isn’t a valid id.') });

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/summary', async (req) => {
    requireAdmin(req);
    const [users, listings, enquiries, ai, emails, orgs] = await Promise.all([
      one<{ total: number; d7: number }>(`SELECT count(*)::int total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int d7 FROM users WHERE deleted_at IS NULL`),
      q<{ status: string; n: number }>('SELECT status, count(*)::int n FROM listings GROUP BY status'),
      one<{ d7: number }>(`SELECT count(*)::int d7 FROM enquiries WHERE created_at > now() - interval '7 days'`),
      one<{ d7: number; failed: number }>(`SELECT count(*)::int d7, count(*) FILTER (WHERE status = 'failed')::int failed FROM ai_images WHERE created_at > now() - interval '7 days'`),
      one<{ failed: number }>(`SELECT count(*)::int failed FROM emails WHERE status = 'failed' AND created_at > now() - interval '7 days'`),
      one<{ unverified: number }>(`SELECT count(*)::int unverified FROM organisations WHERE NOT verified`),
    ]);
    return { users, listings: Object.fromEntries(listings.map((l) => [l.status, l.n])), enquiries7d: enquiries!.d7, aiImages7d: ai!.d7, aiFailed7d: ai!.failed, emailsFailed7d: emails!.failed, orgsAwaitingVerification: orgs!.unverified };
  });

  app.get('/api/admin/listings', async (req) => {
    const admin = requireAdmin(req);
    const { status } = parse(z.object({ status: z.enum(['draft', 'pending', 'live', 'under_offer', 'sold', 'let', 'withdrawn', 'rejected']).default('pending') }), req.query);
    const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE l.status = $1 ORDER BY l.updated_at ASC LIMIT 200`, [status]);
    const [photos, history] = await Promise.all([photosFor(rows.map((r) => r.id)), historyFor(rows.map((r) => r.id))]);
    // Agency feed photos are hosted on the agency's own website: the admin page asks before loading them (it would share the admin's IP address).
    const external = new Set((await q<{ id: string }>(`SELECT id FROM listing_photos WHERE listing_id = ANY($1) AND storage_key LIKE 'ext:%'`, [rows.map((r) => r.id)])).map((p) => p.id));
    return {
      items: rows.map((r) => ({
        ...toDTO(r, (photos.get(r.id) ?? []).map((p) => (external.has(p.id) ? { ...p, external: true } : p)), { userId: admin.id, admin: true }, history.get(r.id)),
        lister: r.organisation_name ?? r.owner_name ?? null, ownershipDeclared: r.ownership_declared,
        checks: checksFor(r, (photos.get(r.id) ?? []).length),
      })),
    };
  });

  app.post('/api/admin/listings/:ref/approve', async (req) => {
    requireAdmin(req);
    const { ref } = parse(RefParams, req.params);
    const r = await tx(async (c) => {
      const up = await one<{ id: string; title: string | null; address_line: string; email: string | null }>(
        `WITH up AS (UPDATE listings SET status = 'live', rejection_reason = NULL, published_at = coalesce(published_at, now()), updated_at = now()
                     WHERE ref = $1 AND status = 'pending' RETURNING id, title, address_line, owner_user_id)
         SELECT up.id, up.title, up.address_line, u.email FROM up LEFT JOIN users u ON u.id = up.owner_user_id`, [ref], c);
      if (up) await recordHistory([up.id], c); // first listed (or back on the market after changes)
      return up;
    });
    if (!r) throw new HttpError(409, 'Only pending listings can be approved. Someone may have dealt with it already.', 'bad_status');
    if (r.email) await mails.listingLive(r.email, r.title ?? r.address_line, ref);
    await audit(req, 'admin.listing_approved', `listing:${ref}`, await reviewContext(r.id));
    await emit('listingsPublished', { listingIds: [r.id] });
    return { status: 'live' };
  });

  app.post('/api/admin/listings/:ref/reject', async (req) => {
    requireAdmin(req);
    const { ref } = parse(RefParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Give the lister a reason they can act on.').max(1000) }), req.body);
    const r = await tx(async (c) => {
      const up = await one<{ id: string; title: string | null; address_line: string; email: string | null }>(
        `WITH up AS (UPDATE listings SET status = 'rejected', rejection_reason = $2, updated_at = now()
                     WHERE ref = $1 AND status IN ('pending', 'live', 'under_offer') RETURNING id, title, address_line, owner_user_id)
         SELECT up.id, up.title, up.address_line, u.email FROM up LEFT JOIN users u ON u.id = up.owner_user_id`, [ref, reason], c);
      if (up) await recordHistory([up.id], c); // a listing that had been on the market is now off it
      return up;
    });
    if (!r) throw new HttpError(409, 'That listing can’t be rejected in its current state. Someone may have dealt with it already.', 'bad_status');
    if (r.email) await mails.listingRejected(r.email, r.title ?? r.address_line, reason);
    await audit(req, 'admin.listing_rejected', `listing:${ref}`, { reason, ...(await reviewContext(r.id)) });
    return { status: 'rejected' };
  });

  app.post('/api/admin/listings/:ref/verify-ownership', async (req) => {
    requireAdmin(req);
    const { ref } = parse(RefParams, req.params);
    const { verified, note } = parse(z.object({ verified: z.boolean().default(true), note: z.string().max(500).optional() }), req.body ?? {});
    const r = await one(`UPDATE listings SET ownership_verified = $2, updated_at = now() WHERE ref = $1 RETURNING id`, [ref, verified]);
    if (!r) throw notFound('That listing');
    await audit(req, 'admin.ownership_verified', `listing:${ref}`, { verified, note });
    return { ok: true };
  });

  app.get('/api/admin/orgs', async (req) => {
    requireAdmin(req);
    return { items: await q(`SELECT o.id, o.name, o.kind, o.verified, o.redress_scheme AS "redressScheme", o.created_at AS "createdAt",
      (SELECT count(*)::int FROM listings l WHERE l.organisation_id = o.id) AS listings,
      (SELECT string_agg(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organisation_id = o.id AND m.role = 'owner') AS owners
      FROM organisations o ORDER BY o.verified, o.created_at DESC LIMIT 200`) };
  });

  app.post('/api/admin/orgs/:id/verify', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const { verified } = parse(z.object({ verified: z.boolean().default(true) }), req.body ?? {});
    const r = await one('UPDATE organisations SET verified = $2 WHERE id = $1 RETURNING id', [id, verified]);
    if (!r) throw notFound('That organisation');
    // Verifying an agency releases its pending feed listings.
    const released = verified ? await tx(async (c) => {
      const rows = await q<{ id: string }>(`UPDATE listings SET status = 'live', published_at = coalesce(published_at, now()), updated_at = now() WHERE organisation_id = $1 AND status = 'pending' AND source_kind IN ('agent-feed', 'agent') RETURNING id`, [id], c);
      await recordHistory(rows.map((x) => x.id), c);
      return rows;
    }) : [];
    await audit(req, 'admin.org_verified', `org:${id}`, { verified, released: released.length });
    if (released.length) await emit('listingsPublished', { listingIds: released.map((x) => x.id) });
    return { ok: true, released: released.length };
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const { q: term } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    return { items: await q(`SELECT id, email, display_name AS name, role, account_type AS "accountType", email_verified_at IS NOT NULL AS "emailVerified", created_at AS "createdAt"
      FROM users WHERE deleted_at IS NULL AND ($1::text IS NULL OR email ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%') ORDER BY created_at DESC LIMIT 100`, [term || null]) };
  });

  app.post('/api/admin/users/:id/role', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const { role } = parse(z.object({ role: z.enum(['member', 'admin']) }), req.body);
    if (id === admin.id && role !== 'admin') throw new HttpError(409, 'You can’t remove your own admin role.', 'self');
    const r = await one('UPDATE users SET role = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id, role]);
    if (!r) throw notFound('That user');
    await audit(req, 'admin.role_changed', `user:${id}`, { role });
    return { ok: true };
  });

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const { subject, limit } = parse(z.object({ subject: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return { items: await q(`SELECT a.id, a.action, a.subject, a.detail, a.at, u.email AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ($1::text IS NULL OR a.subject = $1) ORDER BY a.at DESC LIMIT $2`, [subject ?? null, limit]) };
  });
}
