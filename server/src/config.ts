/**
 * Server configuration, read once from environment variables.
 * See .env.example for every setting and docs/08-backend.md for what each one does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: the nearest folder above this file that contains server/migrations (works from src/ and the built dist/). */
function findRoot() {
  let dir: string;
  try { dir = path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
  for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(dir, 'server', 'migrations'))) return dir; dir = path.dirname(dir); }
  return process.cwd();
}
export const ROOT = findRoot();

const env = process.env;
const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const nodeEnv = env.NODE_ENV ?? 'development';
/** Where the code is running: a long-lived Node server, or Netlify Functions (set by netlify/functions/*). */
const runtime: 'node' | 'netlify' = env.STREETKEY_RUNTIME === 'netlify' ? 'netlify' : 'node';
// Netlify provides URL (primary address) and DEPLOY_PRIME_URL / DEPLOY_URL (this deploy) to functions.
const publicUrl = (env.PUBLIC_URL || env.URL || `http://localhost:${int(env.PORT, 8787)}`).replace(/\/$/, '');
const databaseUrl = env.DATABASE_URL || env.NETLIFY_DB_URL || env.NETLIFY_DATABASE_URL || 'postgres://streetkey:streetkey@localhost:5432/streetkey';
const sslByUrl = /sslmode=require|neon\.tech|\.neon\.|supabase\.co|render\.com/i.test(databaseUrl);

