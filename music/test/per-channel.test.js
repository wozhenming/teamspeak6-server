'use strict';

/**
 * 验证「每频道固定部署一个点歌机器人 + 一个点歌助手」的核心逻辑：
 * 1. 命名规则：单频道用配置昵称原名；多频道加「·频道名」后缀；叶子频道名重复时退回完整路径
 * 2. 点歌助手命名遵循同一规则（多频道自动带后缀）
 * 3. 无人自动暂停按“所有部署频道的真实语音用户总和”判断：任一频道有人就不暂停
 *
 * mock 全局 fetch 模拟 ts6-manager 的 clients 端点（clientlist：clid/cid/client_type）。
 * 运行（music 目录，需先 npm install）：node test/per-channel.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-perchannel';
delete process.env.TS_CHAT_BOT_NICKNAME;
process.env.TS6MGR_URL = 'http://ts6mgr-mock:3001';
process.env.TS6MGR_USER = 'u';
process.env.TS6MGR_PASS = 'p';
process.env.TS_API_KEY = 'test-key';
process.env.TS_HOST = 'teamspeak';
process.env.AUTO_PAUSE_EMPTY = 'true';

const path = require('path');
const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 模拟频道客户端：cid=2 点歌专区 / cid=3 开黑房 ----
// 固定成员：两个频道的机器人 + serveradmin/点歌助手 Query；users 为 {cid: 数量}
let users = {};
let clidSeq = 100;
function clientRow(clid, nick, cid, type) {
  return { clid, client_nickname: nick, cid, client_type: type };
}
function channelClients() {
  const list = [
    clientRow(10, '点歌机器人·点歌专区', 2, 0),
    clientRow(11, '点歌机器人·开黑房', 3, 0),
    clientRow(20, 'serveradmin', 2, 1),
    clientRow(21, '点歌助手', 2, 1),
    clientRow(22, '点歌助手·开黑房', 3, 1),
    clientRow(23, 'serveradmin', 3, 1),
  ];
  for (const [cidStr, n] of Object.entries(users)) {
    for (let i = 0; i < n; i++) list.push(clientRow(clidSeq++, '用户' + cidStr + '_' + i, Number(cidStr), 0));
  }
  return list;
}

function jr(o, s) { return { status: s || 200, json: async () => o, ok: () => (s || 200) < 400 }; }
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/auth/login')) return jr({ data: { token: 'T' } });
  if (u.includes('/api/servers') && !u.includes('/virtual-servers') && !u.includes('/vs/') && !u.includes('/channels')) {
    return jr({ data: [{ id: 1, host: process.env.TS_HOST, name: 'TeamSpeak' }] });
  }
  if (u.includes('/virtual-servers')) return jr({ data: [{ virtualserver_id: 1 }] });
  if (u.includes('/vs/1/clients')) return jr({ data: channelClients() });
  return jr({});
};

async function main() {
  const queue = require(path.resolve(__dirname, '..', 'src/queue.js'));
  const player = require(path.resolve(__dirname, '..', 'src/player.js'));
  const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));
  const tschat = require(path.resolve(__dirname, '..', 'src/tschat.js'));

  queue.load();
  player.load();
  queue.clear();
  const queued = queue.enqueue({ id: 0, name: '测试乐曲', artists: 'T', album: '', cover: '', duration: 200, fee: null }, 'tester');
  player.play(queued.id);

  // ---- 1. 命名规则 ----
  config.saveTsBridge({ ts6mgrChannels: ['点歌专区'] });
  check('单频道：机器人用配置昵称原名', tsbridge._internal.botNameFor('点歌专区') === '点歌机器人', tsbridge._internal.botNameFor('点歌专区'));

  config.saveTsBridge({ ts6mgrChannels: ['默认频道/点歌专区', '默认频道/开黑房'] });
  check('多频道：机器人带「·频道名」后缀（频道1）', tsbridge._internal.botNameFor('默认频道/点歌专区') === '点歌机器人·点歌专区', tsbridge._internal.botNameFor('默认频道/点歌专区'));
  check('多频道：机器人带「·频道名」后缀（频道2）', tsbridge._internal.botNameFor('默认频道/开黑房') === '点歌机器人·开黑房', tsbridge._internal.botNameFor('默认频道/开黑房'));
  check('多频道：点歌助手同规则带后缀', tschat._internal.assistantNameFor('默认频道/开黑房') === '点歌助手·开黑房', tschat._internal.assistantNameFor('默认频道/开黑房'));
  check('单频道：点歌助手用原名', (function () {
    config.saveTsBridge({ ts6mgrChannels: ['点歌专区'] });
    const n = tschat._internal.assistantNameFor('点歌专区');
    config.saveTsBridge({ ts6mgrChannels: ['默认频道/点歌专区', '默认频道/开黑房'] });
    return n === '点歌助手';
  })(), '点歌助手');
  check('叶子频道名重复时退回完整路径命名', (function () {
    const names = tsbridge.assignNames(['A区/大厅', 'B区/大厅'], '点歌机器人');
    return names['A区/大厅'] === '点歌机器人·A区·大厅' && names['B区/大厅'] === '点歌机器人·B区·大厅';
  })(), tsbridge.assignNames(['A区/大厅', 'B区/大厅'], '点歌机器人'));

  // ---- 2. 聚合无人暂停（两个频道：点歌专区 cid=2 / 开黑房 cid=3） ----
  const maybeAutoPauseEmpty = tsbridge._internal.maybeAutoPauseEmpty;

  // 场景1：两个频道都只有机器人+Query（真实用户 0）→ 自动暂停
  users = {};
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('所有频道均无人 → 自动暂停', player.get().playing === false, player.get());

  // 场景2：仅开黑房有 1 个真实用户 → 自动恢复（有人听就不停）
  users = { 3: 1 };
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('任一频道有人 → 自动恢复', player.get().playing === true, player.get());

  // 场景3：点歌专区也来人 → 保持播放
  users = { 2: 2, 3: 1 };
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('多频道有人 → 保持播放', player.get().playing === true, player.get());

  // 场景4：开黑房的人走了，点歌专区还有人 → 保持播放（单频道空不影响全局）
  users = { 2: 2 };
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('部分频道有人 → 保持播放', player.get().playing === true, player.get());

  // 场景5：全部走光 → 再次自动暂停
  users = {};
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('再次全部无人 → 自动暂停', player.get().playing === false, player.get());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
