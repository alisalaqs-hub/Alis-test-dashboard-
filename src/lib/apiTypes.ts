/**
 * Shapes exchanged between the Streetkey server and the website.
 * Shared by server/src (Node) and src (browser), so keep it free of runtime imports.
 */
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
  features: { email: 'resend' | 'log'; storage: 'local' | 's3'; aiImages: boolean; moderation: boolean };
}

export interface EnquirySummaryDTO {
  id: string; kind: 'viewing' | 'question' | 'offer'; status: 'new' | 'replied' | 'closed';
  role: 'lister' | 'enquirer';
  listing: { ref: string; title: string; price: number; channel: 'sale' | 'rent' };
  name: string; email: string | null; phone: string | null; preferredSlot: string | null;
  lastMessage: { body: string; author: 'enquirer' | 'lister'; at: string } | null;
  messages: number; createdAt: string;
}
export interface MessageDTO { id: string; author: 'enquirer' | 'lister'; body: string; at: string }

export interface SavedSearchDTO { id: string; query: string; mode: string; alertFrequency: 'instant' | 'daily' | 'weekly' | 'off'; createdAt: string }

export interface AiImageDTO { id: string; room: string; style: string; brief: string | null; status: 'running' | 'done' | 'failed'; url: string | null; sourceUrl: string | null; model: string; error: string | null; createdAt: string }

export interface ApiErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }
