import { useEffect, useId, useRef } from 'react';

/**
 * Streetkey interactive logo — faithful port of the brand master artwork
 * (1200×800 stage scaled to its frame). Key-turn unlock, tappable houses with
 * insight tags, time-of-day slider with auto day cycle, pointer-following
 * locator dot, moving road and car, and a build-up intro.
 *
 * Accessibility additions (visuals unchanged): navy focus ring (orange fails 3:1
 * on paper), reduced motion = no transitions / no moving road, loop pauses
 * off-screen, a text alternative, and full-size controls under the logo when
 * the frame is too small for the scaled ones.
 */
const W = 1200, H = 800;
const B = 'cubic-bezier(.34,1.56,.64,1)';
const E = 'cubic-bezier(.65,0,.35,1)';
const NAVY = '#0E1424', ORANGE = '#F07415', GLOW = '#FFC24B';
const NIGHT_AT = [72, 64, 86, 60, 79, 92];
const SKY: [number, string][] = [[0, '#F7F5F0'], [50, '#F8D9B8'], [66, '#EDA683'], [76, '#5E5D8F'], [100, '#34437A']];
const INSIGHTS = ['Value', 'Schools', 'Travel', 'Energy', 'Internet', 'Parks'];

const PINS = [
  { left: 516, top: 150, stem: 52, label: 'Value', icon: <><polyline points="3 17 9 11 13 15 21 7" /><polyline points="14 7 21 7 21 14" /></> },
  { left: 576, top: 100, stem: 87, label: 'Schools', icon: <><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" /></> },
  { left: 636, top: 150, stem: 55, label: 'Travel', icon: <><rect x="4" y="3" width="16" height="14" rx="3" /><line x1="4" y1="10" x2="20" y2="10" /><circle cx="8" cy="20" r="1.5" /><circle cx="16" cy="20" r="1.5" /></> },
  { left: 696, top: 100, stem: 77, label: 'Energy', icon: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /> },
  { left: 756, top: 150, stem: 47, label: 'Internet', icon: <><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.94 0" /><line x1="12" y1="20" x2="12.01" y2="20" /></> },
  { left: 816, top: 100, stem: 90, label: 'Parks', icon: <><path d="M12 2 6 12h4l-4 6h12l-4-6h4z" /><line x1="12" y1="18" x2="12" y2="22" /></> },
];
const HITS = [[490, 242, 66], [550, 227, 81], [610, 245, 63], [670, 207, 101], [730, 237, 71], [790, 230, 78]];
const HOUSES = [
  { poly: '172,125 172,95 193,72 214,95 214,125', wins: [[179, 104, 13, 13], [197, 107, 10, 18]] },
  { poly: '220,125 220,85 241,60 262,85 262,125', wins: [[227, 104, 13, 13], [245, 107, 10, 18]] },
  { poly: '268,125 268,96 289,74 310,96 310,125', wins: [[275, 104, 13, 13], [293, 107, 10, 18]] },
  { poly: '316,125 316,80 337,52 358,80 358,125', wins: [[330.5, 86, 13, 12], [323, 104, 13, 13], [341, 107, 10, 18]], chimney: true },
  { poly: '364,125 364,92 385,68 406,92 406,125', wins: [[371, 104, 13, 13], [389, 107, 10, 18]] },
  { poly: '412,125 412,86 433,62 454,86 454,125', wins: [[419, 104, 13, 13], [437, 107, 10, 18]] },
];
const STARS = [[64, 96, 1.6], [140, 170, 1.2], [210, 74, 1.8], [118, 250, 1.3], [300, 130, 1.2], [420, 60, 1.6], [500, 96, 1.1], [620, 52, 1.5], [760, 64, 1.2], [900, 190, 1.4], [990, 96, 1.7], [1060, 150, 1.2], [1130, 70, 1.5], [1100, 260, 1.3], [70, 340, 1.2], [1140, 360, 1.4]];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: string, b: string, f: number) => { const A = hex(a), C = hex(b); return `rgb(${A.map((v, k) => Math.round(v + (C[k] - v) * f)).join(',')})`; };
function ramp(stops: [number, string][], t: number) {
  for (let k = 1; k < stops.length; k++) if (t <= stops[k][0]) { const a = stops[k - 1], b = stops[k]; return mix(a[1], b[1], (t - a[0]) / (b[0] - a[0])); }
  const last = stops[stops.length - 1][1]; return mix(last, last, 0);
}

export function StreetkeyLogo() {
  const root = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, '');

  useEffect(() => {
    const el = root.current!;
    const q = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as unknown as T;
    const qa = <T extends Element = HTMLElement>(s: string) => Array.from(el.querySelectorAll(s)) as unknown as T[];
    const frame = q('.sk-frame'), stage = q('.sk-stage');
    const houses = qa<SVGGElement>('.sk-house'), hits = qa<HTMLButtonElement>('.sk-hit'), pins = qa('.sk-pin'), letters = qa('.sk-l');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const st = { shown: true, instant: reduce, intro: false, unlocked: false, sel: [false, false, false, false, false, false], hover: null as number | null, tod: 0, auto: false, dir: 1, turns: 0, px: null as number | null, py: null as number | null, road: 0, turning: false, visible: true };
    let timers: ReturnType<typeof setTimeout>[] = [];
    let dirty = true;
    const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, reduce ? 0 : ms)); };
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
    const d = (introDelay: number, liveDelay = 0) => `${st.intro ? introDelay : liveDelay}ms`;

    const fit = () => { stage.style.transform = `scale(${frame.clientWidth / W})`; };
    const ro = new ResizeObserver(fit); ro.observe(frame); fit();
    const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; }, { threshold: 0.01 }); io.observe(frame);

    function render() {
      const tod = clamp(st.tod, 0, 100), sky = ramp(SKY, tod), night = tod >= 72;
      const text = night ? '#FFFFFF' : NAVY, muted = night ? '#E4E7F2' : '#4F5468';
      const { shown, intro, unlocked } = st; const instant = st.instant || reduce;
      stage.style.background = sky; stage.style.color = text;
      q('.sk-label').style.color = muted; q('.sk-timelabel').style.color = muted; q('.sk-status').style.color = muted;
      const sf = clamp(tod / 62, 0, 1), mf = clamp((tod - 58) / 42, 0, 1);
      q<SVGGElement>('.sk-stars').style.opacity = String(clamp((tod - 70) / 22, 0, 1));
      const sun = q<SVGCircleElement>('.sk-sun');
      sun.style.transform = `translate(${(930 + 80 * sf).toFixed(1)}px,${(110 + 230 * sf * sf).toFixed(1)}px)`;
      sun.style.opacity = String(1 - clamp((tod - 55) / 7, 0, 1));
      const moon = q<SVGGElement>('.sk-moon');
      moon.style.transform = `translate(${(170 + 60 * mf).toFixed(1)}px,${(340 - 230 * (1 - (1 - mf) * (1 - mf))).toFixed(1)}px)`;
      moon.style.opacity = String(clamp((tod - 58) / 8, 0, 1));
      q<SVGCircleElement>('.sk-mooncut').style.fill = sky;

      const rig = q('.sk-rig');
      rig.style.transition = instant ? 'none' : `transform 900ms ${E}`;
      rig.style.transform = `rotateX(${st.turns * 360}deg)`;
      const ring = q<SVGCircleElement>('.sk-ring');
      ring.style.transition = instant ? 'none' : `stroke-dashoffset 700ms ${E} ${d(0)}`;
      ring.style.strokeDashoffset = shown ? '0' : '1';
      const blade = q<SVGPathElement>('.sk-blade');
      blade.style.transition = instant ? 'none' : `transform 600ms ${E} ${d(300)}`;
      blade.style.transform = `scaleX(${shown ? 1 : 0})`;
      const road = q<SVGLineElement>('.sk-road');
      road.style.stroke = sky; road.style.transition = instant ? 'none' : `opacity 400ms ease ${d(1300)}`;
      road.style.opacity = shown ? '1' : '0'; road.style.strokeDashoffset = (-st.road).toFixed(1);
      const car = q<SVGRectElement>('.sk-car');
      car.style.transform = `translateX(${((st.road * 2.4) % 250).toFixed(1)}px)`;
      car.style.opacity = unlocked && shown ? '1' : '0';

      houses.forEach((g, i) => {
        const on = shown && (unlocked || st.sel[i] || tod >= NIGHT_AT[i]);
        g.style.transition = instant ? 'none' : `transform 520ms ${B} ${d(700 + i * 110, 0)}`;
        g.style.transform = `translateY(${st.hover === i && shown && !intro ? -8 : 0}px) scaleY(${shown ? 1 : 0})`;
        const wt = instant ? 'none' : `fill 280ms ease ${unlocked && !st.sel[i] ? i * 110 : 0}ms`;
        g.querySelectorAll<SVGRectElement>('.sk-win').forEach((w) => { w.style.transition = wt; w.style.fill = on ? GLOW : sky; });
      });

      let ox = 0, oy = 0;
      if (st.px != null && st.py != null) { const dx = st.px - 387.5, dy = st.py - 290, dist = Math.sqrt(dx * dx + dy * dy), m = Math.min(dist / 14, 20); if (dist > 0) { ox = (dx / dist) * m; oy = (dy / dist) * m; } }
      const dot = q<SVGCircleElement>('.sk-dot');
      dot.style.transition = instant ? 'none' : intro ? `transform 450ms ${B} ${d(650)}` : 'transform 140ms linear';
      dot.style.transform = `translate(${ox.toFixed(1)}px,${oy.toFixed(1)}px) scale(${!shown ? 0 : unlocked ? 1.2 : 1})`;

      const pinBg = night ? '#FFFFFF' : NAVY, pinFg = night ? NAVY : '#FFFFFF', pinIcon = night ? ORANGE : GLOW;
      pins.forEach((p, i) => {
        const on = shown && (unlocked || st.sel[i]);
        const delay = unlocked && !st.sel[i] ? 800 + i * 120 : 0;
        p.style.transition = instant ? 'none' : on ? `opacity 300ms ease ${delay}ms, transform 480ms ${B} ${delay}ms` : 'opacity 200ms ease, transform 200ms ease';
        p.style.opacity = on ? '1' : '0';
        p.style.transform = `translateX(-50%) translateY(${on ? 0 : 12}px)`;
        const pill = p.querySelector<HTMLElement>('.sk-pill')!; pill.style.background = pinBg; pill.style.color = pinFg;
        p.querySelector<HTMLElement>('.sk-stem')!.style.background = pinBg;
        p.querySelector<SVGElement>('svg')!.style.stroke = pinIcon;
      });

      letters.forEach((l, i) => {
        const dl = d(1200 + i * 45);
        l.style.transition = instant ? 'none' : `transform 520ms ${B} ${dl}, opacity 260ms ease ${dl}`;
        l.style.color = i >= 6 ? ORANGE : text; l.style.opacity = shown ? '1' : '0';
        l.style.transform = `translateY(${shown ? 0 : 30}px)`;
      });
      const tag = q('.sk-tagline');
      tag.style.transition = instant ? 'none' : `transform 500ms ease ${d(1700)}, opacity 500ms ease ${d(1700)}`;
      tag.style.opacity = shown ? '1' : '0'; tag.style.transform = `translateY(${shown ? 0 : 12}px)`;

      let status = 'Tap the key to unlock the street, or tap any house to see inside.';
      if (intro) status = 'Building the street…';
      else if (unlocked) status = 'Street unlocked. Tap the key again to lock it.';
      else if (st.sel.some(Boolean)) status = 'Tap a house again to close it, or turn the key to open them all.';
      for (const s of qa('.sk-status, .sk-under-status')) if (s.textContent !== status) s.textContent = status;

      for (const t of qa('.sk-turnlabel')) t.textContent = unlocked ? 'Lock the street' : 'Turn the key';
      const play = q('.sk-play'); play.style.borderColor = text; play.style.color = text;
      q<SVGElement>('.sk-sunicon').style.stroke = text; q<SVGElement>('.sk-moonicon').style.stroke = text;
      const autoBtn = q('.sk-auto');
      autoBtn.textContent = st.auto ? 'Pause' : 'Run the day'; autoBtn.style.borderColor = text;
      autoBtn.style.background = st.auto ? text : 'transparent'; autoBtn.style.color = st.auto ? sky : text;
      for (const a of qa('.sk-auto, .sk-u-auto')) { a.setAttribute('aria-pressed', String(st.auto)); if (a.classList.contains('sk-u-auto')) a.textContent = st.auto ? 'Pause' : 'Run the day'; }
      for (const r of qa<HTMLInputElement>('.sk-time, .sk-range')) r.value = String(Math.round(tod));
      hits.forEach((h, i) => h.setAttribute('aria-pressed', String(st.sel[i])));
      qa<HTMLButtonElement>('.sk-u-house').forEach((b, i) => { const on = st.sel[i] || st.unlocked; b.setAttribute('aria-pressed', String(st.sel[i])); b.classList.toggle('on', on); });
      q('.sk-key').setAttribute('aria-pressed', String(unlocked));
      for (const t of qa('.sk-u-turn')) t.setAttribute('aria-pressed', String(unlocked));
    }

    function turn() {
      if (st.intro || st.turning) return;
      st.turning = true; st.turns += 1; render();
      later(() => { st.unlocked = !st.unlocked; render(); later(() => { st.turning = false; }, 350); }, 650);
    }
    function playIntro() {
      clearTimers(); st.turning = false;
      st.shown = false; st.instant = true; st.intro = true; st.unlocked = false; st.sel = [false, false, false, false, false, false]; st.hover = null;
      render();
      later(() => { st.shown = true; st.instant = reduce; render(); later(() => { st.intro = false; render(); }, 2600); }, 60);
    }
    const toggleAuto = () => { st.auto = !st.auto; render(); };
    const setTod = (e: Event) => { st.tod = Number((e.target as HTMLInputElement).value); st.auto = false; render(); };

    const offs: (() => void)[] = [];
    const on = (t: EventTarget, ev: string, fn: EventListener) => { t.addEventListener(ev, fn); offs.push(() => t.removeEventListener(ev, fn)); };
    qa('.sk-key, .sk-turn, .sk-u-turn').forEach((b) => on(b, 'click', turn));
    qa('.sk-play, .sk-u-play').forEach((b) => on(b, 'click', playIntro));
    qa('.sk-auto, .sk-u-auto').forEach((b) => on(b, 'click', toggleAuto));
    qa('.sk-time, .sk-range').forEach((r) => on(r, 'input', setTod));
    hits.forEach((h, i) => {
      on(h, 'click', () => { st.sel[i] = !st.sel[i]; render(); });
      on(h, 'mouseenter', () => { st.hover = i; render(); });
      on(h, 'mouseleave', () => { st.hover = null; render(); });
    });
    qa<HTMLButtonElement>('.sk-u-house').forEach((b, i) => on(b, 'click', () => { st.sel[i] = !st.sel[i]; render(); }));
    on(stage, 'pointermove', ((e: PointerEvent) => { const r = stage.getBoundingClientRect(); if (!r.width || !r.height) return; st.px = (e.clientX - r.left) * (W / r.width); st.py = (e.clientY - r.top) * (H / r.height); dirty = true; }) as EventListener);
    on(stage, 'pointerleave', () => { st.px = null; st.py = null; st.hover = null; dirty = true; });

    let last: number | null = null, raf = 0;
    const loop = (now: number) => {
      if (last == null) last = now;
      const k = Math.min(100, now - last) / 40; last = now;
      if (st.visible) {
        let changed = dirty;
        if (st.unlocked && !st.intro && !reduce) { st.road += 1.2 * k; changed = true; }
        if (st.auto) { st.tod += st.dir * 0.6 * k; if (st.tod >= 100) { st.tod = 100; st.dir = -1; } if (st.tod <= 0) { st.tod = 0; st.dir = 1; } changed = true; }
        if (changed) { dirty = false; render(); }
      }
      raf = requestAnimationFrame(loop);
    };
    render(); raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); clearTimers(); ro.disconnect(); io.disconnect(); offs.forEach((f) => f()); };
  }, []);

  const keyIcon = <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></svg>;
  const replayIcon = <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>;

  return (
    <div ref={root} className="skl">
      <p className="sr-only">Streetkey — See Beyond the Property. Interactive logo: a key whose blade is a street of six houses. Turning the key unlocks the street and reveals insights for each home: {INSIGHTS.join(', ')}.</p>
      <div className="sk-frame">
        <div className="sk-stage">
          <svg className="sk-skylayer" aria-hidden="true" width="1200" height="800" viewBox="0 0 1200 800">
            <g className="sk-stars" style={{ fill: '#FFFFFF', opacity: 0 }}>{STARS.map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />)}</g>
            <circle className="sk-sun" cx="0" cy="0" r="26" style={{ fill: '#FFB547' }} />
            <g className="sk-moon"><circle cx="0" cy="0" r="22" style={{ fill: '#F4EFE3' }} /><circle className="sk-mooncut" cx="9" cy="-6" r="18" /></g>
          </svg>
          <p className="sk-label" aria-hidden="true">Streetkey · Interactive logo</p>
          {PINS.map((p) => (
            <div key={p.label} className="sk-pin" style={{ left: p.left, top: p.top }} aria-hidden="true">
              <div className="sk-pill"><svg viewBox="0 0 24 24">{p.icon}</svg><span>{p.label}</span></div>
              <div className="sk-stem" style={{ height: p.stem }} />
            </div>
          ))}
          <button type="button" className="sk-key" aria-label="Streetkey key: turn it to unlock the whole street" aria-pressed="false">
            <span className="sk-rig">
              <svg aria-hidden="true" viewBox="0 30 520 160" width="650" height="200">
                <circle className="sk-ring" cx="90" cy="110" r="57" pathLength={1} />
                <path className="sk-blade" d="M140 125 H500 V172 H470 V151 H445 V166 H425 V151 H140 Z" />
                <line className="sk-road" x1="168" y1="138" x2="420" y2="138" />
                <rect className="sk-car" x="150" y="133" width="24" height="10" rx="4" style={{ opacity: 0 }} />
                {HOUSES.map((h, i) => (
                  <g key={i} className="sk-house">
                    {h.chimney && <rect className="sk-chimney" x="342" y="44" width="8" height="28" />}
                    <polygon points={h.poly} />
                    {h.wins.map(([x, y, w, hh]) => <rect key={`${x}-${y}`} className="sk-win" x={x} y={y} width={w} height={hh} />)}
                  </g>
                ))}
                <circle className="sk-dot" cx="90" cy="110" r="15" />
              </svg>
            </span>
          </button>
          {HITS.map(([l, t, h], i) => <button key={i} type="button" className="sk-hit" aria-label={`House ${i + 1}: ${INSIGHTS[i]}`} aria-pressed="false" style={{ left: l, top: t, height: h }} />)}
          <div className="sk-words">
            <div className="sk-wordmark" aria-hidden="true">{'streetkey'.split('').map((c, i) => <span key={i} className="sk-l">{c}</span>)}</div>
            <p className="sk-tagline" aria-hidden="true">See Beyond the Property<span style={{ color: '#F07415' }}>.</span></p>
            <p className="sk-status" aria-live="polite" />
          </div>
          <div className="sk-controls">
            <div className="sk-group">
              <button type="button" className="sk-btn sk-btn-primary sk-turn">{keyIcon}<span className="sk-turnlabel">Turn the key</span></button>
              <button type="button" className="sk-btn sk-btn-outline sk-play">{replayIcon}<span>Play intro</span></button>
            </div>
            <div className="sk-group">
              <label className="sk-timelabel" htmlFor={`skTime${uid}`}>Time of day</label>
              <svg className="sk-icon sk-sunicon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              <input id={`skTime${uid}`} className="sk-time" type="range" min="0" max="100" step="1" defaultValue="0" />
              <svg className="sk-icon sk-moonicon" aria-hidden="true" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              <button type="button" className="sk-btn sk-btn-outline sk-auto" aria-pressed="false">Run the day</button>
            </div>
          </div>
        </div>
      </div>
      <div className="sk-under">
        <div className="row">
          <button type="button" className="btn accent sk-u-turn" aria-pressed="false">{keyIcon}<span className="sk-turnlabel">Turn the key</span></button>
          <button type="button" className="btn ghost sk-u-play">Play intro</button>
          <button type="button" className="btn ghost sk-u-auto" aria-pressed="false">Run the day</button>
        </div>
        <div className="sk-u-houses" role="group" aria-label="Open one home's insight">
          {INSIGHTS.map((l, i) => <button key={l} type="button" className="save-btn sk-u-house" data-i={i} aria-pressed="false">{l}</button>)}
        </div>
        <label className="label-mono" htmlFor={`skRange${uid}`}>Time of day — day to night</label>
        <input id={`skRange${uid}`} className="sk-range" type="range" min="0" max="100" step="1" defaultValue="0" />
        <p className="sk-under-status" aria-hidden="true" />
      </div>
    </div>
  );
}
