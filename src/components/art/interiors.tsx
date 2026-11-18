/**
 * Room views for example listings (which have no photographs): each room of the gallery gets its own
 * drawing, in the same fine line and washes as the outside views. `n` belongs to the home, so its
 * rooms share a paint colour and a furnishing colour and look the same wherever they appear.
 */
import type { ReactNode } from 'react';
import { BRASS, Backdrop, FRAME, GLASS_DARK, HEDGE, HEDGE_HI, Hedge, INK, LAWN, LEAF, LEAF_HI, PAINT, PAVE, STUCCO, Tree, ln, pick, thin } from './kit';

const FABRIC = ['#2E3A5A', '#7E8D6C', '#B46A4C', '#55687D', '#C9A66B', '#6B5A7A'];
const WOOD = '#DCC8A6';
const WOOD_DARK = '#B99B72';
const DAYLIGHT = '#DCE7EE';
const WHITE = '#FDFCF9';

/** The room shell: painted wall, coving, skirting and a boarded or tiled floor. */
function Room({ paint, floor = WOOD, floorY = 168, tiles = false, children }: { paint: string; floor?: string; floorY?: number; tiles?: boolean; children: ReactNode }) {
  const lines = [];
  for (let i = 1; i <= 4; i++) lines.push(<line key={`h${i}`} x1={0} y1={floorY + i * i * 4.2} x2={320} y2={floorY + i * i * 4.2} {...thin} />);
  if (tiles) for (let i = -6; i <= 6; i++) lines.push(<line key={`v${i}`} x1={160 + i * 30} y1={floorY} x2={160 + i * 62} y2={240} {...thin} />);
  return (
    <g>
      <rect width={320} height={floorY} fill={paint} />
      <rect width={320} height={7} fill={WHITE} opacity={0.7} />
      <rect x={0} y={floorY} width={320} height={240 - floorY} fill={floor} />
      {lines}
      <rect x={0} y={floorY - 5} width={320} height={5} fill={WHITE} {...thin} />
      {children}
    </g>
  );
}

/** A window with daylight behind it and, when asked, a curtain either side. */
function Window({ x, y, w, h, curtain, split = 2 }: { x: number; y: number; w: number; h: number; curtain?: string; split?: number }) {
  return (
    <g>
      <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} fill={FRAME} {...ln} />
      <rect x={x} y={y} width={w} height={h} fill={DAYLIGHT} />
      <polygon points={`${x},${y + h} ${x},${y + h * 0.5} ${x + w * 0.5},${y} ${x + w * 0.8},${y} ${x + w * 0.1},${y + h}`} fill="#fff" opacity={0.45} />
      {Array.from({ length: split - 1 }, (_, i) => <line key={i} x1={x + ((i + 1) * w) / split} y1={y} x2={x + ((i + 1) * w) / split} y2={y + h} stroke={FRAME} strokeWidth={2.4} />)}
      <line x1={x} y1={y + h * 0.5} x2={x + w} y2={y + h * 0.5} stroke={FRAME} strokeWidth={2} />
      <rect x={x - 8} y={y + h + 4} width={w + 16} height={4} fill={WHITE} {...thin} />
      {curtain && (
        <g>
          <line x1={x - 16} y1={y - 12} x2={x + w + 16} y2={y - 12} stroke={BRASS} strokeWidth={1.6} />
          <path d={`M${x - 14} ${y - 12} h16 q-3 ${h * 0.5} 2 ${h + 26} h-18 Z`} fill={curtain} opacity={0.9} />
          <path d={`M${x + w + 14} ${y - 12} h-16 q3 ${h * 0.5} -2 ${h + 26} h18 Z`} fill={curtain} opacity={0.9} />
        </g>
      )}
    </g>
  );
}

