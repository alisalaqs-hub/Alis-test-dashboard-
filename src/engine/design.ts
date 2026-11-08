/**
 * Design-to-cost engine for the AI Interior Design Studio.
 * Every concept resolves to a material schedule (quantity × material rate +
 * labour rate, regionalised) so a design can be costed, budget-fitted, sent
 * for quotes and fed into the investment analyser.
 *
 * Rates: BRIXO demonstration catalogue (national average, ex VAT). Not
 * supplier prices; production links to supplier feeds and verified quotes.
 */
import { REGIONS, regionFromPostcode } from './refurb';

export type RoomType = 'kitchen' | 'bathroom' | 'living' | 'bedroom';
export type Tier = 'budget' | 'standard' | 'premium' | 'luxury';
export const TIERS: Tier[] = ['budget', 'standard', 'premium', 'luxury'];

export interface Style { id: string; name: string; tier: Tier; palette: { wall: string; cab: string; top: string; floor: string; accent: string }; note: string }
export const STYLES: Style[] = [
  { id: 'modern', name: 'Modern', tier: 'standard', palette: { wall: '#eeeeea', cab: '#2b2f36', top: '#f3f3f0', floor: '#a88f74', accent: '#c9a45c' }, note: 'Clean lines, handleless, warm oak' },
  { id: 'contemporary', name: 'Contemporary', tier: 'standard', palette: { wall: '#ecebe7', cab: '#5b6670', top: '#f4f2ee', floor: '#b89a78', accent: '#b4462a' }, note: 'Current finishes, mixed textures' },
  { id: 'luxury', name: 'Luxury', tier: 'luxury', palette: { wall: '#e6e1d8', cab: '#1d2a26', top: '#f1ece4', floor: '#6f523a', accent: '#c8a24a' }, note: 'Stone, brass, bespoke joinery' },
  { id: 'scandi', name: 'Scandinavian', tier: 'standard', palette: { wall: '#f5f3ee', cab: '#e9e4da', top: '#d8c7aa', floor: '#d9c19b', accent: '#7c8f7a' }, note: 'Pale ash, matte whites, sage' },
  { id: 'minimal', name: 'Minimalist', tier: 'premium', palette: { wall: '#f4f4f2', cab: '#f0efeb', top: '#e2e0db', floor: '#cfc7bb', accent: '#2a2a2a' }, note: 'Reduced, seamless, hidden storage' },
  { id: 'traditional', name: 'Traditional', tier: 'premium', palette: { wall: '#e5e0d2', cab: '#3f5a4c', top: '#e8e3d8', floor: '#8c6a4c', accent: '#b0894a' }, note: 'Shaker, period detail, brass' },
  { id: 'industrial', name: 'Industrial', tier: 'standard', palette: { wall: '#cfcac2', cab: '#22252a', top: '#8d8f90', floor: '#6f6a64', accent: '#b4462a' }, note: 'Black steel, concrete-effect, brick' },
  { id: 'rental', name: 'Budget rental', tier: 'budget', palette: { wall: '#f2f1ec', cab: '#ffffff', top: '#b8b2a7', floor: '#9c948a', accent: '#5b6670' }, note: 'Durable, neutral, easy to maintain' },
  { id: 'investment', name: 'High-end investment', tier: 'premium', palette: { wall: '#efede8', cab: '#3a4450', top: '#f2f0ec', floor: '#a48b70', accent: '#c9a45c' }, note: 'Finishes that lift rent/value per £' },
];

/** Catalogue: per-tier material rate and labour rate for each line. */
interface CatItem { code: string; name: string; unit: 'm²' | 'lm' | 'nr' | 'item'; group: string; rooms: RoomType[]; qty: (d: Dims) => number; mat: Record<Tier, number>; lab: Record<Tier, number>; options?: Record<Tier, string> }
export interface Dims { width: number; length: number; height: number }
const floorA = (d: Dims) => d.width * d.length;
const wallA = (d: Dims) => 2 * (d.width + d.length) * d.height * 0.8;
const T = (b: number, s: number, p: number, l: number): Record<Tier, number> => ({ budget: b, standard: s, premium: p, luxury: l });

