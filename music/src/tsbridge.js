'use strict';

/**
 * 与点歌机器人语音引擎 ts6-manager 对接（每频道固定部署模式）：
 * - 每个配置的频道固定部署一个点歌机器人（一个频道一个，绝不跨频道移动）
 * - 所有机器人播放同一路电台流（本服务 /api/stream，点歌队列全局共享）
 * - 机器人命名：单频道用配置昵称原名；多频道自动加「·频道名」后缀区分
 * - 频道无人自动暂停：所有已部署频道都无人时才暂停；任一频道有人即恢复
 *
 * 仅在配置了 TS6MGR_URL / TS6MGR_USER / TS6MGR_PASS 时启用。
 */

const crypto = require('crypto');
const { config } = require('./config');
const { ensureStreamPublicUrl } = require('./streamurl');
const playerMod = require('./player');

// 管理员 token 缓存：避免面板每次轮询/切页都重新登录（auth 接口有 15次/15分钟 限流）
let tokenCache = { token: null, user: null, at: 0 };
const TOKEN_TTL = 10 * 60 * 1000;
function invalidateToken() { tokenCache = { token: null, user: null, at: 0 }; }

async function getToken() {
  const c = cfg();
  if (tokenCache.token && tokenCache.user === c.user && Date.now() - tokenCache.at < TOKEN_TTL) {
    return tokenCache.token;
  }
  const token = await ensureAdmin();
  tokenCache = { token, user: c.user, at: Date.now() };
  return token;
}