function Plant({ x, base, s = 1 }: { x: number; base: number; s?: number }) {
  return (
    <g>
      <path d={`M${x} ${base - 12 * s} q-${16 * s} -${22 * s} -${10 * s} -${40 * s} q${8 * s} ${14 * s} ${10 * s} ${40 * s} Z`} fill={LEAF} />
      <path d={`M${x} ${base - 12 * s} q${18 * s} -${18 * s} ${14 * s} -${36 * s} q-${10 * s} ${12 * s} -${14 * s} ${36 * s} Z`} fill={HEDGE} />
      <path d={`M${x} ${base - 12 * s} q${2 * s} -${30 * s} -${2 * s} -${50 * s} q${10 * s} ${20 * s} ${2 * s} ${50 * s} Z`} fill={LEAF_HI} />
      <path d={`M${x - 8 * s} ${base - 14 * s} h${16 * s} l-${2.5 * s} ${14 * s} h-${11 * s} Z`} fill="#C9A990" {...thin} />
    </g>
  );
}

function Lamp({ x, base, h = 70, shadeFill = '#F4E9D2' }: { x: number; base: number; h?: number; shadeFill?: string }) {
  return (
    <g>
      <line x1={x} y1={base} x2={x} y2={base - h} stroke="#4B505F" strokeWidth={1.4} />
      <ellipse cx={x} cy={base} rx={9} ry={2.4} fill="#4B505F" />
      <path d={`M${x - 8} ${base - h - 14} h16 l5 16 h-26 Z`} fill={shadeFill} {...thin} />
    </g>
  );
}

function Picture({ x, y, w, h, tone }: { x: number; y: number; w: number; h: number; tone: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={WHITE} {...ln} />
      <rect x={x + 4} y={y + 4} width={w - 8} height={h - 8} fill={tone} opacity={0.35} />
      <circle cx={x + w * 0.62} cy={y + h * 0.42} r={Math.min(w, h) * 0.16} fill={tone} opacity={0.7} />
      <path d={`M${x + 4} ${y + h - 4} l${(w - 8) * 0.35} -${h * 0.3} l${(w - 8) * 0.25} ${h * 0.16} l${(w - 8) * 0.4} -${h * 0.22} V${y + h - 4} Z`} fill={tone} opacity={0.55} />
    </g>
  );
}

export function LivingRoom({ n }: { n: number }) {
  const paint = pick(PAINT, n), sofa = pick(FABRIC, n), accent = pick(FABRIC, n + 2);
  return (
    <Room paint={paint}>
      <Window x={30} y={34} w={76} h={96} curtain={accent} split={2} />
      {/* chimney breast, fireplace and mirror */}
      <rect x={152} y={7} width={106} height={156} fill="#fff" opacity={0.28} />
      <line x1={152} y1={7} x2={152} y2={163} {...thin} />
      <line x1={258} y1={7} x2={258} y2={163} {...thin} />
      <rect x={172} y={100} width={66} height={68} fill={STUCCO} {...ln} />
      <rect x={166} y={95} width={78} height={6} fill={STUCCO} {...ln} />
      <path d="M185 168 V124 q20 -12 40 0 V168 Z" fill="#3A3F4C" />
      <rect x={191} y={150} width={28} height={18} fill="#5A4A3E" opacity={0.7} />
      <circle cx={205} cy={54} r={25} fill={BRASS} />
      <circle cx={205} cy={54} r={21.5} fill={DAYLIGHT} />
      <path d="M190 62 l22 -22" stroke="#fff" strokeWidth={5} opacity={0.5} strokeLinecap="round" />
      <rect x={176} y={86} width={8} height={9} rx={1} fill={accent} />
      <rect x={224} y={80} width={5} height={15} fill={HEDGE} />
      <Picture x={270} y={48} w={34} h={42} tone={sofa} />
      {/* rug, sofa and table */}
      <ellipse cx={150} cy={212} rx={126} ry={20} fill={accent} opacity={0.2} />
      <ellipse cx={150} cy={212} rx={112} ry={16} fill="none" stroke={accent} strokeOpacity={0.35} />
      <rect x={34} y={132} width={118} height={40} rx={9} fill={sofa} {...ln} />
      <rect x={26} y={150} width={134} height={40} rx={9} fill={sofa} {...ln} />
      <rect x={26} y={146} width={18} height={44} rx={8} fill={sofa} {...ln} />
      <rect x={142} y={146} width={18} height={44} rx={8} fill={sofa} {...ln} />
      <path d="M93 152 V172" {...thin} />
      <rect x={50} y={140} width={26} height={22} rx={5} fill={STUCCO} opacity={0.92} {...thin} />
      <rect x={112} y={140} width={26} height={22} rx={5} fill={accent} opacity={0.9} {...thin} />
      <rect x={32} y={190} width={5} height={8} fill={WOOD_DARK} />
      <rect x={150} y={190} width={5} height={8} fill={WOOD_DARK} />
      <ellipse cx={206} cy={204} rx={34} ry={7} fill={WOOD_DARK} {...thin} />
      <path d="M186 206 v14 M226 206 v14" stroke={WOOD_DARK} strokeWidth={2.4} />
      <rect x={196} y={194} width={14} height={4} fill={WHITE} {...thin} />
      <Lamp x={286} base={206} h={84} />
      <Plant x={18} base={214} s={1.15} />
    </Room>
  );
}

