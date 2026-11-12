/** Server listing → the Property shape every Streetkey screen and engine already understands. */
import type { Property } from '../data/properties';
import { buildListing } from '../engine/listings';
import type { Condition, Era, PropertyType } from '../engine/refurb';
import { mediaUrl } from './api';
import type { ListingDTO } from './apiTypes';

const STATUS: Record<ListingDTO['status'], Property['status']> = {
  draft: 'pending', pending: 'pending', live: 'live', under_offer: 'under offer', sold: 'withdrawn', let: 'withdrawn', withdrawn: 'withdrawn', rejected: 'pending',
};

export function dtoToProperty(d: ListingDTO): Property {
  const p = buildListing({
    id: d.ref, listing: d.channel, title: d.title ?? undefined, addressLine: d.addressLine, town: d.town,
    postcode: d.postcode,
    type: d.type as PropertyType, tenure: d.tenure, leaseYears: d.leaseYears ?? undefined, beds: d.beds, baths: d.baths, floorArea: d.floorArea,
    era: (d.era ?? undefined) as Era | undefined, condition: (d.condition ?? undefined) as Condition | undefined, price: d.price,
    epc: d.epc ?? undefined, councilTax: d.councilTax ?? undefined, serviceChargeAnnual: d.serviceChargeAnnual ?? undefined, groundRentAnnual: d.groundRentAnnual ?? undefined,
    features: d.features, description: d.description ?? undefined, photos: d.photos.map((x) => mediaUrl(x.url)),
    source: {
      kind: d.source.kind === 'agent' || d.source.kind === 'agent-feed' ? 'agent-feed' : d.source.kind, name: d.source.name,
      licence: d.source.kind === 'agent-feed' || d.source.kind === 'agent' ? 'Listed by the agent on Streetkey' : 'Posted by the owner on Streetkey', verified: d.source.verified,
    },
    geo: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : undefined,
    status: STATUS[d.status], visibility: 'public',
  });
  if (!d.epc) p.documents = ['EPC (not yet provided)'];
  p.createdAt = d.publishedAt ?? d.createdAt;
  // The server's record of the listing (days actually on the market, price changes) when it has one.
  if (d.history) p.history = d.history;
  p.daysOnMarket = d.history ? d.history.daysOnMarket : d.publishedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(d.publishedAt)) / 86_400_000)) : 0;
  return p;
}

export const isServerRef = (id: string) => /^sk-[a-z0-9]{7}$/.test(id);
