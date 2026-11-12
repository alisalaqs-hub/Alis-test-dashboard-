/**
 * Floor plans drawn from measurements.
 *
 * A plan is a list of rooms. Each room has a name, a floor, a width (across the page) and a length
 * (down the page) in metres, and a simple position: a row number within its floor and an order within
 * that row. Rows run left to right and are stacked top to bottom, so rooms never overlap and
 * neighbours share a wall.
 *
 * Everything here is worked out from the numbers: the sizes people write ("4.2 x 3.9", "13'9\" x 12'10\"",
 * "4200 x 3900") are read into metres, areas are multiplied out, and the drawing is an SVG built
 * to scale from those figures. Nothing is estimated or generated, so the plan always matches the
 * measurements supplied. It is not a measured survey, and the drawing says so.
 *
 * Areas: a room's area is its width × length, rounded to 0.1 m² (the figure printed on the plan).
 * Floor totals and the overall total are the sums of those printed figures, so the plan always adds up.
 * Square feet are converted from the square metres shown.
 *
 * Pure TypeScript with no browser or Node APIs: the website and the server both use it.
 */

/* ───────────────────────── rooms and floors ───────────────────────── */

export const FLOORS = ['basement', 'ground', 'first', 'second', 'loft'] as const;
export type Floor = (typeof FLOORS)[number];
export const FLOOR_LABEL: Record<Floor, string> = { basement: 'Basement', ground: 'Ground floor', first: 'First floor', second: 'Second floor', loft: 'Loft' };
export const isFloor = (v: unknown): v is Floor => typeof v === 'string' && (FLOORS as readonly string[]).includes(v);

export interface PlanRoom {
  id: string;
  name: string;
  floor: Floor;
  /** Across the plan, in metres. null: not measured yet. */
  width: number | null;
  /** Down the plan, in metres. null: not measured yet. */
  length: number | null;
  /** Which row of its floor the room is in (1 is drawn at the top). */
  row: number;
  /** Where it comes in its row (1 is drawn on the left). */
  order: number;
}

/** The smallest and largest side a room can be drawn with. */
export const MIN_SIDE_M = 0.1;
export const MAX_SIDE_M = 100;
const validSide = (m: number | null | undefined): m is number => typeof m === 'number' && Number.isFinite(m) && m >= MIN_SIDE_M && m <= MAX_SIDE_M;
/** A room with a usable width and length. */
export const isMeasured = (r: Pick<PlanRoom, 'width' | 'length'>): r is { width: number; length: number } => validSide(r.width) && validSide(r.length);

/* ───────────────────────── reading sizes as people write them ───────────────────────── */

export type LengthUnit = 'm' | 'cm' | 'mm' | 'ft' | 'in';
export const METRES_PER: Record<LengthUnit, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
export const SQFT_PER_M2 = 10.76391041671;

const round = (n: number, dp: number) => { const k = 10 ** dp; return Math.round(n * k + (n >= 0 ? 1e-9 : -1e-9)) / k; };

/** Lower case, plain quotes for feet and inches, fractions as decimals, single spaces. */
function tidy(text: string): string {
  return String(text ?? '').toLowerCase()
    .replace(/[‘’′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/''/g, '"')
    .replace(/(\d)\s*½/g, '$1.5').replace(/(\d)\s*¼/g, '$1.25').replace(/(\d)\s*¾/g, '$1.75')
    .replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/¾/g, '0.75')
    .replace(/\b(approx(?:imately)?|about|max(?:imum)?|min(?:imum)?)\b\.?/g, ' ')
    .replace(/[ \s]+/g, ' ').trim();
}
/** What to try, in order: the text outside any brackets, then what is inside them ("4.2m x 3.9m (13'9\" x 12'10\")"). */
function candidates(s: string): string[] {
  if (!s.includes('(')) return [s];
  const outside = s.replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim();
  const inside = (s.match(/\(([^)]*)\)?/)?.[1] ?? '').trim();
  return [outside, inside].filter(Boolean);
}
/** "4,200" is four thousand two hundred; "4,2" is 4.2. */
const number = (s: string) => Number(/^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));

