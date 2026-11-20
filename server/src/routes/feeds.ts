/**
 * Agent feeds: an agency sends its stock as a BLM v3 file, the format UK agency software already exports to
 * portals. A file arrives one of two ways, and both run the same import (importFeed):
 *   - from the agency's software, with a feed key (one per branch if they like): POST /api/feeds/blm
 *   - by hand, a signed-in owner or admin uploading the file from the agency page: POST /api/orgs/:id/feed-upload
 * Each file is the full stock for its source: new references are added, changed ones updated, and references
 * missing from the file are withdrawn. After every run the agency's owners and admins are emailed the result.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isFloorPlanCaption } from '../../../src/engine/floorplan';
import { decodeFeedBytes, FEED_PLAN_CAPTION, looksLikeBLM, parseBLM, type FeedIssue, type FeedListing, type FeedReport } from '../../../src/engine/listings';
import type { FeedResultDTO } from '../../../src/lib/apiTypes';
import { listingRef, newToken, sha256 } from '../auth/crypto';
import { config } from '../config';
import { one, q, tx } from '../db';
import { sendFeedReport } from '../services/feedReport';
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
const tooLargeMessage = `the limit is ${(FEED_MAX_BYTES / 1048576).toFixed(1).replace(/\.0$/, '')} MB per upload`;

/**
 * A file uploaded by hand has no feed key, but it is a source of listings like any key: one more branch, in
 * effect. So each agency has one row in feed_keys that stands for "uploaded by hand", and listings.feed_key_id
 * points at it for listings that last arrived that way. That keeps the withdrawal rule one rule (a source only
 * withdraws what it last sent), with no extra column. The row can never be used as a key: it is created
 * revoked, its hash is not the hash of any key, and this prefix marks it (real keys' prefixes start "skf_").
 * It is left out of the agency's list of keys.
 */
const HAND_PREFIX = 'upload';
const HAND_LABEL = 'Uploaded by hand';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function orgRole(req: FastifyRequest, orgId: string) {
  const u = requireUser(req);
  if (!UUID_RE.test(orgId)) throw notFound('That organisation');
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

const hostOf = (url: string) => { try { return new URL(url).host.slice(0, 80) || 'no host'; } catch { return 'not a web address'; } };
const isPdf = (url: string) => { try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; } };
/** A listing ready to store: its photo links checked, and at most one floor plan. */
export type PreparedListing = FeedListing & { photos: string[]; floorPlan: string | null };
/**
 * The listings to import: one per agent reference (a repeated reference keeps the last row, as CRMs append
 * corrections), with picture links the server may fetch only (public https hosts; see storage.safeExternalUrl)
 * and one floor plan each (the first in the file that is a picture).
 *
 * Also the run's list of things to tell the agency: every listing that was not imported, and (marked
 * `imported`) every listing that went in with something left out.
 */
export function prepareFeed(report: FeedReport): { inputs: PreparedListing[]; rejected: FeedIssue[] } {
  const rejected: FeedIssue[] = [...report.rejected, ...report.notes.map((n) => ({ ...n, imported: true }))];
  const note = (ref: string, reason: string) => { rejected.push({ ref, reason, imported: true }); };
  const byRef = new Map<string, FeedListing>();
  for (const i of report.inputs) {
    if (byRef.has(i.ref)) note(i.ref, 'Listed more than once in this file: the last one was used');
    byRef.set(i.ref, i);
  }
  const inputs = [...byRef.values()].map((i) => {
    const photos: string[] = [];
    (i.photos ?? []).forEach((url, n) => {
      if (!safeExternalUrl(url)) note(i.ref, `Photo ${n + 1} skipped (${hostOf(url)}): photos must be on a public https web address`);
      else if (photos.length < FEED_MAX_PHOTOS) photos.push(url);
    });
    let floorPlan: string | null = null, spare = 0;
    (i.floorPlans ?? []).forEach((url, n) => {
      if (!safeExternalUrl(url)) note(i.ref, `Floor plan ${n + 1} skipped (${hostOf(url)}): floor plans must be on a public https web address`);
      else if (isPdf(url)) note(i.ref, `Floor plan ${n + 1} skipped: it is a PDF, and Streetkey shows a floor plan as a picture`);
      else if (floorPlan) spare++;
      else floorPlan = url;
    });
    if (spare) note(i.ref, `Streetkey shows one floor plan for each listing: the first was used and ${spare} more ${spare === 1 ? 'was' : 'were'} left out`);
    return { ...i, photos, floorPlan };
  });
  return { inputs, rejected };
}

/** Whose file it is and how it arrived. */
interface FeedOrg { id: string; name: string; verified: boolean }
type FeedSource = { via: 'key'; keyId: string; label: string } | { via: 'upload'; userId: string };

/** The row in feed_keys that stands for this agency's files uploaded by hand (made the first time one arrives). */
async function handSource(organisationId: string, userId: string): Promise<string> {
  const hash = sha256(`hand-upload:${organisationId}`);
  await q(`INSERT INTO feed_keys (organisation_id, label, prefix, key_hash, created_by, revoked_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (key_hash) DO NOTHING`,
    [organisationId, HAND_LABEL, HAND_PREFIX, hash, userId]);
  return (await one<{ id: string }>('SELECT id FROM feed_keys WHERE key_hash = $1', [hash]))!.id;
}

/** The file as text: UTF-8 or Windows-1252 (decodeFeedBytes), or Latin-1 on a Node build without Windows-1252. */
function decodeFeed(b: Buffer): string {
  try { return decodeFeedBytes(b); } catch { return b.toString('latin1'); }
}

/*
 * One file is the full stock for its source: new references are added, changed ones updated and references
 * missing from the file are withdrawn, only among the listings this source last sent. A source is one feed
 * key, or the agency's uploads by hand. So each branch can use its own key, and uploading a file by hand never
 * withdraws listings that arrive with a key, nor the reverse. A listing belongs to whichever source sent it
 * last. Set-based, so a few hundred listings take a handful of queries, well within a function's time.
 *
 * Listings with no working key: those imported before feeds remembered their key (migration 013) are given the key
 * that sent the agency's last keyed file (until then every upload was the whole stock, so that file held them all).
 * Listings whose key was revoked belong to this key when it is the agency's only working key (the usual case: a
 * replaced key); with several keys they are left for a branch to send again, so one branch never withdraws another's.
 * So an agency splitting its stock across branch keys sends the new branches' files first, then the original key's.
 * Neither rule ever applies to listings uploaded by hand, or to an upload by hand.
 */
