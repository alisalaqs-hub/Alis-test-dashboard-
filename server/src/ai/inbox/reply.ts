/**
 * "Suggest a reply" for listers: an editable draft grounded in the listing's own facts and the
 * conversation. It is never sent automatically. Code checks the draft after the model writes it:
 *   - money amounts that aren't in the listing, notes or thread become [amount];
 *   - days, dates and times nobody mentioned become [day] / [date] / [time] (no invented availability);
 *   - sentences hinting at price flexibility are removed unless the lister's notes say so;
 *   - a private seller's house number and full postcode are removed unless the lister typed them;
 *   - Tenant Fees Act, rental bidding, discrimination and "send money" wording raise warnings.
 */
import { chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one, q } from '../../db';
import { LISTING_SELECT, streetOnly, type ListingRow } from '../../services/listings';
import { clip, isPrivateSeller, type EnquiryRow } from './shared';

export const REPLY_INTENTS = ['answer', 'confirm_viewing', 'offer_times', 'decline', 'request_info'] as const;
export const REPLY_TONES = ['friendly', 'formal', 'brief'] as const;
export type ReplyIntent = typeof REPLY_INTENTS[number];
export type ReplyTone = typeof REPLY_TONES[number];

const ReplySchema = S.obj({
  reply: S.str('The message to the enquirer, plain text, ready for the lister to edit'),
  placeholders: S.arr(S.str('A [square-bracket] placeholder used in the reply that the lister must fill in')),
  warnings: S.arr(S.str('Something the lister should check before sending, in under 25 words')),
});
type ReplyOut = Infer<typeof ReplySchema>;

const INTENT_GUIDE: Record<ReplyIntent, string> = {
  answer: 'Answer the enquirer’s questions using only the LISTING facts and the lister’s NOTES. Where a fact isn’t available, say you’ll check and come back to them, using a placeholder such as [answer about the boiler]. Never guess.',
  confirm_viewing: 'Confirm a viewing. Use a day or time only if the NOTES or the enquirer gave it; otherwise write [day and time]. Put where to meet as [meeting point] unless the NOTES say. Do not offer any other times.',
  offer_times: 'Offer viewing times. Use the times listed in the NOTES; if there are none, write [time option 1] and [time option 2]. Never make up times or say the lister is free at a particular time.',
  decline: 'Politely say you can’t take this further right now (for example, the home is no longer available for viewings or the request can’t be met). Give no reason relating to the person. Make no promises.',
  request_info: 'Thank them and ask for the information the lister needs to move forward. For a sale: their buying position (whether they have a home to sell, a mortgage in principle or proof of funds) and timescale. For a rental: their ideal move-in date and tenancy length, and that the same referencing and Right to Rent checks apply to every applicant.',
};
const TONE_GUIDE: Record<ReplyTone, string> = {
  friendly: 'Warm and friendly, under 150 words.',
  formal: 'Polite and professional, under 170 words.',
  brief: 'Short and to the point, under 70 words.',
};

const SYSTEM = [
  HOUSE_RULES,
  'You draft replies for a UK property lister (a private seller, landlord or estate agent) answering an enquiry on Streetkey. The lister reviews and edits your draft before anything is sent.',
  'Write as the lister, in the first person, to the enquirer. Plain text only: no markdown, no subject line. Greet the enquirer by first name if given. End with "[your name]".',
  'Use only facts from LISTING and NOTES. Never invent availability, viewing times, prices, fees, measurements, legal facts or anything about the area.',
  'Never promise or hint at anything about price or negotiation (no "negotiable", "flexible", "open to offers", "would accept"), and never mention other offers or interest, unless the NOTES say exactly that. If asked about price, say any offer should be made clearly (in writing) and will be considered. If the lister is an agent, say every offer is passed to the seller.',
  'Use [square-bracket placeholders] for anything the lister must fill in, e.g. [day and time], [your phone number].',
  'Location: use only the location given in LISTING. Never write a house number or full postcode that is not in LISTING or NOTES.',
  'Never ask about or comment on age, disability, race, religion, sex, sexual orientation, pregnancy, marital or family status, children, nationality or benefits (Equality Act 2010).',
  'Rentals: never ask for fees beyond the payments the Tenant Fees Act 2019 permits, and never invite offers above the advertised rent.',
  'Never ask the enquirer to send money, bank details or identity documents through messages.',
  'warnings: short notes for the lister, e.g. a question you couldn’t answer from the listing. Do not repeat the placeholders.',
].join('\n');

const fmtGbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const STATUS: Record<string, string> = { live: 'Available', under_offer: 'Under offer', sold: 'Sold', let: 'Let', withdrawn: 'Withdrawn', draft: 'Not yet published', pending: 'Not yet published', rejected: 'Not yet published' };

/** Listing facts the model may use, built in code from the database row (privacy-safe for private sellers). */
export function listingFacts(l: ListingRow) {
  const priv = isPrivateSeller(l.source_kind);
  const material = Object.entries(l.material_info ?? {}).slice(0, 40).map(([k, v]) => [clip(k, 60), typeof v === 'string' ? clip(v, 300) : v] as const).filter(([, v]) => v !== null && v !== '');
  return {
    title: l.title ?? `${l.beds}-bed ${l.property_type} in ${l.town}`,
    listedBy: priv ? (l.source_kind === 'landlord' ? 'private landlord' : 'private seller') : `estate agent${l.organisation_name ? ` (${l.organisation_name})` : ''}`,
    channel: l.channel === 'rent' ? 'to rent' : 'for sale',
    status: STATUS[l.status] ?? l.status,
    price: l.channel === 'rent' ? `${fmtGbp(l.price)} per calendar month` : `${fmtGbp(l.price)}${l.price_qualifier && l.price_qualifier !== 'fixed' ? ` (${l.price_qualifier})` : ''}`,
    location: priv ? `${streetOnly(l.address_line)}, ${l.town} ${l.district}` : `${l.address_line}, ${l.town} ${l.postcode}`,
    propertyType: l.property_type, bedrooms: l.beds, bathrooms: l.baths, floorAreaM2: l.floor_area,
    tenure: l.tenure, ...(l.tenure === 'leasehold' ? { leaseYearsRemaining: l.lease_years ?? 'not stated', serviceChargePerYear: l.service_charge_annual != null ? fmtGbp(l.service_charge_annual) : 'not stated', groundRentPerYear: l.ground_rent_annual != null ? fmtGbp(l.ground_rent_annual) : 'not stated' } : {}),
    councilTaxBand: l.council_tax ?? 'not stated', epcRating: l.epc ?? 'not stated',
    features: (l.features ?? []).slice(0, 20),
    materialInformation: Object.fromEntries(material),
    description: clip(l.description, 1800),
  };
}