function cfg() {
  return {
    url: (config.ts6mgrUrl || '').replace(/\/$/, ''),
    user: config.ts6mgrUser || '',
    pass: config.ts6mgrPass || '',
    channel: config.ts6mgrChannel || '',
    streamUrl: (config.streamPublicUrl || 'http://music:3200/api/stream'),
    streamTokenEnabled: config.streamTokenEnabled !== false,
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

// 连接指纹：Key/host/port 任一变化才需要刷新 ts6-manager 里的连接配置
// （绝不能在页面浏览等被动路径上无条件 PUT——会触发对端重置连接池，造成音频毛刺）
function connHash(c) {
  return crypto.createHash('sha1').update(c.tsApiKey + '|' + c.tsHost + '|' + c.tsWebqueryPort).digest('hex');
}
let appliedConnHash = null;

// 确保 ts6-manager 里已存在指向本 TS 服务器的连接；没有则自动创建
async function ensureServer(token, c) {
  const apiKey = await resolveApiKey();
  const list = await getServers(token);
  const existing = list.find((s) => s && (s.host === c.tsHost || (c.tsHost && s.host && s.host.includes(c.tsHost))));
  if (existing) {
    // 仅当 Key/host/port 实际变化时才刷新连接配置
    const h = connHash(c);
    if (appliedConnHash !== h) {
      await authFetch('PUT', '/api/servers/' + existing.id, token, {
        name: existing.name || 'TeamSpeak',
        host: c.tsHost,
        webqueryPort: c.tsWebqueryPort,
        apiKey,
      });
      appliedConnHash = h;
    }
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
  appliedConnHash = connHash(c);
  return s.id;
}

async function getBots(token) {
  const { status, json } = await authFetch('GET', '/api/music-bots', token);
  if (status !== 200) throw new Error('获取音乐机器人列表失败 (HTTP ' + status + ')');
  const list = (json.data && json.data.bots) || json.data || json || [];
  return Array.isArray(list) ? list : [];
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

// 列出 TS 服务器现有频道（供面板选择要部署的频道）。自动确保 TS 连接已建立。
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
    let clients = null;
    if (ch.total_clients != null) clients = Number(ch.total_clients);
    else if (ch.clients != null) clients = Number(ch.clients);
    else if (ch.client_count != null) clients = Number(ch.client_count);
    else if (ch.channel_clients != null) clients = Number(ch.channel_clients);
    const clientsRaw = Array.isArray(ch.clients) ? ch.clients : null;
    return { id, name, pid, clients, clientsRaw };
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
    return { id: c.id, name: c.name, path, clients: c.clients, clientsRaw: (Array.isArray(c.clientsRaw) ? c.clientsRaw : null) };
  });
}

async function listChannels() {
  const token = await getToken();
  const c = cfg();
  const serverConfigId = await ensureServer(token, c);
  const channels = await getChannels(token, serverConfigId);
  return channels;
}

// 每个频道一路独立电台流（网易云账号全局共享，队列/播放器按频道隔离）：
// /api/stream?ch=<频道路路径>&t=<token>
function stationUrlFor(channel) {
  const c = cfg();
  const sep = c.streamUrl.includes('?') ? '&' : '?';
  let url = c.streamUrl + sep + 'ch=' + encodeURIComponent(channel);
  if (c.streamTokenEnabled && c.streamToken) url += '&t=' + encodeURIComponent(c.streamToken);
  return url;
}

async function ensureStation(token, serverConfigId, channel) {
  const url = stationUrlFor(channel);
  const { status, json } = await authFetch('GET', '/api/servers/' + serverConfigId + '/radio-stations', token);
  const stations = (json.data && json.data.stations) || json.data || json || [];
  const existing = Array.isArray(stations) ? stations.find((s) => s && s.url === url) : null;
  if (existing) return existing.id;
  const created = await authFetch('POST', '/api/servers/' + serverConfigId + '/radio-stations', token, {
    name: botNameFor(channel),
    url,
    genre: '点歌',
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(apiErrText(created.status, created.json, '创建电台失败（' + channel + '）'));
  }
  const st = (created.json && (created.json.data || created.json));
  return st.id;
}

// ---------- 频道列表与命名（一频道一机器人一点歌助手，固定绑定） ----------
function configChannels() {
  const list = Array.isArray(config.ts6mgrChannels) ? config.ts6mgrChannels : [];
  const out = [];
  for (const c of list) {
    const t = String(c || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function leafOf(path) {
  const leaf = String(path || '').split('/').pop().trim();
  return leaf || String(path || '');
}

// 为一组频道分配唯一显示名：单频道用原名；多频道加「·频道名」后缀；
// 频道叶子名重复时退回完整路径（/ 换成 ·）保证不冲突。
function assignNames(channels, base) {
  const chs = Array.isArray(channels) ? channels : [];
  const leaves = chs.map(leafOf);
  const dup = new Set(leaves.filter((l, i) => leaves.indexOf(l) !== i));
  const names = {};
  chs.forEach((ch, i) => {
    names[ch] = chs.length === 1
      ? base
      : (dup.has(leaves[i]) ? base + '·' + String(ch).replace(/\//g, '·') : base + '·' + leaves[i]);
  });
  return names;
}

function botNickname() {
  return (config.ts6mgrBotNickname || '点歌机器人').trim();
}

// 某频道对应的机器人名（含后缀规则）
function botNameFor(channel) {
  const names = assignNames(configChannels(), botNickname());
  return names[channel] || botNickname();
}

// ---------- 机器人固定绑定（频道 → botId） ----------
function botBindings() {
  return (config.ts6mgrChannelBots && typeof config.ts6mgrChannelBots === 'object') ? config.ts6mgrChannelBots : {};
}
function saveBotBinding(channel, botId) {
  const map = Object.assign({}, botBindings());
  if (botId != null && botId !== '') map[channel] = String(botId);
  else delete map[channel];
  config.saveTsBridge({ ts6mgrChannelBots: map });
}

// 确保某频道有自己的机器人：按绑定 botId → 按名字查找 → 不存在则创建（defaultChannel 固定为本频道）
async function ensureBotForChannel(token, serverConfigId, channel) {
  const bots = await getBots(token);
  const name = botNameFor(channel);
  const bound = botBindings()[channel];
  let existing = null;
  if (bound != null) existing = bots.find((b) => b && String(b.id) === String(bound));
  if (!existing) existing = bots.find((b) => b && (b.name === name || b.nickname === name));
  if (existing) {
    // 固定绑定：defaultChannel 指向本频道（幂等 PUT，仅在指错时才会真正“归位”，不构成运行期移动）
    try { await authFetch('PUT', '/api/music-bots/' + existing.id, token, { defaultChannel: channel, channelPassword: config.ts6mgrChannelPassword || '' }); } catch (e) { /* 忽略 */ }
    // 配置昵称变化时同步机器人名（含 ·频道名 后缀）
    const have = (existing.name || existing.nickname || '').trim();
    if (name && have !== name) {
      try { await authFetch('PUT', '/api/music-bots/' + existing.id, token, { name, nickname: name }); } catch (e) { /* 忽略 */ }
    }
    saveBotBinding(channel, existing.id);
    return existing.id;
  }
  const create = await authFetch('POST', '/api/music-bots', token, {
    name,
    serverConfigId,
    nickname: name,
    defaultChannel: channel,
    channelPassword: config.ts6mgrChannelPassword || '',
    volume: 50,
    autoStart: false,
  });
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(apiErrText(create.status, create.json, '创建音乐机器人失败（' + channel + '）'));
  }
  const bot = (create.json && (create.json.data || create.json));
  saveBotBinding(channel, bot.id);
  console.log('[tsbridge] 已为频道「' + channel + '」创建点歌机器人（' + name + '）');
  return bot.id;
}

// 找出“我们的”机器人：已绑定频道的 + 按各频道名匹配的（供断开/删除/恢复电台用）
function ourBots(bots) {
  const bindings = botBindings();
  const boundIds = new Set(Object.values(bindings).map(String));
  const names = new Set(configChannels().map((ch) => botNameFor(ch)));
  const legacyId = config.ts6mgrBotId ? String(config.ts6mgrBotId) : null;
  return (Array.isArray(bots) ? bots : []).filter((b) => {
    if (!b) return false;
    if (legacyId && String(b.id) === legacyId) return true;
    if (boundIds.has(String(b.id))) return true;
    return (b.name != null && names.has(b.name)) || (b.nickname != null && names.has(b.nickname));
  });
}

// 从 ts6-manager 的 bot 响应里取出状态字符串（兼容 data.bot.status / data.status / 嵌套等结构）
function extractBotStatus(json) {
  if (!json) return null;
  const all = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.status === 'string' && o.status) all.push(o.status);
    for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object') walk(o[k]); }
  };
  walk(json);
  for (const s of all) if (s === 'connected' || s === 'playing' || s === 'paused') return s;
  return all[all.length - 1] || null;
}

// 从 ts6-manager 的 bot 响应里取出首个匹配的字段（用于抓取 error/message 等详情）
function extractBotField(json, names) {
  if (!json) return null;
  let found = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const n of names) {
      if (o[n] != null && typeof o[n] !== 'object' && found == null) found = o[n];
    }
    for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object') walk(o[k]); }
  };
  walk(json);
  return found;
}

// 从 ts6-manager 的 bot 对象里取出它在 TS 里的 client id（字段名在 TS3/TS6 间可能不同）
function b_clid(b) {
  if (!b) return null;
  return b.clid != null ? b.clid
    : (b.clientId != null ? b.clientId
      : (b.client_id != null ? b.client_id : null));
}

async function waitBotConnected(token, botId, tries = 30) {
  let dumped = false;
  for (let i = 0; i < tries; i++) {
    try {
      const { status, json } = await authFetch('GET', '/api/music-bots/' + botId, token);
      if (status === 200) {
        const s = extractBotStatus(json);
        const detail = extractBotField(json, ['error', 'errorMessage', 'message', 'lastError', 'reason', 'description', 'detail']);
        if (!dumped && (s === 'error' || s === 'stopped')) {
          dumped = true;
          console.log('[tsbridge] waitBotConnected: 首次失败，bot 详情=' + JSON.stringify(json));
        } else if (i % 3 === 0 || s) {
          console.log('[tsbridge] waitBotConnected: 当前 status=' + s + (detail ? ' 详情=' + detail : '') + ' (尝试 ' + (i + 1) + '/' + tries + ')');
        }
        if (s === 'connected' || s === 'playing' || s === 'paused') return true;
      } else {
        console.log('[tsbridge] waitBotConnected: GET 状态码 ' + status);
      }
    } catch (e) { /* 忽略，继续等 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('[tsbridge] waitBotConnected: 超时，机器人未能连上频道');
  return false;
}

// ---------- 防重复连接（并发锁）+ 自动修复看门狗 ----------
let linking = null;          // 串行化 link()，避免并发点击重复建 bot
let desiredLinked = false;   // 用户意图：应保持连接（用于看门狗判断是否需自愈）
const autoPausedByEmpty = new Map(); // 频道 → 是否因“频道无人”被自动暂停（有人进入时自动恢复）
let watchdogTimer = null;
const repairing = new Set(); // 正在修复的频道（避免 15s tick 重叠修复）

// ---------- 频道在线人数统计（供“频道无人自动暂停”使用） ----------
// 注意：ServerQuery 客户端（serveradmin / 点歌助手）会驻留在频道里，
// 但它们收不到语音、不是“人”。按 clients 端点的 client_type 只统计真实语音用户。
const clidOfClient = (cl) => cl.clid != null ? cl.clid : (cl.client_id != null ? cl.client_id : (cl.clientId != null ? cl.clientId : null));
const cidOfClient = (cl) => cl.cid != null ? cl.cid : (cl.channel_id != null ? cl.channel_id : (cl.channelId != null ? cl.channelId : null));
const nickOfClient = (cl) => cl.nickname || cl.client_nickname || cl.name || '';

// 机器人在 TS 里的 clid 缓存（频道 → clid）：由 status() 从 bot 记录刷新，防同名冒充干扰计数
const botClidByChannel = new Map();

function isQueryClient(cl) {
  const t = cl.client_type != null ? cl.client_type
    : (cl.clientType != null ? cl.clientType : (cl.type != null ? cl.type : null));
  if (t != null) return String(t) === '1'; // TS ServerQuery：client_type=1（语音客户端为 0）
  // 个别实现不回传 client_type 时按已知查询端昵称兜底（点歌助手可能带后缀）
  const n = String(nickOfClient(cl) || '');
  return n === 'serveradmin' || n.startsWith('serveradmin ') || /^点歌助手/.test(n);
}

// 在客户端列表里定位某频道的机器人（clid 缓存优先，昵称兜底）
function findChannelBot(clients, channel) {
  const wantClid = botClidByChannel.get(channel);
  if (wantClid != null) {
    const byClid = clients.find((cl) => String(clidOfClient(cl)) === String(wantClid));
    if (byClid) return byClid;
  }
  const name = botNameFor(channel);
  return clients.find((cl) => nickOfClient(cl) === name)
    || clients.find((cl) => String(nickOfClient(cl) || '').includes(name))
    || null;
}

// 统计每个频道的真实语音用户数（排除机器人自身与 ServerQuery 客户端）。
// 机器人不在列表/定位不到频道的记 null（无法判断）。
function countRealVoiceUsersByChannel(clients, channels) {
  const out = {};
  for (const channel of channels) {
    const bot = findChannelBot(clients, channel);
    if (!bot || cidOfClient(bot) == null) { out[channel] = null; continue; }
    const botCid = String(cidOfClient(bot));
    const botClid = clidOfClient(bot) != null ? String(clidOfClient(bot)) : null;
    out[channel] = clients.filter((cl) =>
      String(cidOfClient(cl)) === botCid
      && (botClid == null || String(clidOfClient(cl)) !== botClid)
      && !isQueryClient(cl)
    ).length;
  }
  return out;
}

async function listAllClients(token, serverConfigId) {
  const sid = await getVirtualServerId(token, serverConfigId);
  const r = await authFetch('GET', '/api/servers/' + serverConfigId + '/vs/' + sid + '/clients', token);
  if (r.status !== 200) return null;
  const j = r.json;
  const clients = Array.isArray(j) ? j
    : (j && Array.isArray(j.data)) ? j.data
      : (j && j.data && Array.isArray(j.data.clients)) ? j.data.clients
        : (j && Array.isArray(j.clients)) ? j.clients : [];
  return clients;
}

// 所有已部署频道的真实语音用户总数。返回数字；完全无法判断时返回 null，调用方应忽略。
async function getChannelClientCount() {
  const channels = configChannels();
  if (!channels.length) return null;
  try {
    const token = await getToken();
    const serverConfigId = await ensureServer(token, cfg());
    const clients = await listAllClients(token, serverConfigId);
    if (!clients || !clients.length) return null;
    const per = countRealVoiceUsersByChannel(clients, channels);
    const vals = Object.values(per);
    if (vals.every((v) => v == null)) return null; // 一个频道都定位不到机器人
    return vals.reduce((a, v) => a + (v || 0), 0);
  } catch (e) {
    return null;
  }
}

// 频道无人自动暂停（按频道独立）：每个部署频道有自己的队列/播放器，
// 哪个频道没人就只暂停哪个频道；有人进来只恢复那个频道。互不影响。
async function maybeAutoPauseEmpty() {
  if (config.autoPauseEmpty === false) return;
  const channels = configChannels();
  if (!channels.length) return;
  let per = null;
  try {
    const token = await getToken();
    const serverConfigId = await ensureServer(token, cfg());
    const clients = await listAllClients(token, serverConfigId);
    if (clients && clients.length) per = countRealVoiceUsersByChannel(clients, channels);
  } catch (e) { /* 无法判断则本轮不动 */ }
  if (!per) return;
  for (const ch of channels) {
    const count = per[ch];
    if (count == null) continue; // 该频道机器人不在/定位不到，跳过
    const p = playerMod.forChannel(ch);
    const playing = !!p.get().playing;
    if (count === 0) {
      if (playing && !autoPausedByEmpty.get(ch)) {
        p.pause();
        autoPausedByEmpty.set(ch, true);
        console.log('[tsbridge] 频道「' + ch + '」无人，自动暂停该频道播放');
      }
    } else if (autoPausedByEmpty.get(ch) && !playing) {
      p.resume();
      resumeRadio(ch).catch(() => {}); // 重新向该频道机器人下达 play-radio 保活
      autoPausedByEmpty.set(ch, false);
      console.log('[tsbridge] 频道「' + ch + '」有人进入，自动恢复播放');
    }
  }
}

// 周期性检查各频道机器人在线状态并修复 + 执行无人自动暂停。
// ts6-manager 在电台空等情况会停止播放/断开；/api/stream 始终有静音保底，
// 重新下达 start + play-radio 即可让它重新拉流、保持在线。
async function watchdogTick() {
  if (!desiredLinked) return;
  try {
    const st = await status();
    if (!st || !st.enabled) return;
    for (const ch of (st.channels || [])) {
      if (!ch.connected && ch.botId && !repairing.has(ch.channel)) {
        repairing.add(ch.channel);
        repairChannel(ch.channel)
          .catch((e) => console.log('[tsbridge] 修复频道「' + ch.channel + '」失败: ' + (e && e.message)))
          .finally(() => repairing.delete(ch.channel));
      }
    }
    await maybeAutoPauseEmpty();
  } catch (e) { /* 忽略本轮 */ }
}

// 修复单个频道的机器人：start → 等连接 → 重新下达 play-radio
async function repairChannel(channel) {
  const botId = botBindings()[channel];
  if (!botId) return;
  console.log('[tsbridge] 检测到频道「' + channel + '」的机器人离线，自动修复…');
  const token = await getToken();
  const c = cfg();
  const serverConfigId = await ensureServer(token, c);
  const stationId = await ensureStation(token, serverConfigId, channel);
  await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
  const ok = await waitBotConnected(token, botId, 20);
  if (!ok) throw new Error('机器人重连超时');
  const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
  if (play.status !== 200) throw new Error(apiErrText(play.status, play.json, '播放电台失败'));
  statusCache = null; // 修复完成立即反映到面板状态
  console.log('[tsbridge] 频道「' + channel + '」的机器人已恢复在线');
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdogTick, 15000);
  if (watchdogTimer.unref) watchdogTimer.unref();
}
function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  desiredLinked = false;
}

// 按频道逐一部署：确保机器人 → 启动 → 等连接 → 播放电台（全部失败才抛错）
async function linkImpl() {
  console.log('[tsbridge] link: 步骤1/5 确保电台流公网地址…');
  await ensureStreamPublicUrl();
  const c = cfg();
  const channels = configChannels();
  if (!channels.length) {
    throw new Error('未配置任何部署频道：请先在面板「TeamSpeak 推流 → 部署频道」添加频道并保存，再点「生成机器人 / 重建连接」');
  }
  console.log('[tsbridge] link: 步骤2/5 获取 ts6-manager token（' + c.url + '）');
  const token = await getToken();
  console.log('[tsbridge] link: 步骤3/5 确保 TS 连接(serverConfig)…');
  const serverConfigId = await ensureServer(token, c);
  console.log('[tsbridge] link: 步骤4/5 按频道确保电台与机器人（共 ' + channels.length + ' 个频道）…');
  // 电台按频道创建：link 时逐频道确保（每个频道一路独立电台流）
  const results = [];
  for (const channel of channels) {
    try {
      const stationId = await ensureStation(token, serverConfigId, channel);
      const botId = await ensureBotForChannel(token, serverConfigId, channel);
      await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
      const ok = await waitBotConnected(token, botId);
      if (!ok) throw new Error('机器人连接频道超时');
      const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
      if (play.status !== 200) throw new Error(apiErrText(play.status, play.json, '播放电台失败'));
      results.push({ channel, ok: true, botId });
      console.log('[tsbridge] 频道「' + channel + '」的机器人已上线并开始推流');
    } catch (e) {
      results.push({ channel, ok: false, error: (e && e.message) || String(e) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    throw new Error('全部频道部署失败：' + failed.map((f) => f.channel + '（' + f.error + '）').join('；'));
  }
  return { ok: true, results, serverConfigId };
}

async function link() {
  if (linking) return linking;            // 并发点击：复用同一连接过程，杜绝重复建 bot
  linking = (async () => {
    try {
      const r = await linkImpl();
      desiredLinked = true;
      statusCache = null; // 部署完成立即反映到面板状态
      startWatchdog();
      return r;
    } finally {
      linking = null;
    }
  })();
  return linking;
}

// 断开：停止所有我们部署的机器人的播放（机器人留在各自频道不动）
async function unlink() {
  stopWatchdog();
  statusCache = null; // 断开后立即反映到面板状态
  const token = await getToken();
  const bots = await getBots(token);
  const targets = ourBots(bots);
  let stopped = 0;
  for (const b of targets) {
    try {
      await authFetch('POST', '/api/music-bots/' + b.id + '/stop-playback', token);
      stopped++;
    } catch (e) { /* 继续其它机器人 */ }
  }
  return { ok: true, stopped };
}

// 彻底删除我们部署的所有机器人（只删绑定的/按名字匹配的，不动用户手建的其他机器人）。
// 之后若想恢复，调用 link() 会按当前频道配置重新创建。
async function deleteBot() {
  stopWatchdog();
  desiredLinked = false;
  let token;
  try { token = await getToken(); } catch (e) { token = null; }
  let deleted = 0;
  if (token) {
    try {
      const bots = await getBots(token);
      const targets = ourBots(bots);
      for (const b of targets) {
        try {
          const r = await authFetch('DELETE', '/api/music-bots/' + b.id, token);
          if (r.status === 200 || r.status === 204) deleted++;
        } catch (e) { /* 继续 */ }
      }
    } catch (e) { /* 忽略 */ }
  }
  config.saveTsBridge({ ts6mgrChannelBots: {}, ts6mgrBotId: '' });
  botClidByChannel.clear();
  statusCache = null;
  return { ok: true, deleted: deleted > 0, count: deleted };
}

// 聚合状态：每个频道的机器人状态一行；connected = 所有已部署频道都在线。
// 结果缓存 5s：面板每 15s 轮询一次 status（getBots + 每机器人详情是多次对
// ts6-manager 的 HTTP），缓存可避免它与 resumeRadio/play-radio 排队相互拖慢。
let statusCache = null; // { at, value }
const STATUS_TTL = 5000;

async function status() {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL) return statusCache.value;
  const c = cfg();
  const channels = configChannels();
  let token;
  try { token = await getToken(); } catch (e) { return { enabled: true, connected: false, channels: [], error: e.message }; }
  try {
    const bots = await getBots(token);
    const byId = {};
    (Array.isArray(bots) ? bots : []).forEach((b) => { if (b && b.id != null) byId[String(b.id)] = b; });
    const bindings = botBindings();
    // 并行取各频道机器人状态（串行会在多频道时放大 ts6-manager 的响应延迟）
    const chs = await Promise.all(channels.map(async (channel) => {
      const bound = bindings[channel] != null ? String(bindings[channel]) : null;
      let bot = bound != null ? byId[bound] : null;
      if (!bot) {
        const name = botNameFor(channel);
        bot = (Array.isArray(bots) ? bots : []).find((b) => b && (b.name === name || b.nickname === name)) || null;
      }
      if (bot && !bot.status) {
        try {
          const r = await authFetch('GET', '/api/music-bots/' + bot.id, token);
          if (r.status === 200) bot = (r.json.data && (r.json.data.bot || r.json.data)) || bot;
        } catch (e) { /* 用列表里的信息兜底 */ }
      }
      const s = bot ? (extractBotStatus(bot) || bot.status || null) : null;
      const error = bot ? extractBotField(bot, ['error', 'errorMessage', 'message', 'lastError', 'reason', 'description', 'detail']) : null;
      const clid = bot ? b_clid(bot) : null;
      if (clid != null) botClidByChannel.set(channel, clid);
      else botClidByChannel.delete(channel);
      return {
        channel,
        botId: bot ? String(bot.id) : bound,
        nickname: bot ? (bot.nickname || bot.name || botNameFor(channel)) : botNameFor(channel),
        status: s,
        connected: s === 'connected' || s === 'playing' || s === 'paused',
        error: error || null,
        nowPlaying: bot ? (bot.nowPlaying || null) : null,
        clid,
      };
    }));
    const connected = chs.length > 0 && chs.every((x) => x.connected);
    const playing = chs.find((x) => x.nowPlaying);
    const agg = !chs.length ? 'empty'
      : connected ? 'connected'
        : chs.some((x) => x.connected) ? 'partial' : 'disconnected';
    const result = { enabled: true, connected, status: agg, channels: chs, nowPlaying: playing ? playing.nowPlaying : null };
    statusCache = { at: Date.now(), value: result };
    return result;
  } catch (e) {
    return { enabled: true, connected: false, channels: [], error: e.message };
  }
}

// 恢复播放时向对应频道的机器人重新下达 play-radio（自愈）：暂停后机器人可能放弃
// 电台流连接，仅改本地状态不会让它重新出声。channel 缺省时对所有部署频道执行。
async function resumeRadio(channel) {
  let token;
  try { token = await getToken(); } catch (e) { return { ok: false }; }
  const bots = await getBots(token);
  let targets = ourBots(bots);
  if (!targets.length) return { ok: false, count: 0 };
  const c = cfg();
  const serverConfigId = targets[0].serverConfigId || (await ensureServer(token, c));
  // 指定频道：只对该频道的机器人 + 该频道的独立电台流
  if (channel) {
    const bound = botBindings()[channel];
    const name = botNameFor(channel);
    targets = targets.filter((b) => String(b.id) === String(bound) || b.name === name || b.nickname === name);
    if (!targets.length) return { ok: false, count: 0 };
    const stationId = await ensureStation(token, serverConfigId, channel);
    const r = await authFetch('POST', '/api/music-bots/' + targets[0].id + '/play-radio', token, { stationId });
    return { ok: r.status === 200, count: r.status === 200 ? 1 : 0 };
  }
  // 缺省：逐频道恢复（每频道一路电台流）
  let n = 0;
  for (const ch of configChannels()) {
    const bound = botBindings()[ch];
    const name = botNameFor(ch);
    const bot = targets.find((b) => String(b.id) === String(bound) || b.name === name || b.nickname === name);
    if (!bot) continue;
    try {
      const stationId = await ensureStation(token, serverConfigId, ch);
      const r = await authFetch('POST', '/api/music-bots/' + bot.id + '/play-radio', token, { stationId });
      if (r.status === 200) n++;
    } catch (e) { /* 继续 */ }
  }
  return { ok: n > 0, count: n };
}

module.exports = { link, unlink, deleteBot, status, cfg, listChannels, resumeRadio, configChannels, assignNames };
module.exports._internal = {
  maybeAutoPauseEmpty,
  getChannelClientCount,
  countRealVoiceUsersByChannel,
  findChannelBot,
  botNameFor,
  isLinkedDesired: () => desiredLinked,
};

// 若之前已成功连接过（botId/频道绑定已持久化），启动看门狗，容器重启/网络抖动后自动恢复在线。
// 必须同时把 desiredLinked 置回 true：它只在 link() 成功时被置位，容器重启后恒为 false，
// 看门狗会在 tick 里直接 return——频道无人自动暂停与断线自动重连在每次重启/部署后全部失效
// （机器人本身活在 ts6-manager 进程里不受影响，问题因此很难被察觉）。
if (config.ts6mgrBotId || Object.keys(botBindings()).length) {
  desiredLinked = true;
  startWatchdog();
}
