/**
 * "Ask Streetkey": one turn of the assistant.
 *
 * The model (role 'main') answers with tools that run Streetkey's engines, in a structured
 * shape. The server then checks the answer before the website sees it:
 *  - homes: only real, public listings that a tool returned this turn, the page's home or homes
 *    earlier replies showed; cards come from the registry, never from the model
 *  - links: only internal Streetkey paths (and links to homes only for those homes)
 *  - figures: every money amount and percentage must match an engine figure in a tool result or
 *    the page's property data, or the person's own messages (never an earlier reply, which the
 *    browser sends back, never text a lister wrote, and never a number the model chose as a tool
 *    argument that the tool merely echoes); otherwise one quick correction pass, and failing that
 *    the sentence goes. Button labels and suggested questions with unchecked
 *    figures are dropped.
 *  - claims: sentences stating a valuation as fact, giving contact details or describing areas by
 *    who lives there are removed. Questions asking to pick areas by who lives there get Streetkey's
 *    policy without a model call.
 * Stateless: the browser keeps the conversation (sessionStorage) and sends the last 12 messages.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { POLICY_NOTE } from '../../../../src/lib/ai/search';
import { config } from '../../config';
import { AiError, cached, chatJSON, HOUSE_RULES, moderate, runWithTools, untrusted, type Message, type ToolTrace } from '../core';
import { ensureLiveRegistry } from '../registry';
import { conforms, S, type Infer } from '../schema';
import { numbersIn, stripUngrounded, toolsEvidence, ungrounded } from './grounding';
import { contextNote, historyMessages, PAGE_RE, ReplySchema, SYSTEM_PROMPT } from './prompt';
import { asksAboutPeople, dropClaims, fitToShow, idsIn, knownIds, sanitiseActions, sanitiseFollowUps, sanitiseReply, type Action } from './sanitise';
import { findHome, ID_RE, publicCard, TOOL_LABELS, TOOLS, type PublicCard } from './tools';

export const ChatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1, 'Type a question.').max(2000, 'Keep each message under 2,000 characters.'),
    propertyIds: z.array(z.string().regex(ID_RE)).max(6).optional(),
  })).min(1, 'Type a question.').max(12, 'Send at most the last 12 messages.')
    .refine((m) => m[m.length - 1]?.role === 'user', 'The last message must be your question.'),
  context: z.object({
    propertyId: z.string().regex(ID_RE).optional(),
    page: z.string().max(160).regex(PAGE_RE).optional(),
  }).optional(),
});
export type ChatBodyT = z.infer<typeof ChatBody>;

export type Grounding = 'checked' | 'corrected' | 'trimmed' | 'none';
export interface AssistantReply {
  reply: string;
  propertyIds: string[];
  /** Cards for the homes above, from Streetkey's data (title, town, price), for the website. */
  homes: PublicCard[];
  actions: Action[];
  followUps: string[];
  /** Streetkey tools the answer used, in plain words ("Stamp duty calculator"). */
  sources: string[];
  /** How the figures were checked against tool results. */
  grounding: Grounding;
}

type Reply = Infer<typeof ReplySchema>;
export const STARTERS = ['Find a 3-bed house with a garden under £450k', 'What’s the stamp duty on a £350,000 first home?', 'Which homes look like good buy-to-let deals?'];
const TRIM_NOTE = 'I’ve left out a figure I couldn’t check against Streetkey’s calculations.';
/** Answer to requests to pick or describe areas by who lives there (no model call). */
export const DEMOGRAPHIC_REPLY = `${POLICY_NOTE} I can help with objective facts instead: journey times, Ofsted ratings in our data, flood risk and prices.`;
const DEMOGRAPHIC_FOLLOW_UPS = ['Which homes are near a station?', 'Show me homes near Good or Outstanding schools', 'What’s the stamp duty on a £350,000 first home?'];

