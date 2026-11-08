import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DUMMY_HASH, hashPassword, newToken, passwordProblem, sha256, verifyPassword } from '../auth/crypto';
import { createSession, destroySession, getUser, publicUser } from '../auth/session';
import { one, q, tx } from '../db';
import { mails } from '../services/email';
import { limit } from '../services/ratelimit';
import { audit, HttpError, parse, requireUser } from '../services/http';

const limited = (name: string, max: number, windowSec = 60) => ({ preHandler: limit(`auth.${name}`, max, windowSec) });
const ACCOUNT_TYPES = ['buyer', 'owner', 'landlord', 'agent', 'developer', 'investor'] as const;

const Register = z.object({
  email: z.email('Enter a valid email address.').max(254),
  password: z.string().max(200),
  name: z.string().trim().min(1, 'Enter your name.').max(80),
  accountType: z.enum(ACCOUNT_TYPES).default('buyer'),
  marketingOptIn: z.boolean().default(false),
  acceptTerms: z.literal(true, { error: 'Please accept the terms and privacy notice.' }),
});

export async function issueEmailToken(userId: string, purpose: 'verify' | 'reset') {
  const { token, hash } = newToken();
  const hours = purpose === 'verify' ? 48 : 1;
  await q(`INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`, [hash, userId, purpose, hours]);
  return token;
}

async function useEmailToken(token: string, purpose: 'verify' | 'reset') {
  const row = await one<{ user_id: string }>(
    `UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), purpose]);
  if (!row) throw new HttpError(400, purpose === 'verify' ? 'This confirmation link has expired or was already used.' : 'This reset link has expired or was already used. Ask for a new one.', 'bad_token');
  return row.user_id;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', limited('register', 8), async (req, reply) => {
    const b = parse(Register, req.body);
    const problem = passwordProblem(b.password);
    if (problem) throw new HttpError(400, problem, 'weak_password', { password: problem });
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [b.email]);
    if (exists) throw new HttpError(409, 'An account with this email already exists. Try signing in instead.', 'email_taken', { email: 'Already registered.' });
    const hash = await hashPassword(b.password);
    const user = await tx(async (c) => {
      const u = await one<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, account_type, marketing_opt_in) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [b.email, hash, b.name, b.accountType, b.marketingOptIn], c);
      await q(`INSERT INTO consents (user_id, purpose) VALUES ($1, 'terms')`, [u!.id], c);
      if (b.marketingOptIn) await q(`INSERT INTO consents (user_id, purpose) VALUES ($1, 'marketing')`, [u!.id], c);
      return u!;
    });
    const token = await issueEmailToken(user.id, 'verify');
    await mails.verify(b.email, b.name, token);
    await createSession(reply, user.id, req.headers['user-agent']);
    req.user = await getUser(user.id);
    await audit(req, 'user.registered', `user:${user.id}`, { accountType: b.accountType });
    return reply.code(201).send({ user: publicUser(req.user!) });
  });

  app.post('/api/auth/login', limited('login', 10), async (req, reply) => {
    const b = parse(z.object({ email: z.string().trim().max(254), password: z.string().max(200) }), req.body);
    const row = await one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1 AND deleted_at IS NULL', [b.email]);
    const good = await verifyPassword(b.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !good) {
      await audit(req, 'auth.login_failed', null, { email: b.email.toLowerCase() });
      throw new HttpError(401, 'That email and password don’t match an account.', 'bad_credentials');
    }
    await createSession(reply, row.id, req.headers['user-agent']);
    req.user = await getUser(row.id);
    await audit(req, 'auth.login', `user:${row.id}`);
    return { user: publicUser(req.user!) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user ? publicUser(req.user) : null }));

  app.post('/api/auth/verify', limited('verify', 20), async (req) => {
    const b = parse(z.object({ token: z.string().min(10).max(100) }), req.body);
    const userId = await useEmailToken(b.token, 'verify');
    await q('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId]);
    return { ok: true, user: req.user?.id === userId ? publicUser((await getUser(userId))!) : undefined };
  });

  app.post('/api/auth/resend-verification', limited('resend', 3, 600), async (req) => {
    const u = requireUser(req);
    if (u.email_verified_at) return { ok: true, alreadyVerified: true };
    await mails.verify(u.email, u.display_name, await issueEmailToken(u.id, 'verify'));
    return { ok: true };
  });

  // Always answers the same way, so it can't be used to find out who has an account.
  app.post('/api/auth/forgot', limited('forgot', 5, 600), async (req) => {
    const b = parse(z.object({ email: z.string().trim().max(254) }), req.body);
    const u = await one<{ id: string; display_name: string; email: string }>('SELECT id, display_name, email FROM users WHERE email = $1 AND deleted_at IS NULL', [b.email]);
    if (u) {
      await mails.reset(u.email, u.display_name, await issueEmailToken(u.id, 'reset'));
      await audit(req, 'auth.reset_requested', `user:${u.id}`);
    }
    return { ok: true };
  });

  app.post('/api/auth/reset', limited('reset', 10), async (req, reply) => {
    const b = parse(z.object({ token: z.string().min(10).max(100), password: z.string().max(200) }), req.body);
    const problem = passwordProblem(b.password);
    if (problem) throw new HttpError(400, problem, 'weak_password', { password: problem });
    const userId = await useEmailToken(b.token, 'reset');
    await q('UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId, await hashPassword(b.password)]);
    await q('DELETE FROM sessions WHERE user_id = $1', [userId]); // sign out everywhere
    await createSession(reply, userId, req.headers['user-agent']);
    await audit(req, 'auth.password_reset', `user:${userId}`);
    return { ok: true, user: publicUser((await getUser(userId))!) };
  });

  app.post('/api/auth/change-password', limited('change-password', 5), async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ current: z.string().max(200), password: z.string().max(200) }), req.body);
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!row || !(await verifyPassword(b.current, row.password_hash))) throw new HttpError(400, 'Your current password isn’t right.', 'bad_credentials', { current: 'Incorrect password.' });
    const problem = passwordProblem(b.password);
    if (problem) throw new HttpError(400, problem, 'weak_password', { password: problem });
    await q('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await hashPassword(b.password)]);
    await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, req.sessionHash]); // sign out other devices
    await audit(req, 'auth.password_changed', `user:${u.id}`);
    return { ok: true };
  });
}
