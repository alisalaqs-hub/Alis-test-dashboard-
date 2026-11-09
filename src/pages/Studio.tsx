import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getProperty, PROPERTIES } from '../data/properties';
import { designCost, fitBudget, parseDesignBrief, planLayout, STYLES, TIERS, type Dims, type RoomType, type Style, type Tier } from '../engine/design';
import { engagementFor } from '../engine/engagement';
import { track } from '../engine/tracking';
import { gbp, gbpK, Meter, Section, Seg, Tag } from '../components/ui';
import { useStore } from '../store';
import { ApiError, mediaUrl } from '../lib/api';
import { useAi } from '../lib/ai/core';
import { CONDITION_LABEL, describePhoto, designBrief, generateRoomImage, ROOM_IMAGE_PROGRESS, type DesignBriefResult, type RoomAnalysis } from '../lib/ai/studio';
import { AiCard, AiDisclaimer, AiLabel, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/studio.css';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

const PAINTS = [['Original', ''], ['Chalk white', '#f3f1ea'], ['Warm stone', '#e3d8c6'], ['Sage', '#c9d3c0'], ['Dusky blue', '#c3cdd6'], ['Clay', '#d9b8a3'], ['Deep green', '#4b5d52']] as const;

function RoomArt({ room, s, before, wall, staged }: { room: RoomType; s: Style; before: boolean; wall?: string; staged: boolean }) {
  const dated = { wall: '#e8d9b5', cab: '#b5813f', top: '#6a5c4a', floor: '#c8b796', accent: '#7a6a55' };
  const c = before ? dated : { ...s.palette, wall: wall || s.palette.wall };
  const showFurniture = !before && staged;
  return (
    <svg viewBox="0 0 400 250" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label={before ? 'Before illustration' : 'Concept illustration'}>
      <rect width="400" height="250" fill={c.wall} />
      <rect x="0" y="190" width="400" height="60" fill={c.floor} />
      {!before && s.id === 'industrial' && Array.from({ length: 9 }).map((_, r) => Array.from({ length: 12 }).map((__, k) => <rect key={`${r}-${k}`} x={k * 34 + (r % 2) * 17} y={r * 14} width={32} height={12} fill="#a5644b" opacity={0.3} />))}
      <rect x="150" y="30" width="100" height="70" fill="#cfe3ee" stroke={before ? '#f6f2e6' : c.accent} strokeWidth={6} />
      {room === 'kitchen' && <>
        <rect x="20" y="130" width="360" height="60" fill={c.cab} />
        {Array.from({ length: 6 }).map((_, k) => <rect key={k} x={24 + k * 60} y={136} width={52} height={50} fill="none" stroke={before ? '#8d6532' : 'rgba(255,255,255,.18)'} strokeWidth={2} />)}
        <rect x="16" y="124" width="368" height="8" fill={c.top} />
        <rect x="20" y="30" width="110" height="60" fill={c.cab} /><rect x="270" y="30" width="110" height="60" fill={c.cab} />
        {!before && <><line x1="120" y1="0" x2="120" y2="40" stroke="#222" /><circle cx="120" cy="44" r="7" fill={c.accent} /><line x1="280" y1="0" x2="280" y2="40" stroke="#222" /><circle cx="280" cy="44" r="7" fill={c.accent} /></>}
        {showFurniture && <><rect x="140" y="200" width="120" height="10" fill="#5a4636" /><rect x="150" y="210" width="6" height="30" fill="#5a4636" /><rect x="244" y="210" width="6" height="30" fill="#5a4636" /></>}
      </>}
      {room === 'bathroom' && <>
        <rect x="30" y="140" width="190" height="50" rx={before ? 4 : 18} fill={before ? '#f0ece2' : '#fbfbf8'} stroke="#ccc" />
        <rect x="270" y="110" width="80" height="40" fill={c.cab} /><ellipse cx="310" cy="112" rx="28" ry="7" fill="#fff" />
        {!before && Array.from({ length: 10 }).map((_, k) => <line key={k} x1={20 + k * 21} y1={60} x2={20 + k * 21} y2={140} stroke={c.accent} opacity={0.18} />)}
      </>}
      {(room === 'living' || room === 'bedroom') && <>
        {(before || showFurniture) && (room === 'living'
          ? <><rect x="40" y="140" width="200" height="45" rx={10} fill={before ? '#8a7a68' : c.cab} /><rect x="50" y="120" width="180" height="30" rx={10} fill={before ? '#8a7a68' : c.cab} opacity={0.85} /><rect x="120" y="195" width="200" height="30" rx={4} fill={c.accent} opacity={0.3} /></>
          : <><rect x="90" y="140" width="220" height="50" rx={6} fill={before ? '#bfae96' : '#fbfaf7'} stroke="#d6d0c4" /><rect x="90" y="110" width="220" height="34" rx={6} fill={before ? '#8a7a68' : c.cab} /></>)}
        {!before && <><rect x="300" y="80" width="60" height="110" fill="none" stroke={c.accent} strokeWidth={4} /><circle cx="330" cy="70" r="18" fill={c.accent} opacity={0.4} /></>}
      </>}
      <text x="12" y="240" fontSize="11" fill="#000" opacity="0.45" fontFamily="sans-serif">{before ? 'BEFORE' : 'CONCEPT'} · illustrative</text>
    </svg>
  );
}

function LayoutPlan({ room, dims }: { room: RoomType; dims: Dims }) {
  const plan = planLayout(room, dims);
  const s = 60; // px per metre
  return (
    <div>
      <svg viewBox={`-10 -10 ${plan.W * s + 20} ${plan.L * s + 20}`} width="100%" className="layout-plan" role="img" aria-label="Furniture layout plan">
        <rect x={0} y={0} width={plan.W * s} height={plan.L * s} fill="var(--surface)" stroke="var(--ink)" strokeWidth={4} />
        <rect x={plan.W * s * 0.4} y={-4} width={60} height={8} fill="#9cc3dd" />
        <rect x={-4} y={plan.L * s - 60} width={8} height={50} fill="var(--accent)" />
        {plan.placed.map((p) => <g key={p.name}><rect x={p.x * s} y={p.y * s} width={p.w * s} height={p.d * s} rx={4} fill="var(--ai-soft)" stroke="var(--ai)" /><text x={p.x * s + 4} y={p.y * s + 13} fontSize={10} fill="var(--ink)">{p.name}</text></g>)}
      </svg>
      <div className="row between xs muted" style={{ marginTop: 4 }}><span>{plan.W.toFixed(1)}m × {plan.L.toFixed(1)}m · {Math.round(plan.free * 100)}% free floor</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: '#9cc3dd' }} /> window · <i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--accent)' }} /> door</span></div>
      <ul className="ticks small" style={{ marginTop: 8 }}>{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}

