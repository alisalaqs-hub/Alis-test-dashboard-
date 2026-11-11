import { slugPlace } from '../lib/meta';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { suggest, type Suggestion } from '../engine/suggest';
import { useStore } from '../store';
import { useAi } from '../lib/ai/core';
import { AiLabel } from './ai/Ai';
import { Icon } from './Icons';
import './ai/search.css';

export type Mode = 'buy' | 'rent' | 'sold' | 'commercial' | 'invest';
export const MODES: { id: Mode; label: string; placeholder: string }[] = [
  { id: 'buy', label: 'Buy', placeholder: 'Place or describe it' },
  { id: 'rent', label: 'Rent', placeholder: 'Where do you want to rent?' },
  { id: 'sold', label: 'Sold prices', placeholder: 'Town or postcode' },
  { id: 'commercial', label: 'Commercial', placeholder: 'Area or type of space' },
  { id: 'invest', label: 'Invest', placeholder: 'Area, budget or strategy' },
];

/** Example prompts shown when AI search is available and there's nothing typed or recent. */
const AI_EXAMPLES: Partial<Record<Mode, string[]>> = {
  buy: ['3 bed house with a garden near good schools under £450k', 'Victorian terrace that needs work, with loft potential', 'Flat near a station in Bristol with a balcony'],
  rent: ['2 bed flat to rent near a station under £1,500 pcm', 'House to rent in Bristol with a garden', 'Studio or 1 bed to rent in Manchester'],
  commercial: ['Office near London with Class MA conversion potential', 'Retail unit in Watford', 'Commercial space to convert into flats'],
  invest: ['HMO in Manchester with at least 7% yield', 'Buy-to-let under £200k with strong rental demand', 'Refurb project with £50k profit potential'],
};

/** Where a query should go for each mode. */
export function destination(mode: Mode, q: string) {
  if (mode === 'sold') return q.trim() ? `/sold-prices/${slugPlace(q)}` : '/prices';
  const text = mode === 'rent' && !/rent|let/i.test(q) ? `${q} to rent` : mode === 'commercial' && !/office|commercial/i.test(q) ? `commercial ${q}` : mode === 'invest' && !/invest|yield|return/i.test(q) ? `${q} investment` : q;
  return `/search?q=${encodeURIComponent(text)}&mode=${mode}`;
}

type Item = Suggestion | { kind: 'recent'; label: string; mode: Mode };

/**
 * The search box with type-ahead suggestions (an ARIA 1.2 combobox: arrow keys move through the
 * suggestions, which screen readers announce; Escape closes the list before anything else).
 * `inlineList`: show suggestions below the box in the page flow instead of floating over what
 * follows (used inside the Ask sheet, whose height follows its content).
 */
