/**
 * The Streetkey server: JSON API under /api, uploaded media under /media,
 * and (optionally) the built website itself so everything lives at one address.
 */
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { loadSession } from './auth/session';
import { config } from './config';
import { HttpError } from './services/http';
import { aiRoutes } from './routes/ai';
import { aiCoreRoutes } from './routes/ai-core';
import { aiAssistantRoutes } from './routes/ai-assistant';
import { aiSearchRoutes } from './routes/ai-search';
import { aiListingRoutes } from './routes/ai-listing';
import { aiTrustRoutes } from './routes/ai-trust';
import { aiInboxRoutes } from './routes/ai-inbox';
import { aiImportRoutes } from './routes/ai-import';
import { aiPropertyRoutes } from './routes/ai-property';
import { aiBriefingRoutes } from './routes/ai-briefing';
import { DataError } from './data/http';
import { dataRoutes } from './routes/data';
import { actorScope, AiError } from './ai/core';
import { clearHooks } from './ai/hooks';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { enquiryRoutes } from './routes/enquiries';
import { eventRoutes } from './routes/events';
import { FEED_MAX_BYTES, feedRoutes } from './routes/feeds';
import { healthRoutes } from './routes/health';
import { listingRoutes } from './routes/listings';
import { meRoutes } from './routes/me';

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
  "font-src 'self' data:", "connect-src 'self' https://api.postcodes.io", "frame-ancestors 'self'", "base-uri 'self'",
  "form-action 'self'", "object-src 'none'",
].join('; ');

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.storage.maxPhotoBytes, files: 12, fields: 20, fieldSize: 20_000 } });
  // A coarse in-memory limit helps a single long-lived server; per-action limits live in the database (services/ratelimit).
  if (config.memoryRateLimit) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  // Agent feeds may arrive as raw bytes; BLM files are commonly Windows-1252 text. (The feed route sets the same limit.)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FEED_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);

  // Each request gets its own slot for "who is using AI", so per-person token caps cover every AI call it makes.
  app.addHook('onRequest', (_req, _reply, done) => actorScope(done));
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (url.startsWith('/api/')) {
      // CORS for allowed origins other than this server's own address (same-origin needs nothing). The site's public
      // address can be another origin than the API's (e.g. the website dev server talking to a local API).
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin) && !sameHost(origin, req.headers.host)) {
        reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Allow-Credentials', 'true').header('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE').header('Access-Control-Allow-Headers', 'Content-Type').header('Access-Control-Max-Age', '600');
          return reply.code(204).send();
        }
      }
      // CSRF defence: state-changing browser requests must come from an allowed origin.
      // (Session cookies are also SameSite=Lax.) Agent feeds use API keys, not cookies.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !url.startsWith('/api/feeds/')) {
        if (origin && !config.allowedOrigins.includes(origin) && !sameHost(origin, req.headers.host) && !isLocalDev(origin)) {
          throw new HttpError(403, 'This request came from a website that isn’t allowed to use your Streetkey account.', 'bad_origin');
        }
      }
      reply.header('Cache-Control', 'no-store');
      await loadSession(req);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/media/')) reply.header('Content-Security-Policy', CSP);
    if (req.url.startsWith('/media/')) reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    return payload;
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && err.fields?.retryAfter) reply.header('Retry-After', err.fields.retryAfter);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, fields: err.fields } });
    }
    if (err instanceof DataError) {
      if (!config.isTest) req.log.warn({ source: err.source, code: err.code }, 'official data unavailable');
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof AiError) {
      if (!config.isTest) req.log.warn({ code: err.code, err: err.message.slice(0, 300) }, 'ai error');
      return reply.code(err.status).send({ error: { code: err.code, message: err.userMessage } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    const code = (err as FastifyError).code;
    // Upload limits: say which limit was hit (routes that read uploads part by part handle these themselves).
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'too_large', message: `That file is too large. The limit is ${Math.round(config.storage.maxPhotoBytes / 1048576)} MB per photo.` } });
    }
    if (code === 'FST_FILES_LIMIT') return reply.code(413).send({ error: { code: 'too_many_files', message: 'That upload has too many files. Send fewer at a time.' } });
    if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') return reply.code(413).send({ error: { code: 'too_many_parts', message: 'That upload has too many parts. Send fewer files at a time.' } });
    if (status === 413) {
      if (req.url.startsWith('/api/feeds/')) {
        return reply.code(413).send({ error: { code: 'feed_too_large', message: `That feed file is too large: the limit is ${(FEED_MAX_BYTES / 1048576).toFixed(1).replace(/\.0$/, '')} MB per upload. Send each branch’s stock with its own feed key (one key per branch) so each file stays under the limit.` } });
      }
      return reply.code(413).send({ error: { code: 'too_large', message: 'That request is too large.' } });
    }
    if (status === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many attempts. Please wait a minute and try again.' } });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'bad_request', message: 'That request wasn’t valid.' } });
    req.log.error(err);
    if (config.isTest) console.error(err);
    return reply.code(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  });

  clearHooks(); // route plugins (re)register their hooks below; never twice per process
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(listingRoutes);
  await app.register(enquiryRoutes);
  await app.register(feedRoutes);
  await app.register(adminRoutes);
  await app.register(aiRoutes);
  await app.register(aiCoreRoutes);
  await app.register(aiAssistantRoutes);
  await app.register(aiSearchRoutes);
  await app.register(aiListingRoutes);
  await app.register(aiTrustRoutes);
  await app.register(aiInboxRoutes);
  await app.register(aiImportRoutes);
  await app.register(aiPropertyRoutes);
  await app.register(aiBriefingRoutes);
  await app.register(eventRoutes);
  await app.register(dataRoutes);

  // Uploaded media (local storage driver).
  if (config.storage.driver === 'local') {
    fs.mkdirSync(config.storage.localDir, { recursive: true });
    await app.register(fastifyStatic, { root: config.storage.localDir, prefix: '/media/', decorateReply: false, maxAge: '30d', immutable: true });
  }

  // The website (one address for site + API). Hashed assets cache for a year; index.html never.
  const siteIndex = path.join(config.siteDir, 'index.html');
  const hasSite = config.serveSite && fs.existsSync(siteIndex);
  if (hasSite) {
    await app.register(fastifyStatic, {
      root: config.siteDir, prefix: '/', wildcard: false, index: false,
      setHeaders: (res, file) => res.header('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    const html = fs.readFileSync(siteIndex);
    app.get('/', (_req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/media/') && !path.extname(req.url.split('?')[0])) {
        return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));
  }
  return app;
}

const sameHost = (origin: string, host?: string) => { try { return !!host && new URL(origin).host === host; } catch { return false; } };
const isLocalDev = (origin: string) => !config.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
