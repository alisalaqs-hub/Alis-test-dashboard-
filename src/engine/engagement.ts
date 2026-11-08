/**
 * Brixo Engagement Engine (deterministic analytics).
 *
 * DATA: the engagement figures here are SIMULATED from a seeded generator so
 * the dashboards are reproducible. Nothing is collected from real users in
 * this prototype. In production these aggregates are built from consented,
 * first-party event streams (see docs/02-architecture.md §Engagement).
 *
 * PRINCIPLES enforced in code:
 *  1. Observed facts (counts) are separated from inferences (interpretation)
 *     and from recommendations (suggested actions).
 *  2. Every insight carries its evidence, a sample size and a confidence.
 *  3. Rates use Wilson score intervals; comparisons only claim a difference
 *     when the intervals don't overlap.
 *  4. Segments with fewer than K_ANON unique users are suppressed.
 *  5. Interest ≠ intent: viewing a photo is never treated as purchase intent.
 */
import { PROPERTIES, photosFor, type Property } from '../data/properties';

export const K_ANON = 10;
export const PERIOD_DAYS = 28;
export const PERIOD_END = '2026-11-08';

/* ---------- seeded RNG ---------- */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const poisson = (rnd: () => number, lambda: number) => {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * (rnd() + rnd() + rnd() - 1.5) * 1.4));
  const L = Math.exp(-lambda); let k = 0; let p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
};

/* ---------- types ---------- */
export interface DailyStat { date: string; views: number; unique: number; repeat: number; saves: number; viewingRequests: number; enquiries: number; avgSeconds: number }
export interface PhotoStat { photoId: string; label: string; impressions: number; enlargements: number; revisits: number; avgDwellSec: number }
export interface ListingEngagement {
  listingId: string;
  simulated: true;
  days: DailyStat[];
  photos: PhotoStat[];
  floorplan: { opens: number; avgSeconds: number };
  comparisons: number;
  aiQuestions: { topic: string; count: number; examples: string[] }[];
  refurbSimulations: number;
  designStyles: { style: string; count: number }[];
  budgetBands: { band: string; count: number }[];
  featureInterest: { feature: string; interactions: number }[];
  campaigns: { channel: string; clicks: number; enquiries: number; spend: number }[];
  searchDemand: { query: string; impressions: number }[];
}

/** Story parameters per demo listing, so the dashboards show realistic, varied situations. */
const PROFILES: Record<string, { traffic: number; enquiry: number; viewing: number; trend: number; leadPhotoWeak?: boolean; kitchenInterest?: number }> = {
  'wal-001': { traffic: 86, enquiry: 0.0045, viewing: 0.003, trend: -0.012, leadPhotoWeak: true, kitchenInterest: 2.4 },
  'cro-002': { traffic: 38, enquiry: 0.011, viewing: 0.008, trend: -0.02 },
  'cro-013': { traffic: 44, enquiry: 0.006, viewing: 0.004, trend: -0.025, leadPhotoWeak: true },
  'ley-014': { traffic: 61, enquiry: 0.019, viewing: 0.015, trend: 0.02, kitchenInterest: 1.6 },
  'mcr-003': { traffic: 52, enquiry: 0.016, viewing: 0.011, trend: 0.01 },
  'liv-007': { traffic: 21, enquiry: 0.009, viewing: 0.006, trend: -0.015 },
  'shf-008': { traffic: 33, enquiry: 0.012, viewing: 0.009, trend: 0 },
  'bhm-006': { traffic: 47, enquiry: 0.017, viewing: 0.004, trend: 0.03 },
};

const AI_TOPICS: [string, string[]][] = [
  ['Refurbishment cost', ['What would it cost to renovate?', 'How much for a new kitchen?']],
  ['Value / overpriced?', ['Is this overpriced?', 'What did similar houses sell for?']],
  ['Extension & loft', ['Could I extend this property?', 'Is a loft conversion possible?']],
  ['Rental potential', ['How much could I rent this for?']],
  ['Running costs', ['What are the council tax and energy costs?']],
  ['Damp / condition', ['Is there a damp problem?', 'What are the risks?']],
  ['Commute & schools', ['How long to get into the City?']],
];
const STYLES = ['Modern', 'Contemporary', 'Luxury', 'Scandinavian', 'Minimalist', 'Traditional', 'Industrial', 'Budget rental', 'High-end investment'];

