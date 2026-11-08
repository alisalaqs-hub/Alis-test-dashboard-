/**
 * Spam and scam screen for new enquiries.
 *
 * Deliberately conservative: a genuine buyer or tenant must never be held back. The order is
 *   1. cheap code heuristics (links, crypto, "send the deposit", "my agent abroad", the same text
 *      sent to many listings…) and OpenAI moderation, in parallel;
 *   2. clear-cut cases are decided by code alone (strong signals from at least two different
 *      families, or severe moderation categories);
 *   3. only when the heuristics are inconclusive, a short 'fast' model classification, which
 *      must say spam/scam with high confidence to hold a message back.
 * Any AI failure or timeout lets the message through. The whole screen answers within ~5.5s.
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
export interface Signal { id: string; family: SignalFamily; weight: number; reason: string }

const SCAM_FAMILIES: SignalFamily[] = ['payment', 'crypto', 'abroad', 'phishing'];

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]{2,}\.(?:com|net|org|info|biz|xyz|top|site|online|club|shop|io|co|ru|cn|tk|ml|ga|cf|gq|link|click)(?:\/[^\s<>"']*)?\b/gi;
const SHORTENER_RE = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|t\.me|wa\.me|chat\.whatsapp\.com|linktr\.ee)\b/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const RULES: { id: string; family: SignalFamily; weight: number; re: RegExp; reason: string }[] = [
  { id: 'crypto', family: 'crypto', weight: 3, re: /\b(bitcoin|btc|usdt|tether|ethereum|\beth\b|crypto(currency)?|binance|coinbase|wallet address)\b|\b(bc1|[13])[a-km-zA-HJ-NP-Z1-9]{25,39}\b|\b0x[a-fA-F0-9]{40}\b/i, reason: 'mentions cryptocurrency' },
  { id: 'wire', family: 'payment', weight: 3, re: /\b(western union|moneygram|money ?gram|gift ?cards?|itunes cards?|steam cards?|amazon vouchers?|paysafe ?card|money transfer agent)\b/i, reason: 'mentions money-transfer services or gift cards' },
  { id: 'overpay', family: 'payment', weight: 3, re: /\b(over-?pa(y|id|yment)|refund (me |us )?the (difference|balance|excess|extra)|cheque for (more|a higher amount)|send (you|the) (a )?(cheque|certified cheque|bank draft))\b/i, reason: 'mentions an overpayment or refund, a common scam' },
  { id: 'send-money', family: 'payment', weight: 2, re: /\b(send|transfer|wire|remit|pay)\s+(me\s+|us\s+|to\s+(me|us|my)\s+)?(the\s+|a\s+|your\s+|some\s+)?(holding\s+|security\s+|reservation\s+|refundable\s+)?(deposit|money|payment|funds|fee|advance)\b/i, reason: 'asks for a deposit, money or payment to be sent' },
  { id: 'upfront', family: 'payment', weight: 2, re: /\b(pay(ment)?\s+(upfront|up front|in advance)|advance (fee|payment)|processing fee|release (the )?funds|clearance fee)\b/i, reason: 'asks for payment up front' },
  { id: 'abroad', family: 'abroad', weight: 2, re: /\b(i am|i'm|im|currently|presently|now|living|working|based|stationed|deployed)\s+(abroad|overseas|offshore|out of the (country|uk)|on an oil rig|at sea)\b/i, reason: 'says they are abroad and can’t view in person' },
  { id: 'agent-abroad', family: 'abroad', weight: 2, re: /\bmy\s+(agent|lawyer|solicitor abroad|representative|shipping agent|relocation agent|moving agent|mover|courier|diplomat)s?\s+(will|would|can|is going to)\s+(pay|collect|handle|send|transfer|arrange)/i, reason: 'says their “agent” will pay or collect for them' },
  { id: 'phishing', family: 'phishing', weight: 2, re: /\b(sort code|account number|card (number|details)|cvv|passport (copy|scan|photo)|login details|your password|one[- ]time (code|passcode)|verify your (account|listing|identity|email|details)|confirm your (account|listing) (details|here))\b/i, reason: 'asks for bank, login or identity details' },
  { id: 'marketing', family: 'marketing', weight: 2, re: /\b(seo|backlinks?|guest posts?|rank(ing)? (on|in) google|first page of google|web ?design services|marketing services|digital marketing|lead generation|social media management|we buy any (house|home)|sell your (house|home) (fast|in \d+)|cash buyers? guaranteed|click here|unsubscribe|limited[- ]time offer|casino|viagra|cialis|forex|binary options|investment opportunity|earn (\$|£)\d|work from home|loan offer|cheap loans?)\b/i, reason: 'reads like advertising or marketing' },
  { id: 'offplatform', family: 'offplatform', weight: 1, re: /\b(whats\s?app|telegram|signal app|wechat|viber)\b/i, reason: 'moves the conversation to a messaging app' },
];

/** Code-only signals for a message (and the sender's name, where spammers often put links). */
export function heuristics(message: string, name = ''): Signal[] {
  const text = `${name}\n${message}`;
  const out: Signal[] = [];
  // Email addresses aren't links ("sam@gmail.com" must not count as a web address).
  const links = (text.replace(EMAIL_RE, ' ').match(URL_RE) ?? []).filter((u) => !/^[\d.]+$/.test(u));
  if (SHORTENER_RE.test(text)) out.push({ id: 'shortener', family: 'link', weight: 3, reason: 'contains a shortened or messaging-app link' });
  else if (links.length >= 2) out.push({ id: 'links', family: 'link', weight: 3, reason: 'contains several web links' });
  else if (links.length === 1) out.push({ id: 'link', family: 'link', weight: 2, reason: 'contains a web link' });
  // A second email address in the message body (beyond the one given in the form) often means "contact me elsewhere".
  if ((message.match(EMAIL_RE) ?? []).length >= 2) out.push({ id: 'emails', family: 'offplatform', weight: 1, reason: 'lists several email addresses' });
  for (const r of RULES) if (r.re.test(text)) out.push({ id: r.id, family: r.family, weight: r.weight, reason: r.reason });
  const letters = message.replace(/[^A-Za-z]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) out.push({ id: 'shouting', family: 'shouting', weight: 1, reason: 'is written mostly in capitals' });
  return out;
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
  if (r.listings >= 10) return [{ id: 'repeat-many', family: 'repeat', weight: 3, reason: `the same message was sent to ${r.listings} other listings this week` }];
  if (r.listings >= 4) return [{ id: 'repeat', family: 'repeat', weight: 2, reason: `the same message was sent to ${r.listings} other listings this week` }];
  if (r.n >= 2 && r.listings === 1) return [{ id: 'repeat-same', family: 'repeat', weight: 1, reason: 'the same message was sent several times' }];
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
  'Be conservative. Genuine people are often brief, informal, misspell words or write in a second language; they ask about deposits, holding deposits, mortgages, chains, pets, parking, schools or viewings; they share phone numbers or WhatsApp; they may be relocating from abroad and ask for a video viewing. All of that is genuine.',
  'Scam: asks the lister to send money, refunds or bank/login details; overpayment or cheque stories; cryptocurrency; an "agent" paying or collecting on their behalf because they are abroad; links to "verify" or "secure" something.',
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
    signals.push({ id: 'moderation', family: 'moderation', weight: 2, reason: 'contains abusive language' });
  }
  const score = signals.reduce((s, x) => s + x.weight, 0);
  const families = new Set(signals.map((s) => s.family));
  if (score <= 1) return allow(signals, score);

  const kind = signals.some((s) => SCAM_FAMILIES.includes(s.family)) ? 'scam' : 'spam';
  if (score >= 5 && families.size >= 2) return { filter: true, reason: reasonFrom(kind, signals), signals, score, decidedBy: 'rules' };

  // Inconclusive: ask a small model, briefly. Any failure lets the message through.
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
  const top = [...signals].sort((a, b) => b.weight - a.weight).slice(0, 3).map((s) => s.reason);
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
