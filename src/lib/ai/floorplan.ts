/**
 * Website client for "Read my sketch" in the floor plan maker: a photo of a hand-drawn sketch goes to
 * Streetkey AI, which copies out the rooms and the sizes written on it for the person to check.
 * The plan is never drawn by AI: it is always drawn from the numbers (src/engine/floorplan.ts).
 */
import { apiCall, ApiError } from '../api';
import type { Floor } from '../../engine/floorplan';
import { shrinkForAnalysis } from './studio';

export interface SketchRoom {
  name: string; floor: Floor; row: number; order: number;
  /** Metres; null when the size isn't written on the sketch or couldn't be read. */
  width: number | null; length: number | null;
  /** The sizes as text in `unit`, ready for the table (empty when there is no size). */
  widthText: string; lengthText: string; unit: 'm' | 'ft';
}
export interface SketchReading { isSketch: boolean; rooms: SketchRoom[]; needsMeasuring: string[]; note: string | null; label: string }

export const SKETCH_CONSENT_TEXT = 'I’m happy for this photo to be sent to Streetkey’s AI provider (OpenAI) so it can read the rooms and sizes. Streetkey doesn’t keep the photo, and it isn’t used to train their models.';
const SKETCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Sends a smaller copy of the photo (2,000px on its longest side: enough to read handwriting, quick to upload and
 * without camera or location details) and returns what was read. `unit` is what a size written without a unit is in.
 * Rejects with ApiError (its message is written for people).
 */
export async function readSketch(photo: File | Blob, unit: 'm' | 'ft'): Promise<SketchReading> {
  const small = await shrinkForAnalysis(photo, 2000, 0.88);
  if (small.size > SKETCH_MAX_BYTES) throw new ApiError(413, 'That photo is too large to read. Try a photo under 4 MB.', 'too_large');
  const form = new FormData();
  form.append('consent', 'true');
  form.append('unit', unit);
  form.append('photo', small, 'sketch.jpg');
  return apiCall<SketchReading>('POST', '/api/ai/floorplan/from-sketch', form, { timeout: 60_000 });
}
