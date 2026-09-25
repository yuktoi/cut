/**
 * NEON — shared engine for the three minigames.
 *
 * Games register themselves with NEON.register() and get a canvas, an audio graph,
 * a particle/pop pool, the glitch stack and the 10-round scoring loop for free.
 * Every game funnels its judgment through NEON.grade() + NEON.commit() so scores,
 * ranks and the global top 10 read the same across the whole app.
 */
window.NEON = (function () {
'use strict';

// ---------- Tuning ----------
const ROUNDS = 10;
const PERFECT_BONUS = 200;
const ROUND_CAP = 1000 + PERFECT_BONUS;   // 1,200 at zero error
// A chain is consecutive rounds graded perfect or success; close and rough break it.
// Milestones pay out once each, so a flawless run banks the full 3,000.
const CHAIN_BONUS = { 3: 300, 5: 600, 7: 900, 10: 1200 };
const CHAIN_MAX = 3000;
const CHAIN_CUE = 0.42;                   // delay so the milestone lands after the round call
const MAX_SCORE = ROUNDS * ROUND_CAP + CHAIN_MAX;   // 15,000
const RESULT_TIME = 1.5;                  // pause so the round score can be read
const PINK = '#ff0055', BLUE = '#00f0ff', GOLD = '#ffd700', LASER = '#ffe600',
      GREEN = '#39FF14', VIOLET = '#b026ff';
const FONT = "'Orbitron','Courier New',monospace";
const GRADE_COL = { perfect: '#ffffff', success: GOLD, close: '#bbbbbb', rough: '#ff2a2a' };
const HITSTOP_SCALE = 0.12;

const $ = id => document.getElementById(id);
const body = document.body;
const cvs = $('c');
const ctx = cvs.getContext('2d');

// ---------- Utils ----------
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const RGB_CACHE = {};
function hexRgb(hex) {
  let c = RGB_CACHE[hex];
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = RGB_CACHE[hex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return c;
}
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// Deterministic value noise, used for the fuzz on the rhythm waveform.
function hash1(x) {
  const s = Math.sin(x * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
}

let vibOn = true;
function vibrate(p) {
  if (!vibOn) return;
  try { navigator.vibrate && navigator.vibrate(p); } catch (e) {}
}

// ---------- Layout ----------
// V holds live viewport/play-field metrics, L the shared vertical rhythm of the mission HUD.
// Both are mutated in place on resize so games can hold a reference instead of re-reading.
const V = {
  W: 0, H: 0, DPR: 1, CX: 0, CY: 0, R: 100,
  playTop: 0, playBottom: 0,
  SAFE: { top: 0, right: 0, bottom: 0, left: 0 },
  chrome: { scoreLabel: 26, scoreValue: 54, chainY: 78, roundLabel: 26, roundValue: 50, clear: 90, scoreX: 18 }
};
const L = { s: 40, labelY: 0, mainY: 0, subSize: 20, subY: 0, errY: 0, pop: 60 };
let bgGlow = null, vignette = null, heatGlow = null, heatBucket = -1;

function readSafe() {
  const el = $('safe');
  if (!el) return;
  const r = el.getBoundingClientRect();
  V.SAFE = {
    top: r.top,
    left: r.left,
    right: Math.max(0, window.innerWidth - r.right),
    bottom: Math.max(0, window.innerHeight - r.bottom)
  };
}
function layoutChrome() {
  let btm = V.SAFE.top;
  for (const id of ['hudToggles', 'hudHome']) {
    const el = $(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0) btm = Math.max(btm, r.bottom);
  }
  const scoreLabel = Math.max(26, V.SAFE.top + 16, btm + 20);
  const roundLabel = scoreLabel;
  const chainY = scoreLabel + 52;
  V.chrome = {
    scoreLabel,
    scoreValue: scoreLabel + 28,
    chainY,
    roundLabel,
    roundValue: roundLabel + 24,
    clear: Math.max(scoreLabel + 46, roundLabel + 40, chainY + 12),
    scoreX: Math.max(18, V.W * 0.04, V.SAFE.left + 12)
  };
}
function resize() {
  V.DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  V.W = window.innerWidth; V.H = window.innerHeight;
  cvs.width = Math.round(V.W * V.DPR); cvs.height = Math.round(V.H * V.DPR);
  readSafe();
  layoutChrome();

  const s = Math.min(V.W * 0.11, V.H * 0.085, 56);
  L.s = s;
  L.labelY = Math.max(64, V.H * 0.1, V.chrome.clear);
  L.mainY = L.labelY + s * 0.95;
  L.subSize = s * 0.5;
  L.subY = L.mainY + s * 0.95;
  L.errY = L.subY + L.subSize * 1.25;
  L.pop = Math.min(V.W * 0.13, 76);

  V.playTop = L.errY + L.subSize * 0.9 + 10;
  V.playBottom = V.H - Math.max(34, V.H * 0.06, V.SAFE.bottom + 28);
  V.CX = V.W / 2;
  V.CY = (V.playTop + V.playBottom) / 2;
  V.R = Math.max(40, Math.min(V.W * 0.4, (V.playBottom - V.playTop) / 2, 300));

  bgGlow = ctx.createRadialGradient(V.CX, V.CY, 0, V.CX, V.CY, Math.max(V.W, V.H) * 0.7);
  bgGlow.addColorStop(0, 'rgba(110,0,160,0.28)');
  bgGlow.addColorStop(0.5, 'rgba(60,0,90,0.10)');
  bgGlow.addColorStop(1, 'rgba(0,0,0,0)');
  vignette = ctx.createRadialGradient(V.W / 2, V.H / 2, Math.min(V.W, V.H) * 0.3, V.W / 2, V.H / 2, Math.max(V.W, V.H) * 0.8);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.85)');
  heatBucket = -1;

  for (const g of games) if (g.layout) g.layout();
}

// ---------- Audio ----------
let AC = null, master = null, noiseBuf = null;
let muted = false;
const MASTER_GAIN = 0.55;
function applyMasterVolume() {
  if (!master || !AC) return;
  const now = AC.currentTime;
  const target = muted ? 0 : MASTER_GAIN;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(target, now + 0.02);
}
function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = muted ? 0 : MASTER_GAIN;
    const comp = AC.createDynamicsCompressor();
    master.connect(comp); comp.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { AC = null; }
}
function syncMuteButton() {
  const btn = $('sound');
  if (!btn) return;
  const on = !muted;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
}
function toggleMute() {
  initAudio();
  muted = !muted;
  applyMasterVolume();
  syncMuteButton();
  if (!muted) sfx.click();
}
function syncVibButton() {
  const btn = $('vib');
  if (!btn) return;
  btn.setAttribute('aria-pressed', vibOn ? 'true' : 'false');
  btn.setAttribute('aria-label', vibOn ? 'Vibration on' : 'Vibration off');
}
function toggleVib() {
  vibOn = !vibOn;
  if (!vibOn) { try { navigator.vibrate && navigator.vibrate(0); } catch (e) {} }
  syncVibButton();
  if (vibOn) { try { navigator.vibrate && navigator.vibrate(20); } catch (e) {} }
}
function tone(freq, dur, type = 'sine', vol = 0.3, when = 0, slideTo = null) {
  if (!AC) return;
  const t = AC.currentTime + when;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, vol, f0, f1, q = 1, when = 0) {
  if (!AC) return;
  const t = AC.currentTime + when;
  const src = AC.createBufferSource(); src.buffer = noiseBuf;
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t); src.stop(t + dur + 0.05);
}
// Kills the whole bus for `dur` seconds — the "tape stops dead" beat before a bass drop.
function cutout(dur = 0.07) {
  if (!AC || !master) return;
  const t = AC.currentTime;
  const target = muted ? 0.0001 : MASTER_GAIN;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0.0001, t + 0.012);
  master.gain.setValueAtTime(0.0001, t + dur);
  master.gain.linearRampToValueAtTime(target, t + dur + 0.04);
}
const sfx = {
  slice()   { noise(0.22, 0.6, 7000, 700, 0.9); tone(1800, 0.14, 'sawtooth', 0.05, 0, 220); tone(90, 0.12, 'sine', 0.25, 0, 45); },
  ding()    { tone(1318.5, 0.7, 'sine', 0.28, 0.04); tone(2637, 0.45, 'sine', 0.08, 0.04); tone(1975.5, 0.5, 'triangle', 0.05, 0.1); },
  perfect() {
    [1046.5, 1318.5, 1568, 2093, 2637].forEach((f, i) => {
      tone(f, 0.55, 'triangle', 0.16, 0.04 + i * 0.06);
      tone(f * 2, 0.3, 'sine', 0.05, 0.04 + i * 0.06);
    });
    tone(120, 0.5, 'sine', 0.5, 0, 38);
    noise(0.6, 0.15, 9000, 3000, 0.5, 0.05);
  },
  close()   { tone(620, 0.16, 'square', 0.05, 0.03); tone(465, 0.2, 'square', 0.04, 0.1); },
  fail()    { tone(240, 0.8, 'sawtooth', 0.18, 0.05, 45); tone(120, 0.9, 'square', 0.1, 0.05, 30); },
  miss()    { tone(260, 0.07, 'square', 0.04); },
  click()   { tone(880, 0.09, 'sine', 0.15); tone(1760, 0.06, 'sine', 0.05, 0.03); },
  hover()   { tone(1480, 0.04, 'square', 0.035); tone(2200, 0.028, 'sine', 0.025, 0.012); },
  tick(hard) {
    tone(hard ? 1568 : 1046.5, 0.05, 'square', hard ? 0.13 : 0.05);
    noise(0.03, hard ? 0.11 : 0.04, 6500, 2800, 1.4);
  },
  go()      { tone(1318.5, 0.18, 'triangle', 0.2); tone(2637, 0.12, 'sine', 0.07, 0.02); noise(0.12, 0.16, 9000, 2500, 0.7); },
  bass(when = 0) {
    tone(58, 0.85, 'sine', 0.72, when, 26);
    tone(116, 0.36, 'triangle', 0.16, when);
    noise(0.5, 0.18, 420, 60, 0.6, when);
  },
  beam()    { tone(2200, 0.45, 'sawtooth', 0.05, 0, 900); noise(0.35, 0.06, 5200, 1200, 3); },
  shatter() { noise(0.45, 0.3, 12000, 900, 0.6); tone(180, 0.5, 'square', 0.1, 0, 60); },
  // Each milestone transposes the same major arpeggio up a whole tone, so the ladder is audible.
  chain(step) {
    const root = 523.25 * Math.pow(2, step * 2 / 12);
    [0, 4, 7, 12].forEach((s, i) => {
      tone(root * Math.pow(2, s / 12), 0.42, 'triangle', 0.15, i * 0.055);
      tone(root * Math.pow(2, s / 12) * 2, 0.22, 'sine', 0.04, i * 0.055);
    });
    tone(110, 0.55, 'sine', 0.38, 0, 55);
  },
  chainBreak() { tone(330, 0.26, 'sawtooth', 0.12, 0, 88); noise(0.22, 0.1, 2400, 300, 0.8); }
};

