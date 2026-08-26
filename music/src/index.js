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
const songIdCache = {}; // 队列条目内部 id -> 网易云歌曲 id（旧数据自愈用）
const urlCache = new Map(); // 网易云歌曲 id -> { url, at }（直链缓存，避免 seek/恢复时反复请求）
const URL_TTL = 8 * 60 * 1000;
let SILENCE_BUF = null; // 预生成的静音 MP3（约2秒，32kbps），暂停/空闲直接回放，零延迟零毛刺

function generateSilence() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const chunks = [];
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-acodec', 'libmp3lame', '-ab', '32k', '-t', '2', '-f', 'mp3', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}

// 探测音频真实时长与码率（试听片段/版权截断的文件本身较短，元数据时长不准）
function probeMedia(input) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration,bit_rate', '-of', 'default=nw=1', input,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 10000);
    p.stdout.on('data', (c) => { out += c.toString(); });
    p.on('error', () => { clearTimeout(t); resolve({ dur: 0, br: 0 }); });
    p.on('close', () => {
      clearTimeout(t);
      let dur = 0, br = 0;
      for (const line of out.split('\n')) {
        const m = line.match(/^(duration|bit_rate)=(.*)$/);
        if (!m) continue;
        const v = parseFloat(m[2]);
        if (!Number.isFinite(v)) continue;
        if (m[1] === 'duration' && v > 0) dur = v;
        if (m[1] === 'bit_rate' && v > 0) br = v;
      }
      resolve({ dur: Math.round(dur), br: Math.round(br) });
    });
  });
}

// ================= 常驻电台编码器（全局单例） =================
// 生命周期：生成机器人(link)/有消费者拉流 时启动；断开(unlink)/空闲60秒 销毁。
// 单个 ffmpeg 从 stdin 喂 MP3 帧，输出恒定 128k；切歌/seek/暂停只是切换数据源，
// 进程永不重启 => 无半截帧电音；进度=已喂字节/码率，定期 align 回写播放器时钟。
const ENC = {
  running: false,
  ff: null,
  listeners: new Set(),   // { res, buf: [], size }
  idleTimer: null,
};

function encBroadcast(chunk) {
  for (const L of ENC.listeners) {
    if (L.res.writableEnded || L.res.destroyed) continue;
    if (L.buf.length) { L.buf.push(chunk); L.size += chunk.length; encFlush(L); continue; }
    if (!L.res.write(chunk)) { L.buf.push(chunk); L.size += chunk.length; }
  }
}

function encFlush(L) {
  while (L.buf.length && !outPausedOf(L)) {
    const c = L.buf.shift();
    L.size -= c.length;
    if (!L.res.write(c)) {
      L.res.once('drain', () => encFlush(L));
      break;
    }
  }
  if (L.size > 1024 * 1024) { // 僵尸客户端保护：积压超 1MB 直接断开
    try { L.res.destroy(); } catch (e) {}
  }
}

function outPausedOf(L) { return L.res.writableLength > 0; }

function encDetach(res) {
  for (const L of ENC.listeners) {
    if (L.res === res) { ENC.listeners.delete(L); break; }
  }
  if (ENC.running && ENC.listeners.size === 0 && !ENC.idleTimer) {
    ENC.idleTimer = setTimeout(() => {
      ENC.idleTimer = null;
      if (ENC.listeners.size === 0) stopEncoder();
    }, 60 * 1000);
  }
}

function stopEncoder() {
  if (!ENC.running) return;
  ENC.running = false;
  if (ENC.idleTimer) { clearTimeout(ENC.idleTimer); ENC.idleTimer = null; }
  const ff = ENC.ff;
  ENC.ff = null;
  try { ff.stdin.end(); } catch (e) {}
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 200);
  console.log('[encoder] 已停止');
}

