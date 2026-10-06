// Рисует PNG-иконки Смотрильни (Пояс Ориона в просвете облаков) без зависимостей: node scripts/icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/assets/', import.meta.url);
const SS = 4; // сглаживание: 4×4 выборки на пиксель

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const CLOUD_TOP = hex('#23262b'), CLOUD_LOW = hex('#2e2c29'); // пасмурный графит, к низу теплее от города
const LIFT = hex('#393a3d'), SEAM = hex('#16181c'), RIM = hex('#4b4e54'), GAP = hex('#08090c');
const SILVER = hex('#dfe6f2'), CORE = hex('#f5f8fc');

// Пояс в долях стороны: настоящие взаимные положения (север вверху, восток слева)
const STARS = [
  { x: 16 / 32, y: 16 / 32, r: 0.04, h: 1 },          // Альнилам — общий фильм, ярче всех
  { x: 24.7 / 32, y: 8.5 / 32, r: 0.03, h: 0.72 },    // Минтака — зритель
  { x: 6.6 / 32, y: 22.1 / 32, r: 0.034, h: 0.82 },    // Альнитак — второй человек
];
const ANG = -37 * Math.PI / 180, CA = Math.cos(ANG), SA = Math.sin(ANG);

// шум для рваной кромки облаков
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => { let s = 0, k = 0.5; for (let o = 0; o < 4; o++) { s += noise(x, y) * k; x = x * 2.03 + 5.2; y = y * 2.03 + 1.3; k /= 2; } return s; };

// цвет точки (x, y в долях стороны 0..1); возвращает [r, g, b]
function shade(x, y) {
  // облака: пасмурная пелена в клочьях, просвет вытянут вдоль Пояса
  let c = mix(CLOUD_TOP, CLOUD_LOW, y);
  c = mix(c, LIFT, sstep(0.4, 0.75, fbm(x * 4 + 7, y * 4)) * 0.6);
  c = mix(c, SEAM, sstep(0.5, 0.8, fbm(x * 8 + 3, y * 8)) * 0.4);
  const dx = x - 0.5, dy = y - 0.5;
  const u = dx * CA + dy * SA, v = -dx * SA + dy * CA;
  const e = Math.hypot(u / 0.6, v / 0.33) + (fbm(x * 3.4, y * 3.4) - 0.5) * 0.7;
  const gap = 1 - sstep(0.56, 1.1, e);
  const rim = Math.exp(-(((e - 1.02) / 0.2) ** 2));
  c = add(c, RIM, rim * 0.12);
  c = mix(c, GAP, gap);
  // звёзды: ореол в дымке и чистая сердцевина
  for (const s of STARS) {
    const d = Math.hypot(x - s.x, y - s.y);
    c = add(c, SILVER, s.h * (0.42 * Math.exp(-((d / 0.045) ** 2)) + 0.07 * Math.exp(-((d / 0.13) ** 2))));
    c = mix(c, CORE, sstep(s.r, s.r * 0.7, d));
  }
  return c.map((v) => Math.min(255, v));
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
  const origin = Buffer.from('Source\0Rendered procedurally by scripts/icons.mjs (Orion\'s Belt mark, no external artwork)', 'latin1');
  const prompt = Buffer.from('impeccable:prompt\0Procedural render (no image model): scripts/icons.mjs draws the three stars of '
    + 'Orion\'s Belt (Mintaka, Alnilam, Alnitak) at their true relative positions, shining in a gap of an overcast graphite '
    + 'sky (#23262b to #2e2c29, value-noise cloud edge, gap #08090c), silver cores with soft gaussian halos; 4x4 supersampling.\n', 'latin1');
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
