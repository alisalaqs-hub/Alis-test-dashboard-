/**
 * Pre-submission review: Streetkey's rule-based compliance checks and wording rules (code),
 * plus an AI read of the description against the facts. All three are merged into one list.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { complianceChecks, type ListingInput } from '../../../../src/engine/listings';
import type { PropertyType } from '../../../../src/engine/refurb';
import { AiError, cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { factLines, FactsSchema, type Facts } from './facts';
import { clip, reviewText, type Reason } from './wording';

export const FIELDS = ['title', 'description', 'price', 'postcode', 'tenure', 'leaseYears', 'serviceCharge', 'groundRent', 'councilTax', 'epc', 'beds', 'baths', 'floorArea', 'features', 'photos', 'general'] as const;
export type Field = (typeof FIELDS)[number];
export type Severity = 'block' | 'warn' | 'tip';
export interface Issue { severity: Severity; field: Field; message: string; source: 'checks' | 'wording' | 'ai'; checkId?: string }

export const PrecheckBody = z.object({
  facts: FactsSchema,
  description: z.string().max(8000).default(''),
  photoCount: z.coerce.number().int().min(0).max(100).default(0),
});
export type PrecheckIn = z.infer<typeof PrecheckBody>;

const CHECK_FIELD: Record<string, Field> = { price: 'price', postcode: 'postcode', tenure: 'tenure', lease: 'leaseYears', charges: 'serviceCharge', ctax: 'councilTax', epc: 'epc', 'epc-let': 'epc', photos: 'photos', discrim: 'description', bidding: 'description' };

/** Streetkey's own compliance checks (the same ones the form and the server use) for these facts. */
export function ruleChecks(f: Facts, description: string, photoCount: number) {
  const input: ListingInput = {
    listing: f.channel, title: f.title ?? undefined, addressLine: '', town: f.town ?? '', postcode: f.postcode ?? f.district ?? '',
    type: f.type as PropertyType, tenure: (f.tenure ?? undefined) as ListingInput['tenure'], leaseYears: f.leaseYears ?? undefined,
    beds: f.beds, baths: f.baths, floorArea: f.floorArea ?? 0, price: f.price ?? 0, epc: f.epc ?? undefined, councilTax: f.councilTax ?? undefined,
    serviceChargeAnnual: f.serviceCharge ?? undefined, groundRentAnnual: f.groundRent ?? undefined, features: f.features, description,
    photos: Array.from({ length: photoCount }, () => ''), source: { kind: f.channel === 'rent' ? 'landlord' : 'owner', name: '', licence: '', verified: false },
  };
  return complianceChecks(input);
}

const WORDING: Record<Reason, { severity: Severity; text: string }> = {
  discrimination: { severity: 'block', text: 'could discriminate or steer people. Describe the home, not who should live there.' },
  bidding: { severity: 'block', text: 'invites offers or bids. A rental advert must state one fixed rent.' },
  fees: { severity: 'block', text: 'mentions tenant fees, which are banned under the Tenant Fees Act 2019 (apart from permitted payments).' },
  pets: { severity: 'warn', text: 'is a blanket “no pets” line. Tenants can ask to keep a pet and landlords must not unreasonably refuse.' },
  superlative: { severity: 'warn', text: 'is a claim people can’t check. Adverts must not mislead, so describe the feature plainly.' },
  price: { severity: 'warn', text: 'mentions a price that isn’t your stated price. Check it’s accurate and not misleading.' },
  mismatch: { severity: 'warn', text: 'doesn’t match the details you entered (EPC, council tax band, tenure or bedrooms).' },
  planning: { severity: 'tip', text: 'mentions planning or extension potential. Only include it if you can evidence it, and say “subject to planning”.' },
  investment: { severity: 'tip', text: 'makes an investment claim. Only include returns or demand you can evidence.' },
  figure: { severity: 'tip', text: 'includes a figure. Check it’s accurate.' },
  schools: { severity: 'tip', text: 'mentions schools. Check it’s accurate and current.' },
  transport: { severity: 'tip', text: 'mentions transport. Check it’s accurate.' },
  area: { severity: 'tip', text: 'describes the area. Keep it factual.' },
  amenities: { severity: 'tip', text: 'mentions nearby amenities. Check it’s accurate.' },
  unstated: { severity: 'tip', text: 'includes a detail that isn’t in your listing fields. Check it’s accurate.' },
};

const AiOut = S.obj({
  issues: S.arr(S.obj({
    severity: S.enum(['block', 'warn', 'tip'] as const),
    field: S.enum(FIELDS),
    message: S.str('One specific, actionable sentence; quote the words briefly'),
  }), 'At most 8; empty if there are no problems'),
});
type AiOutT = Infer<typeof AiOut>;

const REVIEW_RULES = [
  'You review a UK property listing for a private seller or landlord before it is submitted. Compare the title and description with the facts and report real problems only.',
  '- block: unlawful or clearly misleading wording: discrimination or steering (e.g. “no DSS”, “professionals only”, “ideal for couples”), bidding language or tenant fees in a rental, or text that contradicts the facts (e.g. a different number of bedrooms, tenure or EPC rating).',
  '- warn: claims that could mislead or can’t be verified (superlatives, unverified claims about schools, transport, the area, planning potential or investment returns), prices other than the stated one, or material information described inconsistently.',
  '- tip: clarity and completeness (details people will ask about, a very short description, unclear wording).',
  'Point to the words in the text. Do not invent facts, prices or legal requirements. Do not repeat a point. Do not report missing EPC, council tax, tenure or photos: those are checked separately.',
  'Write in British English, plainly and kindly.',
].join('\n');

const ORDER: Record<Severity, number> = { block: 0, warn: 1, tip: 2 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function precheck(input: PrecheckIn, meta: { userId?: string | null }) {
  const f = input.facts;
  const checks = ruleChecks(f, input.description, input.photoCount);
  const issues: Issue[] = checks.filter((c) => !c.ok).map((c) => ({ severity: c.severity, field: CHECK_FIELD[c.id] ?? 'general', message: c.message, source: 'checks', checkId: c.id }));

  // Wording rules on the seller's own title and description (flagged, never changed).
  const seen = new Set<string>();
  for (const [field, text] of [['title', f.title ?? ''], ['description', input.description]] as const) {
    for (const p of reviewText(text, { facts: f, sources: [input.description, f.title ?? ''] })) {
      const k = `${field}:${p.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const w = WORDING[p.reason];
      issues.push({ severity: w.severity, field, message: `“${clip(p.sentence, 90)}” ${w.text}`, source: 'wording' });
    }
  }

  let aiUsed = false;
  let aiNote: string | null = null;
  if (input.description.trim().length >= 20 || f.title) {
    try {
      const key = `listing.precheck:${createHash('sha256').update(JSON.stringify([f, input.description])).digest('hex')}`;
      const ai = await cached(key, 600, () => chatJSON<AiOutT>([
        { role: 'system', content: `${HOUSE_RULES}\n\n${REVIEW_RULES}` },
        { role: 'user', content: [untrusted('listing_facts', factLines(f)), untrusted('listing_title', f.title ?? '(none)', 200), untrusted('listing_description', input.description || '(none)', 8000)].join('\n\n') },
      ], AiOut, 'listing_precheck', { purpose: 'listing.precheck', userId: meta.userId, role: 'fast', maxTokens: 1500, effort: 'low' }));
      aiUsed = true;
      const have = new Set(issues.map((i) => norm(i.message)));
      for (const i of ai.issues.slice(0, 8)) {
        const message = clip(i.message, 300);
        if (!message || have.has(norm(message))) continue;
        have.add(norm(message));
        issues.push({ severity: i.severity, field: (FIELDS as readonly string[]).includes(i.field) ? i.field : 'general', message, source: 'ai' });
      }
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      aiNote = `${e.userMessage} The rule-based checks below still apply.`;
    }
  } else aiNote = 'Add a description to get an AI review of the wording.';

  issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { ready: !issues.some((i) => i.severity === 'block'), issues, checks, aiUsed, aiNote };
}
