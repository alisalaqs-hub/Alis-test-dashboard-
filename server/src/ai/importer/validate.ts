/**
 * Checks that what the model "read" is really in the pasted text: quotes must appear in it and
 * numbers must be written in it. Anything that fails is downgraded or dropped, so people only see
 * figures that came from the listing itself.
 */
import { conditionClues, mention, normText, topicsIn } from '../../../../src/lib/ai/importer';

const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, double: 2 };

/** Lower-case, straight quotes, single spaces: for forgiving "is this quote in the text" checks. */
export const squash = (s: string) => s.toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Does the quote (ignoring case, spacing and quote styles, and a trailing "…") appear in the text? */
export function quoteIn(quote: string | null | undefined, text: string): boolean {
  if (!quote) return false;
  const qt = squash(quote).replace(/^(\.\.\.|…)+|(\.\.\.|…)+$/g, '').trim();
  if (qt.length < 2) return false;
  const body = squash(text);
  if (body.includes(qt)) return true;
  // Allow light paraphrase of punctuation: compare letters and digits only.
  const strip = (s: string) => s.replace(/[^a-z0-9£]+/g, '');
  return strip(qt).length >= 3 && strip(body).includes(strip(qt));
}

/** Every number written in the text: "£375,000" → 375000, "£1.2m" → 1200000, "450k" → 450000, "three" → 3. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const t = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(k|m|million|bn)?\b/g)) {
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) continue;
    out.add(n);
    if (m[2] === 'k') out.add(Math.round(n * 1000));
    if (m[2] === 'm' || m[2] === 'million') out.add(Math.round(n * 1_000_000));
  }
  for (const [w, n] of Object.entries(WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) out.add(n);
  return out;
}

/** Is this number written in the text (allowing for rounding of decimals)? */
export const numberIn = (n: number, nums: Set<number>) => nums.has(n) || [...nums].some((x) => Math.abs(x - n) < 0.01 || (n >= 10 && Math.round(x) === n));

/** A clean single-line string, without control characters, cut to length. */
export function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Remove money figures the model may have added to free text (prices come from engines, not the model). */
export const noMoney = (s: string) => s.replace(/(about|around|roughly|approx\.?|approximately|c\.)?\s*£\s?\d[\d,.]*\s?(k|m|bn|million)?\b(\s*(per|a|\/)\s*(m²|m2|sq ?m|lm|metre|month|year|week))?/gi, '').replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();

/* ───────────── does the quote support the value? ───────────── */
const close = (x: number, n: number) => Math.abs(x - n) < 0.01 || (n >= 10 && Math.round(x) === n);

/** Numbers written with digits, where they sit (end = end of the digits, so "67 m²" keeps "m²" after it). */
function numberTokens(s: string) {
  const out: { values: number[]; start: number; end: number }[] = [];
  for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(k|m|million|bn)\b)?/g)) {
    const n = Number.parseFloat(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    if (!Number.isFinite(n)) continue;
    const values = [n];
    if (m[3] === 'k') values.push(Math.round(n * 1000));
    if (m[3] === 'm' || m[3] === 'million') values.push(Math.round(n * 1_000_000));
    const start = m.index ?? 0;
    out.push({ values, start, end: start + m[1].length + (m[2] ? m[2].length + 1 : 0) });
  }
  return out;
}

export interface NumberContext { before: string; after: string }
/**
 * Where an amount is written, for checking its unit, period and what it belongs to. When the quote can be
 * found in the text, only the amount inside the quote counts; otherwise (a lightly paraphrased quote that
 * still contains the amount) every place it's written does. `before` is ~48 characters before the number;
 * `after` runs to the next number or £ sign. Both are lower-case with line breaks kept.
 */
