import { memo, type CSSProperties, type SVGProps } from 'react';

/**
 * Streetkey journey artwork: a fine-line elevation of a Victorian London terrace.
 *
 * Drawn like an architect's elevation with restrained tonal washes: stock-brick
 * fronts, stucco cornices and string courses, canted bays, sash windows with
 * glazing bars, arched door surrounds with fanlights, party-wall chimney stacks,
 * garden walls with railings and hedges, plane trees and column lamps. Behind it,
 * a layered city fades into the haze (aerial perspective).
 *
 * Performance: each house front is defined once (two handed variants) and placed
 * with <use>; repeated detail (brick, slate, railings, brackets, paving) is done
 * with patterns. Per-house colour comes in through CSS custom properties (--wall,
 * --door), which inherit into <use> instances.
 */

export const GROUND = 770; // building line / back of pavement
export const BAY = 160; // one house front (≈ 5.5 m)
export const X0 = 190; // left edge of house 0 (the eight story houses are 0..7)
export const RIDGE = 500;
export const EAVES = 556;
export const DOT_Y = 497; // the locator dot rides the ridge line
export const KERB = 812;
export const POTS_TOP = 440; // highest chimney pot: callouts clear this
/** Every bay of the terrace, story houses 0..7 plus the street running on either side. */
export const BAYS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
export const bayX = (k: number) => X0 + k * BAY;
export const mirrored = (k: number) => ((k % 2) + 2) % 2 === 1; // doors pair up at alternate party walls

export interface Pal {
  night: boolean;
  sky: [string, string, string];
  sun: string; sunOp: number;
  far: string; farLine: string;
  mid: string; midDark: string; midLine: string; midWin: string; midTree: string;
  via: string; viaLine: string;
  train: string; trainBand: string; trainWin: string;
  walls: string[]; stack: string; pot: string;
  stucco: string; roof: [string, string]; ridge: string; lead: string;
  glass: [string, string]; glassHi: string; glassHiOp: number;
  frame: string; line: string; lineOp: number; shade: string; shadeOp: number;
  recess: string; doors: string[]; step: string; brass: string;
  gwall: string; coping: string; hedge: string; hedgeHi: string; rail: string;
  pave: string; paveLine: string; kerb: string; kerbTop: string; road: [string, string]; roadLine: string;
  leaf: string; leafHi: string; leafLo: string; trunk: string;
  lamp: string; lampGlass: string;
  figure: string; van: string; vanLine: string; tyre: string;
  scaff: string; plank: string; net: string; netOp: number;
  lit: [string, string, string];
  warm: string; warmOp: number;
  boardFace: string; boardInk: string;
  pv: string;
}

export const DAY: Pal = {
  night: false,
  sky: ['#F7F5F0', '#F3EEE5', '#ECE1CF'],
  sun: '#F1D5AE', sunOp: 0.36,
  far: '#D9D3CA', farLine: '#CCC4B8',
  mid: '#CDC6BB', midDark: '#BFB6A9', midLine: '#ABA192', midWin: '#DCD7CF', midTree: '#C3C5B3',
  via: '#D4C6B2', viaLine: '#BCAD97',
  train: '#F4F1EB', trainBand: '#C8C2B8', trainWin: '#A2A9B4',
  walls: ['#E5D7BF', '#DBC7AC', '#EDE6D8', '#E0CCB1', '#DEDCD2'],
  stack: '#D8C4A7', pot: '#C0927A',
  stucco: '#FBF8F2', roof: ['#ACB2BE', '#8E95A4'], ridge: '#7A8192', lead: '#959BA6',
  glass: ['#87929F', '#CBD1D8'], glassHi: '#FFFFFF', glassHiOp: 0.32,
  frame: '#FCFAF6', line: '#0E1424', lineOp: 0.4, shade: '#1D2443', shadeOp: 0.13,
  recess: '#4B505F', doors: ['#2E3A5A', '#6B3934', '#4B6453', '#262A35', '#55687D', '#7A6446'], step: '#ECE7DD', brass: '#C7A35C',
  gwall: '#D8C4A7', coping: '#F2EDE4', hedge: '#7E8D6C', hedgeHi: '#9BA987', rail: '#2B3142',
  pave: '#ECE6DC', paveLine: '#D9D1C3', kerb: '#DCD4C7', kerbTop: '#F7F3EC', road: ['#DAD3C7', '#E9E4DB'], roadLine: '#F6F2EC',
  leaf: '#94A084', leafHi: '#B3BEA1', leafLo: '#7A876B', trunk: '#8F877A',
  lamp: '#3C4356', lampGlass: '#F7F1E4',
  figure: '#4A5167', van: '#FBF9F5', vanLine: '#0E1424', tyre: '#2B3142',
  scaff: '#59607A', plank: '#CBB58E', net: '#FFFFFF', netOp: 0.34,
  lit: ['#FFE8AE', '#FFC24B', '#F3A23F'],
  warm: '#FFCC8A', warmOp: 0.16,
  boardFace: '#FFFFFF', boardInk: '#0E1424',
  pv: '#26324F',
};

export const NIGHT: Pal = {
  night: true,
  sky: ['#101731', '#151F3E', '#29335F'],
  sun: '#6B5672', sunOp: 0.34,
  far: '#1E2850', farLine: '#2B3766',
  mid: '#1A2346', midDark: '#151D3C', midLine: '#2A3563', midWin: '#FFC24B', midTree: '#17213F',
  via: '#1B2447', viaLine: '#2B3664',
  train: '#2A3560', trainBand: '#1C2547', trainWin: '#FFD27A',
  walls: ['#222C50', '#242C4D', '#283157', '#212A4B', '#262F52'],
  stack: '#222B4E', pot: '#2E2A45',
  stucco: '#323E6E', roof: ['#1A2241', '#121831'], ridge: '#2A3460', lead: '#1E2646',
  glass: ['#0B1128', '#18213F'], glassHi: '#9FB2FF', glassHiOp: 0.06,
  frame: '#121936', line: '#A9B5EA', lineOp: 0.17, shade: '#03061A', shadeOp: 0.3,
  recess: '#090E22', doors: ['#121A36', '#341C27', '#18282F', '#0E1325', '#1E2B45', '#2F261E'], step: '#28315C', brass: '#8D7442',
  gwall: '#1C2547', coping: '#2B3561', hedge: '#13202F', hedgeHi: '#1B2B3D', rail: '#060A1A',
  pave: '#1A2242', paveLine: '#232D55', kerb: '#27325E', kerbTop: '#33407A', road: ['#151C38', '#131A35'], roadLine: '#2E3967',
  leaf: '#162039', leafHi: '#1F2C49', leafLo: '#0F172F', trunk: '#1F2847',
  lamp: '#070B1B', lampGlass: '#FFDB8F',
  figure: '#070B1A', van: '#2B355C', vanLine: '#9AA8E0', tyre: '#05081A',
  scaff: '#7D8AC0', plank: '#3B3F5C', net: '#A9B5EA', netOp: 0.07,
  lit: ['#FFE9AE', '#FFC24B', '#EE9637'],
  warm: '#FFB35A', warmOp: 0,
  boardFace: '#EAE6DD', boardInk: '#0E1424',
  pv: '#0A0F22',
};

