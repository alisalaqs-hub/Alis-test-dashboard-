/**
 * Creates or promotes the first admin. Run once after deploying:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run db:seed
 * If the account already exists it is promoted to admin and its password is left unchanged.
 */
import { hashPassword, passwordProblem } from '../auth/crypto';
import { config } from '../config';
import { one, pool, q } from '../db';
import { migrate } from '../migrate';

async function main() {
  await migrate((m) => console.log(m));
  const email = config.adminEmail;
  if (!email) throw new Error('Set ADMIN_EMAIL (and ADMIN_PASSWORD for a new account).');
  const existing = await one<{ id: string }>('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (existing) {
    await q(`UPDATE users SET role = 'admin', email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [existing.id]);
    console.log(`${email} is now an admin.`);
    return;
  }
  const pw = process.env.ADMIN_PASSWORD ?? '';
  const problem = passwordProblem(pw);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  await q(`INSERT INTO users (email, password_hash, display_name, role, account_type, email_verified_at) VALUES ($1, $2, 'Streetkey admin', 'admin', 'buyer', now())`, [email, await hashPassword(pw)]);
  console.log(`Created admin ${email}.`);
}
main().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
