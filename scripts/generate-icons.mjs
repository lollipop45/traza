// Generates TRAZA's brand rasters from the vector master, public/brand/traza-mark.svg (the official
// mark, vectorised from brand/traza-mark-source.png). No dependencies: the mark is three straight-edged
// polygons, rasterised here with supersampled point-in-polygon coverage and written as PNG with
// node:zlib. Re-run after changing the master:
//
//   node scripts/generate-icons.mjs
//
// Outputs (committed, static, public):
//   public/brand/traza-mark.png                         1024 px wide transparent master (charcoal)
//   public/icons/icon-192.png, icon-512.png            "any" icons (sand ground, charcoal mark)
//   public/icons/maskable-192.png, maskable-512.png    whole mark inside the 80 % safe-zone circle
//   public/icons/apple-touch-icon.png                  180 × 180, opaque
//   public/icons/badge-96.png                          monochrome (alpha only) notification badge
//   app/favicon.ico                                    16 + 32 px, PNG-in-ICO
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAND = [0xf4, 0xf2, 0xed];
const CHARCOAL = [0x1f, 0x1f, 0x1f];

// --- The mark (read from the master) -----------------------------------------

/** viewBox size and polygons of the master SVG (absolute M/L/Z path, as the master is written). */
function readMaster() {
  const svg = readFileSync(join(ROOT, "public/brand/traza-mark.svg"), "utf8");
  const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const d = svg.match(/\sd="([^"]+)"/)[1];
  if (/[^MLZ0-9.\s-]/.test(d)) throw new Error("Master path must use absolute M/L/Z commands only");
  const polygons = d
    .split("Z")
    .filter((part) => part.trim())
    .map((part) => {
      const numbers = part.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
      const points = [];
      for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
      return points;
    });
  return { width: vw, height: vh, polygons };
}
const MARK = readMaster();

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inMark = (x, y) => MARK.polygons.some((points) => inPolygon(x, y, points));

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
/** RGBA pixels (Uint8Array, width × height × 4) → PNG. */
function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Rendering --------------------------------------------------------------

/**
 * Renders the mark centred on a width × height canvas, `markWidth` pixels wide (its height follows
 * the master's proportions: the geometry is never stretched). `background` null = transparent.
 */
function render(width, height, { markWidth, background, color = CHARCOAL }) {
  const scale = markWidth / MARK.width;
  // Small sizes: whole-pixel placement keeps the frame's top and left edges sharp (the mark moves by
  // under half a pixel; its geometry is unchanged), and more samples per pixel.
  const small = Math.max(width, height) <= 64;
  const place = small ? Math.round : (v) => v;
  const ox = place((width - MARK.width * scale) / 2);
  const oy = place((height - MARK.height * scale) / 2);
  const samples = small ? 16 : 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples - ox) / scale;
          const y = (py + (sy + 0.5) / samples - oy) / scale;
          if (inMark(x, y)) hits++;
        }
      }
      const coverage = hits / (samples * samples);
      const i = (py * width + px) * 4;
      if (background) {
        for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(background[c] * (1 - coverage) + color[c] * coverage);
        rgba[i + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++) rgba[i + c] = color[c];
        rgba[i + 3] = Math.round(255 * coverage);
      }
    }
  }
  return png(width, height, rgba);
}
/** Square icon; `fraction` = mark width / icon size. */
const icon = (size, { fraction, ...rest }) => render(size, size, { markWidth: size * fraction, ...rest });

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

// Generous optical padding: the solid mark carries more weight than its bounding box suggests.
const any = { fraction: 0.54, background: SAND };
// Maskable: the whole mark (its four filled corners included) stays inside the central 80 % circle.
// Its half-diagonal is 0.69 × its width, so any fraction up to 0.57 fits; 0.46 leaves a margin.
const maskable = { fraction: 0.46, background: SAND };
// Tiny sizes: as large as the tab allows, so the gaps between the three parts stay open.
const favicon = { fraction: 0.875, background: SAND };

const MASTER_WIDTH = 1024;
const outputs = {
  "public/brand/traza-mark.png": render(MASTER_WIDTH, Math.round((MASTER_WIDTH * MARK.height) / MARK.width), {
    markWidth: MASTER_WIDTH,
    background: null,
  }),
  "public/icons/icon-192.png": icon(192, any),
  "public/icons/icon-512.png": icon(512, any),
  "public/icons/maskable-192.png": icon(192, maskable),
  "public/icons/maskable-512.png": icon(512, maskable),
  "public/icons/apple-touch-icon.png": icon(180, any),
  "public/icons/badge-96.png": icon(96, { fraction: 0.78, background: null, color: [255, 255, 255] }),
  "app/favicon.ico": ico([
    { size: 16, data: icon(16, favicon) },
    { size: 32, data: icon(32, favicon) },
  ]),
};

for (const [file, data] of Object.entries(outputs)) {
  const target = join(ROOT, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`${file} (${data.length} bytes)`);
}
