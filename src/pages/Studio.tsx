import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getProperty, PROPERTIES } from '../data/properties';
import { designCost, fitBudget, parseDesignBrief, planLayout, STUDIO_BUDGET, studioBudget, STYLES, TIERS, type Dims, type RoomType, type Style, type Tier } from '../engine/design';
import { regionFromPostcode } from '../engine/refurb';
import { engagementFor } from '../engine/engagement';
import { track } from '../engine/tracking';
import { gbp, gbpK, Meter, Section, Seg, Tag } from '../components/ui';
import { useStore } from '../store';
import { ApiError, mediaUrl } from '../lib/api';
import { announce, signInPath, useAi } from '../lib/ai/core';
import { CONDITION_LABEL, describePhoto, designBrief, generateRoomImage, imageAllowance, keepStudioPhoto, photoProblem, readStudioDraft, ROOM_IMAGE_PROGRESS, saveStudioDraft, takeStudioPhoto, type DesignBriefResult, type RoomAnalysis } from '../lib/ai/studio';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiUnavailable } from '../components/ai/Ai';
import '../components/ai/studio.css';

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

const ROOM_IDS: RoomType[] = ['kitchen', 'bathroom', 'living', 'bedroom'];
const ROOM_NAME: Record<RoomType, string> = { kitchen: 'kitchen', bathroom: 'bathroom', living: 'living room', bedroom: 'bedroom' };
const BRIEF_EXAMPLES = ['Redesign this living room for £5,000', 'Modernise this rental flat bathroom for £4,000', 'Give this kitchen a luxury appearance for £8,000', 'Scandinavian bedroom for £3,500, keep the wooden floor'];
const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.'));
/** Letters, digits and single spaces only, as the server expects: "m14-5rq" becomes "M14 5RQ". */
const cleanPostcode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/^ /, '');
const LIMIT_CODES = new Set(['quota', 'site_quota']);
const rangeNote = (asked: number, shown: number) => `The budget designer below works between ${gbp(STUDIO_BUDGET.min)} and ${gbp(STUDIO_BUDGET.max)}, so it shows ${gbp(shown)} rather than ${gbp(asked)}.`;

