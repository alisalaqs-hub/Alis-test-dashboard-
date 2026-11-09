/**
 * "Suggest a reply" for listers: an editable draft grounded in the listing's own facts and the
 * conversation. It is never sent automatically. Code checks the draft after the model writes it:
 *   - money amounts ("£450,000", "450k", "450,000", "1200 pcm") that aren't in the listing, the lister's
 *     notes or the lister's own earlier messages become [amount]. Figures the enquirer quoted are
 *     never treated as verified ("Is the service charge £900?" is a question, not a fact);
 *   - days, dates and times become [day] / [date] / [time] unless the lister gave them (notes or their
 *     own messages). Only when confirming a viewing may the enquirer's own requested time be used;
 *   - sentences about price flexibility, accepting an offer or other buyers' interest are removed
 *     unless the lister's notes say the same thing (or give the same amount);
 *   - a private seller's house number and full postcode are removed unless the lister typed them;
 *   - Tenant Fees Act, rental bidding, discrimination and "send money" wording raise warnings.
 */
import { chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one, q } from '../../db';
import { LISTING_SELECT, streetOnly, type ListingRow } from '../../services/listings';
import { clip, isPrivateSeller, redactContacts, type EnquiryRow } from './shared';

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
  'Amounts, days or times the enquirer mentions are their questions or requests, not facts: never confirm them unless LISTING or NOTES give them.',
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
/**
 * Money, in the forms people write it: "£450,000", "£1.2m", "450k", "450,000", "1200 pcm".
 *   1-2  £ amounts (optionally with k / m / million)
 *   3-4  bare amounts with k / m / million / thousand ("m" only near price words: "10m" is often metres)
 *   5    bare amounts of 1,000 or more written with commas, or 10000 and over without
 *   6    four-figure amounts followed by a rent period ("1200 pcm")
 * Floor areas, distances, phone numbers and years are not money.
 */
const moneyRe = () => /£\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s?(k|m|bn|million|thousand)\b)?|(?<![\w£.,/-])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s?(k|m|million|thousand)\b|(?<![\w£.,/+-])([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{4,})(?![\d,]|\.\d)|(?<![\w£.,/+-])([1-9]\d{3})(?=\s?(?:pcm|pw|pa|per (?:calendar )?month|a month|per week|a week|per annum|a year|per year)\b)/gi;
const phoneRe = () => /(?:\+44\s?|\b0)(?:\d[\s-]?){8,9}\d(?!\d)/g;
const NOT_MONEY_AFTER = /^\s?(?:sq\.?\s?(?:ft|feet|m|metres|meters)|square|m2|m²|sqm|sqft|ft\b|feet|foot|metres?|meters?|miles?|km\b|kilomet|kwh|people|views|visitors|words|photos|acres?|hectares?|years?\b)/i;
const PRICE_NEAR = /£|\b(?:price|asking|offers?|rent|deposit|pay|paying|bid|sale|sell|sold|budget|valuation|worth|cost|value|charge|fee|accept|mortgage|pcm|cash|for|at)\b/i;

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
interface MoneyHit { index: number; end: number; text: string; value: number }
/** Every money amount in a text, with where it is. */
function moneyIn(text: string): MoneyHit[] {
  const phones = [...text.matchAll(phoneRe())].map((m) => [m.index!, m.index! + m[0].length] as const);
  const out: MoneyHit[] = [];
  for (const m of text.matchAll(moneyRe())) {
    const index = m.index!, end = index + m[0].length;
    if (phones.some(([a, b]) => index < b && end > a)) continue;
    let num: string, unit: string | undefined;
    if (m[1] != null) { num = m[1]; unit = m[2]; }
    else if (m[3] != null) {
      num = m[3]; unit = m[4];
      if (NOT_MONEY_AFTER.test(text.slice(end))) continue;
      if (/^m/i.test(unit) && !PRICE_NEAR.test(`${text.slice(Math.max(0, index - 25), index)} ${text.slice(end, end + 12)}`)) continue;
    } else if (m[5] != null) { num = m[5]; if (NOT_MONEY_AFTER.test(text.slice(end))) continue; }
    else num = m[6];
    const n = Number(num.replace(/,/g, ''));
    const u = unit?.toLowerCase();
    const value = u === 'k' || u === 'thousand' ? n * 1000 : u === 'm' || u === 'million' ? n * 1_000_000 : u === 'bn' ? n * 1_000_000_000 : n;
    if (Number.isFinite(value)) out.push({ index, end, text: m[0], value });
  }
  return out;
}
const amountsIn = (text: string) => moneyIn(text).map((h) => h.value);
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.005);
/** Applies fn to the text outside [placeholders], so placeholders themselves are never rewritten. */
const outside = (text: string, fn: (s: string) => string) => text.split(/(\[[^[\]\n]{1,60}\])/g).map((part, i) => (i % 2 ? part : fn(part))).join('');

/**
 * Wording about price negotiation, accepting an offer or other buyers' interest. Each rule has an
 * id, so a sentence is kept only when the lister's notes say the same kind of thing (and with the
 * same polarity: "not negotiable" in the notes never lets "negotiable" through).
 */
