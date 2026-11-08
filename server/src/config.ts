/**
 * Server configuration, read once from environment variables.
 * See .env.example for every setting and docs/08-backend.md for what each one does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: the nearest folder above this file that contains server/migrations (works from src/ and the built dist/). */
function findRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(dir, 'server', 'migrations'))) return dir; dir = path.dirname(dir); }
  return process.cwd();
}
export const ROOT = findRoot();

const env = process.env;
const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const nodeEnv = env.NODE_ENV ?? 'development';
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${int(env.PORT, 8787)}`).replace(/\/$/, '');

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int(env.PORT, 8787),
  host: env.HOST ?? '0.0.0.0',
  /** The address people use to reach the site (used in emails and absolute links). */
  publicUrl,
  /** Other web origins allowed to call the API with cookies (e.g. a separate front-end domain). */
  allowedOrigins: [publicUrl, ...list(env.ALLOWED_ORIGINS)],
  databaseUrl: env.DATABASE_URL ?? 'postgres://streetkey:streetkey@localhost:5432/streetkey',
  databaseSsl: bool(env.DATABASE_SSL, false),
  /** Serve the built website (dist/) from the same server, so one address hosts everything. */
  serveSite: bool(env.SERVE_SITE, true),
  siteDir: path.resolve(ROOT, env.SITE_DIR ?? 'dist'),
  session: {
    cookie: 'sk_session',
    days: int(env.SESSION_DAYS, 30),
    secureCookie: bool(env.SECURE_COOKIES, nodeEnv === 'production'),
  },
  storage: {
    driver: (env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
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
    openaiKey: env.OPENAI_API_KEY ?? '',
    openaiBase: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    imageModel: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1',
    imageQuality: env.OPENAI_IMAGE_QUALITY ?? 'medium',
    inputFidelity: env.OPENAI_IMAGE_INPUT_FIDELITY ?? 'high',
    dailyImagesPerUser: int(env.AI_DAILY_IMAGES_PER_USER, 10),
    timeoutMs: int(env.AI_TIMEOUT_MS, 180_000),
  },
  /** Listings by private owners go to a moderation queue before they appear publicly. */
  moderateOwnerListings: bool(env.MODERATE_OWNER_LISTINGS, true),
  /** First admin account, created/promoted by `npm run db:seed`. */
  adminEmail: env.ADMIN_EMAIL ?? '',
  trustProxy: bool(env.TRUST_PROXY, nodeEnv === 'production'),
  logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
};
export type Config = typeof config;
