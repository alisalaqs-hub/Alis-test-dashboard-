/**
 * Tools for "Ask Streetkey". Every figure the assistant can quote comes from these functions,
 * which run Streetkey's own engines (the same code the website uses) over the shared property
 * registry (demo listings plus live listings from the database).
 *
 * Results are deliberately compact: only what the model needs to answer, with listing-supplied
 * text (titles, features, descriptions of live listings) wrapped with untrusted() so the model
 * treats it as data rather than instructions.
 */
import { getProperty, PROPERTIES, type Property } from '../../../../src/data/properties';
import { designCost, type RoomType, type Tier } from '../../../../src/engine/design';
import { dealScore, epcPathway, loftScenario, refurbInputFor } from '../../../../src/engine/insights';
import { analyse, DEFAULT_INVESTMENT } from '../../../../src/engine/investment';
import { estimateRefurb, hiddenDefectRisks, regionFromPostcode, REGIONS } from '../../../../src/engine/refurb';
import { describeQuery, parseQuery, runSearch } from '../../../../src/engine/search';
import { transactionTax, type BuyerType, type Nation } from '../../../../src/engine/tax';
import { rentalScenario, valuationScenario } from '../../../../src/engine/valuation';
import { q } from '../../db';
import { untrusted, type Tool } from '../core';
import { ensureLiveRegistry } from '../registry';
import { S, type Infer } from '../schema';

/** Property ids: demo ids (wal-001) and live listing refs (sk-abc1234). */
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/i;

/** A home the public may see, or null. Private, pending and withdrawn homes are never returned. */
export function findHome(id: unknown): Property | null {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const p = getProperty(id);
  if (!p || p.visibility === 'private' || p.status === 'withdrawn' || p.status === 'pending') return null;
  return p;
}

export const isDemo = (p: Property) => !p.source || p.source.kind === 'demo';

/** Listing-supplied text: wrapped as data for live listings (demo text is Streetkey's own). */
const lt = (p: Property, s: string | undefined, max = 160) => (s == null ? null : isDemo(p) ? s.slice(0, max) : untrusted('listing', s, max));
const pct1 = (fraction: number) => (Number.isFinite(fraction) ? Math.round(fraction * 1000) / 10 : null);
const pct2 = (fraction: number) => (Number.isFinite(fraction) ? Math.round(fraction * 10_000) / 100 : null);
const whole = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);

const priceIs = (p: Property) => (p.listing === 'rent' ? 'rent per calendar month' : p.listing === 'auction' ? 'auction guide price' : 'asking price');

/** Short card used in search results and comparisons. The town is free text for live listings, so it is wrapped as data too. */
function homeCard(p: Property) {
  return {
    id: p.id, title: lt(p, p.title, 120), town: lt(p, p.town, 80), district: p.district, listing: p.listing, price: p.price, priceIs: priceIs(p),
    type: p.type, beds: p.beds, baths: p.baths, floorAreaM2: p.floorArea, tenure: p.tenure, status: p.status ?? 'live', demo: isDemo(p),
  };
}

/**
 * What the lister wrote about a home (for live listings) or Streetkey's demo text: the words the
 * model needs to refer to it, sent as a data block, never as instructions or as evidence for figures.
 * Street only: never a private seller's house number or full postcode.
 */
export function listingText(p: Property) {
  return {
    title: p.title.slice(0, 120), town: p.town.slice(0, 80), street: p.street.slice(0, 80),
    features: p.features.slice(0, 8).map((x) => x.slice(0, 60)),
    ...(!isDemo(p) && p.description ? { description: p.description.slice(0, 600) } : {}),
    listedBy: isDemo(p) ? 'Streetkey demonstration data' : `${p.source?.name ?? 'Lister'}${p.source?.verified ? ' (verified)' : ''}`.slice(0, 80),
  };
}

/** What the website shows for a home the assistant mentions (plain, from the registry, never from the model). */
export function publicCard(p: Property) {
  return { id: p.id, title: p.title.slice(0, 140), town: p.town, price: p.price, listing: p.listing, beds: p.beds, type: p.type, demo: isDemo(p) };
}
export type PublicCard = ReturnType<typeof publicCard>;

