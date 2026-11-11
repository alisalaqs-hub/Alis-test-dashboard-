import type { CSSProperties, ReactNode } from 'react';
import { BAY, Figure, type Pal } from './art';

/**
 * Inside the buyer's home: a cutaway of the house drawn over its front, in three layers that the
 * story reveals in turn (classes on the wrapping <g className="j-in">, see journey.css):
 *
 *   model   the plans, as a blueprint: rooms, stairs, sizes, the unconverted loft
 *   built   each room is finished in turn (loft conversion first, then down the house)
 *   lived   furniture, lights and the family
 *
 * House-local coordinates, like the rest of the street art: x 0..160 across the front, y in drawing
 * units (ridge 500, pavement 770). `m` mirrors the plan for houses with the door on the right; text is
 * never mirrored. Purely decorative: the story is told in words by the scene's hidden summary.
 */

/* Structure: inner faces of the party walls, the hall wall, and the floors. */
const L = 3, R = 157, W1 = 58, W2 = 61;
const LOFT_TOP = 509, LOFT_FLOOR = 556, FIRST_TOP = 561, FIRST_FLOOR = 644, GROUND_TOP = 650, GROUND_FLOOR = 752, BASE = 770;

const BP = { day: '#1B2B5E', night: '#101A3C', line: '#E4EBFF', accent: '#FF9A47' };
const ROOM = { loft: '#F1ECE2', bath: '#DCE9EC', bed: '#E3E8DB', hall: '#EFE6D6', living: '#ECE3D3', breast: '#DDD1BC', timber: '#C6A77B', tile: '#C3DAE0', white: '#FDFBF7', ink: '#2B3142' };

export interface InsideFacts {
  /** e.g. "92 m²" and "3 bed" for the plans. */
  area: string; beds: string;
  /** Tags shown as each part of the works finishes, from the cost engine. */
  loft: string; bathroom: string; rewire: string; decorate: string;
}

type Kids = { children?: ReactNode };
/** A finished room: its wall colour wipes across, then its fittings fade in. `k` is its turn in the works. */
function Room({ k, x, y, w, h, fill, children }: Kids & { k: number; x: number; y: number; w: number; h: number; fill: string }) {
  const style = { ['--k' as string]: k, ['--w' as string]: `${w}px` } as CSSProperties;
  return (
    <g style={style}>
      <rect className="j-wipe" x={x} y={y} width={w} height={h} fill={fill} />
      <g className="j-fit">{children}</g>
      <rect className="j-anim j-scan" x={x - 0.6} y={y} width={1.2} height={h} fill={BP.accent} />
    </g>
  );
}
/** A piece of furniture: drops into place on moving in. `i` is its turn. */
const Fur = ({ i, children }: Kids & { i: number }) => <g className="j-fur" style={{ ['--i' as string]: i } as CSSProperties}>{children}</g>;
/** A small label on the plans or the works. */
function Tag({ x, y, text, accent = false, k }: { x: number; y: number; text: string; accent?: boolean; k?: number }) {
  const w = text.length * 2.9 + 7;
  return (
    <g className={k == null ? 'j-in-label' : 'j-fit j-tag j-in-label'} style={k == null ? undefined : ({ ['--k' as string]: k } as CSSProperties)}>
      <rect x={x - w / 2} y={y - 5} width={w} height={8} rx={4} fill={accent ? BP.accent : '#0E1424'} fillOpacity={accent ? 1 : 0.82} />
      <text x={x} y={y + 0.9} textAnchor="middle" fontSize={4.6} fontWeight={800} letterSpacing={0.3} fill={accent ? '#0E1424' : '#FFFFFF'}>{text}</text>
    </g>
  );
}