export function Kitchen({ n }: { n: number }) {
  const paint = pick(PAINT, n + 1), unit = pick(FABRIC, n), dark = unit === '#C9A66B' ? '#7A6446' : unit;
  return (
    <Room paint={paint} floor="#E7E0D4" floorY={176} tiles>
      {/* splashback */}
      <rect x={0} y={92} width={320} height={28} fill={WHITE} opacity={0.75} />
      {Array.from({ length: 15 }, (_, i) => <line key={i} x1={10 + i * 22} y1={92} x2={10 + i * 22} y2={120} {...thin} />)}
      <line x1={0} y1={106} x2={320} y2={106} {...thin} />
      {/* wall units, hood and window */}
      <rect x={14} y={30} width={104} height={56} fill={dark} {...ln} />
      <path d="M49 30 V86 M83 30 V86" stroke="#fff" strokeOpacity={0.25} />
      <path d="M138 30 h44 v26 l10 22 h-64 l10 -22 Z" fill="#C9CED6" {...ln} />
      <Window x={212} y={34} w={84} h={52} split={3} />
      <Plant x={254} base={96} s={0.42} />
      {/* base units, worktop, hob, oven and sink */}
      <rect x={0} y={120} width={320} height={56} fill={dark} {...ln} />
      {[44, 88, 132, 188, 232, 276].map((x) => <line key={x} x1={x} y1={122} x2={x} y2={176} stroke="#fff" strokeOpacity={0.22} />)}
      {[22, 66, 110, 210, 254, 298].map((x) => <rect key={x} x={x - 6} y={127} width={12} height={2} rx={1} fill={BRASS} />)}
      <rect x={0} y={113} width={320} height={7} fill={STUCCO} {...ln} />
      <rect x={138} y={110} width={44} height={3.5} fill="#2B3142" />
      <rect x={138} y={126} width={44} height={44} rx={2} fill="#2B3142" {...ln} />
      <rect x={143} y={136} width={34} height={22} fill={GLASS_DARK} opacity={0.6} />
      <rect x={144} y={130} width={32} height={2} rx={1} fill="#C9CED6" />
      <path d="M252 113 v-12 q0 -6 8 -6" fill="none" stroke="#9AA1AD" strokeWidth={2.2} strokeLinecap="round" />
      <rect x={236} y={111} width={36} height={3} fill="#C9CED6" />
      {/* island with stools, pendants above */}
      <rect x={66} y={192} width={188} height={40} fill={WHITE} {...ln} />
      <rect x={60} y={186} width={200} height={7} fill={WOOD} {...ln} />
      <path d="M128 193 V232 M192 193 V232" {...thin} />
      {[112, 208].map((x) => (
        <g key={x}>
          <line x1={x} y1={7} x2={x} y2={52} stroke="#4B505F" strokeWidth={1} />
          <path d={`M${x - 13} 66 q13 -22 26 0 Z`} fill={BRASS} {...thin} />
        </g>
      ))}
      <rect x={150} y={176} width={22} height={10} rx={3} fill="#C9A990" {...thin} />
      <circle cx={156} cy={172} r={5} fill="#D9691A" opacity={0.8} />
      <circle cx={165} cy={173} r={4.5} fill="#C7A35C" />
    </Room>
  );
}

