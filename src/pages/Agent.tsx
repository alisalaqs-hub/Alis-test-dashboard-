/**
 * For estate and letting agents: what Streetkey gives an agency, what it costs, how to join and how
 * listings get here. Everything on this page is something the site does today.
 */
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icons';
import { useServer } from '../lib/server';

const GET: [icon: string, title: string, text: string][] = [
  ['home', 'Your stock, shown your way', 'Your photos, your description and your price. Streetkey adds official records (sold prices nearby, flood risk, the energy certificate) and never publishes its own opinion of your price.'],
  ['building', 'A page for your agency', 'Your homes for sale and to let in one place, with your phone number, website, redress and client money protection details, and a link to your fees.'],
  ['tag', 'Valuation requests', 'Owners can ask you for a valuation from your page. You get their name, contact details and postcode by email and in your account.'],
  ['bell', 'Leads you can act on', 'Every enquiry arrives by email with the person’s name, email, phone and the listing reference. Reply from your own mailbox or from your Streetkey inbox.'],
  ['chart', 'Results for every listing', 'Views, saves, enquiries and calls for each listing, with totals you can download as a spreadsheet for your vendors and landlords.'],
  ['spark', 'Matched to the right people', 'New listings go straight by email to everyone whose saved search they match.'],
];

const STEPS: [title: string, text: string][] = [
  ['Create your account', 'Choose “Estate agent” when you sign up. It takes a minute.'],
  ['Set up your agency', 'Add your agency name, redress scheme, client money protection scheme, phone number and a link to your fees. Streetkey checks each new agency before its first listings go live.'],
  ['Send your listings', 'Upload the file your agency software already produces for other portals, have your software send it automatically, or add a listing by hand.'],
];

export default function AgentPage() {
  const { user } = useServer();
  return (
    <div className="stack join" style={{ gap: 34 }}>
      <header className="join-hero">
        <div className="eyebrow">For estate and letting agents</div>
        <h2>Your listings on Streetkey, free</h2>
        <p>Streetkey is a property portal for homes for sale and to let. Listing is free for agents. You keep your leads, your brand and your prices.</p>
        <div className="row" style={{ gap: 10 }}>
          <Link to="/account/agency" className="btn accent">{user ? 'Go to your agency' : 'Create your agency'} <Icon name="arrow" size={18} /></Link>
          <a href="#feeds" className="btn ghost">How listings get here</a>
        </div>
      </header>

      <section aria-labelledby="join-get">
        <h3 id="join-get" className="join-h">What you get</h3>
        <ul className="join-grid">
          {GET.map(([icon, title, text]) => <li key={title} className="join-card"><span className="trust-ic"><Icon name={icon} size={20} /></span><b>{title}</b><p>{text}</p></li>)}
        </ul>
      </section>

      <section aria-labelledby="join-steps">
        <h3 id="join-steps" className="join-h">Three steps to join</h3>
        <ol className="join-steps">
          {STEPS.map(([title, text], i) => <li key={title}><span className="join-n" aria-hidden="true">{i + 1}</span><div><b>{title}</b><p>{text}</p></div></li>)}
        </ol>
      </section>

      <section id="feeds" aria-labelledby="join-feeds" className="card join-feeds">
        <h3 id="join-feeds" className="join-h">How listings get here</h3>
        <dl className="join-dl">
          <dt>Upload a file</dt>
          <dd>Export your stock from your agency software as a BLM file (the format it already makes for other portals) and upload it from your agency page. You get a report of what was added, changed and withdrawn, and the reason for anything that was not accepted.</dd>
          <dt>Send it automatically</dt>
          <dd>Create a feed key on your agency page and ask your software supplier to send the same file to Streetkey’s feed address each time your stock changes. Each file is your full stock for that key: listings no longer in it are withdrawn.</dd>
          <dt>Add a listing by hand</dt>
          <dd>Use the same form owners and landlords use, listed under your agency.</dd>
        </dl>
        <p className="small muted">Delivery by FTP is not available yet. Photos in a feed need to be on a public web address.</p>
      </section>

      <section className="pro-band" aria-labelledby="join-cta">
        <div>
          <h3 id="join-cta" style={{ fontSize: '1.3rem' }}>Ready when you are</h3>
          <p>Set up your agency now and upload your first file in a few minutes.</p>
        </div>
        <Link to="/account/agency" className="btn">{user ? 'Go to your agency' : 'Create your agency'}</Link>
      </section>
    </div>
  );
}
