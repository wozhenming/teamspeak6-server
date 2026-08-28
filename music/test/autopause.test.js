'use strict';

/**
 * 验证「频道无人时自动暂停、有人进入自动恢复」逻辑（真实 maybeAutoPauseEmpty + 真实 player 状态机）。
 *
 * 由于该逻辑依赖 ts6-manager 的频道计数接口，而当前环境无法拉取 ts6-manager 镜像做全栈端到端，
 * 这里通过 mock 全局 fetch（模拟 ts6-manager WebQuery 返回的频道客户端数）来驱动真实函数体，
 * 并配合真实的 player 暂停/恢复状态机校验行为。
 *
 * 运行（music 目录，需先安装依赖）：
 *   npm install
 *   node test/autopause.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data';
process.env.AUTO_PAUSE_EMPTY = 'true';
process.env.TS6MGR_URL = 'http://ts6mgr-mock:3001';
process.env.TS6MGR_USER = 'u';
process.env.TS6MGR_PASS = 'p';
process.env.TS6MGR_CHANNEL = '点歌专区';
process.env.TS_API_KEY = 'test-key';
process.env.TS_HOST = 'teamspeak';

const path = require('path');
const queue = require(path.resolve(__dirname, '..', 'src/queue.js'));
const player = require(path.resolve(__dirname, '..', 'src/player.js'));
const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));

// ---- 可调节的“频道客户端数”，模拟 ts6-manager 返回 ----
let fakeCount = 0;
// 记录调用次数，校验确实走了网络计数
let countCalls = 0;

// 模拟 ts6-manager 的 WebQuery 响应
function jsonResponse(obj, status) {
  return {
    status: status || 200,
    json: async () => obj,
    ok: () => (status || 200) < 400,
  };
}

global.fetch = async (url, opts) => {
  const method = (opts && opts.method) || 'GET';
  const u = String(url);
  // 登录
  if (u.includes('/api/auth/login')) {
    return jsonResponse({ data: { token: 'mock-token-abc' } });
  }
  // 服务器连接列表
  if (u.includes('/api/servers') && !u.includes('/virtual-servers') && !u.includes('/vs/') && !u.includes('/channels')) {
    return jsonResponse({ data: [{ id: 1, host: process.env.TS_HOST, name: 'TeamSpeak' }] });
  }
  // 虚拟服务器列表
  if (u.includes('/virtual-servers')) {
    return jsonResponse({ data: [{ virtualserver_id: 1 }] });
  }
  // 频道列表（关键：返回被观察频道的在线客户端数）
  if (u.includes('/vs/1/channels') || u.includes('/channels')) {
    countCalls++;
    return jsonResponse({
      data: [
        { cid: 1, pid: 0, channel_name: 'Default Channel', total_clients: 0 },
        { cid: 2, pid: 0, channel_name: '点歌专区', total_clients: fakeCount, clients: fakeCount },
      ],
    });
  }
  // 其它一律返回空对象，避免未 mock 端点报错
  return jsonResponse({});
};

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  queue.load();
  player.load();
  queue.clear(); // 清掉上次持久化残留，保证 seq 从 1 开始
  // 入队一首并开始播放；enqueue 会用自增 seq 作为内部 id（见 queue.js），play 需用该 id
  const queued = queue.enqueue({ id: 0, name: '测试乐曲', artists: 'T', album: '', cover: '', duration: 200, fee: null }, 'tester');
  player.play(queued.id);
  check('初始处于播放中', player.get().playing === true, player.get());

  const maybeAutoPauseEmpty = tsbridge._internal.maybeAutoPauseEmpty;

  // 场景1：频道内仅机器人自身（count=1，total_client 含机器人）→ 自动暂停
  fakeCount = 1;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('频道无人(1) → 自动暂停', player.get().playing === false, player.get());

  // 场景2：保持无人，再次调用 → 维持暂停（不重复操作、不误报）
  fakeCount = 1;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('仍无人且已暂停 → 保持暂停', player.get().playing === false, player.get());

  // 场景3：有人进入（count=2）→ 自动恢复
  fakeCount = 2;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('有人进入(2) → 自动恢复', player.get().playing === true, player.get());

  // 场景4：有人在且正在播放 → 维持
  fakeCount = 5;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('有人在且播放中 → 保持播放', player.get().playing === true, player.get());

  // 场景5：autoPauseEmpty 关闭时，即便无人也不暂停
  const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
  config.autoPauseEmpty = false;
  player.pause(); // 先暂停，再确认关闭时不因无人做任何操作
  fakeCount = 1;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('autoPauseEmpty=false → 不自动暂停恢复', player.get().playing === false, player.get());
  config.autoPauseEmpty = true;

  check('确实发生了频道计数读取（>0）', countCalls > 0, countCalls);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });