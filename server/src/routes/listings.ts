import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ListingStatus } from '../../../src/lib/apiTypes';
import { altTextProblem } from '../../../src/engine/listings';
import { listingRef } from '../auth/crypto';
import { config } from '../config';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { audit, forbidden, HttpError, notFound, parse, requireUser } from '../services/http';
import { cleanImage, sniffImage } from '../services/images';
import { checksFor, columnsFrom, geocode, LISTING_SELECT, ListingBody, ListingPatch, photosFor, PUBLIC_STATUSES, toDTO, type ListingRow } from '../services/listings';
import { deleteFile, newKey, putFile } from '../services/storage';
import { limit } from '../services/ratelimit';
import { emit } from '../ai/hooks';
import { bytesHash, readPreview } from '../ai/listing/previewToken';
import type { PhotoAnalysis } from '../ai/listing/photos';

export async function orgIdsFor(userId?: string | null) {
  if (!userId) return [];
  return (await q<{ organisation_id: string }>('SELECT organisation_id FROM memberships WHERE user_id = $1', [userId])).map((r) => r.organisation_id);
}

export async function viewerOf(req: FastifyRequest) {
  return { userId: req.user?.id ?? null, orgIds: await orgIdsFor(req.user?.id), admin: req.user?.role === 'admin' };
}

export async function loadByRef(ref: string) {
  return one<ListingRow>(`${LISTING_SELECT} WHERE l.ref = $1`, [ref]);
}

/** The listing, if the signed-in person may edit it (lister, their agency, or an admin). */
export async function editable(req: FastifyRequest, ref: string) {
  const u = requireUser(req);
  const row = await loadByRef(ref);
  if (!row) throw notFound('That listing');
  const orgs = await orgIdsFor(u.id);
  if (row.owner_user_id !== u.id && !(row.organisation_id && orgs.includes(row.organisation_id)) && u.role !== 'admin') throw forbidden();
  return row;
}

const SORTS: Record<string, string> = { newest: 'coalesce(l.published_at, l.created_at) DESC', price_asc: 'l.price ASC', price_desc: 'l.price DESC' };
const DISTRICT_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

const SearchQ = z.object({
  q: z.string().trim().max(200).optional(),
  channel: z.enum(['sale', 'rent']).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minBeds: z.coerce.number().int().min(0).max(30).optional(),
  type: z.string().max(30).optional(),
  district: z.string().max(5).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(24),
});

const TRANSITIONS: Record<string, ListingStatus[]> = {
  // what the lister may move a listing to, from each status
  draft: ['withdrawn'], pending: ['draft', 'withdrawn'], live: ['under_offer', 'sold', 'let', 'withdrawn'],
  under_offer: ['live', 'sold', 'let', 'withdrawn'], sold: ['withdrawn'], let: ['withdrawn'], withdrawn: ['draft'], rejected: ['draft', 'withdrawn'],
};

/** Listings that have passed the submission checks: in the review queue, or public. Edits must keep passing them. */
const SUBMITTED: ListingStatus[] = ['pending', 'live', 'under_offer'];
/** Listings that can't be changed until they're re-listed. */
const CLOSED: ListingStatus[] = ['sold', 'let', 'withdrawn'];

const checksFailed = (blocking: { id: string; message: string }[], message = 'A few things are needed before this listing can go live.') =>
  new HttpError(422, message, 'checks_failed', Object.fromEntries(blocking.map((c) => [c.id, c.message])));

