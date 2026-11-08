import { useEffect, useRef, useState } from 'react';

/**
 * Hero background: the Streetkey key laid along the bottom of the hero — bow
 * with the orange locator dot, blade as the road, a street of houses on top.
 * Quiet at rest; comes alive on interaction:
 *   • pointer near a house → it lifts, windows glow, its insight tag appears
 *   • click/tap the key (or the header logo on the home page) → whole street
 *     unlocks: all windows glow, all tags show, a car drives the road
 *   • Night theme → night sky, stars, moon and lit windows
 * Accessibility: decorative SVG is aria-hidden; the key is a real button with
 * aria-pressed; tags are mirrored in an sr-only list; reduced motion stops the
 * car and transitions; the loop pauses off-screen.
 */
type Variant = 'full' | 'band';
const W = 1600, H = 700;
const BOW = { x: 985, y: 562, r: 56 };
const ROAD_Y = 600;
const INSIGHTS = [
  { label: 'Value', icon: 'M3 17 9 11 13 15 21 7M14 7h7v7' },
  { label: 'Schools', icon: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z' },
  { label: 'Travel', icon: 'M4 3h16v14H4zM4 10h16M8 20h.01M16 20h.01' },
  { label: 'Energy', icon: 'M13 2 3 14h9l-1 8 10-12h-9z' },
  { label: 'Internet', icon: 'M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.94 0M12 20h.01' },
  { label: 'Parks', icon: 'M12 2 6 12h4l-4 6h12l-4-6h4zM12 18v4' },
];
// Six houses, as in the logo: varied heights, tags alternate high/low like the logo's pins.
const HOUSES = [
  [1072, 64, 70, 50], [1158, 64, 92, 58], [1244, 64, 66, 50], [1330, 64, 104, 64], [1416, 64, 76, 54], [1502, 64, 90, 56]
].map(([x, w, wall, roof], i) => ({ i, x, w, wall, roof, top: ROAD_Y - 24 - wall - roof, tagY: ROAD_Y - 24 - wall - roof - (i % 2 ? 78 : 30) }));

function useNight() {
  const get = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  };
  const [night, setNight] = useState(get);
  useEffect(() => {
    const mo = new MutationObserver(() => setNight(get())); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)'); const on = () => setNight(get()); mq?.addEventListener?.('change', on);
    return () => { mo.disconnect(); mq?.removeEventListener?.('change', on); };
  }, []);
  return night;
}

