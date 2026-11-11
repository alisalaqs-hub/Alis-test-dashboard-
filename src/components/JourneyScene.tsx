import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { estimateRefurb } from '../engine/refurb';
import { epcPathway, loftScenario, refurbInputFor } from '../engine/insights';
import { transactionTax } from '../engine/tax';
import { gbp, gbpK } from './ui';
import {
  Backdrop, BAY, BAYS, Board, bayCentre, bayX, Defs, DAY, DOT_Y, fanPath, Figure, GROUND, Grow, Ground, KERB, Lamps, LampLight,
  mirrored, POTS_TOP, RIDGE, TreeShadows, Trees, Van, winRect, WINS, doorX,
} from './journey/art';
import { Inside, type InsideFacts } from './journey/inside';
import { JourneyNotes, type Box, type NoteSpec, type View } from './journey/Notes';
import '../styles/journey.css';

/**
 * Streetkey journey: the homepage's living background.
 * A Victorian terrace, drawn as a fine-line architectural elevation, that plays a home buyer's
 * story on a quick loop (about 16 seconds): Look, Buy, Completion, Inside, Live. Every figure
 * comes from the engines and the example listings.
 *
 * On completion the buyers walk along the pavement, up the path and in through their front door.
 * The camera then closes in on the home and its front gives way to the inside in one continuous
 * move: the plans as a model, the rooms finished, then furnished with the family at home, before
 * the view returns to the street (src/components/journey/inside.tsx; timings in journey.css).
 *
 * Interactive: hover a house for its price or sold price, click a house to open it,
 * gentle parallax. Callouts are placed so they never sit under the search panel.
 * Accessibility: the drawing and its callouts are aria-hidden (a visually hidden
 * summary describes the story); the small pause button is always available
 * (WCAG 2.2.2); reduced motion starts paused with no movement; the story pauses
 * when it's off-screen.
 */
type Chapter = 'look' | 'buy' | 'keys' | 'inside' | 'live';
const STORY: Chapter[] = ['look', 'buy', 'keys', 'inside', 'live'];
/** How long each chapter stays on screen. */
const CHAPTER_MS: Record<Chapter, number> = { look: 2800, buy: 2400, keys: 2600, inside: 5400, live: 3000 };
const HOUSES = Array.from({ length: 8 }, (_, i) => ({ i, x: bayX(i), cx: bayX(i) + BAY / 2, m: mirrored(i) }));
const HERO = 5;                 // the buyer's home
const BUY_FOR_SALE = [3, 4, 5, 7]; // for sale on the buyer's street (hero is the 3rd)
const SOLD_ON = [0, 1, 2, 6];   // the street's recent sold prices
const SCHOOL: [number, number] = [1447, 404]; // the board school, under its bell turret
const LINE: [number, number] = [930, 459];    // the railway viaduct
const BUYERS = [1052, 1066];    // where the couple stand while they look
const HERO_DOOR = bayX(HERO) + doorX(mirrored(HERO)); // centre line of the buyer's front door
const CAM: [number, number] = [bayX(HERO) + BAY / 2, KERB]; // the camera closes in on the home about this point
const VB_FULL = [0, 0, 1600, 900] as const;
const VB_COMPACT = [700, 300, 920, 603] as const;
// Per-bay character: brick or painted fronts, door colours, hedge or railings.
const WALL = [0, 1, 0, 2, 0, 1, 3, 0, 4, 1, 0];
const DOOR = [3, 1, 0, 4, 2, 3, 1, 0, 5, 2, 4];
const HEDGE = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1];
const ROOF = ['rgba(255,255,255,.07)', 'transparent', 'rgba(20,24,40,.05)', 'rgba(255,255,255,.12)', 'transparent', 'rgba(20,24,40,.08)', 'rgba(255,255,255,.04)'];

