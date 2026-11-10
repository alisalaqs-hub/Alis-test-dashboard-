/**
 * Calls to official data services. Every call has a short timeout, identifies itself honestly,
 * is retried once on a timeout or server error, and fails with a message that is safe to show.
 */
import { config } from '../config';

export type DataSource = 'land-registry' | 'environment-agency' | 'epc' | 'postcodes';
const NAME: Record<DataSource, string> = { 'land-registry': 'HM Land Registry', 'environment-agency': 'the Environment Agency', epc: 'the energy certificate register', postcodes: 'the postcode service' };

/** A failure with a message written for people. */
export class DataError extends Error {
  constructor(public source: DataSource, message: string, public status = 502, public code = 'data_unavailable') { super(message); }
}
export const dataOff = (source: DataSource) => new DataError(source, 'Official data lookups are switched off on this site.', 503, 'data_disabled');

export interface FetchOpts { source: DataSource; timeoutMs?: number; retries?: number; /** Wait before each retry, in ms (default 300 each). */ backoffMs?: number[]; headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string; accept?: string }

async function attempt(url: string, o: FetchOpts): Promise<Response> {
  return fetch(url, {
    method: o.method ?? 'GET',
    headers: { Accept: o.accept ?? 'application/json', 'User-Agent': config.data.userAgent, ...(o.headers ?? {}) },
    body: o.body,
    signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
  });
}

/** Fetch a response, retrying (once by default) on timeouts, network errors, 5xx and 429 "too many requests". Other 4xx responses are returned to the caller. */
export async function fetchData(url: string, o: FetchOpts): Promise<Response> {
  if (config.data.disabled) throw dataOff(o.source);
  let last: unknown;
  for (let i = 0; i <= (o.retries ?? 1); i++) {
    try {
      const r = await attempt(url, o);
      if (r.status < 500 && r.status !== 429) return r;
      last = new Error(`HTTP ${r.status}`);
      await r.arrayBuffer().catch(() => {});
    } catch (e) { last = e; }
    if (i < (o.retries ?? 1)) await new Promise((res) => setTimeout(res, config.isTest ? 0 : o.backoffMs?.[i] ?? 300));
  }
  const slow = (last as Error)?.name === 'TimeoutError' || (last as Error)?.name === 'AbortError';
  throw new DataError(o.source, `${slow ? 'It took too long to hear back from' : 'Couldn’t get an answer from'} ${NAME[o.source]}. Please try again in a moment.`, slow ? 504 : 502);
}

export async function fetchJSON<T>(url: string, o: FetchOpts): Promise<{ status: number; json: T | null }> {
  const r = await fetchData(url, o);
  const json = (await r.json().catch(() => null)) as T | null;
  return { status: r.status, json };
}

/** Minimal CSV reader (RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