export function Bedroom({ n }: { n: number }) {
  const paint = pick(PAINT, n + 2), head = pick(FABRIC, n + 1), throwC = pick(FABRIC, n + 3);
  return (
    <Room paint={paint}>
      <Window x={26} y={40} w={58} h={88} curtain={throwC} split={2} />
      <Picture x={152} y={38} w={56} h={40} tone={head} />
      {/* wardrobe */}
      <rect x={278} y={24} width={50} height={144} fill={WHITE} {...ln} />
      <line x1={303} y1={24} x2={303} y2={168} {...thin} />
      <rect x={298} y={92} width={2} height={12} fill={BRASS} />
      {/* rug */}
      <ellipse cx={180} cy={214} rx={132} ry={18} fill={throwC} opacity={0.18} />
      {/* bedside tables and lamps */}
      {[94, 266].map((x) => (
        <g key={x}>
          <rect x={x - 13} y={146} width={26} height={30} fill={WOOD} {...ln} />
          <line x1={x - 13} y1={160} x2={x + 13} y2={160} {...thin} />
          <Lamp x={x} base={146} h={18} />
        </g>
      ))}
      {/* bed */}
      <path d="M112 152 V104 q0 -12 12 -12 h112 q12 0 12 12 V152 Z" fill={head} {...ln} />
      <path d="M146 96 V150 M180 94 V150 M214 96 V150" stroke="#fff" strokeOpacity={0.18} />
      <rect x={106} y={144} width={148} height={56} rx={6} fill={WHITE} {...ln} />
      <rect x={118} y={128} width={56} height={24} rx={8} fill={WHITE} {...ln} />
      <rect x={186} y={128} width={56} height={24} rx={8} fill={WHITE} {...ln} />
      <rect x={134} y={136} width={36} height={18} rx={6} fill={throwC} opacity={0.85} {...thin} />
      <path d="M106 166 q74 10 148 0" fill="none" {...thin} />
      <rect x={104} y={178} width={152} height={26} rx={5} fill={throwC} {...ln} />
      <path d="M104 190 h152" stroke="#fff" strokeOpacity={0.25} />
      <rect x={112} y={204} width={5} height={7} fill={WOOD_DARK} />
      <rect x={243} y={204} width={5} height={7} fill={WOOD_DARK} />
      <Plant x={18} base={214} s={0.9} />
    </Room>
  );
}

export function Bathroom({ n }: { n: number }) {
  const paint = pick(PAINT, n + 3), unit = pick(FABRIC, n + 2);
  return (
    <Room paint={paint} floor="#E4E0D8" floorY={176} tiles>
      {/* half-height tiling */}
      <rect x={0} y={96} width={320} height={80} fill={WHITE} opacity={0.82} />
      {Array.from({ length: 16 }, (_, i) => <line key={i} x1={i * 21} y1={96} x2={i * 21} y2={176} {...thin} />)}
      {[116, 136, 156].map((y) => <line key={y} x1={0} y1={y} x2={320} y2={y} {...thin} />)}
      <rect x={0} y={93} width={320} height={4} fill={unit} opacity={0.75} />
      <Window x={62} y={30} w={64} h={50} split={2} />
      <rect x={62} y={30} width={64} height={50} fill="#fff" opacity={0.35} />
      {/* the bath */}
      <path d="M14 136 h168 v34 q0 14 -14 14 h-140 q-14 0 -14 -14 Z" fill={WHITE} {...ln} />
      <rect x={10} y={131} width={176} height={7} rx={3.5} fill={WHITE} {...ln} />
      <path d="M160 131 v-14 q0 -6 -8 -6" fill="none" stroke="#9AA1AD" strokeWidth={2.4} strokeLinecap="round" />
      <rect x={28} y={184} width={5} height={6} fill="#9AA1AD" />
      <rect x={164} y={184} width={5} height={6} fill="#9AA1AD" />
      <Plant x={30} base={133} s={0.4} />
      {/* towel rail */}
      <path d="M198 108 h16 M198 122 h16 M198 136 h16 M198 150 h16 M198 104 V156 M214 104 V156" stroke="#9AA1AD" strokeWidth={1.4} fill="none" />
      <rect x={196} y={112} width={20} height={26} rx={2} fill={unit} opacity={0.85} />
      {/* vanity, basin, mirror */}
      <rect x={232} y={132} width={70} height={44} fill={unit} {...ln} />
      <line x1={267} y1={134} x2={267} y2={176} stroke="#fff" strokeOpacity={0.25} />
      <rect x={228} y={126} width={78} height={7} fill={STUCCO} {...ln} />
      <path d="M250 126 q17 -10 34 0 Z" fill={WHITE} {...ln} />
      <path d="M267 118 v-8 q0 -4 5 -4" fill="none" stroke="#9AA1AD" strokeWidth={2} strokeLinecap="round" />
      <circle cx={267} cy={62} r={27} fill={BRASS} />
      <circle cx={267} cy={62} r={24} fill={DAYLIGHT} />
      <path d="M252 72 l24 -24" stroke="#fff" strokeWidth={5} opacity={0.5} strokeLinecap="round" />
    </Room>
  );
}