/** Model output → reply object; tolerates a plain-text answer. */
function parseReply(content: string): Reply {
  try {
    const v = JSON.parse(content) as unknown;
    if (conforms(ReplySchema, v)) return v as Reply;
  } catch { /* not JSON */ }
  const text = content.trim();
  if (text && !text.startsWith('{')) return { reply: text, propertyIds: [], actions: [], followUps: [] };
  throw new AiError('bad output', 'The AI returned something unexpected. Please try again.', 502, 'ai_bad_output');
}

/** One quick pass that rewrites a draft so its figures match the evidence (engine figures only). */
async function correctFigures(draft: string, bad: string[], evidence: unknown, homes: ReadonlySet<string>, userId: string | null, timeoutMs: number) {
  const out = await chatJSON<{ reply: string }>([
    { role: 'system', content: `${HOUSE_RULES}\nYou correct figures in a draft reply written by Streetkey’s assistant. Every money amount (£, “pounds”, “600k”, “2,100 a month”…) and percentage must appear in the evidence (rounding to the nearest £1,000 or 0.1% is fine). Correct or remove the unchecked figures listed; do not add new figures or facts. Keep the meaning, tone, length and the "- " bullet and **bold** format.` },
    { role: 'user', content: `${untrusted('draft', draft, 3500)}\nUnchecked figures: ${bad.join(', ').slice(0, 300)}\nEvidence from Streetkey’s tools (JSON):\n${JSON.stringify(evidence ?? null).slice(0, 12_000)}` },
  ], S.obj({ reply: S.str() }), 'streetkey_answer_fix', { purpose: 'assistant.fix', userId, role: 'fast', maxTokens: 900, timeoutMs });
  return sanitiseReply(out.reply, homes);
}

function canned(reply: string, followUps: string[] = STARTERS): AssistantReply {
  return { reply, propertyIds: [], homes: [], actions: [], followUps, sources: [], grounding: 'none' };
}

async function answer(body: ChatBodyT, userId: string | null, deadline: number): Promise<AssistantReply> {
  await ensureLiveRegistry();
  const ctx = await contextNote(body.context);
  // Leave time for the checks (and a quick correction pass) inside the request deadline.
  const left = deadline - Date.now();
  // Only Streetkey's engine data goes in a system note; the page path and the lister's words go in a data block.
  const context: Message[] = ctx ? [...(ctx.system ? [{ role: 'system' as const, content: ctx.system }] : []), { role: 'user' as const, content: ctx.block }] : [];
  const r = await runWithTools([
    { role: 'system', content: SYSTEM_PROMPT },
    ...context,
    ...historyMessages(body.messages),
  ], TOOLS, {
    purpose: 'assistant.chat', userId, role: 'main', maxTokens: 1400, effort: 'low', maxSteps: 4,
    timeoutMs: Math.max(1_500, left - Math.min(4_000, Math.round(left * 0.2))),
    responseSchema: { schema: ReplySchema, name: 'streetkey_answer' },
  });
  const out = parseReply(r.content);
  const traces: ToolTrace[] = r.traces.filter((t) => t.ok);

  // Homes this answer may show: ones a tool returned this turn, the page's home, and homes earlier replies showed.
  const homes = idsIn(traces.map((t) => t.result));
  if (ctx?.propertyId) homes.add(ctx.propertyId);
  for (const m of body.messages) if (m.role === 'assistant') for (const id of knownIds(m.propertyIds ?? [])) homes.add(id);

  // Figures must come from Streetkey's engines (tool results, the page's home) or from the person's own words.
  // Never from text a lister wrote (titles, towns, features, descriptions), from earlier assistant
  // replies (those come back from the browser and could say anything) or from numbers the model chose
  // as a tool's arguments and got straight back (a "price" or "loan" it could have read in a listing).
  const own = body.messages.filter((m) => m.role === 'user').map((m) => m.content);
  const page = ctx?.data ?? null;
  const evidence = { tools: toolsEvidence(traces, [page, own]), page };
  const allowed = numbersIn([evidence.tools.map((t) => t.result), page, own]);
  const checked = (s: string) => !ungrounded(s, allowed).length;
  let reply = sanitiseReply(out.reply, homes);
  let grounding: Grounding = 'checked';
  let bad = ungrounded(reply, allowed);
  if (bad.length && deadline - Date.now() > 6_000) {
    try {
      const fixed = await correctFigures(reply, bad, evidence, homes, userId, deadline - Date.now() - 1_000);
      if (fixed && checked(fixed)) { reply = fixed; grounding = 'corrected'; bad = []; }
    } catch { /* fall through to trimming */ }
  }
  if (bad.length) {
    const s = stripUngrounded(reply, allowed);
    reply = `${s.text || 'I couldn’t check the figures for that answer against Streetkey’s calculations, so I’ve left them out. The calculators linked below give exact numbers.'}\n\n${TRIM_NOTE}`;
    grounding = 'trimmed';
  }
  // Never in Streetkey's voice: a valuation stated as fact, contact details, areas described by who lives there.
  reply = dropClaims(reply).text;
  if (!reply.trim()) throw new AiError('empty reply', 'The AI didn’t answer. Please try again.', 502, 'ai_bad_output');

  const propertyIds = knownIds(out.propertyIds, 6, homes);
  const sources = [...new Set(traces.map((t) => TOOL_LABELS[t.name]).filter(Boolean))];
  const fit = (s: string) => checked(s) && fitToShow(s);
  return {
    reply, propertyIds,
    homes: propertyIds.map((id) => publicCard(findHome(id)!)),
    // Buttons and suggested questions carry no unchecked figures either (a clicked suggestion becomes the person's words).
    actions: sanitiseActions(out.actions, 4, fit, homes),
    followUps: sanitiseFollowUps(out.followUps, 3, fit),
    sources, grounding,
  };
}

