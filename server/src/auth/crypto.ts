import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/* Password hashing with scrypt (memory-hard, built into Node; no native add-ons).
   Stored as scrypt$N$r$p$saltB64$hashB64 so parameters can be raised later. */
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) }, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the email doesn't exist, so timing doesn't reveal accounts. */
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/** URL-safe random token (sent to the user) and its SHA-256 (stored). */
export function newToken(bytes = 32) {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: sha256(token) };
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Short public listing reference: sk- + 7 chars from an unambiguous alphabet. */
export function listingRef() {
  const abc = '23456789abcdefghjkmnpqrstuvwxyz';
  const b = randomBytes(7);
  return 'sk-' + [...b].map((x) => abc[x % abc.length]).join('');
}

/** Password rules: 10+ characters and not one of the most common passwords. */
const COMMON = new Set(['password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop', 'iloveyou12', 'letmein123', 'welcome123', 'streetkey1', 'abcdefghij', 'passw0rd12', '11111111111', 'football123', 'qwerty1234']);
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Try a short phrase of a few words.';
  return null;
}