const N = String.raw`(\d+(?:[.,]\d+)?)`;
const FT = String.raw`(?:'|ft\.?|feet|foot)`;
const IN = String.raw`(?:"|ins?\.?|inch(?:es)?)`;
const RE_FEET = new RegExp(`^${N}\\s*${FT}\\s*-?\\s*(?:${N}\\s*${IN}?)?$`);
const RE_INCHES = new RegExp(`^${N}\\s*${IN}$`);
const RE_METRIC = new RegExp(`^${N}\\s*(mm|millimet(?:re|er)s?|cm|centimet(?:re|er)s?|m|met(?:re|er)s?)$`);
const RE_BARE = new RegExp(`^${N}$`);
/** "13 9" or "13-9": feet then inches, only where the person has said the size is in feet. */
const RE_FEET_SPACED = /^(\d+)\s*[\s-]\s*(\d+(?:\.\d+)?)$/;

type Scanned = { metres: number; unit: LengthUnit } | { bare: number };
/** One length with its unit if one is written, or the bare number if not. null: not a length. */
function scan(s: string, fallback: LengthUnit): Scanned | null {
  let m = s.match(RE_FEET);
  if (m) {
    const inches = m[2] ? number(m[2]) : 0;
    return inches < 12 ? { metres: number(m[1]) * METRES_PER.ft + inches * METRES_PER.in, unit: 'ft' } : null;
  }
  if ((m = s.match(RE_INCHES))) return { metres: number(m[1]) * METRES_PER.in, unit: 'in' };
  if ((m = s.match(RE_METRIC))) { const unit: LengthUnit = m[2].startsWith('mm') || m[2].startsWith('mi') ? 'mm' : m[2].startsWith('c') ? 'cm' : 'm'; return { metres: number(m[1]) * METRES_PER[unit], unit }; }
  if ((m = s.match(RE_BARE))) return { bare: number(m[1]) };
  if (fallback === 'ft' && (m = s.match(RE_FEET_SPACED)) && Number(m[2]) < 12) return { metres: Number(m[1]) * METRES_PER.ft + Number(m[2]) * METRES_PER.in, unit: 'ft' };
  return null;
}
/**
 * The unit of a number written without one. Thousands are millimetres (4200 is 4.2 m) and hundreds are
 * centimetres (420 is 4.2 m: as millimetres it would be too small to be a room); anything smaller is in
 * the unit the person chose.
 */
const guessUnit = (n: number, fallback: LengthUnit): LengthUnit => (n >= 1000 ? 'mm' : n >= 100 ? 'cm' : fallback);
const usable = (m: number) => (Number.isFinite(m) && m > 0 ? round(m, 4) : null);

/**
 * One length in metres, with the unit it was read in: "4.2", "4.2m", "4200mm", "420 cm", "13'9\"",
 * "13ft 9in", "13ft", "165 in". `fallback` is the unit of a number written without one. With `strict`,
 * a bare number is always in that unit; otherwise thousands are read as millimetres and hundreds as
 * centimetres.
 */
export function readLength(text: string, fallback: LengthUnit = 'm', strict = false): { metres: number; unit: LengthUnit } | null {
  for (const c of candidates(tidy(text))) {
    const p = scan(c, fallback);
    if (!p) continue;
    const unit = 'unit' in p ? p.unit : strict ? fallback : guessUnit(p.bare, fallback);
    const metres = usable('metres' in p ? p.metres : p.bare * METRES_PER[unit]);
    if (metres != null) return { metres, unit };
  }
  return null;
}
/** One length in metres (see readLength), or null when the text isn't a length. */
export const parseLength = (text: string, fallback: LengthUnit = 'm', strict = false): number | null => readLength(text, fallback, strict)?.metres ?? null;

