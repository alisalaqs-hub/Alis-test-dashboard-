/**
 * Shared pieces for the AI inbox: who counts as the lister of an enquiry (the same rule as the
 * core enquiries routes: the listing's owner or a member of its agency), who gets emailed, and
 * how a conversation names the home (never with a private seller's house number).
 */
import type { FastifyRequest } from 'fastify';
import { one, q } from '../../db';
import { forbidden, notFound, requireUser } from '../../services/http';
import { streetOnly } from '../../services/listings';
import { orgIdsFor } from '../../routes/listings';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnquiryRow {
  id: string; listing_id: string; from_user_id: string | null; name: string; email: string; phone: string | null;
  kind: 'viewing' | 'question' | 'offer'; status: 'new' | 'replied' | 'closed'; preferred_slot: string | null;
  filtered: boolean; filter_reason: string | null; created_at: Date;
  ref: string; title: string | null; address_line: string; town: string; price: number; channel: 'sale' | 'rent';
  owner_user_id: string | null; organisation_id: string | null; source_kind: string;
}

export const loadEnquiry = (id: string) => one<EnquiryRow>(
  `SELECT e.id, e.listing_id, e.from_user_id, e.name, e.email, e.phone, e.kind, e.status, e.preferred_slot, e.filtered, e.filter_reason, e.created_at,
          l.ref, l.title, l.address_line, l.town, l.price, l.channel, l.owner_user_id, l.organisation_id, l.source_kind
     FROM enquiries e JOIN listings l ON l.id = e.listing_id WHERE e.id = $1`, [id]);

/**
 * The enquiry, if the signed-in person is its lister (listing owner or agency member).
 * Enquirers, admins who aren't the lister, and everyone else are refused.
 */
export async function listerAccess(req: FastifyRequest, id: string) {
  const u = requireUser(req);
  if (!UUID_RE.test(id)) throw notFound('That conversation');
  const e = await loadEnquiry(id);
  if (!e) throw notFound('That conversation');
  const orgs = await orgIdsFor(u.id);
  const lister = e.owner_user_id === u.id || (!!e.organisation_id && orgs.includes(e.organisation_id));
  if (!lister) throw forbidden();
  return { e, user: u };
}

/** Who receives enquiries for a listing: the lister, or the agency's owners and admins (as the core route does). */
export async function listerEmails(listing: { owner_user_id: string | null; organisation_id: string | null }) {
  return (await q<{ email: string }>(
    `SELECT DISTINCT u.email FROM users u WHERE u.deleted_at IS NULL AND (u.id = $1 OR u.id IN (SELECT user_id FROM memberships WHERE organisation_id = $2 AND role IN ('owner', 'admin')))`,
    [listing.owner_user_id, listing.organisation_id])).map((r) => r.email);
}

/** How a conversation refers to the home: never with the house number. */
export const titleOf = (e: { title: string | null; address_line: string; town: string }) => e.title || `${streetOnly(e.address_line)}, ${e.town}`;

/** Private sellers and landlords: their address stays private until they choose to share it. */
export const isPrivateSeller = (sourceKind: string) => sourceKind === 'owner' || sourceKind === 'landlord';

export const clip = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const normaliseText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Data minimisation: contact details in messages aren't needed to summarise or draft a reply. */
export const redactContacts = (s: string) => s
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  .replace(/(?<![\w£])(?:\+44\s?|0)(?:\d[\s-]?){8,9}\d(?!\d)/g, '[phone]');