function startEncoder() {
  if (ENC.running) return;
  if (ENC.idleTimer) { clearTimeout(ENC.idleTimer); ENC.idleTimer = null; }
  ENC.running = true;

  const { spawn } = require('child_process');
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-f', 'mp3', '-i', 'pipe:0',
    '-acodec', 'libmp3lame', '-ab', '128k', '-ar', '44100',
    '-f', 'mp3', '-',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  ENC.ff = ff;
  console.log('[encoder] 已启动');
  ff.on('error', () => {});
  ff.stdout.on('data', (c) => encBroadcast(c));
  ff.on('close', () => {
    if (ENC.ff === ff) {
      ENC.running = false;
      ENC.ff = null;
      console.log('[encoder] 进程退出');
    }
  });

  const SILENCE_BPS = 4000;
  const FALLBACK_BPS = 16000;

  function openSource(url, offsetBytes) {
    const ctrl = new AbortController();
    const headers = offsetBytes > 4096 ? { Range: 'bytes=' + offsetBytes + '-' } : {};
    const p = fetch(url, { signal: ctrl.signal, headers });
    const stObj = {
      ctrl, queue: [], qsize: 0, ended: false,
      ns: null, waiters: [],
      notify() { const ws = this.waiters.splice(0); for (const w of ws) w(); },
    };
    p.then((up) => {
      if (!up.ok || !up.body) { stObj.failed = true; stObj.ended = true; stObj.notify(); return; }
      const ns = Readable.fromWeb(up.body);
      stObj.ns = ns;
      ns.on('data', (c) => {
        stObj.queue.push(c); stObj.qsize += c.length;
        if (stObj.qsize > 512 * 1024 && !ns.isPaused()) ns.pause();
        stObj.notify();
      });
      ns.on('end', () => { stObj.ended = true; stObj.notify(); });
      ns.on('error', () => { stObj.ended = true; stObj.notify(); });
    }).catch(() => { stObj.ended = true; stObj.notify(); });
    return stObj;
  }

  function pumpSrc(stObj) {
    if (stObj && stObj.ns && stObj.qsize < 256 * 1024 && stObj.ns.isPaused()) stObj.ns.resume();
  }

  async function readSource(stObj) {
    if (!stObj) return null;
    for (;;) {
      if (stObj.queue.length) {
        const c = stObj.queue.shift();
        stObj.qsize -= c.length;
        pumpSrc(stObj);
        return c;
      }
      if (stObj.ended) return null;
      await Promise.race([new Promise((r) => stObj.waiters.push(r)), sleep(60)]);
    }
  }

  function stopSource(stObj) { try { if (stObj && stObj.ctrl) stObj.ctrl.abort(); } catch (e) {} }

  async function writeStdin(buf) {
    if (!ENC.running || ff.stdin.destroyed) return;
    ff.stdin.write(buf);
  }

  async function feedSilence(ms) {
    if (!SILENCE_BUF) return;
    let need = Math.ceil(SILENCE_BPS * ms / 1000);
    let pos = silencePos;
    while (need > 0 && ENC.running && !ff.stdin.destroyed) {
      if (pos >= SILENCE_BUF.length) pos = 0;
      const n = Math.min(1024, SILENCE_BUF.length - pos, need);
      await writeStdin(SILENCE_BUF.subarray(pos, pos + n));
      pos += n; need -= n;
    }
    silencePos = pos % SILENCE_BUF.length;
  }

  let srcBps = FALLBACK_BPS;
  let songPos = 0;
  let curKey = null;
  let src = null;
  let lastTick = Date.now();
  let lastAlignAt = 0;
  let failCount = 0;

  (async () => {
    let mode = 'silence';
    let accBytes = 0;
    let silencePosLocal = 0;

    while (ENC.running) {
      const now = Date.now();
      const dt = Math.min(0.5, (now - lastTick) / 1000);
      lastTick = now;

      const st = player.get();
      const wantSong = !!(st.current && st.playing);

      if (!wantSong) {
        if (mode !== 'silence') { mode = 'silence'; stopSource(src); src = null; accBytes = 0; }
        if (SILENCE_BUF) {
          let need = Math.ceil(SILENCE_BPS * dt);
          while (need > 0 && ENC.running) {
            if (silencePosLocal >= SILENCE_BUF.length) silencePosLocal = 0;
            const n = Math.min(1024, SILENCE_BUF.length - silencePosLocal, need);
            await writeStdin(SILENCE_BUF.subarray(silencePosLocal, silencePosLocal + n));
            silencePosLocal += n; need -= n;
          }
        }
        await sleep(30);
        continue;
      }

      const cur = st.current;
      if (cur.id !== curKey || mode === 'silence') {
        curKey = cur.id;
        songPos = Math.max(0, Math.floor(st.position) || 0);
        stopSource(src); src = null;
        mode = 'song';
        accBytes = 0;
        if (SILENCE_BUF) {
          let pad = Math.ceil(SILENCE_BPS * 120 / 1000);
          let p2 = silencePosLocal;
          while (pad > 0 && ENC.running) {
            if (p2 >= SILENCE_BUF.length) p2 = 0;
            const n = Math.min(pad, SILENCE_BUF.length - p2);
            await writeStdin(SILENCE_BUF.subarray(p2, p2 + n));
            p2 += n; pad -= n;
          }
          silencePosLocal = p2 % SILENCE_BUF.length;
        }
        if (!ENC.running) break;
      }

      let neteaseId = cur.songId || songIdCache[curKey] || null;
      if (!neteaseId) {
        try {
          const kw = [cur.title, cur.artists].filter(Boolean).join(' ');
          const r = kw ? await enhanced.search(kw, 'song', 1, 0) : null;
          const first = r && r.songs && r.songs[0];
          if (first) { songIdCache[curKey] = first.id; neteaseId = first.id; }
        } catch (e) {}
      }
      let audioUrl = '', audioType = '';
      const cachedEntry = neteaseId ? urlCache.get(neteaseId) : null;
      if (cachedEntry && cachedEntry.url && Date.now() - cachedEntry.at < URL_TTL) {
        audioUrl = cachedEntry.url;
        audioType = cachedEntry.type || '';
        if (cachedEntry.br) srcBps = Math.min(60000, Math.max(8000, Math.round(cachedEntry.br / 8)));
      }
      if (!audioUrl && neteaseId) {
        try {
          const r = await Promise.race([
            enhanced.songUrl(neteaseId),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('songUrl 超时')), 8000)),
          ]);
          audioUrl = (r && r.url) || '';
          audioType = (r && r.type) || '';
        } catch (e) { audioUrl = ''; }
      }
      if (!audioUrl && neteaseId) {
        try {
          const m = await Promise.race([
            enhanced.songUrlMatch(neteaseId),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('解灰超时')), 10000)),
          ]);
          audioUrl = (m && m.url) || '';
          if (audioUrl) console.log('[stream] 已解灰播放 id=' + neteaseId);
        } catch (e) { audioUrl = ''; }
      }
      if (neteaseId && audioUrl) urlCache.set(neteaseId, Object.assign({}, urlCache.get(neteaseId), { url: audioUrl, at: Date.now(), type: audioType }));

      if (!audioUrl) {
        failCount++;
        let reason = '';
        try {
          const c = await Promise.race([
            enhanced.checkMusic(neteaseId),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('超时')), 5000)),
          ]);
          if (c && c.success === false) reason = ' (' + (c.message || '暂无版权') + ')';
        } catch (e) {}
        console.log('[stream] 拿不到歌曲直链(title=' + (cur.title || '?') + ', id=' + neteaseId + ')' + reason + '，切下一首 #' + failCount);
        player.next();
        await sleep(failCount > 3 ? 5000 : 500);
        continue;
      }
      failCount = 0;

      if (audioType && !/mp3/i.test(audioType)) {
        console.log('[stream] 非 MP3 音源跳过 type=' + audioType + ' id=' + neteaseId);
        player.next();
        await sleep(300);
        continue;
      }

      if (!src && audioUrl) {
        const input = config.imgProxy
          ? config.imgProxy.replace(/\/$/, '') + '/?u=' + encodeURIComponent(audioUrl)
          : audioUrl;
        const offset = Math.floor(songPos * srcBps);
        src = openSource(input, offset);

        if (!cur.realDurProbed && neteaseId) {
          cur.realDurProbed = true;
          probeMedia(input).then(({ dur, br }) => {
            if (br > 0) srcBps = Math.min(60000, Math.max(8000, Math.round(br / 8)));
            if (dur > 0) {
              const meta = cur.duration || 0;
              if (!meta || Math.abs(meta - dur) >= 3) {
                console.log('[stream] 实际可播 ' + dur + 's（元数据 ' + meta + 's）id=' + neteaseId);
                cur.duration = dur;
                try { queue.save(); } catch (e) {}
              }
            }
            const ce = neteaseId ? urlCache.get(neteaseId) : null;
            if (ce) { ce.dur = dur; ce.br = br; }
          }).catch(() => {});
        }
      }

      const uiTarget = Math.floor(player.get().position);
      if (Math.abs(uiTarget - songPos) > 2) {
        stopSource(src); src = null; accBytes = 0;
        songPos = uiTarget;
        if (SILENCE_BUF) {
          let pad = Math.ceil(SILENCE_BPS * 120 / 1000);
          let p3 = silencePosLocal;
          while (pad > 0 && ENC.running) {
            if (p3 >= SILENCE_BUF.length) p3 = 0;
            const n = Math.min(pad, SILENCE_BUF.length - p3);
            await writeStdin(SILENCE_BUF.subarray(p3, p3 + n));
            p3 += n; pad -= n;
          }
          silencePosLocal = p3 % SILENCE_BUF.length;
        }
      }

      accBytes += dt * srcBps;
      accBytes = Math.min(accBytes, srcBps * 2);
      let upstreamDone = false;
      while (accBytes >= 1024 && ENC.running) {
        if (!src) break;
        const chunk = await readSource(src);
        if (chunk === null) {
          if (src.ended) { upstreamDone = true; break; }
          break;
        }
        songPos += chunk.length / srcBps;
        await writeStdin(chunk);
        accBytes -= chunk.length;
      }

      if (upstreamDone) {
        stopSource(src); src = null;
        if (SILENCE_BUF) {
          let pad = Math.ceil(SILENCE_BPS * 250 / 1000);
          let p4 = silencePosLocal;
          while (pad > 0 && ENC.running) {
            if (p4 >= SILENCE_BUF.length) p4 = 0;
            const n = Math.min(pad, SILENCE_BUF.length - p4);
            await writeStdin(SILENCE_BUF.subarray(p4, p4 + n));
            p4 += n; pad -= n;
          }
          silencePosLocal = p4 % SILENCE_BUF.length;
        }
        const sNow = player.get();
        if (sNow.current && sNow.current.id === curKey && sNow.playing) player.next();
      }

      if (now - lastAlignAt > 2000 && curKey != null) {
        lastAlignAt = now;
        try { player.align(songPos); } catch (e) {}
      }

      await sleep(30);
    }
  })().catch((e) => {
    console.log('[encoder] 导播异常:', e.message);
    stopEncoder();
  });
}

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

  // 有消费者拉流 => 确保编码器运行（幂等）
  startEncoder();
  const L = { res, buf: [], size: 0 };
  ENC.listeners.add(L);
  res.on('close', () => encDetach(res));
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
  try {
    const r = await tsbridge.link();
    startEncoder(); // 生成机器人 => 启动常驻编码器
    ok(res, r);
  } catch (e) { fail(res, 502, 'TS_LINK_FAIL', e.message); }
});
app.post('/api/ts-bot/unlink', async (req, res) => {
  try {
    const r = await tsbridge.unlink();
    stopEncoder(); // 断开连接 => 销毁编码器，释放资源
    ok(res, r);
  } catch (e) { fail(res, 502, 'TS_UNLINK_FAIL', e.message); }
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
    if (!loggedIn) return ok(res, { loggedIn: false });

    // 并行取用户资料与 VIP 信息（单项失败不影响整体）
    const [profileRes, vipRes] = await Promise.allSettled([
      enhanced.loginStatus(),
      enhanced.vipInfo(),
    ]);

    let profile = null;
    if (profileRes.status === 'fulfilled') {
      const d = profileRes.value && profileRes.value.data;
      const p = d && d.profile;
      profile = p ? { userId: p.userId, nickname: p.nickname || '', avatarUrl: p.avatarUrl || '' } : null;
    }
    let vip = null;
    if (vipRes.status === 'fulfilled') {
      const d = vipRes.value && vipRes.value.data;
      if (d) {
        vip = {
          isVip: !!d.isVip,
          vipType: d.vipType != null ? d.vipType : null,       // 0无 / 10普通 / 11年费（常见值）
          expireTime: d.expireTime != null ? d.expireTime : null, // 毫秒时间戳
        };
      }
    }
    ok(res, { loggedIn: true, profile, vip });
  } catch (e) {
    ok(res, { loggedIn: false });
  }
});