/** The two (or three) sizes in "4.2 x 3.9", "4.2m × 3.9m", "13'9\" by 12'10\"". */
function splitPair(s: string): [string, string] | null {
  const parts = s.split(/\s*(?:x|×|✕|\*|\bby\b)\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.length === 2 || parts.length === 3 ? [parts[0], parts[1]] : null; // a third figure is a ceiling height
}
interface Pair { width: number; length: number; units: [LengthUnit, LengthUnit]; parts: [string, string] }
function pair(text: string, fallback: LengthUnit, strict: boolean): Pair | null {
  for (const c of candidates(tidy(text))) {
    const parts = splitPair(c);
    if (!parts) continue;
    const a = scan(parts[0], fallback), b = scan(parts[1], fallback);
    if (!a || !b) continue;
    // A number without a unit takes the unit written on the other side; with none on either, they are read together.
    const shared: LengthUnit = 'unit' in a ? a.unit : 'unit' in b ? b.unit
      : strict ? fallback : guessUnit(Math.max((a as { bare: number }).bare, (b as { bare: number }).bare), fallback);
    const metres = (p: Scanned) => usable('metres' in p ? p.metres : p.bare * METRES_PER[shared]);
    const width = metres(a), length = metres(b);
    if (width != null && length != null) return { width, length, units: ['unit' in a ? a.unit : shared, 'unit' in b ? b.unit : shared], parts };
  }
  return null;
}

/**
 * A room's size in metres, with the unit each side was read in, from the way people write it:
 * "4.2 x 3.9", "4.2m × 3.9m", "13'9\" x 12'10\"", "4200 x 3900" (millimetres),
 * "4.20m x 3.90m (13'9\" x 12'10\")". The first figure is the width and the second the length.
 */
export function readDimensions(text: string, fallback: LengthUnit = 'm', strict = false): { width: number; length: number; units: [LengthUnit, LengthUnit] } | null {
  const p = pair(text, fallback, strict);
  return p ? { width: p.width, length: p.length, units: p.units } : null;
}
/** A room's size in metres (see readDimensions), or null when the text isn't two sizes. */
export function parseDimensions(text: string, fallback: LengthUnit = 'm', strict = false): { width: number; length: number } | null {
  const p = pair(text, fallback, strict);
  return p ? { width: p.width, length: p.length } : null;
}

/** A plain number of metres as text ("4.2", "3.912"). */
export const metresText = (m: number) => String(round(m, 3));
/** Feet and inches as text that reads back to the same length ("13'9\"", "13'9.5\""): inches to two decimal places. */
export function feetText(m: number): string {
  const inches = round(m / METRES_PER.in, 2);
  const feet = Math.floor(inches / 12);
  return `${feet}'${round(inches - feet * 12, 2)}"`;
}

/**
 * "4.2 x 3.9" typed into one box, as two separate sizes. Each is kept as typed where it means the
 * same on its own; otherwise it is written in metres ("900 x 1800" becomes "0.9m" and "1.8m").
 */
export function splitDimensions(text: string, fallback: LengthUnit = 'm'): { width: string; length: string } | null {
  const p = pair(text, fallback, false);
  if (!p) return null;
  const keep = (part: string, metres: number) => { const own = parseLength(part, fallback); return own != null && Math.abs(own - metres) < 1e-6 ? part : `${metresText(metres)}m`; };
  return { width: keep(p.parts[0], p.width), length: keep(p.parts[1], p.length) };
}

/* ───────────────────────── sizes and areas as text ───────────────────────── */

const fixed = (n: number, dp: number) => round(n, dp).toFixed(dp);
export const formatMetres = (m: number) => `${fixed(m, 2)} m`;
/** 4.191 → 13'9" (to the nearest inch). */
export function formatFeetInches(m: number): string {
  const inches = Math.round(m / METRES_PER.in);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}
export const formatSize = (width: number, length: number) => `${fixed(width, 2)} × ${fixed(length, 2)} m`;
export const formatSizeImperial = (width: number, length: number) => `${formatFeetInches(width)} × ${formatFeetInches(length)}`;
export const sqFt = (m2: number) => Math.round(m2 * SQFT_PER_M2);
export const formatM2 = (m2: number) => `${fixed(m2, 1)} m²`;
export const formatSqFt = (m2: number) => `${sqFt(m2).toLocaleString('en-GB')} sq ft`;
export const formatArea = (m2: number) => `${formatM2(m2)} (${formatSqFt(m2)})`;

/** A room's area in m², to 0.1 (the figure printed on the plan). null until it has a width and a length. */
export const roomArea = (r: Pick<PlanRoom, 'width' | 'length'>): number | null => (isMeasured(r) ? round(r.width * r.length, 1) : null);

/* ───────────────────────── order and position ───────────────────────── */

const floorIndex = (f: Floor) => FLOORS.indexOf(f);
const whole = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.round(n)) : 1);