/** Same value? (numbers from forms vs the database, null vs undefined, arrays and JSON by content). */
function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'string' && typeof b === 'object') { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(b); } catch { return false; } }
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/* ---------- photo uploads ---------- */
/** Files per upload request. The website sends a few at a time so each request stays well under hosting body limits. */
export const UPLOAD_MAX_FILES = 12;
const PhotoMeta = z.array(z.object({
  /** A signed result from the AI photo preview for exactly this file (see ai/listing/previewToken.ts). */
  token: z.string().max(4000).nullish(),
  /** Alt text the lister wrote or accepted. */
  alt: z.string().trim().max(160).nullish(),
}).nullable()).max(UPLOAD_MAX_FILES);
type PhotoMetaT = z.infer<typeof PhotoMeta>;
/** Multipart limit errors, as a message for the person (the photos stored before the limit was hit are kept). */
function uploadLimitMessage(code: string | undefined, index: number): { code: string; message: string } | null {
  const mb = Math.round(config.storage.maxPhotoBytes / 1048576);
  if (code === 'FST_REQ_FILE_TOO_LARGE') return { code: 'too_large', message: `Photo ${index + 1} is larger than ${mb} MB, so it (and any photos after it in this upload) wasn’t added. Use a smaller copy of it.` };
  if (code === 'FST_FILES_LIMIT') return { code: 'too_many', message: `Send up to ${UPLOAD_MAX_FILES} photos at a time. The rest of this upload wasn’t added: send them again.` };
  if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') return { code: 'too_many', message: 'That upload had too many parts. Send fewer photos at a time.' };
  if (code === 'FST_FIELD_SIZE_LIMIT' || code === 'FST_PROTO_VIOLATION' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return { code: 'bad_upload', message: 'That upload wasn’t valid. Please try again.' };
  return null;
}
const roomAlt = (a: PhotoAnalysis) => a.room.charAt(0).toUpperCase() + a.room.slice(1);

export async function listingRoutes(app: FastifyInstance) {
  /* ---------- public search ---------- */
  app.get('/api/listings', async (req) => {
    const p = parse(SearchQ, req.query);
    const where: string[] = [`l.status = ANY($1)`]; const args: unknown[] = [PUBLIC_STATUSES];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (p.channel) add('l.channel = ?', p.channel);
    if (p.minPrice != null) add('l.price >= ?', p.minPrice);
    if (p.maxPrice != null) add('l.price <= ?', p.maxPrice);
    if (p.minBeds != null) add('l.beds >= ?', p.minBeds);
    if (p.type) add('l.property_type = ?', p.type);
    if (p.district) add('l.district = ?', p.district.toUpperCase());
    let rank = '';
    if (p.q) {
      if (DISTRICT_RE.test(p.q)) add('l.district = ?', p.q.toUpperCase());
      else { add(`l.search @@ websearch_to_tsquery('english', ?)`, p.q); rank = `ts_rank(l.search, websearch_to_tsquery('english', $${args.length})) DESC, `; }
    }
    const whereSql = where.join(' AND ');
    const total = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM listings l WHERE ${whereSql}`, args))!.n;
    args.push(p.pageSize, (p.page - 1) * p.pageSize);
    const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE ${whereSql} ORDER BY ${rank}${SORTS[p.sort]} LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const photos = await photosFor(rows.map((r) => r.id));
    const viewer = await viewerOf(req);
    return { items: rows.map((r) => toDTO(r, photos.get(r.id) ?? [], viewer)), total, page: p.page, pageSize: p.pageSize };
  });

  app.get('/api/listings/:ref', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await loadByRef(ref);
    if (!row) throw notFound('That listing');
    const viewer = await viewerOf(req);
    const canSee = PUBLIC_STATUSES.includes(row.status) || ['sold', 'let'].includes(row.status) || viewer.admin
      || row.owner_user_id === viewer.userId || (row.organisation_id && viewer.orgIds.includes(row.organisation_id));
    if (!canSee) throw notFound('That listing');
    const photos = (await photosFor([row.id])).get(row.id) ?? [];
    const dto = toDTO(row, photos, viewer);
    return { listing: dto, checks: dto.mine || viewer.admin ? checksFor(row, photos.length) : undefined };
  });

  /* ---------- the lister's own listings ---------- */
  app.get('/api/me/listings', async (req) => {
    const u = requireUser(req);
    const orgs = await orgIdsFor(u.id);
    // Each count is limited to this lister's listings first (indexes from migration 009), so the dashboard doesn't
    // scan the whole site. Enquiries held back as spam or scams aren't counted, matching the inbox.
    const rows = await q<ListingRow & { enquiries: number; new_enquiries: number; held_enquiries: number; views_30d: number; saves: number }>(
      `WITH mine AS (SELECT id, ref FROM listings WHERE owner_user_id = $1 OR organisation_id = ANY($2)),
            e AS (SELECT listing_id, count(*) FILTER (WHERE NOT filtered) n, count(*) FILTER (WHERE status = 'new' AND NOT filtered) new_n, count(*) FILTER (WHERE filtered) held_n
                    FROM enquiries WHERE listing_id IN (SELECT id FROM mine) GROUP BY listing_id),
            v AS (SELECT listing_id, count(*) n FROM engagement_events
                   WHERE name = 'listing_view' AND occurred_at > now() - interval '30 days' AND listing_id IN (SELECT id FROM mine) GROUP BY listing_id),
            s AS (SELECT listing_key, count(*) n FROM saved_listings WHERE listing_key IN (SELECT ref FROM mine) GROUP BY listing_key)
       SELECT l.*, o.name AS organisation_name, o.verified AS organisation_verified, u.display_name AS owner_name,
              coalesce(e.n, 0)::int AS enquiries, coalesce(e.new_n, 0)::int AS new_enquiries, coalesce(e.held_n, 0)::int AS held_enquiries,
              coalesce(v.n, 0)::int AS views_30d, coalesce(s.n, 0)::int AS saves
         FROM mine JOIN listings l ON l.id = mine.id
         LEFT JOIN organisations o ON o.id = l.organisation_id LEFT JOIN users u ON u.id = l.owner_user_id
         LEFT JOIN e ON e.listing_id = l.id LEFT JOIN v ON v.listing_id = l.id LEFT JOIN s ON s.listing_key = l.ref
        ORDER BY l.updated_at DESC`, [u.id, orgs]);
    const photos = await photosFor(rows.map((r) => r.id));
    const viewer = { userId: u.id, orgIds: orgs, admin: u.role === 'admin' };
    return {
      items: rows.map((r) => ({
        ...toDTO(r, photos.get(r.id) ?? [], viewer),
        stats: { enquiries: r.enquiries, newEnquiries: r.new_enquiries, filtered: r.held_enquiries, views30d: r.views_30d, saves: r.saves },
        checks: checksFor(r, (photos.get(r.id) ?? []).length),
      })),
    };
  });

  /* ---------- create & edit ---------- */
  app.post('/api/listings', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(ListingBody, req.body);
    const open = (await one<{ n: number }>(`SELECT count(*)::int n FROM listings WHERE owner_user_id = $1 AND status IN ('draft', 'pending', 'rejected')`, [u.id]))!.n;
    if (open >= 25 && u.role !== 'admin') throw new HttpError(409, 'You have a lot of unfinished listings. Finish or delete some drafts first.', 'too_many_drafts');
    const geo = await geocode(b.postcode);
    // Agency staff list under their agency; everyone else is a private seller or landlord.
    const orgId = u.account_type === 'agent' ? (await orgIdsFor(u.id))[0] ?? null : null;
    const sourceKind = orgId ? 'agent' : u.account_type === 'landlord' || b.channel === 'rent' ? 'landlord' : 'owner';
    const cols = { ...columnsFrom(b), postcode: geo.postcode, district: geo.district, lat: geo.lat, lng: geo.lng, owner_user_id: u.id, organisation_id: orgId, source_kind: sourceKind, status: 'draft', ref: listingRef() };
    const keys = Object.keys(cols);
    const row = await one<{ ref: string }>(`INSERT INTO listings (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ref`, Object.values(cols));
    await audit(req, 'listing.created', `listing:${row!.ref}`);
    const full = (await loadByRef(row!.ref))!;
    return reply.code(201).send({ listing: toDTO(full, [], await viewerOf(req)), checks: checksFor(full, 0) });
  });

  /*
   * Editing. A listing that has passed the submission checks (pending, live or under offer) must keep passing them:
   * an edit that fails a blocking check is refused (422 'checks_failed', the same shape as submit). Every change is
   * announced (listingUpdated, with the columns that really changed), so the trust review can re-check edits to live
   * listings; if it takes the listing back to the review queue, the response says so (held: true).
   */
  app.patch('/api/listings/:ref', { preHandler: limit('listing.update', 30, 60, 'user') }, async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const admin = req.user!.role === 'admin';
    if (CLOSED.includes(row.status) && !admin) throw new HttpError(409, 'Re-list this property before editing it.', 'not_editable');
    const b = parse(ListingPatch, req.body);
    const all: Record<string, unknown> = columnsFrom(b);
    if (b.postcode) { const g = await geocode(b.postcode); Object.assign(all, { postcode: g.postcode, district: g.district, lat: g.lat, lng: g.lng }); }
    // Only what actually changed (the form sends every field on each save).
    const cols: Record<string, unknown> = Object.fromEntries(Object.entries(all).filter(([k, v]) => !same(v, (row as unknown as Record<string, unknown>)[k])));
    const fields = Object.keys(cols);
    if (fields.length && SUBMITTED.includes(row.status) && !admin) {
      const photoCount = (await one<{ n: number }>('SELECT count(*)::int n FROM listing_photos WHERE listing_id = $1', [row.id]))!.n;
      const blocking = checksFor({ ...row, ...cols } as ListingRow, photoCount).filter((c) => !c.ok && c.severity === 'block');
      if (blocking.length) throw checksFailed(blocking, 'A few things need fixing before these changes can be saved.');
    }
    // A rejected listing goes back to draft once it's edited.
    if (row.status === 'rejected' && fields.length) cols.status = 'draft';
    const keys = Object.keys(cols);
    if (keys.length) {
      await q(`UPDATE listings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [row.id, ...Object.values(cols)]);
      await audit(req, 'listing.updated', `listing:${ref}`, { fields, ...(b.price != null && Number(b.price) !== Number(row.price) ? { priceFrom: row.price, priceTo: b.price } : {}) });
      await emit('listingUpdated', { listingId: row.id, ref, fields: keys, userId: req.user!.id });
    }
    const fresh = (await loadByRef(ref))!;
    const photos = (await photosFor([fresh.id])).get(fresh.id) ?? [];
    // The trust review's automatic rules take a live listing off the site at once if the edit needs a closer look.
    const held = PUBLIC_STATUSES.includes(row.status) && fresh.status === 'pending';
    return {
      listing: toDTO(fresh, photos, await viewerOf(req)), checks: checksFor(fresh, photos.length),
      ...(held ? { held: true, note: 'Your changes are saved. Some of them need a quick check by our team, so the listing is hidden from search until then. We’ll email you when it’s back.' } : {}),
    };
  });

  /** Send for review (private sellers/landlords) or publish straight away (verified agencies). */
  app.post('/api/listings/:ref/submit', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    if (!['draft', 'rejected', 'withdrawn'].includes(row.status)) throw new HttpError(409, 'This listing has already been submitted.', 'bad_status');
    const photos = (await photosFor([row.id])).get(row.id) ?? [];
    const blocking = checksFor(row, photos.length).filter((c) => !c.ok && c.severity === 'block');
    if (blocking.length) throw checksFailed(blocking);
    const trustedAgency = row.organisation_id && row.organisation_verified;
    const goLive = !config.moderateOwnerListings || trustedAgency;
    await q(`UPDATE listings SET status = $2, rejection_reason = NULL, published_at = CASE WHEN $2 = 'live' THEN now() ELSE published_at END, updated_at = now() WHERE id = $1`, [row.id, goLive ? 'live' : 'pending']);
    await audit(req, goLive ? 'listing.published' : 'listing.submitted', `listing:${ref}`);
    await emit('listingSubmitted', { listingId: row.id, ref, userId: req.user!.id });
    if (goLive) await emit('listingsPublished', { listingIds: [row.id] });
    // A hook (e.g. an AI trust review with auto-approval) may have changed the status already.
    const now = (await one<{ status: string }>('SELECT status FROM listings WHERE id = $1', [row.id]))?.status ?? (goLive ? 'live' : 'pending');
    if (now === 'pending' && config.adminEmail) {
      await mails.listingForReview(config.adminEmail, row.title ?? row.address_line, ref).catch(() => {});
    }
    return { status: now };
  });

  app.post('/api/listings/:ref/status', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const { status } = parse(z.object({ status: z.enum(['draft', 'live', 'under_offer', 'sold', 'let', 'withdrawn']) }), req.body);
    if (!TRANSITIONS[row.status]?.includes(status)) throw new HttpError(409, `A ${row.status.replace('_', ' ')} listing can’t be marked ${status.replace('_', ' ')}.`, 'bad_transition');
    if (status === 'let' && row.channel !== 'rent') throw new HttpError(409, 'Only rentals can be marked let.', 'bad_transition');
    if (status === 'sold' && row.channel !== 'sale') throw new HttpError(409, 'Only sales can be marked sold.', 'bad_transition');
    await q('UPDATE listings SET status = $2, updated_at = now() WHERE id = $1', [row.id, status]);
    await audit(req, 'listing.status', `listing:${ref}`, { from: row.status, to: status });
    return { status };
  });

  app.delete('/api/listings/:ref', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    if (row.status === 'draft') {
      const files = await q<{ storage_key: string }>('SELECT storage_key FROM listing_photos WHERE listing_id = $1', [row.id]);
      await q('DELETE FROM listings WHERE id = $1', [row.id]);
      await Promise.all(files.map((f) => deleteFile(f.storage_key)));
      await audit(req, 'listing.deleted', `listing:${ref}`);
      return { deleted: true };
    }
    await q(`UPDATE listings SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [row.id]);
    await audit(req, 'listing.withdrawn', `listing:${ref}`);
    return { withdrawn: true };
  });

  /* ---------- photos ---------- */
  /*
   * Upload photos (multipart, field 'photos', up to 12 per request; the website sends a few at a time). An optional
   * 'meta' field (JSON array, one entry per file in order) carries the alt text and a signed AI preview result, so
   * photos already checked in the browser aren't sent to the AI again. If a multipart limit stops the upload part-way,
   * the photos stored before it are kept and announced, and the response says what to resend.
   */
  app.post('/api/listings/:ref/photos', { preHandler: limit('listing.photos', 60, 60, 'user-or-ip') }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const userId = req.user!.id;
    if (CLOSED.includes(row.status) && req.user!.role !== 'admin') throw new HttpError(409, 'Re-list this property before adding photos.', 'not_editable');
    if (!req.isMultipart()) throw new HttpError(400, 'Upload photos as a form (multipart).', 'not_multipart');
    const existing = (await one<{ n: number; max: number | null }>('SELECT count(*)::int n, max(position) max FROM listing_photos WHERE listing_id = $1', [row.id]))!;
    let position = (existing.max ?? -1) + 1, count = existing.n;
    const stored: { id: string; url: string; alt: string | null; index: number; hash: string }[] = [];
    const rejected: string[] = [];
    const notes: string[] = [];
    let metaRaw = '';
    let index = -1;
    let stopped: { code: string; message: string } | null = null;
    let failure: unknown = null;
    try {
      for await (const part of req.parts({ limits: { files: UPLOAD_MAX_FILES, fileSize: config.storage.maxPhotoBytes, fields: 4, fieldSize: 64_000, parts: UPLOAD_MAX_FILES + 4 } })) {
        if (part.type !== 'file') { if (part.fieldname === 'meta') metaRaw = String(part.value ?? ''); continue; }
        index++;
        const name = part.filename || `photo ${index + 1}`;
        const buf = await part.toBuffer();
        const type = sniffImage(buf);
        if (!type) { rejected.push(`${name}: not a JPEG, PNG or WebP image`); continue; }
        if (count >= config.storage.maxPhotosPerListing) { rejected.push(`${name}: limit of ${config.storage.maxPhotosPerListing} photos reached`); continue; }
        const hash = bytesHash(buf); // of the file as sent, so an AI preview of exactly this file can be matched
        const clean = cleanImage(buf, type);
        const file = await putFile(newKey(`listings/${row.ref}`, type), clean, type);
        // Use the file name as alt text only when it describes something (not "IMG_1234" or "photo-1") and is safe to show.
        const base = (part.filename ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
        const named = base && !/^(img|dsc|dscn|pxl|photo|image|picture|pic|screenshot|whatsapp image|untitled|file|scan)?\s*[\d\s()]*$/i.test(base) ? base.slice(0, 120) : null;
        const alt = named && !altTextProblem(named) ? named : null;
        const p = await one<{ id: string }>('INSERT INTO listing_photos (listing_id, storage_key, url, content_type, bytes, position, alt) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [row.id, file.key, file.url, type, clean.length, position++, alt]);
        stored.push({ id: p!.id, url: file.url, alt, index, hash }); count++;
      }
    } catch (e) {
      stopped = uploadLimitMessage((e as { code?: string }).code, Math.max(index, 0));
      if (!stopped) failure = e; // unexpected (e.g. storage): finish what was stored, then report it
    }

    // Alt text and AI preview results for the stored photos (entries line up with the files in this request).
    let meta: PhotoMetaT = [];
    if (metaRaw) { try { meta = PhotoMeta.parse(JSON.parse(metaRaw)); } catch { notes.push('Alt text and photo check results weren’t in a form we could read, so they weren’t saved.'); } }
    let prefilled = 0;
    for (const s of stored) {
      const m = meta[s.index];
      if (!m) continue;
      const analysis = m.token ? await readPreview(m.token, userId, s.hash) : null;
      let alt = s.alt;
      if (m.alt) {
        const problem = altTextProblem(m.alt);
        if (problem) notes.push(`Photo ${s.index + 1}: alt text not saved. ${problem}`);
        else alt = m.alt;
      }
      // The AI's alt text is used only when the lister gave none (and never with contact details or links in it).
      const aiAlt = analysis ? (altTextProblem(analysis.alt) ? roomAlt(analysis) : analysis.alt) : null;
      if (!m.alt && aiAlt) alt = aiAlt;
      if (analysis) {
        await q(`UPDATE listing_photos SET alt = $2, ai_room = $3, ai_alt = $4, ai_quality = $5, ai_features = $6, ai_flags = $7, ai_checked_at = now() WHERE id = $1`,
          [s.id, alt, analysis.room, aiAlt, JSON.stringify(analysis.quality), analysis.features, analysis.flags]);
        prefilled++;
      } else if (alt !== s.alt) await q('UPDATE listing_photos SET alt = $2 WHERE id = $1', [s.id, alt]);
      s.alt = alt;
    }

    if (stored.length) {
      await q('UPDATE listings SET updated_at = now() WHERE id = $1', [row.id]);
      await emit('photosUploaded', { listingId: row.id, ref: row.ref, photoIds: stored.map((a) => a.id), userId });
    }
    await audit(req, 'listing.photos_added', `listing:${ref}`, { added: stored.length, rejected: rejected.length, prefilled, ...(stopped ? { stopped: stopped.code } : {}) });
    if (failure) throw failure;
    const added = stored.map(({ id, url, alt, index: i }) => ({ id, url, alt, index: i }));
    const error = stopped ?? (stored.length ? null : { code: 'no_photos', message: rejected[0] ?? 'No photos were uploaded.' });
    return reply.code(stored.length ? 201 : stopped?.code === 'too_large' || stopped?.code === 'too_many' ? 413 : 400).send({ added, rejected, notes, ...(error ? { error } : {}) });
  });

  app.patch('/api/listings/:ref/photos/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const row = await editable(req, ref);
    // Alt text is public (and read out by screen readers), so it can't carry contact details, links or payment details.
    const b = parse(z.object({ alt: z.string().trim().max(160).superRefine((v, ctx) => { const p = altTextProblem(v); if (p) ctx.addIssue({ code: 'custom', message: p }); }).optional() }), req.body);
    const r = await one<{ id: string }>('UPDATE listing_photos SET alt = $3 WHERE id = $1 AND listing_id = $2 RETURNING id', [id, row.id, b.alt || null]);
    if (!r) throw notFound('That photo');
    if (PUBLIC_STATUSES.includes(row.status)) await emit('listingUpdated', { listingId: row.id, ref: row.ref, fields: ['photo_alt'], userId: req.user!.id });
    return { ok: true };
  });

  app.put('/api/listings/:ref/photos/order', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(100) }), req.body);
    await tx(async (c) => { for (const [i, id] of ids.entries()) await q('UPDATE listing_photos SET position = $3 WHERE id = $1 AND listing_id = $2', [id, row.id, i], c); });
    if (PUBLIC_STATUSES.includes(row.status)) await emit('listingUpdated', { listingId: row.id, ref: row.ref, fields: ['photos'], userId: req.user!.id });
    return { ok: true };
  });

  app.delete('/api/listings/:ref/photos/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const row = await editable(req, ref);
    // A submitted listing needs at least one photo (the same rule as submitting it).
    if (SUBMITTED.includes(row.status) && req.user!.role !== 'admin') {
      const n = (await one<{ n: number }>('SELECT count(*)::int n FROM listing_photos WHERE listing_id = $1', [row.id]))!.n;
      const mine = await one('SELECT 1 FROM listing_photos WHERE id = $1 AND listing_id = $2', [id, row.id]);
      if (mine && n <= 1) throw checksFailed([{ id: 'photo-min', message: 'Your listing needs at least one photo. Add another photo before removing this one.' }], 'This is the only photo on your listing.');
    }
    const p = await one<{ storage_key: string }>('DELETE FROM listing_photos WHERE id = $1 AND listing_id = $2 RETURNING storage_key', [id, row.id]);
    if (!p) throw notFound('That photo');
    await deleteFile(p.storage_key);
    if (PUBLIC_STATUSES.includes(row.status)) await emit('listingUpdated', { listingId: row.id, ref: row.ref, fields: ['photos'], userId: req.user!.id });
    return { ok: true };
  });

  /* ---------- stats for the lister ---------- */
  app.get('/api/me/listings/:ref/stats', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const days = await q<{ day: string; views: number; visitors: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(e.id)::int AS views, count(DISTINCT e.session_id)::int AS visitors
         FROM generate_series(current_date - 29, current_date, interval '1 day') d
         LEFT JOIN engagement_events e ON e.listing_id = $1 AND e.name = 'listing_view' AND e.occurred_at::date = d::date
        GROUP BY d ORDER BY d`, [row.id]);
    const totals = await q<{ name: string; n: number }>(`SELECT name, count(*)::int n FROM engagement_events WHERE listing_id = $1 AND occurred_at > now() - interval '30 days' GROUP BY name`, [row.id]);
    const saves = (await one<{ n: number }>('SELECT count(*)::int n FROM saved_listings WHERE listing_key = $1', [row.ref]))!.n;
    // Enquiries held back as spam or scams are counted separately, as in the inbox.
    const enq = (await one<{ n: number; held: number }>('SELECT count(*) FILTER (WHERE NOT filtered)::int n, count(*) FILTER (WHERE filtered)::int held FROM enquiries WHERE listing_id = $1', [row.id]))!;
    return { days, totals: Object.fromEntries(totals.map((t) => [t.name, t.n])), saves, enquiries: enq.n, filteredEnquiries: enq.held, note: 'Counts come only from visitors who allowed analytics; no personal data is stored.' };
  });
}
