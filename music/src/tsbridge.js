'use strict';

/**
 * 与点歌机器人语音引擎 ts6-manager 对接：
 * - 登录拿 JWT
 * - 取/建一个音乐机器人（music bot），并配置加入的频道
 * - 创建一个电台（radio station），URL 指向本服务的 /api/stream 连续流
 * - 让该 bot 播放这个电台，从而把点歌队列推流进 TeamSpeak 频道
 *
 * 仅在配置了 TS6MGR_URL / TS6MGR_USER / TS6MGR_PASS 时启用。
 */

const { config } = require('./config');

function cfg() {
  return {
    url: (config.ts6mgrUrl || '').replace(/\/$/, ''),
    user: config.ts6mgrUser || '',
    pass: config.ts6mgrPass || '',
    botId: config.ts6mgrBotId ? parseInt(config.ts6mgrBotId, 10) : null,
    channel: config.ts6mgrChannel || '',
    streamUrl: (config.streamPublicUrl || 'http://music:3200/api/stream'),
    streamToken: config.streamToken || '',
    tsHost: config.tsHost || '',
    tsWebqueryPort: config.tsWebqueryPort || 10080,
    tsApiKey: config.tsApiKey || '',
  };
}

async function authFetch(method, path, token, body) {
  const c = cfg();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(c.url + path, opts);
  let json = null;
  try { json = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json };
}

async function tryLogin(user, pass) {
  const c = cfg();
  const { status, json } = await authFetch('POST', '/api/auth/login', null, { username: user, password: pass });
  if (status !== 200 || !json) throw new Error('ts6-manager 登录失败 (HTTP ' + status + ')');
  const token = (json.data && (json.data.token || json.data.accessToken)) || json.token || json.accessToken;
  if (!token) throw new Error('ts6-manager 登录未返回 token');
  return token;
}

// 自动确保 ts6-manager 存在管理员账号（无需手动去 :3002 注册）：
// 1) 先用配置的账号密码登录；2) 旧版镜像默认 admin/admin；3) 新镜像走 /api/setup 首次向导
async function ensureAdmin() {
  const c = cfg();
  try { return await tryLogin(c.user, c.pass); } catch (e) { /* 继续 */ }
  try { return await tryLogin('admin', 'admin'); } catch (e) { /* 继续 */ }
  // 新镜像：先查是否需要初始化，再调用 /api/setup/init 创建首个管理员
  try {
    const st = await authFetch('GET', '/api/setup/status', null);
    const needsSetup = st.json && st.json.needsSetup;
    if (needsSetup) {
      const init = await authFetch('POST', '/api/setup/init', null, {
        username: c.user, password: c.pass, displayName: c.user,
      });
      if (init.status === 200 || init.status === 201) return await tryLogin(c.user, c.pass);
    }
  } catch (e) { /* 旧镜像可能没有 /api/setup/status，忽略 */ }
  throw new Error('无法登录/创建 ts6-manager 管理员，请在 ' + c.url + '/setup 手动创建，并把账号密码填进 .env 的 TS6MGR_USER/TS6MGR_PASS');
}

// 解析 TeamSpeak WebQuery API Key：优先用配置/环境变量；否则提示在 .env 设置
async function resolveApiKey() {
  const c = cfg();
  if (c.tsApiKey) return c.tsApiKey;
  throw new Error('未配置 TeamSpeak API Key：请在 .env 设置 TS_API_KEY（在 TS 服务器执行 `apikeyadd scope=manage lifetime=0` 获取后填入）');
}

async function getServers(token) {
  const { status, json } = await authFetch('GET', '/api/servers', token);
  if (status !== 200) throw new Error('获取 TS 连接列表失败 (HTTP ' + status + ')');
  // ts6-manager 直接返回数组（顶层）；兼容可能的 data 包裹
  const list = Array.isArray(json) ? json
    : ((json.data && json.data.servers) || json.servers || json.data || []);
  if (!Array.isArray(list)) throw new Error('ts6-manager 中未配置 TeamSpeak 连接');
  return list;
}