export function contextsOf(amount: number, text: string, evidence: string | null): NumberContext[] {
  const body = normText(text);
  const flat = body.replace(/\n/g, ' '); // same positions; matches squash(text)
  const hits = numberTokens(body).filter((t) => t.values.some((v) => close(v, amount)));
  if (!hits.length) return [];
  let pick = hits;
  if (evidence) {
    const q = squash(evidence).replace(/^(\.\.\.|…)+|(\.\.\.|…)+$/g, '').trim();
    const spans: [number, number][] = [];
    if (q.length >= 2) for (let at = flat.indexOf(q); at >= 0 && spans.length < 20; at = flat.indexOf(q, at + 1)) spans.push([at, at + q.length]);
    if (spans.length) pick = hits.filter((t) => spans.some(([a, b]) => t.start >= a && t.end <= b));
    else if (![...numbersIn(evidence)].some((x) => close(x, amount))) return [];
  }
  return pick.map((t) => {
    const rest = body.slice(t.end, t.end + 48);
    const cut = rest.search(/£|\d/);
    return { before: body.slice(Math.max(0, t.start - 48), t.start), after: cut >= 0 ? rest.slice(0, cut) : rest };
  });
}

/**
 * Does the quote give this band straight after the keyword ("EPC rating: C", "Council tax band D")?
 * The first single letter after the keyword must be the band, so "EPC: C (potential B)" supports C, not B.
 */
export function bandIn(quote: string, key: RegExp, letter: string): boolean {
  for (const m of quote.matchAll(new RegExp(key.source, 'gi'))) {
    const from = (m.index ?? 0) + m[0].length;
    const after = quote.slice(from, from + 40).split(/[.;\n]/)[0];
    for (const l of after.matchAll(/(?:^|[^A-Za-z])([A-Za-z])(?![A-Za-z])/g)) {
      if (l[1] === 'a') continue; // the article, not a band
      if (l[1].toUpperCase() === letter.toUpperCase()) return true;
      break;
    }
  }
  return false;
}

const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'into', 'its', 'this', 'that', 'very', 'fully', 'newly', 'recently', 'well', 'own', 'plus', 'near', 'close', 'has', 'have', 'are']);
/** Is a short phrase (an AI "feature") written in the text, or are all its content words? */
export function groundedPhrase(phrase: string, text: string): boolean {
  if (quoteIn(phrase, text)) return true;
  const words = new Set(squash(text).split(/[^a-z0-9]+/).filter(Boolean));
  const has = (w: string) => words.has(w) || words.has(w.replace(/e?s$/, '')) || words.has(`${w}s`) || words.has(`${w}es`);
  const content = squash(phrase).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return content.length > 0 && content.every(has);
}

/** Content words, roughly stemmed ("needs updating" → need, updat), for comparing two short texts. */
function terms(s: string): Set<string> {
  return new Set(squash(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/(?:ings?|ed|es|e|s)$/, '')).filter((w) => w.length >= 3));
}
/** Do two short texts (a red flag's title and its quote) share at least one content word? */
export function sharesTerms(a: string, b: string): boolean {
  const tb = terms(b);
  return [...terms(a)].some((w) => tb.has(w));
}

/* ───────────── is a red flag's title a concern, or a feature? ───────────── */
/**
 * Positive wording that contains a concern word: "No onward chain", "Long lease", "999-year lease",
 * "Peppercorn ground rent", "Low risk of flooding", "Flooded with natural light", "Works completed in 2023".
 * Taken out of a title before it is checked, so it can't make a feature look like a concern.
 */
