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

const crypto = require('crypto');
const { config } = require('./config');
const { ensureStreamPublicUrl } = require('./streamurl');
const player = require('./player');

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
    botId: config.ts6mgrBotId ? parseInt(config.ts6mgrBotId, 10) : null,
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
    let clients = null;
    if (ch.total_clients != null) clients = Number(ch.total_clients);
    else if (ch.clients != null) clients = Number(ch.clients);
    else if (ch.client_count != null) clients = Number(ch.client_count);
    else if (ch.channel_clients != null) clients = Number(ch.channel_clients);
    return { id, name, pid, clients };
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
  const token = await getToken();
  const c = cfg();
  const serverConfigId = await ensureServer(token, c);
  const channels = await getChannels(token, serverConfigId);
  return channels;
}

async function ensureStation(token, serverConfigId) {
  const c = cfg();
  // ts6-manager 的电台 URL 需附上令牌，且必须是“对 ts6-manager 可达且非内网”的地址
  const sep = c.streamUrl.includes('?') ? '&' : '?';
  const tok = c.streamTokenEnabled && c.streamToken ? c.streamToken : '';
  const streamUrl = tok ? (c.streamUrl + sep + 't=' + encodeURIComponent(tok)) : c.streamUrl;
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
  // 精确匹配
  const byExact = bots.find((b) => b && (b.name === '点歌机器人' || b.nickname === '点歌机器人'));
  if (byExact) return byExact;
  // 模糊兜底：ts6-manager 可能把名字放在别的字段或带前后缀（如 “点歌机器人#1”）
  return bots.find((b) =>
    b && (((b.name || '').includes('点歌机器人')) || ((b.nickname || '').includes('点歌机器人')))
  ) || null;
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
    autoStart: false,
  });
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(apiErrText(create.status, create.json, '创建音乐机器人失败'));
  }
  const bot = (create.json && (create.json.data || create.json));
  // 立即持久化 botId：即使后续 play-radio 失败，下次也不会重复新建机器人
  try { config.saveTsBridge({ ts6mgrBotId: String(bot.id), ts6mgrChannel: c.channel }); } catch (e) { /* 忽略 */ }
  return bot.id;
}

// 等待 bot 真正连上 TS（start 是异步的，play-radio 要求已 connected）
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

// ---------- 防重复连接（并发锁）+ 自动重连看门狗 ----------
let linking = null;          // 串行化 link()，避免并发点击重复建 bot
let desiredLinked = false;   // 用户意图：应保持连接（用于看门狗判断是否需自愈）
let autoPausedByEmpty = false; // 因“频道无人”而自动暂停（用于有人进入时自动恢复）
let watchdogTimer = null;
let switching = null;        // 串行化 switchChannel，避免来回快速切换并发 restart 把机器人搞丢
let switchPendingChannel = null; // 以最后一次切换请求为准（最新胜利）

// 取机器人所在频道的“在线客户端数”（含机器人自身）。依赖 ts6-manager 的频道列表。
// 返回数字；无法判断（未配置频道/接口缺字段）时返回 null，调用方应忽略。
async function getChannelClientCount() {
  const c = cfg();
  const path = (config.ts6mgrChannel || c.channel || '').trim();
  if (!path) return null;
  try {
    const token = await getToken();
    const serverConfigId = await ensureServer(token, c);
    const channels = await getChannels(token, serverConfigId);
    const ch = channels.find((x) => x.path === path) || channels.find((x) => x.name === path);
    if (!ch) return null;
    return ch.clients == null ? null : ch.clients;
  } catch (e) {
    return null;
  }
}

