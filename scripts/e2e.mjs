// E2E: два браузера, логин, синхронный play/pause/seek. Запуск: npm test
// Переменные: TEST_VIDEO=/путь/к/видео (обязательна, не короче 40 с), CHROMIUM=путь к браузеру
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const media = mkdtempSync(join(tmpdir(), 'cinema-media-'));
if (!process.env.TEST_VIDEO) throw new Error('Укажите TEST_VIDEO=/путь/к/видео.webm');
copyFileSync(process.env.TEST_VIDEO, join(media, 'test.webm'));

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, MEDIA_DIR: media, USERS: 'anna:pw1;boris:pw2', SESSION_SECRET: 'test' },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
  if (!ok) failed++;
};

async function open(browser, user, pass) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + '/login');
  await page.fill('input[name=user]', user);
  await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForURL(BASE + '/');
  await page.waitForSelector('#joinBtn:not([disabled])', { timeout: 15000 });
  await page.click('#joinBtn');
  return page;
}
const state = (p) => p.evaluate(() => ({ t: document.getElementById('v').currentTime, paused: document.getElementById('v').paused }));

try {
  await sleep(800);

  // без логина — доступа нет
  check('видео без логина закрыто', (await fetch(BASE + '/video/test.webm')).status === 401);
  check('главная без логина → /login', (await fetch(BASE + '/', { redirect: 'manual' })).headers.get('location') === '/login');
  const broken = await fetch(BASE + '/', { headers: { cookie: 'cinema_session=%E0%A4%A' }, redirect: 'manual' });
  check('битая cookie не роняет сервер', broken.headers.get('location') === '/login' && (await fetch(BASE + '/health')).ok);
  const bad = await fetch(BASE + '/login', { method: 'POST', body: 'user=anna&password=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  check('неверный пароль отклонён', bad.headers.get('location') === '/login?error=1');

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const a = await open(browser, 'anna', 'pw1');
  const b = await open(browser, 'boris', 'pw2');
  await sleep(1000);

  // range-запрос
  const cookie = (await a.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await fetch(BASE + '/video/test.webm', { headers: { cookie, range: 'bytes=0-99' } });
  check('Range отдаёт 206', r.status === 206 && r.headers.get('content-range')?.startsWith('bytes 0-99/'));
  check('presence виден', (await a.textContent('#who')).includes('boris'), await a.textContent('#who'));

  // A жмёт play → у B тоже играет (старт с самого начала идёт через общий отсчёт 3 с)
  await a.evaluate(() => document.getElementById('v').play());
  await sleep(4500);
  let sa = await state(a), sb = await state(b);
  check('play синхронизирован', !sa.paused && !sb.paused, JSON.stringify({ sa, sb }));
  check('позиции близки (<1с)', Math.abs(sa.t - sb.t) < 1, `Δ=${(sa.t - sb.t).toFixed(2)}`);

  // B перематывает → у A тоже
  await b.evaluate(() => { document.getElementById('v').currentTime = 20; });
  await sleep(2500);
  sa = await state(a); sb = await state(b);
  check('seek синхронизирован', sa.t > 20 && sa.t < 26 && Math.abs(sa.t - sb.t) < 1, `a=${sa.t.toFixed(1)} b=${sb.t.toFixed(1)}`);
  check('после seek продолжают играть', !sa.paused && !sb.paused);

  // B ставит паузу → A тоже
  await b.evaluate(() => document.getElementById('v').pause());
  await sleep(1500);
  sa = await state(a); sb = await state(b);
  check('pause синхронизирован', sa.paused && sb.paused);
  check('позиции на паузе совпадают', Math.abs(sa.t - sb.t) < 0.5, `Δ=${(sa.t - sb.t).toFixed(2)}`);

  // A возобновляет
  await a.evaluate(() => document.getElementById('v').play());
  await sleep(2000);
  sa = await state(a); sb = await state(b);
  check('resume синхронизирован', !sa.paused && !sb.paused && Math.abs(sa.t - sb.t) < 1);

  // нет ли «пинг-понга»: сутки событий не должны раскачивать состояние
  await sleep(6000);
  sa = await state(a); sb = await state(b);
  check('стабильно через 6с', !sa.paused && !sb.paused && Math.abs(sa.t - sb.t) < 1, `Δ=${(sa.t - sb.t).toFixed(2)}`);

  // поздний участник догоняет
  await b.close();
  const b2 = await open(browser, 'boris', 'pw2');
  await sleep(2500);
  sa = await state(a); const sb2 = await state(b2);
  check('переподключившийся догоняет', !sb2.paused && Math.abs(sa.t - sb2.t) < 1.5, `Δ=${(sa.t - sb2.t).toFixed(2)}`);

  await browser.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
