import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ListingStatus } from '../../../src/lib/apiTypes';
import { listingRef } from '../auth/crypto';
import { config } from '../config';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { audit, forbidden, HttpError, notFound, parse, requireUser } from '../services/http';
import { cleanImage, sniffImage } from '../services/images';
import { checksFor, columnsFrom, geocode, LISTING_SELECT, ListingBody, photosFor, PUBLIC_STATUSES, toDTO, type ListingRow } from '../services/listings';
import { deleteFile, newKey, putFile } from '../services/storage';

export async function orgIdsFor(userId?: string | null) {
  if (!userId) return [];
  return (await q<{ organisation_id: string }>('SELECT organisation_id FROM memberships WHERE user_id = $1', [userId])).map((r) => r.organisation_id);
}

export async function viewerOf(req: FastifyRequest) {
  return { userId: req.user?.id ?? null, orgIds: await orgIdsFor(req.user?.id), admin: req.user?.role === 'admin' };
}

async function loadByRef(ref: string) {
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
    const rows = await q<ListingRow & { enquiries: number; new_enquiries: number; views_30d: number; saves: number }>(
      `SELECT l2.*, coalesce(e.n, 0)::int AS enquiries, coalesce(e.new_n, 0)::int AS new_enquiries, coalesce(v.n, 0)::int AS views_30d, coalesce(s.n, 0)::int AS saves
         FROM (${LISTING_SELECT} WHERE l.owner_user_id = $1 OR l.organisation_id = ANY($2)) l2
         LEFT JOIN (SELECT listing_id, count(*) n, count(*) FILTER (WHERE status = 'new') new_n FROM enquiries GROUP BY listing_id) e ON e.listing_id = l2.id
         LEFT JOIN (SELECT listing_id, count(*) n FROM engagement_events WHERE name = 'listing_view' AND occurred_at > now() - interval '30 days' GROUP BY listing_id) v ON v.listing_id = l2.id
         LEFT JOIN (SELECT listing_key, count(*) n FROM saved_listings GROUP BY listing_key) s ON s.listing_key = l2.ref
        ORDER BY l2.updated_at DESC`, [u.id, orgs]);
    const photos = await photosFor(rows.map((r) => r.id));
    const viewer = { userId: u.id, orgIds: orgs, admin: u.role === 'admin' };
    return {
      items: rows.map((r) => ({
        ...toDTO(r, photos.get(r.id) ?? [], viewer),
        stats: { enquiries: r.enquiries, newEnquiries: r.new_enquiries, views30d: r.views_30d, saves: r.saves },
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

  app.patch('/api/listings/:ref', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    if (['sold', 'let', 'withdrawn'].includes(row.status) && req.user!.role !== 'admin') throw new HttpError(409, 'Re-list this property before editing it.', 'not_editable');
    const b = parse(ListingBody.partial(), req.body);
    const cols: Record<string, unknown> = columnsFrom(b);
    if (b.postcode) { const g = await geocode(b.postcode); Object.assign(cols, { postcode: g.postcode, district: g.district, lat: g.lat, lng: g.lng }); }
    // A rejected listing goes back to draft once it's edited.
    if (row.status === 'rejected') cols.status = 'draft';
    const keys = Object.keys(cols);
    if (keys.length) {
      await q(`UPDATE listings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [row.id, ...Object.values(cols)]);
      await audit(req, 'listing.updated', `listing:${ref}`, { fields: keys, ...(b.price != null && b.price !== row.price ? { priceFrom: row.price, priceTo: b.price } : {}) });
    }
    const fresh = (await loadByRef(ref))!;
    const photos = (await photosFor([fresh.id])).get(fresh.id) ?? [];
    return { listing: toDTO(fresh, photos, await viewerOf(req)), checks: checksFor(fresh, photos.length) };
  });

  /** Send for review (private sellers/landlords) or publish straight away (verified agencies). */
  app.post('/api/listings/:ref/submit', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    if (!['draft', 'rejected', 'withdrawn'].includes(row.status)) throw new HttpError(409, 'This listing has already been submitted.', 'bad_status');
    const photos = (await photosFor([row.id])).get(row.id) ?? [];
    const blocking = checksFor(row, photos.length).filter((c) => !c.ok && c.severity === 'block');
    if (blocking.length) throw new HttpError(422, 'A few things are needed before this listing can go live.', 'checks_failed', Object.fromEntries(blocking.map((c) => [c.id, c.message])));
    const trustedAgency = row.organisation_id && row.organisation_verified;
    const goLive = !config.moderateOwnerListings || trustedAgency;
    await q(`UPDATE listings SET status = $2, rejection_reason = NULL, published_at = CASE WHEN $2 = 'live' THEN now() ELSE published_at END, updated_at = now() WHERE id = $1`, [row.id, goLive ? 'live' : 'pending']);
    await audit(req, goLive ? 'listing.published' : 'listing.submitted', `listing:${ref}`);
    if (!goLive && config.adminEmail) {
      await mails.enquiryToLister(config.adminEmail, row.title ?? row.address_line, ref, 'Streetkey', 'question', 'A new listing is waiting for review in the admin area.').catch(() => {});
    }
    return { status: goLive ? 'live' : 'pending' };
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
  app.post('/api/listings/:ref/photos', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    if (!req.isMultipart()) throw new HttpError(400, 'Upload photos as a form (multipart).', 'not_multipart');
    const existing = (await one<{ n: number; max: number | null }>('SELECT count(*)::int n, max(position) max FROM listing_photos WHERE listing_id = $1', [row.id]))!;
    let position = (existing.max ?? -1) + 1, count = existing.n;
    const added: { id: string; url: string; alt: string | null }[] = [];
    const rejected: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      const type = sniffImage(buf);
      if (!type) { rejected.push(`${part.filename}: not a JPEG, PNG or WebP image`); continue; }
      if (count >= config.storage.maxPhotosPerListing) { rejected.push(`${part.filename}: limit of ${config.storage.maxPhotosPerListing} photos reached`); continue; }
      const clean = cleanImage(buf, type);
      const stored = await putFile(newKey(`listings/${row.ref}`, type), clean, type);
      const alt = part.filename ? part.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 120) : null;
      const p = await one<{ id: string }>('INSERT INTO listing_photos (listing_id, storage_key, url, content_type, bytes, position, alt) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [row.id, stored.key, stored.url, type, clean.length, position++, alt]);
      added.push({ id: p!.id, url: stored.url, alt }); count++;
    }
    await q('UPDATE listings SET updated_at = now() WHERE id = $1', [row.id]);
    await audit(req, 'listing.photos_added', `listing:${ref}`, { added: added.length, rejected: rejected.length });
    return reply.code(added.length ? 201 : 400).send({ added, rejected, ...(added.length ? {} : { error: { code: 'no_photos', message: rejected[0] ?? 'No photos were uploaded.' } }) });
  });

  app.patch('/api/listings/:ref/photos/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const row = await editable(req, ref);
    const b = parse(z.object({ alt: z.string().trim().max(160).optional() }), req.body);
    const r = await one('UPDATE listing_photos SET alt = $3 WHERE id = $1 AND listing_id = $2 RETURNING id', [id, row.id, b.alt ?? null]);
    if (!r) throw notFound('That photo');
    return { ok: true };
  });

  app.put('/api/listings/:ref/photos/order', async (req) => {
    const { ref } = req.params as { ref: string };
    const row = await editable(req, ref);
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(100) }), req.body);
    await tx(async (c) => { for (const [i, id] of ids.entries()) await q('UPDATE listing_photos SET position = $3 WHERE id = $1 AND listing_id = $2', [id, row.id, i], c); });
    return { ok: true };
  });

  app.delete('/api/listings/:ref/photos/:id', async (req) => {
    const { ref, id } = req.params as { ref: string; id: string };
    const row = await editable(req, ref);
    const p = await one<{ storage_key: string }>('DELETE FROM listing_photos WHERE id = $1 AND listing_id = $2 RETURNING storage_key', [id, row.id]);
    if (!p) throw notFound('That photo');
    await deleteFile(p.storage_key);
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
    const enquiries = (await one<{ n: number }>('SELECT count(*)::int n FROM enquiries WHERE listing_id = $1', [row.id]))!.n;
    return { days, totals: Object.fromEntries(totals.map((t) => [t.name, t.n])), saves, enquiries, note: 'Counts come only from visitors who allowed analytics; no personal data is stored.' };
  });
}
