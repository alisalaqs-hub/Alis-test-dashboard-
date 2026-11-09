import { useEffect, useMemo, useRef, useState } from 'react';
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
  if (mode === 'sold') return `/prices?q=${encodeURIComponent(q)}`;
  const text = mode === 'rent' && !/rent|let/i.test(q) ? `${q} to rent` : mode === 'commercial' && !/office|commercial/i.test(q) ? `commercial ${q}` : mode === 'invest' && !/invest|yield|return/i.test(q) ? `${q} investment` : q;
  return `/search?q=${encodeURIComponent(text)}&mode=${mode}`;
}

export function SmartSearch({ autoFocus, onDone, compact }: { autoFocus?: boolean; onDone?: () => void; compact?: boolean }) {
  const [mode, setMode] = useState<Mode>('buy');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const nav = useNavigate();
  const { recent, addRecent } = useStore();
  const ai = useAi();
  const ref = useRef<HTMLInputElement>(null);
  const items = useMemo(() => suggest(text), [text]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const m = MODES.find((x) => x.id === mode)!;

  const go = (q: string, md: Mode = mode) => {
    if (!q.trim()) { ref.current?.focus(); return; }
    addRecent(q.trim(), md); setOpen(false); onDone?.();
    nav(destination(md, q.trim()));
  };
  const pick = (s: Suggestion) => (s.kind === 'listing' ? (setOpen(false), onDone?.(), nav(`/property/${s.id}`)) : go(s.query));
  const recents = recent.slice(0, 4).map((r) => ({ kind: 'recent' as const, label: r.q, mode: (r.mode as Mode) || 'buy' }));
  const examples: Suggestion[] = ai.available && !recents.length ? (AI_EXAMPLES[mode] ?? []).map((e) => ({ kind: 'ai' as const, label: e, sub: 'Example: Streetkey AI turns your words into filters', query: e })) : [];
  const list: (Suggestion | { kind: 'recent'; label: string; mode: Mode })[] = text ? items : recents.length ? recents : examples;

  return (
    <div className="smart">
      <div className="mode-tabs" role="tablist" aria-label="What are you looking for?">
        {MODES.map((x) => <button key={x.id} role="tab" aria-selected={mode === x.id} className={mode === x.id ? 'on' : ''} onClick={() => { setMode(x.id); ref.current?.focus(); }}>{x.label}</button>)}
      </div>
      <form className="smart-box" onSubmit={(e) => { e.preventDefault(); if (hi >= 0 && list[hi]) { const s = list[hi]; if (s.kind === 'recent') go(s.label, s.mode); else pick(s); } else go(text); }}>
        <span className="smart-icon"><Icon name="search" /></span>
        <input ref={ref} value={text} placeholder={compact ? 'Place, postcode or describe it…' : m.placeholder} aria-label="Search Streetkey" autoComplete="off" enterKeyHint="search"
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(-1); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); } if (e.key === 'Escape') setOpen(false); }} />
        {text && <button type="button" className="smart-clear" aria-label="Clear" onClick={() => { setText(''); ref.current?.focus(); }}><Icon name="x" size={18} /></button>}
        <button type="submit" className="smart-go" aria-label="Search">Search</button>
        {open && list.length > 0 && (
          <ul className="suggest" role="listbox">
            {!text && <li className="suggest-head">{recents.length ? 'Recent searches' : 'Try asking'}</li>}
            {list.map((s, i) => (
              <li key={i} role="option" aria-selected={hi === i} className={hi === i ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); if (s.kind === 'recent') go(s.label, s.mode); else pick(s); }}>
                <span className={`suggest-ic ${s.kind}`}><Icon name={s.kind === 'ai' ? 'spark' : s.kind === 'place' ? 'pin' : s.kind === 'listing' ? 'home' : 'clock'} size={18} /></span>
                <span className="suggest-txt"><b>{s.label}</b>{'sub' in s && <small>{s.sub}</small>}{s.kind === 'recent' && <small>{MODES.find((x) => x.id === s.mode)?.label}</small>}</span>
              </li>
            ))}
          </ul>
        )}
      </form>
      {ai.available
        ? <p className="smart-hint aisr-hint"><AiLabel>AI search</AiLabel><span>Describe it in your own words, e.g. “3 bed with a garden under £450k near a station”, and Streetkey AI turns it into filters.</span></p>
        : <p className="smart-hint">Type a place — or just describe what you want, e.g. “3 bed with a garden under £450k near a station”.</p>}
      {!compact && <div className="quick-chips">
        {(mode === 'rent' ? ['1 bed', '2 bed', 'Pets', 'Under £1,500 pcm', 'Near a station'] : mode === 'invest' ? ['7% yield', 'HMO', 'BRRR', 'Needs work', 'Auction'] : mode === 'commercial' ? ['Office', 'Class MA conversion', 'Retail', 'Near London'] : ['Under £350k', '3+ beds', 'Garden', 'Needs work', 'Loft potential', 'Near a station']).map((c) => (
          <button key={c} type="button" className="chip" onClick={() => { const n = text ? `${text} ${c.toLowerCase()}` : c; setText(n); ref.current?.focus(); setOpen(true); }}>+ {c}</button>
        ))}
      </div>}
    </div>
  );
}
