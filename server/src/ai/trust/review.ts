/**
 * The listing trust review (a background job):
 *   1. content moderation of the text and of each photo (one image per call, at most 12)
 *   2. signals computed in code: price vs area evidence, missing material information,
 *      duplicated descriptions, contact details and payment requests, discriminatory wording
 *   3. an AI review (role 'main') that weighs those signals with the listing facts
 *   4. hard rules in code, so the AI can raise risk but never talk it down
 *   5. optional auto-approval of clearly low-risk listings (AI_AUTO_APPROVE_LOW_RISK); never auto-rejection
 * If the AI review can't run (daily budget reached, refusal, bad output, or a transient fault on the last
 * attempt), a rules-only review is stored instead, so risky listings still rise to the top of the queue.
 * Figures shown to people come from the database or Streetkey's engines; the AI only explains.
 */
import { createHash } from 'node:crypto';
import { one, q, tx } from '../../db';
import { mails } from '../../services/email';
import { audit } from '../../services/http';
import { checksFor, LISTING_SELECT, type ListingRow } from '../../services/listings';
import { getFile } from '../../services/storage';
import { AiError, cached, chatJSON, dataUrl, HOUSE_RULES, modelFor, moderate, untrusted, type Message } from '../core';
import { emit } from '../hooks';
import { S, type Infer } from '../schema';
import * as sig from './signals';
import { AUTO_APPROVE_MAX_SCORE, autoApproveEnabled } from './store';

export const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const RETRIABLE = new Set(['ai_timeout', 'ai_network', 'ai_upstream', 'ai_busy']);
/** How much listing text the model reads: the whole of what a listing may hold (ListingBody: title 120, description 8000, 30 features of 60). */
const TEXT_LIMITS = { title: 200, description: 8000, features: 2000 } as const;

/** Plain names for the FACTS and SIGNALS keys the model may cite as evidence instead of a quote. */
const SIGNAL_NAMES: Record<string, string> = {
  priceVsArea: 'price compared with the area', textModeration: 'text moderation', photoModeration: 'photo moderation',
  failingChecks: 'listing checks', duplicateDescriptions: 'duplicated descriptions', contactDetailsFound: 'contact details found',
  paymentRequestsFound: 'payment requests found', scamWordingFound: 'scam wording found', discriminatoryWordingFound: 'discriminatory wording found',
  descriptionWords: 'description length', price: 'asking price', priceUnit: 'asking price', priceQualifier: 'price qualifier', channel: 'sale or rent',
  status: 'listing status', propertyType: 'property type', tenure: 'tenure', leaseYearsRemaining: 'lease length', beds: 'bedrooms', baths: 'bathrooms',
  floorAreaM2: 'floor area', era: 'age of the property', condition: 'condition', epc: 'EPC rating', councilTaxBand: 'council tax band',
  serviceChargeAnnual: 'service charge', groundRentAnnual: 'ground rent', town: 'town', postcodeDistrict: 'postcode district', listedBy: 'who listed it',
  ownershipDeclared: 'ownership declaration', ownershipVerified: 'ownership verification', photos: 'number of photos',
};

export const ReviewSchema = S.obj({
  risk: S.enum(['low', 'medium', 'high'] as const, 'Overall risk that this listing should not be published as it stands.'),
  score: S.int('Risk score 0–100: low 0–29, medium 30–69, high 70–100.'),
  flags: S.arr(S.obj({
    type: S.enum(sig.FLAG_TYPES),
    severity: S.enum(['high', 'medium', 'low'] as const),
    detail: S.str('One plain sentence for the admin: what the concern is and why it matters.'),
    evidence: S.str('A short exact quote from the listing text, or the name of the signal relied on.'),
  }), 'Concerns, most serious first. Empty if there are none.'),
  summary: S.str('Two or three sentences for the admin reviewing the listing.'),
  suggestedReason: S.nullable(S.str('If changes are needed: a polite, specific message to the lister saying what to change. Otherwise null.')),
});
type ModelReview = Infer<typeof ReviewSchema>;

