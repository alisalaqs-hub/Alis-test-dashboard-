/**
 * Shared pieces for the listing illustrations: the palette (the same muted washes and fine navy line
 * as the home-page street) and the parts every drawing reuses (sash windows, doors, trees, hedges).
 * Everything is drawn on a 320 × 240 canvas.
 */
import type { ReactNode } from 'react';

export const INK = '#0E1424';
export const STUCCO = '#FBF8F2';
export const FRAME = '#FCFAF6';
export const GLASS = '#A9B3BF';
export const GLASS_DARK = '#8792A0';
export const SLATE = '#959CAB';
export const SLATE_DARK = '#7F8798';
export const TILE = '#B98D78';
export const TILE_DARK = '#A67B67';
export const LEAD = '#9BA1AC';
export const STACK = '#D2BC9E';
export const POT = '#C0927A';
export const PAVE = '#ECE6DC';
export const ROAD = '#DAD3C7';
export const HEDGE = '#7E8D6C';
export const HEDGE_HI = '#9BA987';
export const LEAF = '#94A084';
export const LEAF_HI = '#B3BEA1';
export const LEAF_LO = '#7A876B';
export const TRUNK = '#8F877A';
export const LAWN = '#B9C4A4';
export const BRASS = '#C7A35C';
export const SKY = '#F3EFE6';

/** Outside walls: London stock, buff, soft red and render. */
export const WALLS = ['#E5D7BF', '#D9C3A6', '#EDE6D8', '#D6B29A', '#DEDCD2', '#CBAA91', '#E3CFB4', '#D3C4AC'];
export const DOORS = ['#2E3A5A', '#6B3934', '#4B6453', '#262A35', '#55687D', '#7A6446', '#8C4A2F', '#3E5C63'];
/** Inside walls: warm white, sage, lilac grey, blush, pale blue, cream. */
export const PAINT = ['#EEE9DF', '#E1E7DD', '#E6E3EC', '#F0E3D7', '#DEE6EA', '#EDE4D2'];

export const ln = { stroke: INK, strokeOpacity: 0.42, strokeWidth: 1, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
export const thin = { stroke: INK, strokeOpacity: 0.22, strokeWidth: 0.8, strokeLinecap: 'round' as const };
export const shade = { fill: '#1D2443', opacity: 0.1 };

/** A stable pick from a list: the same home always gets the same wall, door and planting. */
export const pick = <T,>(list: readonly T[], n: number) => list[((Math.round(n) % list.length) + list.length) % list.length];

/** Glass with a soft diagonal reflection. */
export function Glass({ x, y, w, h, fill = GLASS }: { x: number; y: number; w: number; h: number; fill?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={fill} />
      <polygon points={`${x},${y + h * 0.62} ${x + w * 0.62},${y} ${x + w},${y} ${x + w},${y + h * 0.12} ${x + w * 0.16},${y + h} ${x},${y + h}`} fill="#fff" opacity={0.2} />
    </g>
  );
}

/** A sash window: frame, glass, meeting rail, optional glazing bar, stone sill and lintel. */
export function Sash({ x, y, w, h, frame = FRAME, bars = true, sill = true, lintel = false }: { x: number; y: number; w: number; h: number; frame?: string; bars?: boolean; sill?: boolean; lintel?: boolean }) {
  return (
    <g>
      {lintel && <rect x={x - 5} y={y - 9} width={w + 10} height={5.5} fill={STUCCO} {...thin} />}
      <rect x={x - 2.5} y={y - 2.5} width={w + 5} height={h + 5} fill={frame} {...ln} />
      <Glass x={x} y={y} w={w} h={h} />
      <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} stroke={frame} strokeWidth={2.2} />
      {bars && <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke={frame} strokeWidth={1.2} />}
      {sill && <rect x={x - 5} y={y + h + 2.5} width={w + 10} height={3.5} fill={STUCCO} {...thin} />}
    </g>
  );
}

/** A panelled front door with a brass knob; `fan` adds a glazed light above it. */
export function Door({ x, y, w, h, fill, fan = 0 }: { x: number; y: number; w: number; h: number; fill: string; fan?: number }) {
  return (
    <g>
      {fan > 0 && <Glass x={x} y={y - fan - 2} w={w} h={fan} fill={GLASS_DARK} />}
      <rect x={x} y={y} width={w} height={h} fill={fill} {...ln} />
      <rect x={x + w * 0.16} y={y + h * 0.1} width={w * 0.68} height={h * 0.34} fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={0.9} />
      <rect x={x + w * 0.16} y={y + h * 0.54} width={w * 0.68} height={h * 0.36} fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={0.9} />
      <circle cx={x + w * 0.82} cy={y + h * 0.52} r={1.5} fill={BRASS} />
    </g>
  );
}

/** A street or garden tree: trunk and a canopy built from a few soft rounds. */
export function Tree({ x, base, h = 96, r = 30 }: { x: number; base: number; h?: number; r?: number }) {
  const cy = base - h;
  return (
    <g>
      <path d={`M${x - 3} ${base} L${x - 1.6} ${cy + r * 0.5} L${x + 1.6} ${cy + r * 0.5} L${x + 3} ${base} Z`} fill={TRUNK} />
      <circle cx={x - r * 0.55} cy={cy + r * 0.3} r={r * 0.72} fill={LEAF_LO} />
      <circle cx={x + r * 0.6} cy={cy + r * 0.25} r={r * 0.7} fill={LEAF} />
      <circle cx={x} cy={cy - r * 0.2} r={r * 0.86} fill={LEAF} />
      <circle cx={x - r * 0.25} cy={cy - r * 0.42} r={r * 0.5} fill={LEAF_HI} opacity={0.75} />
      <circle cx={x + r * 0.42} cy={cy - r * 0.02} r={r * 0.34} fill={LEAF_HI} opacity={0.5} />
    </g>
  );
}

/** A clipped hedge. */
export function Hedge({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={Math.min(6, h / 2)} fill={HEDGE} />
      <rect x={x + 3} y={y + 1.5} width={w - 6} height={Math.max(2, h * 0.3)} rx={2} fill={HEDGE_HI} opacity={0.7} />
    </g>
  );
}

/** Sky, a low sun and the far roofline, behind every outside view. */
export function Backdrop({ sunX = 250, skyline = true }: { sunX?: number; skyline?: boolean }) {
  return (
    <g>
      <rect width={320} height={240} fill={SKY} />
      <circle cx={sunX} cy={54} r={34} fill="#F1D5AE" opacity={0.38} />
      <circle cx={sunX} cy={54} r={18} fill="#F6E3C6" opacity={0.6} />
      {skyline && <path d="M0 150 V118 h22 v-10 h18 v14 h26 v-22 h14 v22 h30 v-8 h24 v-16 l8 -10 l8 10 v24 h28 v-12 h20 v12 h26 v-20 h16 v20 h30 v-9 h22 v9 h28 V150 Z" fill="#E2DCD0" />}
    </g>
  );
}

/** Pavement, kerb and the edge of the road along the bottom of a street view. */
export function Street({ top = 212 }: { top?: number }) {
  return (
    <g>
      <rect x={0} y={top} width={320} height={240 - top} fill={PAVE} />
      <rect x={0} y={231} width={320} height={9} fill={ROAD} />
      <line x1={0} y1={231} x2={320} y2={231} {...thin} />
      <line x1={0} y1={top} x2={320} y2={top} {...thin} />
    </g>
  );
}

/** The frame every illustration sits in. */
export function Canvas({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 320 240" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label={label} style={{ display: 'block' }}>
      {children}
    </svg>
  );
}