// 确保 ts6-manager 里已存在指向本 TS 服务器的连接；没有则自动创建
async function ensureServer(token, c) {
  const apiKey = await resolveApiKey();
  const list = await getServers(token);
  const existing = list.find((s) => s && (s.host === c.tsHost || (c.tsHost && s.host && s.host.includes(c.tsHost))));
  if (existing) {
    // 始终用最新 Key 刷新连接配置，避免首次用错 Key 后一直沿用旧的导致 502
    await authFetch('PUT', '/api/servers/' + existing.id, token, {
      name: existing.name || 'TeamSpeak',
      host: c.tsHost,
      webqueryPort: c.tsWebqueryPort,
      apiKey,
    });
    return existing.id;
  }
  const created = await authFetch('POST', '/api/servers', token, {
    name: 'TeamSpeak',
    host: c.tsHost,
    webqueryPort: c.tsWebqueryPort,
    apiKey,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(apiErrText(created.status, created.json, '自动创建 TS 连接失败') + '；请确认 TS_API_KEY 正确');
  }
  const s = (created.json && (created.json.data || created.json));
  return s.id;
}

async function getBots(token) {
  const { status, json } = await authFetch('GET', '/api/music-bots', token);
  if (status !== 200) throw new Error('获取音乐机器人列表失败 (HTTP ' + status + ')');
  return (json.data && json.data.bots) || json.data || json || [];
}

// 提取 ts6-manager 返回的详细错误（含 TeamSpeak 原始 status 信息），便于排查
function apiErrText(status, json, fallback) {
  let s = fallback + ' (HTTP ' + status + ')';
  if (json) {
    const msg = (json.error && (json.error.message || (typeof json.error === 'string' ? json.error : null)))
      || json.message || json.details || (json.error && json.error.details);
    const code = json.code || (json.error && json.error.code);
    if (msg) s += ' — ' + msg;
    if (code != null) s += ' [code ' + code + ']';
  }
  return s;
}

// WebQuery 响应可能是数组 / {data:[...]} / 单对象，这里统一成数组
function toArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.channels)) return json.channels;
  if (json && json.data && Array.isArray(json.data.channels)) return json.data.channels;
  if (json && json.cid != null) return [json];
  return [];
}

// 取第一个虚拟服务器 id（TS 通常为 1）
async function getVirtualServerId(token, configId) {
  const { status, json } = await authFetch('GET', '/api/servers/' + configId + '/virtual-servers', token);
  if (status !== 200) throw new Error(apiErrText(status, json, '获取虚拟服务器列表失败'));
  const list = toArray(json);
  const first = list[0] || {};
  const sid = first.virtualserver_id || first.sid || first.id || 1;
  return parseInt(sid, 10) || 1;
}

// 列出 TS 服务器现有频道（供面板下拉选择）。自动确保 TS 连接已建立。
async function getChannels(token, configId) {
  const sid = await getVirtualServerId(token, configId);
  const { status, json } = await authFetch('GET', '/api/servers/' + configId + '/vs/' + sid + '/channels', token);
  if (status !== 200) throw new Error(apiErrText(status, json, '获取频道列表失败'));
  // channellist 字段用 cid/pid/channel_name
  const list = toArray(json);
  const norm = list.map((ch) => {
    const id = ch.cid != null ? ch.cid : (ch.id != null ? ch.id : ch.channelId);
    const name = ch.channel_name || ch.name || ch.channelName || ('频道' + id);
    const pid = ch.pid != null ? ch.pid : (ch.cpid != null ? ch.cpid : (ch.parent != null ? ch.parent : null));
    return { id, name, pid };
  });
  const byId = {};
  norm.forEach((c) => { byId[c.id] = c; });
  return norm.map((c) => {
    let path = c.name;
    let cur = c;
    let depth = 0;
    while (cur.pid != null && byId[cur.pid] && depth < 10) {
      cur = byId[cur.pid];
      path = cur.name + '/' + path;
      depth++;
    }
    return { id: c.id, name: c.name, path };
  });
}

async function listChannels() {
  const token = await ensureAdmin();
  const c = cfg();
  const serverConfigId = await ensureServer(token, c);
  const channels = await getChannels(token, serverConfigId);
  return channels;
}