// 频道无人（仅机器人自身）时自动暂停；有人进入且此前是“因无人暂停”的，则自动恢复。
async function maybeAutoPauseEmpty() {
  if (config.autoPauseEmpty === false) return;
  const count = await getChannelClientCount();
  if (count == null) return; // 无法判断则维持现状
  const playing = !!player.get().playing;
  if (count <= 1) {
    // 频道内无人（total_clients 含机器人自身，仅机器人时=1；部分实现不含则=0）
    if (playing && !autoPausedByEmpty) {
      player.pause();
      autoPausedByEmpty = true;
      console.log('[tsbridge] 频道内无人，自动暂停播放');
    }
  } else {
    // 有人进入频道
    if (autoPausedByEmpty && !playing) {
      player.resume();
      resumeRadio().catch(() => {}); // 重新向 ts6-manager 下达 play-radio 保活
      autoPausedByEmpty = false;
      console.log('[tsbridge] 检测到有人进入频道，自动恢复播放');
    }
  }
}

// 周期性检查机器人在线状态：ts6-manager 在电台空（Queue empty）等情况会停止播放/断开，
// 我们的 /api/stream 在队列空时持续输出静音，所以只需重新下达 play-radio 即可让它重新拉流、保持在线。
async function watchdogTick() {
  if (!desiredLinked) return;
  try {
    const st = await status();
    if (!st || !st.enabled) return;
    if (st.connected) {
      // 仍在线：检查频道是否有人，无人则自动暂停
      await maybeAutoPauseEmpty();
      return;
    }
    console.log('[tsbridge] 检测到点歌机器人已断开/停止，自动重连恢复…');
    try { await link(); } catch (e) { console.log('[tsbridge] 自动重连失败: ' + (e && e.message)); }
  } catch (e) { /* 忽略本轮 */ }
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

async function linkImpl() {
  // 生成/恢复机器人前，确保电台流对外地址已正确解析（公网、非内网）。
  // 启动时的自动探测可能偶发失败，这里再试一次；仍失败会抛出清晰错误而非被 ts6-manager 拒掉。
  console.log('[tsbridge] link: 步骤1/6 确保电台流公网地址…');
  await ensureStreamPublicUrl();
  const c = cfg();
  if (!c.channel) {
    throw new Error('未配置机器人要加入的频道：请先在面板选择一个频道并保存，再点「重新连接/重建」');
  }
  console.log('[tsbridge] link: 步骤2/6 获取 ts6-manager token（' + c.url + '）');
  const token = await getToken();
  console.log('[tsbridge] link: 步骤3/6 确保 TS 连接(serverConfig)…');
  const serverConfigId = await ensureServer(token, c);
  console.log('[tsbridge] link: 步骤4/6 确保音乐机器人（serverConfig=' + serverConfigId + '）');
  const botId = await ensureBot(token, serverConfigId);
  const stationId = await ensureStation(token, serverConfigId);

  console.log('[tsbridge] link: 步骤5/6 启动机器人 botId=' + botId);
  await authFetch('POST', '/api/music-bots/' + botId + '/start', token);
  await refreshBotClid(token); // 记录机器人在 TS 里的 client id，供查询端定位
  // 等 bot 连接上频道后再播放电台（避免 “Bot is not connected”）
  console.log('[tsbridge] link: 步骤6/6 等待机器人连接频道…');
  await waitBotConnected(token, botId);
  const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
  if (play.status !== 200) {
    throw new Error(apiErrText(play.status, play.json, '播放电台失败'));
  }
  // 持久化 botId，避免重复连接时反复新建机器人
  try { config.saveTsBridge({ ts6mgrBotId: String(botId), ts6mgrChannel: c.channel }); } catch (e) { /* 忽略 */ }
  return { ok: true, botId, stationId, serverConfigId };
}

async function link() {
  if (linking) return linking;            // 并发点击：复用同一连接过程，杜绝重复建 bot
  linking = (async () => {
    try {
      const r = await linkImpl();
      desiredLinked = true;
      startWatchdog();
      return r;
    } finally {
      linking = null;
    }
  })();
  return linking;
}

async function unlink() {
  stopWatchdog();
  const c = cfg();
  const token = await getToken();
  const bots = await getBots(token);
  const bot = pickBot(c, bots) || bots[0];
  if (!bot) throw new Error('未找到音乐机器人');
  await authFetch('POST', '/api/music-bots/' + bot.id + '/stop-playback', token);
  return { ok: true, botId: bot.id };
}

// 彻底删除 ts6-manager 里的点歌机器人（停止看门狗并清空本地记录的 botId）。
// 之后若想恢复，调用 link() 会以当前配置重新创建机器人。
async function deleteBot() {
  stopWatchdog();
  desiredLinked = false;
  const c = cfg();
  let token;
  try { token = await getToken(); } catch (e) { token = null; }
  let deleted = false;
  let statusCode = null;
  if (token) {
    try {
      const bots = await getBots(token);
      const bot = pickBot(c, bots);
      if (bot) {
        const r = await authFetch('DELETE', '/api/music-bots/' + bot.id, token);
        statusCode = r.status;
        deleted = r.status === 200 || r.status === 204;
      }
    } catch (e) { /* 忽略 */ }
  }
  try { config.saveTsBridge({ ts6mgrBotId: '' }); } catch (e) { /* 忽略 */ }
  botTsClid = null;
  return { ok: true, deleted, status: statusCode };
}

// 切换机器人所在频道：更新 defaultChannel 后重启机器人进入新频道（保留播放队列/电台流）
// 注意：必须“完全断开”（stop）再重连，单停播放（stop-playback）不会让 bot 离开旧频道，
// 那样 start 只是原地恢复，造成“提示切换成功但实际没动”的现象。
//
// 来回快速切换会并发触发多个 restart，把机器人状态搞乱甚至“消失”（play-radio 报
// “Bot is not connected”）。这里用 switching 互斥 + 最新胜利队列串行化，并对每一步做重试。
function switchChannel(channelPath) {
  switchPendingChannel = channelPath; // 始终以最后一次请求为准
  if (switching) return switching;
  switching = (async () => {
    try {
      while (switchPendingChannel != null) {
        const path = switchPendingChannel;
        switchPendingChannel = null;
        await switchChannelInner(path);
      }
      return { ok: true };
    } finally {
      switching = null;
      switchPendingChannel = null;
    }
  })();
  return switching;
}

async function switchChannelInner(path) {
  const p = (path || '').trim();
  if (!p) throw new Error('频道不能为空');
  // 立即持久化新频道，使后续 start/restart 使用它作为 defaultChannel
  try { config.saveTsBridge({ ts6mgrChannel: p }); } catch (e) { /* 忽略 */ }
  const token = await getToken();
  const c = cfg();
  const serverConfigId = await ensureServer(token, c);
  const stationId = await ensureStation(token, serverConfigId);
  let bots = await getBots(token);
  let bot = pickBot(c, bots) || bots[0];
  if (!bot) return await link(); // 还没建过机器人：走完整 link
  const botId = bot.id;
  await refreshBotClid(token); // 记录机器人在 TS 里的 client id，供查询端定位
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 1) 更新目标频道
      try { await authFetch('PUT', '/api/music-bots/' + botId, token, { defaultChannel: p }); } catch (e) { /* 忽略 */ }
      // 2) 重启机器人（离开旧频道并以新频道重新加入）
      const r = await authFetch('POST', '/api/music-bots/' + botId + '/restart', token);
      if (r.status !== 200) {
        await authFetch('POST', '/api/music-bots/' + botId + '/stop', token);
      }
      // 3) 等真正连上频道（避免 “Bot is not connected”）
      const ok = await waitBotConnected(token, botId, 25);
      if (!ok) throw new Error('机器人重连超时（Bot is not connected）');
      // 4) 恢复电台流（默认频道变了，bot 重启后需要重新下达 play-radio）
      const play = await authFetch('POST', '/api/music-bots/' + botId + '/play-radio', token, { stationId });
      if (play.status !== 200) throw new Error(apiErrText(play.status, play.json, '播放电台失败'));
      try { config.saveTsBridge({ ts6mgrBotId: String(botId), ts6mgrChannel: p }); } catch (e) { /* 忽略 */ }
      desiredLinked = true;
      startWatchdog();
      return { ok: true, botId, stationId, serverConfigId };
    } catch (e) {
      lastErr = e;
      console.log('[tsbridge] 切换频道第 ' + (attempt + 1) + ' 次失败：' + (e && e.message));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // 兜底：完整重连一次（以新频道重新创建/启动机器人）
  try { return await link(); } catch (e) { throw lastErr || e; }
}