/* ───────── post-checks (exported for tests) ───────── */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Fresh regexes per use (global regexes keep state between calls).
const dayRe = () => /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b\.?(?=\s*\d)|\b(?:today|tomorrow|tonight|this weekend|next week)\b/gi;
const dateRe = () => new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b`, 'gi');
const timeRe = () => /\b(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b|\bnoon\b|\bmidday\b/gi;
const moneyRe = () => /£\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s?(k|m|million|thousand)\b)?/gi;

const dayKey = (s: string) => {
  const t = s.toLowerCase();
  if (/today|tomorrow|tonight|weekend|next week/.test(t)) return t.replace(/\s+/g, ' ');
  return DAYS.find((d) => t.startsWith(d)) ?? t;
};
function hoursIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(timeRe())) {
    if (/noon|midday/i.test(m[0])) { out.add(12); continue; }
    let h = Number(m[1] ?? m[4]);
    const ap = m[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    out.add(h);
  }
  return out;
}
function amountsIn(text: string): number[] {
  return [...text.matchAll(moneyRe())].map((m) => {
    const n = Number(m[1].replace(/,/g, ''));
    const unit = m[2]?.toLowerCase();
    return unit === 'k' || unit === 'thousand' ? n * 1000 : unit === 'm' || unit === 'million' ? n * 1_000_000 : n;
  });
}
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.005);
/** Applies fn to the text outside [placeholders], so placeholders themselves are never rewritten. */
const outside = (text: string, fn: (s: string) => string) => text.split(/(\[[^[\]\n]{1,60}\])/g).map((part, i) => (i % 2 ? part : fn(part))).join('');

const PRICE_FLEX = /\b(price is negotiable|(price|asking|rent)\b[^.!?\n]{0,30}\b(flexible|negotiable)|flexib\w* (on|about|with) (the )?(price|asking|rent)|room (for|to) (manoeuvre|negotiate|negotiation)|open to (offers|negotiation)|(would|will|could|happy to|might) (accept|consider|take) (a )?(lower|less|offers? (below|under))|(lower|reduce|drop)(ed|ing)? (the |my |our )?(price|asking|rent)|discount on (the )?(price|rent)|below (the )?asking|under (the )?asking|best and final|other offers|several offers|(lots|a lot) of interest)\b/i;
const FEES = /\b(admin(istration)? fees?|referencing fees?|reference fees?|check[- ]?(in|out) fees?|set[- ]?up fees?|viewing fees?|application fees?|renewal fees?|inventory fees?)\b/i;
const BIDDING = /\b(offers? (over|above|in excess of) (the )?(rent|asking)|best offer|highest (bid|offer)|bidding war|bidding|bids)\b/i;
const DISCRIM = /\b(no (dss|benefits|housing benefit|universal credit|children|kids|families|students)|professionals only|working professionals only|suit(s|able for)? (a )?(young )?(couple|professional)|nationality|religio\w+|pregnan\w*|married couples?|single (person|man|woman) only)\b/i;
const MONEY_REQUEST = /\b(bank details|sort code|account number|send (me |us )?(the |a )?(money|deposit|payment|funds)|transfer (the |a )?(money|deposit|payment))\b/i;

const sentences = (s: string) => s.match(/[^.!?\n]+[.!?]*[ \t]*|\n+/g) ?? [s];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ReplyContext {
  listing: Pick<ListingRow, 'address_line' | 'postcode' | 'district' | 'price' | 'service_charge_annual' | 'ground_rent_annual' | 'channel' | 'source_kind'>;
  /** What the lister typed for this draft. */
  notes: string;
  preferredSlot: string;
  /** The conversation so far (both sides). */
  thread: string;
  /** Listing text (description, features, material information): amounts here are listing facts. */
  listingText?: string;
}

/** Applies the code checks to a draft. Returns the cleaned reply, its placeholders and warnings. */
export function checkReply(draft: ReplyOut, ctx: ReplyContext): ReplyOut {
  const warnings: string[] = [];
  let reply = draft.reply.replace(/\r/g, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500);
  const notes = ctx.notes;
  const sources = `${notes}\n${ctx.preferredSlot}\n${ctx.thread}`;

  // 1) Price flexibility or other buyers' interest: only if the lister said so.
  if (!PRICE_FLEX.test(notes)) {
    const kept = sentences(reply).filter((x) => !PRICE_FLEX.test(x));
    if (kept.join('') !== reply) { reply = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); warnings.push('We removed wording about price flexibility or other offers. Only add it if you mean it.'); }
  }

  // 2) Money: only amounts from the listing, the notes or the conversation.
  const allowedMoney = [ctx.listing.price, ctx.listing.service_charge_annual, ctx.listing.ground_rent_annual, ...amountsIn(`${sources}\n${ctx.listingText ?? ''}`)]
    .filter((n): n is number => typeof n === 'number' && n > 0);
  let moneyFixed = false;
  reply = outside(reply, (seg) => seg.replace(moneyRe(), (m) => {
    const [n] = amountsIn(m);
    if (n != null && allowedMoney.some((a) => sameAmount(n, a))) return m;
    moneyFixed = true; return '[amount]';
  }));
  if (moneyFixed) warnings.push('We replaced an amount that isn’t in your listing or notes with [amount]. Fill it in only if you’re sure.');

  // 3) Availability: days, dates and times must come from the notes or the conversation.
  const srcDays = new Set([...sources.matchAll(dayRe())].map((m) => dayKey(m[0])));
  const srcHours = hoursIn(sources);
  const srcDates = new Set([...sources.matchAll(dateRe())].map((m) => m[0].toLowerCase().replace(/\s+/g, ' ')));
  let timeFixed = false;
  reply = outside(reply, (seg) => seg
    .replace(timeRe(), (m) => { const [h] = [...hoursIn(m)]; if (h != null && srcHours.has(h)) return m; timeFixed = true; return '[time]'; })
    .replace(dateRe(), (m) => { if (srcDates.has(m.toLowerCase().replace(/\s+/g, ' '))) return m; timeFixed = true; return '[date]'; })
    .replace(dayRe(), (m) => { if (srcDays.has(dayKey(m))) return m; timeFixed = true; return '[day]'; }));
  if (timeFixed) warnings.push('We replaced days or times you haven’t given with placeholders. Add only times you can do.');

  // 4) A private seller's address stays private unless they typed it.
  if (isPrivateSeller(ctx.listing.source_kind)) {
    let addr = false;
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
    const notesN = norm(notes);
    const street = streetOnly(ctx.listing.address_line);
    for (const part of ctx.listing.address_line.split(',').map((x) => x.trim()).filter((x) => /\d/.test(x))) {
      if (notesN.includes(norm(part))) continue;
      const re = new RegExp(`\\b${escapeRe(part).replace(/\s+/g, '\\s+')}\\b`, 'gi');
      if (re.test(reply)) { reply = reply.replace(re, /[a-z]{3,}/i.test(part.replace(/^(flat|apartment|apt|unit|house)\b/i, '')) ? street : '[flat or house number]'); addr = true; }
    }
    const pc = ctx.listing.postcode.replace(/\s+/g, '');
    if (pc.length > 4 && !notesN.replace(/\s/g, '').includes(pc.toLowerCase())) {
      const pcRe = new RegExp(`\\b${escapeRe(pc.slice(0, -3))}\\s*${escapeRe(pc.slice(-3))}\\b`, 'gi');
      if (pcRe.test(reply)) { reply = reply.replace(pcRe, ctx.listing.district); addr = true; }
    }
    if (addr) warnings.push('We removed your full address. Share it only when you’re ready, for example once a viewing is confirmed.');
  }

  // 5) Legal wording to check.
  if (ctx.listing.channel === 'rent' && FEES.test(reply)) warnings.push('The draft mentions a fee. Under the Tenant Fees Act 2019 you can only charge permitted payments (rent, capped deposits and a few others).');
  if (ctx.listing.channel === 'rent' && BIDDING.test(reply)) warnings.push('Don’t invite offers above the advertised rent: rental bidding is banned.');
  if (DISCRIM.test(reply)) warnings.push('Remove wording that could discriminate (Equality Act 2010), such as preferences about who should live there.');
  if (MONEY_REQUEST.test(reply)) warnings.push('Never ask for money or bank details through messages. Use a documented, secure process.');

  const found = [...new Set(reply.match(/\[[^[\]\n]{1,60}\]/g) ?? [])];
  const modelWarnings = draft.warnings.map((w) => clip(w, 220)).filter(Boolean).slice(0, 4);
  return { reply, placeholders: found.slice(0, 12), warnings: [...new Set([...warnings, ...modelWarnings])].slice(0, 8) };
}

export interface SuggestInput { intent: ReplyIntent; tone: ReplyTone; notes?: string | null }

export async function suggestReply(e: EnquiryRow, input: SuggestInput, userId: string): Promise<ReplyOut> {
  const l = await one<ListingRow>(`${LISTING_SELECT} WHERE l.id = $1`, [e.listing_id]);
  if (!l) throw new Error('listing missing');
  const msgs = await q<{ author: 'enquirer' | 'lister'; body: string; created_at: Date }>(
    'SELECT author, body, created_at FROM enquiry_messages WHERE enquiry_id = $1 ORDER BY created_at DESC LIMIT 10', [e.id]);
  msgs.reverse();
  const thread = msgs.map((m) => `${m.author === 'enquirer' ? 'Enquirer' : 'Lister (me)'} · ${m.created_at.toISOString().slice(0, 10)}: ${m.body.slice(0, 1200)}`).join('\n---\n');
  const notes = clip(input.notes, 800);
  const firstName = clip(e.name, 80).split(' ')[0] ?? '';
  const facts = listingFacts(l);
  const user = [
    `Task: ${INTENT_GUIDE[input.intent]}`,
    `Tone: ${TONE_GUIDE[input.tone]}`,
    `Enquiry type: ${e.kind === 'viewing' ? 'viewing request' : e.kind}. Conversation status: ${e.status}.`,
    untrusted('LISTING', JSON.stringify(facts, null, 1), 7000),
    untrusted('NOTES', notes || '(none)', 1000),
    untrusted('ENQUIRER', `First name: ${firstName || '(not given)'}\nPreferred viewing time they gave: ${e.preferred_slot ?? '(none)'}`, 300),
    untrusted('THREAD', thread, 9000),
  ].join('\n\n');
  const draft = await chatJSON<ReplyOut>([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], ReplySchema, 'reply_draft',
    { purpose: 'inbox.reply', userId, role: 'fast', maxTokens: 1500, effort: 'low' });
  const listingText = [facts.description, ...(facts.features ?? []), JSON.stringify(facts.materialInformation)].join('\n');
  return checkReply(draft, { listing: l, notes, preferredSlot: e.preferred_slot ?? '', thread: msgs.map((m) => m.body).join('\n'), listingText });
}