async function importFeed(req: FastifyRequest, org: FeedOrg, source: FeedSource): Promise<FeedResultDTO> {
  const body = req.body;
  const raw = typeof body === 'string' ? body : Buffer.isBuffer(body) ? decodeFeed(body) : '';
  if (!looksLikeBLM(raw)) throw new HttpError(400, 'That doesn’t look like a BLM file (missing #HEADER# / #DATA#).', 'bad_feed');
  const report = parseBLM(raw, org.name);
  const { inputs, rejected } = prepareFeed(report);
  const geo = await bulkGeocode(inputs.map((i) => i.postcode));
  const sourceId = source.via === 'key' ? source.keyId : await handSource(org.id, source.userId);
  /*
   * "Not in the file" only means "no longer for sale" when the whole file could be read. If any row could not
   * be lined up with the header (or has no reference), or the file has rows but not one listing in it could be
   * imported, the listings already on Streetkey are left as they are and the report says so.
   */
  const unreadable = report.rejected.filter((r) => r.ref === '(no ref)' || /^Expected \d+ fields/.test(r.reason)).length;
  const keepStock = unreadable > 0 || (inputs.length === 0 && report.rejected.length > 0);
  if (keepStock) {
    rejected.push({
      ref: '(whole file)', imported: true,
      reason: unreadable > 0
        ? `${unreadable} row${unreadable === 1 ? '' : 's'} could not be read, so no listings were withdrawn on this run. Listings no longer in your file stay on Streetkey until a file that reads cleanly is sent`
        : 'No listing in this file could be imported, so no listings were withdrawn on this run',
    });
  }
  // What the last run from this source reported, to avoid emailing the same report every time a file is re-sent.
  const last = await one<{ rejected: unknown }>('SELECT rejected FROM feed_runs WHERE organisation_id = $1 AND feed_key_id = $2 ORDER BY created_at DESC LIMIT 1', [org.id, sourceId]);

  const rows = inputs.map((i) => {
    const g = geo.get(i.postcode);
    return {
      ref: listingRef(), source_ref: i.ref, channel: i.listing, status: !org.verified ? 'pending' : i.status === 'under offer' ? 'under_offer' : 'live',
      title: i.title ?? null, address_line: i.addressLine, town: i.town, postcode: i.postcode, district: g?.district ?? i.postcode.split(' ')[0],
      lat: g?.lat ?? null, lng: g?.lng ?? null, property_type: i.type, tenure: i.tenure, lease_years: i.leaseYears ?? null, beds: i.beds,
      baths: Math.max(0, i.baths), floor_area: i.floorArea || Math.round(25 + i.beds * 22), condition: i.condition ?? null, price: i.price,
      price_qualifier: i.priceQualifier ?? null,
      epc: i.epc ?? null, council_tax: i.councilTax ?? null, service_charge_annual: i.serviceChargeAnnual ?? null, features: i.features, description: i.description ?? null,
      // What a letting says beyond the rent (deposit, available date, furnishing), exactly as the file gave it.
      // floorAreaEstimated: the file gave no floor area, so the figure stored (the column needs one) is a guess from
      // the bedroom count. It is never shown as the home's floor area.
      material_info: { ...(i.letting ? { letting: i.letting } : {}), ...(i.floorArea ? {} : { floorAreaEstimated: true }) },
    };
  });
  // Each listing's pictures in order: its photos, then its floor plan under the caption the site knows a floor plan by.
  const pictures = new Map(inputs.map((i) => [i.ref, [...i.photos.map((url) => ({ url, plan: false })), ...(i.floorPlan ? [{ url: i.floorPlan, plan: true }] : [])]]));
  const rowByRef = new Map(rows.map((r) => [r.source_ref, r]));
  const refs = inputs.map((i) => i.ref);

  const touched: string[] = [];
  const result = await tx(async (c) => {
    await q(`UPDATE listings l SET feed_key_id = r.feed_key_id
               FROM (SELECT fr.feed_key_id FROM feed_runs fr JOIN feed_keys k ON k.id = fr.feed_key_id
                      WHERE fr.organisation_id = $1 AND k.prefix <> $2 ORDER BY fr.created_at DESC LIMIT 1) r
              WHERE l.organisation_id = $1 AND l.source_kind = 'agent-feed' AND l.feed_key_id IS NULL`, [org.id, HAND_PREFIX], c);
    const before = await q<{ source_ref: string; ref: string; price: number }>('SELECT source_ref, ref, price FROM listings WHERE organisation_id = $1 AND source_ref = ANY($2)', [org.id, refs], c);
    // On an update the let details in material_info are replaced by the file's (and go when the file no longer
    // has them); anything else kept there stays.
    const saved = rows.length ? await q<{ id: string; source_ref: string }>(
      `INSERT INTO listings (ref, organisation_id, feed_key_id, source_kind, source_ref, channel, status, title, address_line, town, postcode, district, lat, lng,
         property_type, tenure, lease_years, beds, baths, floor_area, condition, price, price_qualifier, epc, council_tax, service_charge_annual, features, description,
         material_info, ownership_declared, published_at)
       SELECT x.ref, $2, $3, 'agent-feed', x.source_ref, x.channel, x.status, x.title, x.address_line, x.town, x.postcode, x.district, x.lat, x.lng,
         x.property_type, x.tenure, x.lease_years, x.beds, x.baths, x.floor_area, x.condition, x.price, x.price_qualifier, x.epc, x.council_tax, x.service_charge_annual,
         x.features, x.description, coalesce(x.material_info, '{}'::jsonb), true, CASE WHEN x.status = 'pending' THEN NULL ELSE now() END
         FROM jsonb_to_recordset($1::jsonb) AS x(ref text, source_ref text, channel text, status text, title text, address_line text, town text, postcode text,
           district text, lat double precision, lng double precision, property_type text, tenure text, lease_years int, beds int, baths int, floor_area numeric,
           condition text, price numeric, price_qualifier text, epc text, council_tax text, service_charge_annual numeric, features text[], description text, material_info jsonb)
       ON CONFLICT (organisation_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
         feed_key_id = EXCLUDED.feed_key_id, channel = EXCLUDED.channel, status = CASE WHEN listings.status IN ('sold', 'let') THEN listings.status ELSE EXCLUDED.status END,
         title = EXCLUDED.title, address_line = EXCLUDED.address_line, town = EXCLUDED.town, postcode = EXCLUDED.postcode, district = EXCLUDED.district,
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, property_type = EXCLUDED.property_type, tenure = EXCLUDED.tenure, lease_years = EXCLUDED.lease_years,
         beds = EXCLUDED.beds, baths = EXCLUDED.baths, floor_area = EXCLUDED.floor_area, condition = EXCLUDED.condition, price = EXCLUDED.price,
         price_qualifier = EXCLUDED.price_qualifier, epc = EXCLUDED.epc, council_tax = EXCLUDED.council_tax, service_charge_annual = EXCLUDED.service_charge_annual,
         features = EXCLUDED.features, description = EXCLUDED.description, material_info = (listings.material_info - 'letting' - 'floorAreaEstimated') || EXCLUDED.material_info,
         published_at = coalesce(listings.published_at, EXCLUDED.published_at), updated_at = now()
       RETURNING id, source_ref`, [JSON.stringify(rows), org.id, sourceId], c) : [];
    const idOf = new Map(saved.map((r) => [r.source_ref, r.id]));
    touched.push(...saved.map((r) => r.id));

    // Feed pictures are the agent's own hosted images: replaced only where the list of links changed (unchanged
    // photos keep their stored checks). A link counts as changed when it turns from a photo into the floor plan or back.
    const current = new Map<string, { url: string; plan: boolean }[]>();
    for (const p of await q<{ listing_id: string; url: string; alt: string | null }>(
      `SELECT listing_id, url, alt FROM listing_photos WHERE listing_id = ANY($1) AND storage_key LIKE 'ext:%' ORDER BY listing_id, position, created_at`, [touched], c)) {
      current.set(p.listing_id, [...(current.get(p.listing_id) ?? []), { url: p.url, plan: isFloorPlanCaption(p.alt) }]);
    }
    const changed = saved.filter((r) => JSON.stringify(current.get(r.id) ?? []) !== JSON.stringify(pictures.get(r.source_ref) ?? []));
    if (changed.length) {
      await q(`DELETE FROM listing_photos WHERE listing_id = ANY($1) AND storage_key LIKE 'ext:%'`, [changed.map((r) => r.id)], c);
      const ids: string[] = [], urls: string[] = [], positions: number[] = [], alts: (string | null)[] = [];
      for (const r of changed) (pictures.get(r.source_ref) ?? []).forEach((p, n) => { ids.push(r.id); urls.push(p.url); positions.push(n); alts.push(p.plan ? FEED_PLAN_CAPTION : null); });
      if (ids.length) {
        await q(`INSERT INTO listing_photos (listing_id, storage_key, url, content_type, bytes, position, alt)
                 SELECT l, 'ext:' || u, u, 'image/*', 0, p, a FROM unnest($1::uuid[], $2::text[], $3::int[], $4::text[]) AS t(l, u, p, a)`, [ids, urls, positions, alts], c);
      }
    }

    // Price changes, for the audit trail (one insert for the whole file). The public history is written below.
    const moves = before.flatMap((b) => { const r = rowByRef.get(b.source_ref); return r && idOf.has(b.source_ref) && Number(b.price) !== Number(r.price) ? [{ ref: b.ref, from: Number(b.price), to: Number(r.price) }] : []; });
    if (moves.length) {
      await q(`INSERT INTO audit_log (action, subject, detail) SELECT 'listing.updated', s, d FROM unnest($1::text[], $2::jsonb[]) AS t(s, d)`,
        [moves.map((m) => `listing:${m.ref}`), moves.map((m) => JSON.stringify({ fields: ['price'], priceFrom: m.from, priceTo: m.to, via: 'feed' }))], c);
    }

    // Withdraw what this source sent before and has not sent now. A feed key also takes over listings with no working
    // key when it is the agency's only working key; an upload by hand only ever withdraws earlier uploads by hand.
    // Never from a file that could not be read properly (see keepStock): a damaged export must not empty an agency's page.
    const withdrawn = keepStock ? [] : await q<{ id: string }>(`UPDATE listings SET status = 'withdrawn', updated_at = now() WHERE organisation_id = $1 AND source_kind = 'agent-feed'
      AND status IN ('live', 'under_offer', 'pending') AND NOT (source_ref = ANY($2))
      AND (feed_key_id = $3 OR ($4::boolean AND
        (feed_key_id IS NULL OR feed_key_id IN (SELECT id FROM feed_keys WHERE organisation_id = $1 AND revoked_at IS NOT NULL AND prefix <> $5))
        AND NOT EXISTS (SELECT 1 FROM feed_keys WHERE organisation_id = $1 AND revoked_at IS NULL AND id <> $3)))
      RETURNING id`, [org.id, refs, sourceId, source.via === 'key', HAND_PREFIX], c);
    // Listing history for the whole file in one statement: first listed, price changes, under offer, withdrawn, relisted.
    await recordHistory([...touched, ...withdrawn.map((w) => w.id)], c);
    await q('INSERT INTO feed_runs (organisation_id, feed_key_id, format, accepted, withdrawn, rejected) VALUES ($1, $2, $3, $4, $5, $6)',
      [org.id, sourceId, `BLM ${report.version}`, saved.length, withdrawn.length, JSON.stringify(rejected)], c);
    await q('UPDATE feed_keys SET last_used_at = now() WHERE id = $1', [sourceId], c);
    const existed = new Set(before.map((b) => b.source_ref));
    return { accepted: saved.length, updated: saved.filter((r) => existed.has(r.source_ref)).length, withdrawn: withdrawn.length };
  });
  const notImported = rejected.filter((r) => !r.imported).length;
  await audit(req, 'feed.ingested', `org:${org.id}`, { ...result, rejected: notImported, notes: rejected.length - notImported, via: source.via });
  if (org.verified && touched.length) await emit('listingsPublished', { listingIds: touched });

  const format = `BLM ${report.version}`;
  // The agency's owners and admins are told what happened. The import is done by now: an email that fails must not undo it.
  // A file re-sent with nothing new in it (software that sends hourly) is not reported again: no listings added or
  // withdrawn, and the same listings left out for the same reasons as last time.
  const nothingNew = !!last && result.accepted === result.updated && result.withdrawn === 0 && JSON.stringify(last.rejected) === JSON.stringify(rejected);
  if (!nothingNew) try {
    await sendFeedReport(org.id, {
      organisationName: org.name, via: source.via, keyLabel: source.via === 'key' ? source.label : undefined, format,
      ...result, issues: rejected, leftOut: report.leftOut, verified: org.verified, at: new Date(),
    });
  } catch (e) { req.log.warn({ what: 'feed_report', code: (e as { code?: string }).code ?? 'error' }, 'feed report email failed'); }

  return {
    ...result, rejected, leftOut: report.leftOut, format,
    note: org.verified ? 'Listings are live.' : 'Your agency is awaiting verification, so these listings are pending until an admin approves the agency.',
  };
}

