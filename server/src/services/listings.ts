/**
 * Listing helpers shared by the listings, feeds, admin and alerts code:
 * database row ⇄ API shape, privacy redaction, compliance checks and geocoding.
 */
import { z } from 'zod';
import type { CheckDTO, ListingDTO, ListingStatus, PhotoDTO } from '../../../src/lib/apiTypes';
import { complianceChecks, locate, normalisePostcode, placeFieldProblem, POSTCODE_RE, streetOnly, type ListingInput } from '../../../src/engine/listings';
import type { PropertyType } from '../../../src/engine/refurb';
import { q, type Q } from '../db';

export const PROPERTY_TYPES = ['terraced', 'semi-detached', 'detached', 'flat', 'bungalow', 'commercial'] as const;
export const ERAS = ['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'] as const;
export const CONDITIONS = ['derelict', 'poor', 'fair', 'good'] as const;

const money = z.coerce.number().positive().max(100_000_000);
export const ListingBody = z.object({
  channel: z.enum(['sale', 'rent']),
  title: z.string().trim().max(120).optional().nullable(),
  // Both are shown publicly (the street part of the address for private sellers), so no contact details, links or payment wording.
  addressLine: z.string().trim().min(3, 'Enter the first line of the address.').max(160)
    .superRefine((v, ctx) => { const p = placeFieldProblem(v, 'addressLine'); if (p) ctx.addIssue({ code: 'custom', message: p }); }),
  town: z.string().trim().min(2, 'Enter the town or city.').max(80)
    .superRefine((v, ctx) => { const p = placeFieldProblem(v, 'town'); if (p) ctx.addIssue({ code: 'custom', message: p }); }),
  postcode: z.string().trim().regex(POSTCODE_RE, 'Enter a full UK postcode, e.g. E17 4QH.'),
  type: z.enum(PROPERTY_TYPES),
  tenure: z.enum(['freehold', 'leasehold', 'share-of-freehold']),
  leaseYears: z.coerce.number().int().min(1).max(999).optional().nullable(),
  beds: z.coerce.number().int().min(0).max(30),
  baths: z.coerce.number().int().min(0).max(30),
  floorArea: z.coerce.number().min(10, 'Floor area looks too small (m²).').max(10_000),
  era: z.enum(ERAS).optional().nullable(),
  condition: z.enum(CONDITIONS).optional().nullable(),
  price: money,
  priceQualifier: z.enum(['guide', 'offers over', 'offers in region of', 'fixed', 'pcm']).optional().nullable(),
  epc: z.string().trim().toUpperCase().regex(/^[A-G]$/, 'EPC rating is a letter A–G.').optional().nullable(),
  councilTax: z.string().trim().toUpperCase().regex(/^([A-I]|EXEMPT)$/, 'Council tax band is a letter A–H (I in Wales).').optional().nullable(),
  serviceChargeAnnual: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  groundRentAnnual: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  features: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  description: z.string().trim().max(8000).optional().nullable(),
  materialInfo: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
  ownershipDeclared: z.boolean().optional(),
});
export type ListingBodyT = z.infer<typeof ListingBody>;

export interface ListingRow {
  id: string; ref: string; owner_user_id: string | null; organisation_id: string | null; organisation_name?: string | null; organisation_verified?: boolean | null;
  owner_name?: string | null;
  source_kind: ListingDTO['source']['kind']; source_ref: string | null; channel: 'sale' | 'rent'; status: ListingStatus;
  title: string | null; address_line: string; town: string; postcode: string; district: string; lat: number | null; lng: number | null;
  property_type: string; tenure: ListingDTO['tenure']; lease_years: number | null; beds: number; baths: number; floor_area: number;
  era: string | null; condition: string | null; price: number; price_qualifier: string | null; epc: string | null; council_tax: string | null;
  service_charge_annual: number | null; ground_rent_annual: number | null; features: string[]; description: string | null;
  material_info: Record<string, unknown>; ownership_declared: boolean; ownership_verified: boolean; rejection_reason: string | null;
  created_at: Date; updated_at: Date; published_at: Date | null;
}

/** SELECT list used everywhere listings are read (joins the organisation and owner's display name). */
export const LISTING_SELECT = `SELECT l.*, o.name AS organisation_name, o.verified AS organisation_verified, u.display_name AS owner_name
  FROM listings l LEFT JOIN organisations o ON o.id = l.organisation_id LEFT JOIN users u ON u.id = l.owner_user_id`;

/** Hide the house number for private sellers, e.g. "Flat 2, 14 Elm Road" → "Elm Road" (shared with the website's preview). */
export { streetOnly };

