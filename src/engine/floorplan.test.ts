import { describe, expect, it } from 'vitest';
import {
  feetText, FLOORS, formatArea, formatFeetInches, formatSize, formatSizeImperial, isFloor, isFloorPlanCaption, isMeasured, layoutPlan, metresText, normalisePositions, parseDimensions, parseLength,
  PLAN_NOTE, planCaption, planSummary, planTotals, readDimensions, readLength, renderPlanSvg, roomArea, sortRooms, splitDimensions, sqFt, svgDataUrl, svgSize, TOTAL_LABEL, wallSegments,
  type Floor, type PlacedRoom, type PlanRoom,
} from './floorplan';
import type { ListingDTO } from '../lib/apiTypes';
import { arrange, blankRow, isBlank, planFileName, rowsToRooms, sizeProblem, storedRooms, type MakerRow } from '../lib/floorplan';
import { dtoToProperty } from '../lib/listingAdapter';

let n = 0;
const room = (name: string, width: number | null, length: number | null, o: Partial<PlanRoom> = {}): PlanRoom => ({ id: `r${++n}`, name, floor: 'ground', width, length, row: 1, order: 1, ...o });

/** A small two-storey house: two rows downstairs, one upstairs, and a room that hasn't been measured. */
const HOUSE: PlanRoom[] = [
  room('Kitchen', 3.2, 3, { row: 1, order: 1 }),
  room('Dining room', 3.6, 3, { row: 1, order: 2 }),
  room('Hall', 1.8, 4.2, { row: 2, order: 1 }),
  room('Living room', 5, 4.2, { row: 2, order: 2 }),
  room('WC', 0.9, 1.8, { row: 3, order: 1 }),
  room('Bedroom 1', 4.2, 3.9, { floor: 'first', row: 1, order: 1 }),
  room('Bathroom', 2.6, 2.1, { floor: 'first', row: 1, order: 2 }),
  room('Utility', null, null, { row: 3, order: 2 }),
];

