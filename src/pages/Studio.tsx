import { Fragment, useMemo, useRef, useState } from 'react';
import { RATE_LIBRARY, REGIONS, regionFromPostcode } from '../engine/refurb';
import { getProperty, PROPERTIES } from '../data/properties';
import { useSearchParams } from 'react-router-dom';
import { gbp, gbpK, Section, Seg, Tag } from '../components/ui';

type Room = 'kitchen' | 'bathroom' | 'living';
interface Style { id: string; name: string; wall: string; cab: string; top: string; floor: string; accent: string; note: string }
const STYLES: Style[] = [
  { id: 'contemporary', name: 'Contemporary', wall: '#ecebe7', cab: '#2f3a40', top: '#f4f2ee', floor: '#b89a78', accent: '#c9a45c', note: 'Handleless slab doors, quartz, warm oak' },
  { id: 'scandi', name: 'Scandinavian', wall: '#f5f3ee', cab: '#e9e4da', top: '#d8c7aa', floor: '#d9c19b', accent: '#7c8f7a', note: 'Pale ash, matte whites, sage accents' },
  { id: 'heritage', name: 'Heritage Shaker', wall: '#e5e0d2', cab: '#3f5a4c', top: '#e8e3d8', floor: '#8c6a4c', accent: '#b0894a', note: 'In-frame shaker, brass, encaustic tiles' },
  { id: 'industrial', name: 'Urban industrial', wall: '#cfcac2', cab: '#22252a', top: '#8d8f90', floor: '#6f6a64', accent: '#b4462a', note: 'Black steel, concrete-effect, exposed brick' },
  { id: 'japandi', name: 'Japandi', wall: '#ebe5da', cab: '#9b7d5f', top: '#e9e2d6', floor: '#c7ad8a', accent: '#3a3a36', note: 'Walnut, limewash, low-contrast calm' },
];
const FINISHES = {
  worktop: [{ id: 'lam', name: 'Laminate', delta: -0.12 }, { id: 'quartz', name: 'Quartz 20mm', delta: 0 }, { id: 'stone', name: 'Natural stone', delta: 0.18 }],
  cabinet: [{ id: 'flat', name: 'Flat-pack rigid', delta: -0.2 }, { id: 'mid', name: 'Mid-range rigid', delta: 0 }, { id: 'bespoke', name: 'Bespoke in-frame', delta: 0.55 }],
  floor: [{ id: 'vinyl', name: 'Sheet vinyl', delta: -0.05 }, { id: 'lvt', name: 'LVT herringbone', delta: 0 }, { id: 'oak', name: 'Engineered oak', delta: 0.08 }, { id: 'tile', name: 'Porcelain tile', delta: 0.06 }],
  layout: [{ id: 'keep', name: 'Keep layout', delta: 0 }, { id: 'island', name: 'Add island', delta: 0.22 }, { id: 'wall', name: 'Knock through (RSJ)', delta: 0.45 }],
};

