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

const config = require('./config');

function cfg() {
  return {
    url: (config.ts6mgrUrl || '').replace(/\/$/, ''),
    user: config.ts6mgrUser || '',
    pass: config.ts6mgrPass || '',
    botId: config.ts6mgrBotId ? parseInt(config.ts6mgrBotId, 10) : null,
    channel: config.ts6mgrChannel || '',
    streamUrl: config.streamPublicUrl || 'http://music:3200/api/stream',
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

async function login() {
  const c = cfg();
  const { status, json } = await authFetch('POST', '/api/auth/login', null, { username: c.user, password: c.pass });
  if (status !== 200 || !json) throw new Error('ts6-manager 登录失败 (HTTP ' + status + ')');
  const token = (json.data && (json.data.token || json.data.accessToken)) || json.token || json.accessToken;
  if (!token) throw new Error('ts6-manager 登录未返回 token');
  return token;
}

async function getServers(token) {
  const { status, json } = await authFetch('GET', '/api/servers', token);
  if (status !== 200) throw new Error('获取 TS 连接列表失败 (HTTP ' + status + ')');
  const list = (json.data && json.data.servers) || json.servers || json.data || [];
  if (!Array.isArray(list) || !list.length) throw new Error('ts6-manager 中未配置 TeamSpeak 连接');
  return list;
}

async function getBots(token) {
  const { status, json } = await authFetch('GET', '/api/music-bots', token);
  if (status !== 200) throw new Error('获取音乐机器人列表失败 (HTTP ' + status + ')');
  return (json.data && json.data.bots) || json.data || json || [];
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
  if (!c.url || !c.user || !c.pass) {
    throw new Error('未配置 ts6-manager（TS6MGR_URL / TS6MGR_USER / TS6MGR_PASS）');
  }
  const token = await login();
  const servers = await getServers(token);
  const serverConfigId = servers[0].id;
  const botId = await ensureBot(token, serverConfigId);
  const stationId = await ensureStation(token, serverConfigId);

  await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
  const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
  if (play.status !== 200) {
    throw new Error('播放电台失败 (HTTP ' + play.status + ')');
  }
  return { ok: true, botId, stationId, serverConfigId };
}

async function unlink() {
  const c = cfg();
  if (!c.url || !c.user || !c.pass) throw new Error('未配置 ts6-manager');
  const token = await login();
  const bots = await getBots(token);
  const botId = c.botId || (bots[0] && bots[0].id);
  if (!botId) throw new Error('未找到音乐机器人');
  await authFetch('POST', '/api/music-bots/' + botId + '/stop-playback', token);
  return { ok: true, botId };
}

async function status() {
  const c = cfg();
  if (!c.url || !c.user || !c.pass) return { enabled: false };
  try {
    const token = await login();
    const bots = await getBots(token);
    const botId = c.botId || (bots[0] && bots[0].id);
    if (!botId) return { enabled: true, connected: false };
    const { status, json } = await authFetch('GET', '/api/music-bots/' + botId, token);
    if (status !== 200) return { enabled: true, connected: false };
    const bot = (json.data && json.data.bot) || json.data || json;
    return { enabled: true, connected: bot.status === 'connected' || bot.status === 'playing' || bot.status === 'paused', status: bot.status, nowPlaying: bot.nowPlaying || null };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}

module.exports = { link, unlink, status, cfg };
