/**
 * NEON · 01 — PERFECT CUT
 * Slice the neon shape so the smaller piece matches the target area ratio.
 */
(function (N) {
'use strict';

const { V, L, ctx, PINK, BLUE, GOLD, LASER, FONT, GRADE_COL } = N;
const { rand, randInt, pick, clamp, easeOutBack, hexA } = N;

// Error is % of area. Normalised onto the shared 0..100 scale at 20x, so 5% off scores zero
// and the shared curve reproduces the original 1000 - floor(err * 200).
const ERR_SCALE = 20;
const TH = { p: 10, s: 40, c: 80 };  // 0.50% perfect · 2.0% success · 4.0% close

// ---------- Geometry ----------
// Hot-path polygons live in preallocated [x, y] pair buffers with an explicit vertex count `n`,
// so per-frame and per-cut geometry never allocates. Buffers only grow past POLY_PREALLOC.
const POLY_PREALLOC = 136;  // largest generated shape (128) + 2 clip intersections, with headroom
const SHAPE_EPS = 0.0025;   // outline tolerance in unit radii: <=0.75 px at the 300 px max radius
const GHOST_EPS = 1.5;      // coarser px tolerance for the faint trail ghosts
function pairBuffer(n) {
  const buf = new Array(n);
  for (let i = 0; i < n; i++) buf[i] = [0, 0];
  return buf;
}
function polyArea(p, n = p.length) {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}
function centroid(p, n = p.length, out = [0, 0]) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
    a += f; cx += (p[j][0] + p[i][0]) * f; cy += (p[j][1] + p[i][1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += p[i][0]; sy += p[i][1]; }
    out[0] = sx / n; out[1] = sy / n;
    return out;
  }
  out[0] = cx / (6 * a); out[1] = cy / (6 * a);
  return out;
}
// Sutherland–Hodgman against one half-plane; area stays exact for concave shapes.
// Writes into `out` (a pair buffer) and returns the vertex count.
function clipHalf(p, pn, a, b, sign, out) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let m = 0;
  for (let i = 0; i < pn; i++) {
    const c = p[i], nx = p[i + 1 === pn ? 0 : i + 1];
    const dc = sign * (dx * (c[1] - a[1]) - dy * (c[0] - a[0]));
    const dn = sign * (dx * (nx[1] - a[1]) - dy * (nx[0] - a[0]));
    if (dc >= 0) {
      const q = out[m] || (out[m] = [0, 0]);
      q[0] = c[0]; q[1] = c[1]; m++;
    }
    if ((dc >= 0) !== (dn >= 0)) {
      const t = dc / (dc - dn);
      const q = out[m] || (out[m] = [0, 0]);
      q[0] = c[0] + (nx[0] - c[0]) * t; q[1] = c[1] + (nx[1] - c[1]) * t; m++;
    }
  }
  return m;
}
// Ramer–Douglas–Peucker for a closed ring: drops vertices that sit within `eps` of the chord
// between kept neighbours. Iterative with preallocated scratch so it can run at cut time.
let simpKeep = new Uint8Array(POLY_PREALLOC);
let simpStack = new Int32Array(POLY_PREALLOC * 4);
function simplifyClosed(src, n, eps, out) {
  let m = 0;
  if (n <= 4) {
    for (let i = 0; i < n; i++) { const q = out[m] || (out[m] = [0, 0]); q[0] = src[i][0]; q[1] = src[i][1]; m++; }
    return m;
  }
  if (simpKeep.length < n) { simpKeep = new Uint8Array(n); simpStack = new Int32Array(n * 4); }
  const keep = simpKeep, stack = simpStack, eps2 = eps * eps;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const dx = src[i][0] - src[0][0], dy = src[i][1] - src[0][1], d = dx * dx + dy * dy;
    if (d > fd) { fd = d; far = i; }
  }
  keep.fill(0, 0, n);
  keep[0] = 1; keep[far] = 1;
  let sp = 0;
  stack[sp++] = 0; stack[sp++] = far;
  stack[sp++] = far; stack[sp++] = n;  // index n wraps to 0, closing the ring
  while (sp > 0) {
    const b = stack[--sp], a = stack[--sp];
    const pa = src[a], pb = src[b % n];
    const sx = pb[0] - pa[0], sy = pb[1] - pa[1], ss = sx * sx + sy * sy;
    let best = -1, bd = eps2;
    for (let i = a + 1; i < b; i++) {
      const q = src[i];
      let t = ss > 0 ? ((q[0] - pa[0]) * sx + (q[1] - pa[1]) * sy) / ss : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = pa[0] + sx * t - q[0], ey = pa[1] + sy * t - q[1], d = ex * ex + ey * ey;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack[sp++] = a; stack[sp++] = best;
      stack[sp++] = best; stack[sp++] = b;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const q = out[m] || (out[m] = [0, 0]);
    q[0] = src[i][0]; q[1] = src[i][1]; m++;
  }
  return m;
}
function inPoly(x, y, poly, n) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- Shapes ----------
function genShapePoints(level) {
  const poolTypes =
    level < 2  ? ['circle', 'rect', 'tri'] :
    level < 6  ? ['circle', 'rect', 'tri', 'ngon', 'ellipse', 'blob', 'semi'] :
                 ['circle', 'rect', 'tri', 'ngon', 'ellipse', 'blob', 'blob', 'star', 'heart', 'cross', 'lshape', 'semi', 'trap'];
  const type = pick(poolTypes);
  let p = [];
  const TAU = Math.PI * 2;
  switch (type) {
    case 'circle':
      for (let i = 0; i < 128; i++) { const t = i / 128 * TAU; p.push([Math.cos(t), Math.sin(t)]); }
      break;
    case 'ellipse': {
      const b = rand(0.45, 0.8);
      for (let i = 0; i < 128; i++) { const t = i / 128 * TAU; p.push([Math.cos(t), Math.sin(t) * b]); }
      break;
    }
    case 'rect': {
      const h = rand(0.45, 1);
      p = [[-1, -h], [1, -h], [1, h], [-1, h]];
      break;
    }
    case 'tri':
      for (let i = 0; i < 3; i++) {
        const t = i / 3 * TAU + rand(-0.45, 0.45);
        const r = rand(0.7, 1);
        p.push([Math.cos(t) * r, Math.sin(t) * r]);
      }
      break;
    case 'ngon': {
      const n = randInt(5, 8);
      for (let i = 0; i < n; i++) { const t = i / n * TAU; p.push([Math.cos(t), Math.sin(t)]); }
      break;
    }
    case 'star': {
      const n = randInt(5, 7), inner = rand(0.45, 0.62);
      for (let i = 0; i < n * 2; i++) {
        const t = i / (n * 2) * TAU, r = i % 2 ? inner : 1;
        p.push([Math.cos(t) * r, Math.sin(t) * r]);
      }
      break;
    }
    case 'blob': {
      const n = randInt(9, 15);
      for (let i = 0; i < n; i++) {
        const t = (i + rand(-0.3, 0.3)) / n * TAU;
        const r = rand(0.55, 1);
        p.push([Math.cos(t) * r, Math.sin(t) * r]);
      }
      break;
    }
    case 'heart':
      for (let i = 0; i < 120; i++) {
        const t = i / 120 * TAU;
        p.push([16 * Math.pow(Math.sin(t), 3) / 17,
          -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17]);
      }
      break;
    case 'cross': {
      const a = rand(0.3, 0.45);
      p = [[-a, -1], [a, -1], [a, -a], [1, -a], [1, a], [a, a], [a, 1], [-a, 1], [-a, a], [-1, a], [-1, -a], [-a, -a]];
      break;
    }
    case 'lshape': {
      const t = rand(0.35, 0.55);
      p = [[0, 0], [t, 0], [t, 1 - t], [1, 1 - t], [1, 1], [0, 1]];
      break;
    }
    case 'semi':
      for (let i = 0; i <= 64; i++) { const t = Math.PI * i / 64; p.push([Math.cos(t), -Math.sin(t)]); }
      break;
    case 'trap': {
      const top = rand(0.2, 0.7), h = rand(0.5, 0.9), sk = rand(-0.3, 0.3);
      p = [[-1, h], [1, h], [top + sk, -h], [-top + sk, -h]];
      break;
    }
  }
  const c = centroid(p);
  p = p.map(q => [q[0] - c[0], q[1] - c[1]]);
  let m = 0; for (const q of p) m = Math.max(m, Math.hypot(q[0], q[1]));
  p = p.map(q => [q[0] / m, q[1] / m]);
  const out = [];
  out.length = simplifyClosed(p, p.length, SHAPE_EPS, out);
  return { kind: type, pts: out };
}
function makeShape(level) {
  const spin = level >= 8
    ? (Math.random() < 0.5 ? -1 : 1) * rand(0.15, 0.35) * (level >= 15 ? 1.8 : 1)
    : 0;
  const gen = genShapePoints(level);
  return {
    pts: gen.pts,
    kind: gen.kind,
    angle: rand(0, Math.PI * 2),
    spin,
    color: pick([PINK, BLUE, '#b026ff', '#ff2bd6']),
    born: N.time
  };
}
function shapeScale(s) { return easeOutBack(clamp((N.time - s.born) / 0.38, 0, 1)); }
// Shared world-space buffer; callers consume it synchronously before the next worldPts() call.
const WORLD = pairBuffer(POLY_PREALLOC);
function worldPts(s) {
  const c = Math.cos(s.angle), sn = Math.sin(s.angle), k = V.R * shapeScale(s);
  const src = s.pts, n = src.length;
  for (let i = 0; i < n; i++) {
    const x = src[i][0], y = src[i][1];
    const q = WORLD[i] || (WORLD[i] = [0, 0]);
    q[0] = V.CX + (x * c - y * sn) * k;
    q[1] = V.CY + (x * sn + y * c) * k;
  }
  return n;
}
function makeTarget(level) {
  if (level < 2) return 50;
  if (Math.random() < 0.18) return 50;
  const step = level < 5 ? 10 : level < 10 ? 5 : 1;
  const min = level < 5 ? 20 : level < 10 ? 15 : 10;
  const n = Math.floor((50 - min) / step);
  return min + step * Math.floor(Math.random() * n);
}

