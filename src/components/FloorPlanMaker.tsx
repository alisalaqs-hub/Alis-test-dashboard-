/**
 * The floor plan maker: a table of rooms (name, floor, width, length, metres or feet, row on the plan),
 * a live plan drawn to scale from those numbers, the floor area per floor and in total, and downloads
 * as PNG and SVG. It works fully without AI.
 *
 * Where AI can read photos, "Read my sketch" fills the table from a photo of a hand-drawn sketch for the
 * person to check; the plan itself is still drawn from the numbers, never by AI.
 *
 * mode 'page': the stand-alone tool (/floor-plan). mode 'listing': inside the listing form, where
 * "Use this plan" hands the plan back to be attached to the listing.
 *
 * Accessibility: every box has its own label (shown above the box on small screens, where the table
 * becomes a stack of cards); arrows and Remove say which room they act on; focus follows a room when it
 * moves and is never dropped when one is removed; what each button did is announced; the plan picture
 * carries the whole plan in words; errors are text beside the box, not colour alone.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FLOOR_LABEL, formatArea, formatSize, formatSizeImperial, isMeasured, planSummary, planTotals, renderPlanSvg, roomArea, splitDimensions, svgDataUrl, svgSize, TOTAL_LABEL, type PlanRoom,
} from '../engine/floorplan';
import {
  arrange, blankRow, downloadBlob, floorOptions, isBlank, loadMaker, MAX_ROOMS, newId, planFileName, planPng, roomLabel, rowsToRooms, saveMaker, sizeProblem, type MakerRow, type MakerState,
} from '../lib/floorplan';
import { readSketch, SKETCH_CONSENT_TEXT, type SketchReading } from '../lib/ai/floorplan';
import { photoProblem } from '../lib/ai/studio';
import { announce, useAi, useAiAction } from '../lib/ai/core';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiThinking, AiUnavailable } from './ai/Ai';
import { download, Section, Seg, Tag } from './ui';
import './floorplan.css';

/** What "Use this plan" hands back: the rooms, the drawing and the total floor area. */
export interface UsedPlan { rooms: PlanRoom[]; svg: string; m2: number; sqft: number }

type Level = 3 | 4 | 5 | 6;
const deeper = (l: Level): Level => Math.min(6, l + 1) as Level;
function H({ level, children, className }: { level: Level; children: ReactNode; className?: string }) {
  const T = `h${level}` as const;
  return <T className={className}>{children}</T>;
}