const FLEX_RULES: { id: string; re: RegExp; skip?: (sentence: string) => boolean }[] = [
  { id: 'negotiable', re: /\b(?:negotiable|negotiat(?:e|ing|ion)|flexib\w* (?:on|about|with|over) (?:the )?(?:price|asking|rent)|room (?:for|to) (?:manoeuvre|negotiat\w*|move)|wiggle room|leeway)\b/i,
    // "The move-in date is negotiable" is about dates, not price.
    skip: (x) => !/£|\b(?:price|asking|rent|offers?)\b/i.test(x) && /\b(?:dates?|move[- ]?in|moving|start|tenancy|viewings?|times?|days?|furnish\w*|length|term|completion|exchange)\b/i.test(x) },
  { id: 'open', re: /\bopen to (?:offers|negotiation|any offers?|sensible offers|reasonable offers|bids)\b|\b(?:offers|o\.?i\.?r\.?o\.?) (?:in the region of|around|near|close to)\b/i },
  { id: 'accept', re: /(?:\b(?:would|will|could|can|might|shall|happy to|willing to|prepared to|able to|glad to)|['’](?:d|ll))\s+(?:(?:be|definitely|probably|certainly|also|still)\s+)*(?:(?:happy|willing|prepared|able|glad)\s+to\s+)?(?:accept|take|agree to|go ahead (?:at|with)|settle (?:for|at|on))\s+(?:a |an |any |your |the |that |this |their )?(?:lower|less|reduced|offers?|bids?|price|amount|figure|\[amount\]|£|\d)(?![^.!?\n]{0,30}\bto (?:the|my|our) (?:seller|vendor|client|landlord|owner)s?\b)/i },
  { id: 'accepted', re: /\baccept(?:ing|ed)?\s+(?:your|the|an|this|that|their)\s+(?:offer|bid)\b|\b(?:offer|bid) (?:is |has been |was )?accepted\b|\b(?:we have|we['’]ve got|i['’]ve got|it['’]?s|that['’]?s|you have|you['’]ve got) a deal\b|\bdeal agreed\b|\b(?:offer|price|sale) (?:is |has been )?agreed\b|\bagreed (?:price|offer|sale)\b|\bagree (?:to|on) (?:a|the|that|your) (?:price|offer|figure|sale)\b/i },
  { id: 'consider', re: /\bconsider(?:ing)?\s+(?:any|all)\s+(?:reasonable |sensible |serious )?offers?\b|\b(?:consider|entertain)(?:ing)?\s+(?:a |an |any |all )?(?:reasonable|sensible|serious|lower|reduced|near|close)\b|\b(?:reasonable|sensible|serious) offers?\b/i },
  { id: 'reduce', re: /\boff (?:the )?(?:asking|price|rent)\b|\b(?:below|under) (?:the )?asking\b|\b(?:lower|reduce|drop|cut)(?:ed|ing|s)?\s+(?:the |my |our )?(?:price|asking|rent)\b|\bknock(?:ing)? (?:\S+ ){0,3}off\b|\bdiscount\w* (?:on|off|for) (?:the )?(?:price|rent|asking)\b|\b(?:price|rent) (?:discount|drop|reduction|cut)\b|\bquick sale\b|\bbest and final\b|\bmotivated (?:seller|vendor|landlord)\b/i },
  { id: 'interest', re: /\b(?:other|several|multiple|many|lots of|a lot of|plenty of|loads of|a number of)\s+(?:other\s+)?(?:offers|bids|buyers|bidders|viewers|applicants|interested (?:parties|people|buyers)|enquiries)\b|\banother (?:buyer|offer|bid|bidder|party|applicant|viewer|tenant)\b|\bother (?:buyers|people|parties|applicants|tenants|viewers) (?:are|have|were|who|interested)\b|\b(?:lots|a lot|plenty|loads|huge amounts?|a great deal) of interest\b|\b(?:high|strong|huge) (?:demand|interest)\b|\b(?:selling|going|moving|letting) (?:really |very )?(?:fast|quickly)\b|\bwon['’]t (?:last|hang around|be around)\b|\balready (?:had|received|got|have) (?:an? |some |several )?(?:offers?|bids?|interest|viewings?)\b|\b(?:viewed|seen) it (?:twice|several times|\w+ times)\b/i },
];
const NEGATION_BEFORE = /\b(?:not|non|never|no longer|isn['’]t|aren['’]t|won['’]t|wouldn['’]t|can['’]t|cannot|unable to)\b[^,;]*$/i;
/** Which kinds of price talk a text contains, e.g. ['accept', 'negotiable:neg']. */
function flexHits(text: string): string[] {
  const out: string[] = [];
  for (const r of FLEX_RULES) {
    const m = r.re.exec(text);
    if (!m || r.skip?.(text)) continue;
    out.push(NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 15), m.index)) ? `${r.id}:neg` : r.id);
  }
  return out;
}
const FEES = /\b(admin(istration)? fees?|referencing fees?|reference fees?|check[- ]?(in|out) fees?|set[- ]?up fees?|viewing fees?|application fees?|renewal fees?|inventory fees?)\b/i;
const BIDDING = /\b(offers? (over|above|in excess of) (the )?(rent|asking)|best offer|highest (bid|offer)|bidding war|bidding|bids)\b/i;
const DISCRIM = /\b(no (dss|benefits|housing benefit|universal credit|children|kids|families|students)|professionals only|working professionals only|suit(s|able for)? (a )?(young )?(couple|professional)|nationality|religio\w+|pregnan\w*|married couples?|single (person|man|woman) only)\b/i;
const MONEY_REQUEST = /\b(bank details|sort code|account number|send (me |us )?(the |a )?(money|deposit|payment|funds)|transfer (the |a )?(money|deposit|payment))\b/i;

/** Splits into sentences without breaking "£1.2m", "e.g." or web addresses. */
const sentences = (s: string) => s.match(/(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*[ \t]*|[.!?]+[ \t]*|\n+/g) ?? [s];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ReplyContext {
  listing: Pick<ListingRow, 'address_line' | 'postcode' | 'district' | 'price' | 'service_charge_annual' | 'ground_rent_annual' | 'channel' | 'source_kind'>;
  /** What the reply is for: only a viewing confirmation may repeat the enquirer's requested time. */
  intent: ReplyIntent;
  /** What the lister typed for this draft. */
  notes: string;
  /** The viewing time the enquirer asked for in the form (a request, not availability). */
  preferredSlot: string;
  /** What the enquirer has written: requests and questions, never verified facts. */
  enquirerText: string;
  /** What the lister has already written in this conversation (their own facts and times). */
  listerText: string;
  /** Listing text (description, features, material information): amounts here are listing facts. */
  listingText?: string;
}

/** Applies the code checks to a draft. Returns the cleaned reply, its placeholders and warnings. */
export function checkReply(draft: ReplyOut, ctx: ReplyContext): ReplyOut {
  const warnings: string[] = [];
  let reply = draft.reply.replace(/\r/g, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500);
  const notes = ctx.notes;
  const lister = `${notes}\n${ctx.listerText}`;

  // 1) Price negotiation, accepting an offer, other buyers' interest: only if the lister's notes say
  //    the same thing (same kind and polarity), or give the same amount alongside such wording.
  const notesHits = new Set(flexHits(notes));
  const notesAmounts = amountsIn(notes);
  const kept = sentences(reply).filter((x) => {
    const hits = flexHits(x);
    if (!hits.length || hits.every((h) => notesHits.has(h))) return true;
    const amounts = amountsIn(x);
    return notesHits.size > 0 && amounts.length > 0 && amounts.every((a) => notesAmounts.some((b) => sameAmount(a, b)));
  });
  if (kept.join('') !== reply) {
    reply = kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    warnings.push('We removed wording about price flexibility, accepting an offer or other buyers’ interest. Only add it if it’s true and you mean it.');
  }

  // 2) Money: only amounts from the listing, the lister's notes or the lister's own messages.
  //    An amount only the enquirer mentioned is their question, not a fact to confirm.
  const allowedMoney = [ctx.listing.price, ctx.listing.service_charge_annual, ctx.listing.ground_rent_annual, ...amountsIn(`${lister}\n${ctx.listingText ?? ''}`)]
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const enquirerMoney = amountsIn(ctx.enquirerText);
  let moneyFixed = false, theirAmount = false;
  reply = outside(reply, (seg) => {
    let out = '', last = 0;
    for (const h of moneyIn(seg)) {
      out += seg.slice(last, h.index);
      last = h.end;
      if (allowedMoney.some((a) => sameAmount(h.value, a))) { out += h.text; continue; }
      out += '[amount]'; moneyFixed = true;
      if (enquirerMoney.some((a) => sameAmount(h.value, a))) theirAmount = true;
    }
    return out + seg.slice(last);
  });
  if (theirAmount) warnings.push('The draft repeated an amount from the enquirer’s message that isn’t in your listing, so we replaced it with [amount]. Don’t confirm a figure you haven’t checked.');
  else if (moneyFixed) warnings.push('We replaced an amount that isn’t in your listing or notes with [amount]. Fill it in only if you’re sure.');

  // 3) Availability: days, dates and times must come from the lister (notes or their own messages).
  //    Only a viewing confirmation may also use the time the enquirer asked for.
  const sources = ctx.intent === 'confirm_viewing' ? `${lister}\n${ctx.preferredSlot}\n${ctx.enquirerText}` : lister;
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
  const thread = msgs.map((m) => `${m.author === 'enquirer' ? 'Enquirer' : 'Lister (me)'} · ${m.created_at.toISOString().slice(0, 10)}: ${redactContacts(m.body.slice(0, 1200))}`).join('\n---\n');
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
  const by = (a: 'enquirer' | 'lister') => msgs.filter((m) => m.author === a).map((m) => m.body).join('\n');
  return checkReply(draft, { listing: l, intent: input.intent, notes, preferredSlot: e.preferred_slot ?? '', enquirerText: by('enquirer'), listerText: by('lister'), listingText });
}
