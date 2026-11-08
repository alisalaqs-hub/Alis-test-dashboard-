/**
 * Consent-gated engagement tracking (client side of the engagement engine).
 * - Nothing is recorded unless the visitor opts in to analytics (PECR: non-essential
 *   storage/access needs consent).
 * - Events carry a random session id, never name/email; IP is not collected client-side.
 * - Prototype keeps events in sessionStorage only; production sends them to a first-party
 *   collector that aggregates and applies k-anonymity before any dashboard sees them.
 */
export type EventName = 'listing_view' | 'photo_enlarge' | 'floorplan_open' | 'save' | 'compare_add' | 'viewing_request' | 'enquiry' | 'ai_question' | 'refurb_sim' | 'design_style' | 'document_open';
export interface TrackedEvent { name: EventName; listingId: string; at: string; session: string; props?: Record<string, string | number> }

import { api } from '../lib/api';

/** Event names the Streetkey server accepts for live listings (others stay on the device). */
const SERVER_NAMES: Partial<Record<EventName, string>> = { listing_view: 'listing_view', photo_enlarge: 'photo_open', floorplan_open: 'floorplan_open', save: 'save', viewing_request: 'viewing_request', enquiry: 'enquiry', ai_question: 'ai_question', refurb_sim: 'refurb_sim', design_style: 'design_style' };
function serverSession() {
  try {
    let s = sessionStorage.getItem('streetkey-ssid');
    if (!s) { const a = new Uint8Array(18); crypto.getRandomValues(a); s = btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); sessionStorage.setItem('streetkey-ssid', s); }
    return s;
  } catch { return null; }
}

const CONSENT_KEY = 'streetkey-analytics-consent';
const EVENTS_KEY = 'streetkey-events';

export function getConsent(): 'granted' | 'denied' | 'unset' {
  try { return (localStorage.getItem(CONSENT_KEY) as 'granted' | 'denied') ?? 'unset'; } catch { return 'unset'; }
}
export function setConsent(v: 'granted' | 'denied') {
  try { localStorage.setItem(CONSENT_KEY, v); if (v === 'denied') sessionStorage.removeItem(EVENTS_KEY); } catch { /* ignore */ }
}
function session() {
  try { let s = sessionStorage.getItem('streetkey-sid'); if (!s) { s = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('streetkey-sid', s); } return s; } catch { return 'anon'; }
}
export function track(name: EventName, listingId: string, props?: TrackedEvent['props']) {
  if (getConsent() !== 'granted') return false;
  try {
    const list: TrackedEvent[] = JSON.parse(sessionStorage.getItem(EVENTS_KEY) ?? '[]');
    list.unshift({ name, listingId, at: new Date().toISOString(), session: session(), props });
    sessionStorage.setItem(EVENTS_KEY, JSON.stringify(list.slice(0, 100)));
    const serverName = SERVER_NAMES[name]; const ssid = serverSession();
    if (serverName && ssid && /^sk-[a-z0-9]{7}$/.test(listingId)) api.event(listingId, serverName, ssid);
    window.dispatchEvent(new Event('streetkey-track'));
    return true;
  } catch { return false; }
}
export function recentEvents(): TrackedEvent[] {
  try { return JSON.parse(sessionStorage.getItem(EVENTS_KEY) ?? '[]'); } catch { return []; }
}
