/**
 * Design studio AI:
 *   POST /api/ai/room-image              confirmed email · photo + style → 202 {jobId, image}; poll GET /api/ai/jobs/:id
 *   GET  /api/ai/room-images             signed in       · your AI designs
 *   POST /api/ai/design/brief            anyone          · brief text → room, style, tier, materials + engine costs
 *   POST /api/ai/design/describe-photo   confirmed email · one room photo → what to keep, what to fix, suggested styles
 *
 * Image generation and photo analysis are the most expensive AI calls, so they need a confirmed
 * email address (403 'verify_email'), and redesigns have a per-person and a site-wide daily cap
 * (429 'quota' / 'site_quota'), checked under a lock so parallel uploads can't pass them together.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { STYLES } from '../../../src/engine/design';
import { config } from '../config';
import { one, q, tx } from '../db';
import { modelFor } from '../ai/core';
import { aiGuard } from '../ai/guard';
import { enqueue } from '../ai/jobs';
import { designBrief, ROOMS } from '../ai/studio/brief';
import { ANALYSIS_LABEL, describeRoomPhoto } from '../ai/studio/describe';
import { assertImageAllowance, imageDTO, imagesUsedToday, lockImageAllowance, recordImageConsent, registerRoomImageJob, ROOM_IMAGE_JOB, ROOM_IMAGE_LABEL, settleStaleImages, type ImageRow } from '../ai/studio/roomImage';
import { audit, HttpError, parse, requireUser } from '../services/http';
import { cleanImage, sniffImage, type ImageType } from '../services/images';
import { roomPrompt } from '../services/openai';
import { deleteFile, newKey, putFile } from '../services/storage';

const CONSENT = z.literal('true', { error: 'Please confirm you’re happy for this photo to be processed by our AI provider.' });
const ImageFields = z.object({
  room: z.enum(['kitchen', 'bathroom', 'living', 'bedroom', 'dining', 'office', 'hallway'], { error: 'Choose the room.' }),
  style: z.string().trim().min(2).max(40),
  brief: z.string().trim().max(600, 'Keep the brief under 600 characters.').optional(),
  palette: z.string().max(200).optional(),
  consent: CONSENT,
});
const DescribeFields = z.object({ room: z.enum(ROOMS).optional(), consent: CONSENT });
const BriefBody = z.object({
  text: z.string({ error: 'Describe what you’d like.' }).trim().min(3, 'Describe what you’d like, e.g. “Scandinavian bedroom for £3,500”.').max(600, 'Keep the brief under 600 characters.'),
  room: z.enum(ROOMS).optional(),
  budget: z.number().min(0).max(1_000_000).nullable().optional(),
  postcode: z.string().trim().max(10).regex(/^[A-Za-z0-9 ]*$/, 'Enter a UK postcode.').optional(),
  dims: z.object({ width: z.number().min(1).max(30), length: z.number().min(1).max(30), height: z.number().min(1.8).max(6) }).optional(),
  staged: z.boolean().optional(),
});
const DESCRIBE_MAX_BYTES = 4 * 1024 * 1024;

/** Reads a multipart form with one photo. Extra files are ignored; too-large photos get a clear 413. */
async function readPhotoForm(req: FastifyRequest, maxBytes: number) {
  if (!req.isMultipart()) throw new HttpError(400, 'Send the room photo as a form upload.', 'not_multipart');
  let file: { buf: Buffer; type: ImageType | null } | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 3, fields: 12 } })) {
      if (part.type === 'file') {
        const buf = await (part as MultipartFile).toBuffer();
        if (!file) file = { buf, type: sniffImage(buf) };
      } else fields[part.fieldname] = String(part.value);
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, `That photo is too large. The limit is ${Math.round(maxBytes / 1048576)} MB.`, 'too_large', { photo: `Use a photo under ${Math.round(maxBytes / 1048576)} MB.` });
    if (code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') throw new HttpError(413, 'Send one photo at a time.', 'too_many_parts');
    throw e;
  }
  return { file, fields };
}
function requirePhoto(file: { buf: Buffer; type: ImageType | null } | null): { buf: Buffer; type: ImageType } {
  if (!file || !file.buf.length) throw new HttpError(400, 'Add a photo of the room.', 'no_photo', { photo: 'Add a photo of the room.' });
  if (!file.type) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP image.', 'bad_photo', { photo: 'Use a JPEG, PNG or WebP photo.' });
  return file as { buf: Buffer; type: ImageType };
}

