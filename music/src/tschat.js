'use strict';

/**
 * TS 频道聊天点歌监听。
 *
 * 原理：以 serveradmin 通过 SSH ServerQuery 登录本 TS 服务器，把查询客户端
 * 移动到点歌机器人所在频道并订阅该频道文本消息（servernotifyregister
 * event=textchannel）。同频道用户在频道聊天里发送：
 *
 *   !点歌 2652820720
 *   !点歌 https://music.163.com/song?id=2652820720
 *   !点歌 https://music.163.com/song/2652820720/
 *   （或整条消息就是一个纯 ID / 链接，无需前缀）
 *
 * 即自动提取歌曲 ID → 拉取歌曲详情 → 加入点歌队列（requestedBy 记录 TS 昵称），
 * 若当前没有播放则立即开始播放，并向频道回执结果。
 *
 * 启用条件：配置了 TS_QUERY_ADMIN_PASSWORD 且未显式禁用（TS_CHAT_ENABLED=0）。
 */

const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');
const player = require('./player');

const CMD_PREFIX = /^!\s*(?:点歌|play|dian)\s*/i;
let conn = null;          // 当前 ssh 连接
let stream = null;        // shell 数据流
let retryTimer = null;
let started = false;
let state = 'stopped';    // stopped | connecting | listening | error

function envKillSwitch() {
  return process.env.TS_CHAT_ENABLED === '0';
}

// 是否应处于运行状态：面板/持久化配置优先，env 仅作总闸
function enabled() {
  if (envKillSwitch()) return false;
  if (config.tsChatEnabled === false) return false;
  return !!config.tsQueryAdminPassword;
}

// ---------- ServerQuery 行协议小工具 ----------
function esc(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\s')
    .replace(/\|/g, '\\p')
    .replace(/\r/g, '')
    .replace(/\n/g, '');
}
function unesc(v) {
  return String(v)
    .replace(/\\s/g, ' ')
    .replace(/\\p/g, '|')
    .replace(/\\\\/g, '\\');
}
// 解析一行 notifytextmessage key=value key="v v" ... 参数
function parseParams(line) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = unesc(m[3] != null ? m[3] : m[2]);
  return out;
}

// 从文本提取网易云歌曲 ID：支持 ?id=、/song/<id>、纯数字
function extractSongId(text) {
  if (!text) return null;
  const t = text.trim();
  let m = t.match(/[?&]id=(\d{4,12})/i);
  if (m) return m[1];
  m = t.match(/song\/(\d{4,12})/i);
  if (m) return m[1];
  m = t.match(/^(\d{4,12})$/);
  if (m) return m[1];
  return null;
}

