/** Agent pages and valuation requests: the public page, "Book a valuation", the agency's own list, and what happens to the data. */
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { one, q } from '../src/db';
import { runCleanup } from '../src/jobs/run';
import { outbox } from '../src/services/email';
import { recordHistory } from '../src/services/history';
import { limits } from '../src/services/ratelimit';
import { client, LISTING, makeAdmin, PASSWORD, signUp } from './helpers';

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

async function agency(name = 'Lea Valley Homes') {
  const agent = await signUp({ accountType: 'agent', name: 'Agent' });
  const org = await agent.c.post('/api/orgs', { name, kind: 'agency', redressScheme: 'The Property Ombudsman' });
  expect(org.status).toBe(201);
  const orgId = org.json.id as string;
  /** A listing by the agency (agency staff list under their agency), put on the market `daysAgo` days ago. */
  const mk = async (over: Record<string, unknown>, daysAgo: number | null = 1) => {
    const r = await agent.c.post('/api/listings', { ...LISTING, ...over });
    expect(r.status).toBe(201);
    const ref = r.json.listing.ref as string;
    const { id } = (await one<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [ref]))!;
    if (daysAgo != null) {
      await q(`UPDATE listings SET status = 'live', published_at = now() - make_interval(days => $2) WHERE id = $1`, [id, daysAgo]);
      await recordHistory([id]); // "listed", as when a listing goes live through the site
    }
    return { ref, id };
  };
  return { agent, orgId, mk };
}

const REQUEST = { name: 'Sam Seller', email: 'sam.seller@example.com', phone: '07700 900123', postcode: 'E17 4QH', intent: 'sell', message: 'Thinking of selling in the spring.' };
const requestsFor = (orgId: string) => q<Record<string, unknown>>('SELECT * FROM valuation_requests WHERE organisation_id = $1 ORDER BY created_at', [orgId]);
const valuationMails = (from = 0) => outbox.slice(from).filter((m) => m.template === 'valuation_request');

