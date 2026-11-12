/**
 * "Make a floor plan" in the listing form (the Photos step). The person makes a plan with the floor plan
 * maker and chooses "Use this plan for my listing": the plan is then added to the listing as its floor plan
 * when the listing is sent, and its total can fill the listing's floor area.
 *
 * The floor area is never changed behind the person's back: a figure they typed is only replaced if they
 * say so, and when the form's starting figure is replaced automatically they are told and can put it back.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { formatArea, planSummary, planTotals, renderPlanSvg, svgDataUrl, type PlanRoom } from '../engine/floorplan';
import { FloorPlanMaker, type UsedPlan } from './FloorPlanMaker';
import './floorplan.css';

/** The smallest floor area a listing accepts (m²): a plan that adds up to less isn't offered as the floor area. */
const MIN_LISTING_AREA = 10;

export function ListingFloorPlan({ plan, onPlan, hasAttached, floorArea, areaTyped, onArea, when }: {
  /** The plan the person has chosen to use, until the listing is sent. */
  plan: PlanRoom[] | null;
  onPlan: (rooms: PlanRoom[] | null) => void;
  /** The listing already has a floor plan (stored with its photos). */
  hasAttached: boolean;
  /** The floor area in the form (m²), and whether the person typed it themselves. */
  floorArea: number;
  areaTyped: boolean;
  onArea: (m2: number) => void;
  /** When the plan is added, to finish "It will be added to your listing …". */
  when: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  /** The plan's total, waiting for the person to say whether the listing should use it. */
  const [ask, setAsk] = useState<{ m2: number; total: number; partial: boolean } | null>(null);
  /** The floor area that was replaced automatically, so it can be put back. */
  const [was, setWas] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const head = useRef<HTMLHeadingElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** When a button goes away once pressed, focus moves to the section's heading rather than the page body. */
  const focusHead = () => requestAnimationFrame(() => head.current?.focus());
  const totals = useMemo(() => (plan ? planTotals(plan) : null), [plan]);
  const svg = useMemo(() => (plan ? renderPlanSvg(plan) : ''), [plan]);

  const use = (p: UsedPlan) => {
    onPlan(p.rooms); setOpen(false); setAsk(null); setWas(null);
    const m2 = Math.round(p.m2);
    const partial = planTotals(p.rooms).needsMeasuring.length > 0;
    if (m2 < MIN_LISTING_AREA || m2 === floorArea) setNote('Your floor plan is ready.');
    // A figure the person typed, or a plan with rooms still to measure: ask first.
    else if (areaTyped || partial) { setAsk({ m2, total: p.m2, partial }); setNote('Your floor plan is ready.'); }
    else { setWas(floorArea); onArea(m2); setNote(`Your floor plan is ready, and the floor area on your listing is now ${m2} m² to match it.`); }
    focusHead();
  };
  const answer = (useIt: boolean) => {
    if (!ask) return;
    if (useIt) onArea(ask.m2);
    setNote(useIt ? `The floor area on your listing is now ${ask.m2} m².` : `The floor area on your listing stays at ${floorArea} m².`);
    setAsk(null); focusHead();
  };

  return (
    <div className="fp-listing">
      <h4 ref={head} tabIndex={-1}>Floor plan</h4>
      {plan && totals ? <>
        <img className="fp-listing-plan" src={svgDataUrl(svg)} alt={planSummary(plan)} />
        <p className="small fp-p">{totals.measured} room{totals.measured === 1 ? '' : 's'}, {formatArea(totals.m2)} in total. It will be added to your listing {when}{hasAttached ? ', in place of the floor plan that’s on it now' : ''}.</p>
      </> : hasAttached
        ? <p className="small fp-p">Your listing has a floor plan: it’s with your photos above, marked “Floor plan”. Making a new one replaces it.</p>
        : <p className="small muted fp-p">Buyers look for a floor plan. Type in each room’s measurements (or photograph a rough sketch) and Streetkey draws the plan and adds up the floor area.</p>}
      <p className="small fp-p" role="status">{note}</p>
      {was != null && !ask && <div><button type="button" className="linkish" onClick={() => { onArea(was); setNote(`The floor area on your listing is back to ${was} m².`); setWas(null); focusHead(); }}>Put the floor area back to {was} m²</button></div>}
      {ask && (
        <div className="callout info fp-area-ask" role="group" aria-labelledby={`${uid}-ask`}>
          <span id={`${uid}-ask`}>Your plan adds up to <b>{formatArea(ask.total)}</b>{ask.partial ? ', not counting the rooms that still need measuring' : ''}. Your listing says <b>{floorArea} m²</b>. Which should your listing show?</span>
          <div className="row">
            <button type="button" className="btn sm" onClick={() => answer(true)}>Use {ask.m2} m²</button>
            <button type="button" className="btn ghost sm" onClick={() => answer(false)}>Keep {floorArea} m²</button>
          </div>
        </div>
      )}
      <div className="row">
        <button ref={toggle} type="button" className="btn ghost" aria-expanded={open} aria-controls={`${uid}-maker`} onClick={() => setOpen(!open)}>{plan ? 'Change the floor plan' : hasAttached ? 'Make a new floor plan' : 'Make a floor plan'}</button>
        {plan && !open && <button type="button" className="btn ghost sm" onClick={() => { onPlan(null); setAsk(null); setNote('The floor plan won’t be added to your listing.'); focusHead(); }}>Don’t use this plan</button>}
      </div>
      <div id={`${uid}-maker`} hidden={!open}>
        {open && <FloorPlanMaker mode="listing" level={5} useLabel="Use this plan for my listing" onUse={use} onClose={() => { setOpen(false); requestAnimationFrame(() => toggle.current?.focus()); }} />}
      </div>
    </div>
  );
}
