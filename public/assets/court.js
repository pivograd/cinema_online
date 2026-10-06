'use strict';
// Двор-колодец, вид снизу вверх. Стены, окна и туман рисуются один раз (и заново при resize);
// живой только слой света в окнах: ~12 кадров в секунду и только пока сцена видна.
(() => {
  // размеры двора в метрах; z считаем от уровня глаз. Узкий и высокий — как настоящий колодец
  const W = 10, D = 7.2, EYE = 1.6, FLOORS = 7, FLOOR_H = 3.1, SILL0 = 2.3;
  const TOP = SILL0 + FLOORS * FLOOR_H + 0.5 - EYE;
  const WIN_W = 1.1, WIN_H = 1.8, TRANSOM = 0.68;
  const SEED = 1703; // двор один и тот же при каждом визите
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // время суток меняет свет: вечер, ночь, утро в тумане, пасмурный день
  const MOODS = {
    evening: { sky: ['#9aa3ad', '#69727c'], fog: '#7d8690', wallTop: '#3d444c', wallLow: '#121519', glass: '#191d22', haze: 0.62, lit: 8, tv: 3 },
    night: { sky: ['#5c656f', '#3a424b'], fog: '#4f5862', wallTop: '#2a3037', wallLow: '#0c0e11', glass: '#121519', haze: 0.55, lit: 6, tv: 2 },
    morning: { sky: ['#c3c9cf', '#98a1a9'], fog: '#a2aab2', wallTop: '#535b63', wallLow: '#191c20', glass: '#22272c', haze: 0.72, lit: 2, tv: 0 },
    day: { sky: ['#b0b7be', '#848d96'], fog: '#8f98a1', wallTop: '#474e56', wallLow: '#15181c', glass: '#1e2227', haze: 0.66, lit: 2, tv: 1 },
  };
  function moodNow(date = new Date()) {
    const h = date.getHours();
    if (h >= 23 || h < 5) return 'night';
    if (h < 11) return 'morning';
    if (h < 17) return 'day';
    return 'evening';
  }

  // стены: точка на стене по координате вдоль стены u и высоте z
  const WALLS = [
    { id: 'left', len: D, cols: 2, at: (u, z) => [-W / 2, -D / 2 + u, z] },
    { id: 'back', len: W, cols: 3, at: (u, z) => [-W / 2 + u, D / 2, z] },
    { id: 'right', len: D, cols: 2, at: (u, z) => [W / 2, D / 2 - u, z] },
    { id: 'front', len: W, cols: 3, at: (u, z) => [W / 2 - u, -D / 2, z] },
  ];

  function mount({ base, lights, onLayout }) {
    const bctx = base.getContext('2d');
    const lctx = lights.getContext('2d');
    const mood = MOODS[document.documentElement.dataset.mood] || MOODS[moodNow()];
    const FOG = rgb(mood.fog);
    // воздушная перспектива: чем выше, тем больше всё растворяется в тумане
    const fogged = (color, z) => mix(rgb(color), FOG, Math.min(0.92, mood.haze * Math.pow(Math.max(0, z) / TOP, 1.35)));
    let cam = null;
    let windows = [];
    let glows = [];
    let people = []; // [{ id, lit, watching }]
    let personWin = new Map(); // id -> окно
    let running = false;
    let timer = 0;
    let vw = 0, vh = 0, dpr = 1;

    function project(p) {
      const z = Math.max(p[2], 0.05);
      const dx = (cam.f * (p[0] - cam.cx)) / z;
      const dy = (-cam.f * (p[1] - cam.cy)) / z;
      return [cam.sx + dx * cam.cos - dy * cam.sin, cam.sy + dx * cam.sin + dy * cam.cos];
    }
    const quad = (wall, u0, u1, z0, z1) =>
      [wall.at(u0, z0), wall.at(u1, z0), wall.at(u1, z1), wall.at(u0, z1)].map(project);
    const path = (ctx, q) => {
      ctx.beginPath();
      ctx.moveTo(q[0][0], q[0][1]);
      for (let i = 1; i < q.length; i++) ctx.lineTo(q[i][0], q[i][1]);
      ctx.closePath();
    };
    const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const lineW = (z, k = 0.06) => Math.max(0.6, (cam.f * k) / z);

    function layout() {
      vw = innerWidth;
      vh = innerHeight;
      dpr = Math.min(devicePixelRatio || 1, 2);
      for (const c of [base, lights]) {
        c.width = Math.round(vw * dpr);
        c.height = Math.round(vh * dpr);
      }
      const portrait = vh > vw;
      // точка «прямо вверх» смещена вправо-вверх: снизу слева остаётся тёмная стена под текст
      const sx = portrait ? vw * 0.55 : vw * 0.63;
      const sy = portrait ? vh * 0.25 : vh * 0.33;
      const skyW = portrait ? vw * 0.34 : Math.min(vw * 0.17, vh * 0.3);
      const roll = (portrait ? -2.5 : -4) * (Math.PI / 180);
      cam = { sx, sy, f: (skyW * TOP) / W, cx: W * 0.1, cy: -D * 0.08, cos: Math.cos(roll), sin: Math.sin(roll) };

      const rand = rng(SEED);
      windows = [];
      for (const wall of WALLS) {
        const step = wall.len / wall.cols;
        // первый этаж — арки и двери, окна начинаются со второго
        for (let floor = 1; floor < FLOORS; floor++) {
          const z0 = SILL0 + floor * FLOOR_H - EYE;
          for (let col = 0; col < wall.cols; col++) {
            const uc = (col + 0.5) * step;
            windows.push({
              wall, floor, col, z0, z1: z0 + WIN_H,
              q: quad(wall, uc - WIN_W / 2, uc + WIN_W / 2, z0, z0 + WIN_H),
              reveal: quad(wall, uc - WIN_W / 2 - 0.1, uc + WIN_W / 2 + 0.1, z0 - 0.12, z0 + WIN_H + 0.06),
              sill: quad(wall, uc - WIN_W / 2 - 0.16, uc + WIN_W / 2 + 0.16, z0 - 0.2, z0 - 0.08),
              stain: rand() < 0.45 ? quad(wall, uc - 0.3 + rand() * 0.2, uc + 0.1 + rand() * 0.2, z0 - 1.5 - rand(), z0 - 0.2) : null,
              // куда падает свет из окна: стена под подоконником
              spill: quad(wall, uc - WIN_W / 2 - 0.55, uc + WIN_W / 2 + 0.55, z0 - 2.4, z0 - 0.08),
              r: rand(),
            });
          }
        }
      }
      pickPersonWindows();
      drawBase();
      buildGlows();
      drawLights(performance.now(), true);
      onLayout && onLayout();
    }

    const inView = (q, m) => q.every(([x, y]) => x > m && x < vw - m && y > m && y < vh * 0.7);

    // окна людей: я на левой стене, остальные напротив; этаж — самый низкий, где все окна целиком на экране
    function pickPersonWindows() {
      personWin = new Map();
      const order = ['right', 'back', 'front'];
      for (let floor = 2; floor < FLOORS; floor++) {
        const mine = windows.find((w) => w.wall.id === 'left' && w.floor === floor && w.col === 1);
        const others = people.slice(1).map((_, i) =>
          windows.find((w) => w.wall.id === order[i % 3] && w.floor === floor && w.col === (i < 3 ? 0 : 1)));
        const all = [mine, ...others].filter(Boolean);
        if (all.every((w) => inView(w.q, 16)) || floor === FLOORS - 1) {
          people.forEach((p, i) => all[i] && personWin.set(p.id, all[i]));
          return;
        }
      }
    }

    // цвет стены по высоте → линейный градиент вдоль средней линии стены
    function wallGradient(c, wall) {
      const zs = [1, TOP * 0.25, TOP * 0.5, TOP * 0.75, TOP];
      const pts = zs.map((z) => project(wall.at(wall.len / 2, z)));
      const g = c.createLinearGradient(pts[0][0], pts[0][1], pts[4][0], pts[4][1]);
      const total = Math.hypot(pts[4][0] - pts[0][0], pts[4][1] - pts[0][1]) || 1;
      zs.forEach((z, i) => {
        const at = Math.min(1, Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) / total);
        const base = mix(rgb(mood.wallLow), rgb(mood.wallTop), Math.pow(z / TOP, 0.8));
        g.addColorStop(at, css(mix(base, FOG, Math.min(0.92, mood.haze * Math.pow(z / TOP, 1.35)))));
      });
      return g;
    }

    function drawBase() {
      const c = bctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = mood.wallLow;
      c.fillRect(0, 0, vw, vh);

      for (const wall of WALLS) {
        c.fillStyle = wallGradient(c, wall);
        path(c, quad(wall, 0, wall.len, 0.3, TOP));
        c.fill();
      }
      // штукатурка неровная: пятна темнее и светлее, к небу растворяются в тумане
      const plaster = rng(SEED + 7);
      for (const wall of WALLS) {
        for (let i = 0; i < 70; i++) {
          const u = plaster() * wall.len, z = 0.8 + plaster() * (TOP - 1.5);
          const du = 0.5 + plaster() * 2.2, dz = 0.4 + plaster() * 2.4;
          const dark = plaster() < 0.6;
          const a = (0.02 + plaster() * 0.035) * (1 - Math.min(0.85, z / TOP));
          c.fillStyle = dark ? `rgba(4,6,8,${a})` : `rgba(190,198,206,${a * 0.7})`;
          path(c, quad(wall, u, Math.min(wall.len, u + du), z, Math.min(TOP, z + dz)));
          c.fill();
        }
      }
      // рёбра углов двора чуть темнее стен
      for (const wall of WALLS) {
        const a = project(wall.at(0, 0.6)), m = project(wall.at(0, TOP * 0.5)), b = project(wall.at(0, TOP));
        const g = c.createLinearGradient(a[0], a[1], b[0], b[1]);
        g.addColorStop(0, 'rgba(6,8,10,.55)');
        g.addColorStop(1, 'rgba(6,8,10,.08)');
        c.strokeStyle = g;
        c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(m[0], m[1]); c.lineTo(b[0], b[1]); c.stroke();
      }

      // водосточная труба в углу
      const pipeWall = WALLS[3];
      for (let z = 0.6; z < TOP - 0.3; z += 1.2) {
        const seg = quad(pipeWall, 0.32, 0.5, z, Math.min(z + 1.2, TOP - 0.3));
        c.fillStyle = css(fogged('#4a525a', z), 0.85);
        path(c, seg);
        c.fill();
      }
      for (let z = 3; z < TOP; z += 3) {
        const a = project(pipeWall.at(0.28, z)), b = project(pipeWall.at(0.54, z));
        c.strokeStyle = css(fogged('#6b737b', z), 0.7);
        c.lineWidth = lineW(z, 0.05);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }

      // окна: подтёки под подоконником, откос, отлив, стекло, переплёт «Т»
      for (const w of windows) {
        const zm = (w.z0 + w.z1) / 2;
        if (w.stain) {
          const g = c.createLinearGradient(...lerp2(w.stain[2], w.stain[3], 0.5), ...lerp2(w.stain[0], w.stain[1], 0.5));
          const k = 0.3 * (1 - Math.min(1, zm / TOP));
          g.addColorStop(0, `rgba(6,8,10,${k})`);
          g.addColorStop(1, 'rgba(6,8,10,0)');
          c.fillStyle = g;
          path(c, w.stain);
          c.fill();
        }
        c.fillStyle = css(fogged('#0b0d10', zm), 0.75);
        path(c, w.reveal);
        c.fill();
        c.fillStyle = css(fogged('#3b4148', w.z0));
        path(c, w.sill);
        c.fill();
        const glass = fogged(mood.glass, zm);
        const g = c.createLinearGradient(...lerp2(w.q[0], w.q[1], 0.5), ...lerp2(w.q[3], w.q[2], 0.5));
        g.addColorStop(0, css(glass));
        g.addColorStop(1, css(mix(glass, FOG, 0.18))); // в верхних стёклах отражается небо
        c.fillStyle = g;
        path(c, w.q);
        c.fill();
        mullions(c, w.q, lineW(zm), css(fogged('#3c434b', zm)));
      }

      // небо: бледный прямоугольник тумана, светлее к середине
      const sky = WALLS.map((wall) => project(wall.at(0, TOP)));
      const sc = sky.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
      const sr = Math.max(...sky.map((p) => Math.hypot(p[0] - sc[0], p[1] - sc[1])));
      const sg = c.createRadialGradient(sc[0], sc[1], 0, sc[0], sc[1], sr);
      sg.addColorStop(0, mood.sky[0]);
      sg.addColorStop(1, mood.sky[1]);
      c.fillStyle = sg;
      path(c, sky);
      c.fill();

      // над колодцем — петербургские крыши: глухой брандмауэр соседнего дома, трубы и ограждение на краю
      const roofTone = (k) => css(mix(fogged(mood.wallTop, TOP), rgb(mood.sky[1]), k));
      const back = WALLS[1];
      c.fillStyle = roofTone(0.25);
      path(c, quad(back, W * 0.52, W, TOP, TOP + 4.2));
      c.fill();
      c.fillStyle = roofTone(0.12);
      path(c, quad(back, W * 0.52, W * 0.535, TOP, TOP + 4.2)); // ребро брандмауэра
      c.fill();
      const chimneys = [[0, 1.4, 1.5], [0, 4.6, 1.1], [3, 2.2, 1.7], [3, 7.3, 1.3], [2, 3.1, 1.2]];
      for (const [wi, u, h] of chimneys) {
        const wall = WALLS[wi];
        c.fillStyle = roofTone(0.08);
        path(c, quad(wall, u, u + 0.7, TOP, TOP + h));
        c.fill();
        c.fillStyle = roofTone(0.02); // оголовок трубы
        path(c, quad(wall, u - 0.08, u + 0.78, TOP + h - 0.15, TOP + h));
        c.fill();
      }
      c.strokeStyle = roofTone(0.1);
      for (const wall of WALLS) {
        const rail = [];
        for (let u = 0; u <= wall.len + 0.01; u += wall.len / 8) rail.push(u);
        c.lineWidth = lineW(TOP, 0.03);
        c.beginPath();
        rail.forEach((u, i) => { const p = project(wall.at(u, TOP + 0.9)); i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); });
        for (const u of rail) { const a = project(wall.at(u, TOP)), b = project(wall.at(u, TOP + 0.9)); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
        c.stroke();
      }

      // туман опускается в колодец: свечение неба переливается через карнизы
      const far = Math.hypot(Math.max(sc[0], vw - sc[0]), Math.max(sc[1], vh - sc[1]));
      const fg = c.createRadialGradient(sc[0], sc[1], sr * 0.5, sc[0], sc[1], far * 0.75);
      fg.addColorStop(0, css(FOG, 0.55));
      fg.addColorStop(0.3, css(FOG, 0.22));
      fg.addColorStop(1, css(FOG, 0));
      c.fillStyle = fg;
      c.fillRect(0, 0, vw, vh);
      // к земле темнее
      const vg = c.createRadialGradient(sc[0], sc[1], far * 0.3, sc[0], sc[1], far);
      vg.addColorStop(0, 'rgba(8,10,12,0)');
      vg.addColorStop(1, 'rgba(8,10,12,.7)');
      c.fillStyle = vg;
      c.fillRect(0, 0, vw, vh);
    }

    function mullions(c, q, lw, color) {
      const bottom = lerp2(q[0], q[1], 0.5);
      const tl = lerp2(q[0], q[3], TRANSOM), tr = lerp2(q[1], q[2], TRANSOM);
      const mid = lerp2(tl, tr, 0.5);
      c.strokeStyle = color;
      c.lineWidth = lw;
      c.beginPath();
      c.moveTo(bottom[0], bottom[1]); c.lineTo(mid[0], mid[1]);
      c.moveTo(tl[0], tl[1]); c.lineTo(tr[0], tr[1]);
      c.stroke();
    }

    // свет в окнах: соседи (ровный свет или мерцание телевизора) и окна людей
    function buildGlows() {
      const taken = new Set(personWin.values());
      // соседи со светом — среди окон, которые видно на экране
      const free = windows.filter((w) => !taken.has(w) && inView(w.q, 0)).sort((a, b) => a.r - b.r);
      const prev = new Map(glows.filter((g) => g.person).map((g) => [g.person, g.level]));
      glows = [];
      free.slice(0, mood.lit).forEach((w, i) => {
        glows.push({ w, kind: i < mood.tv ? 'tv' : 'steady', level: 0, target: 0.45 + w.r * 0.35, seed: w.r * 100 });
      });
      for (const p of people) {
        const w = personWin.get(p.id);
        if (w) glows.push({ w, kind: 'person', person: p.id, level: prev.get(p.id) || 0, target: 0, seed: w.r * 100 });
      }
      applyPeople();
    }
    function applyPeople() {
      for (const g of glows) {
        if (g.kind !== 'person') continue;
        const p = people.find((x) => x.id === g.person);
        g.target = p && p.lit ? 1 : 0;
        g.watching = !!(p && p.lit && p.watching);
      }
    }

    // плавный шум для мерцания экрана телевизора за занавеской
    const flicker = (t, s) => 0.64 + 0.2 * Math.sin(t * 1.7 + s) * Math.sin(t * 0.43 + s * 3) + 0.14 * Math.sin(t * 5.3 + s * 7);

    function drawLights(nowMs, instant) {
      const c = lctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, vw, vh);
      const t = nowMs / 1000;
      const still = reduceMotion.matches;
      for (const g of glows) {
        g.level = instant || still ? g.target : g.level + (g.target - g.level) * 0.12;
        if (g.level < 0.01) continue;
        const tv = (g.kind === 'tv' || g.watching) && !still;
        const k = g.level * (tv ? flicker(t, g.seed) : 1);
        const person = g.kind === 'person';
        const tone = tv ? '172,194,216' : person ? '230,235,240' : '160,170,182';
        const q = g.w.q;
        const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
        const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        const size = Math.hypot(q[0][0] - q[2][0], q[0][1] - q[2][1]);
        // свет складывается с туманом: ореол, пятно на стене под окном и на подоконнике
        c.globalCompositeOperation = 'lighter';
        const r = size * (person ? 4.2 : 1.8);
        const halo = c.createRadialGradient(cx, cy, size * 0.2, cx, cy, r);
        halo.addColorStop(0, `rgba(${tone},${(person ? 0.58 : 0.1) * k})`);
        halo.addColorStop(0.3, `rgba(${tone},${(person ? 0.24 : 0.035) * k})`);
        halo.addColorStop(0.6, `rgba(${tone},${(person ? 0.07 : 0.01) * k})`);
        halo.addColorStop(1, `rgba(${tone},0)`);
        c.fillStyle = halo;
        c.fillRect(cx - r, cy - r, r * 2, r * 2);
        // мягкое пятно света на стене под подоконником
        const s = g.w.spill;
        const sx = (s[2][0] + s[3][0]) / 2, sy = (s[2][1] + s[3][1]) / 2;
        const sr = size * (person ? 2.3 : 0.9);
        const sg = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
        sg.addColorStop(0, `rgba(${tone},${(person ? 0.38 : 0.05) * k})`);
        sg.addColorStop(1, `rgba(${tone},0)`);
        c.fillStyle = sg;
        c.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
        c.globalCompositeOperation = 'source-over';
        // стекло: светлее у подоконника, как от лампы в комнате
        const lg = c.createLinearGradient(...lerp2(q[0], q[1], 0.5), ...lerp2(q[3], q[2], 0.5));
        lg.addColorStop(0, `rgba(${tone},${(person ? 0.96 : 0.62) * k})`);
        lg.addColorStop(1, `rgba(${tone},${(person ? 0.74 : 0.4) * k})`);
        c.fillStyle = lg;
        path(c, q);
        c.fill();
        if (person) {
          // занавеска сбоку: комната внутри, а не белый прямоугольник
          const cg = c.createLinearGradient(...lerp2(q[0], q[3], 0.5), ...lerp2(q[1], q[2], 0.5));
          cg.addColorStop(0, `rgba(48,56,66,${0.85 * g.level})`);
          cg.addColorStop(0.26, `rgba(48,56,66,${0.55 * g.level})`);
          cg.addColorStop(0.34, `rgba(48,56,66,${0.12 * g.level})`);
          cg.addColorStop(0.5, 'rgba(48,56,66,0)');
          c.fillStyle = cg;
          path(c, q);
          c.fill();
        }
        const zm = (g.w.z0 + g.w.z1) / 2;
        mullions(c, q, lineW(zm), `rgba(20,23,27,${0.85 * Math.min(1, g.level * 1.5)})`);
      }
    }

    function loop() {
      if (!running) { timer = 0; return; }
      drawLights(performance.now(), false);
      const settling = glows.some((g) => Math.abs(g.target - g.level) > 0.005);
      const animated = !reduceMotion.matches && glows.some((g) => g.kind === 'tv' || g.watching);
      if (document.hidden || (!settling && !animated)) { timer = 0; return; }
      timer = setTimeout(() => requestAnimationFrame(loop), 80);
    }
    function kick() {
      if (running && !timer) { timer = 1; requestAnimationFrame(loop); }
    }

    let resizeT = 0;
    addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(layout, 120); });
    document.addEventListener('visibilitychange', kick);
    reduceMotion.addEventListener('change', () => { drawLights(performance.now(), true); kick(); });

    layout();
    running = true;
    kick();

    return {
      setPeople(list) {
        const changed = list.map((p) => p.id).join() !== people.map((p) => p.id).join();
        people = list;
        if (changed) { pickPersonWindows(); buildGlows(); onLayout && onLayout(); } else applyPeople();
        kick();
      },
      // экранный прямоугольник окна человека (CSS px) — для подписей и перехода «в окно»
      // четыре угла окна на экране: низ-лево, низ-право, верх-право, верх-лево (по стене)
      quad(id) {
        const w = personWin.get(id);
        return w ? w.q.map((p) => [p[0], p[1]]) : null;
      },
      box(id) {
        const w = personWin.get(id);
        if (!w) return null;
        const xs = w.q.map((p) => p[0]), ys = w.q.map((p) => p[1]);
        const left = Math.min(...xs), top = Math.min(...ys);
        return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
      },
      stop() { running = false; clearTimeout(timer); timer = 0; },
      start() { running = true; kick(); },
    };
  }

  window.Court = { mount, moodNow };
})();
