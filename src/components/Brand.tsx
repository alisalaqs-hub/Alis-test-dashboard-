import { useEffect, useRef } from 'react';

/**
 * Streetkey identity: a key whose blade is a street of six houses, with an
 * orange locator dot in the bow. Wordmark "streetkey" with "key" in orange.
 *
 * Header lockup aligns the wordmark baseline with the street (blade top).
 * Interactive: on hover/focus the key turns and the windows light in sequence;
 * the locator dot follows the pointer. Night theme lights the windows.
 * Reduced motion: no turn and no dot tracking (windows still light).
 */
export const HOUSES = [
  { poly: '172,125 172,95 193,72 214,95 214,125', wins: [[179, 104, 13, 13], [197, 107, 10, 18]] },
  { poly: '220,125 220,85 241,60 262,85 262,125', wins: [[227, 104, 13, 13], [245, 107, 10, 18]] },
  { poly: '268,125 268,96 289,74 310,96 310,125', wins: [[275, 104, 13, 13], [293, 107, 10, 18]] },
  { poly: '316,125 316,80 337,52 358,80 358,125', wins: [[330.5, 86, 13, 12], [323, 104, 13, 13], [341, 107, 10, 18]], chimney: true },
  { poly: '364,125 364,92 385,68 406,92 406,125', wins: [[371, 104, 13, 13], [389, 107, 10, 18]] },
  { poly: '412,125 412,86 433,62 454,86 454,125', wins: [[419, 104, 13, 13], [437, 107, 10, 18]] },
];
// Tight bounds of the artwork: ring outer edge (20..160, 40..180), blade to x=500, chimney top y=44.
const VB = { x: 18, y: 38, w: 486, h: 144 };

export function StreetkeyMark({ height = 26, interactive = false, dotRef }: { height?: number; interactive?: boolean; dotRef?: React.Ref<SVGCircleElement> }) {
  return (
    <svg className={`sk-mark${interactive ? ' is-interactive' : ''}`} viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} height={height} width={(height * VB.w) / VB.h} aria-hidden="true">
      <g className="sk-mark-rig">
        <circle cx="90" cy="110" r="57" fill="none" stroke="currentColor" strokeWidth="26" />
        <path d="M140 125 H500 V172 H470 V151 H445 V166 H425 V151 H140 Z" fill="currentColor" />
        {HOUSES.map((h, i) => (
          <g key={i} className="sk-mark-house" style={{ ['--i' as string]: i }}>
            {h.chimney && <rect x="342" y="44" width="8" height="28" fill="currentColor" />}
            <polygon points={h.poly} fill="currentColor" />
            {h.wins.map(([x, y, w, hh]) => <rect key={`${x}-${y}`} className="sk-mark-win" x={x} y={y} width={w} height={hh} />)}
          </g>
        ))}
      </g>
      <circle ref={dotRef} className="sk-mark-dot" cx="90" cy="110" r="15" />
    </svg>
  );
}

/** Compact bow-and-dot mark for tight spaces (footer, favicon). */
export function StreetkeyBow({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <circle cx="32" cy="32" r="21" fill="none" stroke="var(--ink)" strokeWidth="10" />
      <circle cx="32" cy="32" r="7" fill="var(--accent)" />
    </svg>
  );
}

/** Header lockup: interactive key + wordmark on the same street line. */
export function StreetkeyWordmark({ height = 28 }: { height?: number }) {
  const dot = useRef<SVGCircleElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0, px = 0, py = 0, pending = false;
    const apply = () => {
      pending = false;
      const svg = dot.current?.ownerSVGElement; if (!svg || !dot.current) return;
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      // ring centre in screen space
      const cx = r.left + ((90 - VB.x) / VB.w) * r.width, cy = r.top + ((110 - VB.y) / VB.h) * r.height;
      const dx = px - cx, dy = py - cy, dist = Math.hypot(dx, dy);
      const m = Math.min(dist / 40, 22); // viewBox units (ring inner radius ≈ 44)
      dot.current.style.transform = dist ? `translate(${((dx / dist) * m).toFixed(1)}px, ${((dy / dist) * m).toFixed(1)}px)` : '';
    };
    const move = (e: PointerEvent) => { px = e.clientX; py = e.clientY; if (!pending) { pending = true; raf = requestAnimationFrame(apply); } };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
  return (
    <span ref={wrap} className="wordmark-lockup">
      <StreetkeyMark height={height} interactive dotRef={dot} />
      <span className="wordmark" aria-hidden="true">street<span className="k">key</span></span>
    </span>
  );
}