// The locator dot: hops between the homes for sale (Look), then rests on the home.
const T = (i: number, lift = 0) => `transform:translate(${bayX(i) + BAY / 2}px,${DOT_Y - lift}px)`;
const MID = (a: number, b: number, lift: number) => `transform:translate(${(bayX(a) + bayX(b)) / 2 + BAY / 2}px,${DOT_Y - lift}px)`;
const EASE = 'animation-timing-function:cubic-bezier(.45,0,.55,1)';
const DOT_CSS = `.j-dot{${T(HERO)}}`
  + `@keyframes j-hop{0%,9%{${T(3)};${EASE}}17%{${MID(3, 4, 16)};${EASE}}25%,36%{${T(4)};${EASE}}50%{${MID(4, 7, 34)};${EASE}}64%,74%{${T(7)};${EASE}}82%{${MID(7, 5, 22)};${EASE}}90%,100%{${T(HERO)}}}`;

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
    const others = host ? [...host.querySelectorAll<HTMLElement>('.hero-copy, .journey-pause')] : [];
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
    const works = estimateRefurb(refurbInputFor(hero));
    const heroWorks = works.total;
    const inside: InsideFacts = { area: `${hero.floorArea} m²`, beds: `${hero.beds} bed` };
    const epc = epcPathway(hero);
    const epcTarget = epc.steps[epc.steps.length - 1]?.band ?? hero.epc.potential;
    const school = [...hero.schools].sort((a, b) => (b.rating === 'Outstanding' ? 1 : 0) - (a.rating === 'Outstanding' ? 1 : 0))[0];
    const sold = hero.comparables.filter((c) => c.kind === 'sold');
    const let0 = hero.comparables.find((c) => c.kind === 'let');
    // Buyer street: houses that aren't for sale show the street's real sold / let comparables.
    const buyerHouse = HOUSES.map((h) => {
      const fs = BUY_FOR_SALE.indexOf(h.i);
      if (fs >= 0) { const p = forSale[fs]; return { title: `For sale · ${p.beds} bed`, value: gbpK(p.price), label: `For sale · ${gbpK(p.price)} · ${p.beds} bed`, to: `/property/${p.id}` }; }
      const c = sold[SOLD_ON.indexOf(h.i)];
      if (c) return { title: `Sold · ${c.date}`, value: gbpK(c.price), label: `Sold ${gbpK(c.price)} · ${c.date}`, to: '/prices?q=E17' };
      return { title: let0 ? 'Let' : 'Not for sale', value: let0 ? `${gbp(let0.price)} pcm` : '', label: let0 ? `Let ${gbp(let0.price)} pcm` : 'Not for sale', to: '/prices?q=E17' };
    });
    return { hero, forSale, ftbTax, loft, heroWorks, epcTarget, school, buyerHouse, inside };
  }, []);
}

