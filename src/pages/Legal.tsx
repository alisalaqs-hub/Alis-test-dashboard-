import { Link } from 'react-router-dom';
import { Tag } from '../components/ui';

/**
 * DRAFT legal pages for the public preview. They describe what this build actually does.
 * [Bracketed] items must be completed, and all text reviewed by a solicitor, before full launch.
 */
const UPDATED = '8 November 2026';
function Draft() {
  return <div className="callout small" role="note"><b>Draft for the public preview.</b> Items in [brackets] must be completed and this page reviewed by a solicitor before Streetkey launches with real listings or user accounts.</div>;
}

export function Privacy() {
  return (
    <article className="legal stack" style={{ gap: 12 }}>
      <div className="row"><span className="label-mono">Legal</span><Tag kind="demo">Draft</Tag></div>
      <h1 style={{ fontSize: '2.2rem' }}>Privacy notice</h1>
      <p className="muted small">Last updated {UPDATED}</p>
      <Draft />
      <h2>Who we are</h2>
      <p>Streetkey is operated by [Company name], [registered address], company number [number]. We are registered with the Information Commissioner’s Office under number [ICO registration number]. Contact: [privacy contact email].</p>
      <h2>What this preview collects</h2>
      <ul>
        <li><b>No accounts.</b> You don’t sign up, and we don’t ask for your name or email.</li>
        <li><b>Your saved items stay on your device.</b> Saved homes, searches, designs, listings you create, photos you upload and your theme choice are stored in your browser’s local storage. They are not sent to us. Clearing your browser data deletes them.</li>
        <li><b>Optional analytics.</b> If you choose “Allow analytics” on a listing page, anonymous interaction events (for example “photo enlarged”) are kept in your browser for that session to demonstrate how owner insights work. In this preview they are not sent to a server. Choosing “Essential only” stops this and clears them.</li>
        <li><b>Postcode lookup.</b> When you tap “Find” while listing a property, the postcode is sent to postcodes.io (an open postcode service) to look up the area.</li>
        <li><b>Hosting.</b> Our host keeps standard server logs, including IP addresses, for security and reliability. [Host name, e.g. GitHub Pages / Netlify] processes these under its own privacy terms.</li>
        <li><b>No advertising trackers.</b> We use no third-party advertising or tracking cookies. Fonts are served from our own site.</li>
      </ul>
      <h2>Links to other sites</h2>
      <p>“Search everywhere” links open Rightmove, Zoopla and OnTheMarket in a new tab. Their own privacy notices apply there.</p>
      <h2>Your rights</h2>
      <p>Under UK GDPR you can ask to access, correct or delete personal data we hold, object to processing, and complain to the ICO (ico.org.uk). In this preview we hold almost nothing about you, because your data stays in your browser.</p>
      <h2>When this changes</h2>
      <p>Before we add accounts, real listings or messaging, we will update this notice, explain each use of your data and its lawful basis, and ask for consent where the law requires it.</p>
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
      <h2>This is a public preview</h2>
      <p>Streetkey is in preview. <b>All listings, agents, owners, engagement figures and market data shown are fictional demonstration data.</b> No property shown is for sale or to let.</p>
      <h2>Estimates are not advice</h2>
      <p>Refurbishment costs, valuations, rents, tax figures, investment returns and development screening are indicative estimates from automated tools. They are not financial, tax, legal, mortgage, planning, surveying or RICS valuation advice. Always get advice from a qualified professional before making decisions.</p>
      <h2>Your content</h2>
      <p>Listings, photos and designs you create in the preview stay in your browser and are not published to other people. Don’t upload anything you don’t have the right to use. Don’t post misleading or discriminatory content.</p>
      <h2>Other websites</h2>
      <p>We link to other property websites; we don’t control them and don’t copy their content.</p>
      <h2>Liability</h2>
      <p>The preview is provided “as is”. To the extent the law allows, [Company name] is not liable for losses arising from reliance on estimates shown. Nothing limits liability that cannot be limited by law.</p>
      <h2>Law</h2>
      <p>These terms are governed by the law of England and Wales. Questions: [contact email].</p>
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