const POSITIVE = new RegExp([
  String.raw`\b(?:no|without|free of|free from)\s+(?:an?\s+)?(?:onward\s+|upward\s+|forward\s+)?chain\b|\bchain[- ]free\b`,
  String.raw`\b(?:long|extended|newly extended|new|generous)\s+(?:lease(?:hold)?|lease term)\b|\blease (?:has been |was |recently )?(?:extended|renewed)\b`,
  String.raw`\b(?:(?:lease(?:hold)?|lease (?:length|term))\b[^.;,]{0,12}?)?(?:12[5-9]|1[3-9]\d|[2-9]\d\d|[1-9]\d{3})[- ]?years?\b(?:[^.;,]{0,14}?\blease(?:hold)?\b)?`,
  String.raw`\bpeppercorn(?:\s+ground)?(?:\s+rents?)?\b`,
  String.raw`\b(?:low|very low|minimal|negligible|no known|little)\s+(?:\w+\s+)?(?:risks?|chance)\b(?:\s+of\s+\w+)?`,
  String.raw`\b(?:light|sun)[- ]?flooded\b|\bflooded with (?:natural |lots of |plenty of )?(?:light|sunlight|sunshine|daylight)\b`,
  String.raw`\b(?:works?|repairs?|refurbishment|renovation|modernisation|modernization|updating|rewiring|remediation)\s+(?:(?:were|was|have been|has been|recently|now|all|already|fully|successfully)\s+)*(?:completed?|done|carried out|finished|undertaken)\b`,
].join('|'), 'gi');

/** Risks, defects, costs, restrictions and surroundings worth checking. Each counts unless it's negated ("No damp"). */
const STRONG = new RegExp([
  String.raw`\b(?:risks?|concerns?|issues?|problems?|warnings?|caution|query|queries|disputes?|disputed|check)\b`,
  String.raw`\b(?:damp|mou?ld|mildew|condensation|cracks?|cracked|cracking|subsiden\w*|heave|structural|defects?|defective|leaks?|leaking|leaky|rot|rotten|rotting|woodworm|infestation|vermin|asbestos|knotweed|underpinn\w*|damaged?|broken|faulty|obsolete|outdated|ageing|aging)\b`,
  String.raw`\bflood(?:s|ed|ing|plain|zone)?\b(?!\s+with\b)|\b(?:structural|historic|ground|signs? of|evidence of) movement\b|\bmovement cracks?\b|\bend of (?:its |their )?(?:useful )?(?:life|lifespan)\b`,
  String.raw`\b(?:dated|tired|poor|worn|shabby|derelict|dilapidated|uninhabitable|unmodernised|unmodernized|neglected|unfinished|incomplete)\b`,
  // tenure, charges and money
  String.raw`\b(?:short (?:lease|leasehold)|lease(?:hold)?|lease (?:length|term|extension)|unexpired|marriage value)\b`,
  String.raw`\b(?:charges?(?![- ]?points?)|ground rents?|fees?|costs?(?![- ]effective)|expensive|costly|surcharges?|arrears|debts?|deposit|penalt(?:y|ies)|buyer'?s'? premium|(?:lease|extension) premium|escalat\w*|sinking fund|reserve fund)\b`,
  String.raw`\b(?:rent|charges?|fees?|costs?|premium|bills?|payments?)\b[^.;,]{0,25}\b(?:doubl|increas|escalat|ris(?:e|es|en|ing)\b)\w*|\b(?:doubl(?:es|ing|ed)|increas\w*|rising)\b[^.;,]{0,25}\b(?:rent|charges?|fees?|costs?|premium|bills?|payments?)\b|\b(?:rent|charge) reviews?\b|\breview (?:clause|period)\b`,
  // restrictions, rights and occupation
  String.raw`\b(?:restrict\w*|covenants?|easements?|rights? of way|wayleaves?|unadopted|unregistered)\b`,
  String.raw`\bshared (?:driveway|drive|access|accessway|path|pathway|lane|road|ownership|equity|drainage|drains|septic tank|well|water supply|supply|services|roof|loft|boiler)\b|\b\d{1,3}% share\b|\bpart[- ](?:buy|rent)\b|\bstaircasing\b`,
  String.raw`\b(?:restricted|difficult|poor|steep|narrow|pedestrian|no vehicular|third[- ]party) access\b|\baccess (?:is )?(?:via|over|across|through) (?:a |an |the )?(?:shared|neighbour\w*|private|unadopted|third[- ]party|adjoining)\b`,
  String.raw`\b(?:tenanted|sitting tenants?|tenants? in situ|regulated tenancy|protected tenancy|assured tenancy|(?:currently|still) (?:let|occupied|tenanted))\b`,
  // how it's sold, mortgages and insurance
  String.raw`\b(?:probate|auction\w*|legal pack|reservation (?:fee|agreement)|modern method)\b|\bcash[- ](?:buyers?|purchasers?|purchase)\b(?!\s+welcome)|\bcash only\b`,
  String.raw`\b(?:un|non[- ])mortgageable\b|\buninsurable\b|\b(?:mortgage|lender)s? (?:restrictions?|issues?|problems?|unlikely|difficult\w*|criteria|may|might|concerns?|limitations?)\b|\b(?:difficult|hard|harder|unable|impossible) to (?:mortgage|insure|sell|resell|get a mortgage|obtain a mortgage|get insurance|let)\b|\b(?:insurance|insurer)s? (?:may|might|issues?|problems?|claims?|difficult\w*|excess)\b|\b(?:high|higher|expensive|costly) (?:insurance|premiums?)\b`,
  // building safety and construction
  String.raw`\b(?:cladding|ews ?1|external wall|remediation|building safety|fire (?:safety|risks?|damage|damaged|regulations?)|fire[- ]damaged|non[- ]standard|(?:timber|steel|concrete)[- ]framed?|concrete (?:construction|panels?|built|house|structure)|raac|prefab\w*|pre-?fabricated|prc|mundic|no[- ]fines|airey|system[- ]built|thatch\w*|flat roofs?|asbestos roof|corrugated)\b`,
  // planning and listing
  String.raw`\bplanning (?:enforcement|refus\w*|breach\w*|issues?|disputes?|objections?|conditions?|restrictions?|pending|applications?|appeal)\b|\b(?:subject to|retrospective|lapsed|refused|expired|awaiting|pending) planning\b|\b(?:enforcement|unauthori[sz]ed|retrospective|unapproved)\b`,
  String.raw`\b(?:grade (?:i{1,3}|[123])\*?|ii\*?) listed\b|\blisted (?:building|property|status|home|cottage|house)\b|\bconservation area\b|\barticle 4\b|\btree preservation\b|\btpos?\b`,
  // surroundings, services and energy
  String.raw`\b(?:noise|noisy|busy (?:main )?roads?|main road (?:position|location|frontage)|railway(?! station)|train line|flight ?paths?|pylons?|substation|overlooked|ex[- ](?:local authority|council|la)|above (?:a |the )?(?:shop|shops|commercial|restaurant|pub|takeaway|retail)|septic|cesspit|cesspool|private drainage|treatment plant|oil[- ]fired|oil (?:tank|heating|boiler)|lpg|off[- ](?:mains|grid|gas)|storage heaters?)\b`,
  String.raw`\b(?:fronts?|fronting|faces|facing|on|onto|overlooks?|overlooking|backs? onto|next to|beside|adjacent to) (?:a |the )?(?:busy |main )+road\b`,
  String.raw`\b(?:low|poor) epc\b|\b(?:epc|energy) (?:rating |band )?(?:of |is |: )?[e-g]\b`,
].join('|'), 'gi');

