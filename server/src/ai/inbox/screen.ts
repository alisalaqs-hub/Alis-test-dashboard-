/**
 * Spam and scam screen for new enquiries.
 *
 * Deliberately conservative: a genuine buyer or tenant must never be held back. The order is
 *   1. cheap code heuristics (links, crypto, "send me the deposit", "my agent will pay", the same
 *      text sent to many listings…) and OpenAI moderation, in parallel;
 *   2. clear-cut cases are decided by code alone: severe moderation categories, or a strong score
 *      across at least two families that includes at least one UNAMBIGUOUS marker (crypto payment,
 *      money-transfer services or gift cards, an overpayment story, phishing, a shortened or
 *      "verify / pay here" link, advertising, or the same text sent to many listings). Soft signals
 *      that genuine people produce every day (living abroad, a relocation agent, an ordinary link,
 *      offering a holding deposit, WhatsApp) never hold a message back on their own, however many
 *      of them there are;
 *   3. otherwise, when anything looks unusual, a short 'fast' model classification, which must say
 *      spam/scam with high confidence to hold a message back.
 * Each signal family counts once (its strongest signal). Any AI failure or timeout lets the
 * message through. The whole screen answers within ~5.5s.
 *
 * Held-back enquiries are kept (the lister sees them under "Filtered" and can release them);
 * the reason shown is written by code from the signals, never free text from the model.
 */
