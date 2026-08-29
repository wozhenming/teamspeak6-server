'use strict';

/**
 * TS 频道聊天点歌监听（每频道一个点歌助手）。
 *
 * 每个配置的频道各有一条独立的 SSH ServerQuery 连接，昵称为「点歌助手」
 * （多频道时加「·频道名」后缀），启动后驻留自己的频道，绝不跨频道移动：
 *
 *   默认频道/点歌专区  ← 点歌助手（收本频道的 !点歌 等指令）
 *   默认频道/游戏专区  ← 点歌助手·游戏专区（收本频道的 !点歌 等指令）
 *
 * 各频道发指令 → 提取歌曲 ID → 加入全局点歌队列 → 回执到指令所在频道。
 * 队列/播放全局共享，任一频道点歌都影响同一路电台流。
 *
 * 启用条件：配置了 TS_QUERY_ADMIN_PASSWORD 且未显式禁用（TS_CHAT_ENABLED=0）。
 */

const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');
const player = require('./player');
const tsbridge = require('./tsbridge');

// ---------- 会话表：频道 → 点歌助手连接 ----------
const sessions = new Map(); // channelPath -> session

function createSession(channel) {
  return {
    channel,            // 绑定的频道路径（固定，不移动）
    nick: '',           // 本会话昵称（用于过滤自己发的消息）
    conn: null,         // ssh 连接
    stream: null,       // shell 数据流
    state: 'stopped',   // stopped | connecting | listening | error
    retryTimer: null,
    moveChain: Promise.resolve(),
    pending: [],        // 本会话的命令 FIFO
    started: false,
  };
}

// 串行化单会话内所有“移动/自检”操作，避免并发读取过期状态
function enqueueMove(session, task) {
  const run = session.moveChain.then(task, task);
  session.moveChain = run.then(() => {}, () => {});
  return run;
}

function envKillSwitch() {
  return process.env.TS_CHAT_ENABLED === '0';
}

// 是否应处于运行状态：面板/持久化配置优先，env 仅作总闸
function enabled() {
  if (envKillSwitch()) return false;
  if (config.tsChatEnabled === false) return false;
  return !!config.tsQueryAdminPassword;
}

// ---------- 点歌助手命名 ----------
function assistantBase() {
  return (process.env.TS_CHAT_NICKNAME || '点歌助手').trim() || '点歌助手';
}

// 某频道对应的点歌助手名：单频道用原名；多频道加「·频道名」后缀（与机器人同规则）
function assistantNameFor(channel) {
  const channels = tsbridge.configChannels();
  const names = tsbridge.assignNames(channels, assistantBase());
  if (names[channel]) return names[channel];
  // 频道刚加、还没同步进配置时的兜底
  return channels.length === 1 ? assistantBase() : assistantBase() + '·' + String(channel).split('/').pop();
}

// ---------- ServerQuery 行协议小工具 ----------
function esc(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\s')
    .replace(/\|/g, '\\p')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}
