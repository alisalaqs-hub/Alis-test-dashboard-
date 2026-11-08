/**
 * Live listings as the website's engines see them. The engines (search, valuation, refurb,
 * deal score…) work on the shared Property registry; this keeps the server's copy of that
 * registry topped up with live listings from the database (refreshed at most once a minute).
 */
import { setDynamicListings, PROPERTIES, type Property } from '../../../src/data/properties';
import { buildListing } from '../../../src/engine/listings';
import type { PropertyType } from '../../../src/engine/refurb';
import { q } from '../db';
import { LISTING_SELECT, toDTO, type ListingRow } from '../services/listings';

/** A database listing → Property, using public (privacy-safe) fields only. */
export function rowToProperty(r: ListingRow, photos: string[] = []): Property {
  const d = toDTO(r, [], {});
  const p = buildListing({
    id: d.ref, listing: d.channel, title: d.title ?? undefined, addressLine: d.addressLine, town: d.town, postcode: r.postcode,
    type: d.type as PropertyType, tenure: d.tenure, leaseYears: d.leaseYears ?? undefined, beds: d.beds, baths: d.baths, floorArea: d.floorArea,
    era: (d.era ?? undefined) as never, condition: (d.condition ?? undefined) as never,
    price: d.price, epc: d.epc ?? undefined, councilTax: d.councilTax ?? undefined, features: d.features, description: d.description ?? undefined,
    serviceChargeAnnual: d.serviceChargeAnnual ?? undefined, groundRentAnnual: d.groundRentAnnual ?? undefined, photos,
    source: { kind: d.source.kind === 'landlord' ? 'landlord' : d.source.kind === 'owner' ? 'owner' : 'agent-feed', name: d.source.name, licence: '', verified: d.source.verified },
    geo: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : undefined, status: d.status === 'under_offer' ? 'under offer' : 'live',
  });
  p.street = d.addressLine; // never the house number for private sellers
  return p;
}

let refreshed = 0;
let inflight: Promise<void> | null = null;
/** Make sure the registry includes current live listings (cheap when fresh). */
export function ensureLiveRegistry(maxAgeMs = 60_000): Promise<void> {
  if (Date.now() - refreshed < maxAgeMs) return Promise.resolve();
  if (!inflight) {
    inflight = (async () => {
      const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE l.status IN ('live', 'under_offer') ORDER BY coalesce(l.published_at, l.created_at) DESC LIMIT 2000`);
      setDynamicListings(rows.map((r) => rowToProperty(r)));
      refreshed = Date.now();
    })().finally(() => { inflight = null; });
  }
  return inflight;
}
export const invalidateLiveRegistry = () => { refreshed = 0; };
/** All properties the engines know about (demo + live). */
export const allProperties = () => PROPERTIES;