/* ---------------------------------------------------------------- geometry */

type R = [number, number, number, number];
/** Glazed openings of one house front (door on the left; mirror for the other hand). */
export const WINS: R[] = [
  [21, 586, 24, 46], // first floor, over the door
  [84, 586, 22, 46], // first floor, paired over the bay
  [112, 586, 22, 46],
  [68.5, 667, 9, 57], // canted bay: left face
  [83.5, 667, 51, 57], // centre
  [140.5, 667, 9, 57], // right face
];
const DC = 33; // door centre line
export const winRect = (n: number, m: boolean): R => { const [x, y, w, h] = WINS[n]; return [m ? BAY - x - w : x, y, w, h]; };
export const doorX = (m: boolean) => (m ? BAY - DC : DC);
export const fanPath = (m: boolean, ox = 0) => { const c = doorX(m) + ox; return `M${c - 12} 691V679A12 12 0 0 1 ${c + 12} 679V691Z`; };
export const bayCentre = (m: boolean) => (m ? BAY - 109 : 109);

const pts = (m: boolean, p: number[][]) => p.map(([x, y]) => `${m ? BAY - x : x},${y}`).join(' ');

/** Small deterministic PRNG so the drawing is identical on every render. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** An organic, lobed outline (foliage). */
export function lobed(cx: number, cy: number, rx: number, ry: number, n: number, seed: number, rough = 0.16) {
  const r = rng(seed);
  const p: [number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = ((k + r() * 0.35) / n) * Math.PI * 2;
    const s = 1 - rough * r();
    p.push([cx + Math.cos(a) * rx * s, cy + Math.sin(a) * ry * s, a]);
  }
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let k = 0; k < n; k++) {
    const a = p[k], b = p[(k + 1) % n];
    let ma = (a[2] + b[2]) / 2; if (k === n - 1) ma += Math.PI;
    const bulge = 1.03 + r() * (0.05 + rough * 0.5);
    d += `Q${(cx + Math.cos(ma) * rx * bulge).toFixed(1)} ${(cy + Math.sin(ma) * ry * bulge).toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return d + 'Z';
}

/* ------------------------------------------------------------------- defs */

function HouseFront({ m, P }: { m: boolean; P: Pal }) {
  const f = (x: number, w = 0) => (m ? BAY - x - w : x);
  const hl = { stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.7, fill: 'none' } as const;
  const st = { fill: P.stucco };
  const sh = { fill: P.shade, fillOpacity: P.shadeOp };
  const box = (x: number, y: number, w: number, h: number, p: SVGProps<SVGRectElement> = {}, key?: string) => <rect key={key} x={f(x, w)} y={y} width={w} height={h} {...p} />;
  const faceR = m ? 95 : 153; // right-hand edge of the bay (the side in shade)
  const dc = doorX(m);
  return (
    <>
      {/* slate roof, ridge */}
      <rect x={-0.5} y={RIDGE} width={BAY + 1} height={EAVES - RIDGE} fill="url(#j-roof)" />
      <rect x={-0.5} y={RIDGE} width={BAY + 1} height={EAVES - RIDGE} style={{ fill: 'var(--roof, transparent)' }} />
      <rect x={-0.5} y={RIDGE} width={BAY + 1} height={EAVES - RIDGE} fill="url(#j-slate)" />
      <rect x={-0.5} y={RIDGE - 2.5} width={BAY + 1} height={4} fill={P.ridge} />
      {/* brick front */}
      <rect x={0} y={EAVES} width={BAY} height={GROUND - EAVES} style={{ fill: `var(--wall, ${P.walls[0]})` }} />
      <rect x={0} y={EAVES} width={BAY} height={GROUND - EAVES} fill="url(#j-brick)" />
      {/* eaves cornice on brackets, with the soffit's shadow */}
      <rect x={-0.5} y={549} width={BAY + 1} height={8} {...st} />
      <path d={`M-0.5 549.4H${BAY + 0.5}M-0.5 557H${BAY + 0.5}`} {...hl} />
      <rect x={0} y={557} width={BAY} height={7} fill="url(#j-brackets)" />
      <rect x={0} y={557} width={BAY} height={20} fill="url(#j-soffit)" />
      {/* party wall, downpipe */}
      <path d={`M0.35 557V${GROUND}`} {...hl} />
      {box(4, 563, 2.2, GROUND - 563, { fill: P.lead })}
      {box(3, 559, 4.2, 5, { fill: P.lead })}
      {/* string course */}
      <rect x={0} y={639} width={BAY} height={5} {...st} />
      <path d={`M0 639.4H${BAY}M0 644H${BAY}`} {...hl} />
      <rect x={0} y={644.3} width={BAY} height={3} {...sh} />

      {/* first floor: architraves, hoods, sills, glass */}
      {box(18, 583, 30, 50, st)}
      {box(81, 583, 56, 50, st)}
      {box(18, 583, 30, 50, hl)}
      {box(81, 583, 56, 50, hl)}
      {[[15, 36], [77, 64]].map(([x, w]) => (
        <g key={x}>
          {box(x, 574.5, w, 5.5, { ...st, ...hl, fill: P.stucco })}
          {box(x - 1, 572.6, w + 2, 2, { ...st, ...hl, fill: P.stucco })}
          {box(x + 1, 580, w - 2, 3, sh)}
        </g>
      ))}
      {[[16.5, 33], [79, 60]].map(([x, w]) => (
        <g key={x}>
          {box(x, 632, w, 3.5, { ...st, ...hl, fill: P.stucco })}
          {box(x + 0.5, 635.5, w - 1, 3, sh)}
        </g>
      ))}

      {/* canted bay: lead roof, cornice, frieze, piers, glass, sill, panelled apron */}
      <polygon points={pts(m, [[64, 647], [78, 637.5], [140, 637.5], [154, 647]])} fill={P.lead} {...{ stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.7 }} />
      {box(62.5, 646, 93, 5.5, { ...st, ...hl, fill: P.stucco })}
      {box(65, 651.5, 88, 15.5, st)}
      {[[65, 3.5], [77.5, 6], [134.5, 6], [149.5, 3.5]].map(([x, w]) => box(x, 667, w, 57, st, `p${x}`))}
      {box(63, 724, 92, 4.5, { ...st, ...hl, fill: P.stucco })}
      {box(65, 728.5, 88, 41.5, st)}
      {[[68.5, 9], [84, 50], [140.5, 9]].map(([x, w]) => box(x, 733, w, 32, { ...hl, strokeOpacity: P.lineOp * 0.7 }, `a${x}`))}
      <path d={`M${f(80)} 646V${GROUND}M${f(138)} 646V${GROUND}M${f(65)} 651.5V${GROUND}M${f(153)} 651.5V${GROUND}M${f(65)} 667H${f(153)}`} {...hl} />
      <rect x={faceR - 15} y={638} width={15} height={GROUND - 638} fill={P.shade} fillOpacity={P.shadeOp * 0.7} />
      <polygon points={`${faceR},652 ${faceR + 7},659 ${faceR + 7},${GROUND} ${faceR},${GROUND}`} {...sh} />

      {/* glass: tint, reveal shadow (light from the upper left), sky reflection */}
      {WINS.map((_, n) => {
        const [x, y, w, h] = winRect(n, m);
        return (
          <g key={n}>
            <rect x={x} y={y} width={w} height={h} fill="url(#j-glass)" />
            <path d={`M${x} ${y}h${w}v3.6h${-(w - 2.6)}V${y + h}H${x}Z`} {...sh} fillOpacity={P.shadeOp * 1.6} />
            <polygon points={`${x + w * 0.52},${y} ${x + w * 0.8},${y} ${x + w * 0.38},${y + h} ${x + w * 0.1},${y + h}`} fill={P.glassHi} fillOpacity={P.glassHiOp} />
          </g>
        );
      })}

      {/* door: stucco surround, hood on consoles, arched opening, fanlight, panelled door, steps */}
      {box(13, 657, 40, 95, st)}
      {box(13, 657, 40, 95, hl)}
      {box(10, 650.5, 46, 5.5, { ...st, ...hl, fill: P.stucco })}
      {box(11.5, 656, 3.5, 7, { ...st, ...hl, fill: P.stucco })}
      {box(51, 656, 3.5, 7, { ...st, ...hl, fill: P.stucco })}
      <path d={`M${dc - 12} 752V679A12 12 0 0 1 ${dc + 12} 679V752Z`} fill={P.recess} />
      <path d={`M${dc - 15} 679A15 15 0 0 1 ${dc + 15} 679M${dc - 15} 679V752M${dc + 15} 679V752`} {...hl} />
      <polygon points={`${dc - 2.6},661.5 ${dc + 2.6},661.5 ${dc + 1.7},667.6 ${dc - 1.7},667.6`} {...st} {...{ stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.6 }} />
      <path d={fanPath(m)} fill="url(#j-glass)" />
      <rect x={dc - 11.5} y={692} width={23} height={60} style={{ fill: `var(--door, ${P.doors[0]})` }} />
      {[[-8.5, 695, 7.5, 22], [1, 695, 7.5, 22], [-8.5, 721, 7.5, 27], [1, 721, 7.5, 27]].map(([x, y, w, h]) => <rect key={`${x}${y}`} x={dc + x} y={y} width={w} height={h} fill="none" stroke="#000" strokeOpacity={0.24} strokeWidth={0.6} />)}
      <rect x={dc - 3.5} y={718.6} width={7} height={1.6} fill={P.brass} />
      <circle cx={dc + (m ? -7 : 7)} cy={709} r={1.1} fill={P.brass} />
      <path d={`M${dc - 12} 752V679A12 12 0 0 1 ${dc - 9} 671.3V752Z`} {...sh} fillOpacity={P.shadeOp * 1.8} />
      {[[19, 752, 28], [17, 758, 32], [15, 764, 36]].map(([x, y, w]) => (
        <g key={y}>
          {box(x, y, w, 6, { fill: P.step })}
          <path d={`M${f(x, w)} ${y + 0.3}h${w}`} {...hl} />
        </g>
      ))}
    </>
  );
}

/** Glazing bars & sash frames: drawn above the window-light layer so lit glass reads as glass. */
function HouseBars({ m, P }: { m: boolean; P: Pal }) {
  const fr = { fill: 'none', stroke: P.frame, strokeWidth: 1.4 } as const;
  const hl = { stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.6, fill: 'none' } as const;
  const dc = doorX(m);
  return (
    <>
      {WINS.map((_, n) => {
        const [x, y, w, h] = winRect(n, m);
        return (
          <g key={n}>
            <rect x={x + 0.7} y={y + 0.7} width={w - 1.4} height={h - 1.4} {...fr} />
            <rect x={x} y={y + h / 2 - 1.1} width={w} height={2.2} fill={P.frame} />
            {w > 15 && <path d={`M${x + w / 2} ${y}V${y + h}`} stroke={P.frame} strokeWidth={1} />}
            <rect x={x} y={y} width={w} height={h} {...hl} />
          </g>
        );
      })}
      <path d={`M${dc - 12} 691V679A12 12 0 0 1 ${dc + 12} 679V691`} {...fr} strokeWidth={1.2} />
      {[45, 90, 135].map((a) => <path key={a} d={`M${dc} 690L${(dc + Math.cos((a * Math.PI) / 180) * 12).toFixed(2)} ${(679 - Math.sin((a * Math.PI) / 180) * 12).toFixed(2)}`} stroke={P.frame} strokeWidth={0.8} />)}
      <rect x={dc - 12} y={690.2} width={24} height={2} fill={P.frame} />
    </>
  );
}

function GardenFront({ P, hedge }: { P: Pal; hedge: boolean }) {
  const hl = { stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.6, fill: 'none' } as const;
  const top = 'M57.5 749V726Q57.5 719.5 63 719.5' + Array.from({ length: 10 }, (_, k) => { const x = 63 + k * 9.7; return `Q${(x + 4.8).toFixed(1)} ${k % 2 ? 715.6 : 716.8} ${(x + 9.7).toFixed(1)} ${k % 3 ? 719.4 : 718.6}`; }).join('') + 'L160.5 719V749Z';
  return (
    <>
      {hedge ? (
        <g>
          <path d={top} fill={P.hedge} />
          <path d="M57.5 749V736Q90 731 120 735Q142 732 160.5 735V749Z" fill={P.shade} fillOpacity={P.shadeOp * 0.9} />
          <path d="M60 724Q64 718 72 718.5Q85 714 98 718Q112 714 126 717.5Q140 714 154 718L160.5 718.5V723Q140 721 118 723Q92 721 60 724Z" fill={P.hedgeHi} fillOpacity={0.55} />
          <path d="M-0.5 749V724Q2 718.5 6.5 719.5Q8.5 721 8.5 726V749Z" fill={P.hedge} />
        </g>
      ) : (
        <g>
          <rect x={57.5} y={723} width={103} height={23} fill="url(#j-rail)" />
          <rect x={-0.5} y={723} width={9} height={23} fill="url(#j-rail)" />
        </g>
      )}
      <rect x={-0.5} y={749} width={12.5} height={21} fill={P.gwall} />
      <rect x={54} y={749} width={106.5} height={21} fill={P.gwall} />
      <rect x={-0.5} y={749} width={12.5} height={21} fill="url(#j-brick)" />
      <rect x={54} y={749} width={106.5} height={21} fill="url(#j-brick)" />
      <rect x={-0.5} y={745.5} width={12.5} height={4} fill={P.coping} />
      <rect x={54} y={745.5} width={106.5} height={4} fill={P.coping} />
      <path d="M-0.5 745.7H12M54 745.7H160.5M-0.5 749.5H12M54 749.5H160.5" {...hl} />
      {[8.5, 51].map((x) => (
        <g key={x}>
          <rect x={x} y={737} width={6.5} height={33} fill={P.gwall} />
          <rect x={x + 4.2} y={737} width={2.3} height={33} fill={P.shade} fillOpacity={P.shadeOp} />
          <rect x={x - 1} y={734} width={8.5} height={3.5} fill={P.coping} />
          <path d={`M${x - 1} 734.2h8.5M${x} 737V770M${x + 6.5} 737V770`} {...hl} />
        </g>
      ))}
    </>
  );
}

function StackDef({ P }: { P: Pal }) {
  const hl = { stroke: P.line, strokeOpacity: P.lineOp, strokeWidth: 0.6, fill: 'none' } as const;
  return (
    <>
      <polygon points="16,500 34,500 40,512 16,512" fill={P.shade} fillOpacity={P.shadeOp * 0.8} />
      <rect x={-16} y={466} width={32} height={40} fill={P.stack} />
      <rect x={-16} y={466} width={32} height={40} fill="url(#j-brick)" />
      <rect x={6} y={466} width={10} height={40} fill={P.shade} fillOpacity={P.shadeOp} />
      <rect x={-19} y={460} width={38} height={6} fill={P.stack} />
      <rect x={-17.5} y={456.5} width={35} height={3.5} fill={P.stack} />
      <rect x={-19} y={466} width={38} height={2.5} fill={P.shade} fillOpacity={P.shadeOp * 1.2} />
      <path d="M-16 466V506M16 466V506M-19 460H19V466H-19ZM-17.5 456.5H17.5V460" {...hl} />
      {[[-12, 443], [-4, 446], [4, 442.5], [12, 445]].map(([x, t]) => (
        <g key={x}>
          <path d={`M${x - 2.7} 456.5L${x - 2.1} ${t + 2}H${x + 2.1}L${x + 2.7} 456.5Z`} fill={P.pot} />
          <rect x={x - 2.9} y={t} width={5.8} height={2.2} fill={P.pot} />
          <path d={`M${x + 0.8} 456.5L${x + 1.2} ${t + 2}H${x + 2.1}L${x + 2.7} 456.5Z`} fill={P.shade} fillOpacity={P.shadeOp * 1.2} />
        </g>
      ))}
    </>
  );
}

export const Defs = memo(function Defs({ P }: { P: Pal }) {
  const so = (c: string, o = 1) => ({ stopColor: c, stopOpacity: o });
  return (
    <defs>
      <linearGradient id="j-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={so(P.sky[0])} /><stop offset="0.36" style={so(P.sky[0])} /><stop offset="0.5" style={so(P.sky[1])} /><stop offset="0.6" style={so(P.sky[2])} /><stop offset="1" style={so(P.sky[2])} />
      </linearGradient>
      <radialGradient id="j-sun" cx="1040" cy="540" r="900" gradientUnits="userSpaceOnUse">
        <stop offset="0" style={so(P.sun, P.sunOp)} /><stop offset="0.45" style={so(P.sun, P.sunOp * 0.35)} /><stop offset="1" style={so(P.sun, 0)} />
      </radialGradient>
      <linearGradient id="j-farfade" x1="0" y1="300" x2="0" y2="505" gradientUnits="userSpaceOnUse">
        <stop offset="0" style={so(P.far)} /><stop offset="1" style={so(P.sky[2], P.night ? 1 : 0.9)} />
      </linearGradient>
      <linearGradient id="j-midfade" x1="0" y1="320" x2="0" y2="505" gradientUnits="userSpaceOnUse">
        <stop offset="0" style={so(P.mid)} /><stop offset="1" style={so(P.night ? P.mid : P.far)} />
      </linearGradient>
      <linearGradient id="j-glass" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" style={so(P.glass[0])} /><stop offset="1" style={so(P.glass[1])} />
      </linearGradient>
      <linearGradient id="j-roof" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={so(P.roof[0])} /><stop offset="1" style={so(P.roof[1])} />
      </linearGradient>
      <radialGradient id="j-lit" cx="0.5" cy="0.3" r="0.85">
        <stop offset="0" style={so(P.lit[0])} /><stop offset="0.5" style={so(P.lit[1])} /><stop offset="1" style={so(P.lit[2])} />
      </radialGradient>
      <linearGradient id="j-soffit" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={so(P.shade, P.shadeOp * 1.5)} /><stop offset="1" style={so(P.shade, 0)} />
      </linearGradient>
      <linearGradient id="j-road" x1="0" y1={KERB + 6} x2="0" y2={KERB + 96} gradientUnits="userSpaceOnUse">
        <stop offset="0" style={so(P.road[0])} /><stop offset="0.55" style={so(P.road[1])} /><stop offset="1" style={so(P.night ? '#121A33' : '#F7F5F0')} />
      </linearGradient>
      <linearGradient id="j-warm" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style={so(P.warm, P.warmOp)} /><stop offset="0.75" style={so(P.warm, 0)} />
      </linearGradient>
      <linearGradient id="j-ao" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={so(P.shade, 0)} /><stop offset="1" style={so(P.shade, P.shadeOp * 0.8)} />
      </linearGradient>
      <radialGradient id="j-cloud">
        <stop offset="0" style={so('#FFFFFF', 0.95)} /><stop offset="0.6" style={so('#FFFFFF', 0.5)} /><stop offset="1" style={so('#FFFFFF', 0)} />
      </radialGradient>
      <radialGradient id="j-lamp">
        <stop offset="0" style={so(P.lit[0], 0.7)} /><stop offset="0.25" style={so(P.lit[1], 0.28)} /><stop offset="1" style={so(P.lit[1], 0)} />
      </radialGradient>
      <radialGradient id="j-pool">
        <stop offset="0" style={so(P.lit[1], P.night ? 0.32 : 0)} /><stop offset="1" style={so(P.lit[1], 0)} />
      </radialGradient>
      <linearGradient id="j-spill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={so(P.lit[1], P.night ? 0.65 : 0.4)} /><stop offset="1" style={so(P.lit[1], 0)} />
      </linearGradient>
      <linearGradient id="j-pvsheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={so('#FFFFFF', P.night ? 0.06 : 0.28)} /><stop offset="0.5" style={so('#FFFFFF', 0)} />
      </linearGradient>

      <pattern id="j-brick" width="14" height="8" patternUnits="userSpaceOnUse">
        <path d="M0 .25H14M0 4.25H14M3.5 .25V4.25M10.5 4.25V8.25" stroke={P.line} strokeOpacity={P.night ? 0.1 : 0.075} strokeWidth="0.5" fill="none" />
      </pattern>
      <pattern id="j-slate" width="9" height="9" patternUnits="userSpaceOnUse" y={RIDGE}>
        <path d="M0 .3H9M0 4.8H9M.3 .3V4.8M4.8 4.8V9.3" stroke={P.night ? '#000' : P.line} strokeOpacity={P.night ? 0.3 : 0.13} strokeWidth="0.5" fill="none" />
      </pattern>
      <pattern id="j-brackets" width="20" height="7" patternUnits="userSpaceOnUse" y={557}>
        <path d="M8.5 0h3v3.2c0 2.2-.7 3.6-1.5 3.6S8.5 5.4 8.5 3.2Z" fill={P.stucco} stroke={P.line} strokeOpacity={P.lineOp} strokeWidth="0.5" />
      </pattern>
      <pattern id="j-rail" width="4.6" height="23" patternUnits="userSpaceOnUse" y={723}>
        <rect x="1.9" y="1.6" width="0.9" height="21.4" fill={P.rail} />
        <path d="M2.35 0l1.05 2.3h-2.1Z" fill={P.rail} />
        <rect x="0" y="4.2" width="4.6" height="0.8" fill={P.rail} />
        <rect x="0" y="19.6" width="4.6" height="0.8" fill={P.rail} />
      </pattern>
      <pattern id="j-pave" width="64" height="42" patternUnits="userSpaceOnUse" y={GROUND}>
        <path d="M.5 0V21M32.5 21V42M0 21.2H64" stroke={P.paveLine} strokeWidth="0.8" fill="none" />
      </pattern>
      <pattern id="j-cells" width="5" height="6.4" patternUnits="userSpaceOnUse">
        <path d="M0 .25H5M.25 0V6.4" stroke="#9FB0DA" strokeOpacity={P.night ? 0.18 : 0.4} strokeWidth="0.45" fill="none" />
      </pattern>

      <clipPath id="j-clip-front"><rect x={-160} y={440} width={1920} height={GROUND - 440 - 22} /></clipPath>
      <g id="j-front-a"><HouseFront m={false} P={P} /></g>
      <g id="j-front-b"><HouseFront m P={P} /></g>
      <g id="j-bars-a"><HouseBars m={false} P={P} /></g>
      <g id="j-bars-b"><HouseBars m P={P} /></g>
      <g id="j-garden-r"><GardenFront P={P} hedge={false} /></g>
      <g id="j-garden-h"><GardenFront P={P} hedge /></g>
      <g id="j-stack"><StackDef P={P} /></g>
    </defs>
  );
});

/* -------------------------------------------------------------- backdrop */

const STARS = Array.from({ length: 34 }, (_, k) => { const r = rng(k * 7919 + 13); return [Math.round(r() * 1600), Math.round(40 + r() * 330), +(0.5 + r() * 0.9).toFixed(2), +(0.25 + r() * 0.6).toFixed(2), k % 4 === 0] as const; });

/** Sky, far city and the mid-distance (school, church, viaduct). Static: re-renders only with the theme. */
export const Backdrop = memo(function Backdrop({ P, train }: { P: Pal; train: boolean }) {
  const hl = (c: string, w = 0.7) => ({ stroke: c, strokeWidth: w, fill: 'none' }) as const;
  const viaduct = viaductPath();
  return (
    <>
      <rect x={-160} y={-60} width={1920} height={1020} fill="url(#j-sky)" />
      <rect x={-160} y={-60} width={1920} height={1020} fill="url(#j-sun)" />
      {P.night ? (
        <g className="j-stars">
          {STARS.map(([x, y, r, o, tw], k) => <circle key={k} className={tw ? 'j-anim j-tw' : undefined} style={tw ? ({ ['--t' as string]: `${(k % 5) * -1.3}s` } as CSSProperties) : undefined} cx={x} cy={y} r={r} fill="#F7F5F0" opacity={o} />)}
          <g transform="translate(905 176)">
            <circle r="15" fill="#F3EEDF" opacity="0.92" />
            <circle cx="6.5" cy="-4" r="13.5" fill={P.sky[0]} />
            <circle r="46" fill="url(#j-lamp)" opacity="0.18" />
          </g>
        </g>
      ) : (
        <g className="j-clouds">
          <g className="j-anim j-cloud">
            <ellipse cx="900" cy="214" rx="150" ry="11" fill="url(#j-cloud)" />
            <ellipse cx="960" cy="204" rx="80" ry="9" fill="url(#j-cloud)" />
            <ellipse cx="860" cy="224" rx="70" ry="6" fill="url(#j-cloud)" opacity="0.8" />
          </g>
          <g className="j-anim j-cloud j-cloud2">
            <ellipse cx="1250" cy="338" rx="170" ry="10" fill="url(#j-cloud)" opacity="0.8" />
            <ellipse cx="1320" cy="330" rx="70" ry="7" fill="url(#j-cloud)" opacity="0.8" />
          </g>
        </g>
      )}

      {/* far: the City in the haze */}
      <g className="j-far">
        <g fill="url(#j-farfade)">
          {[[-40, 470, 70, 40], [40, 452, 44, 60], [120, 466, 60, 40], [214, 444, 40, 60], [360, 462, 70, 40], [470, 450, 46, 56], [560, 468, 60, 40],
            [796, 454, 32, 50], [832, 440, 24, 64], [862, 464, 30, 40], [898, 446, 34, 58], [1012, 396, 26, 108], [1016, 388, 18, 10], [1142, 428, 40, 76], [1186, 452, 34, 52], [1226, 466, 44, 40], [1290, 470, 50, 34], [1556, 458, 50, 46], [1610, 470, 60, 34]].map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />)}
          <rect x="296" y="372" width="9" height="132" />
          <rect x="292" y="388" width="17" height="22" rx="3" />
          <polygon points="942,505 969,306 973,294 976,303 979,300 1004,505" />
          <path d="M1050 505V436C1050 410 1058 393 1067 387C1076 393 1084 410 1084 436V505Z" />
          <polygon points="1094,505 1090,418 1097,403 1128,403 1134,418 1128,505" />
        </g>
        <g {...hl(P.farLine, 0.8)} opacity={P.night ? 0.9 : 1}>
          <path d="M300.5 372V350M971 306L962 505M1067 392V505M1012 412H1038M1012 430H1038M1012 448H1038" />
          <path d="M1200 505V388M1158 392H1288M1188 392V386L1200 382L1212 386M1200 382L1158 392M1200 382L1288 392M1268 392V428M1172 392V400H1186V392" />
          <path d="M1504 505V404M1474 408H1572M1504 400L1474 408M1504 400L1572 408M1556 408V436" />
        </g>
        {P.night && <g fill={P.midWin} opacity="0.55">{[[1018, 420], [1026, 452], [1018, 470], [1150, 446], [1162, 470], [1064, 450], [1102, 430], [1112, 458], [906, 470], [842, 460]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="2.2" height="2.6" />)}</g>}
      </g>

      {/* mid: church spire, board school with its bell turret, plane trees, the railway viaduct */}
      <g className="j-mid">
        <g>
          <rect x="744" y="418" width="32" height="90" fill="url(#j-midfade)" />
          <polygon points="742,420 760,316 778,420" fill="url(#j-midfade)" />
          <path d="M760 316V304M756 309H764M742 420H778M744 428H776M752 440V452M768 440V452" {...hl(P.midLine)} />
          <path d="M753 452V441A3 3 0 0 1 759 441V452ZM761 452V441A3 3 0 0 1 767 441V452Z" fill={P.midDark} />
        </g>
        <g>
          <rect x="1330" y="428" width="236" height="80" fill="url(#j-midfade)" />
          <polygon points="1340,430 1385,386 1430,430" fill="url(#j-midfade)" />
          <polygon points="1466,430 1511,386 1556,430" fill="url(#j-midfade)" />
          <rect x="1426" y="372" width="42" height="58" fill={P.mid} />
          <path d="M1430 372V352H1464V372ZM1436 372V358A4 4 0 0 1 1444 358V372ZM1450 372V358A4 4 0 0 1 1458 358V372Z" fill={P.midDark} fillRule="evenodd" />
          <path d="M1426 352Q1447 324 1468 352Z" fill={P.mid} />
          <path d="M1447 334V314M1447 318L1455 321M1426 352H1468M1426 372H1468M1340 430H1556M1385 386V430M1511 386V430" {...hl(P.midLine)} />
          {[1348, 1366, 1394, 1412, 1474, 1492, 1520, 1538].map((x) => <path key={x} d={`M${x} 506V448A5 5 0 0 1 ${x + 10} 448V506Z`} fill={P.night ? (x % 3 ? '#2A2F4E' : P.midWin) : P.midWin} opacity={P.night ? 0.75 : 1} />)}
          {[1372, 1498].map((x) => <circle key={x} cx={x + 13} cy="410" r="6" fill={P.midDark} />)}
        </g>
        <path d={viaduct} fill={P.via} fillRule="evenodd" />
        <path d="M520 458.5H1720M520 468H1720" {...hl(P.viaLine)} />
        <g className={`j-anim j-train${train ? ' on' : ''}`}>
          <path d="M0 458V446Q0 439.5 8 439H420Q430 439.6 434 448L435 458Z" fill={P.train} />
          <rect x="6" y="443" width="418" height="5.2" fill={P.trainWin} />
          <rect x="0" y="454.5" width="435" height="3.5" fill={P.trainBand} />
          <path d="M86 439V458M172 439V458M258 439V458M344 439V458" stroke={P.via} strokeWidth="2" />
          <path d="M0 458V446Q0 439.5 8 439H420Q430 439.6 434 448L435 458Z" {...hl(P.viaLine)} />
        </g>
        {[[560, 472, 48, 40, 3], [668, 466, 42, 36, 5], [1246, 470, 46, 38, 7], [1620, 470, 50, 40, 9], [420, 474, 52, 36, 11], [-20, 470, 60, 42, 15]].map(([x, y, rx, ry, s]) => <path key={x} d={lobed(x, y, rx, ry, 11, s)} fill={P.midTree} />)}
      </g>
    </>
  );
});

let viaductCache = '';
function viaductPath() {
  if (viaductCache) return viaductCache;
  let d = 'M520 458H1720V512H520Z';
  for (let x = 532; x < 1720; x += 64) d += `M${x} 512V500A25 25 0 0 1 ${x + 50} 500V512Z`;
  viaductCache = d;
  return d;
}

/* ------------------------------------------------------------- the street */

/** Pavement, kerb and road. */
export const Ground = memo(function Ground({ P }: { P: Pal }) {
  return (
    <g className="j-np">
      <rect x={-160} y={GROUND} width={1920} height={KERB - GROUND} fill={P.pave} />
      <rect x={-160} y={GROUND} width={1920} height={KERB - GROUND} fill="url(#j-pave)" />
      <rect x={-160} y={KERB} width={1920} height={6} fill={P.kerb} />
      <path d={`M-160 ${KERB + 0.4}H1760`} stroke={P.kerbTop} strokeWidth="0.9" />
      <rect x={-160} y={KERB + 6} width={1920} height={140} fill="url(#j-road)" />
      <path d={`M-160 ${KERB + 6.4}H1760`} stroke={P.line} strokeOpacity={P.lineOp * 0.6} strokeWidth="0.8" />
      <rect x={-160} y={KERB + 6} width={1920} height={10} fill="url(#j-ao)" transform={`rotate(180 800 ${KERB + 11})`} />
    </g>
  );
});

export const TREES: [number, number][] = [[-10, 1], [350, 3], [830, 5], [1310, 7]];
const CLUMPS = [[-46, 626, 34], [44, 614, 38], [-12, 588, 40], [24, 586, 30], [-34, 660, 30], [34, 656, 32], [2, 632, 44], [-2, 668, 28]];
function crown(x: number, seed: number) {
  const j = rng(seed * 977);
  return CLUMPS.map(([dx, y, r], n) => ({ x: x + dx * (0.85 + j() * 0.3), y: y + (j() - 0.5) * 12, r: r * (0.85 + j() * 0.3), s: seed * 31 + n })).sort((a, b) => a.y - b.y);
}
/** Late sun from the left: each tree throws a soft shadow onto the house fronts to its right. */
export const TreeShadows = memo(function TreeShadows({ P }: { P: Pal }) {
  if (P.night) return null;
  return (
    <g className="j-np" opacity={0.055} fill={P.shade} clipPath="url(#j-clip-front)">
      {TREES.map(([x, s]) => crown(x + 40, s).map((c) => <path key={`${x}-${c.s}`} d={lobed(c.x, c.y - 4, c.r * 0.9, c.r * 0.8, 15, c.s, 0.3)} />))}
    </g>
  );
});
export const Trees = memo(function Trees({ P }: { P: Pal }) {
  return (
    <g className="j-np">
      {TREES.map(([x, s]) => (
        <g key={x}>
          {!P.night && <ellipse cx={x + 46} cy={804} rx={64} ry={4.5} fill={P.shade} fillOpacity={P.shadeOp * 0.75} />}
          <rect x={x - 13} y={808} width={26} height={2.6} fill={P.shade} fillOpacity={P.shadeOp * 1.4} />
          <path d={`M${x - 4.6} 809C${x - 4} 760 ${x - 3.4} 720 ${x - 2.2} 668H${x + 2.4}C${x + 3.4} 720 ${x + 4} 760 ${x + 4.8} 809Z`} fill={P.trunk} />
          <path d={`M${x - 1} 700L${x - 30} 640M${x + 1} 690L${x + 28} 632M${x} 680L${x + 3} 600M${x - 10} 680L${x - 20} 664`} stroke={P.trunk} strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d={`M${x + 1.2} 805C${x + 1.6} 760 ${x + 1.8} 720 ${x + 2} 672`} stroke={P.shade} strokeOpacity={P.shadeOp * 2} strokeWidth="2" fill="none" />
          {crown(x, s).map((c) => (
            <g key={c.s}>
              <path d={lobed(c.x, c.y, c.r, c.r * 0.86, 19, c.s, 0.24)} fill={P.leaf} />
              <path d={lobed(c.x + c.r * 0.2, c.y + c.r * 0.24, c.r * 0.74, c.r * 0.58, 15, c.s + 5, 0.26)} fill={P.leafLo} fillOpacity={0.75} />
              <path d={lobed(c.x - c.r * 0.26, c.y - c.r * 0.28, c.r * 0.52, c.r * 0.4, 13, c.s + 9, 0.26)} fill={P.leafHi} fillOpacity={0.9} />
            </g>
          ))}
          <path d={`M${x - 2} 664L${x - 16} 646M${x + 2} 660L${x + 14} 650`} stroke={P.trunk} strokeWidth="1.6" strokeLinecap="round" opacity={0.85} />
        </g>
      ))}
    </g>
  );
});

export const LAMPS = [670, 1150, 1630, 190];
export const Lamps = memo(function Lamps({ P }: { P: Pal }) {
  return (
    <g className="j-np">
      {LAMPS.map((x) => (
        <g key={x}>
          {!P.night && <path d={`M${x + 4} 810L${x + 92} 803.5L${x + 94} 805.5L${x + 4} 811Z`} fill={P.shade} fillOpacity={P.shadeOp * 0.8} />}
          <path d={`M${x - 5} 810h10l-1.6-11h-6.8Z`} fill={P.lamp} />
          <rect x={x - 1.5} y={694} width={3} height={106} fill={P.lamp} />
          <rect x={x - 2.6} y={760} width={5.2} height={3} fill={P.lamp} />
          <rect x={x - 10} y={703} width={20} height={1.6} fill={P.lamp} />
          <circle cx={x - 10} cy={703.8} r={1.3} fill={P.lamp} />
          <circle cx={x + 10} cy={703.8} r={1.3} fill={P.lamp} />
          <path d={`M${x - 7} 677H${x + 7}L${x + 4.6} 693H${x - 4.6}Z`} fill={P.lampGlass} stroke={P.lamp} strokeWidth="1" />
          <path d={`M${x} 677V693`} stroke={P.lamp} strokeWidth="0.6" />
          <path d={`M${x - 8.5} 677L${x} 669L${x + 8.5} 677Z`} fill={P.lamp} />
          <path d={`M${x} 669V663`} stroke={P.lamp} strokeWidth="1.2" />
          <rect x={x - 5} y={693} width={10} height={2.4} fill={P.lamp} />
        </g>
      ))}
    </g>
  );
});
/** Lamp light: halos and pools (visible at night only; transparent by day). */
export const LampLight = memo(function LampLight({ P }: { P: Pal }) {
  if (!P.night) return null;
  return (
    <g className="j-np">
      {LAMPS.map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={812} rx={96} ry={14} fill="url(#j-pool)" />
          <circle cx={x} cy={685} r={52} fill="url(#j-lamp)" />
        </g>
      ))}
    </g>
  );
});

/* ---------------------------------------------- scale figures & the van */

const MAN = 'M-1.6 -45.8H1.6L1.8 -44.2C4.6 -44 6.4 -43.2 6.9 -41.2L8 -27.5C8.1 -26 7.6 -25.3 7 -25.2L6.2 -21.4H4.9L4.4 -1.4L5.9 -.1L5.8 .4H1.2L1 -1.6L.5 -19.2H-.5L-1 -1.6L-1.2 .4H-5.8L-5.9 -.1L-4.4 -1.4L-4.9 -21.4H-6.2L-7 -25.2C-7.6 -25.3 -8.1 -26 -8 -27.5L-6.9 -41.2C-6.4 -43.2 -4.6 -44 -1.8 -44.2Z';
const WOMAN = 'M-1.4 -43H1.4C4.2 -42.6 5.8 -41.6 6.1 -39.6L7.2 -24.5L6.4 -23.8L7.6 -15.5H3.6L3.3 -1.2L4.6 .3H1.1L.8 -14.8H-.8L-1.1 .3H-4.6L-3.3 -1.2L-3.6 -15.5H-7.6L-6.4 -23.8L-7.2 -24.5L-6.1 -39.6C-5.8 -41.6 -4.2 -42.6 -1.4 -43Z';
const HAIR = 'M-3.4 -46.5C-3.8 -51 -2 -51.8 0 -51.8C2.4 -51.8 3.9 -50.4 3.5 -46C3.3 -44 2.9 -43 3.6 -42L-3.6 -42C-2.9 -43 -3.3 -44.5 -3.4 -46.5Z';
const CHILD = 'M-1.2 -26.3H1.2C3.4 -26 4.6 -25.2 4.9 -23.6L5.6 -14.5H3.4L3.1 -.8L3.9 .3H.9L.6 -12.6H-.6L-.9 .3H-3.9L-3.1 -.8L-3.4 -14.5H-5.6L-4.9 -23.6C-4.6 -25.2 -3.4 -26 -1.2 -26.3Z';
const FEET = 806;

export function Figure({ x, kind, P, flip = false }: { x: number; kind: 'man' | 'woman' | 'child'; P: Pal; flip?: boolean }) {
  return (
    <g transform={`translate(${x} ${FEET})${flip ? ' scale(-1 1)' : ''}`} fill={P.figure}>
      <ellipse cx={0} cy={2} rx={kind === 'child' ? 5 : 8} ry={1.4} fill={P.shade} fillOpacity={P.shadeOp * 1.6} />
      {kind === 'man' && <><ellipse cx={0} cy={-49.6} rx={3.3} ry={3.9} /><path d={MAN} /></>}
      {kind === 'woman' && <><ellipse cx={0} cy={-47} rx={3.1} ry={3.7} /><path d={HAIR} /><path d={WOMAN} /><rect x={6.2} y={-27.5} width={5} height={6.8} rx={0.8} /><path d="M6.1 -40L8.6 -27.4" stroke={P.figure} strokeWidth="0.6" /></>}
      {kind === 'child' && <><ellipse cx={0} cy={-29.6} rx={3} ry={3.4} /><path d={CHILD} /></>}
    </g>
  );
}

/** A removal / builder's van drawn as a fine-line elevation, parked at the kerb. */
export function Van({ x, P }: { x: number; P: Pal }) {
  const ln = { stroke: P.vanLine, strokeOpacity: P.night ? 0.32 : 0.5, strokeWidth: 0.75, fill: 'none' } as const;
  const body = 'M2 -10V-26.5Q2 -31.5 6 -34L16.5 -49Q18.5 -51.5 23 -51.5H39V-73Q39 -75 41 -75H151Q153 -75 153 -73V-10Z';
  return (
    <g transform={`translate(${x} 846)`}>
      <ellipse cx={78} cy={0.5} rx={82} ry={3} fill={P.shade} fillOpacity={P.shadeOp * 1.8} />
      <path d={body} fill={P.van} />
      <rect x={2} y={-24} width={151} height={14} fill={P.shade} fillOpacity={P.shadeOp * 0.7} />
      <rect x={39} y={-75} width={114} height={4} fill={P.shade} fillOpacity={P.shadeOp * 0.5} />
      <path d="M11.5 -35L20.5 -47.5H35V-35Z" fill="url(#j-glass)" />
      <path d={`${body}M39 -51.5V-10M11.5 -35L20.5 -47.5H35V-35ZM2 -24H153M96 -75V-24M140 -75V-24M41 -36.5H153`} {...ln} />
      <path d="M41 -36.5H153" stroke={P.vanLine} strokeOpacity={P.night ? 0.25 : 0.32} strokeWidth={2.2} />
      <rect x={29} y={-31} width={5} height={1.4} fill={P.vanLine} fillOpacity={0.45} />
      <path d="M8.5 -40.5h-3v4.5h3" fill={P.vanLine} fillOpacity={0.5} />
      <rect x={0.5} y={-24} width={3.4} height={4.2} rx={1} fill={P.night ? '#FFE3A3' : '#F1E7CF'} />
      <rect x={150.4} y={-27} width={3} height={6} fill="#C2341B" fillOpacity={P.night ? 0.85 : 0.5} />
      {[26, 128].map((cx) => (
        <g key={cx}>
          <path d={`M${cx - 12.5} -10A12.5 12.5 0 0 1 ${cx + 12.5} -10Z`} fill={P.night ? '#0A0F22' : '#5A6072'} fillOpacity={P.night ? 1 : 0.35} />
          <circle cx={cx} cy={-7} r={8.8} fill={P.tyre} />
          <circle cx={cx} cy={-7} r={4.4} fill={P.night ? '#3C4670' : '#B9BEC9'} />
          <circle cx={cx} cy={-7} r={1.4} fill={P.tyre} />
        </g>
      ))}
    </g>
  );
}

/* ------------------------------------------------------- per-house extras */

/** Estate-agent board on a post in the front garden. */
export function Board({ cx, kind, P }: { cx: number; kind: 'sale' | 'sold' | 'let'; P: Pal }) {
  return (
    <>
      <rect x={cx - 1.1} y={714} width={2.2} height={34} fill={P.rail} />
      <rect x={cx - 21} y={692} width={42} height={24} fill={P.boardFace} stroke={P.boardInk} strokeOpacity={0.55} strokeWidth={0.7} />
      <rect x={cx - 21} y={692} width={42} height={5} fill={P.boardInk} />
      {kind === 'sale' && <text x={cx} y={710.2} textAnchor="middle" className="j-board-t" fill={P.boardInk}>FOR SALE</text>}
      {kind !== 'sale' && (
        <g transform={`rotate(-9 ${cx} 705)`}>
          <rect x={cx - 23} y={699.5} width={46} height={10} fill={P.boardInk} />
          <text x={cx} y={707.2} textAnchor="middle" className="j-board-t" fill="#FFFFFF">{kind === 'sold' ? 'SOLD' : 'LET'}</text>
        </g>
      )}
    </>
  );
}

/** Loft dormer and solar slates for "Grow" (house-local coordinates). */
export function Grow({ m, P }: { m: boolean; P: Pal }) {
  const c = bayCentre(m);
  const pv0 = m ? 98 : 16;
  const hl = { stroke: P.line, strokeOpacity: P.lineOp * 1.3, strokeWidth: 0.7, fill: 'none' } as const;
  return (
    <>
      <rect x={c - 21} y={514} width={42} height={37} fill={P.stucco} />
      <rect x={c - 14} y={519} width={28} height={27} fill="url(#j-lit)" />
      <path d={`M${c - 14} 532.5H${c + 14}M${c} 519V546`} stroke={P.frame} strokeWidth={1.4} />
      <rect x={c + 9} y={514} width={12} height={37} fill={P.shade} fillOpacity={P.shadeOp} />
      <polygon points={`${c - 25},516 ${c},503 ${c + 25},516`} fill={P.lead} />
      <path d={`M${c - 25} 516L${c} 503L${c + 25} 516M${c - 21} 516V551H${c + 21}V516M${c - 14} 519H${c + 14}V546H${c - 14}Z`} {...hl} />
      {[0, 1, 2].map((n) => (
        <g key={n}>
          <rect x={pv0 + n * 15.5} y={511} width={14.5} height={32} fill={P.pv} />
          <rect x={pv0 + n * 15.5} y={511} width={14.5} height={32} fill="url(#j-cells)" />
          <rect x={pv0 + n * 15.5} y={511} width={14.5} height={32} fill="url(#j-pvsheen)" stroke={P.line} strokeOpacity={P.lineOp} strokeWidth={0.6} />
        </g>
      ))}
    </>
  );
}

/** Scaffold with debris netting for "Refurb" (house-local coordinates). */
export function Scaffold({ P }: { P: Pal }) {
  const s = { stroke: P.scaff, strokeWidth: 1.3, strokeOpacity: 0.85 } as const;
  return (
    <>
      <rect x={-7} y={538} width={174} height={GROUND - 538} fill={P.net} fillOpacity={P.netOp} />
      <path d={[-4, 52, 108, 164].map((x) => `M${x} ${GROUND}V532`).join('') + [764, 708, 652, 596, 542].map((y) => `M-9 ${y}H169`).join('') + 'M-4 764L52 708M52 708L108 652M108 652L164 596M164 596L108 542'} {...s} fill="none" />
      {[708, 652, 596, 542].map((y) => <rect key={y} x={-8} y={y - 3.4} width={176} height={2.6} fill={P.plank} />)}
      <path d={[708, 652, 596, 542].map((y) => `M-8 ${y - 9}H168`).join('')} stroke={P.scaff} strokeOpacity={0.55} strokeWidth={0.8} />
    </>
  );
}