describe('reading sizes as people write them', () => {
  it('reads one length in metres, centimetres, millimetres, feet and inches', () => {
    const cases: [string, number | null][] = [
      ['4.2', 4.2], ['4.2m', 4.2], ['4.20 m', 4.2], ['4,2', 4.2], ['4.2 metres', 4.2], ['4 meters', 4],
      ['4200mm', 4.2], ['4200 mm', 4.2], ['4,200mm', 4.2], ['420cm', 4.2], ['420 centimetres', 4.2],
      ['4200', 4.2], ['420', 4.2], // no unit: thousands are millimetres, hundreds are centimetres
      ['13\'9"', 4.191], ['13’9”', 4.191], ['13′9″', 4.191], ['13ft 9in', 4.191], ['13 ft 9 in', 4.191], ['13\' 9', 4.191], ['13 feet 9 inches', 4.191], ['13\'-9"', 4.191],
      ['13ft', 3.9624], ['13\'', 3.9624], ['13.5ft', 4.1148], ['13\'9½"', 4.2037], ['165"', 4.191], ['165 in', 4.191],
      ['4.19m (13\'9")', 4.19], ['approx 4.2m', 4.2], ['4.2m max', 4.2],
      ['', null], ['large', null], ['4.2 x 3.9', null], ['13\'14"', null], ['0', null], ['-4', null], ['4.2.1', null], ['m', null],
    ];
    for (const [text, metres] of cases) expect(parseLength(text), text).toBe(metres);
  });

  it('uses the unit the person chose for a number written without one', () => {
    expect(parseLength('13', 'ft')).toBe(3.9624);
    expect(parseLength('13.5', 'ft')).toBe(4.1148);
    expect(parseLength('13 9', 'ft')).toBe(4.191);
    expect(parseLength('13-9', 'ft')).toBe(4.191);
    expect(parseLength('13 9', 'm')).toBeNull();
    expect(parseLength('13 14', 'ft')).toBeNull();
    expect(parseLength('4.2m', 'ft')).toBe(4.2); // a written unit always wins
    expect(parseLength('13\'9"', 'm')).toBe(4.191);
    // strict: the unit is known (for example it is written elsewhere on a sketch), so nothing is guessed from the size
    expect(parseLength('4200', 'mm', true)).toBe(4.2);
    expect(parseLength('420', 'cm', true)).toBe(4.2);
    expect(parseLength('165', 'in', true)).toBe(4.191);
    expect(parseLength('420', 'mm', true)).toBe(0.42);
    expect(parseLength('420', 'mm')).toBe(4.2); // not strict: hundreds are still read as centimetres
  });

  it('reads a room’s size: width first, then length', () => {
    const cases: [string, [number, number] | null][] = [
      ['4.2 x 3.9', [4.2, 3.9]], ['4.2m × 3.9m', [4.2, 3.9]], ['4.2 X 3.9', [4.2, 3.9]], ['4.2 by 3.9', [4.2, 3.9]], ['4.2*3.9', [4.2, 3.9]], ['4.2m x 3.9', [4.2, 3.9]], ['4.2 x 3.9m', [4.2, 3.9]],
      ['13\'9" x 12\'10"', [4.191, 3.9116]], ['13’9” × 12’10”', [4.191, 3.9116]], ['13ft 9in x 12ft 10in', [4.191, 3.9116]], ['13\' x 12\'10"', [3.9624, 3.9116]], ['13 x 12\'10"', [3.9624, 3.9116]],
      ['4200 x 3900', [4.2, 3.9]], ['4200mm x 3900mm', [4.2, 3.9]], ['900 x 1800', [0.9, 1.8]], ['420 x 390', [4.2, 3.9]], ['420cm x 390cm', [4.2, 3.9]],
      ['4.20m x 3.90m (13\'9" x 12\'10")', [4.2, 3.9]], ['(13\'9" x 12\'10")', [4.191, 3.9116]], ['4.2 x 3.9 x 2.4', [4.2, 3.9]], ['4.2m x 3.9m max', [4.2, 3.9]],
      ['4.2', null], ['living room', null], ['4.2 x', null], ['x 3.9', null], ['4.2 x big', null], ['1 x 2 x 3 x 4', null], ['', null],
    ];
    for (const [text, size] of cases) expect(parseDimensions(text), text).toEqual(size ? { width: size[0], length: size[1] } : null);
    expect(parseDimensions('13 x 12', 'ft')).toEqual({ width: 3.9624, length: 3.6576 });
    expect(parseDimensions('13 x 12')).toEqual({ width: 13, length: 12 });
    expect(parseDimensions('4200 x 900', 'mm', true)).toEqual({ width: 4.2, length: 0.9 });
  });

  it('says which unit each size was read in, and writes feet and inches so they read back exactly', () => {
    expect(readLength('13\'9"')).toEqual({ metres: 4.191, unit: 'ft' });
    expect(readLength('165 in')).toEqual({ metres: 4.191, unit: 'in' });
    expect(readLength('4200')).toEqual({ metres: 4.2, unit: 'mm' });
    expect(readLength('420')).toEqual({ metres: 4.2, unit: 'cm' });
    expect(readLength('4.2')).toEqual({ metres: 4.2, unit: 'm' });
    expect(readLength('13', 'ft')).toEqual({ metres: 3.9624, unit: 'ft' });
    expect(readLength('nonsense')).toBeNull();
    expect(readDimensions('420 x 95')).toEqual({ width: 4.2, length: 0.95, units: ['cm', 'cm'] }); // read together: both centimetres
    expect(readDimensions('13 x 12\'10"')).toEqual({ width: 3.9624, length: 3.9116, units: ['ft', 'ft'] });
    expect(readDimensions('4.2m x 13\'9"')).toEqual({ width: 4.2, length: 4.191, units: ['m', 'ft'] });
    expect(readDimensions('4200 x 3900', 'mm', true)).toEqual({ width: 4.2, length: 3.9, units: ['mm', 'mm'] });
    expect(feetText(4.191)).toBe('13\'9"');
    expect(feetText(3.9624)).toBe('13\'0"');
    expect(feetText(4.2037)).toBe('13\'9.5"');
    for (const m of [0.3, 1.2192, 2.54, 3.6576, 4.191, 4.2037, 9.99, 29.9]) expect(Math.abs(parseLength(feetText(m))! - m), String(m)).toBeLessThan(0.0002);
    for (const m of [0.3, 1.2192, 4.191, 29.999]) expect(Math.abs(parseLength(metresText(m))! - m), String(m)).toBeLessThanOrEqual(0.0005);
  });

  it('splits a size typed into one box into two that mean the same on their own', () => {
    expect(splitDimensions('4.2 x 3.9')).toEqual({ width: '4.2', length: '3.9' });
    expect(splitDimensions('13’9” × 12’10”')).toEqual({ width: '13\'9"', length: '12\'10"' });
    expect(splitDimensions('4200 x 3900')).toEqual({ width: '4200', length: '3900' });
    expect(splitDimensions('900 x 1800')).toEqual({ width: '0.9m', length: '1800' }); // 900 alone would read as 9 m
    expect(splitDimensions('4.2 x 3.9m', 'ft')).toEqual({ width: '4.2m', length: '3.9m' });
    expect(splitDimensions('13 x 12', 'ft')).toEqual({ width: '13', length: '12' });
    expect(splitDimensions('4.2')).toBeNull();
    for (const text of ['4.2 x 3.9', '13\'9" x 12\'10"', '900 x 1800', '420 x 95', '13 x 12\'10"', '4.2 x 3.9m']) {
      for (const unit of ['m', 'ft'] as const) {
        const whole = parseDimensions(text, unit)!, parts = splitDimensions(text, unit)!;
        expect(parseLength(parts.width, unit), `${text} (${unit})`).toBeCloseTo(whole.width, 3);
        expect(parseLength(parts.length, unit), `${text} (${unit})`).toBeCloseTo(whole.length, 3);
      }
    }
  });

  it('writes sizes and areas the way a floor plan shows them', () => {
    expect(formatFeetInches(4.191)).toBe('13\'9"');
    expect(formatFeetInches(3.9116)).toBe('12\'10"');
    expect(formatFeetInches(3.6576)).toBe('12\'0"');
    expect(formatFeetInches(3.645)).toBe('12\'0"'); // 11.96 feet rounds up to the next foot, not to 11'12"
    expect(formatSize(4.2, 3.9)).toBe('4.20 × 3.90 m');
    expect(formatSizeImperial(4.2, 3.9)).toBe('13\'9" × 12\'10"');
    expect(formatArea(16.4)).toBe('16.4 m² (177 sq ft)');
    expect(formatArea(1234.5)).toBe('1234.5 m² (13,288 sq ft)');
    expect(sqFt(100)).toBe(1076);
    expect(metresText(3.9116)).toBe('3.912');
    expect(metresText(4.2)).toBe('4.2');
  });
});