/**
 * What the lister actually supplied for a live listing. The shared registry fills gaps with
 * defaults (build era 1945–1979, fair condition, loft "possible", 0 days on market, 0-minute
 * commute…) so the engines can run; those defaults must never be presented as facts.
 */
export interface LiveFacts { eraGiven: boolean; conditionGiven: boolean; listedOn: string | null; daysOnMarket: number | null }
const NOTHING_KNOWN: LiveFacts = { eraGiven: false, conditionGiven: false, listedOn: null, daysOnMarket: null };

/** One query for up to 20 live homes (demo homes need none). Unknown on any error: treated as not supplied. */
export async function liveFacts(homes: Property[]): Promise<Map<string, LiveFacts>> {
  const out = new Map<string, LiveFacts>();
  const refs = [...new Set(homes.filter((p) => !isDemo(p)).map((p) => p.id))].slice(0, 20);
  if (!refs.length) return out;
  const rows = await q<{ ref: string; era: string | null; condition: string | null; published_at: Date | null }>(
    `SELECT ref, era, condition, published_at FROM listings WHERE ref = ANY($1::text[]) AND status IN ('live', 'under_offer')`, [refs],
  ).catch(() => []);
  for (const r of rows) {
    const at = r.published_at ? new Date(r.published_at) : null;
    out.set(r.ref, {
      eraGiven: !!r.era, conditionGiven: !!r.condition, listedOn: at ? at.toISOString().slice(0, 10) : null,
      daysOnMarket: at ? Math.max(0, Math.floor((Date.now() - at.getTime()) / 86_400_000)) : null,
    });
  }
  return out;
}
const factsFor = async (p: Property) => (isDemo(p) ? null : (await liveFacts([p])).get(p.id) ?? NOTHING_KNOWN);

/** Engine estimates for live listings that rest on registry defaults, in words for the model. */
function assumedFor(p: Property, f: LiveFacts | null): string[] {
  if (!f) return [];
  return [
    ...(f.eraGiven ? [] : [`build era: not stated by the lister; estimates assume ${p.era}`]),
    ...(f.conditionGiven ? [] : [`condition: not stated by the lister; estimates assume ${p.condition} condition`]),
  ];
}

function dataNotes(p: Property, f: LiveFacts | null): string[] {
  if (isDemo(p) || !f) return ['Demonstration listing: a fictional home with illustrative figures. Say so if you discuss it in detail or are asked whether it is real.'];
  const assumed = assumedFor(p, f);
  return [
    'Live listing on Streetkey; the details were supplied by the lister.',
    'Value and rent ranges use Streetkey’s demonstration evidence for the area, not HM Land Registry records.',
    'Schools, journey times, loft and extension potential, and flood/subsidence risk have not been assessed for this listing yet: do not describe them.',
    ...(assumed.length ? [`The lister left some details blank, so estimates use assumptions (${assumed.map((a) => a.split(':')[0]).join(', ')}). Say so if you quote refurbishment, EPC or defect estimates.`] : []),
  ];
}

const NOT_ASSESSED = 'not assessed';

/**
 * Facts plus engine intelligence for one home (used by get_property and as page context).
 * Pass `facts` for live listings; without them every gap is treated as not supplied by the lister.
 */
