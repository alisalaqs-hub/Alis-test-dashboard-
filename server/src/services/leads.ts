/**
 * Leads: who is emailed when someone enquires about a listing or asks an agency for a valuation, and the
 * enquiry emails themselves.
 *
 * An agency can set a leads email on its profile (organisations.leads_email). When it has, its enquiries and
 * valuation requests go to that one address INSTEAD OF to individual members: one mailbox, one copy of each
 * lead. Without one they go, as before, to the person who created the listing and the agency's owners and
 * admins. A private seller or landlord gets their own. Either way the conversation is in the inbox of
 * everyone who could see it before.
 *
 * Nothing here decides whether a message may be passed on: the callers only email what the spam and scam
 * screen let through, or what the lister released with "Not spam" (routes/enquiries.ts, routes/ai-inbox.ts).
 */
import { one, q } from '../db';
import { mails, type EnquiryLead } from './email';
import { streetOnly } from './listings';

type Lister = { owner_user_id: string | null; organisation_id: string | null };

/** Where a listing's enquiries are emailed. */
export async function leadRecipients(l: Lister): Promise<string[]> {
  if (l.organisation_id) {
    const o = await one<{ leads_email: string | null }>('SELECT leads_email FROM organisations WHERE id = $1', [l.organisation_id]);
    if (o?.leads_email) return [o.leads_email];
  }
  return (await q<{ email: string }>(
    `SELECT DISTINCT u.email FROM users u WHERE u.deleted_at IS NULL AND (u.id = $1 OR u.id IN (SELECT user_id FROM memberships WHERE organisation_id = $2 AND role IN ('owner', 'admin')))`,
    [l.owner_user_id, l.organisation_id])).map((r) => r.email);
}
/** Where an agency's valuation requests are emailed: its leads email, or else its owners and admins. */
export const agencyRecipients = (organisationId: string) => leadRecipients({ owner_user_id: null, organisation_id: organisationId });

/** How a conversation refers to the home: never with the house number (the enquirer may not have it). */
export const titleOf = (l: { title: string | null; address_line: string; town: string }) => l.title || `${streetOnly(l.address_line)}, ${l.town}`;

interface LeadRow extends Lister {
  id: string; name: string; email: string; phone: string | null; kind: string; preferred_slot: string | null;
  ref: string; title: string | null; address_line: string; town: string; postcode: string; channel: 'sale' | 'rent'; source_kind: string;
  organisation_name: string | null;
}
const loadLead = (enquiryId: string) => one<LeadRow>(
  `SELECT e.id, e.name, e.email, e.phone, e.kind, e.preferred_slot,
          l.ref, l.title, l.address_line, l.town, l.postcode, l.channel, l.source_kind, l.owner_user_id, l.organisation_id, o.name AS organisation_name
     FROM enquiries e JOIN listings l ON l.id = e.listing_id LEFT JOIN organisations o ON o.id = l.organisation_id WHERE e.id = $1`, [enquiryId]);

const leadOf = (e: LeadRow, message: string): EnquiryLead => ({
  id: e.id, kind: e.kind, name: e.name, email: e.email, phone: e.phone, preferredSlot: e.preferred_slot, message,
  // The lister is told the full address (it is theirs); the subject and the enquirer's copy use the public title.
  listing: { ref: e.ref, title: titleOf(e), address: `${e.address_line}, ${e.town} ${e.postcode}` },
});

/**
 * Emails an enquirer's message to whoever receives the listing's leads: the first message of an enquiry with
 * everything needed to answer it, or (followUp) a later message in a conversation they already have. Reply-To
 * is the enquirer. Returns how many addresses it went to.
 */
export async function emailLister(enquiryId: string, message: string, o: { followUp?: boolean } = {}): Promise<number> {
  const e = await loadLead(enquiryId);
  if (!e) return 0;
  const to = await leadRecipients(e);
  const lead = leadOf(e, message);
  for (const addr of to) await (o.followUp ? mails.replyToLister(addr, lead) : mails.enquiryToLister(addr, lead));
  return to.length;
}

/**
 * The enquirer's confirmation: what they sent, to whom, and that the answer comes by email. It names an agency,
 * but never a private seller or landlord, and uses the home's public title (no house number).
 */
export async function confirmToEnquirer(enquiryId: string, message: string): Promise<void> {
  const e = await loadLead(enquiryId);
  if (!e) return;
  const lister = e.organisation_name ?? (e.channel === 'rent' || e.source_kind === 'landlord' ? 'the landlord' : 'the seller');
  await mails.enquiryConfirmation(e.email, { kind: e.kind, name: e.name, preferredSlot: e.preferred_slot, message, listing: { ref: e.ref, title: titleOf(e) }, lister });
}