/** Work that's needed: "Needs updating", "Boiler may need replacing", "Repairs required", "Could benefit from…". Negated ("No work needed") doesn't count. */
const NEED = new RegExp([
  String.raw`\b(?:needs?|needing|needed|requires?|required|requiring|in need of|ripe for|calls? for)\s+(?:(?:a|an|the|some|full|complete|extensive|major|minor|general|new|total|significant|cosmetic|urgent|further|substantial|immediate|considerable|careful|specialist|professional|its|their)\s+)*(?:work|repair|attention|updat|modernis|moderniz|renovat|refurb|replac|improv|decorat|redecorat|rewir|re-?roof|re-?plaster|plaster|investigat|survey|treatment|underpin|upgrad|restor|tlc|planning|consent|approval|permission|lease extension|extend|extension|sign[- ]off|certificate|cash|structural|damp|boiler|roof|windows?|kitchen|bathroom|heating|electric|clear|completion|fixing|maintenance|servicing|checking|inspection)\w*`,
  String.raw`\b(?:work|works|repairs?|updating|modernisation|modernization|refurbishment|renovation|attention|improvements?|replacement|treatment|rewiring|investigation|tlc|maintenance)\s+(?:is |are |will be |may be |would be |might be |likely |probably )?(?:needed|required|necessary|recommended|outstanding|due|advised|planned|proposed|scheduled)\b`,
  String.raw`\b(?:could|would|will|might) benefit from\b|\bscope for improvement\b`,
  String.raw`\b(?:major|building|structural|remedial|planned|upcoming|future|section 20|external|roof|cladding) (?:works?|repairs?)\b`,
].join('|'), 'gi');

