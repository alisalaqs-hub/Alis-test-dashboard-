/**
 * The report an agency receives by email after every feed run, whether the file came from its software with a
 * feed key or was uploaded by hand: how many listings were accepted, updated and withdrawn, and every listing
 * that was not imported, with the reason. It goes to the agency's owners and admins.
 */
import { feedLeftOutText, type FeedIssue, type FeedReport } from '../../../src/engine/listings';
import { config } from '../config';
import { q } from '../db';
import { sendMail, type Mail } from './email';

/** The most listings named in one email. The message says how many more there were. */
export const FEED_REPORT_MAX_LINES = 200;

export interface FeedRun {
  organisationName: string;
  /** How the file arrived: with a feed key, or uploaded by hand from the agency page. */
  via: 'key' | 'upload';
  /** The feed key's label ("Branch 1"), for a file sent with a key. */
  keyLabel?: string;
  /** For example "BLM 3". */
  format: string;
  /** Listings imported: new ones and ones already on Streetkey. `updated` is how many were already there. */
  accepted: number; updated: number; withdrawn: number;
  /** Every listing with something to report. `imported` marks one that went in with a detail left out. */
  issues: FeedIssue[];
  leftOut: FeedReport['leftOut'];
  /** Whether the agency has been verified. Until it is, its listings wait as pending. */
  verified: boolean;
  at: Date;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
/** One line of plain text from words that came out of the agent's file. */
const line = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** The message for one recipient. */
export function feedReportMail(to: string, r: FeedRun): Mail {
  const rejected = r.issues.filter((i) => !i.imported), notes = r.issues.filter((i) => i.imported);
  const date = r.at.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
  const time = r.at.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const how = r.via === 'upload' ? 'uploaded by hand' : `sent with the feed key “${line(r.keyLabel ?? 'CRM feed', 60)}”`;
  const source = r.via === 'upload' ? 'an earlier file uploaded by hand' : 'an earlier file sent with this feed key';

  // Not-imported listings first, then the ones imported with something left out, up to the limit between them.
  const shownRejected = rejected.slice(0, FEED_REPORT_MAX_LINES);
  const shownNotes = notes.slice(0, FEED_REPORT_MAX_LINES - shownRejected.length);
  const more = r.issues.length - shownRejected.length - shownNotes.length;
  const list = (items: FeedIssue[]) => items.map((i) => `${line(i.ref, 40)}: ${line(i.reason, 300)}`).join('\n');

  const parts = [
    `Streetkey has imported the listing file ${how} for ${r.organisationName} on ${date} at ${time} (${r.format}).`,
    [
      `Accepted: ${r.accepted.toLocaleString('en-GB')} (${(r.accepted - r.updated).toLocaleString('en-GB')} new, ${r.updated.toLocaleString('en-GB')} updated)`,
      `Withdrawn: ${r.withdrawn.toLocaleString('en-GB')}`,
      `Not imported: ${rejected.length.toLocaleString('en-GB')}`,
    ].join('\n'),
    ...(r.verified ? [] : ['Your agency is awaiting verification, so the accepted listings are pending until an admin approves the agency.']),
    ...(r.withdrawn ? [`Withdrawn listings were on Streetkey from ${source} and are not among the listings accepted from this one.`] : []),
    ...(shownRejected.length ? [`Not imported (${rejected.length.toLocaleString('en-GB')}). A listing that is not imported is not shown on Streetkey:\n${list(shownRejected)}`] : []),
    ...(shownNotes.length ? [`Imported, with something left out (${notes.length.toLocaleString('en-GB')}):\n${list(shownNotes)}`] : []),
    ...(more > 0 ? [`And ${count(more, 'more listing')} not named here: this email lists the first ${FEED_REPORT_MAX_LINES}.`] : []),
    ...feedLeftOutText(r.leftOut),
    `See your recent uploads: ${config.publicUrl}/account/agency`,
  ];
  return {
    to, template: 'feed_report',
    subject: `Feed report for ${line(r.organisationName, 80)}: ${r.accepted.toLocaleString('en-GB')} accepted, ${r.withdrawn.toLocaleString('en-GB')} withdrawn, ${rejected.length.toLocaleString('en-GB')} not imported`,
    text: parts.join('\n\n'),
  };
}

/** The agency's owners and admins (accounts that still exist). */
export async function feedReportRecipients(organisationId: string): Promise<string[]> {
  const rows = await q<{ email: string }>(
    `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organisation_id = $1 AND m.role IN ('owner', 'admin') AND u.deleted_at IS NULL`, [organisationId]);
  return rows.map((r) => r.email);
}

/** Emails the report to each of the agency's owners and admins. Returns how many messages were handed over. */
export async function sendFeedReport(organisationId: string, run: FeedRun): Promise<number> {
  const to = await feedReportRecipients(organisationId);
  await Promise.all(to.map((email) => sendMail(feedReportMail(email, run))));
  return to.length;
}