// Lobby bed: synthesized, so a missing audio file can never 404.
const BEAT = 0.46;
const LOBBY_ARP = [82.41, 98, 123.47, 146.83, 123.47, 98, 73.42, 110];
let bgmTimer = null, bgmStep = 0;
function startLobbyBgm() {
  if (bgmTimer || !AC) return;
  const tick = () => {
    if (!AC || muted || document.hidden) return;
    const f = LOBBY_ARP[bgmStep % LOBBY_ARP.length];
    tone(f, 0.46, 'sine', 0.04);
    tone(f * 2, 0.2, 'triangle', 0.016, 0.03);
    if (bgmStep % 8 === 0) tone(f / 2, 0.7, 'sine', 0.028);
    bgmStep++;
  };
    try { tick(); bgmTimer = setInterval(tick, BEAT * 1000); } catch (e) { bgmTimer = null; }
}
function stopLobbyBgm() {
  if (bgmTimer) clearInterval(bgmTimer);
  bgmTimer = null;
}

// ---------- Screen FX ----------
const fx = { shake: 0, flash: 0, gold: 0, hitstop: 0, invert: 0, glitchT: 0, glitchDur: 0.2, heavy: false };
let glitchTimer = 0;
function glitch(dur = 0.2, heavy = false) {
  fx.glitchT = dur; fx.glitchDur = dur; fx.heavy = heavy;
  body.classList.remove('gfx', 'gfx-heavy');
  void body.offsetWidth;                       // restart the CSS animations mid-flight
  body.style.setProperty('--gdur', dur + 's');
  body.classList.add('gfx');
  if (heavy) body.classList.add('gfx-heavy');
  clearTimeout(glitchTimer);
  glitchTimer = setTimeout(() => {
    body.classList.remove('gfx', 'gfx-heavy');
    fx.glitchT = 0;
  }, dur * 1000);
}
function clearGlitch() {
  clearTimeout(glitchTimer);
  body.classList.remove('gfx', 'gfx-heavy');
  fx.glitchT = 0;
}
const FX = {
  shake(v)   { fx.shake = Math.max(fx.shake, v); },
  flash(v)   { fx.flash = Math.max(fx.flash, v); },
  gold(v)    { fx.gold = Math.max(fx.gold, v); },
  hitstop(v) { fx.hitstop = Math.max(fx.hitstop, v); },
  invert(v)  { fx.invert = Math.max(fx.invert, v); },
  glitch,
  scanlines() {
    const el = $('static');
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }
};

