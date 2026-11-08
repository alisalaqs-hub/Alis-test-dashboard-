import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import type { AiImageDTO } from '../../../src/lib/apiTypes';
import { STYLES } from '../../../src/engine/design';
import { config } from '../config';
import { one, q } from '../db';
import { audit, HttpError, parse, requireUser } from '../services/http';
import { cleanImage, sniffImage } from '../services/images';
import { AiError, aiImagesEnabled, editRoomImage, roomPrompt } from '../services/openai';
import { modelFor } from '../ai/core';
import { newKey, putFile } from '../services/storage';
import { limit } from '../services/ratelimit';

const Fields = z.object({
  room: z.enum(['kitchen', 'bathroom', 'living', 'bedroom', 'dining', 'office', 'hallway']),
  style: z.string().trim().min(2).max(40),
  brief: z.string().trim().max(600).optional(),
  palette: z.string().max(200).optional(),
  consent: z.literal('true', { error: 'Please confirm you’re happy for this photo to be processed by our AI provider.' }),
});

type Row = { id: string; room: string; style: string; brief: string | null; status: AiImageDTO['status']; result_url: string | null; source_key: string | null; model: string; error: string | null; created_at: Date };
const toDTO = (r: Row): AiImageDTO => ({
  id: r.id, room: r.room, style: r.style, brief: r.brief, status: r.status, url: r.result_url,
  sourceUrl: r.source_key ? (config.storage.driver === 's3' ? `${config.storage.s3.publicBaseUrl}/${r.source_key}` : `/media/${r.source_key}`) : null,
  model: r.model, error: r.error, createdAt: r.created_at.toISOString(),
});

async function usedToday(userId: string) {
  return (await one<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE user_id = $1 AND status <> 'failed' AND created_at > now() - interval '24 hours'`, [userId]))!.n;
}

export async function aiRoutes(app: FastifyInstance) {
  app.post('/api/ai/room-image', { preHandler: limit('ai.room_image', 6, 60, 'user-or-ip') }, async (req, reply) => {
    const u = requireUser(req);
    if (!aiImagesEnabled()) throw new HttpError(503, 'AI room redesign isn’t switched on yet on this server.', 'ai_disabled');
    if ((await usedToday(u.id)) >= config.ai.dailyImagesPerUser) throw new HttpError(429, `You’ve used today’s ${config.ai.dailyImagesPerUser} AI designs. Try again tomorrow.`, 'quota');
    if (!req.isMultipart()) throw new HttpError(400, 'Send the room photo as a form upload.', 'not_multipart');

    let file: { buf: Buffer; type: ReturnType<typeof sniffImage> } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) { await (part as MultipartFile).toBuffer(); continue; }
        const buf = await (part as MultipartFile).toBuffer();
        file = { buf, type: sniffImage(buf) };
      } else fields[part.fieldname] = String(part.value);
    }
    const f = parse(Fields, fields);
    if (!file) throw new HttpError(400, 'Add a photo of the room.', 'no_photo', { photo: 'Add a photo of the room.' });
    if (!file.type) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP image.', 'bad_photo', { photo: 'Use a JPEG, PNG or WebP photo.' });

    const style = STYLES.find((s) => s.id === f.style || s.name.toLowerCase() === f.style.toLowerCase());
    const prompt = roomPrompt({
      room: f.room, style: style?.name ?? f.style, styleNote: style?.note, brief: f.brief,
      palette: f.palette?.split(',').map((s) => s.trim()).filter((s) => /^#?[0-9a-z\s-]{3,30}$/i.test(s)).slice(0, 6),
    });
    const clean = cleanImage(file.buf, file.type);
    const source = await putFile(newKey('ai/source', file.type), clean, file.type);
    await q(`INSERT INTO consents (user_id, purpose) SELECT $1, 'ai_image_processing' WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing' AND withdrawn_at IS NULL)`, [u.id]);
    const row = await one<{ id: string }>(`INSERT INTO ai_images (user_id, room, style, brief, prompt, source_key, model) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [u.id, f.room, style?.name ?? f.style, f.brief ?? null, prompt, source.key, await modelFor('image')]);

    try {
      const out = await editRoomImage(clean, file.type, prompt, { userId: u.id });
      const outType = sniffImage(out) ?? 'image/png';
      const stored = await putFile(newKey('ai/result', outType), out, outType);
      const done = await one<Row>(`UPDATE ai_images SET status = 'done', result_key = $2, result_url = $3, finished_at = now() WHERE id = $1 RETURNING *`, [row!.id, stored.key, stored.url]);
      await audit(req, 'ai.room_image', `ai_image:${row!.id}`, { room: f.room, style: style?.name ?? f.style });
      return reply.code(201).send({ image: toDTO(done!), remainingToday: Math.max(0, config.ai.dailyImagesPerUser - (await usedToday(u.id))), label: 'AI-generated concept. Not a photo of a finished room.' });
    } catch (e) {
      const ai = e instanceof AiError ? e : new AiError((e as Error).message, 'Something went wrong creating the design. Please try again.');
      await q(`UPDATE ai_images SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [row!.id, ai.message.slice(0, 500)]);
      req.log.warn({ err: ai.message }, 'ai image failed');
      throw new HttpError(ai.status, ai.userMessage, 'ai_failed');
    }
  });

  app.get('/api/ai/room-images', async (req) => {
    const u = requireUser(req);
    return { items: (await q<Row>('SELECT * FROM ai_images WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [u.id])).map(toDTO) };
  });
}
