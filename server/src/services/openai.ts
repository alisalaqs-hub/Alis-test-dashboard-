/**
 * OpenAI image editing for "Redesign a room": sends the person's room photo with a
 * written brief and gets back a restyled photo of the same room.
 * The key stays on the server (OPENAI_API_KEY); it is never sent to browsers.
 */
import { config } from '../config';

export const aiImagesEnabled = () => !!config.ai.openaiKey;

export interface RoomBrief { room: string; style: string; styleNote?: string; brief?: string | null; palette?: string[] }

export function roomPrompt(b: RoomBrief) {
  const room = b.room === 'living' ? 'living room' : b.room;
  return [
    `Photorealistic interior redesign of the ${room} shown in this photo, in a ${b.style} style${b.styleNote ? ` (${b.styleNote})` : ''}.`,
    'Keep the room’s architecture exactly as it is: same walls, ceiling, windows, doors, radiators, room size, camera position, lens and perspective.',
    'Change only finishes, furniture, fittings, colours, soft furnishings and lighting.',
    b.palette?.length ? `Colour palette: ${b.palette.join(', ')}.` : '',
    b.brief ? `The owner’s brief: ${b.brief.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    'Realistic materials and products available from UK retailers, UK electrical sockets and fittings, natural daylight.',
    'No people, no text, no logos, no watermarks.',
  ].filter(Boolean).join(' ');
}

export class AiError extends Error { constructor(message: string, public userMessage: string, public status = 502) { super(message); } }

/** Calls POST /images/edits. Returns the generated image bytes (PNG or JPEG). */
export async function editRoomImage(photo: Buffer, contentType: string, prompt: string): Promise<Buffer> {
  if (!aiImagesEnabled()) throw new AiError('OPENAI_API_KEY not set', 'AI room redesign isn’t switched on yet on this server.', 503);
  const send = async (withFidelity: boolean) => {
    const form = new FormData();
    form.append('model', config.ai.imageModel);
    form.append('image', new Blob([new Uint8Array(photo)], { type: contentType }), `room.${contentType.split('/')[1] === 'jpeg' ? 'jpg' : contentType.split('/')[1]}`);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', 'auto');
    if (config.ai.imageQuality) form.append('quality', config.ai.imageQuality);
    if (withFidelity && config.ai.inputFidelity) form.append('input_fidelity', config.ai.inputFidelity);
    return fetch(`${config.ai.openaiBase}/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.ai.openaiKey}` }, body: form, signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  };
  let r: Response;
  try {
    r = await send(true);
    // Older or different image models may not accept input_fidelity: retry once without it.
    if (r.status === 400) {
      const text = await r.clone().text();
      if (/input_fidelity/i.test(text)) r = await send(false);
    }
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new AiError((e as Error).message, timeout ? 'The AI took too long to respond. Please try again.' : 'Couldn’t reach the AI image service. Please try again.', 504);
  }
  const j = (await r.json().catch(() => ({}))) as { data?: { b64_json?: string; url?: string }[]; error?: { message?: string; code?: string; type?: string } };
  if (!r.ok) {
    // Provider messages can echo part of a rejected key: never log or store it.
    const msg = (j.error?.message ?? `HTTP ${r.status}`).replace(/(api key provided:?\s*)\S+/gi, '$1[redacted]').replace(/sk-[A-Za-z0-9_*-]{4,}/g, 'sk-[redacted]');
    if (r.status === 401) throw new AiError(msg, 'The AI image service rejected the server’s API key. An admin needs to check OPENAI_API_KEY.', 502);
    if (r.status === 429) throw new AiError(msg, 'The AI image service is busy or the account has hit its limit. Please try again later.', 503);
    if (j.error?.code === 'moderation_blocked' || /safety|moderation/i.test(msg)) throw new AiError(msg, 'The AI service declined this photo. Try a different photo of the room.', 422);
    throw new AiError(msg, 'The AI image service couldn’t process this photo. Please try another one.', 502);
  }
  const first = j.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first?.url) { const img = await fetch(first.url, { signal: AbortSignal.timeout(60_000) }); if (img.ok) return Buffer.from(await img.arrayBuffer()); }
  throw new AiError('no image in response', 'The AI didn’t return an image. Please try again.');
}