// ---------- Particles ----------
// Fixed pool with an active-count pointer. Dead entries are swapped past the pointer,
// so structs recycle forever and nothing reaches the GC.
const PARTICLE_CAP = 1024;
const pool = new Array(PARTICLE_CAP);
for (let i = 0; i < PARTICLE_CAP; i++) {
  pool[i] = { x: 0, y: 0, vx: 0, vy: 0, g: 0, fr: 0, life: 0, max: 1, size: 0,
    kind: 'dot', col: '#ffffff', hue: 0, rot: 0, vr: 0 };
}
let particleCount = 0;
function take() { return particleCount < PARTICLE_CAP ? pool[particleCount++] : null; }
const MK = {
  confetti(p, x, y) {
    const a = rand(0, Math.PI * 2), sp = rand(180, 720);
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp - 180;
    p.g = 750; p.fr = 0.25; p.life = rand(0.9, 1.7); p.max = 1.7; p.size = rand(5, 10);
    p.hue = rand(0, 360); p.rot = rand(0, 6.28); p.vr = rand(-14, 14); p.kind = 'rect';
  },
  gold(p, x, y) {
    const a = rand(0, Math.PI * 2), sp = rand(60, 340);
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp - 60;
    p.g = 320; p.fr = 0.3; p.life = rand(0.5, 1.0); p.max = 1.0; p.size = rand(1.5, 3.6); p.kind = 'dot';
    p.col = Math.random() < 0.8 ? GOLD : '#fff6c0';
  },
  spark(p, x, y, col) {
    const a = rand(0, Math.PI * 2), sp = rand(80, 300);
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    p.g = 150; p.fr = 0.15; p.life = rand(0.25, 0.55); p.max = 0.55; p.size = rand(1, 2.4); p.kind = 'dot';
    p.col = col || '#ffffff';
  },
  dust(p, x, y, col) {
    const a = rand(0, Math.PI * 2), sp = rand(40, 220);
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    p.g = 200; p.fr = 0.2; p.life = rand(0.15, 0.35); p.max = 0.35; p.size = rand(1, 2.4); p.kind = 'dot';
    p.col = col || LASER;
  }
};
const particles = {
  at(x, y, n, kind, col) {
    const make = MK[kind] || MK.spark;
    for (let i = 0; i < n; i++) { const p = take(); if (!p) return; make(p, x, y, col); }
  },
  // Scatters along a sampled point set: cut chords, beam paths, waveform crests.
  along(pts, pn, n, kind, col) {
    const make = MK[kind] || MK.spark;
    for (let i = 0; i < n; i++) {
      const p = take(); if (!p) return;
      const q = pts[Math.floor(Math.random() * pn)];
      make(p, q[0], q[1], col);
    }
  },
  line(ax, ay, bx, by, n, kind, col) {
    const make = MK[kind] || MK.spark;
    for (let i = 0; i < n; i++) {
      const p = take(); if (!p) return;
      const t = Math.random();
      make(p, lerp(ax, bx, t), lerp(ay, by, t), col);
    }
  }
};

// ---------- Pops ----------
const POP_CAP = 16;
const popPool = new Array(POP_CAP);
for (let i = 0; i < POP_CAP; i++) {
  popPool[i] = { text: '', x: 0, y: 0, size: 0, color: null, dur: 1, rainbow: false, t: 0, pts: false };
}
const POP_SINK = { text: '', x: 0, y: 0, size: 0, color: null, dur: 1, rainbow: false, t: 0, pts: false };
let popCount = 0;
function pop(text, x, y, size, color, dur, rainbow = false, delay = 0) {
  if (popCount >= POP_CAP) return POP_SINK;
  const p = popPool[popCount++];
  p.text = text; p.x = x; p.y = y; p.size = size; p.color = color; p.dur = dur;
  p.rainbow = rainbow; p.t = -delay; p.pts = false;
  return p;
}

// ---------- Scoring ----------
// Every game normalises its own error onto the same 0..100 scale where 100 means "no points".
// RoundScore = max(0, 1000 - floor(errNorm * 10)); PERFECT adds +200, so 1,200 is the round cap.
function grade(errNorm, th) {
  const base = Math.max(0, 1000 - Math.floor(errNorm * 10));
  let g;
  if (errNorm <= th.p) g = 'perfect';
  else if (errNorm < th.s) g = 'success';
  else if (errNorm <= th.c) g = 'close';
  else g = 'rough';
  return { pts: g === 'perfect' ? base + PERFECT_BONUS : base, grade: g, perfect: g === 'perfect' };
}
function tierFor(game, score) {
  const tiers = game.tiers;
  for (const t of tiers) if (score >= t.min) return t;
  return tiers[tiers.length - 1];
}
function tierById(game, id) {
  for (const t of game.tiers) if (t.id === id) return t;
  return null;
}

// Shared round juice. `emit(kind, n, col)` lets each game scatter particles along its own
// geometry — the cut chord, the waveform crest, the beam impact — with identical pacing.
function juice(res, emit, px, py, names) {
  const g = res.grade;
  const call = names || {};
  const x = px === undefined ? V.CX : px;
  const y = py === undefined ? V.CY : py;
  const e = emit || function () {};
  const label = g === 'perfect' ? `+${fmt(res.pts)} PERFECT BONUS!` : `+${fmt(res.pts)} PTS`;
  pop(label, x, y + L.pop * 0.92, g === 'perfect' ? L.pop * 0.32 : L.pop * 0.46,
    g === 'rough' ? '#ff2a2a' : GOLD, 1.4).pts = true;

  if (g === 'perfect') {
    FX.shake(5); FX.flash(1); FX.gold(1); FX.hitstop(0.14);
    glitch(0.2);
    e('confetti', 170);
    pop(call.perfect || 'PERFECT!', x, y - L.pop * 0.15, L.pop * 0.82, null, 1.35, true);
    sfx.perfect(); vibrate([30, 40, 60]);
  } else if (g === 'success') {
    FX.shake(5); FX.gold(0.9);
    e('gold', 55);
    pop(call.success || 'SUCCESS', x, y - L.pop * 0.05, L.pop * 0.62, GOLD, 1.2);
    sfx.ding(); vibrate(20);
  } else if (g === 'close') {
    FX.shake(3);
    e('spark', 14, '#bbbbbb');
    sfx.close();
    if (call.close) pop(call.close, x, y - L.pop * 0.05, L.pop * 0.55, '#d8d8d8', 1.1);
  } else {
    FX.shake(8);
    e('spark', 28, '#ff2a2a');
    sfx.fail(); vibrate(40);
    if (call.rough) pop(call.rough, x, y - L.pop * 0.05, L.pop * 0.55, '#ff2a2a', 1.1);
  }
}

