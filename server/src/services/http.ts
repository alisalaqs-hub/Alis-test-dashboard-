import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../db';

/** An error with an HTTP status and a message that is safe to show to people. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public fields?: Record<string, string>) { super(message); }
}
export const notFound = (what = 'That page') => new HttpError(404, `${what} could not be found.`, 'not_found');
export const forbidden = () => new HttpError(403, 'You don’t have permission to do that.', 'forbidden');

export function requireUser(req: FastifyRequest) {
  if (!req.user) throw new HttpError(401, 'Please sign in to continue.', 'auth_required');
  return req.user;
}
export function requireAdmin(req: FastifyRequest) {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden();
  return u;
}

/** Validate input with zod and turn problems into field-level messages. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) { const k = i.path.join('.') || '_'; if (!fields[k]) fields[k] = i.message; }
  throw new HttpError(400, 'Some details need checking.', 'invalid', fields);
}

export async function audit(req: FastifyRequest | null, action: string, subject: string | null, detail?: Record<string, unknown>) {
  await q('INSERT INTO audit_log (actor_user_id, action, subject, detail, ip) VALUES ($1, $2, $3, $4, $5)',
    [req?.user?.id ?? null, action, subject, detail ? JSON.stringify(detail) : null, req?.ip ?? null]).catch(() => {});
}

export const ok = (reply: FastifyReply, body: unknown = { ok: true }, status = 200) => reply.code(status).send(body);