export function toDTO(r: ListingRow, photos: PhotoDTO[], viewer: { userId?: string | null; orgIds?: string[]; admin?: boolean }): ListingDTO {
  const mine = !!(viewer.userId && r.owner_user_id === viewer.userId) || !!(r.organisation_id && viewer.orgIds?.includes(r.organisation_id));
  const full = mine || !!viewer.admin || r.source_kind === 'agent-feed' || r.source_kind === 'agent';
  const name = r.organisation_name ? r.organisation_name : r.source_kind === 'landlord' ? 'Private landlord' : 'Private seller';
  return {
    ref: r.ref, status: r.status, channel: r.channel, title: r.title,
    addressLine: full ? r.address_line : streetOnly(r.address_line), town: r.town,
    postcode: full ? r.postcode : r.district, district: r.district,
    lat: r.lat == null ? null : full ? r.lat : Math.round(r.lat * 500) / 500, lng: r.lng == null ? null : full ? r.lng : Math.round(r.lng * 500) / 500,
    type: r.property_type, tenure: r.tenure, leaseYears: r.lease_years, beds: r.beds, baths: r.baths, floorArea: r.floor_area,
    era: r.era, condition: r.condition, price: r.price, priceQualifier: r.price_qualifier, epc: r.epc, councilTax: r.council_tax,
    serviceChargeAnnual: r.service_charge_annual, groundRentAnnual: r.ground_rent_annual, features: r.features ?? [], description: r.description,
    photos,
    source: { kind: r.source_kind, name, verified: r.source_kind === 'agent-feed' || r.source_kind === 'agent' ? !!r.organisation_verified : r.ownership_verified },
    ownershipVerified: r.ownership_verified,
    rejectionReason: mine || viewer.admin ? r.rejection_reason : undefined,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), publishedAt: r.published_at?.toISOString() ?? null,
    mine,
  };
}

export async function photosFor(listingIds: string[], db?: Q): Promise<Map<string, PhotoDTO[]>> {
  const m = new Map<string, PhotoDTO[]>();
  if (!listingIds.length) return m;
  const rows = await q<{ id: string; listing_id: string; url: string; alt: string | null }>(
    'SELECT id, listing_id, url, alt FROM listing_photos WHERE listing_id = ANY($1) ORDER BY position, created_at', [listingIds], db);
  for (const r of rows) { const a = m.get(r.listing_id) ?? []; a.push({ id: r.id, url: r.url, alt: r.alt }); m.set(r.listing_id, a); }
  return m;
}

/** Same checks the website shows while someone fills in the form. */
export function checksFor(r: ListingRow, photoCount: number): CheckDTO[] {
  const input: ListingInput = {
    listing: r.channel, title: r.title ?? undefined, addressLine: r.address_line, town: r.town, postcode: r.postcode,
    type: r.property_type as PropertyType, tenure: r.tenure, leaseYears: r.lease_years ?? undefined, beds: r.beds, baths: r.baths, floorArea: r.floor_area,
    price: r.price, epc: r.epc ?? undefined, councilTax: r.council_tax ?? undefined,
    serviceChargeAnnual: r.service_charge_annual ?? undefined, groundRentAnnual: r.ground_rent_annual ?? undefined,
    features: r.features ?? [], description: r.description ?? undefined, photos: Array.from({ length: photoCount }, () => ''),
    source: { kind: r.source_kind === 'landlord' ? 'landlord' : 'owner', name: '', licence: '', verified: false },
  };
  const checks: CheckDTO[] = complianceChecks(input, { minPhotos: 1 });
  checks.push({ id: 'ownership', ok: r.ownership_declared || r.source_kind === 'agent-feed' || r.source_kind === 'agent', severity: 'block', message: 'Confirm you own the property or are authorised to market it.' });
  return checks;
}

/** Postcode → precise location via postcodes.io (free, open data); falls back to an approximate area centre. */
export async function geocode(postcode: string): Promise<{ postcode: string; district: string; lat: number; lng: number; precise: boolean }> {
  const pc = normalisePostcode(postcode);
  const district = pc.split(' ')[0];
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = (await r.json()) as { result?: { latitude: number; longitude: number; outcode: string } };
      if (j.result?.latitude != null) return { postcode: pc, district: j.result.outcode ?? district, lat: j.result.latitude, lng: j.result.longitude, precise: true };
    }
  } catch { /* offline or blocked: fall back */ }
  const loc = locate(pc);
  return { postcode: pc, district: loc.district, lat: loc.lat, lng: loc.lng, precise: false };
}

export function columnsFrom(b: Partial<ListingBodyT>) {
  const map: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => { if (v !== undefined) map[col] = v; };
  set('channel', b.channel); if (b.title !== undefined) map.title = b.title || null; set('address_line', b.addressLine); set('town', b.town);
  set('property_type', b.type); set('tenure', b.tenure); set('lease_years', b.tenure && b.tenure !== 'leasehold' ? null : b.leaseYears);
  set('beds', b.beds); set('baths', b.baths); set('floor_area', b.floorArea); set('era', b.era); set('condition', b.condition);
  set('price', b.price); set('price_qualifier', b.priceQualifier); set('epc', b.epc); set('council_tax', b.councilTax);
  set('service_charge_annual', b.serviceChargeAnnual); set('ground_rent_annual', b.groundRentAnnual);
  set('features', b.features); set('description', b.description);
  if (b.materialInfo !== undefined) map.material_info = JSON.stringify(b.materialInfo);
  if (b.ownershipDeclared !== undefined) map.ownership_declared = b.ownershipDeclared;
  return map;
}

export const PUBLIC_STATUSES: ListingStatus[] = ['live', 'under_offer'];
