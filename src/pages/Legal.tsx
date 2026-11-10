import { Link } from 'react-router-dom';
import { Tag } from '../components/ui';
import { ATTRIBUTION } from '../engine/evidence';

/**
 * DRAFT legal pages for the public preview. They describe what this build actually does.
 * [Bracketed] items must be completed, and all text reviewed by a solicitor, before full launch.
 */
const UPDATED = '10 November 2026';
function Draft() {
  return <div className="callout small" role="note"><b>Draft.</b> Items in [brackets] must be completed and this page reviewed by a solicitor before Streetkey is promoted to the public.</div>;
}

export function Privacy() {
  return (
    <article className="legal stack" style={{ gap: 12 }}>
      <div className="row"><span className="label-mono">Legal</span><Tag kind="demo">Draft</Tag></div>
      <h1 style={{ fontSize: '2.2rem' }}>Privacy notice</h1>
      <p className="muted small">Last updated {UPDATED}</p>
      <Draft />
      <h2>Who we are</h2>
      <p>Streetkey is operated by [Company name], [registered address], company number [number]. We are the data controller and are registered with the Information Commissioner’s Office under number [ICO registration number]. Contact: [privacy contact email].</p>

      <h2>What we collect and why</h2>
      <ul>
        <li><b>Your account.</b> Email address, name, a password (stored only as a one-way hash), the kind of account you chose and, if you give it, a phone number. We use these to sign you in, to send you messages you asked for, and to keep your account secure. Lawful basis: contract.</li>
        <li><b>Listings you create.</b> The address, details, price, photos and description of the home, and your declaration that you may list it. For private sellers and landlords the house number and full postcode are never shown publicly: the advert shows the street and the first half of the postcode. Location data is removed from photos when you upload them. Lawful basis: contract.</li>
        <li><b>Enquiries and messages.</b> Your name, email, phone number if given, your message and any viewing time you asked for. These are passed to the person or agency who listed the home, through Streetkey’s messaging, so that they can reply. Lawful basis: contract and legitimate interests.</li>
        <li><b>Saved homes, saved searches and alerts.</b> Kept with your account so they follow you between devices, and used to email you about new matches if you ask for alerts. Lawful basis: contract; marketing emails only with your consent.</li>
        <li><b>How listings are used.</b> If you choose “Allow analytics” on a listing page, anonymous events (for example “photo enlarged”) are recorded against a random session number, not your account, so that listers can see how their advert is doing. Lawful basis: consent.</li>
        <li><b>Security records.</b> Sign-in sessions, a log of important account actions, and short-lived counters by network address that stop abuse. Our host keeps standard server logs. Lawful basis: legitimate interests.</li>
      </ul>

      <h2>How we use AI</h2>
      <ul>
        <li>Some features use AI models provided by OpenAI: the Ask Streetkey assistant, plain-English search, the description writer, listing and enquiry checks, briefings, and (only if you choose to and tick the consent box) analysing or redesigning photos you upload. What you type or upload for those features is sent to OpenAI to produce the answer. Under OpenAI’s terms for business API customers it is not used to train their models.</li>
        <li>We record how much AI is used and by whom, to control cost and abuse. We do not keep the text of your questions or the AI’s answers, except results you save (for example a room design) and the summaries described below.</li>
        <li><b>Automated checks.</b> Every listing sent for publication is checked automatically for scams, misleading or discriminatory wording and missing legal information, and each new enquiry is checked for spam and scams. These checks produce a risk summary for a person to act on. A person at Streetkey, not the AI, decides whether a private listing is refused, and a lister can release a message that was held back. You can ask us to review any decision: [contact email].</li>
      </ul>

      <h2>Official data we look up</h2>
      <p>When you search sold prices, view a listing or list a home, our server asks public services for information about the place: HM Land Registry (sold prices), the Environment Agency (flood risk), the government’s energy certificate register, and postcodes.io (postcode locations). We send them only the postcode or place, never your name or account details. Energy certificates are address-level records, so we only look one up for a home that is being listed. See <Link to="/data-sources">Data sources</Link>.</p>

      <h2>Who we share data with</h2>
      <ul>
        <li>The lister, when you enquire about their home (your name, contact details and message).</li>
        <li>Our service providers, who act only on our instructions: [Netlify] (hosting, files and database), [OpenAI] (AI features), [Resend] (sending email). Some are based outside the UK; where they are, we rely on [UK adequacy regulations / the UK International Data Transfer Addendum].</li>
        <li>We do not sell personal data and we use no advertising trackers. Fonts are served from our own site.</li>
      </ul>

      <h2>How long we keep it</h2>
      <p>Account details: until you delete your account. Withdrawn listings and enquiries: [period] for our records and to handle complaints. Security logs: [period]. Photos uploaded for a one-off cost estimate are deleted as soon as the estimate is done.</p>

      <h2>Your rights</h2>
      <p>Under UK GDPR you can ask to see, correct or delete your data, object to or restrict how we use it, and withdraw consent at any time. You can download everything we hold about you, including automated assessments, and delete your account yourself from <Link to="/account">your account page</Link>. Deleting your account removes your details, saved items, design photos and AI results, and withdraws your listings. You can complain to the ICO (ico.org.uk).</p>

      <h2>The static preview</h2>
      <p>Where Streetkey is shown as a preview without accounts, nothing is sent to us: saved items and anything you create stay in your browser’s storage.</p>

      <h2>Links to other sites</h2>
      <p>“Search everywhere” links open Rightmove, Zoopla and OnTheMarket in a new tab. Their own privacy notices apply there.</p>
    </article>
  );
}

