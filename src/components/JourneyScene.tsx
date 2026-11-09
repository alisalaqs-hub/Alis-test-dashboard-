import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProperty, PROPERTIES, type Property } from '../data/properties';
import { estimateRefurb } from '../engine/refurb';
import { epcPathway, loftScenario, refurbInputFor } from '../engine/insights';
import { transactionTax } from '../engine/tax';
import { gbp, gbpK } from './ui';
import {
  Backdrop, BAY, BAYS, Board, bayCentre, bayX, Defs, DAY, DOT_Y, fanPath, Figure, GROUND, Grow, Ground, Lamps, LampLight,
  mirrored, NIGHT, POTS_TOP, RIDGE, Scaffold, TreeShadows, Trees, Van, winRect, WINS, doorX,
} from './journey/art';
import { JourneyNotes, type Box, type NoteSpec, type View } from './journey/Notes';
import '../styles/journey.css';

/**
 * Streetkey journey: the homepage's living background.
 * A Victorian terrace, drawn as a fine-line architectural elevation, that plays a
 * story on a loop for a home buyer (Look → Buy → Move in → Live → Grow) or a
 * landlord (Scout → Buy → Refurb → Let → Portfolio). Every figure comes from the
 * engines and the demo listings.
 *
 * Interactive: switch journey, jump to a chapter, pause/play, hover a house for
 * its price / yield / sold price, click a house to open it, gentle parallax.
 * Callouts are placed so they never sit under the search panel or the journey bar.
 * Accessibility: the drawing and its callouts are aria-hidden (the caption carries
 * the same information); controls are real buttons; pause is always available
 * (WCAG 2.2.2); reduced motion starts paused with no movement; the story pauses
 * when it's off-screen. Night theme = the street at dusk.
 */
export type JourneyMode = 'buyer' | 'landlord';
const HOUSES = Array.from({ length: 8 }, (_, i) => ({ i, x: bayX(i), cx: bayX(i) + BAY / 2, m: mirrored(i) }));
const HERO = 5;                 // the buyer's home
const BUY_FOR_SALE = [3, 4, 5, 7]; // for sale on the buyer's street (hero is the 3rd)
const SOLD_ON = [0, 1, 2, 6];   // the street's recent sold prices
const LANDLORD_BUY = [5, 7];    // the landlord's two purchases
const SCHOOL: [number, number] = [1447, 404]; // the board school, under its bell turret
const LINE: [number, number] = [930, 459];    // the railway viaduct
const VB_FULL = [0, 0, 1600, 900] as const;
const VB_COMPACT = [700, 300, 920, 603] as const;
// Per-bay character: brick or painted fronts, door colours, hedge or railings.
const WALL = [0, 1, 0, 2, 0, 1, 3, 0, 4, 1, 0];
const DOOR = [3, 1, 0, 4, 2, 3, 1, 0, 5, 2, 4];
const HEDGE = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1];
const ROOF = ['rgba(255,255,255,.07)', 'transparent', 'rgba(20,24,40,.05)', 'rgba(255,255,255,.12)', 'transparent', 'rgba(20,24,40,.08)', 'rgba(255,255,255,.04)'];
/** At night some windows are lit, some not; the same pattern every time. */
const nightLit = (k: number, n: number) => ((Math.imul(k * 7 + n * 13 + 29, 2654435761) >>> 0) % 100) < 52;

// The locator dot: hops between the homes for sale (Look), scans the street (Scout), rests on the home.
const T = (i: number, lift = 0) => `transform:translate(${bayX(i) + BAY / 2}px,${DOT_Y - lift}px)`;
const MID = (a: number, b: number, lift: number) => `transform:translate(${(bayX(a) + bayX(b)) / 2 + BAY / 2}px,${DOT_Y - lift}px)`;
const EASE = 'animation-timing-function:cubic-bezier(.45,0,.55,1)';
const DOT_CSS = `.j-dot{${T(HERO)}}`
  + `@keyframes j-hop{0%,9%{${T(3)};${EASE}}17%{${MID(3, 4, 16)};${EASE}}25%,36%{${T(4)};${EASE}}50%{${MID(4, 7, 34)};${EASE}}64%,74%{${T(7)};${EASE}}82%{${MID(7, 5, 22)};${EASE}}90%,100%{${T(HERO)}}}`
  + `@keyframes j-scan{${HOUSES.map((h) => `${h.i * 12}%,${h.i * 12 + 4}%{${T(h.i)};${EASE}}`).join('')}100%{${T(7)}}}`;