// ---------- Storage ----------
function bestKey(id) { return 'neon_best_' + id + '_v1'; }
function lbKey(id) { return 'neon_lb_' + id + '_v1'; }
// Keys the lobby contract reads and writes. Legacy neon_best_* stays in sync.
const SPEC_HIGH = { cut: 'perfect_cut_high', rhythm: 'rhythm_tap_high', prism: 'neon_prism_high' };
// PERFECT CUT shipped standalone, so its old keys are still honoured as a fallback.
const LEGACY = { cut: { best: 'perfectcut_best_v1', lb: 'perfectcut_leaderboard_v1' } };
function readNum(key) {
  try {
    const v = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(v) ? v : 0;
  } catch (e) { return 0; }
}
function getBest(id) {
  try {
    let v = parseInt(localStorage.getItem(bestKey(id)), 10);
    if (!Number.isFinite(v) && LEGACY[id]) v = parseInt(localStorage.getItem(LEGACY[id].best), 10);
    if (!Number.isFinite(v)) v = 0;
    if (SPEC_HIGH[id]) v = Math.max(v, readNum(SPEC_HIGH[id]));
    return v;
  } catch (e) { return 0; }
}
function setBest(id, v) {
  const score = Math.max(0, Math.round(v));
  try { localStorage.setItem(bestKey(id), String(score)); } catch (e) {}
  if (SPEC_HIGH[id]) {
    try {
      if (score >= readNum(SPEC_HIGH[id])) localStorage.setItem(SPEC_HIGH[id], String(score));
    } catch (e) {}
  }
  if (window.NeonState && typeof NeonState.refresh === 'function') NeonState.refresh();
}
// Cumulative score after each round of the best run, so the HUD can show live pace.
// Ten integers per mode; a malformed or stale entry simply disables the comparison.
function paceKey(id) { return 'neon_pace_' + id + '_v1'; }
function readPace(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(paceKey(id)));
    if (!Array.isArray(raw) || raw.length !== ROUNDS) return null;
    for (let i = 0; i < raw.length; i++) if (!Number.isFinite(raw[i])) return null;
    return raw;
  } catch (e) { return null; }
}
function writePace(id, marks) {
  if (!Array.isArray(marks) || marks.length !== ROUNDS) return;
  try { localStorage.setItem(paceKey(id), JSON.stringify(marks)); } catch (e) {}
}
function readBoard(id) {
  const parse = key => {
    try {
      const raw = JSON.parse(localStorage.getItem(key));
      if (!Array.isArray(raw)) return null;
      return raw.filter(e => e && typeof e.nickname === 'string' && Number.isFinite(e.score));
    } catch (e) { return null; }
  };
  return parse(lbKey(id)) || (LEGACY[id] ? parse(LEGACY[id].lb) : null) || [];
}

function stampBoard(game, board) {
  return board.map(e => ({
    nickname: e.nickname,
    score: e.score,
    tier: tierFor(game, e.score).id,
    at: e.at
  }));
}
function saveLocalBoard(game, entry) {
  let board = readBoard(game.id);
  board.push(entry);
  board.sort((a, b) => b.score - a.score || a.at - b.at);
  board = board.slice(0, 10);
  try { localStorage.setItem(lbKey(game.id), JSON.stringify(board)); } catch (e) {}
  return board;
}
// Supabase when configured. localStorage when the network or the project config is missing.
async function submitScoreToLeaderboard(nickname, score, gameId) {
  const game = byId[gameId] || run.mode || games[0];
  const points = Math.max(0, Math.round(Number(score) || 0));
  const entry = {
    nickname: String(nickname).slice(0, 8),
    score: points,
    tier: tierFor(game, points).id,
    at: Date.now()
  };
  if (window.NeonRank && NeonRank.configured()) {
    try {
      const remote = await NeonRank.submit(entry.nickname, points, game.id);
      const board = stampBoard(game, remote.board);
      const saved = Object.assign({}, entry, remote.entry, { tier: tierFor(game, remote.entry.score).id });
      try { localStorage.setItem(lbKey(game.id), JSON.stringify(board)); } catch (e) {}
      return { ok: true, source: 'network', entry: saved, board };
    } catch (e) {}
  }
  return { ok: true, source: 'localStorage', entry, board: saveLocalBoard(game, entry) };
}
window.submitScoreToLeaderboard = submitScoreToLeaderboard;

function renderBoard(game, board, mineAt) {
  const host = $('board');
  host.innerHTML = '<div class="head"><span>RK</span><span>// HANDLE</span><span>PTS</span></div>';
  let listed = false;
  for (let i = 0; i < 10; i++) {
    const e = board[i];
    const mine = !!(e && e.at === mineAt);
    if (mine) listed = true;
    const rk = String(i + 1).padStart(2, '0');
    const row = document.createElement('div');
    row.className = 'row' + (mine ? ' me' : '');
    if (e) {
      const id = e.tier || tierFor(game, e.score).id;
      const tier = tierById(game, id);
      const elite = id === 'god' || id === 'slicer';
      const badge = elite && tier && tier.badge ? `<span class="badge">${escapeHTML(tier.badge)}</span>` : '';
      row.innerHTML = `<span class="rk">${rk}</span><span class="who ${elite ? id : ''}">${escapeHTML(e.nickname)}${badge}</span><span class="sc">${fmt(e.score)}</span>`;
    } else {
      row.innerHTML = `<span class="rk dim">${rk}</span><span class="dim">—</span><span class="dim">—</span>`;
    }
    host.appendChild(row);
  }
  const out = $('outside');
  if (listed) out.classList.add('gone');
  else {
    out.classList.remove('gone');
    out.innerHTML = `YOU <b>${escapeHTML($('nick').value.trim().slice(0, 8))}</b> · ${fmt(run.score)} · OUTSIDE TOP 10`;
  }
}

// ---------- Run state ----------
const games = [], byId = {};
// `mode` owns the run's identity — best key, tiers, leaderboard. `game` is the protocol
// currently on the field. With a single game per run they stay the same object.
const run = {
  state: 'menu', mode: null, game: null, score: 0, round: 0, resultT: 0, result: null,
  submitted: false,
  chain: 0, bestChain: 0, chainBonus: 0, grades: [], marks: [], pace: null
};
// The milestone payout lands on the score immediately; only its presentation is deferred,
// so a chain completed on round 10 is already banked when finishRun() reads the total.
const chainCue = { kind: 'gain', step: 0, n: 0, bonus: 0, t: 0, armed: false };
let chainFlash = 0, chainHeat = 0;
let T = 0, lastWall = performance.now();

function register(def) {
  def.resultTime = def.resultTime || RESULT_TIME;
  def.lbGame = def.lbGame || 'neon-' + def.id;
  games.push(def);
  byId[def.id] = def;
  if (def.init) def.init();
  if (def.layout) def.layout();
}

function buildCards() {
  const host = $('cards');
  if (!host) return;
  if (host.querySelector('[data-game]')) {
    if (window.NeonState && typeof NeonState.refresh === 'function') NeonState.refresh();
    else {
      host.querySelectorAll('[data-best]').forEach(node => {
        node.textContent = fmt(getBest(node.getAttribute('data-best')));
      });
    }
    layoutChrome();
    return;
  }
  host.innerHTML = '';
  games.forEach((g, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    btn.dataset.game = g.id;
    btn.style.setProperty('--ac', g.accent);
    btn.style.setProperty('--acDim', hexA(g.accent, 0.07));
    btn.style.setProperty('--acMid', hexA(g.accent, 0.38));
    btn.innerHTML =
      `<span class="cno">${String(i + 1).padStart(2, '0')}</span>` +
      `<span><span class="cname">${escapeHTML(g.name)}</span><span class="ck">${escapeHTML(g.desc)}</span></span>` +
      `<span class="cbest">BEST<b>${fmt(getBest(g.id))}</b></span>`;
    btn.addEventListener('click', () => startRun(g.id));
    host.appendChild(btn);
  });
  layoutChrome();
}