export function propertyIntel(p: Property, facts?: LiveFacts | null) {
  const demo = isDemo(p);
  const f = demo ? null : facts ?? NOTHING_KNOWN;
  const sale = p.listing !== 'rent';
  const refurb = estimateRefurb(refurbInputFor(p));
  const ds = sale ? dealScore(p) : null;
  const val = sale ? valuationScenario(p) : null;
  const rent = rentalScenario(p);
  const epc = epcPathway(p);
  const loft = sale && demo ? loftScenario(p) : null;
  const condition = !f || f.conditionGiven ? p.condition : 'not stated';
  const assumed = assumedFor(p, f);
  return {
    ...homeCard(p),
    street: demo ? p.street : lt(p, p.street, 80), // street only: never a private seller's house number
    nation: p.nation, era: !f || f.eraGiven ? p.era : 'not stated', condition, storeys: demo ? p.storeys : null,
    epc: { current: p.epc.current, potential: demo ? p.epc.potential : null }, councilTaxBand: p.councilTax,
    leaseYears: p.leaseYears ?? null, serviceChargeAnnual: p.serviceChargeAnnual ?? null, groundRentAnnual: p.groundRentAnnual ?? null,
    features: p.features.slice(0, 8).map((x) => lt(p, x, 60)),
    description: !demo && p.description ? untrusted('listing_description', p.description, 600) : null,
    source: demo ? 'Streetkey demonstration data' : lt(p, `${p.source?.name ?? 'Lister'}${p.source?.verified ? ' (verified)' : ''}`, 80),
    daysOnMarket: f ? f.daysOnMarket : p.daysOnMarket,
    ...(f ? { listedOn: f.listedOn } : {}),
    priceHistory: demo ? p.priceHistory.slice(-3) : null, // not tracked for live listings yet
    // Named so the model talks about an indicative range, never "Streetkey's valuation".
    indicativeValue: val ? {
      asIsRange: val.asIs, postWorksRange: val.postWorks, askingPriceIs: val.verdict, askingVsMidPct: pct1(val.askingVsMid),
      confidence: val.confidence, soldComparables: val.evidenceCount, note: 'Indicative range from comparables; not a valuation.',
    } : null,
    rentEstimatePcm: { low: rent.low, mid: rent.mid, high: rent.high, basis: rent.basis },
    dealScore: ds ? {
      score: ds.total, outOf: 100, grade: ds.grade, grossYieldPct: pct1(ds.grossYield), upliftAfterWorks: whole(ds.uplift),
      ...(f ? { basis: 'Uses area estimates; flood risk, planning constraints and tenant demand have not been checked for this listing.' } : {}),
    } : null,
    refurbEstimate: {
      total: refurb.total, low: refurb.low, high: refurb.high, weeks: refurb.programmeWeeks, confidence: refurb.confidence,
      scope: condition === 'not stated' ? `Typical scope for a home in ${p.condition} condition (assumed: the lister did not state the condition), standard finish, including VAT` : `Typical scope for ${p.condition} condition, standard finish, including VAT`,
    },
    epcUpgrades: epc.steps.slice(0, 3).map((s) => ({ measure: s.measure, cost: s.cost, bandAfter: s.band })),
    ...(assumed.length ? { assumed } : {}),
    loftConversion: loft ? { areaM2: loft.area, cost: loft.cost, valueUplift: loft.valueUplift, net: loft.net } : null,
    loftPotential: demo ? p.loftPotential : NOT_ASSESSED, extensionPotential: demo ? p.extensionPotential : NOT_ASSESSED,
    schools: demo ? p.schools.slice(0, 3).map((s) => ({ name: s.name, ofsted: s.rating, distanceKm: s.distanceKm })) : null,
    commute: demo && p.commute.minutes > 0 ? { to: p.commute.to, minutes: p.commute.minutes, mode: p.commute.mode, station: p.station.name, walkMins: p.station.walkMins } : null,
    risks: demo ? { flood: p.risks.flood, subsidence: p.risks.subsidence, conservationArea: p.risks.conservationArea, article4: p.risks.article4, listedBuilding: p.risks.listed, radon: p.risks.radon } : null,
    planningNearby: demo ? p.planningNearby.slice(0, 3).map((a) => ({ desc: a.desc, decision: a.decision, distanceM: a.distanceM })) : null,
    dataNotes: dataNotes(p, f),
    links: { details: `/property/${p.id}`, invest: `/invest?property=${p.id}`, refurb: `/estimate?property=${p.id}`, design: `/studio?property=${p.id}` },
  };
}

const notFound = (id: string) => ({ error: `No public Streetkey listing has the id "${String(id).slice(0, 40)}". Use search_homes to find homes and their ids.` });
const need = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const finite = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/* ───────────────────────── tool definitions ───────────────────────── */