type Stage = { label: string; caption: string };

function useNight() {
  const get = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches; };
  const [night, setNight] = useState(get);
  useEffect(() => {
    const mo = new MutationObserver(() => setNight(get())); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)'); const on = () => setNight(get()); mq?.addEventListener?.('change', on);
    return () => { mo.disconnect(); mq?.removeEventListener?.('change', on); };
  }, []);
  return night;
}
function useMedia(q: string) {
  const [c, setC] = useState(() => !!window.matchMedia?.(q).matches);
  useEffect(() => { const mq = window.matchMedia?.(q); const on = () => setC(!!mq?.matches); mq?.addEventListener?.('change', on); return () => mq?.removeEventListener?.('change', on); }, [q]);
  return c;
}

/** Size of the scene plus the boxes it must keep callouts clear of (search panel, journey bar), in px. */
function useLayoutBoxes(root: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [m, setM] = useState({ w: 0, h: 0, obs: [] as Box[] });
  useLayoutEffect(() => {
    const el = root.current; if (!el) return;
    const host = el.closest('section');
    const others = host ? [...host.querySelectorAll<HTMLElement>('.hero-copy, .journey-bar')] : [];
    let raf = 0;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const obs = others.map((o) => { const b = o.getBoundingClientRect(); return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height }; }).filter((b) => b.w && b.h);
      setM((p) => (p.w === r.width && p.h === r.height && JSON.stringify(p.obs) === JSON.stringify(obs) ? p : { w: r.width, h: r.height, obs }));
    };
    measure();
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
    ro.observe(el); others.forEach((o) => ro.observe(o));
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return m;
}

/** All the numbers the story tells, computed from the engines. */
function useStory() {
  return useMemo(() => {
    const hero = getProperty('wal-001')!;
    const forSale = [getProperty('cro-002')!, getProperty('ley-014')!, hero, getProperty('cro-013')!];
    const ftbTax = transactionTax(hero.price, hero.nation, 'first-time').total;
    const loft = loftScenario(hero);
    const heroWorks = estimateRefurb(refurbInputFor(hero)).total;
    const epc = epcPathway(hero);
    const epcTarget = epc.steps[epc.steps.length - 1]?.band ?? hero.epc.potential;
    const school = [...hero.schools].sort((a, b) => (b.rating === 'Outstanding' ? 1 : 0) - (a.rating === 'Outstanding' ? 1 : 0))[0];
    const sold = hero.comparables.filter((c) => c.kind === 'sold');
    const let0 = hero.comparables.find((c) => c.kind === 'let');
    // Landlord stock: base demo sale listings; the best gross yields sit on the two houses the landlord buys.
    const stock = PROPERTIES.filter((p) => !p.source && p.listing !== 'rent' && p.type !== 'commercial')
      .map((p) => ({ p, y: (p.estRentPcm * 12) / p.price })).sort((a, b) => b.y - a.y).slice(0, 8);
    const order: { p: Property; y: number }[] = new Array(8);
    order[LANDLORD_BUY[0]] = stock[0]; order[LANDLORD_BUY[1]] = stock[1];
    let n = 2; for (let i = 0; i < 8; i++) if (!order[i]) order[i] = stock[n++ % stock.length];
    const bought = LANDLORD_BUY.map((i) => order[i].p);
    const boughtTotal = bought.reduce((t, p) => t + p.price, 0);
    const boughtTax = bought.reduce((t, p) => t + transactionTax(p.price, p.nation, 'additional').total, 0);
    const works = bought.map((p) => estimateRefurb(refurbInputFor(p)));
    const worksTotal = works.reduce((t, e) => t + e.total, 0);
    const worksWeeks = Math.max(...works.map((e) => e.programmeWeeks));
    const rents = bought.map((p) => p.estRentPcm);
    const rentRoll = rents.reduce((a, b) => a + b, 0);
    const yieldOnCost = (rentRoll * 12) / (boughtTotal + boughtTax + worksTotal);
    // Buyer street: houses that aren't for sale show the street's real sold / let comparables.
    const buyerHouse = HOUSES.map((h) => {
      const fs = BUY_FOR_SALE.indexOf(h.i);
      if (fs >= 0) { const p = forSale[fs]; return { title: `For sale · ${p.beds} bed`, value: gbpK(p.price), label: `For sale · ${gbpK(p.price)} · ${p.beds} bed`, to: `/property/${p.id}` }; }
      const c = sold[SOLD_ON.indexOf(h.i)];
      if (c) return { title: `Sold · ${c.date}`, value: gbpK(c.price), label: `Sold ${gbpK(c.price)} · ${c.date}`, to: '/prices?q=E17' };
      return { title: let0 ? 'Let' : 'Not for sale', value: let0 ? `${gbp(let0.price)} pcm` : '', label: let0 ? `Let ${gbp(let0.price)} pcm` : 'Not for sale', to: '/prices?q=E17' };
    });
    return { hero, forSale, ftbTax, loft, heroWorks, epcTarget, school, order, bought, boughtTotal, boughtTax, worksTotal, worksWeeks, rents, rentRoll, yieldOnCost, buyerHouse };
  }, []);
}

