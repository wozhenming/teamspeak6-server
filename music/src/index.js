'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

// ---------- 登录状态 ----------
app.get('/api/status', async (req, res) => {
  try {
    // 有 MUSIC_U cookie 视为已登录（可进一步校验）
    const loggedIn = fs.existsSync(path.join(config.dataDir, 'cookie.txt')) &&
      /MUSIC_U=/.test(fs.readFileSync(path.join(config.dataDir, 'cookie.txt'), 'utf8') || '');
    ok(res, { loggedIn });
  } catch (e) {
    ok(res, { loggedIn: false });
  }
});

// ---------- 扫码登录 ----------
app.post('/api/qr/create', async (req, res) => {
  try {
    const qr = await enhanced.qrCreate();
    ok(res, qr);
  } catch (e) { fail(res, 502, 'QR_FAIL', e.message); }
});

app.get('/api/qr/check', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return fail(res, 400, 'BAD_REQUEST', '缺少 key');
    const r = await enhanced.qrCheck(key);
    ok(res, r);
  } catch (e) { fail(res, 502, 'QR_FAIL', e.message); }
});

app.get('/api/login/status', async (req, res) => {
  try { ok(res, await enhanced.loginStatus()); }
  catch (e) { fail(res, 502, 'LOGIN_FAIL', e.message); }
});

// ---------- 搜索 ----------
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || 'song').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;
    if (!q) return fail(res, 400, 'BAD_REQUEST', '缺少关键词 q');
    const result = await enhanced.search(q, type, limit, offset);
    // 归一化返回
    const data = { type, total: 0, items: [] };
    if (type === 'playlist') {
      const list = result.playlists || [];
      data.total = result.playlistCount || list.length;
      data.items = list.map(p => ({
        id: p.id,
        name: p.name,
        playCount: p.playCount || 0,
        tracks: p.trackCount || 0,
        cover: p.coverImgUrl || '',
        creator: (p.creator || {}).nickname || '',
      }));
    } else {
      const list = result.songs || [];
      data.total = result.songCount || list.length;
      data.items = list.map(s => ({
        id: s.id,
        name: s.name,
        artists: (s.ar || []).map(a => a.name).join(' '),
        album: (s.al || {}).name || '',
        duration: s.dt ? Math.round(s.dt / 1000) : 0,
        cover: (s.al || {}).picUrl || '',
      }));
    }
    ok(res, data);
  } catch (e) { fail(res, 502, 'SEARCH_FAIL', e.message); }
});

// ---------- 歌曲/歌单 ----
app.get('/api/song/url', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    const r = await enhanced.songUrl(id, (req.query.level || 'standard').trim());
    ok(res, r);
  } catch (e) { fail(res, 502, 'SONG_URL_FAIL', e.message); }
});

app.get('/api/playlist/tracks', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 100);
    const tracks = await enhanced.playlistTracks(id, limit);
    ok(res, { tracks });
  } catch (e) { fail(res, 502, 'PLAYLIST_FAIL', e.message); }
});

// ---------- 点歌队列 ----------
app.get('/api/queue', (req, res) => {
  ok(res, { items: queue.all(), current: null });
});

app.post('/api/queue', (req, res) => {
  const s = req.body || {};
  if (!s.id || !s.name) return fail(res, 400, 'BAD_REQUEST', '缺少歌曲信息');
  const item = queue.enqueue({
    name: s.name,
    artists: s.artists || '',
    album: s.album || '',
    cover: s.cover || '',
    duration: s.duration || 0,
  }, s.requestedBy);
  ok(res, { item });
});

app.delete('/api/queue/:id', (req, res) => {
  const removed = queue.remove(req.params.id);
  if (!removed) return fail(res, 404, 'NOT_FOUND', '队列中无此条目');
  ok(res, { removed: true });
});

app.delete('/api/queue', (req, res) => {
  queue.clear();
  ok(res, { cleared: true });
});

// 语音播放输出接口（预留）：后续接入 TS6 语音客户端后在此实现
// app.post('/api/play/start', ...)

fs.mkdirSync(config.dataDir, { recursive: true });
queue.load();

const server = app.listen(config.port, config.host, () => {
  console.log(`[music-bot] 点歌服务已启动 ${config.host}:${config.port}`);
  console.log(`[music-bot] 网易云 API: ${config.apiBase}`);
});
server.setTimeout(60000);