export function StreetBackdrop({ variant }: { variant: Variant }) {
  const night = useNight();
  const [unlocked, setUnlocked] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const car = useRef<SVGRectElement>(null);
  const keyBtn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const evening = (() => { const h = new Date().getHours(); return h >= 17 && h < 21; })();

  // Header logo click on the home page turns this key too.
  useEffect(() => {
    const t = () => setUnlocked((u) => !u);
    window.addEventListener('streetkey:turn', t);
    return () => window.removeEventListener('streetkey:turn', t);
  }, []);

  // Pointer → nearest house + locator dot (listens on the hero section so content stays clickable).
  useEffect(() => {
    const s = svg.current; if (!s) return;
    const host = s.closest('section') ?? s.parentElement!;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const toLocal = (e: PointerEvent) => { const m = s.getScreenCTM(); if (!m) return null; const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()); return p; };
    const move = (e: PointerEvent) => {
      const p = toLocal(e); if (!p) return;
      const near = HOUSES.find((h) => p.x >= h.x - 6 && p.x <= h.x + h.w + 6 && p.y >= h.top - 90 && p.y <= ROAD_Y);
      setHover(near ? near.i : null);
      if (!reduce && dot.current) {
        const dx = p.x - BOW.x, dy = p.y - BOW.y, d = Math.hypot(dx, dy), m = Math.min(d / 18, 22);
        dot.current.style.transform = d ? `translate(${((dx / d) * m).toFixed(1)}px, ${((dy / d) * m).toFixed(1)}px)` : '';
      }
    };
    const leave = () => { setHover(null); if (dot.current) dot.current.style.transform = ''; };
    const tap = (e: PointerEvent) => { if (e.pointerType !== 'mouse') move(e); };
    host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave); host.addEventListener('pointerdown', tap);
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); host.removeEventListener('pointerdown', tap); };
  }, []);

  // Keep the real button exactly over the bow as the scene scales.
  useEffect(() => {
    const place = () => {
      const s = svg.current, b = keyBtn.current, w = wrap.current; if (!s || !b || !w) return;
      const m = s.getScreenCTM(); if (!m) return;
      const c = new DOMPoint(BOW.x, BOW.y).matrixTransform(m), e = new DOMPoint(BOW.x + BOW.r + 14, BOW.y).matrixTransform(m);
      const wr = w.getBoundingClientRect(), r = Math.max(22, e.x - c.x);
      b.style.left = `${c.x - wr.left - r}px`; b.style.top = `${c.y - wr.top - r}px`; b.style.width = b.style.height = `${r * 2}px`;
    };
    const ro = new ResizeObserver(place); if (wrap.current) ro.observe(wrap.current); place();
    window.addEventListener('scroll', place, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener('scroll', place); };
  }, []);

  // Car along the road while unlocked (paused off-screen / reduced motion).
  useEffect(() => {
    if (!unlocked || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0, x = 0, last = 0, visible = true;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); if (svg.current) io.observe(svg.current);
    const loop = (t: number) => { const dt = last ? Math.min(50, t - last) : 0; last = t; if (visible) { x = (x + dt * 0.12) % 520; car.current?.setAttribute('x', String(BOW.x + 80 + x)); } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [unlocked]);

  const skyTop = night ? '#121A33' : '#F7F5F0';
  const skyBottom = night ? '#3A4682' : evening ? '#F6DCC2' : '#F7F5F0';
  const unlit = night ? '#2B3870' : '#F7F5F0';
  const vb = variant === 'full' ? `0 0 ${W} ${H}` : `890 300 712 360`;
  const id = `skbd-${variant}`;

  return (
    <div ref={wrap} className={`sk-bd sk-bd-${variant}${unlocked ? ' unlocked' : ''}${night ? ' night' : ''}`}>
      <svg ref={svg} viewBox={vb} preserveAspectRatio={variant === 'full' ? 'xMaxYMax slice' : 'xMidYMax meet'} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={skyTop} /><stop offset="0.8" stopColor={skyBottom} /><stop offset="1" stopColor={skyTop} /></linearGradient>
          <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="1" y2="0"><stop offset="0.5" stopColor="#fff" stopOpacity="0" /><stop offset="0.58" stopColor="#fff" stopOpacity="1" /></linearGradient>
          <mask id={`${id}-mask`}><rect width={W} height={H} fill={variant === 'full' ? `url(#${id}-fade)` : '#fff'} /></mask>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill={`url(#${id}-sky)`} />
        <g mask={`url(#${id}-mask)`}>
          {night && <g className="sk-bd-stars">{[[1020, 90], [1110, 170], [1190, 70], [1290, 140], [1390, 60], [1470, 200], [1560, 110], [960, 230], [1250, 250], [1120, 280]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={1.8} fill="#FFFFFF" />)}</g>}
          {night ? <g transform="translate(1470 140)"><circle r="26" fill="#F4EFE3" /><circle cx="10" cy="-7" r="21" fill={skyTop} /></g> : <circle cx="1470" cy="150" r="26" fill="#FFB547" opacity={evening ? 0.9 : 0.55} />}
          {/* Key blade = road */}
          <g className="sk-bd-street">
            <path d={`M${BOW.x + 50} ${ROAD_Y - 24} H${W + 10} V${ROAD_Y + 40} H${BOW.x + 50} Z`} fill="#0E1424" />
            <line x1={BOW.x + 80} y1={ROAD_Y + 8} x2={W} y2={ROAD_Y + 8} stroke={unlit} strokeWidth="4" strokeDasharray="16 14" />
            <rect ref={car} className="sk-bd-car" x={BOW.x + 80} y={ROAD_Y + 1} width="34" height="14" rx="6" fill="#F07415" />
            {HOUSES.map((h) => {
              const lit = unlocked || hover === h.i || night;
              const up = hover === h.i;
              const cx = h.x + h.w / 2, base = ROAD_Y - 24;
              return (
                <g key={h.i} className={`sk-bd-house${up ? ' up' : ''}${unlocked || up ? ' on' : ''}`} style={{ ['--i' as string]: h.i }}>
                  {h.i === 3 && <rect x={h.x + h.w - 22} y={h.top + 6} width="12" height="40" fill="#0E1424" />}
                  <polygon points={`${h.x},${base} ${h.x},${base - h.wall} ${cx},${h.top} ${h.x + h.w},${base - h.wall} ${h.x + h.w},${base}`} fill="#0E1424" />
                  <rect className="sk-bd-win" x={h.x + 12} y={base - h.wall + 18} width="20" height="20" fill={lit ? '#FFC24B' : unlit} />
                  <rect className="sk-bd-win" x={h.x + 42} y={base - 34} width="16" height="34" fill={lit ? '#FFC24B' : unlit} />
                  {h.wall > 90 && <rect className="sk-bd-win" x={cx - 10} y={h.top + h.roof - 6} width="20" height="18" fill={lit ? '#FFC24B' : unlit} />}
                  <g className="sk-bd-tag" transform={`translate(${cx} ${h.tagY})`}>
                    <line x1="0" y1="18" x2="0" y2={h.top - h.tagY + 4} stroke={night ? '#F7F5F0' : '#0E1424'} strokeWidth="2.5" />
                    <rect x={-(INSIGHTS[h.i].label.length * 9.4 + 46) / 2} y="-18" width={INSIGHTS[h.i].label.length * 9.4 + 46} height="36" rx="18" fill={night ? '#F7F5F0' : '#0E1424'} />
                    <path d={INSIGHTS[h.i].icon} transform={`translate(${-(INSIGHTS[h.i].label.length * 9.4 + 46) / 2 + 12} -8) scale(0.7)`} fill="none" stroke={night ? '#F07415' : '#FFC24B'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    <text x={-(INSIGHTS[h.i].label.length * 9.4 + 46) / 2 + 34} y="6" fontSize="16" fontWeight="700" fill={night ? '#0E1424' : '#FFFFFF'} fontFamily="Plus Jakarta Sans Variable, Plus Jakarta Sans, system-ui, sans-serif">{INSIGHTS[h.i].label}</text>
                  </g>
                </g>
              );
            })}
            {/* Bow with locator dot */}
            <circle cx={BOW.x} cy={BOW.y} r={BOW.r} fill="none" stroke="#0E1424" strokeWidth="28" />
            <circle ref={dot} className="sk-bd-dot" cx={BOW.x} cy={BOW.y} r="17" fill="#F07415" />
          </g>
        </g>
      </svg>
      <button ref={keyBtn} type="button" className="sk-bd-key" aria-pressed={unlocked} aria-label={unlocked ? 'Lock the street' : 'Turn the key to unlock the street'} onClick={() => setUnlocked((u) => !u)} />
      <ul className="sr-only" aria-live="polite">{unlocked && INSIGHTS.map((t) => <li key={t.label}>{t.label}</li>)}</ul>
    </div>
  );
}
