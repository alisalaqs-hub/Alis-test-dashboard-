/**
 * Listing performance insights for listers. Every figure is computed here, in code, from the
 * database (consented analytics, saves, enquiries, photos) and Streetkey's own area evidence
 * engine; the model only explains and prioritises. Its text is checked: any sentence that uses a
 * number not in the stats is dropped (and replaced by the rule-based version where needed).
 */
import { areaEvidence } from '../../../../src/engine/listings';
import { chatJSON, HOUSE_RULES, modelFor, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one, q } from '../../db';
import { checksFor, type ListingRow } from '../../services/listings';
import { clip } from './shared';

export interface PhotoQuality { analysed: number; averageScore: number | null; weak: number; issues: string[] }
export interface PriceEvidence { low: number; high: number; position: 'below' | 'within' | 'above'; diffPct: number; scope: string; comparables: number }
export interface InsightStats {
  ref: string; channel: 'sale' | 'rent'; status: string; price: number;
  views30d: number; visitors30d: number; saves: number; enquiries30d: number; enquiriesTotal: number; viewingRequests30d: number;
  photoOpens30d: number; shares30d: number; enquiryRatePct: number | null; daysOnMarket: number | null;
  photoCount: number; photoQuality: PhotoQuality | null; descriptionWords: number; featureCount: number;
  missingInfo: string[]; priceEvidence: PriceEvidence | null;
}
export interface Improvement { action: string; why: string; impact: 'high' | 'medium' | 'low' }
export interface ListingInsights { headline: string; whatsWorking: string[]; whatToImprove: Improvement[]; priceNote: string | null; stats: InsightStats; generatedAt: string; model: string | null }

