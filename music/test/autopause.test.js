'use strict';

/**
 * 验证「频道无人时自动暂停、有人进入自动恢复」逻辑（真实 maybeAutoPauseEmpty + 真实每频道播放器）。
 *
 * mock 全局 fetch 模拟 ts6-manager 的 clients 端点（clientlist：clid/cid/client_type），
 * 驱动真实函数体并校验对应频道播放器的暂停/恢复。
 *
 * 关键回归：
 * 1. 点歌助手/serveradmin Query 常驻频道不算“人”（client_type=1 排除）；
 * 2. 每个部署频道独立暂停/恢复，互不影响。
 *
 * 运行（music 目录，需先安装依赖）：node test/autopause.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-autopause';
process.env.AUTO_PAUSE_EMPTY = 'true';
process.env.TS6MGR_URL = 'http://ts6mgr-mock:3001';
process.env.TS6MGR_USER = 'u';
process.env.TS6MGR_PASS = 'p';
process.env.TS6MGR_CHANNEL = '点歌专区';
process.env.TS_API_KEY = 'test-key';
process.env.TS_HOST = 'teamspeak';

const path = require('path');
const queueMod = require(path.resolve(__dirname, '..', 'src/queue.js'));
const playerMod = require(path.resolve(__dirname, '..', 'src/player.js'));
const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));

const CH = '点歌专区';
const queue = queueMod.forChannel(CH);
const player = playerMod.forChannel(CH);

// ---- 可调节的“频道内客户端”，模拟 ts6-manager WebQuery clientlist ----
// 固定成员：clid=10 点歌机器人(语音) / clid=11 serveradmin(Query) / clid=12 点歌助手(Query)
// fakeUsers = 频道内真实语音用户数量（clid 从 100 起）
let fakeUsers = 0;
let clientsFail = false; // 模拟 clients 端点不可用 → 无法判断，保持现状
let countCalls = 0;

function clientRow(clid, nick, type) {
  return { clid, client_nickname: nick, cid: 2, client_type: type };
}
function channelClients() {
  const list = [
    clientRow(10, '点歌机器人', 0),
    clientRow(11, 'serveradmin', 1),
    clientRow(12, '点歌助手', 1),
  ];
  for (let i = 0; i < fakeUsers; i++) list.push(clientRow(100 + i, '用户' + i, 0));
  return list;
}

function jsonResponse(obj, status) {
  return { status: status || 200, json: async () => obj, ok: () => (status || 200) < 400 };
}

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/auth/login')) return jsonResponse({ data: { token: 'mock-token-abc' } });
  if (u.includes('/api/servers') && !u.includes('/virtual-servers') && !u.includes('/vs/') && !u.includes('/channels')) {
    return jsonResponse({ data: [{ id: 1, host: process.env.TS_HOST, name: 'TeamSpeak' }] });
  }
  if (u.includes('/virtual-servers')) return jsonResponse({ data: [{ virtualserver_id: 1 }] });
  if (u.includes('/vs/1/clients')) {
    countCalls++;
    if (clientsFail) return jsonResponse({ error: { message: 'unavailable' } }, 500);
    return jsonResponse({ data: channelClients() });
  }
  return jsonResponse({});
};

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  queue.load();
  player.load();
  queue.clear();
  const queued = queue.enqueue({ id: 0, name: '测试乐曲', artists: 'T', album: '', cover: '', duration: 200, fee: null }, 'tester');
  player.play(queued.id);
  check('初始处于播放中', player.get().playing === true, player.get());

  const maybeAutoPauseEmpty = tsbridge._internal.maybeAutoPauseEmpty;

  // 场景1：频道内只有机器人 + serveradmin/点歌助手 Query（真实用户 0）→ 自动暂停
  fakeUsers = 0;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('仅机器人+Query 在频道 → 自动暂停', player.get().playing === false, player.get());

  // 场景2：保持无人，再次调用 → 维持暂停
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('仍无人且已暂停 → 保持暂停', player.get().playing === false, player.get());

  // 场景3：真实用户进入（Query 仍在场）→ 自动恢复
  fakeUsers = 1;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('真实用户进入 → 自动恢复', player.get().playing === true, player.get());

  // 场景4：有人在且正在播放 → 维持
  fakeUsers = 3;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('有人在且播放中 → 保持播放', player.get().playing === true, player.get());

  // 场景5：clients 端点不可用 → 无法判断，保持现状（不误暂停也不误恢复）
  clientsFail = true;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('clients 端点不可用 → 保持现状', player.get().playing === true, player.get());
  clientsFail = false;

  // 场景6：autoPauseEmpty 关闭时，即便无人也不暂停
  const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
  config.autoPauseEmpty = false;
  fakeUsers = 0;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('autoPauseEmpty=false → 不自动暂停恢复', player.get().playing === true, player.get());
  config.autoPauseEmpty = true;

  check('确实发生了频道计数读取（>0）', countCalls > 0, countCalls);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
