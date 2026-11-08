/**
 * Website side of Streetkey AI: availability, calls, and background-job polling.
 * Every AI feature falls back to Streetkey's built-in rules when AI isn't available
 * (static preview, AI switched off, or the request fails), so pages never break.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiCall, ApiError } from '../api';
import { useServer } from '../server';

export interface AiJob<T = unknown> { id: string; kind: string; status: 'queued' | 'running' | 'done' | 'failed'; progress: string | null; output: T | null; error: string | null; createdAt: string }

/** Is AI usable right now, and why not if it isn't. */
export function useAi() {
  const { status, online, health, user } = useServer();
  const available = online && !!health?.features.ai;
  const reason: 'checking' | 'offline' | 'disabled' | null = status === 'checking' ? 'checking' : !online ? 'offline' : !health?.features.ai ? 'disabled' : null;
  return { available, reason, signedIn: !!user, user };
}

export const aiPost = <T>(path: string, body: unknown, timeout = 60_000) => apiCall<T>('POST', path, body, { timeout });
export const aiGet = <T>(path: string, timeout = 30_000) => apiCall<T>('GET', path, undefined, { timeout });

/** Polls a background job until it finishes. Resolves with its output; rejects with ApiError on failure. */
export async function pollJob<T>(id: string, o: { onProgress?: (job: AiJob<T>) => void; signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const until = Date.now() + (o.timeoutMs ?? 5 * 60_000);
  let wait = o.intervalMs ?? 1500;
  for (;;) {
    if (o.signal?.aborted) throw new ApiError(0, 'Cancelled.', 'cancelled');
    const { job } = await apiCall<{ job: AiJob<T> }>('GET', `/api/ai/jobs/${id}`);
    o.onProgress?.(job);
    if (job.status === 'done') return job.output as T;
    if (job.status === 'failed') throw new ApiError(502, job.error ?? 'The AI couldn’t finish that. Please try again.', 'ai_failed');
    if (Date.now() > until) throw new ApiError(504, 'This is taking longer than expected. We’ll keep working on it: check back in a few minutes.', 'ai_slow');
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(4000, wait * 1.25);
  }
}

/**
 * Run an AI action with busy/error state:
 *   const draft = useAiAction((facts) => aiPost<Out>('/api/ai/listing/describe', facts))
 *   <button onClick={() => draft.run(facts)} disabled={draft.busy}>
 */
export function useAiAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; busy: boolean }>({ data: null, error: null, busy: false });
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const run = useCallback(async (...args: A) => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const data = await fn(...args);
      if (live.current) setState({ data, error: null, busy: false });
      return data;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.');
      if (live.current) setState((s) => ({ ...s, error: err, busy: false }));
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reset = useCallback(() => setState({ data: null, error: null, busy: false }), []);
  return { ...state, run, reset, setData: (data: T | null) => setState((s) => ({ ...s, data })) };
}