function resetFx() {
  particleCount = 0; popCount = 0;
  fx.shake = fx.flash = fx.gold = fx.hitstop = fx.invert = 0;
  chainCue.armed = false;
  chainFlash = 0; chainHeat = 0;
  clearGlitch();
  $('static').classList.remove('on');
}
function resetChain() {
  run.chain = 0; run.bestChain = 0; run.chainBonus = 0;
  run.grades.length = 0;
  run.marks.length = 0;
}
// Gap against the best run at the last round both have finished. Staying on the completed
// round means the readout never shows a deficit for a round that has not been played yet.
function paceGap() {
  if (!run.pace || !run.marks.length) return null;
  const i = Math.min(run.marks.length, ROUNDS) - 1;
  return run.marks[i] - run.pace[i];
}
function renderPace(prevBest) {
  const el = $('ovDelta');
  if (!el) return;
  const show = prevBest > 0 && run.marks.length === ROUNDS;
  el.classList.toggle('gone', !show);
  if (!show) return;
  const d = run.score - prevBest;
  el.textContent = (d >= 0 ? '+' : '\u2212') + fmt(Math.abs(d));
  el.className = 'delta ' + (d >= 0 ? 'up' : 'down');
}
function renderStrip() {
  const host = $('ovStrip');
  if (!host) return;
  host.innerHTML = '';
  for (let i = 0; i < ROUNDS; i++) {
    const cell = document.createElement('i');
    cell.className = run.grades[i] || 'empty';
    cell.style.setProperty('--i', i);
    host.appendChild(cell);
  }
  const sum = $('ovChain');
  if (!sum) return;
  sum.classList.toggle('gone', run.chainBonus <= 0 && run.bestChain < 2);
  sum.innerHTML = `CHAIN <b>+${fmt(run.chainBonus)}</b> · LONGEST <b>${run.bestChain}</b>`;
}

function startRun(id, opt) {
  const mode = byId[id];
  if (!mode) return false;
  const quiet = !!(opt && opt.quiet);
  initAudio();
  if (!quiet) sfx.click();
  stopLobbyBgm();
  document.querySelectorAll('.stage').forEach(el => { el.hidden = true; });
  releasePointer();
  run.mode = mode;
  run.game = mode;
  run.score = 0; run.round = 0; run.resultT = 0; run.result = null; run.submitted = false;
  run.pace = readPace(mode.id);
  resetChain();
  resetFx();
  $('nick').value = '';
  $('formErr').textContent = '';
  $('save').disabled = false;
  $('lbForm').classList.remove('gone');
  $('boardWrap').classList.add('gone');
  $('board').innerHTML = '';
  $('outside').classList.add('gone');
  $('over').classList.remove('boot');
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
  $('hudHome').classList.remove('gone');
  layoutChrome();
  if (run.game && run.game.start) run.game.start();
  nextRound();
  return true;
}
function nextRound() {
  if (chainCue.armed) fireChainCue();   // a game with a short resultTime must not swallow it
  run.round++;
  run.result = null;
  run.resultT = 0;
  if (run.game.round) run.game.round(run.round);
  run.state = 'aim';
}
function armChainCue(kind, n, bonus) {
  let step = 0;
  for (const k in CHAIN_BONUS) if (+k < n) step++;
  chainCue.kind = kind; chainCue.step = step; chainCue.n = n; chainCue.bonus = bonus;
  chainCue.t = 0; chainCue.armed = true;
}
function fireChainCue() {
  chainCue.armed = false;
  if (chainCue.kind === 'break') {
    pop('CHAIN BREAK', V.CX, V.CY - L.pop * 1.4, L.pop * 0.36, '#ff2a2a', 1.0);
    sfx.chainBreak();
    return;
  }
  const n = chainCue.n, full = n >= ROUNDS;
  pop(full ? `FLAWLESS CHAIN +${fmt(chainCue.bonus)}` : `CHAIN ${n}  +${fmt(chainCue.bonus)}`,
    V.CX, V.CY - L.pop * 1.5, L.pop * (full ? 0.5 : 0.42), GOLD, 1.5, full);
  chainFlash = 1;
  FX.gold(1); FX.shake(full ? 10 : 6);
  if (full) { FX.flash(0.8); glitch(0.3, true); FX.scanlines(); }
  sfx.chain(chainCue.step);
  vibrate(full ? [20, 30, 20, 30, 90] : [15, 25, 40]);
}
function trackChain(res) {
  run.grades[run.round - 1] = res.grade;
  if (res.grade === 'perfect' || res.grade === 'success') {
    run.chain++;
    if (run.chain > run.bestChain) run.bestChain = run.chain;
    const bonus = CHAIN_BONUS[run.chain];
    if (bonus) {
      run.score += bonus;
      run.chainBonus += bonus;
      armChainCue('gain', run.chain, bonus);
    }
    return;
  }
  if (run.chain >= 3) armChainCue('break', run.chain, 0);
  run.chain = 0;
}
function commit(res) {
  run.score += res.pts;
  trackChain(res);                 // chain milestones bank before the mark is taken
  run.marks[run.round - 1] = run.score;
  run.result = res;
  run.resultT = 0;
  run.state = 'result';
}
function finishRun() {
  const game = run.mode;
  chainCue.armed = false;
  run.state = 'over';
  const prev = getBest(game.id);
  const isNew = run.score > prev;
  if (isNew) { setBest(game.id, run.score); writePace(game.id, run.marks); }
  if (window.NeonState && typeof NeonState.addChips === 'function') {
    NeonState.addChips(Math.floor(run.score / 100));
  }
  const best = Math.max(prev, run.score);

  $('ovGame').textContent = game.name;
  $('ovScore').textContent = fmt(run.score);
  $('ovMax').textContent = `/ ${fmt(MAX_SCORE)}`;
  $('ovBest').textContent = fmt(best);
  $('ovNew').classList.toggle('hidden', !isNew);
  renderStrip();
  renderPace(prev);
  $('lbTitle').textContent = `GLOBAL TOP 10 · ${game.name}`;
  const tier = tierFor(game, run.score);
  const tierEl = $('ovTier');
  tierEl.textContent = tier.label;
  tierEl.className = 'tier ' + tier.id;

  const over = $('over');
  FX.scanlines();
  over.classList.remove('boot');
  void over.offsetWidth;
  over.classList.add('boot');
  over.classList.remove('hidden');
  over.classList.add('locked');
  setTimeout(() => over.classList.remove('locked'), 400);
  buildCards();
}
function toMenu() {
  releasePointer();
  run.state = 'menu';
  run.result = null;
  resetFx();
  if (run.game && run.game.stop) run.game.stop();
  $('over').classList.add('hidden');
  $('over').classList.remove('boot');
  $('menu').classList.remove('hidden');
  $('hudHome').classList.add('gone');
  document.querySelectorAll('.stage').forEach(el => { el.hidden = true; });
  if (AC) startLobbyBgm();
  buildCards();
}