export function SmartSearch({ autoFocus, onDone, compact, inlineList }: { autoFocus?: boolean; onDone?: () => void; compact?: boolean; inlineList?: boolean }) {
  const [mode, setMode] = useState<Mode>('buy');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const nav = useNavigate();
  const { recent, addRecent } = useStore();
  const ai = useAi();
  const ref = useRef<HTMLInputElement>(null);
  const modesRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const headId = useId();
  const hintId = useId();
  // Without AI, a typed sentence is still searched with Streetkey's built-in rules: the wording (and icon) say so, not "Streetkey AI".
  const items = useMemo<Suggestion[]>(() => suggest(text, 7, { ai: ai.available }), [text, ai.available]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const m = MODES.find((x) => x.id === mode)!;

  const go = (q: string, md: Mode = mode) => {
    if (!q.trim()) { ref.current?.focus(); return; }
    addRecent(q.trim(), md); setOpen(false); onDone?.();
    nav(destination(md, q.trim()));
  };
  const pick = (s: Suggestion) => (s.kind === 'listing' ? (setOpen(false), onDone?.(), nav(`/property/${s.id}`)) : go(s.query));
  const choose = (s: Item) => { if (s.kind === 'recent') go(s.label, s.mode); else pick(s); };
  const recents = recent.slice(0, 4).map((r) => ({ kind: 'recent' as const, label: r.q, mode: (r.mode as Mode) || 'buy' }));
  const examples: Suggestion[] = ai.available && !recents.length ? (AI_EXAMPLES[mode] ?? []).map((e) => ({ kind: 'ai' as const, label: e, sub: 'Example: Streetkey AI turns your words into filters', query: e })) : [];
  const list: Item[] = text ? items : recents.length ? recents : examples;
  const head = text ? null : recents.length ? 'Recent searches' : 'Try asking';
  const expanded = open && list.length > 0;
  const optId = (i: number) => `${listId}-opt-${i}`;

  // Keep the highlighted suggestion in view (the inline list scrolls).
  useEffect(() => { if (expanded && hi >= 0) document.getElementById(optId(hi))?.scrollIntoView?.({ block: 'nearest' }); }, [hi, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); setHi((h) => Math.min(list.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
    else if (e.key === 'Escape' && expanded) {
      // Close the suggestions only: the sheet or page around the box must not see this Escape.
      e.preventDefault(); e.stopPropagation();
      setOpen(false); setHi(-1);
    }
  };
  // Mode choice is a radio group: one tab stop, arrow keys move and select.
  const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((x) => x.id === mode);
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % MODES.length
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + MODES.length) % MODES.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? MODES.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setMode(MODES[next].id); setHi(-1);
    modesRef.current?.querySelector<HTMLButtonElement>(`[data-mode="${MODES[next].id}"]`)?.focus();
  };

  const suggestions = expanded && (
    <div className={`suggest${inlineList ? ' suggest-inline' : ''}`}>
      {head && <p className="suggest-head" id={headId}>{head}</p>}
      <ul className="suggest-list" role="listbox" id={listId} {...(head ? { 'aria-labelledby': headId } : { 'aria-label': 'Suggestions' })}>
        {list.map((s, i) => {
          const off = s.kind === 'ai' && !ai.available;
          return (
            <li key={i} id={optId(i)} role="option" aria-selected={hi === i} className={hi === i ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
              <span className={`suggest-ic ${off ? 'search' : s.kind}`} aria-hidden="true"><Icon name={off ? 'search' : s.kind === 'ai' ? 'spark' : s.kind === 'place' ? 'pin' : s.kind === 'listing' ? 'home' : 'clock'} size={18} /></span>
              <span className="suggest-txt"><b>{s.label}</b>{'sub' in s && <small>{s.sub}</small>}{s.kind === 'recent' && <small>{MODES.find((x) => x.id === s.mode)?.label}</small>}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="smart">
      <div className="mode-tabs" role="radiogroup" aria-label="What are you looking for?" ref={modesRef} onKeyDown={onModeKey}>
        {MODES.map((x) => (
          <button key={x.id} type="button" role="radio" data-mode={x.id} aria-checked={mode === x.id} tabIndex={mode === x.id ? 0 : -1} className={mode === x.id ? 'on' : ''}
            onClick={() => { setMode(x.id); setHi(-1); ref.current?.focus(); }}>{x.label}</button>
        ))}
      </div>
      <form className="smart-box" onSubmit={(e) => { e.preventDefault(); if (expanded && hi >= 0 && list[hi]) choose(list[hi]); else go(text); }}>
        <span className="smart-icon smart-icon-ai" aria-hidden="true"><Icon name="spark" stroke={2.2} /></span>
        <input ref={ref} value={text} placeholder={compact ? 'Place, postcode or describe it…' : m.placeholder} aria-label="Search Streetkey" autoComplete="off" enterKeyHint="search"
          role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && hi >= 0 ? optId(hi) : undefined} aria-describedby={hintId}
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(-1); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => { setOpen(false); setHi(-1); }, 150)}
          onKeyDown={onInputKey} />
        {text && <button type="button" className="smart-clear" aria-label="Clear" onClick={() => { setText(''); setHi(-1); ref.current?.focus(); }}><Icon name="x" size={18} /></button>}
        <button type="submit" className="smart-go" aria-label="Search">Search</button>
        {!inlineList && suggestions}
      </form>
      {inlineList && suggestions}
      {ai.available
        ? <p className="smart-hint aisr-hint" id={hintId}><AiLabel>AI search</AiLabel><span>Describe it in your own words, e.g. “3 bed with a garden under £450k near a station”, and Streetkey AI turns it into filters.</span></p>
        : <p className="smart-hint" id={hintId}>Type a place — or just describe what you want, e.g. “3 bed with a garden under £450k near a station”.</p>}
      {!compact && <div className="quick-chips">
        {(mode === 'rent' ? ['1 bed', '2 bed', 'Pets', 'Under £1,500 pcm', 'Near a station'] : mode === 'invest' ? ['7% yield', 'HMO', 'BRRR', 'Needs work', 'Auction'] : mode === 'commercial' ? ['Office', 'Class MA conversion', 'Retail', 'Near London'] : ['Under £350k', '3+ beds', 'Garden', 'Needs work', 'Loft potential', 'Near a station']).map((c) => (
          <button key={c} type="button" className="chip" onClick={() => { const n = text ? `${text} ${c.toLowerCase()}` : c; setText(n); ref.current?.focus(); setOpen(true); }}>+ {c}</button>
        ))}
      </div>}
    </div>
  );
}