describe('areas and totals', () => {
  it('multiplies out each room and adds up each floor and the whole home', () => {
    expect(roomArea(room('Bedroom', 4.2, 3.9))).toBe(16.4); // 16.38
    expect(roomArea(room('Hall', 1.8, 4.2))).toBe(7.6); // 7.56
    expect(roomArea(room('Store', null, 2))).toBeNull();
    expect(roomArea(room('Store', 0, 2))).toBeNull();
    expect(roomArea(room('Hangar', 150, 2))).toBeNull();
    const t = planTotals(HOUSE);
    expect(t.floors).toEqual([
      { floor: 'ground', label: 'Ground floor', rooms: 6, measured: 5, m2: 50.6, sqft: 545 }, // 9.6 + 10.8 + 7.6 + 21.0 + 1.6
      { floor: 'first', label: 'First floor', rooms: 2, measured: 2, m2: 21.9, sqft: 236 },   // 16.4 + 5.5
    ]);
    expect(t).toMatchObject({ rooms: 8, measured: 7, m2: 72.5, sqft: 780 });
    expect(t.needsMeasuring.map((r) => r.name)).toEqual(['Utility']);
    // the totals are the sums of the figures printed for each room, so the plan always adds up
    const printed = HOUSE.map((r) => roomArea(r) ?? 0);
    expect(Math.round(printed.reduce((s, a) => s + a, 0) * 10) / 10).toBe(t.m2);
    expect(Math.round(t.floors.reduce((s, f) => s + f.m2, 0) * 10) / 10).toBe(t.m2);
    expect(planTotals([])).toEqual({ floors: [], rooms: 0, measured: 0, m2: 0, sqft: 0, needsMeasuring: [] });
  });

  it('only counts rooms with a usable width and length', () => {
    expect(isMeasured({ width: 4, length: 3 })).toBe(true);
    for (const [w, l] of [[null, 3], [4, null], [0, 3], [4, -1], [Number.NaN, 3], [4, Infinity], [0.05, 3], [101, 3]] as const) expect(isMeasured({ width: w, length: l }), `${w} x ${l}`).toBe(false);
  });
});

