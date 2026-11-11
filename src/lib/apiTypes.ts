/**
 * Shapes exchanged between the Streetkey server and the website.
 * Shared by server/src (Node) and src (browser), so keep it free of runtime imports.
 */
import type { SavedSearchFilters } from './ai/search';
import type { EpcBand, EvidenceRange, FloodResult, HpiSummary, SoldSale, SoldStats } from '../engine/evidence';

export type ListingStatus = 'draft' | 'pending' | 'live' | 'under_offer' | 'sold' | 'let' | 'withdrawn' | 'rejected';
export type SourceKindDTO = 'owner' | 'landlord' | 'agent-feed' | 'agent';

export interface PhotoDTO { id: string; url: string; alt: string | null }

export interface ListingDTO {
  ref: string;
  status: ListingStatus;
  channel: 'sale' | 'rent';
  title: string | null;
  /** Street only for private sellers when viewed publicly; full address for the lister. */
  addressLine: string;
  town: string;
  /** Full postcode for the lister; outward code (district) only when viewed publicly. */
  postcode: string;
  district: string;
  lat: number | null;
  lng: number | null;
  type: string;
  tenure: 'freehold' | 'leasehold' | 'share-of-freehold';
  leaseYears: number | null;
  beds: number;
  baths: number;
  floorArea: number;
  era: string | null;
  condition: string | null;
  price: number;
  priceQualifier: string | null;
  epc: string | null;
  councilTax: string | null;
  serviceChargeAnnual: number | null;
  groundRentAnnual: number | null;
  features: string[];
  description: string | null;
  photos: PhotoDTO[];
  source: { kind: SourceKindDTO; name: string; verified: boolean };
  ownershipVerified: boolean;
  rejectionReason?: string | null;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  /** True when the signed-in person listed it (or belongs to the listing agency). */
  mine: boolean;
}

export interface CheckDTO { id: string; ok: boolean; severity: 'block' | 'warn'; message: string }

export interface UserDTO {
  id: string; email: string; name: string; role: 'member' | 'admin'; accountType: string;
  emailVerified: boolean; marketingOptIn: boolean; phone: string | null; createdAt: string;
}

export interface HealthDTO {
  ok: boolean; version: string;
  features: { email: 'resend' | 'log'; storage: 'local' | 's3' | 'netlify-blobs'; aiImages: boolean; /** Photo understanding (absent on older servers: treated as on when AI is on). */ aiPhotos?: boolean; ai: boolean; moderation: boolean; runtime: 'node' | 'netlify' };
}

export interface EnquirySummaryDTO {
  id: string; kind: 'viewing' | 'question' | 'offer'; status: 'new' | 'replied' | 'closed';
  role: 'lister' | 'enquirer';
  /** Held back by the automated spam/scam screen (lister only). */
  filtered: boolean; filterReason: string | null;
  listing: { ref: string; title: string; price: number; channel: 'sale' | 'rent' };
  name: string; email: string | null; phone: string | null; preferredSlot: string | null;
  lastMessage: { body: string; author: 'enquirer' | 'lister'; at: string } | null;
  messages: number; createdAt: string;
}
export interface MessageDTO {
  id: string; author: 'enquirer' | 'lister'; body: string; at: string;
  /** Held back by the spam/scam screen and not emailed (shown to the lister and admins only). */
  held?: boolean;
}

/** filters: the reading the person saw when saving (alerts run exactly that search); null for older saves. */
export interface SavedSearchDTO { id: string; query: string; mode: string; alertFrequency: 'instant' | 'daily' | 'weekly' | 'off'; createdAt: string; filters?: SavedSearchFilters | null }

export interface AiImageDTO { id: string; room: string; style: string; brief: string | null; status: 'running' | 'done' | 'failed'; url: string | null; sourceUrl: string | null; model: string; error: string | null; createdAt: string }

export interface ApiErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }

/* ───────────── Official open data (HM Land Registry, Environment Agency, EPC register) ───────────── */

/** What the server can look up right now. */
export interface DataStatusDTO { enabled: boolean; soldPrices: boolean; flood: boolean; epc: boolean }

/** Sold prices around a place. */
export interface SoldPricesDTO {
  place: { kind: 'postcode' | 'outcode' | 'place'; label: string; district: string | null; country: string | null };
  /** HM Land Registry's Price Paid Data covers England and Wales only. */
  coverage: 'england-wales' | 'not-covered';
  /** How far from the centre the sales reach, in metres. */
  radiusM: number;
  years: number;
  /** Standard residential sales, newest first (at most 300). */
  sales: SoldSale[];
  /** Every sale found, including those not listed above. */
  totalSales: number;
  stats: SoldStats;
  hpi: HpiSummary | null;
  /** True when some postcodes couldn't be refreshed from HM Land Registry just now. */
  partial: boolean;
  attribution: string[];
}

/** Official data for one live listing. Private sellers' exact location is never revealed. */
export interface OfficialListingDTO {
  ref: string;
  sold: Pick<SoldPricesDTO, 'coverage' | 'radiusM' | 'years' | 'sales' | 'totalSales' | 'stats' | 'hpi' | 'partial'> | null;
  /** Where the asking price sits against nearby sold prices (sale listings only). */
  range: EvidenceRange | null;
  flood: FloodResult | null;
  /** The home's energy certificate from the register, when it can be matched with confidence. */
  epc: { band: EpcBand | null; potentialBand: EpcBand | null; score: number | null; registeredOn: string | null; expired: boolean; floorAreaM2: number | null; certificateNumber: string | null; matchesListing: boolean | null } | null;
  /** 'not-configured' when the site has no EPC access token, 'no-match' when no certificate could be matched. */
  epcStatus: 'ok' | 'not-configured' | 'no-match' | 'unavailable';
  attribution: string[];
}