export async function aiRoutes(app: FastifyInstance) {
  registerRoomImageJob();

  /* ───────── room redesign (background job) ───────── */
  app.post('/api/ai/room-image', async (req, reply) => {
    const { user } = await aiGuard(req, 'studio.room_image', { auth: true, verified: true, perMinute: 6, perHour: 40 });
    const u = user!;
    await settleStaleImages(u.id);
    await assertImageAllowance(u.id); // fail fast, before the upload is read
    const { file, fields } = await readPhotoForm(req, config.storage.maxPhotoBytes);
    const f = parse(ImageFields, fields);
    const photo = requirePhoto(file);

    const style = STYLES.find((s) => s.id === f.style || s.name.toLowerCase() === f.style.toLowerCase());
    const prompt = roomPrompt({
      room: f.room, style: style?.name ?? f.style, styleNote: style?.note, brief: f.brief,
      palette: f.palette?.split(',').map((s) => s.trim()).filter((s) => /^#?[0-9a-z\s-]{3,30}$/i.test(s)).slice(0, 6),
    });
    const clean = cleanImage(photo.buf, photo.type); // location and camera metadata removed before storing or sending
    const source = await putFile(newKey('ai/source', photo.type), clean, photo.type);
    const model = await modelFor('image');
    // The upload may have taken a while: re-check the allowances and reserve the design under a lock.
    let row: ImageRow;
    try {
      row = await tx(async (c) => {
        await lockImageAllowance(u.id, c);
        await assertImageAllowance(u.id, c);
        return (await one<ImageRow>(`INSERT INTO ai_images (user_id, room, style, brief, prompt, source_key, model, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running') RETURNING *`,
          [u.id, f.room, style?.name ?? f.style, f.brief ?? null, prompt, source.key, model], c))!;
      });
    } catch (e) {
      await deleteFile(source.key).catch(() => {}); // no design row points at the stored photo
      throw e;
    }
    await recordImageConsent(u.id);
    const job = await enqueue(ROOM_IMAGE_JOB, { imageId: row.id }, { userId: u.id, subject: `ai_image:${row.id}` });
    await audit(req, 'ai.room_image', `ai_image:${row.id}`, { room: f.room, style: style?.name ?? f.style });
    const now = (await one<ImageRow>('SELECT * FROM ai_images WHERE id = $1', [row.id]))!;
    return reply.code(202).send({
      jobId: job.id, image: imageDTO(now),
      remainingToday: Math.max(0, config.ai.dailyImagesPerUser - (await imagesUsedToday(u.id))), label: ROOM_IMAGE_LABEL,
    });
  });

  app.get('/api/ai/room-images', async (req) => {
    const u = requireUser(req);
    await settleStaleImages(u.id);
    return { items: (await q<ImageRow>('SELECT * FROM ai_images WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [u.id])).map(imageDTO) };
  });

  /* ───────── design brief → plan with engine costs ───────── */
  app.post('/api/ai/design/brief', async (req) => {
    const g = await aiGuard(req, 'design.brief', { perMinute: 10, perHour: 60 });
    const b = parse(BriefBody, req.body ?? {});
    return designBrief({ text: b.text, room: b.room, budget: b.budget ?? null, postcode: b.postcode || undefined, dims: b.dims, staged: b.staged }, { userId: g.userId });
  });

  /* ───────── analyse one room photo ───────── */
  app.post('/api/ai/design/describe-photo', async (req) => {
    const { user } = await aiGuard(req, 'design.describe_photo', { auth: true, verified: true, perMinute: 6, perHour: 30 });
    const { file, fields } = await readPhotoForm(req, DESCRIBE_MAX_BYTES);
    const f = parse(DescribeFields, fields);
    const photo = requirePhoto(file);
    await recordImageConsent(user!.id);
    const analysis = await describeRoomPhoto(cleanImage(photo.buf, photo.type), photo.type, { userId: user!.id, roomHint: f.room });
    return { analysis, label: ANALYSIS_LABEL };
  });
}
