/**
 * Views and calls: every visit to a listing page is counted, for everyone, without recording who viewed.
 * Not the listing's own people, not robots, not the same visitor again within half an hour; and counting
 * never gets in the way of the page.
 */
import { describe, expect, it } from 'vitest';
import { one, q } from '../src/db';
import { runCleanup } from '../src/jobs/run';
import { isRobot } from '../src/services/views';
import { client, LISTING, makeAdmin, signUp } from './helpers';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ROBOTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'Mozilla/5.0 (compatible; Baiduspider/2.0)', 'ExampleCrawler/1.0', 'Slackbot-LinkExpanding 1.0',
  'Mozilla/5.0 (Macintosh) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  'Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/) link preview', 'Site24x7 Monitoring', '',
];

/** A browser: its own user agent on every request (a visitor who isn't signed in is told apart by network and browser). */
const browser = (userAgent: string, c = client()) => ({
  get: (u: string) => c.get(u, { 'user-agent': userAgent }),
  post: (u: string) => c.post(u, undefined, { 'user-agent': userAgent }),
});
const today = (id: string) => one<{ views: number; calls: number }>('SELECT views, calls FROM listing_views WHERE listing_id = $1 AND day = current_date', [id]);
const views = async (id: string) => (await today(id))?.views ?? 0;
const calls = async (id: string) => (await today(id))?.calls ?? 0;
/** Half an hour passes: the markers that stop a visitor being counted twice are moved back. */
const halfAnHourLater = () => q(`UPDATE rate_limits SET window_start = window_start - interval '31 minutes' WHERE key LIKE 'view:%'`);

