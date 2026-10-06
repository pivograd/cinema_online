// Рисует PNG-иконки «Свет в окне» (горящее окно с переплётом «Т») без зависимостей: node scripts/icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/assets/', import.meta.url);
const SS = 4; // сглаживание: 4×4 выборки на пиксель

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const BG_TOP = hex('#1b1f24'), BG_LOW = hex('#111317');
const GLASS_TOP = hex('#f1f4f7'), GLASS_LOW = hex('#b9c7d4'), BAR = hex('#1b1f24'), HALO = hex('#dfe7ee');

// цвет точки (x, y в долях стороны 0..1); возвращает [r, g, b]
function shade(x, y) {
  let c = mix(BG_TOP, BG_LOW, y);
  // ореол в тумане вокруг окна
  const d = Math.hypot((x - 0.5) / 0.9, (y - 0.52) / 1.05);
  c = mix(c, HALO, Math.max(0, 0.28 * (1 - d / 0.5)) ** 1.6);
  const L = 0.32, R = 0.68, T = 0.24, B = 0.8; // окно
  if (x >= L && x <= R && y >= T && y <= B) {
    const transom = T + (B - T) * 0.32;
    const bar = 0.024;
    const inBar = Math.abs(y - transom) < bar / 2 || (Math.abs(x - 0.5) < bar / 2 && y > transom);
    c = inBar ? BAR : mix(GLASS_TOP, GLASS_LOW, (y - T) / (B - T));
  }
  return c;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((pxi + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          acc = acc.map((v, i) => v + c[i]);
        }
      }
      const o = (py * size + pxi) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(acc[i] / (SS * SS));
      px[o + 3] = 255;
    }
  }
  return png(size, px);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  // происхождение растра: рисуется кодом, без сторонних картинок (ключ impeccable:prompt читает проверка ассетов)
  const origin = Buffer.from('Source\0Rendered procedurally by scripts/icons.mjs (window glyph, no external artwork)', 'latin1');
  const prompt = Buffer.from('impeccable:prompt\0Procedural render (no image model): scripts/icons.mjs draws a lit Petersburg window '
    + 'with a T-shaped mullion and a soft fog halo on a graphite #1b1f24 to #111317 ground; 4x4 supersampling.\n', 'latin1');
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('tEXt', origin),
    chunk('tEXt', prompt),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), render(size));
  console.log(`icon-${size}.png`);
}