/* ───────── stats (code) ───────── */
let aiQualityColumn: { at: number; exists: boolean } | null = null;
/** listing_photos.ai_quality is added by the photo-analysis feature; use it only if it exists. */
async function hasAiQuality() {
  if (aiQualityColumn && Date.now() - aiQualityColumn.at < 10 * 60_000) return aiQualityColumn.exists;
  const r = await one<{ n: number }>(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'listing_photos' AND column_name = 'ai_quality'`).catch(() => null);
  aiQualityColumn = { at: Date.now(), exists: (r?.n ?? 0) > 0 };
  return aiQualityColumn.exists;
}
export const resetInsightCaches = () => { aiQualityColumn = null; };

/** Reads whatever shape the photo analysis stored (a number, or an object with a score and issues). */
export function summarisePhotoQuality(values: unknown[]): PhotoQuality | null {
  const scores: number[] = []; const issues: string[] = [];
  for (let v of values) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
    let score: unknown = null;
    if (typeof v === 'number') score = v;
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      score = o.score ?? o.quality ?? o.overall ?? o.rating;
      for (const key of ['issues', 'problems', 'improvements', 'suggestions']) {
        const list = o[key];
        if (Array.isArray(list)) {
          for (const i of list) if (typeof i === 'string' && i.trim()) issues.push(clip(i, 80));
        } else if (typeof list === 'string' && list.trim()) issues.push(clip(list, 80));
      }
    }
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0) scores.push(score > 0 && score < 1 ? score * 10 : score <= 10 ? score : score <= 100 ? score / 10 : 10);
  }
  if (!scores.length && !issues.length) return null;
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.toLowerCase(), (counts.get(i.toLowerCase()) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => issues.find((i) => i.toLowerCase() === k)!);
  return {
    analysed: values.length,
    averageScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    weak: scores.filter((s) => s < 5).length, issues: top,
  };
}

/** The same indicative range the listing form shows ("Price guide"), from Streetkey's area evidence. */
export function priceEvidenceFor(r: Pick<ListingRow, 'postcode' | 'channel' | 'floor_area' | 'condition' | 'price' | 'property_type'>): PriceEvidence | null {
  if (r.property_type === 'commercial') return null;
  const ev = areaEvidence(r.postcode);
  if (!ev) return null;
  const condAdj = ({ good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 } as Record<string, number>)[r.condition ?? 'fair'] ?? 0.9;
  const [low, high] = r.channel === 'rent'
    ? [Math.round((ev.rentPerM2 * r.floor_area * 0.92) / 25) * 25, Math.round((ev.rentPerM2 * r.floor_area * 1.08) / 25) * 25]
    : [Math.round((ev.refurbishedPerM2 * r.floor_area * condAdj * 0.92) / 1000) * 1000, Math.round((ev.refurbishedPerM2 * r.floor_area * condAdj * 1.08) / 1000) * 1000];
  if (!(low > 0 && high > low)) return null;
  const mid = (low + high) / 2;
  const position = r.price > high ? 'above' : r.price < low ? 'below' : 'within';
  return { low, high, position, diffPct: Math.round(((r.price - mid) / mid) * 1000) / 10, scope: ev.scope, comparables: ev.n };
}

export async function computeStats(row: ListingRow): Promise<InsightStats> {
  const [ev, enq, saves, photos] = await Promise.all([
    one<{ views: number; visitors: number; photo_opens: number; shares: number }>(
      `SELECT count(*) FILTER (WHERE name = 'listing_view')::int AS views, count(DISTINCT session_id) FILTER (WHERE name = 'listing_view')::int AS visitors,
              count(*) FILTER (WHERE name = 'photo_open')::int AS photo_opens, count(*) FILTER (WHERE name = 'share')::int AS shares
         FROM engagement_events WHERE listing_id = $1 AND occurred_at > now() - interval '30 days'`, [row.id]),
    one<{ total: number; d30: number; viewings: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30,
              count(*) FILTER (WHERE kind = 'viewing' AND created_at > now() - interval '30 days')::int AS viewings
         FROM enquiries WHERE listing_id = $1 AND NOT filtered`, [row.id]),
    one<{ n: number }>('SELECT count(*)::int n FROM saved_listings WHERE listing_key = $1', [row.ref]),
    one<{ n: number }>('SELECT count(*)::int n FROM listing_photos WHERE listing_id = $1', [row.id]),
  ]);
  let photoQuality: PhotoQuality | null = null;
  if (await hasAiQuality()) {
    const vals = await q<{ v: unknown }>('SELECT ai_quality AS v FROM listing_photos WHERE listing_id = $1 AND ai_quality IS NOT NULL ORDER BY position LIMIT 60', [row.id]).catch(() => []);
    photoQuality = summarisePhotoQuality(vals.map((x) => x.v));
  }
  const views = ev?.views ?? 0;
  const photoCount = photos?.n ?? 0;
  const words = (row.description ?? '').trim().split(/\s+/).filter(Boolean).length;
  return {
    ref: row.ref, channel: row.channel, status: row.status, price: row.price,
    views30d: views, visitors30d: ev?.visitors ?? 0, saves: saves?.n ?? 0,
    enquiries30d: enq?.d30 ?? 0, enquiriesTotal: enq?.total ?? 0, viewingRequests30d: enq?.viewings ?? 0,
    photoOpens30d: ev?.photo_opens ?? 0, shares30d: ev?.shares ?? 0,
    enquiryRatePct: views >= 20 ? Math.round(((enq?.d30 ?? 0) / views) * 1000) / 10 : null,
    daysOnMarket: row.published_at ? Math.max(0, Math.floor((Date.now() - row.published_at.getTime()) / 86_400_000)) : null,
    photoCount, photoQuality, descriptionWords: words, featureCount: (row.features ?? []).length,
    // Material information and legal checks (photos are covered by their own figures).
    missingInfo: checksFor(row, photoCount).filter((c) => !c.ok && c.id !== 'photos' && c.id !== 'photo-min').map((c) => c.message).slice(0, 6),
    priceEvidence: priceEvidenceFor(row),
  };
}

/* ───────── rule-based reading (code) ───────── */
const fmtGbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const priceText = (s: InsightStats, n: number) => (s.channel === 'rent' ? `${fmtGbp(n)} pcm` : fmtGbp(n));

