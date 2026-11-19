import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES } from '../data/properties';
import { parseQuery, runSearch } from '../engine/search';
import { destination, SmartSearch, type Mode } from '../components/SmartSearch';
import { Icon } from '../components/Icons';
import { HouseArt } from '../components/ui';
import { PropertyCard } from '../components/PropertyCard';
import { useStore } from '../store';
import { JourneyScene } from '../components/JourneyScene';
import { slugPlace } from '../lib/meta';

/** Where the facts on every listing come from: the reason to search here. */
const TRUST: [icon: string, title: string, source: string][] = [
  ['pound', 'Real sold prices', 'HM Land Registry'],
  ['water', 'Flood risk', 'Environment Agency'],
  ['bolt', 'Energy ratings', 'EPC register'],
  ['bell', 'Instant alerts', 'New homes by email'],
];

const PLACES: { name: string; hue: number; type: string }[] = [
  { name: 'London', hue: 300, type: 'terraced' }, { name: 'Manchester', hue: 77, type: 'terraced' },
  { name: 'Birmingham', hue: 141, type: 'semi-detached' }, { name: 'Leeds', hue: 222, type: 'terraced' },
  { name: 'Bristol', hue: 33, type: 'flat' }, { name: 'Liverpool', hue: 187, type: 'terraced' },
  { name: 'Sheffield', hue: 265, type: 'detached' }, { name: 'Cardiff', hue: 111, type: 'terraced' },
];

const TOOLS: [to: string, icon: string, label: string][] = [
  ['/import', 'spark', 'Check any listing'], ['/estimate', 'tools', 'Renovation costs'], ['/studio', 'palette', 'Room design'],
  ['/invest', 'chart', 'Investment calculator'], ['/floor-plan', 'plan', 'Floor plan maker'], ['/compare', 'building', 'Compare homes'],
];

