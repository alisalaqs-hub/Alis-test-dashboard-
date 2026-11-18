/**
 * Agent pages and valuation requests.
 *
 * Every estate or letting agency (an organisation) has a public page: who they are, how much they have
 * on the market and their live listings. From that page anyone can ask the agent to value a home they
 * want to sell or let ("Book a valuation"). The request is stored for the agency, emailed to the people
 * who run it (its owners and admins) and listed in their account, where they mark it contacted or closed.
 *
 * A request holds how to reach the person, where the home is and whether they want to sell or let it.
 * Nothing about their money is asked for or kept: no funds, mortgage or income. That is a product rule,
 * so never add such a field here.
 *
 * Limits on sending a request: 5 a minute per network; 30 a day per account (per network for visitors
 * who aren't signed in) and 300 a day per network; 3 a day per email address per agent.
 * Requests are deleted after 12 months by the daily clean-up (jobs/run.ts), and with the account of the
 * person who sent them (routes/me.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentProfileDTO, ValuationRequestDTO } from '../../../src/lib/apiTypes';
import { normalisePostcode } from '../../../src/engine/listings';
import { one, q } from '../db';
import { mails } from '../services/email';
import { audit, HttpError, notFound, parse, requireUser } from '../services/http';
import { historyFor } from '../services/history';
import { LISTING_SELECT, photosFor, PROPERTY_TYPES, PUBLIC_STATUSES, toDTO, type ListingRow } from '../services/listings';
import { enforce, limit } from '../services/ratelimit';
import { UUID_RE } from '../ai/inbox/shared';
import { viewerOf } from './listings';
import { member } from './org-report';

/** Listings shown on an agent's page. */
const MAX_LISTINGS = 60;
/** Requests listed for an agency. */
const MAX_REQUESTS = 200;
/** The whole of what was typed must be a UK postcode (the shared POSTCODE_RE finds one anywhere in a longer text). */
const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const POSTCODE_HELP = 'Enter a full UK postcode, for example E17 4QH.';
/** One line of text: line breaks and runs of spaces become single spaces. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const ValuationBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(80, 'Keep your name under 80 characters.').transform(oneLine),
  email: z.email('Enter a valid email address.').max(254),
  phone: z.string().trim().max(30, 'That phone number is too long.').regex(/^[+\d\s()-]*$/, 'Use digits, spaces and + only.').optional().nullable(),
  postcode: z.string().trim().regex(FULL_POSTCODE, POSTCODE_HELP).max(12, POSTCODE_HELP).transform(normalisePostcode),
  addressLine: z.string().trim().max(160, 'Keep the address under 160 characters.').transform(oneLine).optional().nullable(),
  intent: z.enum(['sell', 'let'], 'Choose whether you want to sell or let.'),
  propertyType: z.enum(PROPERTY_TYPES).optional().nullable(),
  beds: z.number().int().min(0).max(30).optional().nullable(),
  message: z.string().trim().max(1000, 'Keep your message under 1,000 characters.').optional().nullable(),
  // "website" is the honeypot and is dealt with before this is read. There is deliberately no field for money, a mortgage or income.
});

/** The honeypot: a box people never see. Anything in it means a script filled in the form. */
const honeypotFilled = (body: unknown) => typeof (body as { website?: unknown } | null)?.website === 'string' && (body as { website: string }).website.trim() !== '';

const dailyCap = async (req: FastifyRequest) => {
  await enforce(req, 'valuation.create.d', 30, 86_400, 'user-or-ip', req.user
    ? 'You’ve sent a lot of valuation requests today. Please try again tomorrow.'
    : 'A lot of valuation requests have been sent from your network today. Sign in or create a free account to send yours, or try again tomorrow.');
  await enforce(req, 'valuation.create.net', 300, 86_400, 'ip', 'A lot of valuation requests have been sent from your network today. Please try again tomorrow.');
};

type RequestRow = {
  id: string; name: string; email: string; phone: string | null; postcode: string; address_line: string | null;
  intent: 'sell' | 'let'; property_type: string | null; beds: number | null; message: string | null;
  status: ValuationRequestDTO['status']; created_at: Date;
};
const REQUEST_COLS = 'id, name, email, phone, postcode, address_line, intent, property_type, beds, message, status, created_at';
const toRequest = (r: RequestRow): ValuationRequestDTO => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, postcode: r.postcode, addressLine: r.address_line,
  intent: r.intent, propertyType: r.property_type, beds: r.beds, message: r.message, status: r.status, createdAt: r.created_at.toISOString(),
});

/** The organisation in the address, once the caller is known to run it (see member in routes/org-report). */
async function ownOrg(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  requireUser(req);
  if (!UUID_RE.test(id)) throw notFound('That organisation');
  await member(req, id);
  return id;
}