describe('order and position', () => {
  it('sorts by floor, row and order, and renumbers rows and places from 1', () => {
    const mixed = [
      room('c', 1, 1, { floor: 'first', row: 5, order: 9 }), room('a', 1, 1, { floor: 'ground', row: 7, order: 3 }), room('b', 1, 1, { floor: 'ground', row: 7, order: 8 }),
      room('z', 1, 1, { floor: 'basement', row: 2, order: 1 }), room('d', 1, 1, { floor: 'ground', row: 2.4, order: 1 }), room('e', 1, 1, { floor: 'ground', row: 7, order: 3 }),
    ];
    expect(sortRooms(mixed).map((r) => r.name)).toEqual(['z', 'd', 'a', 'e', 'b', 'c']);
    expect(normalisePositions(mixed).map((r) => [r.name, r.floor, r.row, r.order])).toEqual([
      ['z', 'basement', 1, 1], ['d', 'ground', 1, 1], ['a', 'ground', 2, 1], ['e', 'ground', 2, 2], ['b', 'ground', 2, 3], ['c', 'first', 1, 1],
    ]);
    expect(normalisePositions([room('x', 1, 1, { row: Number.NaN, order: 0 }), room('y', 1, 1, { row: -3, order: 0 })]).map((r) => [r.row, r.order])).toEqual([[1, 1], [1, 2]]);
    expect(FLOORS).toEqual(['basement', 'ground', 'first', 'second', 'loft']);
    expect(['ground', 'loft', 'attic', '', null, 3].map(isFloor)).toEqual([true, true, false, false, false, false]);
  });
});