function RoomArt({ room, s, before }: { room: Room; s: Style; before: boolean }) {
  const dated = { wall: '#e8d9b5', cab: '#b5813f', top: '#6a5c4a', floor: '#c8b796', accent: '#7a6a55' };
  const c = before ? dated : s;
  return (
    <svg viewBox="0 0 400 250" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${before ? 'Before' : 'After'} concept illustration`}>
      <rect width="400" height="250" fill={c.wall} />
      <rect x="0" y="190" width="400" height="60" fill={c.floor} />
      {!before && s.id === 'industrial' && Array.from({ length: 9 }).map((_, r) => Array.from({ length: 12 }).map((__, k) => <rect key={`${r}-${k}`} x={k * 34 + (r % 2) * 17} y={r * 14} width={32} height={12} fill="#a5644b" opacity={0.35} />))}
      <rect x="150" y="30" width="100" height="70" fill="#cfe3ee" stroke={before ? '#f6f2e6' : c.accent} strokeWidth={6} />
      {room === 'kitchen' && <>
        <rect x="20" y="130" width="360" height="60" fill={c.cab} />
        {Array.from({ length: 6 }).map((_, k) => <rect key={k} x={24 + k * 60} y={136} width={52} height={50} fill="none" stroke={before ? '#8d6532' : 'rgba(255,255,255,.18)'} strokeWidth={2} />)}
        <rect x="16" y="124" width="368" height="8" fill={c.top} />
        <rect x="20" y="30" width="110" height="60" fill={c.cab} /><rect x="270" y="30" width="110" height="60" fill={c.cab} />
        {!before && <><line x1="120" y1="0" x2="120" y2="40" stroke="#222" /><circle cx="120" cy="44" r="7" fill={c.accent} /><line x1="280" y1="0" x2="280" y2="40" stroke="#222" /><circle cx="280" cy="44" r="7" fill={c.accent} /></>}
      </>}
      {room === 'bathroom' && <>
        <rect x="30" y="140" width="190" height="50" rx={before ? 4 : 18} fill={before ? '#f0ece2' : '#fbfbf8'} stroke="#ccc" />
        <rect x="270" y="110" width="80" height="40" fill={c.cab} /><ellipse cx="310" cy="112" rx="28" ry="7" fill="#fff" />
        {!before && <rect x="20" y="60" width="210" height="80" fill="none" stroke={c.accent} strokeWidth={3} opacity={0.6} />}
        {!before && Array.from({ length: 10 }).map((_, k) => <line key={k} x1={20 + k * 21} y1={60} x2={20 + k * 21} y2={140} stroke={c.accent} opacity={0.15} />)}
      </>}
      {room === 'living' && <>
        <rect x="40" y="140" width="200" height="45" rx={10} fill={c.cab} /><rect x="50" y="120" width="180" height="30" rx={10} fill={c.cab} opacity={0.85} />
        <rect x="280" y="80" width="60" height="110" fill="none" stroke={c.accent} strokeWidth={4} />
        <circle cx="330" cy="70" r="18" fill={c.accent} opacity={0.4} />
        <rect x="120" y="195" width="200" height="30" rx={4} fill={c.accent} opacity={before ? 0.2 : 0.35} />
      </>}
      <text x="12" y="240" fontSize="11" fill="#000" opacity="0.45" fontFamily="sans-serif">{before ? 'BEFORE' : 'CONCEPT'} · illustrative</text>
    </svg>
  );
}

export default function Studio() {
  const [params] = useSearchParams();
  const prop = getProperty(params.get('property') ?? '') ?? PROPERTIES[0];
  const [room, setRoom] = useState<Room>('kitchen');
  const [styleId, setStyleId] = useState('heritage');
  const [sel, setSel] = useState({ worktop: 'quartz', cabinet: 'mid', floor: 'lvt', layout: 'keep' });
  const [pos, setPos] = useState(50);
  const [photo, setPhoto] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const style = STYLES.find((s) => s.id === styleId)!;
  const region = regionFromPostcode(prop.postcode) ?? 'south-west';
  const factor = REGIONS[region].factor;

  const budget = useMemo(() => {
    const base = (room === 'kitchen' ? RATE_LIBRARY.KITCHEN.rate : room === 'bathroom' ? RATE_LIBRARY.BATHROOM.rate : RATE_LIBRARY.FLOOR.rate * 20 + RATE_LIBRARY.DECOR.rate * 70) * factor * 1.12 * 1.12 * 1.2;
    const lines = (Object.keys(sel) as (keyof typeof sel)[]).filter((k) => room === 'kitchen' || k === 'floor').map((k) => {
      const opt = FINISHES[k].find((o) => o.id === sel[k])!;
      return { group: k, name: opt.name, delta: base * opt.delta };
    });
    const premium = styleId === 'heritage' ? 0.08 : styleId === 'japandi' ? 0.05 : 0;
    const total = base * (1 + premium) + lines.reduce((s, l) => s + l.delta, 0);
    return { base, lines, premium: base * premium, total };
  }, [room, sel, styleId, factor]);

  const drag = (clientX: number) => { const r = ref.current?.getBoundingClientRect(); if (r) setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100))); };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI design studio</div><h2 style={{ marginTop: 6 }}>Renovation visualiser</h2>
          <p className="muted" style={{ marginTop: 6 }}>Explore styles and finishes with live cost deltas from the pricing engine for {prop.town} ({REGIONS[region].label} ×{factor}).</p></div>
        <div className="row"><Tag kind="warn">Conceptual visualisation — not a construction design</Tag><Tag kind="live">Photo-real generation: image model API</Tag></div>
      </div>
      <div className="split-r">
        <div className="stack" style={{ gap: 14 }}>
          <div className="row between">
            <Seg value={room} onChange={setRoom} options={[{ value: 'kitchen', label: 'Kitchen' }, { value: 'bathroom', label: 'Bathroom' }, { value: 'living', label: 'Living room' }]} />
            <label className="btn ghost sm" style={{ cursor: 'pointer' }}><input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhoto(URL.createObjectURL(f)); }} />Upload your photo</label>
          </div>
          <div ref={ref} className="ba card" style={{ padding: 0 }} onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag(e.clientX); }} onPointerMove={(e) => e.buttons && drag(e.clientX)}>
            <div>{photo ? <img src={photo} alt="Your upload" style={{ width: '100%', height: '100%', objectFit: 'cover', filter: `saturate(1.05) contrast(1.02)` }} /> : <RoomArt room={room} s={style} before={false} />}
              {photo && <div style={{ position: 'absolute', inset: 0, background: style.cab, mixBlendMode: 'color', opacity: 0.45 }} />}</div>
            <div style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>{photo ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <RoomArt room={room} s={style} before />}</div>
            <div className="handle" style={{ left: `${pos}%` }} />
          </div>
          {photo && <p className="xs muted">Your photo stays in the browser. The “after” is a colour-grade preview only; production sends the photo (with consent) to an image-editing model with structure guidance and returns concepts tagged as AI-generated.</p>}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {STYLES.map((s) => (
              <button key={s.id} className="card flat" onClick={() => setStyleId(s.id)} style={{ textAlign: 'left', padding: 10, cursor: 'pointer', borderColor: s.id === styleId ? 'var(--ink)' : undefined, borderWidth: s.id === styleId ? 2 : 1 }}>
                <div className="grid g4" style={{ gap: 4, gridTemplateColumns: 'repeat(4, 1fr)' }}>{[s.wall, s.cab, s.top, s.accent].map((c) => <div key={c} className="swatch" style={{ background: c }} />)}</div>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 6 }}>{s.name}</div>
                <div className="xs muted">{s.note}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="stack sticky" style={{ gap: 14 }}>
          <Section title="Finishes" kicker="Specification">
            {(Object.keys(FINISHES) as (keyof typeof FINISHES)[]).filter((k) => room === 'kitchen' || k === 'floor').map((k) => (
              <div key={k} style={{ marginBottom: 10 }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>{k}</div>
                <Seg value={sel[k]} onChange={(v) => setSel((s) => ({ ...s, [k]: v }))} options={FINISHES[k].map((o) => ({ value: o.id, label: o.name }))} />
              </div>
            ))}
          </Section>
          <Section title="Interactive budget" kicker="Live from engine" right={<Tag kind="est" />}>
            <dl className="kv">
              <dt>Base {room} ({prop.town.split(',')[0]})</dt><dd className="num">{gbp(budget.base)}</dd>
              {budget.premium > 0 && <><dt>{style.name} detailing</dt><dd className="num">+{gbp(budget.premium)}</dd></>}
              {budget.lines.map((l) => <Fragment key={l.group}><dt>{l.name}</dt><dd className={`num ${l.delta > 0 ? 'neg' : l.delta < 0 ? 'pos' : ''}`}>{l.delta === 0 ? '—' : `${l.delta > 0 ? '+' : '−'}${gbp(Math.abs(l.delta))}`}</dd></Fragment>)}
            </dl>
            <div className="hr" />
            <div className="row between"><span className="muted small">Concept total incl. on-costs & VAT</span><span className="num" style={{ fontSize: 24 }}>{gbpK(budget.total)}</span></div>
            {sel.layout === 'wall' && <div className="callout" style={{ marginTop: 10 }}>Removing a wall needs a structural engineer’s calculations and Building Control approval. Price confirmed only after survey.</div>}
          </Section>
        </div>
      </div>
    </div>
  );
}
