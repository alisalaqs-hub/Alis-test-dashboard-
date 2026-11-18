/**
 * Outside views, one per kind of home. Each takes `n`, a number that belongs to the home (so the
 * same home always looks the same): it chooses the wall, the door and where the planting goes.
 * `after` draws the home as it could look once refurbished: pale render, dark frames, new planting.
 */
import {
  Backdrop, Door, FRAME, GLASS_DARK, Glass, HEDGE, Hedge, LAWN, LEAD, PAVE, POT, STACK, STUCCO, SLATE, SLATE_DARK, Sash, Street,
  TILE, TILE_DARK, Tree, WALLS, DOORS, ln, pick, shade, thin,
} from './kit';

interface Look { wall: string; side: string; other: string; door: string; frame: string; v: number }
function look(n: number, after: boolean): Look {
  return after
    ? { wall: '#F2EFE8', side: '#E6E1D6', other: pick(WALLS, n + 3), door: '#3E5C63', frame: '#2B3142', v: n % 3 }
    : { wall: pick(WALLS, n), side: pick(WALLS, n + 5), other: pick(WALLS, n + 2), door: pick(DOORS, n * 3 + 1), frame: FRAME, v: n % 3 };
}

const slateLines = (x1: number, x2: number, ys: number[]) => ys.map((y) => <line key={y} x1={x1} y1={y} x2={x2} y2={y} {...thin} />);

function Chimney({ x, y, w = 24, pots = 3 }: { x: number; y: number; w?: number; pots?: number }) {
  return (
    <g>
      <rect x={x - w / 2} y={y} width={w} height={34} fill={STACK} {...ln} />
      <rect x={x - w / 2 - 2} y={y - 1} width={w + 4} height={4} fill={STUCCO} {...thin} />
      {Array.from({ length: pots }, (_, i) => <rect key={i} x={x - w / 2 + 3 + i * ((w - 6 - 5) / Math.max(1, pots - 1))} y={y - 9} width={5} height={8} rx={1} fill={POT} />)}
    </g>
  );
}