const CATALOGUE: CatItem[] = [
  { code: 'K-UNITS', name: 'Kitchen units (base + wall)', unit: 'lm', group: 'Cabinetry', rooms: ['kitchen'], qty: (d) => Math.max(3, Math.round((d.width + d.length) * 0.8 * 10) / 10), mat: T(260, 520, 980, 1900), lab: T(90, 130, 170, 240), options: { budget: 'Flat-pack gloss', standard: 'Rigid matt slab', premium: 'Painted shaker', luxury: 'Bespoke in-frame' } },
  { code: 'K-TOP', name: 'Worktop', unit: 'lm', group: 'Worktops', rooms: ['kitchen'], qty: (d) => Math.max(3, Math.round((d.width + d.length) * 0.8 * 10) / 10), mat: T(70, 260, 520, 900), lab: T(30, 60, 90, 120), options: { budget: 'Laminate', standard: 'Quartz 20mm', premium: 'Quartz 30mm', luxury: 'Natural stone' } },
  { code: 'K-APP', name: 'Appliance package', unit: 'item', group: 'Appliances', rooms: ['kitchen'], qty: () => 1, mat: T(1200, 2600, 4800, 9500), lab: T(150, 250, 300, 400), options: { budget: 'Freestanding basic', standard: 'Integrated mid-range', premium: 'Integrated premium', luxury: 'Professional range' } },
  { code: 'K-SPL', name: 'Splashback / wall tiles', unit: 'm²', group: 'Tiling', rooms: ['kitchen'], qty: (d) => Math.round((d.width + d.length) * 0.8 * 0.6 * 10) / 10, mat: T(18, 40, 85, 160), lab: T(35, 45, 55, 70), options: { budget: 'White ceramic', standard: 'Metro tile', premium: 'Zellige-effect', luxury: 'Stone slab' } },
  { code: 'B-SAN', name: 'Sanitaryware (WC, basin, bath/shower)', unit: 'item', group: 'Fittings', rooms: ['bathroom'], qty: () => 1, mat: T(650, 1500, 3200, 6800), lab: T(700, 900, 1100, 1500), options: { budget: 'Value suite', standard: 'Mid-range + thermostatic shower', premium: 'Walk-in shower, wall-hung', luxury: 'Freestanding bath, brassware' } },
  { code: 'B-WALL', name: 'Wall tiles', unit: 'm²', group: 'Tiling', rooms: ['bathroom'], qty: (d) => Math.round(wallA(d) * 0.7 * 10) / 10, mat: T(18, 38, 75, 150), lab: T(38, 48, 60, 75), options: { budget: 'White ceramic', standard: 'Porcelain', premium: 'Large-format porcelain', luxury: 'Marble' } },
  { code: 'B-VAN', name: 'Vanity & storage', unit: 'item', group: 'Fittings', rooms: ['bathroom'], qty: () => 1, mat: T(120, 380, 900, 2200), lab: T(80, 100, 140, 180) },
  { code: 'B-EXT', name: 'Extractor fan & ducting (Part F)', unit: 'nr', group: 'Services', rooms: ['bathroom', 'kitchen'], qty: () => 1, mat: T(60, 120, 220, 380), lab: T(140, 160, 180, 220) },
  { code: 'FLOOR', name: 'Flooring', unit: 'm²', group: 'Flooring', rooms: ['kitchen', 'bathroom', 'living', 'bedroom'], qty: (d) => Math.round(floorA(d) * 1.08 * 10) / 10, mat: T(14, 32, 65, 120), lab: T(12, 18, 25, 35), options: { budget: 'Laminate / vinyl', standard: 'LVT', premium: 'Engineered oak', luxury: 'Herringbone oak / stone' } },
  { code: 'PAINT', name: 'Walls & ceiling decoration', unit: 'm²', group: 'Decoration', rooms: ['kitchen', 'bathroom', 'living', 'bedroom'], qty: (d) => Math.round((wallA(d) + floorA(d)) * 10) / 10, mat: T(1.5, 2.5, 4.5, 8), lab: T(7, 9, 11, 14), options: { budget: 'Trade emulsion', standard: 'Durable matt', premium: 'Premium chalky matt', luxury: 'Specialist / limewash' } },
  { code: 'LIGHT', name: 'Lighting (points incl. fittings)', unit: 'nr', group: 'Lighting', rooms: ['kitchen', 'bathroom', 'living', 'bedroom'], qty: (d) => Math.max(2, Math.round(floorA(d) / 3)), mat: T(18, 45, 110, 260), lab: T(45, 55, 65, 85), options: { budget: 'Basic downlights', standard: 'LED downlights + pendant', premium: 'Layered, dimmable', luxury: 'Designer + scene control' } },
  { code: 'DOOR', name: 'Internal door & ironmongery', unit: 'nr', group: 'Joinery', rooms: ['living', 'bedroom'], qty: () => 1, mat: T(60, 140, 320, 650), lab: T(90, 110, 130, 160) },
  { code: 'WARD', name: 'Fitted wardrobe', unit: 'lm', group: 'Joinery', rooms: ['bedroom'], qty: (d) => Math.min(d.width, 2.4), mat: T(0, 380, 750, 1400), lab: T(0, 120, 160, 220) },
  { code: 'STAGE', name: 'Furniture & styling allowance', unit: 'item', group: 'Furniture', rooms: ['living', 'bedroom'], qty: () => 1, mat: T(900, 2200, 4500, 9000), lab: T(0, 0, 0, 0) },
];