describe('layout', () => {
  const overlaps = (a: PlacedRoom, b: PlacedRoom) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

  it('lays rows out left to right and stacks them, with no overlaps', () => {
    const [ground, first] = layoutPlan(HOUSE);
    expect(ground.rooms.map((p) => [p.room.name, p.x, p.y, p.w, p.h])).toEqual([
      ['Kitchen', 0, 0, 3.2, 3], ['Dining room', 3.2, 0, 3.6, 3],
      ['Hall', 0, 3, 1.8, 4.2], ['Living room', 1.8, 3, 5, 4.2],
      ['WC', 0, 7.2, 0.9, 1.8],
    ]);
    expect(ground).toMatchObject({ floor: 'ground', label: 'Ground floor', width: 6.8, height: 9, area: 50.6 });
    expect(ground.unmeasured.map((r) => r.name)).toEqual(['Utility']);
    expect(first.rooms.map((p) => [p.room.name, p.x, p.y])).toEqual([['Bedroom 1', 0, 0], ['Bathroom', 4.2, 0]]);
    expect(first).toMatchObject({ width: 6.8, height: 3.9, area: 21.9 });
    for (const f of [ground, first]) for (const a of f.rooms) for (const b of f.rooms) if (a !== b) expect(overlaps(a, b), `${a.room.name} / ${b.room.name}`).toBe(false);
  });

  it('never overlaps rooms, whatever sizes and positions they are given', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 40; run++) {
      const rooms = Array.from({ length: 1 + Math.floor(rnd() * 14) }, (_, i) => room(`R${i}`, rnd() < 0.1 ? null : Math.round((0.6 + rnd() * 6) * 100) / 100, Math.round((0.6 + rnd() * 6) * 100) / 100,
        { floor: FLOORS[Math.floor(rnd() * FLOORS.length)] as Floor, row: 1 + Math.floor(rnd() * 4), order: 1 + Math.floor(rnd() * 5) }));
      const floors = layoutPlan(rooms);
      expect(floors.reduce((s, f) => s + f.rooms.length + f.unmeasured.length, 0)).toBe(rooms.length);
      for (const f of floors) {
        for (const a of f.rooms) {
          expect(a.x >= 0 && a.y >= 0 && a.x + a.w <= f.width + 1e-9 && a.y + a.h <= f.height + 1e-9).toBe(true);
          for (const b of f.rooms) if (a !== b) expect(overlaps(a, b)).toBe(false);
        }
      }
    }
  });

  it('leaves out floors with no rooms and rows with nothing measured', () => {
    expect(layoutPlan([])).toEqual([]);
    const f = layoutPlan([room('A', null, null, { row: 1 }), room('B', 3, 2, { row: 2 }), room('C', 2, 2, { floor: 'loft' })]);
    expect(f.map((x) => x.floor)).toEqual(['ground', 'loft']);
    expect(f[0].rooms.map((p) => [p.room.name, p.x, p.y])).toEqual([['B', 0, 0]]);
    expect(f[0].unmeasured.map((r) => r.name)).toEqual(['A']);
  });

  it('shares walls between neighbours and marks the outside walls', () => {
    const len = (s: { x1: number; y1: number; x2: number; y2: number }) => Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);
    const sum = (xs: { x1: number; y1: number; x2: number; y2: number }[]) => Math.round(xs.reduce((t, s) => t + len(s), 0) * 1000) / 1000;
    // two rooms side by side: one shared wall, drawn once
    const pair = layoutPlan([room('A', 3, 4, { order: 1 }), room('B', 2, 4, { order: 2 })])[0].rooms;
    const w = wallSegments(pair);
    expect(w.inner).toEqual([{ x1: 3, y1: 0, x2: 3, y2: 4 }]);
    expect(sum(w.outer)).toBe(18); // the outline of a 5 × 4 rectangle
    // a shorter neighbour shares only the stretch where they touch
    const uneven = wallSegments(layoutPlan([room('A', 3, 4, { order: 1 }), room('B', 2, 2.5, { order: 2 })])[0].rooms);
    expect(uneven.inner).toEqual([{ x1: 3, y1: 0, x2: 3, y2: 2.5 }]);
    expect(sum(uneven.outer)).toBe(18); // 3 + 2 along the top, 4 down the left, 3 along the bottom of A, 1.5 up A's right side, 2 under B, 2.5 up B's right side
    // the house: every wall between two rooms is found once, and outside + 2 × shared = the rooms' perimeters
    const ground = layoutPlan(HOUSE)[0].rooms;
    const g = wallSegments(ground);
    const perimeters = ground.reduce((t, p) => t + 2 * (p.w + p.h), 0);
    expect(sum(g.outer) + 2 * sum(g.inner)).toBeCloseTo(perimeters, 6);
    expect(g.inner).toEqual(expect.arrayContaining([
      { x1: 3.2, y1: 0, x2: 3.2, y2: 3 },   // kitchen | dining room
      { x1: 0, y1: 3, x2: 1.8, y2: 3 },     // kitchen over the hall
      { x1: 1.8, y1: 3, x2: 3.2, y2: 3 },   // kitchen over the living room
      { x1: 3.2, y1: 3, x2: 6.8, y2: 3 },   // dining room over the living room
      { x1: 1.8, y1: 3, x2: 1.8, y2: 7.2 }, // hall | living room
      { x1: 0, y1: 7.2, x2: 0.9, y2: 7.2 }, // hall over the WC
    ]));
    expect(g.inner).toHaveLength(6);
    expect(wallSegments([])).toEqual({ outer: [], inner: [] });
  });
});

