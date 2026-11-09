/**
 * Skill sets for the property, owner, agent and landlord assistants.
 * Each skill composes deterministic engine outputs into an explainable answer.
 */
import type { AiAnswer, Skill } from './assistant';
import { PROPERTIES, type Property } from '../data/properties';
import { dealScore, epcPathway, loftScenario, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { rentalScenario, valuationScenario } from '../engine/valuation';
import { developmentOptions } from '../engine/development';
import { analyse, DEFAULT_INVESTMENT } from '../engine/investment';
import { benchmark, engagementFor, insightsFor, totals, PERIOD_DAYS } from '../engine/engagement';

const k = (n: number) => (Math.abs(n) >= 1_000_000 ? `£${(n / 1e6).toFixed(2)}m` : `£${Math.round(n / 1000)}k`);
const g = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const pc = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`;

/* ================= Property assistant (buyers / investors) ================= */

/**
 * Starter questions about the home on a page (the Ask sheet shows them on property pages).
 * Each one is answered by a skill below too, so they still work with the built-in rules.
 */
export const PROPERTY_STARTS = ['Is this home fairly priced?', 'What could it rent for?', 'What would it cost to refurbish?', 'What are the main risks?'];

export const propertySkills: Skill<Property>[] = [
  { id: 'overpriced', label: 'Is this property overpriced?', match: /overpric|underpric|fair(?:ly)?[\s-]*pric|pric(?:ed|e)\s+(?:right|fairly|fair)|(?:good|right|sensible|reasonable)\s+price|asking price|worth|value/i, run: (p) => {
    const v = valuationScenario(p);
    return { confidence: v.confidence, tools: ['valuation.valuationScenario', 'refurb.estimateRefurb'],
      text: v.verdict === 'insufficient evidence' ? 'There is not enough sold evidence to judge the price.' : `The asking price of ${g(p.price)} is ${v.verdict} of Streetkey's indicative as-is range of ${k(v.asIs.low)}–${k(v.asIs.high)} (${v.askingVsMid >= 0 ? '+' : ''}${pc(v.askingVsMid)} vs midpoint).`,
      evidence: [`${v.evidenceCount} sold comparable(s)`, `Post-works value ${k(v.postWorks.mid)}`, ...v.method.slice(0, 2)],
      assumptions: ['Bedroom adjustment ±7% per bedroom (heuristic)', '12% margin a buyer needs for taking on works'],
      verify: ['RICS valuation or mortgage valuation', 'Measured floor areas of comparables', 'Condition via RICS Level 3 survey'] };
  } },
  { id: 'rent', label: 'How much could I rent this for?', match: /\brent|\blet\b|tenant|yield/i, run: (p) => {
    const r = rentalScenario(p); const ds = dealScore(p);
    return { confidence: r.evidence ? 'medium' : 'low', tools: ['valuation.rentalScenario', 'insights.dealScore'],
      text: `Likely achievable rent ${g(r.low)}–${g(r.high)} pcm (mid ${g(r.mid)}). On the all-in cost including works, that is a ${pc(ds.grossYield)} gross yield.`,
      evidence: [r.basis, `Rental demand index ${p.rentDemand}/100 (demo)`], assumptions: ['Property refurbished to a lettable standard', 'Unfurnished, market-rate tenancy'],
      verify: ['Two or three local letting agent appraisals', 'Licensing requirements with the local authority', 'EPC must be E or above to let'], link: { label: 'Model the investment', to: `/invest?property=${p.id}` } };
  } },
  { id: 'refurb', label: 'What are the likely refurbishment costs?', match: /refurb|renovat|cost|budget|works/i, run: (p) => {
    const e = estimateRefurb(refurbInputFor(p));
    return { confidence: e.confidence, tools: ['refurb.estimateRefurb'],
      text: `For the scope implied by its ${p.condition} condition, Streetkey estimates ${g(e.total)} incl. VAT (likely ${k(e.low)}–${k(e.high)}), about ${e.programmeWeeks} weeks on site.`,
      evidence: e.byTrade.slice(0, 4).map((t) => `${t.trade}: ${k(t.total)}`), assumptions: e.assumptions.slice(0, 3), verify: ['Asbestos survey (pre-2000 building)', 'Three contractor quotes against the Streetkey scope', ...e.exclusions.slice(2, 3)],
      link: { label: 'Open the refurbishment calculator', to: `/estimate?property=${p.id}` } };
  } },
  { id: 'kitchen', label: 'What would it look like with a modern kitchen?', match: /kitchen|look like|design|modern|visual/i, run: (p) => ({
    confidence: 'medium', tools: ['studio.designToCost'], text: 'Open the design studio to generate concepts for the kitchen in different styles; each concept is costed live by the refurbishment engine and can be sent to the investment analyser.',
    evidence: ['Kitchen is one of the most-explored features on this listing'], assumptions: ['Concept images are illustrative and keep the existing layout unless you choose otherwise'], verify: ['Measured survey before ordering', 'Services positions (gas, waste) if moving the layout'],
    link: { label: 'Design the kitchen', to: `/studio?property=${p.id}&room=kitchen` } }) },
  { id: 'extend', label: 'Could I extend this property?', match: /extend|extension|loft|convert|conversion|flats|subdivid|planning/i, run: (p) => {
    const opts = developmentOptions(p).filter((o) => o.status !== 'not applicable');
    return { confidence: 'low', tools: ['development.developmentOptions'],
      text: opts.map((o) => `${o.name}: ${o.status}${o.valueUplift != null && o.cost != null ? ` (cost ≈ ${k(o.cost)}, value uplift ≈ ${k(o.valueUplift)})` : ''}`).join('. ') + '.',
      evidence: p.planningNearby.map((a) => `${a.ref}: ${a.desc} — ${a.decision} (${a.distanceM}m)`), assumptions: ['England permitted-development rules as configured Nov 2026', 'Constraint layers are demo data'],
      verify: ['Lawful development certificate or planning permission', 'Planning consultant / architect', 'Structural engineer'], link: { label: 'Development potential', to: `/property/${p.id}/intelligence#development` } };
  } },
  { id: 'risk', label: 'What are the financial risks?', match: /risk|danger|problem|downside|issue/i, run: (p) => {
    const inv = analyse({ ...DEFAULT_INVESTMENT, strategy: 'btl', price: p.price, nation: p.nation, refurbCost: estimateRefurb(refurbInputFor(p)).total, monthlyRent: p.estRentPcm, gdv: p.estGdv });
    const flags = [p.risks.flood === 'medium' || p.risks.flood === 'high' ? `Flood risk ${p.risks.flood}` : '', p.risks.subsidence !== 'low' ? `Subsidence susceptibility ${p.risks.subsidence}` : '', p.era === 'pre-1919' ? 'Pre-1919 solid walls: damp and hidden defects common' : '', p.condition === 'poor' || p.condition === 'derelict' ? 'Poor condition widens the cost range' : '', !inv.icrPass ? `Fails a typical buy-to-let lender stress test at ${pc(inv.stressRate)}` : '', p.tenure === 'leasehold' ? `Leasehold: ${p.leaseYears} years; check service charge & ground rent` : ''].filter(Boolean);
    return { confidence: 'medium', tools: ['investment.analyse', 'constraints'], text: `Main risks: ${flags.join('; ') || 'no major flags in the available data'}.`, evidence: inv.warnings, assumptions: ['Buy-to-let, 75% LTV, 4.99% interest-only (editable)'], verify: ['RICS Level 3 survey', 'Insurance quote (flood/subsidence)', 'Local searches via conveyancer'] };
  } },
  { id: 'compare', label: 'How does this compare to similar properties?', match: /compar|similar|nearby|other/i, run: (p) => {
    const peers = PROPERTIES.filter((x) => x.id !== p.id && x.listing === p.listing && x.type !== 'commercial').map((x) => ({ x, ds: dealScore(x) })).sort((a, b) => b.ds.total - a.ds.total).slice(0, 3);
    const me = dealScore(p);
    return { confidence: 'medium', tools: ['insights.dealScore'], text: `This property scores ${me.total}/100 (${me.grade}). Top comparable opportunities in the dataset: ${peers.map((q) => `${q.x.town.split(',')[0]} ${q.ds.total}/100`).join(', ')}.`,
      evidence: [`£/m² here ${g(p.price / Math.max(1, p.floorArea))}`, ...peers.map((q) => `${q.x.title}: ${g(q.x.price / Math.max(1, q.x.floorArea))}/m²`)], assumptions: ['Deal score weights are Streetkey defaults'], verify: ['Visit comparables; check condition differences'], link: { label: 'Compare side by side', to: `/compare?ids=${[p.id, ...peers.map((q) => q.x.id)].slice(0, 3).join(',')}` } };
  } },
  { id: 'invest', label: 'Would this be a good investment?', match: /invest|good deal|buy it|worth buying|return|roi|profit/i, run: (p) => {
    const ds = dealScore(p); const loft = loftScenario(p);
    return { confidence: 'low', tools: ['insights.dealScore', 'insights.loftScenario'], text: `Deal score ${ds.total}/100 (grade ${ds.grade}). Base-case value-add after works and purchase costs is ${k(ds.uplift)}${loft && loft.net > 0 ? `, plus about ${k(loft.net)} from a loft conversion` : ''}. ${ds.total >= 62 ? 'Worth a detailed look.' : 'Only works if you can buy below asking or add value the comparables don’t show.'}`,
      evidence: ds.components.map((c) => `${c.label}: ${Math.round(c.score)}/100 — ${c.detail}`).slice(0, 4), assumptions: ['Post-works value from comparables', '≈4% purchase costs'], verify: ['Your own finance terms', 'Tax position (Section 24, CGT)'], link: { label: 'Underwrite it', to: `/invest?property=${p.id}` } };
  } },
  { id: 'epc', label: 'How can I improve the EPC?', match: /epc|energy|insulat|heat pump|green/i, run: (p) => {
    const e = epcPathway(p);
    return { confidence: 'medium', tools: ['insights.epcPathway'], text: `From EPC ${p.epc.current} (${p.epc.score}), the cheapest measures per SAP point are: ${e.steps.slice(0, 3).map((s) => `${s.measure} (${k(s.cost)})`).join(', ')}.`, evidence: e.steps.map((s) => `${s.measure} → ${s.band} (${s.cumulative})`), assumptions: ['Indicative SAP gains'], verify: ['Retrofit assessment (PAS 2035)', 'Grant eligibility'] };
  } },
];

