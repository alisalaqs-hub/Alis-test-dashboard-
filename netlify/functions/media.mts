// Serves uploaded photos and AI images from Netlify Blobs at /media/<key>.
import '../../server/src/netlify/env';
import type { Config } from '@netlify/functions';
import { getFileWithType, mediaTag } from '../../server/src/services/storage';

const KEY = /^[a-z0-9][a-z0-9/_-]{0,200}\.(jpg|png|webp)$/i;

export default async (req: Request) => {
  let key: string;
  try { key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/media\//, '')); } catch { return new Response('Not found', { status: 404 }); }
  if (!KEY.test(key) || key.includes('..')) return new Response('Not found', { status: 404 });
  const file = await getFileWithType(key).catch(() => null);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(file.body), {
    headers: {
      'Content-Type': file.contentType,
      // Keys are unique (random) so a file never changes, but it can be deleted (a removed photo, an erased account):
      // browsers keep it for a day, Netlify's CDN for 30 days, and deleteFile() purges the CDN copy by tag.
      'Cache-Control': 'public, max-age=86400',
      'Netlify-CDN-Cache-Control': 'public, max-age=2592000, durable',
      'Netlify-Cache-Tag': mediaTag(key),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'",
    },
  });
};

export const config: Config = { path: '/media/*', method: 'GET' };