describe('the drawing', () => {
  const svg = renderPlanSvg(HOUSE, { title: '12 Example Road' });
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&'));

  it('is a self-contained SVG with a size, a title and a description', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    const { width, height } = svgSize(svg);
    expect(width).toBeGreaterThanOrEqual(600);
    expect(width).toBeLessThanOrEqual(1120);
    expect(height).toBeGreaterThan(900);
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(svg).toMatch(/<title id="fp-title">Floor plan: 12 Example Road<\/title>/);
    expect(svg).toMatch(/<desc id="fp-desc">Floor plan\. Ground floor, 50\.6 m² \(545 sq ft\): Kitchen 3\.20 × 3\.00 m;/);
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|on[a-z]+=/i);
    expect(svgDataUrl(svg).startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
  });

  it('shows each room’s name, its size in metres and in feet and inches, and its area', () => {
    for (const t of ['Kitchen', '3.20 × 3.00 m', '10\'6" × 9\'10"', '9.6 m²', 'Living room', '5.00 × 4.20 m', '16\'5" × 13\'9"', '21.0 m²', 'Bedroom 1', '4.20 × 3.90 m', '13\'9" × 12\'10"', '16.4 m²', 'Bathroom', '2.60 × 2.10 m']) {
      expect(texts, t).toContain(t);
    }
  });

  it('shows the total for each floor, the overall total, a scale bar and the note that it is not a measured survey', () => {
    expect(texts).toEqual(expect.arrayContaining(['Floor plan', '12 Example Road', 'GROUND FLOOR', '50.6 m² (545 sq ft)', 'FIRST FLOOR', '21.9 m² (236 sq ft)']));
    expect(texts).toContain(TOTAL_LABEL.toUpperCase());
    expect(texts).toContain('72.5 m² (780 sq ft)');
    expect(texts).toContain('Ground floor 50.6 m² (545 sq ft) · First floor 21.9 m² (236 sq ft)');
    expect(texts).toContain(PLAN_NOTE);
    expect(PLAN_NOTE).toMatch(/measurements supplied/);
    expect(PLAN_NOTE).toMatch(/not a measured survey/);
    // scale bar: five one-metre blocks, marked 0 to 5 m, each as long as a metre is drawn
    expect(texts).toEqual(expect.arrayContaining(['0', '1', '2', '3', '4', '5 m']));
    const blocks = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="7"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(blocks).toHaveLength(5);
    const kitchen = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" fill="#FFFFFF"\/>/)!;
    const perMetre = Number(kitchen[1]) / 3.2;
    expect(Number(kitchen[2]) / 3).toBeCloseTo(perMetre, 1); // drawn to scale: the same pixels per metre both ways
    for (const [, w] of blocks) expect(w).toBeCloseTo(perMetre, 1);
  });

  it('draws outside walls heavier than the walls between rooms', () => {
    const widths = [...svg.matchAll(/<line [^>]*stroke-width="([\d.]+)" stroke-linecap="square"\/>/g)].map((m) => Number(m[1]));
    expect(widths.filter((w) => w === 2.5).length).toBe(7); // six downstairs, one upstairs
    expect(widths.filter((w) => w === 6).length).toBeGreaterThan(8);
    expect(new Set(widths)).toEqual(new Set([2.5, 6]));
  });

  it('numbers a room too small for its details and writes them out in a key', () => {
    expect(texts).toContain('1. WC: 0.90 × 1.80 m (2\'11" × 5\'11"), 1.6 m² (17 sq ft)');
    expect(svg).toMatch(/<circle [^>]*r="8"/);
    expect(texts).not.toContain('2. Kitchen: 3.20 × 3.00 m (10\'6" × 9\'10"), 9.6 m² (103 sq ft)');
  });

  it('lists rooms without a size instead of drawing or counting them', () => {
    expect(texts).toContain('Not drawn (still to be measured): Utility.');
    expect(texts).toContain('Does not include 1 room still to be measured.');
    expect(texts.filter((t) => t === 'Utility')).toHaveLength(0);
    const empty = renderPlanSvg([room('Lounge', null, null)]);
    expect(empty).toContain('Add the width and length of each room to draw the plan.');
    expect(empty).toContain('Not measured yet');
    expect(empty).not.toMatch(/height="7"/); // no scale bar without a drawing
    expect(renderPlanSvg([])).toContain(PLAN_NOTE);
  });

  it('escapes names, so nothing typed or read from a sketch can become markup', () => {
    const nasty = renderPlanSvg([room('<script>alert(1)</script> & "Bed" \'1\'\u0007', 4, 4)], { title: '</title><svg onload=alert(1)>' });
    expect(nasty).not.toMatch(/<script|<svg onload|onload=alert\(1\)>/);
    expect(nasty).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Bed&quot; &#39;1&#39;');
    expect(nasty).toContain('&lt;/title&gt;&lt;svg onload=alert(1)&gt;');
    expect((nasty.match(/<svg/g) ?? []).length).toBe(1);
  });

  it('fits a very wide home on the page and keeps it to scale', () => {
    const wide = renderPlanSvg(Array.from({ length: 12 }, (_, i) => room(`Unit ${i + 1}`, 5, 4, { order: i + 1 })));
    expect(svgSize(wide).width).toBe(1120);
    const rects = [...wide.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" fill="#FFFFFF"\/>/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]), h: Number(m[3]) }));
    expect(rects).toHaveLength(12);
    expect(rects[0].w / 5).toBeCloseTo(rects[0].h / 4, 1);
    expect(rects[11].x + rects[11].w).toBeLessThanOrEqual(1120 - 32 + 0.01);
    expect(rects[0].x).toBeGreaterThanOrEqual(32 - 0.01);
  });
});

