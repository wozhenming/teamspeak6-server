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
    streamUrl: config.streamPublicUrl || 'http://music:3200/api/stream',
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
// 1) 先用配置的账号密码登录；2) 旧版镜像默认 admin/admin；3) 新版镜像走 /api/setup 首次向导
async function ensureAdmin() {
  const c = cfg();
  try { return await tryLogin(c.user, c.pass); } catch (e) { /* 继续 */ }
  try { return await tryLogin('admin', 'admin'); } catch (e) { /* 继续 */ }
  const setup = await authFetch('POST', '/api/setup', null, {
    username: c.user, password: c.pass, email: c.user + '@local',
  });
  if (setup.status === 200 || setup.status === 201) return await tryLogin(c.user, c.pass);
  throw new Error('无法登录/创建 ts6-manager 管理员，请在 ' + c.url + '/setup 手动创建后重试');
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
  const list = (json.data && json.data.servers) || json.servers || json.data || [];
  if (!Array.isArray(list)) throw new Error('ts6-manager 中未配置 TeamSpeak 连接');
  return list;
}

// 确保 ts6-manager 里已存在指向本 TS 服务器的连接；没有则自动创建
async function ensureServer(token, c) {
  const apiKey = await resolveApiKey();
  const list = await getServers(token);
  const existing = list.find((s) => s && (s.host === c.tsHost || (c.tsHost && s.host && s.host.includes(c.tsHost))));
  if (existing) return existing.id;
  const created = await authFetch('POST', '/api/servers', token, {
    name: 'TeamSpeak',
    host: c.tsHost,
    webqueryPort: c.tsWebqueryPort,
    apiKey,
  });
  if (created.status !== 201 && created.status !== 200) {
    const msg = (created.json && (created.json.error && created.json.error.message)) || ('HTTP ' + created.status);
    throw new Error('自动创建 TS 连接失败（' + msg + '）；请确认 TS_API_KEY 正确');
  }
  const s = (created.json && (created.json.data || created.json));
  return s.id;
}

async function getBots(token) {
  const { status, json } = await authFetch('GET', '/api/music-bots', token);
  if (status !== 200) throw new Error('获取音乐机器人列表失败 (HTTP ' + status + ')');
  return (json.data && json.data.bots) || json.data || json || [];
}

// 列出 TS 服务器现有频道（供面板下拉选择）。自动确保 TS 连接已建立。
async function getChannels(token, serverConfigId) {
  const { status, json } = await authFetch('GET', '/api/servers/' + serverConfigId + '/channels', token);
  if (status !== 200) throw new Error('获取频道列表失败 (HTTP ' + status + ')');
  const raw = (json.data && (json.data.channels || json.data)) || json.channels || json.data || [];
  const list = Array.isArray(raw) ? raw : [];
  const norm = list.map((ch) => {
    const id = ch.id != null ? ch.id : (ch.cid != null ? ch.cid : ch.channelId);
    const name = ch.name || ch.channelName || ch.channel_name || ('频道' + id);
    const pid = ch.pid != null ? ch.pid : (ch.parent != null ? ch.parent : null);
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
  const { status, json } = await authFetch('GET', '/api/servers/' + serverConfigId + '/radio-stations', token);
  const stations = (json.data && json.data.stations) || json.data || json || [];
  const existing = Array.isArray(stations) ? stations.find((s) => s && s.url === c.streamUrl) : null;
  if (existing) return existing.id;
  const created = await authFetch('POST', '/api/servers/' + serverConfigId + '/radio-stations', token, {
    name: '点歌机器人',
    url: c.streamUrl,
    genre: '点歌',
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error('创建电台失败 (HTTP ' + created.status + ')');
  }
  const st = (created.json && (created.json.data || created.json));
  return st.id;
}

async function ensureBot(token, serverConfigId) {
  const c = cfg();
  if (c.botId) {
    const bots = await getBots(token);
    const bot = bots.find((b) => b && b.id === c.botId);
    if (!bot) throw new Error('指定的音乐机器人不存在: ' + c.botId);
    if (c.channel) {
      await authFetch('PUT', '/api/music-bots/' + c.botId, token, { defaultChannel: c.channel });
    }
    return c.botId;
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
    throw new Error('创建音乐机器人失败 (HTTP ' + create.status + ')');
  }
  const bot = (create.json && (create.json.data || create.json));
  return bot.id;
}

async function link() {
  const c = cfg();
  const token = await ensureAdmin();
  const serverConfigId = await ensureServer(token, c);
  const botId = await ensureBot(token, serverConfigId);
  const stationId = await ensureStation(token, serverConfigId);

  await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
  const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
  if (play.status !== 200) {
    throw new Error('播放电台失败 (HTTP ' + play.status + ')');
  }
  // 持久化 botId，避免重复连接时反复新建机器人
  try { config.saveTsBridge({ ts6mgrBotId: String(botId) }); } catch (e) { /* 忽略 */ }
  return { ok: true, botId, stationId, serverConfigId };
}

async function unlink() {
  const c = cfg();
  const token = await ensureAdmin();
  const bots = await getBots(token);
  const botId = c.botId || (bots[0] && bots[0].id);
  if (!botId) throw new Error('未找到音乐机器人');
  await authFetch('POST', '/api/music-bots/' + botId + '/stop-playback', token);
  return { ok: true, botId };
}

async function status() {
  const c = cfg();
  let token;
  try { token = await tryLogin(c.user, c.pass); } catch (e) {
    try { token = await tryLogin('admin', 'admin'); } catch (e2) { return { enabled: true, connected: false }; }
  }
  try {
    const bots = await getBots(token);
    const botId = c.botId || (bots[0] && bots[0].id);
    if (!botId) return { enabled: true, connected: false };
    const { status, json } = await authFetch('GET', '/api/music-bots/' + botId, token);
    if (status !== 200) return { enabled: true, connected: false };
    const bot = (json.data && json.data.bot) || json.data || json;
    return { enabled: true, connected: bot.status === 'connected' || bot.status === 'playing' || bot.status === 'paused', status: bot.status, nowPlaying: bot.nowPlaying || null };
  } catch (e) {
    return { enabled: true, connected: false, error: e.message };
  }
}

module.exports = { link, unlink, status, cfg, listChannels };
