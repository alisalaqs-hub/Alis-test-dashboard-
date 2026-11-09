/**
 * Shared pieces for the AI inbox: who counts as the lister of an enquiry (the same rule as the
 * core enquiries routes: the listing's owner or a member of its agency), who gets emailed, and
 * how a conversation names the home (never with a private seller's house number).
 */
import type { FastifyRequest } from 'fastify';
import { mentionsProtected } from '../../../../src/lib/ai/search';
import { one, q } from '../../db';
import { forbidden, notFound, requireUser } from '../../services/http';
import { streetOnly } from '../../services/listings';
import { hit } from '../../services/ratelimit';
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

/* ───────── per-sender AI allowance ───────── */
/**
 * How many AI actions one enquirer can set off in a day, across every listing: model screening of
 * their messages and background triage of their conversations. Past it, their messages are
 * screened by the rules alone and triage waits until the lister opens the conversation.
 */
export const SENDER_AI_PER_DAY = 20;
/** Counts one AI action for this sender ('u:<id>' or anonId(ip)) and says whether it's within the daily allowance. */
export async function senderAiAllowed(senderKey: string | null | undefined): Promise<boolean> {
  if (!senderKey) return true;
  try { return (await hit(`ai.inbox.sender:${senderKey}`, SENDER_AI_PER_DAY, 86_400)).ok; } catch { return false; }
}

/* ───────── cleaning model-written text ───────── */
/** Web addresses and bare domains ("secure-deposit-uk.com/pay"): never repeated in AI summaries or notes. */
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|xyz|top|site|online|club|shop|io|co|uk|ru|cn|tk|ml|ga|cf|gq|link|click|app|me)(?:\/[^\s<>"']*)?\b/gi;
export const stripLinks = (s: string) => s.replace(LINK_RE, '[link]');
/** A claim that Streetkey checked, verified or approved someone or something: Streetkey makes no such checks on enquirers. */
const STREETKEY_CLAIM_RE = /\b(?:verified|checked|confirmed|approved|vetted|validated|guaranteed)\b[^.!?\n]{0,40}\bstreetkey\b|\bstreetkey\b[^.!?\n]{0,40}\b(?:verified|checked|confirmed|approved|vetted|validated|guaranteed|has verified|has checked)\b/i;
export const claimsStreetkeyCheck = (s: string) => STREETKEY_CLAIM_RE.test(s);
/**
 * Words about who someone is (protected characteristics, family or marital status, pregnancy,
 * benefits, age, immigration status). The triage never records these, so a summary sentence that
 * mentions them is dropped.
 */
const PERSONAL_RE = /\b(?:child(?:ren)?|kids?|bab(?:y|ies)|pregnan\w*|expecting a baby|married|marriage|divorc\w*|widow\w*|single (?:mum|mom|dad|parent|man|woman)|benefits?|universal credit|dss|disab\w*|wheelchair|pensioners?|retired|elderly|\d{1,3}[- ]years?[- ]old|aged \d{1,3}|religio\w*|church|mosque|synagogue|temple|gurdwara|nationality|citizenship|visa|asylum)\b/i;
export const aboutThePerson = (s: string) => mentionsProtected(s) || PERSONAL_RE.test(s);
/** Splits into sentences without breaking "£1.2m", "e.g." or web addresses. */
export const sentencesOf = (s: string) => s.match(/(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*[ \t]*|[.!?]+[ \t]*|\n+/g) ?? [s];
/** Drops the sentences for which drop() is true. */
export const dropSentences = (s: string, drop: (sentence: string) => boolean) => sentencesOf(s).filter((x) => !x.trim() || !drop(x)).join('').replace(/[ \t]{2,}/g, ' ').trim();