// ---------- Piece physics ----------
// Velocities and gravity are per-frame at 60 fps; step() scales by dt so the fall is frame-rate independent.
// dt arrives already multiplied by the global time scale, so hit-stop slows motion, spin, fade and trail alike.
const Pieces = {
  GRAVITY: 0.3,
  POP_MIN: 2, POP_MAX: 4,
  PUSH: 2.4,
  NUDGE: 6,
  SPIN: 0.012,
  TRAIL: 10,
  SAMPLE: 1 / 120,     // trail sample spacing in simulated seconds, independent of display refresh
  GHOST_STEP: 4,       // max px between drawn ghosts before interpolating
  GHOST_MAX: 36,       // per-piece ghost budget for mobile fill-rate
  GHOST_DECAY: 0.7,
  GHOST_ALPHA: 0.55,
  // Static piece slots; `count` is the active pointer. Trails are fixed-size ring buffers and
  // ghosts are written into one shared Float64Array, so the 1/120 s sampler never allocates.
  pool: null,
  count: 0,
  ghostBuf: null,
  _pa: new Float64Array(3),
  _pb: new Float64Array(3),
  makeSlot() {
    return {
      pts: pairBuffer(POLY_PREALLOC), n: 0, lod: pairBuffer(POLY_PREALLOC), lodN: 0,
      c: [0, 0], dir: 1, col: PINK, pct: 0,
      x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, alpha: 0,
      trail: new Float64Array(this.TRAIL * 3), tHead: 0, tCount: 0, acc: 0
    };
  },
  spawn(pc, n) {
    const push = this.PUSH * pc.dir;
    pc.x = pc.c[0] + n[0] * this.NUDGE * pc.dir;
    pc.y = pc.c[1] + n[1] * this.NUDGE * pc.dir;
    pc.vx = n[0] * push;
    pc.vy = n[1] * push - rand(this.POP_MIN, this.POP_MAX);
    pc.rot = 0;
    pc.vr = this.SPIN * pc.dir * rand(0.6, 1.4);
    pc.alpha = 1;
    pc.tHead = 0;
    pc.tCount = 0;
    pc.acc = 0;
    return pc;
  },
  step(dt, t, life) {
    if (dt <= 0) return;
    const f = dt * 60;
    const alpha = clamp(1 - t / life, 0, 1);
    const T = this.TRAIL;
    for (let i = 0; i < this.count; i++) {
      const pc = this.pool[i];
      const x0 = pc.x, y0 = pc.y, r0 = pc.rot;
      pc.vy += this.GRAVITY * f;
      pc.x += pc.vx * f;
      pc.y += pc.vy * f;
      pc.rot += pc.vr * f;
      pc.alpha = alpha;
      // Emit samples at their exact sub-step instant so spacing tracks simulated time, not frame count.
      pc.acc += dt;
      const tr = pc.trail;
      while (pc.acc >= this.SAMPLE) {
        pc.acc -= this.SAMPLE;
        const k = 1 - pc.acc / dt;
        pc.tHead = (pc.tHead + 1) % T;
        const o = pc.tHead * 3;
        tr[o] = x0 + (pc.x - x0) * k;
        tr[o + 1] = y0 + (pc.y - y0) * k;
        tr[o + 2] = r0 + (pc.rot - r0) * k;
        if (pc.tCount < T) pc.tCount++;
      }
    }
  },
  // Path index 0 is the live piece; 1..tCount walk the ring buffer newest -> oldest.
  pathPoint(pc, j, out) {
    if (j === 0) { out[0] = pc.x; out[1] = pc.y; out[2] = pc.rot; return; }
    const o = ((pc.tHead - j + 1 + this.TRAIL) % this.TRAIL) * 3;
    out[0] = pc.trail[o]; out[1] = pc.trail[o + 1]; out[2] = pc.trail[o + 2];
  },
  // Walks head -> tail, lerping extra ghosts wherever consecutive points are far apart.
  // Fills ghostBuf with [x, y, rot, alpha] head-first and returns the count; draw it in reverse.
  ghosts(pc) {
    const len = 1 + pc.tCount;
    let a = this._pa, b = this._pb, sw;
    this.pathPoint(pc, 0, a);
    let total = 0;
    for (let i = 1; i < len; i++) {
      this.pathPoint(pc, i, b);
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      sw = a; a = b; b = sw;
    }
    const step = Math.max(this.GHOST_STEP, total / this.GHOST_MAX);
    const g = this.ghostBuf, cap = g.length / 4;
    let m = 0;
    this.pathPoint(pc, 0, a);
    for (let i = 1; i < len; i++) {
      this.pathPoint(pc, i, b);
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      const inv = 1 / Math.sqrt(n);
      for (let s = 1; s <= n && m < cap; s++) {
        const u = s / n, o = m * 4;
        g[o] = a[0] + (b[0] - a[0]) * u;
        g[o + 1] = a[1] + (b[1] - a[1]) * u;
        g[o + 2] = a[2] + (b[2] - a[2]) * u;
        g[o + 3] = pc.alpha * this.GHOST_ALPHA * Math.pow(this.GHOST_DECAY, i - 1 + u) * inv;
        m++;
      }
      sw = a; a = b; b = sw;
    }
    return m;
  },
  reset() { this.count = 0; }
};
Pieces.pool = [Pieces.makeSlot(), Pieces.makeSlot()];
Pieces.ghostBuf = new Float64Array((Pieces.GHOST_MAX + Pieces.TRAIL) * 2 * 4);

