/** An agency's results report: what each listing brought in, exact counts, members only, and the spreadsheet. */
import { describe, expect, it } from 'vitest';
import { one, q } from '../src/db';
import { client, LISTING, signUp } from './helpers';

async function agency() {
  const agent = await signUp({ accountType: 'agent', name: 'Agent' });
  const org = await agent.c.post('/api/orgs', { name: 'Lea Valley Homes', kind: 'agency', redressScheme: 'The Property Ombudsman' });
  expect(org.status).toBe(201);
  const orgId = org.json.id as string;
  const mk = async (over: Record<string, unknown>) => {
    const ref = (await agent.c.post('/api/listings', { ...LISTING, ...over })).json.listing.ref as string;
    await q(`UPDATE listings SET organisation_id = $2 WHERE ref = $1`, [ref, orgId]);
    return ref;
  };
  return { agent, orgId, mk };
}
const idOf = async (ref: string) => (await one<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [ref]))!.id;

describe('agency results report', () => {
  it('counts views, visitors, saves, enquiries and viewing requests per listing over the period', async () => {
    const { agent, orgId, mk } = await agency();
    const busy = await mk({ title: 'Busy terrace near the station', addressLine: '1 Busy Road' });
    const quiet = await mk({ title: 'Quiet flat, no enquiries yet', addressLine: '2 Quiet Road', channel: 'rent', price: 1500 });
    const draft = await mk({ title: 'Unpublished draft, never shown', addressLine: '3 Draft Road' });
    await q(`UPDATE listings SET status = 'live', published_at = now() - interval '12 days' WHERE ref = ANY($1)`, [[busy, quiet]]);
    const [busyId, quietId] = [await idOf(busy), await idOf(quiet)];
    // 3 views from 2 visitors in the period, 1 old view outside it, 1 view on the quiet one
    await q(`INSERT INTO engagement_events (listing_id, session_id, name, occurred_at) VALUES
      ($1, 's1', 'listing_view', now() - interval '1 day'), ($1, 's1', 'listing_view', now() - interval '2 days'), ($1, 's2', 'listing_view', now() - interval '3 days'),
      ($1, 's3', 'listing_view', now() - interval '60 days'), ($1, 's1', 'photo_open', now()), ($2, 's9', 'listing_view', now())`, [busyId, quietId]);
    const buyer = await signUp();
    await q(`INSERT INTO saved_listings (user_id, listing_key) VALUES ($1, $2)`, [buyer.user.id, busy]);
    await q(`INSERT INTO enquiries (listing_id, name, email, kind, filtered, created_at) VALUES
      ($1, 'A', 'a@example.com', 'viewing', false, now()), ($1, 'B', 'b@example.com', 'question', false, now()),
      ($1, 'Spam', 's@example.com', 'question', true, now()), ($1, 'Old', 'o@example.com', 'viewing', false, now() - interval '70 days')`, [busyId]);

    const r = await agent.c.get(`/api/orgs/${orgId}/report`);
    expect(r.status).toBe(200);
    expect(r.json.days).toBe(30);
    expect(r.json.items.map((i: { ref: string }) => i.ref)).toEqual([busy, quiet]); // most enquiries first; the draft is not there
    expect(r.json.items.map((i: { ref: string }) => i.ref)).not.toContain(draft);
    expect(r.json.items[0]).toMatchObject({ ref: busy, views: 3, visitors: 2, saves: 1, enquiries: 2, viewings: 1, daysOnMarket: 12, channel: 'sale' });
    expect(r.json.items[1]).toMatchObject({ ref: quiet, views: 1, visitors: 1, saves: 0, enquiries: 0, viewings: 0, channel: 'rent' });
    expect(r.json.totals).toEqual({ listings: 2, views: 4, visitors: 3, saves: 1, enquiries: 2, viewings: 1 });

    // a longer period picks up the older view and enquiry
    const long = await agent.c.get(`/api/orgs/${orgId}/report?days=90`);
    expect(long.json.items[0]).toMatchObject({ views: 4, enquiries: 3, viewings: 2 });
  });

  it('is for the agency only', async () => {
    const { orgId } = await agency();
    expect((await client().get(`/api/orgs/${orgId}/report`)).status).toBe(401);
    const stranger = await signUp();
    expect((await stranger.c.get(`/api/orgs/${orgId}/report`)).status).toBe(404);
    expect((await stranger.c.get('/api/orgs/not-an-id/report')).status).toBe(404);
  });

  it('downloads as a spreadsheet that cannot run formulas', async () => {
    const { agent, orgId, mk } = await agency();
    const ref = await mk({ title: '=HYPERLINK("http://evil.example","Click"), 2 bed', addressLine: '4 Sheet Road' });
    await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [ref]);
    const r = await agent.c.get(`/api/orgs/${orgId}/report?format=csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="streetkey-results-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Reference,Title,Town,Postcode,For,Status,Price,Days on the market,Views (30 days),Visitors (30 days),Saves,Enquiries (30 days),Viewing requests (30 days)');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${ref},"'=HYPERLINK(""http://evil.example"",""Click""), 2 bed",London,E17 4QH,For sale,live,525000,0,0,0,0,0,0`);
  });
});