export async function feedRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:id/feed-keys', async (req) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    return { items: await q(`SELECT id, label, prefix, last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt" FROM feed_keys WHERE organisation_id = $1 AND prefix <> $2 ORDER BY created_at DESC`, [id, HAND_PREFIX]) };
  });

  app.post('/api/orgs/:id/feed-keys', async (req, reply) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    const { label } = parse(z.object({ label: z.string().trim().min(1).max(60).default('CRM feed') }), req.body ?? {});
    const { token } = newToken(32);
    const key = `skf_${token}`;
    await q('INSERT INTO feed_keys (organisation_id, label, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5)', [id, label, key.slice(0, 10), sha256(key), req.user!.id]);
    await audit(req, 'feed.key_created', `org:${id}`, { label });
    return reply.code(201).send({ key, note: 'Copy this key now: it is shown only once. Send it as “Authorization: Bearer <key>” with each feed upload.' });
  });

  app.delete('/api/orgs/:id/feed-keys/:keyId', async (req) => {
    const { id, keyId } = req.params as { id: string; keyId: string };
    await orgRole(req, id);
    if (!UUID_RE.test(keyId)) throw notFound('That feed key');
    await q('UPDATE feed_keys SET revoked_at = now() WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL', [keyId, id]);
    await audit(req, 'feed.key_revoked', `org:${id}`);
    return { ok: true };
  });

  // source: 'upload' for a file uploaded by hand, 'key' for one sent with a feed key (keyLabel names the key).
  app.get('/api/orgs/:id/feed-runs', async (req) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    return { items: await q(
      `SELECT r.id, r.format, r.accepted, r.withdrawn, r.rejected, r.created_at AS "createdAt",
              CASE WHEN k.prefix = $2 THEN 'upload' ELSE 'key' END AS source, CASE WHEN k.prefix = $2 THEN NULL ELSE k.label END AS "keyLabel"
         FROM feed_runs r LEFT JOIN feed_keys k ON k.id = r.feed_key_id WHERE r.organisation_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [id, HAND_PREFIX]) };
  });

  await app.register(fileRoutes);
}

/** The two routes that take a feed file as the request body. */
async function fileRoutes(app: FastifyInstance) {
  // A feed file is read as bytes whatever content type it arrives with, so Windows-1252 text survives (decodeFeed).
  // Only these two routes: this plugin has its own readers, and the routes above keep the JSON one.
  const asBytes = (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => done(null, body);
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, asBytes);
  app.addContentTypeParser('*', { parseAs: 'buffer' }, asBytes);

  /* From the agency's software: the whole file is the request body, with the feed key as a bearer token. */
  app.post('/api/feeds/blm', { bodyLimit: FEED_MAX_BYTES, preHandler: limit('feeds.blm', 12, 60) }, async (req) => {
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!key.startsWith('skf_')) throw new HttpError(401, 'Send your feed key as “Authorization: Bearer skf_…”.', 'feed_auth');
    const fk = await one<{ id: string; label: string; organisation_id: string; name: string; verified: boolean }>(
      `SELECT k.id, k.label, k.organisation_id, o.name, o.verified FROM feed_keys k JOIN organisations o ON o.id = k.organisation_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [sha256(key)]);
    if (!fk) throw new HttpError(401, 'That feed key isn’t valid or has been revoked.', 'feed_auth');
    return importFeed(req, { id: fk.organisation_id, name: fk.name, verified: fk.verified }, { via: 'key', keyId: fk.id, label: fk.label });
  });

  /*
   * By hand: a signed-in owner or admin of the agency (the same rule as the feed-key routes) sends the file as the
   * request body. The same import, the same size limit. The file is the full stock for "uploaded by hand": listings
   * from an earlier upload by hand that are not in it are withdrawn, and listings sent with a feed key are untouched.
   */
  const uploadError = (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err.statusCode !== 413) return app.errorHandler(err, req, reply);
    return reply.code(413).send({ error: { code: 'feed_too_large', message: `That file is too large: ${tooLargeMessage}. Larger agencies send each branch’s stock from their software with its own feed key.` } });
  };
  app.post('/api/orgs/:id/feed-upload', { bodyLimit: FEED_MAX_BYTES, errorHandler: uploadError, preHandler: limit('feeds.upload', 12, 60, 'user-or-ip') }, async (req) => {
    const { id } = req.params as { id: string };
    await orgRole(req, id);
    const org = await one<FeedOrg>('SELECT id, name, verified FROM organisations WHERE id = $1', [id]);
    if (!org) throw notFound('That organisation');
    return importFeed(req, org, { via: 'upload', userId: req.user!.id });
  });
}