/** Small drawings for the three reasons to use Streetkey. They are decoration: shapes, never figures. */
function FeatureArt({ kind }: { kind: 'sold' | 'works' | 'ask' }) {
  return (
    <svg viewBox="0 0 280 120" className="feat-art" aria-hidden="true">
      {kind === 'sold' && <>
        <path d="M16 96 L60 78 L104 84 L148 58 L192 62 L236 34 L264 26" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 96 L60 78 L104 84 L148 58 L192 62 L236 34 L264 26 V110 H16 Z" fill="var(--accent)" opacity=".1" />
        {[[60, 78], [148, 58], [236, 34]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2.5" />)}
        <rect x="150" y="12" width="78" height="22" rx="11" fill="var(--ink)" />
        <rect x="162" y="20" width="54" height="6" rx="3" fill="var(--paper)" opacity=".85" />
      </>}
      {kind === 'works' && <>
        {[[18, 74, 'var(--ink)'], [96, 52, 'var(--ai)'], [152, 62, 'var(--accent)'], [218, 44, 'var(--glow)']].map(([x, w, c]) => <rect key={x as number} x={x as number} y="26" width={w as number} height="18" rx="4" fill={c as string} />)}
        {[0, 1, 2].map((i) => <g key={i}><rect x="18" y={62 + i * 18} width={96 - i * 14} height="7" rx="3.5" fill="var(--line)" /><rect x="206" y={62 + i * 18} width={56 - i * 8} height="7" rx="3.5" fill="var(--ink)" opacity={0.75 - i * 0.2} /></g>)}
      </>}
      {kind === 'ask' && <>
        <rect x="70" y="14" width="194" height="34" rx="17" fill="var(--ink)" />
        <rect x="88" y="27" width="150" height="7" rx="3.5" fill="var(--paper)" opacity=".85" />
        <rect x="16" y="62" width="208" height="46" rx="18" fill="var(--surface)" stroke="var(--line)" />
        <path d="M38 76v18M30.200 80.500l15.600 9M45.800 80.500l-15.600 9" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
        <rect x="60" y="76" width="140" height="6" rx="3" fill="var(--line)" />
        <rect x="60" y="89" width="96" height="6" rx="3" fill="var(--line)" />
      </>}
    </svg>
  );
}

export default function Home() {
  const { recent, serverListings } = useStore();
  // Real homes first, newest first. Until agents and owners have listed enough, example homes fill the row, each tagged "Example".
  const real = useMemo(() => serverListings.filter((p) => p.status !== 'withdrawn' && p.visibility !== 'private')
    .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')).slice(0, 8), [serverListings]);
  const examples = useMemo(() => PROPERTIES.filter((p) => p.type !== 'commercial').slice(0, 8), []);
  const homes = real.length >= 4 ? real : [...real, ...examples].slice(0, 8);
  const onlyExamples = real.length === 0;
  const resume = recent[0];
  const resumeCount = useMemo(() => (resume ? runSearch(parseQuery(resume.mode === 'rent' ? `${resume.q} to rent` : resume.q)).length : 0), [resume]);

  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="hero-h">
        <div className="home-hero-inner">
          <div className="hero-copy">
            <h1 id="hero-h">Find a home<i className="stop">.</i><br /><span>Unlock the whole street<b className="stop">.</b></span></h1>
            <SmartSearch />
          </div>
        </div>
        <JourneyScene />
      </section>

      <div className="home-body">
        <ul className="trust" aria-label="On every home">
          {TRUST.map(([icon, title, source]) => (
            <li key={title}><span className="trust-ic"><Icon name={icon} size={20} /></span><span><b>{title}</b><small>{source}</small></span></li>
          ))}
        </ul>

        {resume && (
          <Link to={destination(resume.mode as Mode, resume.q)} className="resume-bar">
            <span className="trust-ic"><Icon name="clock" size={20} /></span>
            <span className="resume-bar-txt"><small>Pick up where you left off</small><b>{resume.q}</b></span>
            <span className="resume-bar-n">{resumeCount} home{resumeCount === 1 ? '' : 's'} <Icon name="arrow" size={16} /></span>
          </Link>
        )}

        <section aria-labelledby="home-latest">
          <div className="sec-head">
            <div>
              <h2 id="home-latest" className="home-h">{onlyExamples ? 'Homes to explore' : 'Latest homes'}</h2>
              {onlyExamples && <p className="sec-sub">Example listings, shown while agents and owners add theirs.</p>}
            </div>
            <Link to={destination('buy', 'homes for sale')} className="sec-link">See all homes <Icon name="arrow" size={16} /></Link>
          </div>
          <div className="carousel hcards">
            {homes.map((p, i) => <PropertyCard key={p.id} p={p} eager={i < 4} />)}
          </div>
        </section>

        <section aria-labelledby="home-places">
          <div className="sec-head"><h2 id="home-places" className="home-h">Popular places</h2></div>
          <ul className="places">
            {PLACES.map((pl) => (
              <li key={pl.name} className="place">
                <Link to={`/for-sale/${slugPlace(pl.name)}`} className="place-img" tabIndex={-1} aria-hidden="true"><HouseArt hue={pl.hue} type={pl.type} /></Link>
                <div className="place-body">
                  <b>{pl.name}</b>
                  <span className="place-links">
                    <Link to={`/for-sale/${slugPlace(pl.name)}`} aria-label={`Homes for sale in ${pl.name}`}>For sale</Link>
                    <Link to={`/to-rent/${slugPlace(pl.name)}`} aria-label={`Homes to rent in ${pl.name}`}>To rent</Link>
                    <Link to={`/sold-prices/${slugPlace(pl.name)}`} aria-label={`Sold prices in ${pl.name}`}>Sold prices</Link>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="home-why">
          <div className="sec-head"><h2 id="home-why" className="home-h">More than a listing</h2></div>
          <div className="feats">
            <Link to="/prices" className="feat">
              <FeatureArt kind="sold" />
              <b>See what homes really sold for</b>
              <p>Every sale registered with HM Land Registry, street by street, next to the asking price.</p>
              <span className="feat-go">Look up sold prices <Icon name="arrow" size={16} /></span>
            </Link>
            <Link to="/estimate" className="feat">
              <FeatureArt kind="works" />
              <b>Know the cost of the work first</b>
              <p>A trade-by-trade estimate for your area, with VAT, fees and a contingency, before you make an offer.</p>
              <span className="feat-go">Cost a renovation <Icon name="arrow" size={16} /></span>
            </Link>
            <Link to={destination('buy', '3 bed house with a garden under £450k near a station')} className="feat">
              <FeatureArt kind="ask" />
              <b>Search in your own words</b>
              <p>Describe the home you want. Streetkey turns it into the right filters and shows why each home matches.</p>
              <span className="feat-go">Try a search <Icon name="arrow" size={16} /></span>
            </Link>
          </div>
        </section>

        <section className="duo" aria-label="For owners">
          <div className="duo-card ink">
            <h2>Selling or letting? List it free.</h2>
            <p>Add your home in minutes. Streetkey checks your price against real sales, writes a first description for you to edit and draws your floor plan.</p>
            <div className="row" style={{ gap: 10 }}>
              <Link to="/list" className="btn accent">List your property <Icon name="arrow" size={18} /></Link>
              <Link to="/floor-plan" className="btn on-ink">Make a floor plan</Link>
            </div>
          </div>
          <div className="duo-card">
            <h2>Own a home? See what it is worth.</h2>
            <p>A value range from real sales nearby, ideas for adding value and what they would cost, in under a minute.</p>
            <div className="row"><Link to="/my-home" className="btn">Check my home <Icon name="arrow" size={18} /></Link></div>
          </div>
        </section>

        <section aria-labelledby="home-tools">
          <div className="sec-head"><h2 id="home-tools" className="home-h">Tools</h2></div>
          <div className="tool-row">
            {TOOLS.map(([to, icon, label]) => <Link key={to} to={to} className="tool"><span className="trust-ic"><Icon name={icon} size={20} /></span>{label}</Link>)}
          </div>
        </section>

        <section className="pro-band" aria-labelledby="home-pro">
          <div>
            <h2 id="home-pro">Agents and landlords</h2>
            <p>Put your listings on Streetkey free: a page for your agency, valuation requests, leads by email and results for every listing.</p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Link to="/agents" className="btn">For agents</Link>
            <Link to="/landlord" className="btn ghost">For landlords</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
