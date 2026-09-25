/**
 * Global leaderboard. One best score per device per mode.
 * Writes go through public.submit_score; reads are the public scores table.
 * A missing config or a failed request leaves the local board in charge.
 */
window.NeonRank = (function () {
  'use strict';

  const PLAYER_KEY = 'neon_player_id_v1';
  const GAMES = { cut: 1, rhythm: 1, prism: 1 };
  const TIMEOUT = 4000;

  function cfg() {
    const c = window.NEON_SUPABASE;
    if (!c || typeof c.url !== 'string' || typeof c.key !== 'string') return null;
    const url = c.url.replace(/\/+$/, '');
    const key = c.key.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || key.length < 20) return null;
    return { url, key };
  }

  function playerId() {
    try {
      let id = localStorage.getItem(PLAYER_KEY);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || fallbackId();
        localStorage.setItem(PLAYER_KEY, id);
      }
      return id;
    } catch (e) {
      return fallbackId();
    }
  }

  function fallbackId() {
    const bytes = new Uint8Array(16);
    if (crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function headers(key, extra) {
    return Object.assign({
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json'
    }, extra || {});
  }

  async function request(path, options) {
    const c = cfg();
    if (!c) throw new Error('config');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(c.url + path, Object.assign({}, options, {
        headers: headers(c.key, options && options.headers),
        signal: ctrl.signal
      }));
      if (!res.ok) throw new Error('http');
      return res.status === 204 ? null : res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function row(e) {
    if (!e || typeof e.nickname !== 'string' || !Number.isFinite(Number(e.score))) return null;
    return {
      nickname: String(e.nickname).slice(0, 8),
      score: Math.round(Number(e.score)),
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : Date.parse(e.updated_at) || Date.now()
    };
  }

  async function submit(nickname, score, gameId) {
    if (!GAMES[gameId]) throw new Error('game');
    const data = await request('/rest/v1/rpc/submit_score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_player_key: playerId(),
        p_game: gameId,
        p_nickname: String(nickname).trim().slice(0, 8),
        p_score: Math.max(0, Math.round(Number(score) || 0))
      })
    });
    const entry = row(data);
    const board = Array.isArray(data && data.board)
      ? data.board.map(row).filter(Boolean).slice(0, 10)
      : null;
    if (!entry || !board) throw new Error('payload');
    return { entry, board };
  }

  async function top(gameId) {
    const filter = GAMES[gameId] ? '&game=eq.' + gameId : '';
    const data = await request(
      '/rest/v1/scores?select=game,nickname,score,updated_at&order=score.desc,updated_at.asc&limit=10' + filter
    );
    if (!Array.isArray(data)) throw new Error('payload');
    return data.map(e => {
      const parsed = row(e);
      if (!parsed || !GAMES[e.game]) return null;
      parsed.game = e.game;
      return parsed;
    }).filter(Boolean);
  }

  async function totals() {
    const data = await request(
      '/rest/v1/scores?select=player_key,game,nickname,score,updated_at&limit=1000'
    );
    if (!Array.isArray(data)) throw new Error('payload');
    const byPlayer = new Map();
    data.forEach(e => {
      const parsed = row(e);
      if (!parsed || !GAMES[e.game] || !e.player_key) return;
      let acc = byPlayer.get(e.player_key);
      if (!acc) acc = { nickname: parsed.nickname, score: 0, at: 0, games: {} };
      const prev = acc.games[e.game] || 0;
      if (parsed.score >= prev) {
        acc.score += parsed.score - prev;
        acc.games[e.game] = parsed.score;
      }
      if (parsed.at >= acc.at) {
        acc.at = parsed.at;
        acc.nickname = parsed.nickname;
      }
      byPlayer.set(e.player_key, acc);
    });
    return [...byPlayer.values()]
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .slice(0, 10);
  }

  return {
    configured: () => !!cfg(),
    submit,
    top,
    totals
  };
})();