function unesc(v) {
  return String(v)
    .replace(/\\s/g, ' ')
    .replace(/\\p/g, '|')
    .replace(/\\\\/g, '\\');
}
// 判断某位置的 '|' 是否为“行分隔符”而不是被反斜杠转义的 \p（原义管道符）。
// 只有前面反斜杠数量为偶数时才是真正的分隔符。
function isRowSeparator(line, idx) {
  let bs = 0, i = idx - 1;
  while (i >= 0 && line[i] === '\\') { bs++; i--; }
  return bs % 2 === 0;
}
// TS6 ServerQuery 会把多条结果行用 '|' 拼在同一行返回（如 channellist/clientlist/serverlist），
// 单行 parseParams 会把它们合并成一个错乱对象（字段跨行混搭、仅留最后一行值），导致
// 无法正确解析列表。这里先把一行按未转义的 '|' 拆成多行，再逐行解析。
function splitRows(line) {
  const rows = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && isRowSeparator(line, i)) {
      rows.push(line.slice(start, i));
      start = i + 1;
    }
  }
  rows.push(line.slice(start));
  return rows.filter((r) => r.length > 0);
}
// 解析一行 notifytextmessage key=value key="v v" ... 参数
function parseParams(line) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = unesc(m[3] != null ? m[3] : m[2]);
  return out;
}
// 把一行 ServerQuery 数据行解析成一个对象；若该行是 '|' 拼接的多行则返回对象数组
function rowsOrObjects(line) {
  const parts = splitRows(line);
  if (parts.length <= 1) return [parseParams(line)];
  return parts.map(parseParams);
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

// ---------- 与队列/播放器对接（全部按会话所在频道隔离） ----------

// 确保某频道正在播放：只要该频道当前没在放，就开播（队列空则从头/继续）
function ensurePlaying(channel) {
  const st = player.forChannel(channel).get();
  if (st.playing) return;
  if (!st.current) player.forChannel(channel).play();
  else player.forChannel(channel).resume();
}

async function addSong(body, invokerName, reply, channel) {
  const songId = extractSongId(body);
  if (!songId) {
    reply('用法：!点歌 <歌曲ID 或 网易云链接>');
    return;
  }
  try {
    let detail = null;
    try {
      const d = await enhanced.songDetail(songId);
      detail = d && d.songs && d.songs[0];
    } catch (e) { /* 详情失败仍可尝试入队最小信息 */ }
    if (!detail) detail = { id: songId, name: '歌曲 ' + songId };
    const q = queue.forChannel(channel);
    q.enqueue({
      name: detail.name,
      songId: songId,
      artists: (detail.ar || []).map((a) => a.name).join(' '),
      album: (detail.al || {}).name || '',
      cover: (detail.al || {}).picUrl || '',
      duration: detail.dt ? Math.round(detail.dt / 1000) : 0,
      fee: detail.fee != null ? detail.fee : null,
    }, (invokerName || 'TS用户') + '(TS)');
    ensurePlaying(channel); // 队列为空或未在播放时自动开播
    const pos = q.all().length;
    reply('✔ 已加入本频道队列：' + detail.name + '（第 ' + pos + ' 位）');
  } catch (e) {
    reply('✖ 点歌失败：' + e.message);
  }
}

function runControl(cmdName, invokerName, arg, reply, channel) {
  try {
    const st = player.forChannel(channel).get();
    if (cmdName === 'play') {
      const at = parsePosition(arg);
      if (at) { runPlayAt(at, invokerName, reply, channel); return; }
      if (!st.current) player.forChannel(channel).play();
      else player.forChannel(channel).resume();
      require('./tsbridge').resumeRadio(channel).catch(() => {});
      reply(st.current && st.current.title ? '▶ 已继续播放：' + st.current.title : '▶ 已开始播放');
    } else if (cmdName === 'pause') {
      player.forChannel(channel).pause();
      reply('⏸ 已暂停');
    } else if (cmdName === 'next') {
      const r = player.forChannel(channel).next();
      const cur = r && r.current;
      reply(cur ? '⏭ 已切歌：' + cur.title : '队列末尾/为空，无法继续切');
      // 切歌后主动重新向 ts6-manager 下达 play-radio：即便它此前因流空档报
      // “Queue empty” 停掉了点歌机器人，也能立即恢复拉流，避免掉线。
      require('./tsbridge').resumeRadio(channel).catch(() => {});
    } else if (cmdName === 'clear') {
      runClear(invokerName, reply, channel);
    } else if (cmdName === 'search') {
      runSearch(arg || '', invokerName, reply);
    } else if (cmdName === 'queue') {
      runQueue(arg || '', invokerName, reply, channel);
    }
  } catch (e) {
    reply('✖ 操作失败：' + e.message);
  }
}

// 清空本频道点歌队列（并停止当前播放，emitChange(null) 会触发 player 停止）
function runClear(invokerName, reply, channel) {
  try {
    const n = queue.forChannel(channel).all().length;
    queue.forChannel(channel).clear();
    reply(n ? ('🧹 已清空本频道点歌队列（' + n + ' 首）') : '队列本来就是空的');
  } catch (e) {
    reply('✖ 清空失败：' + e.message);
  }
}

// 从 "!第3首" / "3" / "第 3 首" / "3首" 中解析 1 基序号
function parsePosition(text) {
  if (text == null) return null;
  const m = String(text).match(/第?\s*(\d+)\s*(?:首|位|个|song)?/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// 跳播队列指定位置（1 基）：!播放第3首 / !播3 / !跳3 / !播放 3
function runPlayAt(n, invokerName, reply, channel) {
  const all = queue.forChannel(channel).all();
  if (!all.length) return reply('队列为空，用 !点歌 <ID> 添加歌曲');
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    return reply('✖ 队列只有 ' + all.length + ' 首，无法播放第 ' + n + ' 首');
  }
  const item = all[n - 1];
  const res = player.forChannel(channel).play(item.id);
  const played = res.current || item;
  require('./tsbridge').resumeRadio(channel).catch(() => {});
  reply('▶ 已跳播第 ' + n + ' 首：' + (played.title || played.name) + (played.artists ? ' - ' + played.artists : ''));
}

// 查看本频道播放队列（分页，每页最多 10 首）：!队列 [页码]
function runQueue(arg, invokerName, reply, channel) {
  const all = queue.forChannel(channel).all();
  const total = all.length;
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = player.forChannel(channel).get().current;
  const curId = cur ? cur.id : null;
  // 未指定页码时，默认定位到“当前正在播放的歌曲”所在页
  let defaultPage = 1;
  if (curId != null) {
    const curIndex = all.findIndex((s) => Number(s.id) === Number(curId));
    if (curIndex >= 0) defaultPage = Math.floor(curIndex / pageSize) + 1;
  }
  let page = parseInt((arg || '').trim(), 10);
  if (!page || page < 1) page = defaultPage;
  if (page > pages) page = pages;
  const start = (page - 1) * pageSize;
  const slice = all.slice(start, start + pageSize);
  if (!total) {
    reply('队列为空，用 !点歌 <ID> 添加歌曲');
    return;
  }
  const lines = slice.map((s, i) => {
    const idx = start + i + 1;
    const mark = (s.id === curId) ? '▶ ' : '  ';
    const artists = s.artists ? ' - ' + s.artists : '';
    const sid = s.songId || s.id;
    return mark + idx + '. ' + s.title + artists + '  (ID:' + sid + ')';
  });
  let msg = '📜 本频道播放队列（共 ' + total + ' 首，第 ' + page + '/' + pages + ' 页）\n' + lines.join('\n');
  if (pages > 1) {
    msg += '\n!队列 ' + (page < pages ? (page + 1) : 1) + ' 查看' + (page < pages ? '下一页' : '首页');
  }
  reply(msg);
}

// 按关键词搜索歌曲，返回前 5 首：歌名 - 歌手（ID）
function runSearch(keyword, invokerName, reply) {
  keyword = (keyword || '').trim();
  if (!keyword) {
    reply('用法：!搜索 <歌曲名/关键字>，例如 !搜索 周杰伦');
    return;
  }
  // 异步执行，避免阻塞命令分发
  (async () => {
    try {
      const result = await enhanced.search(keyword, 'song', 5, 0);
      const songs = (result && result.songs) || [];
      if (!songs.length) {
        reply('未找到与「' + keyword + '」相关的歌曲');
        return;
      }
      const lines = songs.slice(0, 5).map((s, i) => {
        const artists = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join('/') : (s.artist || '');
        return (i + 1) + '. ' + s.name + (artists ? ' - ' + artists : '') + '  (ID:' + s.id + ')';
      });
      reply('🔍 搜索「' + keyword + '」前 ' + lines.length + ' 首：\n' + lines.join('\n') + '\n用 !点歌 <ID> 点播');
    } catch (e) {
      reply('✖ 搜索失败：' + e.message);
    }
  })();
}

// 命令分发：!点歌/!点 <ID|链接> · !播放/!继续/!pause · !暂停 · !切歌/!下一首/!next · !清队列 · !搜索 <关键词>
const CTRL_MAP = {
  play: 'play', resume: 'play', 继续: 'play', 播放: 'play', 开始: 'play',
  pause: 'pause', 暂停: 'pause',
  next: 'next', skip: 'next', 切歌: 'next', 下一首: 'next',
  clear: 'clear', 清队列: 'clear', 清空队列: 'clear', 清队: 'clear', 清掉队列: 'clear',
  search: 'search', 搜: 'search', 搜索: 'search', 查找: 'search', 找歌: 'search', find: 'search',
  queue: 'queue', 队列: 'queue', 列表: 'queue', q: 'queue', playlist: 'queue', 待播: 'queue',
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
function cmdEnabled(name) {
  const cmds = (config.chatCommands || {});
  return cmds[name] !== false;
}

function runLoop(arg, invokerName, reply, channel) {
  try {
    const a = (arg || '').trim().toLowerCase();
    let mode = LOOP_MODES[a];
    let cur = player.forChannel(channel).get().loopMode;
    if (!mode) {
      if (a) { reply('循环模式：!循环 <列表|单曲|随机|关>（当前：' + (LOOP_LABEL[cur] || cur) + '）'); return; }
      const order = ['all', 'one', 'shuffle', 'off'];
      mode = order[(order.indexOf(cur) + 1) % order.length]; // 不给参数则循环切换
    }
    player.forChannel(channel).setLoop(mode);
    reply('循环模式 → ' + (LOOP_LABEL[player.forChannel(channel).get().loopMode] || player.forChannel(channel).get().loopMode));
  } catch (e) {
    reply('✖ 切换循环失败：' + e.message);
  }
}

// !状态：本频道正在播放 / 下一首 / 播放与循环状态
const STATUS_WORDS = { 状态: 1, now: 1, 当前: 1, playing: 1, 正在播放: 1 };
function mm(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function runStatus(invokerName, reply, channel) {
  try {
    const st = player.forChannel(channel).get();
    const all = queue.forChannel(channel).all();
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
    reply('正在播放：' + nowTxt + '｜下一首：' + nextTxt + '｜' +
      (st.playing ? '▶播放中' : '⏸已暂停') + '｜' + '循环：' + (LOOP_LABEL[st.loopMode] || st.loopMode) +
      '｜队列：' + all.length + ' 首');
  } catch (e) {
    reply('✖ 状态查询失败：' + e.message);
  }
}

const CMD_NAME = { play: 'play', pause: 'pause', next: 'next', clear: 'clear', search: 'search', queue: 'queue', playat: 'playat' };
function handleRequest(rawText, invokerName, reply, channel) {
  const text = (rawText || '').trim();
  if (!text) return;
  channel = channel || 'default';
  const ctl = text.match(/^!\s*(\S+)\s*(.*)$/);
  if (ctl) {
    const w = ctl[1].toLowerCase();
    const rest = ctl[2].trim();
    if (CTRL_MAP[w]) {
      const name = CMD_NAME[CTRL_MAP[w]];
      if (!cmdEnabled(name)) return reply('该指令已被管理员禁用');
      runControl(CTRL_MAP[w], invokerName, rest, reply, channel);
      return;
    }
    if (LOOP_WORDS[w]) {
      if (!cmdEnabled('loop')) return reply('循环指令已被管理员禁用');
      runLoop(rest, invokerName, reply, channel);
      return;
    }
    if (STATUS_WORDS[w]) {
      if (!cmdEnabled('status')) return reply('状态指令已被管理员禁用');
      runStatus(invokerName, reply, channel);
      return;
    }
    if (['点歌', '点', 'dian', 'song', 'req', '点播'].includes(w)) {
      if (!cmdEnabled('dian')) return reply('点歌指令已被管理员禁用');
      addSong(rest, invokerName, reply, channel);
      return;
    }
    // 跳播队列第 N 首：!播放第3首 / !播3 / !跳3 / !第3首 / !play3
    const playAtMatch = text.match(/^!\s*(?:播|播放|跳|选|放|第|play|jump|goto|select|p)\s*第?\s*(\d+)\s*(?:首|位|个|song)?\s*$/i);
    if (playAtMatch) {
      if (!cmdEnabled('playat')) return reply('该指令已被管理员禁用');
      runPlayAt(parseInt(playAtMatch[1], 10), invokerName, reply, channel);
      return;
    }
    reply('可用指令：!点歌 <歌曲ID或链接> · !播放(第N首) · !暂停 · !切歌 · !清队列 · !搜索 <关键词> · !队列 [页码] · !循环 · !状态');
    return;
  }
  // 无前缀：整条就是歌曲 ID 或链接才视为点歌（避免把闲聊话题误当成点歌）
  if (/^https?:\/\//i.test(text) || /^\d{4,12}$/.test(text)) {
    if (!cmdEnabled('dian')) return;
    addSong(text, invokerName, reply, channel);
  }
}

// ---------- 单会话命令收发：应答按到达顺序配对（每会话独立 FIFO） ----------
function dispatchLine(session, line) {
  if (line.startsWith('notifytextmessage')) {
    const p = parseParams(line);
    console.log('[tschat][' + session.channel + '] 收到聊天 from=' + (p.invokername || '?') + ' tm=' + (p.targetmode || '?') + ' msg=' + String(p.msg || '').slice(0, 120));
    const invName = (p.invokername || '').trim();
    // 仅忽略“自己发出的回执”（按本会话昵称判断，最可靠）
    if (invName && invName === session.nick) return;
    // 指令只作用于本会话所在频道的队列/播放器
    handleRequest(p.msg || '', invName || '?', (msg) => reply(session, msg), session.channel);
    return;
  }
  const head = session.pending[0];
  if (!head) return;
  if (/^error id=/i.test(line)) {
    session.pending.shift();
    clearTimeout(head.timer);
    if (/^error id=0\b/i.test(line)) {
      const rows = head.rows;
      // 成功应答：若只解析出一行（多数命令）返回该对象，多行（列表类）返回数组。
      resolveHead(head, rows.length ? (rows.length === 1 ? rows[0] : rows) : {});
    } else {
      rejectHead(head, new Error(line));
    }
    return;
  }
  const objs = rowsOrObjects(line);
  for (const o of objs) head.rows.push(o);
}
function resolveHead(h, v) { try { h.resolve(v); } catch (e) {} }
function rejectHead(h, e) { try { h.reject(e); } catch (e2) {} }

// 发送命令并等待其应答（单会话内串行 FIFO 配对）
function cmd(session, cmdStr, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!session.stream) return reject(new Error('chat 连接未就绪'));
    const entry = { rows: [], resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = session.pending.indexOf(entry);
      if (i >= 0) session.pending.splice(i, 1);
      reject(new Error('cmd 超时: ' + cmdStr));
    }, timeoutMs);
    session.pending.push(entry);
    session.stream.write(cmdStr + '\n');
  });
}