export default function Studio() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  /** The listing the studio was opened for (?property=), if any. Without one, the person's own postcode prices the work. */
  const linked = getProperty(params.get('property') ?? '');
  const draft = useMemo(() => readStudioDraft(), []);
  const startStyle = STYLES.find((s) => s.id === params.get('style')) ?? STYLES[0];
  const [room, setRoom] = useState<RoomType>(() => (ROOM_IDS as string[]).includes(params.get('room') ?? '') ? params.get('room') as RoomType : 'kitchen');
  const [styleId, setStyleId] = useState(startStyle.id);
  const [tier, setTier] = useState<Tier>(() => (TIERS as string[]).includes(params.get('tier') ?? '') ? params.get('tier') as Tier : startStyle.tier);
  const [dims, setDims] = useState<Dims>(draft.dims ?? { width: 4.2, length: 3.4, height: 2.5 });
  const [paint, setPaint] = useState(draft.paint ?? '');
  const [staged, setStaged] = useState(draft.staged ?? true);
  const [overrides, setOverrides] = useState<Record<string, Tier>>({});
  const [tab, setTab] = useState<'finishes' | 'layout' | 'budget'>('finishes');
  // Empty until the person writes or picks a brief: an example is never sent as theirs.
  const [brief, setBrief] = useState(draft.brief ?? '');
  const [budget, setBudget] = useState(draft.budget ?? 8_000);
  const [postcodeInput, setPostcodeInput] = useState(() => cleanPostcode(draft.postcode ?? ''));
  const [briefMsg, setBriefMsg] = useState('');
  const [pos, setPos] = useState(50);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoMsg, setPhotoMsg] = useState('');
  const [ai, setAi] = useState<{ url: string; style: string; room: RoomType; label: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  /** The last thing that went wrong with AI on the photo (one message, whichever action it was). */
  const [photoErr, setPhotoErr] = useState<{ error: ApiError; action: 'analyse' | 'generate' } | null>(null);
  const [aiLeft, setAiLeft] = useState<number | null>(null);
  const [siteFull, setSiteFull] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [aiProgress, setAiProgress] = useState('');
  const [plan, setPlan] = useState<DesignBriefResult | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefNote, setBriefNote] = useState('');
  const [analysis, setAnalysis] = useState<{ analysis: RoomAnalysis; label: string } | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const aiState = useAi();
  const aiOn = aiState.available;
  const user = aiState.user;
  const aiReason = aiState.reason;
  const unverified = !!user && user.emailVerified === false;
  const verifyNote = useMemo(() => new ApiError(403, 'Confirm your email address to analyse or redesign photos with AI. We sent you a link when you signed up (check your spam folder too).', 'verify_email'), []);
  const uid = useId();
  const jobRef = useRef<AbortController | null>(null);
  const analysisSeq = useRef(0);
  const roomRef = useRef(room); roomRef.current = room;
  const styleRef = useRef(styleId); styleRef.current = styleId;
  const fileRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  /** When the daily limit the server last reported (the person's or the whole site's) resets, if it said. */
  const limitUntil = useRef(0);
  useEffect(() => () => jobRef.current?.abort(), []);

  // Coming back from signing in: the photo kept in memory for this tab, and the draft from this session.
  useEffect(() => {
    const kept = takeStudioPhoto();
    if (kept) { setPhoto(URL.createObjectURL(kept)); setPhotoFile(kept); }
  }, []);
  useEffect(() => { saveStudioDraft({ brief, postcode: postcodeInput, dims, budget, paint, staged }); }, [brief, postcodeInput, dims, budget, paint, staged]);

  // Today's AI designs left, from the server's count (it includes designs still running after "Stop waiting").
  const userId = user?.id;
  const refreshAllowance = useCallback(() => {
    if (!aiOn || !userId) return;
    void imageAllowance().then((a) => { if (a) setAiLeft(a.left); });
  }, [aiOn, userId]);
  useEffect(() => { refreshAllowance(); }, [refreshAllowance]);

  const style = STYLES.find((s) => s.id === styleId)!;
  const ownPostcode = postcodeInput.trim().toUpperCase();
  const ownRegion = !linked && ownPostcode ? regionFromPostcode(ownPostcode) : null;
  const pricingPostcode = linked?.postcode ?? (ownRegion ? ownPostcode : '');
  const furniture = (room === 'living' || room === 'bedroom') && staged;
  const cost = useMemo(() => designCost(room, tier, dims, pricingPostcode, { furniture, overrides }), [room, tier, dims, pricingPostcode, furniture, overrides]);
  const fit = useMemo(() => fitBudget(room, budget, dims, pricingPostcode, furniture), [room, budget, dims, pricingPostcode, furniture]);
  const portfolioStyles = useMemo(() => { const m = new Map<string, number>(); PROPERTIES.filter((p) => p.listing !== 'rent').forEach((p) => engagementFor(p).designStyles.forEach((s) => m.set(s.style, (m.get(s.style) ?? 0) + s.count))); return [...m].sort((a, b) => b[1] - a[1]); }, []);
  const pricedFor = linked || ownRegion ? `${cost.regionLabel} (×${cost.regionFactor})` : 'the UK average (×1.00)';

  // The brief goes with a redesign only when the person wrote it and it's about the room being redesigned.
  const briefText = brief.trim();
  const briefRoom = briefText ? parseDesignBrief(briefText).room : undefined;
  const briefClash = !!briefRoom && briefRoom !== room;
  const sentBrief = briefText && !briefClash ? briefText : undefined;

  const outOfDesigns = aiLeft === 0;
  const atLimit = outOfDesigns || siteFull;
  const generate = async () => {
    if (!photoFile || aiBusy) return;
    if (atLimit) {
      if (limitUntil.current && Date.now() >= limitUntil.current) {
        limitUntil.current = 0; setSiteFull(false); setAiLeft(null); // the limit has reset since: try again
      } else {
        // Generate stays focusable at the limit (disabling it would drop keyboard focus to the page): say why instead.
        const shown = photoErr?.action === 'generate' && LIMIT_CODES.has(photoErr.error.code);
        if (shown) announce(photoErr.error.message, 'assertive');
        else {
          const secs = limitUntil.current ? Math.ceil((limitUntil.current - Date.now()) / 1000) : 0;
          const msg = siteFull ? 'Streetkey’s AI designer has reached its limit for today across the whole site. The colour preview and costs still work.'
            : 'You’ve used today’s AI designs. You can still analyse the room, and the colour preview and costs still work.';
          setPhotoErr({ error: new ApiError(429, msg, siteFull ? 'site_quota' : 'quota', secs > 0 ? { retryAfter: String(secs) } : {}), action: 'generate' });
        }
        if (!siteFull) refreshAllowance(); // in case the day has turned over
        return;
      }
    }
    jobRef.current?.abort();
    const ctrl = new AbortController(); jobRef.current = ctrl;
    const styleName = style.name;
    const forRoom = room;
    setAiBusy(true); setPhotoErr(null); setAiProgress('Uploading your photo…');
    let quota = false;
    try {
      const r = await generateRoomImage(photoFile, { room: forRoom, style: styleId, brief: sentBrief, palette: [paint, style.palette.wall, style.palette.accent].filter(Boolean).join(',') }, { onProgress: setAiProgress, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setAi({ url: mediaUrl(r.image.url!), style: styleName, room: forRoom, label: r.label }); setAiLeft(r.remainingToday); setPos(50);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const err = asApiError(e);
        if (err.code === 'quota') { setAiLeft(0); quota = true; }
        if (err.code === 'site_quota') setSiteFull(true);
        if (LIMIT_CODES.has(err.code)) { const secs = Number(err.fields?.retryAfter); limitUntil.current = Number.isFinite(secs) && secs > 0 ? Date.now() + secs * 1000 : 0; }
        setPhotoErr({ error: err, action: 'generate' });
      }
    } finally {
      if (jobRef.current === ctrl) { setAiBusy(false); setAiProgress(''); jobRef.current = null; }
      if (!quota) refreshAllowance(); // the server's "used up" answer is the latest word
    }
  };
  const stopWaiting = () => {
    jobRef.current?.abort(); jobRef.current = null;
    setAiBusy(false); setAiProgress('');
    refreshAllowance(); // the design keeps going on the server and still counts
    requestAnimationFrame(() => generateRef.current?.focus());
  };
  const analyse = async () => {
    if (!photoFile || analysisBusy) return;
    const my = ++analysisSeq.current;
    const startRoom = room, startStyleId = styleId;
    setAnalysisBusy(true); setPhotoErr(null);
    try {
      const r = await describePhoto(photoFile);
      if (my !== analysisSeq.current) return; // a newer photo replaced the one this was about
      setAnalysis(r);
      if (r.analysis.isRoom) {
        // Suggestions apply only to what the person hasn't changed while the analysis ran.
        const roomFree = roomRef.current === startRoom;
        const styleFree = styleRef.current === startStyleId;
        if (r.analysis.room && roomFree) setRoom(r.analysis.room);
        const first = STYLES.find((x) => x.id === r.analysis.suggestedStyleIds[0]);
        if (first && styleFree) { setStyleId(first.id); setTier(r.analysis.suggestedTier); setPaint(''); }
        if ((r.analysis.room && roomFree) || (first && styleFree)) setOverrides({});
      }
    } catch (e) {
      if (my === analysisSeq.current) setPhotoErr({ error: asApiError(e), action: 'analyse' });
    } finally {
      if (my === analysisSeq.current) setAnalysisBusy(false);
    }
  };
  const choosePhoto = async (f: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''; // so the same file can be chosen again
    if (!f) return;
    const problem = await photoProblem(f);
    if (problem) { setPhotoMsg(problem); return; } // the photo already there (if any) stays
    setPhotoMsg('');
    jobRef.current?.abort(); jobRef.current = null; setAiBusy(false); setAiProgress('');
    analysisSeq.current++; setAnalysisBusy(false); // an analysis of the old photo no longer applies
    if (photo) URL.revokeObjectURL(photo);
    setPhoto(URL.createObjectURL(f)); setPhotoFile(f);
    setAi(null); setPhotoErr(null); setAnalysis(null);
    setAiConsent(false); // the consent was for the previous photo
  };

  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { designs, saveDesign, enqueue } = useStore();

  const pickStyle = (s: Style) => { setStyleId(s.id); setTier(s.tier); setOverrides({}); setPaint(''); track('design_style', linked?.id ?? '', { style: s.name }); };
  const drag = (x: number) => { const r = ref.current?.getBoundingClientRect(); if (r) setPos(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))); };
  const sliderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 1 : 5;
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? pos - step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? pos + step
      : e.key === 'PageDown' ? pos - 25 : e.key === 'PageUp' ? pos + 25 : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null;
    if (next === null) return;
    e.preventDefault();
    setPos(Math.max(0, Math.min(100, next)));
  };
  /** Put a budget the brief gave into the budget designer, saying so if it had to be moved into range. */
  const applyBudget = (n: number) => {
    const b = studioBudget(n);
    setBudget(b.value); setTab('budget');
    return b.clamped ? rangeNote(n, b.value) : '';
  };
  const runBrief = async () => {
    if (briefBusy) return;
    setBriefNote('');
    if (aiOn && briefText.length >= 3) {
      setBriefBusy(true);
      try {
        const p = await designBrief({ text: briefText, room, postcode: pricingPostcode || undefined, dims, staged });
        setRoom(p.room); setStyleId(p.styleId); setTier(p.tier); setOverrides({}); setPaint('');
        const range = p.budget != null ? applyBudget(p.budget) : '';
        setPlan(p); setBriefMsg(p.message);
        setBriefNote([p.note, range].filter(Boolean).join(' '));
        track('design_style', linked?.id ?? '', { style: p.styleName });
        return;
      } catch (e) {
        runBriefRules(`${asApiError(e).message} Streetkey’s built-in brief reader was used instead.`);
        return;
      } finally { setBriefBusy(false); }
    }
    runBriefRules();
  };
  const runBriefRules = (note = '') => {
    setPlan(null);
    const b = parseDesignBrief(brief);
    const r = b.room ?? room; if (b.room) { setRoom(b.room); setOverrides({}); }
    let range = '';
    if (b.budget) {
      range = applyBudget(b.budget);
      const f = fitBudget(r, b.budget, dims, pricingPostcode, r === 'living' || r === 'bedroom');
      const asked = b.style ? STYLES.find((x) => x.id === b.style) : undefined;
      const askedFits = asked ? f.fits.find((x) => x.style.id === asked.id) : undefined;
      const chosen = askedFits ?? f.best;
      // Say so when the style the brief asked for doesn't fit, rather than quietly swapping it.
      const instead = asked && !askedFits ? `${asked.name} (${asked.tier}) would be about ${gbp(designCost(r, asked.tier, dims, pricingPostcode, { furniture: r === 'living' || r === 'bedroom' }).total)}, over your budget. ` : '';
      if (chosen) { setStyleId(chosen.style.id); setTier(chosen.style.tier); setOverrides({}); setBriefMsg(`${instead}Best fit for ${gbp(b.budget)}: ${chosen.style.name} (${chosen.style.tier}) at ${gbp(chosen.cost.total)} incl. VAT — ${gbp(b.budget - chosen.cost.total)} headroom.`); }
      else setBriefMsg(`${gbp(b.budget)} is below the cheapest package for this ${ROOM_NAME[r]} (${gbp(f.cheapest.cost.total)} for ${f.cheapest.style.name}). Consider decoration and lighting only, or a smaller scope.`);
    } else if (b.style) { const s = STYLES.find((x) => x.id === b.style)!; pickStyle(s); setBriefMsg(`Applied ${s.name}${b.room ? ` to the ${ROOM_NAME[b.room]}` : ''}.`); }
    else if (b.room) setBriefMsg(`Switched to the ${ROOM_NAME[b.room]}. Add a style or a budget, e.g. “${ROOM_NAME[b.room]} in Scandinavian style for £5,000”.`);
    else setBriefMsg('Tell me the room and a budget or style, e.g. “Give this kitchen a luxury appearance for £8,000”.');
    setBriefNote([note, range].filter(Boolean).join(' '));
  };
  // A contractor quote request waits in the approval queue. Only a new request goes on to the marketplace; a repeat or a
  // full queue is explained here (in the same words as the agent pages), and the button keeps focus.
  const quoteTitle = `Send ${style.name} ${ROOM_NAME[room]} scope to 3 verified contractors`;
  const [quoteNote, setQuoteNote] = useState<{ title: string; text: string } | null>(null);
  const shownQuoteNote = quoteNote?.title === quoteTitle ? quoteNote.text : '';
  const requestQuotes = () => {
    const r = enqueue([{ id: `rfq-${Date.now()}`, agent: 'contractor', title: quoteTitle, detail: `${cost.lines.length}-line schedule, budget ${gbp(cost.total)}`, consequential: true }]);
    if (r.added.length) { nav('/marketplace', { state: { queued: `Quote request for the ${style.name} ${ROOM_NAME[room]}: added to the approval queue.` } }); return; }
    const text = r.duplicates.length ? 'This quote request is already waiting in the approval queue.'
      : r.full.length ? 'The approval queue is full. Approve or reject some waiting items first.' : '';
    if (!text) return;
    if (text === shownQuoteNote) announce(text); // the same words again: the status line wouldn't be re-read
    else setQuoteNote({ title: quoteTitle, text });
  };
  const studioQuery = () => new URLSearchParams({ ...(linked ? { property: linked.id } : {}), room, style: styleId, tier }).toString();
  const shareUrl = `${window.location.origin}${window.location.pathname}#/studio?${studioQuery()}`;
  const groups = [...new Set(cost.lines.map((l) => l.group))];
  const beforeName = photo ? 'your photo' : 'the room before';
  const afterName = ai ? 'the AI design' : photo ? 'the colour preview' : 'the concept';

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI interior design studio</div><h2 style={{ marginTop: 6 }}>Redesign any room — and know what it costs</h2>
          <p className="muted" style={{ marginTop: 6 }}>{linked ? <>For {linked.street.replace(' (fictional)', '')}, {linked.town} · labour priced for {pricedFor}.</> : <>Labour priced for {pricedFor}.</>}</p>
          {!linked && <div className="sk-postcode">
            <label className="small" htmlFor={`${uid}-pc`}>Your postcode, for local labour prices</label>
            <input id={`${uid}-pc`} className="input mono" value={postcodeInput} maxLength={8} autoComplete="postal-code" placeholder="e.g. M14 5RQ" aria-describedby={`${uid}-pc-h`} onChange={(e) => setPostcodeInput(cleanPostcode(e.target.value))} />
            <span className="xs muted" id={`${uid}-pc-h`} role="status">{ownPostcode && !ownRegion ? 'We don’t recognise that postcode yet, so prices use the UK average.' : ownRegion ? `Prices for ${cost.regionLabel}.` : 'The start of your postcode is enough (e.g. M14).'}</span>
          </div>}
        </div>
        <div className="row"><Tag kind="warn">Concept visualisation — not a construction design</Tag>{aiOn ? <Tag kind="ai">AI photo redesign: on</Tag> : aiReason !== 'checking' && <Tag kind="neutral">{aiReason === 'paused' ? 'AI photo redesign: temporarily unavailable' : aiReason === 'disabled' ? 'AI photo redesign: not switched on yet' : 'AI photo redesign: on the live site'}</Tag>}</div>
      </div>

      <div className="card ai-card">
        <div className="ask" style={{ boxShadow: 'none' }}>
          <textarea rows={1} value={brief} maxLength={600} placeholder={`e.g. ${BRIEF_EXAMPLES[0]}`} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!briefBusy) void runBrief(); } }} aria-label="Design brief: the room, a style or a budget" />
          <button type="button" className="btn accent sm" onClick={() => void runBrief()} aria-disabled={briefBusy || undefined} aria-busy={briefBusy || undefined}>{briefBusy ? 'Designing…' : 'Design it'}</button>
        </div>
        <div className="chips" style={{ marginTop: 8 }} role="group" aria-label="Example briefs">{BRIEF_EXAMPLES.map((x) => <button type="button" key={x} className="chip xs" onClick={() => setBrief(x)}>{x}</button>)}</div>
        {briefBusy && <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>Reading your brief…</div>}
        {briefNote && <p className="xs muted" role="status" style={{ marginTop: 8 }}>{briefNote}</p>}
        {briefMsg && !briefBusy && <div className="msg ai" style={{ maxWidth: '100%', marginTop: 10 }} role="status">{plan?.engine === 'ai' ? <AiLabel>Streetkey AI</AiLabel> : <Tag kind="neutral">Built-in rules</Tag>} {briefMsg}</div>}
        {plan?.engine === 'ai' && !briefBusy && (plan.priorities.length > 0 || plan.keep.length > 0 || plan.materials.length > 0 || plan.notes) && <div className="sk-studio-panel" style={{ marginTop: 10 }}>
          {(plan.priorities.length > 0 || plan.keep.length > 0) && <div className="sk-two">
            {plan.priorities.length > 0 && <div><h3 className="sk-list-h">What matters most</h3><ul className="sk-list">{plan.priorities.map((x) => <li key={x}>{x}</li>)}</ul></div>}
            {plan.keep.length > 0 && <div><h3 className="sk-list-h">Keep</h3><ul className="sk-list">{plan.keep.map((x) => <li key={x}>{x}</li>)}</ul></div>}
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
            <Seg aria-label="Room" value={room} onChange={(r) => { setRoom(r); setOverrides({}); }} options={ROOM_IDS.map((r) => ({ value: r, label: r === 'living' ? 'Living room' : ROOM_NAME[r].charAt(0).toUpperCase() + ROOM_NAME[r].slice(1) }))} />
            <div className="row">
              {(room === 'living' || room === 'bedroom' || room === 'kitchen') && <label className="check"><input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />Virtual staging</label>}
              <label className="btn ghost sm sk-upload" style={{ cursor: 'pointer' }}><input ref={fileRef} type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" aria-describedby={photoMsg ? `${uid}-photo-msg` : undefined} onChange={(e) => void choosePhoto(e.target.files?.[0])} />{photo ? 'Change room photo' : 'Upload room photo'}</label>
            </div>
          </div>
          {photoMsg && <p className="callout small" id={`${uid}-photo-msg`} role="alert" style={{ margin: 0 }}>{photoMsg}</p>}
          <div ref={ref} className="ba card" style={{ padding: 0 }} onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag(e.clientX); handleRef.current?.focus({ preventScroll: true }); }} onPointerMove={(e) => e.buttons && drag(e.clientX)}>
            {ai ? <span className="watermark">AI-GENERATED CONCEPT</span> : photo ? <span className="watermark">COLOUR PREVIEW · NOT AI</span> : staged && (room === 'living' || room === 'bedroom' || room === 'kitchen') && <span className="watermark">VIRTUALLY STAGED</span>}
            <div>{ai ? <img src={ai.url} alt={`AI concept: ${ai.style} ${ROOM_NAME[ai.room]}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : photo ? <><img src={photo} alt="Your room with a colour preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /><div style={{ position: 'absolute', inset: 0, background: paint || style.palette.cab, mixBlendMode: 'color', opacity: 0.45 }} /></> : <RoomArt room={room} s={style} before={false} wall={paint} staged={staged} />}</div>
            <div style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>{photo ? <img src={photo} alt={ai ? 'Your original photo' : ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <RoomArt room={room} s={style} before wall="" staged={false} />}</div>
            <div ref={handleRef} className="handle" style={{ left: `${pos}%` }} role="slider" tabIndex={0} aria-label="Before and after comparison" aria-orientation="horizontal"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos)} aria-valuetext={`${Math.round(pos)}% ${beforeName}, ${100 - Math.round(pos)}% ${afterName}`} aria-describedby={`${uid}-ba-help`} onKeyDown={sliderKey} />
          </div>
          <p className="xs muted" id={`${uid}-ba-help`} style={{ margin: '-6px 0 0' }}>Drag the slider or use the arrow keys to compare before and after.</p>
          {photo && <div className="card ai-gen stack">
            <div className="row between"><b>Use AI on this photo</b>{aiLeft != null && <span className="xs muted">{aiLeft} AI design{aiLeft === 1 ? '' : 's'} left today</span>}</div>
            {aiOn && user ? <>
              <p className="small muted">Streetkey AI can analyse the room to suggest a style, and redesign it as <b>{style.name}</b>{sentBrief ? <> following your brief</> : ''} while keeping the walls, windows and layout. A redesign usually takes under a minute.</p>
              {unverified && photoErr?.error.code !== 'verify_email' && <AiErrorNote error={verifyNote} />}
              <label className="check"><input type="checkbox" checked={aiConsent} onChange={(e) => setAiConsent(e.target.checked)} />I’m happy for this photo to be sent to our AI provider (OpenAI) to analyse or redesign it. It isn’t used to train their models.</label>
              <div className="sk-actions">
                <AiButton kind="ghost" busy={analysisBusy} busyLabel="Analysing…" disabled={!aiConsent} onClick={() => void analyse()}>{analysis ? 'Analyse again' : 'Analyse this room'}</AiButton>
                <AiButton ref={generateRef} busy={aiBusy} busyLabel="Designing your room…" disabled={!aiConsent} aria-describedby={atLimit && !photoErr ? `${uid}-brief-sent ${uid}-limit` : `${uid}-brief-sent`} onClick={() => void generate()}>{ai ? `Try again as ${style.name}` : `Generate ${style.name} design`}</AiButton>
                {aiBusy && <button type="button" className="btn ghost sm" onClick={stopWaiting}>Stop waiting</button>}
              </div>
              <p className="xs muted" id={`${uid}-brief-sent`} style={{ margin: 0 }}>{sentBrief ? <>Your brief goes with the redesign: <q>{sentBrief}</q></>
                : briefClash ? <>Your brief is about a {ROOM_NAME[briefRoom!]}, so it won’t be sent with this {ROOM_NAME[room]} redesign. Choose the {ROOM_NAME[briefRoom!]} or change the brief to use it.</>
                : <>No brief: the redesign follows the {style.name} style. Write one above to add your own requests.</>}</p>
              {!aiConsent && <p className="xs muted" style={{ margin: 0 }}>Tick the box above to use AI on this photo.</p>}
              {atLimit && !photoErr && <p className="xs muted" id={`${uid}-limit`} style={{ margin: 0 }}>{siteFull ? 'Streetkey’s AI designer has reached its limit for today across the whole site.' : 'You’ve used today’s AI designs.'} You can still analyse the room, and the colour preview and costs still work.</p>}
              {analysisBusy && <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>Looking at your room…</div>}
              {aiBusy && <div className="sk-studio-progress">
                <div className="ai-thinking" role="status" aria-live="polite"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{aiProgress || ROOM_IMAGE_PROGRESS}</div>
                <div className="sk-studio-bar" aria-hidden="true"><i /></div>
                <p className="xs muted">You can keep exploring finishes and costs while you wait. The finished design is also saved in <Link to="/account/designs">your AI designs</Link>.</p>
              </div>}
              {photoErr && <AiErrorNote error={photoErr.error} onRetry={!aiConsent || (photoErr.action === 'generate' && atLimit) ? undefined : photoErr.action === 'generate' ? () => void generate() : () => void analyse()} />}
              {ai && !aiBusy && <p className="xs muted" role="status">{ai.label} Drag the slider or use the arrow keys to compare. Saved in <Link to="/account/designs">your AI designs</Link>.</p>}
              {analysis && !analysisBusy && (analysis.analysis.isRoom ? <AiCard title="What Streetkey AI sees in this room" tone="quiet" focusKey={analysis} footer={<AiDisclaimer>{analysis.label}</AiDisclaimer>}>
                <div className="row small"><span>Condition: <b>{CONDITION_LABEL[analysis.analysis.condition]}</b></span>{analysis.analysis.room && <span>· Room: <b>{ROOM_NAME[analysis.analysis.room]}</b></span>}</div>
                <div className="sk-two">
                  <div><h4 className="sk-list-h">Worth keeping</h4>{analysis.analysis.keepWorthy.length ? <ul className="sk-list">{analysis.analysis.keepWorthy.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nothing in particular.</p>}</div>
                  <div><h4 className="sk-list-h">To address</h4>{analysis.analysis.problems.length ? <ul className="sk-list">{analysis.analysis.problems.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nothing obvious.</p>}</div>
                </div>
                {analysis.analysis.suggestedStyleIds.length > 0 && <div><h4 className="sk-list-h" id={`${uid}-suggested`}>Suggested styles</h4><div className="sk-style-suggest" role="group" aria-labelledby={`${uid}-suggested`}>{analysis.analysis.suggestedStyleIds.map((id) => { const st = STYLES.find((x) => x.id === id); return st ? <button type="button" key={id} className="chip xs" aria-pressed={styleId === id} onClick={() => pickStyle(st)}>{st.name}</button> : null; })}</div></div>}
                {analysis.analysis.notes && <p className="small" style={{ margin: 0 }}>{analysis.analysis.notes}</p>}
              </AiCard> : <p className="callout small" role="status">This doesn’t look like a photo of a room. Try a photo taken from a corner, showing the walls and window.</p>)}
            </> : aiOn ? <p className="small"><Link to={signInPath(`/studio?${studioQuery()}`)} onClick={() => keepStudioPhoto(photoFile)}>Sign in or create a free account</Link> to analyse this room or generate a photo-real redesign. Your photo and choices stay here while you do. The preview above is a simple colour wash, not AI.</p>
              : aiReason === 'paused' ? <p className="small muted">AI photo redesign is temporarily unavailable. The preview above is a simple colour wash, not AI.</p>
              : aiReason === 'disabled' ? <p className="small muted">AI photo redesign isn’t switched on for this site yet. The preview above is a simple colour wash, not AI.</p>
              : aiReason === 'offline' ? <p className="small muted">This preview has no server, so the “after” is a simple colour wash, not AI. On the live Streetkey site, the AI redesigns your actual photo in the style you choose. Your photo stays in your browser here.</p>
              : <p className="small muted">The preview above is a simple colour wash, not AI.</p>}
          </div>}

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }} role="group" aria-label="Styles">
            {STYLES.map((s) => (
              <button type="button" key={s.id} className="card flat" aria-pressed={s.id === styleId} onClick={() => pickStyle(s)} style={{ textAlign: 'left', padding: 10, cursor: 'pointer', borderColor: s.id === styleId ? 'var(--ink)' : undefined, borderWidth: s.id === styleId ? 2 : 1 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }} aria-hidden="true">{[s.palette.wall, s.palette.cab, s.palette.floor, s.palette.accent].map((c, i) => <div key={i} className="swatch" style={{ background: c }} />)}</div>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 6 }}>{s.name}</div>
                <div className="xs muted">{s.note}</div>
                <div className="xs num" style={{ marginTop: 4 }}>{gbpK(designCost(room, s.tier, dims, pricingPostcode, { furniture }).total)}</div>
              </button>
            ))}
          </div>

          <section className="card">
            <div className="pill-tabs"><Seg aria-label="Studio tools" value={tab} onChange={setTab} options={[{ value: 'finishes', label: 'Materials & finishes' }, { value: 'layout', label: 'Layout planner' }, { value: 'budget', label: 'Budget designer' }]} /></div>
            {tab === 'finishes' && <div className="stack">
              <div className="field"><span id={`${uid}-tier`}>Overall specification</span><Seg aria-labelledby={`${uid}-tier`} value={tier} onChange={(t) => { setTier(t); setOverrides({}); }} options={TIERS.map((t) => ({ value: t, label: t }))} /></div>
              <div className="eyebrow" style={{ marginTop: 6 }} id={`${uid}-paint`}>Paint colour</div>
              <div className="row" role="group" aria-labelledby={`${uid}-paint`}>{PAINTS.map(([n, c]) => <button type="button" key={n} title={n} aria-pressed={paint === c} onClick={() => setPaint(c)} className="save-btn" style={{ borderColor: paint === c ? 'var(--ink)' : undefined }}><i aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: c || style.palette.wall, border: '1px solid var(--line)', verticalAlign: 'middle', marginRight: 6 }} />{n}</button>)}</div>
              <div className="table-wrap" tabIndex={0} style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Element</th><th>Specification</th></tr></thead>
                <tbody>{cost.lines.filter((l) => l.code !== 'STAGE').map((l) => <tr key={l.code}><td className="small">{l.name}</td><td><select className="input" aria-label={`${l.name} specification`} value={overrides[l.code] ?? tier} onChange={(e) => setOverrides((o) => ({ ...o, [l.code]: e.target.value as Tier }))}>{TIERS.map((t) => <option key={t} value={t}>{t} — {designCost(room, t, dims, pricingPostcode, { overrides: {} }).lines.find((x) => x.code === l.code)?.spec}</option>)}</select></td></tr>)}</tbody></table></div>
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
              <label className="field">Budget incl. VAT: <b className="num">{gbp(budget)}</b><input type="range" min={STUDIO_BUDGET.min} max={STUDIO_BUDGET.max} step={STUDIO_BUDGET.step} value={budget} aria-valuetext={gbp(budget)} onChange={(e) => setBudget(Number(e.target.value))} /></label>
              {fit.best ? <div className="callout ok small">Best fit: <b>{fit.best.style.name}</b> ({fit.best.style.tier}) at {gbp(fit.best.cost.total)} — {gbp(fit.headroom)} headroom. <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={() => pickStyle(fit.best!.style)}>Apply</button></div> : <div className="callout small">Below the cheapest package ({fit.cheapest.style.name}, {gbp(fit.cheapest.cost.total)}). Short by {gbp(-fit.headroom)}.</div>}
              <ul className="clean small">{STYLES.map((s) => { const c = designCost(room, s.tier, dims, pricingPostcode, { furniture }).total; return <li key={s.id} className="row between"><span>{c <= budget ? <span aria-label="Within budget">✅</span> : <span aria-label="Over budget">—</span>} {s.name} <span className="xs muted">({s.tier})</span></span><span className="num">{gbp(c)}</span></li>; })}</ul>
            </div>}
          </section>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <section className="card ink">
            <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Design-to-cost · {style.name} {ROOM_NAME[room]}</div>
            <div className="num" style={{ fontSize: 40, marginTop: 6 }}>{gbp(cost.total)}</div>
            <div className="muted small">incl. VAT · materials {gbpK(cost.materials)} · labour {gbpK(cost.labour)} · ≈{cost.weeks} week{cost.weeks > 1 ? 's' : ''} on site</div>
            <div className="row" style={{ marginTop: 14 }}>
              <button type="button" className="btn accent sm" onClick={() => { saveDesign({ propertyId: linked?.id ?? '', room, style: style.name, budget, total: cost.total }); }}>Save design</button>
              <button type="button" className="btn ghost sm" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.3)' }} onClick={() => { setParams(new URLSearchParams(studioQuery())); try { void navigator.clipboard?.writeText(shareUrl); } catch { /* ignore */ } setCopied(true); }}>{copied ? 'Link copied' : 'Share link'}</button>
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
              <button type="button" className="btn" onClick={requestQuotes}>Request contractor quotes</button>
              <Link className="btn ghost" to={`/invest?${linked ? `property=${linked.id}&` : ''}refurb=${cost.total}&from=studio&label=${encodeURIComponent(`${style.name} ${ROOM_NAME[room]}`)}`}>Use in investment analysis →</Link>
              <Link className="btn ghost" to={linked ? `/estimate?property=${linked.id}` : '/estimate'}>Add to whole-house estimate →</Link>
            </div>
            {/* Always present, so what happened to the request is announced; the button keeps focus. */}
            <p className="small" role="status" style={{ margin: shownQuoteNote ? '10px 0 0' : 0 }}>{shownQuoteNote && <>{shownQuoteNote} <Link to="/automation">See the approval queue</Link></>}</p>
          </Section>
          <Section title="Saved designs" kicker="Compare concepts">
            {designs.length === 0 ? <p className="small muted">Save concepts to compare them side by side or share with contractors, agents or family.</p> :
              <ul className="clean small">{designs.slice(0, 6).map((d) => { const town = getProperty(d.propertyId)?.town.split(',')[0]; return <li key={d.id} className="row between"><span>{d.style} {ROOM_NAME[d.room as RoomType] ?? d.room}{town && <span className="xs muted"> · {town}</span>}</span><span className="num">{gbpK(d.total)}</span></li>; })}</ul>}
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