/**
 * Information or something basic that is missing: "No off-street parking", "Lease length not stated",
 * "Lift not working", "Not mortgageable", "Service charge unknown". "No onward chain", "No admin fees"
 * and "No service charge" aren't (nothing a buyer needs is missing).
 */
const NEEDED = String.raw`(?:parking|garage|driveway|heating|central heating|boiler|gas|mains|water|drainage|sewer\w*|electric\w*|broadband|internet|fibre|wi-?fi|signal|lift|kitchen|bathroom|shower|toilets?|wc|garden|outside space|outdoor space|storage|double[- ]glazing|glazing|windows?|access|rights? of way|planning|permission|consent|building (?:regulations?|regs|control)|regs|sign[- ]off|completion certificate|certificates?|guarantees?|warrant(?:y|ies)|survey|title|deeds|mortgage\w*|lenders?|insurance|insurable|licen[cs]es?|hmo|gas safety|eicr|smoke alarms?|epc|energy (?:performance|certificate|rating)|floor ?plans?|photos?|pictures?|images?|viewings?|deposit protection|details?|information|info|figures?|breakdown|mention|ventilation|extractor|fire (?:doors?|alarms?|escape|exits?)|alarms?|security)`;
const MISSING = new RegExp([
  String.raw`\b(?:no|not|without|lacks?|lacking|lack of|limited|missing|absence of|absent|unknown|unclear|unconfirmed|unverified|insufficient|inadequate|unspecified)\s+(?:(?!need\b|needs\b|needed\b|requirement)[a-z'-]+\s+){0,2}${NEEDED}\b(?!(?:\s+[a-z'-]+){0,2}\s+(?:issues?|problems?|concerns?|restrictions?|risks?|charges?|fees?|worries|needed|required|necessary)\b)`,
  String.raw`\b(?:not|isn't|aren't|wasn't|weren't|never)\s+(?:(?:yet|been|being)\s+)*(?:stated|given|provided|confirmed|known|shown|specified|disclosed|mentioned|listed|quoted|available|clear|included|supplied|verified|registered|signed off|approved|working|functioning|operational|connected|in use|accessible|allowed|permitted|suitable for (?:a )?(?:mortgage|lending|lenders))\b`,
  String.raw`\b(?:unknown|unclear|unconfirmed|unverified|unspecified|undisclosed|unstated|tbc|to be confirmed|missing|absent|awaiting|pending)\b|\boutstanding (?:works?|repairs?|charges?|balance|arrears|bills?|fees?|issues?|planning|matters?|enquiries)\b`,
  String.raw`\b(?:no|without)\s+(?:[a-z'-]+\s+){0,3}(?:given|stated|provided|shown|listed|mentioned|specified|disclosed|quoted|confirmed|supplied)\b`,
].join('|'), 'i');