async function privateListing(over: Record<string, unknown> = {}) {
  const seller = await signUp({ accountType: 'owner' });
  const ref = (await seller.c.post('/api/listings', { ...LISTING, ...over })).json.listing.ref as string;
  const { id } = (await q<{ id: string }>(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1 RETURNING id`, [ref]))[0];
  return { seller, ref, id };
}
async function agencyListing(phone: string | null = '020 7946 0123') {
  const agent = await signUp({ accountType: 'agent', name: 'Agent' });
  const orgId = (await agent.c.post('/api/orgs', { name: 'Lea Valley Homes', kind: 'agency' })).json.id as string;
  if (phone) expect((await agent.c.patch(`/api/orgs/${orgId}`, { phone })).status).toBe(200);
  const colleague = await signUp({ accountType: 'agent', name: 'Colleague' });
  await q(`INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, colleague.user.id]);
  const ref = (await agent.c.post('/api/listings', { ...LISTING, title: 'Flat listed by the agency', addressLine: '5 Agency Road' })).json.listing.ref as string;
  const { id } = (await q<{ id: string }>(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1 RETURNING id`, [ref]))[0];
  return { agent, colleague, orgId, ref, id };
}

describe('counting views of a listing', () => {
  it('counts each visitor once in half an hour, whoever they are', async () => {
    const { ref, id } = await privateListing();
    const first = browser(CHROME), second = browser(SAFARI);
    expect(await views(id)).toBe(0);
    expect((await first.get(`/api/listings/${ref}`)).status).toBe(200);
    expect(await views(id)).toBe(1);
    // the same visitor again: reloading the page, or coming back a few minutes later
    await first.get(`/api/listings/${ref}`);
    await first.get(`/api/listings/${ref}`);
    expect(await views(id)).toBe(1);
    // someone else on the same network, in another browser
    await second.get(`/api/listings/${ref}`);
    expect(await views(id)).toBe(2);
    // someone signed in is counted by their account, once
    const buyer = await signUp();
    await browser(CHROME, buyer.c).get(`/api/listings/${ref}`);
    await browser(SAFARI, buyer.c).get(`/api/listings/${ref}`); // their phone as well as their laptop
    expect(await views(id)).toBe(3);
    // half an hour later the same people count again
    await halfAnHourLater();
    await first.get(`/api/listings/${ref}`);
    await browser(CHROME, buyer.c).get(`/api/listings/${ref}`);
    await first.get(`/api/listings/${ref}`);
    expect(await views(id)).toBe(5);
    // looking at one listing says nothing about another
    const other = await privateListing({ addressLine: '2 Other Road' });
    await first.get(`/api/listings/${other.ref}`);
    expect(await views(other.id)).toBe(1);
    expect(await views(id)).toBe(5);
  });

  it('does not count the lister, their agency or Streetkey’s admins', async () => {
    const own = await privateListing();
    await browser(CHROME, own.seller.c).get(`/api/listings/${own.ref}`);
    expect(await views(own.id)).toBe(0);

    const { agent, colleague, ref, id } = await agencyListing();
    await browser(CHROME, agent.c).get(`/api/listings/${ref}`);
    await browser(SAFARI, colleague.c).get(`/api/listings/${ref}`); // a member of the agency who did not create it
    const admin = await signUp();
    await makeAdmin(admin.email);
    await browser(CHROME, admin.c).get(`/api/listings/${ref}`);
    await browser(CHROME, admin.c).post(`/api/listings/${ref}/view`);
    await browser(CHROME, agent.c).post(`/api/listings/${ref}/view`);
    expect(await today(id)).toBeNull();
    // another agent looking at it is a member of the public here
    const rival = await signUp({ accountType: 'agent' });
    await browser(CHROME, rival.c).get(`/api/listings/${ref}`);
    expect(await views(id)).toBe(1);
  });

  it('does not count robots', async () => {
    const { ref, id } = await privateListing();
    for (const ua of ROBOTS) {
      expect([ua, isRobot(ua)]).toEqual([ua, true]);
      expect((await browser(ua).get(`/api/listings/${ref}`)).status).toBe(200); // they still get the listing
      await browser(ua).post(`/api/listings/${ref}/view`);
    }
    expect(await today(id)).toBeNull();
    for (const ua of [CHROME, SAFARI, 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0']) expect([ua, isRobot(ua)]).toEqual([ua, false]);
    expect(isRobot(undefined)).toBe(true); // a browser always says what it is
  });

  it('counts only listings that are on the market', async () => {
    const { seller, ref, id } = await privateListing();
    await q(`UPDATE listings SET status = 'pending' WHERE id = $1`, [id]);
    expect((await browser(CHROME).get(`/api/listings/${ref}`)).status).toBe(404);
    expect((await browser(CHROME).post(`/api/listings/${ref}/view`)).json).toEqual({ ok: false });
    await q(`UPDATE listings SET status = 'under_offer' WHERE id = $1`, [id]);
    await browser(CHROME).get(`/api/listings/${ref}`);
    expect(await views(id)).toBe(1);
    // sold: the page can still be opened, but it is no longer being marketed
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'sold' })).status).toBe(200);
    expect((await browser(SAFARI).get(`/api/listings/${ref}`)).status).toBe(200);
    expect((await browser(SAFARI).post(`/api/listings/${ref}/view`)).json).toEqual({ ok: false });
    expect(await views(id)).toBe(1);
  });

  it('counts a page that already had the listing, and never the same page view twice', async () => {
    // The website keeps listings it has loaded, so a page opened from search results tells the server itself.
    const { ref, id } = await privateListing();
    const visitor = browser(CHROME);
    const told = await visitor.post(`/api/listings/${ref}/view`);
    expect(told.status).toBe(202);
    expect(told.json).toEqual({ ok: true });
    expect(await views(id)).toBe(1);
    await visitor.get(`/api/listings/${ref}`); // a page that fetched the listing as well
    await visitor.post(`/api/listings/${ref}/view`);
    expect(await views(id)).toBe(1);
    // both at once, as a freshly opened page sends them
    const other = browser(SAFARI);
    await Promise.all([other.get(`/api/listings/${ref}`), other.post(`/api/listings/${ref}/view`), other.post(`/api/listings/${ref}/view`)]);
    expect(await views(id)).toBe(2);
    // a listing that does not exist is answered quietly
    expect((await visitor.post('/api/listings/sk-nothere/view')).json).toEqual({ ok: false });
    expect((await visitor.post(`/api/listings/${'x'.repeat(60)}/view`)).status).toBe(202);
  });

  it('keeps nothing that says who viewed', async () => {
    const { ref, id } = await privateListing();
    const buyer = await signUp();
    await browser(CHROME).get(`/api/listings/${ref}`);
    await browser(CHROME, buyer.c).get(`/api/listings/${ref}`);
    // the count: a listing, a day and two numbers
    const row = (await q<Record<string, unknown>>('SELECT * FROM listing_views WHERE listing_id = $1', [id]))[0];
    expect(Object.keys(row).sort()).toEqual(['calls', 'day', 'listing_id', 'views']);
    expect(row).toMatchObject({ views: 2, calls: 0 });
    // the half-hour markers: a one-way hash, with no network address, account, listing or browser in it
    const markers = (await q<{ key: string }>(`SELECT key FROM rate_limits WHERE key LIKE 'view:%'`)).map((r) => r.key);
    expect(markers.length).toBeGreaterThanOrEqual(2);
    for (const key of markers) {
      expect(key).toMatch(/^view:[0-9a-f]{40}$/);
      for (const personal of ['127.0.0.1', buyer.user.id, id, ref, 'Mozilla']) expect(key).not.toContain(personal);
    }
    // and the clean-up that clears old rate-limit rows clears them too
    await q(`UPDATE rate_limits SET window_start = window_start - interval '3 days' WHERE key LIKE 'view:%'`);
    await runCleanup();
    expect((await q(`SELECT 1 FROM rate_limits WHERE key LIKE 'view:%'`))).toHaveLength(0);
  });

  it('never fails or holds up the listing when the count cannot be written', async () => {
    const { ref } = await privateListing();
    await q('ALTER TABLE listing_views RENAME TO listing_views_away');
    try {
      const r = await browser(CHROME).get(`/api/listings/${ref}`);
      expect(r.status).toBe(200);
      expect(r.json.listing.ref).toBe(ref);
      expect((await browser(CHROME).post(`/api/listings/${ref}/view`)).status).toBe(202);
      expect((await browser(CHROME).post(`/api/listings/${ref}/call`)).status).toBe(202);
    } finally { await q('ALTER TABLE listing_views_away RENAME TO listing_views'); }
  });
});

describe('counting calls', () => {
  it('adds one each time someone taps the agent’s phone number on a listing', async () => {
    const { agent, colleague, ref, id } = await agencyListing();
    expect((await client().get(`/api/listings/${ref}`, { 'user-agent': CHROME })).json.listing.agentPhone).toBe('020 7946 0123');
    const visitor = browser(CHROME);
    const tapped = await visitor.post(`/api/listings/${ref}/call`);
    expect(tapped.status).toBe(202);
    expect(tapped.json).toEqual({ ok: true });
    await visitor.post(`/api/listings/${ref}/call`); // rang off and tried again
    await browser(SAFARI).post(`/api/listings/${ref}/call`);
    expect(await today(id)).toEqual({ views: 1, calls: 3 });
    // the agency's own taps, and robots, are not calls
    await browser(CHROME, agent.c).post(`/api/listings/${ref}/call`);
    await browser(CHROME, colleague.c).post(`/api/listings/${ref}/call`);
    await browser(ROBOTS[0]).post(`/api/listings/${ref}/call`);
    expect(await calls(id)).toBe(3);
  });

  it('has nothing to count where there is no number to tap', async () => {
    const noPhone = await agencyListing(null);
    expect((await browser(CHROME).post(`/api/listings/${noPhone.ref}/call`)).json).toEqual({ ok: false });
    expect(await today(noPhone.id)).toBeNull();
    const own = await privateListing(); // a private seller's number is never shown
    expect((await browser(CHROME).post(`/api/listings/${own.ref}/call`)).json).toEqual({ ok: false });
    const withdrawn = await agencyListing();
    await q(`UPDATE listings SET status = 'withdrawn' WHERE id = $1`, [withdrawn.id]);
    expect((await browser(CHROME).post(`/api/listings/${withdrawn.ref}/call`)).json).toEqual({ ok: false });
    expect((await browser(CHROME).post('/api/listings/sk-nothere/call')).json).toEqual({ ok: false });
    expect(await today(own.id)).toBeNull();
    expect(await today(withdrawn.id)).toBeNull();
  });
});

describe('what the lister sees', () => {
  it('shows the complete views and calls for their listing, day by day', async () => {
    const { agent, ref, id } = await agencyListing();
    await browser(CHROME).get(`/api/listings/${ref}`);
    await browser(SAFARI).get(`/api/listings/${ref}`);
    await browser(SAFARI).post(`/api/listings/${ref}/call`);
    await q(`INSERT INTO listing_views (listing_id, day, views, calls) VALUES ($1, current_date - 3, 7, 2), ($1, current_date - 29, 1, 0), ($1, current_date - 30, 50, 9)`, [id]);
    // one person allowed analytics: their events are still there for the other figures, but views no longer depend on them
    await q(`INSERT INTO engagement_events (listing_id, session_id, name) VALUES ($1, 's1', 'listing_view'), ($1, 's1', 'photo_open')`, [id]);

    const stats = (await agent.c.get(`/api/me/listings/${ref}/stats`)).json;
    expect(stats.days).toHaveLength(30);
    expect(stats.days[29]).toMatchObject({ views: 2, calls: 1, visitors: 1 });
    expect(stats.days[26]).toMatchObject({ views: 7, calls: 2, visitors: 0 });
    expect(stats.days[0]).toMatchObject({ views: 1, calls: 0 });
    expect(stats.totals).toEqual({ listing_view: 10, photo_open: 1 }); // the day 30 days back is outside the period
    expect(stats.calls).toBe(3);
    expect(stats.note).toMatch(/without recording who viewed/);

    const mine = (await agent.c.get('/api/me/listings')).json.items.find((l: { ref: string }) => l.ref === ref);
    expect(mine.stats.views30d).toBe(10);
  });

  it('deletes the daily counts after 13 months', async () => {
    const { id } = await privateListing();
    await q(`INSERT INTO listing_views (listing_id, day, views, calls) VALUES ($1, (current_date - interval '13 months 1 day')::date, 4, 1), ($1, (current_date - interval '12 months')::date, 6, 0), ($1, current_date, 2, 0)`, [id]);
    const out = await runCleanup();
    expect(out).toMatchObject({ listingViews: 1 });
    expect((await q<{ views: number }>('SELECT views FROM listing_views WHERE listing_id = $1 ORDER BY day', [id])).map((r) => r.views)).toEqual([6, 2]);
    // and they go with the listing
    await q('DELETE FROM listings WHERE id = $1', [id]);
    expect((await q('SELECT 1 FROM listing_views WHERE listing_id = $1', [id]))).toHaveLength(0);
  });
});
