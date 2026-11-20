/**
 * Views and calls for listings, counted for every visitor without recording who they are.
 *
 * listing_views (migration 018) holds one row per listing per day: how many times its page was viewed and
 * how many times its phone number was tapped. No account, no network address, no session id.
 *
 * Not counted: the listing's own people (its owner, members of its agency) and Streetkey's admins; obvious
 * robots; a listing that isn't on the market; and the same visitor again within the same half hour. That
 * last check uses the rate-limit store (rate_limits, the fixed windows services/ratelimit.ts uses): a marker
 * that is a one-way hash of the listing and the visitor, so it can't be read back as "who viewed what", and
 * the daily clean-up deletes it with the other rate-limit rows. Nothing new that identifies a visitor is kept.
 *
 * Counting never fails a request and never holds one up for long: errors are swallowed, and the request
 * stops waiting after a moment (the count itself still completes).
 */
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ListingStatus } from '../../../src/lib/apiTypes';
import { q } from '../db';
import { PUBLIC_STATUSES } from './listings';
import { ipKey } from './ratelimit';

/** A visitor is counted once per listing in each window of this many seconds (half an hour). */
export const VIEW_WINDOW_SEC = 1800;
/** How long a request waits for its count before answering anyway. */
const WAIT_MS = 400;

/** Obvious robots: search engines, link previews (messaging apps, social sites) and uptime checks. A browser always says what it is. */
export const isRobot = (userAgent: string | undefined) => !userAgent?.trim() || /bot|crawler|spider|preview|monitoring/i.test(userAgent);

export interface Viewer { userId?: string | null; orgIds?: string[]; admin?: boolean }
type Counted = { id: string; status: ListingStatus; owner_user_id: string | null; organisation_id: string | null };

/** The listing's own people and Streetkey's admins: their visits say nothing about interest in the home. */
export const isOwnVisit = (l: Pick<Counted, 'owner_user_id' | 'organisation_id'>, v: Viewer) =>
  !!v.admin || (!!v.userId && l.owner_user_id === v.userId) || (!!l.organisation_id && !!v.orgIds?.includes(l.organisation_id));

/** Whether this request is a member of the public looking at a listing that is on the market. */
const countable = (req: FastifyRequest, l: Counted, v: Viewer) =>
  PUBLIC_STATUSES.includes(l.status) && !isOwnVisit(l, v) && !isRobot(req.headers['user-agent']);

/**
 * The half-hour marker for one visitor and one listing. The visitor is their account when signed in, otherwise
 * their network and browser together (several people behind one address still count separately). Only the hash is stored.
 */
const marker = (req: FastifyRequest, listingId: string) => {
  const who = req.user ? `u:${req.user.id}` : `${ipKey(req.ip)}|${req.headers['user-agent'] ?? ''}`;
  return `view:${createHash('sha256').update(`${listingId}|${who}`).digest('hex').slice(0, 40)}`;
};

/** Runs a count without letting it fail the request or hold it up. */
async function quietly(work: Promise<unknown>): Promise<void> {
  const done = work.then(() => undefined, () => undefined);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([done, new Promise<void>((res) => { timer = setTimeout(res, WAIT_MS); })]);
  clearTimeout(timer);
}

/**
 * One view of a listing for today, if this visit counts (see the top of the file). Safe to call from more than
 * one request for the same page view: the marker makes the second one a no-op, even when they arrive together.
 */
export function countView(req: FastifyRequest, l: Counted, v: Viewer): Promise<void> {
  if (!countable(req, l, v)) return Promise.resolve();
  // One statement: the marker for this half hour goes in, and only if it was new is the day's count raised.
  return quietly(q(
    `WITH first AS (
       INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1)
       ON CONFLICT (key, window_start) DO NOTHING RETURNING 1)
     INSERT INTO listing_views (listing_id, day, views)
     SELECT $2, current_date, 1 FROM first
     ON CONFLICT (listing_id, day) DO UPDATE SET views = listing_views.views + 1`, [marker(req, l.id), l.id, VIEW_WINDOW_SEC]));
}

/** One tap on the listing's phone number for today, from a member of the public. */
export function countCall(req: FastifyRequest, l: Counted, v: Viewer): Promise<void> {
  if (!countable(req, l, v)) return Promise.resolve();
  return quietly(q(
    `INSERT INTO listing_views (listing_id, day, calls) VALUES ($1, current_date, 1)
     ON CONFLICT (listing_id, day) DO UPDATE SET calls = listing_views.calls + 1`, [l.id]));
}