// ---------- 与队列/播放器对接 ----------
async function handleRequest(rawText, invokerName) {
  const text = rawText.trim();
  const hasPrefix = CMD_PREFIX.test(text);
  const body = text.replace(CMD_PREFIX, '').trim();
  if (!hasPrefix && !/^https?:\/\//i.test(body) && !/^\d{4,12}$/.test(body)) return; // 普通聊天忽略
  const songId = extractSongId(body);
  if (!songId) {
    reply(invokerName, '用法：!点歌 <歌曲ID 或 网易云链接>');
    return;
  }
  try {
    let detail = null;
    try {
      const d = await enhanced.songDetail(songId);
      detail = d && d.songs && d.songs[0];
    } catch (e) { /* 详情失败仍可尝试入队最小信息 */ }
    if (!detail) detail = { id: songId, name: '歌曲 ' + songId };
    const beforeIdle = !player.get().current;
    queue.enqueue({
      name: detail.name,
      artists: (detail.ar || []).map((a) => a.name).join(' '),
      album: (detail.al || {}).name || '',
      cover: (detail.al || {}).picUrl || '',
      duration: detail.dt ? Math.round(detail.dt / 1000) : 0,
      fee: detail.fee != null ? detail.fee : null,
    }, (invokerName || 'TS用户') + '(TS)');
    if (beforeIdle) player.play();
    const pos = queue.all().length;
    reply(invokerName, '✔ 已加入队列：' + detail.name + '（第 ' + pos + ' 位）');
  } catch (e) {
    reply(invokerName, '✖ 点歌失败：' + e.message);
  }
}

// 向频道回执（targetmode=2 为频道聊天）
function reply(invokerName, msg) {
  cmd('sendtextmessage targetmode=2 msg=' + esc('[点歌] ' + msg)).catch(() => {});
}

// ---------- 单一分发器：所有行经此路由（通知 / 命令应答） ----------
// 每条命令串行排队，应答按到达顺序配对，避免多监听器抢行导致的超时/错位。
const pending = []; // { rows, resolve, reject, timer }
function dispatchLine(line) {
  if (line.startsWith('notifytextmessage')) {
    const p = parseParams(line);
    console.log('[tschat] 收到聊天 from=' + (p.invokername || '?') + ' uid=' + (p.invokeruid || '') + ' msg=' + String(p.msg || '').slice(0, 80));
    const uid = p.invokeruid || '';
    if (uid !== 'serveradmin') handleRequest(p.msg || '', p.invokername || '?').catch(() => {});
    return;
  }
  const head = pending[0];
  if (!head) return;
  if (/^error id=/i.test(line)) {
    pending.shift();
    clearTimeout(head.timer);
    if (/^error id=0\b/i.test(line)) {
      const rows = head.rows;
      resolveHead(head, rows.length ? rows[rows.length - 1] : {});
    } else {
      rejectHead(head, new Error(line));
    }
    return;
  }
  head.rows.push(parseParams(line));
}
function resolveHead(h, v) { try { h.resolve(v); } catch (e) {} }
function rejectHead(h, e) { try { h.reject(e); } catch (e2) {} }

// 发送命令并等待其应答（串行 FIFO 配对）
function cmd(cmdStr, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!stream) return reject(new Error('chat 连接未就绪'));
    const entry = { rows: [], resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('cmd 超时: ' + cmdStr));
    }, timeoutMs);
    pending.push(entry);
    stream.write(cmdStr + '\n');
  });
}

// ---------- SSH 连接管理 ----------
function connect() {
  const host = config.tsHost || 'teamspeak';
  const port = parseInt(process.env.TS_CHAT_SSH_PORT || '10022', 10);
  state = 'connecting';
  const { Client } = require('ssh2');
  const c = new Client();
  conn = c;

  c.on('ready', () => {
    // TS6 查询接口拒绝 PTY 分配，必须以无伪终端方式打开 shell
    c.shell(false, (err, s) => {
      if (err) { fail(err); return; }
      stream = s;
      let buf = '';
      let bannerSeen = false;
      s.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '').trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          // 必须等服务端打出 TS3 横幅后才接受命令（过早写入会被丢弃）
          if (!bannerSeen) {
            if (/^TS3\b/.test(line)) { bannerSeen = true; bootstrap(); }
            continue;
          }
          dispatchLine(line);
        }
      });
      s.on('close', () => {
        // 面板主动停止时 conn.end() 会触发 close，属正常流程
        if (!started) { teardown(); return; }
        fail(new Error('shell closed'));
      });
      s.stderr && s.stderr.on('data', () => {});
    });
  });
  c.on('error', (e) => {
    if (!started) { teardown(); return; }
    fail(e);
  });

  c.connect({
    host,
    port,
    username: 'serveradmin',
    password: config.tsQueryAdminPassword,
    readyTimeout: 8000,
    keepaliveInterval: 30000,
  });
}