export function Inside({ m, P, facts }: { m: boolean; P: Pal; facts: InsideFacts }) {
  // Mirror a position (and a width) for a door-on-the-right house.
  const f = (x: number, w = 0) => (m ? BAY - x - w : x);
  const dir = m ? -1 : 1;
  const bp = P.night ? BP.night : BP.day;
  const ln = { stroke: BP.line, strokeWidth: 0.7, fill: 'none', strokeOpacity: 0.85 } as const;
  const thin = { stroke: BP.line, strokeWidth: 0.45, fill: 'none', strokeOpacity: 0.5 } as const;
  const edge = { stroke: ROOM.ink, strokeOpacity: 0.28, strokeWidth: 0.5, fill: 'none' } as const;

  // The stairs rise from the front door towards the middle of the house: 12 steps in side view.
  const stairs = Array.from({ length: 12 }, (_, n) => `${n === 0 ? `M${f(8)} ${GROUND_FLOOR}` : ''}v-8.5h${4 * dir}`).join('');
  const stairsFill = `${stairs}V${GROUND_FLOOR}Z`;
  const grid = [...Array.from({ length: 17 }, (_, n) => `M0 ${514 + n * 16}H${BAY}`), ...Array.from({ length: 9 }, (_, n) => `M${16 + n * 16} 504V${BASE}`)].join('');
  const hatch = Array.from({ length: 13 }, (_, n) => `M${L + n * 12} ${LOFT_FLOOR}l14 -${LOFT_FLOOR - LOFT_TOP}`).join('');
  const onFloor = (floor: number) => `translate(0 ${floor - 806})`; // Figure stands on the pavement line (806)

  return (
    <>
      {/* ── the model: the plans as a blueprint ── */}
      <g className="j-model">
        <rect x={0} y={504} width={BAY} height={BASE - 504} fill={bp} />
        <path d={grid} stroke={BP.line} strokeOpacity={0.07} strokeWidth={0.5} />
        <path d={`M${L} ${LOFT_TOP}H${R}V${BASE}H${L}ZM${L} ${LOFT_FLOOR}H${R}M${L} ${FIRST_TOP}H${R}M${L} ${FIRST_FLOOR}H${R}M${L} ${GROUND_TOP}H${R}M${L} ${GROUND_FLOOR}H${R}`} {...ln} />
        <path d={`M${f(W1)} ${FIRST_TOP}V${FIRST_FLOOR}M${f(W2)} ${FIRST_TOP}V${FIRST_FLOOR}M${f(W1)} ${GROUND_TOP}V${GROUND_FLOOR}M${f(W2)} ${GROUND_TOP}V${GROUND_FLOOR}`} {...ln} />
        <path d={stairs} {...ln} />
        <path d={hatch} {...thin} strokeDasharray="2 2.4" />
        {/* doorways on the back wall, and the chimney breast */}
        <path d={`M${f(132)} ${GROUND_FLOOR}V708H${f(132, 14)}V${GROUND_FLOOR}M${f(134)} ${FIRST_FLOOR}V604H${f(134, 13)}V${FIRST_FLOOR}M${f(96)} ${GROUND_TOP}V${GROUND_FLOOR}M${f(96, 28)} ${GROUND_TOP}V${GROUND_FLOOR}M${f(103)} ${GROUND_FLOOR}V724H${f(103, 14)}V${GROUND_FLOOR}`} {...thin} />
        {/* overall width */}
        <path d={`M${L} 763H${R}M${L} 760.5V765.5M${R} 760.5V765.5`} {...thin} strokeOpacity={0.8} />
        <g className="j-in-label" fill={BP.line} textAnchor="middle" fontWeight={700} letterSpacing={0.9}>
          <text x={f(109)} y={700} fontSize={6}>LIVING</text>
          <text x={f(109)} y={707.5} fontSize={4.2} fillOpacity={0.7} letterSpacing={0.3}>4.3 × 3.9 m</text>
          <text x={f(31)} y={672} fontSize={6}>HALL</text>
          <text x={f(109)} y={604} fontSize={6}>BED 1</text>
          <text x={f(109)} y={611.5} fontSize={4.2} fillOpacity={0.7} letterSpacing={0.3}>4.3 × 3.4 m</text>
          <text x={f(31)} y={604} fontSize={6}>BATH</text>
          <text x={80} y={535} fontSize={6}>LOFT</text>
          <text x={80} y={542.5} fontSize={4.2} fill={BP.accent} letterSpacing={0.3}>not yet converted</text>
          <text x={80} y={768.6} fontSize={4.2} fillOpacity={0.8} letterSpacing={0.3}>{facts.beds} · {facts.area}</text>
        </g>
      </g>

      {/* ── the works: each room is finished in turn ── */}
      <g className="j-built">
        <Room k={0} x={L} y={LOFT_TOP} w={R - L} h={LOFT_FLOOR - LOFT_TOP} fill={ROOM.loft}>
          {[34, 100].map((x) => (
            <g key={x}>
              <rect x={f(x, 22)} y={513.5} width={22} height={15} fill="#CFE2F1" stroke={ROOM.white} strokeWidth={1.4} />
              <path d={`M${f(x, 22) + 11} 513.5v15`} stroke={ROOM.white} strokeWidth={0.9} />
            </g>
          ))}
          <rect x={L} y={LOFT_FLOOR - 3} width={R - L} height={3} fill={ROOM.timber} />
          <path d={`M${L} ${LOFT_TOP}H${R}`} {...edge} />
        </Room>
        <Room k={1} x={f(L, W1 - L)} y={FIRST_TOP} w={W1 - L} h={FIRST_FLOOR - FIRST_TOP} fill={ROOM.bath}>
          <rect x={f(L, W1 - L)} y={606} width={W1 - L} height={FIRST_FLOOR - 606} fill={ROOM.tile} />
          <path d={[612, 620, 628, 636].map((y) => `M${f(L, W1 - L)} ${y}h${W1 - L}`).join('') + [11, 19, 27, 35, 43, 51].map((x) => `M${f(x)} 606V${FIRST_FLOOR}`).join('')} stroke={ROOM.white} strokeOpacity={0.75} strokeWidth={0.5} />
          <rect x={f(L, W1 - L)} y={FIRST_FLOOR - 2.4} width={W1 - L} height={2.4} fill="#AEB9BF" />
        </Room>
        <Room k={2} x={f(W2, R - W2)} y={FIRST_TOP} w={R - W2} h={FIRST_FLOOR - FIRST_TOP} fill={ROOM.bed}>
          <rect x={f(134, 13)} y={604} width={13} height={FIRST_FLOOR - 604} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.25} strokeWidth={0.5} />
          <circle cx={f(136.5)} cy={626} r={0.8} fill={ROOM.ink} fillOpacity={0.5} />
          <rect x={f(W2, R - W2)} y={FIRST_FLOOR - 3} width={R - W2} height={3} fill={ROOM.timber} />
          <path d={`M${f(W2, R - W2)} ${FIRST_FLOOR - 5.4}h${R - W2}`} stroke={ROOM.white} strokeWidth={1.4} />
        </Room>
        <Room k={3} x={f(L, W1 - L)} y={GROUND_TOP} w={W1 - L} h={GROUND_FLOOR - GROUND_TOP} fill={ROOM.hall}>
          <path d={stairsFill} fill={ROOM.timber} />
          <path d={stairs} stroke={ROOM.white} strokeWidth={1} fill="none" />
          <path d={`M${f(8)} ${GROUND_FLOOR - 22}L${f(56)} ${GROUND_TOP + 6}`} stroke={ROOM.ink} strokeOpacity={0.6} strokeWidth={1.1} />
          <path d={[14, 22, 30, 38, 46, 54].map((x) => `M${f(x)} ${GROUND_FLOOR - 22 - ((x - 8) / 48) * 74}v${14}`).join('')} stroke={ROOM.ink} strokeOpacity={0.35} strokeWidth={0.6} />
          <rect x={f(L, W1 - L)} y={GROUND_FLOOR - 2.4} width={W1 - L} height={2.4} fill="#B9AE9C" />
        </Room>
        <Room k={4} x={f(W2, R - W2)} y={GROUND_TOP} w={R - W2} h={GROUND_FLOOR - GROUND_TOP} fill={ROOM.living}>
          <rect x={f(96, 28)} y={GROUND_TOP} width={28} height={GROUND_FLOOR - GROUND_TOP} fill={ROOM.breast} />
          <rect x={f(103, 14)} y={724} width={14} height={GROUND_FLOOR - 724} fill="#3A3F4E" />
          <path d={`M${f(100, 20)} 722.5h20`} stroke={ROOM.white} strokeWidth={2.2} />
          <rect x={f(132, 14)} y={708} width={14} height={GROUND_FLOOR - 708} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.25} strokeWidth={0.5} />
          <path d={`M${f(W2, R - W2)} 668h${R - W2}`} stroke={ROOM.white} strokeWidth={1} strokeOpacity={0.9} />
          <rect x={f(W2, R - W2)} y={GROUND_FLOOR - 3} width={R - W2} height={3} fill={ROOM.timber} />
          <path d={`M${f(W2, R - W2)} ${GROUND_FLOOR - 5.4}h${R - W2}`} stroke={ROOM.white} strokeWidth={1.4} />
        </Room>
        {/* floors and walls, drawn over the rooms */}
        <g className="j-fit" style={{ ['--k' as string]: 0 } as CSSProperties}>
          <path d={`M${L} ${LOFT_FLOOR}H${R}V${FIRST_TOP}H${L}ZM${L} ${FIRST_FLOOR}H${R}V${GROUND_TOP}H${L}Z`} fill={ROOM.white} />
          <path d={`M${f(W1)} ${FIRST_TOP}h${3 * dir}V${FIRST_FLOOR}h${-3 * dir}ZM${f(W1)} ${GROUND_TOP}h${3 * dir}V${GROUND_FLOOR}h${-3 * dir}Z`} fill={ROOM.white} />
          <path d={`M${L} ${LOFT_FLOOR}H${R}M${L} ${FIRST_TOP}H${R}M${L} ${FIRST_FLOOR}H${R}M${L} ${GROUND_TOP}H${R}`} {...edge} />
        </g>
        <g className="j-fit" style={{ ['--k' as string]: 3 } as CSSProperties}>
          <rect x={L} y={GROUND_FLOOR} width={R - L} height={BASE - GROUND_FLOOR} fill={P.night ? '#2A3358' : '#D9CDB8'} />
          <path d={`M${L} ${GROUND_FLOOR}H${R}`} {...edge} />
        </g>
        <Tag k={0} x={80} y={546} text={facts.loft} accent />
        <Tag k={1} x={f(30.5)} y={574} text={facts.bathroom} />
        <Tag k={2} x={f(100)} y={574} text={facts.rewire} />
        <Tag k={4} x={f(88)} y={662} text={facts.decorate} />
      </g>

      {/* ── the crew, while the works are on ── */}
      <g className="j-crew">
        <path d={`M${f(70)} ${GROUND_FLOOR}l${7 * dir} -26l${7 * dir} 26M${f(72.6)} 742h${8.8 * dir}M${f(74.6)} 734h${4.8 * dir}`} stroke={P.scaff} strokeWidth={1.1} fill="none" />
        {[{ x: 90, floor: GROUND_FLOOR }, { x: 122, floor: FIRST_FLOOR }].map(({ x, floor }) => (
          <g key={x} transform={onFloor(floor)}>
            <g className="j-anim j-step">
              <Figure x={f(x)} kind="man" P={P} />
              <path d={`M${f(x) - 4.2} ${806 - 51.2}a4.2 4.2 0 0 1 8.4 0z`} fill="#F2B43C" />
            </g>
          </g>
        ))}
        <path d={`M${f(128)} ${FIRST_FLOOR - 36}l${9 * dir} -12`} stroke={P.figure} strokeWidth={1} />
        <rect x={f(135, 6)} y={FIRST_FLOOR - 52} width={6} height={3.4} rx={1.2} fill={BP.accent} />
      </g>

      {/* ── moving in: furniture, lights and the family ── */}
      <g className="j-lived">
        {/* living room */}
        <Fur i={0}><ellipse cx={f(92)} cy={GROUND_FLOOR - 1.4} rx={30} ry={1.6} fill="#B8553A" fillOpacity={0.55} /></Fur>
        <Fur i={1}>
          <rect x={f(64, 30)} y={727} width={30} height={12} rx={3} fill="#3D5A73" />
          <rect x={f(63, 32)} y={736} width={32} height={12} rx={2.5} fill="#4A6B87" />
          <rect x={f(68, 8)} y={731} width={8} height={7} rx={1.6} fill="#F07415" />
          <path d={`M${f(66)} 748v4M${f(92)} 748v4`} stroke={ROOM.ink} strokeWidth={1} />
        </Fur>
        <Fur i={2}>
          <rect x={f(128, 17)} y={733} width={17} height={15} rx={3} fill="#D8A446" />
          <path d={`M${f(130)} 748v4M${f(143)} 748v4`} stroke={ROOM.ink} strokeWidth={1} />
        </Fur>
        <Fur i={3}>
          <path d={`M${f(151)} ${GROUND_FLOOR}V708`} stroke={ROOM.ink} strokeWidth={0.9} />
          <path d={`M${f(151) - 4.4} 708h8.8l-2 -7h-4.8z`} fill="#F4E3BF" />
          <circle className="j-glow" cx={f(151)} cy={706} r={17} fill="url(#j-lamp)" />
        </Fur>
        <Fur i={4}>
          <rect x={f(66, 12)} y={686} width={12} height={15} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.5} strokeWidth={0.7} />
          <path d={`M${f(66, 12) + 1.5} 698l3.5 -5l2.5 3l1.6 -2l2 4z`} fill="#7E8D6C" />
          <rect x={f(81, 9)} y={689} width={9} height={11} fill="#E9C9A6" stroke={ROOM.ink} strokeOpacity={0.5} strokeWidth={0.7} />
        </Fur>
        {/* hall: the last of the boxes */}
        <Fur i={5}>
          <rect x={f(40, 11)} y={741} width={11} height={11} fill="#C99B66" stroke="#8D6A3F" strokeWidth={0.5} />
          <rect x={f(47, 9)} y={732} width={9} height={9} fill="#D3A873" stroke="#8D6A3F" strokeWidth={0.5} />
          <path d={`M${f(40, 11)} 746.5h11M${f(47, 9)} 736.5h9`} stroke="#8D6A3F" strokeWidth={0.5} />
        </Fur>
        {/* bedroom */}
        <Fur i={6}>
          <rect x={f(64, 3)} y={618} width={3} height={FIRST_FLOOR - 618} fill="#8B6B4A" />
          <rect x={f(66, 48)} y={637} width={48} height={5} fill="#8B6B4A" />
          <rect x={f(67, 46)} y={631} width={46} height={7} rx={2} fill={ROOM.white} />
          <rect x={f(82, 31)} y={628.5} width={31} height={9.5} rx={2} fill="#8FA58B" />
          <rect x={f(68.5, 11)} y={627.5} width={11} height={5} rx={2} fill="#F3EFE7" stroke={ROOM.ink} strokeOpacity={0.2} strokeWidth={0.4} />
        </Fur>
        <Fur i={7}>
          <rect x={f(118, 9)} y={633} width={9} height={11} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.3} strokeWidth={0.5} />
          <path d={`M${f(122.5)} 633v-4`} stroke={ROOM.ink} strokeWidth={0.7} />
          <path d={`M${f(122.5) - 3.4} 629h6.8l-1.4 -5h-4z`} fill="#F4E3BF" />
          <circle className="j-glow" cx={f(122.5)} cy={627} r={14} fill="url(#j-lamp)" />
        </Fur>
        <Fur i={8}><rect x={f(84, 16)} y={588} width={16} height={12} fill="#E9C9A6" stroke={ROOM.ink} strokeOpacity={0.5} strokeWidth={0.7} /></Fur>
        {/* bathroom */}
        <Fur i={9}>
          <path d={`M${f(7)} 628h${34 * dir}v9a6 6 0 0 ${m ? 0 : 1} ${-6 * dir} 6h${-22 * dir}a6 6 0 0 ${m ? 0 : 1} ${-6 * dir} -6z`} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.35} strokeWidth={0.6} />
          <path d={`M${f(10)} 628v-5h${3 * dir}`} stroke="#9AA3AD" strokeWidth={0.9} fill="none" />
          <rect x={f(45, 10)} y={621} width={10} height={4} rx={1.6} fill={ROOM.white} stroke={ROOM.ink} strokeOpacity={0.35} strokeWidth={0.6} />
          <path d={`M${f(50)} 625V${FIRST_FLOOR - 2.4}`} stroke={ROOM.white} strokeWidth={2.4} />
          <rect x={f(45.5, 9)} y={598} width={9} height={14} rx={1} fill="#BFD9E6" stroke={ROOM.white} strokeWidth={1} />
        </Fur>
        {/* loft room */}
        <Fur i={10}>
          <rect x={f(10, 40)} y={548} width={40} height={5} fill="#8B6B4A" />
          <rect x={f(11, 38)} y={543.5} width={38} height={5.5} rx={2} fill="#C9D6E2" />
          <rect x={f(12, 9)} y={541} width={9} height={4} rx={1.6} fill={ROOM.white} />
        </Fur>
        <Fur i={11}>
          <path d={`M${f(104)} 540h${26 * dir}M${f(106)} 540V${LOFT_FLOOR - 3}M${f(128)} 540V${LOFT_FLOOR - 3}`} stroke="#8B6B4A" strokeWidth={1.3} fill="none" />
          <rect x={f(112, 7)} y={534.5} width={7} height={5} fill="#3A3F4E" />
          <path d={`M${f(136)} ${LOFT_FLOOR - 3}v-8h${6 * dir}v8M${f(136)} 545v-7`} stroke={ROOM.ink} strokeWidth={0.9} fill="none" />
        </Fur>
        {/* the family, at home */}
        <g className="j-fam-in">
          <g transform={onFloor(GROUND_FLOOR)}><Figure x={f(105)} kind="woman" P={P} /><Figure x={f(117)} kind="man" P={P} flip={m} /></g>
          <g transform={onFloor(LOFT_FLOOR - 3)}><Figure x={f(72)} kind="child" P={P} /></g>
        </g>
        {/* ceiling lights */}
        {[{ x: 109, y: GROUND_TOP }, { x: 31, y: GROUND_TOP }, { x: 109, y: FIRST_TOP }, { x: 31, y: FIRST_TOP }].map(({ x, y }, n) => (
          <g key={`${x}-${y}`} className="j-fur" style={{ ['--i' as string]: 12 + n } as CSSProperties}>
            <path d={`M${f(x)} ${y}v7`} stroke={ROOM.ink} strokeWidth={0.5} />
            <path d={`M${f(x) - 3} ${y + 10}a3 3 0 0 1 6 0z`} fill="#F4E3BF" />
            <circle className="j-glow" cx={f(x)} cy={y + 11} r={20} fill="url(#j-lamp)" />
          </g>
        ))}
      </g>
    </>
  );
}
