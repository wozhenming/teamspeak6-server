'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');
const player = require('./player');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

// ---------- 图片代理（绕过网易云外链防盗链 / 混合内容限制） ----------
const IMG_HOSTS = ['.music.126.net', '.music.163.com'];
app.get('/api/img', async (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== 'string') return res.status(400).send('missing u');
  let url;
  try { url = new URL(u); } catch (e) { return res.status(400).send('bad url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return res.status(400).send('bad protocol');
  if (!IMG_HOSTS.some((h) => url.hostname.endsWith(h))) return res.status(400).send('blocked host');
  try {
    const r = await fetch(url.toString(), {
      headers: { 'Referer': 'https://music.126.net/', 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });
    if (!r.ok) return res.status(r.status).send('upstream ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) { res.status(502).send('fetch error'); }
});

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

// 歌单全部曲目（用于"全量加入队列"与前端浏览）
app.get('/api/playlist/tracks-all', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    const cap = Math.min(parseInt(req.query.cap, 10) || 2000, 5000);
    const tracks = await enhanced.playlistTracksAll(id, cap);
    ok(res, { tracks });
  } catch (e) { fail(res, 502, 'PLAYLIST_FAIL', e.message); }
});

// ---------- 点歌队列 ----------
app.get('/api/queue', (req, res) => {
  const all = queue.all();
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const filtered = q
    ? all.filter((it) =>
        [it.title, it.artists, it.album, it.requestedBy]
          .join(' ').toLowerCase().includes(q))
    : all;
  const total = filtered.length;
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 100);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const start = (page - 1) * pageSize;
  ok(res, {
    items: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    pages,
  });
});

app.post('/api/queue', (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.songs) && body.songs.length) {
    const added = queue.enqueueMany(body.songs, body.requestedBy);
    ok(res, { items: added, count: added.length });
  } else {
    const s = body;
    if (!s.id || !s.name) return fail(res, 400, 'BAD_REQUEST', '缺少歌曲信息');
    const item = queue.enqueue({
      name: s.name,
      artists: s.artists || '',
      album: s.album || '',
      cover: s.cover || '',
      duration: s.duration || 0,
    }, s.requestedBy);
    ok(res, { item });
  }
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

// ---------- 播放器 ----------
app.get('/api/player', (req, res) => {
  ok(res, player.get());
});

app.post('/api/player/play', (req, res) => {
  const id = req.body && req.body.id != null ? parseInt(req.body.id, 10) : null;
  ok(res, player.play(id));
});

app.post('/api/player/toggle', (req, res) => {
  ok(res, player.toggle());
});

app.post('/api/player/pause', (req, res) => {
  ok(res, player.pause());
});

app.post('/api/player/resume', (req, res) => {
  ok(res, player.resume());
});

app.post('/api/player/seek', (req, res) => {
  const pos = Number(req.body && req.body.position);
  if (!Number.isFinite(pos) || pos < 0) return fail(res, 400, 'BAD_REQUEST', 'position 无效');
  ok(res, player.seek(pos));
});

app.post('/api/player/next', (req, res) => {
  ok(res, player.next());
});

app.post('/api/player/prev', (req, res) => {
  ok(res, player.prev());
});

app.post('/api/player/loop', (req, res) => {
  const mode = (req.body && req.body.mode) || 'all';
  ok(res, player.setLoop(mode));
});

// 语音播放输出接口（预留）：后续接入 TS6 语音客户端后在此实现
// app.post('/api/play/start', ...)

fs.mkdirSync(config.dataDir, { recursive: true });
queue.load();
player.load();
queue.onChange(player.onQueueChanged);

const server = app.listen(config.port, config.host, () => {
  console.log(`[music-bot] 点歌服务已启动 ${config.host}:${config.port}`);
  console.log(`[music-bot] 网易云 API: ${config.apiBase}`);
});
server.setTimeout(60000);