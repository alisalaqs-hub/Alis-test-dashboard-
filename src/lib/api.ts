/**
 * Talks to the Streetkey server. When the site is served by the server (the live site),
 * calls go to the same address (/api/...). VITE_API_URL can point the site at a server
 * elsewhere. On a static host with no server (GitHub Pages, previews) every call fails
 * fast and the site stays in demo mode.
 */
import type { AiImageDTO, CheckDTO, EnquirySummaryDTO, HealthDTO, ListingDTO, MessageDTO, SavedSearchDTO, UserDTO } from './apiTypes';

export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error', public fields: Record<string, string> = {}) { super(message); }
}

/** Low-level call used by feature clients (src/lib/ai/*). Throws ApiError with a message written for people. */
export async function apiCall<T>(method: string, path: string, body?: unknown, opts: { timeout?: number } = {}): Promise<T> { return request<T>(method, path, body, opts); }

async function request<T>(method: string, path: string, body?: unknown, opts: { timeout?: number } = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let r: Response;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'include',
      headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? 30_000),
    });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new ApiError(0, timeout ? 'The server took too long to answer. Please try again.' : 'Couldn’t reach Streetkey. Check your connection and try again.', 'network');
  }
  const json = await r.json().catch(() => null) as ({ error?: { code: string; message: string; fields?: Record<string, string> } } & T) | null;
  if (!r.ok) throw new ApiError(r.status, json?.error?.message ?? `Something went wrong (${r.status}).`, json?.error?.code, json?.error?.fields ?? {});
  return json as T;
}
const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: unknown, o?: { timeout?: number }) => request<T>('POST', p, b ?? {}, o);
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const put = <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {});
const del = <T>(p: string, b?: unknown) => request<T>('DELETE', p, b);
const qs = (o: Record<string, string | number | undefined | null>) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') s.set(k, String(v)); const t = s.toString(); return t ? `?${t}` : ''; };

/** Absolute URL for media the server returns as /media/... */
export const mediaUrl = (u: string) => (u.startsWith('/') ? `${API_BASE}${u}` : u);

export type MyListing = ListingDTO & { stats: { enquiries: number; newEnquiries: number; views30d: number; saves: number }; checks: CheckDTO[] };
export type ListingWrite = Partial<{
  channel: 'sale' | 'rent'; title: string | null; addressLine: string; town: string; postcode: string; type: string; tenure: string; leaseYears: number | null;
  beds: number; baths: number; floorArea: number; era: string | null; condition: string | null; price: number; priceQualifier: string | null; epc: string | null;
  councilTax: string | null; serviceChargeAnnual: number | null; groundRentAnnual: number | null; features: string[]; description: string | null; ownershipDeclared: boolean;
}>;

