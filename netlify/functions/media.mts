// Serves uploaded photos and AI images from Netlify Blobs at /media/<key>.
import '../../server/src/netlify/env';
import type { Config } from '@netlify/functions';
import { getFileWithType } from '../../server/src/services/storage';

const KEY = /^[a-z0-9][a-z0-9/_-]{0,200}\.(jpg|png|webp)$/i;

export default async (req: Request) => {
  const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/media\//, ''));
  if (!KEY.test(key) || key.includes('..')) return new Response('Not found', { status: 404 });
  const file = await getFileWithType(key).catch(() => null);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(file.body), {
    headers: {
      'Content-Type': file.contentType,
      // Keys are unique (random) so files never change: cache for a year.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'",
    },
  });
};

export const config: Config = { path: '/media/*', method: 'GET' };
