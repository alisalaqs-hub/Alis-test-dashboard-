import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SavedSearchDTO } from '../../../src/lib/apiTypes';
import { newToken, verifyPassword } from '../auth/crypto';
import { getUser, publicUser } from '../auth/session';
import { config } from '../config';
import { one, q, tx } from '../db';
import { audit, HttpError, notFound, parse, requireUser } from '../services/http';
import { deleteFile } from '../services/storage';

const KEY = z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/i);
const toSearch = (r: { id: string; query: string; mode: string; alert_frequency: SavedSearchDTO['alertFrequency']; created_at: Date }): SavedSearchDTO =>
  ({ id: r.id, query: r.query, mode: r.mode, alertFrequency: r.alert_frequency, createdAt: r.created_at.toISOString() });

export async function meRoutes(app: FastifyInstance) {
  /* ---------- profile ---------- */
  app.patch('/api/me', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      phone: z.string().trim().max(30).regex(/^[+\d\s()-]*$/, 'Use digits, spaces and + only.').optional().nullable(),
      marketingOptIn: z.boolean().optional(),
      accountType: z.enum(['buyer', 'owner', 'landlord', 'agent', 'developer', 'investor']).optional(),
    }), req.body);
    await q(`UPDATE users SET display_name = coalesce($2, display_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
              marketing_opt_in = coalesce($5, marketing_opt_in), account_type = coalesce($6, account_type), updated_at = now() WHERE id = $1`,
    [u.id, b.name ?? null, b.phone !== undefined, b.phone || null, b.marketingOptIn ?? null, b.accountType ?? null]);
    if (b.marketingOptIn !== undefined && b.marketingOptIn !== u.marketing_opt_in) {
      if (b.marketingOptIn) await q(`INSERT INTO consents (user_id, purpose) VALUES ($1, 'marketing')`, [u.id]);
      else await q(`UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND purpose = 'marketing' AND withdrawn_at IS NULL`, [u.id]);
    }
    return { user: publicUser((await getUser(u.id))!) };
  });

  /** UK GDPR right of access: everything we hold about you, as JSON. */
  app.get('/api/me/export', async (req, reply) => {
    const u = requireUser(req);
    const [listings, saved, searches, sent, consents, images, sessions] = await Promise.all([
      q('SELECT ref, status, channel, title, address_line, town, postcode, price, created_at FROM listings WHERE owner_user_id = $1', [u.id]),
      q('SELECT listing_key, created_at FROM saved_listings WHERE user_id = $1', [u.id]),
      q('SELECT query, mode, alert_frequency, created_at FROM saved_searches WHERE user_id = $1', [u.id]),
      q(`SELECT e.kind, e.name, e.email, e.phone, e.preferred_slot, e.created_at, l.ref AS listing FROM enquiries e JOIN listings l ON l.id = e.listing_id WHERE e.from_user_id = $1`, [u.id]),
      q('SELECT purpose, version, granted_at, withdrawn_at FROM consents WHERE user_id = $1', [u.id]),
      q('SELECT room, style, brief, status, result_url, created_at FROM ai_images WHERE user_id = $1', [u.id]),
      q('SELECT created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE user_id = $1', [u.id]),
    ]);
    // Automated assessments about you or your listings (UK GDPR Articles 15 and 22).
    const aiAboutMe = {
      listingReviews: await q(`SELECT l.ref, r.risk, r.score, r.summary, r.flags, r.auto_approved, r.created_at FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id WHERE l.owner_user_id = $1 ORDER BY r.created_at`, [u.id]).catch(() => []),
      enquiryTriage: await q(`SELECT l.ref AS listing, a.intent, a.buyer_position, a.questions, a.urgency, a.summary, a.created_at FROM enquiry_ai a JOIN enquiries e ON e.id = a.enquiry_id JOIN listings l ON l.id = e.listing_id WHERE e.from_user_id = $1`, [u.id]).catch(() => []),
      usage: await q(`SELECT purpose, count(*)::int AS requests, min(at) AS first, max(at) AS last FROM ai_usage WHERE user_id = $1 GROUP BY purpose`, [u.id]).catch(() => []),
    };
    await audit(req, 'user.exported', `user:${u.id}`);
    reply.header('Content-Disposition', 'attachment; filename="streetkey-my-data.json"');
    return { exportedAt: new Date().toISOString(), account: publicUser(u), listings, savedHomes: saved, savedSearches: searches, enquiriesSent: sent, consents, aiImages: images, aiAssessments: aiAboutMe, sessions };
  });

  /**
   * UK GDPR right to erasure: removes the account and personal details, design-studio photos and AI results,
   * AI jobs, draft listings and their photos. Published listings are withdrawn (kept, without the owner's details,
   * for the audit trail).
   */
  app.delete('/api/me', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(z.object({ password: z.string().max(200) }), req.body);
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!row || !(await verifyPassword(b.password, row.password_hash))) throw new HttpError(400, 'Your password isn’t right.', 'bad_credentials', { password: 'Incorrect password.' });
    // Files to remove once the database changes are committed: room photos and AI designs, and draft listings' photos.
    const files = [
      ...(await q<{ k: string | null }>(`SELECT unnest(ARRAY[source_key, result_key]) AS k FROM ai_images WHERE user_id = $1`, [u.id])),
      ...(await q<{ k: string }>(`SELECT p.storage_key AS k FROM listing_photos p JOIN listings l ON l.id = p.listing_id WHERE l.owner_user_id = $1 AND l.status = 'draft'`, [u.id])),
    ].map((r) => r.k).filter((k): k is string => !!k && !k.startsWith('ext:'));
    await tx(async (c) => {
      await q(`UPDATE listings SET status = 'withdrawn', updated_at = now() WHERE owner_user_id = $1 AND status NOT IN ('draft', 'withdrawn')`, [u.id], c);
      await q('DELETE FROM ai_images WHERE user_id = $1', [u.id], c);
      await q('DELETE FROM ai_jobs WHERE user_id = $1', [u.id], c);
      await q(`DELETE FROM listings WHERE owner_user_id = $1 AND status = 'draft'`, [u.id], c);
      await q(`DELETE FROM enquiry_ai WHERE enquiry_id IN (SELECT id FROM enquiries WHERE from_user_id = $1)`, [u.id], c);
      await q(`UPDATE enquiries SET name = 'Deleted user', email = 'deleted@invalid', phone = NULL WHERE from_user_id = $1`, [u.id], c);
      await q(`UPDATE ai_usage SET user_id = NULL WHERE user_id = $1`, [u.id], c);
      await q('DELETE FROM saved_listings WHERE user_id = $1', [u.id], c);
      await q('DELETE FROM saved_searches WHERE user_id = $1', [u.id], c);
      await q('DELETE FROM sessions WHERE user_id = $1', [u.id], c);
      await q('DELETE FROM email_tokens WHERE user_id = $1', [u.id], c);
      await q(`UPDATE users SET email = $2, display_name = 'Deleted user', phone = NULL, password_hash = $3, marketing_opt_in = false, deleted_at = now() WHERE id = $1`,
        [u.id, `deleted+${u.id}@invalid`, `deleted$${newToken().token}`], c);
    });
    await Promise.allSettled(files.map((k) => deleteFile(k)));
    await audit(req, 'user.deleted', `user:${u.id}`, { filesRemoved: files.length });
    reply.clearCookie(config.session.cookie, { path: '/' });
    return { ok: true };
  });

  /* ---------- saved homes ---------- */
  app.get('/api/me/saved', async (req) => {
    const u = requireUser(req);
    return { keys: (await q<{ listing_key: string }>('SELECT listing_key FROM saved_listings WHERE user_id = $1 ORDER BY created_at', [u.id])).map((r) => r.listing_key) };
  });
  app.put('/api/me/saved/:key', async (req) => {
    const u = requireUser(req);
    const key = parse(KEY, (req.params as { key: string }).key);
    await q('INSERT INTO saved_listings (user_id, listing_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, key]);
    return { ok: true };
  });
  app.delete('/api/me/saved/:key', async (req) => {
    const u = requireUser(req);
    await q('DELETE FROM saved_listings WHERE user_id = $1 AND listing_key = $2', [u.id, (req.params as { key: string }).key]);
    return { ok: true };
  });
  /** Merge homes saved on this device before signing in. */
  app.post('/api/me/saved/merge', async (req) => {
    const u = requireUser(req);
    const { keys } = parse(z.object({ keys: z.array(KEY).max(500) }), req.body);
    if (keys.length) await q('INSERT INTO saved_listings (user_id, listing_key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [u.id, keys]);
    return { keys: (await q<{ listing_key: string }>('SELECT listing_key FROM saved_listings WHERE user_id = $1 ORDER BY created_at', [u.id])).map((r) => r.listing_key) };
  });

  /* ---------- saved searches & alerts ---------- */
  const SearchBody = z.object({ query: z.string().trim().min(2).max(200), mode: z.string().max(20).default('buy'), alertFrequency: z.enum(['instant', 'daily', 'weekly', 'off']).default('daily') });
  app.get('/api/me/searches', async (req) => {
    const u = requireUser(req);
    return { items: (await q<Parameters<typeof toSearch>[0]>('SELECT * FROM saved_searches WHERE user_id = $1 ORDER BY created_at DESC', [u.id])).map(toSearch) };
  });
  app.post('/api/me/searches', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(SearchBody, req.body);
    const count = (await one<{ n: number }>('SELECT count(*)::int n FROM saved_searches WHERE user_id = $1', [u.id]))!.n;
    if (count >= 50) throw new HttpError(409, 'You can save up to 50 searches.', 'limit');
    const r = await one<Parameters<typeof toSearch>[0]>(
      `INSERT INTO saved_searches (user_id, query, mode, alert_frequency, last_alerted_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, query, mode) DO UPDATE SET alert_frequency = EXCLUDED.alert_frequency RETURNING *`, [u.id, b.query, b.mode, b.alertFrequency]);
    return reply.code(201).send({ search: toSearch(r!) });
  });
  app.patch('/api/me/searches/:id', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ alertFrequency: z.enum(['instant', 'daily', 'weekly', 'off']) }), req.body);
    const r = await one<Parameters<typeof toSearch>[0]>('UPDATE saved_searches SET alert_frequency = $3 WHERE id = $1 AND user_id = $2 RETURNING *', [(req.params as { id: string }).id, u.id, b.alertFrequency]);
    if (!r) throw notFound('That saved search');
    return { search: toSearch(r) };
  });
  app.delete('/api/me/searches/:id', async (req) => {
    const u = requireUser(req);
    await q('DELETE FROM saved_searches WHERE id = $1 AND user_id = $2', [(req.params as { id: string }).id, u.id]);
    return { ok: true };
  });

  /* ---------- organisations (agencies, landlord companies) ---------- */
  app.get('/api/me/orgs', async (req) => {
    const u = requireUser(req);
    return { items: await q(`SELECT o.id, o.name, o.kind, o.verified, o.redress_scheme AS "redressScheme", m.role FROM memberships m JOIN organisations o ON o.id = m.organisation_id WHERE m.user_id = $1`, [u.id]) };
  });
  app.post('/api/orgs', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(['agency', 'landlord', 'developer', 'contractor']), redressScheme: z.string().trim().max(120).optional() }), req.body);
    const org = await tx(async (c) => {
      const o = await one<{ id: string }>('INSERT INTO organisations (name, kind, redress_scheme) VALUES ($1, $2, $3) RETURNING id', [b.name, b.kind, b.redressScheme ?? null], c);
      await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'owner')`, [o!.id, u.id], c);
      if (b.kind === 'agency') await q(`UPDATE users SET account_type = 'agent' WHERE id = $1`, [u.id], c);
      return o!;
    });
    await audit(req, 'org.created', `org:${org.id}`, { name: b.name, kind: b.kind });
    return reply.code(201).send({ id: org.id, verified: false, note: 'An admin will verify your organisation (e.g. redress scheme membership) before feed listings go live.' });
  });
}
