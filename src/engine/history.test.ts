import { describe, expect, it } from 'vitest';
import { daysOnMarket, historyDate, historyPrice, latestPriceMove, listedLine, onMarketLine, onMarketParts, priceChangeLine, summariseHistory, type ListingEvent } from './history';

const NOW = new Date('2026-12-01T12:00:00Z');
const ev = (kind: ListingEvent['kind'], at: string, price = 485_000, oldPrice: number | null = null): ListingEvent => ({ kind, at, price, oldPrice });

describe('days on the market', () => {
  it('counts whole days from first listed until now', () => {
    expect(daysOnMarket([ev('listed', '2026-11-03T09:00:00Z')], NOW)).toBe(28);
    expect(daysOnMarket([ev('listed', '2026-12-01T09:00:00Z')], NOW)).toBe(0); // listed this morning
    expect(daysOnMarket([ev('listed', '2026-11-30T12:00:00Z')], NOW)).toBe(1);
    expect(daysOnMarket([ev('listed', '2026-11-30T12:00:01Z')], NOW)).toBe(0); // a second short of a day
  });

  it('is null for a listing that has never been on the market', () => {
    expect(daysOnMarket([], NOW)).toBeNull();
    expect(daysOnMarket([ev('withdrawn', '2026-11-03T09:00:00Z')], NOW)).toBeNull();
  });

  it('keeps counting while under offer and stops when sold, let or withdrawn', () => {
    const listed = ev('listed', '2026-11-01T00:00:00Z');
    expect(daysOnMarket([listed, ev('under_offer', '2026-11-10T00:00:00Z')], NOW)).toBe(30);
    expect(daysOnMarket([listed, ev('under_offer', '2026-11-10T00:00:00Z'), ev('available', '2026-11-12T00:00:00Z')], NOW)).toBe(30);
    expect(daysOnMarket([listed, ev('under_offer', '2026-11-10T00:00:00Z'), ev('sold', '2026-11-21T00:00:00Z')], NOW)).toBe(20);
    expect(daysOnMarket([listed, ev('let', '2026-11-08T00:00:00Z')], NOW)).toBe(7);
    expect(daysOnMarket([listed, ev('withdrawn', '2026-11-05T12:00:00Z')], NOW)).toBe(4);
  });

  it('leaves out the time a listing was off the market before it was relisted', () => {
    const events = [ev('listed', '2026-10-01T00:00:00Z'), ev('withdrawn', '2026-10-11T00:00:00Z'), ev('relisted', '2026-11-21T00:00:00Z')];
    expect(daysOnMarket(events, NOW)).toBe(20); // 10 days, a gap, then 10 and a half more
    // parts of days add up across the gap rather than being rounded away each time
    expect(daysOnMarket([ev('listed', '2026-10-01T00:00:00Z'), ev('withdrawn', '2026-10-01T18:00:00Z'), ev('relisted', '2026-11-30T18:00:00Z')], NOW)).toBe(1);
  });

  it('does not depend on the order events arrive in, and ignores repeats and bad dates', () => {
    const events = [ev('relisted', '2026-11-21T00:00:00Z'), ev('listed', '2026-10-01T00:00:00Z'), ev('withdrawn', '2026-10-11T00:00:00Z'), ev('withdrawn', '2026-10-12T00:00:00Z'), ev('price_change', 'not a date', 1, 2)];
    expect(daysOnMarket(events, NOW)).toBe(20);
    expect(daysOnMarket([ev('listed', '2026-11-01T00:00:00Z'), ev('relisted', '2026-11-20T00:00:00Z')], NOW)).toBe(30); // already on the market: nothing restarts
    expect(daysOnMarket([ev('listed', '2026-12-05T00:00:00Z')], NOW)).toBe(0); // a clock ahead of ours never gives a negative count
  });
});

