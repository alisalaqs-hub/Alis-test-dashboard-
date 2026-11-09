/**
 * Saved searches and their alerts.
 *
 * A saved search keeps its words AND the filters the person saw on the search page (the validated
 * reading, after removing chips and setting page filters). Alerts run exactly those filters, so an
 * alert never disagrees with the page: a place the AI reading kept but the built-in parser doesn't
 * know, a removed chip or a Market filter all carry over. Filters arrive from the browser, so they
 * are validated here again (sizes, ranges, plain place names, nothing about who lives somewhere).
 * Searches saved before filters were stored are read from their words with the built-in rules, in
 * the saved mode ("rent" always searches rentals), plus any known place named in the words.
 */
import { z } from 'zod';
import type { SearchQuery } from '../../../../src/engine/search';
import {
  DISTRICT_RE, FLAG_FIELDS, fromRules, mentionsProtected, PROPERTY_TYPES, SEARCH_MODES,
  type FlagField, type SavedSearchFilters, type SearchExtras, type SearchMode,
} from '../../../../src/lib/ai/search';
import { placesIn } from './intent';

const notAboutPeople = (s: string) => !mentionsProtected(s);
const flags = Object.fromEntries(FLAG_FIELDS.map((f) => [f, z.boolean().optional()])) as Record<FlagField, z.ZodOptional<z.ZodBoolean>>;

export const SavedFiltersSchema = z.object({
  query: z.object({
    intent: z.enum(['buy', 'rent', 'invest']),
    minBeds: z.number().int().min(1).max(15).optional(),
    maxPrice: z.number().positive().max(100_000_000).optional(),
    locations: z.array(z.string().trim().min(1).max(40).regex(/^[\p{L}][\p{L} .'’-]*$/u, 'Not a place name.').refine(notAboutPeople, 'Not a place name.')).max(10).default([]),
    districts: z.array(z.string().trim().toUpperCase().regex(DISTRICT_RE, 'Not a postcode district.')).max(10).default([]),
    maxCommuteMins: z.number().int().min(5).max(180).optional(),
    commuteTo: z.string().trim().min(1).max(60).regex(/^[a-z][a-z .'’-]*$/i, 'Not a place name.').refine(notAboutPeople, 'Not a place name.').optional(),
    types: z.array(z.enum(PROPERTY_TYPES)).max(PROPERTY_TYPES.length).default([]),
    ...flags,
    minRefurbProfit: z.number().min(0).max(5_000_000).optional(),
    minYield: z.number().min(0).max(0.3).optional(),
  }),
  extras: z.object({
    minPrice: z.number().min(0).max(100_000_000).nullable().default(null),
    maxBeds: z.number().int().min(1).max(15).nullable().default(null),
    mustHaves: z.array(z.string().trim().min(1).max(30).regex(/^[a-z][a-z0-9 '-]*$/i, 'Not a home feature.').refine(notAboutPeople, 'Not a home feature.')).max(5).default([]),
  }).default({ minPrice: null, maxBeds: null, mustHaves: [] }),
});

/** A saved search's mode, as stored: one of the search box modes ('buy' for anything else). */
export const savedMode = (mode: string | null | undefined): SearchMode =>
  ((SEARCH_MODES as readonly string[]).includes(mode ?? '') ? mode as SearchMode : 'buy');

/** Stored filters → the engine query and extras, or null when they are missing or no longer valid. */
export function storedFilters(raw: unknown): SavedSearchFilters | null {
  if (raw == null) return null;
  const r = SavedFiltersSchema.safeParse(raw);
  if (!r.success) return null;
  return { query: { ...r.data.query, unsupported: [] }, extras: { minPrice: r.data.extras.minPrice, maxBeds: r.data.extras.maxBeds, mustHaves: r.data.extras.mustHaves.map((m) => m.toLowerCase()) } };
}

/** What an alert searches for: the stored filters, or (older saves) the words read by the built-in rules in the saved mode. */
export function alertSearch(s: { query: string; mode: string; filters: unknown }, places: string[]): { query: SearchQuery; extras: SearchExtras; from: 'filters' | 'words' } {
  const saved = storedFilters(s.filters);
  if (saved) return { ...saved, from: 'filters' };
  const r = fromRules(s.query, savedMode(s.mode));
  const query = r.query;
  // A place Streetkey knows by name but the built-in parser doesn't ("Brighton", "Hackney"), so the alert isn't UK-wide.
  if (!query.locations.length && !query.districts.length && !query.maxCommuteMins) query.locations = placesIn(s.query, places).slice(0, 3);
  return { query, extras: r.extras, from: 'words' };
}
