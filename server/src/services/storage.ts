/**
 * File storage for listing photos and AI images.
 *  - netlify-blobs: Netlify Blobs (default on Netlify), served by the media function at /media/...
 *  - local: files on disk (development, or a persistent disk on the host), served at /media/...
 *  - s3:    any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2) with a public base URL.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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
  if (key.startsWith('ext:')) { const r = await fetch(key.slice(4), { signal: AbortSignal.timeout(15_000) }).catch(() => null); return r?.ok ? Buffer.from(await r.arrayBuffer()) : null; }
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

export async function deleteFile(key: string) {
  if (key.startsWith('ext:')) return;
  if (config.storage.driver === 'netlify-blobs') { await (await blobs()).delete(key).catch(() => {}); return; }
  if (config.storage.driver === 's3') { await s3Request('DELETE', key).catch(() => {}); return; }
  await fs.unlink(safeLocal(key)).catch(() => {});
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
