/**
 * Image checks for uploads: detect the real type from the bytes (never trust the
 * file name or browser), and strip JPEG metadata (EXIF/XMP can carry the GPS
 * location of someone's home and camera details).
 */
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export function sniffImage(b: Buffer): ImageType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Removes APP1 (EXIF/XMP), APP13 (IPTC) and COM segments from a JPEG. Keeps APP0/APP2 (ICC colour). */
export function stripJpegMetadata(b: Buffer): Buffer {
  if (sniffImage(b) !== 'image/jpeg') return b;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b; // not a well-formed marker stream: leave untouched
    const marker = b[i + 1];
    if (marker === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); } // start of scan: rest is image data
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return Buffer.concat(out);
}

/** Removes the eXIf chunk (EXIF in PNG) and text chunks that can carry metadata. */
export function stripPngMetadata(b: Buffer): Buffer {
  if (sniffImage(b) !== 'image/png') return b;
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/** Removes EXIF and XMP chunks from a WebP and clears their flags in the VP8X header. */
export function stripWebpMetadata(b: Buffer): Buffer {
  if (sniffImage(b) !== 'image/webp') return b;
  const out: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('ascii', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) return b;
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, end));
      if (type === 'VP8X' && len >= 1) chunk[8] &= ~(0x08 | 0x04);
      out.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

export function cleanImage(b: Buffer, type: ImageType) {
  return type === 'image/jpeg' ? stripJpegMetadata(b) : type === 'image/png' ? stripPngMetadata(b) : stripWebpMetadata(b);
}