describe('words about a plan', () => {
  it('captions the plan as a picture, starting "Floor plan"', () => {
    expect(planCaption(HOUSE)).toBe('Floor plan: 7 rooms on 2 floors, about 72.5 m² (780 sq ft) in total. Drawn from the measurements supplied, not a measured survey.');
    expect(planCaption([room('Studio', 5, 4)])).toBe('Floor plan: 1 room, about 20.0 m² (215 sq ft) in total. Drawn from the measurements supplied, not a measured survey.');
    expect(planCaption([])).toBe('Floor plan: Drawn from the measurements supplied, not a measured survey.');
    expect(planCaption(Array.from({ length: 40 }, (_, i) => room(`R${i}`, 99, 99, { floor: FLOORS[i % 5] }))).length).toBeLessThanOrEqual(160);
    for (const yes of ['Floor plan', 'floor plan: 6 rooms', ' Floorplan', 'Floor plans', planCaption(HOUSE)]) expect(isFloorPlanCaption(yes), yes).toBe(true);
    for (const no of ['Kitchen with a tiled floor', 'Ground floor plan', 'Floor planning', '', null, undefined]) expect(isFloorPlanCaption(no), String(no)).toBe(false);
  });

  it('describes the plan room by room for people who can’t see the drawing', () => {
    const s = planSummary(HOUSE);
    expect(s).toMatch(/^Floor plan\. Ground floor, 50\.6 m² \(545 sq ft\): Kitchen 3\.20 × 3\.00 m; Dining room 3\.60 × 3\.00 m; Hall 1\.80 × 4\.20 m; Living room 5\.00 × 4\.20 m; WC 0\.90 × 1\.80 m\. First floor, 21\.9 m² \(236 sq ft\): Bedroom 1 4\.20 × 3\.90 m; Bathroom 2\.60 × 2\.10 m\./);
    expect(s).toContain('Approximate gross internal area 72.5 m² (780 sq ft).');
    expect(s).toContain('Not drawn, still to be measured: Utility.');
    expect(s.endsWith(PLAN_NOTE)).toBe(true);
    expect(planSummary([room('', null, null)])).toMatch(/No rooms have been measured yet/);
    expect(planSummary([room('  ', 3, 3)])).toContain('Room 3.00 × 3.00 m');
  });
});