export function ruleHints(s: InsightStats): Improvement[] {
  const out: Improvement[] = [];
  if (s.missingInfo.length) out.push({ action: 'Add the missing material information', why: s.missingInfo[0], impact: 'high' });
  if (s.photoCount < 3) out.push({ action: 'Add more photos, covering every main room and the outside', why: `The listing has ${s.photoCount} photo${s.photoCount === 1 ? '' : 's'}. Buyers want to see every main room and the outside before they enquire.`, impact: 'high' });
  else if (s.photoCount < 8) out.push({ action: 'Add a few more photos', why: `The listing has ${s.photoCount} photos. Buyers like to see every room before they enquire.`, impact: 'medium' });
  if (s.photoQuality && s.photoQuality.weak > 0) out.push({ action: 'Retake or replace the weaker photos', why: `${s.photoQuality.weak} photo${s.photoQuality.weak === 1 ? ' was' : 's were'} rated low by the photo check${s.photoQuality.issues[0] ? ` (e.g. ${s.photoQuality.issues[0]})` : ''}.`, impact: 'medium' });
  if (s.descriptionWords < 80) out.push({ action: 'Write a fuller description', why: `It has ${s.descriptionWords} words. Describe the layout, light, storage, outside space and transport links.`, impact: s.descriptionWords < 30 ? 'high' : 'medium' });
  if (s.priceEvidence?.position === 'above') out.push({ action: 'Compare your price with similar homes nearby', why: `It is above the indicative ${priceText(s, s.priceEvidence.low)}–${priceText(s, s.priceEvidence.high)} range from ${s.priceEvidence.scope} evidence.`, impact: 'high' });
  if (s.views30d >= 50 && s.enquiries30d === 0) out.push({ action: 'Look at why viewers aren’t enquiring', why: `${s.views30d} views in 30 days but no enquiries: the price, photos or missing details may be putting people off.`, impact: 'high' });
  if (s.views30d < 20 && (s.daysOnMarket ?? 0) >= 14) out.push({ action: 'Share the listing link', why: `${s.views30d} views in the last 30 days. Sharing it on social media and with local groups helps.`, impact: 'medium' });
  if (s.featureCount < 4) out.push({ action: 'List more key features', why: `There ${s.featureCount === 1 ? 'is 1 feature' : `are ${s.featureCount} features`} listed. Buyers filter by features such as parking and garden.`, impact: 'low' });
  return out.slice(0, 5);
}
export function ruleWorking(s: InsightStats): string[] {
  const out: string[] = [];
  if (s.saves >= 3) out.push(`${s.saves} people have saved it.`);
  if (s.enquiryRatePct != null && s.enquiryRatePct >= 2) out.push(`${s.enquiryRatePct}% of views turned into enquiries in the last 30 days.`);
  if (s.viewingRequests30d > 0) out.push(`${s.viewingRequests30d} viewing request${s.viewingRequests30d === 1 ? '' : 's'} in the last 30 days.`);
  if (s.photoCount >= 8) out.push(`A good set of ${s.photoCount} photos.`);
  if (s.descriptionWords >= 150) out.push('A detailed description.');
  if (!s.missingInfo.length) out.push('All the required material information is there.');
  if (s.priceEvidence?.position === 'within') out.push('The price sits within the indicative range for similar homes.');
  return out.slice(0, 4);
}
export function rulePriceNote(s: InsightStats): string | null {
  const e = s.priceEvidence;
  if (!e) return null;
  const range = `${priceText(s, e.low)}–${priceText(s, e.high)}`;
  const where = e.position === 'within' ? 'within' : e.position === 'above' ? 'above' : 'below';
  return `Your ${s.channel === 'rent' ? 'rent' : 'asking price'} of ${priceText(s, s.price)} is ${where} the indicative ${range} range from ${e.scope} evidence (${e.comparables} comparable${e.comparables === 1 ? '' : 's'}). This is a guide from Streetkey’s demo evidence, not a valuation.`;
}
export function ruleHeadline(s: InsightStats): string {
  if (s.missingInfo.length) return 'Some required details are missing, which can hold buyers back.';
  if (s.views30d >= 50 && s.enquiries30d === 0) return 'Plenty of people are looking, but nobody has enquired yet.';
  if (s.enquiries30d > 0) return `${s.enquiries30d} enquir${s.enquiries30d === 1 ? 'y' : 'ies'} in the last 30 days.`;
  if (s.views30d === 0) return 'No tracked views yet in the last 30 days.';
  return `${s.views30d} views in the last 30 days.`;
}

