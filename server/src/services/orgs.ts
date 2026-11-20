/**
 * An organisation's profile (migration 018): what an agency says about itself on its public page
 * (/agent/<id>) and where its leads are emailed.
 *
 * Letting agents in England must show (or link to) their fees, their redress scheme and their client money
 * protection scheme wherever they advertise, portals included, so the profile has a place for each.
 * leads_email is the one private part: members see it, the public page never does.
 */
import { z } from 'zod';
import type { AgencyProfileDTO, OrgDTO } from '../../../src/lib/apiTypes';

export interface OrgProfileRow {
  phone: string | null; leads_email: string | null; website: string | null; about: string | null; address: string | null;
  client_money_scheme: string | null; redress_number: string | null; fees_url: string | null;
}
/** The profile columns that are public, for a SELECT (`o` is the organisations table). */
export const PUBLIC_PROFILE_COLS = 'o.phone, o.website, o.about, o.address, o.client_money_scheme, o.redress_number, o.fees_url';

/** The public part of a profile: everything except the leads email. */
export const publicProfile = (o: Omit<OrgProfileRow, 'leads_email'>): AgencyProfileDTO => ({
  phone: o.phone, website: o.website, about: o.about, address: o.address,
  clientMoneyScheme: o.client_money_scheme, redressNumber: o.redress_number, feesUrl: o.fees_url,
});

export type OrgRow = OrgProfileRow & { id: string; name: string; kind: OrgDTO['kind']; verified: boolean; redress_scheme: string | null; role: OrgDTO['role'] };
/** An organisation with the caller's role in it, for a SELECT joined to memberships as `m`. */
export const ORG_SELECT = `SELECT o.id, o.name, o.kind, o.verified, o.redress_scheme, o.leads_email, ${PUBLIC_PROFILE_COLS}, m.role
  FROM memberships m JOIN organisations o ON o.id = m.organisation_id`;
/** An organisation as its own members see it. */
export const toOrg = (o: OrgRow): OrgDTO => ({
  id: o.id, name: o.name, kind: o.kind, verified: o.verified, redressScheme: o.redress_scheme, role: o.role,
  ...publicProfile(o), leadsEmail: o.leads_email,
});

/* ---------- what an agency may save ---------- */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '').length;
const URL_HELP = 'Enter a full web address that starts with https://, for example https://www.example.co.uk.';

/**
 * A web address people are sent to from a public page: https only, an ordinary host name, no sign-in details
 * or port in it. Returns it as the browser would write it, or null if it isn't acceptable.
 */
export function httpsUrl(v: string): string | null {
  if (!/^https:\/\//i.test(v) || /[\s<>"'`\\]/.test(v)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i.test(u.hostname)) return null;
  return u.href;
}
const webAddress = z.string().trim().max(300, 'Keep the web address under 300 characters.')
  .refine((v) => v === '' || !!httpsUrl(v), URL_HELP).transform((v) => (v === '' ? '' : httpsUrl(v)!));

/**
 * Every box is optional: one that is left out stays as it is, and an empty one (or null) is cleared.
 * Deliberately not here: the agency's name and redress scheme, which an admin checks before verifying it.
 */
export const OrgProfileBody = z.object({
  phone: z.string().trim().max(30, 'That phone number is too long.').regex(/^[+\d\s()-]*$/, 'Use digits, spaces and + ( ) - only.')
    .refine((v) => v === '' || (digits(v) >= 7 && digits(v) <= 15), 'Enter a full phone number, for example 020 7946 0123.').nullable(),
  leadsEmail: z.string().trim().max(254, 'That email address is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.').nullable(),
  website: webAddress.nullable(),
  about: z.string().trim().max(600, 'Keep this under 600 characters.')
    .refine((v) => !/<\/?[a-z!][^>]*>/i.test(v), 'Use plain text, without HTML.')
    // Plain text: control characters out, and no more than one blank line in a row.
    .transform((v) => v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()).nullable(),
  address: z.string().trim().max(200, 'Keep the address under 200 characters.').transform(oneLine).nullable(),
  clientMoneyScheme: z.string().trim().max(120, 'Keep the scheme name under 120 characters.').transform(oneLine).nullable(),
  redressNumber: z.string().trim().max(40, 'Keep the membership number under 40 characters.').regex(/^[A-Za-z0-9 /-]*$/, 'Use letters, numbers, spaces, / and - only.').transform(oneLine).nullable(),
  feesUrl: webAddress.nullable(),
}).partial();
export type OrgProfileBodyT = z.infer<typeof OrgProfileBody>;

/** The columns to write for a profile body: only the boxes that were sent, with empty ones as NULL. */
export function profileColumns(b: OrgProfileBodyT): Record<string, string | null> {
  const cols: Record<string, string | null> = {};
  const set = (col: keyof OrgProfileRow, v: string | null | undefined) => { if (v !== undefined) cols[col] = v || null; };
  set('phone', b.phone); set('leads_email', b.leadsEmail); set('website', b.website); set('about', b.about); set('address', b.address);
  set('client_money_scheme', b.clientMoneyScheme); set('redress_number', b.redressNumber); set('fees_url', b.feesUrl);
  return cols;
}