export async function agentRoutes(app: FastifyInstance) {
  /* ---------- the public page ---------- */
  app.get('/api/agents/:id', { preHandler: limit('agents.get', 120, 60) }, async (req): Promise<AgentProfileDTO> => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('That agent');
    // Sold or let in the last 12 months: listings that still stand as sold or let, by the day their history says it happened.
    const o = await one<{ id: string; name: string; kind: AgentProfileDTO['agent']['kind']; verified: boolean; redress_scheme: string | null; created_at: Date; sale: number; rent: number; sold_or_let: number }>(
      `SELECT o.id, o.name, o.kind, o.verified, o.redress_scheme, o.created_at,
              (SELECT count(*) FROM listings l WHERE l.organisation_id = o.id AND l.status = ANY($2) AND l.channel = 'sale')::int AS sale,
              (SELECT count(*) FROM listings l WHERE l.organisation_id = o.id AND l.status = ANY($2) AND l.channel = 'rent')::int AS rent,
              (SELECT count(*) FROM listings l WHERE l.organisation_id = o.id AND l.status IN ('sold', 'let')
                  AND EXISTS (SELECT 1 FROM listing_events e WHERE e.listing_id = l.id AND e.kind IN ('sold', 'let') AND e.at > now() - interval '12 months'))::int AS sold_or_let
         FROM organisations o WHERE o.id = $1`, [id, PUBLIC_STATUSES]);
    if (!o) throw notFound('That agent');
    const rows = await q<ListingRow>(
      `${LISTING_SELECT} WHERE l.organisation_id = $1 AND l.status = ANY($2) ORDER BY coalesce(l.published_at, l.created_at) DESC, l.created_at DESC LIMIT $3`, [id, PUBLIC_STATUSES, MAX_LISTINGS]);
    const ids = rows.map((r) => r.id);
    const [photos, history, viewer] = await Promise.all([photosFor(ids), historyFor(ids), viewerOf(req)]);
    return {
      agent: {
        id: o.id, name: o.name, kind: o.kind, verified: o.verified, redressScheme: o.redress_scheme, since: o.created_at.toISOString().slice(0, 10),
        counts: { sale: o.sale, rent: o.rent, soldOrLet12m: o.sold_or_let },
      },
      // The same shape as the public search (GET /api/listings).
      listings: rows.map((r) => toDTO(r, photos.get(r.id) ?? [], viewer, history.get(r.id))),
    };
  });

  /* ---------- "Book a valuation" ---------- */
  app.post('/api/agents/:id/valuation-requests', { preHandler: [limit('valuation.create', 5, 60), dailyCap] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (honeypotFilled(req.body)) return reply.code(201).send({ ok: true }); // a script: answer as if it worked, keep nothing
    const org = UUID_RE.test(id) ? await one<{ id: string; name: string }>('SELECT id, name FROM organisations WHERE id = $1', [id]) : null;
    if (!org) throw notFound('That agent');
    const b = parse(ValuationBody, req.body);
    const recent = await one<{ n: number }>(`SELECT count(*)::int n FROM valuation_requests WHERE organisation_id = $1 AND email = $2 AND created_at > now() - interval '1 day'`, [org.id, b.email]);
    if (recent!.n >= 3) throw new HttpError(429, 'You’ve already asked this agent for a valuation. They’ll contact you by email or phone.', 'rate_limited');

    const details = { name: b.name, email: b.email, phone: b.phone || null, postcode: b.postcode, addressLine: b.addressLine || null, intent: b.intent, propertyType: b.propertyType ?? null, beds: b.beds ?? null, message: b.message || null };
    const row = await one<{ id: string }>(
      `INSERT INTO valuation_requests (organisation_id, name, email, phone, postcode, address_line, intent, property_type, beds, message, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [org.id, details.name, details.email, details.phone, details.postcode, details.addressLine, details.intent, details.propertyType, details.beds, details.message, req.user?.id ?? null]);
    // The request is stored: an email that fails must not turn it into an error (the person would send it twice). Logged without the details.
    try {
      const to = await q<{ email: string }>(
        `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organisation_id = $1 AND m.role IN ('owner', 'admin') AND u.deleted_at IS NULL`, [org.id]);
      for (const m of to) await mails.valuationRequest(m.email, org.name, details);
    } catch (e) { req.log.warn({ what: 'valuation_request', code: (e as { code?: string }).code ?? 'error' }, 'valuation request notification failed'); }
    await audit(req, 'valuation.requested', `org:${org.id}`, { request: row!.id, intent: b.intent });
    return reply.code(201).send({ ok: true });
  });

  /* ---------- the agency's own list ---------- */
  app.get('/api/orgs/:id/valuation-requests', { preHandler: limit('orgs.valuations', 60, 60) }, async (req) => {
    const id = await ownOrg(req);
    const rows = await q<RequestRow>(`SELECT ${REQUEST_COLS} FROM valuation_requests WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT $2`, [id, MAX_REQUESTS]);
    return { items: rows.map(toRequest) };
  });

  app.patch('/api/orgs/:id/valuation-requests/:rid', async (req) => {
    const id = await ownOrg(req);
    const { rid } = req.params as { rid: string };
    if (!UUID_RE.test(rid)) throw notFound('That valuation request');
    const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'closed']) }), req.body);
    const r = await one<RequestRow>(`UPDATE valuation_requests SET status = $3 WHERE id = $2 AND organisation_id = $1 RETURNING ${REQUEST_COLS}`, [id, rid, status]);
    if (!r) throw notFound('That valuation request');
    await audit(req, 'valuation.status', `org:${id}`, { request: rid, status });
    return { request: toRequest(r) };
  });
}