// ---------- State ----------
let shape = null, target = 50;
let drag = null, cutFlash = null;
const DRAG = { a: [0, 0], b: [0, 0] };
const CUT_FLASH = { a: [0, 0], b: [0, 0], t: 0 };
const cutN = [0, 0];
const RESULT = { small: 0, large: 0, err: 0, grade: 'rough', pts: 0 };

const CHORD = pairBuffer(81);
let chordN = 0;
const GUIDE = pairBuffer(POLY_PREALLOC);
const GUIDE_SCR = pairBuffer(POLY_PREALLOC);
let guideN = 0, guideY = 0, guideReady = false;

function chordPoints(poly, pn, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const t0 = (V.CX - a[0]) * ux + (V.CY - a[1]) * uy;
  let m = 0;
  for (let i = 0; i <= 80; i++) {
    const t = t0 + (-1.1 + 2.2 * i / 80) * V.R;
    const x = a[0] + ux * t, y = a[1] + uy * t;
    if (inPoly(x, y, poly, pn)) { CHORD[m][0] = x; CHORD[m][1] = y; m++; }
  }
  if (!m) { CHORD[0][0] = V.CX; CHORD[0][1] = V.CY; m = 1; }
  return m;
}

// ---------- Cut & judgment ----------
function performCut(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 18) return;
  const pn = worldPts(shape);
  const s1 = Pieces.pool[0], s2 = Pieces.pool[1];
  s1.n = clipHalf(WORLD, pn, a, b, 1, s1.pts);
  s2.n = clipHalf(WORLD, pn, a, b, -1, s2.pts);
  const A1 = s1.n >= 3 ? Math.abs(polyArea(s1.pts, s1.n)) : 0;
  const A2 = s2.n >= 3 ? Math.abs(polyArea(s2.pts, s2.n)) : 0;
  const tot = A1 + A2;
  if (tot <= 0 || A1 / tot < 0.002 || A2 / tot < 0.002) {
    N.sfx.miss();
    N.pop('MISS', V.CX, V.CY, L.pop * 0.45, 'rgba(255,255,255,0.7)', 0.6);
    return;
  }

  const p1 = A1 / tot * 100;
  const smallRaw = Math.min(p1, 100 - p1);
  const small = Math.round(smallRaw * 100) / 100;
  const large = (10000 - Math.round(small * 100)) / 100;
  const err = Math.abs(smallRaw - target);

  const firstIsSmall = p1 <= 50;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  cutN[0] = -uy; cutN[1] = ux;
  centroid(s1.pts, s1.n, s1.c);
  s1.dir = 1;  s1.col = firstIsSmall ? PINK : BLUE; s1.pct = firstIsSmall ? small : large;
  centroid(s2.pts, s2.n, s2.c);
  s2.dir = -1; s2.col = firstIsSmall ? BLUE : PINK; s2.pct = firstIsSmall ? large : small;
  s1.lodN = simplifyClosed(s1.pts, s1.n, GHOST_EPS, s1.lod);
  s2.lodN = simplifyClosed(s2.pts, s2.n, GHOST_EPS, s2.lod);
  Pieces.spawn(s1, cutN);
  Pieces.spawn(s2, cutN);
  Pieces.count = 2;

  const scored = N.grade(err * ERR_SCALE, TH);
  RESULT.small = small; RESULT.large = large; RESULT.err = err;
  RESULT.grade = scored.grade; RESULT.pts = scored.pts;
  N.commit(RESULT);

  cutFlash = CUT_FLASH;
  cutFlash.a[0] = a[0]; cutFlash.a[1] = a[1];
  cutFlash.b[0] = b[0]; cutFlash.b[1] = b[1];
  cutFlash.t = 0;
  N.sfx.slice();

  chordN = chordPoints(WORLD, pn, a, b);
  N.particles.along(CHORD, chordN, 18, 'spark', '#ffffff');
  N.juice(scored, emitAlongChord, V.CX, V.CY);
  // Same perfect slam as Neon Slash and Neon Prism: white invert flash, heavy glitch, shake.
  if (scored.perfect) {
    N.fx.invert(1);
    N.fx.glitch(0.45, true);
    N.fx.shake(12);
    N.fx.scanlines();
    N.vibrate([25, 30, 80]);
  }
}
function emitAlongChord(kind, n, col) {
  N.particles.along(CHORD, chordN, n, kind, col);
}

