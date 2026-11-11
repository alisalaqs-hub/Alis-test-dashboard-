/**
 * Results for an agency: what each of its listings has brought in over a period. Views and visitors
 * come only from people who allowed analytics; saves, enquiries and viewing requests are exact.
 * Enquiries held back as spam or scams are not counted. Also available as a spreadsheet (CSV).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, q } from '../db';
import { forbidden, notFound, requireUser } from '../services/http';
import { limit } from '../services/ratelimit';

export interface OrgReportRow {
  ref: string; title: string | null; town: string; postcode: string; channel: 'sale' | 'rent'; status: string; price: number;
  publishedAt: string | null; daysOnMarket: number | null;
  views: number; visitors: number; saves: number; enquiries: number; viewings: number;
}

async function member(req: FastifyRequest, orgId: string) {
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
              coalesce(v.views, 0)::int AS views, coalesce(v.visitors, 0)::int AS visitors, coalesce(s.saves, 0)::int AS saves,
              coalesce(e.enquiries, 0)::int AS enquiries, coalesce(e.viewings, 0)::int AS viewings
         FROM listings l
         LEFT JOIN LATERAL (SELECT count(*) AS views, count(DISTINCT session_id) AS visitors FROM engagement_events
                             WHERE listing_id = l.id AND name = 'listing_view' AND occurred_at > now() - make_interval(days => $2)) v ON true
         LEFT JOIN LATERAL (SELECT count(*) AS saves FROM saved_listings WHERE listing_key = l.ref) s ON true
         LEFT JOIN LATERAL (SELECT count(*) AS enquiries, count(*) FILTER (WHERE kind = 'viewing') AS viewings FROM enquiries
                             WHERE listing_id = l.id AND NOT filtered AND created_at > now() - make_interval(days => $2)) e ON true
        WHERE l.organisation_id = $1 AND l.status IN ('live', 'under_offer', 'sold', 'let')
        ORDER BY enquiries DESC, views DESC, l.published_at DESC NULLS LAST
        LIMIT 5000`, [id, days]);
    const sum = (k: 'views' | 'visitors' | 'saves' | 'enquiries' | 'viewings') => rows.reduce((n, r) => n + r[k], 0);
    const totals = { listings: rows.length, views: sum('views'), visitors: sum('visitors'), saves: sum('saves'), enquiries: sum('enquiries'), viewings: sum('viewings') };

    if (query.format === 'csv') {
      const head = ['Reference', 'Title', 'Town', 'Postcode', 'For', 'Status', 'Price', 'Days on the market', `Views (${days} days)`, `Visitors (${days} days)`, 'Saves', `Enquiries (${days} days)`, `Viewing requests (${days} days)`];
      const lines = rows.map((r) => [r.ref, r.title, r.town, r.postcode, r.channel === 'rent' ? 'To rent' : 'For sale', r.status.replace('_', ' '), r.price, r.daysOnMarket, r.views, r.visitors, r.saves, r.enquiries, r.viewings].map(csvCell).join(','));
      return reply
        .header('Content-Disposition', `attachment; filename="streetkey-results-${new Date().toISOString().slice(0, 10)}.csv"`)
        .header('Cache-Control', 'no-store')
        .type('text/csv; charset=utf-8')
        .send(`﻿${[head.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
    }
    return { days, totals, items: rows, note: 'Views and visitors count only people who allowed analytics. Saves, enquiries and viewing requests are exact; enquiries held back as spam are left out.' };
  });
}
