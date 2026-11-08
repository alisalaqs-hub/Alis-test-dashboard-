// Netlify build: embed migrations, build the website, and (when a database is connected)
// apply migrations before the new functions go live.
import { execSync } from 'node:child_process';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('node scripts/gen-migrations.mjs');
run('npm run build');
const db = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL;
if (db) run('npx tsx server/src/bin/migrate.ts');
else console.warn('\n[streetkey] No database connected yet (NETLIFY_DB_URL / DATABASE_URL). The site builds, but accounts and listings need a database: see docs/08-backend.md.\n');
