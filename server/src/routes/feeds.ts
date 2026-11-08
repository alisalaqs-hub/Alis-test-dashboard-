/**
 * Agent feeds: agencies push their stock (BLM v3, the format UK CRMs already export to portals)
 * with a per-agency API key. Each upload is the agency's full stock: new refs are added,
 * changed ones updated, and refs missing from the file are withdrawn.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBLM } from '../../../src/engine/listings';
import { listingRef, newToken, sha256 } from '../auth/crypto';
import { one, q, tx } from '../db';
import { audit, forbidden, HttpError, notFound, parse, requireUser } from '../services/http';
import { limit } from '../services/ratelimit';
import { emit } from '../ai/hooks';

async function orgRole(req: FastifyRequest, orgId: string) {
  const u = requireUser(req);
  const m = await one<{ role: string }>('SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2', [orgId, u.id]);
  if (u.role === 'admin') return 'admin';
  if (!m) throw notFound('That organisation');
  if (!['owner', 'admin'].includes(m.role)) throw forbidden();
  return m.role;
}

/** Bulk postcode lookup (postcodes.io, up to 100 per call); misses fall back to approximate centres. */
async function bulkGeocode(postcodes: string[]) {
  const out = new Map<string, { lat: number; lng: number; district: string }>();
  for (let i = 0; i < postcodes.length; i += 100) {
    try {
      const r = await fetch('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcodes: postcodes.slice(i, i + 100) }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { result: { query: string; result: { latitude: number; longitude: number; outcode: string } | null }[] };
      for (const x of j.result ?? []) if (x.result) out.set(x.query, { lat: x.result.latitude, lng: x.result.longitude, district: x.result.outcode });
    } catch { /* offline: approximate locations are used */ }
  }
  return out;
}

export async function feedRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:id/feed-keys', async (req) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    return { items: await q(`SELECT id, label, prefix, last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt" FROM feed_keys WHERE organisation_id = $1 ORDER BY created_at DESC`, [id]) };
  });

  app.post('/api/orgs/:id/feed-keys', async (req, reply) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    const { label } = parse(z.object({ label: z.string().trim().min(1).max(60).default('CRM feed') }), req.body ?? {});
    const { token } = newToken(32);
    const key = `skf_${token}`;
    await q('INSERT INTO feed_keys (organisation_id, label, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5)', [id, label, key.slice(0, 10), sha256(key), req.user!.id]);
    await audit(req, 'feed.key_created', `org:${id}`, { label });
    return reply.code(201).send({ key, note: 'Copy this key now — it is shown only once. Send it as “Authorization: Bearer <key>” with each feed upload.' });
  });

  app.delete('/api/orgs/:id/feed-keys/:keyId', async (req) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    await orgRole(req, id);
    await q('UPDATE feed_keys SET revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL', [keyId, id]);
    await audit(req, 'feed.key_revoked', `org:${id}`);
    return { ok: true };
  });

  app.get('/api/orgs/:id/feed-runs', async (req) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    return { items: await q(`SELECT id, format, accepted, withdrawn, rejected, created_at AS "createdAt" FROM feed_runs WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]) };
  });

  app.post('/api/feeds/blm', { bodyLimit: 25 * 1024 * 1024, preHandler: limit('feeds.blm', 12, 60) }, async (req) => {
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!key.startsWith('skf_')) throw new HttpError(401, 'Send your feed key as “Authorization: Bearer skf_…”.', 'feed_auth');
    const fk = await one<{ id: string; organisation_id: string; name: string; verified: boolean }>(
      `SELECT k.id, k.organisation_id, o.name, o.verified FROM feed_keys k JOIN organisations o ON o.id = k.organisation_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [sha256(key)]);
    if (!fk) throw new HttpError(401, 'That feed key isn’t valid or has been revoked.', 'feed_auth');

    const body = req.body;
    const raw = typeof body === 'string' ? body : Buffer.isBuffer(body) ? decode(body) : '';
    if (!/#HEADER#/i.test(raw) || !/#DATA#/i.test(raw)) throw new HttpError(400, 'That doesn’t look like a BLM file (missing #HEADER# / #DATA#).', 'bad_feed');
    const report = parseBLM(raw, fk.name);
    const geo = await bulkGeocode(report.inputs.map((i) => i.postcode));

    const touched: string[] = [];
    const result = await tx(async (c) => {
      let accepted = 0;
      for (const i of report.inputs) {
        const g = geo.get(i.postcode);
        const status = !fk.verified ? 'pending' : i.status === 'under offer' ? 'under_offer' : 'live';
        const row = await one<{ id: string }>(
          `INSERT INTO listings (ref, organisation_id, source_kind, source_ref, channel, status, title, address_line, town, postcode, district, lat, lng,
             property_type, tenure, lease_years, beds, baths, floor_area, condition, price, epc, council_tax, service_charge_annual, features, description, ownership_declared, published_at)
           VALUES ($1, $2, 'agent-feed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, true, CASE WHEN $5 = 'pending' THEN NULL ELSE now() END)
           ON CONFLICT (organisation_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
             channel = EXCLUDED.channel, status = CASE WHEN listings.status IN ('sold', 'let') THEN listings.status ELSE EXCLUDED.status END,
             title = EXCLUDED.title, address_line = EXCLUDED.address_line, town = EXCLUDED.town, postcode = EXCLUDED.postcode, district = EXCLUDED.district,
             lat = EXCLUDED.lat, lng = EXCLUDED.lng, property_type = EXCLUDED.property_type, tenure = EXCLUDED.tenure, lease_years = EXCLUDED.lease_years,
             beds = EXCLUDED.beds, baths = EXCLUDED.baths, floor_area = EXCLUDED.floor_area, condition = EXCLUDED.condition, price = EXCLUDED.price,
             epc = EXCLUDED.epc, council_tax = EXCLUDED.council_tax, service_charge_annual = EXCLUDED.service_charge_annual, features = EXCLUDED.features,
             description = EXCLUDED.description, published_at = coalesce(listings.published_at, EXCLUDED.published_at), updated_at = now()
           RETURNING id`,
          [listingRef(), fk.organisation_id, i.ref, i.listing, status, i.title ?? null, i.addressLine, i.town, i.postcode, g?.district ?? i.postcode.split(' ')[0],
            g?.lat ?? null, g?.lng ?? null, i.type, i.tenure, i.leaseYears ?? null, i.beds, Math.max(0, i.baths), i.floorArea || Math.round(25 + i.beds * 22),
            i.condition ?? null, i.price, i.epc ?? null, i.councilTax ?? null, i.serviceChargeAnnual ?? null, i.features, i.description ?? null], c);
        // Feed photos are the agent's own hosted images (https links); replace them on every upload.
        await q(`DELETE FROM listing_photos WHERE listing_id = $1 AND storage_key LIKE 'ext:%'`, [row!.id], c);
        for (const [n, url] of (i.photos ?? []).slice(0, 40).entries()) {
          await q(`INSERT INTO listing_photos (listing_id, storage_key, url, content_type, bytes, position) VALUES ($1, $2, $3, 'image/*', 0, $4)`, [row!.id, `ext:${url}`, url, n], c);
        }
        accepted++; touched.push(row!.id);
      }
      const withdrawn = await q(`UPDATE listings SET status = 'withdrawn', updated_at = now() WHERE organisation_id = $1 AND source_kind = 'agent-feed'
        AND status IN ('live', 'under_offer', 'pending') AND NOT (source_ref = ANY($2)) RETURNING id`, [fk.organisation_id, report.inputs.map((i) => i.ref)], c);
      await q('INSERT INTO feed_runs (organisation_id, feed_key_id, format, accepted, withdrawn, rejected) VALUES ($1, $2, $3, $4, $5, $6)',
        [fk.organisation_id, fk.id, `BLM ${report.version}`, accepted, withdrawn.length, JSON.stringify(report.rejected)], c);
      await q('UPDATE feed_keys SET last_used_at = now() WHERE id = $1', [fk.id], c);
      return { accepted, withdrawn: withdrawn.length };
    });
    await audit(req, 'feed.ingested', `org:${fk.organisation_id}`, { ...result, rejected: report.rejected.length });
    if (fk.verified && touched.length) await emit('listingsPublished', { listingIds: touched });
    return {
      ...result, rejected: report.rejected, format: `BLM ${report.version}`,
      note: fk.verified ? 'Listings are live.' : 'Your agency is awaiting verification, so these listings are pending until an admin approves the agency.',
    };
  });
}

/** BLM files are often Windows-1252; use UTF-8 when the bytes are valid UTF-8. */
function decode(b: Buffer) {
  const s = b.toString('utf8');
  return s.includes('�') ? b.toString('latin1') : s;
}