const SearchArgs = S.obj({
  query: S.str('What the person is looking for, in their words: place or postcode, budget, bedrooms, features, strategy.'),
  mode: S.enum(['buy', 'rent', 'invest'] as const, 'buy = homes for sale, rent = homes to rent, invest = investment purchases'),
});
const IdArgs = S.obj({ id: S.str('Property id from a tool result, e.g. wal-001 or sk-abc1234') });
const CompareArgs = S.obj({ ids: S.arr(S.str(), 'Two to four property ids from tool results') });
const TaxArgs = S.obj({
  price: S.num('Purchase price in pounds'),
  nation: S.enum(['england', 'wales', 'scotland', 'northern-ireland'] as const, 'Where the home is (SDLT in England and Northern Ireland, LTT in Wales, LBTT in Scotland)'),
  buyer: S.enum(['first-time', 'home-mover', 'additional'] as const, 'first-time buyer, moving home, or an additional property (second home or buy-to-let)'),
});
const RefurbArgs = S.obj({ propertyId: S.str('Property id') });
const DesignArgs = S.obj({
  room: S.enum(['kitchen', 'bathroom', 'living', 'bedroom'] as const),
  tier: S.enum(['budget', 'standard', 'premium', 'luxury'] as const, 'Finish level'),
  widthM: S.num('Room width in metres (use 3 if unknown)'),
  lengthM: S.num('Room length in metres (use 4 if unknown)'),
  postcode: S.str('UK postcode or district for regional prices, e.g. E17 or M14 5RB (use the home’s district if known)'),
});
const InvestArgs = S.obj({
  propertyId: S.str('Property id (a home for sale)'),
  depositPct: S.num('Deposit as a percentage of the price, e.g. 25 (use 25 if not given)'),
  ratePct: S.num('Mortgage interest rate in percent a year, e.g. 5 (use 5 if not given)'),
});
const MortgageArgs = S.obj({
  loan: S.num('Amount borrowed in pounds'),
  ratePct: S.num('Interest rate in percent a year, e.g. 4.5 (use 5 if not given)'),
  years: S.num('Mortgage term in years (use 25 if not given)'),
});

