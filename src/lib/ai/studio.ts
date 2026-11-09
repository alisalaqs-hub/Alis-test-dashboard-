/**
 * Website client for the design studio's AI: room redesign (a background job the page polls),
 * the design brief reader and "Analyse this room". Every caller falls back to Streetkey's
 * built-in engines when AI isn't available or a call fails.
 */
import { apiCall, ApiError } from '../api';
import type { AiImageDTO } from '../apiTypes';
import type { RoomType, Tier } from '../../engine/design';
import { aiPost, pollJob } from './core';

/* ───────── room redesign ───────── */
export interface RoomImageStart { jobId: string; image: AiImageDTO; remainingToday: number; label: string }
export interface RoomImageResult { image: AiImageDTO; label: string; remainingToday: number }
export const ROOM_IMAGE_PROGRESS = 'Designing your room… usually under a minute';

/**
 * Upload a room photo, then wait for the redesign job. `onProgress` receives short messages for
 * a live region. Resolves with the finished design; rejects with ApiError (message safe to show).
 */
export async function generateRoomImage(
  photo: File | Blob,
  fields: { room: string; style: string; brief?: string; palette?: string },
  o: { onProgress?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<RoomImageResult> {
  const form = new FormData();
  form.append('room', fields.room); form.append('style', fields.style); form.append('consent', 'true');
  if (fields.brief) form.append('brief', fields.brief.slice(0, 600));
  if (fields.palette) form.append('palette', fields.palette.slice(0, 200));
  form.append('photo', photo, (photo as File).name || 'room.jpg');
  o.onProgress?.('Uploading your photo…');
  const start = await apiCall<RoomImageStart>('POST', '/api/ai/room-image', form, { timeout: 90_000 });
  if (start.image.status === 'done' && start.image.url) return { image: start.image, label: start.label, remainingToday: start.remainingToday };
  o.onProgress?.(ROOM_IMAGE_PROGRESS);
  const out = await pollJob<{ image: AiImageDTO; label: string }>(start.jobId, {
    signal: o.signal, timeoutMs: 6 * 60_000,
    onProgress: (job) => o.onProgress?.(job.status === 'queued' ? 'Waiting for the designer to start…' : job.progress || ROOM_IMAGE_PROGRESS),
  });
  if (!out?.image?.url) throw new ApiError(502, 'The AI didn’t return a design. Please try again.', 'ai_failed');
  return { image: out.image, label: out.label || start.label, remainingToday: start.remainingToday };
}

/* ───────── design brief ───────── */
export interface DesignBriefResult {
  engine: 'ai' | 'rules';
  room: RoomType; styleId: string; styleName: string; tier: Tier; budget: number | null;
  priorities: string[]; keep: string[]; materials: { item: string; spec: string; why: string }[]; notes: string;
  cost: { total: number; materials: number; labour: number; prelimsOhp: number; contingency: number; vat: number; weeks: number; regionLabel: string };
  fitsBudget: boolean | null; tierAdjusted: boolean; message: string; note: string | null;
}
export const designBrief = (body: { text: string; room?: RoomType; postcode?: string; dims?: { width: number; length: number; height: number }; staged?: boolean }) =>
  aiPost<DesignBriefResult>('/api/ai/design/brief', { ...body, text: body.text.slice(0, 600) }, 30_000);

/* ───────── analyse this room ───────── */
export interface RoomAnalysis {
  isRoom: boolean; room: RoomType | null; condition: 'dated' | 'tired' | 'fair' | 'good' | 'like new';
  keepWorthy: string[]; problems: string[]; suggestedStyleIds: string[]; suggestedTier: Tier; notes: string;
}
const ANALYSIS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A smaller JPEG for analysis: the AI looks at a low-detail view, so a 1024px image is plenty,
 * uploads quickly and stays under the 4 MB limit. Re-encoding also drops camera metadata.
 * Falls back to the original file when the browser can't resize it.
 */
export async function shrinkForAnalysis(file: File | Blob, maxSide = 1024): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob && blob.size > 0 ? blob : file;
  } catch { return file; }
}

export async function describePhoto(photo: File | Blob, room?: RoomType): Promise<{ analysis: RoomAnalysis; label: string }> {
  const small = await shrinkForAnalysis(photo);
  if (small.size > ANALYSIS_MAX_BYTES) throw new ApiError(413, 'That photo is too large to analyse. Try a photo under 4 MB.', 'too_large');
  const form = new FormData();
  form.append('consent', 'true');
  if (room) form.append('room', room);
  form.append('photo', small, 'room.jpg');
  return apiCall('POST', '/api/ai/design/describe-photo', form, { timeout: 45_000 });
}

export const CONDITION_LABEL: Record<RoomAnalysis['condition'], string> = { dated: 'Dated', tired: 'Tired', fair: 'Fair', good: 'Good', 'like new': 'Like new' };
