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

// 确保正在播放：只要当前没在放，就开播（队列空则从头/继续）
function ensurePlaying() {
  const st = player.get();
  if (st.playing) return;
  if (!st.current) player.play();
  else player.resume();
}

async function addSong(body, invokerName) {
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
    queue.enqueue({
      name: detail.name,
      artists: (detail.ar || []).map((a) => a.name).join(' '),
      album: (detail.al || {}).name || '',
      cover: (detail.al || {}).picUrl || '',
      duration: detail.dt ? Math.round(detail.dt / 1000) : 0,
      fee: detail.fee != null ? detail.fee : null,
    }, (invokerName || 'TS用户') + '(TS)');
    ensurePlaying(); // 队列为空或未在播放时自动开播
    const pos = queue.all().length;
    reply(invokerName, '✔ 已加入队列：' + detail.name + '（第 ' + pos + ' 位）');
  } catch (e) {
    reply(invokerName, '✖ 点歌失败：' + e.message);
  }
}

function runControl(cmd, invokerName) {
  try {
    const st = player.get();
    if (cmd === 'play') {
      if (!st.current) player.play();
      else player.resume();
      require('./tsbridge').resumeRadio().catch(() => {});
      reply(invokerName, st.current && st.current.title ? '▶ 已继续播放：' + st.current.title : '▶ 已开始播放');
    } else if (cmd === 'pause') {
      player.pause();
      reply(invokerName, '⏸ 已暂停');
    } else if (cmd === 'next') {
      const r = player.next();
      const cur = r && r.current;
      reply(invokerName, cur ? '⏭ 已切歌：' + cur.title : '队列末尾/为空，无法继续切');
    }
  } catch (e) {
    reply(invokerName, '✖ 操作失败：' + e.message);
  }
}

// 命令分发：!点歌/!点 <ID|链接> · !播放/!继续/!pause · !暂停 · !切歌/!下一首/!next
const CTRL_MAP = {
  play: 'play', resume: 'play', 继续: 'play', 播放: 'play', 开始: 'play',
  pause: 'pause', 暂停: 'pause',
  next: 'next', skip: 'next', 切歌: 'next', 下一首: 'next',
};
const LOOP_WORDS = { loop: 1, cycle: 1, 循环: 1, 循环模式: 1 };
const LOOP_MODES = {
  all: 'all', 列表: 'all', 顺序: 'all', list: 'all',
  one: 'one', 单曲: 'one', single: 'one',
  shuffle: 'shuffle', 随机: 'shuffle',
  off: 'off', 关: 'off', none: 'off',
};
const LOOP_LABEL = { all: '列表循环', one: '单曲循环', shuffle: '随机播放', off: '顺序播放' };

// 指令是否被面板允许
// 指令是否可用于某用户：全局是唯一开关来源——全局未启用则任何人不可用；
// 用户配置只是“在全局已启用指令里再做子集限制”（空数组=该用户禁用全部）。
function cmdEnabled(name, uid) {
  const cmds = (config.chatCommands || {});
  if (cmds[name] === false) return false;      // 全局关 → 任何人不可用
  if (uid) {
    const up = (config.chatUserPermissions || {})[uid];
    if (Array.isArray(up)) return up.includes(name); // 该用户已配置 → 需在其允许列表内
  }
  return true;                                  // 全局开且未对该用户配置 → 跟随全局
}

// 各指令的展示信息与别名（供 !帮助 与面板指南使用）
const CMD_INFO = [
  { key: 'dian', label: '点歌', desc: '按歌曲ID或网易云链接点歌', aliases: ['!点歌 <ID|链接>', '!点 <ID>', '裸ID/链接'] },
  { key: 'play', label: '播放', desc: '开始/继续播放', aliases: ['!播放', '!继续', '!开始', '!play', '!resume'] },
  { key: 'pause', label: '暂停', desc: '暂停播放', aliases: ['!暂停', '!pause'] },
  { key: 'next', label: '切歌', desc: '下一首', aliases: ['!切歌', '!下一首', '!next', '!skip'] },
  { key: 'loop', label: '循环', desc: '切换循环模式：列表/单曲/随机/关（不带参数则循环切换）', aliases: ['!循环 <模式>', '!循环模式', '!loop'] },
  { key: 'status', label: '状态', desc: '查看正在播放/下一首/播放与循环状态', aliases: ['!状态', '!now', '!当前', '!playing'] },
  { key: 'clear', label: '清队列', desc: '清空点歌队列', aliases: ['!清队列', '!清队', '!清空队列', '!clear'] },
  { key: 'help', label: '帮助', desc: '列出当前用户可用的全部指令', aliases: ['!帮助', '!help', '!指令', '!?'] },
];