async function ensureStation(token, serverConfigId) {
  const c = cfg();
  // ts6-manager 的电台 URL 需附上令牌，且必须是“对 ts6-manager 可达且非内网”的地址
  const sep = c.streamUrl.includes('?') ? '&' : '?';
  const streamUrl = c.streamToken ? (c.streamUrl + sep + 't=' + encodeURIComponent(c.streamToken)) : c.streamUrl;
  const { status, json } = await authFetch('GET', '/api/servers/' + serverConfigId + '/radio-stations', token);
  const stations = (json.data && json.data.stations) || json.data || json || [];
  const existing = Array.isArray(stations) ? stations.find((s) => s && s.url === streamUrl) : null;
  if (existing) return existing.id;
  const created = await authFetch('POST', '/api/servers/' + serverConfigId + '/radio-stations', token, {
    name: '点歌机器人',
    url: streamUrl,
    genre: '点歌',
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(apiErrText(created.status, created.json, '创建电台失败'));
  }
  const st = (created.json && (created.json.data || created.json));
  return st.id;
}

// 找到我们的点歌机器人：优先用配置的 botId，其次按名字匹配（避免重复创建出多个机器人）
function pickBot(c, bots) {
  if (c.botId) {
    const byId = bots.find((b) => b && b.id === c.botId);
    if (byId) return byId;
  }
  return bots.find((b) => b && b.name === '点歌机器人')
    || bots.find((b) => b && b.nickname === '点歌机器人')
    || null;
}

async function ensureBot(token, serverConfigId) {
  const c = cfg();
  let bots = [];
  try { bots = await getBots(token); } catch (e) { bots = []; }
  const existing = pickBot(c, bots);
  if (existing) {
    // 尽力更新加入的频道（失败不阻断）
    if (c.channel) {
      try { await authFetch('PUT', '/api/music-bots/' + existing.id, token, { defaultChannel: c.channel }); } catch (e) { /* 忽略 */ }
    }
    try { config.saveTsBridge({ ts6mgrBotId: String(existing.id) }); } catch (e) { /* 忽略 */ }
    return existing.id;
  }
  const name = '点歌机器人';
  const create = await authFetch('POST', '/api/music-bots', token, {
    name,
    serverConfigId,
    nickname: name,
    defaultChannel: c.channel,
    volume: 50,
    autoStart: true,
  });
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(apiErrText(create.status, create.json, '创建音乐机器人失败'));
  }
  const bot = (create.json && (create.json.data || create.json));
  return bot.id;
}

// 等待 bot 真正连上 TS（start 是异步的，play-radio 要求已 connected）
async function waitBotConnected(token, botId, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const { status, json } = await authFetch('GET', '/api/music-bots/' + botId, token);
      if (status === 200) {
        const b = (json.data && (json.data.bot || json.data)) || json;
        const s = b.status;
        if (s === 'connected' || s === 'playing' || s === 'paused') return true;
      }
    } catch (e) { /* 忽略，继续等 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function link() {
  const c = cfg();
  const token = await ensureAdmin();
  const serverConfigId = await ensureServer(token, c);
  const botId = await ensureBot(token, serverConfigId);
  const stationId = await ensureStation(token, serverConfigId);

  await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
  // 等 bot 连接上频道后再播放电台（避免 “Bot is not connected”）
  await waitBotConnected(token, botId);
  const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
  if (play.status !== 200) {
    throw new Error(apiErrText(play.status, play.json, '播放电台失败'));
  }
  // 持久化 botId，避免重复连接时反复新建机器人
  try { config.saveTsBridge({ ts6mgrBotId: String(botId), ts6mgrChannel: c.channel }); } catch (e) { /* 忽略 */ }
  return { ok: true, botId, stationId, serverConfigId };
}

async function unlink() {
  const c = cfg();
  const token = await ensureAdmin();
  const bots = await getBots(token);
  const bot = pickBot(c, bots) || bots[0];
  if (!bot) throw new Error('未找到音乐机器人');
  await authFetch('POST', '/api/music-bots/' + bot.id + '/stop-playback', token);
  return { ok: true, botId: bot.id };
}

async function status() {
  const c = cfg();
  let token;
  try { token = await tryLogin(c.user, c.pass); } catch (e) {
    try { token = await tryLogin('admin', 'admin'); } catch (e2) { return { enabled: true, connected: false }; }
  }
  try {
    const bots = await getBots(token);
    const target = pickBot(c, bots) || bots[0];
    if (!target) return { enabled: true, connected: false };
    let bot = target;
    if (!bot.status) {
      const { status, json } = await authFetch('GET', '/api/music-bots/' + target.id, token);
      if (status !== 200) return { enabled: true, connected: false };
      bot = (json.data && json.data.bot) || json.data || json;
    }
    return { enabled: true, connected: bot.status === 'connected' || bot.status === 'playing' || bot.status === 'paused', status: bot.status, nowPlaying: bot.nowPlaying || null };
  } catch (e) {
    return { enabled: true, connected: false, error: e.message };
  }
}

module.exports = { link, unlink, status, cfg, listChannels };
