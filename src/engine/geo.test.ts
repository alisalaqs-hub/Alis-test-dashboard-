import { describe, expect, it } from 'vitest';
import { boundsOf, milesBetween, pointInPolygon, type LngLat } from './geo';

describe('map geometry', () => {
  it('measures distance in miles', () => {
    const london: LngLat = [-0.1276, 51.5072], manchester: LngLat = [-2.2426, 53.4808];
    expect(milesBetween(london, manchester)).toBeGreaterThan(160);
    expect(milesBetween(london, manchester)).toBeLessThan(166);
    expect(milesBetween(london, london)).toBe(0);
  });
  it('knows whether a home is inside a drawn area', () => {
    const e17: LngLat[] = [[-0.04, 51.57], [0.0, 51.57], [0.0, 51.6], [-0.04, 51.6]];
    expect(pointInPolygon([-0.02, 51.585], e17)).toBe(true);
    expect(pointInPolygon([-0.07, 51.585], e17)).toBe(false);
    expect(pointInPolygon([-0.02, 51.62], e17)).toBe(false);
    // an L-shaped area: the notch is outside
    const l: LngLat[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    expect(pointInPolygon([1, 3], l)).toBe(true);
    expect(pointInPolygon([3, 3], l)).toBe(false);
    expect(pointInPolygon([1, 1], [[0, 0], [2, 2]])).toBe(false); // two corners are not an area
  });
  it('finds the box around points', () => {
    expect(boundsOf([[-2, 53], [0, 51], [-1, 52]])).toEqual([-2, 51, 0, 53]);
    expect(boundsOf([])).toBeNull();
  });
});
