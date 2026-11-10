// Checks that the Netlify functions will start on Netlify, before a deploy finds out the hard way.
//
//   1. Dependencies: no CommonJS package may require() a package that is ES-module-only.
//      Netlify's function runtime refuses that (ERR_REQUIRE_ESM), and it takes the whole API down.
//   2. Bundled: every function is bundled into one file with esbuild (ESM, Node 22).
//   3. As shipped: every function is built with packages left in node_modules, the way Netlify
//      ships them, and loaded by a Node that refuses require() of an ES module.
//
// With --run, the API function is also called with real web Requests against the local database
// (health, register, who-am-I), both bundled and as shipped.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const outdir = path.resolve('.netlify-check');
const strictDir = path.join(outdir, 'as-shipped');
const fns = fs.readdirSync('netlify/functions').filter((f) => /\.m?ts$/.test(f));
const outName = (f) => f.replace(/\.m?ts$/, '.mjs');
const run = process.argv.includes('--run');

/** Calls the API function like Netlify does and checks an account can be made and read back. */
async function exercise(apiFile, label) {
  process.env.AI_JOBS_MODE ||= 'inline';
  const api = (await import(pathToFileURL(apiFile).href)).default;
  const call = async (method, p, body, cookie) => {
    const r = await api(new Request(`http://localhost:8888${p}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:8888', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), { ip: '203.0.113.9' });
    return { status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') };
  };
  const h = await call('GET', '/api/health');
  console.log(`${label}: health`, h.status, JSON.stringify(h.json?.features));
  const email = `bundle${Date.now()}@example.com`;
  const reg = await call('POST', '/api/auth/register', { email, password: 'bundle check passphrase', name: 'Bundle Check', acceptTerms: true });
  console.log(`${label}: register`, reg.status, reg.setCookie ? 'cookie set' : 'NO COOKIE');
  const me = await call('GET', '/api/auth/me', null, reg.setCookie?.split(';')[0]);
  console.log(`${label}: me`, me.status, me.json?.user?.email === email ? 'ok' : JSON.stringify(me.json));
  const ai = await call('GET', '/api/ai/status');
  console.log(`${label}: ai status`, ai.status, JSON.stringify(ai.json));
  return h.status === 200 && reg.status === 201 && me.json?.user?.email === email;
}

// The second process: load every function as Netlify ships it. Started below with require(esm) switched off.
if (process.argv.includes('--as-shipped')) {
  for (const f of fns) {
    try { await import(pathToFileURL(path.join(strictDir, outName(f))).href); console.log(`as shipped: ${f} loads`); }
    catch (e) { console.error(`as shipped: ${f} FAILED to load: ${e.code ?? ''} ${String(e.message).split('\n')[0]}`); process.exit(1); }
  }
  if (run) {
    const ok = await exercise(path.join(strictDir, 'api.mjs'), 'as shipped').catch((e) => { console.error(`as shipped: request FAILED: ${e.code ?? ''} ${String(e.message).split('\n')[0]}`); return false; });
    process.exit(ok ? 0 : 1);
  }
  process.exit(0);
}

// 1. Dependencies.
const pkg = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };
const offersRequire = (e) => !!e && typeof e === 'object' && Object.entries(e).some(([k, v]) => k === 'require' || (k === 'node' && typeof v === 'string' && !v.endsWith('.mjs')) || offersRequire(v));
const esmOnly = (p) => p.type === 'module' && !offersRequire(p.exports);
const findDep = (from, name) => { for (let d = from; ;) { const c = path.join(d, 'node_modules', name); if (fs.existsSync(path.join(c, 'package.json'))) return c; const up = path.dirname(d); if (up === d) return null; d = up; } };
let listed = '';
try { listed = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { listed = String(e.stdout ?? ''); } // npm exits non-zero for warnings but still prints the list
const dirs = listed.split('\n').filter((d) => d.includes('node_modules'));
if (!dirs.length) { console.error('Could not list the installed packages (npm ls printed nothing).'); process.exit(1); }
const clashes = new Set();
for (const dir of dirs) {
  const p = pkg(dir);
  if (!p || p.type === 'module') continue;
  for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
    const at = findDep(dir, dep), dp = at && pkg(at);
    if (dp && esmOnly(dp)) clashes.add(`${p.name}@${p.version} (CommonJS) requires ${dp.name}@${dp.version} (ES module only)`);
  }
}
if (clashes.size) {
  console.error(`These packages would crash the API on Netlify (ERR_REQUIRE_ESM):\n  ${[...clashes].join('\n  ')}\nPin the ES-module-only package to its last CommonJS version under "overrides" in package.json.`);
  process.exit(1);
}
console.log(`dependencies: ${dirs.length} production packages, none requires an ES-module-only package`);

// 2 and 3. Build each function both ways.
fs.rmSync(outdir, { recursive: true, force: true });
for (const f of fns) {
  await build({
    entryPoints: [`netlify/functions/${f}`], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    outfile: path.join(outdir, outName(f)), external: ['pg-native'], logLevel: 'error',
    // Netlify adds the same require shim to ESM function bundles.
    banner: { js: "import {createRequire as ___nfyCreateRequire} from 'module';const require=___nfyCreateRequire(import.meta.url);" },
  });
  await build({ entryPoints: [`netlify/functions/${f}`], bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', outfile: path.join(strictDir, outName(f)), logLevel: 'error' });
  console.log(`bundled ${f} (${(fs.statSync(path.join(outdir, outName(f))).size / 1024).toFixed(0)} KB)`);
}

// Netlify's runtime does not let require() load an ES module; newer Node does unless told not to.
const strictFlag = process.allowedNodeEnvironmentFlags.has('--experimental-require-module') ? ['--no-experimental-require-module'] : [];
const shipped = spawnSync(process.execPath, [...strictFlag, fileURLToPath(import.meta.url), '--as-shipped', ...(run ? ['--run'] : [])], {
  stdio: 'inherit',
  // As on Netlify: no storage or site settings of our own, so the app takes its Netlify defaults.
  env: { ...process.env, NETLIFY: 'true', STORAGE_DRIVER: '', SERVE_SITE: '' },
});
if (shipped.status !== 0) process.exit(1);

if (run) {
  process.env.STORAGE_DRIVER ||= 'local';
  const ok = await exercise(path.join(outdir, 'api.mjs'), 'bundled');
  process.exit(ok ? 0 : 1);
}