export function Garden({ n }: { n: number }) {
  const bloom = pick(['#D99A7C', '#C98BA0', '#E0B86A', '#B58FB8'], n);
  return (
    <g>
      <Backdrop sunX={n % 2 ? 60 : 262} skyline={false} />
      <Tree x={n % 2 ? 268 : 54} base={120} h={70} r={34} />
      <Tree x={n % 2 ? 40 : 290} base={116} h={48} r={24} />
      {/* fence */}
      <rect x={0} y={92} width={320} height={64} fill="#CDB892" />
      {Array.from({ length: 23 }, (_, i) => <line key={i} x1={i * 14 + 6} y1={92} x2={i * 14 + 6} y2={156} {...thin} />)}
      <rect x={0} y={90} width={320} height={4} fill="#B99B72" />
      {/* shed */}
      <g transform={n % 2 ? undefined : 'translate(320 0) scale(-1 1)'}>
        <rect x={22} y={98} width={62} height={58} fill="#D9CBB0" {...ln} />
        <polygon points="16,100 53,76 90,100" fill="#8E95A4" {...ln} />
        <rect x={32} y={116} width={20} height={40} fill="#B99B72" {...ln} />
        <rect x={60} y={116} width={16} height={14} fill={GLASS_DARK} {...ln} />
      </g>
      {/* lawn with mown stripes and a planted border */}
      <rect x={0} y={152} width={320} height={88} fill={LAWN} />
      {[0, 2, 4].map((i) => <polygon key={i} points={`${128 + i * 12},152 ${140 + i * 12},152 ${150 + i * 40},240 ${110 + i * 40},240`} fill="#fff" opacity={0.12} />)}
      <Hedge x={n % 2 ? 100 : 0} y={140} w={220} h={18} />
      {Array.from({ length: 9 }, (_, i) => <circle key={i} cx={(n % 2 ? 114 : 14) + i * 24} cy={147 + (i % 2) * 4} r={3} fill={bloom} />)}
      {Array.from({ length: 5 }, (_, i) => <circle key={`h${i}`} cx={(n % 2 ? 126 : 26) + i * 46} cy={143} r={2.2} fill={HEDGE_HI} />)}
      {/* patio, table and chairs */}
      <polygon points="0,206 320,196 320,240 0,240" fill={PAVE} />
      <path d="M0 222 L320 216 M70 204 L50 240 M150 201 L140 240 M230 199 L236 240" {...thin} />
      <g transform={n % 2 ? 'translate(320 0) scale(-1 1)' : undefined}>
        <ellipse cx={226} cy={206} rx={34} ry={7} fill="#F7F3EC" {...ln} />
        <path d="M226 212 V232 M212 234 h28" stroke="#4B505F" strokeWidth={2} />
        <path d="M176 196 v20 h20 M176 216 v18 M196 216 v18" fill="none" stroke="#4B505F" strokeWidth={2} />
        <path d="M276 194 v20 h-20 M276 214 v20 M256 214 v20" fill="none" stroke="#4B505F" strokeWidth={2} />
        <rect x={220} y={196} width={12} height={8} rx={2} fill="#C9A990" />
        <circle cx={226} cy={192} r={6} fill={HEDGE} />
      </g>
    </g>
  );
}