/** Rooms in plan order: by floor (lowest first), then row, then order within the row. */
export function sortRooms<T extends Pick<PlanRoom, 'floor' | 'row' | 'order'>>(rooms: T[]): T[] {
  return rooms.map((r, i) => ({ r, i }))
    .sort((a, b) => floorIndex(a.r.floor) - floorIndex(b.r.floor) || a.r.row - b.r.row || a.r.order - b.r.order || a.i - b.i)
    .map((x) => x.r);
}

/** Rooms in plan order with tidy positions: on each floor rows are numbered 1, 2, 3… and each row's rooms 1, 2, 3… */
export function normalisePositions<T extends Pick<PlanRoom, 'floor' | 'row' | 'order'>>(rooms: T[]): T[] {
  const out: T[] = [];
  let floor: Floor | null = null, lastRow = 0, row = 0, order = 0;
  for (const r of sortRooms(rooms.map((x) => ({ ...x, row: whole(x.row) })))) {
    if (r.floor !== floor) { floor = r.floor; lastRow = r.row; row = 1; order = 0; }
    else if (r.row !== lastRow) { lastRow = r.row; row++; order = 0; }
    out.push({ ...r, row, order: ++order });
  }
  return out;
}

/* ───────────────────────── totals ───────────────────────── */

export interface FloorTotal { floor: Floor; label: string; rooms: number; measured: number; m2: number; sqft: number }
export interface PlanTotals {
  floors: FloorTotal[];
  rooms: number;
  measured: number;
  /** All floors, in m² (the sum of the room areas shown). */
  m2: number;
  sqft: number;
  /** Rooms that can't be drawn or counted until they have a width and a length. */
  needsMeasuring: PlanRoom[];
}

/** Area per floor and overall, in m² and sq ft. Rooms without a size are listed, not counted. */
export function planTotals(rooms: PlanRoom[]): PlanTotals {
  const floors: FloorTotal[] = [];
  for (const floor of FLOORS) {
    const on = rooms.filter((r) => r.floor === floor);
    if (!on.length) continue;
    const m2 = round(on.reduce((s, r) => s + (roomArea(r) ?? 0), 0), 1);
    floors.push({ floor, label: FLOOR_LABEL[floor], rooms: on.length, measured: on.filter(isMeasured).length, m2, sqft: sqFt(m2) });
  }
  const m2 = round(floors.reduce((s, f) => s + f.m2, 0), 1);
  return { floors, rooms: rooms.length, measured: rooms.filter(isMeasured).length, m2, sqft: sqFt(m2), needsMeasuring: sortRooms(rooms.filter((r) => !isMeasured(r))) };
}

/* ───────────────────────── layout ───────────────────────── */

export interface PlacedRoom { room: PlanRoom; /** Metres from the floor's top-left corner. */ x: number; y: number; w: number; h: number; area: number }
export interface FloorLayout { floor: Floor; label: string; rooms: PlacedRoom[]; /** Metres. */ width: number; height: number; area: number; unmeasured: PlanRoom[] }

