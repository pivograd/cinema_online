'use strict';
// Совместный просмотр: HTTP (логин, статика, видео с Range) + WebSocket (синхронизация).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, 'media'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'cinema_session';
// вход запоминается на устройстве: вводить пароль каждый вечер — худший экран сервиса
const SESSION_TTL_MS = (Number(process.env.SESSION_DAYS) || 30) * 24 * 60 * 60 * 1000;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };
const SUB_TYPES = new Set(['.vtt', '.srt']);
const COUNTDOWN_MS = 3000; // общий отсчёт, когда фильм запускают с самого начала
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
// шрифты и картинки между релизами не меняются, их можно кешировать; html/css/js всегда берём свежими
const LONG_CACHE = new Set(['.woff2', '.png', '.svg']);

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

// Данные от клиента: битая строка не должна бросать исключение и ронять процесс.
const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return null; }
};
const pathnameOf = (req) => {
  try { return new URL(req.url, 'http://x').pathname; } catch { return null; }
};

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
  const value = safeDecode(cookie.slice(COOKIE.length + 1));
  if (!value) return null;
  const [u, exp, mac] = value.split('.');
  if (!u || !exp || !mac) return null;
  const payload = `${u}.${exp}`;
  if (!safeEqual(mac, sign(payload)) || Number(exp) < Date.now()) return null;
  const user = Buffer.from(u, 'base64url').toString();
  return USERS.has(user) ? user : null;
}

