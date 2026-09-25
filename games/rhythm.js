/**
 * NEON · 02 — NEON SLASH
 *
 * A random geometric shape is tossed up from the bottom, hangs, then falls. A dashed perforation
 * is drawn across it. A slice scores by how closely that flick matches the perforation:
 * the worse of the angle gap and the sideways offset decides Perfect, Great, Good, or Miss.
 * A flick that misses the shape does not end the round. Falling off the bottom does.
 */
(function (N) {
'use strict';

const { V, L, ctx, PINK, BLUE, LASER, VIOLET, GREEN, FONT, GRADE_COL } = N;
const { rand, randInt, pick, clamp, lerp, hexA } = N;

const GRAVITY = 900;
const SLASH_MIN = 18;
const NAMES = { perfect: 'PERFECT!', success: 'GREAT', close: 'GOOD', rough: 'MISS' };
const COLORS = [BLUE, VIOLET, PINK, '#ff2bd6'];

// Both errors land on the same 0..100 scale the shared grade curve reads.
// 4° or 6% of the diameter is the perfect edge; 14° / 18% great; 32° / 40% good.
const TH = { p: 4, s: 14, c: 32 };
const ANG = { p: 4, s: 14, c: 32 };
const OFF = { p: 6, s: 18, c: 40 };

const SHAPE_N = 48;
function pairBuffer(n) {
  const buf = new Array(n);
  for (let i = 0; i < n; i++) buf[i] = [0, 0];
  return buf;
}
const WORLD = pairBuffer(SHAPE_N + 8);
const SCR = [pairBuffer(SHAPE_N + 8), pairBuffer(SHAPE_N + 8)];
const CEN = [0, 0];
const CHORD = pairBuffer(8);

function makePiece() {
  return { pts: pairBuffer(SHAPE_N + 8), n: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, col: BLUE };
}
const PIECES = [makePiece(), makePiece()];
let pieceCount = 0;

const SHAPE = {
  pts: pairBuffer(SHAPE_N), n: 0, col: BLUE,
  x: 0, y: 0, r: 48, vx: 0, vy: 200, g: 1600, speed: 200,
  rot: 0, spin: 0, entered: false,
  cutAng: 0, cutOff: 0, alive: false
};
// Same ten relative sizes every run, only the order is shuffled, so runs stay comparable.
const SIZE_SCALE = [0.64, 0.76, 0.88, 1.00, 1.12, 1.24, 1.36, 1.50, 1.64, 1.80];
const sizeDeck = new Array(10);
const DRAG = { a: [0, 0], b: [0, 0] };
let drag = null;
const FLASH = { x: 0, y: 0, ang: 0, t: 0 };
let slash = 0;
const RESULT = {
  grade: 'rough', pts: 0, err: 0, ang: 0, off: 0, speed: 0, timedOut: false
};

function genShape(round) {
  const pool = round < 3
    ? ['circle', 'rect', 'tri', 'diamond']
    : round < 7
      ? ['circle', 'rect', 'tri', 'diamond', 'ngon', 'ellipse', 'trap']
      : ['circle', 'rect', 'tri', 'ngon', 'ellipse', 'star', 'trap', 'hex'];
  const type = pick(pool);
  const src = [];
  const TAU = Math.PI * 2;
  if (type === 'circle') {
    for (let i = 0; i < 32; i++) { const t = i / 32 * TAU; src.push([Math.cos(t), Math.sin(t)]); }
  } else if (type === 'ellipse') {
    const b = rand(0.55, 0.78);
    for (let i = 0; i < 32; i++) { const t = i / 32 * TAU; src.push([Math.cos(t), Math.sin(t) * b]); }
  } else if (type === 'rect') {
    const h = rand(0.55, 0.95);
    src.push([-1, -h], [1, -h], [1, h], [-1, h]);
  } else if (type === 'tri') {
    for (let i = 0; i < 3; i++) {
      const t = -Math.PI / 2 + i / 3 * TAU;
      src.push([Math.cos(t), Math.sin(t)]);
    }
  } else if (type === 'diamond') {
    src.push([0, -1.15], [0.72, 0], [0, 1.15], [-0.72, 0]);
  } else if (type === 'ngon' || type === 'hex') {
    const n = type === 'hex' ? 6 : randInt(5, 7);
    for (let i = 0; i < n; i++) { const t = -Math.PI / 2 + i / n * TAU; src.push([Math.cos(t), Math.sin(t)]); }
  } else if (type === 'star') {
    const n = randInt(5, 6), inner = rand(0.42, 0.55);
    for (let i = 0; i < n * 2; i++) {
      const t = -Math.PI / 2 + i / (n * 2) * TAU;
      const rr = i % 2 ? inner : 1;
      src.push([Math.cos(t) * rr, Math.sin(t) * rr]);
    }
  } else {
    const top = rand(0.35, 0.7), h = rand(0.6, 0.9);
    src.push([-1, h], [1, h], [top, -h], [-top, -h]);
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < src.length; i++) { cx += src[i][0]; cy += src[i][1]; }
  cx /= src.length; cy /= src.length;
  let m = 0;
  for (let i = 0; i < src.length; i++) {
    src[i][0] -= cx; src[i][1] -= cy;
    m = Math.max(m, Math.hypot(src[i][0], src[i][1]));
  }
  const n = Math.min(src.length, SHAPE.pts.length);
  for (let i = 0; i < n; i++) {
    SHAPE.pts[i][0] = src[i][0] / m;
    SHAPE.pts[i][1] = src[i][1] / m;
  }
  SHAPE.n = n;
}

function buildSizeDeck() {
  const h = Math.max(120, V.playBottom - V.playTop);
  const mid = clamp(Math.min(V.W * 0.11, h * 0.105), 42, 64);
  for (let i = 0; i < 10; i++) sizeDeck[i] = SIZE_SCALE[i];
  for (let i = 9; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const s = sizeDeck[i]; sizeDeck[i] = sizeDeck[j]; sizeDeck[j] = s;
  }
  for (let i = 0; i < 10; i++) sizeDeck[i] *= mid;
}
function tossFor(round, r, tApex) {
  const h = Math.max(120, V.playBottom - V.playTop);
  const y0 = V.playBottom + r * 0.35;
  const rise = lerp(h * 0.62, h * 0.92, rand(0, 1));
  const drop = Math.max(80, y0 - (V.playTop + r + 8) - (h - rise));
  const g = 2 * drop / (tApex * tApex);
  const vy = -Math.sqrt(2 * g * drop);
  const drift = rand(-1, 1) * lerp(40, 110, (round - 1) / 9);
  return { y0, g, vy, vx: drift, speed: -vy };
}
function spinFor(round) {
  if (round < 5) return 0;
  const s = rand(0.35, 0.7) * (round >= 8 ? 1.7 : 1);
  return Math.random() < 0.5 ? -s : s;
}

function worldPts() {
  const c = Math.cos(SHAPE.rot), s = Math.sin(SHAPE.rot), R = SHAPE.r;
  const n = SHAPE.n;
  for (let i = 0; i < n; i++) {
    const x = SHAPE.pts[i][0], y = SHAPE.pts[i][1];
    WORLD[i][0] = SHAPE.x + (x * c - y * s) * R;
    WORLD[i][1] = SHAPE.y + (x * s + y * c) * R;
  }
  return n;
}

// Local cut: direction `cutAng`, offset `cutOff` along its normal, in unit space.
function cutWorld() {
  const ang = SHAPE.rot + SHAPE.cutAng;
  const nx = -Math.sin(SHAPE.cutAng), ny = Math.cos(SHAPE.cutAng);
  const c = Math.cos(SHAPE.rot), s = Math.sin(SHAPE.rot);
  const lx = nx * SHAPE.cutOff, ly = ny * SHAPE.cutOff;
  return {
    ang,
    x: SHAPE.x + (lx * c - ly * s) * SHAPE.r,
    y: SHAPE.y + (lx * s + ly * c) * SHAPE.r
  };
}

function polyArea(p, n) {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(a) * 0.5;
}
function centroid(p, n, out) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
    a += f; cx += (p[j][0] + p[i][0]) * f; cy += (p[j][1] + p[i][1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return 0;
  out[0] = cx / (6 * a); out[1] = cy / (6 * a);
  return Math.abs(a);
}
function clipLine(src, n, px, py, nx, ny, side, out) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const c = src[i], d = src[i + 1 === n ? 0 : i + 1];
    const dc = side * ((c[0] - px) * nx + (c[1] - py) * ny);
    const dd = side * ((d[0] - px) * nx + (d[1] - py) * ny);
    if (dc >= 0) { out[m][0] = c[0]; out[m][1] = c[1]; m++; }
    if ((dc >= 0) !== (dd >= 0)) {
      const k = dc / (dc - dd);
      out[m][0] = c[0] + (d[0] - c[0]) * k;
      out[m][1] = c[1] + (d[1] - c[1]) * k;
      m++;
    }
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

// Chord of an infinite line through the live shape. Returns endpoint count (0 or 2+).
function chordOf(px, py, ang) {
  const n = SHAPE.alive ? worldPts() : 0;
  if (n < 3) return 0;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const ts = [];
  for (let i = 0; i < n; i++) {
    const a = WORLD[i], b = WORLD[i + 1 === n ? 0 : i + 1];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-8) continue;
    const t = ((a[0] - px) * ey - (a[1] - py) * ex) / den;
    const u = ((a[0] - px) * dy - (a[1] - py) * dx) / den;
    if (u >= -1e-4 && u <= 1 + 1e-4) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  let m = 0;
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1.5) continue;
    const mid = (ts[i] + ts[i + 1]) * 0.5;
    const mx = px + dx * mid, my = py + dy * mid;
    if (!inPoly(mx, my, WORLD, n)) continue;
    if (m + 2 > CHORD.length) break;
    CHORD[m][0] = px + dx * ts[i]; CHORD[m][1] = py + dy * ts[i]; m++;
    CHORD[m][0] = px + dx * ts[i + 1]; CHORD[m][1] = py + dy * ts[i + 1]; m++;
    i++;
  }
  return m;
}

function lineDelta(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d * 180 / Math.PI;
}
function mapBand(v, band) {
  if (v <= band.p) return v / band.p * TH.p;
  if (v < band.s) return TH.p + (v - band.p) / (band.s - band.p) * (TH.s - TH.p);
  if (v <= band.c) return TH.s + (v - band.s) / (band.c - band.s) * (TH.c - TH.s);
  const span = band === ANG ? 90 - band.c : 100 - band.c;
  return Math.min(100, TH.c + (v - band.c) / span * (100 - TH.c));
}

function pickCut() {
  for (let attempt = 0; attempt < 8; attempt++) {
    SHAPE.cutAng = rand(0, Math.PI);
    SHAPE.cutOff = rand(-0.28, 0.28);
    const cut = cutWorld();
    const n = worldPts();
    const nnx = -Math.sin(cut.ang), nny = Math.cos(cut.ang);
    const nL = clipLine(WORLD, n, cut.x, cut.y, nnx, nny, -1, SCR[0]);
    const nR = clipLine(WORLD, n, cut.x, cut.y, nnx, nny, 1, SCR[1]);
    const aL = nL >= 3 ? polyArea(SCR[0], nL) : 0;
    const aR = nR >= 3 ? polyArea(SCR[1], nR) : 0;
    const tot = aL + aR;
    if (tot > 0 && aL / tot > 0.18 && aR / tot > 0.18) return;
  }
  SHAPE.cutAng = rand(0, Math.PI);
  SHAPE.cutOff = 0;
}

const BEAT = () => N.BEAT || 0.46;
let beat0 = 0, beatSent = -1;

function beatIndex(at) {
  return Math.floor(((at === undefined ? N.time : at) - beat0) / BEAT() + 1e-4);
}
function pumpBeat() {
  const step = beatIndex();
  if (step <= beatSent) return;
  const arp = N.ARP || [82.41, 98, 123.47, 146.83, 123.47, 98, 73.42, 110];
  for (let b = beatSent + 1; b <= step; b++) {
    const f = arp[((b % arp.length) + arp.length) % arp.length];
    const apex = SHAPE.alive && b === SHAPE.apexBeat;
    N.tone(f, apex ? 0.5 : 0.36, 'sine', apex ? 0.08 : 0.042);
    N.tone(f * 2, apex ? 0.22 : 0.14, 'triangle', apex ? 0.03 : 0.014, 0.02);
  }
  beatSent = step;
}
function spawn(round) {
  genShape(round);
  SHAPE.col = pick(COLORS);
  SHAPE.r = sizeDeck[round - 1] || sizeDeck[0];
  const rawHang = lerp(2.7, 1.15, (round - 1) / 9) * rand(0.92, 1.08);
  const beats = Math.max(1, Math.round(rawHang));
  const nowBeat = (N.time - beat0) / BEAT();
  const launchBeat = Math.ceil(nowBeat - 1e-4);
  SHAPE.launchT = beat0 + launchBeat * BEAT();
  SHAPE.apexBeat = launchBeat + beats;
  const toss = tossFor(round, SHAPE.r, beats * BEAT());
  SHAPE.g = toss.g;
  SHAPE.vy0 = toss.vy;
  SHAPE.vy = 0;
  SHAPE.vx = toss.vx;
  SHAPE.speed = toss.speed;
  SHAPE.y0 = toss.y0;
  SHAPE.rot = rand(0, Math.PI * 2);
  SHAPE.spin = spinFor(round);
  SHAPE.entered = false;
  const margin = SHAPE.r + 16;
  SHAPE.x = rand(margin, Math.max(margin + 1, V.W - margin));
  SHAPE.y = toss.y0;
  SHAPE.alive = true;
  pickCut();
  pieceCount = 0;
  slash = 0;
}

function launch(pc, speed, spin) {
  pc.x = CEN[0]; pc.y = CEN[1];
  pc.vx = speed[0]; pc.vy = speed[1];
  pc.rot = 0; pc.vr = spin; pc.col = SHAPE.col;
}
function split(ang, lx, ly, perfect) {
  const n = worldPts();
  const nnx = -Math.sin(ang), nny = Math.cos(ang);
  let ok = true;
  for (let k = 0; k < 2; k++) {
    const pc = PIECES[k], side = k ? 1 : -1;
    pc.n = clipLine(WORLD, n, lx, ly, nnx, nny, side, pc.pts);
    if (pc.n < 3 || centroid(pc.pts, pc.n, CEN) < SHAPE.r * SHAPE.r * 0.01) ok = false;
    else {
      for (let i = 0; i < pc.n; i++) { pc.pts[i][0] -= CEN[0]; pc.pts[i][1] -= CEN[1]; }
      const sp = perfect ? 220 : rand(120, 210);
      launch(pc, [nnx * side * sp, nny * side * sp * 0.35 - rand(20, 80)],
        perfect ? side * 0.4 : side * rand(1.2, 3.2));
    }
  }
  if (!ok) { pieceCount = 0; return false; }
  pieceCount = 2;
  SHAPE.alive = false;
  return true;
}

function finish(scored, angErr, offPct, timedOut) {
  RESULT.grade = scored.grade;
  RESULT.pts = scored.pts;
  RESULT.err = Math.max(mapBand(angErr, ANG), mapBand(offPct, OFF));
  RESULT.ang = angErr;
  RESULT.off = offPct;
  RESULT.speed = SHAPE.speed;
  RESULT.timedOut = timedOut;
  N.commit(RESULT);
  const popY = Math.min(SHAPE.y, V.playBottom - 40) - SHAPE.r * 0.2;
  N.juice(scored, (kind, n, col) => {
    N.particles.at(SHAPE.x, SHAPE.y, n, kind, col || SHAPE.col);
  }, SHAPE.x, popY, NAMES);
  if (timedOut) N.pop('TOO LATE', SHAPE.x, popY - L.pop * 0.85, L.pop * 0.38, '#ff2a2a', 1.0);
}

function resolve(ang, lx, ly) {
  const hits = chordOf(lx, ly, ang);
  if (hits < 2) {
    N.sfx.miss();
    N.pop('MISS', lx, Math.max(ly, V.playTop + 20), L.pop * 0.36, 'rgba(255,255,255,0.75)', 0.45);
    return;
  }
  const cut = cutWorld();
  const angErr = lineDelta(ang, cut.ang);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const dist = Math.abs((cut.x - lx) * dy - (cut.y - ly) * dx);
  const offPct = dist / (SHAPE.r * 2) * 100;
  const norm = Math.max(mapBand(angErr, ANG), mapBand(offPct, OFF));
  const scored = N.grade(norm, TH);
  split(ang, lx, ly, scored.perfect);
  SHAPE.alive = false;
  FLASH.x = lx; FLASH.y = ly; FLASH.ang = ang; FLASH.t = 0;
  slash = 1;
  N.sfx.slice();
  const span = Math.max(V.W, V.H);
  N.particles.line(lx - dx * span, ly - dy * span, lx + dx * span, ly + dy * span, 22, 'spark', '#ffffff');
  finish(scored, angErr, offPct, false);
  if (scored.perfect) {
    N.fx.invert(1);
    N.fx.glitch(0.35, true);
    N.fx.shake(12);
    N.vibrate([25, 30, 80]);
  }
}
function timeout() {
  SHAPE.alive = false;
  const scored = N.grade(100, TH);
  finish(scored, 90, 100, true);
}

function tracePts(pts, n) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function neonShape(col, alpha, fillA) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = hexA(col, fillA);
  ctx.fill();
  ctx.shadowColor = col; ctx.shadowBlur = 22;
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
  ctx.stroke();
}