/**
 * Where each room goes, floor by floor (lowest first; floors with no rooms are left out).
 * Each row is laid out left to right from the floor's left edge, and rows are stacked from the top, each
 * starting where the deepest room of the row above ends. Rooms never overlap, rooms next to each other in
 * a row share a wall, and a row sits against the row above it.
 */
export function layoutPlan(rooms: PlanRoom[]): FloorLayout[] {
  const out: FloorLayout[] = [];
  for (const floor of FLOORS) {
    const on = sortRooms(rooms.filter((r) => r.floor === floor));
    if (!on.length) continue;
    const placed: PlacedRoom[] = [];
    let y = 0, x = 0, depth = 0, row: number | null = null, width = 0;
    for (const r of on) {
      if (!isMeasured(r)) continue;
      if (r.row !== row) { y = round(y + depth, 4); x = 0; depth = 0; row = r.row; }
      placed.push({ room: r, x, y, w: r.width, h: r.length, area: roomArea(r)! });
      x = round(x + r.width, 4);
      depth = Math.max(depth, r.length);
      width = Math.max(width, x);
    }
    out.push({ floor, label: FLOOR_LABEL[floor], rooms: placed, width, height: round(y + depth, 4), area: round(placed.reduce((s, p) => s + p.area, 0), 1), unmeasured: on.filter((r) => !isMeasured(r)) });
  }
  return out;
}

export interface Segment { x1: number; y1: number; x2: number; y2: number }
const EPS = 1e-6;
/** [from, to] with the given stretches taken out. */
function without(from: number, to: number, cuts: [number, number][]): [number, number][] {
  let left: [number, number][] = [[from, to]];
  for (const [a, b] of cuts) left = left.flatMap(([s, e]): [number, number][] => (b <= s + EPS || a >= e - EPS ? [[s, e]] : [[s, Math.min(e, a)], [Math.max(s, b), e]])).filter(([s, e]) => e - s > EPS);
  return left;
}
/**
 * The walls of one floor: `outer` runs round the outside, `inner` is each wall two rooms share (once).
 * Used to draw outside walls heavier than the partitions between rooms.
 */
export function wallSegments(rooms: PlacedRoom[]): { outer: Segment[]; inner: Segment[] } {
  const outer: Segment[] = [], inner: Segment[] = [];
  const overlap = (a1: number, a2: number, b1: number, b2: number): [number, number] | null => { const s = Math.max(a1, b1), e = Math.min(a2, b2); return e - s > EPS ? [s, e] : null; };
  for (const r of rooms) {
    const others = rooms.filter((o) => o !== r);
    // Each side: the stretches where another room's opposite side lies along it are shared walls.
    const vertical = (x: number, touching: (o: PlacedRoom) => number, emit: boolean) => {
      const shared = others.filter((o) => Math.abs(touching(o) - x) < EPS).map((o) => overlap(r.y, r.y + r.h, o.y, o.y + o.h)).filter((v): v is [number, number] => !!v);
      for (const [s, e] of without(r.y, r.y + r.h, shared)) outer.push({ x1: x, y1: s, x2: x, y2: e });
      if (emit) for (const [s, e] of shared) inner.push({ x1: x, y1: s, x2: x, y2: e });
    };
    const horizontal = (y: number, touching: (o: PlacedRoom) => number, emit: boolean) => {
      const shared = others.filter((o) => Math.abs(touching(o) - y) < EPS).map((o) => overlap(r.x, r.x + r.w, o.x, o.x + o.w)).filter((v): v is [number, number] => !!v);
      for (const [s, e] of without(r.x, r.x + r.w, shared)) outer.push({ x1: s, y1: y, x2: e, y2: y });
      if (emit) for (const [s, e] of shared) inner.push({ x1: s, y1: y, x2: e, y2: y });
    };
    vertical(r.x, (o) => o.x + o.w, false);        // left side against a neighbour's right side
    vertical(r.x + r.w, (o) => o.x, true);         // right side against a neighbour's left side
    horizontal(r.y, (o) => o.y + o.h, false);      // top against the bottom of a room above
    horizontal(r.y + r.h, (o) => o.y, true);       // bottom against the top of a room below
  }
  return { outer, inner };
}