/** Answer one turn. Moderation runs alongside; first questions without personal context are cached briefly. */
export async function assistantChat(body: ChatBodyT, meta: { userId: string | null }): Promise<AssistantReply> {
  const deadline = Date.now() + config.ai.quickTimeoutMs;
  const question = body.messages[body.messages.length - 1].content;
  // Choosing or describing areas by who lives there: Streetkey's policy, in code (no model call).
  // Facilities and things named after a place ("Is the Leyton community centre nearby?") are not that.
  if (asksAboutPeople(question)) return canned(DEMOGRAPHIC_REPLY, DEMOGRAPHIC_FOLLOW_UPS);
  const cacheable = body.messages.length === 1 && question.length <= 200;
  // v2: answers cached before the stricter checks (homes, lister figures, claims) are never served.
  const key = cacheable ? `assistant:v2:${createHash('sha256').update(JSON.stringify([question.toLowerCase().replace(/\s+/g, ' '), body.context ?? null])).digest('hex')}` : '';
  const run = () => answer(body, meta.userId, deadline);
  const [mod, res] = await Promise.all([
    moderate({ text: question }, { purpose: 'assistant.moderation', userId: meta.userId }).catch(() => null),
    (cacheable ? cached(key, 600, run) : run()).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  if (mod?.flagged) {
    if (mod.categories.some((c) => c.startsWith('self-harm') || c.startsWith('self_harm'))) {
      return canned('I’m sorry you’re going through this. You don’t have to face it alone: in the UK you can call Samaritans free on 116 123 at any time, or text SHOUT to 85258. If you’re in immediate danger, call 999.\n\nWhenever you’re ready, I’m here to help with homes, moving and anything property-related.', []);
    }
    return canned('I can’t help with that. I can help you find homes to buy or rent, check costs like stamp duty or refurbishment, or look at what a home might be worth or rent for.');
  }
  if (!res.ok) {
    if (res.e instanceof AiError && res.e.code === 'ai_refused') return canned('I can’t help with that one. Try asking about a home, an area’s listings, or costs like stamp duty, refurbishment or a mortgage.');
    throw res.e;
  }
  return res.v;
}
