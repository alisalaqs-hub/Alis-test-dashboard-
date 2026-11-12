/**
 * Listing history: what Streetkey records about a real listing over time (first listed, each change
 * to the asking price, under offer, sold or let, withdrawn, relisted) and the plain-English lines the
 * listing page shows from it. Pure functions, shared by the server (which builds the public summary)
 * and the website (which words it). The public summary holds prices and dates only.
 */

export type ListingEventKind = 'listed' | 'price_change' | 'under_offer' | 'available' | 'sold' | 'let' | 'withdrawn' | 'relisted';

/** One recorded event. price is the asking price (monthly rent for a rental) at that moment. */
export interface ListingEvent { kind: ListingEventKind; at: string; price: number; oldPrice?: number | null }

export interface PriceChange { at: string; from: number; to: number }

/** What the public sees of a listing's history. */
export interface ListingHistory {
  /** When the listing first went on the market (ISO date and time). */
  firstListedAt: string;
  /** The asking price (monthly rent for a rental) it was first listed at. */
  firstListedPrice: number;
  /** Whole days on the market so far. Time withdrawn isn't counted, and the count stops once sold or let. */
  daysOnMarket: number;
  /** Changes to the asking price since it was first listed, oldest first. */
  priceChanges: PriceChange[];
}

const DAY_MS = 86_400_000;
const OPENS: ListingEventKind[] = ['listed', 'relisted'];
const CLOSES: ListingEventKind[] = ['sold', 'let', 'withdrawn'];
/** Events in the order they happened (events at the same moment keep the order given); ones without a real date are left out. */
const byTime = <T extends { at: string }>(events: T[]) =>
  events.map((e, i) => ({ e, i, t: Date.parse(e.at) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);

/**
 * Whole days a listing has been on the market: from each time it was listed (or relisted) until it was
 * sold, let or withdrawn, or until now if it is still on the market. Under offer still counts as on the
 * market. Null when it has never been listed.
 */
export function daysOnMarket(events: Pick<ListingEvent, 'kind' | 'at'>[], now: Date = new Date()): number | null {
  let total = 0, openedAt: number | null = null, listed = false;
  for (const e of byTime(events)) {
    const t = Date.parse(e.at);
    if (OPENS.includes(e.kind)) { listed = true; if (openedAt == null) openedAt = t; }
    else if (CLOSES.includes(e.kind) && openedAt != null) { total += Math.max(0, t - openedAt); openedAt = null; }
  }
  if (!listed) return null;
  if (openedAt != null) total += Math.max(0, now.getTime() - openedAt);
  return Math.floor(total / DAY_MS);
}

/** The public summary of a listing's events, or null when it has never been on the market. */
export function summariseHistory(events: ListingEvent[], now: Date = new Date()): ListingHistory | null {
  const ordered = byTime(events);
  const first = ordered.find((e) => e.kind === 'listed') ?? ordered.find((e) => e.kind === 'relisted');
  const days = daysOnMarket(ordered, now);
  if (!first || days == null) return null;
  const priceChanges = ordered
    .filter((e) => e.kind === 'price_change' && e.oldPrice != null && e.oldPrice > 0 && e.oldPrice !== e.price)
    .map((e) => ({ at: e.at, from: Number(e.oldPrice), to: e.price }));
  return { firstListedAt: first.at, firstListedPrice: first.price, daysOnMarket: days, priceChanges };
}

/** Which way the most recent price change went, or null when the price hasn't changed. */
export function latestPriceMove(history: Pick<ListingHistory, 'priceChanges'> | null | undefined): 'reduced' | 'increased' | null {
  const changes = history?.priceChanges ?? [];
  const last = changes[changes.length - 1];
  if (!last || last.to === last.from) return null;
  return last.to < last.from ? 'reduced' : 'increased';
}

/* ───────────── wording ───────────── */

/** A date as people in the UK write it: "3 Nov 2026" (UK time, whatever the reader's time zone). */
export function historyDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
}

/** £485,000, or £1,250 pcm for a rental. */
export function historyPrice(amount: number, rental = false): string {
  return `£${Math.round(amount).toLocaleString('en-GB')}${rental ? ' pcm' : ''}`;
}

/** "Listed at £485,000 on 3 Nov 2026". */
export function listedLine(history: Pick<ListingHistory, 'firstListedAt' | 'firstListedPrice'>, rental = false): string {
  return `Listed at ${historyPrice(history.firstListedPrice, rental)} on ${historyDate(history.firstListedAt)}`;
}

/**
 * "Reduced by £10,000 (2.1%) on 20 Nov 2026" or "Increased by £5,000 (1.0%) on 2 Dec 2026".
 * The percentage is of the price before the change; it is left out when it would round to 0.0%.
 */
export function priceChangeLine(change: PriceChange, rental = false): string {
  const diff = Math.abs(change.to - change.from);
  const share = change.from > 0 ? (diff / change.from) * 100 : 0;
  const pct = share >= 0.05 ? ` (${share.toFixed(1)}%)` : '';
  return `${change.to < change.from ? 'Reduced' : 'Increased'} by ${historyPrice(diff, rental)}${pct} on ${historyDate(change.at)}`;
}

/**
 * Time on the market as a label and a figure, for a headline number: "On the market for" + "12 days".
 * On the first day: "On the market" + "Listed today". closed: the listing has been sold, let or withdrawn.
 */
export function onMarketParts(days: number, closed = false): { label: string; value: string } {
  const n = Math.max(0, Math.floor(days));
  const label = `${closed ? 'Was on' : 'On'} the market for`;
  if (n === 0) return closed ? { label, value: 'less than a day' } : { label: 'On the market', value: 'Listed today' };
  return { label, value: `${n.toLocaleString('en-GB')} day${n === 1 ? '' : 's'}` };
}

/**
 * "On the market for 12 days" ("Listed today" on the first day). For a listing that has been sold, let
 * or withdrawn (closed): "Was on the market for 12 days".
 */
export function onMarketLine(days: number, closed = false): string {
  const p = onMarketParts(days, closed);
  return p.value === 'Listed today' ? p.value : `${p.label} ${p.value}`;
}