export function engagementFor(p: Property): ListingEngagement {
  const rnd = mulberry32(hash(p.id));
  const prof = PROFILES[p.id] ?? { traffic: 18 + rnd() * 30, enquiry: 0.008 + rnd() * 0.01, viewing: 0.005 + rnd() * 0.007, trend: (rnd() - 0.5) * 0.03 };
  const end = new Date(PERIOD_END);
  const days: DailyStat[] = [];
  for (let d = PERIOD_DAYS - 1; d >= 0; d--) {
    const date = new Date(end.getTime() - d * 86_400_000);
    const k = PERIOD_DAYS - 1 - d;
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.35 : 1;
    const reductionBump = p.priceHistory.some((h) => h.event === 'Reduced') && k > 8 && k < 13 ? 1.5 : 1;
    const lambda = prof.traffic * weekend * reductionBump * Math.max(0.3, 1 + prof.trend * (k - 14));
    const views = poisson(rnd, lambda);
    const unique = Math.round(views * (0.68 + rnd() * 0.08));
    days.push({
      date: date.toISOString().slice(0, 10), views, unique, repeat: views - unique,
      saves: poisson(rnd, views * 0.035), viewingRequests: poisson(rnd, views * prof.viewing),
      enquiries: poisson(rnd, views * prof.enquiry), avgSeconds: Math.round(70 + rnd() * 60),
    });
  }
  const totalViews = days.reduce((s, d) => s + d.views, 0);
  const photos = photosFor(p).map((ph, i) => {
    const impressions = Math.round(totalViews * (i === 0 ? 0.98 : Math.max(0.25, 0.9 - i * 0.11)));
    let appeal = 0.12 + rnd() * 0.14;
    if (i === 0 && prof.leadPhotoWeak) appeal = 0.07;
    if (/garden|balcony/i.test(ph.label)) appeal += 0.12;
    if (/kitchen/i.test(ph.label)) appeal += 0.05 * (prof.kitchenInterest ?? 1);
    const enlargements = Math.round(impressions * appeal);
    return { photoId: ph.id, label: ph.label, impressions, enlargements, revisits: Math.round(enlargements * (0.18 + rnd() * 0.2)), avgDwellSec: Math.round(3 + appeal * 30 + rnd() * 3) };
  });
  const aiQuestions = AI_TOPICS.map(([topic, examples], i) => {
    let c = poisson(rnd, totalViews * 0.012 * (1 - i * 0.1));
    if (topic === 'Refurbishment cost') c = Math.round(c * (prof.kitchenInterest ?? 1.2));
    if (topic === 'Value / overpriced?' && p.daysOnMarket > 40) c = Math.round(c * 1.8);
    return { topic, count: c, examples };
  }).sort((a, b) => b.count - a.count);
  const refurbSimulations = Math.round(totalViews * 0.03 * (prof.kitchenInterest ?? 1));
  const designStyles = STYLES.map((style) => ({ style, count: poisson(rnd, refurbSimulations * (style === 'Modern' || style === 'Contemporary' ? 0.22 : style === 'Scandinavian' ? 0.14 : 0.06)) })).sort((a, b) => b.count - a.count);
  const budgetBands = ['< £10k', '£10–25k', '£25–50k', '£50–100k', '> £100k'].map((band, i) => ({ band, count: poisson(rnd, refurbSimulations * [0.12, 0.3, 0.32, 0.18, 0.08][i]) }));
  const feats = [...p.features, 'Kitchen', p.loftPotential !== 'none' ? 'Loft potential' : 'Storage', 'Commute', 'Schools'];
  const featureInterest = feats.map((f) => ({ feature: f, interactions: Math.round(totalViews * (0.04 + rnd() * 0.12) * (f === 'Kitchen' ? prof.kitchenInterest ?? 1 : 1)) })).sort((a, b) => b.interactions - a.interactions).slice(0, 7);
  const campaigns = [
    { channel: 'Brixo search (organic)', share: 0.55, conv: 1.1, spend: 0 },
    { channel: 'Partner portal syndication', share: 0.25, conv: 0.8, spend: 0 },
    { channel: 'Social campaign', share: 0.12, conv: 0.45, spend: 180 },
    { channel: 'Email to matched buyers', share: 0.08, conv: 2.6, spend: 0 },
  ].map((c) => { const clicks = Math.round(totalViews * c.share); return { channel: c.channel, clicks, enquiries: Math.round(clicks * prof.enquiry * c.conv), spend: c.spend }; });
  const searchDemand = [
    `${p.beds}-bed ${p.type} ${p.district}`, `${p.type} with ${p.loftPotential !== 'none' ? 'loft potential' : 'parking'} ${p.town.split(',')[0]}`,
    `refurbishment opportunity ${p.town.split(',')[0]}`, `homes near ${p.station.name}`,
  ].map((query, i) => ({ query, impressions: Math.round(totalViews * (2.2 - i * 0.4) * (0.8 + rnd() * 0.4)) }));
  return {
    listingId: p.id, simulated: true, days, photos,
    floorplan: { opens: Math.round(totalViews * (0.22 + rnd() * 0.1)), avgSeconds: Math.round(25 + rnd() * 30) },
    comparisons: Math.round(totalViews * (0.03 + rnd() * 0.03)), aiQuestions, refurbSimulations, designStyles, budgetBands, featureInterest, campaigns, searchDemand,
  };
}