export function Balcony({ n }: { n: number }) {
  const seat = pick(FABRIC, n);
  return (
    <g>
      <Backdrop sunX={n % 2 ? 84 : 240} skyline={false} />
      {/* the city beyond */}
      <path d="M0 176 V112 h26 v-18 h20 v18 h18 v-34 h22 v34 h26 v-12 h18 v-28 l10 -12 l10 12 v40 h24 v-22 h22 v22 h20 v-40 h24 v40 h22 v-16 h18 v16 h20 V176 Z" fill="#E2DCD0" />
      <path d="M0 176 V134 h34 v-14 h28 v14 h30 v-22 h30 v22 h44 v-10 h26 v10 h36 v-26 h30 v26 h32 v-8 h30 V176 Z" fill="#D3CCBF" />
      {Array.from({ length: 12 }, (_, i) => <rect key={i} x={12 + i * 26} y={142 + (i % 3) * 6} width={5} height={7} fill="#EEE9DF" />)}
      <path d="M0 176 q80 -16 160 -6 t160 -4 V190 H0 Z" fill={LEAF} opacity={0.8} />
      {/* glass balustrade and deck */}
      <rect x={0} y={132} width={320} height={64} fill="#DCE7EE" opacity={0.42} />
      {[64, 128, 192, 256].map((x) => <line key={x} x1={x} y1={132} x2={x} y2={196} stroke="#5A6172" strokeWidth={1.2} strokeOpacity={0.6} />)}
      <rect x={0} y={129} width={320} height={4} fill="#4B505F" />
      <rect x={0} y={196} width={320} height={44} fill={WOOD} />
      {[204, 214, 226].map((y) => <line key={y} x1={0} y1={y} x2={320} y2={y} {...thin} />)}
      {/* chairs, table, planters */}
      <g transform={n % 2 ? 'translate(320 0) scale(-1 1)' : undefined}>
        <rect x={150} y={176} width={30} height={5} rx={2} fill={seat} {...thin} />
        <path d="M150 150 v30 M180 180 v24 M152 180 v24 M150 150 h4 v28" fill="none" stroke="#4B505F" strokeWidth={2} />
        <ellipse cx={214} cy={184} rx={16} ry={4} fill="#F7F3EC" {...ln} />
        <path d="M214 188 v18" stroke="#4B505F" strokeWidth={2} />
        <rect x={236} y={176} width={30} height={5} rx={2} fill={seat} {...thin} />
        <path d="M266 150 v30 M236 180 v24 M264 180 v24 M266 150 h-4 v28" fill="none" stroke="#4B505F" strokeWidth={2} />
        <rect x={20} y={182} width={84} height={20} fill="#3B4249" {...ln} />
        <Hedge x={22} y={166} w={80} h={18} />
        <circle cx={40} cy={168} r={3} fill="#D99A7C" />
        <circle cx={62} cy={166} r={3} fill="#E0B86A" />
        <circle cx={84} cy={168} r={3} fill="#D99A7C" />
      </g>
    </g>
  );
}

export function Office({ n, reception = false }: { n: number; reception?: boolean }) {
  const paint = pick(PAINT, n), tone = pick(FABRIC, n);
  return (
    <Room paint={paint} floor="#D9D6CF" floorY={160}>
      {/* a run of windows */}
      <rect x={0} y={30} width={320} height={86} fill={DAYLIGHT} />
      <polygon points="0,116 0,70 60,30 120,30 20,116" fill="#fff" opacity={0.4} />
      {[0, 64, 128, 192, 256, 320].map((x) => <line key={x} x1={x} y1={30} x2={x} y2={116} stroke={FRAME} strokeWidth={4} />)}
      <rect x={0} y={27} width={320} height={4} fill={FRAME} {...thin} />
      <rect x={0} y={114} width={320} height={5} fill={FRAME} {...thin} />
      {/* ceiling lights */}
      {[60, 160, 260].map((x) => <rect key={x} x={x - 26} y={12} width={52} height={5} rx={2} fill="#fff" {...thin} />)}
      {reception ? (
        <g>
          <rect x={86} y={142} width={148} height={52} fill={tone} {...ln} />
          <rect x={80} y={136} width={160} height={7} fill={STUCCO} {...ln} />
          <rect x={134} y={160} width={52} height={7} rx={3.5} fill="#fff" opacity={0.85} />
          <rect x={258} y={168} width={46} height={30} rx={8} fill={pick(FABRIC, n + 2)} {...ln} />
          <rect x={258} y={156} width={46} height={20} rx={8} fill={pick(FABRIC, n + 2)} {...ln} />
          <Plant x={40} base={206} s={1.3} />
        </g>
      ) : (
        <g>
          {[[28, 150, 0.8], [124, 150, 0.8], [220, 150, 0.8], [8, 186, 1], [118, 186, 1], [228, 186, 1]].map(([x, y, s], i) => (
            <g key={i}>
              <rect x={x} y={y} width={84 * s} height={5 * s} fill={WOOD} {...ln} />
              <path d={`M${x + 6 * s} ${y + 5 * s} v${22 * s} M${x + 78 * s} ${y + 5 * s} v${22 * s}`} stroke="#4B505F" strokeWidth={1.6} />
              <rect x={x + 26 * s} y={y - 22 * s} width={32 * s} height={19 * s} rx={1.5} fill="#2B3142" {...thin} />
              <rect x={x + 40 * s} y={y - 3 * s} width={4 * s} height={3 * s} fill="#4B505F" />
              <rect x={x + 60 * s} y={y + 12 * s} width={18 * s} height={14 * s} rx={3} fill={tone} opacity={0.9} />
            </g>
          ))}
        </g>
      )}
    </Room>
  );
}