describe('the public summary', () => {
  it('gives the first listing, days on the market and each price change, oldest first', () => {
    const h = summariseHistory([
      ev('price_change', '2026-11-27T10:00:00Z', 470_000, 475_000),
      ev('listed', '2026-11-03T09:00:00Z', 485_000),
      ev('price_change', '2026-11-20T10:00:00Z', 475_000, 485_000),
      ev('under_offer', '2026-11-29T10:00:00Z', 470_000),
    ], NOW);
    expect(h).toEqual({
      firstListedAt: '2026-11-03T09:00:00Z', firstListedPrice: 485_000, daysOnMarket: 28,
      priceChanges: [{ at: '2026-11-20T10:00:00Z', from: 485_000, to: 475_000 }, { at: '2026-11-27T10:00:00Z', from: 475_000, to: 470_000 }],
    });
  });

  it('holds prices and dates only', () => {
    const h = summariseHistory([ev('listed', '2026-11-03T09:00:00Z'), ev('price_change', '2026-11-20T10:00:00Z', 475_000, 485_000), ev('withdrawn', '2026-11-25T10:00:00Z', 475_000), ev('relisted', '2026-11-28T10:00:00Z', 475_000)], NOW)!;
    expect(Object.keys(h).sort()).toEqual(['daysOnMarket', 'firstListedAt', 'firstListedPrice', 'priceChanges']);
    expect(Object.keys(h.priceChanges[0]).sort()).toEqual(['at', 'from', 'to']);
    expect(JSON.stringify(h)).not.toMatch(/withdrawn|relisted/);
  });

  it('is null until the listing has been on the market, and skips changes that changed nothing', () => {
    expect(summariseHistory([], NOW)).toBeNull();
    expect(summariseHistory([ev('price_change', '2026-11-20T10:00:00Z', 475_000, 485_000)], NOW)).toBeNull();
    const h = summariseHistory([ev('listed', '2026-11-03T09:00:00Z'), ev('price_change', '2026-11-20T10:00:00Z', 485_000, 485_000), ev('price_change', '2026-11-21T10:00:00Z', 480_000)], NOW)!;
    expect(h.priceChanges).toEqual([]);
  });

  it('says which way the latest change went', () => {
    const changes = (...c: [number, number][]) => ({ priceChanges: c.map(([from, to], i) => ({ at: `2026-11-${10 + i}T10:00:00Z`, from, to })) });
    expect(latestPriceMove(null)).toBeNull();
    expect(latestPriceMove(changes())).toBeNull();
    expect(latestPriceMove(changes([485_000, 475_000]))).toBe('reduced');
    expect(latestPriceMove(changes([485_000, 475_000], [475_000, 480_000]))).toBe('increased'); // reduced earlier, but put up since
    expect(latestPriceMove(changes([485_000, 490_000], [490_000, 470_000]))).toBe('reduced');
  });
});

describe('wording', () => {
  it('writes dates the British way, in UK time', () => {
    expect(historyDate('2026-11-03T09:00:00Z')).toBe('3 Nov 2026');
    expect(historyDate('2026-06-30T23:30:00Z')).toBe('1 Jul 2026'); // 00:30 on 1 July, British Summer Time
    expect(historyDate('2026-12-31T23:30:00Z')).toBe('31 Dec 2026'); // winter: UK time is UTC
    expect(historyDate('nonsense')).toBe('');
  });

  it('formats prices in whole pounds, with pcm for rentals', () => {
    expect(historyPrice(485_000)).toBe('£485,000');
    expect(historyPrice(1_250, true)).toBe('£1,250 pcm');
    expect(historyPrice(1_249.5, true)).toBe('£1,250 pcm');
  });

  it('describes when a home was listed', () => {
    expect(listedLine({ firstListedAt: '2026-11-03T09:00:00Z', firstListedPrice: 485_000 })).toBe('Listed at £485,000 on 3 Nov 2026');
    expect(listedLine({ firstListedAt: '2026-11-03T09:00:00Z', firstListedPrice: 1_250 }, true)).toBe('Listed at £1,250 pcm on 3 Nov 2026');
  });

  it('describes a price change with the amount and the share of the old price', () => {
    expect(priceChangeLine({ at: '2026-11-20T10:00:00Z', from: 485_000, to: 475_000 })).toBe('Reduced by £10,000 (2.1%) on 20 Nov 2026');
    expect(priceChangeLine({ at: '2026-12-02T10:00:00Z', from: 500_000, to: 505_000 })).toBe('Increased by £5,000 (1.0%) on 2 Dec 2026');
    expect(priceChangeLine({ at: '2026-11-20T10:00:00Z', from: 1_250, to: 1_200 }, true)).toBe('Reduced by £50 pcm (4.0%) on 20 Nov 2026');
    expect(priceChangeLine({ at: '2026-11-20T10:00:00Z', from: 2_000_000, to: 1_999_500 })).toBe('Reduced by £500 on 20 Nov 2026'); // 0.025% would read as 0.0%
  });

  it('describes the time on the market', () => {
    expect(onMarketLine(0)).toBe('Listed today');
    expect(onMarketLine(1)).toBe('On the market for 1 day');
    expect(onMarketLine(28)).toBe('On the market for 28 days');
    expect(onMarketLine(1_200)).toBe('On the market for 1,200 days');
    expect(onMarketLine(20, true)).toBe('Was on the market for 20 days');
    expect(onMarketLine(0, true)).toBe('Was on the market for less than a day');
    // the same words split into a label and a headline figure
    expect(onMarketParts(28)).toEqual({ label: 'On the market for', value: '28 days' });
    expect(onMarketParts(1, true)).toEqual({ label: 'Was on the market for', value: '1 day' });
    expect(onMarketParts(0)).toEqual({ label: 'On the market', value: 'Listed today' });
    expect(onMarketParts(-3)).toEqual({ label: 'On the market', value: 'Listed today' });
  });
});