// 某用户当前可用的指令
function availableCmds(uid) {
  return CMD_INFO.filter((c) => cmdEnabled(c.key, uid)).map((c) => c.key);
}

// !帮助：列出该用户当前可用的全部指令（含别名）
function runHelp(invokerName, uid) {
  const on = CMD_INFO.filter((c) => cmdEnabled(c.key, uid));
  if (!on.length) {
    reply(invokerName, '你当前没有任何可用指令（可能被管理员禁用）');
    return;
  }
  reply(invokerName, '可用指令：' + on.map((c) => c.aliases[0]).join(' · '));
}

function runLoop(arg, invokerName) {
  try {
    const a = (arg || '').trim().toLowerCase();
    let mode = LOOP_MODES[a];
    let cur = player.get().loopMode;
    if (!mode) {
      if (a) { reply(invokerName, '循环模式：!循环 <列表|单曲|随机|关>（当前：' + (LOOP_LABEL[cur] || cur) + '）'); return; }
      const order = ['all', 'one', 'shuffle', 'off'];
      mode = order[(order.indexOf(cur) + 1) % order.length]; // 不给参数则循环切换
    }
    player.setLoop(mode);
    reply(invokerName, '循环模式 → ' + (LOOP_LABEL[player.get().loopMode] || player.get().loopMode));
  } catch (e) {
    reply(invokerName, '✖ 切换循环失败：' + e.message);
  }
}

