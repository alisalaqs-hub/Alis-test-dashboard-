/**
 * Flood risk from the Environment Agency (Open Government Licence v3.0). England only.
 *   - Long-term risk from rivers and the sea, and from surface water: the national flood risk
 *     assessment (NaFRA2, 2025), read from the Agency's map service at a point.
 *   - Flood alerts and warnings in force right now, and the warning areas a place sits in:
 *     the real-time flood-monitoring service.
 *
 * The map service answers in under a second but occasionally hangs, so each read has a short
 * timeout and one retry, and answers are kept for 30 days (the maps change a few times a year).
 * A place with no mapped risk is "very low", the wording the Agency's own service uses.
 */
import { parseBand, worstBand, type FloodBand, type FloodResult, type FloodSource, type FloodWarning } from '../../../src/engine/evidence';
import { config } from '../config';
import { cachedData, DAY } from './cache';
import { fetchJSON } from './http';

const LAYERS = {
  riversAndSea: { service: 'nafra2-risk-of-flooding-from-rivers-and-sea', layer: 'rofrs_4band' },
  surfaceWater: { service: 'nafra2-risk-of-flooding-from-surface-water', layer: 'rofsw' },
} as const;

/**
 * Ask; if there's no answer after `afterMs`, ask a second time and take whichever answers first.
 * About one map request in ten hangs, and a second request almost always returns within a second.
 */
function hedged<T>(ask: () => Promise<T>, afterMs = config.isTest ? 30 : 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = ask();
  const second = new Promise<T>((resolve, reject) => { timer = setTimeout(() => ask().then(resolve, reject), afterMs); });
  first.then(() => clearTimeout(timer), () => {});
  return Promise.any([first, second]);
}

/** The highest risk band mapped within `radiusM` of a point (null = no mapped risk there). Throws when the map can't be read. */
async function bandNear(kind: keyof typeof LAYERS, lat: number, lng: number, radiusM: number): Promise<FloodBand | null> {
  const { service, layer } = LAYERS[kind];
  // A 200 m box drawn as 101 × 101 pixels (about 2 m each), asking about the centre pixel with a search radius in pixels.
  const dy = 100 / 111_320, dx = dy / Math.cos((lat * Math.PI) / 180);
  const bbox = [lng - dx, lat - dy, lng + dx, lat + dy].map((n) => n.toFixed(6)).join(',');
  const url = `${config.data.floodMapsUrl}/${service}/wms?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=${layer}&query_layers=${layer}`
    + `&crs=CRS:84&bbox=${bbox}&width=101&height=101&i=50&j=50&buffer=${Math.max(1, Math.round(radiusM / 2))}&info_format=application/json&feature_count=20&propertyName=risk_band`;
  const features = await hedged(async () => {
    const { status, json } = await fetchJSON<{ features?: { properties?: { risk_band?: string } }[] }>(url, { source: 'environment-agency', timeoutMs: 6000, retries: 0 });
    if (status !== 200 || !json || !Array.isArray(json.features)) throw new Error(`flood map ${status}`);
    return json.features;
  });
  return worstBand(features.map((f) => parseBand(f.properties?.risk_band)));
}

async function source(kind: keyof typeof LAYERS, lat: number, lng: number): Promise<FloodSource | null> {
  try {
    // Most places have nothing mapped within 100 m, so that is asked first and the closer reading only when needed.
    const nearby = await bandNear(kind, lat, lng, 100);
    if (!nearby) return { here: 'very low', nearby: 'very low' };
    const here = await bandNear(kind, lat, lng, 15);
    return { here: here ?? 'very low', nearby: worstBand([here, nearby]) ?? 'very low' };
  } catch { return null; }
}

