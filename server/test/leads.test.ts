/**
 * Lead emails: what the lister is sent about an enquiry (and that a reply goes to the enquirer), the
 * enquirer's confirmation, what happens to a message the spam screen holds back, and an agency's leads email.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setEnquiryScreener } from '../src/ai/hooks';
import { enquiryScreener } from '../src/ai/inbox/screen';
import { config } from '../src/config';
import { one, q } from '../src/db';
import { outbox, type Mail } from '../src/services/email';
import { client, getApp, LISTING, signUp } from './helpers';
import { fakeHosts } from './setup';

const SAFETY = 'Never pay a deposit or holding fee before you have viewed the property.';
const ENQUIRY = { name: 'Sam Buyer', phone: '07700 900123', kind: 'viewing', message: 'Could I view on Saturday morning?', preferredSlot: 'Sat 10:00' };
/** Emails sent since `from`, optionally to one address or of one template. */
const sent = (from: number, o: { to?: string; template?: string } = {}) => outbox.slice(from).filter((m) => (!o.to || m.to === o.to) && (!o.template || m.template === o.template));

/** A live listing by a private seller or landlord. */
async function privateListing(over: Record<string, unknown> = {}, accountType = 'owner') {
  const seller = await signUp({ accountType, name: 'Pat Seller' });
  const ref = (await seller.c.post('/api/listings', { ...LISTING, ...over })).json.listing.ref as string;
  await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [ref]);
  return { seller, ref };
}
/** An agency with an owner, an admin and an ordinary member, and one live listing created by the member. */
async function agencyListing() {
  const owner = await signUp({ accountType: 'agent', name: 'Agency Owner' });
  const orgId = (await owner.c.post('/api/orgs', { name: 'Lea Valley Homes', kind: 'agency', redressScheme: 'The Property Ombudsman' })).json.id as string;
  const manager = await signUp({ accountType: 'agent', name: 'Branch Manager' });
  const negotiator = await signUp({ accountType: 'agent', name: 'Negotiator' });
  await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, manager.user.id, negotiator.user.id]);
  const ref = (await negotiator.c.post('/api/listings', { ...LISTING, title: 'Two-bed flat by the marshes', addressLine: 'Flat 3, 8 Marsh Lane' })).json.listing.ref as string;
  await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [ref]);
  return { owner, manager, negotiator, orgId, ref };
}
const enquiryId = async (ref: string, email: string) =>
  (await one<{ id: string }>('SELECT e.id FROM enquiries e JOIN listings l ON l.id = e.listing_id WHERE l.ref = $1 AND e.email = $2 ORDER BY e.created_at DESC LIMIT 1', [ref, email]))!.id;