export function Parking({ n }: { n: number }) {
  return (
    <g>
      <Backdrop sunX={n % 2 ? 60 : 262} />
      <rect x={30} y={70} width={260} height={96} fill={pick(PAINT, n)} {...ln} />
      {[52, 108, 164, 220].map((x) => <rect key={x} x={x} y={86} width={44} height={22} fill={GLASS_DARK} {...thin} />)}
      {[52, 108, 164, 220].map((x) => <rect key={`g${x}`} x={x} y={124} width={44} height={22} fill={GLASS_DARK} {...thin} />)}
      <Hedge x={0} y={154} w={320} h={16} />
      <rect x={0} y={166} width={320} height={74} fill="#D3CEC6" />
      {[20, 90, 160, 230, 300].map((x) => <polygon key={x} points={`${x},170 ${x + 3},170 ${(x - 160) * 1.5 + 163},240 ${(x - 160) * 1.5 + 157},240`} fill="#fff" opacity={0.9} />)}
      {[[104, '#2E3A5A'], [222, '#B46A4C']].map(([x, c]) => (
        <g key={x as number}>
          <path d={`M${(x as number) - 30} 208 q2 -14 14 -16 l8 -12 h22 l10 12 q10 2 10 16 v6 h-64 Z`} fill={c as string} {...ln} />
          <path d={`M${(x as number) - 6} 181 h17 l8 10 h-31 Z`} fill={DAYLIGHT} opacity={0.85} />
          <circle cx={(x as number) - 16} cy={214} r={6} fill="#2B3142" />
          <circle cx={(x as number) + 20} cy={214} r={6} fill="#2B3142" />
        </g>
      ))}
      <Tree x={n % 2 ? 296 : 22} base={170} h={96} r={30} />
    </g>
  );
}

/** A drawn plan, for the "floor plan view" picture of a commercial listing. */
export function PlanSheet() {
  return (
    <g>
      <rect width={320} height={240} fill="#F7F5F0" />
      <rect x={40} y={30} width={240} height={180} fill="#fff" {...ln} strokeWidth={2.4} strokeOpacity={0.8} />
      <path d="M40 120 H180 M180 30 V210 M180 150 H280 M110 120 V210" fill="none" stroke={INK} strokeOpacity={0.8} strokeWidth={2.4} />
      <path d="M76 120 a18 18 0 0 1 18 -18 M180 80 a18 18 0 0 0 18 18 M230 150 a18 18 0 0 1 18 18" fill="none" {...thin} strokeOpacity={0.5} />
      {[[86, 78, 'Open-plan office'], [214, 92, 'Meeting'], [64, 168, 'Kitchen'], [136, 168, 'Core'], [214, 184, 'Reception']].map(([x, y, t]) => <text key={t as string} x={x as number} y={y as number} fontSize={8.5} fill={INK} fillOpacity={0.7} fontFamily="var(--sans)">{t}</text>)}
    </g>
  );
}