const TRUST_RULES = [
  'You help Streetkey’s trust and safety team review UK property listings before they are published. You advise a human reviewer: you never approve or reject anything.',
  'Look for: scams (a price far below the area, payment requested before a viewing or by bank transfer, crypto or gift cards, a lister who is abroad, keys sent by post, no viewings); misleading claims (Consumer Protection from Unfair Trading Regulations 2008 and the Digital Markets, Competition and Consumers Act 2024: claims the facts contradict, or important omissions); discrimination (Equality Act 2010: excluding people by race, nationality, religion, sex, sexual orientation, disability or pregnancy; "No DSS" or no children); missing material information (National Trading Standards: price, council tax, tenure, lease length, service charge and ground rent for leaseholds, EPC); rentals: fees banned by the Tenant Fees Act 2019 (such as viewing or admin fees) and inviting bids above the advertised rent; photo problems; contact details or off-platform payment; duplicated text.',
  'Base everything on FACTS, SIGNALS and the listing text. SIGNALS were computed by Streetkey’s code and are reliable. Do not invent figures: only mention amounts or percentages that appear in FACTS, SIGNALS or the listing text. A low price on its own is not proof of fraud; say what an admin should check.',
  'Never speculate about the lister’s identity, background or characteristics. Be fair: ordinary, honest listings should score low with no flags.',
  'suggestedReason: write to the lister as "you", in British English, under 120 words: thank them, then say exactly what to change. Be polite and never accuse them of fraud. Do not mention scores, risk levels, AI or internal checks, do not give legal advice, and never include contact details or links. Use null when nothing needs to change.',
].join('\n');

export interface ReviewOutput {
  reviewId: string | null; risk: sig.Risk | null; score: number | null; autoApproved: boolean; skipped?: string;
  /** The AI review couldn't run, so the stored review comes from Streetkey's automatic rules only. */
  rulesOnly?: boolean;
}

