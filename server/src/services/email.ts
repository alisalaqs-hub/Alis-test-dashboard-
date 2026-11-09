/**
 * Transactional email. Sends through Resend when RESEND_API_KEY is set; otherwise
 * logs the message (development) so every flow still works end to end.
 */
import { config } from '../config';
import { q } from '../db';

export interface Mail { to: string; template: string; subject: string; text: string; html?: string }
/** Messages "sent" without a provider, newest last (used by tests and local development). */
export const outbox: Mail[] = [];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function wrap(subject: string, text: string) {
  const body = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#B24D00">$1</a>').replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;background:#F7F5F0;font-family:Arial,Helvetica,sans-serif;color:#0E1424">
<div style="max-width:560px;margin:0 auto;padding:28px 20px"><div style="font-weight:800;font-size:22px;letter-spacing:-0.02em">street<span style="color:#F07415">key</span></div>
<h1 style="font-size:20px;margin:22px 0 12px">${esc(subject)}</h1><div style="font-size:15px;line-height:1.55">${body}</div>
<p style="font-size:12px;color:#555B6E;margin-top:28px">You’re receiving this because of activity on your Streetkey account.</p></div></body></html>`;
}

export async function sendMail(m: Mail) {
  const html = m.html ?? wrap(m.subject, m.text);
  let status: 'sent' | 'logged' | 'failed' = 'logged', providerId: string | null = null, error: string | null = null;
  if (config.email.resendApiKey) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.email.from, to: [m.to], subject: m.subject, text: m.text, html }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
      if (r.ok) { status = 'sent'; providerId = j.id ?? null; } else { status = 'failed'; error = j.message ?? `HTTP ${r.status}`; }
    } catch (e) { status = 'failed'; error = (e as Error).message; }
  } else {
    outbox.push(m);
    if (outbox.length > 200) outbox.shift();
    if (!config.isTest) console.log(`\n[email:${m.template}] to ${m.to}\nSubject: ${m.subject}\n${m.text}\n`);
  }
  await q('INSERT INTO emails (to_address, template, subject, status, provider_id, error) VALUES ($1, $2, $3, $4, $5, $6)',
    [m.to, m.template, m.subject, status, providerId, error]).catch(() => {});
  return status;
}

const link = (hashPath: string) => `${config.publicUrl}/#${hashPath}`;

export const mails = {
  verify: (to: string, name: string, token: string) => sendMail({ to, template: 'verify', subject: 'Confirm your email address',
    text: `Hi ${name},\n\nPlease confirm your email address to finish setting up your Streetkey account:\n${link(`/account/verify?token=${token}`)}\n\nThe link works for 48 hours. If you didn’t create an account, you can ignore this email.` }),
  reset: (to: string, name: string, token: string) => sendMail({ to, template: 'reset', subject: 'Reset your password',
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset your Streetkey password. Choose a new one here:\n${link(`/account/reset?token=${token}`)}\n\nThe link works for 1 hour and can be used once. If you didn’t ask, you can ignore this email; your password hasn’t changed.` }),
  enquiryToLister: (to: string, listingTitle: string, ref: string, from: string, kind: string, message: string, slot?: string | null) => sendMail({ to, template: 'enquiry_received',
    subject: `New ${kind === 'viewing' ? 'viewing request' : kind} for ${listingTitle}`,
    text: `${from} sent a ${kind === 'viewing' ? 'viewing request' : kind} about ${listingTitle} (${ref}).${slot ? `\nPreferred time: ${slot}` : ''}\n\n“${message}”\n\nReply from your inbox: ${link('/account/inbox')}` }),
  replyToEnquirer: (to: string, listingTitle: string, body: string) => sendMail({ to, template: 'enquiry_reply',
    subject: `Reply about ${listingTitle}`, text: `The seller or agent replied about ${listingTitle}:\n\n“${body}”\n\nSee the conversation: ${link('/account/inbox')}` }),
  replyToLister: (to: string, listingTitle: string, body: string) => sendMail({ to, template: 'enquiry_followup',
    subject: `New message about ${listingTitle}`, text: `You have a new message about ${listingTitle}:\n\n“${body}”\n\nReply from your inbox: ${link('/account/inbox')}` }),
  listingLive: (to: string, title: string, ref: string) => sendMail({ to, template: 'listing_live', subject: 'Your listing is live',
    text: `Good news: ${title} is now live on Streetkey.\n${link(`/property/${ref}`)}\n\nYou’ll get an email whenever someone asks for a viewing.` }),
  /** To the site admin (ADMIN_EMAIL): a submitted listing is waiting in the review queue. */
  listingForReview: (to: string, title: string, ref: string) => sendMail({ to, template: 'listing_review_admin', subject: `A new listing is waiting for review (${ref})`,
    text: `${title} (${ref}) was submitted and is waiting for review.\n\nReview it in the admin area:\n${link('/admin')}` }),
  listingRejected: (to: string, title: string, reason: string) => sendMail({ to, template: 'listing_rejected', subject: 'Your listing needs changes',
    text: `We couldn’t publish ${title} yet.\n\nReason: ${reason}\n\nYou can edit it and submit it again from ${link('/account/listings')}.` }),
  searchAlert: (to: string, query: string, items: { title: string; ref: string; price: string }[]) => sendMail({ to, template: 'search_alert',
    subject: `${items.length} new ${items.length === 1 ? 'home matches' : 'homes match'} “${query}”`,
    text: `New on Streetkey for “${query}”:\n\n${items.map((i) => `• ${i.title}, ${i.price}\n  ${link(`/property/${i.ref}`)}`).join('\n')}\n\nManage alerts: ${link('/account/searches')}` }),
};