export function Terms() {
  return (
    <article className="legal stack" style={{ gap: 12 }}>
      <div className="row"><span className="label-mono">Legal</span><Tag kind="demo">Draft</Tag></div>
      <h1 style={{ fontSize: '2.2rem' }}>Terms of use</h1>
      <p className="muted small">Last updated {UPDATED}</p>
      <Draft />
      <h2>Early access</h2>
      <p>Streetkey is in early access. Homes marked <b>“Demo data”</b> or <b>“Fictional listing”</b> are illustrations: they are not for sale or to let, and their figures are made up. Other listings are placed by their owners, landlords or agents, who are responsible for them.</p>
      <h2>Figures and estimates are not advice</h2>
      <p>Sold prices, average prices, flood risk and energy ratings come from official public records (see <Link to="/data-sources">Data sources</Link>) and are shown as those sources publish them; they can be incomplete or out of date. Refurbishment costs, rent and value ranges, tax figures, investment returns and development screening are indicative estimates from automated tools. None of this is financial, tax, legal, mortgage, planning, surveying or RICS valuation advice. Always get advice from a qualified professional before you decide.</p>
      <h2>AI features</h2>
      <p>AI-written text is labelled. It can be wrong. Figures shown come from Streetkey’s calculators or official records, not from the AI. Check anything important before relying on it.</p>
      <h2>If you list a home</h2>
      <ul>
        <li>You must own the home or have the right to market it, and what you say about it must be accurate, complete and not misleading. You are responsible for the legal information buyers and tenants need (tenure, council tax band, energy certificate, charges).</li>
        <li>No discriminatory wording, no rental bidding and no banned tenant fees. Label photos that have been virtually staged or edited.</li>
        <li>We check listings before they are published, may ask for changes, and may remove a listing that breaks these terms or the law.</li>
        <li>[If Streetkey introduces buyers or tenants to private sellers and landlords, add: redress scheme membership, anti-money-laundering supervision and fees.]</li>
      </ul>
      <h2>If you contact a lister</h2>
      <p>Be honest about who you are. Don’t send spam, scams or abuse. Never pay a deposit or fee before you have viewed a home and checked who you are dealing with. Messages are checked automatically for scams and some may be held back.</p>
      <h2>Your content</h2>
      <p>You keep the rights to what you upload and give us permission to show it on Streetkey for as long as your listing or design is live. Don’t upload anything you don’t have the right to use.</p>
      <h2>Other websites</h2>
      <p>We link to other property websites; we don’t control them and don’t copy their content.</p>
      <h2>Liability</h2>
      <p>The service is provided “as is” during early access. To the extent the law allows, [Company name] is not liable for losses arising from reliance on figures or estimates shown, or from dealings between listers and enquirers. Nothing limits liability that cannot be limited by law.</p>
      <h2>Law</h2>
      <p>These terms are governed by the law of England and Wales. Questions: [contact email].</p>
    </article>
  );
}

