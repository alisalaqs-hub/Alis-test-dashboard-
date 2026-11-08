/**
 * Enquiry triage: a short, structured read of what an enquirer wants, so listers can prioritise.
 * Only what the enquirer actually wrote is recorded (each buying-position flag must be backed by
 * words in their messages, checked in code). Nothing about protected characteristics, benefits,
 * family or nationality is ever extracted.
 */
import { chatJSON, HOUSE_RULES, modelFor, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one, q } from '../../db';
import { clip, loadEnquiry } from './shared';

export const INTENTS = ['book_viewing', 'ask_question', 'make_offer', 'check_availability', 'rental_application', 'other'] as const;
export const URGENCIES = ['this_week', 'this_month', 'flexible', 'unknown'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

const Position = S.obj({
  chainFree: S.nullable(S.bool(), 'true only if they say they are chain-free / have nothing to sell / are renting or first-time buyers; null if not stated'),
  mortgageInPrinciple: S.nullable(S.bool(), 'true only if they say they have a mortgage (agreement/decision) in principle; null if not stated'),
  cash: S.nullable(S.bool(), 'true only if they say they are a cash buyer; null if not stated'),
  firstTimeBuyer: S.nullable(S.bool(), 'true only if they say they are a first-time buyer; null if not stated'),
  hasPropertyToSell: S.nullable(S.bool(), 'true if they say they must sell a home first (on the market, under offer or sold STC); false if they say they have nothing to sell; else null'),
  moveTimescale: S.nullable(S.str('When they want to move or move in, in at most 6 words, only if stated (e.g. "by March", "as soon as possible")')),
});
export const TriageSchema = S.obj({
  intent: S.enum(INTENTS),
  buyerPosition: Position,
  questions: S.arr(S.str('One question the enquirer asked, rephrased in under 15 words')),
  urgency: S.enum(URGENCIES, 'How soon they want to view or move, only from what they wrote'),
  summary: S.str('One or two plain sentences (under 40 words) for the lister. No names, emails or phone numbers.'),
  sentiment: S.enum(SENTIMENTS),
});
export type TriageOut = Infer<typeof TriageSchema>;
export type BuyerPosition = TriageOut['buyerPosition'];

/** Words that must appear in the enquirer's messages for a position flag to be kept. */
const EVIDENCE: Record<Exclude<keyof BuyerPosition, 'moveTimescale'>, RegExp> = {
  chainFree: /chain|nothing to sell|no (property|house|home|flat) to sell|not selling|first[- ]time|\bftb\b|renting|living with|no onward/i,
  mortgageInPrinciple: /mortgage|\b[amd]ip\b|in principle|pre-?approved|broker/i,
  cash: /\bcash\b|no mortgage|without (a )?mortgage|mortgage[- ]free|funds (are )?(ready|available|in place)/i,
  firstTimeBuyer: /first[- ]time|\bftb\b|never owned|first (home|property|purchase)/i,
  hasPropertyToSell: /\b(my|our) (current |own )?(home|house|flat|property|place)\b.{0,40}\b(sell|sale|market|offer|sold)|\bsold (stc|subject to contract)\b|\bon the market\b|\bunder offer\b|\b(need|have|got) to sell\b|\bnothing to sell\b|\bchain\b|\bselling\b/i,
};
const TIMESCALE_EVIDENCE = /\b(asap|as soon as|soon|immediately|urgent|week|weeks|month|months|year|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|winter|christmas|new year|easter|20\d\d|end of|start of|beginning of|by the|from the|move|moving|relocat)/i;

/** Keeps only what the messages support; trims everything to safe lengths. */
export function validateTriage(t: TriageOut, enquirerText: string): TriageOut {
  const pos: BuyerPosition = { chainFree: null, mortgageInPrinciple: null, cash: null, firstTimeBuyer: null, hasPropertyToSell: null, moveTimescale: null };
  for (const k of Object.keys(EVIDENCE) as (keyof typeof EVIDENCE)[]) {
    const v = t.buyerPosition[k];
    if (typeof v === 'boolean' && EVIDENCE[k].test(enquirerText)) pos[k] = v;
  }
  const ts = clip(t.buyerPosition.moveTimescale, 60);
  if (ts && TIMESCALE_EVIDENCE.test(enquirerText)) pos.moveTimescale = ts;
  // Contradictions the model can't have read: a chain-free buyer with a home to sell.
  if (pos.chainFree === true && pos.hasPropertyToSell === true) { pos.chainFree = null; pos.hasPropertyToSell = null; }
  return {
    intent: (INTENTS as readonly string[]).includes(t.intent) ? t.intent : 'other',
    buyerPosition: pos,
    questions: t.questions.map((x) => clip(x, 200)).filter(Boolean).slice(0, 6),
    urgency: (URGENCIES as readonly string[]).includes(t.urgency) ? t.urgency : 'unknown',
    summary: stripContacts(clip(t.summary, 280)),
    sentiment: (SENTIMENTS as readonly string[]).includes(t.sentiment) ? t.sentiment : 'neutral',
  };
}
/** The summary is for a quick read; contact details belong in the conversation panel, not here. */
const stripContacts = (s: string) => s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').replace(/(\+?\d[\d\s()-]{8,}\d)/g, '[phone]');

export interface Chip { label: string; tone: 'good' | 'info' | 'urgent' }
export interface TriageDTO {
  intent: TriageOut['intent']; position: BuyerPosition; questions: string[]; urgency: TriageOut['urgency'];
  summary: string; sentiment: TriageOut['sentiment']; chips: Chip[]; model: string | null; updatedAt: string;
}

/** Short labels for the inbox list, worked out in code from the stored triage. */
export function chipsFor(t: Pick<TriageDTO, 'intent' | 'position' | 'urgency'>, kind: string): Chip[] {
  const c: Chip[] = [];
  const p = t.position;
  if (t.urgency === 'this_week') c.push({ label: kind === 'viewing' || t.intent === 'book_viewing' ? 'Viewing this week' : 'Wants to move this week', tone: 'urgent' });
  if (t.intent === 'make_offer') c.push({ label: 'Offer', tone: 'urgent' });
  if (p.cash) c.push({ label: 'Cash buyer', tone: 'good' });
  if (p.mortgageInPrinciple) c.push({ label: 'Mortgage in principle', tone: 'good' });
  if (p.chainFree) c.push({ label: 'Chain-free', tone: 'good' });
  if (p.firstTimeBuyer) c.push({ label: 'First-time buyer', tone: 'info' });
  if (p.hasPropertyToSell === true) c.push({ label: 'Has a home to sell', tone: 'info' });
  if (p.moveTimescale && t.urgency !== 'this_week') c.push({ label: `Move: ${p.moveTimescale.slice(0, 28)}`, tone: 'info' });
  return c.slice(0, 5);
}

export interface TriageRow { enquiry_id: string; intent: string; buyer_position: BuyerPosition; questions: string[]; urgency: string; summary: string; sentiment: string; model: string | null; updated_at: Date; kind: string }
export const triageDTO = (r: TriageRow): TriageDTO => {
  const position = { chainFree: null, mortgageInPrinciple: null, cash: null, firstTimeBuyer: null, hasPropertyToSell: null, moveTimescale: null, ...(r.buyer_position ?? {}) } as BuyerPosition;
  const base = { intent: r.intent as TriageDTO['intent'], position, urgency: r.urgency as TriageDTO['urgency'] };
  return { ...base, questions: r.questions ?? [], summary: r.summary, sentiment: r.sentiment as TriageDTO['sentiment'], chips: chipsFor(base, r.kind), model: r.model, updatedAt: r.updated_at.toISOString() };
};
export const TRIAGE_SELECT = `SELECT a.enquiry_id, a.intent, a.buyer_position, a.questions, a.urgency, a.summary, a.sentiment, a.model, a.updated_at, e.kind
  FROM enquiry_ai a JOIN enquiries e ON e.id = a.enquiry_id`;

const SYSTEM = [
  HOUSE_RULES,
  'You triage messages that buyers and tenants send to a UK property lister, so the lister can prioritise replies.',
  'Record only what the enquirer explicitly wrote. Leave a buying-position field null unless the message states it; never infer it from tone, name or writing style.',
  'Never record or mention anything about age, disability, race, religion, sex, sexual orientation, pregnancy, marital or family status, nationality, or whether someone receives benefits.',
  'Questions: list the distinct questions the enquirer asked (none if they asked none).',
  'Urgency: this_week only if they ask to view or move within about seven days; this_month for within a month; flexible if they say there is no rush; otherwise unknown.',
].join('\n');

/** Runs the triage for an enquiry and stores it. Returns what was stored (or why nothing was). */
export async function runTriage(enquiryId: string): Promise<{ stored: boolean; skipped?: string; triage?: TriageDTO }> {
  const e = await loadEnquiry(enquiryId);
  if (!e) return { stored: false, skipped: 'missing' };
  if (e.filtered) return { stored: false, skipped: 'filtered' };
  const msgs = await q<{ author: 'enquirer' | 'lister'; body: string; created_at: Date }>(
    'SELECT author, body, created_at FROM enquiry_messages WHERE enquiry_id = $1 ORDER BY created_at DESC LIMIT 12', [enquiryId]);
  msgs.reverse();
  const fromEnquirer = msgs.filter((m) => m.author === 'enquirer');
  if (!fromEnquirer.length) return { stored: false, skipped: 'empty' };
  const enquirerText = fromEnquirer.map((m) => m.body).join('\n');
  const thread = msgs.map((m) => `${m.author === 'enquirer' ? 'Enquirer' : 'Lister'}: ${m.body.slice(0, 1500)}`).join('\n---\n');
  const context = `Listing: ${e.channel === 'rent' ? 'to rent' : 'for sale'}. Form type chosen by the enquirer: ${e.kind}.${e.preferred_slot ? ' They gave a preferred viewing time (see thread data).' : ''}`;
  const model = await modelFor('fast');
  const raw = await chatJSON<TriageOut>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${context}\n\n${untrusted('thread', `${e.preferred_slot ? `Preferred time: ${e.preferred_slot}\n` : ''}${thread}`, 9000)}` },
  ], TriageSchema, 'enquiry_triage', { purpose: 'inbox.triage', userId: e.owner_user_id, role: 'fast', maxTokens: 1200, effort: 'low' });
  const t = validateTriage(raw, `${enquirerText}\n${e.preferred_slot ?? ''}`);
  const row = await one<TriageRow>(
    `INSERT INTO enquiry_ai (enquiry_id, intent, buyer_position, questions, urgency, summary, sentiment, model, messages_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (enquiry_id) DO UPDATE SET intent = EXCLUDED.intent, buyer_position = EXCLUDED.buyer_position, questions = EXCLUDED.questions,
       urgency = EXCLUDED.urgency, summary = EXCLUDED.summary, sentiment = EXCLUDED.sentiment, model = EXCLUDED.model, messages_seen = EXCLUDED.messages_seen, updated_at = now()
     RETURNING enquiry_id, intent, buyer_position, questions, urgency, summary, sentiment, model, updated_at, $10::text AS kind`,
    [enquiryId, t.intent, JSON.stringify(t.buyerPosition), t.questions, t.urgency, t.summary, t.sentiment, model, fromEnquirer.length, e.kind]);
  return { stored: true, triage: triageDTO(row!) };
}
