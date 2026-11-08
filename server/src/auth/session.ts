import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { one, q } from '../db';
import { newToken, sha256 } from './crypto';

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  role: 'member' | 'admin';
  account_type: string;
  email_verified_at: string | null;
  marketing_opt_in: boolean;
  phone: string | null;
  created_at: string;
}

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null; sessionHash: Buffer | null }
}

const USER_COLS = 'u.id, u.email, u.display_name, u.role, u.account_type, u.email_verified_at, u.marketing_opt_in, u.phone, u.created_at';

export async function createSession(reply: FastifyReply, userId: string, userAgent?: string) {
  const { token, hash } = newToken();
  const expires = new Date(Date.now() + config.session.days * 86_400_000);
  await q('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)', [hash, userId, expires, (userAgent ?? '').slice(0, 300)]);
  reply.setCookie(config.session.cookie, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.session.secureCookie, expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionHash) await q('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
  reply.clearCookie(config.session.cookie, { path: '/' });
}

/** Resolves the signed-in user (if any) for every request. */
export async function loadSession(req: FastifyRequest) {
  req.user = null; req.sessionHash = null;
  const token = req.cookies?.[config.session.cookie];
  if (!token || token.length > 100) return;
  const hash = sha256(token);
  const row = await one<SessionUser & { last_seen_at: Date }>(
    `SELECT ${USER_COLS}, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`, [hash]);
  if (!row) return;
  req.sessionHash = hash;
  const { last_seen_at, ...user } = row;
  req.user = user;
  if (Date.now() - new Date(last_seen_at).getTime() > 3_600_000) {
    q('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hash]).catch(() => {});
  }
}

export async function getUser(id: string) {
  return one<SessionUser>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
}

export function publicUser(u: SessionUser) {
  return {
    id: u.id, email: u.email, name: u.display_name, role: u.role, accountType: u.account_type,
    emailVerified: !!u.email_verified_at, marketingOptIn: u.marketing_opt_in, phone: u.phone, createdAt: u.created_at,
  };
}
