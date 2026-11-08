import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProperty, PROPERTIES, type Property } from '../data/properties';
import { estimateRefurb } from '../engine/refurb';
import { epcPathway, loftScenario, refurbInputFor } from '../engine/insights';
import { transactionTax } from '../engine/tax';
import { gbp, gbpK } from './ui';

/**
 * Streetkey journey: the homepage's living background.
 * A street that plays a story on a loop, for a home buyer
 * (Look → Buy → Move in → Live → Grow) or a landlord (Scout → Buy → Refurb →
 * Let → Portfolio). Every figure comes from the engines and the demo listings.
 *
 * Interactive: switch journey, jump to a chapter, pause/play, hover a house for
 * its price / yield / sold price, click a house to open it, parallax on pointer.
 * Tags are placed so they never sit under the search panel or the journey bar,
 * and scale up on small screens so they stay readable.
 * Accessibility: the drawing is aria-hidden; controls are real buttons; pause is
 * always available (WCAG 2.2.2); reduced motion starts paused with no movement;
 * the story pauses when it's off-screen. Night theme = night street.
 */
export type JourneyMode = 'buyer' | 'landlord';
const GROUND = 770;
const HOUSES = [
  [230, 130, 70], [390, 150, 78], [550, 120, 66], [710, 165, 84],
  [870, 140, 72], [1030, 155, 80], [1190, 128, 70], [1350, 160, 76],
].map(([x, wall, roof], i) => ({ i, x, w: 120, wall, roof, top: GROUND - wall - roof, cx: x + 60 }));
const HERO = 5;                 // the buyer's home
const BUY_FOR_SALE = [3, 4, 5, 7]; // for sale on the buyer's street (hero is the 3rd)
const SOLD_ON = [0, 1, 2, 6];   // the street's recent sold prices
const LANDLORD_BUY = [5, 7];    // the landlord's two purchases
const SCHOOL_X = 1488;
const VB_FULL = [0, 0, 1600, 900] as const;
const VB_COMPACT = [720, 310, 900, 590] as const;

type Box = { x: number; y: number; w: number; h: number };
type Geo = { k: number; x0: number; x1: number; y0: number; obs: Box[] };

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

/** Size of the scene plus the boxes it must keep tags clear of (search panel, journey bar), in px. */
function useLayoutBoxes(root: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [m, setM] = useState({ w: 0, h: 0, obs: [] as Box[] });
  useLayoutEffect(() => {
    const el = root.current; if (!el) return;
    const host = el.closest('section');
    const others = host ? [...host.querySelectorAll<HTMLElement>('.hero-copy, .journey-bar')] : [];
    let raf = 0;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const obs = others.map((o) => { const b = o.getBoundingClientRect(); return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height }; });
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
      if (fs >= 0) { const p = forSale[fs]; return { label: `For sale · ${gbpK(p.price)} · ${p.beds} bed`, to: `/property/${p.id}` }; }
      const c = sold[SOLD_ON.indexOf(h.i)];
      if (c) return { label: `Sold ${gbpK(c.price)} · ${c.date}`, to: '/prices?q=E17' };
      return { label: let0 ? `Let ${gbp(let0.price)} pcm` : 'Not for sale', to: '/prices?q=E17' };
    });
    return { hero, forSale, ftbTax, loft, heroWorks, epcTarget, school, order, bought, boughtTotal, boughtTax, worksTotal, worksWeeks, rents, rentRoll, yieldOnCost, buyerHouse };
  }, []);
}

type Stage = { label: string; caption: string };
type PillSpec = { id: string; on: boolean; x: number; y: number; text: string; anchor?: number; accent?: boolean; d?: number };