function drawShape() {
  const missed = N.run.result === RESULT && RESULT.timedOut && N.run.state !== 'aim';
  if (!SHAPE.alive && !missed) return;
  const n = worldPts();
  const alpha = missed ? clamp(1 - N.run.resultT / 0.8, 0, 1) : 1;
  if (alpha <= 0 || n < 3) return;
  const col = missed && Math.floor(N.run.resultT * 10) % 2 === 0 ? '#ff2a2a' : SHAPE.col;
  ctx.save();
  ctx.lineJoin = 'round';
  tracePts(WORLD, n);
  neonShape(col, alpha, 0.16);
  ctx.restore();
  drawPerforation(alpha);
}

function drawPerforation(alpha) {
  const cut = cutWorld();
  const m = chordOf(cut.x, cut.y, cut.ang);
  if (m < 2) return;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.globalAlpha = alpha;
  for (let i = 0; i + 1 < m; i += 2) {
    const ax = CHORD[i][0], ay = CHORD[i][1], bx = CHORD[i + 1][0], by = CHORD[i + 1][1];
    ctx.shadowColor = LASER; ctx.shadowBlur = 12;
    ctx.strokeStyle = LASER; ctx.lineWidth = 2.4;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -N.time * 28;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function drawPieces() {
  if (!pieceCount) return;
  const alpha = clamp(1 - N.run.resultT / 1.25, 0, 1);
  if (alpha <= 0) return;
  for (let i = 0; i < pieceCount; i++) {
    const pc = PIECES[i];
    if (pc.n < 3) continue;
    ctx.save();
    ctx.translate(pc.x, pc.y);
    ctx.rotate(pc.rot);
    ctx.lineJoin = 'round';
    tracePts(pc.pts, pc.n);
    neonShape(pc.col, alpha, 0.24);
    ctx.restore();
  }
}

function drawSlash() {
  if (slash <= 0.02) return;
  const k = slash;
  ctx.save();
  ctx.globalAlpha = k;
  ctx.lineCap = 'round';
  ctx.shadowColor = LASER; ctx.shadowBlur = 28;
  ctx.strokeStyle = hexA(LASER, 0.85); ctx.lineWidth = 8 * k + 1;
  const len = Math.max(V.W, V.H);
  ctx.beginPath();
  ctx.moveTo(FLASH.x - Math.cos(FLASH.ang) * len, FLASH.y - Math.sin(FLASH.ang) * len);
  ctx.lineTo(FLASH.x + Math.cos(FLASH.ang) * len, FLASH.y + Math.sin(FLASH.ang) * len);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2 * k + 0.4;
  ctx.stroke();
  ctx.restore();
}

function drawBlade(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len, uy = dy / len, ext = Math.max(V.W, V.H);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([5, 8]);
  ctx.lineDashOffset = -N.time * 36;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a[0] - ux * ext, a[1] - uy * ext);
  ctx.lineTo(b[0] + ux * ext, b[1] + uy * ext);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const flicker = 0.85 + Math.random() * 0.15;
  ctx.shadowColor = LASER; ctx.shadowBlur = 26;
  ctx.strokeStyle = hexA(LASER, 0.55 * flicker); ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.shadowColor = LASER; ctx.shadowBlur = 18;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(b[0], b[1], 5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Backdrop: a spectrum analyser standing on the floor line the shape must not cross.
// The bars are value noise, not real audio, but they sell the floor as a deadline.
const BAR_N = 26;
function drawAnalyser() {
  const floor = V.playBottom;
  const w = V.W / BAR_N;
  const reach = (V.playBottom - V.playTop) * 0.24;
  const phase = (((N.time - beat0) / BEAT()) % 1 + 1) % 1;
  const kick = Math.pow(1 - phase, 2.4);
  const step = beatIndex();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = hexA(BLUE, 0.16);
  for (let i = 0; i < BAR_N; i++) {
    const env = 0.3 + 0.7 * Math.sin(Math.PI * (i + 0.5) / BAR_N);
    const h = (0.22 + 0.78 * kick) * (0.45 + 0.55 * (0.5 + 0.5 * N.noise1(i * 0.8 + step))) * env * reach;
    ctx.fillRect(i * w + 1, floor - h, w - 2, h);
  }
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = hexA(BLUE, 0.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(floor) + 0.5);
  ctx.lineTo(V.W, Math.round(floor) + 0.5);
  ctx.stroke();
}

N.register({
  id: 'rhythm',
  name: 'NEON SLASH',
  code: 'SLASH',
  desc: 'SLASH THE FALLING CUT',
  accent: BLUE,
  backdrop: drawAnalyser,
  hint: 'SLASH THE DASHED LINE',
  lbGame: 'neon-rhythm-tap',
  tiers: [
    { min: 13500, id: 'god', label: '[ BEAT GOD ]', badge: 'GOD' },
    { min: 11000, id: 'slicer', label: '[ SYNC MASTER ]', badge: 'SYNC' },
    { min: 7500, id: 'human', label: '[ OFF BEAT ]' },
    { min: 0, id: 'butcher', label: '[ WHITE NOISE ]' }
  ],

  start() {
    pieceCount = 0; SHAPE.alive = false; drag = null; slash = 0;
    beat0 = N.time; beatSent = beatIndex() - 1;
    N.initAudio();
    buildSizeDeck();
  },
  stop() {
    pieceCount = 0; SHAPE.alive = false; drag = null; slash = 0;
  },
  round(n) {
    drag = null; slash = 0;
    spawn(n);
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
    if (N.run.state !== 'aim' || !SHAPE.alive) return;
    const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1];
    if (dx * dx + dy * dy < SLASH_MIN * SLASH_MIN) return;
    resolve(Math.atan2(dy, dx), d.a[0], d.a[1]);
  },
  cancel() { drag = null; },

  update(dt) {
    pumpBeat();
    if (SHAPE.alive && N.run.state === 'aim') {
      const t = N.time - SHAPE.launchT;
      if (t < 0) {
        SHAPE.y = SHAPE.y0;
        SHAPE.vy = 0;
      } else {
        SHAPE.vy = SHAPE.vy0 + SHAPE.g * t;
        SHAPE.y = SHAPE.y0 + SHAPE.vy0 * t + 0.5 * SHAPE.g * t * t;
        SHAPE.x += SHAPE.vx * dt;
        const margin = SHAPE.r + 8;
        if (SHAPE.x < margin) { SHAPE.x = margin; SHAPE.vx = Math.abs(SHAPE.vx); }
        else if (SHAPE.x > V.W - margin) { SHAPE.x = V.W - margin; SHAPE.vx = -Math.abs(SHAPE.vx); }
        SHAPE.rot += SHAPE.spin * dt;
      }
      if (SHAPE.y + SHAPE.r < V.playBottom) SHAPE.entered = true;
      if (SHAPE.entered && SHAPE.vy > 0 && SHAPE.y - SHAPE.r > V.playBottom) timeout();
    }
    for (let i = 0; i < pieceCount; i++) {
      const pc = PIECES[i];
      if (pc.n < 3) continue;
      pc.vy += GRAVITY * dt;
      pc.x += pc.vx * dt; pc.y += pc.vy * dt;
      pc.rot += pc.vr * dt;
    }
    slash *= Math.exp(-dt * 5);
  },

  draw() {
    drawShape();
    drawPieces();
    drawSlash();
    if (drag && N.run.state === 'aim') drawBlade(drag.a, drag.b);
  },

  hud() {
    N.text('CUT', V.W / 2, L.labelY, 11, '#ffffff', { alpha: 0.55, glow: 0, spacing: 6 });
    N.duo(String(Math.round(SHAPE.speed)), 'PX/S', L.mainY, L.s, 1, ' ', LASER, BLUE, 0.38);

    if (N.run.result === RESULT && (N.run.state === 'result' || N.run.state === 'over')) {
      const k = clamp(N.run.resultT / 0.18, 0, 1);
      const col = GRADE_COL[RESULT.grade];
      const name = NAMES[RESULT.grade].replace('!', '');
      if (RESULT.timedOut) {
        N.text('TOO LATE', V.W / 2, L.subY, L.subSize * 0.72, col, { alpha: k, glow: 12, spacing: 3 });
      } else {
        N.duo(RESULT.ang.toFixed(1) + '\u00b0', RESULT.off.toFixed(0) + '%', L.subY, L.subSize * 0.85, k, '  ', col, BLUE, 0.85);
      }
      N.text(name, V.W / 2, L.errY, Math.max(11, L.subSize * 0.55), col, { alpha: k, glow: 10, spacing: 3 });
    } else if (N.run.state === 'aim') {
      const a = 0.35 + Math.sin(N.time * 6) * 0.25;
      N.text('MATCH THE CUT', V.W / 2, L.subY, Math.max(11, L.subSize * 0.5), GREEN,
        { alpha: a, glow: 8, spacing: 4 });
      const spin = Math.abs(SHAPE.spin) < 0.05 ? 'HOLD STILL' : 'LINE IS SPINNING';
      N.text(spin, V.W / 2, L.errY, Math.max(10, L.subSize * 0.42), '#ffffff',
        { alpha: 0.35, glow: 0, spacing: 3 });
    }
  }
});
})(window.NEON);
