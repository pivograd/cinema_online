'use strict';
// Совместный просмотр: HTTP (логин, статика, видео с Range) + WebSocket (синхронизация).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'cinema_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// USERS="anna:пароль1;boris:пароль2"
function parseUsers(raw) {
  const users = new Map();
  for (const part of (raw || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) users.set(part.slice(0, i).trim(), part.slice(i + 1));
  }
  return users;
}
const USERS = parseUsers(process.env.USERS);
if (USERS.size === 0) {
  console.error('Не заданы пользователи. Пример: USERS="anna:пароль1;boris:пароль2" npm start');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// --- сессии: подписанный cookie "user.expires.hmac" ---
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function makeToken(user) {
  const payload = `${Buffer.from(user).toString('base64url')}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}
function readUser(req) {
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!cookie) return null;
  const [u, exp, mac] = decodeURIComponent(cookie.slice(COOKIE.length + 1)).split('.');
  if (!u || !exp || !mac) return null;
  const payload = `${u}.${exp}`;
  if (!safeEqual(mac, sign(payload)) || Number(exp) < Date.now()) return null;
  const user = Buffer.from(u, 'base64url').toString();
  return USERS.has(user) ? user : null;
}

// --- защита от перебора пароля: 5 попыток за 5 минут с одного IP ---
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 5;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// --- состояние комнаты (единственной) ---
const room = { file: null, playing: false, position: 0, updatedAt: Date.now() };
const currentPosition = () =>
  room.position + (room.playing ? (Date.now() - room.updatedAt) / 1000 : 0);
const snapshot = () => ({
  file: room.file,
  playing: room.playing,
  position: currentPosition(),
});

function listMedia() {
  try {
    return fs.readdirSync(MEDIA_DIR).filter((f) => VIDEO_TYPES[path.extname(f).toLowerCase()]).sort();
  } catch {
    return [];
  }
}
function ensureFile() {
  const files = listMedia();
  if (!room.file || !files.includes(room.file)) {
    room.file = files[0] || null;
    room.playing = false;
    room.position = 0;
    room.updatedAt = Date.now();
  }
}

// --- HTTP ---
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

function serveVideo(req, res, name) {
  const full = path.join(MEDIA_DIR, name);
  const type = VIDEO_TYPES[path.extname(name).toLowerCase()];
  if (!type || !full.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(full)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const size = fs.statSync(full).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(size - Number(range[2]), 0); // bytes=-N
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    status = 206;
  }
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=3600',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const user = readUser(req);

  if (req.method === 'POST' && url.pathname === '/login') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) { res.writeHead(429).end('Слишком много попыток, подождите 5 минут'); return; }
    let form;
    try { form = new URLSearchParams(await readBody(req)); } catch { res.writeHead(400).end(); return; }
    const name = form.get('user') || '';
    const pass = form.get('password') || '';
    const expected = USERS.get(name);
    // сравниваем всегда, чтобы время ответа не выдавало существование логина
    const ok = safeEqual(pass, expected ?? '\0') && expected !== undefined;
    if (!ok) {
      attempts.get(ip).push(Date.now());
      res.writeHead(303, { Location: '/login?error=1' }).end();
      return;
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeToken(name))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      Location: '/',
    }).end();
    return;
  }

  if (url.pathname === '/logout') {
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/`, Location: '/login' }).end();
    return;
  }

  if (url.pathname === '/login') return serveStatic(res, 'login.html');
  if (url.pathname === '/health') { res.writeHead(200).end('ok'); return; }

  if (!user) {
    if (url.pathname === '/') { res.writeHead(303, { Location: '/login' }).end(); return; }
    res.writeHead(401).end('Unauthorized');
    return;
  }

  if (url.pathname === '/') return serveStatic(res, 'index.html');
  if (url.pathname === '/app.js') return serveStatic(res, 'app.js');
  if (url.pathname === '/style.css') return serveStatic(res, 'style.css');
  if (url.pathname === '/api/media') {
    ensureFile();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ user, files: listMedia() }));
    return;
  }
  if (url.pathname.startsWith('/video/')) {
    return serveVideo(req, res, decodeURIComponent(url.pathname.slice(7)));
  }
  res.writeHead(404).end('Not found');
});

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const user = readUser(req);
  if (!user || new URL(req.url, 'http://x').pathname !== '/ws') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit('connection', ws);
  });
});

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
function broadcast(msg, except) {
  for (const c of wss.clients) if (c !== except) send(c, msg);
}
const roster = () => [...new Set([...wss.clients].map((c) => c.user))];
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ensureFile();
  send(ws, { type: 'state', ...snapshot(), by: null, serverTime: Date.now() });
  broadcast({ type: 'presence', users: roster() });
  send(ws, { type: 'presence', users: roster() });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') { send(ws, { type: 'pong', t: m.t, serverTime: Date.now() }); return; }
    if (m.type === 'select' && listMedia().includes(m.file)) {
      Object.assign(room, { file: m.file, playing: false, position: 0, updatedAt: Date.now() });
    } else if (m.type === 'control') {
      const pos = num(m.position);
      if (pos === null || typeof m.playing !== 'boolean') return;
      Object.assign(room, { playing: m.playing, position: pos, updatedAt: Date.now() });
    } else {
      return;
    }
    const out = { type: 'state', ...snapshot(), by: ws.user, serverTime: Date.now() };
    for (const c of wss.clients) send(c, out);
  });

  ws.on('close', () => broadcast({ type: 'presence', users: roster() }));
});

// Периодически рассылаем эталонное состояние (коррекция дрейфа) и убираем «мёртвые» соединения.
setInterval(() => {
  for (const c of wss.clients) {
    if (!c.alive) { c.terminate(); continue; }
    c.alive = false;
    c.ping();
  }
  const out = { type: 'tick', ...snapshot(), serverTime: Date.now() };
  for (const c of wss.clients) send(c, out);
}, 4000);

server.listen(PORT, () => {
  console.log(`Кинотеатр запущен: http://localhost:${PORT}`);
  console.log(`Пользователи: ${[...USERS.keys()].join(', ')}`);
  console.log(`Фильмы (${MEDIA_DIR}): ${listMedia().join(', ') || 'пока нет — положите .mp4 в папку media'}`);
});
