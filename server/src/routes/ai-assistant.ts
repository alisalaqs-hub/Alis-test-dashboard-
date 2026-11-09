/**
 * AI feature routes: assistant ("Ask Streetkey").
 *
 *   POST /api/ai/chat  { messages: [{ role, content, propertyIds? }] (last 12), context?: { propertyId?, page? } }
 *     → { reply, propertyIds, homes, actions, followUps, sources, grounding }
 *
 * Open to visitors (rate limited per IP, or per account when signed in). Stateless: the
 * conversation lives in the person's browser for the session and is never stored here.
 */
import type { FastifyInstance } from 'fastify';
import { assistantChat, ChatBody } from '../ai/assistant/chat';
import { aiGuard } from '../ai/guard';
import { parse } from '../services/http';

export async function aiAssistantRoutes(app: FastifyInstance) {
  app.post('/api/ai/chat', { bodyLimit: 128 * 1024 }, async (req) => {
    const { userId } = await aiGuard(req, 'assistant.chat', { perMinute: 8, perHour: 60 });
    const body = parse(ChatBody, req.body);
    return assistantChat(body, { userId });
  });
}