/** Where Streetkey's official data comes from, with the wording each licence asks for. */
export function DataSources() {
  return (
    <article className="legal stack" style={{ gap: 12 }}>
      <div className="row"><span className="label-mono">Legal</span></div>
      <h1 style={{ fontSize: '2.2rem' }}>Data sources</h1>
      <p className="muted small">Last updated {UPDATED}</p>
      <p>Streetkey shows official public data alongside listings. It is shown as the source publishes it, and it can be incomplete or out of date. Demo listings and their figures are illustrations and are labelled “Demo data”.</p>

      <h2>Sold prices and average prices: HM Land Registry</h2>
      <p>Sold prices come from HM Land Registry’s Price Paid Data, which covers residential sales in England and Wales registered since 1995. Sales appear once they are registered, usually two weeks to two months after completion. Area averages and yearly change come from the UK House Price Index (HM Land Registry and the Office for National Statistics).</p>
      <p className="small">{ATTRIBUTION.landRegistry}</p>
      <p className="small">The address data in Price Paid Data is used with the permission of Royal Mail and Ordnance Survey, for the purpose of providing residential property price information.</p>

      <h2>Flood risk: Environment Agency</h2>
      <p>Long-term flood risk from rivers and the sea and from surface water comes from the Environment Agency’s national flood risk assessment; flood alerts and warnings come from its live flood-monitoring service. Both cover England only. Streetkey reads the risk at the centre of a postcode, not at a building, so it is a guide and not a survey.</p>
      <p className="small">{ATTRIBUTION.environmentAgency}</p>

      <h2>Energy certificates: Ministry of Housing, Communities and Local Government</h2>
      <p>Energy ratings can be checked against the register of Energy Performance Certificates for England and Wales. Streetkey looks a certificate up only for a home that is being listed.</p>
      <p className="small">{ATTRIBUTION.epc}</p>
      <p className="small">Ordnance Survey and Royal Mail Group Limited reserve all their respective copyright, database rights, trademarks and other intellectual property rights in the address data. Any use of the address data that is not for a purpose related to the energy performance of buildings needs a licence from Ordnance Survey (PricingLicensing@os.uk) or Royal Mail (address.management@royalmail.com).</p>

      <h2>Postcodes and places</h2>
      <p className="small">{ATTRIBUTION.postcodes}</p>

      <h2>Not connected yet</h2>
      <p>School ratings, journey times, planning applications, conservation areas, subsidence and radon are not connected to official sources yet. Streetkey doesn’t show them for real listings; on demo listings they are illustrations.</p>
      <p><Link to="/prices">Search sold prices</Link></p>
    </article>
  );
}

export function Accessibility() {
  return (
    <article className="legal stack" style={{ gap: 12 }}>
      <div className="row"><span className="label-mono">Legal</span><Tag kind="demo">Draft</Tag></div>
      <h1 style={{ fontSize: '2.2rem' }}>Accessibility statement</h1>
      <p className="muted small">Last updated {UPDATED}</p>
      <p>We want everyone to be able to use Streetkey. We design to the Web Content Accessibility Guidelines (WCAG) 2.2 level AA.</p>
      <h2>What we’ve tested</h2>
      <ul>
        <li>An automated audit (axe-core) of every screen in light and dark themes, on desktop and mobile, reports no WCAG 2.2 A or AA failures.</li>
        <li>The site works with a keyboard alone, has a skip link and visible focus, and respects “reduce motion” settings.</li>
        <li>Text and controls meet colour-contrast requirements in both themes.</li>
      </ul>
      <h2>Known limitations</h2>
      <ul>
        <li>We have not yet completed testing with screen readers (VoiceOver, NVDA, TalkBack) or with disabled users.</li>
        <li>Some charts rely on visual layout; the same figures are available as text or tables nearby.</li>
        <li>Property images in the preview are illustrations without detailed descriptions.</li>
      </ul>
      <h2>Tell us about a problem</h2>
      <p>If something doesn’t work for you, email [accessibility contact email] and we’ll respond within 5 working days.</p>
      <p><Link to="/">Back to Streetkey</Link></p>
    </article>
  );
}