/* ───────── number checks ───────── */
export function allowedNumbers(s: InsightStats): number[] {
  const out: number[] = [s.price, s.price / 1000, s.views30d, s.visitors30d, s.saves, s.enquiries30d, s.enquiriesTotal, s.viewingRequests30d, s.photoOpens30d, s.shares30d,
    s.photoCount, s.descriptionWords, s.featureCount, 30, 28, 7, 14, 3, 8];
  if (s.enquiryRatePct != null) out.push(s.enquiryRatePct, Math.round(s.enquiryRatePct));
  if (s.daysOnMarket != null) out.push(s.daysOnMarket, Math.round(s.daysOnMarket / 7));
  if (s.photoQuality) { out.push(s.photoQuality.analysed, s.photoQuality.weak); if (s.photoQuality.averageScore != null) out.push(s.photoQuality.averageScore, 10); }
  if (s.priceEvidence) { const e = s.priceEvidence; out.push(e.low, e.high, e.low / 1000, e.high / 1000, Math.abs(e.diffPct), Math.round(Math.abs(e.diffPct)), e.comparables); }
  if (s.views30d > 0) out.push(Math.round(s.saves / s.views30d * 100));
  return out.filter((n) => Number.isFinite(n));
}
/**
 * A small count is fine without being in the stats only when it counts something on the listing
 * itself ("Add 2 more photos", "3 key features"), never time ("within 9 days", "in 3 weeks").
 */
const COUNTED_AFTER = /^\s*(?:(?:or|to|-|–)\s*\d{1,2}\s+)?(?:(?:more|extra|further|new|additional|good|great|clear|bright|key|outdoor|outside|garden|kitchen|interior|exterior|room|daylight|landscape|professional|quality)\s+){0,2}(?:photo(?:graph)?s?|pictures?|images?|features?|enquir(?:y|ies)|views?|viewers?|visitors?|saves?|shares?|viewings?|bedrooms?|bathrooms?|rooms?)\b/i;
/** True if every number in the text is one of the given figures (or a small count of photos, features, views…). */
export function numbersOk(text: string, allowed: number[]): boolean {
  for (const m of text.matchAll(/(£)?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s?(k\b|m\b|million\b|%)?/gi)) {
    let v = Number(m[2].replace(/,/g, ''));
    const unit = m[3]?.toLowerCase();
    if (unit === 'k') v *= 1000; else if (unit === 'm' || unit === 'million') v *= 1_000_000;
    if (allowed.some((a) => Math.abs(v - a) <= Math.max(0.6, Math.abs(a) * 0.01))) continue;
    if (!m[1] && !unit && Number.isInteger(v) && v <= 10 && COUNTED_AFTER.test(text.slice(m.index! + m[0].length))) continue;
    return false;
  }
  return true;
}

/**
 * Predictions and comparisons Streetkey has no data for: how soon it will sell or let, what a change
 * "will" bring, or how it does against other listings. Text like this is dropped whatever its numbers.
 */
const SPECULATIVE = /\bexpect\w*\s+(?:an?\s|more\b|offers?\b|bids?\b|interest\b|enquir|viewings?\b|views?\b|to\s+(?:sell|let|get|receive|attract|achieve|see\s+(?:more|an?|offers?)))|\bwill\s+(?:\w+\s+)?(?:sell|let|get|receive|attract|bring|generate|increase|boost|double|triple|lead to)\b|\b(?:likely|certain|sure|guaranteed|bound)\s+to\s+(?:sell|let|get|receive|attract|go)\b|\bwithin\s+(?:\d+|a|an|one|two|three|four|five|six|a few|a couple of)\s+(?:days?|weeks?|months?)\b|\b(?:sells?|lets?|sold|let|selling|letting|goes)\s+(?:in|within)\s+(?:under\s+|less than\s+)?(?:\d+|a|an|one|two|three|four|five|six|a few|a couple of)\s+(?:days?|weeks?|months?)\b|\bfaster\b|\bquicker\b|\b\d+(?:\.\d+)?\s?x\b|\b(?:twice|three times|\d+ times)\b|\btimes (?:more|faster|as many|as likely)\b|\boutperform\w*|\b(?:better|worse) than (?:similar|other|most|average|comparable)\b|\b(?:similar|other|comparable) (?:homes|listings|properties|houses|flats) (?:sell|let|get|receive|attract|go|do)\b|\blistings like yours\b|\bon average\b|\baverage (?:listing|home|property)\b/i;
export const speculative = (text: string) => SPECULATIVE.test(text);

