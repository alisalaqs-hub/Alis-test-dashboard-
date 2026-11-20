/**
 * Results for an agency: what each of its listings has brought in over a period: views, calls, saves,
 * enquiries and viewing requests. Views and calls come from listing_views (services/views.ts): every
 * visit to the listing page and every tap on the agency's phone number is counted, for everyone and
 * without recording who, so the figures no longer depend on who allowed analytics. There is no
 * "visitors" figure any more: counting people apart would mean keeping something that identifies them.
 * Enquiries held back as spam or scams are not counted. Also available as a spreadsheet (CSV).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db';
import { forbidden, notFound, requireUser } from '../services/http';
import { limit } from '../services/ratelimit';

export interface OrgReportRow {
  ref: string; title: string | null; town: string; postcode: string; channel: 'sale' | 'rent'; status: string; price: number;
  publishedAt: string | null; daysOnMarket: number | null;
  views: number; calls: number; saves: number; enquiries: number; viewings: number;
}

/**
 * Lets the request through only for someone who runs this organisation (its owners and admins) or a site
 * admin. Anyone else is told the organisation can't be found, so its id reveals nothing; a member without
 * that role is refused. Shared by everything an agency sees about itself (results, valuation requests).
 */
export async function member(req: FastifyRequest, orgId: string) {
  const u = requireUser(req);
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw notFound('That organisation');
  if (u.role === 'admin') return;
  const m = await one<{ role: string }>('SELECT role FROM memberships WHERE organisation_id = $1 AND user_id = $2', [orgId, u.id]);
  if (!m) throw notFound('That organisation');
  if (!['owner', 'admin'].includes(m.role)) throw forbidden();
}

const csvCell = (v: string | number | null) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a title must never run as a spreadsheet formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function orgReportRoutes(app: FastifyInstance) {
  app.get('/api/orgs/:id/report', { preHandler: limit('orgs.report', 30, 60) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { days?: string; format?: string };
    await member(req, id);
    const days = Math.min(90, Math.max(7, Math.round(Number(query.days)) || 30));
    const rows = await q<OrgReportRow>(
      `SELECT l.ref, l.title, l.town, l.postcode, l.channel, l.status, l.price::float8 AS price,
              l.published_at AS "publishedAt",
              CASE WHEN l.published_at IS NULL THEN NULL ELSE greatest(0, (current_date - l.published_at::date))::int END AS "daysOnMarket",
              coalesce(v.views, 0)::int AS views, coalesce(v.calls, 0)::int AS calls, coalesce(s.saves, 0)::int AS saves,
              coalesce(e.enquiries, 0)::int AS enquiries, coalesce(e.viewings, 0)::int AS viewings
         FROM listings l
         LEFT JOIN LATERAL (SELECT sum(views) AS views, sum(calls) AS calls FROM listing_views
                             WHERE listing_id = l.id AND day > current_date - $2::int) v ON true
         LEFT JOIN LATERAL (SELECT count(*) AS saves FROM saved_listings WHERE listing_key = l.ref) s ON true
         LEFT JOIN LATERAL (SELECT count(*) AS enquiries, count(*) FILTER (WHERE kind = 'viewing') AS viewings FROM enquiries
                             WHERE listing_id = l.id AND NOT filtered AND created_at > now() - make_interval(days => $2)) e ON true
        WHERE l.organisation_id = $1 AND l.status IN ('live', 'under_offer', 'sold', 'let')
        ORDER BY enquiries DESC, views DESC, l.published_at DESC NULLS LAST
        LIMIT 5000`, [id, days]);
    const sum = (k: 'views' | 'calls' | 'saves' | 'enquiries' | 'viewings') => rows.reduce((n, r) => n + r[k], 0);
    const totals = { listings: rows.length, views: sum('views'), calls: sum('calls'), saves: sum('saves'), enquiries: sum('enquiries'), viewings: sum('viewings') };

    if (query.format === 'csv') {
      const head = ['Reference', 'Title', 'Town', 'Postcode', 'For', 'Status', 'Price', 'Days on the market', `Views (${days} days)`, `Calls (${days} days)`, 'Saves', `Enquiries (${days} days)`, `Viewing requests (${days} days)`];
      const lines = rows.map((r) => [r.ref, r.title, r.town, r.postcode, r.channel === 'rent' ? 'To rent' : 'For sale', r.status.replace('_', ' '), r.price, r.daysOnMarket, r.views, r.calls, r.saves, r.enquiries, r.viewings].map(csvCell).join(','));
      return reply
        .header('Content-Disposition', `attachment; filename="streetkey-results-${new Date().toISOString().slice(0, 10)}.csv"`)
        .header('Cache-Control', 'no-store')
        .type('text/csv; charset=utf-8')
        .send(`﻿${[head.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
    }
    return { days, totals, items: rows, note: 'Views count every visit to a listing, once per visitor in half an hour, without recording who viewed; your own team’s visits are left out. Calls are taps on your phone number on a listing. Enquiries held back as spam are left out.' };
  });
}