// 独立的 VIP 信息接口
app.get('/api/vip/info', async (req, res) => {
  try {
    const r = await enhanced.vipInfo();
    const d = (r && r.data) || {};
    ok(res, { isVip: !!d.isVip, vipType: d.vipType != null ? d.vipType : null, expireTime: d.expireTime != null ? d.expireTime : null });
  } catch (e) { fail(res, 502, 'VIP_INFO_FAIL', e.message); }
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
        fee: s.fee != null ? s.fee : null,
        noCopyright: !!s.noCopyrightRcmd,
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
    let r = await enhanced.songUrl(id, (req.query.level || 'standard').trim());
    // 无直链（灰色/无版权）时走解灰兜底
    if (!r.url) r = await enhanced.songUrlMatch(id, req.query.source);
    ok(res, r);
  } catch (e) { fail(res, 502, 'SONG_URL_FAIL', e.message); }
});

// 音乐是否可用：{success:true} 或 {success:false,message:'暂无版权'}
app.get('/api/check/music', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    ok(res, await enhanced.checkMusic(id));
  } catch (e) { fail(res, 502, 'CHECK_MUSIC_FAIL', e.message); }
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
      fee: s.fee != null ? s.fee : null,
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

Promise.all([
  resolveStreamPublicUrl(),
  generateSilence().then((b) => { SILENCE_BUF = b; if (!b) console.log('[music-bot] 静音缓冲生成失败，暂停过渡将无垫片'); }),
]).then(() => {
  const server = app.listen(config.port, config.host, () => {
    console.log(`[music-bot] 点歌服务已启动 ${config.host}:${config.port}`);
    console.log(`[music-bot] 网易云 API: ${config.apiBase}`);
  });
  server.setTimeout(60000);
}).catch((e) => { console.error('[music-bot] 启动失败', e); process.exit(1); });