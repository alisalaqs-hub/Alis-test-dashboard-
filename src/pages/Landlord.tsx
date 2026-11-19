/**
 * For landlords: what advertising a rental on Streetkey involves and what you get. Streetkey is where
 * tenants find the property; the tenancy itself stays with the landlord or their agent.
 */
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icons';

const GET: [icon: string, title: string, text: string][] = [
  ['home', 'A full advert, free', 'Photos, a floor plan you can draw from your own measurements, the details tenants ask for (deposit, available date, furnishing, pets, bills) and a description you can write yourself or start with AI and edit.'],
  ['bell', 'Enquiries in one place', 'Viewing requests and questions arrive by email with the person’s name, email and phone, and in your Streetkey inbox. Reply from either.'],
  ['shield', 'Wording checked before it goes live', 'The advert is checked for things that cause landlords trouble: fees tenants cannot be charged, deposits above the legal limit, wording that discriminates, and rents that are not fixed.'],
  ['spark', 'Shown to the right tenants', 'Your advert goes straight to everyone whose saved search it matches, and appears on the map and in searches for your area.'],
];

const READY = ['The energy rating (EPC). A rental needs E or better, or a registered exemption.', 'The council tax band.', 'The monthly rent, the deposit and the date it is available.', 'Whether it is furnished, and whether you will consider pets.', 'Photos of every main room and the outside.'];

export default function LandlordPage() {
  return (
    <div className="stack join" style={{ gap: 34 }}>
      <header className="join-hero">
        <div className="eyebrow">For landlords</div>
        <h2>Advertise your rental on Streetkey, free</h2>
        <p>Put your property in front of people looking to rent, with the facts they want up front. It takes about five minutes.</p>
        <div className="row" style={{ gap: 10 }}>
          <Link to="/list" className="btn accent">List a property to let <Icon name="arrow" size={18} /></Link>
          <Link to="/floor-plan" className="btn ghost">Make a floor plan</Link>
        </div>
      </header>

      <section aria-labelledby="ll-get">
        <h3 id="ll-get" className="join-h">What you get</h3>
        <ul className="join-grid two">
          {GET.map(([icon, title, text]) => <li key={title} className="join-card"><span className="trust-ic"><Icon name={icon} size={20} /></span><b>{title}</b><p>{text}</p></li>)}
        </ul>
      </section>

      <div className="grid g2" style={{ gap: 18, alignItems: 'start' }}>
        <section className="card" aria-labelledby="ll-ready">
          <h3 id="ll-ready" className="join-h">Have these ready</h3>
          <ul className="ticks">{READY.map((r) => <li key={r}>{r}</li>)}</ul>
        </section>
        <section className="card" aria-labelledby="ll-how">
          <h3 id="ll-how" className="join-h">How it works</h3>
          <ol className="join-steps compact">
            <li><span className="join-n" aria-hidden="true">1</span><div><b>List your property</b><p>Fill in the form and add your photos.</p></div></li>
            <li><span className="join-n" aria-hidden="true">2</span><div><b>Streetkey checks it</b><p>Each new advert is looked at before it goes live.</p></div></li>
            <li><span className="join-n" aria-hidden="true">3</span><div><b>Reply and arrange viewings</b><p>Answer enquiries by email or in your inbox, and mark the property let when it is.</p></div></li>
          </ol>
        </section>
      </div>

      <p className="small muted" style={{ maxWidth: 720 }}>Streetkey is where tenants find your property. Referencing, the tenancy agreement, the deposit and the rent stay with you or your letting agent.</p>
    </div>
  );
}