// ---------- Input ----------
// Pointer events cover mouse, pen and touch. The move handler only latches the latest raw
// coordinates; the rAF tick consumes them once per frame, so 1000–8000 Hz mice cost nothing extra.
let activePointer = null;
const pend = { x: 0, y: 0, dirty: false };
cvs.addEventListener('pointerdown', e => {
  initAudio();
  if (run.state !== 'aim' || activePointer !== null || !run.game) return;
  activePointer = e.pointerId;
  try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
  pend.x = e.clientX; pend.y = e.clientY; pend.dirty = false;
  if (run.game.down) run.game.down(e.clientX, e.clientY);
});
window.addEventListener('pointermove', e => {
  if (activePointer === null || e.pointerId !== activePointer) return;
  pend.x = e.clientX; pend.y = e.clientY; pend.dirty = true;
}, { passive: true });
function applyPending() {
  if (!pend.dirty) return;
  pend.dirty = false;
  if (activePointer === null || !run.game || !run.game.move) return;
  run.game.move(pend.x, pend.y);
}
window.addEventListener('pointerup', e => {
  if (e.pointerId !== activePointer) return;
  applyPending();
  activePointer = null;
  if (run.game && run.game.up) run.game.up(e.clientX, e.clientY);
});
window.addEventListener('pointercancel', e => {
  if (e.pointerId !== activePointer) return;
  releasePointer();
});
// Drops a latched pointer that never sent up/cancel — an interrupted touch, a backgrounded
// app, or leaving mid-drag. Without this the next pointerdown would be ignored forever.
function releasePointer() {
  activePointer = null;
  pend.dirty = false;
  if (run.game && run.game.cancel) run.game.cancel();
}

$('restart').addEventListener('click', () => { if (run.mode) startRun(run.mode.id); });
$('toMenu').addEventListener('click', () => { sfx.click(); toMenu(); });
$('home').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); sfx.click(); toMenu(); });
$('sound').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleMute(); });
$('vib').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleVib(); });
$('lbForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (run.state !== 'over' || run.submitted || $('over').classList.contains('locked')) return;
  const nick = $('nick').value.trim();
  if (nick.length < 3 || nick.length > 8 || /\s/.test(nick)) {
    $('formErr').textContent = 'USE 3–8 CHARACTERS';
    return;
  }
  $('formErr').textContent = '';
  run.submitted = true;
  $('save').disabled = true;
  const res = await submitScoreToLeaderboard(nick, run.score, run.mode.id);
  $('lbTitle').textContent = (res.source === 'network' ? 'GLOBAL TOP 10' : 'LOCAL TOP 10') + ' · ' + run.mode.name;
  renderBoard(run.mode, res.board, res.entry.at);
  $('lbForm').classList.add('gone');
  $('boardWrap').classList.remove('gone');
  sfx.ding();
});
window.addEventListener('keydown', e => {
  if (e.target && e.target.id === 'nick') return;
  if (e.code === 'Escape' && run.state !== 'menu') { e.preventDefault(); toMenu(); }
});

// ---------- Update ----------
function update(dt) {
  applyPending();
  T += dt;

  if (run.state === 'menu') {
    menuT += dt;
  } else {
    if (run.state === 'result' || run.state === 'over') run.resultT += dt;
    if (run.game && run.game.update) run.game.update(dt);
    if (run.state === 'result' && run.resultT >= run.game.resultTime) {
      if (run.round >= ROUNDS) finishRun();
      else nextRound();
    }
  }

  let w = 0;
  for (let i = 0; i < particleCount; i++) {
    const p = pool[i];
    const f = Math.pow(p.fr, dt);
    p.vx *= f; p.vy *= f;
    p.vy += p.g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.kind === 'rect') p.rot += p.vr * dt;
    p.life -= dt;
    if (p.life > 0) {
      if (i !== w) { pool[i] = pool[w]; pool[w] = p; }
      w++;
    }
  }
  particleCount = w;

  w = 0;
  for (let i = 0; i < popCount; i++) {
    const p = popPool[i];
    p.t += dt;
    if (p.t < p.dur) {
      if (i !== w) { popPool[i] = popPool[w]; popPool[w] = p; }
      w++;
    }
  }
  popCount = w;

  if (chainCue.armed) {
    chainCue.t += dt;
    if (chainCue.t >= CHAIN_CUE) fireChainCue();
  }
  const heatTarget = run.state === 'menu' ? 0 : run.chain / ROUNDS;
  chainHeat += (heatTarget - chainHeat) * (1 - Math.exp(-dt * 4));
  stepTint(dt);

  fx.shake *= Math.exp(-dt * 9); if (fx.shake < 0.1) fx.shake = 0;
  fx.flash *= Math.exp(-dt * 4.5);
  fx.gold *= Math.exp(-dt * 2.4);
  fx.invert *= Math.exp(-dt * 8);
  chainFlash *= Math.exp(-dt * 5);
}

// ---------- Render helpers ----------
// Cached in eight buckets: the grid runs hotter as the chain grows, but rebuilding a
// gradient every frame is not worth the one visible step between buckets.
function heatGradient(h) {
  const b = Math.round(h * 8);
  if (b !== heatBucket) {
    heatBucket = b;
    const t = b / 8;
    const g = ctx.createRadialGradient(V.CX, V.CY, 0, V.CX, V.CY, Math.max(V.W, V.H) * 0.75);
    g.addColorStop(0, `rgba(255,${Math.round(lerp(60, 170, t))},0,${(0.11 * t).toFixed(3)})`);
    g.addColorStop(0.6, `rgba(255,90,0,${(0.04 * t).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,60,0,0)');
    heatGlow = g;
  }
  return heatGlow;
}
// The grid is tinted by the active game's accent, so switching protocols mid-run repaints
// the whole world. `tint` eases toward the target instead of snapping, which reads as a
// colour wash rather than a cut.
const tint = [176, 38, 255];
function stepTint(dt) {
  const to = hexRgb(run.game && run.game.accent ? run.game.accent : VIOLET);
  const k = 1 - Math.exp(-dt * 3.5);
  for (let i = 0; i < 3; i++) tint[i] += (to[i] - tint[i]) * k;
}
function drawBackground() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, V.W, V.H);
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, V.W, V.H);
  const heat = clamp(chainHeat, 0, 1);
  if (heat > 0.02) {
    ctx.fillStyle = heatGradient(heat);
    ctx.fillRect(0, 0, V.W, V.H);
  }

  const g = Math.max(32, Math.min(V.W, V.H) / 11);
  const oy = (T * 12) % g;
  const ox = (V.W / 2) % g;
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${Math.round(lerp(tint[0], 255, heat))},${Math.round(lerp(tint[1], 140, heat))},${Math.round(lerp(tint[2], 20, heat))},${(0.13 + heat * 0.11).toFixed(3)})`;
  ctx.beginPath();
  for (let x = ox - g; x < V.W + g; x += g) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, V.H); }
  for (let y = oy - g; y < V.H + g; y += g) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(V.W, Math.round(y) + 0.5); }
  ctx.stroke();

  ctx.strokeStyle = `rgba(${Math.round(tint[0])},${Math.round(tint[1])},${Math.round(tint[2])},0.07)`;
  ctx.beginPath();
  for (let y = oy - g * 4; y < V.H + g; y += g * 4) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(V.W, Math.round(y) + 0.5); }
  ctx.stroke();

  // Each game paints its own instrument panel on top of the shared grid.
  if (run.state !== 'menu' && run.game && run.game.backdrop) {
    ctx.save();
    run.game.backdrop();
    ctx.restore();
  }

  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, V.W, V.H);
}

