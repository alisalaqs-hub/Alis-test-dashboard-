/**
 * Small geometry for the map search: distance between two points, and whether a home is inside an
 * area someone has drawn. Points are [longitude, latitude], as maps use them.
 */
export type LngLat = [number, number];

const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function milesBetween([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Is the point inside the polygon (corners in order, not repeated)? Fewer than three corners is no area at all. */
export function pointInPolygon([x, y]: LngLat, polygon: LngLat[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The box around some points: [west, south, east, north], or null when there are none. */
export function boundsOf(points: LngLat[]): [number, number, number, number] | null {
  if (!points.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of points) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  return [w, s, e, n];
}
