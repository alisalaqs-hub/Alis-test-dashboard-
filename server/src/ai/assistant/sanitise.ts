/**
 * Server-side checks on what the model returns, before anything reaches the website:
 * only real, public homes; only internal links to Streetkey pages; tidy, bounded text.
 */
import { findHome } from './tools';

/** Top-level pages the assistant may link to. */
const ROUTE_RE = /^\/(?:$|(?:search|property|invest|estimate|studio|compare|prices|list|import|saved|my-home|account|owner|landlord|developer|agents|marketplace|sources|enterprise|automation|privacy|terms|accessibility)(?:[/?#]|$))/;
const BASE = 'https://streetkey.invalid';

const strip = (s: string) => s.replace(/<<<|>>>/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/**
 * A safe internal path, or null: must start with a single "/", no scheme, no backslashes,
 * no host, and point at a Streetkey page. Links that name a home must name a real one.
 */
export function safeInternalPath(to: unknown): string | null {
  if (typeof to !== 'string') return null;
  const t = to.trim().replace(/ /g, '%20');
  if (!t || t.length > 300 || !t.startsWith('/') || t.startsWith('//')) return null;
  if (/[\s\\<>"'`\u0000-\u001f\u007f]/.test(t)) return null;
  if (/^[^?#]*:/.test(t)) return null; // "/javascript:…" style tricks
  let u: URL;
  try { u = new URL(t, BASE); } catch { return null; }
  if (u.origin !== BASE) return null;
  const path = `${u.pathname}${u.search}${u.hash}`;
  if (path.startsWith('//') || !ROUTE_RE.test(path)) return null;
  try {
    if (u.pathname === '/property' || u.pathname.startsWith('/property/')) {
      const id = decodeURIComponent(u.pathname.split('/')[2] ?? '');
      if (!findHome(id)) return null;
    }
    const ref = u.searchParams.get('property');
    if (ref != null && !findHome(ref)) return null;
    if (u.pathname === '/compare') {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (!ids.length || ids.length > 4 || ids.some((id) => !findHome(id))) return null;
    }
  } catch { return null; }
  return path;
}

/** The reply text: markers removed, only safe internal markdown links kept, length bounded. */
export function sanitiseReply(text: unknown): string {
  let s = strip(String(text ?? '')).replace(/\r/g, '').trim();
  s = s.replace(/\[([^\]\n]{1,160})\]\(([^)\n]*)\)/g, (_m, label: string, href: string) => {
    const p = safeInternalPath(href);
    return p ? `[${label}](${p})` : label;
  });
  if (s.length > 3000) s = `${s.slice(0, 2990).replace(/\s+\S*$/, '')}…`;
  return s;
}

export interface Action { label: string; to: string }
export function sanitiseActions(list: unknown, max = 4): Action[] {
  const out: Action[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(list) ? list : []) {
    const rec = a as { label?: unknown; to?: unknown } | null;
    const label = typeof rec?.label === 'string' ? strip(rec.label).replace(/\s+/g, ' ').trim().slice(0, 48) : '';
    const to = safeInternalPath(rec?.to);
    if (!label || !to || seen.has(to)) continue;
    seen.add(to);
    out.push({ label, to });
    if (out.length >= max) break;
  }
  return out;
}

export function sanitiseFollowUps(list: unknown, max = 3): string[] {
  const out: string[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f !== 'string') continue;
    const s = strip(f).replace(/\s+/g, ' ').trim();
    if (s.length < 3 || s.length > 100 || /https?:|www\./i.test(s)) continue;
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Ids of real, public homes only (unknown or private ids are dropped). */
export function knownIds(list: unknown, max = 6): string[] {
  const out: string[] = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (typeof id !== 'string') continue;
    const p = findHome(id.trim());
    if (p && !out.includes(p.id)) out.push(p.id);
    if (out.length >= max) break;
  }
  return out;
}
