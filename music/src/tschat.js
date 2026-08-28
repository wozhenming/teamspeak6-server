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
const tsbridge = require('./tsbridge');

let conn = null;          // 当前 ssh 连接
let stream = null;        // shell 数据流
let retryTimer = null;
let started = false;
let state = 'stopped';    // stopped | connecting | listening | error
// 串行化所有“移动查询端到频道”的操作，避免并发 join/自检互相读取到过期的 myCid 造成反复移动/报错
let moveChain = Promise.resolve();
function enqueueMove(task) {
  const run = moveChain.then(task, task);
  moveChain = run.then(() => {}, () => {});
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
      songId: songId,
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

function runControl(cmd, invokerName, arg) {
  try {
    const st = player.get();
    if (cmd === 'play') {
      const at = parsePosition(arg);
      if (at) { runPlayAt(at, invokerName); return; }
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
      // 切歌后主动重新向 ts6-manager 下达 play-radio：即便它此前因流空档报
      // “Queue empty” 停掉了点歌机器人，也能立即恢复拉流，避免掉线。
      require('./tsbridge').resumeRadio().catch(() => {});
    } else if (cmd === 'clear') {
      runClear(invokerName);
    } else if (cmd === 'search') {
      runSearch(arg || '', invokerName);
    } else if (cmd === 'queue') {
      runQueue(arg || '', invokerName);
    } else if (cmd === 'switch') {
      runSwitchChannel(arg || '', invokerName);
    }
  } catch (e) {
    reply(invokerName, '✖ 操作失败：' + e.message);
  }
}

// 切换机器人所在频道：!切频道 <频道名或路径>
function runSwitchChannel(arg, invokerName) {
  const name = (arg || '').trim();
  if (!name) {
    reply(invokerName, '用法：!切频道 <频道名或路径>，例如 !切频道 点歌专区');
    return;
  }
  (async () => {
    try {
      const tsbridge = require('./tsbridge');
      const channels = await tsbridge.listChannels();
      if (!channels || !channels.length) return reply(invokerName, '✖ 暂无可切换的频道列表');
      const lower = name.toLowerCase();
      const hit = channels.find((c) => (c.path || c.name || '').toLowerCase() === lower)
        || channels.find((c) => (c.path || c.name || '').toLowerCase().includes(lower));
      if (!hit) {
        const names = channels.slice(0, 10).map((c) => c.path || c.name).join('、');
        return reply(invokerName, '✖ 未找到频道「' + name + '」，可选：' + names);
      }
      const path = hit.path || hit.name;
      await tsbridge.switchChannel(path);
      // 机器人切频道后，让聊天点歌查询端也跟随到新频道，否则收不到该频道的指令
      try { await new Promise((r) => setTimeout(r, 1500)); await joinBotChannel(); } catch (e) { console.log('[tschat] 切频道后重新加入失败: ' + (e && e.message)); }
      reply(invokerName, '✅ 已切换到频道：' + path + '（点歌助手已跟随）');
    } catch (e) {
      reply(invokerName, '✖ 切换失败：' + e.message);
    }
  })();
}

// 清空点歌队列（并停止当前播放，emitChange(null) 会触发 player 停止）
function runClear(invokerName) {
  try {
    const n = queue.all().length;
    queue.clear();
    reply(invokerName, n ? ('🧹 已清空点歌队列（' + n + ' 首）') : '队列本来就是空的');
  } catch (e) {
    reply(invokerName, '✖ 清空失败：' + e.message);
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
function runPlayAt(n, invokerName) {
  const all = queue.all();
  if (!all.length) return reply(invokerName, '队列为空，用 !点歌 <ID> 添加歌曲');
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    return reply(invokerName, '✖ 队列只有 ' + all.length + ' 首，无法播放第 ' + n + ' 首');
  }
  const item = all[n - 1];
  const res = player.play(item.id);
  const played = res.current || item;
  require('./tsbridge').resumeRadio().catch(() => {});
  reply(invokerName, '▶ 已跳播第 ' + n + ' 首：' + (played.title || played.name) + (played.artists ? ' - ' + played.artists : ''));
}

// 查看播放队列（分页，每页最多 10 首）：!队列 [页码]
function runQueue(arg, invokerName) {
  const all = queue.all();
  const total = all.length;
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = player.get().current;
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
    reply(invokerName, '队列为空，用 !点歌 <ID> 添加歌曲');
    return;
  }
  const lines = slice.map((s, i) => {
    const idx = start + i + 1;
    const mark = (s.id === curId) ? '▶ ' : '  ';
    const artists = s.artists ? ' - ' + s.artists : '';
    const sid = s.songId || s.id;
    return mark + idx + '. ' + s.title + artists + '  (ID:' + sid + ')';
  });
  let msg = '📜 播放队列（共 ' + total + ' 首，第 ' + page + '/' + pages + ' 页）\n' + lines.join('\n');
  if (pages > 1) {
    msg += '\n!队列 ' + (page < pages ? (page + 1) : 1) + ' 查看' + (page < pages ? '下一页' : '首页');
  }
  reply(invokerName, msg);
}

// 按关键词搜索歌曲，返回前 5 首：歌名 - 歌手（ID）
function runSearch(keyword, invokerName) {
  keyword = (keyword || '').trim();
  if (!keyword) {
    reply(invokerName, '用法：!搜索 <歌曲名/关键字>，例如 !搜索 周杰伦');
    return;
  }
  // 异步执行，避免阻塞命令分发
  (async () => {
    try {
      const result = await enhanced.search(keyword, 'song', 5, 0);
      const songs = (result && result.songs) || [];
      if (!songs.length) {
        reply(invokerName, '未找到与「' + keyword + '」相关的歌曲');
        return;
      }
      const lines = songs.slice(0, 5).map((s, i) => {
        const artists = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join('/') : (s.artist || '');
        return (i + 1) + '. ' + s.name + (artists ? ' - ' + artists : '') + '  (ID:' + s.id + ')';
      });
      reply(invokerName, '🔍 搜索「' + keyword + '」前 ' + lines.length + ' 首：\n' + lines.join('\n') + '\n用 !点歌 <ID> 点播');
    } catch (e) {
      reply(invokerName, '✖ 搜索失败：' + e.message);
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
  queue: 'queue', 队列: 'queue', 列表: 'queue', q: 'queue',   playlist: 'queue', 待播: 'queue',
  switch: 'switch', 切频道: 'switch', 切换频道: 'switch', switchchannel: 'switch',
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

const CMD_NAME = { play: 'play', pause: 'pause', next: 'next', clear: 'clear', search: 'search', queue: 'queue', switch: 'switch', playat: 'playat' };
function handleRequest(rawText, invokerName) {
  const text = (rawText || '').trim();
  if (!text) return;
  const ctl = text.match(/^!\s*(\S+)\s*(.*)$/);
  if (ctl) {
    const w = ctl[1].toLowerCase();
    const rest = ctl[2].trim();
    if (CTRL_MAP[w]) {
      const name = CMD_NAME[CTRL_MAP[w]];
      if (!cmdEnabled(name)) return reply(invokerName, '该指令已被管理员禁用');
      runControl(CTRL_MAP[w], invokerName, rest);
      return;
    }
    if (LOOP_WORDS[w]) {
      if (!cmdEnabled('loop')) return reply(invokerName, '循环指令已被管理员禁用');
      runLoop(rest, invokerName);
      return;
    }
    if (STATUS_WORDS[w]) {
      if (!cmdEnabled('status')) return reply(invokerName, '状态指令已被管理员禁用');
      runStatus(invokerName);
      return;
    }
    if (['点歌', '点', 'dian', 'song', 'req', '点播'].includes(w)) {
      if (!cmdEnabled('dian')) return reply(invokerName, '点歌指令已被管理员禁用');
      addSong(rest, invokerName);
      return;
    }
    // 跳播队列第 N 首：!播放第3首 / !播3 / !跳3 / !第3首 / !play3
    const playAtMatch = text.match(/^!\s*(?:播|播放|跳|选|放|第|play|jump|goto|select|p)\s*第?\s*(\d+)\s*(?:首|位|个|song)?\s*$/i);
    if (playAtMatch) {
      if (!cmdEnabled('playat')) return reply(invokerName, '该指令已被管理员禁用');
      runPlayAt(parseInt(playAtMatch[1], 10), invokerName);
      return;
    }
    reply(invokerName, '可用指令：!点歌 <歌曲ID或链接> · !播放(第N首) · !暂停 · !切歌 · !清队列 · !搜索 <关键词> · !队列 [页码] · !切频道 <频道名> · !循环 · !状态');
    return;
  }
  // 无前缀：整条就是歌曲 ID 或链接才视为点歌（避免把闲聊话题误当成点歌）
  if (/^https?:\/\//i.test(text) || /^\d{4,12}$/.test(text)) {
    if (!cmdEnabled('dian')) return;
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
    if (uid !== 'serveradmin') handleRequest(p.msg || '', p.invokername || '?');
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
  console.log('[tschat][diag] 连接 TeamSpeak SSH Query：host=' + host + ' port=' + port);
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
let reconcileTimer = null; // 定时自检并跟随机器人频道，防止二者漂移
let myNick = '';           // 本查询端昵称，用于从 clientlist 中定位自己
// 机器人昵称（可配置，默认“点歌机器人”）：部分服务器昵称带前后缀，可用 TS_CHAT_BOT_NICKNAME 覆盖
const BOT_NAME = (process.env.TS_CHAT_BOT_NICKNAME || '点歌机器人').trim();

// 兼容 TS3/TS6 字段命名差异（clid/client_id、cid/channel_id）
function cidOf(x) { return x.cid != null ? x.cid : x.channel_id; }
function clidOf(x) { return x.clid != null ? x.clid : x.client_id; }
function findBot(items) {
  // 优先用 ts6-manager 记录的音乐机器人 clid 精确定位（最稳），昵称只作兜底
  const botClid = tsbridge.getBotClid();
  if (botClid != null) {
    const byClid = items.find((x) => String(cidOf(x)) === String(botClid));
    if (byClid) return byClid;
  }
  return items.find((x) => x.client_nickname === BOT_NAME)
    || items.find((x) => x.client_nickname && x.client_nickname.includes(BOT_NAME));
}
function findMe(items) {
  if (myNick) {
    const m = items.find((x) => x.client_nickname === myNick)
      || items.find((x) => x.client_nickname && String(x.client_nickname).startsWith(myNick));
    if (m) return m;
  }
  return items.find((x) => String(x.client_type) === '1'); // 退化：取任一 ServerQuery 客户端
}

// 取查询客户端自身的位置。ServerQuery 客户端常不在 clientlist 中露出自己，
// 故优先用 whoami（返回 clid/cid）拿到自身的 clid，clientmove 缺它无法移动。
async function myInfo() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const w = await cmd('whoami');
      if (w && (w.clid != null || w.cid != null)) {
        return { clid: w.clid != null ? w.clid : null, cid: w.cid != null ? w.cid : null, via: 'whoami' };
      }
    } catch (e) { /* 重试 */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
  }
  // 兜底：从 clientlist 里找自己（ServerQuery 客户端 often 不在此列出，故可能为空）
  try {
    const list = await cmd('clientlist -uid');
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    const m = findMe(items);
    return { clid: m ? clidOf(m) : null, cid: m ? cidOf(m) : null, via: 'list' };
  } catch (e) {
    return { clid: null, cid: null, via: 'none' };
  }
}

// 把聊天点歌查询客户端移动到“点歌机器人”所在频道并订阅聊天事件。
// 抽成独立函数，便于机器人切换频道后（switchChannel）重新把查询端挪过去，
// 否则查询端停留在旧频道，收不到新频道的 !点歌 等指令。
async function joinBotChannelBody() {
  if (!conn) return; // 连接已断开时不操作
  try {
    // 先刷新机器人 clid 缓存（优先用 clid 精准定位），失败不阻断
    try { await tsbridge.refreshBotClid(); } catch (e) { /* 忽略 */ }
    let botCid = null;
    let botName = '';
    let botSeen = false;
    // 优先：直接按“点歌机器人”在 TS 里的 client id / UID / 昵称，跨虚拟服务器定位它所在的频道，
    // 不再依赖频道名与配置——点歌助手只要跟随机器人即可（用户要求按 UID 判断）。
    const located = await locateMusicBot();
    if (located) {
      botCid = located.cid; botName = located.nick + '(按clientid定位)'; botSeen = true;
      console.log('[tschat] 已按 client id 定位点歌机器人：clid=' + located.clid + ' 频道cid=' + located.cid + ' 虚拟服务器sid=' + located.sid);
    } else {
      // 兜底：按配置频道名（跨虚拟服务器扫描）
      await selectVirtualServer((config.ts6mgrChannel || '').trim());
    }
    const list = await cmd('clientlist -uid');
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    const channelList = await cmd('channellist');
    const chItems = Array.isArray(channelList) ? channelList : [channelList];
    const me0 = await myInfo();
    const myClid0 = me0.clid;
    const myCid0 = me0.cid;
    if (!botCid) {
      // 关键：ServerQuery 的频道 id 与 ts6-manager 的频道 id 是两套不同的编号空间。
      // 查询端 clientmove 必须用「ServerQuery 自己的 channellist」按频道名解析出的 cid。
      const r = resolveTargetCid(items, chItems, myCid0);
      botCid = r.cid; botName = r.name; botSeen = r.botSeen;
      if (!botCid) {
        // 退回：用 ts6-manager 解析（注意其 id 空间可能不同，仅作兜底）
        try {
          const channels = await tsbridge.listChannels();
          const want = (config.ts6mgrChannel || '').trim().toLowerCase();
          const leaf = want.split('/').pop();
          const hit = channels.find((c) => (c.path || c.name || '').toLowerCase() === want)
            || channels.find((c) => (c.path || c.name || '').toLowerCase().endsWith(leaf));
          if (hit) { botCid = hit.id; botName = hit.path || hit.name; botSeen = true; }
        } catch (e) { /* 忽略 */ }
      }
    }
    // 移动前再读一次自身位置（消除并发调用间读到的过期 myCid）
    const me = await myInfo();
    const myClid = me.clid != null ? me.clid : myClid0;
    const myCid = me.cid != null ? me.cid : myCid0;
    console.log('[tschat] join: myNick=' + myNick + ' myClid=' + myClid + ' myCid=' + myCid
      + ' botCid=' + botCid + ' botSeen=' + botSeen + ' 目标频道=' + (botName || '(未知)')
      + ' clients=' + items.map((x) => (x.client_nickname || '?') + '@' + cidOf(x)).join(',')
      + ' | channellist=' + JSON.stringify(chItems.map((c) => ({ cid: cidOf(c), name: c.channel_name }))));
    if (botCid && myClid && String(botCid) !== String(myCid)) {
      const cpw = (config.ts6mgrChannelPassword || '').trim();
      let moved = false;
      for (let attempt = 0; attempt < 3 && !moved; attempt++) {
        try {
          let cmdStr = 'clientmove cid=' + botCid + ' clid=' + myClid;
          if (cpw) cmdStr += ' cpw=' + cpw;
          await cmd(cmdStr);
          console.log('[tschat] 已 clientmove 到频道 ' + botCid + (cpw ? '（带密码）' : ''));
          moved = true;
        } catch (e) {
          // error id=770 already member of channel：说明已经在目标频道，视为成功
          // TS 报错里空格被转义成 \s，故用 [^a-z]* 兼容（或直接匹配 id=770）
          if (/id=770|already[^a-z]*member/i.test(e.message || String(e))) { moved = true; console.log('[tschat] 已在频道 ' + botCid + '，无需移动'); }
          else {
            console.log('[tschat] clientmove 第 ' + (attempt + 1) + ' 次失败：' + (e.message || e));
            if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else if (botCid && String(botCid) === String(myCid)) {
      console.log('[tschat] 已在目标频道 ' + botCid + '，无需移动');
    }
    // 订阅频道聊天 + 私聊 + 服务器聊天，尽量覆盖用户的不同发送方式
    for (const ev of ['textchannel', 'textprivate', 'textserver']) {
      try { await cmd('servernotifyregister event=' + ev); }
      catch (e) { console.log('[tschat] 订阅 ' + ev + ' 失败：' + (e.message || e)); }
    }
    if (!botSeen) console.log('[tschat] 提示：未找到点歌机器人(' + BOT_NAME + ')，聊天点歌仅在「点歌助手」所在频道/私聊里有效');
    console.log('[tschat] 已就位频道 ' + (botCid || myCid || '?') + ' 并订阅聊天事件');
  } catch (e) {
    console.log('[tschat] 重新加入频道失败：' + (e && e.message ? e.message : e));
  }
}
// 串行化包装
function joinBotChannel() { return enqueueMove(() => joinBotChannelBody()); }

// 选择包含目标频道的虚拟服务器。TeamSpeak 可能有多台虚拟服务器，
// 音乐机器人（点歌机器人）与点歌助手必须落在同一台虚拟服务器才能同频道。
// 默认 use 1；若当前虚拟服务器里找不到目标频道，则遍历虚拟服务器找到含该频道的那台并 use 过去。
async function selectVirtualServer(wantName) {
  const defaultSid = (process.env.TS_CHAT_SID || config.ts6mgrSid || '1');
  const leaf = (wantName || '').split('/').pop().toLowerCase();
  const matchCh = (ch) => {
    const n = (ch.channel_name || '').toLowerCase();
    return n === (wantName || '').toLowerCase() || (leaf && n.endsWith(leaf));
  };
  if (wantName) {
    try {
      const sl = await cmd('serverlist');
      const servers = (Array.isArray(sl) ? sl : [sl]).filter(Boolean);
      for (const s of servers) {
        const sid = s.virtualserver_id || s.sid || s.id;
        if (!sid) continue;
        try {
          await cmd('use ' + sid);
          const cl = await cmd('channellist');
          const chs = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
          if (chs.some(matchCh)) { console.log('[tschat] 已切到含目标频道的虚拟服务器 sid=' + sid); return; }
        } catch (e) { /* 试下一台 */ }
      }
      console.log('[tschat] 未找到含目标频道的虚拟服务器，回退默认 sid=' + defaultSid);
    } catch (e) {
      console.log('[tschat] 遍历虚拟服务器失败，回退默认：' + (e.message || e));
    }
  }
  await cmd('use ' + defaultSid);
}

// 跨虚拟服务器定位“点歌机器人”：优先用 ts6-manager 已知的 TS client id（最精准），
// 其次按昵称包含 BOT_NAME 匹配。返回 { cid, clid, sid, uid, nick }；找不到返回 null。
// 定位过程中会把查询端切到机器人所在的虚拟服务器（use 过去）。
async function locateMusicBot() {
  const targetClid = tsbridge.getBotClid();
  try {
    const sl = await cmd('serverlist');
    const servers = (Array.isArray(sl) ? sl : [sl]).filter(Boolean);
    console.log('[tschat][diag] serverlist=' + JSON.stringify(servers) + ' targetClid=' + targetClid);
    for (const s of servers) {
      const sid = s.virtualserver_id || s.sid || s.id;
      if (!sid) continue;
      try {
        await cmd('use ' + sid);
        const list = await cmd('clientlist -uid');
        const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
        const cl = await cmd('channellist');
        const chs = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
        console.log('[tschat][diag] vs sid=' + sid + ' clients=' + JSON.stringify(items.map((x) => ({ clid: clidOf(x), nick: x.client_nickname, cid: cidOf(x) })))
          + ' channels=' + JSON.stringify(chs.map((c) => ({ cid: cidOf(c), name: c.channel_name }))));
        let bot = (targetClid != null) ? items.find((x) => String(clidOf(x)) === String(targetClid)) : null;
        if (!bot) bot = items.find((x) => (x.client_nickname || '').includes(BOT_NAME));
        if (bot) {
          return { cid: cidOf(bot), clid: clidOf(bot), sid, uid: bot.client_unique_identifier, nick: bot.client_nickname };
        }
      } catch (e) { /* 试下一台虚拟服务器 */ }
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// 解析目标频道 cid：1) 已配置频道名/路径；2) 机器人昵称；3) 兜底第一个语音用户频道
function resolveTargetCid(items, chItems, myCid) {
  const wantName = (config.ts6mgrChannel || '').trim();
  const bot = findBot(items);
  const botSeen = !!bot;
  if (wantName) {
    const leaf = wantName.split('/').pop().toLowerCase();
    const lower = wantName.toLowerCase();
    const ch = chItems.find((x) => (x.channel_name || '').toLowerCase() === lower)
      || chItems.find((x) => (x.channel_name || '').toLowerCase().endsWith(leaf));
    if (ch) return { cid: cidOf(ch), botSeen, name: wantName };
  }
  if (bot) return { cid: cidOf(bot), botSeen: true, name: (bot.channel_name || bot.client_nickname || BOT_NAME) };
  const voice = items.find((x) => String(x.client_type) !== '1');
  if (voice && String(cidOf(voice)) !== String(myCid) && cidOf(voice) != null) return { cid: cidOf(voice), botSeen, name: voice.channel_name || '' };
  return { cid: null, botSeen, name: '' };
}

// 轻量自检：若查询端已不在机器人所在频道，则自动跟过去。
// 解决“切换频道后过一阵二者不在同一频道”的问题（查询端被服务器移动/重连错位）。
async function ensureInBotChannelBody() {
  if (state !== 'listening' || !conn) return;
  try {
    try { await tsbridge.refreshBotClid(); } catch (e) { /* 忽略 */ }
    // 优先按 client id / UID 跨虚拟服务器定位点歌机器人
    let botCid = null;
    const located = await locateMusicBot();
    if (located) botCid = located.cid;
    if (!botCid) {
      const list = await cmd('clientlist -uid');
      const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
      const bot = findBot(items);
      if (bot) botCid = cidOf(bot);
    }
    const me0 = await myInfo();
    const myClid0 = me0.clid;
    const myCid0 = me0.cid;
    // 移动前再读一次自身位置（消除并发调用间读到的过期 myCid）
    const me = await myInfo();
    const myClid = me.clid != null ? me.clid : myClid0;
    const myCid = me.cid != null ? me.cid : myCid0;
    if (botCid && String(botCid) === String(myCid)) {
      // 已在目标频道，无需移动
    } else if (botCid && myClid && String(botCid) !== String(myCid)) {
      try {
        let cmdStr = 'clientmove cid=' + botCid + ' clid=' + myClid;
        const cpw = (config.ts6mgrChannelPassword || '').trim();
        if (cpw) cmdStr += ' cpw=' + cpw;
        await cmd(cmdStr);
        console.log('[tschat] 检测到与机器人频道不一致，已重新移动到 ' + botCid);
      } catch (e) {
        if (/id=770|already[^a-z]*member/i.test(e.message || String(e))) console.log('[tschat] 已在频道 ' + botCid + '（自动跟随）');
        else console.log('[tschat] 自动跟随移动失败：' + (e.message || e));
      }
    }
    // 重新订阅聊天事件，防止订阅被服务器静默取消导致收不到 !点歌
    for (const ev of ['textchannel', 'textprivate', 'textserver']) {
      try { await cmd('servernotifyregister event=' + ev); }
      catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略瞬时错误 */ }
}
function ensureInBotChannel() { return enqueueMove(() => ensureInBotChannelBody()); }
async function bootstrap() {
  try {
    await selectVirtualServer((config.ts6mgrChannel || '').trim());
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
    myNick = nick;
    await joinBotChannel();
    bootstrapped = true;
    state = 'listening';
    // 启动频道一致性自检：每 30s 检测一次，若与机器人不在同一频道则自动跟过去
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = setInterval(() => { ensureInBotChannel(); }, 30000);
    console.log('[tschat] 已加入频道并监听 !点歌 命令 (昵称=' + nick + ')');
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
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
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
  // 机器人切换频道后调用：把聊天点歌查询端也挪到新频道（否则收不到指令）
  rejoinChannel: joinBotChannel,
  getState: () => ({ state, enabled: enabled(), hasPassword: !!config.tsQueryAdminPassword }),
  // 测试钩子（非公开接口）
  _internal: { extractSongId, parseParams, esc, unesc, handleRequest },
};
