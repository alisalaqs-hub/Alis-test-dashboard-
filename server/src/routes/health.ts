import type { FastifyInstance } from 'fastify';
import type { HealthDTO } from '../../../src/lib/apiTypes';
import { config } from '../config';
import { one } from '../db';
import { aiAvailable } from '../ai/core';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    const db = await one('SELECT 1 AS ok').then(() => true).catch(() => false);
    const body: HealthDTO = {
      ok: db,
      version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.GIT_SHA ?? 'dev',
      features: { email: config.email.resendApiKey ? 'resend' : 'log', storage: config.storage.driver, aiImages: aiAvailable(), ai: aiAvailable(), moderation: config.moderateOwnerListings, runtime: config.runtime },
    };
    return reply.code(db ? 200 : 503).send(body);
  });
}
