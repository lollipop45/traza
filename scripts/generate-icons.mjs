// Generates TRAZA's PWA icons from the brand mark (a square cut by its diagonal, as in
// components/ui/Wordmark.tsx). No dependencies: the mark is pure geometry, rasterised here with 4×4
// supersampling and written as PNG with node:zlib. Re-run after changing the mark:
//
//   node scripts/generate-icons.mjs
//
// Outputs (committed, static, public):
//   public/icons/icon-192.png, icon-512.png            "any" icons (sand ground, charcoal mark)
//   public/icons/maskable-192.png, maskable-512.png    mark inside the 80 % safe zone
//   public/icons/apple-touch-icon.png                  180 × 180, opaque
//   public/icons/badge-96.png                          monochrome (alpha only) notification badge
//   app/favicon.ico                                    16 + 32 px, PNG-in-ICO
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAND = [0xf4, 0xf2, 0xed];
const CHARCOAL = [0x1f, 0x1f, 0x1f];

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** RGBA pixels (Uint8Array, size × size × 4) → PNG. */
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- The mark ---------------------------------------------------------------

/**
 * Coverage (0..1) of the mark at a point: a square outline of side `side` centred in the canvas,
 * with stroke `stroke`, plus the diagonal from its bottom-left to its top-right corner.
 */
function markAt(x, y, size, side, stroke) {
  const x0 = (size - side) / 2;
  const y0 = (size - side) / 2;
  const inOuter = x >= x0 && x <= x0 + side && y >= y0 && y <= y0 + side;
  if (!inOuter) return false;
  const inInner = x >= x0 + stroke && x <= x0 + side - stroke && y >= y0 + stroke && y <= y0 + side - stroke;
  if (!inInner) return true;
  // Diagonal: points (x0, y0 + side) → (x0 + side, y0), i.e. (x - x0) + (y - y0) = side.
  const distance = Math.abs(x - x0 + (y - y0) - side) / Math.SQRT2;
  return distance <= stroke / 2;
}

/** Renders the mark. `fraction` = mark side / canvas; `strokeRatio` = stroke / mark side. */
function render(size, { fraction, strokeRatio, background, color = CHARCOAL }) {
  const side = Math.round(size * fraction);
  const stroke = Math.max(1, side * strokeRatio);
  const rgba = new Uint8Array(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (markAt(px + (sx + 0.5) / samples, py + (sy + 0.5) / samples, size, side, stroke)) hits++;
        }
      }
      const coverage = hits / (samples * samples);
      const i = (py * size + px) * 4;
      if (background) {
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(background[c] * (1 - coverage) + color[c] * coverage);
        rgba[i + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++) rgba[i + c] = color[c];
        rgba[i + 3] = Math.round(255 * coverage);
      }
    }
  }
  return png(size, rgba);
}

/** ICO container holding PNG images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size % 256;
    entry[1] = size % 256;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// --- Outputs ----------------------------------------------------------------

const any = { fraction: 0.5, strokeRatio: 0.075, background: SAND };
// Maskable: the whole mark (its corners included) stays inside the central 80 % circle.
const maskable = { fraction: 0.42, strokeRatio: 0.075, background: SAND };
// Tiny sizes need a bolder, larger mark to stay legible.
const favicon = { fraction: 0.78, strokeRatio: 0.12, background: SAND };

const outputs = {
  "public/icons/icon-192.png": render(192, any),
  "public/icons/icon-512.png": render(512, any),
  "public/icons/maskable-192.png": render(192, maskable),
  "public/icons/maskable-512.png": render(512, maskable),
  "public/icons/apple-touch-icon.png": render(180, any),
  "public/icons/badge-96.png": render(96, { fraction: 0.7, strokeRatio: 0.1, background: null, color: [255, 255, 255] }),
  "app/favicon.ico": ico([
    { size: 16, data: render(16, favicon) },
    { size: 32, data: render(32, favicon) },
  ]),
};

for (const [file, data] of Object.entries(outputs)) {
  const target = join(ROOT, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`${file} (${data.length} bytes)`);
}