export function JourneyScene() {
  const s = useStory();
  const P = DAY;
  const compact = useMedia('(max-width: 599px)');
  const nav = useNavigate();
  const descId = useId();
  const reduce = useMemo(() => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);
  const [stage, setStage] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(!reduce);
  const [visible, setVisible] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const m = useLayoutBoxes(root, [compact, stage]);

  const after = gbpK(s.hero.estGdv + (s.loft?.valueUplift ?? 0));
  const summary = `A Victorian street where a home buyer's story plays on a loop. Look: every home on the street comes priced. `
    + `Buy: offer accepted at ${gbp(s.hero.price)}, stamp duty as a first-time buyer ${gbp(s.ftbTax)}. `
    + `Completion: keys collected; the buyers walk up the path and in through their front door. `
    + `Inside: the view moves into the home, shows its plans (${s.inside.beds}, ${s.inside.area}), then the rooms renovated (about ${gbpK(s.heroWorks)})${s.loft ? `, the loft converted (${s.loft.area} m² more)` : ''} `
    + `and the family moved in; estimated value after works ${after}, EPC ${s.hero.epc.current} to ${s.epcTarget}. `
    + `Live: back on the street, ${s.school ? `${s.school.rating} school ${s.school.distanceKm} km away, ` : ''}${s.hero.commute.minutes} min to ${s.hero.commute.to}.`;
  const running = playing && visible;
  const st = stage % STORY.length;
  const ch = STORY[st];

  // Move the story on by itself while it's playing and on screen.
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setStage((x) => (x + 1) % STORY.length), CHAPTER_MS[ch]);
    return () => window.clearTimeout(t);
  }, [running, stage, nonce, ch]);

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

  const on = (c: boolean) => (c ? ' on' : '');
  /** True from chapter `c` onwards. */
  const past = (c: Chapter) => st >= STORY.indexOf(c);
  /** Inside the home: the camera is close in, and the street's hover labels are off. */
  const inside = ch === 'inside';
  const hov = inside ? null : hover;
  // How far the camera can close in: the home's roof has to stay inside the scene.
  const topU = view.sc ? vby - view.oy / view.sc : vby;
  const zoom = Math.max(1.25, Math.min(2.5, (CAM[1] - topU - 26 / (view.sc || 1)) / (CAM[1] - 494)));
  const camPt = ([x, y]: [number, number]): [number, number] => [CAM[0] + (x - CAM[0]) * zoom, CAM[1] + (y - CAM[1]) * zoom];
  const camera = inside ? `translate(${(CAM[0] * (1 - zoom)).toFixed(1)}px, ${(CAM[1] * (1 - zoom)).toFixed(1)}px) scale(${zoom.toFixed(3)})` : 'translate(0px, 0px) scale(1)';

  const storyLit = (i: number) => hov === i || (i === HERO && past('keys'));
  const doorOpen = (i: number) => i === HERO && past('keys');
  const ridge = (i: number): [number, number] => [HOUSES[i].cx, DOT_Y];

  const notes: NoteSpec[] = [];
  BUY_FOR_SALE.forEach((i, n) => notes.push({ id: `fs${i}`, on: ch === 'look', at: [ridge(i)], title: `For sale · ${s.forSale[n].beds} bed`, short: 'For sale', value: gbpK(s.forSale[n].price), accent: i === HERO, d: n }));
  notes.push({ id: 'offer', on: ch === 'buy', at: [ridge(HERO)], title: 'Offer accepted', value: gbp(s.hero.price), rows: compact ? undefined : [['Stamp duty · first-time buyer', gbp(s.ftbTax)]], accent: true, dot: true });
  notes.push({ id: 'keys', on: ch === 'keys', at: [ridge(HERO)], title: 'Completion', value: 'Keys collected', accent: true, dot: true });
  if (s.school) notes.push({ id: 'school', on: ch === 'live', at: [SCHOOL], title: `${s.school.rating} school`, value: `${s.school.distanceKm} km`, d: 1 });
  notes.push({ id: 'travel', on: ch === 'live', at: [LINE], title: `To ${s.hero.commute.to}`, value: `${s.hero.commute.minutes} min`, accent: true });
  // Inside the home one label sits beside it, level with the first floor, and arrives as the rooms are finished.
  notes.push({ id: 'home', on: inside, at: [camPt([bayX(HERO) + BAY, 630])], title: 'After the works', value: after, d: 28, accent: true,
    rows: compact ? undefined : [['Renovation', `≈ ${gbpK(s.heroWorks)}`], ...(s.loft ? [['Loft conversion', `+${s.loft.area} m²`] as [string, string]] : []), ['Energy rating', `EPC ${s.hero.epc.current} → ${s.epcTarget}`]] });
  const hoverNote: NoteSpec | null = hov == null ? null
    : { id: 'hover', on: true, at: [ridge(hov)], title: s.buyerHouse[hov].title, value: s.buyerHouse[hov].value, dot: hov === HERO && st > 0 };

  return (
    <>
      <div ref={root} className={`journey${running ? '' : ' is-paused'}${hov != null ? ' hovering' : ''}${inside ? ' is-inside' : ''}`} data-stage={st} data-chapter={ch}>
        <svg key={nonce} viewBox={`${vbx} ${vby} ${vbw} ${vbh}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
          <style>{DOT_CSS}</style>
          <Defs P={P} />
          <g className="j-cam" style={{ transform: camera }}>
          <Backdrop P={P} train={ch === 'live'} />

          {/* The terrace */}
          <g className="j-near">
            {BAYS.map((k, n) => {
              const x = bayX(k), mm = mirrored(k), story = k >= 0 && k < 8;
              const lit = WINS.map(() => story && storyLit(k));
              const fanLit = story && storyLit(k);
              const style = { ['--wall' as string]: P.walls[WALL[n]], ['--door' as string]: P.doors[DOOR[n]], ['--roof' as string]: ROOF[n % ROOF.length], ['--i' as string]: n } as CSSProperties;
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
              const forSale = BUY_FOR_SALE.includes(i) && (ch === 'look' || (ch === 'buy' && !isHero));
              const sold = isHero && (ch === 'buy' || ch === 'keys');
              const board: 'sale' | 'sold' | null = forSale ? 'sale' : sold ? 'sold' : null;
              const dx = doorX(mm);
              return (
                <g key={k} style={style} className={`j-house${hov === i ? ' is-hover' : ''}${isHero && ch === 'keys' ? ' is-entering' : ''}`}
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => nav(s.buyerHouse[i].to)}>
                  {body}
                  <g transform={`translate(${x} 0)`}>
                    {isHero && (
                      <g className={`j-doorway${on(doorOpen(i))}`}>
                        <rect x={dx - 11.5} y={692} width={23} height={60} fill="url(#j-lit)" />
                        <rect className={`j-leaf${mm ? ' m' : ''}`} x={dx - 11.5} y={692} width={23} height={60} style={{ fill: 'var(--door)' }} />
                        <polygon points={`${dx - 13},752 ${dx + 13},752 ${dx + 22},770 ${dx - 22},770`} fill="url(#j-spill)" />
                      </g>
                    )}
                    {isHero && <g className={`j-grow${on(ch === 'live')}`}><Grow m={mm} P={P} /></g>}
                    <g className={`j-board${on(!!board)}`}><Board cx={bayCentre(mm)} kind={board ?? (isHero && st >= 1 ? 'sold' : 'sale')} P={P} /></g>
                    {isHero && (
                      <g className={`j-in${on(inside)}${past('inside') ? ' go' : ''}`}>
                        <Inside m={mm} P={P} facts={s.inside} />
                      </g>
                    )}
                    <rect className="j-hit" x={0} y={RIDGE - 40} width={BAY} height={GROUND - RIDGE + 40} />
                  </g>
                </g>
              );
            })}
            <g className="j-np">{[...BAYS, 9].map((k) => <use key={k} href="#j-stack" x={bayX(k)} />)}</g>
            <rect className="j-np" x={-160} y={440} width={1920} height={GROUND - 440} fill="url(#j-warm)" />
            <rect className="j-np" x={-160} y={690} width={1920} height={GROUND - 690} fill="url(#j-ao)" />
            <TreeShadows P={P} />
            <g className="j-np">{BAYS.map((k, n) => <use key={k} className={k === HERO ? 'j-front-garden' : undefined} href={HEDGE[n] ? '#j-garden-h' : '#j-garden-r'} x={bayX(k)} transform={mirrored(k) ? `translate(${2 * bayX(k) + BAY} 0) scale(-1 1)` : undefined} />)}</g>
            <Ground P={P} />
            <Lamps P={P} />

            {/* Scale figures and the van: quiet silhouettes, as on an architect's drawing */}
            {/* The buyers look, buy, then (on completion) walk to their door and go in; the family is out on the street afterwards. */}
            <g className={`j-np j-buyer${on(st <= STORY.indexOf('keys'))}${past('keys') ? ' enter' : ''}`}>
              {BUYERS.map((x, n) => (
                <g key={x} className="j-anim j-walk" style={{ ['--dx' as string]: `${HERO_DOOR - x}px`, ['--wd' as string]: `${n * 280}ms` } as CSSProperties}>
                  <g className="j-anim j-step"><Figure x={x} kind={n ? 'man' : 'woman'} P={P} /></g>
                </g>
              ))}
            </g>
            <g className={`j-np j-family${on(past('live'))}`}><Figure x={1082} kind="woman" P={P} /><Figure x={1146} kind="man" P={P} flip /></g>
            <g className={`j-np j-kid${on(past('live'))}`}><Figure x={1093} kind="child" P={P} /></g>
            <Trees P={P} />
            <LampLight P={P} />
            <g className={`j-np j-van${on(inside)}`}><Van x={1166} P={P} /></g>

            <g className={`j-np j-dot${ch === 'look' ? ' hop' : ''}${on(!inside)}`}>
              <circle r="16" className="j-anim j-halo" fill="#F07415" />
              <circle r="6.6" fill="#F07415" stroke="#FFFFFF" strokeWidth="2.4" />
            </g>
          </g>
          </g>
        </svg>
        <JourneyNotes specs={notes} hover={hoverNote} view={view} obs={m.obs} compact={compact} />
        <p className="sr-only" id={descId}>{summary}</p>
        <button type="button" className="icon-btn journey-pause" aria-describedby={descId}
          aria-label={playing ? 'Pause the street animation' : 'Play the street animation'} onClick={() => setPlaying((p) => !p)}>
          {playing ? <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
        </button>
      </div>
    </>
  );
}