// 带 token 失效重试：401 时强制重新登录再试一次
async function withAuth(fn) {
  try {
    return await fn(await getToken());
  } catch (e) {
    if (/401/.test(e.message || '')) {
      invalidateToken();
      return fn(await getToken());
    }
    throw e;
  }
}

// 缓存音乐机器人在 TS 里的 client id（clid），供「点歌助手」查询端精准定位机器人所在频道。
// 优先用 clid 判断机器人，昵称只作兜底（昵称可能带前后缀/特殊符号）。
let botTsClid = null;
async function refreshBotClid(token) {
  try {
    const t = token || (await getToken());
    const c = cfg();
    const bots = await getBots(t);
    const bot = pickBot(c, bots);
    if (!bot) return botTsClid;
    const { status, json } = await authFetch('GET', '/api/music-bots/' + bot.id, t);
    if (status !== 200) return botTsClid;
    const b = (json.data && (json.data.bot || json.data)) || json;
    const cid = b_clid(b);
    if (cid != null) botTsClid = cid;
  } catch (e) { /* 忽略 */ }
  return botTsClid;
}
function getBotClid() { return botTsClid; }

// 从 ts6-manager 的 bot 对象里取出它在 TS 里的 client id（字段名在 TS3/TS6 间可能不同）
function b_clid(b) {
  if (!b) return null;
  return b.clid != null ? b.clid
    : (b.clientId != null ? b.clientId
      : (b.client_id != null ? b.client_id : null));
}