import type { EnquiryScreenInput, ScreenVerdict } from '../hooks';
import { aiAvailable, chatJSON, HOUSE_RULES, moderate, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { one } from '../../db';
import { normaliseText } from './shared';

export type SignalFamily = 'link' | 'payment' | 'crypto' | 'abroad' | 'phishing' | 'marketing' | 'offplatform' | 'repeat' | 'moderation' | 'shouting';
/** strong = an unambiguous marker of spam or a scam (required before code alone holds a message back). */
export interface Signal { id: string; family: SignalFamily; weight: number; reason: string; strong: boolean }

const SCAM_FAMILIES: SignalFamily[] = ['payment', 'crypto', 'abroad', 'phishing'];

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]{2,}\.(?:com|net|org|info|biz|xyz|top|site|online|club|shop|io|co|ru|cn|tk|ml|ga|cf|gq|link|click)(?:\/[^\s<>"']*)?\b/gi;
const SHORTENER_RE = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|linktr\.ee|shorturl\.at|tiny\.cc|rb\.gy)\b/i;
/** Click-to-chat links: the same as saying "WhatsApp me", which genuine people do all the time. */
const MESSAGING_LINK_RE = /\b(?:wa\.me|t\.me|chat\.whatsapp\.com|api\.whatsapp\.com|whatsapp\.com|telegram\.me|m\.me)\b/i;
/** Well-known property portals, official and social sites: mentioning them is ordinary. */
const KNOWN_SITE_RE = /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)*(?:rightmove|zoopla|onthemarket|openrent|spareroom|primelocation|gumtree|linkedin|facebook|instagram|streetkey|gov|nhs|police|bbc|google|youtube|youtu|ons|tfl|nationalrail)\.(?:co\.uk|com|uk|co|org\.uk|org|be)\b/i;
/** A link that asks the lister to verify, secure, claim or pay something: a phishing pattern. */
const PHISHING_LINK_RE = /verif|secur|claim|pay|login|log-in|sign-?in|confirm|wallet|refund|unlock|reward|prize|bonus|account/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const RULES: { id: string; family: SignalFamily; weight: number; strong: boolean; re: RegExp; reason: string }[] = [
  // Paying in, or being paid in, cryptocurrency (or a wallet address): unambiguous.
  { id: 'crypto', family: 'crypto', weight: 3, strong: true, re: /\b(?:pay|paid|send|sent|transfer|wire)\s+(?:you\s+|it\s+|me\s+|us\s+|the\s+\w+\s+)?(?:in|with|via|using|by)\s+(?:bitcoin|btc|usdt|tether|ethereum|eth|crypto(?:currency)?)\b|\b(?:bitcoin|btc|usdt|tether|ethereum|crypto(?:currency)?) (?:payment|transfer|wallet)s?\b|\b\d+(?:\.\d+)?\s?(?:btc|bitcoin|eth|usdt)\b|\bwallet address\b|\bbc1[ac-hj-np-z02-9]{25,62}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\b0x[a-fA-F0-9]{40}\b/i, reason: 'mentions paying in cryptocurrency' },
  // Merely mentioning crypto ("I made my money in crypto") is not a scam on its own.
  { id: 'crypto-mention', family: 'crypto', weight: 2, strong: false, re: /\b(?:bitcoin|btc|usdt|tether|ethereum|crypto(?:currency)?|binance|coinbase)\b/i, reason: 'mentions cryptocurrency' },
  { id: 'wire', family: 'payment', weight: 3, strong: true, re: /\b(?:western union|moneygram|money ?gram|gift ?cards?|itunes cards?|steam cards?|google play cards?|amazon vouchers?|paysafe ?card|money transfer agent)\b/i, reason: 'mentions money-transfer services or gift cards' },
  // An overpayment story told by the sender ("I will overpay", "refund the difference"), not "we don't want to overpay".
  { id: 'overpay', family: 'payment', weight: 3, strong: true, re: /\b(?:i|we|my \w+)\s+(?:will|would|shall|have|had|has|can|['’]ll|['’]ve)\s+(?:accidentally\s+|mistakenly\s+)?over-?pa(?:id|y)\b|\brefund (?:of )?the overpayment\b|\brefund (?:me |us )?the (?:difference|balance|excess|extra)\b|\bcheque for (?:more|a higher amount|a larger amount)\b|\b(?:certified|cashier['’]?s) cheque\b|\bbank draft\b/i, reason: 'mentions an overpayment or refund, a common scam' },
  // Asking the LISTER to send money ("send me the deposit", "transfer the money to my agent"), never the enquirer offering to pay.
  { id: 'send-money', family: 'payment', weight: 2, strong: false, re: /\b(?:send|transfer|wire|remit)\s+(?:me|us)\s+(?:the\s+|a\s+|your\s+|some\s+)?(?:holding\s+|security\s+|reservation\s+|refundable\s+)?(?:deposit|money|payment|funds|fee|advance|refund|cash)\b|\b(?:send|transfer|wire|remit)\s+(?:the\s+|a\s+|your\s+|some\s+)?(?:holding\s+|security\s+|reservation\s+|refundable\s+)?(?:deposit|money|payment|funds|fee|refund|cash)\s+(?:back\s+)?(?:to|into)\s+(?:me|us|my|our)\b/i, reason: 'asks for money to be sent to them' },
  { id: 'fee-scam', family: 'payment', weight: 2, strong: false, re: /\b(?:advance fee|processing fee|clearance fee|transfer fee|release (?:the |my )?funds|unlock (?:the )?funds)\b/i, reason: 'mentions fees to release or process money' },
  { id: 'abroad', family: 'abroad', weight: 2, strong: false, re: /\b(?:i am|i['’]m|im|currently|presently|now|living|working|based|stationed|deployed|(?:i|we)\s+(?:work|live))\s+(?:abroad|overseas|offshore|out of the (?:country|uk)|on an oil rig|at sea)\b/i, reason: 'says they are abroad and can’t view in person' },
  // A third party who will pay or collect money or keys. Relocation agents, lawyers and solicitors arranging or handling things are ordinary.
  { id: 'agent-abroad', family: 'abroad', weight: 2, strong: false, re: /\bmy\s+(?:agent|representative|shipping agent|courier|diplomat|associate|secretary|cousin|friend|brother|sister|uncle|son|daughter)s?\s+(?:will|would|can|shall|is going to|['’]ll)\s+(?:pay|send (?:you )?(?:the |a )?(?:money|payment|funds|cheque|deposit)|transfer (?:the |you )?(?:money|funds|payment|deposit)|wire|collect (?:the )?(?:keys|money|payment|deposit|cheque|funds)|bring (?:the )?(?:money|cash|payment))/i, reason: 'says someone else will pay or collect for them' },
  { id: 'third-party', family: 'abroad', weight: 1, strong: false, re: /\bmy\s+(?:agent|representative|shipping agent|courier|diplomat|associate|secretary)\s+(?:will|would|can|shall|is going to|['’]ll)\s+(?:handle|arrange|deal with|take care of|sort)\s+(?:everything|it all|all of it|the rest|the (?:payment|deposit|money|transaction|keys))\b/i, reason: 'says someone else will handle everything' },
  // Phishing aimed at the lister: card security codes, passwords, one-time codes, "verify your listing".
  { id: 'phishing', family: 'phishing', weight: 3, strong: true, re: /\b(?:cvv|cvc|(?:your|the) card number|(?:your|the) (?:online banking |bank |account )?(?:password|log-?in details|pin number)|one[- ]time (?:code|passcode|password)|(?:send|share|give|tell|forward)\s+(?:me|us)\s+(?:the|your)\s+(?:\d-digit\s+)?(?:verification|security|confirmation|whatsapp) (?:code|pin)|verify your (?:account|listing|identity|email|details|ad|advert|property)|confirm your (?:account|listing|advert|ad) (?:details|here|now|below)|(?:your )?(?:account|listing|advert) (?:will be|has been) (?:suspended|deactivated|removed|locked))\b/i, reason: 'asks for bank, login or identity details' },
  { id: 'id-request', family: 'phishing', weight: 2, strong: false, re: /\b(?:copy|scan|photo|picture) of your (?:passport|id|driving licen[cs]e|bank statement|bank card)\b|\byour (?:passport|id card) (?:copy|scan|photo)\b/i, reason: 'asks for a copy of your identity documents' },
  { id: 'marketing', family: 'marketing', weight: 2, strong: true, re: /\b(?:seo services|backlinks?|guest posts?|rank(?:ing)? (?:on|in) google|first page of google|(?:we|i) (?:offer|provide|can help (?:you )?with)\s+(?:\w+\s+){0,2}(?:seo|marketing|web ?design|social media|lead generation|backlinks?)|web ?design services|lead generation services|we buy any (?:house|home)|sell your (?:house|home|property) (?:fast|in \d+)|cash buyers? guaranteed|click here|unsubscribe|limited[- ]time offer|casino|viagra|cialis|forex signals?|binary options|(?:exclusive|lucrative|guaranteed) investment opportunit(?:y|ies)|earn (?:\$|£)\d|earn money from home|loan offers?|cheap loans?)\b/i, reason: 'reads like advertising or marketing' },
  { id: 'offplatform', family: 'offplatform', weight: 1, strong: false, re: /\b(?:whats\s?app|telegram|signal app|wechat|viber)\b/i, reason: 'moves the conversation to a messaging app' },
];

/** Code-only signals for a message (and the sender's name, where spammers often put links). */
export function heuristics(message: string, name = ''): Signal[] {
  const text = `${name}\n${message}`;
  const out: Signal[] = [];
  // Email addresses aren't links ("sam@gmail.com" must not count as a web address); nor are
  // click-to-chat links or well-known sites such as property portals.
  const urls = (text.replace(EMAIL_RE, ' ').match(URL_RE) ?? []).filter((u) => !/^[\d.]+$/.test(u));
  const links = urls.filter((u) => !MESSAGING_LINK_RE.test(u) && !KNOWN_SITE_RE.test(u));
  if (SHORTENER_RE.test(text)) out.push({ id: 'shortener', family: 'link', weight: 3, strong: true, reason: 'contains a shortened web link' });
  else if (links.some((u) => PHISHING_LINK_RE.test(u))) out.push({ id: 'phishing-link', family: 'link', weight: 3, strong: true, reason: 'contains a web link to verify, secure or pay for something' });
  else if (links.length >= 2) out.push({ id: 'links', family: 'link', weight: 3, strong: false, reason: 'contains several web links' });
  else if (links.length === 1) out.push({ id: 'link', family: 'link', weight: 2, strong: false, reason: 'contains a web link' });
  if (MESSAGING_LINK_RE.test(text)) out.push({ id: 'messaging-link', family: 'offplatform', weight: 1, strong: false, reason: 'moves the conversation to a messaging app' });
  // A second email address in the message body (beyond the one given in the form) often means "contact me elsewhere".
  if ((message.match(EMAIL_RE) ?? []).length >= 2) out.push({ id: 'emails', family: 'offplatform', weight: 1, strong: false, reason: 'lists several email addresses' });
  for (const r of RULES) if (r.re.test(text)) out.push({ id: r.id, family: r.family, weight: r.weight, strong: r.strong, reason: r.reason });
  const letters = message.replace(/[^A-Za-z]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) out.push({ id: 'shouting', family: 'shouting', weight: 1, strong: false, reason: 'is written mostly in capitals' });
  return out;
}

/** The strongest signal of each family: families count once, however many of their patterns match. */
function topPerFamily(signals: Signal[]): Signal[] {
  const best = new Map<SignalFamily, Signal>();
  for (const s of signals) {
    const b = best.get(s.family);
    if (!b || s.weight > b.weight || (s.weight === b.weight && s.strong && !b.strong)) best.set(s.family, s);
  }
  return [...best.values()];
}

export interface Assessment { score: number; families: number; strong: boolean; rulesDecide: boolean; kind: 'spam' | 'scam' }
/**
 * Scores the signals (each family once, at its strongest) and says whether code alone may hold
 * the message back: only with a high score across two or more families that includes at least
 * one unambiguous marker. Everything else goes to the model (or straight through).
 */
export function assess(signals: Signal[]): Assessment {
  const top = topPerFamily(signals);
  const score = top.reduce((s, x) => s + x.weight, 0);
  const strong = signals.some((s) => s.strong);
  const kind = signals.some((s) => SCAM_FAMILIES.includes(s.family) || s.id === 'phishing-link') ? 'scam' : 'spam';
  return { score, families: top.length, strong, rulesDecide: strong && score >= 5 && top.length >= 2, kind };
}

/** The same text from the same email address, recently, to this or other listings. */
export async function repetition(email: string, message: string, enquiryId: string): Promise<Signal[]> {
  const norm = normaliseText(message);
  if (norm.length < 25) return []; // short messages ("Is it still available?") are naturally repeated
  const r = await one<{ n: number; listings: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT e.listing_id)::int AS listings
       FROM enquiries e JOIN enquiry_messages m ON m.enquiry_id = e.id AND m.author = 'enquirer'
      WHERE e.email = $1 AND e.id <> $2 AND e.created_at > now() - interval '7 days'
        AND lower(btrim(regexp_replace(m.body, '\\s+', ' ', 'g'))) = $3`, [email, enquiryId, norm]);
  if (!r || r.n === 0) return [];
  if (r.listings >= 10) return [{ id: 'repeat-many', family: 'repeat', weight: 3, strong: true, reason: `the same message was sent to ${r.listings} other listings this week` }];
  if (r.listings >= 4) return [{ id: 'repeat', family: 'repeat', weight: 2, strong: false, reason: `the same message was sent to ${r.listings} other listings this week` }];
  if (r.n >= 2 && r.listings === 1) return [{ id: 'repeat-same', family: 'repeat', weight: 1, strong: false, reason: 'the same message was sent several times' }];
  return [];
}

/** Moderation categories serious enough to hold a message back on their own. */
const SEVERE = /^(harassment\/threatening|hate\/threatening|violence\/graphic|sexual\/minors|illicit\/violent|sexual)$/;

export interface ScreenOutcome extends ScreenVerdict { signals: Signal[]; score: number; decidedBy: 'none' | 'rules' | 'moderation' | 'model' }

const Classify = S.obj({
  verdict: S.enum(['genuine', 'spam', 'scam', 'unsure'] as const, 'genuine = a real person asking about the home; spam = advertising or unrelated; scam = trying to get money, details or access by deception'),
  confidence: S.enum(['low', 'medium', 'high'] as const),
});
type ClassifyT = Infer<typeof Classify>;

const CLASSIFY_PROMPT = [
  HOUSE_RULES,
  'You screen messages that people send to UK property listers (private sellers, landlords and estate agents) through Streetkey.',
  'Decide whether the message is from a genuine prospective buyer or tenant, or is spam or a scam.',
  'Be conservative. Genuine people are often brief, informal, misspell words or write in a second language; they ask about deposits, holding deposits, mortgages, chains, pets, parking, schools or viewings; they share phone numbers, WhatsApp or links to property portals; they may be living abroad and relocating, ask for a video viewing, offer to pay a holding deposit, or say a relocation agent, solicitor or lawyer will arrange or handle things. All of that is genuine.',
  'Scam: asks the lister to send money, refunds, codes or bank/login details; overpayment or cheque stories; paying in cryptocurrency or gift cards; an "agent" paying or collecting money or keys on their behalf because they are abroad; links to "verify", "secure" or pay for something.',
  'Spam: advertising, SEO, marketing, loans or anything unrelated to this home.',
  'Use confidence "high" only when it is unmistakable. If in doubt, answer genuine or unsure.',
].join('\n');

/** Full screen with an outcome description (used by the hook and by tests). */
export async function screen(e: EnquiryScreenInput, opts: { budgetMs?: number } = {}): Promise<ScreenOutcome> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 5500;
  const left = () => budget - (Date.now() - started);
  const allow = (signals: Signal[], score: number, decidedBy: ScreenOutcome['decidedBy'] = 'none'): ScreenOutcome => ({ filter: false, signals, score, decidedBy });
  if (!aiAvailable()) return allow([], 0);
  const meta = { purpose: 'inbox.screen', userId: null };

  const moderation = withTimeout(moderate({ text: `${e.name}\n${e.message}`.slice(0, 4000) }, meta).catch(() => null), Math.min(3000, left()), null);
  const [mod, repeat] = await Promise.all([moderation, repetition(e.email, e.message, e.enquiryId).catch(() => [] as Signal[])]);
  const signals = [...heuristics(e.message, e.name), ...repeat];
  if (mod?.flagged) {
    const severe = mod.categories.filter((c) => SEVERE.test(c));
    if (severe.length) return { filter: true, reason: 'Held back by the automated content check: threatening, violent or sexual content.', signals, score: 99, decidedBy: 'moderation' };
    signals.push({ id: 'moderation', family: 'moderation', weight: 2, strong: false, reason: 'contains abusive language' });
  }
  const a = assess(signals);
  const score = a.score;
  if (score <= 1) return allow(signals, score);
  if (a.rulesDecide) return { filter: true, reason: reasonFrom(a.kind, signals), signals, score, decidedBy: 'rules' };

  // Unusual but not clear-cut: ask a small model, briefly. Any failure lets the message through.
  if (left() < 1500) return allow(signals, score);
  const verdict = await withTimeout(chatJSON<ClassifyT>([
    { role: 'system', content: CLASSIFY_PROMPT },
    { role: 'user', content: `Enquiry type: ${e.kind}\nAutomatic checks noticed: ${signals.map((s) => s.reason).join('; ') || 'nothing unusual'}\n\n${untrusted('enquiry', `Name: ${e.name}\nMessage:\n${e.message}`, 3000)}` },
  ], Classify, 'enquiry_screen', { ...meta, role: 'fast', maxTokens: 600, effort: 'low', timeoutMs: Math.max(1500, Math.min(4000, left() - 200)) }).catch(() => null), left() - 100, null);
  if (verdict && (verdict.verdict === 'scam' || verdict.verdict === 'spam') && verdict.confidence === 'high') {
    return { filter: true, reason: reasonFrom(verdict.verdict, signals), signals, score, decidedBy: 'model' };
  }
  return allow(signals, score, verdict ? 'model' : 'none');
}

function reasonFrom(kind: 'spam' | 'scam', signals: Signal[]) {
  const top = [...new Set(topPerFamily(signals).sort((a, b) => b.weight - a.weight).map((s) => s.reason))].slice(0, 3);
  const why = top.length ? `: it ${top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0]}` : '';
  return `Held back as a likely ${kind}${why}.`.slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** The function registered with setEnquiryScreener: never throws, never takes longer than ~5.5s. */
export async function enquiryScreener(e: EnquiryScreenInput): Promise<ScreenVerdict> {
  try {
    const r = await withTimeout(screen(e), 5800, null);
    return r?.filter ? { filter: true, reason: r.reason } : { filter: false };
  } catch { return { filter: false }; }
}
