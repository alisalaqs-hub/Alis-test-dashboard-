/**
 * Agent feeds: agencies push their stock (BLM v3, the format UK CRMs already export to portals)
 * with an agency API key (one per branch if they like). Each upload is the full stock for that key: new refs
 * are added, changed ones updated, and refs missing from the file are withdrawn.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBLM, type FeedReport } from '../../../src/engine/listings';
import { listingRef, newToken, sha256 } from '../auth/crypto';
import { config } from '../config';
import { one, q, tx } from '../db';
import { recordHistory } from '../services/history';
import { audit, forbidden, HttpError, notFound, parse, requireUser } from '../services/http';
import { limit } from '../services/ratelimit';
import { safeExternalUrl } from '../services/storage';
import { emit } from '../ai/hooks';

/**
 * Biggest feed file per upload. Netlify Functions refuse request bodies over about 6 MB (binary bodies are
 * base64-encoded on the way in), so 4.5 MB there; larger agencies send each branch's stock with its own key.
 */
export const FEED_MAX_BYTES = config.runtime === 'netlify' ? 4.5 * 1024 * 1024 : 25 * 1024 * 1024;
/** Photos kept per feed listing. */
const FEED_MAX_PHOTOS = 40;

async function orgRole(req: FastifyRequest, orgId: string) {
  const u = requireUser(req);
  const m = await one<{ role: string }>('SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2', [orgId, u.id]);
  if (u.role === 'admin') return 'admin';
  if (!m) throw notFound('That organisation');
  if (!['owner', 'admin'].includes(m.role)) throw forbidden();
  return m.role;
}

/** Bulk postcode lookup (postcodes.io, up to 100 per call, all batches at once); misses fall back to approximate centres. */
async function bulkGeocode(postcodes: string[]) {
  const out = new Map<string, { lat: number; lng: number; district: string }>();
  const unique = [...new Set(postcodes)];
  const batches = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, i * 100 + 100));
  await Promise.all(batches.map(async (batch) => {
    try {
      const r = await fetch('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcodes: batch }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const j = (await r.json()) as { result: { query: string; result: { latitude: number; longitude: number; outcode: string } | null }[] };
      for (const x of j.result ?? []) if (x.result) out.set(x.query, { lat: x.result.latitude, lng: x.result.longitude, district: x.result.outcode });
    } catch { /* offline: approximate locations are used */ }
  }));
  return out;
}

type FeedInput = FeedReport['inputs'][number];
const hostOf = (url: string) => { try { return new URL(url).host.slice(0, 80) || 'no host'; } catch { return 'not a web address'; } };
/**
 * The listings to import: one per agent reference (a repeated reference keeps the last row, as CRMs append
 * corrections), with photo links the server may fetch only (public https hosts; see storage.safeExternalUrl).
 */
