'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('v');
  const filesSel = $('files');

  let ws = null;
  let me = null;
  let joined = false;
  let last = null; // последнее эталонное состояние с сервера
  let ignoreEventsUntil = 0; // события плеера, вызванные нами самими, не отправляем
  let ignoreTicksUntil = 0; // после своего действия не даём тику «откатить» нас
  let retry = 0;
  let toast = '';

  const now = () => performance.now();
  function setStatus(text) {
    toast = text;
    $('status').textContent = text;
    clearTimeout(setStatus.t);
    if (text) setStatus.t = setTimeout(() => { if (toast === text) $('status').textContent = ''; }, 4000);
  }

  function setConn(on, text) {
    $('dot').className = 'dot ' + (on ? 'on' : 'off');
    $('conn').textContent = text;
  }

  // --- применение эталонного состояния к плееру ---
  function apply(state, { hard = false } = {}) {
    if (!state.file) { $('joinHint').textContent = 'Фильм не найден: положите .mp4 в папку media на сервере.'; return; }
    const src = '/video/' + encodeURIComponent(state.file);
    if (!video.src.endsWith(src)) {
      ignoreEventsUntil = now() + 800;
      video.src = src;
      video.load();
      filesSel.value = state.file;
    }
    if (!joined) return;

    const drift = video.currentTime - state.position;
    const abs = Math.abs(drift);
    const changing = [];
    if (abs > 1.2 || (hard && abs > 0.3)) {
      changing.push('seek');
      video.currentTime = state.position;
      video.playbackRate = 1;
    } else if (state.playing && abs > 0.15) {
      // мелкий дрейф гасим плавным изменением скорости
      video.playbackRate = drift > 0 ? 0.95 : 1.05;
    } else {
      video.playbackRate = 1;
    }
    if (state.playing && video.paused) {
      changing.push('play');
      video.play().catch(() => { $('join').hidden = false; $('joinBtn').disabled = false; $('joinHint').textContent = 'Браузер заблокировал воспроизведение — нажмите кнопку.'; joined = false; });
    } else if (!state.playing && !video.paused) {
      changing.push('pause');
      video.pause();
    }
    if (changing.length) ignoreEventsUntil = now() + 600;
  }

  // --- локальные действия -> сервер ---
  function sendControl() {
    if (!ws || ws.readyState !== 1 || now() < ignoreEventsUntil || !joined) return;
    ignoreTicksUntil = now() + 2000;
    ws.send(JSON.stringify({ type: 'control', playing: !video.paused, position: video.currentTime }));
  }
  video.addEventListener('play', sendControl);
  video.addEventListener('pause', sendControl);
  video.addEventListener('seeked', sendControl);
  video.addEventListener('waiting', () => setStatus('Буферизация…'));
  video.addEventListener('playing', () => { if (toast === 'Буферизация…') setStatus(''); });

  // --- WebSocket ---
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { retry = 0; setConn(true, 'онлайн'); };
    ws.onclose = () => {
      setConn(false, 'нет связи, переподключение…');
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'presence') {
        const others = m.users.filter((u) => u !== me);
        $('who').textContent = others.length ? '· с вами: ' + others.join(', ') : '· вы пока одни';
      } else if (m.type === 'state') {
        last = m;
        if (m.by && m.by !== me) setStatus(`${m.by}: ${m.playing ? '▶ играет' : '⏸ пауза'}`);
        ignoreTicksUntil = 0;
        apply(m, { hard: true });
      } else if (m.type === 'tick') {
        last = m;
        if (now() >= ignoreTicksUntil && !video.seeking) apply(m);
      }
    };
  }

  // --- запуск ---
  $('joinBtn').addEventListener('click', () => {
    joined = true;
    $('join').hidden = true;
    // жест пользователя «разблокирует» воспроизведение на iOS/Android
    ignoreEventsUntil = now() + 1500;
    video.play().then(() => { if (last) apply(last, { hard: true }); }).catch(() => {});
    if (last) apply(last, { hard: true });
  });

  filesSel.addEventListener('change', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'select', file: filesSel.value }));
  });

  video.addEventListener('canplay', () => {
    if (!joined) { $('joinBtn').disabled = false; $('joinHint').textContent = 'Нажмите, когда будете готовы — это нужно браузеру телефона.'; }
  });
  video.addEventListener('error', () => { $('joinHint').textContent = 'Не удалось загрузить видео. Нужен mp4 (H.264 + AAC).'; });

  fetch('/api/media').then((r) => { if (r.status === 401) location.href = '/login'; return r.json(); }).then((d) => {
    me = d.user;
    if (d.files.length > 1) {
      filesSel.hidden = false;
      for (const f of d.files) filesSel.add(new Option(f, f));
    }
    connect();
  });
})();
