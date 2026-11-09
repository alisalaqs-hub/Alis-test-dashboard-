import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Callouts for the journey street, drawn like annotations on an architect's
 * elevation: a hairline leader rises from a point on the drawing to a small
 * frosted label (small-caps title, tabular figures).
 *
 * They are HTML laid over the SVG so the text stays at a real, readable size on
 * every screen. Placement runs in screen px: labels stay inside the scene, clear
 * of the search panel and the journey bar and of each other; a label that can't
 * be placed is hidden rather than overlapping.
 */
export type NoteSpec = {
  id: string;
  on: boolean;
  /** Anchor point(s) in drawing units. Two anchors draw a bracket. */
  at: [number, number][];
  title: string;
  /** Shorter title for the phone band. */
  short?: string;
  value?: string;
  rows?: [string, string][];
  accent?: boolean;
  /** The locator dot already marks the anchor. */
  dot?: boolean;
  d?: number;
};
export type Box = { x: number; y: number; w: number; h: number };
/** Screen mapping of the drawing (preserveAspectRatio xMidYMax slice). `clear` = px from a ridge anchor to clear the chimney pots. */
export type View = { w: number; h: number; sc: number; ox: number; oy: number; vbx: number; vby: number; clear: number };

type Pt = { x: number; y: number };
type Placed = { spec: NoteSpec; hidden: boolean; A: Pt[]; sx: number; base: number; bar?: number; cx: number; cy: number; cw: number; ch: number; side: 'r' | 'l' | 'c' };

const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const EDGE = 6;

function estimate(s: NoteSpec): [number, number] {
  const t = s.title.length * 7 + 24, v = (s.value?.length ?? 0) * 9 + 24;
  const r = Math.max(0, ...(s.rows ?? []).map(([k, x]) => (k.length + x.length) * 6.6 + 44));
  return [Math.max(t, v, r), 44 + (s.rows?.length ?? 0) * 18];
}

function place(specs: NoteSpec[], sizes: Record<string, [number, number]>, v: View, obs: Box[], solo = false, gap = 6): Placed[] {
  const px = (u: number) => v.ox + (u - v.vbx) * v.sc, py = (u: number) => v.oy + (u - v.vby) * v.sc;
  const taken: Box[] = [];
  const order = specs.map((s, n) => ({ s, n })).sort((a, b) => Number(b.s.on) - Number(a.s.on) || Number(!!b.s.accent) - Number(!!a.s.accent) || a.n - b.n);
  const out: Placed[] = new Array(specs.length);
  for (const { s, n } of order) {
    const [cw, ch] = sizes[s.id] ?? estimate(s);
    const A = s.at.map(([x, y]) => ({ x: px(x), y: py(y) }));
    const multi = A.length > 1;
    const xs = A.map((a) => a.x);
    const bar = multi ? Math.min(...A.map((a) => a.y)) - v.clear * 0.62 : undefined;
    const sx = multi ? (Math.min(...xs) + Math.max(...xs)) / 2 : A[0].x;
    const base = multi ? bar! : A[0].y - (s.dot ? 8 * v.sc + 2 : 4);
    const seen = A.every((a) => a.x > EDGE && a.x < v.w - EDGE && a.y > EDGE && a.y < v.h - EDGE && !obs.some((o) => hit({ x: a.x, y: a.y, w: 0, h: 0 }, o, 6)));
    const c0 = multi ? v.clear * 0.45 : v.clear;
    const lifts = [c0, c0 + ch + 8, c0 + 2 * (ch + 8), Math.min(c0, 12)];
    const sides: ('r' | 'l')[] = sx + cw > v.w - EDGE ? ['l', 'r'] : ['r', 'l'];
    // Straight leaders first (raising the label if it must); then dog-legs, where the
    // label slides sideways along a short horizontal shoulder to clear a panel.
    const offs = [1, 2, 3, 4, 5, 6, 8, 10].flatMap((k) => [-k * 34, k * 34]);
    const cands: [number, 'r' | 'l', number][] = [
      ...lifts.flatMap((L) => sides.map((side) => [L, side, 0] as [number, 'r' | 'l', number])),
      ...lifts.slice(0, 2).flatMap((L) => offs.flatMap((o) => sides.map((side) => [L, side, o] as [number, 'r' | 'l', number]))),
    ];
    let best: Placed | null = null;
    if (seen) {
      for (const [L, side, off] of cands) {
        const cx = (side === 'r' ? sx - 0.5 : sx - cw + 0.5) + off, cy = base - L - ch;
        const card = { x: cx, y: cy, w: cw, h: ch }, stem = { x: sx - 1, y: cy + ch, w: 2, h: L };
        const sh = { x: Math.min(sx, cx + cw), y: cy + ch - 1, w: Math.max(0, cx - sx, sx - cx - cw), h: 2 };
        const ok = cx >= EDGE && cx + cw <= v.w - EDGE && cy >= EDGE
          && !obs.some((o) => hit(card, o, 10) || hit(stem, o, 4) || hit(sh, o, 4))
          && (solo || !s.on || !taken.some((t) => hit(card, t, gap) || hit(stem, t, 2) || hit(sh, t, 2)));
        if (ok) {
          const where = cx + cw < sx + 1 ? 'l' : cx > sx - 1 ? 'r' : 'c';
          best = { spec: s, hidden: false, A, sx, base, bar, cx, cy, cw, ch, side: where };
          break;
        }
      }
    }
    if (!best) best = { spec: s, hidden: true, A, sx, base, bar, cx: sx, cy: base - c0 - ch, cw, ch, side: 'r' };
    if (s.on && !best.hidden) taken.push({ x: best.cx, y: best.cy, w: cw, h: ch });
    out[n] = best;
  }
  return out;
}