/* ───────── AI explanation ───────── */
const InsightSchema = S.obj({
  headline: S.str('One sentence on how the listing is doing, under 20 words'),
  whatsWorking: S.arr(S.str('Something that is going well, under 20 words')),
  whatToImprove: S.arr(S.obj({
    action: S.str('A specific thing the lister can do, under 12 words'),
    why: S.str('Why, citing the stats, under 30 words'),
    impact: S.enum(['high', 'medium', 'low'] as const),
  })),
  priceNote: S.nullable(S.str('One or two sentences comparing the price with the indicative range given, or null if there is no range')),
});
type InsightOut = Infer<typeof InsightSchema>;

const SYSTEM = [
  HOUSE_RULES,
  'You explain how a UK property listing is performing to the person marketing it (a private seller, landlord or agent), and what would most improve it.',
  'Use only the figures in STATS, written exactly as given. Do not calculate new figures, estimate values or predict sale prices or timescales.',
  'Never say what a change will achieve ("will sell faster", "expect more enquiries") and never compare this listing with other listings or an average: Streetkey has no data for that. Describe what the lister can do and why, from STATS.',
  'Prioritise: legally required material information first, then photos and description, then price presentation. At most 4 points in whatsWorking and 5 in whatToImprove; leave a list empty rather than pad it.',
  'priceNote: compare the price only with the indicative range in STATS and say it is an indicative guide from Streetkey’s evidence, not a valuation. Never tell them what price to set, and never call it a valuation.',
  'Visitor counts include only people who allowed analytics, so treat small numbers with caution and say so if relevant.',
  'Never suggest wording that would discriminate (for example about families, benefits or nationality), and never suggest misleading claims.',
].join('\n');

export async function explainInsights(row: ListingRow, stats: InsightStats, userId: string): Promise<ListingInsights> {
  const listingText = { title: row.title, type: row.property_type, beds: row.beds, features: (row.features ?? []).slice(0, 20), description: clip(row.description, 1500) };
  const hints = ruleHints(stats);
  const out = await chatJSON<InsightOut>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [
      `STATS (computed by Streetkey; last 30 days unless stated):\n${JSON.stringify(stats, null, 1)}`,
      `Checks Streetkey's rules already suggest (use, reword or reorder them; add others only if the stats support them):\n${JSON.stringify(hints)}`,
      untrusted('listing', JSON.stringify(listingText), 3000),
    ].join('\n\n') },
  ], InsightSchema, 'listing_insights', { purpose: 'inbox.insights', userId, role: 'main', maxTokens: 1800, effort: 'low' });

  const allowed = allowedNumbers(stats);
  /** Every number comes from the stats, and nothing predicts results or compares with other listings. */
  const ok = (t: string) => numbersOk(t, allowed) && !speculative(t);
  const working = out.whatsWorking.map((x) => clip(x, 200)).filter((x) => x && ok(x)).slice(0, 4);
  const improve = out.whatToImprove
    .map((x) => ({ action: clip(x.action, 120), why: clip(x.why, 260), impact: x.impact }))
    .filter((x) => x.action && ok(x.action) && ok(x.why)).slice(0, 5);
  const headline = clip(out.headline, 200);
  // The price note must stay an indicative comparison: never a valuation or a price recommendation.
  const callsItValuation = (t: string) => /\bvaluation\b|\bvalued at\b|\bis worth\b|\byou should (set|ask|price|list)\b/i.test(t.replace(/\bnot an? (formal |RICS |official )?valuation\b/gi, ''));
  const priceNote = stats.priceEvidence ? (out.priceNote && ok(out.priceNote) && !callsItValuation(out.priceNote) ? clip(out.priceNote, 400) : rulePriceNote(stats)) : null;
  return {
    headline: headline && ok(headline) ? headline : ruleHeadline(stats),
    whatsWorking: working.length ? working : ruleWorking(stats),
    whatToImprove: improve.length ? improve : hints,
    priceNote,
    stats, generatedAt: new Date().toISOString(), model: await modelFor('main'),
  };
}