/* ================= Owner assistant ================= */
export const ownerSkills: Skill<Property>[] = [
  { id: 'not-selling', label: 'Why is my house not selling?', match: /not selling|why.*(sell|offer)|no offers/i, run: (p) => {
    const ins = insightsFor(p); const t = totals(engagementFor(p)); const bm = benchmark(p); const v = valuationScenario(p);
    const reasons: string[] = [];
    if (t.enquiryRate.high < bm.rate.low) reasons.push('visitors are looking but not enquiring at the rate comparable listings achieve');
    if (v.verdict === 'above range') reasons.push(`the asking price sits above Streetkey's indicative as-is range (${k(v.asIs.low)}–${k(v.asIs.high)})`);
    if (ins.some((i) => i.id === 'photo-test')) reasons.push('the lead photograph under-performs other images');
    if (ins.some((i) => i.id === 'refurb-interest')) reasons.push('buyers are trying to work out renovation costs themselves');
    return { confidence: 'medium', tools: ['engagement.insightsFor', 'engagement.benchmark', 'valuation.valuationScenario'], text: reasons.length ? `The evidence points to: ${reasons.join('; ')}.` : 'Engagement and conversion are in line with comparables; it may simply need more time.',
      evidence: ins.filter((i) => i.kind === 'observed').slice(0, 3).map((i) => i.title), assumptions: ['Engagement figures are simulated in this prototype', `${PERIOD_DAYS}-day window`], verify: ['Viewing feedback from your agent', 'Recent sold prices'] };
  } },
  { id: 'reduce', label: 'Should I consider reducing the asking price?', match: /reduc|lower|drop|price/i, run: (p) => {
    const v = valuationScenario(p); const t = totals(engagementFor(p)); const bm = benchmark(p);
    const lowConv = t.enquiryRate.high < bm.rate.low;
    return { confidence: 'low', tools: ['valuation.valuationScenario', 'engagement.benchmark'],
      text: v.verdict === 'above range' && lowConv ? `Both signals point the same way: price above the indicative range and conversion below comparables. A move towards ${k(v.asIs.high)} is worth discussing with your agent.` : v.verdict === 'above range' ? 'Price looks high against comparables, but conversion is not yet below par — improve marketing first and review in two weeks.' : lowConv ? 'Price is within the evidence range, so test marketing changes (lead photo, renovation visualisation) before reducing.' : 'No strong evidence for a reduction yet.',
      evidence: [`Asking ${g(p.price)} vs as-is range ${k(v.asIs.low)}–${k(v.asIs.high)}`, `Conversion ${pc(t.enquiryRate.p)} vs comparables ${pc(bm.rate.p)}`, `${p.daysOnMarket} days on market`], assumptions: ['Comparables are demo data'], verify: ['Agent pricing advice', 'RICS valuation if in dispute'] };
  } },
  { id: 'interest', label: 'What do buyers find most interesting?', match: /interest|like|popular|buyers? (find|want)/i, run: (p) => {
    const e = engagementFor(p); const top = [...e.photos].sort((a, b) => b.enlargements / b.impressions - a.enlargements / a.impressions)[0];
    return { confidence: 'medium', tools: ['engagement.engagementFor'], text: `Most-explored features: ${e.featureInterest.slice(0, 3).map((f) => f.feature).join(', ')}. The “${top.label}” photo draws the most enlargements, and the top AI question topic is “${e.aiQuestions[0].topic}”.`,
      evidence: e.featureInterest.slice(0, 4).map((f) => `${f.feature}: ${f.interactions} interactions`), assumptions: ['Interactions show attention, not purchase intent'], verify: [] };
  } },
  { id: 'kitchen-roi', label: 'Would refurbishing the kitchen improve marketability?', match: /kitchen|refurbish|improve/i, run: (p) => {
    const base = refurbInputFor(p); const e = estimateRefurb({ ...base, bathrooms: 0, scope: { ...base.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', windows: false, roof: 'none', flooring: false, decoration: false, damp: false, external: false, insulation: false, structuralOpenings: 0, kitchen: true } });
    const eg = engagementFor(p); const kitchenQs = eg.aiQuestions.find((q) => q.topic === 'Refurbishment cost')?.count ?? 0;
    return { confidence: 'low', tools: ['refurb.estimateRefurb', 'engagement.engagementFor'], text: `A standard new kitchen would cost about ${k(e.total)} incl. VAT. Buyers clearly notice the kitchen (${kitchenQs} cost questions, ${eg.refurbSimulations} renovation simulations), but a cheaper first step is to show a costed AI kitchen concept in the listing; refurbishing before sale rarely returns more than it costs unless the kitchen is unusable.`,
      evidence: [`Kitchen engagement rank: #${eg.featureInterest.findIndex((f) => f.feature === 'Kitchen') + 1}`], assumptions: ['Standard specification'], verify: ['Agent view on local buyer expectations'], link: { label: 'Create a kitchen concept', to: `/studio?property=${p.id}&room=kitchen` } };
  } },
  { id: 'compare-nearby', label: 'How does my property compare to others nearby?', match: /compare|nearby|others|competition/i, run: (p) => {
    const t = totals(engagementFor(p)); const bm = benchmark(p);
    return { confidence: 'medium', tools: ['engagement.benchmark'], text: `Your listing had ${t.views.toLocaleString('en-GB')} views vs a comparable average of ${Math.round(bm.avgViews).toLocaleString('en-GB')}; conversion ${pc(t.enquiryRate.p)} vs ${pc(bm.rate.p)}.`, evidence: [`Comparable set: ${bm.n} listings`], assumptions: ['Comparable set chosen by area and type'], verify: [] };
  } },
  { id: 'report', label: 'Can you prepare a weekly performance report?', match: /report|summary|weekly/i, run: () => ({ confidence: 'high', tools: ['reports.weeklyOwnerReport'], text: 'Your weekly report is ready to download below. It includes reach, conversion against comparables, photo performance, buyer questions and recommended actions with their evidence.', evidence: [], assumptions: [], verify: [] }) },
];

/* ================= Agent assistant (portfolio-level) ================= */
export interface AgentCtx { listings: Property[] }
const rows = (c: AgentCtx) => c.listings.map((p) => { const t = totals(engagementFor(p)); const bm = benchmark(p); return { p, t, bm, gap: t.enquiryRate.p - bm.rate.p }; });
export const agentSkills: Skill<AgentCtx>[] = [
  { id: 'improve', label: 'Suggest improvements to my five weakest listings', match: /improve|suggest|weakest/i, run: (c) => {
    const r = rows(c).sort((a, b) => a.gap - b.gap).slice(0, 5);
    return { confidence: 'medium', tools: ['engagement.insightsFor'], text: `Suggested actions for the ${r.length} weakest listings are below; each needs your approval before any listing change is published.`, evidence: r.map((x) => `${x.p.street.replace(' (fictional)', '')}: ${insightsFor(x.p).filter((i) => i.kind === 'recommendation').map((i) => i.title).join('; ') || 'refresh description & check price evidence'}`), assumptions: [], verify: [] };
  } },
  { id: 'underperf', label: 'Which properties are underperforming this week?', match: /underperform|worst|weak|struggl/i, run: (c) => {
    const r = rows(c).map((x) => ({ ...x, wk: totals(engagementFor(x.p), 21, 28), pwk: totals(engagementFor(x.p), 14, 21) })).filter((x) => x.gap < 0 || x.wk.views < x.pwk.views * 0.85).sort((a, b) => a.gap - b.gap);
    return { confidence: 'medium', tools: ['engagement.totals', 'engagement.benchmark'], text: r.length ? `${r.length} listing(s) are underperforming: ${r.map((x) => x.p.street.replace(' (fictional)', '')).join(', ')}.` : 'No listings are underperforming on this week’s evidence.',
      evidence: r.map((x) => `${x.p.street.replace(' (fictional)', '')}: conversion ${pc(x.t.enquiryRate.p)} vs ${pc(x.bm.rate.p)}; views this week ${x.wk.views} vs ${x.pwk.views}`), assumptions: ['Engagement simulated in prototype'], verify: [] };
  } },
  { id: 'high-low', label: 'Which listings have high engagement but low conversion?', match: /high engagement|low conversion|engag/i, run: (c) => {
    const r = rows(c).filter((x) => x.t.views > x.bm.avgViews && x.t.enquiryRate.high < x.bm.rate.low);
    return { confidence: 'medium', tools: ['engagement.benchmark'], text: r.length ? `${r.map((x) => x.p.street.replace(' (fictional)', '')).join(', ')} — above-average views with conversion significantly below comparables.` : 'None with a statistically clear gap.', evidence: r.map((x) => `${x.t.views} views; conversion CI ${pc(x.t.enquiryRate.low)}–${pc(x.t.enquiryRate.high)} vs comparables ${pc(x.bm.rate.p)}`), assumptions: ['95% Wilson intervals'], verify: ['Viewing feedback', 'Price vs evidence'] };
  } },
  { id: 'interests', label: 'What are buyers most interested in across my portfolio?', match: /interest|portfolio|across/i, run: (c) => {
    const topics = new Map<string, number>(); const styles = new Map<string, number>();
    c.listings.forEach((p) => { const e = engagementFor(p); e.aiQuestions.forEach((q) => topics.set(q.topic, (topics.get(q.topic) ?? 0) + q.count)); e.designStyles.forEach((s) => styles.set(s.style, (styles.get(s.style) ?? 0) + s.count)); });
    const t = [...topics].sort((a, b) => b[1] - a[1]); const s = [...styles].sort((a, b) => b[1] - a[1]);
    return { confidence: 'medium', tools: ['engagement.engagementFor'], text: `Across ${c.listings.length} listings, buyers ask most about ${t[0][0].toLowerCase()} and ${t[1][0].toLowerCase()}; the most-explored design style is ${s[0][0]}.`, evidence: t.slice(0, 5).map(([a, b]) => `${a}: ${b} questions`), assumptions: ['Aggregated, no individual-level data'], verify: [] };
  } },
  { id: 'owner-report', label: 'Prepare a report for the owner of Ashcombe Grove', match: /report|owner of/i, run: (c, q) => {
    const p = c.listings.find((x) => q.toLowerCase().includes(x.street.toLowerCase().split(' (')[0].toLowerCase().split(' ')[0])) ?? c.listings[0];
    return { confidence: 'high', tools: ['reports.weeklyOwnerReport'], text: `Draft seller report for ${p.street.replace(' (fictional)', '')} is ready for your review. Nothing is sent to the owner until you approve it.`, evidence: insightsFor(p).slice(0, 3).map((i) => i.title), assumptions: [], verify: ['Agent review before sending'], link: { label: 'Open in approval queue', to: '/agents#approvals' } };
  } },
];

export const answerText = (a: AiAnswer) => [a.text, ...a.evidence.map((e) => `• ${e}`)].join('\n');
