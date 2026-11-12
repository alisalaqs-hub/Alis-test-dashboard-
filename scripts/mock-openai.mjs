// A local stand-in for the OpenAI API, for trying every AI screen without a key or cost.
//   node scripts/mock-openai.mjs            (listens on http://127.0.0.1:8790)
//   OPENAI_BASE_URL=http://127.0.0.1:8790/v1 OPENAI_API_KEY=mock npm run server:dev
// Structured-output requests get a valid object generated from the requested JSON Schema,
// filled with readable placeholder text. Images come back as a small sample picture.
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.MOCK_OPENAI_PORT || 8790);
const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-image-2', 'text-embedding-3-small', 'omni-moderation-latest'];

const WORDS = {
  headline: 'Bright three-bedroom terrace with a south-facing garden',
  summary: 'Based on the figures provided, this looks workable. The main costs are the kitchen and rewiring, and the biggest risk is hidden damp in the rear wall.',
  reply: 'Here’s what I found. **Three homes** match: the best value is in Walthamstow. Ask me to compare them or work out stamp duty.',
  description: 'A well-proportioned family home arranged over two floors, with a bright reception room, a kitchen opening to the garden and three bedrooms upstairs. The property is freehold, EPC band D and council tax band C.',
};
function sampleString(name, schema) {
  if (schema.enum) return schema.enum[0];
  const n = (name || '').toLowerCase();
  if (/headline|title/.test(n)) return WORDS.headline;
  if (/summary|narrative|verdict.?text|explanation|insight/.test(n)) return WORDS.summary;
  if (/reply|answer|content/.test(n)) return WORDS.reply;
  if (/description/.test(n)) return WORDS.description;
  if (/alt/.test(n)) return 'Living room with a bay window, wooden floor and a fireplace';
  if (/room/.test(n)) return 'living room';
  if (/(^|_)to$|link|path|url/.test(n)) return '/search?q=3%20bed%20house%20in%20E17';
  if (/label|chip|understood/.test(n)) return '3+ bedrooms';
  if (/id$|ids$/.test(n)) return 'wal-001';
  if (/question/.test(n)) return 'Is the boiler under warranty?';
  if (/reason|why|detail|note|issue|risk|step|action|tip|warning|flag|strength|opportunit|priority|quickwin|avoid|evidence/.test(n)) return 'Check the condition of the rear extension roof before committing.';
  if (/district/.test(n)) return 'E17';
  if (/location|town|place/.test(n)) return 'Walthamstow';
  return 'Sample text from the local AI stand-in.';
}
function sample(schema, name = '', depth = 0) {
  if (!schema || depth > 8) return null;
  if (schema.anyOf) { const nonNull = schema.anyOf.find((s) => s.type !== 'null'); return nonNull ? sample(nonNull, name, depth + 1) : null; }
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sample(v, k, depth + 1)]));
    case 'array': return [0, 1].map(() => sample(schema.items, name.replace(/s$/, ''), depth + 1)).filter((x) => x !== null);
    case 'string': return sampleString(name, schema);
    case 'integer': return /beds/.test(name) ? 3 : /score/.test(name) ? 72 : /year/.test(name) ? 2026 : 3;
    case 'number': return /price|budget/.test(name) ? 450000 : /pct|percent|rate/.test(name) ? 5.5 : /confidence/.test(name) ? 0.8 : 3;
    case 'boolean': return /flag|contains|spam|scam|filter|block/.test(name) ? false : true;
    case 'null': return null;
    default: return null;
  }
}

function png(w = 64, h = 48) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200 - y; raw[o + 1] = 180 + (x % 20); raw[o + 2] = 150; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return crc ^ 0xffffffff; }
const IMAGE = png();

// "Read my sketch" (floor plan maker): rooms as they might be written on a hand sketch, one in feet and inches and one with no size.
const sketchRoom = (name, floor, width, length, unit, row, order) => ({ name, floor, width, length, unit, row, order });
const SKETCH = {
  isSketch: true,
  rooms: [
    sketchRoom('Kitchen', 'ground', '3.2', '3.0', 'm', 1, 1), sketchRoom('Dining rm', 'ground', '3.6', '3.0', 'm', 1, 2),
    sketchRoom('Hall', 'ground', '1.8', '4.2', 'm', 2, 1), sketchRoom('Lounge', 'ground', '5.0', '4.2', 'm', 2, 2), sketchRoom('Utility', 'ground', null, null, 'unknown', 3, 1),
    sketchRoom('Bed 1', 'first', '13\'9"', '12\'10"', 'ft', 1, 1), sketchRoom('Bathroom', 'first', '2.6', '2.1', 'm', 1, 2),
  ],
  notes: 'No size is written for the utility room.',
};

function embedding(text) { const v = new Array(64).fill(0); for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 64] += 1; } return v; }

const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const path = (req.url || '').replace(/^\/v1/, '').split('?')[0];
  const send = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  await new Promise((r) => setTimeout(r, 250));
  if (path === '/models') return send({ data: MODELS.map((id) => ({ id })) });
  if (path === '/moderations') return send({ results: [{ flagged: false, categories: {}, category_scores: {} }] });
  if (path === '/embeddings') { const body = JSON.parse(raw.toString() || '{}'); const input = Array.isArray(body.input) ? body.input : [body.input]; return send({ data: input.map((t, index) => ({ embedding: embedding(t), index })), usage: { prompt_tokens: 10 } }); }
  if (path === '/images/edits' || path === '/images/generations') { await new Promise((r) => setTimeout(r, 1500)); return send({ data: [{ b64_json: IMAGE.toString('base64') }] }); }
  if (path === '/chat/completions') {
    const body = JSON.parse(raw.toString() || '{}');
    const schema = body.response_format?.json_schema?.schema;
    const name = body.response_format?.json_schema?.name;
    const content = name === 'floor_plan_sketch' ? JSON.stringify(SKETCH) : schema ? JSON.stringify(sample(schema, name)) : WORDS.reply;
    return send({ choices: [{ message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 120 } });
  }
  send({ error: { message: `mock: no handler for ${path}` } }, 404);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Mock OpenAI on http://127.0.0.1:${PORT}/v1`));