interface EaFlood { description?: string; message?: string; severity?: string; severityLevel?: number | string; timeMessageChanged?: string; floodArea?: { label?: string } }
/** Flood alerts and warnings in force within `km` of a point, most serious first. */
async function warningsNear(lat: number, lng: number, km = 5): Promise<FloodWarning[]> {
  const { status, json } = await fetchJSON<{ items?: EaFlood[] }>(`${config.data.floodWarningsUrl}/id/floods?lat=${lat.toFixed(5)}&long=${lng.toFixed(5)}&dist=${km}`, { source: 'environment-agency', timeoutMs: 6000 });
  if (status !== 200 || !json) throw new Error(`flood warnings ${status}`);
  return (json.items ?? []).map((f) => {
    const level = Number(f.severityLevel);
    return {
      level: (level >= 1 && level <= 4 ? level : 4) as FloodWarning['level'], severity: String(f.severity ?? 'Flood warning').slice(0, 60),
      area: String(f.description ?? f.floodArea?.label ?? 'Nearby').slice(0, 160), message: String(f.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), changedAt: f.timeMessageChanged ?? null,
    };
  }).sort((a, b) => a.level - b.level).slice(0, 5);
}

async function warningAreasNear(lat: number, lng: number, km = 1): Promise<string[]> {
  const { status, json } = await fetchJSON<{ items?: { label?: string; riverOrSea?: string }[] }>(`${config.data.floodWarningsUrl}/id/floodAreas?lat=${lat.toFixed(5)}&long=${lng.toFixed(5)}&dist=${km}&_limit=8`, { source: 'environment-agency', timeoutMs: 6000 });
  if (status !== 200 || !json) throw new Error(`flood areas ${status}`);
  return [...new Set((json.items ?? []).map((a) => String(a.label ?? '').slice(0, 120)).filter(Boolean))].slice(0, 6);
}

/**
 * Flood risk at a point. `approximate` says the point is a postcode centre or a rounded location
 * rather than the building. Outside England the Environment Agency has no data: coverage says so.
 */
export async function floodRisk(lat: number, lng: number, opts: { country?: string | null; approximate?: boolean } = {}): Promise<FloodResult> {
  const approximate = opts.approximate ?? true;
  const country = opts.country ?? null;
  if (country && country !== 'England') {
    return { coverage: 'not-covered', country, riversAndSea: null, surfaceWater: null, overall: null, warnings: [], warningAreas: [], approximate, checkedAt: new Date().toISOString() };
  }
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  // Long-term risk: kept for 30 days, but only stored when both maps answered, so a hang is retried next time.
  const longTerm = await cachedData(`flood:${key}`, 30 * DAY, async () => {
    const [riversAndSea, surfaceWater] = await Promise.all([source('riversAndSea', lat, lng), source('surfaceWater', lat, lng)]);
    if (!riversAndSea && !surfaceWater) throw new Error('flood maps unavailable');
    return { riversAndSea, surfaceWater };
  }, { store: (v) => !!v.riversAndSea && !!v.surfaceWater }).catch(() => ({ value: { riversAndSea: null as FloodSource | null, surfaceWater: null as FloodSource | null }, fetchedAt: new Date(), stale: false }));
  // What's in force now changes by the hour.
  const live = await cachedData(`floodnow:${lat.toFixed(2)},${lng.toFixed(2)}`, 900, async () => {
    const [warnings, areas] = await Promise.allSettled([warningsNear(lat, lng), warningAreasNear(lat, lng)]);
    if (warnings.status === 'rejected' && areas.status === 'rejected') throw new Error('flood warnings unavailable');
    return { warnings: warnings.status === 'fulfilled' ? warnings.value : [], warningAreas: areas.status === 'fulfilled' ? areas.value : [] };
  }).catch(() => ({ value: { warnings: [] as FloodWarning[], warningAreas: [] as string[] } }));
  const { riversAndSea, surfaceWater } = longTerm.value;
  return {
    coverage: 'england', country: country ?? 'England', riversAndSea, surfaceWater,
    overall: riversAndSea || surfaceWater ? worstBand([riversAndSea?.here, surfaceWater?.here]) : null,
    warnings: live.value.warnings.filter((w) => w.level <= 3), warningAreas: live.value.warningAreas, approximate, checkedAt: longTerm.fetchedAt.toISOString(),
  };
}
