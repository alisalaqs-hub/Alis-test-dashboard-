/**
 * File storage for listing photos and AI images.
 *  - netlify-blobs: Netlify Blobs (default on Netlify), served by the media function at /media/...
 *  - local: files on disk (development, or a persistent disk on the host), served at /media/...
 *  - s3:    any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2) with a public base URL.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config';

export interface Stored { key: string; url: string }

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function newKey(folder: string, contentType: string) {
  const d = new Date();
  return `${folder}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
}

/** Netlify Blobs store (strong consistency so a photo can be shown straight after upload). */
async function blobs() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: config.storage.blobStore, consistency: 'strong' });
}

export async function putFile(key: string, body: Buffer, contentType: string): Promise<Stored> {
  if (config.storage.driver === 'netlify-blobs') {
    await (await blobs()).set(key, new Uint8Array(body).buffer as ArrayBuffer, { metadata: { contentType } });
    return { key, url: `/media/${key}` };
  }
  if (config.storage.driver === 's3') {
    await s3Put(key, body, contentType);
    return { key, url: `${config.storage.s3.publicBaseUrl}/${key}` };
  }
  const file = safeLocal(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return { key, url: `/media/${key}` };
}

export async function getFile(key: string): Promise<Buffer | null> {
  if (key.startsWith('ext:')) return fetchExternalImage(key.slice(4)).catch(() => null);
  if (config.storage.driver === 'netlify-blobs') {
    const b = await (await blobs()).get(key, { type: 'arrayBuffer' });
    return b ? Buffer.from(b) : null;
  }
  if (config.storage.driver === 's3') {
    const r = await fetch(`${config.storage.s3.publicBaseUrl}/${key}`);
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }
  return fs.readFile(safeLocal(key)).catch(() => null);
}

/** Bytes and content type (used by the Netlify media function). */
export async function getFileWithType(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (config.storage.driver === 'netlify-blobs') {
    const r = await (await blobs()).getWithMetadata(key, { type: 'arrayBuffer' });
    if (!r) return null;
    return { body: Buffer.from(r.data), contentType: String((r.metadata as { contentType?: string })?.contentType ?? 'application/octet-stream') };
  }
  const body = await getFile(key);
  if (!body) return null;
  const ext = key.split('.').pop();
  return { body, contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' ? 'image/jpeg' : 'application/octet-stream' };
}

/** CDN cache tag for one media file, so a deleted file can be purged from Netlify's edge. */
export const mediaTag = (key: string) => `m-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

export async function deleteFile(key: string) {
  if (key.startsWith('ext:')) return;
  if (config.storage.driver === 'netlify-blobs') {
    await (await blobs()).delete(key).catch(() => {});
    // Best effort: the CDN copy would otherwise be served until it expires.
    await import('@netlify/functions').then((m) => (m as { purgeCache?: (o: { tags: string[] }) => Promise<void> }).purgeCache?.({ tags: [mediaTag(key)] })).catch(() => {});
    return;
  }
  if (config.storage.driver === 's3') { await s3Request('DELETE', key).catch(() => {}); return; }
  await fs.unlink(safeLocal(key)).catch(() => {});
}

/* ---------- external (agent feed) photos: public HTTPS hosts only ---------- */

/** Biggest external photo we'll download. */
export const MAX_EXTERNAL_BYTES = 10 * 1024 * 1024;
const EXTERNAL_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** True for a stored key that's safe to fetch: our own files, or an `ext:` URL on a public HTTPS host name. */
export function fetchableExternal(key: string) {
  if (!key.startsWith('ext:')) return true;
  return safeExternalUrl(key.slice(4)) !== null;
}

/** The URL if it's https on a public-looking host name (no IP literals, credentials or internal names), else null. */
export function safeExternalUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.port && u.port !== '443') return null;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || !h.includes('.')) return null;
    if (/^[\d.]+$/.test(h) || /^0x/i.test(h) || h.includes(':') || net.isIP(h)) return null; // IP literals (incl. IPv6 and odd forms): use a host name
    return u;
  } catch { return null; }
}

/** Addresses we never connect to: loopback, private, link-local (cloud metadata), CGNAT, ULA, multicast, reserved. */
export function isBlockedAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/%.*$/, '');
  if (net.isIPv4(v)) {
    const [a, b, c] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)          // CGNAT
      || (a === 169 && b === 254)                    // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))       // benchmarking
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(v)) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  return v === '::' || v === '::1' || v.startsWith('::')  // unspecified, loopback, IPv4-compatible/mapped (hex form)
    || /^f[cd]/.test(v)                                    // ULA fc00::/7
    || /^fe[89ab]/.test(v)                                 // link-local fe80::/10
    || v.startsWith('ff')                                  // multicast
    || v.startsWith('64:ff9b:') || v.startsWith('100:')   // NAT64, discard
    || v.startsWith('2001:db8') || v.startsWith('2002:'); // documentation, 6to4
}

/**
 * DNS lookup that refuses blocked addresses. Used as the socket's lookup, so the address we check is the address
 * we connect to (no DNS rebinding between a check and the request).
 */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return cb(err, '', 4);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EBLOCKEDADDR' }), '', 4);
    }
    if (options.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

const IMAGE_TYPE = /^image\/(jpeg|jpg|pjpeg|png|webp|gif|avif)\b/;
type Fetched = { status: number; location?: string; contentType: string; body?: Buffer };
function requestOnce(u: URL, signal: AbortSignal): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = https.get(u, {
      lookup: guardedLookup as unknown as typeof dnsLookup,
      signal,
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 'user-agent': 'StreetkeyBot/1.0 (+listing photo check)' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location: res.headers.location, contentType }); }
      if (status !== 200) { res.resume(); return resolve({ status, contentType }); }
      if (!IMAGE_TYPE.test(contentType)) { res.destroy(); return resolve({ status: 415, contentType }); }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > MAX_EXTERNAL_BYTES) { res.destroy(); return resolve({ status: 413, contentType }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_EXTERNAL_BYTES) { res.destroy(); resolve({ status: 413, contentType }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Download an external photo safely: https only, public host names that resolve only to public addresses,
 * redirects followed by hand (each one re-checked, at most 3), image content types only, 10 MB cap, 15 s overall.
 * Returns null for anything that doesn't meet those rules.
 */
let transport: (u: URL, signal: AbortSignal) => Promise<Fetched> = requestOnce;
/** Tests only: replace the network call (URL, redirect, type and size rules still apply). */
export function setExternalTransport(t: typeof transport | null) { transport = t ?? requestOnce; }

export async function fetchExternalImage(raw: string): Promise<Buffer | null> {
  const signal = AbortSignal.timeout(EXTERNAL_TIMEOUT_MS);
  let u = safeExternalUrl(raw);
  for (let hop = 0; u && hop <= MAX_REDIRECTS; hop++) {
    const r = await transport(u, signal);
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) return null;
      u = safeExternalUrl(new URL(r.location, u).toString());
      continue;
    }
    return r.status === 200 && IMAGE_TYPE.test(r.contentType) && r.body?.length && r.body.length <= MAX_EXTERNAL_BYTES ? r.body : null;
  }
  return null;
}

function safeLocal(key: string) {
  const file = path.resolve(config.storage.localDir, key);
  if (!file.startsWith(config.storage.localDir + path.sep)) throw new Error('bad storage key');
  return file;
}

/* ---------- minimal S3 client (AWS Signature V4), enough for put/delete ---------- */
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function s3Put(key: string, body: Buffer, contentType: string) {
  const r = await s3Request('PUT', key, body, contentType);
  if (!r.ok) throw new Error(`storage upload failed (${r.status})`);
}

async function s3Request(method: 'PUT' | 'DELETE', key: string, body: Buffer = Buffer.alloc(0), contentType?: string) {
  const s = config.storage.s3;
  const endpoint = new URL(s.endpoint);
  const host = endpoint.host;
  const pathName = `/${s.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = hex(body);
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const signed = Object.keys(headers).sort();
  const canonical = [method, pathName, '', signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${s.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${s.secretAccessKey}`, day), s.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${s.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  delete headers.host;
  return fetch(`${endpoint.origin}${pathName}`, { method, headers, body: method === 'PUT' ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
}

export const storageReady = () => config.storage.driver === 'local' || config.storage.driver === 'netlify-blobs' || !!(config.storage.s3.endpoint && config.storage.s3.bucket && config.storage.s3.accessKeyId && config.storage.s3.publicBaseUrl);
