/**
 * Floor plan maker AI:
 *   POST /api/ai/floorplan/from-sketch   confirmed email · one photo of a hand sketch (multipart: photo, consent, unit)
 *                                        → the rooms and the sizes written on it, for the person to check
 *
 * The plan itself is always drawn from the numbers by src/engine/floorplan.ts, never by AI. This route only reads
 * a sketch into the maker's table: sizes the model copies out are converted to metres in code, and a room whose
 * size isn't written or can't be read comes back without one (listed under needsMeasuring).
 *
 * Reading a photo is one of the more expensive AI calls, so it needs a confirmed email address
 * (403 'verify_email') and the person's consent to the photo going to the AI provider. The AI allowance (per
 * minute, per hour and daily) is charged only once the upload is valid, so a refused upload costs nothing.
 * The photo is not stored, and neither is the reading.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { AiError, aiCan } from '../ai/core';
import { aiAccess, aiCharge } from '../ai/guard';
import { readSketch, SKETCH_LABEL } from '../ai/floorplan/sketch';
import { recordImageConsent } from '../ai/studio/roomImage';
import { HttpError, parse } from '../services/http';
import { cleanImage, sniffImage, type ImageType } from '../services/images';
import { enforce } from '../services/ratelimit';

/** The website sends a resized copy well under this; hosting accepts about 6 MB per request. */
export const SKETCH_MAX_BYTES = 4 * 1024 * 1024;
const SKETCH_LIMITS = { perMinute: 6, perHour: 30 };
const SketchFields = z.object({
  consent: z.literal('true', { error: 'Please confirm you’re happy for this photo to be sent to our AI provider.' }),
  /** What a size written without a unit is in. */
  unit: z.enum(['m', 'ft'], { error: 'Choose metres or feet.' }).default('m'),
});

/** Reads a multipart form with one photo. Extra files are ignored; a photo that is too large gets a clear 413. */
async function readSketchForm(req: FastifyRequest) {
  if (!req.isMultipart()) throw new HttpError(400, 'Send the photo of your sketch as a form upload.', 'not_multipart');
  const mb = Math.round(SKETCH_MAX_BYTES / 1048576);
  let file: { buf: Buffer; type: ImageType | null } | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts({ limits: { fileSize: SKETCH_MAX_BYTES, files: 2, fields: 6, fieldSize: 200 } })) {
      if (part.type === 'file') {
        const buf = await (part as MultipartFile).toBuffer();
        if (!file) file = { buf, type: sniffImage(buf) };
      } else fields[part.fieldname] = String(part.value);
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `That photo is too large. The limit is ${mb} MB.`, 'too_large', { photo: `Use a photo under ${mb} MB.` });
    if (code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') throw new HttpError(413, 'Send one photo at a time.', 'too_many_parts');
    throw e;
  }
  return { file, fields };
}

export async function aiFloorplanRoutes(app: FastifyInstance) {
  app.post('/api/ai/floorplan/from-sketch', async (req) => {
    // Cheap checks first, before the upload is read: AI is on, the person is signed in and their email is confirmed.
    const { user } = await aiAccess(req, { auth: true, verified: true });
    // AI can be on with a provider that has no way to read photos: say so before anything is uploaded or charged.
    if (!aiCan('vision')) throw new AiError('the AI provider has no vision model', 'This AI feature isn’t available on this site.', 503, 'ai_unsupported');
    // Uploads are throttled on their own key, so a burst of refused uploads never uses up the AI allowance.
    await enforce(req, 'floorplan.sketch_uploads.m', 10, 60, 'user', 'You’re uploading photos a bit fast. Please wait a moment and try again.');
    const { file, fields } = await readSketchForm(req);
    const f = parse(SketchFields, fields);
    if (!file || !file.buf.length) throw new HttpError(400, 'Add a photo of your sketch.', 'no_photo', { photo: 'Add a photo of your sketch.' });
    if (!file.type) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP image.', 'bad_photo', { photo: 'Use a JPEG, PNG or WebP photo.' });

    // Valid, and about to reach the model: now it counts towards the AI allowance.
    await aiCharge(req, 'floorplan.sketch', SKETCH_LIMITS);
    await recordImageConsent(user!.id);
    // Location and camera details are removed before the photo is sent; it is held in memory only and never stored.
    const reading = await readSketch(cleanImage(file.buf, file.type), file.type, { userId: user!.id, unit: f.unit });
    return { ...reading, label: SKETCH_LABEL };
  });
}
