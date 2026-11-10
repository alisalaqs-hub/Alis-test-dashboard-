/**
 * Official open data for the website:
 *   GET /api/data/status                     what can be looked up right now
 *   GET /api/data/sold?q=…&radius=&years=    sold prices around a postcode, postcode district or town (HM Land Registry)
 *   GET /api/data/flood?q=…                  flood risk at a postcode or place (Environment Agency, England)
 *   GET /api/data/listings/:ref              sold prices nearby, price range, flood risk and energy certificate for a listing
 *   GET /api/data/epc/search?postcode=…      certificates at a postcode, for a signed-in person filling in their own listing
 *   GET /api/data/epc/certificate?number=…   one certificate, for a signed-in person
 *
 * Every lookup is cached in the database, so repeat visits don't call the public services again.
 * The limits below protect those services (and this site) from being used as a bulk download.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ATTRIBUTION } from '../../../src/engine/evidence';
import { POSTCODE_RE } from '../../../src/engine/listings';
import type { DataStatusDTO } from '../../../src/lib/apiTypes';
import { config } from '../config';
import { epcCertificate, epcConfigured, epcSearch } from '../data/epc';
import { floodRisk } from '../data/flood';
import { dataOff } from '../data/http';
import { officialForListing, soldAround } from '../data/official';
import { resolvePlace } from '../data/postcodes';
import { HttpError, notFound, parse, requireUser } from '../services/http';
import { limit } from '../services/ratelimit';
import { PUBLIC_STATUSES } from '../services/listings';
import { loadByRef, viewerOf } from './listings';

const Place = z.string().trim().min(2, 'Enter a postcode or a place.').max(80);
const noPlace = () => new HttpError(404, 'We couldn’t find that place. Try a full postcode (for example E17 4PP), a postcode district (E17) or a town.', 'place_not_found', { q: 'Not found.' });

export async function dataRoutes(app: FastifyInstance) {
  app.get('/api/data/status', async (): Promise<DataStatusDTO> => ({ enabled: !config.data.disabled, soldPrices: !config.data.disabled, flood: !config.data.disabled, epc: epcConfigured() }));

  app.get('/api/data/sold', { preHandler: [limit('data.sold', 30, 60), limit('data.sold.d', 600, 86_400)] }, async (req) => {
    if (config.data.disabled) throw dataOff('land-registry');
    const b = parse(z.object({ q: Place, radius: z.coerce.number().int().min(100).max(1500).optional(), years: z.coerce.number().int().min(1).max(10).optional() }), req.query);
    const place = await resolvePlace(b.q);
    if (!place) throw noPlace();
    return soldAround(place, { radiusM: b.radius, years: b.years });
  });

  app.get('/api/data/flood', { preHandler: [limit('data.flood', 30, 60), limit('data.flood.d', 600, 86_400)] }, async (req) => {
    if (config.data.disabled) throw dataOff('environment-agency');
    const b = parse(z.object({ q: Place }), req.query);
    const place = await resolvePlace(b.q);
    if (!place) throw noPlace();
    return {
      place: { kind: place.kind, label: place.label, district: place.district, country: place.country },
      flood: await floodRisk(place.lat, place.lng, { country: place.country, approximate: true }),
      attribution: [ATTRIBUTION.environmentAgency, ATTRIBUTION.postcodes],
    };
  });

  app.get('/api/data/listings/:ref', { preHandler: limit('data.listing', 60, 60) }, async (req) => {
    if (config.data.disabled) throw dataOff('land-registry');
    const { ref } = req.params as { ref: string };
    if (!/^[a-z0-9-]{2,40}$/i.test(ref)) throw notFound('That listing');
    const row = await loadByRef(ref);
    if (!row) throw notFound('That listing');
    const viewer = await viewerOf(req);
    const canSee = PUBLIC_STATUSES.includes(row.status) || viewer.admin || row.owner_user_id === viewer.userId || (!!row.organisation_id && viewer.orgIds.includes(row.organisation_id));
    if (!canSee) throw notFound('That listing');
    return officialForListing(row);
  });

  /* Energy certificates are address-level records: only for signed-in people, a few at a time. */
  const epcLimits = [limit('data.epc', 20, 60, 'user'), limit('data.epc.d', 200, 86_400, 'user')];
  app.get('/api/data/epc/search', { preHandler: epcLimits }, async (req) => {
    requireUser(req);
    const b = parse(z.object({ postcode: z.string().trim().regex(POSTCODE_RE, 'Enter a full UK postcode (for example E17 4PP).').max(10) }), req.query);
    return { items: await epcSearch(b.postcode), attribution: [ATTRIBUTION.epc] };
  });
  app.get('/api/data/epc/certificate', { preHandler: epcLimits }, async (req) => {
    requireUser(req);
    const b = parse(z.object({ number: z.string().trim().regex(/^\d{4}-?\d{4}-?\d{4}-?\d{4}-?\d{4}$/, 'That isn’t a certificate number.') }), req.query);
    const certificate = await epcCertificate(b.number);
    if (!certificate) throw notFound('That certificate');
    return { certificate, attribution: [ATTRIBUTION.epc] };
  });
}
