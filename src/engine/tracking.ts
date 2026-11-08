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

const CONSENT_KEY = 'brixo-analytics-consent';
const EVENTS_KEY = 'brixo-events';

export function getConsent(): 'granted' | 'denied' | 'unset' {
  try { return (localStorage.getItem(CONSENT_KEY) as 'granted' | 'denied') ?? 'unset'; } catch { return 'unset'; }
}
export function setConsent(v: 'granted' | 'denied') {
  try { localStorage.setItem(CONSENT_KEY, v); if (v === 'denied') sessionStorage.removeItem(EVENTS_KEY); } catch { /* ignore */ }
}
function session() {
  try { let s = sessionStorage.getItem('brixo-sid'); if (!s) { s = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('brixo-sid', s); } return s; } catch { return 'anon'; }
}
export function track(name: EventName, listingId: string, props?: TrackedEvent['props']) {
  if (getConsent() !== 'granted') return false;
  try {
    const list: TrackedEvent[] = JSON.parse(sessionStorage.getItem(EVENTS_KEY) ?? '[]');
    list.unshift({ name, listingId, at: new Date().toISOString(), session: session(), props });
    sessionStorage.setItem(EVENTS_KEY, JSON.stringify(list.slice(0, 100)));
    window.dispatchEvent(new Event('brixo-track'));
    return true;
  } catch { return false; }
}
export function recentEvents(): TrackedEvent[] {
  try { return JSON.parse(sessionStorage.getItem(EVENTS_KEY) ?? '[]'); } catch { return []; }
}
