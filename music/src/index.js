'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');
const player = require('./player');
const tsbridge = require('./tsbridge');

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
  let target;
  try { target = new URL(u); } catch (e) { return res.status(400).send('bad url'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return res.status(400).send('bad protocol');
  if (!IMG_HOSTS.some((h) => target.hostname.endsWith(h))) return res.status(400).send('blocked host');

  // 若配置了上游图片代理（通常是 neteasemusic 容器，拥有外网出口），则转发给它
  if (config.imgProxy) {
    const upstream = config.imgProxy.replace(/\/$/, '') + '/?u=' + encodeURIComponent(target.toString());
    try {
      const r = await fetch(upstream, { redirect: 'follow' });
      if (!r.ok) return res.status(r.status).send('upstream ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch (e) { return res.status(502).send('img proxy error'); }
  }

  try {
    const r = await fetch(target.toString(), {
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

// ---------- 连续电台流（供 ts6-manager 音乐机器人作为电台源拉流） ----------
// 把当前点歌队列当作“网络电台”持续输出：逐首解析网易云直链并管道输出，
// 一曲结束后自动下一首；用户在面板切歌/暂停时本流自动跟随。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/api/stream', async (req, res) => {
  // 简单令牌校验：若配置了 STREAM_TOKEN，则电台 URL 必须带 ?t= 且匹配，避免公网被随意收听
  if (config.streamToken && req.query.t !== config.streamToken) {
    return res.status(403).end('forbidden');
  }
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');
  res.set('Connection', 'keep-alive');
  res.set('Transfer-Encoding', 'chunked');
  res.flushHeaders && res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const pump = async () => {
    while (!closed) {
      let st = player.get();
      if (!st.current) {
        if (queue.all().length) { player.play(); st = player.get(); }
        else { await sleep(1000); continue; }
      }
      if (!st.playing) { await sleep(500); continue; }

      const curId = st.current.id;
      let audioUrl = '';
      try { audioUrl = (await enhanced.songUrl(curId)).url || ''; } catch (e) { audioUrl = ''; }
      if (!audioUrl) { player.next(); await sleep(300); continue; }

      try {
        // 经 neteasemusic 出口代理抓取音频（music-bot 可能无外网）
        const source = config.imgProxy
          ? config.imgProxy.replace(/\/$/, '') + '/?u=' + encodeURIComponent(audioUrl)
          : audioUrl;
        const up = await fetch(source);
        if (!up.ok || !up.body) { player.next(); await sleep(300); continue; }
        const nodeStream = Readable.fromWeb(up.body);
        await new Promise((resolve) => {
          let aborted = false;
          const check = () => {
            const cur = player.get().current;
            if (!cur || cur.id !== curId) { aborted = true; nodeStream.destroy(); }
          };
          nodeStream.on('data', (chunk) => {
            check();
            if (aborted) return;
            if (!res.write(chunk)) {
              nodeStream.pause();
              res.once('drain', () => { if (!aborted) nodeStream.resume(); });
            }
          });
          nodeStream.on('end', resolve);
          nodeStream.on('error', resolve);
          req.on('close', () => { aborted = true; nodeStream.destroy(); resolve(); });
        });
      } catch (e) { /* 忽略单首错误，进入下一首 */ }

      if (closed) break;
      // 自然播放结束 -> 前进
      if (player.get().current && player.get().current.id === curId) player.next();
      await sleep(200);
    }
    if (!res.writableEnded) res.end();
  };
  pump();
});

// ---------- ts6-manager 对接（点歌机器人进入 TeamSpeak） ----------
app.get('/api/ts-bot/status', async (req, res) => {
  try { ok(res, await tsbridge.status()); } catch (e) { ok(res, { enabled: false, error: e.message }); }
});
app.get('/api/ts-bot/config', (req, res) => {
  ok(res, {
    ts6mgrUrl: config.ts6mgrUrl,
    ts6mgrUser: config.ts6mgrUser,
    ts6mgrPass: config.ts6mgrPass,
    ts6mgrBotId: config.ts6mgrBotId,
    ts6mgrChannel: config.ts6mgrChannel,
    streamPublicUrl: config.streamPublicUrl,
    tsHost: config.tsHost,
    tsWebqueryPort: config.tsWebqueryPort,
    tsApiKey: config.tsApiKey,
  });
});
app.put('/api/ts-bot/config', (req, res) => {
  try { ok(res, config.saveTsBridge(req.body || {})); } catch (e) { fail(res, 500, 'CFG_FAIL', e.message); }
});
app.post('/api/ts-bot/link', async (req, res) => {
  try { ok(res, await tsbridge.link()); } catch (e) { fail(res, 502, 'TS_LINK_FAIL', e.message); }
});
app.post('/api/ts-bot/unlink', async (req, res) => {
  try { ok(res, await tsbridge.unlink()); } catch (e) { fail(res, 502, 'TS_UNLINK_FAIL', e.message); }
});
app.get('/api/ts-bot/channels', async (req, res) => {
  try { ok(res, await tsbridge.listChannels()); } catch (e) { fail(res, 400, 'TS_CHANNELS_FAIL', e.message); }
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

// ---------- 自动解析电台流对外地址 ----------
// ts6-manager 的 SSRF 防护会拒绝内网主机名（如 music），故电台 URL 必须是“对 ts6-manager
// 可达且非内网”的地址。优先用显式配置，否则启动时自动探测本机公网 IP。
async function resolveStreamPublicUrl() {
  const streamPort = process.env.MUSIC_STREAM_PORT || '3200';
  const explicit = process.env.STREAM_PUBLIC_URL || process.env.STREAM_PUBLIC_HOST;
  if (process.env.STREAM_PUBLIC_URL) {
    config.streamPublicUrl = process.env.STREAM_PUBLIC_URL;
    console.log('[music-bot] 电台流对外地址(显式):', config.streamPublicUrl);
    return;
  }
  if (process.env.STREAM_PUBLIC_HOST) {
    config.streamPublicUrl = `http://${process.env.STREAM_PUBLIC_HOST}:${streamPort}/api/stream`;
    console.log('[music-bot] 电台流对外地址(STREAM_PUBLIC_HOST):', config.streamPublicUrl);
    return;
  }
  // 自动探测公网 IP（多个服务兜底）
  const services = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com', 'https://myip.dnsomatic.com'];
  for (const s of services) {
    try {
      const r = await fetch(s, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        config.streamPublicUrl = `http://${ip}:${streamPort}/api/stream`;
        console.log('[music-bot] 电台流对外地址(自动探测公网 IP):', config.streamPublicUrl);
        return;
      }
    } catch (e) { /* 尝试下一个 */ }
  }
  // 兜底：仍用内网主机名（可能在 ts6-manager 侧被拦，仅作降级）
  config.streamPublicUrl = `http://music:${streamPort}/api/stream`;
  console.log('[music-bot] 警告：未能自动获取公网 IP，回退到内网地址', config.streamPublicUrl, '（ts6-manager 可能拒绝，建议设置 STREAM_PUBLIC_HOST）');
}

resolveStreamPublicUrl().then(() => {
  const server = app.listen(config.port, config.host, () => {
    console.log(`[music-bot] 点歌服务已启动 ${config.host}:${config.port}`);
    console.log(`[music-bot] 网易云 API: ${config.apiBase}`);
  });
  server.setTimeout(60000);
}).catch((e) => { console.error('[music-bot] 启动失败', e); process.exit(1); });