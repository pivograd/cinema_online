'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const video = $('v');
  const stage = $('stage');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const portrait = matchMedia('(orientation: portrait)');
  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const canElementFullscreen = !!(stage.requestFullscreen || stage.webkitRequestFullscreen);

  let ws = null;
  let me = null;
  let everyone = [];
  let subsByFile = {};
  let joined = false;
  let blocked = false; // браузер не дал играть без нового касания
  let last = null; // последнее эталонное состояние с сервера + когда получено
  let ignoreEventsUntil = 0; // события плеера, вызванные нами самими, не отправляем
  let ignoreTicksUntil = 0; // после своего действия не даём тику «откатить» нас
  let intentUntil = 0; // окно, в котором пауза считается нажатой человеком, а не системой
  let selfSeek = false; // перемотку сделала синхронизация, а не человек
  let retry = 0;
  let connected = false;
  let online = new Set();
  let status = {};
  let presenceSeen = false;
  let videoReady = false;
  let videoError = false;
  let videoRetries = 0, retryTimer = 0;
  let sky = null;
  let joinedAt = 0;

  const now = () => performance.now();
  // огонёк — знак присутствия: тёплый, когда человек в сети, пустое серебряное кольцо, когда нет
  const LAMP = '<span class="lamp" aria-hidden="true"></span>';
  const others = () => everyone.filter((u) => u !== me);
  // как зовут человека на экране: логин остаётся логином для сравнений, показываем имя
  const NAMES = { egor: 'Егор', alina: 'Алина' };
  const nameOf = (u) => (u ? NAMES[String(u).toLowerCase()] || u : '');
  // звёзды Пояса закреплены за людьми по общему списку зрителей: у обоих на экранах одна и та же картина
  const skyOrder = () => (everyone.includes(me) ? everyone : [me, ...others()]).filter(Boolean);
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  // имя файла → название: «The.Matrix.1999.1080p.BluRay.x264.mkv» → «The Matrix (1999)»
  const RELEASE_TAG = /^(\d{3,4}p|[48]k|uhd|hdr\d*|dv|sdr|blu-?ray|bd(rip|remux)?|br(rip)?|remux|web(-?dl|rip)?|hdtv|hdrip|dvd(rip|5|9)?|x26[45]|h\.?26[45]|hevc|avc|aac\d*|ac3|e?ac-?3|dts(-hd)?|ddp?\d*|truehd|atmos|10bit|8bit|rus|eng|ukr|sub|subs|dub|mvo|avo|proper|repack|extended|unrated|imax|internal|limited)$/i;
  function title(file) {
    const words = (file || '').replace(/\.[^.]+$/, '').split(/[\s._]+/).filter(Boolean);
    const keep = [];
    let year = '';
    for (const w of words) {
      const bare = w.replace(/[()[\]]/g, '');
      if (/^(19|20)\d{2}$/.test(bare) && keep.length) { year = bare; break; }
      if (/^\[.*\]$/.test(w) && !keep.length) continue; // «[Группа] Фильм» — метка релиза впереди
      if (RELEASE_TAG.test(bare) || /^\[.*\]$/.test(w)) break;
      keep.push(w);
    }
    const name = (keep.length ? keep : words).join(' ').replace(/[\s-]+$/, '');
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    return year ? `${cap} (${year})` : cap;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };

  // --- где сейчас комната по часам сервера ---
  // Считаем от serverTime сообщения, а не от момента, когда оно дошло: в загруженной сети (рядом качается фильм)
  // тик идёт и полсекунды, и секунду, и эта задержка читалась бы как рассинхрон — с лишней перемоткой.
  // Смещение часов меряем ping/pong и берём замер с самым коротким путём туда-обратно: в нём меньше всего очередей.
  let clock = null;
  const clockSamples = [];
  function onPong(m) {
    const rtt = now() - m.t;
    if (!(rtt >= 0) || !Number.isFinite(m.serverTime)) return;
    clockSamples.push({ offset: m.serverTime + rtt / 2 - now(), rtt });
    if (clockSamples.length > 8) clockSamples.shift();
    clock = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }
  // сколько прошло по часам сервера с момента, который описывает last; пока часы не сверены — по приходу
  const sinceLast = () => (clock && Number.isFinite(last.serverTime) ? now() + clock.offset - last.serverTime : now() - last.receivedAt);
  const startsInNow = () => (last && last.playing ? Math.max(0, last.startsIn - sinceLast()) : 0);
  function roomPosition() {
    if (!last) return 0;
    if (!last.playing) return last.position;
    return last.position + Math.max(0, sinceLast() - last.startsIn) / 1000;
  }

  // --- общие события: одинаковая карточка у обоих ---
  let toastTimer = 0;
  function toast(text) {
    const el = $('status');
    if (!text) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
  }
  const notices = new Map(); // ключ -> текст; показываем самое важное
  const NOTICE_ORDER = ['conn', 'blocked', 'wait', 'buffer'];
  function notice(key, text) {
    if (text) notices.set(key, text); else notices.delete(key);
    const top = NOTICE_ORDER.find((k) => notices.has(k));
    const el = $('notice');
    el.hidden = !top;
    if (top) el.textContent = notices.get(top);
  }

  function describe(m, prev, expected) {
    if (!m.by || !prev) return;
    const who = m.by === me ? 'Вы' : nameOf(m.by);
    if (m.cause === 'select') { toast(`${who}: новый фильм, «${title(m.file)}»`); return; }
    if (m.cause === 'ended') { toast('Фильм закончился'); return; }
    if (m.cause === 'wait') return; // это постоянная плашка, её ставит renderWait
    if (m.cause === 'resume') { toast('Догрузилось, продолжаем'); return; }
    if (m.playing !== prev.playing) {
      if (!m.playing) toast(m.cause === 'system' ? `${who}: плеер встал на паузу` : `${who}: пауза`);
      else if (!m.startsIn) toast(`${who}: продолжаем`);
      return;
    }
    if (Math.abs(m.position - expected) > 2) toast(`${who}: перемотка на ${fmt(m.position)}`);
  }
  function renderWait() {
    if (!last || last.playing || !last.hold) { notice('wait', null); return; }
    if (last.hold === me) notice('wait', `Догружаем фильм у вас. ${others().map(nameOf).join(', ') || 'Второй зритель'} ждёт.`);
    else notice('wait', `${nameOf(last.hold)}: догружается, ждём. Нажмите «Продолжить», чтобы не ждать.`);
  }

  // --- источник видео ---
  // Есть нарезка HLS — берём её: качество подстраивается под скорость сети, перемотка грузит только нужные секунды.
  // Safari и любой браузер на iPhone играют HLS сами; остальным нужен hls.js, его грузим, только когда понадобится.
  // Нет нарезки или HLS не завёлся — обычный mp4.
  let hlsByFile = {};
  const hlsFailed = new Set();
  const appleHls = (isIOS || /^((?!chrome|chromium|android|crios|fxios|edg|opr).)*safari/i.test(navigator.userAgent))
    && !!video.canPlayType('application/vnd.apple.mpegurl');
  let source = null; // { file, mode: 'native' | 'hlsjs' | 'mp4' }
  let hls = null;
  let hlsLib = null;
  const mediaUrl = (p) => '/video/' + p.split('/').map(encodeURIComponent).join('/');
  function sourceMode(file) {
    if (!hlsByFile[file] || hlsFailed.has(file)) return 'mp4';
    if (appleHls) return 'native';
    return window.MediaSource || window.ManagedMediaSource ? 'hlsjs' : 'mp4';
  }
  function loadHlsLib() {
    hlsLib ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/assets/hls.js';
      s.onload = () => (window.Hls && window.Hls.isSupported() ? resolve(window.Hls) : reject(new Error('hls.js не поддерживается')));
      s.onerror = () => { hlsLib = null; reject(new Error('hls.js не загрузился')); };
      document.head.append(s);
    });
    return hlsLib;
  }
  // HLS не завёлся: дальше этот фильм идёт обычным mp4
  function fallBackToMp4(file) {
    hlsFailed.add(file);
    source = null;
    ensureSource(file);
    apply({ hard: true });
  }
  function attachHls(Hls, current) {
    if (source !== current) return; // пока грузился hls.js, выбрали другой фильм
    hls = new Hls({
      enableWorker: false, // без blob-воркеров, которые запретила бы CSP; fMP4 почти не нужно перепаковывать
      startPosition: joined ? roomPosition() : -1,
      backBufferLength: 90,
    });
    let mediaRecoveries = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (joined) apply({ hard: true }); });
    // У hls.js свои повторы при обрывах; сюда доходит только то, что он не вытянул сам
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || source !== current) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && videoRetries < 5) {
        videoRetries++;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (source === current && hls) hls.startLoad(); }, 1000 * videoRetries);
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
        hls.recoverMediaError();
      } else {
        fallBackToMp4(current.file);
      }
    });
    hls.loadSource(mediaUrl(hlsByFile[current.file]));
    hls.attachMedia(video);
  }
  function ensureSource(file) {
    const mode = sourceMode(file);
    if (source && source.file === file && source.mode === mode) return;
    videoReady = false;
    videoError = false;
    videoRetries = 0;
    clearTimeout(retryTimer);
    ignoreEventsUntil = now() + 800;
    if (hls) { hls.destroy(); hls = null; }
    const current = source = { file, mode };
    if (mode === 'hlsjs') {
      video.removeAttribute('src');
      video.load(); // прервать загрузку прежнего файла
      loadHlsLib().then((Hls) => attachHls(Hls, current), () => { if (source === current) fallBackToMp4(file); });
    } else {
      video.src = mediaUrl(mode === 'native' ? hlsByFile[file] : file);
      video.load();
    }
    setupTracks(file);
    for (const sel of [$('files'), $('filesP')]) sel.value = file;
    $('pTitle').textContent = title(file);
    $('preTitle').textContent = title(file);
    updateMediaMetadata(file);
    renderLobby();
  }

  function apply({ hard = false } = {}) {
    if (!last || !last.file) return;
    ensureSource(last.file);
    if (!joined || blocked) return;

    // Видео догружается: перемотка сейчас выбросила бы то, что уже скачано, и догрузка началась бы заново
    // (на телефоне это заметнее всего). Плановые тики ждут; если догрузка затянется, сервер поставит зал на паузу
    // («ждём друг друга»), а выровняемся, когда данные будут.
    if (!hard && last.playing && !video.paused && video.readyState < 3) return;

    const wait = startsInNow() > 50 ? startsInNow() : 0; // хвост отсчёта короче кадра — уже старт
    const target = roomPosition();
    const drift = video.currentTime - target;
    const abs = Math.abs(drift);
    let changed = false;
    if (abs > 2 || (hard && abs > 0.3)) {
      selfSeek = true;
      video.currentTime = target;
      video.playbackRate = 1;
      changed = true;
    } else if (last.playing && !wait && abs > 0.15) {
      // дрейф до 2 с гасим скоростью, а не перемоткой: каждая перемотка — новая догрузка
      const k = abs > 0.6 ? 0.1 : 0.05;
      video.playbackRate = drift > 0 ? 1 - k : 1 + k;
    } else {
      video.playbackRate = 1;
    }

    const shouldPlay = last.playing && !wait;
    if (wait) countdown(wait); else countdown(0);
    if (shouldPlay && video.paused) {
      changed = true;
      video.play().catch(onBlocked);
    } else if (!shouldPlay && !video.paused) {
      changed = true;
      video.pause();
    }
    if (changed) ignoreEventsUntil = now() + 600;
    renderControls();
  }

  // --- общий отсчёт перед стартом с начала ---
  let countAt = 0, countTimer = 0;
  function countdown(ms) {
    const el = $('countdown');
    if (!ms) {
      if (countAt) { clearTimeout(countTimer); countAt = 0; el.hidden = true; }
      return;
    }
    const at = now() + ms;
    if (countAt && Math.abs(at - countAt) < 250) return;
    clearTimeout(countTimer);
    countAt = at;
    el.hidden = false;
    const step = () => {
      const left = countAt - now();
      if (left <= 50) { countAt = 0; el.hidden = true; delete el.dataset.shown; apply({ hard: true }); return; }
      const n = String(Math.ceil(left / 1000));
      const num = $('countNum');
      if (num.textContent !== n || !el.dataset.shown) {
        num.textContent = n;
        el.dataset.shown = '1';
        if (!reduceMotion.matches) num.animate([{ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
      }
      countTimer = setTimeout(step, (left % 1000) + 10);
    };
    step();
  }
  const counting = () => countAt > 0;

  // --- локальные действия -> сервер ---
  function sendControl(playing, position, cause = 'user') {
    if (!ws || ws.readyState !== 1 || !joined) return;
    ignoreTicksUntil = now() + 2000;
    ws.send(JSON.stringify({ type: 'control', playing, position, cause }));
  }
  function sendStatus() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', joined, buffering }));
  }
  // паузу поставил человек (наши кнопки, клавиши, системный плеер) или система (звонок, наушники)
  const causeNow = () => (now() < intentUntil || video.webkitDisplayingFullscreen || document.pictureInPictureElement ? 'user' : 'system');

  video.addEventListener('play', () => {
    if (now() < ignoreEventsUntil || !joined) return;
    sendControl(true, video.currentTime, causeNow());
  });
  video.addEventListener('pause', () => {
    if (now() < ignoreEventsUntil || !joined || video.ended) return;
    sendControl(false, video.currentTime, causeNow());
  });
  video.addEventListener('seeked', () => {
    if (selfSeek) { selfSeek = false; return; }
    if (now() < ignoreEventsUntil || !joined) return;
    // Сдвиг меньше секунды от позиции зала — не перемотка человека, а сам плеер (hls.js перешагивает дырку
    // между кусками, Safari выравнивается на ключевой кадр). Рассылать такое второму зрителю незачем.
    if (Math.abs(video.currentTime - roomPosition()) < 1) return;
    // во время общего отсчёта видео ещё стоит, но фильм уже запущен: перемотка не должна его отменять
    sendControl(!video.paused || counting(), video.currentTime, causeNow());
  });
  video.addEventListener('ended', () => { if (joined) sendControl(false, video.duration, 'ended'); });

  function userPlay() {
    intentUntil = now() + 1000;
    if (blocked) { unblock(); return; }
    // старт с начала идёт через общий отсчёт: играем по команде сервера, а не сразу
    if (last && !last.playing && video.currentTime < 2) { sendControl(true, video.currentTime, 'user'); return; }
    video.play().catch(onBlocked);
  }
  function userPause() {
    intentUntil = now() + 1000;
    if (counting()) { sendControl(false, video.currentTime, 'user'); return; }
    video.pause();
  }
  const userToggle = () => (video.paused && !counting() ? userPlay() : userPause());
  function userSeek(t) {
    intentUntil = now() + 1000;
    selfSeek = false;
    video.currentTime = Math.min(Math.max(0, t), (video.duration || t) - 0.25);
  }
  const userSkip = (d) => userSeek(video.currentTime + d);

  // --- догрузка: «ждём друг друга» ---
  let buffering = false, stallTimer = 0, stallPoll = 0, bufferingSince = 0;
  // сколько секунд фильма уже скачано вперёд от текущей позиции
  function bufferedAhead() {
    const t = video.currentTime, b = video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) > t) return b.end(i) - t;
    return 0;
  }
  // Догрузка закончилась, когда впереди есть хотя бы 8 с фильма (или он докачан до конца). Если продолжать, как
  // только пришли первые кадры, медленная сеть даёт цикл «на миг включилось — снова ждём». Телефон на паузе иногда
  // перестаёт качать, поэтому через 12 с ожидания продолжаем с тем, что есть.
  const RESUME_AHEAD_S = 8;
  function readyToResume() {
    if (video.readyState < 3) return false;
    const ahead = bufferedAhead();
    return ahead >= RESUME_AHEAD_S || video.currentTime + ahead >= (video.duration || Infinity) - 0.5
      || now() - bufferingSince > 12000;
  }
  function setBuffering(on) {
    if (buffering === on) return;
    buffering = on;
    if (on) bufferingSince = now();
    sendStatus();
    clearInterval(stallPoll);
    if (on) stallPoll = setInterval(() => { if (readyToResume()) setBuffering(false); }, 400);
    notice('buffer', on && !(last && last.hold) ? 'Догружаем фильм…' : null);
  }
  video.addEventListener('waiting', () => {
    if (!joined) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (joined && video.readyState < 3 && last && (last.playing || last.hold === me)) setBuffering(true);
    }, 1500);
  });
  for (const ev of ['playing', 'canplay']) video.addEventListener(ev, () => { clearTimeout(stallTimer); if (readyToResume()) setBuffering(false); });

  // --- браузер заблокировал воспроизведение ---
  function onBlocked(err) {
    // AbortError — play() перебили pause() или перезагрузкой файла; это не запрет браузера
    if (!joined || (err && err.name === 'AbortError')) return;
    blocked = true;
    notice('blocked', 'Браузер остановил фильм. Нажмите «Продолжить», чтобы догнать.');
    renderControls();
  }
  function unblock() {
    blocked = false;
    notice('blocked', null);
    ignoreEventsUntil = now() + 1500;
    video.play().then(() => apply({ hard: true })).catch(onBlocked);
    apply({ hard: true });
  }

  // --- WebSocket ---
  let pingTimer = 0;
  const ping = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: now() })); };
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      retry = 0;
      connected = true;
      notice('conn', null);
      sendStatus();
      renderAll();
      // сверка часов: три быстрых замера сразу, дальше раз в 10 с
      ping();
      setTimeout(ping, 400);
      setTimeout(ping, 1200);
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 10000);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      connected = false;
      if (joined) notice('conn', 'Нет связи. Переподключаемся…');
      renderAll();
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'pong') onPong(m);
      else if (m.type === 'presence') onPresence(m);
      else if (m.type === 'state') {
        const expected = roomPosition();
        const prev = last;
        last = { ...m, receivedAt: now() };
        if (joined) describe(m, prev, expected);
        ignoreTicksUntil = 0;
        apply({ hard: true });
        renderWait();
        renderLobby();
      } else if (m.type === 'tick') {
        last = { ...m, by: last && last.by, receivedAt: now() };
        if (now() >= ignoreTicksUntil && !video.seeking) apply();
        renderWait();
        renderLobby();
      }
    };
  }

  function onPresence(m) {
    const before = online;
    online = new Set(m.users);
    status = m.status || {};
    if (presenceSeen && joined) {
      for (const u of others()) {
        if (online.has(u) && !before.has(u)) toast(`${nameOf(u)}: в сети`);
        else if (!online.has(u) && before.has(u)) toast(`${nameOf(u)}: не в сети`);
      }
    }
    presenceSeen = true;
    renderAll();
  }

  // --- отрисовка ---
  function renderAll() {
    renderPresence();
    renderLobby();
    renderTab();
  }

  function renderPresence() {
    const list = $('who');
    list.textContent = '';
    for (const u of [me, ...others()].filter(Boolean)) {
      const on = u === me ? connected : online.has(u);
      const li = document.createElement('li');
      li.className = on ? 'on' : 'off';
      li.innerHTML = LAMP;
      const s = status[u] || {};
      let text = u === me ? `${nameOf(u)} (вы)` : nameOf(u);
      if (u !== me && !on) text += ', не в сети';
      else if (u !== me && s.buffering) text += ', догружается';
      li.append(text);
      list.append(li);
    }
    if (sky) {
      sky.setPeople(skyOrder().map((u) => ({
        id: u,
        me: u === me,
        lit: u === me ? connected : online.has(u),
        watching: u !== me && online.has(u) && !!(status[u] && status[u].joined) && !!(last && last.playing),
      })));
      placeLabels();
    }
  }

  // подписи у звёзд, как в звёздном атласе: имя и звезда; от звезды к подписи — тонкая выноска
  const STARS = [['Минтака', 'δ'], ['Альнитак', 'ζ'], ['Бетельгейзе', 'α'], ['Ригель', 'β'], ['Беллатрикс', 'γ'], ['Саиф', 'κ']];
  const marks = new Map(); // человек -> его подпись и выноска
  function mark(u) {
    let m = marks.get(u);
    if (m) return m;
    const el = document.createElement('div');
    el.className = 'mark';
    const nm = document.createElement('span');
    nm.className = 'nm';
    el.append(nm);
    const line = document.createElement('div');
    line.className = 'lead';
    $('labels').append(line, el);
    m = { el, nm, line, text: '' };
    marks.set(u, m);
    // проявляются, когда уже стоят на месте
    requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.add('shown'); line.classList.add('shown'); }));
    return m;
  }
  function placeLabels() {
    if (!sky) return;
    const people = skyOrder();
    for (const [u, m] of marks) if (!people.includes(u)) { m.el.remove(); m.line.remove(); marks.delete(u); }
    const f = sky.film();
    const vw = innerWidth, vh = innerHeight, pad = 14;
    const tall = vh > vw;
    people.forEach((u, i) => {
      const m = mark(u);
      const on = u === me ? connected : online.has(u);
      m.el.classList.toggle('off', !on);
      m.line.classList.toggle('off', !on);
      // у звезды только имя: кто здесь, видно по её свету
      if (m.text !== u) { m.text = u; m.nm.textContent = nameOf(u); }
      const p = sky.point(u);
      m.el.hidden = m.line.hidden = !p || !STARS[i];
      if (m.el.hidden) return;
      const w = m.el.offsetWidth, h = m.el.offsetHeight;
      const r = p.r || 2;
      let x, y, right = false, line = null;
      if (i < 2 && f) {
        const dx = p.x - f.x, dy = p.y - f.y, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        if (tall) {
          // телефон стоя: выноска вертикально, подпись над верхней звездой и под нижней, текстом к середине
          const sy = uy < 0 ? -1 : 1;
          right = ux > 0;
          line = [p.x, p.y + sy * (r + 12), p.x, p.y + sy * (r + 39)];
          x = right ? p.x + 3 - w : p.x - 3;
          y = sy < 0 ? p.y - r - 45 - h : p.y + r + 45;
        } else {
          // по линии Пояса наружу, от средней звезды
          right = ux < 0;
          line = [p.x + ux * (r + 14), p.y + uy * (r + 14), p.x + ux * (r + 46), p.y + uy * (r + 46)];
          x = p.x + ux * (r + 54) - (right ? w : 0);
          y = p.y + uy * (r + 54) - h / 2 + (uy < 0 ? -4 : 4);
        }
      } else {
        x = p.x + r + 12;
        y = p.y - h / 2;
      }
      x = Math.min(Math.max(pad, x), vw - w - pad);
      y = Math.min(Math.max(pad, y), vh - h - pad);
      // подпись налезла на «Выйти» (низкий экран лёжа): ставим её сбоку от звезды, к середине экрана
      const out = document.querySelector('.out');
      const o = out && out.offsetParent ? out.getBoundingClientRect() : null;
      if (o && x < o.right + 8 && x + w > o.left - 8 && y < o.bottom + 4 && y + h > o.top - 4) {
        const side = p.x > vw / 2 ? -1 : 1;
        right = side < 0;
        line = [p.x + side * (r + 10), p.y, p.x + side * (r + 30), p.y];
        x = Math.min(Math.max(pad, side < 0 ? p.x - r - 36 - w : p.x + r + 36), vw - w - pad);
        y = Math.min(Math.max(pad, p.y - h / 2), vh - h - pad);
      }
      // подпись легла на текст лобби (низкий экран лёжа): переносим её на сторону звезды, свободную от текста
      const lob = !joined ? $('join').getBoundingClientRect() : null;
      const hits = (bx, by) => lob && lob.width && bx < lob.right + 8 && bx + w > lob.left - 8 && by < lob.bottom + 4 && by + h > lob.top - 4;
      if (hits(x, y)) {
        right = false;
        line = [p.x + r + 10, p.y, p.x + r + 30, p.y];
        x = Math.min(Math.max(pad, p.x + r + 36), vw - w - pad);
        y = Math.min(Math.max(pad, p.y - h / 2), vh - h - pad);
        if (hits(x, y)) { line = null; x = Math.min(Math.max(pad, p.x - w / 2), vw - w - pad); y = Math.max(pad, p.y - r - 14 - h); }
      }
      m.el.classList.toggle('right', right);
      m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      m.line.hidden = !line;
      if (line) {
        const [x1, y1, x2, y2] = line;
        m.line.style.width = `${Math.hypot(x2 - x1, y2 - y1).toFixed(1)}px`;
        m.line.style.transform = `translate(${x1.toFixed(1)}px, ${y1.toFixed(1)}px) rotate(${Math.atan2(y2 - y1, x2 - x1).toFixed(4)}rad)`;
      }
    });
  }

  // название с годом: «I Swear (2025)» — год мельче и тише
  function setTitle(el, text) {
    const yr = / \((\d{4})\)$/.exec(text);
    el.textContent = yr ? text.slice(0, yr.index) + ' ' : text;
    if (!yr) return;
    const s = document.createElement('span');
    s.className = 'yr';
    s.textContent = `(${yr[1]})`;
    el.append(s);
  }

  function renderLobby() {
    if (joined) return;
    const btn = $('joinBtn');
    const state = $('joinHint');
    if (!last) return;
    if (!last.file) {
      $('filmTitle').textContent = 'Фильма пока нет';
      state.textContent = 'Положите mp4 в папку media на сервере и обновите страницу.';
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    setTitle($('filmTitle'), title(last.file));
    setTitle($('preTitle'), title(last.file));
    btn.disabled = !videoReady || videoError;
    const pos = roomPosition();
    // на карточке только время, с которого начнётся просмотр; пока фильм идёт, оно тикает
    if (videoError) state.textContent = 'Этот файл не открывается в браузере. Попросите того, кто ставит фильмы, перекодировать его в mp4 (H.264 и AAC).';
    else if (pos < 2 || (last.playing && startsInNow())) state.textContent = 'с начала';
    else state.textContent = `с ${fmt(pos)}`;
    if (sky) placeLabels(); // высота карточки могла измениться — подписи у звёзд обходят её заново
  }
  setInterval(() => { if (!joined && last && last.playing) renderLobby(); }, 1000);

  function renderTab() {
    const here = others().filter((u) => online.has(u));
    document.title = here.length ? `${here.map(nameOf).join(', ')} здесь · Смотрильня` : 'Смотрильня';
    $('favicon').href = here.length ? '/assets/icon-lit.svg' : '/assets/icon.svg';
  }

  // --- контролы ---
  const seek = $('seek');
  let scrubbing = false;
  function setIcon(btn, id, label) {
    btn.querySelector('use').setAttribute('href', '#' + id);
    btn.setAttribute('aria-label', label);
  }
  function renderControls() {
    const paused = video.paused && !counting();
    setIcon($('playBtn'), paused ? 'i-play' : 'i-pause', paused ? 'Играть' : 'Пауза');
    $('playBtn').title = paused ? 'Играть у обоих (пробел)' : 'Пауза у обоих (пробел)';
    // до первого старта вместо чёрного кадра — туман зала, название и «Начать у обоих»
    // «ещё не начинали» — только у самого нуля: пауза на 0:01 показывает кадр и «Продолжить», а не стартовый экран
    const fresh = joined && !blocked && !!last && last.position < 0.3 && video.currentTime < 0.3 && (!last.playing || counting());
    const before = fresh && !counting();
    body.classList.toggle('prestart', fresh);
    $('prestart').hidden = !before;
    $('bigPlay').hidden = !joined || !(paused || blocked) || counting() || before;
    setIcon($('muteBtn'), video.muted ? 'i-mute' : 'i-sound', video.muted ? 'Включить звук' : 'Выключить звук');
    const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
    setIcon($('fsBtn'), full ? 'i-unfull' : 'i-full', full ? 'Выйти из полноэкранного режима' : 'Во весь экран');
    if (!canElementFullscreen && video.webkitEnterFullscreen) $('fsBtn').title = 'Системный плеер: в нём не видно, кто в зале и кто нажал паузу';
    $('rotateBtn').hidden = !coarse.matches || !(portrait.matches || body.classList.contains('rotated'));
    $('vol').style.setProperty('--v', `${(video.muted ? 0 : video.volume) * 100}%`);
    if (paused) showChrome();
  }
  function renderTime() {
    const d = video.duration || 0;
    const t = scrubbing ? (seek.value / 1000) * d : video.currentTime;
    $('cur').textContent = fmt(t);
    $('dur').textContent = fmt(d);
    $('played').style.transform = `scaleX(${d ? t / d : 0})`;
    if (!scrubbing) seek.value = d ? Math.round((t / d) * 1000) : 0;
    seek.setAttribute('aria-valuetext', `${fmt(t)} из ${fmt(d)}`);
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t + 0.5) end = Math.max(end, video.buffered.end(i));
    }
    $('buffered').style.transform = `scaleX(${d ? end / d : 0})`;
  }
  let raf = 0;
  function tick() {
    raf = 0;
    renderTime();
    if (!video.paused && !stage.classList.contains('idle') && !document.hidden) raf = requestAnimationFrame(tick);
  }
  const kickTime = () => { if (!raf) raf = requestAnimationFrame(tick); };
  for (const ev of ['timeupdate', 'durationchange', 'progress', 'seeked', 'loadedmetadata']) video.addEventListener(ev, kickTime);
  for (const ev of ['play', 'pause', 'volumechange']) video.addEventListener(ev, () => { renderControls(); kickTime(); });

  // перетаскивание: показываем время локально, а перемотку отправляем только при отпускании
  const tl = $('timeline');
  seek.addEventListener('input', () => {
    scrubbing = true;
    tl.classList.add('scrub');
    placeTip((seek.value / 1000) * (video.duration || 0), seek.value / 1000);
    renderTime();
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    tl.classList.remove('scrub');
    userSeek((seek.value / 1000) * (video.duration || 0));
  });
  tl.addEventListener('pointermove', (e) => {
    if (scrubbing) return;
    const r = tl.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    placeTip(k * (video.duration || 0), k);
  });
  function placeTip(t, k) {
    const tip = $('tip');
    tip.textContent = fmt(t);
    tip.style.left = `${k * 100}%`;
  }

  $('playBtn').addEventListener('click', userToggle);
  $('bigPlay').addEventListener('click', userToggle);
  $('startBtn').addEventListener('click', userPlay);
  $('backBtn').addEventListener('click', () => userSkip(-10));
  $('fwdBtn').addEventListener('click', () => userSkip(10));
  $('muteBtn').addEventListener('click', toggleMute);
  $('vol').addEventListener('input', (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    store.set('volume', String(video.volume));
  });
  const savedVolume = Number(store.get('volume'));
  if (store.get('volume') !== null && Number.isFinite(savedVolume)) { video.volume = savedVolume; $('vol').value = savedVolume; }
  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
  }
  $('fsBtn').addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req) {
      const p = req.call(stage);
      if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
    } else if (video.webkitEnterFullscreen) {
      intentUntil = now() + 1000;
      video.webkitEnterFullscreen(); // iPhone: только системный плеер
    }
  }
  document.addEventListener('fullscreenchange', renderControls);
  document.addEventListener('webkitfullscreenchange', renderControls);
  $('rotateBtn').addEventListener('click', () => {
    const on = body.classList.toggle('rotated');
    $('rotateBtn').setAttribute('aria-pressed', String(on));
    renderControls();
  });
  portrait.addEventListener('change', () => {
    if (!portrait.matches) { body.classList.remove('rotated'); $('rotateBtn').setAttribute('aria-pressed', 'false'); }
    renderControls();
  });

  // --- субтитры: выбор у каждого свой ---
  let subIndex = -1;
  function setupTracks(file) {
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    const subs = subsByFile[file] || [];
    for (const s of subs) {
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = s.label;
      tr.srclang = s.lang;
      tr.src = '/subs/' + encodeURIComponent(s.file);
      video.append(tr);
    }
    $('ccBtn').hidden = !subs.length;
    const raw = store.get('subs:' + file); // по умолчанию субтитры выключены
    const saved = raw === null ? -1 : Number(raw);
    subIndex = Number.isInteger(saved) && saved < subs.length ? saved : -1;
    setTimeout(applySubs, 0);
  }
  // субтитры рисуем сами: так они не прячутся под контролами и читаются на светлом кадре
  function applySubs() {
    [...video.textTracks].forEach((t, i) => {
      t.mode = i === subIndex ? 'hidden' : 'disabled';
      t.oncuechange = i === subIndex ? renderSubs : null;
    });
    $('ccBtn').setAttribute('aria-pressed', String(subIndex >= 0));
    renderSubs();
  }
  function renderSubs() {
    const box = $('subs');
    box.textContent = '';
    const track = video.textTracks[subIndex];
    if (!track || !track.activeCues) return;
    for (const cue of [...track.activeCues]) {
      const line = document.createElement('span');
      line.textContent = (cue.text || '').replace(/<[^>]+>/g, '');
      box.append(line);
    }
  }
  function cycleSubs() {
    const n = video.textTracks.length;
    if (!n) return;
    subIndex = subIndex + 1 >= n ? -1 : subIndex + 1;
    applySubs();
    if (last) store.set('subs:' + last.file, String(subIndex));
    toast(subIndex < 0 ? 'Субтитры выключены' : `Субтитры: ${video.textTracks[subIndex].label}`);
  }
  $('ccBtn').addEventListener('click', cycleSubs);

  // --- интерфейс плеера уходит в тень ---
  let idleTimer = 0;
  function showChrome() {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hideChrome, 2600);
    kickTime();
  }
  function hideChrome() {
    const busy = video.paused || counting() || scrubbing || blocked || $('controls').matches(':hover') || stage.querySelector('.chrome :focus-visible');
    if (busy) { idleTimer = setTimeout(hideChrome, 2600); return; }
    stage.classList.add('idle');
  }
  stage.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showChrome(); });
  video.addEventListener('pointerup', (e) => {
    if (!joined || now() - joinedAt < 900) return; // касание, которым обрывали переход, — не пауза
    if (e.pointerType === 'mouse') { userToggle(); showChrome(); return; }
    // на телефоне касание показывает и прячет интерфейс, а не ставит паузу
    if (stage.classList.contains('idle')) showChrome();
    else if (!video.paused) { clearTimeout(idleTimer); stage.classList.add('idle'); }
  });
  video.addEventListener('dblclick', toggleFullscreen);
  $('chrome').addEventListener('pointerdown', showChrome);

  document.addEventListener('keydown', (e) => {
    if (!joined || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range')) return;
    switch (e.code) {
      case 'Space': case 'KeyK': userToggle(); break;
      case 'ArrowLeft': case 'KeyJ': userSkip(-10); break;
      case 'ArrowRight': case 'KeyL': userSkip(10); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'KeyM': toggleMute(); break;
      case 'KeyC': cycleSubs(); break;
      default: return;
    }
    e.preventDefault();
    showChrome();
  });
  // пробел на кнопке в фокусе иначе сработал бы второй раз — как нажатие этой кнопки
  document.addEventListener('keyup', (e) => { if (joined && e.code === 'Space' && e.target.tagName === 'BUTTON') e.preventDefault(); });

  // --- экран не гаснет, пока смотрим; плеер виден на экране блокировки ---
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (joined && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* батарея на исходе или запрещено — не страшно */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  function updateMediaMetadata(file) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title(file),
      artist: 'Смотрильня',
      artwork: [{ src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  if ('mediaSession' in navigator) {
    const handlers = {
      play: userPlay,
      pause: userPause,
      seekbackward: () => userSkip(-10),
      seekforward: () => userSkip(10),
      seekto: (d) => userSeek(d.seekTime),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, (d) => { if (joined) fn(d); }); } catch { /* не поддерживается */ }
    }
  }

  // --- вход в зал: фильм раскрывается из своей звезды ---
  $('joinBtn').addEventListener('click', () => {
    if (!last || !last.file || joined) return;
    joined = true;
    joinedAt = now();
    blocked = false;
    ignoreEventsUntil = now() + 1500;
    // жест пользователя «разблокирует» воспроизведение на iOS/Android: play() строго здесь, до анимации
    video.play().then(() => apply({ hard: true })).catch(() => {});
    apply({ hard: true });
    sendStatus();
    keepAwake();
    if (coarse.matches && canElementFullscreen) toggleFullscreen();
    openStage();
  });

  // easeInOutQuart — та же кривая, что cubic-bezier(0.77, 0, 0.175, 1)
  const easeInOut = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);
  function openStage() {
    const p = sky && sky.point(me);
    body.dataset.view = 'player';
    renderControls();
    stage.classList.add('flying'); // контролы и надписи появятся, когда круг раскроется
    const done = () => {
      stage.style.clipPath = '';
      for (const k of ['--r', '--w', '--sx', '--sy']) stage.style.removeProperty(k);
      $('stageRim').style.opacity = '';
      stage.classList.remove('flying');
      body.classList.add('scene-off');
      if (sky) sky.stop();
      showChrome();
    };
    if (reduceMotion.matches || !p) {
      stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }).finished.then(done);
      return;
    }
    const vw = innerWidth, vh = innerHeight;
    // круг растёт из своей звезды, пока не накроет самый дальний угол экрана
    const far = Math.max(Math.hypot(p.x, p.y), Math.hypot(vw - p.x, p.y), Math.hypot(p.x, vh - p.y), Math.hypot(vw - p.x, vh - p.y)) + 2;
    const r0 = Math.max(1.5, p.r || 2);
    const at = `at ${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`;
    const scene = document.querySelector('.scene');
    scene.style.transformOrigin = `${p.x}px ${p.y}px`;
    const glowEl = $('stageGlow');
    // центр и радиус круга — на самом плеере: по ним рисуются и вспышка, и кромка
    stage.style.setProperty('--sx', `${p.x}px`);
    stage.style.setProperty('--sy', `${p.y}px`);
    const rim = $('stageRim');
    const ease = 'cubic-bezier(0.77, 0, 0.175, 1)';
    // небо чуть подаётся навстречу своей звезде
    const fly = scene.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }], { duration: 800, easing: ease, fill: 'forwards' });
    // жемчужная вспышка у звезды: свет разливается и уступает кадру
    const glow = glowEl.animate([{ opacity: 1 }, { opacity: 0.85, offset: 0.4 }, { opacity: 0 }], { duration: 1000, easing: 'ease-out' });
    // только clip-path: маска поверх играющего видео обрезает его по прямоугольнику, а не по кругу
    const open = (t) => {
      const r = r0 + (far - r0) * easeInOut(t);
      stage.style.clipPath = `circle(${r.toFixed(1)}px ${at})`;
      stage.style.setProperty('--r', `${r.toFixed(1)}px`);
      stage.style.setProperty('--w', `${Math.min(r * 0.5, 140).toFixed(1)}px`);
      rim.style.opacity = String(t < 0.8 ? 1 : Math.max(0, (1 - t) / 0.2)); // кромка гаснет на последней пятой пути
    };
    let t0 = 0, skipped = false;
    const step = (ts) => {
      if (!t0) t0 = ts;
      const t = skipped ? 1 : Math.min(1, (ts - t0) / 800);
      open(t);
      if (t < 1) requestAnimationFrame(step);
      else { fly.finish(); glow.finish(); done(); }
    };
    open(0);
    requestAnimationFrame(step);
    // переход можно оборвать касанием
    stage.addEventListener('pointerdown', () => { skipped = true; }, { once: true });
  }

  // --- выбор фильма (меняется у обоих) ---
  for (const sel of [$('files'), $('filesP')]) {
    sel.addEventListener('change', () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'select', file: sel.value }));
    });
  }

  video.addEventListener('canplay', () => { videoReady = true; videoRetries = 0; renderLobby(); });
  video.addEventListener('loadeddata', () => { videoReady = true; renderLobby(); });
  // Ошибка видео чаще всего — обрыв связи (смена Wi-Fi на мобильный, выкладка новой версии сервера), а не формат
  // файла. Поэтому сначала тихо перезагружаем тот же файл и возвращаемся на позицию зала, и только если не помогло,
  // говорим про формат. Неподходящий формат виден сразу, до первой картинки: ему хватит одной повторной попытки.
  video.addEventListener('error', () => {
    if (!source || source.mode === 'hlsjs') return; // у hls.js свои повторы, см. attachHls
    const current = source;
    const unsupported = video.error && video.error.code === 4 && !videoReady;
    if (videoRetries < (unsupported ? 1 : 5)) {
      videoRetries++;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (source !== current) return; // пока ждали, выбрали другой фильм
        videoReady = false;
        ignoreEventsUntil = now() + 1500;
        video.load();
        apply({ hard: true });
      }, 1000 * videoRetries);
      return;
    }
    if (current.mode === 'native') { fallBackToMp4(current.file); return; }
    videoError = true;
    renderLobby();
    if (joined) notice('blocked', 'Этот файл не открывается в браузере. Нужен mp4 (H.264 и AAC).');
  });


  // --- запуск ---
  fetch('/api/media')
    .then((r) => { if (r.status === 401) { location.href = '/login'; throw new Error('401'); } return r.json(); })
    .then((d) => {
      me = d.user;
      everyone = d.users && d.users.length ? d.users : [d.user];
      subsByFile = d.subs || {};
      hlsByFile = d.hls || {};
      if (d.files.length > 1) {
        for (const sel of [$('files'), $('filesP')]) for (const f of d.files) sel.add(new Option(title(f), f));
        $('pick').hidden = false;
        $('filesP').hidden = false;
      }
      if (window.Sky) {
        sky = window.Sky.mount({ root: document.querySelector('.scene'), onLayout: placeLabels });
      }
      renderAll();
      connect();
    })
    .catch(() => {});
})();
