import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** £ amount; negatives as "−£1,250" (a true minus sign, matching money()); "—" when there is no real figure. */
export const gbp = (n: number, dp = 0) => {
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: dp, minimumFractionDigits: dp });
  return n < 0 && /[1-9]/.test(s) ? `−${s}` : s;
};
/** Short £ amount: £950, £1.3k, £182k, £1.25m; negatives as "−£182k"; "—" when there is no real figure. */
export const gbpK = (n: number) => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 999_500) return `${sign}£${(a / 1_000_000).toFixed(2)}m`;
  if (a >= 10_000) return `${sign}£${Math.round(a / 1_000)}k`;
  if (a >= 1_000) return `${sign}£${(a / 1_000).toFixed(1)}k`;
  return gbp(n);
};
/** Fraction as a percentage (0.052 → "5.2%"); "—" for a division by zero or other non-figure. */
export const pct = (n: number, dp = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : '—');

type TagKind = 'demo' | 'est' | 'ai' | 'ok' | 'live' | 'neutral' | 'warn' | 'obs' | 'inf' | 'rec';
const TAG_TEXT: Partial<Record<TagKind, string>> = { demo: 'Demo data', est: 'Estimate', ai: 'AI-generated', ok: 'Verified', live: 'Needs live integration', obs: 'Observed', inf: 'Inferred', rec: 'Recommendation' };
export function Tag({ kind, children, title }: { kind: TagKind; children?: ReactNode; title?: string }) {
  return <span className={`tag tag-${kind}`} title={title}>{children ?? TAG_TEXT[kind]}</span>;
}