/* ---------- statistics ---------- */
export function wilson(successes: number, n: number, z = 1.96) {
  if (n === 0) return { p: 0, low: 0, high: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function totals(e: ListingEngagement, fromDay = 0, toDay = PERIOD_DAYS) {
  const d = e.days.slice(fromDay, toDay);
  const sum = (k: keyof DailyStat) => d.reduce((s, x) => s + (x[k] as number), 0);
  const views = sum('views'); const unique = sum('unique');
  return {
    views, unique, repeat: sum('repeat'), saves: sum('saves'), viewingRequests: sum('viewingRequests'), enquiries: sum('enquiries'),
    avgSeconds: d.length ? Math.round(d.reduce((s, x) => s + x.avgSeconds * x.views, 0) / Math.max(1, views)) : 0,
    enquiryRate: wilson(sum('enquiries') + sum('viewingRequests'), unique),
    saveRate: wilson(sum('saves'), unique),
  };
}

export type Confidence = 'low' | 'medium' | 'high';
export interface Insight {
  id: string;
  kind: 'observed' | 'inferred' | 'recommendation';
  title: string;
  evidence: string[];
  confidence: Confidence;
  caveat?: string;
  action?: { label: string; to: string };
}

const fmt = (n: number) => n.toLocaleString('en-GB');
const pc = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`;

/** Comparable set: same broad area & type where possible, falling back to all sale listings. */
export function comparableSet(p: Property) {
  const sale = PROPERTIES.filter((x) => x.id !== p.id && x.listing !== 'rent' && x.type !== 'commercial' && !x.source);
  const near = sale.filter((x) => x.town.split(',').pop()!.trim() === p.town.split(',').pop()!.trim());
  return near.length >= 2 ? near : sale;
}

export function benchmark(p: Property) {
  const comps = comparableSet(p).map((c) => totals(engagementFor(c)));
  const pooled = comps.reduce((a, c) => ({ s: a.s + c.enquiries + c.viewingRequests, n: a.n + c.unique, v: a.v + c.views }), { s: 0, n: 0, v: 0 });
  return { n: comps.length, rate: wilson(pooled.s, pooled.n), avgViews: comps.length ? pooled.v / comps.length : 0 };
}

export function insightsFor(p: Property): Insight[] {
  const e = engagementFor(p);
  const t = totals(e);
  const recent = totals(e, 21, 28); const prior = totals(e, 14, 21);
  const bm = benchmark(p);
  const out: Insight[] = [];

  out.push({ id: 'reach', kind: 'observed', confidence: 'high', title: `${fmt(t.views)} views from ${fmt(t.unique)} unique visitors in ${PERIOD_DAYS} days`, evidence: [`${fmt(t.repeat)} repeat visits`, `${fmt(t.saves)} saves`, `${t.viewingRequests} viewing requests, ${t.enquiries} enquiries`, `Comparable listings averaged ${fmt(Math.round(bm.avgViews))} views (${bm.n} listings)`] });

  const below = t.enquiryRate.high < bm.rate.low; const above = t.enquiryRate.low > bm.rate.high;
  const rateLine = `Enquiry + viewing conversion ${pc(t.enquiryRate.p)} (95% CI ${pc(t.enquiryRate.low)}–${pc(t.enquiryRate.high)}) vs comparables ${pc(bm.rate.p)} (${pc(bm.rate.low)}–${pc(bm.rate.high)})`;
  if (below) out.push({ id: 'conv-low', kind: 'observed', confidence: t.unique > 800 ? 'high' : 'medium', title: `High interest, low conversion: ${fmt(t.views)} views but only ${t.enquiries + t.viewingRequests} enquiries & viewing requests`, evidence: [rateLine, 'Intervals do not overlap, so the gap is unlikely to be noise.'] });
  else if (above) out.push({ id: 'conv-high', kind: 'observed', confidence: 'medium', title: 'Converting better than comparable listings', evidence: [rateLine] });
  else out.push({ id: 'conv-par', kind: 'observed', confidence: 'low', title: 'Conversion in line with comparable listings', evidence: [rateLine, 'Intervals overlap — no clear difference yet.'] });

  const change = prior.views ? (recent.views - prior.views) / prior.views : 0;
  if (Math.abs(change) > 0.12) out.push({ id: 'trend', kind: 'observed', confidence: Math.min(recent.views, prior.views) > 150 ? 'medium' : 'low', title: `Views ${change > 0 ? 'up' : 'down'} ${pc(Math.abs(change), 0)} week on week`, evidence: [`Last 7 days ${fmt(recent.views)} vs previous 7 days ${fmt(prior.views)}`], caveat: 'Weekly swings are common; watch for a 2–3 week trend before acting.' });

  const ranked = [...e.photos].map((ph) => ({ ...ph, rate: ph.enlargements / Math.max(1, ph.impressions) })).sort((a, b) => b.rate - a.rate);
  const lead = e.photos[0]; const leadRate = lead.enlargements / Math.max(1, lead.impressions);
  out.push({ id: 'photo-top', kind: 'observed', confidence: 'high', title: `“${ranked[0].label}” is the most-engaged photo`, evidence: [`Enlarged by ${pc(ranked[0].rate)} of visitors who saw it vs ${pc(leadRate)} for the lead photo`, `${fmt(ranked[0].revisits)} revisits, average ${ranked[0].avgDwellSec}s dwell`] });
  if (ranked[0].photoId !== lead.photoId && ranked[0].rate > leadRate * 1.6) out.push({ id: 'photo-test', kind: 'recommendation', confidence: 'medium', title: `Test “${ranked[0].label}” as the lead photograph`, evidence: [`Its enlargement rate is ${(ranked[0].rate / leadRate).toFixed(1)}× the current lead photo`], caveat: 'Enlargement shows curiosity, not purchase intent. Run an A/B test for 14 days rather than assuming a lift.', action: { label: 'Set up A/B test', to: '' } });

  const kitchenQs = e.aiQuestions.find((q) => q.topic === 'Refurbishment cost')?.count ?? 0;
  if (e.refurbSimulations > t.unique * 0.025 || kitchenQs > 20) out.push({ id: 'refurb-interest', kind: 'inferred', confidence: 'medium', title: 'Visitors are actively costing a renovation', evidence: [`${fmt(e.refurbSimulations)} refurbishment simulations run`, `${kitchenQs} AI questions about refurbishment cost`, `Most-explored style: ${e.designStyles[0].style}`], caveat: 'Inference: suggests buyers see the property as a project. It may also mean the condition is putting some buyers off.' });
  if (e.refurbSimulations > t.unique * 0.025) out.push({ id: 'add-viz', kind: 'recommendation', confidence: 'medium', title: 'Add an AI renovation visualisation and a costed refurb summary to the listing', evidence: ['Refurbishment interest is above typical levels', 'A clear budget reduces the uncertainty buyers are trying to resolve themselves'], action: { label: 'Open design studio', to: `/studio?property=${p.id}` } });

  const valueQs = e.aiQuestions.find((q) => q.topic === 'Value / overpriced?')?.count ?? 0;
  if (valueQs > 15 && (below || p.daysOnMarket > 45)) out.push({ id: 'price', kind: 'recommendation', confidence: 'low', title: 'Review pricing evidence with your agent', evidence: [`${valueQs} visitors asked the assistant whether the price is fair`, `${p.daysOnMarket} days on market`, below ? 'Conversion below comparables' : 'Conversion not above comparables'], caveat: 'Engagement data alone cannot tell you the right price. Use sold comparables and an agent or RICS valuation.' });

  const fp = e.floorplan.opens / Math.max(1, t.unique);
  out.push({ id: 'floorplan', kind: 'observed', confidence: 'high', title: `${pc(fp, 0)} of unique visitors opened the floor plan`, evidence: [`${fmt(e.floorplan.opens)} opens, average ${e.floorplan.avgSeconds}s`] });
  return out;
}

export function suppress(n: number) { return n < K_ANON ? `<${K_ANON}` : fmt(n); }