// ---------- Render ----------
function tracePoly(pts, n = pts.length) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function drawPoly(pts, col, alpha = 1, fillA = 0.2, n = pts.length) {
  if (n < 3 || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  tracePoly(pts, n);
  ctx.fillStyle = hexA(col, fillA);
  ctx.fill();
  ctx.shadowColor = col; ctx.shadowBlur = 26;
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
function buildAreaGuide() {
  guideN = 0;
  guideReady = false;
  if (!shape) return false;
  const n = worldPts(shape);
  const total = Math.abs(polyArea(WORLD, n));
  if (n < 3 || total < 1e-6) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = WORLD[i][0], y = WORLD[i][1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxY - minY < 2) return false;
  const want = clamp(target, 1, 50) / 100;
  const ax = minX - 8, bx = maxX + 8;
  const below = y => {
    const m = clipHalf(WORLD, n, [ax, y], [bx, y], 1, GUIDE_SCR);
    return m >= 3 ? Math.abs(polyArea(GUIDE_SCR, m)) / total : 0;
  };
  let lo = minY, hi = maxY, y = (minY + maxY) / 2;
  for (let i = 0; i < 16; i++) {
    y = (lo + hi) / 2;
    if (below(y) > want) lo = y; else hi = y;
  }
  guideY = (lo + hi) / 2;
  guideN = clipHalf(WORLD, n, [ax, guideY], [bx, guideY], 1, GUIDE);
  guideReady = guideN >= 3;
  return guideReady;
}
function drawAreaGuide() {
  if (N.run.round !== 1 || N.run.state !== 'aim' || !shape) return;
  buildAreaGuide();
  if (!guideReady) return;
  ctx.save();
  ctx.lineJoin = 'round';
  tracePoly(GUIDE, guideN);
  ctx.fillStyle = hexA(GOLD, 0.28);
  ctx.fill();
  ctx.setLineDash([5, 6]);
  ctx.lineDashOffset = -N.time * 24;
  ctx.shadowColor = GOLD; ctx.shadowBlur = 10;
  ctx.strokeStyle = hexA(GOLD, 0.9); ctx.lineWidth = 1.6;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < guideN; i++) {
    const a = GUIDE[i], b = GUIDE[i + 1 === guideN ? 0 : i + 1];
    if (Math.abs(a[1] - guideY) > 1.2 || Math.abs(b[1] - guideY) > 1.2) { pen = false; continue; }
    if (!pen) { ctx.moveTo(a[0], a[1]); pen = true; }
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  ctx.restore();
}
function drawShape() {
  if (!shape) return;
  const n = worldPts(shape);
  const pulse = 0.18 + Math.sin(N.time * 3) * 0.04;
  drawPoly(WORLD, shape.color, 1, pulse, n);
  drawAreaGuide();
}
function placePiece(pc, x, y, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.translate(-pc.c[0], -pc.c[1]);
}
// Ghosts skip shadowBlur; the wide low-alpha stroke fakes the glow so dense trails stay cheap.
function drawGhost(pc, col, x, y, rot, alpha) {
  if (alpha < 0.004) return;
  placePiece(pc, x, y, rot);
  tracePoly(pc.lod, pc.lodN);
  ctx.strokeStyle = col;
  ctx.globalAlpha = alpha * 0.35;
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}
function drawPieces() {
  const t = N.run.resultT;
  const rough = N.run.result === RESULT && RESULT.grade === 'rough';
  const g = Pieces.ghostBuf;
  for (let i = 0; i < Pieces.count; i++) {
    const pc = Pieces.pool[i];
    if (pc.alpha <= 0) continue;
    const col = rough && Math.floor(t * 8) % 2 === 0 ? '#ff2a2a' : pc.col;
    ctx.save();
    ctx.lineJoin = 'round';
    for (let j = Pieces.ghosts(pc) - 1; j >= 0; j--) {
      const o = j * 4;
      drawGhost(pc, col, g[o], g[o + 1], g[o + 2], g[o + 3]);
    }
    ctx.restore();
    placePiece(pc, pc.x, pc.y, pc.rot);
    drawPoly(pc.pts, col, pc.alpha, 0.26, pc.n);
    ctx.globalAlpha = pc.alpha * clamp(t / 0.2, 0, 1);
    ctx.font = `700 ${Math.max(11, V.R * 0.085)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = pc.col; ctx.shadowBlur = 10;
    ctx.fillStyle = '#fff';
    ctx.fillText(pc.pct.toFixed(2), pc.c[0], pc.c[1]);
    ctx.restore();
  }
}
function drawLaser(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len, uy = dy / len, ext = Math.max(V.W, V.H) * 2;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.setLineDash([6, 10]);
  ctx.lineDashOffset = -N.time * 40;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(a[0] - ux * ext, a[1] - uy * ext); ctx.lineTo(b[0] + ux * ext, b[1] + uy * ext); ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  const flicker = 0.85 + Math.random() * 0.15;
  ctx.shadowColor = LASER; ctx.shadowBlur = 28;
  ctx.strokeStyle = hexA(LASER, 0.55 * flicker); ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 12;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(a[0], a[1], 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = LASER; ctx.shadowBlur = 24;
  ctx.beginPath(); ctx.arc(b[0], b[1], 5 + Math.sin(N.time * 30) * 1.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawCutFlash() {
  if (!cutFlash) return;
  const a = cutFlash.a, b = cutFlash.b, t = cutFlash.t;
  const k = 1 - t / 0.4;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, ext = Math.max(V.W, V.H) * 2;
  ctx.save();
  ctx.globalAlpha = k;
  ctx.lineCap = 'round';
  ctx.shadowColor = LASER; ctx.shadowBlur = 30;
  ctx.strokeStyle = hexA(LASER, 0.7); ctx.lineWidth = 10 * k + 1;
  ctx.beginPath(); ctx.moveTo(a[0] - ux * ext, a[1] - uy * ext); ctx.lineTo(b[0] + ux * ext, b[1] + uy * ext); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * k + 0.5;
  ctx.stroke();
  ctx.restore();
}

// ---------- Registration ----------
// Backdrop: a cutting mat. Ruler ticks down both edges and the dashed work envelope the
// shape is sized against, so the playfield reads as a measuring rig.
function drawMat() {
  const left = V.SAFE.left + 8, right = V.W - V.SAFE.right - 8;
  const top = V.playTop, span = V.playBottom - V.playTop;
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = hexA(PINK, 0.3);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 7]);
  ctx.beginPath();
  ctx.arc(V.CX, V.CY, V.R * 1.14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const y = Math.round(top + span * i / 10) + 0.5;
    const len = i % 5 === 0 ? 17 : 8;
    ctx.moveTo(left, y); ctx.lineTo(left + len, y);
    ctx.moveTo(right, y); ctx.lineTo(right - len, y);
  }
  ctx.stroke();
}

N.register({
  id: 'cut',
  name: 'PERFECT CUT',
  code: 'CUT',
  desc: 'SLICE THE EXACT AREA RATIO',
  accent: PINK,
  backdrop: drawMat,
  hint: 'DRAG TO SLICE',
  lbGame: 'perfect-cut',
  tiers: [
    { min: 13500, id: 'god', label: '[ GOD HAND ]', badge: 'GOD' },
    { min: 11000, id: 'slicer', label: '[ CYBER SLICER ]', badge: 'SLICER' },
    { min: 7500, id: 'human', label: '[ NORMAL HUMAN ]' },
    { min: 0, id: 'butcher', label: '[ BUTCHER ]' }
  ],

  start() {
    Pieces.reset();
    drag = null; cutFlash = null;
  },
  stop() {
    Pieces.reset();
    drag = null; cutFlash = null; shape = null;
  },
  round(n) {
    shape = makeShape(n);
    target = makeTarget(n);
    Pieces.reset();
    drag = null; cutFlash = null;
    guideReady = false;
  },

  hintVisible() { return !drag; },

  down(x, y) {
    DRAG.a[0] = DRAG.b[0] = x;
    DRAG.a[1] = DRAG.b[1] = y;
    drag = DRAG;
  },
  move(x, y) {
    if (!drag) return;
    drag.b[0] = x; drag.b[1] = y;
    N.particles.at(x, y, 2, 'dust', Math.random() < 0.6 ? LASER : '#ffffff');
  },
  up() {
    if (!drag) return;
    const d = drag; drag = null;
    performCut(d.a, d.b);
  },
  cancel() { drag = null; },

  update(dt) {
    if (shape && N.run.state === 'aim') shape.angle += shape.spin * dt;
    if (N.run.state === 'result') Pieces.step(dt, N.run.resultT, this.resultTime);
    if (cutFlash) { cutFlash.t += dt; if (cutFlash.t > 0.4) cutFlash = null; }
  },

  draw() {
    if (N.run.state === 'aim') drawShape();
    else drawPieces();
    drawCutFlash();
    if (drag) drawLaser(drag.a, drag.b);
  },

  hud() {
    N.text('TARGET', V.W / 2, L.labelY, 11, '#ffffff', { alpha: 0.55, glow: 0, spacing: 6 });
    N.duo(String(target), String(100 - target), L.mainY, L.s);

    const res = N.run.result;
    if (res === RESULT && (N.run.state === 'result' || N.run.state === 'over')) {
      const k = clamp(N.run.resultT / 0.18, 0, 1);
      N.duo(RESULT.small.toFixed(2), RESULT.large.toFixed(2), L.subY, L.subSize, k);
      N.text(`\u0394 ${RESULT.err.toFixed(2)}%`, V.W / 2, L.errY, Math.max(11, L.subSize * 0.55),
        GRADE_COL[RESULT.grade], { alpha: k, glow: 10, spacing: 2 });
    }
  }
});
})(window.NEON);