let bootstrapped = false;
async function bootstrap() {
  try {
    await cmd('use ' + (process.env.TS_CHAT_SID || '1'));
    // 昵称冲突自愈（上一次连接未干净退出时 513）
    const baseNick = process.env.TS_CHAT_NICKNAME || '点歌助手';
    let nick = baseNick;
    try {
      await cmd('clientupdate client_nickname=' + esc(nick));
    } catch (e) {
      nick = baseNick + Math.floor(Math.random() * 90 + 10);
      await cmd('clientupdate client_nickname=' + esc(nick));
    }
    // 找到机器人所在频道并移过去（查询客户端只能收到自己所在频道的聊天）
    const who = await cmd('whoami');
    // TS6 的 whoami 字段为 client_id / client_channel_id（非 TS3 的 clid/cid）
    const myClid = who.client_id != null ? who.client_id : who.clid;
    const myCid = who.client_channel_id != null ? who.client_channel_id : who.cid;
    const list = await cmd('clientlist -uid');
    // clientlist 单行时可能是对象，统一成数组
    const rawItems = Array.isArray(list) ? list : [list];
    const items = rawItems.filter(Boolean);
    // 1) 优先按已配置的点歌频道名定位；2) 其次按机器人昵称；3) 兜底第一个语音用户频道
    const wantName = (config.ts6mgrChannel || '').trim();
    const channelList = await cmd('channellist');
    const chItems = Array.isArray(channelList) ? channelList : [channelList];
    let botCid = null;
    let botSeen = items.some((x) => x.client_nickname && x.client_nickname.includes('点歌机器人'));
    if (wantName) {
      const ch = chItems.find((x) => (x.channel_name || '') === wantName);
      if (ch) botCid = ch.cid;
    }
    if (!botCid) {
      const bot = items.find((x) => x.client_nickname === '点歌机器人')
        || items.find((x) => x.client_nickname && x.client_nickname.includes('点歌机器人'));
      if (bot) botCid = bot.cid;
      botSeen = botSeen || !!bot;
    }
    if (!botCid) {
      const voice = items.find((x) => String(x.client_type) !== '1');
      if (voice && String(voice.cid) !== String(myCid) && voice.cid != null) botCid = voice.cid;
    }
    if (botCid && myClid && String(botCid) !== String(myCid)) {
      await cmd('clientmove cid=' + botCid + ' clid=' + myClid);
    }
    // 订阅频道聊天 + 私聊 + 服务器聊天，尽量覆盖用户的不同发送方式
    for (const ev of ['textchannel', 'textprivate', 'textserver']) {
      try { await cmd('servernotifyregister event=' + ev); }
      catch (e) { console.log('[tschat] 订阅 ' + ev + ' 失败：' + (e.message || e)); }
    }
    if (!botSeen) console.log('[tschat] 提示：未找到点歌机器人，聊天点歌仅在「点歌助手」所在频道/私聊里有效');
    bootstrapped = true;
    state = 'listening';
    console.log('[tschat] 已加入频道并监听 !点歌 命令 (clid=' + myClid + ', cid=' + (botCid || myCid || '?') + ', 昵称=' + nick + ')');
  } catch (e) {
    fail(e);
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 8000);
}

function fail(err) {
  if (!started) { teardown(); return; }
  state = 'error';
  console.log('[tschat] 断开：' + (err && err.message ? err.message : err));
  teardown();
  if (started && enabled()) scheduleRetry();
}

// 立即停掉监听（面板关闭开关时调用）
function stop() {
  started = false;
  state = 'stopped';
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  teardown();
}

function teardown() {
  while (pending.length) {
    const p = pending.shift();
    clearTimeout(p.timer);
    try { p.reject(new Error('已停止')); } catch (e) {}
  }
  try { conn && conn.end(); } catch (e) {}
  conn = null; stream = null; bootstrapped = false;
}

// 面板保存配置后调用：按最新配置启/停/重连
let appliedSig = null; // 当前连接使用的凭据指纹
function applyConfig() {
  const want = enabled();
  const sig = config.tsQueryAdminPassword || '';
  if (!want) {
    if (started) stop();
    console.log('[tschat] 已按配置停止');
    return;
  }
  // 需要启动，或密码已变化 → 重建连接
  if (started && appliedSig !== sig) {
    console.log('[tschat] 查询密码变更，重建连接');
    teardown();
    started = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }
  if (!started) {
    appliedSig = sig;
    start();
  }
}

function start() {
  if (started) return;
  if (!enabled()) {
    console.log('[tschat] 未启用（需设置查询密码；可在点歌页「频道聊天点歌」中配置）');
    return;
  }
  started = true;
  connect();
}

module.exports = {
  start,
  stop,
  applyConfig,
  enabled,
  getState: () => ({ state, enabled: enabled(), hasPassword: !!config.tsQueryAdminPassword }),
  // 测试钩子（非公开接口）
  _internal: { extractSongId, parseParams, esc, unesc, handleRequest },
};