// !状态：正在播放 / 下一首 / 播放与循环状态
const STATUS_WORDS = { 状态: 1, now: 1, 当前: 1, playing: 1, 正在播放: 1 };
const CLEAR_WORDS = { 清队列: 1, 清空队列: 1, 清队: 1, clear: 1 };
const HELP_WORDS = { 帮助: 1, help: 1, 指令: 1, '?': 1 };
function mm(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function runStatus(invokerName) {
  try {
    const st = player.get();
    const all = queue.all();
    const cur = st.current;
    let nowTxt = '无';
    if (cur) {
      nowTxt = cur.title + (cur.artists ? ' - ' + cur.artists : '') + ' [' + mm(st.position) + '/' + (cur.duration ? mm(cur.duration) : '--') + ']';
    }
    let nextTxt = '无';
    if (all.length) {
      const idx = cur ? all.findIndex((i) => Number(i.id) === Number(cur.id)) : -1;
      const nxt = (idx >= 0 && idx + 1 < all.length) ? all[idx + 1] : (st.loopMode === 'all' && all[0] ? all[0] : null);
      if (nxt) nextTxt = nxt.title + (nxt.artists ? ' - ' + nxt.artists : '');
    }
    reply(invokerName,
      '正在播放：' + nowTxt + '｜下一首：' + nextTxt + '｜' +
      (st.playing ? '▶播放中' : '⏸已暂停') + '｜' + '循环：' + (LOOP_LABEL[st.loopMode] || st.loopMode) +
      '｜队列：' + all.length + ' 首');
  } catch (e) {
    reply(invokerName, '✖ 状态查询失败：' + e.message);
  }
}

// !清队列：清空点歌队列（并停止播放）
function runClear(invokerName) {
  try {
    const n = queue.all().length;
    queue.clear();
    reply(invokerName, n ? ('🧹 已清空点歌队列（' + n + ' 首）') : '队列本来就是空的');
  } catch (e) {
    reply(invokerName, '✖ 清空失败：' + e.message);
  }
}

const CMD_NAME = { play: 'play', pause: 'pause', next: 'next' };
function handleRequest(rawText, invokerName, invokerUid) {
  const text = (rawText || '').trim();
  if (!text) return;
  const uid = invokerUid || '';
  const ctl = text.match(/^!\s*(\S+)\s*(.*)$/);
  if (ctl) {
    const w = ctl[1].toLowerCase();
    const rest = ctl[2].trim();
    if (CTRL_MAP[w]) {
      const name = CMD_NAME[CTRL_MAP[w]];
      if (!cmdEnabled(name, uid)) return reply(invokerName, '该指令已被禁用');
      runControl(CTRL_MAP[w], invokerName);
      return;
    }
    if (LOOP_WORDS[w]) {
      if (!cmdEnabled('loop', uid)) return reply(invokerName, '循环指令已被禁用');
      runLoop(rest, invokerName);
      return;
    }
    if (STATUS_WORDS[w]) {
      if (!cmdEnabled('status', uid)) return reply(invokerName, '状态指令已被禁用');
      runStatus(invokerName);
      return;
    }
    if (CLEAR_WORDS[w]) {
      if (!cmdEnabled('clear', uid)) return reply(invokerName, '清空队列指令已被禁用');
      runClear(invokerName);
      return;
    }
    if (HELP_WORDS[w]) {
      if (!cmdEnabled('help', uid)) return reply(invokerName, '帮助指令已被禁用');
      runHelp(invokerName, uid);
      return;
    }
    if (['点歌', '点', 'dian', 'song', 'req', '点播'].includes(w)) {
      if (!cmdEnabled('dian', uid)) return reply(invokerName, '点歌指令已被禁用');
      addSong(rest, invokerName);
      return;
    }
    reply(invokerName, '未知指令，输入 !帮助 查看可用指令');
    return;
  }
  // 无前缀：整条就是歌曲 ID 或链接才视为点歌（避免把闲聊话题误当成点歌）
  if (/^https?:\/\//i.test(text) || /^\d{4,12}$/.test(text)) {
    if (!cmdEnabled('dian', uid)) return;
    addSong(text, invokerName);
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
    if (uid !== 'serveradmin') handleRequest(p.msg || '', p.invokername || '?', uid);
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
    let botCid = null;
    let bot = null;
    const voice = items.filter((x) => String(x.client_type) !== '1'); // 机器人必然是语音客户端
    const findByName = () => voice.find((x) => x.client_nickname === '点歌机器人')
      || voice.find((x) => x.client_nickname && x.client_nickname.includes('点歌机器人')) || null;
    // 1) 已记录机器人 UID → 一律按 UID 精确识别（防普通用户冒名）
    if (config.tsBotUid) {
      const byUid = voice.find((x) => x.client_unique_identifier === config.tsBotUid);
      if (byUid) bot = byUid;
    }
    if (!bot) bot = findByName(); // 2) 未知 UID 时按昵称兜底并顺带记录 UID
    // 首次见到机器人时记录其 UID（此后以 UID 为准，冒名者不再被当机器人）
    if (bot && bot.client_unique_identifier && bot.client_unique_identifier !== config.tsBotUid) {
      try { config.saveTsBridge({ tsBotUid: bot.client_unique_identifier }); console.log('[tschat] 记录点歌机器人 UID=' + bot.client_unique_identifier); } catch (e) {}
    }
    // 3) 优先按已配置的点歌频道名定位加入频道；否则用机器人所在频道
    const wantName = (config.ts6mgrChannel || '').trim();
    const channelList = await cmd('channellist');
    const chItems = Array.isArray(channelList) ? channelList : [channelList];
    if (wantName) {
      const ch = chItems.find((x) => (x.channel_name || '') === wantName);
      if (ch) botCid = ch.cid;
    }
    if (!botCid && bot && bot.cid != null) botCid = bot.cid;
    if (!botCid) {
      const anyVoice = voice.find((x) => x.cid != null && String(x.cid) !== String(myCid));
      if (anyVoice) botCid = anyVoice.cid;
    }
    if (botCid && myClid && String(botCid) !== String(myCid)) {
      await cmd('clientmove cid=' + botCid + ' clid=' + myClid);
    }
    // 订阅频道聊天 + 私聊 + 服务器聊天，尽量覆盖用户的不同发送方式
    for (const ev of ['textchannel', 'textprivate', 'textserver']) {
      try { await cmd('servernotifyregister event=' + ev); }
      catch (e) { console.log('[tschat] 订阅 ' + ev + ' 失败：' + (e.message || e)); }
    }
    if (!bot) console.log('[tschat] 提示：未找到点歌机器人，聊天点歌仅在「点歌助手」所在频道/私聊里有效');
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

let lastError = '';
function fail(err) {
  if (!started) { teardown(); return; }
  state = 'error';
  lastError = (err && err.message) ? err.message : String(err);
  console.log('[tschat] 断开：' + lastError);
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
  getState: () => ({ state, enabled: enabled(), hasPassword: !!config.tsQueryAdminPassword, error: lastError }),
  // 测试钩子（非公开接口）
  _internal: { extractSongId, parseParams, esc, unesc, handleRequest },
};