export default function Studio() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const prop = getProperty(params.get('property') ?? '') ?? PROPERTIES[0];
  const [room, setRoom] = useState<RoomType>((params.get('room') as RoomType) || 'kitchen');
  const [styleId, setStyleId] = useState(params.get('style') || 'modern');
  const [tier, setTier] = useState<Tier>((params.get('tier') as Tier) || STYLES.find((s) => s.id === (params.get('style') || 'modern'))!.tier);
  const [dims, setDims] = useState<Dims>({ width: 4.2, length: 3.4, height: 2.5 });
  const [paint, setPaint] = useState('');
  const [staged, setStaged] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, Tier>>({});
  const [tab, setTab] = useState<'finishes' | 'layout' | 'budget'>('finishes');
  const [brief, setBrief] = useState('Redesign this living room for £5,000');
  const [budget, setBudget] = useState(8_000);
  const [briefMsg, setBriefMsg] = useState('');
  const [pos, setPos] = useState(50);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [ai, setAi] = useState<{ url: string; style: string; label: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState('');
  const [aiLeft, setAiLeft] = useState<number | null>(null);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiProgress, setAiProgress] = useState('');
  const [plan, setPlan] = useState<DesignBriefResult | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefNote, setBriefNote] = useState('');
  const [analysis, setAnalysis] = useState<{ analysis: RoomAnalysis; label: string } | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisErr, setAnalysisErr] = useState('');
  const aiState = useAi();
  const aiOn = aiState.available;
  const user = aiState.user;
  const online = aiState.reason !== 'offline' && aiState.reason !== 'checking';
  const jobRef = useRef<AbortController | null>(null);
  useEffect(() => () => jobRef.current?.abort(), []);
  const generate = async () => {
    if (!photoFile) return;
    jobRef.current?.abort();
    const ctrl = new AbortController(); jobRef.current = ctrl;
    const styleName = style.name;
    setAiBusy(true); setAiErr(''); setAiProgress('Uploading your photo…');
    try {
      const r = await generateRoomImage(photoFile, { room, style: styleId, brief: brief.trim() || undefined, palette: [paint, style.palette.wall, style.palette.accent].filter(Boolean).join(',') }, { onProgress: setAiProgress, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setAi({ url: mediaUrl(r.image.url!), style: styleName, label: r.label }); setAiLeft(r.remainingToday); setPos(50);
    } catch (e) {
      if (!ctrl.signal.aborted) setAiErr(errText(e));
    } finally {
      if (jobRef.current === ctrl) { setAiBusy(false); setAiProgress(''); jobRef.current = null; }
    }
  };
  const analyse = async () => {
    if (!photoFile) return;
    setAnalysisBusy(true); setAnalysisErr('');
    try {
      const r = await describePhoto(photoFile);
      setAnalysis(r);
      if (r.analysis.isRoom) {
        if (r.analysis.room) setRoom(r.analysis.room);
        const first = STYLES.find((x) => x.id === r.analysis.suggestedStyleIds[0]);
        if (first) { setStyleId(first.id); setTier(r.analysis.suggestedTier); setPaint(''); }
        setOverrides({});
      }
    } catch (e) { setAnalysisErr(errText(e)); } finally { setAnalysisBusy(false); }
  };
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { designs, saveDesign, enqueue } = useStore();
  const style = STYLES.find((s) => s.id === styleId)!;
  const furniture = (room === 'living' || room === 'bedroom') && staged;
  const cost = useMemo(() => designCost(room, tier, dims, prop.postcode, { furniture, overrides }), [room, tier, dims, prop.postcode, furniture, overrides]);
  const fit = useMemo(() => fitBudget(room, budget, dims, prop.postcode, furniture), [room, budget, dims, prop.postcode, furniture]);
  const portfolioStyles = useMemo(() => { const m = new Map<string, number>(); PROPERTIES.filter((p) => p.listing !== 'rent').forEach((p) => engagementFor(p).designStyles.forEach((s) => m.set(s.style, (m.get(s.style) ?? 0) + s.count))); return [...m].sort((a, b) => b[1] - a[1]); }, []);

  const pickStyle = (s: Style) => { setStyleId(s.id); setTier(s.tier); setOverrides({}); setPaint(''); track('design_style', prop.id, { style: s.name }); };
  const drag = (x: number) => { const r = ref.current?.getBoundingClientRect(); if (r) setPos(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))); };
  const runBrief = async () => {
    setBriefNote('');
    if (aiOn && brief.trim().length >= 3) {
      setBriefBusy(true);
      try {
        const p = await designBrief({ text: brief.trim(), room, postcode: prop.postcode, dims, staged });
        setRoom(p.room); setStyleId(p.styleId); setTier(p.tier); setOverrides({}); setPaint('');
        if (p.budget != null) { setBudget(p.budget); setTab('budget'); }
        setPlan(p); setBriefMsg(p.message); if (p.note) setBriefNote(p.note);
        track('design_style', prop.id, { style: p.styleName });
        return;
      } catch (e) {
        setBriefNote(`${errText(e)} Streetkey’s built-in brief reader was used instead.`);
      } finally { setBriefBusy(false); }
    }
    runBriefRules();
  };
  const runBriefRules = () => {
    setPlan(null);
    const b = parseDesignBrief(brief);
    const r = b.room ?? room; if (b.room) setRoom(b.room);
    if (b.budget) {
      setBudget(b.budget); setTab('budget');
      const f = fitBudget(r, b.budget, dims, prop.postcode, r === 'living' || r === 'bedroom');
      const chosen = b.style ? f.fits.find((x) => x.style.id === b.style) ?? f.best : f.best;
      if (chosen) { setStyleId(chosen.style.id); setTier(chosen.style.tier); setOverrides({}); setBriefMsg(`Best fit for £${b.budget.toLocaleString('en-GB')}: ${chosen.style.name} (${chosen.style.tier}) at ${gbp(chosen.cost.total)} incl. VAT — ${gbp(b.budget - chosen.cost.total)} headroom.`); }
      else setBriefMsg(`£${b.budget.toLocaleString('en-GB')} is below the cheapest package for this ${r} (${gbp(f.cheapest.cost.total)} for ${f.cheapest.style.name}). Consider decoration and lighting only, or a smaller scope.`);
    } else if (b.style) { const s = STYLES.find((x) => x.id === b.style)!; pickStyle(s); setBriefMsg(`Applied ${s.name}.`); }
    else setBriefMsg('Tell me the room and a budget or style, e.g. “Give this kitchen a luxury appearance for £8,000”.');
  };
  const shareUrl = `${window.location.origin}${window.location.pathname}#/studio?property=${prop.id}&room=${room}&style=${styleId}&tier=${tier}`;
  const groups = [...new Set(cost.lines.map((l) => l.group))];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI interior design studio</div><h2 style={{ marginTop: 6 }}>Redesign any room — and know what it costs</h2>
          <p className="muted" style={{ marginTop: 6 }}>For {prop.street.replace(' (fictional)', '')}, {prop.town} · labour priced for {cost.regionLabel} (×{cost.regionFactor}).</p></div>
        <div className="row"><Tag kind="warn">Concept visualisation — not a construction design</Tag>{aiOn ? <Tag kind="ai">AI photo redesign: on</Tag> : <Tag kind="neutral">{online ? 'AI photo redesign: not switched on yet' : 'AI photo redesign: on the live site'}</Tag>}</div>
      </div>

      <div className="card ai-card">
        <div className="ask" style={{ boxShadow: 'none' }}>
          <textarea rows={1} value={brief} maxLength={600} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!briefBusy) void runBrief(); } }} aria-label="Design brief: the room, a style or a budget" />
          <button type="button" className="btn accent sm" onClick={() => void runBrief()} disabled={briefBusy} aria-busy={briefBusy || undefined}>{briefBusy ? 'Designing…' : 'Design it'}</button>
        </div>
        <div className="chips" style={{ marginTop: 8 }}>{['Redesign this living room for £5,000', 'Modernise this rental flat bathroom for £4,000', 'Give this kitchen a luxury appearance for £8,000', 'Scandinavian bedroom for £3,500, keep the wooden floor'].map((x) => <button type="button" key={x} className="chip xs" onClick={() => setBrief(x)}>{x}</button>)}</div>
        {briefBusy && <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>Reading your brief…</div>}
        {briefNote && <p className="xs muted" role="status" style={{ marginTop: 8 }}>{briefNote}</p>}
        {briefMsg && !briefBusy && <div className="msg ai" style={{ maxWidth: '100%', marginTop: 10 }} role="status">{plan?.engine === 'ai' ? <AiLabel>Streetkey AI</AiLabel> : <Tag kind="neutral">Built-in rules</Tag>} {briefMsg}</div>}
        {plan?.engine === 'ai' && !briefBusy && (plan.priorities.length > 0 || plan.keep.length > 0 || plan.materials.length > 0 || plan.notes) && <div className="sk-studio-panel" style={{ marginTop: 10 }}>
          {(plan.priorities.length > 0 || plan.keep.length > 0) && <div className="sk-two">
            {plan.priorities.length > 0 && <div><p className="sk-list-h">What matters most</p><ul className="sk-list">{plan.priorities.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            {plan.keep.length > 0 && <div><p className="sk-list-h">Keep</p><ul className="sk-list">{plan.keep.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          </div>}
          {plan.materials.length > 0 && <div className="table-wrap" tabIndex={0} aria-label="Suggested materials"><table className="sk-materials"><caption className="sr-only">Suggested materials and why</caption>
            <thead><tr><th scope="col">Item</th><th scope="col">Specification</th><th scope="col">Why</th></tr></thead>
            <tbody>{plan.materials.map((m) => <tr key={`${m.item}-${m.spec}`}><td>{m.item}</td><td>{m.spec}</td><td className="muted">{m.why}</td></tr>)}</tbody></table></div>}
          {plan.notes && <p className="small" style={{ margin: 0 }}>{plan.notes}</p>}
          <AiDisclaimer>Suggestions by Streetkey AI. Costs are Streetkey’s indicative design-to-cost estimate, not quotes.</AiDisclaimer>
        </div>}
        {!aiOn && <AiUnavailable reason={aiState.reason} feature="The AI design brief reader" />}
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 14 }}>
          <div className="row between">
            <Seg value={room} onChange={(r) => { setRoom(r); setOverrides({}); }} options={[{ value: 'kitchen', label: 'Kitchen' }, { value: 'bathroom', label: 'Bathroom' }, { value: 'living', label: 'Living room' }, { value: 'bedroom', label: 'Bedroom' }]} />
            <div className="row">
              {(room === 'living' || room === 'bedroom' || room === 'kitchen') && <label className="check"><input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />Virtual staging</label>}
              <label className="btn ghost sm sk-upload" style={{ cursor: 'pointer' }}><input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) { jobRef.current?.abort(); if (photo) URL.revokeObjectURL(photo); setPhoto(URL.createObjectURL(f)); setPhotoFile(f); setAi(null); setAiErr(''); setAnalysis(null); setAnalysisErr(''); } }} />{photo ? 'Change room photo' : 'Upload room photo'}</label>
            </div>
          </div>
          <div ref={ref} className="ba card" style={{ padding: 0 }} onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag(e.clientX); }} onPointerMove={(e) => e.buttons && drag(e.clientX)}>
            {ai ? <span className="watermark">AI-GENERATED CONCEPT</span> : photo ? <span className="watermark">COLOUR PREVIEW · NOT AI</span> : staged && (room === 'living' || room === 'bedroom' || room === 'kitchen') && <span className="watermark">VIRTUALLY STAGED</span>}
            <div>{ai ? <img src={ai.url} alt={`AI concept: ${ai.style} ${room}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : photo ? <><img src={photo} alt="Your room" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /><div style={{ position: 'absolute', inset: 0, background: paint || style.palette.cab, mixBlendMode: 'color', opacity: 0.45 }} /></> : <RoomArt room={room} s={style} before={false} wall={paint} staged={staged} />}</div>
            <div style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>{photo ? <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <RoomArt room={room} s={style} before wall="" staged={false} />}</div>
            <div className="handle" style={{ left: `${pos}%` }} />
          </div>
          {photo && <div className="card ai-gen stack">
            <div className="row between"><b>Use AI on this photo</b>{aiLeft != null && <span className="xs muted">{aiLeft} AI design{aiLeft === 1 ? '' : 's'} left today</span>}</div>
            {aiOn && user ? <>
              <p className="small muted">Streetkey AI can analyse the room to suggest a style, and redesign it as <b>{style.name}</b>{brief.trim() ? <> following your brief</> : ''} while keeping the walls, windows and layout. A redesign usually takes under a minute.</p>
              <label className="check"><input type="checkbox" checked={aiConsent} onChange={(e) => setAiConsent(e.target.checked)} />I’m happy for this photo to be sent to our AI provider (OpenAI) to analyse or redesign it. It isn’t used to train their models.</label>
              <div className="sk-actions">
                <button type="button" className="btn ghost" disabled={analysisBusy || aiBusy || !aiConsent} aria-busy={analysisBusy || undefined} onClick={() => void analyse()}>{analysisBusy ? 'Analysing…' : analysis ? 'Analyse again' : 'Analyse this room'}</button>
                <button type="button" className="btn accent" disabled={aiBusy || !aiConsent} aria-busy={aiBusy || undefined} onClick={() => void generate()}>{aiBusy ? 'Designing your room…' : ai ? `Try again as ${style.name}` : `Generate ${style.name} design`}</button>
                {aiBusy && <button type="button" className="btn ghost sm" onClick={() => { jobRef.current?.abort(); setAiBusy(false); setAiProgress(''); }}>Stop waiting</button>}
              </div>
              {!aiConsent && <p className="xs muted">Tick the box above to use AI on this photo.</p>}
              {analysisBusy && <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>Looking at your room…</div>}
              {aiBusy && <div className="sk-studio-progress">
                <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{aiProgress || ROOM_IMAGE_PROGRESS}</div>
                <div className="sk-studio-bar" aria-hidden="true"><i /></div>
                <p className="xs muted">You can keep exploring finishes and costs while you wait. The finished design is also saved in <Link to="/account/designs">your AI designs</Link>.</p>
              </div>}
              {aiErr && <div className="ai-error" role="alert"><span>{aiErr}</span><button type="button" className="linkish" onClick={() => void generate()} disabled={!aiConsent}>Try again</button></div>}
              {analysisErr && <div className="ai-error" role="alert"><span>{analysisErr}</span></div>}
              {ai && !aiBusy && <p className="xs muted" role="status">{ai.label} Drag the slider to compare. Saved in <Link to="/account/designs">your AI designs</Link>.</p>}
              {analysis && !analysisBusy && (analysis.analysis.isRoom ? <AiCard title="What Streetkey AI sees in this room" tone="quiet" footer={<AiDisclaimer>{analysis.label}</AiDisclaimer>}>
                <div className="row small"><span>Condition: <b>{CONDITION_LABEL[analysis.analysis.condition]}</b></span>{analysis.analysis.room && <span>· Room: <b>{analysis.analysis.room === 'living' ? 'living room' : analysis.analysis.room}</b></span>}</div>
                <div className="sk-two">
                  <div><p className="sk-list-h">Worth keeping</p>{analysis.analysis.keepWorthy.length ? <ul className="sk-list">{analysis.analysis.keepWorthy.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nothing in particular.</p>}</div>
                  <div><p className="sk-list-h">To address</p>{analysis.analysis.problems.length ? <ul className="sk-list">{analysis.analysis.problems.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nothing obvious.</p>}</div>
                </div>
                {analysis.analysis.suggestedStyleIds.length > 0 && <div><p className="sk-list-h" id="sk-suggested">Suggested styles</p><div className="sk-style-suggest" role="group" aria-labelledby="sk-suggested">{analysis.analysis.suggestedStyleIds.map((id) => { const st = STYLES.find((x) => x.id === id); return st ? <button type="button" key={id} className="chip xs" aria-pressed={styleId === id} onClick={() => pickStyle(st)}>{st.name}</button> : null; })}</div></div>}
                {analysis.analysis.notes && <p className="small" style={{ margin: 0 }}>{analysis.analysis.notes}</p>}
              </AiCard> : <p className="callout small" role="status">This doesn’t look like a photo of a room. Try a photo taken from a corner, showing the walls and window.</p>)}
            </> : aiOn ? <p className="small"><Link to="/account">Sign in or create a free account</Link> to analyse this room or generate a photo-real redesign. The preview above is a simple colour wash, not AI.</p>
              : online ? <p className="small muted">AI photo redesign isn’t switched on on this server yet. The preview above is a simple colour wash, not AI.</p>
              : <p className="small muted">This preview has no server, so the “after” is a simple colour wash, not AI. On the live Streetkey site, the AI redesigns your actual photo in the style you choose. Your photo stays in your browser here.</p>}
          </div>}

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {STYLES.map((s) => (
              <button key={s.id} className="card flat" onClick={() => pickStyle(s)} style={{ textAlign: 'left', padding: 10, cursor: 'pointer', borderColor: s.id === styleId ? 'var(--ink)' : undefined, borderWidth: s.id === styleId ? 2 : 1 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>{[s.palette.wall, s.palette.cab, s.palette.floor, s.palette.accent].map((c, i) => <div key={i} className="swatch" style={{ background: c }} />)}</div>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 6 }}>{s.name}</div>
                <div className="xs muted">{s.note}</div>
                <div className="xs num" style={{ marginTop: 4 }}>{gbpK(designCost(room, s.tier, dims, prop.postcode, { furniture }).total)}</div>
              </button>
            ))}
          </div>

          <section className="card">
            <div className="pill-tabs"><Seg value={tab} onChange={setTab} options={[{ value: 'finishes', label: 'Materials & finishes' }, { value: 'layout', label: 'Layout planner' }, { value: 'budget', label: 'Budget designer' }]} /></div>
            {tab === 'finishes' && <div className="stack">
              <label className="field">Overall specification<Seg value={tier} onChange={(t) => { setTier(t); setOverrides({}); }} options={TIERS.map((t) => ({ value: t, label: t }))} /></label>
              <div className="eyebrow" style={{ marginTop: 6 }}>Paint colour</div>
              <div className="row">{PAINTS.map(([n, c]) => <button key={n} title={n} onClick={() => setPaint(c)} className="save-btn" style={{ borderColor: paint === c ? 'var(--ink)' : undefined }}><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: c || style.palette.wall, border: '1px solid var(--line)', verticalAlign: 'middle', marginRight: 6 }} />{n}</button>)}</div>
              <div className="table-wrap" tabIndex={0} style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Element</th><th>Specification</th></tr></thead>
                <tbody>{cost.lines.filter((l) => l.code !== 'STAGE').map((l) => <tr key={l.code}><td className="small">{l.name}</td><td><select className="input" aria-label={`${l.name} specification`} value={overrides[l.code] ?? tier} onChange={(e) => setOverrides((o) => ({ ...o, [l.code]: e.target.value as Tier }))}>{TIERS.map((t) => <option key={t} value={t}>{t} — {designCost(room, t, dims, prop.postcode, { overrides: {} }).lines.find((x) => x.code === l.code)?.spec}</option>)}</select></td></tr>)}</tbody></table></div>
            </div>}
            {tab === 'layout' && <div className="stack">
              <div className="grid g3" style={{ gap: 10 }}>
                <label className="field">Width (m)<input className="input num" type="number" step={0.1} value={dims.width} onChange={(e) => setDims({ ...dims, width: Math.max(1.5, Number(e.target.value) || 1.5) })} /></label>
                <label className="field">Length (m)<input className="input num" type="number" step={0.1} value={dims.length} onChange={(e) => setDims({ ...dims, length: Math.max(1.5, Number(e.target.value) || 1.5) })} /></label>
                <label className="field">Ceiling (m)<input className="input num" type="number" step={0.1} value={dims.height} onChange={(e) => setDims({ ...dims, height: Math.max(2, Number(e.target.value) || 2.4) })} /></label>
              </div>
              <LayoutPlan room={room} dims={dims} />
              <p className="xs muted">Dimensions also drive quantities in the cost schedule. Production reads dimensions from uploaded floor plans.</p>
            </div>}
            {tab === 'budget' && <div className="stack">
              <label className="field">Budget incl. VAT: <b className="num">{gbp(budget)}</b><input type="range" min={1500} max={40000} step={500} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label>
              {fit.best ? <div className="callout ok small">Best fit: <b>{fit.best.style.name}</b> ({fit.best.style.tier}) at {gbp(fit.best.cost.total)} — {gbp(fit.headroom)} headroom. <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => pickStyle(fit.best!.style)}>Apply</button></div> : <div className="callout small">Below the cheapest package ({fit.cheapest.style.name}, {gbp(fit.cheapest.cost.total)}). Short by {gbp(-fit.headroom)}.</div>}
              <ul className="clean small">{STYLES.map((s) => { const c = designCost(room, s.tier, dims, prop.postcode, { furniture }).total; return <li key={s.id} className="row between"><span>{c <= budget ? '✅' : '—'} {s.name} <span className="xs muted">({s.tier})</span></span><span className="num">{gbp(c)}</span></li>; })}</ul>
            </div>}
          </section>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <section className="card ink">
            <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Design-to-cost · {style.name} {room}</div>
            <div className="num" style={{ fontSize: 40, marginTop: 6 }}>{gbp(cost.total)}</div>
            <div className="muted small">incl. VAT · materials {gbpK(cost.materials)} · labour {gbpK(cost.labour)} · ≈{cost.weeks} week{cost.weeks > 1 ? 's' : ''} on site</div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn accent sm" onClick={() => { saveDesign({ propertyId: prop.id, room, style: style.name, budget, total: cost.total }); }}>Save design</button>
              <button className="btn ghost sm" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.3)' }} onClick={() => { setParams({ property: prop.id, room, style: styleId, tier }); try { void navigator.clipboard?.writeText(shareUrl); } catch { /* ignore */ } setCopied(true); }}>{copied ? 'Link copied' : 'Share link'}</button>
            </div>
          </section>
          <Section title="Material & labour schedule" kicker="Indicative" right={<Tag kind="est" />}>
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Mat.</th><th className="r">Lab.</th></tr></thead>
              <tbody>{groups.map((g) => cost.lines.filter((l) => l.group === g).map((l) => <tr key={l.code}><td className="small">{l.name}<div className="xs muted">{l.spec}</div></td><td className="r num xs">{l.qty} {l.unit}</td><td className="r num xs">{gbpK(l.materials)}</td><td className="r num xs">{gbpK(l.labour)}</td></tr>))}</tbody>
              <tfoot>
                <tr><td colSpan={3}>Prelims, OH&P (18%)</td><td className="r num">{gbpK(cost.prelimsOhp)}</td></tr>
                <tr><td colSpan={3}>Contingency (8%)</td><td className="r num">{gbpK(cost.contingency)}</td></tr>
                <tr><td colSpan={3}>VAT (20%)</td><td className="r num">{gbpK(cost.vat)}</td></tr>
              </tfoot>
            </table></div>
            <div className="stack" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => { enqueue([{ id: `rfq-${Date.now()}`, agent: 'contractor', title: `Send ${style.name} ${room} scope to 3 verified contractors`, detail: `${cost.lines.length}-line schedule, budget ${gbp(cost.total)}`, consequential: true }]); nav('/marketplace'); }}>Request contractor quotes</button>
              <Link className="btn ghost" to={`/invest?property=${prop.id}&refurb=${cost.total}&label=${encodeURIComponent(`${style.name} ${room}`)}`}>Use in investment analysis →</Link>
              <Link className="btn ghost" to={`/estimate?property=${prop.id}`}>Add to whole-house estimate →</Link>
            </div>
          </Section>
          <Section title="Saved designs" kicker="Compare concepts">
            {designs.length === 0 ? <p className="small muted">Save concepts to compare them side by side or share with contractors, agents or family.</p> :
              <ul className="clean small">{designs.slice(0, 6).map((d) => <li key={d.id} className="row between"><span>{d.style} {d.room} <span className="xs muted">· {getProperty(d.propertyId)?.town.split(',')[0]}</span></span><span className="num">{gbpK(d.total)}</span></li>)}</ul>}
          </Section>
          <Section title="Design engagement intelligence" kicker="Styles explored across Streetkey" right={<Tag kind="obs">Aggregated</Tag>}>
            {portfolioStyles.slice(0, 6).map(([s, n]) => <Meter key={s} label={s} value={n} max={portfolioStyles[0][1]} display={n.toLocaleString('en-GB')} color="var(--accent)" />)}
            <p className="xs muted" style={{ marginTop: 8 }}>Simulated aggregate across demo listings. Owners and agents see this per listing to shape marketing and refurbishment decisions.</p>
          </Section>
        </div>
      </div>
    </div>
  );
}