function text(str, x, y, size, color, opt) {
  const o = opt || {};
  const align = o.align || 'center', weight = o.weight || 700;
  const glow = o.glow === undefined ? 12 : o.glow;
  const alpha = o.alpha === undefined ? 1 : o.alpha;
  const spacing = o.spacing || 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
  ctx.shadowColor = color; ctx.shadowBlur = glow;
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.restore();
}
function segment(s, c, x, y, w) {
  ctx.shadowColor = c; ctx.shadowBlur = 20;
  ctx.fillStyle = c;
  ctx.fillText(s, x, y);
  return x + w;
}
// Two neon values joined by a separator, laid out centred: "42 : 58", "0.50 : SEC".
function duo(a, b, y, size, alpha = 1, sep = ' : ', ca = PINK, cb = BLUE, bScale = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `900 ${size}px ${FONT}`;
  const wa = ctx.measureText(a).width, ws = ctx.measureText(sep).width;
  ctx.font = `900 ${size * bScale}px ${FONT}`;
  const wb = ctx.measureText(b).width;
  let x = V.W / 2 - (wa + ws + wb) / 2;
  ctx.font = `900 ${size}px ${FONT}`;
  x = segment(a, ca, x, y, wa);
  x = segment(sep, '#ffffff', x, y, ws);
  ctx.font = `900 ${size * bScale}px ${FONT}`;
  segment(b, cb, x, y, wb);
  ctx.restore();
}