type Row = ListingRow & { version: string; owner_email: string | null; owner_verified: boolean };
interface PhotoRow { id: string; storage_key: string; content_type: string; bytes: number; position: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (s: string | null | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

class MissingFile extends Error {}

/**
 * The AI fault to record as "not checked", or null when the error must end this attempt instead: anything that
 * isn't an AI fault, or a transient AI fault while the job still has attempts left (the job then retries).
 */
const recordable = (e: unknown, finalAttempt: boolean): AiError | null => (e instanceof AiError && (!RETRIABLE.has(e.code) || finalAttempt) ? e : null);

async function moderatePhoto(p: PhotoRow, index: number, meta: { purpose: string; userId: string | null }, finalAttempt: boolean): Promise<sig.Signals['moderation']['photos'][number]> {
  const base = { photoId: p.id, position: index + 1 };
  if (p.bytes > MAX_PHOTO_BYTES) return { ...base, checked: false, flagged: false, categories: [], note: 'Too large to check automatically.' };
  try {
    // Photos never change once stored, so a result per stored file can be reused (e.g. on a re-check).
    const r = await cached(`trust.photo:${p.storage_key}`, 30 * 86_400, async () => {
      const bytes = await getFile(p.storage_key);
      if (!bytes) throw new MissingFile();
      const m = await moderate({ images: [dataUrl(bytes, p.content_type)] }, meta);
      return { flagged: m.flagged, categories: m.categories };
    });
    return { ...base, checked: true, flagged: r.flagged, categories: r.categories };
  } catch (e) {
    if (e instanceof MissingFile) return { ...base, checked: false, flagged: false, categories: [], note: 'The photo file could not be found.' };
    if (!recordable(e, finalAttempt)) throw e;
    return { ...base, checked: false, flagged: false, categories: [], note: 'Could not be checked automatically.' };
  }
}

async function findDuplicates(row: Row): Promise<sig.Signals['duplicates']> {
  const desc = row.description ?? '';
  if (sig.words(desc).length < sig.DUPLICATE_MIN_WORDS) return [];
  const terms = sig.searchTerms(desc);
  if (terms.length < 3) return [];
  const tsq = terms.join(' | ');
  // Candidates come from the full-text index (bounded), then exact overlap is measured in code.
  const rows = await q<{ ref: string; owner_user_id: string | null; organisation_id: string | null; status: string; description: string }>(
    `SELECT ref, owner_user_id, organisation_id, status, description FROM listings
      WHERE id <> $1 AND status <> 'draft' AND description IS NOT NULL AND search @@ to_tsquery('english', $2)
      ORDER BY ts_rank(search, to_tsquery('english', $2)) DESC LIMIT 25`, [row.id, tsq]);
  const mine = sig.shingles(desc);
  return rows
    .map((r) => ({ r, similarity: sig.overlap(mine, sig.shingles(r.description)) }))
    .filter((x) => x.similarity >= sig.DUPLICATE_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map(({ r, similarity }) => ({
      ref: r.ref, status: r.status, similarity: Math.round(similarity * 100) / 100,
      sameLister: !!((row.owner_user_id && r.owner_user_id === row.owner_user_id) || (row.organisation_id && r.organisation_id === row.organisation_id)),
    }));
}

const SEV_RANK: Record<sig.Severity, number> = { high: 2, medium: 1, low: 0 };

/** Runs the whole review for one listing and stores it. */
export async function reviewListing(listingId: string, o: {
  trigger: 'submitted' | 'admin'; userId: string | null; progress?: (t: string) => Promise<void>;
  /** False while the job still has attempts left (a transient AI fault then retries the job instead of falling back to rules). */
  finalAttempt?: boolean;
}): Promise<ReviewOutput> {
  const progress = o.progress ?? (async () => {});
  const finalAttempt = o.finalAttempt !== false;
  const row = await one<Row>(
    `SELECT x.*, x.updated_at::text AS version, ou.email AS owner_email, (ou.email_verified_at IS NOT NULL AND ou.deleted_at IS NULL) AS owner_verified
       FROM (${LISTING_SELECT} WHERE l.id = $1) x LEFT JOIN users ou ON ou.id = x.owner_user_id`, [listingId]);
  const none = (skipped: string): ReviewOutput => ({ reviewId: null, risk: null, score: null, autoApproved: false, skipped });
  if (!row) return none('The listing no longer exists.');
  if (o.trigger === 'submitted' && !['pending', 'live', 'under_offer'].includes(row.status)) return none('The listing is no longer submitted.');

  const photoTotal = (await one<{ n: number }>('SELECT count(*)::int n FROM listing_photos WHERE listing_id = $1', [row.id]))!.n;
  const photos = await q<PhotoRow>('SELECT id, storage_key, content_type, bytes, position FROM listing_photos WHERE listing_id = $1 ORDER BY position, created_at LIMIT $2', [row.id, MAX_PHOTOS]);
  const features = (row.features ?? []).join('. ');
  const listingText = [row.title ?? '', row.description ?? '', features].filter(Boolean).join('\n');
  // Belt and braces: if the model ever reads less than the whole listing, the listing can't be auto-approved.
  const clipped = (row.title ?? '').length > TEXT_LIMITS.title || (row.description ?? '').length > TEXT_LIMITS.description || features.length > TEXT_LIMITS.features;

  /* 1. moderation */
  await progress('Checking the text and photos…');
  const modMeta = { purpose: 'trust.moderation', userId: o.userId };
  let textMod: { flagged: boolean; categories: string[] } | null = null;
  if (listingText.trim()) {
    try {
      textMod = await cached(`trust.text:${sha(listingText)}`, 7 * 86_400, async () => { const m = await moderate({ text: listingText }, modMeta); return { flagged: m.flagged, categories: m.categories }; });
    } catch (e) {
      if (!recordable(e, finalAttempt)) throw e;
    }
  }
  const photoMod = await mapLimit(photos, 3, (p, i) => moderatePhoto(p, i, modMeta, finalAttempt));

  /* 2. signals in code */
  await progress('Comparing with similar listings…');
  const checks = checksFor(row, photoTotal);
  const signals: sig.Signals = {
    moderation: { text: { checked: !!textMod, flagged: !!textMod?.flagged, categories: textMod?.categories ?? [] }, photos: photoMod, photoTotal },
    price: sig.priceSignal(row),
    failingChecks: checks.filter((c) => !c.ok).map((c) => ({ ...c, type: sig.typeForCheck(c.id) })),
    duplicates: await findDuplicates(row),
    contacts: sig.contactDetails(listingText),
    payments: sig.paymentRequests(listingText),
    scamPhrases: sig.scamPhrases(listingText),
    discrimination: sig.discriminatoryWording(listingText),
    blockingChecksPass: checks.every((c) => c.ok || c.severity !== 'block'),
    wordCount: sig.words(row.description ?? '').length,
  };

  /* 3. AI review */
  await progress('Reviewing the listing…');
  const facts = {
    ref: row.ref, channel: row.channel, status: row.status, propertyType: row.property_type, tenure: row.tenure, leaseYearsRemaining: row.lease_years,
    beds: row.beds, baths: row.baths, floorAreaM2: Number(row.floor_area), era: row.era, condition: row.condition,
    price: Number(row.price), priceUnit: row.channel === 'rent' ? '£ per calendar month' : '£', priceQualifier: row.price_qualifier,
    epc: row.epc, councilTaxBand: row.council_tax, serviceChargeAnnual: row.service_charge_annual, groundRentAnnual: row.ground_rent_annual,
    town: row.town, postcodeDistrict: row.district, listedBy: row.source_kind, ownershipDeclared: row.ownership_declared, ownershipVerified: row.ownership_verified,
    photos: photoTotal,
  };
  const p = signals.price;
  const forModel = {
    priceVsArea: p.checked
      ? { typicalFrom: p.typicalLow, typicalTo: p.typicalHigh, unit: p.channel === 'rent' ? '£ pcm' : '£', percentBelowTypical: p.belowPct, percentAboveTypical: p.abovePct, farBelow: p.farBelow, wellAbove: p.wellAbove, evidence: p.scope, referenceListings: p.comparables ?? null }
      : { checked: false, reason: p.reason === 'commercial' ? 'commercial property' : 'no area evidence for this postcode' },
    textModeration: textMod ? { flagged: textMod.flagged, categories: textMod.categories } : listingText.trim() ? 'not checked' : 'no text',
    photoModeration: { checked: photoMod.filter((x) => x.checked).length, notChecked: photoMod.filter((x) => !x.checked).length, flagged: photoMod.filter((x) => x.flagged).map((x) => ({ photo: x.position, categories: x.categories })) },
    failingChecks: signals.failingChecks.map((c) => ({ id: c.id, severity: c.severity, message: c.message })),
    duplicateDescriptions: signals.duplicates.map((d) => ({ similarityPercent: Math.round(d.similarity * 100), sameLister: d.sameLister })),
    contactDetailsFound: signals.contacts.map((c) => ({ kind: c.label, masked: sig.mask(c.text) })),
    paymentRequestsFound: signals.payments.map((x) => x.label),
    scamWordingFound: signals.scamPhrases.map((x) => x.label),
    discriminatoryWordingFound: signals.discrimination.map((x) => x.label),
    descriptionWords: signals.wordCount,
  };
  const messages: Message[] = [
    { role: 'system', content: `${HOUSE_RULES}\n${TRUST_RULES}` },
    { role: 'user', content: [
      'FACTS (from Streetkey’s database):', JSON.stringify(facts),
      'SIGNALS (computed by Streetkey’s code):', JSON.stringify(forModel),
      'LISTING TEXT (written by the lister):',
      untrusted('listing_title', row.title ?? '', TEXT_LIMITS.title),
      untrusted('listing_description', row.description ?? '', TEXT_LIMITS.description),
      untrusted('listing_features', features, TEXT_LIMITS.features),
      'Review this listing.',
    ].join('\n') },
  ];
  const ask = () => chatJSON<ModelReview>(messages, ReviewSchema, 'listing_trust_review', { purpose: 'trust.review', userId: o.userId, role: 'main', maxTokens: 2500, timeoutMs: 90_000 });
  let ai: ModelReview | null = null;
  try {
    // A resubmitted, unchanged listing reuses the earlier answer; an admin's re-check always asks afresh.
    ai = o.trigger === 'admin' ? await ask() : await cached(`trust.review:${sha(JSON.stringify(messages))}`, 86_400, ask);
  } catch (e) {
    const fault = recordable(e, finalAttempt);
    if (!fault) throw e;
    // Never replace an AI review of this exact version with a rules-only one: the job fails and the earlier review stays.
    const reviewed = await one<{ ok: number }>(
      `SELECT 1 AS ok FROM listing_ai_reviews WHERE listing_id = $1 AND model IS NOT NULL AND listing_updated_at = $2::timestamptz LIMIT 1`, [row.id, row.version]);
    if (reviewed) throw e;
    signals.aiProblem = fault.userMessage.slice(0, 200);
  }
  const model = ai ? await modelFor('main') : null;

  /* 4. hard rules and grounding */
  const allowed = {
    money: [facts.price, row.service_charge_annual, row.ground_rent_annual, p.typicalLow, p.typicalHigh, ...sig.numbersIn(listingText)].filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map(Number),
    percent: [p.belowPct, p.abovePct, ...signals.duplicates.map((d) => Math.round(d.similarity * 100)), ...sig.numbersIn(listingText)].filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
  };
  const ground = (s: string, n: number) => sig.groundFigures(clip(s, n), allowed);
  const rules = sig.ruleFlags(signals);
  // Evidence is shown to admins as evidence: only real quotes from the listing (or a named Streetkey signal) survive.
  const aiFlags: sig.Flag[] = (ai?.flags ?? []).slice(0, 10)
    .map((f) => ({ type: f.type, severity: f.severity, detail: ground(f.detail, 400), evidence: sig.groundEvidence(f.evidence, listingText, SIGNAL_NAMES), source: 'ai' as const }))
    .filter((f) => f.detail && !rules.some((r) => r.type === f.type && r.evidence && r.evidence === f.evidence));
  const flags = [...rules, ...aiFlags].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.source === b.source ? 0 : a.source === 'rules' ? -1 : 1)).slice(0, 15);

  const floor = sig.maxRisk(...rules.map((f) => f.severity));
  const points = flags.length ? `${flags.length} point${flags.length === 1 ? '' : 's'} to look at` : 'nothing of concern';
  let risk: sig.Risk, score: number, summary: string;
  if (ai) {
    const aiScore = sig.clampScore(ai.score);
    risk = sig.maxRisk(ai.risk, floor, sig.riskFromScore(aiScore));
    score = Math.max(aiScore, sig.BAND_MIN[risk]);
    summary = ground(ai.summary, 700) || `Automatic checks found ${points}.`;
    if (sig.maxRisk(ai.risk, floor) !== ai.risk) summary = `${summary} Streetkey’s automatic rules raised this to ${risk} risk.`.trim();
  } else {
    // Rules only: the risk is exactly what the code found, never lower.
    risk = floor;
    score = sig.BAND_MIN[floor];
    summary = `The AI review couldn’t run, so this shows Streetkey’s automatic rules only, which found ${points}. Re-check with AI later for a fuller review.`;
  }

  // Keep the lister message's line breaks (it is emailed as plain text); ground each line separately.
  let reason: string | null = ai?.suggestedReason
    ? ai.suggestedReason.slice(0, 1000).split('\n').map((line) => sig.groundFigures(line.replace(/[ \t]+/g, ' ').trim(), allowed)).filter(Boolean).join('\n').trim() || null
    : null;
  if (reason && (reason.length < 20 || sig.hasContactDetails(reason))) reason = null;
  if (!reason && risk !== 'low') {
    reason = sig.fallbackReason(signals)
      ?? 'Thank you for your listing. Before it can go live, please check that the description and photos accurately describe the property and include everything a buyer or tenant needs to know, then submit it again.';
  }

  /* 5. store, and auto-approve if allowed */
  // Auto-approval is deliberately narrow: private listings only (agencies have their own verification), everything
  // actually checked (text and every photo), nothing above low severity, and a lister with a verified email.
  // Never without the AI review itself, and never if the model read less than the whole listing.
  const fullyChecked = !!ai && !clipped && (!listingText.trim() || !!textMod) && photoTotal <= MAX_PHOTOS && photoMod.every((x) => x.checked);
  const eligible = o.trigger === 'submitted' && autoApproveEnabled() && row.status === 'pending' && !row.organisation_id
    && risk === 'low' && score < AUTO_APPROVE_MAX_SCORE && !flags.some((f) => f.severity !== 'low')
    && fullyChecked && !textMod?.flagged && !photoMod.some((x) => x.flagged)
    && signals.blockingChecksPass && row.owner_verified && !!row.owner_email;
  const { reviewId, approved } = await tx(async (c) => {
    // Publish only if the listing is unchanged since it was reviewed and still waiting.
    const up = eligible ? await one<{ v: string }>(
      `UPDATE listings SET status = 'live', rejection_reason = NULL, published_at = coalesce(published_at, now()), updated_at = now()
        WHERE id = $1 AND status = 'pending' AND updated_at = $2::timestamptz RETURNING updated_at::text AS v`, [row.id, row.version], c) : null;
    const ins = await one<{ id: string }>(
      `INSERT INTO listing_ai_reviews (listing_id, risk, score, flags, signals, summary, suggested_reason, auto_approved, model, triggered_by, listing_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz) RETURNING id`,
      [row.id, risk, score, JSON.stringify(flags), JSON.stringify(signals), summary, reason, !!up, model, o.trigger, up?.v ?? row.version], c);
    return { reviewId: ins!.id, approved: !!up };
  });
  if (approved) {
    await mails.listingLive(row.owner_email!, row.title ?? row.address_line, row.ref).catch(() => {});
    await audit(null, 'ai.auto_approved', `listing:${row.ref}`, { reviewId, score, model });
    await emit('listingsPublished', { listingIds: [row.id] });
  }
  return { reviewId, risk, score, autoApproved: approved, rulesOnly: !ai };
}
