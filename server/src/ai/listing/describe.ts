/**
 * "Write it for me": a UK portal-style description from the seller's facts only.
 * The model writes; code then enforces the rules (stated prices and figures only, no unverifiable,
 * discriminatory or bidding wording, no claims about schools/transport/neighbours unless given)
 * and supplies the material information itself.
 */
import { z } from 'zod';
import { repeatsStructuredFact } from '../../../../src/engine/listings';
import { chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { factLines, FactsSchema, gbpText, materialInfo, missingFacts, outwardCode, sqft, typeWord, type Facts } from './facts';
import { cleanLines, cleanText, clip, moneyIn, notesProblems, REASON_TEXT, sentences, wordCount, type Reason, type RuleContext } from './wording';

export const TONES = ['warm', 'concise', 'premium', 'investor'] as const;
export type Tone = (typeof TONES)[number];

export const DescribeBody = z.object({
  facts: FactsSchema,
  tone: z.enum(TONES).default('warm'),
  photoInsights: z.array(z.string().trim().min(1).max(80)).max(40).optional().default([]),
  notes: z.string().trim().max(2000).optional().default(''),
});
export type DescribeIn = z.infer<typeof DescribeBody>;

const TONE_GUIDE: Record<Tone, string> = {
  warm: 'Warm and welcoming, everyday language, about 180 to 230 words.',
  concise: 'Concise and factual: short sentences, about 120 to 150 words.',
  premium: 'Polished and elegant, but restrained: describe quality plainly without superlatives, about 180 to 240 words.',
  investor: 'Practical and matter-of-fact, focused on layout, condition, tenure, EPC and running costs as stated. Do not estimate rent, yield, value or costs. About 140 to 200 words.',
};

const DescribeOut = S.obj({
  headline: S.str('Factual portal headline, at most 70 characters, no price'),
  paragraphs: S.arr(S.str(), '2 to 4 paragraphs, 120 to 250 words in total'),
  keyFeatures: S.arr(S.str(), '5 to 8 short bullet points, each a stated fact, under 70 characters'),
  avoided: S.arr(S.str(), 'Wording from the seller’s notes you deliberately left out, with a short reason; empty if none'),
  missingInfo: S.arr(S.str(), 'Up to 4 details people usually ask about that are not in the facts (e.g. parking, heating)'),
});
type DescribeOutT = Infer<typeof DescribeOut>;

export interface DescribeResult {
  headline: string; description: string; keyFeatures: string[]; materialInfo: string[];
  /**
   * The key features that only repeat a structured field (bedrooms, bathrooms, floor area, tenure, EPC,
   * council tax). The listing already shows those from the facts, so they aren't added to the saved features.
   */
  structuredFeatures: string[];
  wordingWarnings: string[]; missingInfo: string[]; wordCount: number; tone: Tone;
}

const RULES = (f: Facts) => [
  'You write UK property portal listings for private sellers and landlords on Streetkey.',
  'Write only from the facts, the seller’s notes and the photo insights provided. Never add anything else: no room sizes, floor levels, layouts, views, orientation, heating, parking, outside space, improvements, ages or dates unless stated.',
  'Never mention schools, transport, shops, parks, neighbours, the community or what the area is like unless the facts or notes mention it, and then only as stated.',
  'Do not write any price, rent, charge or other figure that is not in the facts. Never estimate value, rent, yield, running costs or savings.',
  'Avoid unverifiable superlatives and pressure (“best in the area”, “unbeatable”, “won’t last”, “rare opportunity”, “below market value”). Describe features plainly.',
  'Never say who the home suits or who should live there (for example “ideal for professionals”, “perfect for families”, “would suit a couple”): describe the space instead. Never use discriminatory wording.',
  f.channel === 'rent'
    ? 'This is a letting: state the rent once, as a fixed monthly rent. Never invite offers or bids, never mention tenant fees, and never write “no DSS”, “no benefits”, “professionals only”, “no children” or “no pets”.'
    : 'This is a sale: you may state the asking price once. No pressure or investment claims.',
  'Material information (tenure, lease, charges, council tax band, EPC) is shown separately from the seller’s answers. You may mention it briefly, exactly as given.',
  'Use British English and plain UK portal style: short paragraphs separated as items in "paragraphs", no headings, no emojis, no exclamation marks, no markdown.',
  'Headline: at most 70 characters, factual, no price, e.g. “Three-bedroom terraced house with garden”.',
  'Key features: 5 to 8 short bullets, each a stated fact (no full sentences needed).',
  'If the seller’s notes contain wording you must not use, leave it out and list it under "avoided".',
].join('\n');

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NUM_WORD = ['Studio', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** A factual headline built from the facts (fallback when the model's headline breaks a rule). */
export function factualHeadline(f: Facts): string {
  const base = f.beds === 0
    ? (f.type === 'flat' ? 'Studio flat' : `Studio ${typeWord(f.type)}`)
    : `${NUM_WORD[f.beds] ?? f.beds}-bedroom ${typeWord(f.type)}`;
  const kind = `${base}${f.channel === 'rent' ? ' to rent' : ''}`;
  const extra = f.features.find((x) => /garden|parking|garage|balcony|terrace|en-suite/i.test(x));
  const where = f.town ? ` in ${f.town.split(',')[0].trim()}` : '';
  return [`${kind}${extra ? ` with ${extra.toLowerCase()}` : ''}${where}`, `${kind}${where}`, kind].find((h) => h.length <= 70) ?? clip(kind, 70);
}

/** Short factual bullets (to top up key features): the seller's own features first, as the listing shows the structured facts anyway. */
function factBullets(f: Facts): string[] {
  const b = [
    ...f.features.map((x) => cap(x)),
    f.beds === 0 ? 'Studio' : `${f.beds} bedroom${f.beds === 1 ? '' : 's'}`,
    `${f.baths} bathroom${f.baths === 1 ? '' : 's'}`,
    f.floorArea ? `Approx. ${Math.round(f.floorArea)} m² (${sqft(f.floorArea)} sq ft)` : '',
    f.tenure ? cap(f.tenure.replace(/-/g, ' ')) + (f.tenure !== 'freehold' && f.leaseYears ? `, ${f.leaseYears} years remaining` : '') : '',
    f.epc ? `EPC rating ${f.epc}` : '',
    f.councilTax && f.councilTax !== 'EXEMPT' ? `Council tax band ${f.councilTax}` : '',
  ];
  return b.filter(Boolean);
}

/** Factual sentences used to top up a draft that came out too short after cleaning. */
function factSentences(f: Facts, intro: boolean): string[] {
  const out: string[] = [];
  if (intro) out.push(`${f.beds === 0 ? 'A studio' : `A ${f.beds}-bedroom`} ${typeWord(f.type)} ${f.channel === 'rent' ? 'to rent' : 'for sale'}${f.town ? ` in ${f.town}` : ''}.`);
  if (f.floorArea) out.push(`The accommodation extends to approximately ${Math.round(f.floorArea)} m² (${sqft(f.floorArea)} sq ft).`);
  if (f.tenure) out.push(`The property is ${f.tenure === 'share-of-freehold' ? 'offered with a share of the freehold' : f.tenure}${f.tenure !== 'freehold' && f.leaseYears ? `, with ${f.leaseYears} years remaining on the lease` : ''}.`);
  if (f.epc || f.councilTax) out.push([f.epc ? `It has an EPC rating of ${f.epc}` : '', f.councilTax && f.councilTax !== 'EXEMPT' ? `${f.epc ? 'and is in' : 'It is in'} council tax band ${f.councilTax}` : ''].filter(Boolean).join(' ') + '.');
  return out;
}

/** Wording found in the seller's own notes and deliberately left out. */
const NOTE_TEXT: Partial<Record<Reason, string>> = {
  discrimination: 'Your notes include wording that could discriminate or steer people (such as “no DSS” or “professionals only”), so it was left out.',
  steering: 'Your notes say who the home would suit (such as “ideal for professionals”), so that was left out: describe the home, not who should live there.',
  bidding: 'Your notes mention offers or bidding, so that was left out: a rental advert must state one fixed rent.',
  fees: 'Your notes mention tenant fees, so they were left out: most letting fees are banned under the Tenant Fees Act 2019.',
  pets: 'Your notes include a blanket “no pets” line, which was left out: tenants can ask to keep a pet and landlords must not unreasonably refuse.',
  superlative: 'Your notes include claims that can’t be verified (such as “best in the area”), so they were left out.',
  price: 'Your notes mention a price other than your stated price, so it was left out. Update the price field if it has changed.',
};

/** "fixed rent" / "the rent is fixed" (not "fixed-term tenancy" or "fixed wardrobes"). */
const FIXED_RENT = /\bfixed(?![- ]term)(?:\s+(?:monthly|calendar[- ]month(?:ly)?))?\s+rent\b|\brent\s+(?:is|will\s+be|remains|stays)\s+fixed\b(?![- ]term)/i;
/** Whether the text has a sentence stating the rent, at the stated figure, as fixed. Exported for tests. */
export function statesFixedRent(text: string, price: number): boolean {
  return sentences(text.replace(/\n+/g, ' ')).some((s) => FIXED_RENT.test(s) && moneyIn(s).some((a) => Math.abs(a - price) < 0.005));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dedupe = (xs: string[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = norm(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

/** Applies every rule to the model's draft. Exported for tests. */
export function finalise(out: DescribeOutT, input: DescribeIn): DescribeResult {
  const f = input.facts;
  const ctx: RuleContext = { facts: f, sources: [input.notes, ...input.photoInsights] };
  const reasons = new Set<Reason>();

  // Description: strip sentences that break the rules; keep within 250 words; top up with facts if short.
  const cleaned = cleanText(out.paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n'), ctx);
  cleaned.removed.forEach((r) => reasons.add(r.reason));
  const paras = cleaned.text.split('\n\n').filter(Boolean);
  // Lettings must state the rent as fixed: added if the final text doesn't (room is kept for it within the word limit).
  const fixedRent = f.channel === 'rent' && f.price ? `The rent is fixed at ${gbpText(f.price)} per calendar month.` : '';
  if (wordCount(paras.join(' ')) + (fixedRent && !statesFixedRent(cleaned.text, f.price!) ? wordCount(fixedRent) : 0) < 120) {
    const have = norm(paras.join(' '));
    const extra = factSentences(f, !paras.length).filter((s) => !have.includes(norm(s).slice(0, 30)));
    if (extra.length) paras.push(extra.join(' '));
  }
  // Trim to 250 words at a sentence boundary.
  const limit = 250 - wordCount(fixedRent);
  const trimmed: string[] = [];
  let words = 0;
  outer: for (const p of paras) {
    const keep: string[] = [];
    for (const s of sentences(p)) { const w = wordCount(s); if (words + w > limit) { if (keep.length) trimmed.push(keep.join(' ')); break outer; } keep.push(s); words += w; }
    if (keep.length) trimmed.push(keep.join(' '));
  }
  if (fixedRent && !statesFixedRent(trimmed.join(' '), f.price!)) trimmed.push(fixedRent);
  const description = trimmed.join('\n\n');

  // Headline: rules, then 70 characters.
  const head = cleanLines([out.headline.replace(/[\r\n]+/g, ' ').replace(/[!]+/g, '').trim()], ctx);
  head.removed.forEach((r) => reasons.add(r.reason));
  const headline = head.kept[0] && head.kept[0].length >= 8 ? clip(head.kept[0].replace(/\.$/, ''), 70) : factualHeadline(f);

  // Key features: rules, dedupe, 5 to 8 (topped up from the facts).
  const kf = cleanLines(out.keyFeatures.map((x) => clip(x.replace(/^[-•*\s]+/, '').replace(/\.$/, ''), 80)).filter(Boolean), ctx);
  kf.removed.forEach((r) => reasons.add(r.reason));
  let keyFeatures = dedupe(kf.kept).slice(0, 8);
  if (keyFeatures.length < 5) keyFeatures = dedupe([...keyFeatures, ...factBullets(f)]).slice(0, Math.max(5, keyFeatures.length));

  // Warnings: what code removed, what was avoided from the notes, and the model's own notes.
  const noteReasons = input.notes ? notesProblems(input.notes, f) : [];
  const warnings = [
    ...noteReasons.map((r) => NOTE_TEXT[r] ?? REASON_TEXT[r]),
    ...[...reasons].map((r) => REASON_TEXT[r]),
    ...out.avoided.map((a) => clip(a, 200)).filter(Boolean).map((a) => `Left out from your notes: ${a.replace(/^left out:?\s*/i, '')}`),
  ];
  const missing = dedupe([...missingFacts(f), ...out.missingInfo.map((m) => clip(m, 100))]).slice(0, 8);

  return {
    headline, description, keyFeatures, materialInfo: materialInfo(f), structuredFeatures: keyFeatures.filter(repeatsStructuredFact),
    wordingWarnings: dedupe(warnings).slice(0, 10), missingInfo: missing, wordCount: wordCount(description), tone: input.tone,
  };
}

export async function describeListing(input: DescribeIn, meta: { userId?: string | null }): Promise<DescribeResult> {
  const f = input.facts;
  const user = [
    untrusted('listing_facts', factLines(f)),
    input.notes ? untrusted('seller_notes', input.notes, 2000) : 'Seller’s notes: none.',
    input.photoInsights.length ? untrusted('photo_insights', `Visible in the seller’s photos (labels from an automatic check):\n${input.photoInsights.join('\n')}`, 3000) : '',
    `Tone: ${TONE_GUIDE[input.tone]}`,
    `Area to name, if any: ${[f.town, outwardCode(f)].filter(Boolean).join(', ') || 'none given'}.`,
    'Write the listing.',
  ].filter(Boolean).join('\n\n');
  const out = await chatJSON<DescribeOutT>([
    { role: 'system', content: `${HOUSE_RULES}\n\n${RULES(f)}` },
    { role: 'user', content: user },
  ], DescribeOut, 'listing_description', { purpose: 'listing.describe', userId: meta.userId, role: 'main', maxTokens: 2500, effort: 'low' });
  return finalise(out, input);
}