// --- защита от перебора пароля: 5 попыток за 5 минут с одного IP ---
// Попытка засчитывается до проверки пароля: иначе пачка параллельных запросов, придержавших тело формы,
// прошла бы проверку лимита разом. Удачный вход свою попытку возвращает.
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map();
const recentAttempts = (ip, now) => (attempts.get(ip) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
function takeAttempt(ip) {
  const now = Date.now();
  const list = recentAttempts(ip, now);
  attempts.set(ip, list);
  if (list.length >= 5) return null;
  list.push(now);
  return now;
}
function returnAttempt(ip, stamp) {
  const list = attempts.get(ip);
  const i = list ? list.indexOf(stamp) : -1;
  if (i !== -1) list.splice(i, 1);
  if (list && !list.length) attempts.delete(ip);
}
setInterval(() => {
  const now = Date.now();
  for (const ip of attempts.keys()) if (!recentAttempts(ip, now).length) attempts.delete(ip);
}, 60 * 1000).unref();
// X-Forwarded-For может прислать кто угодно, поэтому верим ему, только если явно сказано, сколько прокси стоит
// перед сервером (TRUST_PROXY). Каждый прокси дописывает адрес справа, так что клиент — N-й адрес с конца,
// а всё, что левее, мог подставить сам клиент.
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0;
function clientIp(req) {
  const chain = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  chain.push(req.socket.remoteAddress || '');
  return chain[Math.max(chain.length - 1 - TRUST_PROXY, 0)];
}

// --- состояние комнаты (единственной) ---
// updatedAt может быть в будущем: это общий отсчёт перед стартом, позиция до него стоит на месте.
// hold — кто догружается: пока он не догрузится, комната стоит на паузе («ждём друг друга»).
const room = { file: null, playing: false, position: 0, updatedAt: Date.now(), hold: null };
const currentPosition = () =>
  room.position + (room.playing ? Math.max(0, Date.now() - room.updatedAt) / 1000 : 0);
const snapshot = () => ({
  file: room.file,
  playing: room.playing,
  position: currentPosition(),
  startsIn: room.playing ? Math.max(0, room.updatedAt - Date.now()) : 0,
  hold: room.hold,
});

// Комната переживает перезапуск сервера (выкладка новой версии, перезагрузка): состояние лежит в STATE_FILE.
// После короткого перерыва фильм идёт дальше — плееры зрителей всё это время тоже играли; после долгого
// встаёт на паузу там, где был. Без STATE_FILE комната живёт только в памяти.
const STATE_FILE = process.env.STATE_FILE || '';
const RESUME_WITHIN_MS = 60 * 1000;
function saveRoom() {
  if (!STATE_FILE) return;
  const data = { file: room.file, playing: room.playing, position: currentPosition(), savedAt: Date.now() };
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (err) {
    console.warn(`Комната не сохранилась: ${err.message}`);
  }
}
function loadRoom() {
  if (!STATE_FILE) return;
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  if (!s || typeof s.file !== 'string' || !(s.position >= 0) || !Number.isFinite(s.savedAt)) return;
  const away = Date.now() - s.savedAt;
  const resume = s.playing === true && away >= 0 && away < RESUME_WITHIN_MS;
  Object.assign(room, {
    file: s.file, playing: resume, position: s.position + (resume ? away / 1000 : 0), updatedAt: Date.now(), hold: null,
  });
}

function readMediaDir() {
  try {
    return fs.readdirSync(MEDIA_DIR).sort();
  } catch {
    return [];
  }
}
const listMedia = () => readMediaDir().filter((f) => VIDEO_TYPES[path.extname(f).toLowerCase()]);

// субтитры лежат рядом с фильмом: film.mp4 → film.srt, film.ru.vtt, film.en.srt
const SUB_LANGS = { ru: 'Русские', en: 'Английские', uk: 'Украинские', de: 'Немецкие', fr: 'Французские', es: 'Испанские' };
function listSubs() {
  const all = readMediaDir();
  const subs = {};
  for (const video of listMedia()) {
    const stem = video.slice(0, -path.extname(video).length);
    subs[video] = all
      .filter((f) => SUB_TYPES.has(path.extname(f).toLowerCase()) && (f.startsWith(stem + '.')))
      .map((file) => {
        const tag = file.slice(stem.length + 1, -path.extname(file).length).toLowerCase();
        return { file, lang: tag || 'und', label: SUB_LANGS[tag] || tag || 'Субтитры' };
      });
  }
  return subs;
}
// браузер понимает только WebVTT; srt переводим на лету, а старые русские srt часто в windows-1251
function serveSubs(res, name) {
  const full = path.join(MEDIA_DIR, name);
  const ext = path.extname(name).toLowerCase();
  if (!SUB_TYPES.has(ext) || !full.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(full)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const raw = fs.readFileSync(full);
  let text = new TextDecoder('utf-8').decode(raw);
  if (text.includes('�')) text = new TextDecoder('windows-1251').decode(raw);
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (ext === '.srt') text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-cache' }).end(text);
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

// Страницы грузят скрипты, стили и медиа только со своего сервера, без инлайн-кода, и не встраиваются в чужие
// фреймы. WebSocket разрешаем явно на свой хост — старый Safari не считает ws/wss «своими» по 'self'.
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;
function pageHeaders(req) {
  const host = HOST_RE.test(req.headers.host || '') ? req.headers.host : null;
  const sockets = host ? ` wss://${host} ws://${host}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "media-src 'self'",
      `connect-src 'self'${sockets}`, "font-src 'self'", "manifest-src 'self'", "object-src 'none'",
      "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  };
}

function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = path.extname(full);
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': LONG_CACHE.has(ext) ? 'public, max-age=604800' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(ext === '.html' ? pageHeaders(req) : {}),
  });
  pipeline(fs.createReadStream(full), res, () => {});
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
  // Зритель перемотал или закрыл вкладку — браузер обрывает ответ. pipeline тогда закрывает и файл; с .pipe()
  // дескриптор оставался бы открытым, и удалённый или заменённый фильм занимал бы диск до перезапуска сервера.
  pipeline(fs.createReadStream(full, { start, end }), res, () => {});
}

async function handle(req, res) {
  const pathname = pathnameOf(req);
  if (pathname === null) { res.writeHead(400).end('Bad request'); return; }
  const user = readUser(req);

  if (req.method === 'POST' && pathname === '/login') {
    const ip = clientIp(req);
    const attempt = takeAttempt(ip);
    // форма входа сама объясняет, что случилось и сколько ждать
    if (attempt === null) { res.writeHead(303, { Location: '/login?error=limit' }).end(); return; }
    let form;
    try { form = new URLSearchParams(await readBody(req)); } catch { res.writeHead(400).end(); return; }
    const name = form.get('user') || '';
    const pass = form.get('password') || '';
    const expected = USERS.get(name);
    // сравниваем всегда, чтобы время ответа не выдавало существование логина
    const ok = safeEqual(pass, expected ?? '\0') && expected !== undefined;
    if (!ok) {
      res.writeHead(303, { Location: '/login?error=1' }).end();
      return;
    }
    returnAttempt(ip, attempt);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeToken(name))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      Location: '/',
    }).end();
    return;
  }

  if (pathname === '/logout') {
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/`, Location: '/login' }).end();
    return;
  }

  if (pathname === '/login') return serveStatic(req, res, 'login.html');
  if (pathname === '/health') { res.writeHead(200).end('ok'); return; }
  // стили, шрифты и скрипты нужны и странице входа, поэтому /assets открыт без логина (секретов там нет)
  if (pathname.startsWith('/assets/')) return serveStatic(req, res, pathname.slice(1));

  if (!user) {
    if (pathname === '/') { res.writeHead(303, { Location: '/login' }).end(); return; }
    res.writeHead(401).end('Unauthorized');
    return;
  }

  if (pathname === '/') return serveStatic(req, res, 'index.html');
  if (pathname === '/api/media') {
    ensureFile();
    // users — все зрители, а не только те, кто сейчас в сети: интерфейс показывает и тёмные «окна»
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ user, users: [...USERS.keys()], files: listMedia(), subs: listSubs() }));
    return;
  }
  if (pathname.startsWith('/video/') || pathname.startsWith('/subs/')) {
    const name = safeDecode(pathname.slice(pathname.indexOf('/', 1) + 1));
    if (name === null) { res.writeHead(400).end('Bad request'); return; }
    return pathname.startsWith('/video/') ? serveVideo(req, res, name) : serveSubs(res, name);
  }
  res.writeHead(404).end('Not found');
}

