/**
 * Room-redesign prompt + compatibility exports. All OpenAI calls go through server/src/ai/core.ts.
 */
import { aiAvailable, aiCan, AiError, editImage } from '../ai/core';

export { AiError };
/** Room images need an image model: every OpenAI account has one; another provider must have one named (AI_IMAGE_MODEL). */
export const aiImagesEnabled = () => aiAvailable() && aiCan('image');

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

/** Restyles a room photo. */
export function editRoomImage(photo: Buffer, contentType: string, prompt: string, meta: { userId?: string | null } = {}) {
  return editImage(photo, contentType, prompt, { purpose: 'studio.room_image', userId: meta.userId ?? null });
}