const SENTENCE = /[.;:!?()]|\s-\s|\b(?:but|however|although|though)\b/;
const NOT_WORDS = /\b(?:no|not|never|without|zero|nil|none|nothing|free of|free from|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|hasn't|haven't|cannot|can't)\b/;
const LOW_WORDS = /\b(?:low|lower|minimal|negligible|reduced|little)\b/;
const NOT_AFTER = /^(?:[- ]free\b|\s*(?:[:-]\s*)?(?:none|nil|n\/a|not applicable|not present|not found)\b|\s*[:-]\s*(?:no|£0)\b)/;
const lastWords = (s: string, n: number) => s.trim().split(/\s+/).filter(Boolean).slice(-n).join(' ');

/**
 * Is the concern word at [from, to) negated? "No damp", "Low service charge", "Fee-free", "Damp: none", and the
 * later items of a list after "no" ("No damp, cracks or leaks"); not "No onward chain, cash buyers only".
 */
function negatedAt(u: string, from: number, to: number): boolean {
  if (NOT_AFTER.test(u.slice(to, to + 24))) return true;
  const sentence = u.slice(Math.max(0, from - 160), from).split(SENTENCE).pop() ?? '';
  const parts = sentence.split(',');
  const scope = parts.pop() ?? '';
  if (NOT_WORDS.test(lastWords(scope, 3)) || LOW_WORDS.test(lastWords(scope, 2))) return true;
  if (!parts.length || !NOT_WORDS.test(parts[0].trim().split(/\s+/).slice(0, 3).join(' '))) return false;
  // A list: "No damp, cracks or leaks" (this item is followed by "or …", or is the "or …" item itself).
  const rest = u.slice(to, to + 80).split(SENTENCE)[0];
  return /\b(?:or|nor|and)\b/.test(scope) || /^[^,]*\b(?:or|nor)\b/.test(rest);
}
const anyLive = (re: RegExp, u: string) => [...u.matchAll(re)].some((m) => !negatedAt(u, m.index ?? 0, (m.index ?? 0) + m[0].length));
const FLAT = { type: 'flat' } as const; // a title is checked on its own: let cladding count as it would for a flat

/**
 * Does a red flag's title name a concern rather than a feature: a risk, a defect, a cost, a restriction, missing
 * information or work needed? "Needs updating", "Shared driveway" and "Lift not working" do; "Recently refurbished
 * kitchen", "Modernised throughout", "No onward chain", "Spacious shared garden" and "No admin fees" don't.
 */
export function concernIn(s: string): boolean {
  const u = squash(s).replace(POSITIVE, ' ').replace(/\s+/g, ' ').trim();
  if (!u) return false;
  if (MISSING.test(u)) return true;
  if (anyLive(NEED, u) || anyLive(STRONG, u)) return true;
  if (conditionClues(u).some((c) => c.value !== 'good')) return true; // "requires modernisation", "renovation project", "dated"
  return topicsIn(u).some((t) => !!mention(u, t, FLAT));
}

/**
 * Wording about who a home suits, or about schools, safety, crime or communities. Streetkey never adds it
 * (Equality Act 2010: no demographic steering), even when the listing itself says it.
 */
const STEER_PEOPLE = /\byoung (professionals?|couples?|famil(y|ies))\b|\bprofessionals only\b|\bfamilies\b|\bfamily[- ](home|area|neighbourhood|friendly|street)\b|\b(retirees?|retired|pensioners?|elderly|older (people|residents|buyers))\b|\bcouples?\b|\bstudents?\b|\bdownsizers?\b|\bfirst[- ]time buyers?\b|\b(children|kids)\b|\bschools?\b|\bcatchment\b|\bsafe (area|neighbourhood|street|location|place)\b|\bcrime\b|\bcommunity\b|\b(ethnic\w*|religio\w*|church(es)?|mosques?|synagogues?|temples?|gurdwaras?)\b/i;
const STEER_SUITS = /\b(ideal|perfect|suits?|suited|great) for\b/i;
export const steers = (s: string) => STEER_PEOPLE.test(s) || STEER_SUITS.test(s);
/** Legal conclusions are left to the rules' careful wording (and to a solicitor), never to the model's free text. */
export const LEGAL_CLAIM = /\b(illegal(ly)?|unlawful(ly)?|breach(es|ed|ing)?|criminal|offences?|fraud(ulent)?|scams?|sue|lawsuits?|prosecut\w*|non[- ]compliant|banned|prohibited)\b/i;