/* ───────────────────────── words about a plan ───────────────────────── */

export const PLAN_NOTE = 'Drawn from the measurements supplied. This is not a measured survey.';
export const TOTAL_LABEL = 'Approximate gross internal area';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (r: Pick<PlanRoom, 'name'>, fallback = 'Room') => r.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;

/** A short caption for the plan as a picture (it always starts "Floor plan"). At most 160 characters. */
export function planCaption(rooms: PlanRoom[]): string {
  const t = planTotals(rooms);
  const size = t.measured ? `${plural(t.measured, 'room')}${t.floors.length > 1 ? ` on ${t.floors.length} floors` : ''}, about ${formatArea(t.m2)} in total. ` : '';
  return `Floor plan: ${size}Drawn from the measurements supplied, not a measured survey.`.slice(0, 160);
}
/** True for a picture captioned as a floor plan ("Floor plan", "Floor plan: 6 rooms…", "Floorplan"). */
export const isFloorPlanCaption = (caption: string | null | undefined) => /^\s*floor\s?plans?\b/i.test(caption ?? '');

/** The whole plan in words, room by room: the text alternative to the drawing. */
export function planSummary(rooms: PlanRoom[]): string {
  const t = planTotals(rooms);
  if (!t.measured) return 'No rooms have been measured yet, so there is no plan to draw.';
  const floors = layoutPlan(rooms).filter((f) => f.rooms.length).map((f) => `${f.label}, ${formatArea(f.area)}: ${f.rooms.map((p) => `${nameOf(p.room)} ${formatSize(p.w, p.h)}`).join('; ')}.`);
  const missing = t.needsMeasuring.length ? ` Not drawn, still to be measured: ${t.needsMeasuring.map((r) => nameOf(r)).join(', ')}.` : '';
  return `Floor plan. ${floors.join(' ')} ${TOTAL_LABEL} ${formatArea(t.m2)}.${missing} ${PLAN_NOTE}`;
}

/* ───────────────────────── the drawing ───────────────────────── */