// 向本会话所在频道回执（targetmode=2 为频道聊天）
function reply(session, msg) {
  cmd(session, 'sendtextmessage targetmode=2 msg=' + esc('[点歌] ' + msg)).catch(() => {});
}

// TeamSpeak ServerQuery 参数转义：空格→\s，反斜杠→\\，竖线→\p（频道名含空格必须转义）
function q(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\p')
    .replace(/ /g, '\\s');
}

// 解析频道 cid（多管齐下，兼容 TS6 查询端可见性受限的情况）：
// 1) channelidbyname（按名字→cid，旧版已在真实 TS6 上验证可用）
// 2) channellist 精确/叶子匹配（支持 '|' 拼接多行）
// 3) channelinfo 逐个探测
// 全部失败时抛错并带上「查询端实际看到的频道名」，便于从日志定位。
async function resolveChannelCid(session, channelPath) {
  const want = String(channelPath || '').trim();
  const leaf = want.split('/').pop().trim();
  const low = (v) => String(v || '').trim().toLowerCase();
  // 1) channelidbyname：不依赖查询端可见性，优先尝试（叶子名 + 完整名都试）
  for (const nm of [leaf, want]) {
    if (!nm) continue;
    try {
      const r = await cmd(session, 'channelidbyname channel_name=' + q(nm));
      const obj = (Array.isArray(r) ? r[0] : r) || {};
      if (obj.cid != null) return String(obj.cid);
    } catch (e) { /* 部分版本不支持该命令，继续走下一途径 */ }
  }
  // 2) channellist 匹配
  let seen = [];
  try {
    const cl = await cmd(session, 'channellist');
    const items = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
    seen = items.map((c) => c.channel_name);
    for (const ch of items) {
      if ((low(ch.channel_name) === low(want) || low(ch.channel_name) === low(leaf)) && ch.cid != null) {
        return String(ch.cid);
      }
    }
  } catch (e) { /* 继续走下一途径 */ }
  // 3) channelinfo 逐个探测
  for (let cid = 1; cid <= 20; cid++) {
    try {
      const ci = await cmd(session, 'channelinfo cid=' + cid);
      const o = (Array.isArray(ci) ? ci[0] : ci) || {};
      if (low(o.channel_name) === low(leaf) || low(o.channel_name) === low(want)) return String(cid);
    } catch (e) { /* 该 cid 可能不存在，忽略 */ }
  }
  throw new Error('找不到频道「' + want + '」（查询端 channellist 实际看到: ' + JSON.stringify(seen) + '）');
}