export interface ScheduleLine { code: string; group: string; name: string; spec: string; qty: number; unit: string; materials: number; labour: number; total: number }
export interface DesignCost { lines: ScheduleLine[]; materials: number; labour: number; prelimsOhp: number; contingency: number; vat: number; total: number; regionLabel: string; regionFactor: number; weeks: number }

export function designCost(room: RoomType, tier: Tier, dims: Dims, postcode: string, opts: { furniture?: boolean; overrides?: Partial<Record<string, Tier>> } = {}): DesignCost {
  const region = regionFromPostcode(postcode) ?? 'south-west';
  const rf = REGIONS[region].factor;
  const lines = CATALOGUE.filter((c) => c.rooms.includes(room) && (c.code !== 'STAGE' || opts.furniture)).map((c) => {
    const t = opts.overrides?.[c.code] ?? tier;
    const qty = c.qty(dims);
    const materials = Math.round(qty * c.mat[t]);
    const labour = Math.round(qty * c.lab[t] * rf); // labour regionalised; materials broadly national
    return { code: c.code, group: c.group, name: c.name, spec: c.options?.[t] ?? t, qty, unit: c.unit, materials, labour, total: materials + labour };
  }).filter((l) => l.total > 0);
  const materials = lines.reduce((s, l) => s + l.materials, 0);
  const labour = lines.reduce((s, l) => s + l.labour, 0);
  const prelimsOhp = Math.round((materials + labour) * 0.18);
  const contingency = Math.round((materials + labour + prelimsOhp) * 0.08);
  const vat = Math.round((materials + labour + prelimsOhp + contingency) * 0.2);
  const total = materials + labour + prelimsOhp + contingency + vat;
  return { lines, materials, labour, prelimsOhp, contingency, vat, total, regionLabel: REGIONS[region].label, regionFactor: rf, weeks: room === 'kitchen' ? (tier === 'luxury' ? 5 : 3) : room === 'bathroom' ? 2 : 1 };
}

/** Pick the best style/tier package that fits a budget (inc. VAT). */
export function fitBudget(room: RoomType, budget: number, dims: Dims, postcode: string, furniture = false) {
  const options = STYLES.map((s) => ({ style: s, cost: designCost(room, s.tier, dims, postcode, { furniture }) }));
  const fits = options.filter((o) => o.cost.total <= budget).sort((a, b) => b.cost.total - a.cost.total);
  const cheapest = [...options].sort((a, b) => a.cost.total - b.cost.total)[0];
  return { fits, best: fits[0] ?? null, cheapest, headroom: fits[0] ? budget - fits[0].cost.total : budget - cheapest.cost.total };
}

