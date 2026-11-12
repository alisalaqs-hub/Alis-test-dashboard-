/**
 * Price history for a real listing: when it was first listed, how long it has been on the market
 * and every change to the asking price, from Streetkey's own record of the listing. These are facts
 * (not estimates), so the block looks like the official-data blocks and carries a "record" tag.
 * Example listings don't use it.
 */
import { historyDate, historyPrice, latestPriceMove, listedLine, onMarketParts, priceChangeLine, type ListingHistory } from '../engine/history';
import { Section, Stat, Tag } from './ui';
import '../styles/history.css';

/** The "Reduced" tag shown beside the price when the latest change to it was a reduction. */
export function ReducedTag({ history, rental }: { history?: ListingHistory | null; rental: boolean }) {
  if (latestPriceMove(history) !== 'reduced' || !history) return null;
  const last = history.priceChanges[history.priceChanges.length - 1];
  return <Tag kind="rec" title={priceChangeLine(last, rental)}>Reduced</Tag>;
}

/** A history sentence with its date kept on one line ("3 Nov 2026" never splits across lines on a narrow phone). */
function Line({ text, at }: { text: string; at: string }) {
  const date = historyDate(at);
  const i = date ? text.lastIndexOf(date) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<span className="lh-date">{date}</span>{text.slice(i + date.length)}</>;
}

/** closed: the listing has been sold, let or withdrawn, so its time on the market has ended. */
export function PriceHistory({ history, rental, closed = false }: { history: ListingHistory; rental: boolean; closed?: boolean }) {
  const onMarket = onMarketParts(history.daysOnMarket, closed);
  const changes = history.priceChanges;
  const what = rental ? 'rent' : 'asking price';
  // Withdrawn for a while and listed again: the days on the market are fewer than the days since it was first listed.
  const offForAWhile = Math.floor((Date.now() - Date.parse(history.firstListedAt)) / 86_400_000) > history.daysOnMarket;
  return (
    <Section title="Price history" kicker="Listing history" right={<Tag kind="neutral" title="Recorded by Streetkey while this home has been listed here">Streetkey record</Tag>}>
      <Stat label={onMarket.label} value={onMarket.value} sub={<>First listed <span className="lh-date">{historyDate(history.firstListedAt)}</span>{!closed && offForAWhile ? '. Time off the market isn’t counted.' : ''}</>} />
      <ol className="lh-list" role="list" aria-label={`Changes to the ${what}, oldest first`}>
        <li><Line text={listedLine(history, rental)} at={history.firstListedAt} /></li>
        {changes.map((c) => (
          <li key={`${c.at}-${c.to}`}>
            <Line text={priceChangeLine(c, rental)} at={c.at} /> <span className="lh-to">to <span className="num">{historyPrice(c.to, rental)}</span></span>
          </li>
        ))}
      </ol>
      <p className="xs muted lh-note">
        {changes.length === 0 ? `The ${what} hasn’t changed since this home was listed. ` : ''}
        Streetkey shows every change to the {what} made while a home is listed here. Changes made before it came to Streetkey aren’t included.
      </p>
    </Section>
  );
}
