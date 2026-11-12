/**
 * Browser side of the floor plan maker: the rooms as the person types them, the plan as a PNG,
 * downloads, and the table kept in this tab so it isn't lost between pages.
 * The plan itself is worked out and drawn by src/engine/floorplan.ts.
 */
import { FLOOR_LABEL, isFloor, isMeasured, MAX_SIDE_M, MIN_SIDE_M, normalisePositions, parseLength, svgDataUrl, svgSize, type Floor, type PlanRoom } from '../engine/floorplan';

/** One line of the maker's table: sizes are kept as typed, in the unit chosen for that room. */
export interface MakerRow {
  id: string;
  name: string;
  floor: Floor;
  width: string;
  length: string;
  unit: 'm' | 'ft';
  /** Which row of its floor the room is drawn in (1 at the top). Rooms in a row are drawn in table order. */
  row: number;
  /** Filled in by AI from a sketch and not yet changed by the person. */
  ai?: boolean;
}
export interface MakerState { rows: MakerRow[]; title: string }

export const MAX_ROOMS = 60;
let seq = 0;
export const newId = () => `r${Date.now().toString(36)}${(++seq).toString(36)}`;
export const blankRow = (after?: MakerRow): MakerRow => ({ id: newId(), name: '', floor: after?.floor ?? 'ground', width: '', length: '', unit: after?.unit ?? 'm', row: after?.row ?? 1 });
/** A line nobody has typed anything into. */
export const isBlank = (r: MakerRow) => !r.name.trim() && !r.width.trim() && !r.length.trim();

/** The table in plan order (floor, then row, keeping the order rooms are listed in), with rows numbered from 1 on each floor. */
export function arrange(rows: MakerRow[]): MakerRow[] {
  return normalisePositions(rows.map((r, i) => ({ ...r, order: i }))).map(({ order: _order, ...r }) => r);
}

/** The rooms to draw: sizes read into metres, positions from the table. Lines with nothing typed are left out. */
export function rowsToRooms(rows: MakerRow[]): PlanRoom[] {
  return normalisePositions(rows.filter((r) => !isBlank(r)).map((r, i) => ({
    id: r.id, name: r.name.trim(), floor: r.floor, width: parseLength(r.width, r.unit), length: parseLength(r.length, r.unit), row: r.row, order: i,
  })));
}

/** Rooms read back from storage (a form kept in this tab): only well-formed ones are kept. null when there are none. */
export function storedRooms(v: unknown): PlanRoom[] | null {
  if (!Array.isArray(v)) return null;
  const size = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const rooms = (v as Partial<PlanRoom>[]).filter((r) => r && typeof r === 'object' && isFloor(r.floor)).slice(0, MAX_ROOMS).map((r, i): PlanRoom => ({
    id: typeof r.id === 'string' ? r.id.slice(0, 40) : `k${i}`, name: typeof r.name === 'string' ? r.name.slice(0, 40) : '', floor: r.floor as Floor,
    width: size(r.width), length: size(r.length), row: size(r.row) ?? 1, order: size(r.order) ?? i + 1,
  }));
  return rooms.length ? normalisePositions(rooms) : null;
}

/** What's wrong with a size as typed, or null (an empty box isn't wrong: the room just isn't measured yet). */
export function sizeProblem(text: string, unit: 'm' | 'ft'): string | null {
  if (!text.trim()) return null;
  const m = parseLength(text, unit);
  if (m == null) return unit === 'ft' ? 'Enter a size such as 13\'9" or 13.5.' : 'Enter a size such as 4.2 or 4200mm.';
  if (!isMeasured({ width: m, length: m })) return `Enter a size between ${MIN_SIDE_M} m and ${MAX_SIDE_M} m.`;
  return null;
}

/** A name for a room in messages and button labels: its own, or its place in the table. */
export const roomLabel = (r: MakerRow, index: number) => r.name.trim() || `room ${index + 1}`;
export const floorOptions = (Object.keys(FLOOR_LABEL) as Floor[]).map((f) => ({ value: f, label: FLOOR_LABEL[f] }));

/* ───────── the table, kept in this tab ───────── */
/*
 * The 'streetkey-draft:' prefix means src/lib/server.tsx clears it on sign-out or when the tab's account changes,
 * like the site's other unsent forms. Kept in sessionStorage: it goes when the tab is closed.
 */
const MAKER_KEY = 'streetkey-draft:floor-plan';
export function loadMaker(): MakerState | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(MAKER_KEY) ?? 'null') as { v?: number; rows?: unknown; title?: unknown } | null;
    if (d?.v !== 1 || !Array.isArray(d.rows)) return null;
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const rows = (d.rows as Partial<MakerRow>[]).filter((r) => r && typeof r === 'object').slice(0, MAX_ROOMS).map((r): MakerRow => ({
      id: text(r.id, 40) || newId(), name: text(r.name, 40), floor: isFloor(r.floor) ? r.floor : 'ground', width: text(r.width, 30), length: text(r.length, 30),
      unit: r.unit === 'ft' ? 'ft' : 'm', row: typeof r.row === 'number' && Number.isFinite(r.row) ? r.row : 1, ...(r.ai === true ? { ai: true } : {}),
    }));
    return rows.length ? { rows: arrange(rows), title: text(d.title, 80) } : null;
  } catch { return null; }
}
export function saveMaker(s: MakerState) {
  try {
    if (s.rows.every(isBlank) && !s.title.trim()) sessionStorage.removeItem(MAKER_KEY);
    else sessionStorage.setItem(MAKER_KEY, JSON.stringify({ v: 1, rows: s.rows, title: s.title }));
  } catch { /* storage unavailable: nothing to keep */ }
}

/* ───────── the plan as a PNG ───────── */

/**
 * Draws the SVG plan onto a canvas and returns it as a PNG, twice the plan's size so it stays sharp
 * (less for a very long plan, so phones can still draw it). White background.
 */
export async function planPng(svg: string): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const scale = Math.max(0.5, Math.min(2, Math.sqrt(12_000_000 / (width * height))));
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The plan couldn’t be drawn as a picture.'));
    img.src = svgDataUrl(svg);
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The plan couldn’t be drawn as a picture.');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob || !blob.size) throw new Error('The plan couldn’t be drawn as a picture.');
  return blob;
}

/** Saves a file to the person's device. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "floor-plan-12-example-road" from the plan's title, or just "floor-plan". */
export function planFileName(title: string) {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug ? `floor-plan-${slug}` : 'floor-plan';
}
