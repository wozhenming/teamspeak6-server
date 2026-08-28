'use strict';

/**
 * 回归：容器重启（重新 require 模块）后看门狗必须保持工作。
 *
 * desiredLinked（保持连接的意图）只在 link() 成功时置 true，此前模块加载虽然
 * 会因持久化的 botId 启动看门狗，但 tick 里 `if (!desiredLinked) return;` 直接退出，
 * 导致每次重启/部署后「频道无人自动暂停」与「断线自动重连」全部失效
 * （机器人活在 ts6-manager 进程里不受影响，现象是"一切正常就是不暂停"）。
 *
 * 运行（music 目录）：node test/watchdog-restart.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-watchdog';
process.env.TS6MGR_URL = 'http://ts6mgr-mock:3001';
process.env.TS6MGR_USER = 'u';
process.env.TS6MGR_PASS = 'p';
process.env.TS6MGR_BOT_ID = '7'; // 模拟此前已成功连接、botId 已持久化
process.env.TS_API_KEY = 'test-key';

const path = require('path');
const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };

check('持久化 botId 下模块加载即视为"应保持连接"', tsbridge._internal.isLinkedDesired() === true, tsbridge._internal.isLinkedDesired());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
