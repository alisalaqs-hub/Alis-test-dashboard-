/**
 * Hook points the core routes emit, so AI features can react without the core
 * knowing about them. Handlers should be quick (enqueue a job), and never throw
 * into the request: failures are logged and ignored.
 *
 *   on('photosUploaded', async ({ listingId, ref, photoIds, userId }) => enqueue(...))
 */
export interface HookPayloads {
  /** A lister submitted a listing for review (or it went straight live). */
  listingSubmitted: { listingId: string; ref: string; userId: string | null };
  /** Listings became publicly visible (approved, published, agency verified, feed upload). */
  listingsPublished: { listingIds: string[] };
  /** Listing content changed (edit), e.g. to refresh embeddings. */
  listingUpdated: { listingId: string; ref: string; fields: string[] };
  /** New photos stored for a listing. */
  photosUploaded: { listingId: string; ref: string; photoIds: string[]; userId: string | null };
  /**
   * A buyer/tenant sent an enquiry. senderKey identifies who sent it ('u:<user id>', or an anonymised
   * visitor network from anonId(ip)), so AI work an enquirer sets off can be capped per sender.
   */
  enquiryCreated: { enquiryId: string; listingId: string; senderKey: string };
  /** A new message in an enquiry thread (senderKey: 'u:<user id>' of whoever wrote it). */
  enquiryMessage: { enquiryId: string; author: 'enquirer' | 'lister'; senderKey: string };
}
type Name = keyof HookPayloads;
const subs: { [K in Name]?: ((p: HookPayloads[K]) => Promise<unknown> | unknown)[] } = {};

export function on<K extends Name>(name: K, fn: (p: HookPayloads[K]) => Promise<unknown> | unknown) {
  (subs[name] ??= [] as never as typeof subs[K]);
  (subs[name] as ((p: HookPayloads[K]) => unknown)[]).push(fn);
}
export async function emit<K extends Name>(name: K, payload: HookPayloads[K]) {
  for (const fn of (subs[name] ?? []) as ((p: HookPayloads[K]) => Promise<unknown> | unknown)[]) {
    try { await fn(payload); } catch (e) { if (process.env.NODE_ENV !== 'test') console.warn(`[hook ${name}]`, (e as Error).message); }
  }
}

/* ───────── screening (a hook that can stop an action) ───────── */
/**
 * What the screener sees. For a follow-up message in an existing conversation, message is the new
 * message and followUp is true. senderKey ('u:<id>' or anonId(ip)) lets the screener cap AI use per sender.
 */
export interface EnquiryScreenInput { enquiryId: string; listingId: string; name: string; email: string; message: string; kind: string; senderKey?: string | null; followUp?: boolean }
export interface ScreenVerdict { filter: boolean; reason?: string }
let enquiryScreener: ((e: EnquiryScreenInput) => Promise<ScreenVerdict>) | null = null;
/** Register the spam/scam screen for new enquiries (one screener; the AI inbox feature provides it). */
export function setEnquiryScreener(fn: typeof enquiryScreener) { enquiryScreener = fn; }
/** Ask the screener about an enquiry. Never blocks for long and never throws: unscreened = allowed. */
export async function screenEnquiry(e: EnquiryScreenInput): Promise<ScreenVerdict> {
  if (!enquiryScreener) return { filter: false };
  try {
    return await Promise.race([enquiryScreener(e), new Promise<ScreenVerdict>((res) => setTimeout(() => res({ filter: false }), 8000))]);
  } catch { return { filter: false }; }
}
export function clearHooks() { for (const k of Object.keys(subs) as Name[]) delete subs[k]; enquiryScreener = null; }
