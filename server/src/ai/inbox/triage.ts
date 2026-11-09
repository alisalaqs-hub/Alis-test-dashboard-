/**
 * Enquiry triage: a short, structured read of what an enquirer wants, so listers can prioritise.
 * Only what the enquirer actually wrote is recorded, checked in code against their words:
 *   - each buying-position flag needs a cue for it that isn't negated ("not a cash buyer");
 *   - urgency needs a time reference, an offer needs offer words (or the offer form), and a question
 *     needs the enquirer to have asked something about it;
 *   - the summary loses web addresses, claims that Streetkey checked anyone, and any sentence about
 *     who the person is.
 * Nothing about protected characteristics, benefits, family or nationality is ever extracted.
 */
import { chatJSON, HOUSE_RULES, modelFor, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one, q } from '../../db';
import { aboutThePerson, claimsStreetkeyCheck, clip, dropSentences, loadEnquiry, redactContacts, stripLinks, UUID_RE } from './shared';

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

/**
 * A false flag ("nothing to sell") only needs the topic to come up; a true flag needs one of these
 * cues, not negated (see negated()).
 */
const TOPIC: Record<Exclude<keyof BuyerPosition, 'moveTimescale'>, RegExp> = {
  chainFree: /chain|nothing to sell|no (property|house|home|flat) to sell|not selling|first[- ]time|\bftb\b|renting|living with|no onward/i,
  mortgageInPrinciple: /mortgage|\b[amd]ip\b|in principle|pre-?approved|broker/i,
  cash: /\bcash\b|mortgage|funds/i,
  firstTimeBuyer: /first[- ]time|\bftb\b|never owned|first (home|property|purchase)/i,
  hasPropertyToSell: /\b(my|our) (current |own )?(home|house|flat|property|place)\b|\bsold\b|\bmarket\b|\bunder offer\b|\bto sell\b|\bchain\b|\bselling\b/i,
};
const CUES: Record<keyof typeof TOPIC, RegExp> = {
  chainFree: /\bchain[- ]?free\b|\bno (?:onward )?chain\b|\bnot (?:in|part of) (?:a|any) chain\b|\bnothing to sell\b|\bno (?:property|house|home|flat) to sell\b|\b(?:don't|do not) (?:have|need) to sell\b|\bnot selling\b|\bfirst[- ]time buyers?\b|\bftbs?\b|\brenting\b|\bliving with (?:my |our )?(?:parents|family|friends)\b/gi,
  mortgageInPrinciple: /\bmortgage (?:agreement |decision )?in principle\b|\b(?:agreement|decision) in principle\b|\b[amd]ips?\b|\bpre-?approved\b|\bmortgage (?:offer|approval|approved|agreed|in place|lined up|sorted)\b/gi,
  cash: /\bcash buyers?\b|\b(?:buying|buy|paying|pay) (?:in |with |for it in |for it with )?cash\b|\bcash purchase\b|\bno mortgage (?:needed|required)\b|\b(?:without|don't need|do not need) (?:a )?mortgage\b|\bmortgage[- ]free\b|\bfunds (?:are )?(?:ready|available|in place)\b|\bproof of funds\b/gi,
  firstTimeBuyer: /\bfirst[- ]time (?:buyers?|buying|purchase|home)\b|\bftbs?\b|\bnever owned\b|\bfirst (?:home|property|purchase|flat|house)\b/gi,
  hasPropertyToSell: /\b(?:my|our) (?:current |own )?(?:home|house|flat|property|place)\b.{0,40}\b(?:sell|sale|market|offer|sold)|\bsold (?:stc|subject to contract)\b|\bon the market\b|\bunder offer\b|\b(?:need|have|got) to sell\b|\bin a chain\b|\bselling (?:my|our)\b/gi,
};
/** A negation in the few words before a cue, within its clause: "I'm not a cash buyer", "we haven't got a MIP yet". */
const NEGATION = /\b(?:not|no|never|don't|doesn't|didn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|can't|cannot|won't|wouldn't|without|yet to|unable to)\b/i;
const negated = (text: string, index: number) => NEGATION.test((text.slice(0, index).split(/[.!?;,\n]|\bbut\b/i).pop() ?? '').split(/\s+/).slice(-5).join(' '));
/** True if the text has the cue somewhere it isn't negated. */
export function stated(text: string, cue: RegExp): boolean {
  for (const m of text.matchAll(new RegExp(cue.source, cue.flags.includes('g') ? cue.flags : `${cue.flags}g`))) if (!negated(text, m.index!)) return true;
  return false;
}
const TIMESCALE_EVIDENCE = /\b(asap|as soon as|soon|immediately|urgent|week|weeks|month|months|year|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|winter|christmas|new year|easter|20\d\d|end of|start of|beginning of|by the|from the|move|moving|relocat)/i;
/** A time reference, needed before urgency is "this week" or "this month". */
const SOON = /\b(?:today|tonight|tomorrow|this (?:week|weekend|month|evening|afternoon|morning)|next (?:week|weekend|month|few days)|weekend|asap|as soon as|straight away|right away|immediately|urgent(?:ly)?|in (?:a|one|two|three|a couple of|a few) (?:days?|weeks?)|fortnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\.?(?=\s*\d)|\d{1,2}(?:st|nd|rd|th)\b|\d{1,2}\/\d{1,2}\b|\d{1,2}(?:[:.]\d{2})?\s?(?:am|pm)\b|\d{1,2}[:.]\d{2}\b|january|february|march|april|june|july|august|september|october|november|december)/i;
const FLEXIBLE = /\b(?:no rush|no hurry|not in a (?:rush|hurry)|flexible|whenever|any ?time|in no rush|in no hurry)\b/i;
const OFFER = /\boffer|\bbids?\b|\bbidding\b|£\s?\d|\b\d+(?:\.\d+)?\s?k\b/i;
/** The enquirer asked something: a question mark, a sentence starting with a question word, or "I was wondering…". */
const ASKED = /\?|(?:^|[.!\n]\s*)(?:what|when|where|which|who|why|how|is|are|can|could|would|will|do|does|did|has|have|should|may)\b|\b(?:wonder(?:ing|ed)?|let me know|tell me|please (?:confirm|advise)|i'd like to know|any (?:idea|info))\b/i;
const STOP = new Set(['about', 'there', 'their', 'these', 'those', 'would', 'could', 'should', 'which', 'where', 'whether', 'still', 'available', 'property', 'house', 'home', 'flat', 'please', 'thanks', 'thank', 'hello', 'they', 'them', 'what', 'when', 'this', 'that', 'with', 'have', 'does', 'will', 'your', 'from', 'asked', 'asks', 'asking', 'enquirer', 'lister', 'whether']);
const words = (s: string) => s.toLowerCase().replace(/[’']/g, '').match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)) ?? [];

/** Keeps only what the messages support; trims everything to safe lengths. kind is the form type the enquirer chose. */
export function validateTriage(t: TriageOut, enquirerText: string, kind?: string): TriageOut {
  const text = enquirerText.replace(/[’‘]/g, "'");
  const pos: BuyerPosition = { chainFree: null, mortgageInPrinciple: null, cash: null, firstTimeBuyer: null, hasPropertyToSell: null, moveTimescale: null };
  for (const k of Object.keys(TOPIC) as (keyof typeof TOPIC)[]) {
    const v = t.buyerPosition[k];
    if (v === true && stated(text, CUES[k])) pos[k] = true;
    else if (v === false && TOPIC[k].test(text)) pos[k] = false;
  }
  const ts = clip(t.buyerPosition.moveTimescale, 60);
  if (ts && TIMESCALE_EVIDENCE.test(text) && !aboutThePerson(ts)) pos.moveTimescale = ts;
  // Contradictions the model can't have read: a chain-free buyer with a home to sell.
  if (pos.chainFree === true && pos.hasPropertyToSell === true) { pos.chainFree = null; pos.hasPropertyToSell = null; }

  // Questions: only if they asked something, about something they mentioned; each once.
  const theirWords = new Set(words(text));
  const seen = new Set<string>();
  const questions = !ASKED.test(text) ? [] : t.questions.map((x) => stripLinks(clip(x, 200))).filter((x) => {
    const key = x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key) || aboutThePerson(x) || claimsStreetkeyCheck(x)) return false;
    const w = words(x);
    if (w.length && !w.some((v) => theirWords.has(v))) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);

  let intent: TriageOut['intent'] = (INTENTS as readonly string[]).includes(t.intent) ? t.intent : 'other';
  if (intent === 'make_offer' && kind !== 'offer' && !OFFER.test(text)) intent = kind === 'viewing' ? 'book_viewing' : questions.length ? 'ask_question' : 'other';
  let urgency: TriageOut['urgency'] = (URGENCIES as readonly string[]).includes(t.urgency) ? t.urgency : 'unknown';
  if ((urgency === 'this_week' || urgency === 'this_month') && !SOON.test(text)) urgency = 'unknown';
  if (urgency === 'flexible' && !FLEXIBLE.test(text)) urgency = 'unknown';
  return {
    intent,
    buyerPosition: pos,
    questions,
    urgency,
    summary: cleanSummary(t.summary),
    sentiment: (SENTIMENTS as readonly string[]).includes(t.sentiment) ? t.sentiment : 'neutral',
  };
}
/**
 * The summary is for a quick read: no contact details or web addresses (they belong in the
 * conversation), no claims that Streetkey checked anyone, nothing about who the person is.
 */
export const cleanSummary = (s: string) => clip(dropSentences(stripContacts(clip(s, 400)), (x) => /\[link\]/.test(x) || claimsStreetkeyCheck(x) || aboutThePerson(x)), 280);
const stripContacts = (s: string) => stripLinks(s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').replace(/(\+?\d[\d\s()-]{8,}\d)/g, '[phone]'));

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
  const position = { chainFree: null, mortgageInPrinciple: null, cash: null, firstTimeBuyer: null, hasPropertyToSell: null, moveTimescale: null, ...((r.buyer_position ?? {}) as Partial<BuyerPosition>) } as BuyerPosition;
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
  'Intent make_offer only if they make or discuss an offer. A buying-position field is true only if they say it is so, not if they say it is not ("I am not a cash buyer" means cash is false).',
  'Summary: never include web addresses, and never say that Streetkey (or anyone) has checked or verified the enquirer or their funds.',
].join('\n');

/** Runs the triage for an enquiry and stores it. Returns what was stored (or why nothing was). */
export async function runTriage(enquiryId: string): Promise<{ stored: boolean; skipped?: string; triage?: TriageDTO }> {
  if (!UUID_RE.test(enquiryId)) return { stored: false, skipped: 'missing' };
  const e = await loadEnquiry(enquiryId);
  if (!e) return { stored: false, skipped: 'missing' };
  if (e.filtered) return { stored: false, skipped: 'filtered' };
  const msgs = await q<{ author: 'enquirer' | 'lister'; body: string; created_at: Date }>(
    'SELECT author, body, created_at FROM enquiry_messages WHERE enquiry_id = $1 ORDER BY created_at DESC LIMIT 12', [enquiryId]);
  msgs.reverse();
  const fromEnquirer = msgs.filter((m) => m.author === 'enquirer');
  if (!fromEnquirer.length) return { stored: false, skipped: 'empty' };
  const enquirerText = fromEnquirer.map((m) => m.body).join('\n');
  const thread = msgs.map((m) => `${m.author === 'enquirer' ? 'Enquirer' : 'Lister'}: ${redactContacts(m.body.slice(0, 1500))}`).join('\n---\n');
  const context = `Listing: ${e.channel === 'rent' ? 'to rent' : 'for sale'}. Form type chosen by the enquirer: ${e.kind}.${e.preferred_slot ? ' They gave a preferred viewing time (see thread data).' : ''}`;
  const model = await modelFor('fast');
  const raw = await chatJSON<TriageOut>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${context}\n\n${untrusted('thread', `${e.preferred_slot ? `Preferred time: ${e.preferred_slot}\n` : ''}${thread}`, 9000)}` },
  ], TriageSchema, 'enquiry_triage', { purpose: 'inbox.triage', userId: e.owner_user_id, role: 'fast', maxTokens: 1200, effort: 'low', timeoutMs: 20_000 }); // short enough to run inside a request when no worker picks it up
  const t = validateTriage(raw, `${enquirerText}\n${e.preferred_slot ?? ''}`, e.kind);
  const row = await one<TriageRow>(
    `INSERT INTO enquiry_ai (enquiry_id, intent, buyer_position, questions, urgency, summary, sentiment, model, messages_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (enquiry_id) DO UPDATE SET intent = EXCLUDED.intent, buyer_position = EXCLUDED.buyer_position, questions = EXCLUDED.questions,
       urgency = EXCLUDED.urgency, summary = EXCLUDED.summary, sentiment = EXCLUDED.sentiment, model = EXCLUDED.model, messages_seen = EXCLUDED.messages_seen, updated_at = now()
     RETURNING enquiry_id, intent, buyer_position, questions, urgency, summary, sentiment, model, updated_at, $10::text AS kind`,
    [enquiryId, t.intent, JSON.stringify(t.buyerPosition), t.questions, t.urgency, t.summary, t.sentiment, model, fromEnquirer.length, e.kind]);
  return { stored: true, triage: triageDTO(row!) };
}