async function status() {
  const c = cfg();
  let token;
  try { token = await getToken(); } catch (e) { return { enabled: true, connected: false }; }
  try {
    const run = (t) => async () => {
      const bots = await getBots(t);
      const target = pickBot(c, bots) || bots[0];
      if (!target) return { enabled: true, connected: false };
      let bot = target;
      if (!bot.status) {
        const { status, json } = await authFetch('GET', '/api/music-bots/' + target.id, t);
        if (status !== 200) return { enabled: true, connected: false };
        bot = (json.data && json.data.bot) || json.data || json;
      }
      const botStatus = extractBotStatus(bot) || bot.status;
      const botError = extractBotField(bot, ['error', 'errorMessage', 'message', 'lastError', 'reason', 'description', 'detail']);
      const clid = b_clid(bot);
      if (clid != null) botTsClid = clid;
      return { enabled: true, connected: botStatus === 'connected' || botStatus === 'playing' || botStatus === 'paused', status: botStatus, error: botError || null, nowPlaying: bot.nowPlaying || null, clid: clid };
    };
    return await withAuth(run(token));
  } catch (e) {
    return { enabled: true, connected: false, error: e.message };
  }
}

// 恢复播放时重新向机器人下达 play-radio（自愈）：暂停后 ts6-manager 机器人可能已放弃
// 当前电台流连接，仅改本地状态不会让它重新出声；重下达后它会重新拉取 /api/stream。
async function resumeRadio() {
  const c = cfg();
  const token = await getToken();
  const bots = await getBots(token);
  const bot = pickBot(c, bots) || bots[0];
  if (!bot || !bot.serverConfigId) return { ok: false };
  const stationId = await ensureStation(token, bot.serverConfigId);
  await authFetch('POST', '/api/music-bots/' + bot.id + '/play-radio', token, { stationId });
  return { ok: true, botId: bot.id };
}

module.exports = { link, unlink, deleteBot, switchChannel, status, cfg, listChannels, resumeRadio, getBotClid, refreshBotClid };

// 若之前已成功连接过（botId 已持久化），启动看门狗，容器重启/网络抖动后自动恢复在线。
if (config.ts6mgrBotId) startWatchdog();