export function JourneyScene() {
  const s = useStory();
  const night = useNight();
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

  // Gentle parallax from the pointer anywhere over the hero.
  useEffect(() => {
    if (reduce) return;
    const el = root.current; const host = el?.closest('section'); if (!el || !host) return;
    let raf = 0;
    const move = (e: PointerEvent) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const r = host.getBoundingClientRect(); el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3)); }); };
    host.addEventListener('pointermove', move);
    return () => { host.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [reduce]);

  // Screen px → drawing units (preserveAspectRatio xMidYMax slice).
  const [vbx, vby, vbw, vbh] = compact ? VB_COMPACT : VB_FULL;
  const geo: Geo = useMemo(() => {
    if (!m.w || !m.h) return { k: 1, x0: vbx, x1: vbx + vbw, y0: vby, obs: [] };
    const sc = Math.max(m.w / vbw, m.h / vbh);
    const ox = (m.w - vbw * sc) / 2, oy = m.h - vbh * sc;
    const ux = (px: number) => vbx + (px - ox) / sc, uy = (py: number) => vby + (py - oy) / sc;
    return {
      k: Math.min(1.9, Math.max(1, 12 / (14 * sc))),
      x0: ux(0), x1: ux(m.w), y0: uy(0),
      obs: m.obs.filter((b) => b.w && b.h).map((b) => ({ x: ux(b.x), y: uy(b.y), w: b.w / sc, h: b.h / sc })),
    };
  }, [m, vbx, vby, vbw, vbh]);
  const k = geo.k;
  const lift = (top: number, high = false) => top - 55 - 16 * k - (high ? 32 * k + 12 : 0);

  const pick = (m2: JourneyMode) => { if (m2 !== mode) { setMode(m2); setStage(0); } };
  const go = (i: number) => { if (i === stage) setNonce((n) => n + 1); setStage(i); };
  const next = () => { if (running) setStage((x) => (x + 1) % 5); };
  const B = mode === 'buyer', L = !B;
  const st = stage;
  const on = (c: boolean) => (c ? ' on' : '');

  const lit = (i: number) => night || hover === i || (B && i === HERO && st >= 2) || (L && LANDLORD_BUY.includes(i) && st >= 3);
  const hoverLabel = (i: number) => (B ? s.buyerHouse[i].label : `${gbpK(s.order[i].p.price)} · ${(s.order[i].y * 100).toFixed(1)}% gross yield`);
  const hoverTo = (i: number) => (B ? s.buyerHouse[i].to : `/invest?property=${s.order[i].p.id}`);
  const hero = HOUSES[HERO];
  const schoolsY = GROUND - 226 - 16 * k;

  const pills: PillSpec[] = [];
  if (B) {
    BUY_FOR_SALE.forEach((i, n) => pills.push({ id: `fs${i}`, on: st === 0, x: HOUSES[i].cx, y: lift(HOUSES[i].top, n % 2 === 1), anchor: HOUSES[i].top, text: gbpK(s.forSale[n].price), accent: i === HERO, d: n }));
    pills.push({ id: 'offer', on: st === 1, x: hero.cx, y: lift(hero.top), anchor: hero.top, text: `Offer accepted · ${gbpK(s.hero.price)}`, accent: true });
    pills.push({ id: 'sdlt', on: st === 1, x: hero.cx, y: lift(hero.top, true), text: `Stamp duty ${gbp(s.ftbTax)}` });
    pills.push({ id: 'keys', on: st === 2, x: hero.cx, y: lift(hero.top), anchor: hero.top, text: 'Keys collected', accent: true });
    if (s.school) pills.push({ id: 'school', on: st === 3, x: SCHOOL_X + 55, y: schoolsY, anchor: GROUND - 196, text: `${s.school.rating} school · ${s.school.distanceKm} km`, d: 1 });
    pills.push({ id: 'travel', on: st === 3, x: 960, y: schoolsY - 32 * k - 16, text: `${s.hero.commute.minutes} min to ${s.hero.commute.to}`, accent: true });
    if (s.loft) pills.push({ id: 'value', on: st === 4, x: hero.cx, y: lift(hero.top, true), text: `After works ${gbpK(s.hero.estGdv + s.loft.valueUplift)}`, accent: true });
    pills.push({ id: 'loft', on: st === 4, x: hero.cx - 230, y: lift(HOUSES[4].top), text: `Loft +${s.loft?.area ?? 0}m² · EPC ${s.hero.epc.current} → ${s.epcTarget}`, d: 1 });
  } else {
    HOUSES.forEach((h) => pills.push({ id: `y${h.i}`, on: st === 0, x: h.cx, y: lift(h.top, h.i % 2 === 1), anchor: h.top, text: `${gbpK(s.order[h.i].p.price)} · ${(s.order[h.i].y * 100).toFixed(1)}%`, accent: LANDLORD_BUY.includes(h.i), d: h.i }));
    const topY = lift(Math.min(HOUSES[5].top, HOUSES[7].top), true);
    pills.push({ id: 'bought', on: st === 1, x: 1250, y: topY, text: `2 homes · ${gbpK(s.boughtTotal)} · SDLT ${gbpK(s.boughtTax)}`, accent: true });
    pills.push({ id: 'works', on: st === 2, x: 1250, y: topY, text: `Works ${gbpK(s.worksTotal)} · ${s.worksWeeks} weeks` });
    LANDLORD_BUY.forEach((i, n) => pills.push({ id: `r${i}`, on: st === 3, x: HOUSES[i].cx, y: lift(HOUSES[i].top), anchor: HOUSES[i].top, text: `${gbp(s.rents[n])} pcm`, accent: true, d: n }));
    pills.push({ id: 'roll', on: st === 4, x: 1250, y: topY, text: `Rent roll ${gbp(s.rentRoll)}/mo · ${(s.yieldOnCost * 100).toFixed(1)}%`, accent: true });
    pills.push({ id: 'comply', on: st === 4, x: 1250, y: topY + 32 * k + 12, text: 'Gas safe ✓  EICR ✓  EPC ✓', d: 1 });
  }

  return (
    <>
      <div ref={root} className={`journey${running ? '' : ' is-paused'}${night ? ' night' : ''}${hover != null ? ' hovering' : ''}`} data-mode={mode} data-stage={st}>
        <svg key={nonce} viewBox={`${vbx} ${vby} ${vbw} ${vbh}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="j-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={night ? '#121A33' : '#F7F5F0'} />
              <stop offset="0.45" stopColor={night ? '#121A33' : '#F7F5F0'} />
              <stop offset="0.8" stopColor={night ? '#2B3870' : '#FBE3CB'} />
              <stop offset="1" stopColor={night ? '#34437A' : '#F9D9B8'} />
            </linearGradient>
          </defs>
          <rect x="-60" y="-60" width="1720" height="1020" fill="url(#j-sky)" />

          {/* Far layer: sun / moon, clouds, skyline, viaduct + train */}
          <g className="j-far">
            {night ? <g transform="translate(1240 170)"><circle r="30" fill="#F4EFE3" /><circle cx="12" cy="-8" r="25" fill="#1C2650" /></g> : <circle cx="1240" cy="190" r="36" fill="#FFB547" opacity="0.7" />}
            {night && [[300, 90], [520, 160], [760, 70], [980, 140], [1320, 90], [1460, 200], [140, 220], [640, 250], [1100, 260], [1540, 120], [860, 330], [1420, 330]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" fill="#FFFFFF" opacity="0.85" />)}
            <g className="j-anim j-cloud" opacity={night ? 0.07 : 0.95}><ellipse cx="760" cy="230" rx="70" ry="22" fill="#FFFFFF" /><ellipse cx="810" cy="215" rx="44" ry="20" fill="#FFFFFF" /></g>
            <g className="j-anim j-cloud j-cloud2" opacity={night ? 0.06 : 0.85}><ellipse cx="1420" cy="300" rx="80" ry="22" fill="#FFFFFF" /><ellipse cx="1380" cy="286" rx="46" ry="20" fill="#FFFFFF" /></g>
            <g fill={night ? '#0B1128' : '#0E1424'} opacity={night ? 0.55 : 0.07}>
              {[[-60, 90], [10, 70], [80, 120], [160, 60], [230, 140], [310, 90], [390, 170], [470, 80], [550, 130], [630, 210], [710, 110], [790, 150], [870, 90], [950, 180], [1030, 120], [1110, 70], [1190, 160], [1270, 100], [1350, 140], [1430, 80], [1510, 130], [1590, 100]].map(([x, h]) => <rect key={x} x={x} y={600 - h} width="72" height={h} />)}
              {night && [[640, 410], [660, 440], [960, 440], [1200, 460], [400, 450]].map(([x, y]) => <rect key={`w${x}`} x={x} y={y} width="8" height="10" fill="#FFC24B" opacity="0.7" />)}
            </g>
            <g opacity={night ? 0.8 : 0.22} fill="#0E1424">
              <rect x="-60" y="600" width="1720" height="8" />
              {Array.from({ length: 22 }, (_, n) => <path key={n} d={`M${n * 80 - 60} 608 v34 h14 v-14 a26 26 0 0 1 52 0 v14 h14 v-34 z`} />)}
            </g>
            <g className={`j-anim j-train${on(B && st === 3)}`}>
              <rect x="0" y="569" width="330" height="31" rx="10" fill="#0E1424" />
              <rect x="300" y="569" width="30" height="31" rx="10" fill="#F07415" />
              {Array.from({ length: 8 }, (_, n) => <rect key={n} x={16 + n * 35} y="576" width="22" height="12" rx="3" fill="#FFC24B" />)}
            </g>
          </g>

          {/* Street */}
          <g className="j-near">
            <rect x="-60" y={GROUND} width="1720" height="20" fill={night ? '#26315E' : '#E3DED3'} />
            <rect x="-60" y={GROUND + 20} width="1720" height="78" fill="#0E1424" />
            <rect x="-60" y={GROUND + 98} width="1720" height="80" fill={night ? '#26315E' : '#E3DED3'} />
            <line x1="150" y1={GROUND + 56} x2="1660" y2={GROUND + 56} stroke={night ? '#3A4682' : '#F7F5F0'} strokeOpacity={night ? 1 : 0.7} strokeWidth="4" strokeDasharray="22 18" />
            {/* the road is the key's blade: the bow and locator dot sit at its left end */}
            <circle cx="70" cy={GROUND + 56} r="52" fill={night ? '#121A33' : '#F7F5F0'} stroke="#0E1424" strokeWidth="24" />
            <circle cx="70" cy={GROUND + 56} r="14" fill="#F07415" />

            {/* street trees & school */}
            {[1010, 1330].map((x) => <g key={x}><rect x={x - 3} y={GROUND - 60} width="6" height="60" fill="#0E1424" /><circle cx={x} cy={GROUND - 74} r="24" fill={night ? '#2E5B4A' : '#7FA88A'} /></g>)}
            <g className="j-school">
              <rect x={SCHOOL_X} y={GROUND - 120} width="110" height="120" fill="#0E1424" />
              <polygon points={`${SCHOOL_X - 10},${GROUND - 120} ${SCHOOL_X + 55},${GROUND - 160} ${SCHOOL_X + 120},${GROUND - 120}`} fill="#0E1424" />
              <circle cx={SCHOOL_X + 55} cy={GROUND - 133} r="9" style={{ fill: night || (B && st === 3) ? '#FFC24B' : '#F7F5F0' }} className="j-win" />
              <line x1={SCHOOL_X + 55} y1={GROUND - 160} x2={SCHOOL_X + 55} y2={GROUND - 196} stroke="#0E1424" strokeWidth="3" /><rect x={SCHOOL_X + 56} y={GROUND - 196} width="24" height="14" fill="#F07415" />
              {[14, 44, 74].map((d) => <rect key={d} className="j-win" x={SCHOOL_X + d} y={GROUND - 92} width="18" height="20" style={{ fill: night || (B && st === 3) ? '#FFC24B' : '#F7F5F0' }} />)}
              <rect x={SCHOOL_X + 44} y={GROUND - 40} width="22" height="40" fill={night ? '#2B3870' : '#E3DED3'} />
            </g>

            {HOUSES.map((h) => {
              const isHero = h.i === HERO;
              const forSale = B && BUY_FOR_SALE.includes(h.i) && (st === 0 || (st === 1 && !isHero));
              const sold = B && isHero && st >= 1 && st <= 2;
              const bought = L && LANDLORD_BUY.includes(h.i);
              const boardOn = forSale || sold || (bought && st >= 1);
              const kb = Math.min(k, 1.5);
              const bx = h.x + h.w - 26;
              return (
                <g key={h.i} className={`j-house${hover === h.i ? ' up' : ''}`} style={{ ['--i' as string]: h.i }}
                  onPointerEnter={() => setHover(h.i)} onPointerLeave={() => setHover(null)} onClick={() => nav(hoverTo(h.i))}>
                  {h.i === 3 && <rect x={h.x + 84} y={h.top + 14} width="14" height="44" fill="#0E1424" />}
                  <polygon points={`${h.x},${GROUND} ${h.x},${GROUND - h.wall} ${h.cx},${h.top} ${h.x + h.w},${GROUND - h.wall} ${h.x + h.w},${GROUND}`} fill="#0E1424" />
                  {[[h.x + 18, GROUND - h.wall + 24], [h.x + 74, GROUND - h.wall + 24], [h.x + 18, GROUND - 74]].map(([x, y], n) =>
                    <rect key={n} className="j-win" x={x} y={y} width="28" height="28" style={{ fill: lit(h.i) ? '#FFC24B' : night ? '#2B3870' : '#F7F5F0' }} />)}
                  <rect className="j-win" x={h.cx + 6} y={GROUND - 52} width="26" height="52" style={{ fill: isHero && B && st >= 2 ? '#F07415' : night ? '#2B3870' : '#E3DED3' }} />
                  {/* Grow: loft dormer + solar panels on the buyer's home */}
                  {isHero && <g className={`j-grow${on(B && st === 4)}`}>
                    <rect x={h.cx + 4} y={h.top + 34} width="38" height="34" fill="#0E1424" stroke="#F7F5F0" strokeWidth="2" />
                    <rect x={h.cx + 12} y={h.top + 42} width="22" height="18" fill="#FFC24B" />
                    <polygon points={`${h.x + 16},${GROUND - h.wall - 6} ${h.cx - 14},${h.top + 32} ${h.cx - 4},${h.top + 44} ${h.x + 28},${GROUND - h.wall + 4}`} fill="#2A55B8" stroke="#8EC5FF" strokeWidth="2" />
                  </g>}
                  {/* Refurb scaffolding */}
                  {bought && <g className={`j-scaffold${on(st === 2)}`} stroke="#FFC24B" strokeWidth="4">
                    {[-8, 60, 128].map((d) => <line key={d} x1={h.x + d} y1={GROUND} x2={h.x + d} y2={GROUND - h.wall - 12} />)}
                    {[40, 90, 140].map((d) => <line key={d} x1={h.x - 12} y1={GROUND - d} x2={h.x + h.w + 12} y2={GROUND - d} />)}
                  </g>}
                  {/* Boards */}
                  <g className={`j-board${on(boardOn)}`} transform={`translate(${bx} ${GROUND}) scale(${kb}) translate(${-bx} ${-GROUND})`}>
                    <line x1={bx} y1={GROUND - 66} x2={bx} y2={GROUND + 10} stroke="#0E1424" strokeWidth="4" />
                    <rect x={bx - 44} y={GROUND - 96} width="88" height="32" rx="4" fill={sold || (bought && st >= 3) ? '#F07415' : '#FFFFFF'} stroke="#0E1424" strokeWidth="3" />
                    <text x={bx} y={GROUND - 74} textAnchor="middle" className="j-board-t" fill="#0E1424">{sold ? 'SOLD' : bought ? (st >= 3 ? 'LET' : st === 2 ? 'WORKS' : 'BOUGHT') : 'FOR SALE'}</text>
                  </g>
                </g>
              );
            })}

            {/* People & vehicles */}
            <g className="j-anim j-car"><rect x="0" y={GROUND + 66} width="58" height="20" rx="8" fill="#F07415" /><rect x="14" y={GROUND + 57} width="28" height="12" rx="5" fill="#F07415" /><rect x="20" y={GROUND + 59} width="16" height="7" rx="2" fill="#0E1424" opacity="0.6" /></g>
            <g className={`j-anim j-buyer${on(B && st === 0)}`}><Person x={0} /><rect x="16" y={GROUND - 34} width="8" height="13" rx="2" fill="#FFC24B" /></g>
            <g className={`j-family${on(B && st >= 2)}`}><Person x={1040} /><Person x={1066} tone="#34437A" /><Person x={1004} small tone="#B24D00" />{st >= 3 && <Person x={1124} small tone="#2A55B8" />}</g>
            <g className={`j-tenants${on(L && st >= 3)}`}><Person x={1052} /><Person x={1076} tone="#34437A" /><Person x={1412} tone="#B24D00" /></g>
            <g className={`j-anim j-van${on(st === 2)}`}>
              <rect x="0" y={GROUND + 18} width="150" height="54" rx="8" fill="#FFFFFF" stroke="#0E1424" strokeWidth="4" />
              <rect x="150" y={GROUND + 34} width="40" height="38" rx="6" fill="#0E1424" /><rect x="160" y={GROUND + 40} width="22" height="14" rx="3" fill="#8EC5FF" />
              <rect x="0" y={GROUND + 42} width="150" height="8" fill="#F07415" />
              <circle cx="36" cy={GROUND + 74} r="12" fill="#0E1424" stroke="#F7F5F0" strokeWidth="3" /><circle cx="160" cy={GROUND + 74} r="12" fill="#0E1424" stroke="#F7F5F0" strokeWidth="3" />
            </g>
            <g className={`j-anim j-bus${on(B && st === 3)}`}>
              <rect x="0" y={GROUND + 22} width="190" height="50" rx="10" fill="#FFC24B" stroke="#0E1424" strokeWidth="3" />
              {[14, 52, 90, 128].map((x) => <rect key={x} x={x} y={GROUND + 30} width="28" height="16" rx="3" fill="#0E1424" />)}
              <text x="95" y={GROUND + 64} textAnchor="middle" className="j-board-t" fill="#0E1424">SCHOOL</text>
              <circle cx="40" cy={GROUND + 74} r="11" fill="#0E1424" stroke="#F7F5F0" strokeWidth="3" /><circle cx="150" cy={GROUND + 74} r="11" fill="#0E1424" stroke="#F7F5F0" strokeWidth="3" />
            </g>

            {/* Locator dot: hops between homes for sale (Look), scans the street (Scout), then pins the home */}
            <g className={`j-dot${B && st === 0 ? ' hop' : L && st === 0 ? ' scan' : ''}${on(B || st === 0)}`}>
              <circle r="26" fill="#F07415" opacity="0.25" className="j-anim j-halo" /><circle r="13" fill="#F07415" stroke="#FFFFFF" strokeWidth="3" />
              <line x1="0" y1="14" x2="0" y2="30" stroke="#F07415" strokeWidth="4" />
            </g>

            {/* Tags */}
            {placePills(pills, geo).map((p) => <Pill key={p.spec.id} p={p} k={k} />)}
            {hover != null && <Pill p={placePills([{ id: 'hover', on: true, x: HOUSES[hover].cx, y: lift(HOUSES[hover].top, true), anchor: HOUSES[hover].top, text: hoverLabel(hover) }], { ...geo, obs: [] })[0]} k={k} hoverPill />}
          </g>
        </svg>
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

function Person({ x, tone = '#0E1424', small = false }: { x: number; tone?: string; small?: boolean }) {
  const k = small ? 0.66 : 1;
  const top = GROUND + 18 - 58 * k;
  return (
    <g transform={`translate(${x} 0)`}>
      <circle cx="10" cy={top + 8 * k} r={8 * k} fill={tone} />
      <rect x={10 - 9 * k} y={top + 18 * k} width={18 * k} height={26 * k} rx={7 * k} fill={tone} />
      <rect x={10 - 7 * k} y={top + 40 * k} width={5 * k} height={18 * k} rx={2} fill={tone} />
      <rect x={10 + 2 * k} y={top + 40 * k} width={5 * k} height={18 * k} rx={2} fill={tone} />
    </g>
  );
}

const hit = (a: Box, b: Box, pad = 10) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

type Placed = { spec: PillSpec; x: number; w: number; h: number; hidden: boolean };

/**
 * Places the tags: inside the visible area, clear of the search panel / journey bar and of each other.
 * Floating tags slide right past an obstacle; tags pinned to a house just hide. Accent tags win ties.
 */
function placePills(specs: PillSpec[], geo: Geo): Placed[] {
  const { k } = geo;
  const taken: Box[] = [];
  const order = [...specs].sort((a, b) => Number(!!b.on) - Number(!!a.on) || Number(!!b.accent) - Number(!!a.accent));
  const out = new Map<string, Placed>();
  for (const spec of order) {
    const w = (spec.text.length * 8.4 + 34) * k, h = 32 * k;
    const lo = geo.x0 + w / 2 + 12, hi = geo.x1 - w / 2 - 12;
    let x = lo > hi ? (geo.x0 + geo.x1) / 2 : Math.min(hi, Math.max(lo, spec.x));
    const box = () => ({ x: x - w / 2, y: spec.y - h / 2, w, h });
    if (spec.anchor == null) for (const o of geo.obs) if (hit(box(), o)) x = Math.max(x, o.x + o.w + w / 2 + 16);
    const hidden = x > hi + 1 || Math.abs(x - spec.x) > w / 2 - 12 && spec.anchor != null
      || geo.obs.some((o) => hit(box(), o)) || (spec.on && taken.some((t) => hit(box(), t, 6)))
      || spec.y - h / 2 < geo.y0 + 4 || spec.x < geo.x0 - 20 || spec.x > geo.x1 + 20;
    if (spec.on && !hidden) taken.push(box());
    out.set(spec.id, { spec, x, w, h, hidden });
  }
  return specs.map((sp) => out.get(sp.id)!);
}

/** A navy tag; scaled up on small screens so it stays readable. */
function Pill({ p, k, hoverPill = false }: { p: Placed; k: number; hoverPill?: boolean }) {
  const { spec, x, w, h, hidden } = p;
  if (hidden && !spec.on) return null;
  const ax = spec.x - x;
  const stem = spec.anchor != null && spec.anchor > spec.y + h / 2 && Math.abs(ax) < w / 2 - 12;
  return (
    <g className={`j-pill${spec.on && !hidden ? ' on' : ''}${hoverPill ? ' is-hover' : ''}`} transform={`translate(${x.toFixed(1)} ${spec.y.toFixed(1)})`} style={{ ['--d' as string]: spec.d ?? 0 }}>
      <g className="j-pill-in">
        {stem && <line x1={ax} y1={h / 2} x2={ax} y2={spec.anchor! - spec.y} stroke="#0E1424" strokeWidth={2.5 * Math.min(k, 1.4)} />}
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill="#0E1424" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="1.5" />
        {spec.accent && <circle cx={-w / 2 + 16 * k} cy="0" r={5 * k} fill="#FFC24B" />}
        <text x={spec.accent ? 7 * k : 0} y={5 * k} textAnchor="middle" className="j-pill-t" fill="#FFFFFF" style={{ fontSize: `${14 * k}px` }}>{spec.text}</text>
      </g>
    </g>
  );
}
