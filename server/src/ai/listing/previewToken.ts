/**
 * Photo-check results the browser carries from the preview to the upload.
 *
 * POST /api/ai/listing/photos/preview analyses photos that are still in the browser. So the same photos aren't
 * sent to the vision model a second time after upload, the preview returns one signed token per photo: an HMAC
 * over the person, the exact image bytes it looked at, the analysis and an expiry. The upload route accepts a
 * token only for the same person and byte-for-byte the same file, and only then stores the analysis
 * (ai_* columns) without another AI call. Raw analyses from the browser are never trusted (admins and the
 * trust review may rely on the flags).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { workerSecret } from '../jobs';
import { FLAGS, ISSUES, ROOMS, type PhotoAnalysis } from './photos';

/** How long a preview result can be used for an upload. */
export const PREVIEW_TOKEN_TTL_SEC = 24 * 3600;

const AnalysisZ = z.object({
  room: z.enum(ROOMS),
  alt: z.string().max(200),
  quality: z.object({ score: z.number().int().min(1).max(10), issues: z.array(z.enum(ISSUES)).max(ISSUES.length) }),
  features: z.array(z.string().max(60)).max(8),
  flags: z.array(z.enum(FLAGS)).max(FLAGS.length),
});
const PayloadZ = z.object({ v: z.literal(1), u: z.string().min(1).max(64), h: z.string().regex(/^[0-9a-f]{64}$/), e: z.number().int(), a: AnalysisZ });

let key: Buffer | null = null;
/** A key for this purpose only, derived from the server's own secret (never sent anywhere). */
async function signingKey(): Promise<Buffer | null> {
  if (key) return key;
  const secret = await workerSecret();
  if (!secret) return null;
  key = createHmac('sha256', secret).update('streetkey:listing-photo-preview:v1').digest();
  return key;
}

const b64 = (b: Buffer) => b.toString('base64url');
export const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A token for one analysed photo (`hash` = bytesHash of the file), or null if signing isn't possible (the upload then checks it again). */
export async function signPreview(userId: string, hash: string, analysis: PhotoAnalysis, now = Date.now()): Promise<string | null> {
  const k = await signingKey();
  if (!k) return null;
  const payload = b64(Buffer.from(JSON.stringify({ v: 1, u: userId, h: hash, e: Math.floor(now / 1000) + PREVIEW_TOKEN_TTL_SEC, a: analysis })));
  return `${payload}.${b64(createHmac('sha256', k).update(payload).digest())}`;
}

/** The analysis in a token, if it was issued to this person for exactly this file (`hash` = bytesHash) and hasn't expired; else null. */
export async function readPreview(token: unknown, userId: string, hash: string, now = Date.now()): Promise<PhotoAnalysis | null> {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const k = await signingKey();
  if (!k) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = createHmac('sha256', k).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  const p = PayloadZ.safeParse(raw);
  if (!p.success) return null;
  if (p.data.u !== userId || p.data.e * 1000 < now || p.data.h !== hash) return null;
  return p.data.a as PhotoAnalysis;
}