/** A Victorian terrace: canted bay, sashes, an arched door, slate roof and party-wall stacks. */
export function Terraced({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  const flip = n % 2 === 1; // bay on the right for every other home
  const body = (
    <g>
      {/* roof */}
      <rect x={-10} y={46} width={340} height={32} fill={SLATE} />
      <rect x={-10} y={46} width={340} height={3} fill={SLATE_DARK} />
      {slateLines(-10, 330, [56, 64, 72])}
      <rect x={57.5} y={44} width={5} height={34} fill={STUCCO} {...thin} />
      <rect x={257.5} y={44} width={5} height={34} fill={STUCCO} {...thin} />
      <Chimney x={60} y={20} />
      <Chimney x={260} y={20} />
      {/* walls: the neighbours either side, the home in the middle */}
      <rect x={-10} y={82} width={70} height={124} fill={k.side} />
      <rect x={260} y={82} width={70} height={124} fill={k.other} />
      <rect x={60} y={82} width={200} height={124} fill={k.wall} />
      <rect x={60} y={82} width={200} height={124} fill="none" {...ln} />
      <rect x={-10} y={77} width={340} height={6} fill={STUCCO} {...thin} />
      <rect x={-10} y={140} width={340} height={4} fill={STUCCO} {...thin} />
      {/* neighbours' windows, just enough to read as a street */}
      <Sash x={14} y={94} w={24} h={38} sill={false} />
      <Sash x={284} y={94} w={24} h={38} sill={false} />
      <Sash x={14} y={154} w={24} h={38} sill={false} />
      <Sash x={284} y={154} w={24} h={38} sill={false} />
      {/* first floor */}
      <Sash x={88} y={94} w={24} h={38} frame={k.frame} lintel />
      <Sash x={124} y={94} w={24} h={38} frame={k.frame} lintel />
      <Sash x={199} y={94} w={26} h={38} frame={k.frame} lintel />
      {/* the bay */}
      <polygon points="74,147 162,147 152,138 84,138" fill={LEAD} {...ln} />
      <polygon points="76,147 86,147 86,204 76,204" fill={STUCCO} />
      <polygon points="150,147 160,147 160,204 150,204" fill={STUCCO} />
      <rect x={76} y={147} width={10} height={57} {...shade} />
      <rect x={86} y={147} width={64} height={57} fill={STUCCO} />
      <rect x={76} y={147} width={84} height={57} fill="none" {...ln} />
      <Glass x={78.5} y={154} w={5} h={38} fill={GLASS_DARK} />
      <Glass x={152.5} y={154} w={5} h={38} fill={GLASS_DARK} />
      <Sash x={93} y={154} w={50} h={38} frame={k.frame} sill={false} />
      <rect x={74} y={194} width={88} height={3.5} fill={STUCCO} {...thin} />
      {/* the door: stucco surround, arched fanlight, a step */}
      <path d="M190 206 V162 a22 22 0 0 1 44 0 V206 Z" fill={STUCCO} {...ln} />
      <path d="M198 164 a14 14 0 0 1 28 0 Z" fill={GLASS_DARK} />
      <path d="M212 150 V164 M203 154 L212 164 L221 154" fill="none" stroke={STUCCO} strokeWidth={1} />
      <Door x={198} y={166} w={28} h={40} fill={k.door} />
      <rect x={190} y={206} width={44} height={4} fill="#ECE7DD" {...thin} />
    </g>
  );
  return (
    <g>
      <Backdrop sunX={flip ? 70 : 250} skyline={false} />
      <g transform={flip ? 'translate(320 0) scale(-1 1)' : undefined}>{body}</g>
      {/* front garden: wall, piers, a hedge behind */}
      <g transform={flip ? 'translate(320 0) scale(-1 1)' : undefined}>
        {k.v !== 1 && <Hedge x={64} y={188} w={118} h={18} />}
        <rect x={-10} y={202} width={196} height={12} fill={STACK} {...ln} />
        <rect x={-10} y={200} width={196} height={3} fill={STUCCO} {...thin} />
        <rect x={238} y={202} width={92} height={12} fill={STACK} {...ln} />
        <rect x={238} y={200} width={92} height={3} fill={STUCCO} {...thin} />
        <rect x={183} y={194} width={7} height={20} fill={STUCCO} {...ln} />
        <rect x={234} y={194} width={7} height={20} fill={STUCCO} {...ln} />
        <rect x={190} y={210} width={44} height={4} fill={PAVE} />
      </g>
      <Street top={214} />
      {k.v !== 2 && <Tree x={flip ? 34 : 288} base={232} h={118} r={34} />}
      {after && <g><rect x={flip ? 96 : 196} y={196} width={14} height={10} rx={2} fill="#3B4249" /><circle cx={flip ? 103 : 203} cy={191} r={8} fill={HEDGE} /></g>}
    </g>
  );
}

/** A 1930s semi: the pair under one tiled roof, a two-storey bay under its gable, an arched porch. */
export function Semi({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  const render = after ? '#F2EFE8' : '#F1EADC';
  const half = (ours: boolean) => {
    const wall = ours ? k.wall : k.other;
    return (
      <g>
        <rect x={18} y={92} width={142} height={114} fill={wall} {...ln} />
        {/* the two-storey bay and its gable */}
        <polygon points="26,92 70,52 114,92" fill={render} {...ln} />
        <path d="M34 92 L70 60 L106 92 M70 60 V92 M52 76 V92 M88 76 V92" fill="none" {...thin} strokeOpacity={0.34} />
        <rect x={30} y={92} width={80} height={114} fill={wall} />
        <rect x={30} y={136} width={80} height={22} fill={ours ? TILE : TILE_DARK} opacity={0.9} />
        {slateLines(30, 110, [143, 150])}
        <rect x={30} y={92} width={80} height={114} fill="none" {...ln} />
        <Sash x={38} y={100} w={30} h={30} frame={ours ? k.frame : FRAME} sill={false} />
        <Sash x={72} y={100} w={30} h={30} frame={ours ? k.frame : FRAME} sill={false} />
        <Sash x={38} y={164} w={30} h={32} frame={ours ? k.frame : FRAME} sill={false} />
        <Sash x={72} y={164} w={30} h={32} frame={ours ? k.frame : FRAME} sill={false} />
        {/* the porch and the small window over it */}
        <Sash x={124} y={104} w={22} h={24} frame={ours ? k.frame : FRAME} bars={false} />
        <path d="M118 206 V170 a17 17 0 0 1 34 0 V206 Z" fill={render} {...ln} />
        <path d="M124 206 V172 a11 11 0 0 1 22 0 V206 Z" fill="#4B505F" />
        <Door x={126} y={174} w={18} h={32} fill={ours ? k.door : '#5B6270'} />
      </g>
    );
  };
  return (
    <g>
      <Backdrop sunX={262} />
      <Tree x={20} base={206} h={112} r={30} />
      {/* one hipped roof over both halves, the shared stack in the middle */}
      <polygon points="6,94 44,48 276,48 314,94" fill={TILE} {...ln} />
      <polygon points="6,94 44,48 60,48 22,94" fill={TILE_DARK} opacity={0.6} />
      {slateLines(30, 290, [60, 71, 82])}
      <Chimney x={160} y={22} w={30} pots={4} />
      <g>{half(true)}</g>
      <g transform="translate(320 0) scale(-1 1)">{half(false)}</g>
      <line x1={160} y1={92} x2={160} y2={206} {...ln} />
      <rect x={6} y={90} width={308} height={5} fill={STUCCO} {...thin} />
      {/* front: drive, lawn, low wall and hedge */}
      <rect x={0} y={206} width={320} height={10} fill={LAWN} />
      <polygon points="118,206 152,206 160,216 108,216" fill={PAVE} />
      <Hedge x={164} y={196} w={156} h={14} />
      {k.v !== 0 && <Hedge x={0} y={198} w={22} h={12} />}
      <rect x={0} y={208} width={104} height={8} fill={STACK} {...ln} />
      <rect x={164} y={208} width={156} height={8} fill={STACK} {...ln} />
      <Street top={216} />
    </g>
  );
}

/** A double-fronted detached house: central door and porch, a hipped slate roof, lawn and drive. */
export function Detached({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  return (
    <g>
      <Backdrop sunX={k.v === 1 ? 64 : 258} />
      <Tree x={k.v === 1 ? 292 : 26} base={204} h={128} r={36} />
      <Tree x={k.v === 1 ? 14 : 306} base={204} h={84} r={24} />
      {/* roof and stacks */}
      <Chimney x={92} y={30} w={22} pots={2} />
      <Chimney x={228} y={30} w={22} pots={2} />
      <polygon points="34,90 78,44 242,44 286,90" fill={SLATE} {...ln} />
      <polygon points="34,90 78,44 96,44 52,90" fill={SLATE_DARK} opacity={0.55} />
      {slateLines(58, 262, [56, 67, 78])}
      {/* walls */}
      <rect x={44} y={90} width={232} height={114} fill={k.wall} {...ln} />
      <rect x={38} y={87} width={244} height={6} fill={STUCCO} {...thin} />
      <rect x={44} y={143} width={232} height={3.5} fill={STUCCO} {...thin} />
      <rect x={44} y={90} width={10} height={114} {...shade} />
      {/* first floor: five across */}
      <Sash x={60} y={101} w={24} h={34} frame={k.frame} lintel />
      <Sash x={102} y={101} w={24} h={34} frame={k.frame} lintel />
      <Sash x={148} y={101} w={24} h={34} frame={k.frame} lintel />
      <Sash x={194} y={101} w={24} h={34} frame={k.frame} lintel />
      <Sash x={236} y={101} w={24} h={34} frame={k.frame} lintel />
      {/* ground floor: tall windows either side of the porch */}
      <Sash x={62} y={154} w={52} h={38} frame={k.frame} lintel />
      <line x1={79.5} y1={154} x2={79.5} y2={192} stroke={k.frame} strokeWidth={1.2} />
      <line x1={96.5} y1={154} x2={96.5} y2={192} stroke={k.frame} strokeWidth={1.2} />
      <Sash x={206} y={154} w={52} h={38} frame={k.frame} lintel />
      <line x1={223.5} y1={154} x2={223.5} y2={192} stroke={k.frame} strokeWidth={1.2} />
      <line x1={240.5} y1={154} x2={240.5} y2={192} stroke={k.frame} strokeWidth={1.2} />
      {/* porch: two columns and a flat hood */}
      <rect x={134} y={148} width={52} height={6} fill={STUCCO} {...ln} />
      <rect x={138} y={154} width={5} height={50} fill={STUCCO} {...ln} />
      <rect x={177} y={154} width={5} height={50} fill={STUCCO} {...ln} />
      <Door x={147} y={166} w={26} h={38} fill={k.door} fan={8} />
      <rect x={132} y={204} width={56} height={4} fill="#ECE7DD" {...thin} />
      {/* front garden */}
      <rect x={0} y={204} width={320} height={14} fill={LAWN} />
      <polygon points="140,208 180,208 196,218 124,218" fill={PAVE} />
      <Hedge x={0} y={196} w={40} h={18} />
      <Hedge x={280} y={196} w={40} h={18} />
      <circle cx={58} cy={204} r={7} fill={HEDGE} />
      <circle cx={262} cy={204} r={7} fill={HEDGE} />
      {after && <g><circle cx={128} cy={202} r={6} fill={HEDGE} /><circle cx={192} cy={202} r={6} fill={HEDGE} /></g>}
      <Street top={218} />
    </g>
  );
}

/** A block of flats: brick over a rendered base, balconies, a glazed entrance under a canopy. */
export function Flats({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  const rows = [52, 90, 128];
  const balcony = (x: number, y: number) => (
    <g key={`b${x}${y}`}>
      <rect x={x - 6} y={y + 21} width={48} height={3} fill={STUCCO} {...thin} />
      <rect x={x - 5} y={y + 9} width={46} height={12} fill="#DCE3E8" opacity={0.75} />
      <rect x={x - 5} y={y + 9} width={46} height={12} fill="none" {...thin} strokeOpacity={0.4} />
      <line x1={x - 6} y1={y + 9} x2={x + 42} y2={y + 9} stroke={after ? '#2B3142' : '#5A6172'} strokeWidth={1.4} />
    </g>
  );
  return (
    <g>
      <Backdrop sunX={k.v === 0 ? 40 : 286} />
      {/* the block beyond */}
      <rect x={k.v === 0 ? 232 : -30} y={70} width={120} height={140} fill="#DCD5C8" />
      <rect x={34} y={34} width={252} height={172} fill={k.wall} {...ln} />
      <rect x={34} y={34} width={12} height={172} {...shade} />
      <rect x={30} y={30} width={260} height={6} fill={STUCCO} {...ln} />
      <rect x={34} y={166} width={252} height={40} fill={after ? '#E6E1D6' : '#EFE9DD'} />
      <line x1={34} y1={166} x2={286} y2={166} {...thin} />
      {/* three floors of flats: tall windows, balconies on the outer bays */}
      {rows.map((y) => (
        <g key={y}>
          <Sash x={54} y={y} w={36} h={26} frame={k.frame} sill={false} />
          <Sash x={112} y={y} w={26} h={26} frame={k.frame} bars={false} />
          <Sash x={182} y={y} w={26} h={26} frame={k.frame} bars={false} />
          <Sash x={230} y={y} w={36} h={26} frame={k.frame} sill={false} />
          {balcony(54, y)}
          {balcony(230, y)}
        </g>
      ))}
      {/* the stair core */}
      <rect x={150} y={44} width={20} height={116} fill={GLASS_DARK} opacity={0.85} />
      <path d="M150 72 H170 M150 100 H170 M150 128 H170" stroke={k.frame} strokeWidth={1.6} />
      <rect x={150} y={44} width={20} height={116} fill="none" {...ln} />
      {/* ground floor */}
      <Sash x={54} y={176} w={36} h={22} frame={k.frame} sill={false} />
      <Sash x={230} y={176} w={36} h={22} frame={k.frame} sill={false} />
      <rect x={128} y={168} width={64} height={5} fill={after ? '#2B3142' : '#5A6172'} />
      <Glass x={138} y={175} w={44} h={31} fill={GLASS_DARK} />
      <path d="M160 175 V206 M138 175 H182" stroke={k.frame} strokeWidth={1.6} />
      <rect x={138} y={175} width={44} height={31} fill="none" {...ln} />
      <rect x={150} y={183} width={8} height={1.6} fill="#C7A35C" />
      {/* planting and street */}
      <Hedge x={40} y={198} w={84} h={12} />
      <Hedge x={196} y={198} w={84} h={12} />
      <rect x={0} y={206} width={320} height={8} fill={PAVE} />
      <Street top={214} />
      <Tree x={k.v === 0 ? 292 : 26} base={232} h={126} r={32} />
    </g>
  );
}

/** A bungalow: low and wide under a big hipped roof, a bay to one side, a gabled porch. */
export function Bungalow({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  return (
    <g>
      <Backdrop sunX={60} />
      <Tree x={296} base={206} h={110} r={34} />
      <Chimney x={204} y={58} w={20} pots={2} />
      <polygon points="18,138 92,78 228,78 302,138" fill={TILE} {...ln} />
      <polygon points="18,138 92,78 112,78 38,138" fill={TILE_DARK} opacity={0.55} />
      {slateLines(56, 264, [94, 108, 122])}
      <rect x={28} y={138} width={264} height={68} fill={k.wall} {...ln} />
      <rect x={22} y={135} width={276} height={6} fill={STUCCO} {...thin} />
      <rect x={28} y={138} width={10} height={68} {...shade} />
      {/* the bay */}
      <polygon points="46,150 124,150 116,142 54,142" fill={LEAD} {...ln} />
      <rect x={48} y={150} width={74} height={56} fill={STUCCO} {...ln} />
      <Sash x={56} y={158} w={58} h={32} frame={k.frame} sill={false} />
      <line x1={75} y1={158} x2={75} y2={190} stroke={k.frame} strokeWidth={1.2} />
      <line x1={95} y1={158} x2={95} y2={190} stroke={k.frame} strokeWidth={1.2} />
      {/* porch */}
      <polygon points="140,160 166,138 192,160" fill={after ? '#F2EFE8' : '#F1EADC'} {...ln} />
      <rect x={146} y={160} width={40} height={46} fill="#4B505F" />
      <Door x={154} y={166} w={24} h={40} fill={k.door} />
      <Sash x={214} y={158} w={56} h={32} frame={k.frame} />
      <line x1={232.5} y1={158} x2={232.5} y2={190} stroke={k.frame} strokeWidth={1.2} />
      <line x1={251.5} y1={158} x2={251.5} y2={190} stroke={k.frame} strokeWidth={1.2} />
      {/* garden */}
      <rect x={0} y={206} width={320} height={12} fill={LAWN} />
      <polygon points="150,206 182,206 194,218 138,218" fill={PAVE} />
      <Hedge x={0} y={198} w={44} h={16} />
      <circle cx={206} cy={206} r={7} fill={HEDGE} />
      <circle cx={284} cy={205} r={8} fill={HEDGE} />
      <Street top={218} />
    </g>
  );
}

/** A shop with offices over: a glazed shopfront under a fascia, sashes above. */
export function Commercial({ n, after }: { n: number; after: boolean }) {
  const k = look(n, after);
  const fascia = after ? '#2B3142' : pick(['#2E3A5A', '#4B6453', '#6B3934', '#262A35'], n);
  return (
    <g>
      <Backdrop sunX={270} skyline={false} />
      <rect x={-10} y={50} width={70} height={156} fill={k.side} />
      <rect x={260} y={62} width={70} height={144} fill={k.other} />
      <rect x={60} y={36} width={200} height={170} fill={k.wall} {...ln} />
      <rect x={56} y={32} width={208} height={7} fill={STUCCO} {...ln} />
      <rect x={60} y={36} width={10} height={170} {...shade} />
      {[52, 100].map((y) => (
        <g key={y}>
          <Sash x={80} y={y} w={30} h={36} frame={k.frame} lintel />
          <Sash x={145} y={y} w={30} h={36} frame={k.frame} lintel />
          <Sash x={210} y={y} w={30} h={36} frame={k.frame} lintel />
        </g>
      ))}
      <Sash x={14} y={70} w={24} h={34} sill={false} />
      <Sash x={14} y={118} w={24} h={34} sill={false} />
      <Sash x={284} y={80} w={24} h={34} sill={false} />
      <Sash x={284} y={126} w={24} h={34} sill={false} />
      {/* the shopfront */}
      <rect x={60} y={146} width={200} height={16} fill={fascia} {...ln} />
      <rect x={96} y={151} width={62} height={5} rx={2} fill="#fff" opacity={0.85} />
      <rect x={66} y={162} width={188} height={44} fill={STUCCO} />
      <Glass x={72} y={166} w={104} h={34} />
      <Glass x={220} y={166} w={30} h={34} />
      <path d="M124 166 V200" stroke={FRAME} strokeWidth={1.6} />
      <rect x={72} y={166} width={104} height={34} fill="none" {...ln} />
      <rect x={220} y={166} width={30} height={34} fill="none" {...ln} />
      <Door x={184} y={166} w={28} h={40} fill={fascia} />
      <rect x={-10} y={164} width={70} height={42} fill="#E9E3D7" />
      <rect x={260} y={164} width={70} height={42} fill="#E9E3D7" />
      <rect x={0} y={206} width={320} height={8} fill={PAVE} />
      <Street top={214} />
      <Tree x={k.v === 1 ? 34 : 292} base={232} h={112} r={30} />
    </g>
  );
}
