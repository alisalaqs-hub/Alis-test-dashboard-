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
 * Largest upload we send for a redesign. The site runs on Netlify Functions, which cap a request at
 * 6 MB (less once a binary body is encoded), so anything near the server's own photo limit would be
 * turned away before it reached Streetkey.
 */
export const ROOM_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const TOO_LARGE = 'That photo is too large to upload. Try a photo under 4 MB, or a smaller copy of it (for example a screenshot).';

/**
 * The photo to upload for a redesign: a 2048px JPEG (plenty for image editing, much smaller than a
 * phone photo, and without camera or location metadata). The original is used only when the browser
 * can't resize it and it's already under the limit.
 */
export async function prepareRoomPhoto(photo: File | Blob): Promise<Blob> {
  const small = await shrinkForAnalysis(photo, 2048, 0.9);
  if (small !== photo && small.size <= ROOM_IMAGE_MAX_BYTES) return small;
  if (photo.size <= ROOM_IMAGE_MAX_BYTES) return photo;
  throw new ApiError(413, TOO_LARGE, 'too_large');
}

/**
 * Upload a room photo, then wait for the redesign job. `onProgress` receives short messages for
 * a live region. Resolves with the finished design; rejects with ApiError (message safe to show).
 */
export async function generateRoomImage(
  photo: File | Blob,
  fields: { room: string; style: string; brief?: string; palette?: string },
  o: { onProgress?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<RoomImageResult> {
  o.onProgress?.('Preparing your photo…');
  const upload = await prepareRoomPhoto(photo);
  const form = new FormData();
  form.append('room', fields.room); form.append('style', fields.style); form.append('consent', 'true');
  if (fields.brief) form.append('brief', fields.brief.slice(0, 600));
  if (fields.palette) form.append('palette', fields.palette.slice(0, 200));
  form.append('photo', upload, upload === photo ? (photo as File).name || 'room.jpg' : 'room.jpg');
  o.onProgress?.('Uploading your photo…');
  let start: RoomImageStart;
  try { start = await apiCall<RoomImageStart>('POST', '/api/ai/room-image', form, { timeout: 90_000 }); }
  catch (e) {
    // The hosting platform rejects oversized requests itself, without Streetkey's friendly message.
    if (e instanceof ApiError && e.status === 413 && e.code !== 'too_large') throw new ApiError(413, TOO_LARGE, 'too_large');
    throw e;
  }
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
 * A smaller JPEG: for analysis the AI looks at a low-detail view, so a 1024px image is plenty,
 * uploads quickly and stays under the 4 MB limit (redesigns use 2048px). Re-encoding also drops
 * camera metadata. Falls back to the original file when the browser can't resize it.
 */
export async function shrinkForAnalysis(file: File | Blob, maxSide = 1024, quality = 0.85): Promise<Blob> {
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
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
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

/* ───────── today's allowance ───────── */
export interface ImageAllowance { limit: number; used: number; left: number }
/**
 * How many AI designs this person has left today, from the server's own count (which includes designs
 * still running, e.g. after "Stop waiting"). Null when signed out or it can't be checked.
 */
export async function imageAllowance(): Promise<ImageAllowance | null> {
  try {
    const s = await apiCall<{ signedIn: boolean; dailyLimit: number; usedToday: number }>('GET', '/api/ai/status', undefined, { timeout: 10_000 });
    if (!s?.signedIn || !Number.isFinite(s.dailyLimit) || !Number.isFinite(s.usedToday)) return null;
    return { limit: s.dailyLimit, used: s.usedToday, left: Math.max(0, s.dailyLimit - s.usedToday) };
  } catch { return null; }
}

/* ───────── checking a photo before it's used ───────── */
export type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp';
export const NOT_A_PHOTO = 'That file isn’t a photo Streetkey can use. Choose a JPEG, PNG or WebP image.';
const BROKEN_PHOTO = 'That photo couldn’t be opened. It may be damaged: try another copy of it.';

/** The image type from the file's first bytes (the same check the server makes), or null. */
export async function sniffPhoto(file: Blob): Promise<PhotoType | null> {
  let b: Uint8Array;
  try { b = new Uint8Array(await file.slice(0, 12).arrayBuffer()); } catch { return null; }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Why a chosen file can't be used as a room photo, or null when it can: it must really be a JPEG,
 * PNG or WebP (not just named like one), and the browser must be able to open it.
 */
export async function photoProblem(file: Blob): Promise<string | null> {
  if (!(await sniffPhoto(file))) return NOT_A_PHOTO;
  if (typeof createImageBitmap !== 'function') return null;
  try { const bmp = await createImageBitmap(file); bmp.close?.(); return null; } catch { return BROKEN_PHOTO; }
}

/* ───────── keeping the person's work while they sign in ───────── */
let keptPhoto: { file: File; at: number } | null = null;
/**
 * Keep the studio photo in memory while the person signs in (it's in this tab only and never stored),
 * so coming back to the studio afterwards doesn't lose it.
 */
export function keepStudioPhoto(file: File | null) { keptPhoto = file ? { file, at: Date.now() } : null; }
/** The kept photo (once: it's forgotten as it's handed back), if it was kept in the last two hours. */
export function takeStudioPhoto(): File | null {
  const k = keptPhoto; keptPhoto = null;
  return k && Date.now() - k.at < 2 * 3600_000 ? k.file : null;
}

export interface StudioDraft { brief: string; postcode: string; dims: { width: number; length: number; height: number }; budget: number; paint: string; staged: boolean }
const DRAFT_KEY = 'streetkey:studio-draft';
/** What the person typed or chose in the studio, for this browser tab's session. */
export function readStudioDraft(): Partial<StudioDraft> {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<StudioDraft> | null;
    if (!d || typeof d !== 'object') return {};
    const num = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined);
    const dims = d.dims && num(d.dims.width, 1.5, 30) && num(d.dims.length, 1.5, 30) && num(d.dims.height, 2, 6) ? d.dims : undefined;
    return {
      brief: typeof d.brief === 'string' ? d.brief.slice(0, 600) : undefined,
      postcode: typeof d.postcode === 'string' ? d.postcode.slice(0, 10) : undefined,
      dims, budget: num(d.budget, 1500, 40_000), paint: typeof d.paint === 'string' && /^(#[0-9a-f]{6})?$/i.test(d.paint) ? d.paint : undefined,
      staged: typeof d.staged === 'boolean' ? d.staged : undefined,
    };
  } catch { return {}; }
}
export function saveStudioDraft(d: StudioDraft) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* storage unavailable: nothing to keep */ }
}
