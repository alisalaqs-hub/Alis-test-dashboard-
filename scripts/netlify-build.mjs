// Netlify build: embed migrations, build the website, and (when a database is connected)
// apply migrations before the new functions go live.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('node scripts/gen-migrations.mjs');
run('npm run build');
run('node scripts/spa-redirects.mjs'); // page addresses → the site (see the script)
run('node scripts/robots.mjs');        // robots.txt as a plain file
// Apps that show a preview of a shared link need the picture's full address, which is only known here.
const site = (process.env.PUBLIC_URL || process.env.URL || '').replace(/\/$/, '');
if (site) fs.writeFileSync('dist/index.html', fs.readFileSync('dist/index.html', 'utf8').replace('content="/share.png"', `content="${site}/share.png"`));
// An address that isn't a page gets the site's own "Page not found" (Netlify serves 404.html with a 404 status).
fs.copyFileSync('dist/index.html', 'dist/404.html');
const db = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL;
if (db) run('npx tsx server/src/bin/migrate.ts');
else console.warn('\n[streetkey] No database connected yet (NETLIFY_DB_URL / DATABASE_URL). The site builds, but accounts and listings need a database: see docs/08-backend.md.\n');