const INK = '#0E1424', MUTED = '#555B6E', RULE = '#D8D2C5', PAPER = '#FFFFFF';
const FONT = "'Plus Jakarta Sans Variable','Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const PAD = 32;
/** Pixels per metre before the plan is fitted to the page. */
const BASE_SCALE = 84;
const MIN_WIDTH = 600, MAX_WIDTH = 1120;

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const px = (n: number) => String(round(n, 2));
/** A cautious estimate of how wide text is (the plan is drawn with whichever sans-serif font the device has). */
const textWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.62 : 0.57);
function wrap(s: string, size: number, width: number): string[] {
  const max = Math.max(12, Math.floor(width / (size * 0.57)));
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

interface TextStyle { size: number; weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; spacing?: number }
const textEl = (x: number, y: number, s: string, o: TextStyle) =>
  `<text x="${px(x)}" y="${px(y)}" font-size="${px(o.size)}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill ?? INK}"${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${esc(s)}</text>`;
const lineEl = (s: Segment, width: number) => `<line x1="${px(s.x1)}" y1="${px(s.y1)}" x2="${px(s.x2)}" y2="${px(s.y2)}" stroke="${INK}" stroke-width="${width}" stroke-linecap="square"/>`;

interface LabelLine { text: string; size: number; weight?: number; fill?: string }
/**
 * What fits inside a room drawn w × h pixels: everything (name, size in metres, size in feet and inches,
 * area), or the name and metric size, or just the name, or nothing. Anything short of everything is
 * numbered and written out in full in the key under the floor.
 */
function fitLabel(name: string, metric: string, imperial: string, area: string, w: number, h: number): { lines: LabelLine[]; full: boolean } {
  const all: LabelLine[] = [
    { text: name, size: 13, weight: 700 }, { text: metric, size: 11.5 }, { text: imperial, size: 10.5, fill: MUTED }, { text: area, size: 11.5, weight: 600 },
  ];
  const fits = (lines: LabelLine[], k: number, badge: boolean) =>
    lines.every((l) => textWidth(l.text, l.size * k, !!l.weight) <= w - 14) && lines.reduce((s, l) => s + l.size * k * 1.34, 0) <= h - (badge ? 30 : 12);
  for (const [lines, full] of [[all, true], [all.slice(0, 2), false], [all.slice(0, 1), false]] as const) {
    for (const k of [1, 0.88, 0.77]) if (fits(lines, k, !full)) return { lines: lines.map((l) => ({ ...l, size: round(l.size * k, 1) })), full };
  }
  return { lines: [], full: false };
}

export interface PlanSvgOptions {
  /** Shown under the heading, for example the name of the home. */
  title?: string;
}

/**
 * The plan as an SVG picture, to scale: outside walls, the walls between rooms, each room's name,
 * its size in metres and in feet and inches, its area, the total for each floor, the overall total,
 * a scale bar and a line saying it is drawn from the measurements supplied and is not a measured survey.
 * Rooms too small for their details are numbered and listed in a key under their floor; rooms without
 * a size are listed as not drawn. All text is escaped.
 */
export function renderPlanSvg(rooms: PlanRoom[], o: PlanSvgOptions = {}): string {
  const floors = layoutPlan(rooms);
  const totals = planTotals(rooms);
  const widest = Math.max(0, ...floors.map((f) => f.width));
  const scale = widest > 0 ? Math.min(BASE_SCALE, (MAX_WIDTH - 2 * PAD) / widest) : BASE_SCALE;
  const W = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest * scale) + 2 * PAD));
  const inner = W - 2 * PAD;
  const out: string[] = [];
  let y = PAD;
  const paragraph = (s: string, style: TextStyle, gap = 1.45) => { for (const l of wrap(s, style.size, inner)) { y += style.size * gap; out.push(textEl(PAD, y, l, style)); } };
  const rule = () => { y += 14; out.push(`<line x1="${PAD}" y1="${px(y)}" x2="${W - PAD}" y2="${px(y)}" stroke="${RULE}" stroke-width="1"/>`); };

  y += 20; out.push(textEl(PAD, y, 'Floor plan', { size: 22, weight: 700 }));
  const title = nameOf({ name: o.title ?? '' }, '').slice(0, 80);
  if (title) paragraph(title, { size: 13.5, fill: MUTED });
  rule();

  let key = 0;
  for (const f of floors) {
    y += 30;
    out.push(textEl(PAD, y, f.label.toUpperCase(), { size: 12.5, weight: 700, spacing: 1.4 }));
    if (f.rooms.length) out.push(textEl(W - PAD, y, formatArea(f.area), { size: 13, weight: 600, anchor: 'end' }));
    const notes: string[] = [];
    if (f.rooms.length) {
      y += 16;
      const x0 = (W - f.width * scale) / 2, y0 = y;
      const at = (s: Segment): Segment => ({ x1: x0 + s.x1 * scale, y1: y0 + s.y1 * scale, x2: x0 + s.x2 * scale, y2: y0 + s.y2 * scale });
      for (const p of f.rooms) out.push(`<rect x="${px(x0 + p.x * scale)}" y="${px(y0 + p.y * scale)}" width="${px(p.w * scale)}" height="${px(p.h * scale)}" fill="${PAPER}"/>`);
      const walls = wallSegments(f.rooms);
      for (const s of walls.inner) out.push(lineEl(at(s), 2.5));
      for (const s of walls.outer) out.push(lineEl(at(s), 6));
      for (const p of f.rooms) {
        const w = p.w * scale, h = p.h * scale, cx = x0 + (p.x + p.w / 2) * scale, cy = y0 + (p.y + p.h / 2) * scale;
        const name = nameOf(p.room), metric = formatSize(p.w, p.h), imperial = formatSizeImperial(p.w, p.h);
        const label = fitLabel(name, metric, imperial, formatM2(p.area), w, h);
        if (!label.full) {
          key++;
          notes.push(`${key}. ${name}: ${metric} (${imperial}), ${formatArea(p.area)}`);
          // The number sits in the room's top-left corner, or in the middle of a room too small for any words.
          const bx = label.lines.length ? x0 + p.x * scale + 15 : cx, by = label.lines.length ? y0 + p.y * scale + 15 : cy;
          out.push(`<circle cx="${px(bx)}" cy="${px(by)}" r="8" fill="${INK}"/>`, textEl(bx, by + 3.2, String(key), { size: 9.5, weight: 700, fill: PAPER, anchor: 'middle' }));
        }
        const height = label.lines.reduce((s, l) => s + l.size * 1.34, 0);
        let ty = cy - height / 2 + (label.full ? 0 : 6);
        for (const l of label.lines) { ty += l.size * 1.34; out.push(textEl(cx, ty - l.size * 0.3, l.text, { size: l.size, weight: l.weight, fill: l.fill, anchor: 'middle' })); }
      }
      y = y0 + f.height * scale + 8;
    }
    for (const n of notes) paragraph(n, { size: 12 });
    if (f.unmeasured.length) paragraph(`Not drawn (still to be measured): ${f.unmeasured.map((r) => nameOf(r)).join(', ')}.`, { size: 12, fill: MUTED });
  }
  if (!totals.measured) { y += 8; paragraph('Add the width and length of each room to draw the plan.', { size: 13.5, fill: MUTED }); }

  y += 8; rule();
  y += 26; out.push(textEl(PAD, y, TOTAL_LABEL.toUpperCase(), { size: 11.5, weight: 700, fill: MUTED, spacing: 1.2 }));
  y += 28; out.push(textEl(PAD, y, totals.measured ? formatArea(totals.m2) : 'Not measured yet', { size: 22, weight: 700 }));
  if (totals.floors.filter((f) => f.measured).length > 1) paragraph(totals.floors.filter((f) => f.measured).map((f) => `${f.label} ${formatArea(f.m2)}`).join(' · '), { size: 12.5 });
  if (totals.measured && totals.needsMeasuring.length) paragraph(`Does not include ${plural(totals.needsMeasuring.length, 'room')} still to be measured.`, { size: 12, fill: MUTED });

  if (totals.measured) {
    // A scale bar marked in metres, as long as fits: 5 m, 2 m or 1 m.
    const metres = [5, 2, 1].find((m) => m * scale <= inner) ?? 1;
    y += 26;
    for (let i = 0; i < metres; i++) out.push(`<rect x="${px(PAD + i * scale)}" y="${px(y)}" width="${px(scale)}" height="7" fill="${i % 2 ? PAPER : INK}" stroke="${INK}" stroke-width="1"/>`);
    y += 21;
    for (let i = 0; i <= metres; i++) out.push(textEl(PAD + i * scale, y, i === metres ? `${i} m` : String(i), { size: 10.5, fill: MUTED, anchor: i === 0 ? 'start' : 'middle' }));
  }
  y += 6;
  paragraph(PLAN_NOTE, { size: 12, fill: MUTED });
  const H = Math.ceil(y + PAD);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="fp-title fp-desc" font-family="${FONT}">`,
    `<title id="fp-title">${esc(title ? `Floor plan: ${title}` : 'Floor plan')}</title>`,
    `<desc id="fp-desc">${esc(planSummary(rooms))}</desc>`,
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>`,
    ...out,
    '</svg>',
  ].join('\n');
}

/** The picture's size in pixels, read back from an SVG made by renderPlanSvg. */
export function svgSize(svg: string): { width: number; height: number } {
  const m = svg.match(/^<svg[^>]*\swidth="(\d+)"\sheight="(\d+)"/);
  return { width: m ? Number(m[1]) : MIN_WIDTH, height: m ? Number(m[2]) : MIN_WIDTH };
}
/** The SVG as an address a picture can be shown from (no file needed). */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
