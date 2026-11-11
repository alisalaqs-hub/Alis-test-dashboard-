import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, MapLibreMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LngLat } from '../engine/geo';
import '../styles/map.css';

/**
 * The search map: a real street map (OpenStreetMap data, served free by OpenFreeMap) with a price pin
 * for each home, and a "draw your area" tool: click round the area you want and only homes inside it
 * are shown.
 *
 * Loaded only when the search page opens (it is a large library). If the map can't start (no WebGL,
 * the map service unreachable), onFail lets the page fall back to its simple map.
 * Keyboard: the map pans and zooms with the arrow and +/- keys, and every pin is a button. Drawing an
 * area needs a pointer; searching by place name does the same job without one.
 */
const STYLE_URL: string = import.meta.env.VITE_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron';
setWorkerUrl(workerUrl);
const UK = new LngLatBounds([-8.2, 49.9], [1.8, 58.7]);
const AREA_SRC = 'drawn-area';

type AreaFeature = { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'Polygon'; coordinates: LngLat[][] } | { type: 'LineString'; coordinates: LngLat[] } | { type: 'Point'; coordinates: LngLat } };

export interface MapHome { id: string; lat: number; lng: number; label: string; price: string }

export default function MapSearch({ homes, active, onPick, area, onArea, onFail }: {
  homes: MapHome[]; active: string | null; onPick: (id: string) => void;
  /** The drawn area's corners, or null. */
  area: LngLat[] | null; onArea: (a: LngLat[] | null) => void; onFail: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const pins = useRef(new Map<string, { marker: Marker; el: HTMLButtonElement }>());
  const [ready, setReady] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<LngLat[]>([]);
  const [said, setSaid] = useState('');
  const pick = useRef(onPick); pick.current = onPick;
  const fail = useRef(onFail); fail.current = onFail;

  // Start the map once.
  useEffect(() => {
    if (!box.current) return;
    let m: MapLibreMap;
    try {
      m = new MapLibreMap({ container: box.current, style: STYLE_URL, bounds: UK, fitBoundsOptions: { padding: 20 }, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxZoom: 18 });
    } catch { fail.current(); return; }
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    // If the street map hasn't arrived after a while, the page shows its simple map instead.
    const giveUp = window.setTimeout(() => { if (!m.isStyleLoaded()) fail.current(); }, 9000);
    m.once('load', () => {
      window.clearTimeout(giveUp);
      m.addSource(AREA_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'drawn-area-fill', type: 'fill', source: AREA_SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#F07415', 'fill-opacity': 0.12 } });
      m.addLayer({ id: 'drawn-area-line', type: 'line', source: AREA_SRC, paint: { 'line-color': '#F07415', 'line-width': 2.5 } });
      m.addLayer({ id: 'drawn-area-points', type: 'circle', source: AREA_SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#F07415', 'circle-stroke-width': 2.5 } });
      setReady(true);
    });
    return () => { window.clearTimeout(giveUp); pins.current.clear(); m.remove(); map.current = null; };
  }, []);

  // A pin for each home; the map moves to show them all when the set of homes changes.
  const homesKey = homes.map((h) => h.id).join(',');
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const want = new Set(homes.map((h) => h.id));
    for (const [id, p] of pins.current) if (!want.has(id)) { p.marker.remove(); pins.current.delete(id); }
    for (const h of homes) {
      if (pins.current.has(h.id) || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) continue;
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'map-pin'; el.textContent = h.price; el.setAttribute('aria-label', `${h.label}, ${h.price}. Show in the list`);
      el.addEventListener('click', (e) => { e.stopPropagation(); pick.current(h.id); });
      pins.current.set(h.id, { el, marker: new Marker({ element: el, anchor: 'bottom' }).setLngLat([h.lng, h.lat]).addTo(m) });
    }
    const pts = homes.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
    if (area?.length) return; // keep the view on the area the person drew
    if (!pts.length) { m.fitBounds(UK, { padding: 20, duration: 0 }); return; }
    const b = new LngLatBounds();
    pts.forEach((h) => b.extend([h.lng, h.lat]));
    m.fitBounds(b, { padding: 56, maxZoom: 14, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homesKey, ready]);

  useEffect(() => { for (const [id, p] of pins.current) p.el.classList.toggle('on', id === active); }, [active, homesKey, ready]);

  // The area: the finished one, or the corners placed so far.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(AREA_SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const ring = drawing ? points : area ?? [];
    const features: AreaFeature[] = [];
    if (!drawing && ring.length >= 3) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
    if (drawing && ring.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring.length >= 3 ? [...ring, ring[0]] : ring } });
    if (drawing) ring.forEach((p) => features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    src.setData({ type: 'FeatureCollection', features } as Parameters<GeoJSONSource['setData']>[0]);
  }, [area, points, drawing, ready]);

  // While drawing, each click on the map adds a corner.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !drawing) return;
    const add = (e: { lngLat: { lng: number; lat: number } }) => setPoints((p) => (p.length >= 40 ? p : [...p, [e.lngLat.lng, e.lngLat.lat]]));
    m.on('click', add);
    m.doubleClickZoom.disable();
    return () => { m.off('click', add); m.doubleClickZoom.enable(); };
  }, [drawing, ready]);

  const start = () => { setPoints([]); setDrawing(true); setSaid('Drawing: click round the area you want, then press Finish area.'); };
  const finish = () => { if (points.length < 3) return; onArea(points); setDrawing(false); setSaid('Area drawn. The list shows homes inside it.'); };
  const cancel = () => { setDrawing(false); setPoints([]); setSaid('Drawing cancelled.'); };
  const clear = () => { onArea(null); setPoints([]); setSaid('Area cleared. The list shows all results.'); };

  return (
    <div className="map-block">
      <div className={`map-real${drawing ? ' is-drawing' : ''}`}>
        <div ref={box} className="map-canvas" role="region" aria-label="Map of the homes in your results" />
      </div>
      <div className="map-tools">
        {!drawing && !area && <button type="button" className="btn ghost sm" onClick={start} disabled={!ready}>Draw your area</button>}
        {drawing && <>
          <button type="button" className="btn sm" onClick={finish} disabled={points.length < 3}>Finish area</button>
          <button type="button" className="btn ghost sm" onClick={() => setPoints((p) => p.slice(0, -1))} disabled={!points.length}>Undo last point</button>
          <button type="button" className="btn ghost sm" onClick={cancel}>Cancel</button>
          <p className="small muted">{points.length < 3 ? `Click round the area you want (${points.length} of at least 3 points).` : `${points.length} points. Add more, or finish.`}</p>
        </>}
        {!drawing && area && <>
          <button type="button" className="btn ghost sm" onClick={clear}>Clear area</button>
          <button type="button" className="btn ghost sm" onClick={start}>Draw again</button>
          <p className="small muted">Showing homes inside your area.</p>
        </>}
      </div>
      <p className="sr-only" role="status">{said}</p>
    </div>
  );
}