/** Parse "Redesign this living room for £5,000" style requests. */
export function parseDesignBrief(text: string): { room?: RoomType; budget?: number; style?: string } {
  const t = text.toLowerCase();
  const room = /kitchen/.test(t) ? 'kitchen' : /bath|shower/.test(t) ? 'bathroom' : /bed/.test(t) ? 'bedroom' : /living|lounge|reception|flat/.test(t) ? 'living' : undefined;
  const m = t.match(/£\s?([\d,.]+)\s?(k)?/);
  const budget = m ? parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1) : undefined;
  const style = STYLES.find((s) => t.includes(s.name.toLowerCase()) || (s.id === 'luxury' && /luxur/.test(t)) || (s.id === 'rental' && /rental|let/.test(t)))?.id;
  return { room, budget, style };
}

/* ---------- Layout planner ---------- */
export interface Placed { name: string; x: number; y: number; w: number; d: number }
const FURNITURE: Record<RoomType, { name: string; w: number; d: number; wall: 'long' | 'short' | 'centre' | 'corner' }[]> = {
  living: [{ name: 'Sofa (3-seat)', w: 2.1, d: 0.9, wall: 'long' }, { name: 'Media unit', w: 1.6, d: 0.45, wall: 'long' }, { name: 'Armchair', w: 0.85, d: 0.85, wall: 'corner' }, { name: 'Coffee table', w: 1.1, d: 0.6, wall: 'centre' }],
  bedroom: [{ name: 'Double bed', w: 1.5, d: 2.0, wall: 'short' }, { name: 'Wardrobe', w: 1.8, d: 0.6, wall: 'long' }, { name: 'Bedside', w: 0.45, d: 0.4, wall: 'short' }, { name: 'Desk', w: 1.0, d: 0.5, wall: 'corner' }],
  kitchen: [{ name: 'Run of units', w: 3.0, d: 0.6, wall: 'long' }, { name: 'Dining table (4)', w: 1.2, d: 0.8, wall: 'centre' }, { name: 'Tall housing', w: 0.6, d: 0.6, wall: 'corner' }],
  bathroom: [{ name: 'Bath / shower', w: 1.7, d: 0.75, wall: 'long' }, { name: 'WC', w: 0.4, d: 0.65, wall: 'short' }, { name: 'Vanity', w: 0.6, d: 0.45, wall: 'short' }],
};

export function planLayout(room: RoomType, dims: Dims) {
  const W = Math.max(dims.width, dims.length), L = Math.min(dims.width, dims.length);
  const placed: Placed[] = []; const notes: string[] = [];
  let longX = 0.1, shortY = 0.1;
  for (const f of FURNITURE[room]) {
    if (f.wall === 'long') { if (longX + f.w > W - 0.1) { notes.push(`${f.name} does not fit along the longest wall (${W.toFixed(1)}m)`); continue; } placed.push({ name: f.name, x: longX, y: placed.some((p) => p.y === 0.05) ? L - f.d - 0.05 : 0.05, w: f.w, d: f.d }); longX += f.w + 0.3; }
    else if (f.wall === 'short') { if (shortY + f.w > L - 0.1) { notes.push(`${f.name} omitted — short wall too narrow`); continue; } placed.push({ name: f.name, x: W - f.d - 0.05, y: shortY, w: f.d, d: f.w }); shortY += f.w + 0.1; }
    else if (f.wall === 'corner') placed.push({ name: f.name, x: 0.05, y: L - f.d - 0.05, w: f.w, d: f.d });
    else placed.push({ name: f.name, x: W / 2 - f.w / 2, y: L / 2 - f.d / 2, w: f.w, d: f.d });
  }
  const used = placed.reduce((s, p) => s + p.w * p.d, 0);
  const free = 1 - used / (W * L);
  if (free < 0.55) notes.push('Tight: less than 55% free floor — consider wall-hung storage or a smaller sofa/bed.');
  if (room === 'bedroom' && L < 2.9) notes.push('Room is under 2.9m deep: a double bed leaves under 0.7m walkway — consider a small double (1.2m).');
  if (room === 'kitchen' && W * L < 9) notes.push('Compact kitchen: a galley layout with tall integrated units maximises storage.');
  if (room === 'living' && W / L > 1.7) notes.push('Long, narrow room: zone it — seating at one end, dining/desk at the other.');
  notes.push('Keep ≥ 0.9m clear routes to doors and windows (Approved Document M guidance for circulation).');
  return { W, L, placed, free, notes };
}