describe('an agent’s public page', () => {
  it('shows who the agent is, their live listings newest first, and what they have on the market', async () => {
    const { agent, orgId, mk } = await agency();
    const oldest = await mk({ title: 'Terrace for sale, listed first', addressLine: '1 First Road' }, 3);
    const offer = await mk({ title: 'Semi for sale, now under offer', addressLine: '2 Second Road', type: 'semi-detached' }, 2);
    const rental = await mk({ title: 'Flat to rent, listed last', addressLine: '3 Third Road', channel: 'rent', price: 1500, type: 'flat' }, 1);
    const draft = await mk({ title: 'Draft that was never published', addressLine: '4 Draft Road' }, null);
    const withdrawn = await mk({ title: 'Withdrawn from the market', addressLine: '5 Gone Road' }, 9);
    const sold = await mk({ title: 'Sold last week', addressLine: '6 Sold Road' }, 30);
    const let_ = await mk({ title: 'Let last week', addressLine: '7 Let Road', channel: 'rent', price: 1200 }, 30);
    const soldLongAgo = await mk({ title: 'Sold over a year ago', addressLine: '8 Old Road' }, 500);
    expect((await agent.c.post(`/api/listings/${offer.ref}/status`, { status: 'under_offer' })).status).toBe(200);
    expect((await agent.c.post(`/api/listings/${withdrawn.ref}/status`, { status: 'withdrawn' })).status).toBe(200);
    expect((await agent.c.post(`/api/listings/${sold.ref}/status`, { status: 'sold' })).status).toBe(200);
    expect((await agent.c.post(`/api/listings/${let_.ref}/status`, { status: 'let' })).status).toBe(200);
    await q(`UPDATE listings SET status = 'sold' WHERE id = $1`, [soldLongAgo.id]);
    await q(`INSERT INTO listing_events (listing_id, kind, price, at) VALUES ($1, 'sold', 525000, now() - interval '13 months')`, [soldLongAgo.id]);
    // someone else's live listing is not the agent's
    const seller = await signUp();
    const elsewhere = (await seller.c.post('/api/listings', { ...LISTING, title: 'A private seller’s home', addressLine: '9 Other Road' })).json.listing.ref as string;
    await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [elsewhere]);

    const r = await client().get(`/api/agents/${orgId}`);
    expect(r.status).toBe(200);
    const joined = (await one<{ created_at: Date }>('SELECT created_at FROM organisations WHERE id = $1', [orgId]))!.created_at.toISOString().slice(0, 10);
    expect(r.json.agent).toEqual({
      id: orgId, name: 'Lea Valley Homes', kind: 'agency', verified: false, redressScheme: 'The Property Ombudsman', since: joined,
      counts: { sale: 2, rent: 1, soldOrLet12m: 2 },
      // the profile, empty until the agency fills it in
      phone: null, website: null, about: null, address: null, clientMoneyScheme: null, redressNumber: null, feesUrl: null,
    });
    expect(r.json.agent.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const refs = r.json.listings.map((l: { ref: string }) => l.ref);
    expect(refs).toEqual([rental.ref, offer.ref, oldest.ref]);
    for (const hidden of [draft.ref, withdrawn.ref, sold.ref, let_.ref, soldLongAgo.ref, elsewhere]) expect(refs).not.toContain(hidden);
    expect(r.json.listings.map((l: { status: string }) => l.status)).toEqual(['live', 'under_offer', 'live']);

    // the same public shape as the search, which now says whose listing it is
    const search = await client().get('/api/listings?pageSize=200');
    const inSearch = (ref: string) => search.json.items.find((l: { ref: string }) => l.ref === ref);
    for (const l of r.json.listings) expect(l).toEqual(inSearch(l.ref));
    expect(r.json.listings[0]).toMatchObject({ organisationId: orgId, agentName: 'Lea Valley Homes', source: { kind: 'agent', name: 'Lea Valley Homes' }, mine: false });
    expect(inSearch(elsewhere)).toMatchObject({ organisationId: null, agentName: null });
    expect((await client().get(`/api/listings/${oldest.ref}`)).json.listing).toMatchObject({ organisationId: orgId, agentName: 'Lea Valley Homes' });

    // once an admin has checked the agency, the page says so
    await q('UPDATE organisations SET verified = true WHERE id = $1', [orgId]);
    expect((await client().get(`/api/agents/${orgId}`)).json.agent.verified).toBe(true);
  });

  it('shows at most 60 listings but counts them all', async () => {
    const { orgId, mk } = await agency('Sixty Plus Estates');
    const first = await mk({ title: 'The one the rest are copied from', addressLine: '1 Copy Road' }, 2);
    await q(
      `INSERT INTO listings (ref, owner_user_id, organisation_id, source_kind, channel, status, title, address_line, town, postcode, district, property_type, tenure, beds, baths, floor_area, price, published_at)
       SELECT 'sk-b' || lpad(g::text, 6, '0'), owner_user_id, organisation_id, source_kind, channel, 'live', title, address_line, town, postcode, district, property_type, tenure, beds, baths, floor_area, price, now() - make_interval(mins => g)
         FROM listings, generate_series(1, 64) g WHERE id = $1`, [first.id]);
    const r = await client().get(`/api/agents/${orgId}`);
    expect(r.json.listings).toHaveLength(60);
    expect(r.json.listings[0].ref).toBe('sk-b000001'); // the newest
    expect(r.json.agent.counts).toEqual({ sale: 65, rent: 0, soldOrLet12m: 0 });
  });

  it('answers 404 for an agent that does not exist', async () => {
    expect((await client().get(`/api/agents/${UNKNOWN}`)).status).toBe(404);
    const bad = await client().get('/api/agents/not-an-id');
    expect(bad.status).toBe(404);
    expect(bad.json.error.code).toBe('not_found');
    expect((await client().post(`/api/agents/${UNKNOWN}/valuation-requests`, REQUEST)).status).toBe(404);
    expect((await client().post('/api/agents/not-an-id/valuation-requests', REQUEST)).status).toBe(404);
  });

  it('is in the sitemap once the agent has a live listing', async () => {
    const withStock = await agency('Stocked Estates');
    await withStock.mk({ title: 'On the market today', addressLine: '1 Market Road' });
    const empty = await agency('No Stock Yet');
    await empty.mk({ title: 'Still a draft, not public', addressLine: '2 Draft Road' }, null);
    const r = await client().get('/sitemap.xml');
    const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(config.publicUrl, ''));
    expect(locs).toContain(`/agent/${withStock.orgId}`);
    expect(locs).not.toContain(`/agent/${empty.orgId}`);
    expect(locs.filter((l) => l === `/agent/${withStock.orgId}`)).toHaveLength(1);
    expect(r.body).toMatch(new RegExp(`/agent/${withStock.orgId}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
  });
});

describe('an agency’s profile', () => {
  const PROFILE = {
    phone: '020 7946 0123', leadsEmail: 'leads@leavalleyhomes.example', website: 'https://www.leavalleyhomes.example', address: '12 High Street, London E17 7AA',
    about: 'Independent sales and lettings agent in Walthamstow since 1998.\n\nOpen six days a week.', clientMoneyScheme: 'Client Money Protect',
    redressNumber: 'T01234', feesUrl: 'https://www.leavalleyhomes.example/fees',
  };
  const stored = (orgId: string) => one<Record<string, string | null>>('SELECT phone, leads_email, website, about, address, client_money_scheme, redress_number, fees_url FROM organisations WHERE id = $1', [orgId]);

  it('is saved by the people who run the agency and shown on its page, except the leads email', async () => {
    const { agent, orgId, mk } = await agency();
    const listing = await mk({ title: 'Terrace listed by the agency', addressLine: '1 Agency Road' });
    const saved = await agent.c.patch(`/api/orgs/${orgId}`, PROFILE);
    expect(saved.status).toBe(200);
    expect(saved.json.org).toEqual({
      id: orgId, name: 'Lea Valley Homes', kind: 'agency', verified: false, redressScheme: 'The Property Ombudsman', role: 'owner',
      ...PROFILE, website: 'https://www.leavalleyhomes.example/', // as a browser writes it
    });

    // its members see all of it, the leads email included: an admin, and a negotiator who cannot change it
    const manager = await signUp({ accountType: 'agent', name: 'Branch Manager' });
    const negotiator = await signUp({ accountType: 'agent', name: 'Negotiator' });
    await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, manager.user.id, negotiator.user.id]);
    expect((await agent.c.get('/api/me/orgs')).json.items).toEqual([saved.json.org]);
    expect((await manager.c.get('/api/me/orgs')).json.items).toEqual([{ ...saved.json.org, role: 'admin' }]);
    expect((await negotiator.c.get('/api/me/orgs')).json.items).toEqual([{ ...saved.json.org, role: 'member' }]);

    // the public page has everything except the leads email, for anyone, signed in or not, even the agency itself
    for (const c of [client(), agent.c, negotiator.c]) {
      const page = await c.get(`/api/agents/${orgId}`);
      expect(page.status).toBe(200);
      expect(page.json.agent).toMatchObject({
        phone: '020 7946 0123', website: 'https://www.leavalleyhomes.example/', address: '12 High Street, London E17 7AA', about: PROFILE.about,
        clientMoneyScheme: 'Client Money Protect', redressScheme: 'The Property Ombudsman', redressNumber: 'T01234', feesUrl: 'https://www.leavalleyhomes.example/fees',
      });
      expect(Object.keys(page.json.agent)).not.toContain('leadsEmail');
      expect(page.body).not.toContain('leads@leavalleyhomes.example');
      expect(page.body).not.toMatch(/leads_?email/i);
    }

    // the agency's listings carry its phone number everywhere they are shown; a private seller's never carry one
    const seller = await signUp({ accountType: 'owner' });
    await seller.c.patch('/api/me', { phone: '07700 900999' });
    const own = (await seller.c.post('/api/listings', { ...LISTING, title: 'A private seller’s home', addressLine: '9 Other Road' })).json.listing.ref as string;
    await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [own]);
    const search = (await client().get('/api/listings?pageSize=200')).json.items as { ref: string; agentPhone: string | null }[];
    expect(search.find((l) => l.ref === listing.ref)!.agentPhone).toBe('020 7946 0123');
    expect(search.find((l) => l.ref === own)!.agentPhone).toBeNull();
    expect((await client().get(`/api/listings/${listing.ref}`)).json.listing.agentPhone).toBe('020 7946 0123');
    expect((await client().get(`/api/listings/${own}`)).json.listing.agentPhone).toBeNull();
    expect((await client().get(`/api/agents/${orgId}`)).json.listings[0].agentPhone).toBe('020 7946 0123');
    expect((await agent.c.get('/api/me/listings')).json.items[0].agentPhone).toBe('020 7946 0123');
    expect(JSON.stringify(search)).not.toContain('07700 900999');
  });

  it('changes only the boxes that were sent, and clears one that is sent empty', async () => {
    const { agent, orgId } = await agency();
    expect((await agent.c.patch(`/api/orgs/${orgId}`, PROFILE)).status).toBe(200);
    const phoneOnly = await agent.c.patch(`/api/orgs/${orgId}`, { phone: ' +44 (0)20 7946 0999 ' });
    expect(phoneOnly.json.org).toMatchObject({ ...PROFILE, website: 'https://www.leavalleyhomes.example/', phone: '+44 (0)20 7946 0999' });
    const cleared = await agent.c.patch(`/api/orgs/${orgId}`, { leadsEmail: '', feesUrl: null, about: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.json.org).toMatchObject({ leadsEmail: null, feesUrl: null, about: null, phone: '+44 (0)20 7946 0999', clientMoneyScheme: 'Client Money Protect' });
    expect(await stored(orgId)).toMatchObject({ leads_email: null, fees_url: null, about: null, phone: '+44 (0)20 7946 0999', website: 'https://www.leavalleyhomes.example/' });
    // nothing sent: nothing changes
    expect((await agent.c.patch(`/api/orgs/${orgId}`, {})).json.org.phone).toBe('+44 (0)20 7946 0999');
    // the name, the redress scheme and "verified" are not part of the profile: sending them changes nothing
    const sneaky = await agent.c.patch(`/api/orgs/${orgId}`, { name: 'Another Name', verified: true, redressScheme: 'None', redress_scheme: 'None', kind: 'landlord' });
    expect(sneaky.status).toBe(200);
    expect(sneaky.json.org).toMatchObject({ name: 'Lea Valley Homes', verified: false, redressScheme: 'The Property Ombudsman', kind: 'agency' });
    // text is tidied: one line for an address or a scheme, plain paragraphs for the description
    const tidy = await agent.c.patch(`/api/orgs/${orgId}`, { address: ' 12 High Street,\n London   E17 7AA ', clientMoneyScheme: 'Money\tShield', about: 'First line.\r\n\r\n\r\n\r\nSecond   line.' });
    expect(tidy.json.org).toMatchObject({ address: '12 High Street, London E17 7AA', clientMoneyScheme: 'Money Shield', about: 'First line.\n\nSecond line.' });
  });

  it('checks every box before anything is saved', async () => {
    const { agent, orgId } = await agency();
    expect((await agent.c.patch(`/api/orgs/${orgId}`, PROFILE)).status).toBe(200);
    const before = await stored(orgId);
    const bad = await agent.c.patch(`/api/orgs/${orgId}`, {
      phone: 'call the office', leadsEmail: 'not-an-email', website: 'http://www.leavalleyhomes.example', feesUrl: 'www.leavalleyhomes.example/fees',
      about: 'x'.repeat(601), address: 'y'.repeat(201), clientMoneyScheme: 'z'.repeat(121), redressNumber: 'T<01234>',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid');
    expect(Object.keys(bad.json.error.fields).sort()).toEqual(['about', 'address', 'clientMoneyScheme', 'feesUrl', 'leadsEmail', 'phone', 'redressNumber', 'website']);
    expect(bad.json.error.fields.phone).toBe('Use digits, spaces and + ( ) - only.');
    expect(bad.json.error.fields.website).toBe('Enter a full web address that starts with https://, for example https://www.example.co.uk.');
    expect(await stored(orgId)).toEqual(before);

    const refused = async (body: Record<string, unknown>) => {
      const r = await agent.c.patch(`/api/orgs/${orgId}`, { phone: '020 7946 0555', ...body }); // one good box with the bad one: neither is saved
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(Object.keys(r.json.error.fields)).toEqual(Object.keys(body));
    };
    // a web address must be https, on an ordinary host name, with nothing else hidden in it
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'ftp://example.co.uk', '//example.co.uk', 'https://', 'https://localhost', 'https://192.168.0.1/fees',
      'https://user:secret@example.co.uk', 'https://example.co.uk:8443/fees', 'https://example.co.uk/a b', 'https://example.co.uk/"><script>', `https://example.co.uk/${'a'.repeat(300)}`]) {
      await refused({ website: url });
      await refused({ feesUrl: url });
    }
    // a phone number is digits, spaces and + ( ) - only, and long enough to be one
    for (const phone of ['020 7946 0123 ext. 4', '0800-FLOWERS', '12345', '()', '+', '0'.repeat(16), '<b>020 7946 0123</b>']) await refused({ phone });
    await refused({ leadsEmail: 'leads@' });
    await refused({ leadsEmail: 'leads@example.com\nbcc: other@example.com' });
    await refused({ about: 'We are <b>the best</b> agent in town.' });
    await refused({ about: '<script>alert(1)</script>' });
    await refused({ redressNumber: 'x'.repeat(41) });
    await refused({ website: 12345 });
    expect(await stored(orgId)).toEqual(before);
    // an international name is kept as a browser writes it
    expect((await agent.c.patch(`/api/orgs/${orgId}`, { website: 'https://xn--bcher-kva.example/über-uns?ref=streetkey' })).json.org.website).toBe('https://xn--bcher-kva.example/%C3%BCber-uns?ref=streetkey');
  });

  it('can be changed only by the agency’s owners and admins', async () => {
    const { orgId } = await agency();
    const manager = await signUp({ accountType: 'agent' });
    const negotiator = await signUp({ accountType: 'agent' });
    await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, manager.user.id, negotiator.user.id]);
    const url = `/api/orgs/${orgId}`;
    expect((await client().patch(url, PROFILE)).status).toBe(401);
    const stranger = await signUp();
    expect((await stranger.c.patch(url, PROFILE)).status).toBe(404); // as if it did not exist
    expect((await stranger.c.patch('/api/orgs/not-an-id', PROFILE)).status).toBe(404);
    expect((await stranger.c.patch(`/api/orgs/${UNKNOWN}`, PROFILE)).status).toBe(404);
    const rival = await agency('Rival Estates');
    expect((await rival.agent.c.patch(url, PROFILE)).status).toBe(404);
    expect((await negotiator.c.patch(url, PROFILE)).status).toBe(403); // a member who does not run the agency
    expect((await negotiator.c.patch(url, { phone: 'not checked before the refusal' })).status).toBe(403);
    const staff = await signUp();
    await makeAdmin(staff.email);
    expect((await staff.c.patch(url, PROFILE)).status).toBe(404); // Streetkey's own staff do not write an agency's page for it
    expect(await stored(orgId)).toEqual({ phone: null, leads_email: null, website: null, about: null, address: null, client_money_scheme: null, redress_number: null, fees_url: null });
    expect((await stored(rival.orgId))!.phone).toBeNull();
    // an admin of the agency can
    const ok = await manager.c.patch(url, { phone: PROFILE.phone });
    expect(ok.status).toBe(200);
    expect(ok.json.org).toMatchObject({ phone: '020 7946 0123', role: 'admin' });
    // what changed is in the audit trail by name only, never what was typed
    await manager.c.patch(url, { leadsEmail: PROFILE.leadsEmail });
    const trail = await q<{ detail: { fields: string[] } }>(`SELECT detail FROM audit_log WHERE action = 'org.profile_updated' AND subject = $1 ORDER BY id`, [`org:${orgId}`]);
    expect(trail.map((t) => t.detail)).toEqual([{ fields: ['phone'] }, { fields: ['leads_email'] }]);
  });
});