export function Stat({ label, value, sub, big, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; big?: boolean; tone?: 'pos' | 'neg' }) {
  return (
    <div className={`stat${big ? ' big' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export interface SegOption<T extends string> { value: T; label: string; /** Fuller name for screen readers when the visible label is short (e.g. 'B' → 'Budget'). */ ariaLabel?: string; disabled?: boolean }

/**
 * A row of options that behaves like a radio group (WAI-ARIA pattern): one Tab stop (the chosen option),
 * Arrow keys / Home / End move and choose, and the group has a name.
 * Name it with aria-labelledby (the id of the visible heading, preferred) or aria-label. Placed inside a
 * <label className="field">, the label's own text names the group and clicking that text no longer
 * changes the choice; a <div className="field"> with a <span id> heading is the better markup.
 */
export function Seg<T extends string>({ value, options, onChange, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, id, className, disabled }: {
  value: T; options: SegOption<T>[]; onChange: (v: T) => void;
  'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string; id?: string; className?: string; disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const named = !!(ariaLabel || labelledBy);
  // Inside a <label>: name the group from the label's own text, and stop clicks on that text "pressing" the first option.
  useLayoutEffect(() => {
    const el = root.current;
    const lab = el?.parentElement?.closest('label');
    if (!el || !lab) return;
    if (!named) {
      const text = Array.from(lab.childNodes).filter((n) => !n.contains(el)).map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) el.setAttribute('aria-label', text); else el.removeAttribute('aria-label');
    }
    const stop = (e: MouseEvent) => { if (!el.contains(e.target as Node)) e.preventDefault(); };
    lab.addEventListener('click', stop);
    return () => lab.removeEventListener('click', stop);
  }, [named]);

  const usable = (i: number) => !disabled && !options[i]?.disabled;
  const checked = options.findIndex((o) => o.value === value);
  const tabStop = checked >= 0 && usable(checked) ? checked : options.findIndex((_, i) => usable(i));
  const pick = (i: number) => {
    if (!usable(i)) return;
    btns.current[i]?.focus();
    if (options[i].value !== value) onChange(options[i].value);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    const step = (from: number, dir: 1 | -1) => { for (let k = 1; k <= n; k++) { const j = (from + dir * k + n) % n; if (usable(j)) return j; } return from; };
    let to: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = step(i, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = step(i, -1);
    else if (e.key === 'Home') to = step(-1 + n, 1) % n;
    else if (e.key === 'End') to = step(n, -1);
    if (to == null) return;
    e.preventDefault();
    pick(to);
  };
  return (
    <div ref={root} id={id} className={`seg${className ? ` ${className}` : ''}`} role="radiogroup"
      aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-disabled={disabled || undefined}>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { btns.current[i] = el; }} type="button" role="radio"
          aria-checked={o.value === value} aria-label={o.ariaLabel ?? o.label} className={o.value === value ? 'on' : ''}
          tabIndex={i === tabStop ? 0 : -1} disabled={disabled || o.disabled}
          onClick={() => { if (o.value !== value) onChange(o.value); }} onKeyDown={(e) => onKey(e, i)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ───────────── Number fields ───────────── */

interface NumberRules {
  min?: number; max?: number; integer?: boolean;
  /** Unit for messages, e.g. 'm²' ("Enter a number from 20 m² to 20,000 m²") or '%'. */
  unit?: string;
  /** Shown before the figure in messages and inside the box, e.g. '£'. */
  prefix?: string;
  /** The box shows value × scale (Pct: 0.055 shows as 5.5); min/max are in what the person types. */
  scale?: number;
  /** Decimal places shown for the current value (Money 0, Pct 2). */
  dp?: number;
}

const fmtRule = (n: number, r: NumberRules) => `${r.prefix ?? ''}${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}${r.unit ? (r.unit === '%' ? '%' : ` ${r.unit}`) : ''}`;

/** What's wrong with what the person typed (null: fine, or not finished yet). */
export function numberProblem(raw: string, r: NumberRules): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return 'Enter a number.';
  if (r.integer && !Number.isInteger(n)) return 'Enter a whole number.';
  const lo = r.min != null && n < r.min, hi = r.max != null && n > r.max;
  if (!lo && !hi) return null;
  if (r.min != null && r.max != null) return `Enter ${r.integer ? 'a whole number' : 'a number'} from ${fmtRule(r.min, r)} to ${fmtRule(r.max, r)}.`;
  return lo ? `Enter ${fmtRule(r.min!, r)} or more.` : `Enter ${fmtRule(r.max!, r)} or less.`;
}

/**
 * Typing state for a number box. What the person types is kept as typed (an empty box or a part-typed
 * number is fine mid-edit); a value is passed on only once it's a valid number within the limits, so
 * figures never jump to a clamped or half-typed number. On leaving the box (or Enter) an empty box goes
 * back to the last value and an out-of-range one shows why, instead of being rewritten.
 */
export function useNumberDraft(value: number, onChange: (n: number) => void, r: NumberRules, onValidityChange?: (valid: boolean) => void) {
  const scale = r.scale ?? 1;
  const toText = (v: number) => (Number.isFinite(v) ? String(r.dp != null ? +(v * scale).toFixed(r.dp) : +(v * scale).toPrecision(12)) : '');
  const [text, setText] = useState(() => toText(value));
  const [shown, setShown] = useState<string | null>(null);
  const committed = useRef(value);
  // A change from outside (reset, prefill, an AI suggestion applied) replaces what's in the box.
  useEffect(() => {
    if (Object.is(value, committed.current)) return;
    committed.current = value;
    setText(toText(value));
    setShown(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const problem = numberProblem(text, r);
  const valid = problem == null;
  const report = useRef(onValidityChange);
  useLayoutEffect(() => { report.current = onValidityChange; });
  const reported = useRef(true);
  useEffect(() => { if (reported.current !== valid) { reported.current = valid; report.current?.(valid); } }, [valid]);

  const change = (raw: string) => {
    setText(raw);
    const p = numberProblem(raw, r);
    if (p == null) {
      setShown(null);
      if (raw.trim() !== '') {
        const v = Number(raw) / scale;
        if (!Object.is(v, committed.current)) { committed.current = v; onChange(v); }
      }
    } else if (shown) setShown(p); // already explaining a problem: keep it up to date while they fix it
  };
  const finish = () => {
    if (text.trim() === '') { setText(toText(committed.current)); setShown(null); return; }
    if (problem) setShown(problem);
    else setText(toText(committed.current)); // tidy, e.g. "085" → "85"
  };
  return { text, error: shown, valid, change, finish };
}

export interface NumberFieldProps extends NumberRules {
  label: ReactNode; value: number; onChange: (n: number) => void;
  step?: number | 'any'; hint?: ReactNode; id?: string; name?: string; className?: string; inputClassName?: string;
  disabled?: boolean; required?: boolean; placeholder?: string;
  /** Told when the box holds something that can't be used (so a page can hold back an action until it's fixed). */
  onValidityChange?: (valid: boolean) => void;
  'aria-describedby'?: string;
}

/**
 * A labelled number box (see useNumberDraft): typing is never rewritten, limits are explained next to the
 * box (and announced), and min/max are also set on the input for the browser's own steppers.
 */
export function NumberField({ label, value, onChange, min, max, integer, unit, prefix, scale, dp, step, hint, id, name, className, inputClassName = 'input num', disabled, required, placeholder, onValidityChange, 'aria-describedby': describedBy }: NumberFieldProps) {
  const auto = useId();
  const inputId = id ?? `nf${auto}`;
  const hintId = `${inputId}-hint`, errId = `${inputId}-err`;
  const d = useNumberDraft(value, onChange, { min, max, integer, unit, prefix, scale, dp }, onValidityChange);
  const input = (
    <input id={inputId} name={name} className={inputClassName} type="number" inputMode={integer ? 'numeric' : 'decimal'}
      min={min} max={max} step={step ?? (integer ? 1 : 'any')} value={d.text} disabled={disabled} required={required} placeholder={placeholder}
      aria-invalid={d.error ? true : undefined}
      aria-describedby={[hint ? hintId : '', d.error ? errId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
      onChange={(e) => d.change(e.target.value)} onBlur={d.finish} onKeyDown={(e) => { if (e.key === 'Enter') d.finish(); }} />
  );
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={inputId}>{label}</label>
      {prefix ? <div className="input-prefix"><span aria-hidden="true">{prefix}</span>{input}</div> : input}
      {hint && <span id={hintId} className="xs muted">{hint}</span>}
      {/* Always present (empty until needed) so the message is announced when it appears. */}
      <span id={errId} className="field-error xs" aria-live="polite" style={d.error ? undefined : { position: 'absolute' }}>{d.error ?? ''}</span>
    </div>
  );
}

export function Money({ label, value, onChange, step = 1000, min, max, hint, onValidityChange, id }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; hint?: ReactNode; onValidityChange?: (valid: boolean) => void; id?: string }) {
  return <NumberField label={label} value={value} onChange={onChange} prefix="£" dp={0} step={step} min={min} max={max} hint={hint} onValidityChange={onValidityChange} id={id} />;
}

export function Pct({ label, value, onChange, step = 0.1, min, max, hint, onValidityChange, id }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; hint?: ReactNode; onValidityChange?: (valid: boolean) => void; id?: string }) {
  return <NumberField label={label} value={value} onChange={onChange} unit="%" scale={100} dp={2} step={step} min={min} max={max} hint={hint} onValidityChange={onValidityChange} id={id} />;
}

export function Meter({ label, value, max, display, color }: { label: ReactNode; value: number; max: number; display?: ReactNode; color?: string }) {
  return (
    <div className="meter-row">
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div className="bar"><i style={{ width: `${Math.max(2, Math.min(100, (value / max) * 100))}%`, background: color }} /></div>
      <span className="num r" style={{ textAlign: 'right' }}>{display ?? value}</span>
    </div>
  );
}

export function Spark({ data, height = 48, color = 'var(--accent)', fill = true }: { data: number[]; height?: number; color?: string; fill?: boolean }) {
  const w = 240;
  const min = Math.min(...data), max = Math.max(...data);
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, height - 4 - ((d - min) / (max - min || 1)) * (height - 8)]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
      {fill && <path d={`${path} L${w},${height} L0,${height} Z`} fill={color} opacity={0.12} />}
      <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Stacked horizontal bar for cost composition. */
export function Stacked({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div>
      <div style={{ display: 'flex', height: 14, borderRadius: 99, overflow: 'hidden', gap: 2 }}>
        {parts.map((p) => <div key={p.label} title={`${p.label}: ${gbp(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
      </div>
      <div className="row" style={{ marginTop: 10, gap: 14 }}>
        {parts.map((p) => (
          <span key={p.label} className="xs row" style={{ gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 3, background: p.color, display: 'inline-block' }} />{p.label} <span className="num">{gbpK(p.value)}</span></span>
        ))}
      </div>
    </div>
  );
}

/** Generated facade illustration — the demo has no licensed listing photography. */
export function HouseArt({ hue, type, seed = 1, after = false }: { hue: number; type: string; seed?: number; after?: boolean }) {
  const brick = after ? `hsl(${hue} 18% 86%)` : `hsl(${hue} 42% ${type === 'flat' ? 62 : 48}%)`;
  const sky = after ? 'hsl(205 60% 86%)' : `hsl(${(hue + 190) % 360} 30% 82%)`;
  const door = after ? '#1f3b33' : `hsl(${(hue + seed * 70) % 360} 45% 35%)`;
  const frame = after ? '#1b1f24' : '#f5f2ea';
  const flat = type === 'flat';
  const det = type === 'detached' || type === 'bungalow';
  return (
    <svg viewBox="0 0 320 240" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustrative facade (not a photograph)">
      <rect width="320" height="240" fill={sky} />
      <circle cx={260} cy={46} r={18} fill="#fff" opacity={0.5} />
      {!flat && <polygon points={det ? '40,92 160,30 280,92' : '0,92 60,40 260,40 320,92'} fill={after ? '#3b4249' : `hsl(${hue} 15% 30%)`} />}
      {!flat && <rect x={det ? 210 : 230} y={det ? 40 : 22} width={18} height={30} fill={after ? '#3b4249' : `hsl(${hue} 20% 34%)`} />}
      <rect x={det ? 40 : 0} y={flat ? 20 : 92} width={det ? 240 : 320} height={flat ? 220 : 148} fill={brick} />
      {flat && Array.from({ length: 3 }).map((_, r) => Array.from({ length: 4 }).map((__, c) => <rect key={`${r}${c}`} x={28 + c * 72} y={40 + r * 62} width={44} height={40} fill="#cfd8de" stroke={frame} strokeWidth={4} />))}
      {!flat && <>
        <rect x={det ? 70 : 34} y={108} width={58} height={44} fill={after ? '#bfd3dc' : '#c7cfd4'} stroke={frame} strokeWidth={5} />
        <rect x={det ? 192 : 196} y={108} width={58} height={44} fill={after ? '#bfd3dc' : '#c7cfd4'} stroke={frame} strokeWidth={5} />
        <path d={`M${det ? 70 : 24} 240 v-62 h${det ? 70 : 92} v62`} fill={after ? '#dfe7ea' : '#c4ccd1'} stroke={frame} strokeWidth={5} />
        <rect x={det ? 150 : 130} y={170} width={36} height={70} fill={door} />
        <circle cx={det ? 178 : 158} cy={206} r={2.5} fill="#e7c76b" />
        <rect x={det ? 148 : 128} y={164} width={40} height={6} fill={frame} />
      </>}
      {after && <rect x={0} y={232} width={320} height={8} fill="#5d7a5a" />}
    </svg>
  );
}

/* ---------- Schematic UK map (no tile provider needed) ---------- */
const GB: [number, number][] = [[-3.03,58.64],[-3.1,58.44],[-3.65,58.12],[-4.2,57.48],[-3.28,57.72],[-2.0,57.69],[-2.1,57.15],[-2.47,56.7],[-2.6,56.28],[-3.1,55.98],[-2.5,56.0],[-2.0,55.77],[-1.6,55.3],[-1.4,55.0],[-1.2,54.7],[-0.6,54.48],[-0.08,54.12],[0.12,53.58],[0.34,53.14],[0.3,52.9],[1.3,52.93],[1.75,52.48],[1.35,51.96],[0.95,51.6],[0.7,51.53],[1.4,51.38],[1.33,51.12],[0.6,50.85],[-0.14,50.82],[-1.1,50.78],[-2.45,50.6],[-3.4,50.6],[-3.64,50.22],[-5.2,49.96],[-5.7,50.07],[-5.08,50.42],[-4.5,51.0],[-3.47,51.2],[-2.7,51.5],[-3.17,51.45],[-3.94,51.6],[-5.3,51.88],[-4.66,52.1],[-4.08,52.41],[-4.6,52.85],[-4.5,53.4],[-3.83,53.33],[-3.05,53.42],[-3.05,53.82],[-2.9,54.07],[-3.25,54.1],[-3.6,54.5],[-3.2,54.95],[-4.1,54.8],[-4.86,54.64],[-4.65,55.46],[-4.9,55.95],[-5.8,55.3],[-5.47,56.4],[-5.83,57.0],[-5.7,57.5],[-5.16,57.9],[-5.0,58.62],[-3.53,58.6]];
const NI: [number, number][] = [[-5.45,54.55],[-5.95,55.2],[-6.8,55.2],[-7.3,55.05],[-8.1,54.5],[-7.5,54.1],[-6.3,54.05],[-5.6,54.3]];
const K = 52, LAT0 = 58.9, LNG0 = -8.4, COS = Math.cos((54.5 * Math.PI) / 180);
export const project = (lng: number, lat: number) => [(lng - LNG0) * COS * K, (LAT0 - lat) * K] as const;
const poly = (pts: [number, number][]) => pts.map(([lng, lat]) => project(lng, lat).map((v) => v.toFixed(1)).join(',')).join(' ');

export interface MapPin { id: string; lat: number; lng: number; label: string; tone?: string; active?: boolean }
export function UKMap({ pins, onPin, height }: { pins: MapPin[]; onPin?: (id: string) => void; height?: number }) {
  const [w, h] = [(10.5) * COS * K, 9.3 * K];
  return (
    <div className="map-wrap" style={height ? { height } : undefined}>
      <svg viewBox={`0 0 ${w.toFixed(0)} ${h.toFixed(0)}`} style={height ? { height: '100%' } : undefined} role="img" aria-label="Schematic map of the UK with property pins">
        <defs><pattern id="dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="var(--blue)" opacity="0.18" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#dots)" />
        <polygon points={poly(GB)} fill="var(--surface)" stroke="var(--line)" strokeWidth={1.5} />
        <polygon points={poly(NI)} fill="var(--surface)" stroke="var(--line)" strokeWidth={1.5} />
        {pins.map((p) => {
          const [x, y] = project(p.lng, p.lat);
          return (
            <g key={p.id} transform={`translate(${x},${y})`} style={{ cursor: onPin ? 'pointer' : 'default' }} onClick={() => onPin?.(p.id)}>
              <circle r={p.active ? 15 : 9} fill={p.tone ?? 'var(--accent)'} opacity={0.18} />
              <circle r={p.active ? 7 : 5} fill={p.tone ?? 'var(--accent)'} stroke="var(--surface)" strokeWidth={2} />
              {p.active && <text x={12} y={4} fontSize={12} fontFamily="var(--sans)" fontWeight={600} fill="var(--ink)" paintOrder="stroke" stroke="var(--surface)" strokeWidth={4}>{p.label}</text>}
            </g>
          );
        })}
      </svg>
      <div className="map-note"><Tag kind="live">Schematic · production: OS Maps API / Mapbox + PostGIS</Tag></div>
    </div>
  );
}

export function Section({ title, kicker, right, children }: { title: ReactNode; kicker?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>{kicker && <div className="eyebrow" style={{ marginBottom: 4 }}>{kicker}</div>}<h3>{title}</h3></div>
        {right && <div className="row">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function download(filename: string, content: string, type = 'text/csv') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
