import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { dealScore, epcPathway, loftScenario, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { gbpK } from './ui';

/**
 * The Streetkey X-ray: drag the lens across a home to see its blueprint —
 * annotated with live engine figures. Decorative graphics are aria-hidden;
 * the same information is provided as a list for assistive technology.
 */
const W = 600, H = 420;

function HouseFront() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" aria-hidden className="xr-svg">
      <defs><pattern id="xr-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="var(--grid)" strokeWidth="1" /></pattern></defs>
      <rect width={W} height={H} fill="url(#xr-grid)" />
      <rect x="0" y="372" width={W} height="48" fill="#C9D9B8" />
      {/* neighbours */}
      <rect x="20" y="168" width="110" height="204" fill="#D9CFC4" /><polygon points="20,168 75,118 130,168" fill="#3A3F52" />
      <rect x="470" y="168" width="110" height="204" fill="#D9CFC4" /><polygon points="470,168 525,118 580,168" fill="#3A3F52" />
      {/* the house */}
      <polygon points="150,170 300,70 450,170" fill="#0B0F1C" />
      <rect x="374" y="88" width="22" height="50" fill="#262B3A" />
      <rect x="150" y="170" width="300" height="202" fill="#B8603A" />
      {Array.from({ length: 13 }).map((_, r) => <line key={r} x1="150" x2="450" y1={182 + r * 15} y2={182 + r * 15} stroke="#9E4E2C" strokeWidth="1" />)}
      <rect x="182" y="200" width="70" height="58" fill="#DCE6EE" stroke="#F6F7F9" strokeWidth="6" />
      <rect x="348" y="200" width="70" height="58" fill="#DCE6EE" stroke="#F6F7F9" strokeWidth="6" />
      <path d="M170 372v-86h104v86" fill="#DCE6EE" stroke="#F6F7F9" strokeWidth="6" />
      <rect x="320" y="292" width="46" height="80" fill="#5E3BF6" />
      <circle cx="356" cy="334" r="3" fill="#F07415" />
      <rect x="312" y="284" width="62" height="8" fill="#F6F7F9" />
      <rect x="140" y="368" width="320" height="8" fill="#0B0F1C" />
    </svg>
  );
}

function Blueprint({ a }: { a: { loft: string; kitchen: string; epc: string; value: string; risk: string } }) {
  const L = '#E4E7F2', G = '#6E78A6', O = '#FF8A3D', P = '#FFC24B';
  const lab = { fontFamily: 'Plus Jakarta Sans Variable, Plus Jakarta Sans, system-ui, sans-serif', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em' } as const;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" aria-hidden className="xr-svg">
      <defs><pattern id="bp-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#1D2747" strokeWidth="1" /></pattern></defs>
      <rect width={W} height={H} fill="#0E1424" /><rect width={W} height={H} fill="url(#bp-grid)" />
      {/* dimension line */}
      <g stroke={G} strokeWidth="1.5"><line x1="150" y1="52" x2="450" y2="52" /><line x1="150" y1="44" x2="150" y2="60" /><line x1="450" y1="44" x2="450" y2="60" /></g>
      <text x="300" y="40" textAnchor="middle" fill={L} style={lab}>5.4 M · SECTION A–A</text>
      {/* structure */}
      <polygon points="150,170 300,70 450,170" fill="rgba(127,212,255,0.06)" stroke={L} strokeWidth="2" />
      <rect x="150" y="170" width="300" height="202" fill="rgba(127,212,255,0.04)" stroke={L} strokeWidth="2" />
      <line x1="150" y1="272" x2="450" y2="272" stroke={G} strokeWidth="1.5" strokeDasharray="6 5" />
      {/* loft potential */}
      <polygon points="215,150 300,92 385,150 385,170 215,170" fill="rgba(255,194,75,0.18)" stroke={P} strokeWidth="2" strokeDasharray="7 5" />
      {/* kitchen */}
      <rect x="290" y="282" width="150" height="82" fill="rgba(240,116,21,0.15)" stroke={O} strokeWidth="2" strokeDasharray="7 5" />
      {/* foundations */}
      <g fill="rgba(240,116,21,0.18)" stroke={O} strokeWidth="1.5" strokeDasharray="6 4"><rect x="150" y="378" width="96" height="22" /><rect x="252" y="378" width="96" height="22" /><rect x="354" y="378" width="96" height="22" /></g>
      {/* growth arrow */}
      <polyline points="196,340 270,262 400,210 520,96" fill="none" stroke={O} strokeWidth="3" strokeDasharray="10 7" strokeLinecap="round" />
      <polyline points="500,98 520,96 518,116" fill="none" stroke={O} strokeWidth="3" strokeLinecap="round" />
      {[[196, 340], [270, 262], [400, 210]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="5" fill={O} />)}
      {/* callouts */}
      <g style={lab}>
        <text x="300" y="136" textAnchor="middle" fill={P}>LOFT</text>
        <text x="300" y="150" textAnchor="middle" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.loft}</text>
        <text x="365" y="300" textAnchor="middle" fill={O}>KITCHEN</text>
        <text x="365" y="316" textAnchor="middle" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.kitchen}</text>
        <polyline points="150,214 120,190 18,190" fill="none" stroke={L} strokeWidth="1.5" /><circle cx="150" cy="214" r="3.5" fill={L} />
        <text x="18" y="182" fill={L}>EPC</text><text x="18" y="206" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.epc}</text>
        <polyline points="450,389 470,372 590,372" fill="none" stroke={L} strokeWidth="1.5" /><circle cx="450" cy="389" r="3.5" fill={L} />
        <text x="470" y="336" fill={L}>FOUNDATIONS</text><text x="470" y="352" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.risk.split(' ')[0]}</text><text x="470" y="366" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.risk.split(' ').slice(1).join(' ')}</text>
        <text x="586" y="62" textAnchor="end" fill={O}>VALUE</text><text x="586" y="78" textAnchor="end" fill="#E8EEFF" style={{ ...lab, fontWeight: 600 }}>{a.value}</text>
      </g>
    </svg>
  );
}

