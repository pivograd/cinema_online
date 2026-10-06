'use strict';
// Небо над крышами: серая петербургская гряда, в просвете — Пояс Ориона.
// Двое — крайние звёзды Пояса (смотрящий — Минтака, второй — Альнитак), общий фильм — Альнилам.
// Звёзды, крыши и стекло рисуются один раз (и заново при resize); живут только облака
// (WebGL, пониженное разрешение, ~30 к/с) и тёплые огни присутствия. Без WebGL — неподвижная гряда на 2D.
(() => {
  const D2R = Math.PI / 180;
  const PERIOD = 5.6; // спокойное дыхание огней, ~11 в минуту
  const FADE = 800; // мс на смену состояния человека
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // запасные координаты: сцена не должна падать, если stars.js не загрузился
  const DEF = {
    Mintaka: [83.002, -0.299, 2.23, 330], Alnilam: [84.053, -1.202, 1.7, 300], Alnitak: [85.19, -1.943, 2.05, 330],
    Betelgeuse: [88.793, 7.407, 0.5, 34], Rigel: [78.635, -8.202, 0.12, 140], Bellatrix: [81.283, 6.35, 1.64, 260], Saiph: [86.939, -9.67, 2.06, 300],
  };
  const STARS = (window.ORION || []).map((s) => ({ ra: s[0], dec: s[1], v: s[2], k: s[3] * 100, n: s[4] || '' }));
  const named = (n) => {
    let s = STARS.find((x) => x.n === n);
    if (!s) { const d = DEF[n]; s = { ra: d[0], dec: d[1], v: d[2], k: d[3] * 100, n }; STARS.push(s); }
    return s;
  };
  const MINTAKA = named('Mintaka'), ALNILAM = named('Alnilam'), ALNITAK = named('Alnitak');
  const EXTRA = ['Betelgeuse', 'Rigel', 'Bellatrix', 'Saiph'].map(named); // третий и дальше (редко)
  const BELT = new Set([MINTAKA, ALNILAM, ALNITAK]);

  // гномоническая проекция с центром посередине Пояса; север вверху, прямое восхождение растёт влево
  const RA0 = 84.0957, DEC0 = -1.121;
  const sD0 = Math.sin(DEC0 * D2R), cD0 = Math.cos(DEC0 * D2R);
  function tangent(ra, dec) {
    const a = (ra - RA0) * D2R, d = dec * D2R;
    const cc = sD0 * Math.sin(d) + cD0 * Math.cos(d) * Math.cos(a);
    return [Math.cos(d) * Math.sin(a) / cc / D2R, (cD0 * Math.sin(d) - sD0 * Math.cos(d) * Math.cos(a)) / cc / D2R];
  }
  for (const s of STARS) { const t = tangent(s.ra, s.dec); s.X = t[0]; s.Y = t[1]; }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const breath = (t, ph) => Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * t / PERIOD + ph), 1.25);
  function rng(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6d2b79f5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function kelvinTint(K) {
    const t = (K || 6500) / 100; let r, g, b;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
    else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
    const c = [r, g, b].map((v) => clamp(v, 0, 255));
    // почти серебро: цвет звезды — лишь шёпот холодного или тёплого
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return c.map((v) => Math.round(0.78 * 248 + 0.22 * (248 * v / Math.max(1, l))));
  }

  /* ------------------------------------------------------------------ *
   *  Шейдер облачной гряды. Низ подсвечен городом, кромки у просвета —
   *  луной из-за гряды; в просвете — холодная глубина и Пояс.
   * ------------------------------------------------------------------ */
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FS = `
precision highp float;
uniform vec2 uView; uniform float uScale; uniform float uTime;
uniform vec2 uA, uF, uB; uniform float uLen, uOpen, uBreA, uBreB, uPresA, uPresB, uGap;
uniform vec2 uWatch; uniform vec4 uText; uniform vec4 uStar[4]; uniform vec2 uCam; uniform vec2 uMoon;
uniform float uGapK, uSkew; uniform vec2 uCloud; uniform vec4 uSmoke;

vec2 h22(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float h12(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = dot(h22(i) * 2. - 1., f);
  float b = dot(h22(i + vec2(1., 0.)) * 2. - 1., f - vec2(1., 0.));
  float c = dot(h22(i + vec2(0., 1.)) * 2. - 1., f - vec2(0., 1.));
  float d = dot(h22(i + vec2(1., 1.)) * 2. - 1., f - vec2(1., 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 RT = mat2(1.6, 1.2, -1.2, 1.6);
float fbm3(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 3; i++){ s += a * gn(p); p = RT * p + vec2(3.1, 1.7); a *= .5; } return .5 + s; }
float fbm4(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * gn(p); p = RT * p + vec2(3.1, 1.7); a *= .5; } return .5 + s; }
float fbm7(vec2 p, float lod, float extra, out float lo){
  float s = 0., a = .5; lo = 0.;
  for (int i = 0; i < 7; i++){
    float w = i < 3 ? 1. : (i < 5 ? lod : lod * extra);
    s += a * gn(p) * w;
    if (i == 2) lo = s;
    p = RT * p + vec2(3.1, 1.7); a *= .5;
  }
  lo += .5; return .5 + s;
}
float halo(vec2 p, vec2 c, float k, float veil){
  float r = length(p - c) / uLen;
  return k * (exp(-r * r * 1400.) * .34 + exp(-r * 19.) * .09 + exp(-r * 5.5) * .022) * (.6 + veil * 1.4);
}
float aura(vec2 p, vec2 c, float k){
  float r = length(p - c) / uLen;
  return k * (exp(-r * r * 240.) * .1 + exp(-r * 6.) * .045);
}

void main(){
  vec2 css = vec2(gl_FragCoord.x, uView.y * uScale - gl_FragCoord.y) / uScale;
  float t = uTime;

  // камера смотрит вверх над крышами; гряда — плоскость над городом
  vec2 ndc = vec2(css.x - .5 * uView.x, .5 * uView.y - css.y) / (.5 * uView.y);
  vec3 rd = normalize(vec3(ndc * uCam.x, 1.));
  float cp = cos(uCam.y), sp = sin(uCam.y);
  vec3 d = vec3(rd.x, rd.y * cp + rd.z * sp, rd.z * cp - rd.y * sp);
  float el = max(d.y, .012);
  float tP = 1. / el;
  vec2 P = vec2(d.x, d.z) * tP * uCloud.x;
  float lod = smoothstep(16., 5., tP);
  float fog = 1. - exp(-max(tP - 1.5, 0.) * .085);
  float hgt = clamp(css.y / uView.y, 0., 1.);

  // нижний слой: слоисто-кучевая гряда
  vec2 q = P * 1.55 + vec2(-t * .0105, t * .0022) + vec2(3.7, 1.9);
  vec2 w = vec2(fbm3(q * .32 + vec2(1.7, 9.2) + t * .004), fbm3(q * .32 + vec2(8.3, 2.8) - t * .0035));
  vec2 qw = q + (w - .5) * .8;
  float lo; float n = fbm7(qw, lod, uCloud.y, lo);
  float loL = fbm3(qw + vec2(.075, .055));
  float bl = abs(gn(qw * 2.3 + 11.)) * 1.4 + abs(gn(qw * 4.7 + 3.)) * .6;
  n += (smoothstep(0., .35, bl) - .7) * .07 * lod;

  // просвет: разрыв вдоль Пояса, рваный и несимметричный
  vec2 ab = uA - uB; vec2 nab = normalize(ab);
  float hh = clamp(dot(css - uB, ab) / dot(ab, ab), 0., 1.);
  vec2 dv = css - uB - ab * hh;
  float dseg = length(dv);
  float side = nab.x * dv.y - nab.y * dv.x;
  float br = 1. + .045 * sin(t * .56) + .02 * sin(t * .21 + 1.3);
  float R = uLen * uGapK * br * mix(.12, 1., uOpen) * mix(.75, 1., uGap);
  vec2 gp = css / uLen;
  float lf = fbm3(gp * 1.4 + vec2(t * .011, -t * .006) + 7.3) - .5;
  float hf = fbm3(gp * 5.4 + vec2(-t * .018, t * .012) + 2.1) - .5;
  float dg = dseg + uSkew * side + lf * R * 1.6 + hf * R * 1.15 - hh * (1. - hh) * R * .6;
  float gapF = 1. - smoothstep(R * .25, R * 2.1, dg);
  float dStar = min(min(length(css - uA), length(css - uB)), length(css - uF));
  gapF = max(gapF, 1. - smoothstep(R * .15, R * .6, dStar));

  // спокойная гряда под текстом: темнее, но с фактурой
  vec2 tc = .5 * (uText.xy + uText.zw), th = .5 * (uText.zw - uText.xy);
  vec2 qd = abs(css - tc) - th;
  float sdf = length(max(qd, 0.)) + min(max(qd.x, qd.y), 0.);
  float calm = 1. - smoothstep(-30., 150., sdf);

  float raw = mix(n, .6 + (lo - .5) * .5, calm * .4);
  raw -= gapF * .7;
  float dens = smoothstep(.2, .5, raw);
  float body = smoothstep(.3, .8, raw);
  float shade = clamp(.5 + (lo - loL) * 7., 0., 1.);

  float moon = exp(-length((css - uMoon) / uView.y) * 1.6);
  float city = exp(-(1. - hgt) * 1.6);
  float nearGap = 1. - smoothstep(R * .9, R * 2.6, dg);

  vec3 cHi   = vec3(.136, .144, .158);   // холодный графит в зените
  vec3 cLo   = vec3(.212, .198, .184);   // тёплый серый над городом
  vec3 cBody = mix(cHi, cLo, smoothstep(.12, .95, hgt));
  vec3 cSeam = cBody * .52 + vec3(.01, .011, .014);
  vec3 cLit  = vec3(.31, .325, .35);
  vec3 cRim  = vec3(.6, .62, .66);
  vec3 cCity = vec3(.36, .32, .28);
  vec3 pearl = vec3(.94, .89, .81);

  vec3 col = mix(cSeam, cBody, body);
  col *= .84 + .32 * shade;
  col = mix(col, cLit, shade * shade * (.05 + .26 * moon + .3 * nearGap) * (1. - calm * .9));
  // город греет брюхо облаков
  col += cCity * city * body * (1. - shade * .55) * .46 * (1. - calm * .32);
  float rim = dens * (1. - dens) * 4.;
  col += cRim * rim * (.02 + .22 * nearGap + .1 * moon) * (.4 + .6 * shade) * (1. - calm * .85);
  // тёплое дыхание присутствия ложится на кромки рядом со звездой
  float wA = aura(css, uA, uPresA * (.65 + .35 * uBreA) * (1. + .25 * uWatch.x));
  float wB = aura(css, uB, uPresB * (.65 + .35 * uBreB) * (1. + .25 * uWatch.y));
  col += pearl * (rim * 1.8 + body * .35) * (wA + wB);
  col *= 1. - calm * .28;

  // верхняя пелена: тонкие волокна, вытянутые ветром
  vec2 PV = vec2(d.x, d.z) * (2.6 * tP) * uCloud.x;
  vec2 qv = PV * vec2(.3, .62) + vec2(-t * .004, t * .001) + (w - .5) * .3;
  float vn = fbm4(qv);
  float gapW = 1. - smoothstep(R * .4, R * 2.2, dg);
  float starCore = 1. - smoothstep(R * .12, R * .45, dStar);
  float veil = smoothstep(.46, .8, vn) * (1. - gapW * .4) * mix(.4, 1., smoothstep(8., 3.5, tP));
  // одна-две тонкие пряди пересекают просвет между звёздами
  vec2 rel = (css - uF) / uLen;
  vec2 wq = vec2(rel.x * .98 + rel.y * .2, rel.y * .98 - rel.x * .2);
  float wn = fbm4(vec2(wq.x * 1.5 - t * .012, wq.y * 7.5 + wq.x * .8) + 4.2);
  float wisp = smoothstep(.62, .84, wn) * gapW;
  veil = max(veil, wisp * .48) * (1. - starCore * .9);
  vec3 cVeil = mix(vec3(.205, .212, .228), vec3(.25, .232, .214), hgt) + vec3(.05, .055, .062) * moon + vec3(.05, .052, .056) * gapW;

  float aV = veil * .5;
  vec3 pm = cVeil * aV; float a = aV;
  float aL = max(dens, calm * .97);   // под текстом гряда плотная: звёзды сквозь неё не светят
  pm = col * aL + pm * (1. - aL); a = aL + a * (1. - aL);

  // свет звёзд в дымке: Альнилам — ровное серебро, огни людей — тёплый жемчуг и дыхание
  float tr = (1. - aL * .9);
  vec3 silver = vec3(.83, .87, .93);
  float kA = (1. + .3 * (uBreA - .5) * uPresA) * (1. + .2 * uWatch.x * uBreA * uPresA);
  float kB = (1. + .3 * (uBreB - .5) * uPresB) * (1. + .2 * uWatch.y * uBreB * uPresB);
  vec3 glow = silver * halo(css, uF, 1.3, veil)
            + mix(silver, pearl, uPresA * .92) * halo(css, uA, .8 * kA, veil)
            + mix(silver, pearl, uPresB * .92) * halo(css, uB, .88 * kB, veil);
  for (int i = 0; i < 4; i++){
    vec4 s = uStar[i];
    float tw = .8 + .2 * sin(t * 2.3 + float(i) * 1.9) * sin(t * .7 + float(i));
    glow += mix(silver, pearl, s.w * .92) * halo(css, s.xy, s.z * .55 * tw * (1. + .3 * s.w * (uBreA - .5)), veil) * (1. - body * .85);
  }
  glow += pearl * (wA + wB) * .7;
  pm += glow * tr;

  // дымка у горизонта, подсвеченная городом
  vec3 cHaze = mix(vec3(.2, .19, .178), vec3(.385, .342, .298), smoothstep(.55, 1., hgt));
  pm = mix(pm, cHaze * (1. - calm * .18), fog); a = mix(a, 1., fog);

  // дымок из трубы: поднимается и сносится ветром туда же, куда плывут облака
  if (uSmoke.w > 0.) {
    vec2 s0 = css - uSmoke.xy; float Hs = uSmoke.z;
    if (s0.y < 1. && s0.y > -Hs && s0.x > -Hs * .35 && s0.x < Hs * 1.15) {
      float u = max(-s0.y, 0.) / Hs;
      float sway = (fbm3(vec2(u * 2.4 - t * .22, 3.1)) - .5) * Hs * .22 * u;
      float xc = Hs * .66 * pow(u, 1.75) + sway;
      float wd = Hs * (.022 + .2 * u);
      float dx = (s0.x - xc) / wd;
      float tn = fbm4(vec2(s0.x - t * Hs * .05, s0.y + t * Hs * .12) / Hs * 5.2 + 5.);
      float puff = .35 + .65 * smoothstep(.34, .68, tn + .2 * (1. - u));
      float smk = exp(-dx * dx * 1.2) * puff * smoothstep(0., .05, u) * pow(1. - u, 1.25) * uSmoke.w;
      pm = mix(pm, vec3(.43, .405, .376), smk); a = mix(a, 1., smk);
    }
  }

  pm += (h12(gl_FragCoord.xy + fract(t * 7.3) * 91.) - .5) / 255. * 1.3;
  gl_FragColor = vec4(max(pm, 0.), clamp(a, 0., 1.));
}`;

  /* ------------------------------------------------------------------ *
   *  Тот же шум на JS — для неподвижной гряды без WebGL.
   * ------------------------------------------------------------------ */
  const fr = (x) => x - Math.floor(x);
  let hx = 0, hy = 0;
  function h22(x, y) {
    let a = fr(x * 0.1031), b = fr(y * 0.103), c = fr(x * 0.0973);
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d; b += d; c += d;
    hx = fr((a + b) * c); hy = fr((a + c) * b);
  }
  function gn(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    h22(ix, iy); const a = (hx * 2 - 1) * fx + (hy * 2 - 1) * fy;
    h22(ix + 1, iy); const b = (hx * 2 - 1) * (fx - 1) + (hy * 2 - 1) * fy;
    h22(ix, iy + 1); const c = (hx * 2 - 1) * fx + (hy * 2 - 1) * (fy - 1);
    h22(ix + 1, iy + 1); const d = (hx * 2 - 1) * (fx - 1) + (hy * 2 - 1) * (fy - 1);
    const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }
  let fbLo = 0;
  function fbm(x, y, oct, lod, extra) {
    let s = 0, a = 0.5; fbLo = 0;
    for (let i = 0; i < oct; i++) {
      const w = i < 3 ? 1 : (i < 5 ? lod : lod * extra);
      s += a * gn(x, y) * w;
      if (i === 2) fbLo = s;
      const nx = 1.6 * x - 1.2 * y + 3.1, ny = 1.2 * x + 1.6 * y + 1.7;
      x = nx; y = ny; a *= 0.5;
    }
    fbLo += 0.5;
    return 0.5 + s;
  }

  function mount(opts) {
    const root = (opts && opts.root) || document.body;
    const onLayout = opts && typeof opts.onLayout === 'function' ? opts.onLayout : null;
    const anchor = [...root.children].find((el) => el.id === 'labels' || el.classList.contains('scene-labels')) || null;
    if (getComputedStyle(root).position === 'static') { root.style.position = 'fixed'; root.style.inset = '0'; }

    const layer = (full = true) => {
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      const s = c.style;
      s.position = 'absolute'; s.left = '0'; s.top = '0'; s.display = 'block'; s.pointerEvents = 'none';
      if (full) { s.width = '100%'; s.height = '100%'; }
      root.insertBefore(c, anchor);
      return c;
    };
    // снизу вверх: небо со звёздами → Пояс → облака → (без WebGL: гряда и огни) → крыши → окно → стекло
    const skyC = layer(), beltC = layer(false), deck = layer(), deck2 = layer(), auraC = layer(false), near = layer(), hearthC = layer(false), glass = layer();
    deck2.style.display = 'none'; auraC.style.display = 'none';
    // зазоры от выреза и «чёлки»: читаем env() через невидимую пробу
    const probe = document.createElement('div');
    Object.assign(probe.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', visibility: 'hidden', pointerEvents: 'none',
      paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)' });
    root.insertBefore(probe, anchor);

    let W = 0, H = 0, OX = 0, OY = 0, DPR = 1, P = false, sc = 1, S = 150, BX = 0, BY = 0;
    let A = [0, 0], F = [0, 0], B = [0, 0], LEN = 1, EX = [], coreR = [2, 2, 2];
    let calm = [0, 0, 0, 0], smoke = [0, 0, 0, 0], safe = [0, 0, 0, 0], hearthAt = null;
    const fieldArr = new Float32Array(16);
    const fieldSlot = [-1, -1, -1, -1];
    let hasExtras = false;

    const T0 = performance.now();
    const tween = (v) => ({ from: v, to: v, t0: -1e9 });
    const tv = (o, now) => { const u = (now - o.t0) / FADE; if (u >= 1) return o.to; const e = u <= 0 ? 0 : u * u * (3 - 2 * u); return o.from + (o.to - o.from) * e; };
    const retarget = (o, to, now) => { if (o.to === to) return; o.from = tv(o, now); o.to = to; o.t0 = now; };
    const slots = Array.from({ length: 6 }, () => ({ id: null, pres: tween(0), watch: tween(0), joined: -1e9 }));
    const gap = tween(1); // без людей (страница входа) просвет раскрыт целиком
    let lastChange = -1e9;
    const pres = new Float32Array(6), watch = new Float32Array(6);

    const reduced = () => reduceMotion.matches;
    const place = (s) => [BX - s.X * S, BY - s.Y * S];

    /* ---------------- раскладка ---------------- */
    function measure() {
      const r = root.getBoundingClientRect();
      OX = r.left; OY = r.top;
      W = Math.round(r.width) || innerWidth; H = Math.round(r.height) || innerHeight;
      P = H > W * 1.1;
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const cs = getComputedStyle(probe);
      safe = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => parseFloat(v) || 0);
      sc = P ? 0.7 : clamp(H / 820, 0.62, 1);
    }

    function layout() {
      // спокойный угол под текст: слева внизу на широком экране, вся нижняя часть на телефоне
      if (P) {
        const bot = H - Math.max(68, safe[2] + 56);
        // на коротком телефоне текст занимает больше половины экрана — Пояс поднимается и чуть сжимается
        calm = [14, Math.max(H * 0.4, bot - 360), W - 14, bot];
      } else {
        const gx = Math.max(clamp(W * 0.06, 24, 92), safe[3] + 20);
        const bot = H - 84 * sc - (H <= 760 ? 22 : 38) + 6;
        calm = [gx - 10, Math.max(bot - 300, H * 0.3), gx + Math.min(560, W * 0.46) + 10, bot];
      }
      const ys = [MINTAKA.Y, ALNILAM.Y, ALNITAK.Y], up = Math.max(...ys), down = -Math.min(...ys);
      if (P) {
        // телефон: Пояс посередине сверху, над текстом и подальше от крыш
        S = Math.min(W * 0.25, H * 0.118); BX = W * 0.5; BY = H * 0.285;
        const topMin = safe[0] + 84, botMax = calm[1] - 46;
        if ((up + down) * S > botMax - topMin) S = Math.max(36, (botMax - topMin) / (up + down));
        BY = Math.min(Math.max(BY, topMin + up * S), botMax - down * S);
      } else {
        // широкий экран: Пояс справа вверху, Альнитак не заходит в колонку текста
        S = Math.min(W * 0.104, H * 0.168);
        BX = W * (0.72 - 0.12 * clamp((W - 900) / 540, 0, 1)); BY = H * 0.345;
        const xMax = W - safe[1] - 170, xa = -MINTAKA.X, xb = ALNITAK.X;
        if (BY - ALNITAK.Y * S > calm[1] - 90) {
          BX = Math.max(BX, calm[2] + 40 + xb * S);
          if (BX + xa * S > xMax) { S = Math.max(36, (xMax - calm[2] - 40) / (xa + xb)); BX = calm[2] + 40 + xb * S; }
        }
        BY = Math.max(BY, safe[0] + 44 + up * S);
        BY = Math.min(BY, H - 84 * sc - 70 - down * S);
      }
      A = place(MINTAKA); F = place(ALNILAM); B = place(ALNITAK);
      LEN = Math.hypot(A[0] - B[0], A[1] - B[1]);
      EX = EXTRA.map(place);
      const k = P ? 0.86 : 1;
      coreR = [MINTAKA, ALNITAK, ALNILAM].map((s) => {
        const f = Math.pow(10, -0.4 * (s.v - 1.7));
        return Math.max((0.55 + 1.55 * f) * k, (6 + 9 * f) * k * 0.3);
      });
      pickField();
    }
    const onScreen = (p, m) => p[0] > -m && p[0] < W + m && p[1] > -m && p[1] < H + m;

    // четыре ярких звезды для мерцания в шейдере; огни третьего и дальше — в первую очередь
    function pickField() {
      const list = [];
      hasExtras = false;
      for (let i = 2; i < 6 && list.length < 4; i++) {
        if (slots[i].id == null || !onScreen(EX[i - 2], 0)) continue;
        list.push([EX[i - 2], EXTRA[i - 2], i]); hasExtras = true;
      }
      for (const s of STARS) {
        if (list.length >= 4) break;
        if (s.v >= 3.95 || BELT.has(s) || list.some((e) => e[1] === s)) continue;
        const p = place(s);
        if (onScreen(p, 40)) list.push([p, s, -1]);
      }
      for (let j = 0; j < 4; j++) {
        const e = list[j];
        fieldArr[j * 4] = e ? e[0][0] : -9999; fieldArr[j * 4 + 1] = e ? e[0][1] : -9999;
        fieldArr[j * 4 + 2] = e ? Math.pow(10, -0.4 * (e[1].v - 2.0)) : 0; fieldArr[j * 4 + 3] = 0;
        fieldSlot[j] = e ? e[2] : -1;
      }
    }

    function fit(cv, w, h, dpr) {
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw) cv.width = pw;
      if (cv.height !== ph) cv.height = ph;
      const g = cv.getContext('2d');
      g.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0);
      return g;
    }

    /* ---------------- небо и звёзды: статично ---------------- */
    function drawSky() {
      const g = fit(skyC, W, H, DPR);
      // градиент с лёгким дизерингом считаем в CSS-пикселях — тёмное небо не ложится полосами
      const tile = document.createElement('canvas');
      const tw = Math.max(1, Math.min(W, 1600)), th = Math.max(1, Math.round(H * tw / W));
      tile.width = tw; tile.height = th;
      const tg = tile.getContext('2d', { willReadFrequently: true });
      const lg = tg.createLinearGradient(0, 0, 0, th);
      lg.addColorStop(0, '#0a0b0e'); lg.addColorStop(0.55, '#0c0d10'); lg.addColorStop(0.8, '#141413'); lg.addColorStop(1, '#2a2623');
      tg.fillStyle = lg; tg.fillRect(0, 0, tw, th);
      try {
        const img = tg.getImageData(0, 0, tw, th), d = img.data;
        let s = 1234567;
        for (let i = 0; i < d.length; i += 4) {
          s = (s * 1103515245 + 12345) & 0x7fffffff; const n = ((s >> 16) & 3) - 1.5;
          d[i] += n; d[i + 1] += n; d[i + 2] += n;
        }
        tg.putImageData(img, 0, 0);
      } catch (e) { /* без дизеринга тоже живём */ }
      g.imageSmoothingEnabled = true;
      g.drawImage(tile, 0, 0, W, H);

      g.globalCompositeOperation = 'lighter';
      for (const s of STARS) {
        if (BELT.has(s)) continue;
        const [x, y] = place(s);
        if (!onScreen([x, y], 30)) continue;
        const [r, gg, b] = kelvinTint(s.k);
        const f = Math.pow(10, -0.4 * (s.v - 2.0));
        const core = 0.48 + 0.34 * Math.pow(Math.max(0, 6.9 - s.v), 0.95);
        // слабые звёзды скопления Collinder 70 чуть светлее: просвет читается как небо, а не как тёмная туча
        const peak = Math.min(1, (0.14 + 0.9 * Math.sqrt(f)) * (s.v > 4 ? 1.4 : 1));
        const R = core * 2.3;
        let grd = g.createRadialGradient(x, y, 0, x, y, R);
        grd.addColorStop(0, `rgba(${r},${gg},${b},${peak})`);
        grd.addColorStop(0.22, `rgba(${r},${gg},${b},${peak * 0.78})`);
        grd.addColorStop(0.5, `rgba(${r},${gg},${b},${peak * 0.26})`);
        grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, R, 0, 7); g.fill();
        if (s.v < 4.4) {
          const R2 = 5 + 7 * (4.4 - s.v), a2 = 0.06 * (4.4 - s.v) / 2.6;
          grd = g.createRadialGradient(x, y, 0, x, y, R2);
          grd.addColorStop(0, `rgba(${r},${gg},${b},${a2})`); grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
          g.fillStyle = grd; g.beginPath(); g.arc(x, y, R2, 0, 7); g.fill();
        }
      }
      g.globalCompositeOperation = 'source-over';
    }

    /* ---------------- Пояс: свой маленький холст, перерисовывается только при смене огней ---------------- */
    let beltBox = [0, 0, 1, 1], beltDrawn = [-1, -1];
    function sizeBelt() {
      const pad = 26;
      const x0 = Math.floor(Math.min(A[0], F[0], B[0]) - pad), y0 = Math.floor(Math.min(A[1], F[1], B[1]) - pad);
      const x1 = Math.ceil(Math.max(A[0], F[0], B[0]) + pad), y1 = Math.ceil(Math.max(A[1], F[1], B[1]) + pad);
      beltBox = [x0, y0, x1 - x0, y1 - y0];
      Object.assign(beltC.style, { left: x0 + 'px', top: y0 + 'px', width: beltBox[2] + 'px', height: beltBox[3] + 'px' });
      beltC.width = Math.round(beltBox[2] * DPR); beltC.height = Math.round(beltBox[3] * DPR);
      beltDrawn = [-1, -1];
    }
    function drawBelt(pA, pB) {
      if (Math.abs(pA - beltDrawn[0]) < 0.004 && Math.abs(pB - beltDrawn[1]) < 0.004) return;
      beltDrawn = [pA, pB];
      const g = beltC.getContext('2d');
      g.setTransform(DPR, 0, 0, DPR, -beltBox[0] * DPR, -beltBox[1] * DPR);
      g.clearRect(beltBox[0], beltBox[1], beltBox[2], beltBox[3]);
      g.globalCompositeOperation = 'lighter';
      const k = P ? 0.86 : 1;
      // размер — от настоящего блеска: Альнилам (1.70) крупнее всех; тепло — у тех, кто здесь
      for (const [s, p, w] of [[ALNILAM, F, 0], [ALNITAK, B, pB], [MINTAKA, A, pA]]) {
        const f = Math.pow(10, -0.4 * (s.v - 1.7));
        const c = [228 + 27 * w, 236 + 4 * w, 252 - 32 * w].map(Math.round).join(',');
        const R1 = (6 + 9 * f) * k;
        const grd = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], R1);
        grd.addColorStop(0, `rgba(${c},${0.5 + 0.2 * f})`); grd.addColorStop(0.3, `rgba(${c},${0.15 + 0.06 * f})`); grd.addColorStop(1, `rgba(${c},0)`);
        g.fillStyle = grd; g.beginPath(); g.arc(p[0], p[1], R1, 0, 7); g.fill();
        g.fillStyle = `rgb(${Math.round(250 + 5 * w)},${Math.round(252 - 3 * w)},${Math.round(255 - 15 * w)})`;
        g.beginPath(); g.arc(p[0], p[1], (0.55 + 1.55 * f) * k, 0, 7); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }

    /* ---------------- крыши у нижнего края: цинк, трубы, антенны, шпиль ---------------- */
    function shape(b, type, r, hb, s) {
      const x = b.x, w = b.w; b.type = type;
      if (type === 'wall') { // брандмауэр — глухая торцевая стена выше соседей
        b.top = H - hb * (1.1 + r() * 0.22); b.pts = [[x, b.top], [x + w, b.top]];
      } else if (type === 'hip') { // пологая жестяная кровля
        b.top = H - hb * (0.6 + r() * 0.4);
        const rise = (3 + r() * 5) * s, ins = Math.min(w * (0.04 + r() * 0.06), 9 * s);
        b.pts = [[x, b.top], [x + ins, b.top - rise], [x + w - ins, b.top - rise], [x + w, b.top]];
      } else if (type === 'mans') { // мансарда: крутой низ, пологий верх
        b.top = H - hb * (0.55 + r() * 0.3);
        const r1 = (7 + r() * 6) * s, i1 = (2.5 + r() * 2.5) * s, r2 = (2 + r() * 2.5) * s, i2 = w * 0.16;
        b.pts = [[x, b.top], [x + i1, b.top - r1], [x + i1 + i2, b.top - r1 - r2], [x + w - i1 - i2, b.top - r1 - r2], [x + w - i1, b.top - r1], [x + w, b.top]];
      } else { // низкий щипец
        b.top = H - hb * (0.58 + r() * 0.3);
        const rise = (6 + r() * 6) * s;
        b.pts = [[x, b.top], [x + w / 2, b.top - rise], [x + w, b.top]];
      }
      b.ridge = Math.min(...b.pts.map((p) => p[1]));
      return b;
    }
    function row(r, hb, s, far) {
      const out = []; let x = -12 - r() * 30;
      while (x < W + 12) {
        const k = r();
        const type = !far && k < 0.1 ? 'wall' : k < 0.62 ? 'hip' : k < 0.86 ? 'mans' : 'gable';
        const w = (type === 'wall' ? 20 + r() * 26 : type === 'gable' ? 34 + r() * 46 : far ? 80 + r() * 140 : 56 + r() * 100) * s;
        out.push(shape({ x, w }, type, r, hb, s));
        x += w;
      }
      return out;
    }
    function yAt(b, x) {
      const p = b.pts;
      if (x <= p[0][0]) return p[0][1];
      for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const u = (x - p[i - 1][0]) / ((p[i][0] - p[i - 1][0]) || 1); return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u; }
      return p[p.length - 1][1];
    }
    const at = (rw, x) => rw.find((b) => x >= b.x && x < b.x + b.w) || rw[rw.length - 1];
    function fillB(g, b) { g.beginPath(); g.moveTo(b.x, H + 2); for (const [px, py] of b.pts) g.lineTo(px, py); g.lineTo(b.x + b.w, H + 2); g.closePath(); }
    function stacks(g, r, b, s, n0, far) {
      let cx = b.x + b.w * (0.16 + r() * 0.6);
      const n = n0 || 1 + Math.floor(r() * (far ? 2 : 4)), ch = (5 + r() * 9) * s;
      for (let j = 0; j < n; j++) {
        const cw = (2.6 + r() * 2.4) * s, ry = yAt(b, cx + cw / 2), hj = ch * (0.82 + r() * 0.3);
        if (cx + cw > b.x + b.w - 3 * s) break;
        g.fillRect(cx, ry - hj, cw, hj + 4);
        g.fillRect(cx - 0.7 * s, ry - hj - 1.3 * s, cw + 1.4 * s, 1.4 * s);
        if (!far) { g.save(); g.fillStyle = 'rgba(150,140,126,.2)'; g.fillRect(cx - 0.7 * s, ry - hj - 1.3 * s, cw + 1.4 * s, 0.6); g.restore(); }
        cx += cw + (1.3 + r() * 1.8) * s;
      }
    }
    function antenna(g, x, y, h, s) {
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x, y - h);
      const boom = (L, yy, el) => {
        g.moveTo(x - L * 0.3, yy); g.lineTo(x + L * 0.7, yy);
        for (let i = 0; i < el; i++) { const ex = x - L * 0.3 + L * i / (el - 1), eh = (3 - i * 0.32) * s; g.moveTo(ex, yy - eh); g.lineTo(ex, yy + eh); }
      };
      boom(17 * s, y - h + 1, 6);
      boom(10 * s, y - h * 0.6, 4);
      g.stroke();
    }

    function drawNear() {
      const g = fit(near, W, H, DPR);
      g.clearRect(0, 0, W, H);
      const s = sc;
      const hbFar = (P ? 42 : 74 * s), hbMid = (P ? 33 : 57 * s), hbNear = (P ? 25 : 42 * s);
      const rFar = rng(11), rMid = rng(31), rNear = rng(5), rDet = rng(23);
      const farRow = row(rFar, hbFar, s, true);
      const midRow = row(rMid, hbMid, s, true);
      const nearRow = row(rNear, hbNear, s, false);

      // слуховое окно — под звездой смотрящего; труба с дымком — по ветру, вправо
      const tx = Math.round(Math.min(W * 0.92, Math.max(W * (P ? 0.25 : 0.55), A[0])));
      const sx = Math.round(W * (P ? 0.86 : 0.83));
      for (const x of [tx, sx]) { const b = at(nearRow, x); if (b.type === 'wall' || b.type === 'gable' || b.w < 40 * s) shape(b, 'hip', rNear, hbNear, s); }

      // дальний ряд тонет в городской дымке; среди него — игла шпиля
      const farFill = g.createLinearGradient(0, H - hbFar * 1.1, 0, H);
      farFill.addColorStop(0, '#34302d'); farFill.addColorStop(1, '#3b3631');
      g.fillStyle = farFill;
      for (const b of farRow) { fillB(g, b); g.fill(); }
      for (const b of farRow) if (rFar() < 0.5) stacks(g, rFar, b, s * 0.8, 0, true);
      const spx = Math.round(W * (P ? 0.2 : 0.585)), sb = at(farRow, spx), stop = Math.min(yAt(sb, spx), H - hbFar * 0.8);
      const twr = (P ? 12 : 24) * s, drum = (P ? 4 : 7) * s, ndl = (P ? 18 : 50) * s, tw = (P ? 7 : 9) * s;
      g.fillRect(spx - tw / 2, stop - twr, tw, twr + 4);
      g.fillRect(spx - tw * 0.32, stop - twr - drum, tw * 0.64, drum);
      g.beginPath(); g.moveTo(spx - 1.5 * s, stop - twr - drum); g.lineTo(spx, stop - twr - drum - ndl); g.lineTo(spx + 1.5 * s, stop - twr - drum); g.closePath(); g.fill();

      // средний ряд — ближе и темнее
      g.fillStyle = '#1e1d1c';
      for (const b of midRow) { fillB(g, b); g.fill(); }
      for (const b of midRow) if (rMid() < 0.6) stacks(g, rMid, b, s * 0.9, 0, true);

      // тусклые тёплые окна в дальних рядах — только там, где их не заслоняют ближние
      const frontTop = (rows, x) => Math.min(...rows.map((rw) => { const b = at(rw, x); return Math.min(yAt(b, x - 5), yAt(b, x + 5)); }));
      let made = 0;
      for (let tries = 0; tries < 200 && made < (P ? 3 : 5); tries++) {
        const wx = 20 + rDet() * (W - 40), inMid = made >= (P ? 2 : 3);
        if (Math.abs(wx - spx) < 16 || Math.abs(wx - tx) < 40 || Math.abs(wx - sx) < 30) continue;
        const own = at(inMid ? midRow : farRow, wx);
        const wy = own.top + (4 + rDet() * 5) * s;
        if (wy + 4 * s > frontTop(inMid ? [nearRow] : [midRow, nearRow], wx) - 1.5) continue;
        const pair = rDet() < 0.45, ww = 1.9 * s, wh = 2.6 * s;
        const gl = g.createRadialGradient(wx, wy, 0, wx, wy, 8 * s);
        gl.addColorStop(0, 'rgba(217,196,160,.08)'); gl.addColorStop(1, 'rgba(217,196,160,0)');
        g.fillStyle = gl; g.fillRect(wx - 9 * s, wy - 9 * s, 18 * s, 18 * s);
        g.fillStyle = `rgba(217,196,160,${((inMid ? 0.42 : 0.3) + rDet() * 0.14).toFixed(2)})`;
        g.fillRect(wx, wy, ww, wh); if (pair) g.fillRect(wx + ww + 2.4 * s, wy, ww, wh);
        made++;
      }

      // ближний ряд: тёмный цинк, мокрый блик на коньках ловит свет города
      g.fillStyle = '#0c0d0e';
      for (const b of nearRow) { fillB(g, b); g.fill(); }
      for (const b of nearRow) {
        if (b.type === 'wall') continue;
        g.save(); fillB(g, b); g.clip();
        const sh = g.createLinearGradient(0, b.ridge, 0, b.ridge + 9 * s);
        sh.addColorStop(0, 'rgba(132,123,112,.13)'); sh.addColorStop(1, 'rgba(132,123,112,0)');
        g.fillStyle = sh; g.fillRect(b.x, b.ridge, b.w, 9 * s);
        g.restore();
        g.beginPath(); b.pts.forEach(([px, py], i) => (i ? g.lineTo(px, py + 0.6) : g.moveTo(px, py + 0.6)));
        g.strokeStyle = 'rgba(166,155,140,.24)'; g.lineWidth = 1; g.stroke();
      }
      g.fillStyle = '#0c0d0e';
      for (const b of nearRow) {
        if (Math.abs(b.x + b.w / 2 - tx) < b.w * 0.6) continue;
        const groups = b.type === 'wall' ? (rNear() < 0.6 ? 1 : 0) : Math.floor(rNear() * 2.4);
        for (let k = 0; k < groups; k++) stacks(g, rNear, b, s, 0, false);
      }

      // труба, из которой идёт дым (сам дым рисует шейдер облаков)
      {
        const b = at(nearRow, sx), cw = 5 * s, ry = yAt(b, sx), hj = (P ? 12 : 17) * s;
        g.fillRect(sx - cw / 2, ry - hj, cw, hj + 4);
        g.fillRect(sx - cw / 2 - 0.8 * s, ry - hj - 1.5 * s, cw + 1.6 * s, 1.5 * s);
        g.fillRect(sx + cw / 2 + 1.6 * s, ry - hj * 0.7, cw * 0.8, hj * 0.7 + 4); // соседка пониже
        g.fillRect(sx + cw / 2 + 0.9 * s, ry - hj * 0.7 - 1.3 * s, cw * 0.8 + 1.4 * s, 1.3 * s);
        smoke = [sx, ry - hj - 1.5 * s, P ? 46 : 128 * s, P ? 0.5 : 0.56];
      }

      // слуховое окно смотрящего; само окно светится на своём холсте и дышит в такт звезде
      {
        const b = at(nearRow, tx), ry = Math.round(yAt(b, tx)), dw = 10 * s, dh = 12 * s, gh = 4.5 * s;
        g.beginPath();
        g.moveTo(tx - dw / 2, ry + dh); g.lineTo(tx - dw / 2, ry - 2 * s);
        g.lineTo(tx - dw / 2 - 1 * s, ry - 2 * s); g.lineTo(tx, ry - 2 * s - gh); g.lineTo(tx + dw / 2 + 1 * s, ry - 2 * s);
        g.lineTo(tx + dw / 2, ry - 2 * s); g.lineTo(tx + dw / 2, ry + dh); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(tx - dw / 2 - 1 * s, ry - 1.4 * s); g.lineTo(tx, ry - 1.4 * s - gh); g.lineTo(tx + dw / 2 + 1 * s, ry - 1.4 * s);
        g.strokeStyle = 'rgba(170,158,142,.3)'; g.stroke();
        const ws = P ? 0.8 : Math.max(0.8, s);
        hearthAt = { x: tx, y: ry + 2.6 * s + 3.25 * ws, s: ws, spill: [tx, ry + 7 * s, 22 * s] };
        g.fillStyle = '#0c0d0e';
      }

      // старые телевизионные антенны
      g.strokeStyle = '#0c0d0e'; g.lineWidth = Math.max(0.9, 1 * s);
      for (const fx of (P ? [0.56] : [0.37, 0.7])) {
        let x = Math.round(W * fx); if (Math.abs(x - tx) < 30) x += 40;
        const b = at(nearRow, x);
        antenna(g, x, yAt(b, x) + 1, (P ? 20 : 27) * s, s);
      }
    }

    /* ---------------- окно под крышей: свет комнаты дышит вместе со звездой ---------------- */
    let hearthBox = [0, 0, 1, 1], hearthPane = null, hearthGlow = null, hearthShown = -1;
    function sizeHearth() {
      const h = hearthAt, s = h.s, gw = 46 * s, ghh = 40 * s;
      // на холсте: ореол, само окно и тёплое пятно на мокром цинке под ним
      const x0 = Math.floor(h.x - 30 * s), y0 = Math.floor(h.y - 26 * s), w = Math.ceil(60 * s), hh = Math.ceil(60 * s);
      hearthBox = [x0, y0, w, hh];
      Object.assign(hearthC.style, { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: hh + 'px' });
      hearthC.width = Math.round(w * DPR); hearthC.height = Math.round(hh * DPR);
      const mk = () => { const c = document.createElement('canvas'); c.width = hearthC.width; c.height = hearthC.height; const g = c.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, -x0 * DPR, -y0 * DPR); return [c, g]; };
      let g;
      [hearthGlow, g] = mk();
      g.save(); g.translate(h.x, h.y); g.scale(1, ghh / gw);
      let gr = g.createRadialGradient(0, 0, 0, 0, 0, gw / 2);
      gr.addColorStop(0, 'rgba(217,196,160,.2)'); gr.addColorStop(0.55, 'rgba(217,196,160,.06)'); gr.addColorStop(1, 'rgba(217,196,160,0)');
      g.fillStyle = gr; g.fillRect(-gw / 2, -gw / 2, gw, gw); g.restore();
      const [sx, sy, sr] = h.spill;
      gr = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      gr.addColorStop(0, 'rgba(217,196,160,.07)'); gr.addColorStop(1, 'rgba(217,196,160,0)');
      g.fillStyle = gr; g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
      [hearthPane, g] = mk();
      const pw = 5 * s, ph = 6.5 * s, px = h.x - pw / 2, py = h.y - ph / 2;
      g.fillStyle = '#d9c4a0'; g.fillRect(px, py, pw, ph);
      g.fillStyle = '#0c0d0e'; // переплёт
      g.fillRect(px + 2 * s, py, 1 * s, ph); g.fillRect(px, py + 2.2 * s, pw, 0.9 * s);
      hearthShown = -1;
    }
    function drawHearth(p, b) {
      const key = p < 0.002 ? 0 : p * 1000 + b;
      if (key === hearthShown) return;
      hearthShown = key;
      const g = hearthC.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, hearthC.width, hearthC.height);
      if (!key) return;
      g.globalAlpha = p * (0.38 + 0.62 * b); g.drawImage(hearthGlow, 0, 0);
      g.globalAlpha = p * (0.62 + 0.38 * b); g.drawImage(hearthPane, 0, 0);
      g.globalAlpha = 1;
    }

    /* ---------------- стекло: запотевшие нижние углы и несколько капель ---------------- */
    let drops = [], runner = null, glassCtx = null;
    function drawDrop(g, x, y, r, a) {
      // капля чуть вытянута книзу; тёмная кромка — полное отражение на краю линзы
      const ry = r * 1.08;
      let gr = g.createRadialGradient(x, y, r * 0.55, x, y, r * 1.28);
      gr.addColorStop(0, 'rgba(8,9,10,0)'); gr.addColorStop(0.6, `rgba(8,9,10,${0.3 * a})`); gr.addColorStop(1, 'rgba(8,9,10,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r * 1.28, ry * 1.28, 0, 0, 7); g.fill();
      // линза переворачивает вид: тёплое зарево города наверху капли, тёмное небо — внизу
      gr = g.createLinearGradient(0, y - ry, 0, y + ry);
      gr.addColorStop(0, `rgba(222,206,184,${0.3 * a})`); gr.addColorStop(0.5, `rgba(160,150,138,${0.1 * a})`); gr.addColorStop(1, `rgba(30,31,34,${0.18 * a})`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r * 0.9, ry * 0.9, 0, 0, 7); g.fill();
      g.strokeStyle = `rgba(236,224,206,${0.32 * a})`; g.lineWidth = Math.max(0.6, r * 0.14);
      g.beginPath(); g.ellipse(x, y + r * 0.06, r * 0.68, ry * 0.68, 0, Math.PI * 0.22, Math.PI * 0.78); g.stroke();
      // блик тёплой лампы из комнаты за спиной
      g.fillStyle = `rgba(255,246,232,${0.85 * a})`;
      g.beginPath(); g.ellipse(x - r * 0.34, y - ry * 0.4, Math.max(0.6, r * 0.2), Math.max(0.5, r * 0.15), -0.5, 0, 7); g.fill();
    }
    function mist(g, cx, cy, R, seed) {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      gr.addColorStop(0, 'rgba(214,202,186,.06)'); gr.addColorStop(0.55, 'rgba(214,202,186,.022)'); gr.addColorStop(1, 'rgba(214,202,186,0)');
      g.fillStyle = gr; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      const r = rng(seed), n = Math.round(R * 1.1);
      for (let i = 0; i < n; i++) { // мельчайший бисер конденсата
        const u = Math.pow(r(), 0.7), ang = r() * Math.PI * 2, x = cx + Math.cos(ang) * u * R, y = cy + Math.sin(ang) * u * R;
        if (x < 0 || x > W || y < 0 || y > H) continue;
        const a = 0.1 * Math.pow(1 - u, 1.6) * (0.4 + r());
        g.fillStyle = `rgba(226,216,200,${a.toFixed(3)})`;
        g.beginPath(); g.arc(x, y, 0.3 + r() * 0.5, 0, 7); g.fill();
      }
    }
    // капли — только низко, на фоне городского зарева: в небе их легко принять за звёзды,
    // а каждая звезда здесь настоящая. На телефоне капель нет, остаётся запотевший низ
    function layoutGlass() {
      const wide = !P && W >= 900 && H >= 560;
      const list = wide ? [[0.528, H - 100, 5.6], [0.676, H - 128, 3.2], [0.962, H - 140, 4.2], [0.988, H - 100, 2.6]] : [];
      drops = list.map(([fx, y, r]) => ({ x: fx * W, y, r })).filter((d) => d.x > calm[2] + 30);
      runner = wide ? { x: 0.93 * W, y0: H - 210, len: 64, r: 3.6 } : null;
    }
    function paintGlass(clip, run) {
      const g = glassCtx;
      g.save();
      if (clip) { g.beginPath(); g.rect(clip[0], clip[1], clip[2], clip[3]); g.clip(); g.clearRect(clip[0], clip[1], clip[2], clip[3]); }
      else g.clearRect(0, 0, W, H);
      mist(g, -W * 0.02, H * 1.02, P ? 190 : 330 * sc, 91);
      mist(g, W * 1.02, H * 1.02, P ? 160 : 280 * sc, 57);
      for (const d of drops) drawDrop(g, d.x, d.y, d.r, 1);
      if (run) {
        // мокрый след и бисеринки, оставшиеся по пути
        if (run.trail > 0.01 && run.y > runner.y0) {
          g.strokeStyle = `rgba(214,204,190,${(0.07 * run.trail).toFixed(3)})`; g.lineWidth = runner.r * 0.55; g.lineCap = 'round';
          g.beginPath(); g.moveTo(runner.x, runner.y0); g.lineTo(runner.x + (run.y - runner.y0) * 0.04, run.y - runner.r * 0.6); g.stroke();
          for (const f of [0.28, 0.61]) { const yy = runner.y0 + runner.len * f; if (yy < run.y - 4) drawDrop(g, runner.x + (yy - runner.y0) * 0.04, yy, runner.r * 0.32, run.trail); }
        }
        if (run.a > 0.01) drawDrop(g, runner.x + (run.y - runner.y0) * 0.04, run.y, runner.r * (run.y > runner.y0 + 1 ? 1.08 : 1), run.a);
      }
      g.restore();
    }
    // капля стекает раз в 25 секунд: короткими рывками, как настоящая
    const CYCLE = 25, RUN0 = 9;
    const KNOTS = [[0, 0], [0.22, 0.1], [0.34, 0.13], [0.6, 0.55], [0.72, 0.58], [1, 1]];
    function stair(u) {
      for (let i = 1; i < KNOTS.length; i++) if (u <= KNOTS[i][0]) {
        const [u0, y0] = KNOTS[i - 1], [u1, y1] = KNOTS[i], v = (u - u0) / (u1 - u0);
        return y0 + (y1 - y0) * v * v * (3 - 2 * v);
      }
      return 1;
    }
    const runSt = { y: 0, a: 1, trail: 0, live: false };
    function runState(t) {
      if (!runner) return null;
      const s = runSt, y0 = runner.y0, y1 = runner.y0 + runner.len;
      s.y = y0; s.a = 1; s.trail = 0; s.live = false;
      if (reduced() || t < RUN0) return s;
      const c = (t - RUN0) % CYCLE;
      if (c < 3.6) { s.y = y0 + runner.len * stair(c / 3.6); s.trail = 1; s.live = true; }
      else if (c < 12) { s.y = y1; s.trail = 1; }
      else if (c < 17) { const u = (c - 12) / 5; s.y = y1; s.a = 1 - u; s.trail = 1 - u; s.live = true; }
      else if (c < 21) { s.a = (c - 17) / 4; s.live = true; }
      return s;
    }
    let glassWasLive = false;
    const glassClip = [0, 0, 0, 0];
    function drawGlass(t) {
      glassCtx = fit(glass, W, H, DPR);
      paintGlass(null, runState(t));
      if (runner) { glassClip[0] = runner.x - 10; glassClip[1] = runner.y0 - 10; glassClip[2] = 20 + runner.len * 0.05; glassClip[3] = runner.len + 20; }
    }
    function tickGlass(t) {
      if (!glassCtx || !runner) return;
      const s = runState(t);
      if (!s.live && !glassWasLive) return;
      glassWasLive = s.live;
      paintGlass(glassClip, s);
    }

    /* ---------------- облака: WebGL ---------------- */
    let gl = null, glOK = false, U = {}, scale = 0.75;
    function setupGL() {
      glOK = false;
      try {
        gl = gl || deck.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      } catch (e) { gl = null; }
      if (!gl || gl.isContextLost()) return false;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
      const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
      if (!v || !f) return false;
      const prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      U = {};
      for (const n of ['uView', 'uScale', 'uTime', 'uA', 'uF', 'uB', 'uLen', 'uOpen', 'uBreA', 'uBreB', 'uPresA', 'uPresB', 'uGap', 'uWatch', 'uText', 'uStar', 'uCam', 'uMoon', 'uGapK', 'uSkew', 'uCloud', 'uSmoke']) U[n] = gl.getUniformLocation(prog, n);
      glOK = true;
      return true;
    }
    function sizeGL() {
      const dpr = window.devicePixelRatio || 1;
      // облака мягкие: им хватает пониженного разрешения; на телефоне чуть плотнее, чтобы кромки не мылились
      scale = dpr >= 2 ? (P ? 1.1 : 1) : 0.75;
      const maxPx = 1.0e6; if (W * H * scale * scale > maxPx) scale = Math.sqrt(maxPx / (W * H));
      deck.width = Math.max(1, Math.round(W * scale)); deck.height = Math.max(1, Math.round(H * scale));
      gl.viewport(0, 0, deck.width, deck.height);
      gl.uniform2f(U.uView, W, H); gl.uniform1f(U.uScale, deck.width / W);
      gl.uniform2f(U.uA, A[0], A[1]); gl.uniform2f(U.uF, F[0], F[1]); gl.uniform2f(U.uB, B[0], B[1]);
      gl.uniform1f(U.uLen, LEN);
      gl.uniform4f(U.uText, calm[0], calm[1], calm[2], calm[3]);
      gl.uniform4fv(U.uStar, fieldArr);
      const c = cam();
      gl.uniform2f(U.uCam, c.fovT, c.pitch);
      gl.uniform2f(U.uMoon, c.moon[0], c.moon[1]);
      gl.uniform1f(U.uGapK, c.gapK); gl.uniform1f(U.uSkew, c.skew);
      gl.uniform2f(U.uCloud, c.cloud[0], c.cloud[1]);
      gl.uniform4f(U.uSmoke, smoke[0], smoke[1], smoke[2], smoke[3]);
    }
    // камера, луна и характер гряды — общие для WebGL и для неподвижной 2D-версии
    function cam() {
      return {
        // горизонт прячется прямо за крышами
        fovT: Math.tan((P ? 39 : 30) * D2R), pitch: (P ? 38.6 : 30.9) * D2R,
        // луна — за грядой, далеко слева вверху: рассеянный холодный свет, без пятна
        moon: [-W * (P ? 0.25 : 0.12), -H * (P ? 0.16 : 0.3)],
        gapK: P ? 0.2 : 0.28, skew: P ? 0.22 : 0.12,
        // на узком экране ячейки мельче, чтобы в кадр помещалась гряда, а не одно пятно
        cloud: [P ? 1.7 : 1, P ? 1 : 0],
      };
    }

    /* ---------------- без WebGL: та же гряда, посчитанная один раз на JS ---------------- */
    let stillTimer = 0, auraSprite = null, auraBox = [0, 0, 1, 1];
    function still2d() {
      const t = 46, c = cam(), gv = tv(gap, performance.now());
      const n = 60000, kk = Math.min(1, Math.sqrt(n / (W * H)));
      const sw = Math.max(48, Math.round(W * kk)), sh = Math.max(48, Math.round(H * kk));
      const off = document.createElement('canvas'); off.width = sw; off.height = sh;
      const og = off.getContext('2d'), img = og.createImageData(sw, sh), px = img.data;
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const abx = A[0] - B[0], aby = A[1] - B[1], ab2 = abx * abx + aby * aby, nl = Math.sqrt(ab2), nbx = abx / nl, nby = aby / nl;
      const br = 1 + 0.045 * Math.sin(t * 0.56) + 0.02 * Math.sin(t * 0.21 + 1.3);
      const R = LEN * c.gapK * br * (0.75 + 0.25 * gv);
      const tcx = (calm[0] + calm[2]) / 2, tcy = (calm[1] + calm[3]) / 2, thx = (calm[2] - calm[0]) / 2, thy = (calm[3] - calm[1]) / 2;
      const sm = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
      const haloF = (x, y, cx, cy, k, veil) => { const r = Math.hypot(x - cx, y - cy) / LEN; return k * (Math.exp(-r * r * 1400) * 0.34 + Math.exp(-r * 19) * 0.09 + Math.exp(-r * 5.5) * 0.022) * (0.6 + veil * 1.4); };
      for (let j = 0; j < sh; j++) {
        for (let i = 0; i < sw; i++) {
          const x = (i + 0.5) * W / sw, y = (j + 0.5) * H / sh;
          let rx = (x - 0.5 * W) / (0.5 * H) * c.fovT, ry = (0.5 * H - y) / (0.5 * H) * c.fovT, rz = 1;
          const il = 1 / Math.hypot(rx, ry, rz); rx *= il; ry *= il; rz *= il;
          const dX = rx, dY = ry * cp + rz * sp, dZ = rz * cp - ry * sp;
          const tP = 1 / Math.max(dY, 0.012);
          const Px = dX * tP * c.cloud[0], Py = dZ * tP * c.cloud[0];
          const lod = sm(16, 5, tP), fog = 1 - Math.exp(-Math.max(tP - 1.5, 0) * 0.085), hgt = clamp(y / H, 0, 1);
          const qx = Px * 1.55 - t * 0.0105 + 3.7, qy = Py * 1.55 + t * 0.0022 + 1.9;
          const wx = fbm(qx * 0.32 + 1.7 + t * 0.004, qy * 0.32 + 9.2 + t * 0.004, 3, 1, 0);
          const wy = fbm(qx * 0.32 + 8.3 - t * 0.0035, qy * 0.32 + 2.8 - t * 0.0035, 3, 1, 0);
          const qwx = qx + (wx - 0.5) * 0.8, qwy = qy + (wy - 0.5) * 0.8;
          let nn = fbm(qwx, qwy, 7, lod, c.cloud[1]); const lo = fbLo;
          const loL = fbm(qwx + 0.075, qwy + 0.055, 3, 1, 0);
          const bl = Math.abs(gn(qwx * 2.3 + 11, qwy * 2.3 + 11)) * 1.4 + Math.abs(gn(qwx * 4.7 + 3, qwy * 4.7 + 3)) * 0.6;
          nn += (sm(0, 0.35, bl) - 0.7) * 0.07 * lod;
          // просвет
          const hh = clamp(((x - B[0]) * abx + (y - B[1]) * aby) / ab2, 0, 1);
          const dvx = x - B[0] - abx * hh, dvy = y - B[1] - aby * hh, dseg = Math.hypot(dvx, dvy), side = nbx * dvy - nby * dvx;
          const lf = fbm(x / LEN * 1.4 + t * 0.011 + 7.3, y / LEN * 1.4 - t * 0.006 + 7.3, 3, 1, 0) - 0.5;
          const hf = fbm(x / LEN * 5.4 - t * 0.018 + 2.1, y / LEN * 5.4 + t * 0.012 + 2.1, 3, 1, 0) - 0.5;
          const dg = dseg + c.skew * side + lf * R * 1.6 + hf * R * 1.15 - hh * (1 - hh) * R * 0.6;
          const dStar = Math.min(Math.hypot(x - A[0], y - A[1]), Math.hypot(x - B[0], y - B[1]), Math.hypot(x - F[0], y - F[1]));
          const gapF = Math.max(1 - sm(R * 0.25, R * 2.1, dg), 1 - sm(R * 0.15, R * 0.6, dStar));
          // спокойный угол под текстом
          const qdx = Math.abs(x - tcx) - thx, qdy = Math.abs(y - tcy) - thy;
          const sdf = Math.hypot(Math.max(qdx, 0), Math.max(qdy, 0)) + Math.min(Math.max(qdx, qdy), 0);
          const calmK = 1 - sm(-30, 150, sdf);
          const raw = nn + (0.6 + (lo - 0.5) * 0.5 - nn) * calmK * 0.4 - gapF * 0.7;
          const dens = sm(0.2, 0.5, raw), body = sm(0.3, 0.8, raw), shade = clamp(0.5 + (lo - loL) * 7, 0, 1);
          const moon = Math.exp(-Math.hypot((x - c.moon[0]) / H, (y - c.moon[1]) / H) * 1.6), city = Math.exp(-(1 - hgt) * 1.6);
          const nearGap = 1 - sm(R * 0.9, R * 2.6, dg);
          const hb = sm(0.12, 0.95, hgt);
          const bR = 0.136 + 0.076 * hb, bG = 0.144 + 0.054 * hb, bB = 0.158 + 0.026 * hb;
          let r = bR * 0.52 + 0.01, g = bG * 0.52 + 0.011, b = bB * 0.52 + 0.014;
          r += (bR - r) * body; g += (bG - g) * body; b += (bB - b) * body;
          const sk = 0.84 + 0.32 * shade; r *= sk; g *= sk; b *= sk;
          const lit = shade * shade * (0.05 + 0.26 * moon + 0.3 * nearGap) * (1 - calmK * 0.9);
          r += (0.31 - r) * lit; g += (0.325 - g) * lit; b += (0.35 - b) * lit;
          const ck = city * body * (1 - shade * 0.55) * 0.46 * (1 - calmK * 0.32);
          r += 0.36 * ck; g += 0.32 * ck; b += 0.28 * ck;
          const rim = dens * (1 - dens) * 4, rk = rim * (0.02 + 0.22 * nearGap + 0.1 * moon) * (0.4 + 0.6 * shade) * (1 - calmK * 0.85);
          r += 0.6 * rk; g += 0.62 * rk; b += 0.66 * rk;
          const dk = 1 - calmK * 0.28; r *= dk; g *= dk; b *= dk;
          // пелена и пряди
          const vx = dX * 2.6 * tP * c.cloud[0] * 0.3 - t * 0.004 + (wx - 0.5) * 0.3, vy = dZ * 2.6 * tP * c.cloud[0] * 0.62 + t * 0.001 + (wy - 0.5) * 0.3;
          const vn = fbm(vx, vy, 4, 1, 1);
          const gapW = 1 - sm(R * 0.4, R * 2.2, dg), starCore = 1 - sm(R * 0.12, R * 0.45, dStar);
          let veil = sm(0.46, 0.8, vn) * (1 - gapW * 0.4) * (0.4 + 0.6 * sm(8, 3.5, tP));
          const rlx = (x - F[0]) / LEN, rly = (y - F[1]) / LEN, wqx = rlx * 0.98 + rly * 0.2, wqy = rly * 0.98 - rlx * 0.2;
          const wn = fbm(wqx * 1.5 - t * 0.012 + 4.2, wqy * 7.5 + wqx * 0.8 + 4.2, 4, 1, 1);
          veil = Math.max(veil, sm(0.62, 0.84, wn) * gapW * 0.48) * (1 - starCore * 0.9);
          const aV = veil * 0.5;
          let pr = (0.205 + 0.045 * hgt + 0.05 * moon + 0.05 * gapW) * aV, pg = (0.212 + 0.02 * hgt + 0.055 * moon + 0.052 * gapW) * aV, pb = (0.228 - 0.014 * hgt + 0.062 * moon + 0.056 * gapW) * aV;
          const aL = Math.max(dens, calmK * 0.97);
          pr = r * aL + pr * (1 - aL); pg = g * aL + pg * (1 - aL); pb = b * aL + pb * (1 - aL);
          let a = aL + aV * (1 - aL);
          // серебро звёзд в дымке; тёплое дыхание людей рисуется поверх, на своём холсте
          const tr = 1 - aL * 0.9;
          let gl2 = haloF(x, y, F[0], F[1], 1.3, veil) + haloF(x, y, A[0], A[1], 0.8, veil) + haloF(x, y, B[0], B[1], 0.88, veil);
          for (let q = 0; q < 4; q++) gl2 += haloF(x, y, fieldArr[q * 4], fieldArr[q * 4 + 1], fieldArr[q * 4 + 2] * 0.44, veil) * (1 - body * 0.85);
          pr += 0.83 * gl2 * tr; pg += 0.87 * gl2 * tr; pb += 0.93 * gl2 * tr;
          // дымка у горизонта
          const hz = sm(0.55, 1, hgt), hk = 1 - calmK * 0.18;
          pr += ((0.2 + 0.185 * hz) * hk - pr) * fog; pg += ((0.19 + 0.152 * hz) * hk - pg) * fog; pb += ((0.178 + 0.12 * hz) * hk - pb) * fog;
          a += (1 - a) * fog;
          const o = (j * sw + i) * 4, ia = a > 0.002 ? 255 / a : 0;
          px[o] = clamp(pr * ia, 0, 255); px[o + 1] = clamp(pg * ia, 0, 255); px[o + 2] = clamp(pb * ia, 0, 255); px[o + 3] = clamp(a * 255, 0, 255);
        }
      }
      og.putImageData(img, 0, 0);
      const g = fit(deck2, W, H, 1);
      g.clearRect(0, 0, W, H);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(off, 0, 0, W, H);
    }
    // тёплый ореол присутствия для 2D: один спрайт, по кадру только drawImage с прозрачностью
    function sizeAura() {
      const rr = Math.ceil(LEN * 0.5), pad = rr;
      const x0 = Math.floor(Math.min(A[0], B[0]) - pad), y0 = Math.floor(Math.min(A[1], B[1]) - pad);
      auraBox = [x0, y0, Math.ceil(Math.max(A[0], B[0]) + pad) - x0, Math.ceil(Math.max(A[1], B[1]) + pad) - y0];
      Object.assign(auraC.style, { left: x0 + 'px', top: y0 + 'px', width: auraBox[2] + 'px', height: auraBox[3] + 'px' });
      auraC.width = auraBox[2]; auraC.height = auraBox[3];
      const d = rr * 2, sp = document.createElement('canvas'); sp.width = d; sp.height = d;
      const sg = sp.getContext('2d'), im = sg.createImageData(d, d), q = im.data;
      for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) {
        const r = Math.hypot(i + 0.5 - rr, j + 0.5 - rr) / LEN;
        const f = (Math.exp(-r * r * 1400) * 0.34 + Math.exp(-r * 19) * 0.09 + Math.exp(-r * 5.5) * 0.022) * 0.45 + (Math.exp(-r * r * 240) * 0.1 + Math.exp(-r * 6) * 0.045) * 1.05;
        const o = (j * d + i) * 4, a = Math.min(1, f);
        q[o] = 240; q[o + 1] = 230; q[o + 2] = 214; q[o + 3] = Math.round(a * 255);
      }
      sg.putImageData(im, 0, 0);
      auraSprite = sp;
    }
    function drawAura(bA, bB) {
      const g = auraC.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, auraC.width, auraC.height);
      if (!auraSprite) return;
      g.globalCompositeOperation = 'lighter';
      const rr = auraSprite.width / 2;
      for (const [p, i, b] of [[A, 0, bA], [B, 1, bB]]) {
        const k = pres[i] * (0.65 + 0.35 * b) * (1 + 0.25 * watch[i]);
        if (k < 0.003) continue;
        g.globalAlpha = Math.min(1, k);
        g.drawImage(auraSprite, p[0] - auraBox[0] - rr, p[1] - auraBox[1] - rr);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function useFallback() {
      glOK = false;
      deck.style.display = 'none'; deck2.style.display = 'block'; auraC.style.display = 'block';
      sizeAura();
      clearTimeout(stillTimer);
      // тяжёлый расчёт — после первой отрисовки, чтобы страница не ждала
      stillTimer = setTimeout(() => { try { still2d(); } catch (e) { /* остаются небо и крыши */ } }, 30);
    }
    function useGL() {
      deck.style.display = 'block'; deck2.style.display = 'none'; auraC.style.display = 'none';
      clearTimeout(stillTimer);
      sizeGL();
    }
    deck.addEventListener('webglcontextlost', (e) => { e.preventDefault(); useFallback(); kick(); });
    deck.addEventListener('webglcontextrestored', () => { if (setupGL()) { useGL(); kick(); } });

    /* ---------------- кадр ---------------- */
    function busy(now) {
      if (now - lastChange < FADE + 50) return true;
      return false;
    }
    function draw(now) {
      const red = reduced();
      const t = (now - T0) / 1000;
      for (let i = 0; i < 6; i++) { pres[i] = tv(slots[i].pres, now); watch[i] = tv(slots[i].watch, now); }
      // второй входит со своим дыханием, и за пару секунд оно попадает в такт со смотрящим
      const phB = 1.9 * Math.exp(-Math.max(0, (now - slots[1].joined) / 1000) / 0.75);
      const bA = red ? 0.8 : breath(t, 0), bB = red ? 0.8 : breath(t, phB);
      if (glOK) {
        gl.uniform1f(U.uTime, red ? 46 : 40 + t);
        gl.uniform1f(U.uOpen, red ? 1 : ease((t - 0.1) / 2.3));
        gl.uniform1f(U.uBreA, bA); gl.uniform1f(U.uBreB, bB);
        gl.uniform1f(U.uPresA, pres[0]); gl.uniform1f(U.uPresB, pres[1]);
        gl.uniform2f(U.uWatch, watch[0], watch[1]);
        gl.uniform1f(U.uGap, tv(gap, now));
        if (hasExtras) {
          for (let j = 0; j < 4; j++) fieldArr[j * 4 + 3] = fieldSlot[j] >= 0 ? pres[fieldSlot[j]] : 0;
          gl.uniform4fv(U.uStar, fieldArr);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        drawAura(bA, bB);
      }
      drawBelt(pres[0], pres[1]);
      drawHearth(pres[0], bA);
      if (!red) tickGlass(t);
    }

    let raf = 0, last = -1e9, stopped = false;
    function frame(now) {
      raf = 0;
      if (stopped || document.hidden) return;
      const more = !reduced() || busy(now);
      if (now - last >= 32 || !more) { last = now; draw(now); } // ~30 к/с
      if (more) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf && !stopped && !document.hidden) raf = requestAnimationFrame(frame); }

    function rebuild() {
      measure();
      if (W < 2 || H < 2) return;
      layout();
      drawSky(); drawNear(); layoutGlass();
      const now = performance.now();
      drawGlass(reduced() ? 0 : (now - T0) / 1000);
      sizeBelt(); sizeHearth();
      if (glOK) sizeGL(); else useFallback();
      draw(now);
      if (onLayout) { try { onLayout(); } catch (e) { setTimeout(() => { throw e; }); } }
    }

    // пока идёт фильм, сцена спит целиком: поворот телефона пересчитаем, когда она понадобится снова
    let rzT = 0, sizeKey = '', dirty = false;
    const onResize = () => {
      clearTimeout(rzT);
      if (stopped) { dirty = true; return; }
      rzT = setTimeout(() => {
        const r = root.getBoundingClientRect(), key = `${Math.round(r.width)}x${Math.round(r.height)}@${window.devicePixelRatio}`;
        if (key === sizeKey) return;
        sizeKey = key; rebuild(); kick();
      }, 140);
    };
    addEventListener('resize', onResize);
    addEventListener('orientationchange', onResize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick(); });
    const onMotion = () => { if (stopped) return; const now = performance.now(); drawGlass(reduced() ? 0 : (now - T0) / 1000); draw(now); kick(); };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotion);

    /* ---------------- старт ---------------- */
    measure();
    const r0 = root.getBoundingClientRect();
    sizeKey = `${Math.round(r0.width)}x${Math.round(r0.height)}@${window.devicePixelRatio}`;
    if (!setupGL()) { glOK = false; }
    if (W >= 2 && H >= 2) {
      layout();
      drawSky(); drawNear(); layoutGlass(); drawGlass(0);
      sizeBelt(); sizeHearth();
      if (glOK) useGL(); else useFallback();
      draw(performance.now());
    }
    // первая раскладка — после того, как mount вернул управление
    if (onLayout) Promise.resolve().then(() => { try { onLayout(); } catch (e) { setTimeout(() => { throw e; }); } });
    kick();

    /* ---------------- API ---------------- */
    function setPeople(list) {
      const now = performance.now();
      const arr = Array.isArray(list) ? list : [];
      let extrasChanged = false;
      for (let i = 0; i < 6; i++) {
        const p = arr[i], sl = slots[i];
        const id = p && p.id != null ? p.id : null;
        if (i >= 2 && (id == null) !== (sl.id == null)) extrasChanged = true;
        sl.id = id;
        const lit = p && p.lit ? 1 : 0;
        if (i === 1 && lit && sl.pres.to === 0) sl.joined = now;
        if (sl.pres.to !== lit || sl.watch.to !== (p && p.watching ? 1 : 0)) lastChange = now;
        retarget(sl.pres, lit, now);
        retarget(sl.watch, p && p.watching ? 1 : 0, now);
      }
      const g = arr.length ? slots[1].pres.to : 1;
      if (gap.to !== g) lastChange = now;
      retarget(gap, g, now);
      if (extrasChanged && W) { pickField(); if (glOK) gl.uniform4fv(U.uStar, fieldArr); }
      kick();
    }
    function point(id) {
      const i = slots.findIndex((s) => s.id != null && s.id === id);
      if (i < 0 || !W) return null;
      const p = i === 0 ? A : i === 1 ? B : EX[i - 2];
      if (!onScreen(p, 0)) return null;
      return { x: OX + p[0], y: OY + p[1], r: i < 2 ? coreR[i] : 2 };
    }
    function film() { return { x: OX + F[0], y: OY + F[1], r: coreR[2] }; }
    function stop() { stopped = true; cancelAnimationFrame(raf); raf = 0; }
    function start() { stopped = false; if (dirty) { dirty = false; onResize(); } kick(); }
    return { setPeople, point, film, stop, start };
  }

  window.Sky = { mount };
})();