describe('the maker’s table', () => {
  const line = (name: string, o: Partial<MakerRow> = {}): MakerRow => ({ id: name || `blank${++n}`, name, floor: 'ground', width: '', length: '', unit: 'm', row: 1, ...o });

  it('keeps the table in plan order, with rooms in a row in the order they are listed', () => {
    const rows = [line('Lounge', { row: 4 }), line('Bed 1', { floor: 'first', row: 2 }), line('Kitchen', { row: 4 }), line('Hall', { row: 2 }), line('Cellar', { floor: 'basement', row: 9 })];
    expect(arrange(rows).map((r) => [r.name, r.floor, r.row])).toEqual([['Cellar', 'basement', 1], ['Hall', 'ground', 1], ['Lounge', 'ground', 2], ['Kitchen', 'ground', 2], ['Bed 1', 'first', 1]]);
    expect(arrange(rows)[0]).not.toHaveProperty('order');
  });

  it('reads each line’s sizes in its own unit, and leaves out lines with nothing typed', () => {
    const rooms = rowsToRooms([
      line('Kitchen', { width: '3.2', length: '3' }), line(''), line('Bed 1', { floor: 'first', width: '13\'9"', length: '12', unit: 'ft' }),
      line('Diner', { width: '4200mm', length: 'about 4m' }), line('Utility'), line('', { width: '2', length: 'two' }),
    ]);
    expect(rooms.map((r) => [r.name, r.floor, r.width, r.length, r.row, r.order])).toEqual([
      ['Kitchen', 'ground', 3.2, 3, 1, 1], ['Diner', 'ground', 4.2, 4, 1, 2], ['Utility', 'ground', null, null, 1, 3], ['', 'ground', 2, null, 1, 4], ['Bed 1', 'first', 4.191, 3.6576, 1, 1],
    ]);
    expect(planTotals(rooms)).toMatchObject({ rooms: 5, measured: 3, m2: 41.7 }); // 9.6 + 16.8 + 15.3
    expect(isBlank(line(''))).toBe(true);
    expect(isBlank(line('', { length: ' 3 ' }))).toBe(false);
    expect(blankRow(line('Bed 1', { floor: 'first', row: 2, unit: 'ft' }))).toMatchObject({ name: '', floor: 'first', row: 2, unit: 'ft', width: '', length: '' });
  });

  it('says what is wrong with a size in plain words', () => {
    expect(sizeProblem('', 'm')).toBeNull();
    expect(sizeProblem('4.2', 'm')).toBeNull();
    expect(sizeProblem('13\'9"', 'm')).toBeNull();
    expect(sizeProblem('big', 'm')).toBe('Enter a size such as 4.2 or 4200mm.');
    expect(sizeProblem('big', 'ft')).toBe('Enter a size such as 13\'9" or 13.5.');
    expect(sizeProblem('250', 'm')).toBeNull(); // 250 cm
    expect(sizeProblem('0.05', 'm')).toBe('Enter a size between 0.1 m and 100 m.');
    expect(sizeProblem('350ft', 'ft')).toBe('Enter a size between 0.1 m and 100 m.');
  });

  it('only takes well-formed rooms back from storage, and names downloads after the plan', () => {
    expect(storedRooms(null)).toBeNull();
    expect(storedRooms('rooms')).toBeNull();
    expect(storedRooms([])).toBeNull();
    expect(storedRooms([{ name: 'No floor' }, null, 7])).toBeNull();
    expect(storedRooms([{ id: 'a', name: 'Kitchen', floor: 'ground', width: 3.2, length: 3, row: 5, order: 2 }, { name: 'Odd', floor: 'first', width: '3', length: Number.NaN, row: 'x' }, { floor: 'moon' }])).toEqual([
      { id: 'a', name: 'Kitchen', floor: 'ground', width: 3.2, length: 3, row: 1, order: 1 }, { id: 'k1', name: 'Odd', floor: 'first', width: null, length: null, row: 1, order: 1 },
    ]);
    expect(planFileName('')).toBe('floor-plan');
    expect(planFileName(' 12 Example Road, E17! ')).toBe('floor-plan-12-example-road-e17');
    expect(planFileName('../../etc/passwd')).toBe('floor-plan-etc-passwd');
  });
});

describe('a floor plan on a listing', () => {
  const dto = (photos: ListingDTO['photos'], epc: string | null = 'D'): ListingDTO => ({
    ref: 'sk-abc1234', status: 'live', channel: 'sale', title: 'A home', addressLine: 'Elm Road', town: 'London', postcode: 'E17', district: 'E17', lat: null, lng: null, type: 'terraced',
    tenure: 'freehold', leaseYears: null, beds: 3, baths: 1, floorArea: 92, era: null, condition: null, price: 525000, priceQualifier: null, epc, councilTax: 'C', serviceChargeAnnual: null,
    groundRentAnnual: null, features: [], description: null, photos, source: { kind: 'owner', name: 'Private seller', verified: false }, ownershipVerified: false,
    createdAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', mine: false,
  });

  it('is told apart from the photos by its caption and shown as the floor plan, not in the gallery', () => {
    const p = dtoToProperty(dto([
      { id: '1', url: '/media/a.jpg', alt: 'Front of the house' }, { id: '2', url: '/media/old-plan.png', alt: 'Floor plan' },
      { id: '3', url: '/media/b.jpg', alt: null }, { id: '4', url: '/media/plan.png', alt: planCaption(HOUSE) },
    ]));
    expect(p.photos).toEqual(['/media/a.jpg', '/media/b.jpg']);
    expect(p.floorPlan).toEqual({ url: '/media/plan.png', alt: planCaption(HOUSE) }); // the newest one
    expect(p.documents).toEqual(['EPC (stated)', 'Floor plan']);
    expect(dtoToProperty(dto([{ id: '4', url: '/media/plan.png', alt: 'Floor plan' }], null)).documents).toEqual(['EPC (not yet provided)', 'Floor plan']);
  });

  it('leaves listings without one as they were', () => {
    const p = dtoToProperty(dto([{ id: '1', url: '/media/a.jpg', alt: 'Kitchen with a tiled floor' }]));
    expect(p.photos).toEqual(['/media/a.jpg']);
    expect(p.floorPlan).toBeUndefined();
    expect(p.documents).toEqual(['EPC (stated)', 'Floor plan (requested)']);
  });
});
