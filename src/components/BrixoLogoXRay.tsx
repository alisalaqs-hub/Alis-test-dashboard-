import { useEffect, useRef, useState } from 'react';

/**
 * Brixo interactive X-ray logo — faithful port of the brand master artwork
 * (1200×800 stage, scaled to its frame). Move/drag across the logo to reveal the
 * blueprint; "See through" reveals it fully.
 *
 * Accessibility additions (visuals unchanged): text alternative for the artwork,
 * aria-pressed toggle, purple focus ring (orange fails 3:1 on paper),
 * prefers-reduced-motion stops the auto-sweep, and the loop pauses off-screen.
 */
const W = 1200, H = 800, R = 150;
const LOGO_POINTS = '178,415 178,233.9 399.9,79.4 605,219.6 605,499.8 544.8,560 488,560 488,498 519.2,498 543,474.2 543,252.4 400.1,154.7 240,266.1 240,383';

export function BrixoLogoXRay({ className }: { className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const xray = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const st = useRef({ t: 0, last: 0, active: false, full: false, anim: false, px: 0, py: 0, visible: true, timer: 0 as unknown as ReturnType<typeof setTimeout> });

  useEffect(() => {
    const f = frame.current!, s = stage.current!, s0 = st.current;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const fit = () => { s.style.transform = `scale(${f.clientWidth / W})`; };
    const ro = new ResizeObserver(fit); ro.observe(f); fit();
    const io = new IntersectionObserver(([e]) => { s0.visible = e.isIntersecting; }, { threshold: 0.01 }); io.observe(f);
    const move = (e: PointerEvent) => { const r = s.getBoundingClientRect(); if (!r.width || !r.height) return; s0.px = (e.clientX - r.left) * (W / r.width); s0.py = (e.clientY - r.top) * (H / r.height); s0.active = true; };
    const leave = () => { s0.active = false; };
    s.addEventListener('pointermove', move); s.addEventListener('pointerdown', move); s.addEventListener('pointerleave', leave); s.addEventListener('pointercancel', leave);
    let raf = 0;
    const loop = (now: number) => {
      if (!s0.last) s0.last = now;
      const dt = Math.min(0.1, (now - s0.last) / 1000); s0.last = now;
      if (s0.visible) {
        if (!s0.active && !s0.full && !s0.anim && !reduce) s0.t += dt;
        const x = s0.active ? s0.px : 600 + 380 * Math.sin(s0.t * 0.55);
        const y = s0.active ? s0.py : 395 + 75 * Math.sin(s0.t * 1.1 + 0.6);
        if (xray.current) {
          xray.current.style.transition = s0.anim ? 'clip-path 700ms cubic-bezier(.65,0,.35,1)' : 'none';
          xray.current.style.clipPath = `circle(${s0.full ? 1500 : R}px at ${x.toFixed(1)}px ${y.toFixed(1)}px)`;
        }
        if (ring.current) { ring.current.style.left = `${(x - R).toFixed(1)}px`; ring.current.style.top = `${(y - R).toFixed(1)}px`; }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); clearTimeout(s0.timer); s.removeEventListener('pointermove', move); s.removeEventListener('pointerdown', move); s.removeEventListener('pointerleave', leave); s.removeEventListener('pointercancel', leave); };
  }, []);

  const toggle = () => {
    const s0 = st.current; s0.full = !s0.full; s0.anim = true;
    clearTimeout(s0.timer); s0.timer = setTimeout(() => { s0.anim = false; }, 750);
    setFull(s0.full);
  };

  return (
    <div className={`bxl ${className ?? ''}`}>
    <div ref={frame} className="bxl-frame">
      <p className="sr-only">Brixo — See Beyond the Property. Interactive logo: an x-ray lens reveals the logo as an architectural blueprint showing the foundations, the property and growth beyond it.</p>
      <div ref={stage} className="bxl-stage">
        <div className="bxl-layer" aria-hidden="true">
          <div className="bxl-lockup">
            <svg viewBox="170 70 445 500" width="222.5" height="250">
              <polygon points="178,445 230,415 345,415 345,477 178,477" fill="#F07415" />
              <rect x="370" y="415" width="150" height="62" fill="#F07415" />
              <rect x="178" y="500" width="92" height="60" fill="#F07415" />
              <rect x="293" y="500" width="157" height="60" fill="#F07415" />
              <polygon points={LOGO_POINTS} fill="#0B0F1C" />
              <polygon points="285,343 343,322 343,392 285,392" fill="#5E3BF6" />
              <polygon points="365,301 422,280 422,392 365,392" fill="#5E3BF6" />
              <polygon points="445,262 502,238 502,392 445,392" fill="#5E3BF6" />
            </svg>
            <div className="bxl-words">
              <span className="bxl-wordmark">BRIXO</span>
              <span className="bxl-tagline">See Beyond the Property<span style={{ color: '#F07415' }}>.</span></span>
            </div>
          </div>
        </div>

        <div ref={xray} className="bxl-layer bxl-xray" aria-hidden="true">
          <svg viewBox="0 0 1200 800" width="1200" height="800" style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}>
            <g fill="none" stroke="#3F6FBF" strokeWidth="1.5"><line x1="181" y1="232" x2="1024" y2="232" /><line x1="181" y1="223" x2="181" y2="241" /><line x1="1024" y1="223" x2="1024" y2="241" /></g>
            <g fill="none" stroke="#3F6FBF" strokeWidth="1" strokeDasharray="6 5"><line x1="427" y1="333" x2="1024" y2="333" /><line x1="427" y1="460.5" x2="1024" y2="460.5" /></g>
            <g fill="none" stroke="#7FD4FF" strokeWidth="1.5"><polyline points="200,515 170,545 48,545" /><polyline points="181,352 150,322 48,322" /></g>
            <circle cx="200" cy="515" r="4" fill="#7FD4FF" /><circle cx="181" cy="352" r="4" fill="#7FD4FF" />
            <g transform="translate(177 270) scale(0.5) translate(-170 -70)">
              <g fill="rgba(240,116,21,0.18)" stroke="#FF9A4D" strokeWidth="3" strokeDasharray="10 6">
                <polygon points="178,445 230,415 345,415 345,477 178,477" /><rect x="370" y="415" width="150" height="62" /><rect x="178" y="500" width="92" height="60" /><rect x="293" y="500" width="157" height="60" />
              </g>
              <polygon points={LOGO_POINTS} fill="rgba(127,212,255,0.08)" stroke="#7FD4FF" strokeWidth="3" />
              <g fill="none" stroke="#A996FF" strokeWidth="3" strokeDasharray="8 6">
                <polygon points="285,321 343,290.5 343,392 285,392" /><polygon points="365,246.4 422,212.8 422,392 365,392" /><polygon points="445,132 502,84 502,392 445,392" />
              </g>
              <g fill="rgba(123,92,255,0.35)" stroke="#A996FF" strokeWidth="3">
                <polygon points="285,343 343,322 343,392 285,392" /><polygon points="365,301 422,280 422,392 365,392" /><polygon points="445,262 502,238 502,392 445,392" />
              </g>
              <polyline points="314,305.8 393.5,229.6 473.5,108 509.5,53.3" fill="none" stroke="#FF9A4D" strokeWidth="4" strokeDasharray="12 8" strokeLinecap="round" />
              <polyline points="487.4,65.1 509.5,53.3 507.4,78.3" fill="none" stroke="#FF9A4D" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              <g fill="#FF9A4D"><circle cx="314" cy="305.8" r="6" /><circle cx="393.5" cy="229.6" r="6" /><circle cx="473.5" cy="108" r="6" /></g>
            </g>
          </svg>
          <div className="bxl-lockup">
            <div style={{ width: 222.5, height: 250, flex: 'none' }} />
            <div className="bxl-words">
              <span className="bxl-wordmark">BRIXO</span>
              <span className="bxl-tagline">See Beyond the Property<span style={{ color: '#FF9A4D' }}>.</span></span>
            </div>
          </div>
          <div className="bxl-label" style={{ left: 181, width: 843, top: 207, textAlign: 'center', letterSpacing: '0.16em' }}>BRIXO · SECTION A–A</div>
          <div className="bxl-label" style={{ left: 48, top: 328 }}>02 / THE PROPERTY</div>
          <div className="bxl-label" style={{ left: 48, top: 551 }}>01 / FOUNDATIONS</div>
          <div className="bxl-label" style={{ left: 358, top: 250, fontWeight: 700, color: '#FF9A4D' }}>03 / BEYOND</div>
          <div className="bxl-label" style={{ left: 1034, top: 327, fontSize: 10, fontWeight: 400, letterSpacing: '0.12em', color: '#6E9BE0' }}>CAP</div>
          <div className="bxl-label" style={{ left: 1034, top: 454, fontSize: 10, fontWeight: 400, letterSpacing: '0.12em', color: '#6E9BE0' }}>BASE</div>
          <div className="bxl-titleblock">
            <div><span className="k">PROJECT</span><span>BRIXO</span></div>
            <div><span className="k">DRAWING</span><span>LOGO / X-RAY</span></div>
            <div><span className="k">NOTE</span><span style={{ color: '#FF9A4D' }}>SEE BEYOND</span></div>
          </div>
        </div>

        <div ref={ring} className="bxl-ring" style={{ opacity: full ? 0 : 1 }} aria-hidden="true"><span className="h" /><span className="v" /><span className="tag">X-RAY</span></div>

        <div className="bxl-chrome" style={{ color: full ? '#A9B4D0' : '#5B6070' }} aria-hidden="true">
          <span>BRIXO / X-RAY LOGO</span><span>MOVE OR DRAG ACROSS THE LOGO</span>
        </div>

        <button type="button" className="bxl-btn" aria-pressed={full} onClick={toggle} style={{ background: full ? '#F07415' : '#0B0F1C', color: full ? '#0B0F1C' : '#FFFFFF' }}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          <span>{full ? 'Close x-ray' : 'See through'}</span>
        </button>
      </div>
    </div>
    {/* Small screens: full-size control & hint (the scaled stage button would be too small to tap). */}
    <div className="bxl-under">
      <button type="button" className="btn bxl-btn-out" aria-pressed={full} onClick={toggle} style={full ? { background: '#F07415', borderColor: '#F07415', color: '#0B0F1C' } : undefined}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
        {full ? 'Close x-ray' : 'See through'}
      </button>
      <span className="label-mono">Drag across the logo</span>
    </div>
    </div>
  );
}