export const config = {
  env: nodeEnv,
  runtime,
  isProd: nodeEnv === 'production' || runtime === 'netlify',
  isTest: nodeEnv === 'test',
  port: int(env.PORT, 8787),
  host: env.HOST ?? '0.0.0.0',
  /** The address people use to reach the site (used in emails and absolute links). */
  publicUrl,
  /** Other web origins allowed to call the API with cookies (e.g. a separate front-end domain). */
  allowedOrigins: [...new Set([publicUrl, env.DEPLOY_PRIME_URL, env.DEPLOY_URL, ...list(env.ALLOWED_ORIGINS)].filter((x): x is string => !!x).map((x) => x.replace(/\/$/, '')))],
  databaseUrl,
  /** Direct (unpooled) connection for migrations when the host provides one. */
  migrationsUrl: env.DATABASE_URL_UNPOOLED || env.NETLIFY_DATABASE_URL_UNPOOLED || databaseUrl,
  databaseSsl: bool(env.DATABASE_SSL, sslByUrl),
  /** Verify the database's TLS certificate (managed hosts such as Neon/Netlify Database use public CAs). */
  databaseSslVerify: bool(env.DATABASE_SSL_VERIFY, true),
  /** Connections per process: small on serverless (many short-lived instances), larger on a server. */
  databasePoolMax: int(env.DATABASE_POOL_MAX, runtime === 'netlify' ? 3 : 10),
  /** Serve the built website (dist/) from the same server, so one address hosts everything. */
  serveSite: bool(env.SERVE_SITE, runtime !== 'netlify'),
  siteDir: path.resolve(ROOT, env.SITE_DIR ?? 'dist'),
  session: {
    cookie: 'sk_session',
    days: int(env.SESSION_DAYS, 30),
    secureCookie: bool(env.SECURE_COOKIES, nodeEnv === 'production' || runtime === 'netlify'),
  },
  storage: {
    driver: (env.STORAGE_DRIVER || (runtime === 'netlify' ? 'netlify-blobs' : 'local')) as 'local' | 's3' | 'netlify-blobs',
    blobStore: env.BLOB_STORE ?? 'streetkey-media',
    localDir: path.resolve(ROOT, env.UPLOAD_DIR ?? 'server/uploads'),
    s3: {
      endpoint: env.S3_ENDPOINT ?? '',
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      publicBaseUrl: (env.S3_PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
    },
    maxPhotoBytes: int(env.MAX_PHOTO_MB, 12) * 1024 * 1024,
    maxPhotosPerListing: int(env.MAX_PHOTOS_PER_LISTING, 30),
  },
  email: {
    from: env.EMAIL_FROM ?? 'Streetkey <no-reply@streetkey.local>',
    resendApiKey: env.RESEND_API_KEY ?? '',
  },
  ai: {
    /**
     * The AI provider. OpenAI by default; any provider that speaks the same API works too (many have a free plan):
     * set AI_BASE_URL, AI_API_KEY and AI_MODEL. The older OPENAI_* names still work.
     */
    openaiKey: env.AI_API_KEY || env.OPENAI_API_KEY || '',
    openaiBase: (env.AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    /** The provider's name as shown to admins (defaults to OpenAI, or the host of AI_BASE_URL). */
    providerName: env.AI_PROVIDER_NAME || '',
    /** Master switch: AI_DISABLED=true turns every AI feature off (the site falls back to its built-in rules). */
    disabled: bool(env.AI_DISABLED, false),
    /**
     * Models per role. On OpenAI, leave blank to auto-select the best model the account can use.
     * On any other provider, AI_MODEL is required (AI_FAST_MODEL is optional); photo understanding, room images,
     * embeddings and moderation are used only when a model is named for them.
     */
    models: {
      main: env.AI_MODEL || env.OPENAI_MODEL || '',                      // assistant, reasoning-heavy writing
      fast: env.AI_FAST_MODEL || env.OPENAI_FAST_MODEL || '',            // parsing, classification, short drafts
      vision: env.AI_VISION_MODEL || env.OPENAI_VISION_MODEL || '',      // photo understanding
      image: env.AI_IMAGE_MODEL || env.OPENAI_IMAGE_MODEL || '',         // room redesign (image editing)
      embedding: env.AI_EMBEDDING_MODEL || env.OPENAI_EMBEDDING_MODEL || '',
      moderation: env.AI_MODERATION_MODEL || env.OPENAI_MODERATION_MODEL || '',
    },
    imageQuality: env.OPENAI_IMAGE_QUALITY ?? 'medium',
    inputFidelity: env.OPENAI_IMAGE_INPUT_FIDELITY ?? 'high',
    dailyImagesPerUser: int(env.AI_DAILY_IMAGES_PER_USER, 10),
    /** AI requests per signed-in person per day (text features), and per visitor IP for anonymous features. */
    dailyRequestsPerUser: int(env.AI_DAILY_REQUESTS_PER_USER, 200),
    dailyRequestsPerIp: int(env.AI_DAILY_REQUESTS_PER_IP, 60),
    /** Site-wide safety net: AI pauses for the day once this many tokens have been used. 0 = no cap. */
    dailyTokenBudget: int(env.AI_DAILY_TOKEN_BUDGET, 3_000_000),
    /** Tokens one person (signed in) or one visitor network may use per 24 hours. 0 = no per-person cap. Safety checks don't count. */
    dailyTokensPerUser: int(env.AI_DAILY_TOKENS_PER_USER, 250_000),
    dailyTokensPerIp: int(env.AI_DAILY_TOKENS_PER_IP, 60_000),
    /** Room redesigns per day across the whole site (images are the most expensive AI calls). 0 = no cap. */
    dailyImagesSite: int(env.AI_DAILY_IMAGES_SITE, 300),
    /** Per-call timeout for quick (in-request) AI calls; serverless requests must finish within ~30s. */
    quickTimeoutMs: int(env.AI_QUICK_TIMEOUT_MS, runtime === 'netlify' ? 24_000 : 45_000),
    /** Per-call timeout for background jobs (image editing, photo analysis). */
    timeoutMs: int(env.AI_TIMEOUT_MS, 240_000),
  },
  /**
   * Official open data: HM Land Registry sold prices and house price index, Environment Agency flood risk,
   * the energy certificate (EPC) register and postcodes.io. All are called from the server only and cached in the database.
   */
  data: {
    /** OFFICIAL_DATA_DISABLED=true stops every call to these services (pages then say the data isn't available). */
    disabled: bool(env.OFFICIAL_DATA_DISABLED, false),
    landRegistryUrl: (env.LAND_REGISTRY_SPARQL_URL ?? 'https://landregistry.data.gov.uk/landregistry/query').replace(/\/$/, ''),
    floodMapsUrl: (env.EA_FLOOD_MAPS_URL ?? 'https://environment.data.gov.uk/spatialdata').replace(/\/$/, ''),
    floodWarningsUrl: (env.EA_FLOOD_WARNINGS_URL ?? 'https://environment.data.gov.uk/flood-monitoring').replace(/\/$/, ''),
    postcodesUrl: (env.POSTCODES_URL ?? 'https://api.postcodes.io').replace(/\/$/, ''),
    /** Energy certificates: a free bearer token from get-energy-performance-data.communities.gov.uk (GOV.UK One Login). Without it EPC lookups are off. */
    epcUrl: (env.EPC_API_URL ?? 'https://api.get-energy-performance-data.communities.gov.uk').replace(/\/$/, ''),
    epcToken: env.EPC_API_TOKEN ?? '',
    /** Sent with every request so the services can see who is calling. */
    userAgent: `Streetkey/1.0 (+${publicUrl})`,
  },
  jobs: {
    /** How queued AI jobs run: 'inline' (same process, after the response), 'netlify' (background function), 'sync' (tests: run before responding). */
    mode: (env.AI_JOBS_MODE || (runtime === 'netlify' ? 'netlify' : nodeEnv === 'test' ? 'sync' : 'inline')) as 'inline' | 'netlify' | 'sync',
    /** Shared secret the background worker checks (set automatically from the database if blank). */
    workerSecret: env.AI_WORKER_SECRET ?? '',
  },
  /** Listings by private owners go to a moderation queue before they appear publicly. */
  moderateOwnerListings: bool(env.MODERATE_OWNER_LISTINGS, true),
  /** First admin account, created/promoted by `npm run db:seed`. */
  adminEmail: env.ADMIN_EMAIL ?? '',
  /** Behind a reverse proxy (Render, Docker + nginx): trust X-Forwarded-For. Netlify passes the client IP directly. */
  trustProxy: bool(env.TRUST_PROXY, nodeEnv === 'production' && runtime === 'node'),
  /** In-memory rate limiting only helps a single long-lived server; the database limiter covers serverless. */
  memoryRateLimit: runtime === 'node' && nodeEnv !== 'test',
  logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : runtime === 'netlify' ? 'warn' : 'info'),
};
export type Config = typeof config;