function drawParticles() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < particleCount; i++) {
    const p = pool[i];
    ctx.globalAlpha = clamp(p.life / p.max * 1.6, 0, 1);
    if (p.kind === 'rect') {
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = `hsl(${(p.hue + T * 200) % 360},100%,60%)`;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else {
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}
function drawPops() {
  for (let i = 0; i < popCount; i++) {
    const p = popPool[i];
    if (p.t < 0) continue;
    const k = p.t / p.dur;
    const s = p.t < 0.22 ? easeOutBack(p.t / 0.22) : 1 + (p.t - 0.22) * 0.06;
    const a = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    ctx.save();
    ctx.translate(p.x, p.y - k * 18);
    ctx.rotate(p.rainbow ? Math.sin(p.t * 20) * 0.03 * (1 - k) : 0);
    ctx.scale(s, s);
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.font = `900 ${p.size}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (p.rainbow) {
      const w = ctx.measureText(p.text).width;
      const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
      for (let j = 0; j <= 6; j++) grad.addColorStop(j / 6, `hsl(${(T * 360 + j * 60) % 360},100%,62%)`);
      ctx.lineWidth = Math.max(2, p.size * 0.06);
      ctx.strokeStyle = '#fff';
      ctx.shadowColor = `hsl(${(T * 360) % 360},100%,60%)`; ctx.shadowBlur = 30;
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = grad;
      ctx.fillText(p.text, 0, 0);
    } else {
      ctx.shadowColor = p.color; ctx.shadowBlur = 22;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.globalAlpha *= 0.6;
      ctx.fillStyle = '#fff';
      ctx.fillText(p.text, 0, 0);
    }
    ctx.restore();
  }
}

// Ten pips, one per round. The four milestone slots are drawn larger so the next payout
// is always visible before it is earned.
function drawChain() {
  const c = V.chrome;
  const sp = Math.min(10, Math.max(7, V.W * 0.026));
  const rm = sp * 0.4, r = sp * 0.29;
  let x = c.scoreX + rm;
  ctx.save();
  for (let i = 1; i <= ROUNDS; i++) {
    const ms = CHAIN_BONUS[i] !== undefined;
    const on = i <= run.chain;
    let rad = ms ? rm : r;
    if (on && i === run.chain) rad *= 1 + chainFlash * 0.8;
    ctx.beginPath();
    ctx.arc(x, c.chainY, rad, 0, Math.PI * 2);
    if (on) {
      ctx.shadowColor = GOLD; ctx.shadowBlur = 10 + chainFlash * 12;
      ctx.fillStyle = GOLD;
      ctx.fill();
    } else {
      ctx.shadowBlur = 0;
      if (ms) {
        ctx.strokeStyle = hexA(GOLD, 0.4); ctx.lineWidth = 1.2; ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
      }
    }
    x += sp;
  }
  ctx.restore();
  if (run.chain >= 2) {
    text('CHAIN ' + run.chain, x + 2, c.chainY, 11, GOLD,
      { align: 'left', weight: 900, glow: 12 + chainFlash * 16 });
  }
}
function drawChrome() {
  if (run.state === 'menu' || run.state === 'over' || !run.game) return;
  const c = V.chrome;
  const padR = Math.max(18, V.W * 0.04, V.SAFE.right + 12);

  text('SCORE', c.scoreX, c.scoreLabel, 10, '#ffffff', { align: 'left', alpha: 0.5, glow: 0, spacing: 3 });
  let bump = 1;
  for (let i = 0; i < popCount; i++) {
    const p = popPool[i];
    if (p.pts && p.t >= 0 && p.t < 0.28) { bump = 1.18; break; }
  }
  text(fmt(run.score), c.scoreX, c.scoreValue, 26 * bump, '#ffffff', { align: 'left', weight: 900, glow: 16 });
  drawChain();

  text('ROUND', V.W - padR, c.roundLabel, 10, '#ffffff', { align: 'right', alpha: 0.5, glow: 0, spacing: 3 });
  text(`${run.round} / ${ROUNDS}`, V.W - padR, c.roundValue, 22, BLUE, { align: 'right', weight: 900, glow: 14 });

  const gap = paceGap();
  if (gap !== null) {
    const up = gap >= 0;
    text((up ? '+' : '\u2212') + fmt(Math.abs(gap)) + ' VS BEST', V.W - padR, c.chainY, 11,
      up ? GREEN : '#ff2a5a', { align: 'right', weight: 900, glow: 12 });
  }

  const g = run.game;
  if (g.hint && run.round === 1 && run.score === 0 && run.state === 'aim' &&
      (!g.hintVisible || g.hintVisible())) {
    const a = 0.35 + Math.sin(T * 4) * 0.25;
    text(g.hint, V.W / 2, V.H - Math.max(22, V.H * 0.035, V.SAFE.bottom + 16), 11, '#ffffff',
      { alpha: a, glow: 8, spacing: 5 });
  }
}

// ---------- Menu scene ----------
// One emblem that quotes all three games: a spinning polygon (cut), a scrolling
// waveform (rhythm) and a pair of refracted beams (prism).
let menuT = 0;
function drawMenuScene() {
  const cx = V.W / 2, cy = V.H / 2, r = Math.min(V.W, V.H) * 0.34;
  ctx.save();
  ctx.lineJoin = 'round';

  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = menuT * 0.22 + i / 6 * Math.PI * 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.shadowColor = VIOLET; ctx.shadowBlur = 26;
  ctx.strokeStyle = hexA(VIOLET, 0.55); ctx.lineWidth = 2;
  ctx.stroke();

  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let x = 0; x <= V.W; x += 6) {
    const k = x / V.W;
    const env = Math.sin(Math.PI * k);
    const y = cy + Math.sin(k * 11 - menuT * 2.1) * r * 0.42 * env
                 + noise1(k * 24 + menuT * 3) * r * 0.08 * env;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.shadowColor = BLUE; ctx.shadowBlur = 22;
  ctx.strokeStyle = hexA(BLUE, 0.7); ctx.lineWidth = 2;
  ctx.stroke();

  ctx.globalAlpha = 0.45;
  const sweep = Math.sin(menuT * 0.5) * 0.5;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx - dir * r * 1.5, cy - r * 0.9);
    ctx.lineTo(cx, cy + sweep * r * 0.4);
    ctx.lineTo(cx + dir * r * 1.5, cy + r * (0.9 - sweep));
    ctx.shadowColor = dir < 0 ? PINK : LASER; ctx.shadowBlur = 24;
    ctx.strokeStyle = hexA(dir < 0 ? PINK : LASER, 0.5); ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- Glitch compositor ----------
const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d');
function paintGlitch() {
  if (fx.glitchT <= 0) return;
  const sw = cvs.width, sh = cvs.height;
  if (!sw || !sh) return;
  if (scratch.width !== sw || scratch.height !== sh) {
    scratch.width = sw; scratch.height = sh;
  }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.drawImage(cvs, 0, 0);

  const k = clamp(fx.glitchT / fx.glitchDur, 0, 1);
  const shift = (fx.heavy ? 14 : 5) * V.DPR * (0.4 + k * 0.6);
  const fringe = (fx.heavy ? 6 : 3) * V.DPR;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const bands = fx.heavy ? 9 : 3;
  for (let i = 0; i < bands; i++) {
    const y = fx.heavy
      ? Math.floor(Math.random() * sh)
      : Math.floor(sh * [0.38, 0.52, 0.61][i]);
    const hh = Math.min(Math.max(1, Math.floor((fx.heavy ? rand(4, 34) : [6, 4, 5][i]) * V.DPR)), sh - y);
    if (hh <= 0) continue;
    const dx = Math.round((fx.heavy ? rand(-1, 1) : [-1, 1, -0.6][i]) * shift);
    ctx.drawImage(scratch, 0, y, sw, hh, dx, y, sw, hh);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.28;
    ctx.drawImage(scratch, 0, y, sw, hh, dx - fringe, y, sw, hh);
    ctx.drawImage(scratch, 0, y, sw, hh, dx + fringe, y, sw, hh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Heavy mode additionally shatters the frame into displaced blocks.
  if (fx.heavy) {
    const cols = 7, rows = 5, bw = sw / cols, bh = sh / rows;
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < 10; i++) {
      const cxi = Math.floor(Math.random() * cols), cyi = Math.floor(Math.random() * rows);
      const sx = cxi * bw, sy = cyi * bh;
      ctx.drawImage(scratch, sx, sy, bw, bh,
        sx + rand(-1, 1) * shift * 1.6, sy + rand(-1, 1) * shift * 0.5, bw, bh);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ---------- Render ----------
function render() {
  ctx.setTransform(V.DPR, 0, 0, V.DPR, 0, 0);
  drawBackground();

  ctx.save();
  if (fx.shake > 0) ctx.translate(rand(-fx.shake, fx.shake), rand(-fx.shake, fx.shake));

  if (fx.gold > 0.01) {
    const g = ctx.createRadialGradient(V.CX, V.CY, 0, V.CX, V.CY, V.R * 1.7);
    g.addColorStop(0, `rgba(255,215,0,${0.32 * fx.gold})`);
    g.addColorStop(0.5, `rgba(255,170,0,${0.12 * fx.gold})`);
    g.addColorStop(1, 'rgba(255,170,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, V.W, V.H);
  }

  if (run.state === 'menu') drawMenuScene();
  else if (run.game && run.game.draw) run.game.draw();

  drawParticles();
  drawPops();
  ctx.restore();

  drawChrome();
  if (run.state !== 'menu' && run.game && run.game.hud) run.game.hud();

  if (fx.flash > 0.01) {
    ctx.fillStyle = `hsla(${(T * 720) % 360},100%,60%,${fx.flash * 0.3})`;
    ctx.fillRect(0, 0, V.W, V.H);
    if (fx.flash > 0.75) {
      ctx.fillStyle = `rgba(255,255,255,${(fx.flash - 0.75) * 1.6})`;
      ctx.fillRect(0, 0, V.W, V.H);
    }
  }
  // 'difference' against white is a true colour inversion — the bass-drop slam.
  if (fx.invert > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = `rgba(255,255,255,${clamp(fx.invert, 0, 1)})`;
    ctx.fillRect(0, 0, V.W, V.H);
    ctx.restore();
  }
  paintGlitch();
}

// ---------- Loop ----------
function frame(now) {
  if (run.state === 'menu') {
    lastWall = now;
    requestAnimationFrame(frame);
    return;
  }
  const wall = Math.min(0.05, (now - lastWall) / 1000);
  lastWall = now;
  // Only the slice of this frame that overlaps the hit-stop runs slowed, so the exit is seamless.
  const slow = Math.min(wall, Math.max(0, fx.hitstop));
  fx.hitstop -= slow;
  const dt = slow * HITSTOP_SCALE + (wall - slow);
  if (fx.glitchT > 0) fx.glitchT = Math.max(0, fx.glitchT - wall);
  update(dt);
  render();
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (!AC) return;
  if (document.hidden) AC.suspend();
  else { applyMasterVolume(); AC.resume(); }
});
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutChrome);
window.addEventListener('load', () => {
  buildCards();
  syncMuteButton();
  syncVibButton();
  resize();
});
requestAnimationFrame(frame);

// ---------- Public surface ----------
return {
  // constants
  PINK, BLUE, GOLD, LASER, GREEN, VIOLET, FONT, GRADE_COL,
  BEAT, ARP: LOBBY_ARP,
  ROUNDS, MAX_SCORE, ROUND_CAP, PERFECT_BONUS, CHAIN_BONUS, CHAIN_MAX,
  // canvas + layout
  cvs, ctx, V, L,
  // utils
  rand, randInt, pick, clamp, lerp, easeOutBack, hexA, fmt, escapeHTML, noise1, vibrate,
  get time() { return T; },
  // Sub-frame clock: lets the rhythm game timestamp a tap between two rAF ticks.
  nowGame() { return T + Math.max(0, (performance.now() - lastWall) / 1000); },
  // audio + fx
  sfx, tone, noise, cutout, initAudio, fx: FX,
  // drawing
  text, duo, particles, pop,
  // flow
  run, grade, juice, commit, register, toMenu,
  submitScoreToLeaderboard,
  has(id) { return !!byId[id]; },
  best(id) { return getBest(id); },
  launch(id) { return startRun(id, { quiet: true }); },
  ui: {
    wake() { initAudio(); if (run.state === 'menu') startLobbyBgm(); },
    hover() { initAudio(); if (!muted) sfx.hover(); },
    click() { initAudio(); if (!muted) sfx.click(); }
  }
};
})();