// Непредвиденная ошибка в обработчике — 500 для одного запроса, а не падение всего сервера.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) res.destroy();
    else res.writeHead(500).end();
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
// Cookie уходит и с соседних поддоменов (для браузера это «тот же сайт»), поэтому чужая страница могла бы
// подключиться к комнате от имени зрителя. Браузер всегда присылает Origin — пускаем только со своего хоста.
const originHost = (origin) => {
  try { return new URL(origin).host; } catch { return null; }
};
server.on('upgrade', (req, socket, head) => {
  const user = readUser(req);
  const origin = req.headers.origin;
  if (origin && originHost(origin) !== req.headers.host) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!user || pathnameOf(req) !== '/ws') {
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
const CAUSES = new Set(['user', 'system', 'ended']);
// у одного человека может быть несколько вкладок: «смотрит», если смотрит хоть в одной, и так же с догрузкой
function presence() {
  const status = {};
  for (const c of wss.clients) {
    const s = (status[c.user] ||= { joined: false, buffering: false });
    s.joined ||= !!c.joined;
    s.buffering ||= !!c.buffering;
  }
  return { type: 'presence', users: roster(), status };
}
const stillBuffering = (user) => [...wss.clients].some((c) => c.user === user && c.buffering);
function publish(by, cause) {
  const out = { type: 'state', ...snapshot(), by, cause, serverTime: Date.now() };
  for (const c of wss.clients) send(c, out);
  saveRoom();
}

// Когда все ушли, ставим комнату на паузу там, где ушёл последний, иначе фильм «досматривается» без зрителей.
// Пауза не сразу: короткий обрыв связи у единственного зрителя не должен останавливать ему фильм.
const EMPTY_ROOM_PAUSE_MS = 30 * 1000;
let emptyRoomTimer = null;
function pauseIfEmpty() {
  if (wss.clients.size > 0 || !room.playing) return;
  const position = currentPosition();
  clearTimeout(emptyRoomTimer);
  emptyRoomTimer = setTimeout(() => {
    Object.assign(room, { playing: false, position, updatedAt: Date.now() });
    saveRoom();
  }, EMPTY_ROOM_PAUSE_MS);
}

// «Ждём друг друга»: кто-то догружается во время просмотра — пауза у всех; догрузился — продолжаем с того же места.
function onBuffering(user) {
  if (stillBuffering(user)) {
    if (!room.playing || room.hold || room.updatedAt > Date.now()) return;
    Object.assign(room, { playing: false, position: currentPosition(), updatedAt: Date.now(), hold: user });
    publish(user, 'wait');
  } else if (room.hold === user) {
    Object.assign(room, { playing: true, updatedAt: Date.now(), hold: null });
    publish(user, 'resume');
  }
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  // битый кадр или превышение maxPayload: ws сам закроет соединение, без обработчика процесс бы упал
  ws.on('error', (err) => console.warn(`ws ${ws.user}: ${err.message}`));
  clearTimeout(emptyRoomTimer);
  ensureFile();
  send(ws, { type: 'state', ...snapshot(), by: null, serverTime: Date.now() });
  broadcast(presence());

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m) return;
    if (m.type === 'ping') { send(ws, { type: 'pong', t: m.t, serverTime: Date.now() }); return; }
    if (m.type === 'status') {
      ws.joined = !!m.joined;
      ws.buffering = !!m.buffering && ws.joined;
      onBuffering(ws.user);
      broadcast(presence());
      return;
    }
    if (m.type === 'select' && listMedia().includes(m.file)) {
      Object.assign(room, { file: m.file, playing: false, position: 0, updatedAt: Date.now(), hold: null });
      publish(ws.user, 'select');
    } else if (m.type === 'control') {
      const pos = num(m.position);
      if (pos === null || typeof m.playing !== 'boolean') return;
      // запуск с самого начала — с общим отсчётом, чтобы оба увидели первые секунды
      const countdown = m.playing && !room.playing && pos < 2;
      Object.assign(room, {
        playing: m.playing, position: pos, updatedAt: Date.now() + (countdown ? COUNTDOWN_MS : 0), hold: null,
      });
      // system — паузу поставил не человек (звонок, наушники), ended — фильм закончился
      publish(ws.user, CAUSES.has(m.cause) ? m.cause : 'user');
    }
  });

  ws.on('close', () => {
    if (room.hold === ws.user && !stillBuffering(ws.user)) room.hold = null; // ушёл, не догрузившись: остаёмся на паузе
    broadcast(presence());
    pauseIfEmpty();
  });
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
  if (room.playing) saveRoom(); // время сохранения — почти момент остановки сервера, если он упадёт
}, 4000);

loadRoom();
pauseIfEmpty(); // фильм шёл, а после перезапуска никто не вернулся — через 30 с пауза, как будто все ушли
// docker stop и перезапуск: сохраняем комнату и выходим сразу, зрители переподключатся сами
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveRoom(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Кинотеатр запущен: http://localhost:${PORT}`);
  console.log(`Пользователи: ${[...USERS.keys()].join(', ')}`);
  console.log(`Фильмы (${MEDIA_DIR}): ${listMedia().join(', ') || 'пока нет — положите .mp4 в папку media'}`);
});
