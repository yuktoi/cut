/**
 * NEON · 03 — NEON PRISM
 *
 * The emitter fires a straight beam off the screen until the player commits a mirror.
 * Dragging only lays down the glass — the bounce is never previewed. On pointer-up the
 * beam is erased and re-cast with r = d − 2(d·n)n, then scored by how close the
 * reflected ray passes the moving target. Round 1 previews the bounce while dragging.
 *
 * Launched by launchGame('NEON_PRISM') through NEON.launch('prism').
 */
(function (N) {
'use strict';

const { V, L, ctx, PINK, BLUE, GOLD, LASER, GREEN, VIOLET, GRADE_COL } = N;
const { clamp, hexA, pick, rand, randInt, lerp, easeOutBack } = N;

const DEG = 180 / Math.PI;
const MIN_MIRROR = 24;
const TOL_ANGLE = 45;
const TH = { p: 1, s: 8, c: 20 };
const AIM_PERFECT = 18;
const AIM_HIT = 46;
const AIM_GRAZE = 88;
// Same size on the same round for every player. Small and large are interleaved
// across the 10-round run so the average target is equal for everyone.
const SIZE_MIX = [0.84, 1.16, 0.68, 1.0, 0.9, 1.24, 0.74, 0.96, 0.62, 1.08];
const SHARD_MAX = 16;
const ZAP = 0.09;                  // seconds for the committed beam to streak out

const src = { x: 0, y: 0, dx: 1, dy: 0 };
const tgt = { x: 0, y: 0, y0: 0, amp: 0, phase: 0, omega: 0, on: false, pts: [], rot: 0, color: GREEN, r: 42, born: 0 };
const shards = [];
for (let i = 0; i < SHARD_MAX; i++) shards.push({ pts: [], x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, life: 0, dur: 0.8 });
let shardN = 0;
const mission = { kind: 'aim', value: 0 };
const SHOT = blankShot();
const LOCKED = blankShot();
const RESULT = { grade: 'rough', pts: 0, err: 0, kind: 'aim', value: 0, raw: 0, dist: 0, call: '' };
let mirror = null, live = false, locked = false;
let impact = 0, zap = 1;

function blankShot() {
  return { ok: false, hx: 0, hy: 0, rx: 1, ry: 0, inc: 0, defl: 0, dist: 0, errNorm: 0, raw: 0, along: 0, hit: false };
}
function ext() { return Math.hypot(V.W, V.H) * 1.3; }
function playBox() {
  const m = (tgt.r || 44) + 12;
  const top = Math.max(m, V.playTop + 6);
  const bottom = Math.min(V.H - m, V.playBottom - 6);
  const left = Math.max(m, V.SAFE.left + m, V.W * 0.18);
  const right = V.W - Math.max(m, V.SAFE.right + 8);
  return {
    left, right: Math.max(left + 8, right),
    top, bottom: Math.max(top + 8, bottom)
  };
}
// Pure sampler so the backdrop can trace the whole orbit without disturbing the live target.
function pathPoint(p, out) {
  const s = Math.sin(p);
  const c = Math.cos(p);
  if (tgt.path === 'horiz') {
    out[0] = tgt.cx + s * tgt.ax;
    out[1] = tgt.cy;
  } else if (tgt.path === 'ellipse') {
    out[0] = tgt.cx + c * tgt.ax;
    out[1] = tgt.cy + s * tgt.ay;
  } else if (tgt.path === 'diag') {
    out[0] = tgt.cx + s * tgt.ax;
    out[1] = tgt.cy + s * tgt.ay;
  } else if (tgt.path === 'liss') {
    out[0] = tgt.cx + s * tgt.ax;
    out[1] = tgt.cy + Math.sin(p * 2) * tgt.ay;
  } else {
    out[0] = tgt.cx;
    out[1] = tgt.cy + s * tgt.ay;
  }
  const box = playBox();
  out[0] = clamp(out[0], box.left, box.right);
  out[1] = clamp(out[1], box.top, box.bottom);
  return out;
}
const PT = [0, 0];
function syncTarget() {
  pathPoint(tgt.phase, PT);
  tgt.x = PT[0];
  tgt.y = PT[1];
}
function zapK() { return 1 - Math.pow(1 - clamp(zap, 0, 1), 3); }

// Distance on the aim mission maps onto the shared 0..100 grade scale.
// Inside AIM_PERFECT → perfect, inside AIM_HIT → success, inside AIM_GRAZE → close.
function aimErr(dist) {
  if (dist <= AIM_PERFECT) return (dist / AIM_PERFECT) * TH.p;
  if (dist <= AIM_HIT) return TH.p + (dist - AIM_PERFECT) / (AIM_HIT - AIM_PERFECT) * (TH.s - TH.p - 0.01);
  if (dist <= AIM_GRAZE) return TH.s + (dist - AIM_HIT) / (AIM_GRAZE - AIM_HIT) * (TH.c - TH.s);
  return TH.c + (dist - AIM_GRAZE) / AIM_GRAZE * 90;
}
function aimCall(dist) {
  if (dist <= AIM_PERFECT) return 'LOCK';
  if (dist <= AIM_HIT) return 'HIT';
  if (dist <= AIM_GRAZE) return 'GRAZE';
  return 'MISS';
}

// Same family of outlines as Perfect Cut, normalised around the origin.
function genShape(round) {
  const pool = round < 2 ? ['circle', 'rect', 'tri']
    : round < 6 ? ['circle', 'rect', 'tri', 'ngon', 'ellipse', 'blob', 'semi']
    : ['circle', 'rect', 'tri', 'ngon', 'ellipse', 'blob', 'star', 'heart', 'cross', 'lshape', 'semi', 'trap'];
  const type = pick(pool);
  const TAU = Math.PI * 2;
  let p = [];
  switch (type) {
    case 'circle':
      for (let i = 0; i < 48; i++) { const t = i / 48 * TAU; p.push([Math.cos(t), Math.sin(t)]); }
      break;
    case 'ellipse': {
      const b = rand(0.45, 0.8);
      for (let i = 0; i < 48; i++) { const t = i / 48 * TAU; p.push([Math.cos(t), Math.sin(t) * b]); }
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
        p.push([Math.cos(t) * rand(0.55, 1), Math.sin(t) * rand(0.55, 1)]);
      }
      break;
    }
    case 'heart':
      for (let i = 0; i < 64; i++) {
        const t = i / 64 * TAU;
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
      for (let i = 0; i <= 32; i++) { const t = Math.PI * i / 32; p.push([Math.cos(t), -Math.sin(t)]); }
      break;
    case 'trap': {
      const top = rand(0.2, 0.7), h = rand(0.5, 0.9), sk = rand(-0.3, 0.3);
      p = [[-1, h], [1, h], [top + sk, -h], [-top + sk, -h]];
      break;
    }
    default:
      p = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  }
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
    a += f; cx += (p[j][0] + p[i][0]) * f; cy += (p[j][1] + p[i][1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    cx = 0; cy = 0;
    for (let i = 0; i < p.length; i++) { cx += p[i][0]; cy += p[i][1]; }
    cx /= p.length; cy /= p.length;
  } else { cx /= 6 * a; cy /= 6 * a; }
  let m = 0;
  for (let i = 0; i < p.length; i++) {
    p[i][0] -= cx; p[i][1] -= cy;
    m = Math.max(m, Math.hypot(p[i][0], p[i][1]));
  }
  if (m > 1e-6) for (let i = 0; i < p.length; i++) { p[i][0] /= m; p[i][1] /= m; }
  return p;
}
function shapeScale() { return 1; }
function densify(pts, minN) {
  if (pts.length >= minN) return pts;
  const n = pts.length;
  const steps = Math.ceil(minN / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
  return out;
}

// Closer to the centre → more wedges, harder kick. A miss leaves the shape whole.
function segHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
function pointInShape(x, y) {
  const c = Math.cos(tgt.rot), s = Math.sin(tgt.rot);
  const dx = x - tgt.x, dy = y - tgt.y;
  const lx = (dx * c + dy * s) / tgt.r, ly = (-dx * s + dy * c) / tgt.r;
  const p = tgt.pts;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if ((yi > ly) !== (yj > ly) && lx < (xj - xi) * (ly - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function shapeWorld(i, out) {
  const p = tgt.pts[i];
  const c = Math.cos(tgt.rot), s = Math.sin(tgt.rot);
  const x = p[0] * tgt.r, y = p[1] * tgt.r;
  out[0] = tgt.x + x * c - y * s;
  out[1] = tgt.y + x * s + y * c;
}
// The visible prism beam is the incoming segment plus the reflected ray.
// A hit is contact with the shape, not only a centre that sits in front of the bounce.
function beamTouches(shot) {
  if (!tgt.on || tgt.pts.length < 3 || !shot.ok) return false;
  const e = ext();
  const x1 = shot.hx + shot.rx * e, y1 = shot.hy + shot.ry * e;
  const A = [0, 0], B = [0, 0];
  const n = tgt.pts.length;
  if (pointInShape(shot.hx, shot.hy) || pointInShape(src.x, src.y)) return true;
  for (let i = 0; i < n; i++) {
    shapeWorld(i, A);
    shapeWorld((i + 1) % n, B);
    if (segHit(src.x, src.y, shot.hx, shot.hy, A[0], A[1], B[0], B[1])) return true;
    if (segHit(shot.hx, shot.hy, x1, y1, A[0], A[1], B[0], B[1])) return true;
  }
  return Math.hypot(tgt.x - shot.hx, tgt.y - shot.hy) <= tgt.r + 8
    || (shot.along > 0 && shot.dist <= tgt.r + 8);
}
function shatter(dist, touched) {
  shardN = 0;
  if (!tgt.on || !tgt.pts.length || (!touched && dist > AIM_GRAZE)) return;
  const t = clamp(1 - dist / AIM_GRAZE, 0, 1);
  const count = Math.max(3, Math.min(SHARD_MAX, Math.round(3 + t * 13)));
  const speed = 160 + t * 520;
  const srcPts = tgt.pts.length >= count * 2 ? tgt.pts : densify(tgt.pts, count * 2);
  const n = srcPts.length;
  const R = tgt.r;
  for (let s = 0; s < count; s++) {
    const sh = shards[s];
    const poly = sh.pts;
    poly.length = 0;
    poly.push([0, 0]);
    const i0 = Math.floor(s * n / count);
    const i1 = Math.floor((s + 1) * n / count);
    const last = Math.max(i0 + 1, i1);
    for (let i = i0; i <= last; i++) {
      const q = srcPts[i % n];
      poly.push([q[0] * R, q[1] * R]);
    }
    let cx = 0, cy = 0, c = 0;
    for (let i = 1; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; c++; }
    cx /= c || 1; cy /= c || 1;
    const len = Math.hypot(cx, cy) || 1;
    sh.x = tgt.x; sh.y = tgt.y;
    sh.vx = cx / len * speed * rand(0.75, 1.2);
    sh.vy = cy / len * speed * rand(0.75, 1.2) - rand(40, 120 + t * 80);
    sh.rot = tgt.rot;
    sh.vr = rand(-1, 1) * (4 + t * 9);
    sh.life = 0.85 + t * 0.45;
    sh.dur = sh.life;
  }
  shardN = count;
  N.fx.shake(4 + t * 12);
  N.fx.flash(0.35 + t * 0.65);
  N.particles.at(tgt.x, tgt.y, Math.round(16 + t * 48), 'spark', tgt.color);
  if (dist > AIM_PERFECT) {
    if (t > 0.75) N.sfx.shatter();
    else N.sfx.slice();
  }
  if (t > 0.85) N.vibrate([16, 20, 28]);
  else N.vibrate(12 + Math.round(t * 20));
}

function placeRound(round) {
  const bandTop = V.playTop + 34, bandBottom = V.playBottom - 34;
  src.x = Math.max(26, V.W * 0.07, V.SAFE.left + 18);
  src.y = rand(bandTop, bandBottom);
  const lim = Math.min(26, 4 + round * 2.5) / DEG;
  const a = rand(-lim, lim);
  src.dx = Math.cos(a);
  src.dy = Math.sin(a);

  mission.kind = 'aim';
  mission.value = 0;

  tgt.on = true;
  placeTarget(round);
}

// The whole shape, including its radius, stays inside the playfield on every path.
function targetRadius(round) {
  const base = clamp(Math.min(V.W, V.H) * 0.052, 42, 54);
  const t = SIZE_MIX[(Math.max(1, round) - 1) % SIZE_MIX.length];
  return base * t;
}
function placeTarget(round) {
  tgt.r = targetRadius(round);
  const box = playBox();
  const bw = Math.max(8, box.right - box.left);
  const bh = Math.max(8, box.bottom - box.top);
  const maxAx = bw * 0.46;
  const maxAy = bh * 0.46;
  tgt.path = pick(['vert', 'horiz', 'ellipse', 'diag', 'liss']);
  const spanX = Math.min(maxAx, Math.max(24, bw * rand(0.22, 0.48)));
  const spanY = Math.min(maxAy, Math.max(24, bh * rand(0.22, 0.5)));
  if (tgt.path === 'vert') { tgt.ax = 0; tgt.ay = spanY; }
  else if (tgt.path === 'horiz') { tgt.ax = spanX; tgt.ay = 0; }
  else if (tgt.path === 'diag') { tgt.ax = spanX * 0.8; tgt.ay = spanY * (Math.random() < 0.5 ? 1 : -1); }
  else { tgt.ax = spanX * 0.75; tgt.ay = spanY * 0.75; }
  const ax = Math.abs(tgt.ax), ay = Math.abs(tgt.ay);
  const x0 = box.left + ax, x1 = Math.max(x0, box.right - ax);
  const y0 = box.top + ay, y1 = Math.max(y0, box.bottom - ay);
  tgt.cx = rand(x0, x1);
  tgt.cy = rand(y0, y1);
  tgt.phase = rand(0, Math.PI * 2);
  tgt.omega = (0.14 + Math.min(round, 10) * 0.02) * Math.PI * 2;
  tgt.pts = genShape(round);
  tgt.rot = rand(0, Math.PI * 2);
  tgt.color = pick([GREEN, PINK, BLUE, VIOLET, GOLD]);
  tgt.born = N.time;
  shardN = 0;
  syncTarget();
}

// Ray o + t d against segment a + u (b − a).
// t = ((a − o) × e) / (d × e),  u = ((a − o) × d) / (d × e),  with × the 2D cross.
function raySegT(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return -1;
  const wx = ax - ox, wy = ay - oy;
  const t = (wx * ey - ex * wy) / den;
  const u = (wx * dy - dx * wy) / den;
  if (t <= 1e-4 || u < 0 || u > 1) return -1;
  return t;
}

// Reflection about a unit normal: r = d − 2(d·n)n. Flipping n does not change r.
// Incidence is measured from the normal, so the beam's turn is θ_d = 180° − 2θ_i.
function computeShot(out, ax, ay, bx, by) {
  out.ok = false;
  out.hit = false;
  const mx = bx - ax, my = by - ay, ml = Math.hypot(mx, my);
  if (ml < 1) return out;
  const t = raySegT(src.x, src.y, src.dx, src.dy, ax, ay, bx, by);
  if (t < 0) return out;

  out.hx = src.x + src.dx * t;
  out.hy = src.y + src.dy * t;

  const ux = mx / ml, uy = my / ml;
  const nx = -uy, ny = ux;
  const dn = src.dx * nx + src.dy * ny;
  out.rx = src.dx - 2 * dn * nx;
  out.ry = src.dy - 2 * dn * ny;
  const rl = Math.hypot(out.rx, out.ry) || 1;
  out.rx /= rl;
  out.ry /= rl;

  out.inc = Math.acos(clamp(Math.abs(dn), 0, 1)) * DEG;
  out.defl = 180 - 2 * out.inc;

  const wx = tgt.on ? tgt.x - out.hx : 0;
  const wy = tgt.on ? tgt.y - out.hy : 0;
  out.along = wx * out.rx + wy * out.ry;
  out.dist = !tgt.on ? 0
    : out.along <= 0
      ? Math.hypot(wx, wy)
      : Math.abs(out.rx * wy - out.ry * wx);

  if (mission.kind === 'aim') {
    out.raw = out.dist;
    out.errNorm = aimErr(out.dist);
    out.hit = out.along > 0 && out.dist <= AIM_HIT;
  } else {
    out.raw = mission.kind === 'defl' ? out.defl : out.inc;
    out.errNorm = Math.abs(out.raw - mission.value) / TOL_ANGLE * 100;
    out.hit = false;
  }
  out.ok = true;
  return out;
}
function copyShot(from, to) {
  to.ok = from.ok; to.hx = from.hx; to.hy = from.hy; to.rx = from.rx; to.ry = from.ry;
  to.inc = from.inc; to.defl = from.defl; to.dist = from.dist;
  to.errNorm = from.errNorm; to.raw = from.raw; to.along = from.along; to.hit = from.hit;
}

function fire() {
  copyShot(SHOT, LOCKED);
  locked = true;
  live = false;
  impact = 1;
  zap = 0;
  syncTarget();

  const touched = beamTouches(LOCKED);
  let dist = LOCKED.dist;
  if (touched) dist = Math.min(dist, Math.max(tgt.r, AIM_GRAZE));
  if (mission.kind === 'aim' || touched) {
    LOCKED.dist = dist;
    LOCKED.raw = dist;
    LOCKED.errNorm = aimErr(dist);
    LOCKED.hit = touched || (LOCKED.along > 0 && dist <= AIM_HIT);
  }
  const scored = N.grade(LOCKED.errNorm, TH);
  const whiff = !touched && mission.kind === 'aim' && dist > AIM_GRAZE;
  if (whiff) {
    scored.pts = 0;
    scored.grade = 'rough';
    scored.perfect = false;
    LOCKED.errNorm = 100;
  }
  RESULT.grade = scored.grade;
  RESULT.pts = scored.pts;
  RESULT.err = LOCKED.errNorm;
  RESULT.kind = mission.kind;
  RESULT.value = mission.value;
  RESULT.raw = LOCKED.raw;
  RESULT.dist = LOCKED.dist;
  RESULT.call = (mission.kind === 'aim' || touched) ? (whiff ? 'MISS' : aimCall(dist)) : '';
  N.commit(RESULT);

  N.sfx.beam();
  const e = ext();
  const bx = LOCKED.hx + LOCKED.rx * e, by = LOCKED.hy + LOCKED.ry * e;
  const emit = (kind, n, col) => {
    N.particles.at(LOCKED.hx, LOCKED.hy, Math.ceil(n * 0.6), kind, col);
    N.particles.line(LOCKED.hx, LOCKED.hy, lerp(LOCKED.hx, bx, 0.35), lerp(LOCKED.hy, by, 0.35),
      Math.ceil(n * 0.4), kind, col);
  };
  N.juice(scored, emit, V.CX, V.CY, whiff ? { rough: 'MISS' } : undefined);

  shatter(dist, touched);
  if (scored.perfect) {
    N.fx.glitch(0.5, true);
    N.fx.shake(13);
    N.fx.invert(0.85);
    N.fx.scanlines();
    N.sfx.shatter();
    N.vibrate([20, 25, 20, 25, 80]);
    if (tgt.on) N.particles.at(tgt.x, tgt.y, 60, 'gold');
  }
}

function beam(ax, ay, bx, by, col, w, glow, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha === undefined ? 1 : alpha;
  ctx.lineCap = 'round';
  ctx.shadowColor = col; ctx.shadowBlur = glow;
  ctx.strokeStyle = hexA(col, 0.55);
  ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = glow * 0.5;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, w * 0.3);
  ctx.stroke();
  ctx.restore();
}
function dispersedBeam(hx, hy, rx, ry, reach, alpha) {
  const base = Math.atan2(ry, rx);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const fan = [
    { a: -0.9 / DEG, col: '#ff2a5a' },
    { a: 0, col: GREEN },
    { a: 0.9 / DEG, col: '#2a6cff' }
  ];
  for (let i = 0; i < fan.length; i++) {
    const ang = base + fan[i].a;
    ctx.globalAlpha = 0.34 * alpha;
    ctx.shadowColor = fan[i].col; ctx.shadowBlur = 22;
    ctx.strokeStyle = fan[i].col; ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + Math.cos(ang) * reach, hy + Math.sin(ang) * reach);
    ctx.stroke();
  }
  ctx.restore();
  beam(hx, hy, hx + rx * reach, hy + ry * reach, LASER, 4.5, 26, alpha);
}
function drawPrismGuide() {
  if (N.run.round !== 1 || !live || locked || !SHOT.ok) return;
  const e = ext();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([7, 9]);
  ctx.lineDashOffset = -N.time * 40;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = hexA(LASER, 0.9);
  ctx.shadowColor = LASER;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(src.x, src.y);
  ctx.lineTo(SHOT.hx, SHOT.hy);
  ctx.lineTo(SHOT.hx + SHOT.rx * e, SHOT.hy + SHOT.ry * e);
  ctx.stroke();
  ctx.restore();
}
function drawEmitter() {
  const p = 0.7 + Math.sin(N.time * 8) * 0.3;
  ctx.save();
  ctx.translate(src.x, src.y);
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 16 * p;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(0, 0, 3 + p, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function traceLocal(pts, n) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function drawNeonPoly(pts, n, col, alpha, fillA, lw) {
  if (n < 3 || alpha <= 0) return;
  const w = lw || 3;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  traceLocal(pts, n);
  ctx.fillStyle = hexA(col, fillA);
  ctx.fill();
  ctx.shadowColor = col; ctx.shadowBlur = w < 2 ? w * 7 : 22;
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = w * 0.38;
  ctx.stroke();
  ctx.restore();
}
function drawTarget() {
  if (!tgt.on || shardN > 0 || tgt.pts.length < 3) return;
  const miss = locked && RESULT.call === 'MISS';
  const col = miss ? '#ff2a5a' : tgt.color;
  const k = shapeScale();
  const sc = tgt.r * k || 1;
  ctx.save();
  ctx.translate(tgt.x, tgt.y);
  ctx.rotate(tgt.rot);
  ctx.scale(sc, sc);
  const pulse = miss ? 0.12 : 0.18 + Math.sin(N.time * 3) * 0.04;
  drawNeonPoly(tgt.pts, tgt.pts.length, col, miss ? 0.7 : 1, pulse, 3 / sc);
  ctx.restore();
}
function stepShards(dt) {
  for (let i = 0; i < shardN; i++) {
    const s = shards[i];
    if (s.life <= 0) continue;
    s.vy += 520 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.rot += s.vr * dt;
    s.life -= dt;
  }
}
function drawShards() {
  for (let i = 0; i < shardN; i++) {
    const s = shards[i];
    if (s.life <= 0 || s.pts.length < 3) continue;
    const a = clamp(s.life / s.dur, 0, 1);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.rot);
    drawNeonPoly(s.pts, s.pts.length, tgt.color, a, 0.28);
    ctx.restore();
  }
}
function drawMirror(m, alpha) {
  const mx = m.bx - m.ax, my = m.by - m.ay, ml = Math.hypot(mx, my) || 1;
  const ux = mx / ml, uy = my / ml;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  const g = ctx.createLinearGradient(m.ax, m.ay, m.bx, m.by);
  g.addColorStop(0, hexA(BLUE, 0.9));
  g.addColorStop(0.5, hexA(VIOLET, 0.9));
  g.addColorStop(1, hexA(PINK, 0.9));
  ctx.shadowColor = VIOLET; ctx.shadowBlur = 26;
  ctx.strokeStyle = g; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(m.ax, m.ay); ctx.lineTo(m.bx, m.by); ctx.stroke();
  ctx.shadowBlur = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = alpha * 0.4;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 11;
  for (let d = step; d < ml; d += step) {
    const x = m.ax + ux * d, y = m.ay + uy * d;
    ctx.moveTo(x - uy * 4, y + ux * 4);
    ctx.lineTo(x + uy * 4, y - ux * 4);
  }
  ctx.stroke();
  ctx.restore();
}
function drawPhoton() {
  if (!locked || zap >= 1) return;
  const k = zapK();
  const e = ext();
  const x = LOCKED.hx + LOCKED.rx * e * k, y = LOCKED.hy + LOCKED.ry * e * k;
  ctx.save();
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 28;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawImpact() {
  if (impact <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = impact * 0.8;
  ctx.shadowColor = LASER; ctx.shadowBlur = 30;
  ctx.strokeStyle = hexA(LASER, 0.8); ctx.lineWidth = 2 + impact * 3;
  ctx.beginPath();
  ctx.arc(LOCKED.hx, LOCKED.hy, (1 - impact) * 90 + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Backdrop: a faint optical axis behind the emitter. No orbit rail and no aperture rings.
function drawBench() {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = hexA(GREEN, 0.22);
  ctx.setLineDash([2, 9]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(src.y) + 0.5);
  ctx.lineTo(V.W, Math.round(src.y) + 0.5);
  ctx.stroke();
  ctx.restore();
}

N.register({
  id: 'prism',
  name: 'NEON PRISM',
  code: 'PRISM',
  desc: 'RELEASE TO BEND. TIME THE TARGET.',
  accent: GREEN,
  backdrop: drawBench,
  hint: 'DRAG TO MIRROR',
  lbGame: 'neon-prism',
  beam: src,
  goal: tgt,
  mission,
  tiers: [
    { min: 13500, id: 'god', label: '[ LIGHT GOD ]', badge: 'GOD' },
    { min: 11000, id: 'slicer', label: '[ PRISM MASTER ]', badge: 'PRISM' },
    { min: 7500, id: 'human', label: '[ REFRACTED ]' },
    { min: 0, id: 'butcher', label: '[ BLACKOUT ]' }
  ],

  start() { mirror = null; live = false; locked = false; impact = 0; zap = 1; shardN = 0; },
  stop() { mirror = null; live = false; locked = false; shardN = 0; },
  layout() { if (N.run.game === this && N.run.state !== 'menu' && !locked) placeRound(N.run.round || 1); },
  round(n) {
    mirror = null; live = false; locked = false; impact = 0; zap = 1; shardN = 0;
    SHOT.ok = false; LOCKED.ok = false;
    placeRound(n);
  },

  hintVisible() { return !live; },

  down(x, y) {
    mirror = { ax: x, ay: y, bx: x, by: y };
    live = true;
    SHOT.ok = false;
  },
  move(x, y) {
    if (!live || !mirror) return;
    mirror.bx = x;
    mirror.by = y;
    if (N.run.round === 1) {
      syncTarget();
      computeShot(SHOT, mirror.ax, mirror.ay, mirror.bx, mirror.by);
    } else SHOT.ok = false;
  },
  up() {
    if (!live || !mirror) return;
    const len = Math.hypot(mirror.bx - mirror.ax, mirror.by - mirror.ay);
    if (len < MIN_MIRROR) {
      live = false; mirror = null; SHOT.ok = false;
      N.sfx.miss();
      N.pop('DRAW A LONGER MIRROR', V.CX, V.CY, L.pop * 0.3, 'rgba(255,255,255,0.75)', 0.7);
      return;
    }
    syncTarget();
    computeShot(SHOT, mirror.ax, mirror.ay, mirror.bx, mirror.by);
    if (!SHOT.ok) {
      live = false; mirror = null;
      N.sfx.miss();
      N.pop('NO CONTACT', V.CX, V.CY, L.pop * 0.4, 'rgba(255,255,255,0.75)', 0.7);
      return;
    }
    fire();
  },
  cancel() { live = false; mirror = null; SHOT.ok = false; },

  update(dt) {
    if (impact > 0) impact *= Math.exp(-dt * 6.5);
    stepShards(dt);
    if (locked) {
      if (zap < 1) zap = Math.min(1, zap + dt / ZAP);
      return;
    }
    if (tgt.on) {
      tgt.phase += tgt.omega * dt;
      syncTarget();
    }
  },

  draw() {
    const e = ext();
    drawPrismGuide();

    if (!locked) {
      const flicker = 0.88 + Math.random() * 0.12;
      beam(src.x, src.y, src.x + src.dx * e, src.y + src.dy * e, LASER, 6, 26, flicker);
    } else {
      const k = zapK();
      const flicker = 0.92 + Math.random() * 0.08;
      beam(src.x, src.y, LOCKED.hx, LOCKED.hy, LASER, 6, 26, flicker);
      dispersedBeam(LOCKED.hx, LOCKED.hy, LOCKED.rx, LOCKED.ry, e * k, 0.45 + 0.55 * k);
    }

    drawTarget();
    drawShards();
    if (mirror) drawMirror(mirror, live ? 0.95 : 1);
    drawImpact();
    drawPhoton();
    drawEmitter();
  },

  hud() {
    N.text('MISSION', V.W / 2, L.labelY, 11, '#ffffff', { alpha: 0.55, glow: 0, spacing: 6 });
    N.text(live ? 'HOLD' : 'TARGET LOCK', V.W / 2, L.mainY, L.s * 0.56, GOLD, { weight: 900, glow: 26, spacing: 3 });

    if (N.run.result === RESULT && (N.run.state === 'result' || N.run.state === 'over')) {
      const k = clamp(N.run.resultT / 0.18, 0, 1);
      const col = GRADE_COL[RESULT.grade];
      N.duo(LOCKED.dist.toFixed(1), 'PX', L.subY, L.subSize, k, ' ', col, BLUE, 0.45);
      N.text(RESULT.call, V.W / 2, L.errY, Math.max(11, L.subSize * 0.55), col,
        { alpha: k, glow: 10, spacing: 3 });
    }
  }
});
})(window.NEON);
