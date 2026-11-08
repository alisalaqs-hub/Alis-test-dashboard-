// Streetkey API on Netlify: every /api/* request runs the same Fastify app as the Node server.
import '../../server/src/netlify/env';
import type { Config, Context } from '@netlify/functions';
import { handleApi } from '../../server/src/netlify/handler';

export default (req: Request, context: Context) => handleApi(req, context.ip);

export const config: Config = {
  path: '/api/*',
  // Coarse per-IP protection at Netlify's edge; finer per-action limits live in the app.
  rateLimit: { windowLimit: 300, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