export function JourneyNotes({ specs, hover, view, obs, compact = false }: { specs: NoteSpec[]; hover: NoteSpec | null; view: View; obs: Box[]; compact?: boolean }) {
  const cards = useRef(new Map<string, HTMLDivElement>());
  const [sizes, setSizes] = useState<Record<string, [number, number]>>({});
  const [, setFonts] = useState(0);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => { if (live) setFonts((t) => t + 1); });
    return () => { live = false; };
  }, []);
  // Measure the labels as rendered (exact widths with the real font), then place them.
  useLayoutEffect(() => {
    let changed = false;
    const next = { ...sizes };
    cards.current.forEach((el, id) => {
      const w = el.offsetWidth, h = el.offsetHeight, p = next[id];
      if (w && (!p || Math.abs(p[0] - w) > 0.5 || Math.abs(p[1] - h) > 0.5)) { next[id] = [w, h]; changed = true; }
    });
    if (changed) setSizes(next);
  });
  if (!view.w || !view.h) return null;
  // Narrow houses on screen (phone band, tablet): shorter titles, tighter packing.
  const tight = compact || view.sc < 0.62;
  const placed = place(specs, sizes, view, obs, false, tight ? 3 : 8);
  const hov = hover ? place([hover], sizes, view, obs, true)[0] : null;
  const reg = (id: string) => (el: HTMLDivElement | null) => { if (el) cards.current.set(id, el); else cards.current.delete(id); };
  return (
    <div className="j-notes" aria-hidden="true">
      {placed.map((p) => <Note key={p.spec.id} p={p} reg={reg(p.spec.id)} compact={tight} />)}
      {hov && <Note key="hover" p={hov} reg={reg(hov.spec.id)} compact={tight} hover />}
    </div>
  );
}

function Note({ p, reg, compact, hover = false }: { p: Placed; reg: (el: HTMLDivElement | null) => void; compact: boolean; hover?: boolean }) {
  const s = p.spec;
  const on = s.on && !p.hidden;
  const xs = p.A.map((a) => a.x);
  const bottom = p.cy + p.ch;
  return (
    <div className={`j-note${on ? ' on' : ''}${s.accent ? ' accent' : ''}${hover ? ' is-hover' : ''}`} style={{ ['--d' as string]: s.d ?? 0 } as CSSProperties}>
      {p.bar != null && p.A.map((a, n) => <i key={`t${n}`} className="j-tick" style={{ left: a.x, top: p.bar, height: Math.max(0, a.y - 4 - p.bar!) }} />)}
      {p.bar != null && <i className="j-bar" style={{ left: Math.min(...xs), top: p.bar, width: Math.max(...xs) - Math.min(...xs) }} />}
      <i className="j-stem" style={{ left: p.sx, top: bottom, height: Math.max(0, p.base - bottom) }} />
      {(p.cx > p.sx + 1 || p.cx + p.cw < p.sx - 1) && <i className={`j-bar j-shoulder${p.cx > p.sx ? '' : ' to-l'}`} style={{ left: Math.min(p.sx, p.cx + p.cw), top: bottom, width: Math.max(p.cx - p.sx, p.sx - p.cx - p.cw) }} />}
      {!s.dot && p.A.map((a, n) => <i key={`p${n}`} className="j-pin" style={{ left: a.x, top: a.y }} />)}
      <div ref={reg} className={`j-card j-${p.side}`} style={{ left: p.cx, top: p.cy }}>
        <small>{compact && s.short ? s.short : s.title}</small>
        {s.value && <b>{s.value}</b>}
        {s.rows && <dl>{s.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      </div>
    </div>
  );
}