describe('the email a lister gets about an enquiry', () => {
  it('has everything needed to answer, and a reply goes to the enquirer', async () => {
    const { seller, ref } = await privateListing();
    const before = outbox.length;
    const r = await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: 'sam.buyer@example.com' });
    expect(r.status).toBe(201);

    const [mail] = sent(before, { to: seller.email });
    expect(mail.template).toBe('enquiry_received');
    expect(mail.replyTo).toBe('sam.buyer@example.com'); // answering from their own mail reaches the enquirer
    // the person's details are in the body, never the subject, and the subject has no house number
    expect(mail.subject).toBe('New viewing request for 3-bed Victorian terrace with garden');
    const lines = mail.text.split('\n');
    for (const line of ['Name: Sam Buyer', 'Email: sam.buyer@example.com', 'Phone: 07700 900123', 'Type: Viewing request', 'Preferred time: Sat 10:00',
      '“Could I view on Saturday morning?”', `Listing: 3-bed Victorian terrace with garden (${ref})`, 'Address: 14 Elm Road, London E17 4QH', `${config.publicUrl}/property/${ref}`]) expect(lines).toContain(line);
    // the link to the conversation in the inbox is still there
    expect(mail.text).toContain(`${config.publicUrl}/account/inbox/${r.json.id}`);
    expect(mail.text).toContain('Reply to this email to answer Sam Buyer directly');
    expect(mail.text).not.toContain('Reply from your inbox'); // the old wording, which hid how to reach the person
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM emails WHERE template = 'enquiry_received' AND to_address = $1`, [seller.email]))!.n).toBe(1);
  });

  it('says when it is a question, and leaves out a phone number or time that was not given', async () => {
    const { seller, ref } = await privateListing({ title: null, addressLine: '22 Oak Avenue' });
    const before = outbox.length;
    expect((await client().post(`/api/listings/${ref}/enquiries`, { name: 'Lena Asker', email: 'lena@example.com', kind: 'question', message: 'Is the garden south facing?' })).status).toBe(201);
    const [mail] = sent(before, { to: seller.email });
    expect(mail.subject).toBe('New question about Oak Avenue, London'); // no title: the street, never the house number
    expect(mail.text).toContain('Type: Question');
    expect(mail.text).toContain('Address: 22 Oak Avenue, London E17 4QH'); // the lister's own address, in full, in the body
    expect(mail.text).not.toMatch(/^Phone:/m);
    expect(mail.text).not.toMatch(/^Preferred time:/m);
  });

  it('keeps what was typed in a one-line box on one line, so it cannot pass for another line of the email', async () => {
    const { seller, ref } = await privateListing();
    const before = outbox.length;
    const r = await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, name: 'Sam\nEmail: someone.else@example.com', email: 'real@example.com', preferredSlot: 'Sat\nPhone: 0900 000 0000' });
    expect(r.status).toBe(201);
    const lines = sent(before, { to: seller.email })[0].text.split('\n');
    expect(lines.filter((l) => l.startsWith('Email:'))).toEqual(['Email: real@example.com']);
    expect(lines.filter((l) => l.startsWith('Phone:'))).toEqual(['Phone: 07700 900123']);
    expect(lines).toContain('Name: Sam Email: someone.else@example.com');
  });

  it('gives the email provider the enquirer’s address as Reply-To', async () => {
    const { seller, ref } = await privateListing();
    const posted: { to: string[]; reply_to?: string; subject: string }[] = [];
    config.email.resendApiKey = 're_test';
    fakeHosts.set('api.resend.com', async (_url, init) => { posted.push(JSON.parse(String(init!.body))); return Response.json({ id: 'ok' }); });
    try {
      expect((await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: 'sam.buyer@example.com' })).status).toBe(201);
    } finally { config.email.resendApiKey = ''; fakeHosts.delete('api.resend.com'); }
    const lead = posted.find((m) => m.to[0] === seller.email)!;
    expect(lead.reply_to).toBe('sam.buyer@example.com');
    const confirmation = posted.find((m) => m.to[0] === 'sam.buyer@example.com')!;
    expect(confirmation.subject).toMatch(/^Your viewing request/);
    expect('reply_to' in confirmation).toBe(false); // replies to the confirmation go nowhere special
  });
});

describe('the enquirer’s confirmation', () => {
  it('says what they sent, to whom, that the answer comes by email, and gives the safety advice', async () => {
    const { seller, ref } = await privateListing();
    const before = outbox.length;
    expect((await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: 'sam.buyer@example.com' })).status).toBe(201);
    const [mail] = sent(before, { to: 'sam.buyer@example.com' });
    expect(mail.template).toBe('enquiry_confirmation');
    expect(mail.subject).toBe('Your viewing request for 3-bed Victorian terrace with garden');
    expect(mail.replyTo).toBeUndefined();
    for (const part of ['Hi Sam Buyer,', 'We’ve sent your viewing request to the seller.', `Listing: 3-bed Victorian terrace with garden (${ref})`, `${config.publicUrl}/property/${ref}`,
      'Preferred time: Sat 10:00', '“Could I view on Saturday morning?”', 'The seller will reply to you by email, at this address.', SAFETY]) expect(mail.text).toContain(part);
    // nothing about a private seller that the listing itself doesn't show
    expect(mail.text).not.toContain('14 Elm');
    expect(mail.text).not.toContain('E17 4QH');
    expect(mail.text).not.toContain('Pat Seller');
    expect(mail.text).not.toContain(seller.email);
    // one confirmation, and one lead
    expect(sent(before)).toHaveLength(2);
  });

  it('names an agency, and calls a private landlord "the landlord"', async () => {
    const agency = await agencyListing();
    let before = outbox.length;
    expect((await client().post(`/api/listings/${agency.ref}/enquiries`, { name: 'Lena Asker', email: 'lena@example.com', kind: 'question', message: 'Is there a lift?' })).status).toBe(201);
    let mail = sent(before, { to: 'lena@example.com' })[0];
    expect(mail.subject).toBe('Your question about Two-bed flat by the marshes');
    expect(mail.text).toContain('We’ve sent your question to Lea Valley Homes.');
    expect(mail.text).toContain('Lea Valley Homes will reply to you by email, at this address.');
    expect(mail.text).toContain(SAFETY);

    const rental = await privateListing({ channel: 'rent', price: 1500, title: 'One-bed flat near the park' }, 'landlord');
    before = outbox.length;
    expect((await client().post(`/api/listings/${rental.ref}/enquiries`, { ...ENQUIRY, email: 'tenant@example.com' })).status).toBe(201);
    mail = sent(before, { to: 'tenant@example.com' })[0];
    expect(mail.text).toContain('We’ve sent your viewing request to the landlord.');
    expect(mail.text).toContain('The landlord will reply to you by email, at this address.');
    expect(mail.text).toContain(SAFETY);
  });
});

describe('a message the spam screen holds back', () => {
  afterEach(() => { setEnquiryScreener(enquiryScreener); });

  it('is not emailed to anyone, and the lister gets the full email when they choose "Not spam"', async () => {
    const { seller, ref } = await privateListing();
    const buyer = await signUp({ name: 'Ana Real' });
    await getApp();
    setEnquiryScreener(async () => ({ filter: true, reason: 'Held for this test.' }));
    const before = outbox.length;
    const r = await buyer.c.post(`/api/listings/${ref}/enquiries`, { name: 'Ana Real', email: buyer.email, phone: '07700 900456', kind: 'question', message: 'Please send the holding deposit details today.' });
    expect(r.status).toBe(201); // accepted the same way either way
    expect(r.json).toEqual({ ok: true, id: r.json.id });
    // nothing goes out: no lead to the lister, and no confirmation quoting the held message to the address that was typed
    expect(sent(before)).toEqual([]);

    // a follow-up in the held conversation is held too
    expect((await buyer.c.post(`/api/enquiries/${r.json.id}/messages`, { body: 'Hello? Did you get my message?' })).status).toBe(201);
    expect(sent(before)).toEqual([]);

    setEnquiryScreener(enquiryScreener);
    const released = await seller.c.post(`/api/ai/inbox/${r.json.id}/unfilter`);
    expect(released.json).toMatchObject({ ok: true, filtered: false, emailed: 1 });
    const out = sent(before);
    expect(out.map((m) => [m.to, m.template])).toEqual([[seller.email, 'enquiry_received']]); // still no confirmation
    const mail = out[0];
    expect(mail.replyTo).toBe(buyer.email);
    for (const part of ['Name: Ana Real', `Email: ${buyer.email}`, 'Phone: 07700 900456', 'Type: Question', 'Please send the holding deposit details today.', 'Hello? Did you get my message?',
      'Address: 14 Elm Road, London E17 4QH', `${config.publicUrl}/account/inbox/${r.json.id}`]) expect(mail.text).toContain(part);

    // from now on a follow-up is emailed as usual, and a reply to it goes to the enquirer too
    expect((await buyer.c.post(`/api/enquiries/${r.json.id}/messages`, { body: 'Is there parking?' })).status).toBe(201);
    const followUp = sent(before, { template: 'enquiry_followup' }).at(-1)!;
    expect(followUp.to).toBe(seller.email);
    expect(followUp.replyTo).toBe(buyer.email);
    expect(followUp.subject).toBe('New message about 3-bed Victorian terrace with garden');
    for (const part of ['Ana Real sent another message', '“Is there parking?”', `Email: ${buyer.email}`, 'Phone: 07700 900456', `${config.publicUrl}/account/inbox/${r.json.id}`]) expect(followUp.text).toContain(part);
  });
});

describe('an agency’s leads email', () => {
  const to = (mails: Mail[]) => mails.map((m) => m.to).sort();

  it('receives the agency’s enquiries and valuation requests instead of its members', async () => {
    const { owner, manager, negotiator, orgId, ref } = await agencyListing();
    const buyer = await signUp({ name: 'Sam Buyer' });

    // without one: the person who created the listing and the people who run the agency
    let before = outbox.length;
    expect((await buyer.c.post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: buyer.email })).status).toBe(201);
    expect(to(sent(before, { template: 'enquiry_received' }))).toEqual([owner.email, manager.email, negotiator.email].sort());
    before = outbox.length;
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { name: 'Vera Vendor', email: 'vera@example.com', postcode: 'E17 4QH', intent: 'sell' })).status).toBe(201);
    expect(to(sent(before, { template: 'valuation_request' }))).toEqual([owner.email, manager.email].sort());

    // with one: that address only, for a new enquiry, a later message and a valuation request
    expect((await owner.c.patch(`/api/orgs/${orgId}`, { leadsEmail: 'leads@leavalleyhomes.example' })).status).toBe(200);
    before = outbox.length;
    const other = await signUp({ name: 'Lena Asker' });
    const enq = await other.c.post(`/api/listings/${ref}/enquiries`, { name: 'Lena Asker', email: other.email, kind: 'question', message: 'Is there a lift?' });
    expect(enq.status).toBe(201);
    const lead = sent(before, { template: 'enquiry_received' });
    expect(to(lead)).toEqual(['leads@leavalleyhomes.example']);
    expect(lead[0].replyTo).toBe(other.email);
    expect(lead[0].text).toContain('Address: Flat 3, 8 Marsh Lane, London E17 4QH');
    expect(sent(before, { to: other.email, template: 'enquiry_confirmation' })[0].text).toContain('We’ve sent your question to Lea Valley Homes.');

    expect((await other.c.post(`/api/enquiries/${enq.json.id}/messages`, { body: 'And is there a bike store?' })).status).toBe(201);
    expect(to(sent(before, { template: 'enquiry_followup' }))).toEqual(['leads@leavalleyhomes.example']);

    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { name: 'Vera Vendor', email: 'vera2@example.com', phone: '07700 900789', postcode: 'E17 4QH', intent: 'let' })).status).toBe(201);
    const valuation = sent(before, { template: 'valuation_request' });
    expect(to(valuation)).toEqual(['leads@leavalleyhomes.example']);
    expect(valuation[0].replyTo).toBe('vera2@example.com');
    // nobody at the agency got a copy in their own mailbox
    for (const member of [owner, manager, negotiator]) expect(sent(before, { to: member.email })).toEqual([]);
    // but the conversation is in their inboxes on the site as before
    expect((await negotiator.c.get('/api/me/inbox')).json.items.map((i: { id: string }) => i.id)).toContain(enq.json.id);
    // and a reply written there still goes to the enquirer
    expect((await manager.c.post(`/api/enquiries/${enq.json.id}/messages`, { body: 'Yes, there is a lift.' })).status).toBe(201);
    expect(sent(before, { to: other.email, template: 'enquiry_reply' })).toHaveLength(1);

    // cleared: back to the members
    expect((await owner.c.patch(`/api/orgs/${orgId}`, { leadsEmail: '' })).status).toBe(200);
    before = outbox.length;
    expect((await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: 'third@example.com' })).status).toBe(201);
    expect(to(sent(before, { template: 'enquiry_received' }))).toEqual([owner.email, manager.email, negotiator.email].sort());
    expect(await enquiryId(ref, 'third@example.com')).toBeTruthy();
  });

  it('is used when a held message is released, too', async () => {
    const { owner, orgId, ref } = await agencyListing();
    expect((await owner.c.patch(`/api/orgs/${orgId}`, { leadsEmail: 'leads@leavalleyhomes.example' })).status).toBe(200);
    await getApp();
    setEnquiryScreener(async () => ({ filter: true, reason: 'Held for this test.' }));
    const before = outbox.length;
    let id = '';
    try {
      const r = await client().post(`/api/listings/${ref}/enquiries`, { ...ENQUIRY, email: 'held@example.com' });
      expect(r.status).toBe(201);
      id = r.json.id;
      expect(sent(before)).toEqual([]);
    } finally { setEnquiryScreener(enquiryScreener); }
    expect((await owner.c.post(`/api/ai/inbox/${id}/unfilter`)).json).toMatchObject({ ok: true, emailed: 1 });
    expect(sent(before).map((m) => [m.to, m.template, m.replyTo])).toEqual([['leads@leavalleyhomes.example', 'enquiry_received', 'held@example.com']]);
  });
});