async function searchHomes(a: Infer<typeof SearchArgs>) {
  const text = String(a.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  need(text.length > 0, 'Give a search query.');
  const mode = (['buy', 'rent', 'invest'] as const).includes(a.mode) ? a.mode : 'buy';
  await ensureLiveRegistry();
  const query = parseQuery(text);
  query.intent = mode;
  const all = runSearch(query, PROPERTIES);
  // Live listings have no journey times yet (the registry says 0 minutes), so they can't be said to meet a commute limit.
  const hits = query.maxCommuteMins ? all.filter((h) => isDemo(h.property)) : all;
  const top = hits.slice(0, 6);
  const facts = await liveFacts(top.map((h) => h.property));
  const notes = [
    ...(top.some((h) => isDemo(h.property)) ? ['Homes with demo: true are fictional demonstration listings.'] : []),
    ...(top.some((h) => !isDemo(h.property)) ? ['For live listings (demo: false), journey times, loft and extension potential, schools and risks have not been assessed yet.'] : []),
    // The engine itself never counts an uncalculated journey as meeting a limit, so say why live homes are missing.
    ...(query.maxCommuteMins && (hits.length < all.length || PROPERTIES.some((p) => !isDemo(p))) ? ['Live listings were left out because their journey times have not been calculated yet.'] : []),
  ];
  return {
    understood: describeQuery(query), notSupportedYet: query.unsupported, totalMatches: hits.length,
    homes: top.map((h) => {
      const f = isDemo(h.property) ? null : facts.get(h.property.id) ?? NOTHING_KNOWN;
      return {
        ...homeCard(h.property), dealGrade: h.property.listing === 'rent' ? null : h.dealGrade,
        reasons: liveSafe(h.reasons, f).slice(0, 3), cautions: liveSafe(h.cautions, f).slice(0, 2),
      };
    }),
    searchLink: `/search?q=${encodeURIComponent(text)}&mode=${mode}`,
    note: notes.length ? notes.join(' ') : null,
  };
}

/** Engine reasons that rest on registry defaults for live listings (journey times, loft, schools, risks…). */
const UNASSESSED = /door-to-door|commute|loft|extension|rental demand|demand index|schools?|ofsted|conversion|flood|subsidence|article 4|listed building|conservation/i;
function liveSafe(lines: string[], f: LiveFacts | null): string[] {
  if (!f) return lines;
  return lines.filter((l) => !UNASSESSED.test(l) && (f.conditionGiven || !/^condition\b|good condition/i.test(l)));
}

async function getHome(a: Infer<typeof IdArgs>) {
  await ensureLiveRegistry();
  const p = findHome(a.id);
  return p ? propertyIntel(p, await factsFor(p)) : notFound(a.id);
}

async function compareHomes(a: Infer<typeof CompareArgs>) {
  await ensureLiveRegistry();
  const ids = [...new Set((Array.isArray(a.ids) ? a.ids : []).map(String))].slice(0, 4);
  need(ids.length > 0, 'Give two to four property ids.');
  const found = ids.map((id) => findHome(id)).filter((p): p is Property => !!p);
  const facts = await liveFacts(found);
  return {
    homes: found.map((p) => {
      const sale = p.listing !== 'rent';
      const ds = sale ? dealScore(p) : null;
      const val = sale ? valuationScenario(p) : null;
      const f = isDemo(p) ? null : facts.get(p.id) ?? NOTHING_KNOWN;
      const assumed = assumedFor(p, f);
      return {
        ...homeCard(p), epc: p.epc.current, councilTaxBand: p.councilTax,
        dealScore: ds?.total ?? null, dealGrade: ds?.grade ?? null, grossYieldPct: ds ? pct1(ds.grossYield) : null,
        askingPriceIs: val?.verdict ?? null, asIsMid: val?.asIs.mid ?? null, rentEstimateMidPcm: rentalScenario(p).mid,
        refurbEstimate: estimateRefurb(refurbInputFor(p)).total, floodRisk: f ? 'not checked' : p.risks.flood, daysOnMarket: f ? f.daysOnMarket : p.daysOnMarket,
        ...(assumed.length ? { assumed } : {}),
      };
    }),
    notFound: ids.filter((id) => !findHome(id)),
    compareLink: found.length >= 2 ? `/compare?ids=${found.map((p) => p.id).join(',')}` : null,
  };
}

function stampDuty(a: Infer<typeof TaxArgs>) {
  need(finite(a.price, 1, 100_000_000), 'The price must be between £1 and £100,000,000.');
  const nation: Nation = (['england', 'wales', 'scotland', 'northern-ireland'] as const).includes(a.nation) ? a.nation : 'england';
  const buyer: BuyerType = (['first-time', 'home-mover', 'additional'] as const).includes(a.buyer) ? a.buyer : 'home-mover';
  const r = transactionTax(Math.round(a.price), nation, buyer);
  return {
    price: Math.round(a.price), nation, buyer, tax: r.tax, total: r.total, effectiveRatePct: pct2(r.effectiveRate),
    bands: r.lines.map((l) => ({ from: l.from, to: l.to, ratePct: pct1(l.rate), tax: l.tax })),
    notes: r.notes.slice(0, 3),
  };
}

async function refurbEstimate(a: Infer<typeof RefurbArgs>) {
  await ensureLiveRegistry();
  const p = findHome(a.propertyId);
  if (!p) return notFound(a.propertyId);
  const f = await factsFor(p);
  const input = refurbInputFor(p);
  const e = estimateRefurb(input);
  const eraKnown = !f || f.eraGiven;
  return {
    home: { id: p.id, title: lt(p, p.title, 120), condition: !f || f.conditionGiven ? p.condition : 'not stated', floorAreaM2: p.floorArea, demo: isDemo(p) },
    total: e.total, low: e.low, high: e.high, confidence: e.confidence, weeksOnSite: e.programmeWeeks, costPerM2ExVat: e.costPerM2, includesVat: true,
    byTrade: e.byTrade.slice(0, 6).map((t) => ({ trade: t.trade, total: Math.round(t.total) })),
    // The engine quotes the postcode it priced from; only the district is ever shown (private sellers' privacy).
    assumptions: [...assumedFor(p, f), ...e.assumptions.slice(0, 3).map((s) => s.split(p.postcode.toUpperCase()).join(p.district))], exclusions: e.exclusions.slice(0, 3),
    // Without a stated build era, how likely each defect is has not been assessed: they are general things to check.
    hiddenDefectRisks: hiddenDefectRisks(input).slice(0, 3).map((r) => (eraKnown ? r : { risk: r.risk, likelihood: NOT_ASSESSED, allowance: r.allowance, basis: 'general check: based on an assumed build era, because the lister did not state it' })),
    calculator: `/estimate?property=${p.id}`,
  };
}

function designCostTool(a: Infer<typeof DesignArgs>) {
  const room: RoomType = (['kitchen', 'bathroom', 'living', 'bedroom'] as const).includes(a.room) ? a.room : 'kitchen';
  const tier: Tier = (['budget', 'standard', 'premium', 'luxury'] as const).includes(a.tier) ? a.tier : 'standard';
  need(finite(a.widthM, 1, 15) && finite(a.lengthM, 1, 15), 'Room width and length must be between 1 and 15 metres.');
  const postcode = String(a.postcode ?? '').trim().toUpperCase().slice(0, 10);
  need(/^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/.test(postcode), 'Give a UK postcode or district, e.g. E17 or M14 5RB.');
  const region = regionFromPostcode(postcode);
  const c = designCost(room, tier, { width: a.widthM, length: a.lengthM, height: 2.4 }, postcode);
  return {
    room, tier, widthM: a.widthM, lengthM: a.lengthM, region: c.regionLabel, regionKnown: !!region,
    total: c.total, materials: c.materials, labour: c.labour, prelimsAndOverheads: c.prelimsOhp, contingency: c.contingency, vat: c.vat, weeks: c.weeks,
    biggestLines: [...c.lines].sort((x, y) => y.total - x.total).slice(0, 5).map((l) => ({ item: l.name, spec: l.spec, total: l.total })),
    note: region ? `Prices adjusted for ${REGIONS[region].label}.` : 'Postcode not recognised: national average prices used.',
    designStudio: `/studio?room=${room}`,
  };
}

async function investmentCheck(a: Infer<typeof InvestArgs>) {
  await ensureLiveRegistry();
  const p = findHome(a.propertyId);
  if (!p) return notFound(a.propertyId);
  if (p.listing === 'rent') return { error: 'This home is to rent, so a purchase investment check does not apply.' };
  need(finite(a.depositPct, 5, 100), 'Deposit must be between 5% and 100%.');
  need(finite(a.ratePct, 0, 20), 'Interest rate must be between 0% and 20%.');
  const assumed = assumedFor(p, await factsFor(p));
  const refurb = estimateRefurb(refurbInputFor(p)).total;
  const rent = p.type === 'commercial' ? p.estRentPcm : rentalScenario(p).mid;
  if (!rent) return { error: 'There is no rent estimate for this home, so yields cannot be worked out.' };
  const r = analyse({
    ...DEFAULT_INVESTMENT, strategy: p.type === 'commercial' ? 'commercial' : 'btl', price: p.price, nation: p.nation, buyer: 'additional',
    refurbCost: refurb, gdv: p.estGdv, monthlyRent: rent, serviceChargeAnnual: p.serviceChargeAnnual ?? 0,
    depositPct: a.depositPct / 100, mortgageRate: a.ratePct / 100, interestOnly: true,
  });
  return {
    home: { id: p.id, title: lt(p, p.title, 120), price: p.price, demo: isDemo(p) },
    assumptions: {
      strategy: 'Buy-to-let, interest-only mortgage, bought as an additional property by an individual',
      depositPct: a.depositPct, loanToValuePct: Math.round((100 - a.depositPct) * 10) / 10, ratePct: a.ratePct,
      rentPcm: rent, refurbishment: refurb, voidsPct: pct1(DEFAULT_INVESTMENT.voidPct), managementPct: pct1(DEFAULT_INVESTMENT.managementPct), maintenancePct: pct1(DEFAULT_INVESTMENT.maintenancePct),
      ...(assumed.length ? { refurbishmentBasis: assumed } : {}),
    },
    grossYieldPct: pct1(r.grossYield), netYieldPct: pct1(r.netYield),
    monthlyCashFlowBeforeTax: whole(r.monthlyCashflow), annualRent: whole(r.annualRent), annualRunningCosts: whole(r.annualCosts), annualMortgageInterest: whole(r.annualFinance),
    loan: whole(r.loan), cashNeeded: whole(r.cashInvested), purchaseTax: r.acquisition.tax, purchaseTaxName: r.acquisition.taxName,
    lenderStressTest: { passes: r.icrPass, coverPct: pct1(r.icr), requiredPct: pct1(r.icrRequired), stressRatePct: pct1(r.stressRate) },
    warnings: r.warnings.slice(0, 3),
    calculator: `/invest?property=${p.id}`,
  };
}

function mortgagePayment(a: Infer<typeof MortgageArgs>) {
  need(finite(a.loan, 1_000, 20_000_000), 'The loan must be between £1,000 and £20,000,000.');
  need(finite(a.ratePct, 0, 25), 'The interest rate must be between 0% and 25%.');
  need(finite(a.years, 1, 40), 'The term must be between 1 and 40 years.');
  const n = Math.round(a.years * 12);
  const i = a.ratePct / 100 / 12;
  const repayment = i === 0 ? a.loan / n : (a.loan * i) / (1 - Math.pow(1 + i, -n));
  const interestOnly = a.loan * i;
  return {
    loan: Math.round(a.loan), ratePct: a.ratePct, years: n / 12,
    monthlyRepayment: Math.round(repayment), monthlyInterestOnly: Math.round(interestOnly),
    totalRepaid: Math.round(repayment * n), totalInterest: Math.round(repayment * n - a.loan),
    note: 'Illustration at a fixed rate for the whole term; real products change rate and add fees. Not a mortgage offer.',
  };
}

/** Human-readable names for the website ("Based on: …"). */
export const TOOL_LABELS: Record<string, string> = {
  search_homes: 'Streetkey search', get_property: 'Property intelligence', compare_homes: 'Comparison', stamp_duty: 'Stamp duty calculator',
  refurb_estimate: 'Refurbishment estimator', design_cost: 'Design cost engine', investment_check: 'Investment analyser', mortgage_payment: 'Mortgage calculator',
};

export const TOOLS: Tool[] = [
  { name: 'search_homes', description: 'Find homes on Streetkey that match what the person wants. Returns up to 6 homes with id, price, beds, deal grade and reasons/cautions.', parameters: SearchArgs, run: searchHomes },
  { name: 'get_property', description: 'Facts and intelligence for one home: indicative value range, rent estimate, deal score, refurbishment estimate, EPC upgrades, loft potential, schools, commute and risks.', parameters: IdArgs, run: getHome },
  { name: 'compare_homes', description: 'Side-by-side key figures for two to four homes.', parameters: CompareArgs, run: compareHomes },
  { name: 'stamp_duty', description: 'Property purchase tax (SDLT in England/NI, LTT in Wales, LBTT in Scotland) for a price and buyer type, with the bands used.', parameters: TaxArgs, run: stampDuty },
  { name: 'refurb_estimate', description: 'Whole-home refurbishment cost estimate for a home (scope implied by its condition), with range, timescale and main trades.', parameters: RefurbArgs, run: refurbEstimate },
  { name: 'design_cost', description: 'Cost to redo one room (kitchen, bathroom, living room or bedroom) at a finish level, adjusted for the region.', parameters: DesignArgs, run: designCostTool },
  { name: 'investment_check', description: 'Buy-to-let check for a home for sale: gross and net yield, monthly cash flow, cash needed, purchase tax and lender stress test.', parameters: InvestArgs, run: investmentCheck },
  { name: 'mortgage_payment', description: 'Monthly mortgage payment (repayment and interest-only) for a loan, rate and term.', parameters: MortgageArgs, run: mortgagePayment },
];
