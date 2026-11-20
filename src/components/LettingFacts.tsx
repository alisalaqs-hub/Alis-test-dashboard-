/**
 * Letting details on a rental listing.
 *
 *  - <LettingFacts p={property} />: a definition list for the listing page (Deposit, Available from, Furnishing,
 *    Pets, Bills, Maximum occupants, Let type, HMO licence, and the energy rating when a registered exemption is
 *    declared). Rows only for what the lister has said; nothing at all for a sale or a rental with no details.
 *    It has no heading of its own: put it under the page's own (for example "Letting details").
 *  - lettingLine(p): a short line for search cards, such as "Available 1 Dec · Furnished" or "Available now ·
 *    Unfurnished" (an empty string for sales, or when nothing is known).
 *
 * The wording lives in src/engine/letting.ts (no React), so the server and the tests use the same.
 */
import { lettingLine as line, lettingRows, type LetFacts } from '../engine/letting';
import '../styles/letting.css';

/** A short line for search cards: "Available 1 Dec · Furnished". Empty for sales or when nothing is known. */
export const lettingLine = (p: LetFacts): string => line(p);

/** Whether there is anything to show (so the page can leave out the section's heading too). */
export const hasLettingFacts = (p: LetFacts): boolean => lettingRows(p).length > 0;

export function LettingFacts({ p, className }: { p: LetFacts; className?: string }) {
  const rows = lettingRows(p);
  if (!rows.length) return null;
  return (
    <dl className={`letting-facts${className ? ` ${className}` : ''}`}>
      {rows.map((r) => (
        <div key={r.label} className="letting-fact">
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default LettingFacts;
