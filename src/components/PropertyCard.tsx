/**
 * The home card used wherever homes are shown side by side (the home page, an agent's page, saved
 * homes): picture, price, what it is, where it is and its key facts. Example listings always carry
 * their "Example" tag; real listings show "New" for their first week and "Reduced" after a price cut.
 */
import { Link } from 'react-router-dom';
import type { Property } from '../data/properties';
import { latestPriceMove } from '../engine/history';
import { useStore } from '../store';
import { Icon } from './Icons';
import { gbp, HouseArt, streetName } from './ui';
import { lettingLine } from './LettingFacts';

const KIND: Record<string, string> = { flat: 'flat', bungalow: 'bungalow', commercial: 'commercial property', terraced: 'terraced house', 'semi-detached': 'semi-detached house', detached: 'detached house' };
/** "3 bed terraced house", "Studio flat", "Commercial property". */
export function homeKind(p: Pick<Property, 'type' | 'beds'>) {
  const kind = KIND[p.type] ?? 'home';
  if (p.type === 'commercial') return 'Commercial property';
  return p.beds ? `${p.beds} bed ${kind}` : `Studio ${kind}`;
}

const QUALIFIER: Record<string, string> = { guide: 'guide price', 'offers over': 'offers over', 'offers in region of': 'offers in the region of', fixed: 'fixed price' };
/** How the lister qualified a sale price ("guide price", "offers over"), or '' when they did not. */
export const priceNote = (p: Pick<Property, 'priceQualifier'>) => (p.priceQualifier ? QUALIFIER[p.priceQualifier] ?? '' : '');

export function PropertyCard({ p, eager = false }: { p: Property; eager?: boolean }) {
  const { saved, toggleSaved } = useStore();
  const on = saved.includes(p.id);
  const example = !p.source;
  const rental = p.listing === 'rent';
  const to = `/property/${p.id}`;
  return (
    <article className="hcard">
      <Link to={to} className="hcard-img" tabIndex={-1} aria-hidden="true">
        {p.photos?.[0] ? <img src={p.photos[0]} alt="" loading={eager ? 'eager' : 'lazy'} /> : <HouseArt hue={p.photoHue} type={p.type} />}
      </Link>
      <div className="hcard-tags">
        {example && <span className="hcard-tag">Example</span>}
        {!!p.history && p.history.daysOnMarket <= 7 && <span className="hcard-tag is-new">New</span>}
        {latestPriceMove(p.history) === 'reduced' && <span className="hcard-tag is-reduced">Reduced</span>}
        {p.listing === 'auction' && <span className="hcard-tag">Auction</span>}
      </div>
      <button type="button" className={`hcard-heart${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${on ? 'Saved' : 'Save'}: ${p.title}`} onClick={() => toggleSaved(p.id)}><Icon name="heart" size={20} /></button>
      <Link to={to} className="hcard-body">
        <span className="hcard-price">{gbp(p.price)}{rental ? <small> pcm</small> : p.listing === 'auction' ? <small> guide</small> : priceNote(p) ? <small> {priceNote(p)}</small> : null}</span>
        <span className="hcard-kind">{homeKind(p)}{rental ? ' to rent' : ''}</span>
        <span className="hcard-place">{streetName(p.street)}, {p.town}</span>
        {rental && lettingLine(p) && <span className="hcard-let">{lettingLine(p)}</span>}
        <span className="hcard-facts">
          {p.beds > 0 && <span><Icon name="bed" size={16} />{p.beds}<span className="sr-only"> bedrooms</span></span>}
          {p.baths > 0 && <span><Icon name="bath" size={16} />{p.baths}<span className="sr-only"> bathrooms</span></span>}
          {p.floorArea > 0 && !p.floorAreaEstimated && <span><Icon name="area" size={16} />{Math.round(p.floorArea)} m²</span>}
          {p.epc?.current && <span className="hcard-epc">EPC {p.epc.current}</span>}
        </span>
      </Link>
    </article>
  );
}
