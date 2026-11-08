// Bundles every Netlify function the way Netlify does (esbuild, ESM, Node 22) and, with --run,
// invokes the API function with real web Requests against the local database.
// Catches bundling problems (missing modules, dynamic requires) before a deploy does.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outdir = path.resolve('.netlify-check');
fs.rmSync(outdir, { recursive: true, force: true });
const fns = fs.readdirSync('netlify/functions').filter((f) => /\.m?ts$/.test(f));
for (const f of fns) {
  await build({
    entryPoints: [`netlify/functions/${f}`], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    outfile: path.join(outdir, f.replace(/\.m?ts$/, '.mjs')), external: ['pg-native'], logLevel: 'error',
    // Netlify adds the same require shim to ESM function bundles.
    banner: { js: "import {createRequire as ___nfyCreateRequire} from 'module';const require=___nfyCreateRequire(import.meta.url);" },
  });
  console.log(`bundled ${f} (${(fs.statSync(path.join(outdir, f.replace(/\.m?ts$/, '.mjs'))).size / 1024).toFixed(0)} KB)`);
}

if (process.argv.includes('--run')) {
  process.env.STORAGE_DRIVER ||= 'local';
  process.env.AI_JOBS_MODE ||= 'inline';
  const api = (await import(pathToFileURL(path.join(outdir, 'api.mjs')).href)).default;
  const call = async (method, p, body, cookie) => {
    const r = await api(new Request(`http://localhost:8888${p}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:8888', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), { ip: '203.0.113.9' });
    return { status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') };
  };
  const h = await call('GET', '/api/health');
  console.log('health', h.status, JSON.stringify(h.json?.features));
  const email = `bundle${Date.now()}@example.com`;
  const reg = await call('POST', '/api/auth/register', { email, password: 'bundle check passphrase', name: 'Bundle Check', acceptTerms: true });
  console.log('register', reg.status, reg.setCookie ? 'cookie set' : 'NO COOKIE');
  const me = await call('GET', '/api/auth/me', null, reg.setCookie?.split(';')[0]);
  console.log('me', me.status, me.json?.user?.email === email ? 'ok' : JSON.stringify(me.json));
  const ai = await call('GET', '/api/ai/status');
  console.log('ai status', ai.status, JSON.stringify(ai.json));
  if (h.status !== 200 || reg.status !== 201 || me.json?.user?.email !== email) process.exit(1);
  process.exit(0);
}