export function XRayHero({ propertyId = 'wal-001' }: { propertyId?: string }) {
  const p = getProperty(propertyId)!;
  const a = useMemo(() => {
    const est = estimateRefurb(refurbInputFor(p));
    const loft = loftScenario(p);
    const kitchen = est.byTrade.find((t) => t.trade === 'Kitchen')?.total ?? 0;
    const epc = epcPathway(p);
    const ds = dealScore(p);
    return {
      loft: loft ? `+${loft.area}M² · ${gbpK(loft.cost)}` : 'NO LOFT ROOM',
      kitchen: `${gbpK((kitchen * est.total) / Math.max(1, est.measuredWorks))} ALL-IN`,
      epc: `${p.epc.current} → ${epc.steps.length ? epc.steps[Math.min(3, epc.steps.length - 1)].band : p.epc.potential}`,
      value: `${gbpK(p.price)} → ${gbpK(p.estGdv)}`,
      risk: `SUBSIDENCE ${p.risks.subsidence.toUpperCase()}`,
      works: gbpK(est.total), grade: ds.grade,
    };
  }, [p]);
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const state = useRef({ x: 0.5, y: 0.45, active: false, t: 0, visible: true, full: false });
  state.current.full = full;

  useEffect(() => {
    const el = box.current!; const st = state.current;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; }, { threshold: 0.05 });
    io.observe(el);
    const move = (e: PointerEvent) => { const r = el.getBoundingClientRect(); st.x = (e.clientX - r.left) / r.width; st.y = (e.clientY - r.top) / r.height; st.active = true; };
    const leave = () => { st.active = false; };
    el.addEventListener('pointermove', move); el.addEventListener('pointerdown', move); el.addEventListener('pointerleave', leave); el.addEventListener('pointercancel', leave);
    let raf = 0; let last = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - (last || now)) / 1000); last = now;
      if (st.visible) {
        if (!st.active && !st.full && !reduce) st.t += dt;
        const x = st.active ? st.x : 0.5 + 0.3 * Math.sin(st.t * 0.55);
        const y = st.active ? st.y : 0.47 + 0.12 * Math.sin(st.t * 1.1 + 0.6);
        const w = el.clientWidth; const R = Math.max(70, w * 0.2);
        if (layer.current) layer.current.style.clipPath = `circle(${st.full ? Math.max(w, el.clientHeight) * 1.5 : R}px at ${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%)`;
        if (ring.current) { ring.current.style.width = ring.current.style.height = `${R * 2}px`; ring.current.style.left = `calc(${(x * 100).toFixed(2)}% - ${R}px)`; ring.current.style.top = `calc(${(y * 100).toFixed(2)}% - ${R}px)`; }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); io.disconnect(); el.removeEventListener('pointermove', move); el.removeEventListener('pointerdown', move); el.removeEventListener('pointerleave', leave); el.removeEventListener('pointercancel', leave); };
  }, []);

  return (
    <figure className="xr">
      <div className="xr-head"><span className="label-mono">Streetkey · Look inside</span><span className="label-mono muted">Drag across the house</span></div>
      <div ref={box} className={`xr-stage${full ? ' full' : ''}`}>
        <HouseFront />
        <div ref={layer} className="xr-layer"><Blueprint a={a} /></div>
        <div ref={ring} className="xr-ring" style={{ opacity: full ? 0 : 1 }} aria-hidden><span className="h" /><span className="v" /><span className="tag">PLANS</span></div>
      </div>
      <ul className="sr-only">
        <li>Demo property: {p.street.replace(' (fictional)', '')}, {p.town}, asking {gbpK(p.price)}.</li>
        <li>Loft conversion: {a.loft.toLowerCase()}.</li><li>New kitchen: {a.kitchen.toLowerCase()}.</li>
        <li>Energy rating: {a.epc}.</li><li>Value after works: {a.value}.</li><li>Ground: {a.risk.toLowerCase()}.</li>
      </ul>
      <figcaption className="xr-foot">
        <button type="button" className="btn xr-btn" aria-pressed={full} onClick={() => setFull((f) => !f)}>
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          {full ? 'Close the plans' : 'Show the plans'}
        </button>
        <Link to={`/property/${p.id}/intelligence`} className="xr-link"><b>{p.street.replace(' (fictional)', '')}</b> · works {a.works} · grade {a.grade} →</Link>
      </figcaption>
    </figure>
  );
}