// ---------- 单会话 SSH 连接管理 ----------
function connect(session) {
  const host = config.tsHost || 'teamspeak';
  const port = parseInt(process.env.TS_CHAT_SSH_PORT || '10022', 10);
  console.log('[tschat][' + session.channel + '] 连接 TeamSpeak SSH Query：host=' + host + ' port=' + port);
  session.state = 'connecting';
  const { Client } = require('ssh2');
  const c = new Client();
  session.conn = c;

  c.on('ready', () => {
    // TS6 查询接口拒绝 PTY 分配，必须以无伪终端方式打开 shell
    c.shell(false, (err, s) => {
      if (err) { fail(session, err); return; }
      session.stream = s;
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
            if (/^TS3\b/.test(line)) { bannerSeen = true; bootstrap(session); }
            continue;
          }
          dispatchLine(session, line);
        }
      });
      s.on('close', () => {
        // 面板主动停止时 conn.end() 会触发 close，属正常流程
        if (!session.started) { teardownSession(session); return; }
        fail(session, new Error('shell closed'));
      });
      s.stderr && s.stderr.on('data', () => {});
    });
  });
  c.on('error', (e) => {
    if (!session.started) { teardownSession(session); return; }
    fail(session, e);
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

// 会话启动：进自己的频道并订阅聊天事件（固定驻留，绝不跨频道移动）
async function bootstrap(session) {
  try {
    await selectVirtualServer(session, session.channel);
    // 昵称冲突自愈（上一次连接未干净退出时 513）
    let nick = assistantNameFor(session.channel);
    try {
      await cmd(session, 'clientupdate client_nickname=' + esc(nick));
    } catch (e) {
      nick = nick + Math.floor(Math.random() * 90 + 10);
      await cmd(session, 'clientupdate client_nickname=' + esc(nick));
    }
    session.nick = nick;
    await joinOwnChannel(session);
    session.state = 'listening';
    session.retryAttempt = 0; // 连续失败计数清零（退避重置）
    console.log('[tschat][' + session.channel + '] 已驻留频道并监听点歌指令 (昵称=' + nick + ')');
  } catch (e) {
    fail(session, e);
  }
}

// 把本会话的查询客户端移动到自己绑定的频道（失败重试；已在则返回 id=770 视为成功）。
// 同时清理重连堆积的「点歌助手*」残留查询会话：TS6 有会话/洪水限制，
// 残留会话堆积会导致 shell 反复 closed（每次重连新建一个，越积越多）。
const liveClids = new Map(); // 频道 → 当前存活会话的 clid（各会话注册，互不误踢）

async function joinOwnChannel(session) {
  const cid = await resolveChannelCid(session, session.channel);
  const me = await myInfo(session);
  const myClid = me.clid;
  if (!myClid) throw new Error('无法获取查询端自身 clid');
  liveClids.set(session.channel, String(myClid));
  // 清理残留助手会话：昵称以「点歌助手」开头、且不在存活注册表里的都是历史遗留
  try {
    const list = await cmd(session, 'clientlist');
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    const live = new Set([...liveClids.values()]);
    const base = assistantBase();
    for (const h of items) {
      const nick = String(h.client_nickname || '');
      const clid = h.clid != null ? String(h.clid) : (h.client_id != null ? String(h.client_id) : null);
      if (!clid || clid === String(myClid)) continue;
      if (!nick.startsWith(base) || live.has(clid)) continue;
      cmd(session, 'clientkick clid=' + clid + ' reasonid=5 reasonmsg=' + q('点歌助手会话已重建，清理残留')).catch(() => {});
      console.log('[tschat][' + session.channel + '] 已清理残留查询会话: ' + nick + '(clid=' + clid + ')');
    }
  } catch (e) { /* 清理失败不阻断驻留 */ }
  const cpw = (config.ts6mgrChannelPassword || '').trim();
  let moved = false;
  for (let attempt = 0; attempt < 3 && !moved; attempt++) {
    try {
      let cmdStr = 'clientmove cid=' + cid + ' clid=' + myClid;
      if (cpw) cmdStr += ' cpw=' + cpw;
      await cmd(session, cmdStr);
      console.log('[tschat][' + session.channel + '] 已 clientmove 到频道 cid=' + cid + (cpw ? '（带密码）' : ''));
      moved = true;
    } catch (e) {
      // error id=770 already member of channel：已在目标频道，视为成功
      if (/id=770|already[^a-z]*member/i.test(e.message || String(e))) { moved = true; }
      else {
        console.log('[tschat][' + session.channel + '] clientmove 第 ' + (attempt + 1) + ' 次失败：' + (e.message || e));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (!moved) throw new Error('clientmove 失败');
  // 订阅聊天事件。server 全局事件只挂在第一个频道会话上，避免多助手重复应答。
  const events = ['textchannel', 'textprivate'];
  const firstChannel = tsbridge.configChannels()[0];
  if (session.channel === firstChannel) events.push('textserver');
  for (const ev of events) {
    try { await cmd(session, 'servernotifyregister event=' + ev); }
    catch (e) { console.log('[tschat][' + session.channel + '] 订阅 ' + ev + ' 失败：' + (e.message || e)); }
  }
}

// 取查询客户端自身的 clid（ServerQuery 客户端常不在 clientlist 中露出自己，优先 whoami）
async function myInfo(session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const w = await cmd(session, 'whoami');
      if (w && (w.clid != null || w.cid != null)) {
        return { clid: w.clid != null ? w.clid : null, cid: w.cid != null ? w.cid : null, via: 'whoami' };
      }
    } catch (e) { /* 重试 */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
  }
  return { clid: null, cid: null, via: 'none' };
}

// 选择包含目标频道的虚拟服务器（TeamSpeak 可能有多台；默认 use 1，找不到目标频道再遍历）
async function selectVirtualServer(session, wantName) {
  const defaultSid = (process.env.TS_CHAT_SID || '1');
  const leaf = (wantName || '').split('/').pop().toLowerCase();
  const matchCh = (ch) => {
    const n = (ch.channel_name || '').toLowerCase();
    return n === (wantName || '').toLowerCase() || (leaf && n.endsWith(leaf));
  };
  if (wantName) {
    try {
      const sl = await cmd(session, 'serverlist');
      const servers = (Array.isArray(sl) ? sl : [sl]).filter(Boolean);
      for (const s of servers) {
        const sid = s.virtualserver_id || s.sid || s.id;
        if (!sid) continue;
        try {
          await cmd(session, 'use ' + sid);
          const cl = await cmd(session, 'channellist');
          const chs = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
          if (chs.some(matchCh)) { console.log('[tschat][' + session.channel + '] 已切到含目标频道的虚拟服务器 sid=' + sid); return; }
        } catch (e) { /* 试下一台 */ }
      }
      console.log('[tschat][' + session.channel + '] 未找到含目标频道的虚拟服务器，回退默认 sid=' + defaultSid);
    } catch (e) {
      console.log('[tschat][' + session.channel + '] 遍历虚拟服务器失败，回退默认：' + (e.message || e));
    }
  }
  await cmd(session, 'use ' + defaultSid);
}

function scheduleRetry(session) {
  if (session.retryTimer) return;
  session.retryAttempt = (session.retryAttempt || 0) + 1;
  const wait = Math.min(60000, 8000 * session.retryAttempt); // 指数退避：8s/16s/24s…封顶 60s，防重连风暴堆积查询会话
  console.log('[tschat][' + session.channel + '] ' + Math.round(wait / 1000) + 's 后重试（第 ' + session.retryAttempt + ' 次）');
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    if (!session.started) return;
    connect(session);
  }, wait);
}

function fail(session, err) {
  if (!session.started) { teardownSession(session); return; }
  session.state = 'error';
  console.log('[tschat][' + session.channel + '] 断开：' + (err && err.message ? err.message : err));
  teardownConn(session);
  scheduleRetry(session);
}

function teardownConn(session) {
  while (session.pending.length) {
    const p = session.pending.shift();
    clearTimeout(p.timer);
    try { p.reject(new Error('已停止')); } catch (e) {}
  }
  try { session.conn && session.conn.end(); } catch (e) {}
  session.conn = null;
  session.stream = null;
}

function teardownSession(session) {
  session.started = false;
  session.state = 'stopped';
  if (session.retryTimer) { clearTimeout(session.retryTimer); session.retryTimer = null; }
  liveClids.delete(session.channel);
  teardownConn(session);
}

// ---------- 多会话编排 ----------
// 面板保存配置后调用：按最新频道列表增删会话（密码变化时全部重建）
let appliedPassword = null;

function syncSessions() {
  const channels = tsbridge.configChannels();
  // 停掉不再配置的频道会话
  for (const [ch, s] of [...sessions]) {
    if (!channels.includes(ch)) {
      teardownSession(s);
      sessions.delete(ch);
      console.log('[tschat] 频道「' + ch + '」已从部署列表移除，点歌助手停止');
    }
  }
  // 为新频道创建会话（错峰连接，避免同时大量查询登录触发 TS6 会话/洪水限制）
  let delay = 0;
  for (const ch of channels) {
    if (sessions.has(ch)) continue;
    const s = createSession(ch);
    sessions.set(ch, s);
    setTimeout(() => {
      if (sessions.get(ch) === s && s.started && enabled()) connect(s);
    }, delay);
    delay += 2500;
    s.started = true;
    s.state = 'connecting';
    console.log('[tschat] 将为频道「' + ch + '」启动点歌助手（' + assistantNameFor(ch) + '）');
  }
}

function start() {
  if (!enabled()) {
    console.log('[tschat] 未启用（需设置查询密码；可在点歌页「机器人管理 → 点歌助手」中配置）');
    return;
  }
  appliedPassword = config.tsQueryAdminPassword || '';
  syncSessions();
}

function stop() {
  appliedPassword = null;
  for (const s of sessions.values()) teardownSession(s);
  sessions.clear();
  console.log('[tschat] 已按配置停止');
}

// 面板保存配置后调用：按最新配置启/停/增删会话
function applyConfig() {
  if (!enabled()) {
    if (sessions.size) stop();
    console.log('[tschat] 已按配置停止');
    return;
  }
  const pwd = config.tsQueryAdminPassword || '';
  if (appliedPassword !== null && appliedPassword !== pwd) {
    console.log('[tschat] 查询密码变更，重建全部点歌助手连接');
    stop();
  }
  start();
}

// 运行状态（面板展示）：state 为聚合状态，sessions 为各频道明细
function getState() {
  const list = [...sessions.values()].map((s) => ({ channel: s.channel, state: s.state, nick: s.nick }));
  let state = 'stopped';
  if (!enabled()) state = 'stopped';
  else if (!list.length) state = 'stopped';
  else if (list.some((s) => s.state === 'error')) state = 'error';
  else if (list.some((s) => s.state === 'connecting')) state = 'connecting';
  else if (list.every((s) => s.state === 'listening')) state = 'listening';
  else state = 'connecting';
  return {
    state,
    enabled: enabled(),
    hasPassword: !!config.tsQueryAdminPassword,
    sessions: list,
  };
}

module.exports = {
  start,
  stop,
  applyConfig,
  enabled,
  getState,
  // 测试钩子（非公开接口）
  _internal: { extractSongId, parseParams, esc, unesc, handleRequest, splitRows, isRowSeparator, assistantNameFor },
};