describe('booking a valuation', () => {
  it('checks the details before anything is stored or sent', async () => {
    const { orgId } = await agency();
    const before = outbox.length;
    const bad = await client().post(`/api/agents/${orgId}/valuation-requests`, { name: ' ', email: 'not-an-email', postcode: 'somewhere in London', intent: 'buy', phone: 'call me', message: 'x'.repeat(1001) });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid');
    expect(Object.keys(bad.json.error.fields).sort()).toEqual(['email', 'intent', 'message', 'name', 'phone', 'postcode']);
    expect(bad.json.error.fields.postcode).toBe('Enter a full UK postcode, for example E17 4QH.');
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, {})).status).toBe(400);
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, postcode: 'E17' })).status).toBe(400); // half a postcode
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, propertyType: 'castle' })).status).toBe(400);
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, beds: 99 })).status).toBe(400);
    expect(await requestsFor(orgId)).toHaveLength(0);
    expect(valuationMails(before)).toHaveLength(0);
  });

  it('stores the request and emails the people who run the agency', async () => {
    const { agent, orgId } = await agency();
    const admin = await signUp({ accountType: 'agent', name: 'Branch Manager' });
    const negotiator = await signUp({ accountType: 'agent', name: 'Negotiator' });
    await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin.user.id, negotiator.user.id]);
    const before = outbox.length;

    const r = await client().post(`/api/agents/${orgId}/valuation-requests`, {
      name: '  Sam \n Seller ', email: 'sam.seller@example.com', phone: '07700 900123', postcode: 'e174qh', addressLine: '14 Elm Road', intent: 'sell',
      propertyType: 'terraced', beds: 3, message: 'Thinking of selling in the spring.', website: '',
    });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ ok: true });

    const rows = await requestsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Sam Seller', email: 'sam.seller@example.com', phone: '07700 900123', postcode: 'E17 4QH', address_line: '14 Elm Road', intent: 'sell',
      property_type: 'terraced', beds: 3, message: 'Thinking of selling in the spring.', status: 'new', user_id: null,
    });

    // owners and admins are emailed; an ordinary member is not
    const sent = valuationMails(before);
    expect(sent.map((m) => m.to).sort()).toEqual([agent.email, admin.email].sort());
    const mail = sent[0];
    expect(mail.subject).toBe('New valuation request for Lea Valley Homes');
    expect(mail.replyTo).toBe('sam.seller@example.com'); // answering the email reaches the person who asked
    for (const part of ['Sam Seller', 'sam.seller@example.com', '07700 900123', 'E17 4QH', '14 Elm Road', '3 bed terraced', 'sell the property', 'Thinking of selling in the spring.']) expect(mail.text).toContain(part);
    expect(mail.text).toContain(`${config.publicUrl}/account`);
    expect(mail.subject).not.toContain('Sam'); // the person's details stay out of the subject line
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM emails WHERE template = 'valuation_request' AND to_address = $1`, [agent.email]))!.n).toBe(1);
  });

  it('needs only a name, an email, a postcode and whether to sell or let, and links the request to a signed-in person', async () => {
    const { orgId } = await agency();
    const owner = await signUp({ name: 'Lena Landlord' });
    const r = await owner.c.post(`/api/agents/${orgId}/valuation-requests`, { name: 'Lena Landlord', email: owner.email, postcode: 'LS6 2AB', intent: 'let', phone: '', message: '' });
    expect(r.status).toBe(201);
    const [row] = await requestsFor(orgId);
    expect(row).toMatchObject({ name: 'Lena Landlord', postcode: 'LS6 2AB', intent: 'let', phone: null, address_line: null, property_type: null, beds: null, message: null, user_id: owner.user.id });
  });

  it('never keeps anything about the person’s money', async () => {
    const { orgId } = await agency();
    const r = await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, budget: 650000, funds: 'cash', mortgageAgreed: true, income: 82000, deposit: 90000 });
    expect(r.status).toBe(201);
    const [row] = await requestsFor(orgId);
    expect(Object.keys(row).sort()).toEqual(['address_line', 'beds', 'created_at', 'email', 'id', 'intent', 'message', 'name', 'organisation_id', 'phone', 'postcode', 'property_type', 'status', 'user_id']);
    expect(JSON.stringify(row)).not.toMatch(/650000|cash|82000|90000/);
  });

  it('accepts a form filled in by a script without keeping or sending anything', async () => {
    const { orgId } = await agency();
    const before = outbox.length;
    const bot = await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, website: 'https://spam.example' });
    expect(bot.status).toBe(201);
    expect(bot.json).toEqual({ ok: true }); // looks the same as a real one
    const junk = await client().post(`/api/agents/${orgId}/valuation-requests`, { name: 'x', website: 'buy pills' });
    expect(junk.status).toBe(201);
    expect(await requestsFor(orgId)).toHaveLength(0);
    expect(valuationMails(before)).toHaveLength(0);
  });

  it('stops the same email address asking one agent again and again', async () => {
    const { orgId } = await agency();
    const other = await agency('Another Agency');
    for (let i = 0; i < 3; i++) expect((await client().post(`/api/agents/${orgId}/valuation-requests`, REQUEST)).status).toBe(201);
    const fourth = await client().post(`/api/agents/${orgId}/valuation-requests`, REQUEST);
    expect(fourth.status).toBe(429);
    expect(fourth.json.error.code).toBe('rate_limited');
    expect(await requestsFor(orgId)).toHaveLength(3);
    // a different agent is a different matter
    expect((await client().post(`/api/agents/${other.orgId}/valuation-requests`, REQUEST)).status).toBe(201);
  });

  it('limits how many requests one network can send in a minute', async () => {
    const { orgId } = await agency();
    const prev = limits.multiplier;
    await q(`DELETE FROM rate_limits WHERE key LIKE 'valuation.create%'`); // earlier tests sent theirs in the same minute
    limits.multiplier = 1; // real limits for this test
    try {
      // 5 a minute. Eleven are sent so that one is refused even if the minute turns over part-way through.
      const answers = [];
      for (let i = 0; i < 11; i++) answers.push(await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, email: `visitor${i}@example.com` }));
      expect(answers[0].status).toBe(201);
      const refused = answers.find((a) => a.status === 429);
      expect(refused?.json.error.code).toBe('rate_limited');
      expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0);
      expect(answers.every((a) => a.status === 201 || a.status === 429)).toBe(true);
      expect(await requestsFor(orgId)).toHaveLength(answers.filter((a) => a.status === 201).length); // a refused request is not stored
    } finally { limits.multiplier = prev; }
  });
});

describe('an agency’s valuation requests', () => {
  async function withRequests() {
    const a = await agency();
    expect((await client().post(`/api/agents/${a.orgId}/valuation-requests`, { ...REQUEST, addressLine: '14 Elm Road', propertyType: 'terraced', beds: 3 })).status).toBe(201);
    expect((await client().post(`/api/agents/${a.orgId}/valuation-requests`, { name: 'Lena Landlord', email: 'lena@example.com', postcode: 'LS6 2AB', intent: 'let' })).status).toBe(201);
    await q(`UPDATE valuation_requests SET created_at = now() - interval '2 days' WHERE organisation_id = $1 AND email = $2`, [a.orgId, REQUEST.email]);
    return a;
  }

  it('lists them for the agency, newest first', async () => {
    const { agent, orgId } = await withRequests();
    const r = await agent.c.get(`/api/orgs/${orgId}/valuation-requests`);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(2);
    expect(r.json.items[0]).toMatchObject({ name: 'Lena Landlord', email: 'lena@example.com', phone: null, postcode: 'LS6 2AB', addressLine: null, intent: 'let', propertyType: null, beds: null, message: null, status: 'new' });
    expect(r.json.items[1]).toMatchObject({ name: 'Sam Seller', email: REQUEST.email, phone: '07700 900123', postcode: 'E17 4QH', addressLine: '14 Elm Road', intent: 'sell', propertyType: 'terraced', beds: 3, message: REQUEST.message, status: 'new' });
    expect(Object.keys(r.json.items[0]).sort()).toEqual(['addressLine', 'beds', 'createdAt', 'email', 'id', 'intent', 'message', 'name', 'phone', 'postcode', 'propertyType', 'status']);
    expect(Date.parse(r.json.items[0].createdAt)).toBeGreaterThan(Date.parse(r.json.items[1].createdAt));
  });

  it('lets the agency mark a request contacted or closed', async () => {
    const { agent, orgId } = await withRequests();
    const [first] = (await agent.c.get(`/api/orgs/${orgId}/valuation-requests`)).json.items;
    const done = await agent.c.patch(`/api/orgs/${orgId}/valuation-requests/${first.id}`, { status: 'contacted' });
    expect(done.status).toBe(200);
    expect(done.json.request).toEqual({ ...first, status: 'contacted' });
    expect((await agent.c.patch(`/api/orgs/${orgId}/valuation-requests/${first.id}`, { status: 'closed' })).json.request.status).toBe('closed');
    expect((await agent.c.get(`/api/orgs/${orgId}/valuation-requests`)).json.items.map((i: { status: string }) => i.status)).toEqual(['closed', 'new']);
    const bad = await agent.c.patch(`/api/orgs/${orgId}/valuation-requests/${first.id}`, { status: 'won' });
    expect(bad.status).toBe(400);
    expect((await agent.c.patch(`/api/orgs/${orgId}/valuation-requests/${UNKNOWN}`, { status: 'closed' })).status).toBe(404);
    expect((await agent.c.patch(`/api/orgs/${orgId}/valuation-requests/not-an-id`, { status: 'closed' })).status).toBe(404);
  });

  it('is for the people who run the agency only', async () => {
    const { orgId } = await withRequests();
    const [first] = await requestsFor(orgId);
    const list = `/api/orgs/${orgId}/valuation-requests`, item = `${list}/${first.id}`;
    // not signed in
    expect((await client().get(list)).status).toBe(401);
    expect((await client().patch(item, { status: 'closed' })).status).toBe(401);
    // someone with nothing to do with the agency: it is as if it did not exist
    const stranger = await signUp();
    expect((await stranger.c.get(list)).status).toBe(404);
    expect((await stranger.c.patch(item, { status: 'closed' })).status).toBe(404);
    expect((await stranger.c.get('/api/orgs/not-an-id/valuation-requests')).status).toBe(404);
    // another agency cannot reach it through its own address either
    const rival = await agency('Rival Estates');
    expect((await rival.agent.c.get(list)).status).toBe(404);
    expect((await rival.agent.c.patch(`/api/orgs/${rival.orgId}/valuation-requests/${first.id}`, { status: 'closed' })).status).toBe(404);
    expect((await rival.agent.c.get(`/api/orgs/${rival.orgId}/valuation-requests`)).json.items).toEqual([]);
    // a member who does not run the agency is refused
    const negotiator = await signUp({ accountType: 'agent' });
    await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, negotiator.user.id]);
    expect((await negotiator.c.get(list)).status).toBe(403);
    expect((await negotiator.c.patch(item, { status: 'closed' })).status).toBe(403);
    expect((await one<{ status: string }>('SELECT status FROM valuation_requests WHERE id = $1', [first.id]))!.status).toBe('new'); // nothing changed
    // Streetkey's own staff cannot read them either: the person was told the request goes only to the agent they chose
    const staff = await signUp();
    await makeAdmin(staff.email);
    expect((await staff.c.get(list)).status).toBe(404);
    expect((await staff.c.patch(item, { status: 'closed' })).status).toBe(404);
    // and only an estate or letting agency takes valuation requests
    const landlord = await signUp({ accountType: 'landlord' });
    const estate = await landlord.c.post('/api/orgs', { name: 'Harbour Lettings Ltd', kind: 'landlord' });
    expect(estate.status).toBe(201);
    expect((await client().post(`/api/agents/${estate.json.id}/valuation-requests`, REQUEST)).status).toBe(404);
  });
});

describe('valuation requests and data protection', () => {
  it('are in the person’s data export and go when they delete their account', async () => {
    const { orgId } = await agency();
    const person = await signUp({ name: 'Sam Seller' });
    expect((await person.c.post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, email: person.email })).status).toBe(201);
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, email: 'someone.else@example.com' })).status).toBe(201); // not theirs

    const data = await person.c.get('/api/me/export');
    expect(data.status).toBe(200);
    expect(data.json.valuationRequests).toHaveLength(1);
    expect(data.json.valuationRequests[0]).toMatchObject({ agent: 'Lea Valley Homes', intent: 'sell', name: 'Sam Seller', email: person.email, postcode: 'E17 4QH', message: REQUEST.message, status: 'new' });

    expect((await person.c.del('/api/me', { password: PASSWORD })).status).toBe(200);
    const left = await requestsFor(orgId);
    expect(left.map((r) => r.email)).toEqual(['someone.else@example.com']);
  });

  it('are deleted by the daily clean-up after 12 months', async () => {
    const { orgId } = await agency();
    for (const email of ['old@example.com', 'recent@example.com']) expect((await client().post(`/api/agents/${orgId}/valuation-requests`, { ...REQUEST, email })).status).toBe(201);
    await q(`UPDATE valuation_requests SET created_at = now() - interval '12 months 1 day', status = 'contacted' WHERE email = 'old@example.com'`);
    await q(`UPDATE valuation_requests SET created_at = now() - interval '11 months' WHERE email = 'recent@example.com'`);
    const out = await runCleanup();
    expect(out).toMatchObject({ valuationRequests: 1 });
    expect((await requestsFor(orgId)).map((r) => r.email)).toEqual(['recent@example.com']);
  });

  it('go with the agency if it is removed', async () => {
    const { orgId } = await agency();
    expect((await client().post(`/api/agents/${orgId}/valuation-requests`, REQUEST)).status).toBe(201);
    await q('DELETE FROM organisations WHERE id = $1', [orgId]);
    expect((await one<{ n: number }>('SELECT count(*)::int n FROM valuation_requests WHERE organisation_id = $1', [orgId]))!.n).toBe(0);
  });
});