export function prepareFeed(report: FeedReport) {
  const rejected = [...report.rejected];
  const byRef = new Map<string, FeedInput>();
  for (const i of report.inputs) {
    if (byRef.has(i.ref)) rejected.push({ ref: i.ref, reason: 'Listed more than once in this file: the last one was used' });
    byRef.set(i.ref, i);
  }
  const inputs = [...byRef.values()].map((i) => {
    const photos: string[] = [];
    (i.photos ?? []).forEach((url, n) => {
      if (!safeExternalUrl(url)) rejected.push({ ref: i.ref, reason: `Photo ${n + 1} skipped (${hostOf(url)}): photos must be on a public https web address` });
      else if (photos.length < FEED_MAX_PHOTOS) photos.push(url);
    });
    return { ...i, photos };
  });
  return { inputs, rejected };
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

  /*
   * One upload is the full stock for this feed key: new references are added, changed ones updated and references
   * missing from the file are withdrawn, only among the listings this key last sent, so each branch can use its own
   * key. Set-based, so a few hundred listings take a handful of queries, well within a function's time.
   *
   * Listings with no working key: those imported before feeds remembered their key (migration 013) are given the key
   * that sent the agency's last file (until then every upload was the whole stock, so that file held them all).
   * Listings whose key was revoked belong to this key when it is the agency's only working key (the usual case: a
   * replaced key); with several keys they are left for a branch to send again, so one branch never withdraws another's.
   * So an agency splitting its stock across branch keys sends the new branches' files first, then the original key's.
   */
  app.post('/api/feeds/blm', { bodyLimit: FEED_MAX_BYTES, preHandler: limit('feeds.blm', 12, 60) }, async (req) => {
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
    const { inputs, rejected } = prepareFeed(report);
    const geo = await bulkGeocode(inputs.map((i) => i.postcode));

    const rows = inputs.map((i) => {
      const g = geo.get(i.postcode);
      return {
        ref: listingRef(), source_ref: i.ref, channel: i.listing, status: !fk.verified ? 'pending' : i.status === 'under offer' ? 'under_offer' : 'live',
        title: i.title ?? null, address_line: i.addressLine, town: i.town, postcode: i.postcode, district: g?.district ?? i.postcode.split(' ')[0],
        lat: g?.lat ?? null, lng: g?.lng ?? null, property_type: i.type, tenure: i.tenure, lease_years: i.leaseYears ?? null, beds: i.beds,
        baths: Math.max(0, i.baths), floor_area: i.floorArea || Math.round(25 + i.beds * 22), condition: i.condition ?? null, price: i.price,
        epc: i.epc ?? null, council_tax: i.councilTax ?? null, service_charge_annual: i.serviceChargeAnnual ?? null, features: i.features, description: i.description ?? null,
      };
    });
    const photos = new Map(inputs.map((i) => [i.ref, i.photos]));
    const rowByRef = new Map(rows.map((r) => [r.source_ref, r]));
    const refs = inputs.map((i) => i.ref);

    const touched: string[] = [];
    const result = await tx(async (c) => {
      await q(`UPDATE listings l SET feed_key_id = r.feed_key_id
                 FROM (SELECT feed_key_id FROM feed_runs WHERE organisation_id = $1 AND feed_key_id IS NOT NULL ORDER BY created_at DESC LIMIT 1) r
                WHERE l.organisation_id = $1 AND l.source_kind = 'agent-feed' AND l.feed_key_id IS NULL`, [fk.organisation_id], c);
      const before = await q<{ source_ref: string; ref: string; price: number }>('SELECT source_ref, ref, price FROM listings WHERE organisation_id = $1 AND source_ref = ANY($2)', [fk.organisation_id, refs], c);
      const saved = rows.length ? await q<{ id: string; source_ref: string }>(
        `INSERT INTO listings (ref, organisation_id, feed_key_id, source_kind, source_ref, channel, status, title, address_line, town, postcode, district, lat, lng,
           property_type, tenure, lease_years, beds, baths, floor_area, condition, price, epc, council_tax, service_charge_annual, features, description, ownership_declared, published_at)
         SELECT x.ref, $2, $3, 'agent-feed', x.source_ref, x.channel, x.status, x.title, x.address_line, x.town, x.postcode, x.district, x.lat, x.lng,
           x.property_type, x.tenure, x.lease_years, x.beds, x.baths, x.floor_area, x.condition, x.price, x.epc, x.council_tax, x.service_charge_annual,
           x.features, x.description, true, CASE WHEN x.status = 'pending' THEN NULL ELSE now() END
           FROM jsonb_to_recordset($1::jsonb) AS x(ref text, source_ref text, channel text, status text, title text, address_line text, town text, postcode text,
             district text, lat double precision, lng double precision, property_type text, tenure text, lease_years int, beds int, baths int, floor_area numeric,
             condition text, price numeric, epc text, council_tax text, service_charge_annual numeric, features text[], description text)
         ON CONFLICT (organisation_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
           feed_key_id = EXCLUDED.feed_key_id, channel = EXCLUDED.channel, status = CASE WHEN listings.status IN ('sold', 'let') THEN listings.status ELSE EXCLUDED.status END,
           title = EXCLUDED.title, address_line = EXCLUDED.address_line, town = EXCLUDED.town, postcode = EXCLUDED.postcode, district = EXCLUDED.district,
           lat = EXCLUDED.lat, lng = EXCLUDED.lng, property_type = EXCLUDED.property_type, tenure = EXCLUDED.tenure, lease_years = EXCLUDED.lease_years,
           beds = EXCLUDED.beds, baths = EXCLUDED.baths, floor_area = EXCLUDED.floor_area, condition = EXCLUDED.condition, price = EXCLUDED.price,
           epc = EXCLUDED.epc, council_tax = EXCLUDED.council_tax, service_charge_annual = EXCLUDED.service_charge_annual, features = EXCLUDED.features,
           description = EXCLUDED.description, published_at = coalesce(listings.published_at, EXCLUDED.published_at), updated_at = now()
         RETURNING id, source_ref`, [JSON.stringify(rows), fk.organisation_id, fk.id], c) : [];
      const idOf = new Map(saved.map((r) => [r.source_ref, r.id]));
      touched.push(...saved.map((r) => r.id));

      // Feed photos are the agent's own hosted images: replaced only where the list of links changed (unchanged
      // photos keep their stored checks).
      const current = new Map((await q<{ listing_id: string; urls: string[] }>(
        `SELECT listing_id, array_agg(url ORDER BY position, created_at) urls FROM listing_photos WHERE listing_id = ANY($1) AND storage_key LIKE 'ext:%' GROUP BY listing_id`, [touched], c))
        .map((r) => [r.listing_id, r.urls]));
      const changed = saved.filter((r) => JSON.stringify(current.get(r.id) ?? []) !== JSON.stringify(photos.get(r.source_ref) ?? []));
      if (changed.length) {
        await q(`DELETE FROM listing_photos WHERE listing_id = ANY($1) AND storage_key LIKE 'ext:%'`, [changed.map((r) => r.id)], c);
        const ids: string[] = [], urls: string[] = [], positions: number[] = [];
        for (const r of changed) (photos.get(r.source_ref) ?? []).forEach((u, n) => { ids.push(r.id); urls.push(u); positions.push(n); });
        if (ids.length) {
          await q(`INSERT INTO listing_photos (listing_id, storage_key, url, content_type, bytes, position)
                   SELECT l, 'ext:' || u, u, 'image/*', 0, p FROM unnest($1::uuid[], $2::text[], $3::int[]) AS t(l, u, p)`, [ids, urls, positions], c);
        }
      }

      // Price changes, for the audit trail (one insert for the whole file). The public history is written below.
      const moves = before.flatMap((b) => { const r = rowByRef.get(b.source_ref); return r && idOf.has(b.source_ref) && Number(b.price) !== Number(r.price) ? [{ ref: b.ref, from: Number(b.price), to: Number(r.price) }] : []; });
      if (moves.length) {
        await q(`INSERT INTO audit_log (action, subject, detail) SELECT 'listing.updated', s, d FROM unnest($1::text[], $2::jsonb[]) AS t(s, d)`,
          [moves.map((m) => `listing:${m.ref}`), moves.map((m) => JSON.stringify({ fields: ['price'], priceFrom: m.from, priceTo: m.to, via: 'feed' }))], c);
      }

      const withdrawn = await q<{ id: string }>(`UPDATE listings SET status = 'withdrawn', updated_at = now() WHERE organisation_id = $1 AND source_kind = 'agent-feed'
        AND status IN ('live', 'under_offer', 'pending') AND NOT (source_ref = ANY($2))
        AND (feed_key_id = $3 OR (
          (feed_key_id IS NULL OR feed_key_id IN (SELECT id FROM feed_keys WHERE organisation_id = $1 AND revoked_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM feed_keys WHERE organisation_id = $1 AND revoked_at IS NULL AND id <> $3)))
        RETURNING id`, [fk.organisation_id, refs, fk.id], c);
      // Listing history for the whole file in one statement: first listed, price changes, under offer, withdrawn, relisted.
      await recordHistory([...touched, ...withdrawn.map((w) => w.id)], c);
      await q('INSERT INTO feed_runs (organisation_id, feed_key_id, format, accepted, withdrawn, rejected) VALUES ($1, $2, $3, $4, $5, $6)',
        [fk.organisation_id, fk.id, `BLM ${report.version}`, saved.length, withdrawn.length, JSON.stringify(rejected)], c);
      await q('UPDATE feed_keys SET last_used_at = now() WHERE id = $1', [fk.id], c);
      return { accepted: saved.length, withdrawn: withdrawn.length };
    });
    await audit(req, 'feed.ingested', `org:${fk.organisation_id}`, { ...result, rejected: rejected.length });
    if (fk.verified && touched.length) await emit('listingsPublished', { listingIds: touched });
    return {
      ...result, rejected, format: `BLM ${report.version}`,
      note: fk.verified ? 'Listings are live.' : 'Your agency is awaiting verification, so these listings are pending until an admin approves the agency.',
    };
  });
}

/** BLM files are often Windows-1252; use UTF-8 when the bytes are valid UTF-8. */
function decode(b: Buffer) {
  const s = b.toString('utf8');
  return s.includes('�') ? b.toString('latin1') : s;
}
