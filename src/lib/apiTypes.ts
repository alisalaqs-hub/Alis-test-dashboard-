/**
 * Shapes exchanged between the Streetkey server and the website.
 * Shared by server/src (Node) and src (browser), so keep it free of runtime imports.
 */
import type { SavedSearchFilters } from './ai/search';
import type { EpcBand, EvidenceRange, FloodResult, HpiSummary, SoldSale, SoldStats } from '../engine/evidence';
import type { ListingHistory } from '../engine/history';
import type { Letting } from '../engine/letting';

export type ListingStatus = 'draft' | 'pending' | 'live' | 'under_offer' | 'sold' | 'let' | 'withdrawn' | 'rejected';
export type SourceKindDTO = 'owner' | 'landlord' | 'agent-feed' | 'agent';

export interface PhotoDTO {
  id: string; url: string; alt: string | null;
  /** What Streetkey AI saw in this photo ("period fireplace", "bay window"), when the lister had their photos checked. */
  features?: string[];
}

/**
 * A listing's public history: when it was first listed, how long it has been on the market and every
 * change to the asking price. Prices and dates only, the same for every viewer and every kind of lister.
 */
export type ListingHistoryDTO = ListingHistory;

/** Letting details on a rental: deposit, when it is available, furnishing and so on (only what the lister has said). */
export type LettingDTO = Letting;

export interface ListingDTO {
  ref: string;
  status: ListingStatus;
  channel: 'sale' | 'rent';
  title: string | null;
  /** Street only when viewed publicly, whoever listed it; the full first line for the lister, their agency and admins. */
  addressLine: string;
  town: string;
  /** Outward code (district) only when viewed publicly, whoever listed it; the full postcode for the lister, their agency and admins. */
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
  /** True when the floor area is a guess (a feed that gave none): the site never shows it as the home's floor area. */
  floorAreaEstimated?: boolean;
  photos: PhotoDTO[];
  source: { kind: SourceKindDTO; name: string; verified: boolean };
  /** The agency (or landlord or developer company) that listed it, whose public page is /agent/<id>. Null for private sellers and landlords (absent on older servers). */
  organisationId?: string | null;
  /** That organisation's name; null when there is none. */
  agentName?: string | null;
  /** That organisation's phone number, for a "Call" link; null when it has not given one. Private sellers' and landlords' numbers are never sent. */
  agentPhone?: string | null;
  ownershipVerified: boolean;
  rejectionReason?: string | null;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  /** Null until the listing has been on the market (absent on older servers). */
  history?: ListingHistoryDTO | null;
  /** Rentals only, when the lister gave letting details. Sale listings never carry it (absent on older servers). */
  letting?: LettingDTO;
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

/**
 * An agency's results: one row per listing, with totals. views: visits to the listing page, counted for
 * everyone without recording who viewed. calls: taps on the agency's phone number on the listing.
 */
export interface OrgReportRowDTO {
  ref: string; title: string | null; town: string; postcode: string; channel: 'sale' | 'rent'; status: string; price: number;
  publishedAt: string | null; daysOnMarket: number | null;
  views: number; calls: number; saves: number; enquiries: number; viewings: number;
}
export interface OrgReportDTO {
  days: number;
  totals: { listings: number; views: number; calls: number; saves: number; enquiries: number; viewings: number };
  items: OrgReportRowDTO[];
  note: string;
}

/* ───────────── Agent pages and valuation requests ───────────── */

/**
 * What an agency says about itself on its public page. Each is null until the agency fills it in.
 * Letting agents in England must show their fees, redress scheme and client money protection wherever they advertise.
 */
export interface AgencyProfileDTO {
  phone: string | null;
  /** Always an https address. */
  website: string | null;
  /** Short plain text. */
  about: string | null;
  address: string | null;
  /** The client money protection scheme the agency belongs to. */
  clientMoneyScheme: string | null;
  /** The agency's membership number with its redress scheme. */
  redressNumber: string | null;
  /** Where the agency publishes its tenant and landlord fees (always an https address). */
  feesUrl: string | null;
}

/** An agent's public page: who they are, how much they have on the market, and their live listings (newest first, at most 60). */
export interface AgentProfileDTO {
  agent: {
    id: string; name: string; kind: 'agency' | 'landlord' | 'developer' | 'contractor';
    /** Checked by Streetkey (for example redress scheme membership). */
    verified: boolean; redressScheme: string | null;
    /** The day the agent joined Streetkey, as YYYY-MM-DD. */
    since: string;
    /** Homes on the market now (live or under offer), and those marked sold or let in the last 12 months. */
    counts: { sale: number; rent: number; soldOrLet12m: number };
  } & AgencyProfileDTO;
  listings: ListingDTO[];
}

/** An organisation as its own members see it (GET /api/me/orgs): its profile, and the leads email the public never sees. */
export interface OrgDTO extends AgencyProfileDTO {
  id: string; name: string; kind: 'agency' | 'landlord' | 'developer' | 'contractor'; verified: boolean; redressScheme: string | null;
  /** The signed-in person's role. Owners and admins may change the profile. */
  role: 'owner' | 'admin' | 'member';
  /** Where enquiries and valuation requests are emailed instead of to individual members; null when they go to members. */
  leadsEmail: string | null;
}
/** What PATCH /api/orgs/:id accepts: a box left out stays as it is; an empty one (or null) is cleared. */
export type OrgProfileBody = Partial<Record<keyof AgencyProfileDTO | 'leadsEmail', string | null>>;

/**
 * What someone sends to ask an agent to value their home. Nothing about the person's money is asked
 * for or kept: no funds, mortgage or income.
 */
export interface ValuationRequestBody {
  name: string; email: string; phone?: string | null;
  postcode: string; addressLine?: string | null;
  intent: 'sell' | 'let';
  propertyType?: string | null; beds?: number | null; message?: string | null;
  /** Honeypot: left empty by people. */
  website?: string;
}
export type ValuationStatus = 'new' | 'contacted' | 'closed';
/** A valuation request as the agency's members see it. */
export interface ValuationRequestDTO {
  id: string; name: string; email: string; phone: string | null;
  postcode: string; addressLine: string | null;
  intent: 'sell' | 'let'; propertyType: string | null; beds: number | null; message: string | null;
  status: ValuationStatus; createdAt: string;
}

/* ───────────── Agent feeds ───────────── */

/**
 * A listing a feed run has something to say about. Without `imported` the listing was not imported, for the
 * reason given. With it, the listing went in and the reason says what was left out (a photo, a floor plan, a date).
 */
export interface FeedIssueDTO { ref: string; reason: string; imported?: boolean }
/** What one feed run did: a BLM file sent with a feed key, or uploaded by hand from the agency page. */
export interface FeedResultDTO {
  /** Listings imported from the file, and how many of those were already on Streetkey. */
  accepted: number; updated: number;
  /** Listings the same source sent before that are not among those accepted from this file. */
  withdrawn: number;
  rejected: FeedIssueDTO[];
  /** Media in the file that Streetkey does not show: energy certificates, brochures, virtual tours, and pictures given as file names. */
  leftOut: { epc: number; documents: number; virtualTours: number; notLinks: number };
  /** For example "BLM 3". */
  format: string;
  /** Whether the listings are live or waiting for the agency to be verified. */
  note: string;
}