export const api = {
  health: async (): Promise<HealthDTO | null> => {
    try {
      const r = await fetch(`${API_BASE}/api/health`, { credentials: 'include', signal: AbortSignal.timeout(4000) });
      if (!r.headers.get('content-type')?.includes('json')) return null;
      return (await r.json()) as HealthDTO;
    } catch { return null; }
  },
  auth: {
    me: () => get<{ user: UserDTO | null }>('/api/auth/me'),
    register: (b: { email: string; password: string; name: string; accountType: string; marketingOptIn: boolean; acceptTerms: boolean }) => post<{ user: UserDTO }>('/api/auth/register', b),
    login: (email: string, password: string) => post<{ user: UserDTO }>('/api/auth/login', { email, password }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    verify: (token: string) => post<{ ok: true }>('/api/auth/verify', { token }),
    resendVerification: () => post<{ ok: true }>('/api/auth/resend-verification'),
    forgot: (email: string) => post<{ ok: true }>('/api/auth/forgot', { email }),
    reset: (token: string, password: string) => post<{ ok: true; user: UserDTO }>('/api/auth/reset', { token, password }),
    changePassword: (current: string, password: string) => post<{ ok: true }>('/api/auth/change-password', { current, password }),
  },
  me: {
    update: (b: Partial<{ name: string; phone: string | null; marketingOptIn: boolean; accountType: string }>) => patch<{ user: UserDTO }>('/api/me', b),
    exportData: () => get<Record<string, unknown>>('/api/me/export'),
    deleteAccount: (password: string) => del<{ ok: true }>('/api/me', { password }),
    saved: () => get<{ keys: string[] }>('/api/me/saved'),
    save: (key: string) => put<{ ok: true }>(`/api/me/saved/${encodeURIComponent(key)}`),
    unsave: (key: string) => del<{ ok: true }>(`/api/me/saved/${encodeURIComponent(key)}`),
    mergeSaved: (keys: string[]) => post<{ keys: string[] }>('/api/me/saved/merge', { keys }),
    searches: () => get<{ items: SavedSearchDTO[] }>('/api/me/searches'),
    addSearch: (query: string, mode: string, alertFrequency: SavedSearchDTO['alertFrequency'] = 'daily') => post<{ search: SavedSearchDTO }>('/api/me/searches', { query, mode, alertFrequency }),
    setSearchAlert: (id: string, alertFrequency: SavedSearchDTO['alertFrequency']) => patch<{ search: SavedSearchDTO }>(`/api/me/searches/${id}`, { alertFrequency }),
    removeSearch: (id: string) => del<{ ok: true }>(`/api/me/searches/${id}`),
    listings: () => get<{ items: MyListing[] }>('/api/me/listings'),
    inbox: () => get<{ items: EnquirySummaryDTO[]; unread: number }>('/api/me/inbox'),
    orgs: () => get<{ items: { id: string; name: string; kind: string; verified: boolean; role: string }[] }>('/api/me/orgs'),
  },
  listings: {
    search: (p: { q?: string; channel?: string; page?: number; pageSize?: number } = {}) => get<{ items: ListingDTO[]; total: number }>(`/api/listings${qs(p)}`),
    get: (ref: string) => get<{ listing: ListingDTO; checks?: CheckDTO[] }>(`/api/listings/${encodeURIComponent(ref)}`),
    create: (b: ListingWrite) => post<{ listing: ListingDTO; checks: CheckDTO[] }>('/api/listings', b),
    update: (ref: string, b: ListingWrite) => patch<{ listing: ListingDTO; checks: CheckDTO[] }>(`/api/listings/${ref}`, b),
    submit: (ref: string) => post<{ status: 'live' | 'pending' }>(`/api/listings/${ref}/submit`),
    setStatus: (ref: string, status: string) => post<{ status: string }>(`/api/listings/${ref}/status`, { status }),
    remove: (ref: string) => del<{ deleted?: true; withdrawn?: true }>(`/api/listings/${ref}`),
    uploadPhotos: (ref: string, files: (File | Blob)[]) => { const f = new FormData(); files.forEach((x, i) => f.append('photos', x, (x as File).name ?? `photo-${i + 1}.jpg`)); return request<{ added: { id: string; url: string }[]; rejected: string[] }>('POST', `/api/listings/${ref}/photos`, f, { timeout: 120_000 }); },
    deletePhoto: (ref: string, id: string) => del<{ ok: true }>(`/api/listings/${ref}/photos/${id}`),
    enquire: (ref: string, b: { name: string; email: string; phone?: string; kind: 'viewing' | 'question' | 'offer'; message: string; preferredSlot?: string; website?: string }) => post<{ ok: true }>(`/api/listings/${ref}/enquiries`, b),
  },
  enquiries: {
    get: (id: string) => get<{ role: 'lister' | 'enquirer'; status: string; kind: string; preferredSlot: string | null; listing: { ref: string; title: string; price: number; channel: string }; contact: { name: string; email?: string; phone?: string | null }; messages: MessageDTO[] }>(`/api/enquiries/${id}`),
    reply: (id: string, body: string) => post<{ ok: true }>(`/api/enquiries/${id}/messages`, { body }),
    setStatus: (id: string, status: 'new' | 'replied' | 'closed') => patch<{ status: string }>(`/api/enquiries/${id}`, { status }),
  },
  ai: {
    status: () => get<{ imagesEnabled: boolean; dailyLimit: number; usedToday: number; signedIn: boolean; model: string }>('/api/ai/status'),
    roomImage: (photo: File | Blob, fields: { room: string; style: string; brief?: string; palette?: string }) => {
      const f = new FormData();
      f.append('room', fields.room); f.append('style', fields.style); f.append('consent', 'true');
      if (fields.brief) f.append('brief', fields.brief);
      if (fields.palette) f.append('palette', fields.palette);
      f.append('photo', photo, (photo as File).name ?? 'room.jpg');
      return request<{ image: AiImageDTO; remainingToday: number; label: string }>('POST', '/api/ai/room-image', f, { timeout: 240_000 });
    },
    history: () => get<{ items: AiImageDTO[] }>('/api/ai/room-images'),
  },
  admin: {
    summary: () => get<Record<string, unknown> & { listings: Record<string, number>; users: { total: number; d7: number }; enquiries7d: number; aiImages7d: number; orgsAwaitingVerification: number; emailsFailed7d: number }>('/api/admin/summary'),
    listings: (status = 'pending') => get<{ items: (ListingDTO & { lister: string | null; ownershipDeclared: boolean; checks: CheckDTO[] })[] }>(`/api/admin/listings?status=${status}`),
    approve: (ref: string) => post<{ status: string }>(`/api/admin/listings/${ref}/approve`),
    reject: (ref: string, reason: string) => post<{ status: string }>(`/api/admin/listings/${ref}/reject`, { reason }),
    verifyOwnership: (ref: string) => post<{ ok: true }>(`/api/admin/listings/${ref}/verify-ownership`, { verified: true }),
    orgs: () => get<{ items: { id: string; name: string; kind: string; verified: boolean; redressScheme: string | null; listings: number; owners: string | null; createdAt: string }[] }>('/api/admin/orgs'),
    verifyOrg: (id: string, verified = true) => post<{ ok: true; released: number }>(`/api/admin/orgs/${id}/verify`, { verified }),
    users: (q = '') => get<{ items: { id: string; email: string; name: string; role: string; accountType: string; emailVerified: boolean; createdAt: string }[] }>(`/api/admin/users${qs({ q })}`),
    setRole: (id: string, role: 'member' | 'admin') => post<{ ok: true }>(`/api/admin/users/${id}/role`, { role }),
    audit: () => get<{ items: { id: number; action: string; subject: string | null; detail: unknown; at: string; actor: string | null }[] }>('/api/admin/audit?limit=100'),
  },
  orgs: {
    create: (b: { name: string; kind: string; redressScheme?: string }) => post<{ id: string; verified: boolean; note: string }>('/api/orgs', b),
    keys: (id: string) => get<{ items: { id: string; label: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }[] }>(`/api/orgs/${id}/feed-keys`),
    createKey: (id: string, label: string) => post<{ key: string; note: string }>(`/api/orgs/${id}/feed-keys`, { label }),
    revokeKey: (id: string, keyId: string) => del<{ ok: true }>(`/api/orgs/${id}/feed-keys/${keyId}`),
    runs: (id: string) => get<{ items: { id: string; format: string; accepted: number; withdrawn: number; rejected: { ref: string; reason: string }[]; createdAt: string }[] }>(`/api/orgs/${id}/feed-runs`),
  },
  event: (listing: string, name: string, session: string) => {
    try {
      void fetch(`${API_BASE}/api/events`, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listing, name, session, consent: true }) }).catch(() => {});
    } catch { /* analytics never breaks the page */ }
  },
};