export function JourneyScene() {
  const s = useStory();
  const night = useNight();
  const P = night ? NIGHT : DAY;
  const compact = useMedia('(max-width: 599px)');
  const nav = useNavigate();
  const capId = useId();
  const reduce = useMemo(() => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);
  const [mode, setMode] = useState<JourneyMode>('buyer');
  const [stage, setStage] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(!reduce);
  const [visible, setVisible] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const m = useLayoutBoxes(root, [compact, mode, stage]);

  const stages: Record<JourneyMode, Stage[]> = {
    buyer: [
      { label: 'Look', caption: 'Look: every home on the street comes priced, with the true cost of works, schools and travel.' },
      { label: 'Buy', caption: `Buy: offer accepted at ${gbp(s.hero.price)}. Stamp duty as a first-time buyer: ${gbp(s.ftbTax)}.` },
      { label: 'Move in', caption: 'Move in: keys collected, the van’s unloaded and the lights are on.' },
      { label: 'Live', caption: `Live: ${s.school ? `${s.school.rating} school ${s.school.distanceKm} km away, ` : ''}${s.hero.commute.minutes} min to ${s.hero.commute.to}.` },
      { label: 'Grow', caption: `Grow: renovate (about ${gbpK(s.heroWorks)}) and convert the loft (about ${gbpK(s.loft?.cost ?? 0)}). Estimated value after works ${gbpK(s.hero.estGdv + (s.loft?.valueUplift ?? 0))}, EPC ${s.hero.epc.current} → ${s.epcTarget}.` },
    ],
    landlord: [
      { label: 'Scout', caption: 'Scout: compare prices and gross yields on every house in the street before you view.' },
      { label: 'Buy', caption: `Buy: 2 homes for ${gbpK(s.boughtTotal)}. Stamp duty at additional-property rates: ${gbp(s.boughtTax)}.` },
      { label: 'Refurb', caption: `Refurb: works about ${gbpK(s.worksTotal)} incl. VAT, ${s.worksWeeks} weeks on site.` },
      { label: 'Let', caption: `Let: ${s.rents.map((r) => gbp(r)).join(' + ')} pcm. Deposits protected, right-to-rent checked.` },
      { label: 'Portfolio', caption: `Portfolio: rent roll ${gbp(s.rentRoll)} a month, ${(s.yieldOnCost * 100).toFixed(1)}% gross yield on total cost.` },
    ],
  };
  const list = stages[mode];
  const running = playing && visible;

  // Pause when off-screen.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  // Header logo (on the home page) restarts the journey.
  useEffect(() => {
    const t = () => { setStage(0); setNonce((n) => n + 1); setPlaying(true); };
    window.addEventListener('streetkey:turn', t);
    return () => window.removeEventListener('streetkey:turn', t);
  }, []);

  // Gentle parallax from the pointer anywhere over the hero (the distance drifts, the street holds still).
  useEffect(() => {
    if (reduce) return;
    const el = root.current; const host = el?.closest('section'); if (!el || !host) return;
    let raf = 0;
    const move = (e: PointerEvent) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const r = host.getBoundingClientRect(); el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3)); }); };
    host.addEventListener('pointermove', move);
    return () => { host.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [reduce]);

  // Drawing units → screen px (preserveAspectRatio xMidYMax slice).
  const [vbx, vby, vbw, vbh] = compact ? VB_COMPACT : VB_FULL;
  const view: View = useMemo(() => {
    const sc = m.w && m.h ? Math.max(m.w / vbw, m.h / vbh) : 1;
    return { w: m.w, h: m.h, sc, ox: (m.w - vbw * sc) / 2, oy: m.h - vbh * sc, vbx, vby, clear: (DOT_Y - POTS_TOP) * sc + 10 };
  }, [m.w, m.h, vbx, vby, vbw, vbh]);

  const pick = (m2: JourneyMode) => { if (m2 !== mode) { setMode(m2); setStage(0); } };
  const go = (i: number) => { if (i === stage) setNonce((n) => n + 1); setStage(i); };
  const next = () => { if (running) setStage((x) => (x + 1) % 5); };
  const B = mode === 'buyer', L = !B;
  const st = stage;
  const on = (c: boolean) => (c ? ' on' : '');

  const storyLit = (i: number) => hover === i || (B && i === HERO && st >= 2) || (L && LANDLORD_BUY.includes(i) && st >= 3);
  const doorOpen = (i: number) => (B && i === HERO && st >= 2) || (L && LANDLORD_BUY.includes(i) && st >= 3);
  const hoverTo = (i: number) => (B ? s.buyerHouse[i].to : `/invest?property=${s.order[i].p.id}`);
  const ridge = (i: number): [number, number] => [HOUSES[i].cx, DOT_Y];
  const pct = (y: number) => `${(y * 100).toFixed(1)}%`;

  const notes: NoteSpec[] = [];
  if (B) {
    BUY_FOR_SALE.forEach((i, n) => notes.push({ id: `fs${i}`, on: st === 0, at: [ridge(i)], title: `For sale · ${s.forSale[n].beds} bed`, short: 'For sale', value: gbpK(s.forSale[n].price), accent: i === HERO, d: n }));
    notes.push({ id: 'offer', on: st === 1, at: [ridge(HERO)], title: 'Offer accepted', value: gbp(s.hero.price), rows: [[compact ? 'Stamp duty' : 'Stamp duty · first-time buyer', gbp(s.ftbTax)]], accent: true, dot: true });
    notes.push({ id: 'keys', on: st === 2, at: [ridge(HERO)], title: 'Completion', value: 'Keys collected', accent: true, dot: true });
    if (s.school) notes.push({ id: 'school', on: st === 3, at: [SCHOOL], title: `${s.school.rating} school`, value: `${s.school.distanceKm} km`, d: 1 });
    notes.push({ id: 'travel', on: st === 3, at: [LINE], title: `To ${s.hero.commute.to}`, value: `${s.hero.commute.minutes} min`, accent: true });
    notes.push({ id: 'grow', on: st === 4, at: [ridge(HERO)], title: 'Value after works', value: gbpK(s.hero.estGdv + (s.loft?.valueUplift ?? 0)), rows: [...(s.loft ? [['Loft conversion', `+${s.loft.area} m²`] as [string, string]] : []), ['Energy rating', `EPC ${s.hero.epc.current} → ${s.epcTarget}`]], accent: true, dot: true });
  } else {
    HOUSES.forEach((h) => notes.push({ id: `y${h.i}`, on: st === 0, at: [ridge(h.i)], title: `${pct(s.order[h.i].y)} yield`, short: pct(s.order[h.i].y), value: gbpK(s.order[h.i].p.price), accent: LANDLORD_BUY.includes(h.i), d: h.i }));
    const pair = LANDLORD_BUY.map(ridge);
    notes.push({ id: 'bought', on: st === 1, at: pair, title: '2 homes bought', value: gbpK(s.boughtTotal), rows: [[compact ? 'Stamp duty' : 'Stamp duty · additional rate', gbp(s.boughtTax)]], accent: true });
    notes.push({ id: 'works', on: st === 2, at: pair, title: 'Refurbishment', value: `${gbpK(s.worksTotal)} incl. VAT`, rows: [['On site', `${s.worksWeeks} weeks`]] });
    LANDLORD_BUY.forEach((i, n) => notes.push({ id: `r${i}`, on: st === 3, at: [ridge(i)], title: 'Let agreed', value: `${gbp(s.rents[n])} pcm`, accent: true, d: n }));
    notes.push({ id: 'roll', on: st === 4, at: pair, title: 'Rent roll', value: `${gbp(s.rentRoll)} a month`, rows: [[compact ? 'Yield on cost' : 'Gross yield on total cost', pct(s.yieldOnCost)], [compact ? 'Gas · EICR · EPC' : 'Gas safety · EICR · EPC', 'In date']], accent: true });
  }
  const hoverNote: NoteSpec | null = hover == null ? null : B
    ? { id: 'hover', on: true, at: [ridge(hover)], title: s.buyerHouse[hover].title, value: s.buyerHouse[hover].value, dot: hover === HERO && st > 0 }
    : { id: 'hover', on: true, at: [ridge(hover)], title: `${pct(s.order[hover].y)} gross yield`, value: gbpK(s.order[hover].p.price) };

  return (
    <>
      <div ref={root} className={`journey${running ? '' : ' is-paused'}${night ? ' night' : ''}${hover != null ? ' hovering' : ''}`} data-mode={mode} data-stage={st}>
        <svg key={nonce} viewBox={`${vbx} ${vby} ${vbw} ${vbh}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
          <style>{DOT_CSS}</style>
          <Defs P={P} />
          <Backdrop P={P} train={B && st === 3} />

          {/* The terrace */}
          <g className="j-near">
            {BAYS.map((k, n) => {
              const x = bayX(k), mm = mirrored(k), story = k >= 0 && k < 8;
              const lit = WINS.map((_, w) => (story && storyLit(k)) || (night && nightLit(k, w)));
              const fanLit = (story && storyLit(k)) || (night && nightLit(k, 6));
              const style = { ['--wall' as string]: P.walls[WALL[n]], ['--door' as string]: P.doors[DOOR[n]], ['--roof' as string]: night ? 'transparent' : ROOF[n % ROOF.length], ['--i' as string]: n } as CSSProperties;
              const body = (
                <>
                  <use href={mm ? '#j-front-b' : '#j-front-a'} x={x} />
                  <g transform={`translate(${x} 0)`}>
                    {WINS.map((_, w) => { const [wx, wy, ww, wh] = winRect(w, mm); return <rect key={w} className={`j-lw${on(lit[w])}`} style={{ ['--n' as string]: w } as CSSProperties} x={wx} y={wy} width={ww} height={wh} fill="url(#j-lit)" />; })}
                    <path className={`j-lw${on(fanLit)}`} style={{ ['--n' as string]: 6 } as CSSProperties} d={fanPath(mm)} fill="url(#j-lit)" />
                  </g>
                  <use href={mm ? '#j-bars-b' : '#j-bars-a'} x={x} />
                </>
              );
              if (!story) return <g key={k} style={style} className="j-np">{body}</g>;
              const i = k, isHero = i === HERO;
              const forSale = B && BUY_FOR_SALE.includes(i) && (st === 0 || (st === 1 && !isHero));
              const sold = B && isHero && st >= 1 && st <= 2;
              const bought = L && LANDLORD_BUY.includes(i);
              const board: 'sale' | 'sold' | 'let' | null = forSale ? 'sale' : sold || (bought && st === 1) ? 'sold' : bought && st >= 3 ? 'let' : null;
              const dx = doorX(mm);
              return (
                <g key={k} style={style} className={`j-house${hover === i ? ' is-hover' : ''}`}
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => nav(hoverTo(i))}>
                  {body}
                  <g transform={`translate(${x} 0)`}>
                    {(isHero || LANDLORD_BUY.includes(i)) && (
                      <g className={`j-doorway${on(doorOpen(i))}`}>
                        <rect x={dx - 11.5} y={692} width={23} height={60} fill="url(#j-lit)" />
                        <rect className={`j-leaf${mm ? ' m' : ''}`} x={dx - 11.5} y={692} width={23} height={60} style={{ fill: 'var(--door)' }} />
                        <polygon points={`${dx - 13},752 ${dx + 13},752 ${dx + 22},770 ${dx - 22},770`} fill="url(#j-spill)" />
                      </g>
                    )}
                    {isHero && <g className={`j-grow${on(B && st === 4)}`}><Grow m={mm} P={P} /></g>}
                    {bought && <g className={`j-scaffold${on(st === 2)}`}><Scaffold P={P} /></g>}
                    <g className={`j-board${on(!!board)}`}><Board cx={bayCentre(mm)} kind={board ?? 'sale'} P={P} /></g>
                    <rect className="j-hit" x={0} y={RIDGE - 40} width={BAY} height={GROUND - RIDGE + 40} />
                  </g>
                </g>
              );
            })}
            <g className="j-np">{[...BAYS, 9].map((k) => <use key={k} href="#j-stack" x={bayX(k)} />)}</g>
            <rect className="j-np" x={-160} y={440} width={1920} height={GROUND - 440} fill="url(#j-warm)" />
            <rect className="j-np" x={-160} y={690} width={1920} height={GROUND - 690} fill="url(#j-ao)" />
            <TreeShadows P={P} />
            <g className="j-np">{BAYS.map((k, n) => <use key={k} href={HEDGE[n] ? '#j-garden-h' : '#j-garden-r'} x={bayX(k)} transform={mirrored(k) ? `translate(${2 * bayX(k) + BAY} 0) scale(-1 1)` : undefined} />)}</g>
            <Ground P={P} />
            <Lamps P={P} />

            {/* Scale figures and the van: quiet silhouettes, as on an architect's drawing */}
            <g className={`j-np j-buyer${on(B && st === 0)}`}><Figure x={1052} kind="woman" P={P} /><Figure x={1066} kind="man" P={P} /></g>
            <g className={`j-np j-family${on(B && st >= 2)}`}><Figure x={1082} kind="woman" P={P} /><Figure x={1146} kind="man" P={P} flip /></g>
            <g className={`j-np j-kid${on(B && st >= 3)}`}><Figure x={1093} kind="child" P={P} /></g>
            <g className={`j-np j-tenants${on(L && st >= 3)}`}><Figure x={1090} kind="woman" P={P} /><Figure x={1408} kind="man" P={P} /><Figure x={1466} kind="woman" P={P} flip /></g>
            <Trees P={P} />
            <LampLight P={P} />
            <g className={`j-np j-van${on(st === 2)}`}><Van x={1166} P={P} /></g>

            <g className={`j-np j-dot${B && st === 0 ? ' hop' : L && st === 0 ? ' scan' : ''}${on(B || st === 0)}`}>
              <circle r="16" className="j-anim j-halo" fill="#F07415" />
              <circle r="6.6" fill="#F07415" stroke={night ? '#121A33' : '#FFFFFF'} strokeWidth="2.4" />
            </g>
          </g>
        </svg>
        <JourneyNotes specs={notes} hover={hoverNote} view={view} obs={m.obs} compact={compact} />
      </div>

      <div className="journey-bar" role="group" aria-label="The Streetkey journey">
        <div className="jb-top">
          <span className="label-mono jb-label">The journey</span>
          <div className="seg jb-mode" role="group" aria-label="Choose a journey">
            {(['buyer', 'landlord'] as JourneyMode[]).map((x) => <button key={x} type="button" aria-pressed={mode === x} className={mode === x ? 'on' : ''} onClick={() => pick(x)}>{x === 'buyer' ? 'Home buyer' : 'Landlord'}</button>)}
          </div>
          <button type="button" className="icon-btn jb-play" aria-label={playing ? 'Pause the journey' : 'Play the journey'} onClick={() => setPlaying((p) => !p)}>
            {playing ? <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
          </button>
        </div>
        <ol className="jb-steps">
          {list.map((x, i) => (
            <li key={x.label}>
              <button type="button" className={i === st ? 'on' : i < st ? 'done' : ''} aria-current={i === st ? 'step' : undefined} aria-describedby={i === st ? capId : undefined} onClick={() => go(i)}>
                <span className="jb-n" aria-hidden="true">{i + 1}</span>{x.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="jb-progress" aria-hidden="true">
          <i key={`${mode}-${st}-${nonce}`} className={running ? '' : 'paused'} onAnimationEnd={next} />
        </div>
        <p className="jb-caption" id={capId}>{list[st].caption}</p>
      </div>
    </>
  );
}