const ROOM_NAMES = ['Living room', 'Kitchen', 'Kitchen / diner', 'Dining room', 'Hall', 'Landing', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Bathroom', 'En-suite', 'Shower room', 'WC', 'Utility room', 'Study', 'Conservatory', 'Garage', 'Store'];
const EXAMPLE: Omit<MakerRow, 'id'>[] = [
  { name: 'Kitchen', floor: 'ground', width: '3.2', length: '3', unit: 'm', row: 1 },
  { name: 'Dining room', floor: 'ground', width: '3.6', length: '3', unit: 'm', row: 1 },
  { name: 'Hall', floor: 'ground', width: '1.8', length: '4.2', unit: 'm', row: 2 },
  { name: 'Living room', floor: 'ground', width: '5', length: '4.2', unit: 'm', row: 2 },
  { name: 'Bedroom 1', floor: 'first', width: '4.2', length: '3.9', unit: 'm', row: 1 },
  { name: 'Bathroom', floor: 'first', width: '2.6', length: '2.1', unit: 'm', row: 1 },
  { name: 'Bedroom 2', floor: 'first', width: '3.4', length: '3.1', unit: 'm', row: 2 },
  { name: 'Landing', floor: 'first', width: '1', length: '3.1', unit: 'm', row: 2 },
  { name: 'Bedroom 3', floor: 'first', width: '2.4', length: '3.1', unit: 'm', row: 2 },
];
const UNITS = [{ value: 'm', label: 'Metres' }, { value: 'ft', label: 'Feet and inches' }] as const;
const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ───────────────────────── "Read my sketch" (only where AI can read photos) ───────────────────────── */
function SketchReader({ level, onRead }: { level: Level; onRead: (r: SketchReading) => void }) {
  const ai = useAi();
  const uid = useId();
  const [photo, setPhoto] = useState<File | null>(null);
  const [thumb, setThumb] = useState('');
  const [consent, setConsent] = useState(false);
  const [unit, setUnit] = useState<'m' | 'ft'>('m');
  const [problem, setProblem] = useState('');
  const read = useAiAction(async (file: File, u: 'm' | 'ft') => { const r = await readSketch(file, u); onRead(r); return r; }, {
    label: 'Sketch', announce: true,
    done: (r) => (r.isSketch
      ? `Sketch read. ${count(r.rooms.length, 'room')} put in the table${r.needsMeasuring.length ? `, ${r.needsMeasuring.length} still to measure` : ''}. Check each one against your sketch.`
      : 'That photo doesn’t look like a sketch with rooms on it.'),
  });
  // A small preview of the chosen photo (it stays in this tab until it is sent to be read).
  useEffect(() => {
    if (!photo) { setThumb(''); return; }
    const url = URL.createObjectURL(photo);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  if (!ai.photos || !ai.signedIn) {
    return <AiUnavailable reason={ai.available && !ai.photos ? 'disabled' : ai.reason} signedOut={ai.photos && !ai.signedIn} feature="Reading a sketch with AI" fallback="You can type your rooms into the table instead." />;
  }

  const choose = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // the same photo can be chosen again
    if (!file) return;
    setProblem('');
    const wrong = await photoProblem(file);
    if (wrong) { setProblem(wrong); return; }
    setPhoto(file);
    setConsent(false); // the consent was for the previous photo
    read.reset();
  };
  const r = read.data;

  return (
    <div className="fp-sketch">
      <div className="fp-sketch-head"><AiLabel /><H level={level} className="fp-sub">Have a hand-drawn sketch? Let AI read it</H></div>
      <p className="small muted">Photograph your sketch with each room’s name and size written on it. Streetkey AI copies the rooms and sizes into the table for you to check. It never guesses: a size it can’t read is left for you to fill in. The plan itself is always drawn from your numbers.</p>
      <div className="fp-sketch-pick">
        <label className="dropzone fp-drop">
          <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" onChange={(e) => void choose(e.currentTarget)} />
          <span>{photo ? 'Choose a different photo' : 'Choose or take a photo of your sketch'}</span>
        </label>
        {photo && thumb && <img className="fp-thumb" src={thumb} alt="The photo you chose" />}
      </div>
      {problem && <p className="field-error small" role="alert">{problem}</p>}
      {photo && <>
        <div className="field">
          <span id={`${uid}-unit`}>If a size has no unit written, it is in</span>
          <Seg aria-labelledby={`${uid}-unit`} value={unit} onChange={setUnit} options={[{ value: 'm', label: 'Metres' }, { value: 'ft', label: 'Feet' }]} />
        </div>
        <label className="check fp-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{SKETCH_CONSENT_TEXT}</span></label>
        <div className="row">
          <AiButton busy={read.busy} busyLabel="Reading your sketch…" disabled={!consent} onClick={() => void read.run(photo, unit)}>{r ? 'Read it again' : 'Read my sketch'}</AiButton>
          {!consent && <span className="xs muted">Tick the box above to use AI on this photo.</span>}
        </div>
      </>}
      {read.busy && <AiThinking label="Reading your sketch" />}
      <AiErrorNote error={read.error} onRetry={photo && consent ? () => void read.run(photo, unit) : undefined} />
      {r && !read.busy && (
        <AiCard title={r.isSketch ? 'Sketch read: please check it' : 'No rooms found in that photo'} headingLevel={deeper(level)} focusKey={r} footer={<AiDisclaimer>{r.label}</AiDisclaimer>}>
          {r.isSketch ? <>
            <p className="small fp-p">{count(r.rooms.length, 'room')} from your sketch {r.rooms.length === 1 ? 'is' : 'are'} now in the table below, marked “Read by AI”. Check each name and size against your sketch and correct anything that’s wrong.</p>
            {r.needsMeasuring.length > 0 && <div>
              <p className="small fp-p"><b>Needs measuring ({r.needsMeasuring.length})</b>: no size was written for {r.needsMeasuring.length === 1 ? 'this room' : 'these rooms'}, or it couldn’t be read. Type the sizes in to add {r.needsMeasuring.length === 1 ? 'it' : 'them'} to the plan.</p>
              <ul className="fp-list">{r.needsMeasuring.map((n, i) => <li key={`${n}-${i}`}>{n}</li>)}</ul>
            </div>}
          </> : <p className="small fp-p">That photo doesn’t look like a sketch with rooms on it. Try a clearer photo taken straight on in good light, or type your rooms into the table.</p>}
          {r.note && <p className="small muted fp-p">The AI noted: {r.note}</p>}
        </AiCard>
      )}
    </div>
  );
}

/* ───────────────────────── the maker ───────────────────────── */
export function FloorPlanMaker({ mode = 'page', level = 3, onUse, onClose, useLabel = 'Use this plan' }: {
  mode?: 'page' | 'listing';
  /** Heading level for the maker's sections (3 on its own page; deeper inside another form). */
  level?: Level;
  onUse?: (plan: UsedPlan) => void;
  onClose?: () => void;
  useLabel?: string;
}) {
  const uid = useId();
  const [state, setState] = useState<MakerState>(() => loadMaker() ?? { rows: [blankRow()], title: '' });
  const { rows } = state;
  const title = mode === 'page' ? state.title : '';
  /** The size box being typed in: its problem (if any) is shown once the person leaves it. */
  const [editing, setEditing] = useState('');
  const [undo, setUndo] = useState<{ state: MakerState; what: string } | null>(null);
  const [said, setSaid] = useState('');
  const [zoom, setZoom] = useState<'fit' | 'full'>('fit');
  const [saving, setSaving] = useState(false);
  useEffect(() => { saveMaker(state); }, [state]);

  const rooms = useMemo(() => rowsToRooms(rows), [rows]);
  const totals = useMemo(() => planTotals(rooms), [rooms]);
  const svg = useMemo(() => renderPlanSvg(rooms, { title }), [rooms, title]);
  const size = useMemo(() => svgSize(svg), [svg]);
  const byId = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);
  const canDraw = totals.measured > 0;
  const allBlank = rows.every(isBlank);

  /** Says what a button did: shown beside the buttons and read out by screen readers. */
  const say = (msg: string) => { setSaid(msg); announce(msg); };
  const setRows = (fn: (rows: MakerRow[]) => MakerRow[]) => setState((s) => ({ ...s, rows: fn(s.rows) }));
  const patch = (id: string, p: Partial<MakerRow>, place = false) => setRows((rs) => { const next = rs.map((r) => (r.id === id ? { ...r, ...p } : r)); return place ? arrange(next) : next; });
  /**
   * Swaps the whole table for another (an example, a sketch reading), keeping the old one for Undo if it had anything
   * in it. A sketch reading arrives a few seconds after it was asked for, so the table as it is now is what's kept.
   */
  const latest = useRef(state);
  useLayoutEffect(() => { latest.current = state; });
  const replaceRows = (next: MakerRow[], what: string) => {
    const now = latest.current;
    setUndo(now.rows.every(isBlank) ? null : { state: now, what });
    setState((s) => ({ ...s, rows: next.length ? arrange(next) : [blankRow()] }));
  };

  const add = () => {
    if (rows.length >= MAX_ROOMS) { say(`A plan can have up to ${MAX_ROOMS} rooms.`); return; }
    const r = blankRow(rows[rows.length - 1]);
    setRows((rs) => [...rs, r]);
    say('Room added at the end of the table.');
    focusSoon(`${uid}-name-${r.id}`);
  };
  const remove = (id: string) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const next = rows.filter((r) => r.id !== id);
    const keep = next.length ? next : [blankRow()];
    setUndo(isBlank(rows[i]) ? undo : { state, what: roomLabel(rows[i], i) });
    setState((s) => ({ ...s, rows: arrange(keep) }));
    say(`${roomLabel(rows[i], i)} removed.`);
    // Focus goes to the room that took its place (or the one before, or the new empty line), never to the page body.
    focusSoon(`${uid}-name-${(keep[i] ?? keep[keep.length - 1]).id}`);
  };
  const neighbour = (i: number, dir: -1 | 1) => { const a = rows[i], b = rows[i + dir]; return b && b.floor === a.floor && b.row === a.row ? b : null; };
  const move = (id: string, dir: -1 | 1) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0 || !neighbour(i, dir)) return;
    setRows((rs) => { const next = [...rs]; [next[i], next[i + dir]] = [next[i + dir], next[i]]; return next; });
    say(`${roomLabel(rows[i], i)} moved ${dir < 0 ? 'left' : 'right'} on the plan.`);
    focusSoon(`${uid}-${dir < 0 ? 'left' : 'right'}-${id}`);
  };
  /** "4.2 x 3.9" typed into one box fills both. */
  const leaveSize = (r: MakerRow, field: 'width' | 'length') => {
    setEditing('');
    const both = splitDimensions(r[field], r.unit);
    if (both) { patch(r.id, { width: both.width, length: both.length, ai: false }); say('Filled in the width and the length.'); }
  };
  const showExample = () => { replaceRows(EXAMPLE.map((r) => ({ ...r, id: newId() })), 'your rooms'); say('An example home is in the table. Change it to match yours.'); };
  const clearAll = () => { replaceRows([], 'your rooms'); say('All rooms cleared.'); focusSoon(`${uid}-add`); };
  const undoNow = () => {
    if (!undo) return;
    setState(undo.state); setUndo(null);
    say(`${undo.what.charAt(0).toUpperCase()}${undo.what.slice(1)} ${/rooms$/.test(undo.what) ? 'are' : 'is'} back.`);
    focusSoon(`${uid}-add`);
  };
  const onSketch = (r: SketchReading) => {
    if (!r.isSketch || !r.rooms.length) return;
    replaceRows(r.rooms.slice(0, MAX_ROOMS).map((x) => ({ id: newId(), name: x.name, floor: x.floor, width: x.widthText, length: x.lengthText, unit: x.unit, row: x.row, ai: true })), 'your earlier rooms');
  };

  const savePng = async () => {
    if (!canDraw || saving) return;
    setSaving(true);
    try { downloadBlob(`${planFileName(title)}.png`, await planPng(svg)); say('Your plan has been downloaded as a PNG picture.'); }
    catch { say('Sorry, the picture couldn’t be made on this device. Try “Download as SVG” instead.'); }
    finally { setSaving(false); }
  };
  const saveSvg = () => { if (!canDraw) return; download(`${planFileName(title)}.svg`, svg, 'image/svg+xml'); say('Your plan has been downloaded as an SVG file.'); };
  const use = () => { if (canDraw) onUse?.({ rooms, svg, m2: totals.m2, sqft: totals.sqft }); };

  /* Lines of the table grouped as they are drawn: by floor, then by row. */
  const groups: { floor: MakerRow['floor']; row: number; items: { r: MakerRow; i: number }[] }[] = [];
  rows.forEach((r, i) => {
    const last = groups[groups.length - 1];
    if (last && last.floor === r.floor && last.row === r.row) last.items.push({ r, i }); else groups.push({ floor: r.floor, row: r.row, items: [{ r, i }] });
  });
  const rowsOnFloor = (floor: MakerRow['floor']) => Math.max(1, ...rows.filter((r) => r.floor === floor).map((r) => r.row));

  const table = (
    <table className="t fp-table" role="table" aria-label="Rooms">
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">Room</th><th role="columnheader" scope="col">Floor</th><th role="columnheader" scope="col">Row</th><th role="columnheader" scope="col">Width</th>
          <th role="columnheader" scope="col">Length</th><th role="columnheader" scope="col">Sizes in</th><th role="columnheader" scope="col">On the plan</th><th role="columnheader" scope="col"><span className="sr-only">Move or remove</span></th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={`${g.floor}-${g.row}`} role="rowgroup">
          <tr role="row" className="fp-group"><th role="rowheader" colSpan={8} scope="rowgroup">{FLOOR_LABEL[g.floor]}, row {g.row} <span className="fp-group-note">drawn left to right</span></th></tr>
          {g.items.map(({ r, i }) => {
            const label = roomLabel(r, i), which = <span className="sr-only"> ({r.name.trim() ? `${r.name.trim()}, ` : ''}room {i + 1})</span>;
            const wKey = `${r.id}:w`, lKey = `${r.id}:l`;
            const wErr = editing === wKey ? null : sizeProblem(r.width, r.unit), lErr = editing === lKey ? null : sizeProblem(r.length, r.unit);
            const room = byId.get(r.id);
            const area = room ? roomArea(room) : null;
            const canLeft = !!neighbour(i, -1), canRight = !!neighbour(i, 1);
            const sizeBox = (field: 'width' | 'length', key: string, err: string | null, text: string) => (
              <label><span className="fp-lab">{text}{which}</span>
                <input id={`${uid}-${field}-${r.id}`} className="input" value={r[field]} maxLength={30} autoComplete="off" inputMode={r.unit === 'ft' ? 'text' : 'decimal'}
                  placeholder={r.unit === 'ft' ? (field === 'width' ? 'e.g. 13\'9"' : 'e.g. 12\'10"') : field === 'width' ? 'e.g. 4.2' : 'e.g. 3.9'}
                  aria-invalid={err ? true : undefined} aria-describedby={err ? `${uid}-${field}-err-${r.id}` : undefined}
                  onFocus={() => setEditing(key)} onBlur={() => leaveSize(r, field)} onChange={(e) => patch(r.id, { [field]: e.target.value, ai: false })} />
              </label>
            );
            return (
              <tr role="row" key={r.id} className="fp-room">
                <td role="cell" className="fp-c-name">
                  <label><span className="fp-lab">Room name{which}</span>
                    <input id={`${uid}-name-${r.id}`} className="input" value={r.name} maxLength={40} list={`${uid}-names`} autoComplete="off" placeholder="e.g. Kitchen" onChange={(e) => patch(r.id, { name: e.target.value, ai: false })} />
                  </label>
                  {r.ai && <span className="fp-ai"><AiLabel>Read by AI</AiLabel> <span className="xs muted">check it</span></span>}
                </td>
                <td role="cell" className="fp-c-floor">
                  <label><span className="fp-lab">Floor{which}</span>
                    <select id={`${uid}-floor-${r.id}`} className="input" value={r.floor} onChange={(e) => { patch(r.id, { floor: e.target.value as MakerRow['floor'] }, true); focusSoon(`${uid}-floor-${r.id}`); }}>
                      {floorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </td>
                <td role="cell" className="fp-c-row">
                  <label><span className="fp-lab">Row<span className="sr-only"> on the plan</span>{which}</span>
                    <select id={`${uid}-row-${r.id}`} className="input" value={r.row} onChange={(e) => { patch(r.id, { row: Number(e.target.value) }, true); focusSoon(`${uid}-row-${r.id}`); }}>
                      {Array.from({ length: Math.min(12, rowsOnFloor(r.floor) + 1) }, (_, k) => <option key={k + 1} value={k + 1}>{k + 1}</option>)}
                    </select>
                  </label>
                </td>
                <td role="cell" className="fp-c-w">{sizeBox('width', wKey, wErr, 'Width')}</td>
                <td role="cell" className="fp-c-l">{sizeBox('length', lKey, lErr, 'Length')}</td>
                <td role="cell" className="fp-c-unit">
                  <label><span className="fp-lab">Sizes in{which}</span>
                    <select className="input" value={r.unit} onChange={(e) => patch(r.id, { unit: e.target.value === 'ft' ? 'ft' : 'm', ai: false })}>
                      {UNITS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </td>
                <td role="cell" className="fp-c-plan">
                  <span className="fp-lab">On the plan</span>
                  {wErr && <span className="field-error fp-msg" id={`${uid}-width-err-${r.id}`}>Width: {wErr}</span>}
                  {lErr && <span className="field-error fp-msg" id={`${uid}-length-err-${r.id}`}>Length: {lErr}</span>}
                  {!wErr && !lErr && (room && area != null && isMeasured(room)
                    ? <><span className="num fp-msg">{formatSize(room.width, room.length)}</span><span className="xs muted fp-msg">{formatSizeImperial(room.width, room.length)} · {formatArea(area)}</span></>
                    : isBlank(r) ? <span className="xs muted fp-msg">Nothing typed yet</span> : <Tag kind="warn">Needs measuring</Tag>)}
                </td>
                <td role="cell" className="fp-c-actions">
                  <div className="fp-actions">
                    <button type="button" id={`${uid}-left-${r.id}`} className="btn ghost sm fp-arrow" aria-label={`Move ${label} left on the plan`} aria-disabled={!canLeft || undefined} onClick={() => move(r.id, -1)}><span aria-hidden="true">←</span></button>
                    <button type="button" id={`${uid}-right-${r.id}`} className="btn ghost sm fp-arrow" aria-label={`Move ${label} right on the plan`} aria-disabled={!canRight || undefined} onClick={() => move(r.id, 1)}><span aria-hidden="true">→</span></button>
                    <button type="button" className="btn ghost sm" aria-label={`Remove ${label}`} onClick={() => remove(r.id)}>Remove</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );

  const roomsBlock = <>
    <p className="small muted fp-p">Add each room with its width (across the plan) and length (front to back), as you measured them: <span className="num">4.2</span>, <span className="num">4200mm</span> or <span className="num">13'9"</span> all work. Rooms in the same row are drawn side by side and share a wall; row 1 is at the top. Rooms are drawn as rectangles, so add an L-shaped room as two parts.</p>
    <SketchReader level={deeper(level)} onRead={onSketch} />
    <div className="fp-table-wrap">{table}</div>
    <datalist id={`${uid}-names`}>{ROOM_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
    <div className="row fp-buttons">
      <button type="button" id={`${uid}-add`} className="btn" onClick={add}>Add a room</button>
      {allBlank && <button type="button" className="btn ghost sm" onClick={showExample}>Show an example</button>}
      {!allBlank && <button type="button" className="btn ghost sm" onClick={clearAll}>Clear all rooms</button>}
      {undo && <button type="button" className="linkish" onClick={undoNow}>Undo: put {undo.what} back</button>}
      <span className="xs muted fp-said">{said}</span>
    </div>
  </>;

  const preview = (
    <div className={`fp-preview${zoom === 'full' ? ' full' : ''}`} {...(zoom === 'full' ? { tabIndex: 0, role: 'region', 'aria-label': 'Floor plan, full size (scrolls)' } : {})}>
      <img src={svgDataUrl(svg)} width={size.width} height={size.height} alt={planSummary(rooms)} />
    </div>
  );
  const fixed1 = (n: number) => n.toFixed(1);
  const totalsBlock = <>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Floor area for each floor and in total">
      <table className="t">
        <caption className="sr-only">Floor area for each floor and in total</caption>
        <thead><tr><th scope="col">Floor</th><th scope="col" className="r">Rooms<span className="sr-only"> measured</span></th><th scope="col" className="r">m²</th><th scope="col" className="r">sq ft</th></tr></thead>
        <tbody>
          {totals.floors.map((f) => (
            <tr key={f.floor}><th scope="row">{f.label}</th><td className="r num">{f.measured === f.rooms ? f.rooms : `${f.measured} of ${f.rooms}`}</td><td className="r num">{fixed1(f.m2)}</td><td className="r num">{f.sqft.toLocaleString('en-GB')}</td></tr>
          ))}
          {!totals.floors.length && <tr><td colSpan={4} className="muted">No rooms yet.</td></tr>}
        </tbody>
        <tfoot><tr><th scope="row">Total</th><td className="r num">{totals.measured === totals.rooms ? totals.rooms : `${totals.measured} of ${totals.rooms}`}</td><td className="r num">{fixed1(totals.m2)}</td><td className="r num">{totals.sqft.toLocaleString('en-GB')}</td></tr></tfoot>
      </table>
    </div>
    <p className="fp-total"><span className="eyebrow">{TOTAL_LABEL}</span><span className="num">{canDraw ? formatArea(totals.m2) : 'Not measured yet'}</span></p>
    {totals.needsMeasuring.length > 0 && <p className="small fp-p"><Tag kind="warn">Needs measuring</Tag> {totals.needsMeasuring.map((r) => r.name || 'A room with no name').join(', ')}. {totals.needsMeasuring.length === 1 ? 'This room isn’t' : 'These rooms aren’t'} drawn or counted until {totals.needsMeasuring.length === 1 ? 'it has' : 'they have'} a width and a length.</p>}
    <p className="xs muted fp-p">Each room is its width × length, to the nearest 0.1 m², and the total is the sum of the rooms you’ve added. To cover the whole home, add halls, landings and cupboards as rooms too. It’s a guide drawn from your measurements, not a measured survey.</p>
  </>;
  const downloads = (
    <div className="row fp-buttons">
      {mode === 'listing' && <button type="button" className="btn accent" aria-disabled={!canDraw || undefined} onClick={use}>{useLabel}</button>}
      <button type="button" className={`btn${mode === 'listing' ? ' ghost' : ''}`} aria-disabled={!canDraw || saving || undefined} onClick={() => void savePng()}>{saving ? 'Making the picture…' : 'Download as PNG'}</button>
      <button type="button" className="btn ghost" aria-disabled={!canDraw || undefined} onClick={saveSvg}>Download as SVG</button>
      {mode === 'listing' && onClose && <button type="button" className="btn ghost" onClick={onClose}>Close without using it</button>}
      {!canDraw && <span className="xs muted">Add the width and length of at least one room first.</span>}
    </div>
  );
  const zoomSeg = <Seg aria-label="Size of the plan preview" value={zoom} onChange={setZoom} options={[{ value: 'fit', label: 'Fit to width' }, { value: 'full', label: 'Full size' }]} />;
  const titleBox = mode === 'page' && (
    <label className="field fp-title">Name on the plan (optional)
      <input className="input" value={state.title} maxLength={80} placeholder="e.g. 12 Example Road" autoComplete="off" onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))} />
    </label>
  );

  if (mode === 'page') {
    return (
      <div className="stack fp" style={{ gap: 16 }}>
        <Section title="1. Your rooms" kicker="Type them in, or read them from a sketch">{roomsBlock}</Section>
        <div className="split-r fp-split">
          <Section title="2. Your plan" kicker="Drawn to scale from your numbers" right={zoomSeg}>{preview}</Section>
          <div className="stack" style={{ gap: 16 }}>
            <Section title="Floor area">{totalsBlock}</Section>
            <Section title="3. Save your plan">
              {titleBox}{downloads}
              <p className="xs muted fp-p" style={{ marginTop: 10 }}>PNG is a picture you can share, print or add to a listing. SVG stays sharp at any size and opens in drawing programs.</p>
            </Section>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="stack fp fp-inline" style={{ gap: 16 }}>
      <div className="stack"><H level={level} className="fp-sub">Your rooms</H>{roomsBlock}</div>
      <div className="stack"><div className="row between"><H level={level} className="fp-sub">Your plan</H>{zoomSeg}</div>{preview}</div>
      <div className="stack"><H level={level} className="fp-sub">Floor area</H>{totalsBlock}</div>
      {downloads}
    </div>
  );
}
