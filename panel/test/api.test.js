'use strict';

/**
 * 端到端测试：面板 API × 模拟 TS6 WebQuery。
 *
 * 前置：
 *   1. node test/mock-webquery.js          （终端 1，端口 10080）
 *   2. TSSERVER_API_KEY=test-api-key node src/server.js （终端 2）
 *   3. node test/api.test.js                （终端 3）
 *
 * 面板默认账号 admin/admin123（.env）。
 */

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

async function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (r.status !== 200) throw new Error('登录失败');
  return r.headers.get('set-cookie').split(';')[0];
}

(async () => {
  const cookie = await login();
  const H = { cookie };

  // ---------- 仪表盘 ----------
  console.log('\n[仪表盘]');
  let r = await fetch(`${BASE}/api/overview?sid=1`, { headers: H });
  let j = await r.json();
  await check('overview 200', r.status === 200 && j.ok, j);
  await check('connected=true', j.data && j.data.connected === true);
  await check('server 名称', j.data && j.data.server && j.data.server.name === 'Test Server');
  await check('在线用户数=2', j.data && j.data.server && j.data.server.clients_online === 2);
  await check('运行时长=86400', j.data && j.data.server && j.data.server.uptime_seconds === 86400);
  await check('上行速率=16.384 Kbit/s', Math.abs(j.data.bandwidth_sent_rate - 2048 * 8 / 1000) < 0.01, j.data.bandwidth_sent_rate);
  await check('下行速率=8.192 Kbit/s', Math.abs(j.data.bandwidth_received_rate - 1024 * 8 / 1000) < 0.01, j.data.bandwidth_received_rate);
  await check('客户端含频道名', j.data.clients.length === 3 && j.data.clients[0].channel_name === 'Lobby', j.data.clients);
  await check('query 客户端识别', j.data.clients.find(c => c.nickname === 'serveradmin').is_query === true);
  await check('频道数=3', j.data.channels.length === 3);
  await check('频道密码标记', j.data.channels.find(c => c.cid === 2).has_password === true);

  // ---------- 服务器列表 ----------
  console.log('\n[服务器列表]');
  r = await fetch(`${BASE}/api/servers`, { headers: H });
  j = await r.json();
  await check('serverlist 200', r.status === 200 && j.ok);
  await check('包含 Test Server', j.data && j.data.length === 1 && j.data[0].name === 'Test Server', j.data);

  // ---------- 用户管理 ----------
  console.log('\n[用户管理]');
  r = await fetch(`${BASE}/api/servers/1/clients`, { headers: H });
  j = await r.json();
  await check('clientlist 200', r.status === 200 && j.ok);
  await check('用户数=3', j.data && j.data.clients.length === 3);

  r = await fetch(`${BASE}/api/servers/1/clients/1/kick`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'test', from: 'server' }) });
  j = await r.json();
  await check('kick 200', r.status === 200 && j.ok && j.data.kicked);

  r = await fetch(`${BASE}/api/servers/1/clients/2/ban`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'spam', time: 60, ipban: true }) });
  j = await r.json();
  await check('ban(60分钟+IP) 200', r.status === 200 && j.ok && j.data.banned);

  r = await fetch(`${BASE}/api/servers/1/clients/1/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ cid: 3 }) });
  j = await r.json();
  await check('move 200', r.status === 200 && j.ok && j.data.moved);

  r = await fetch(`${BASE}/api/servers/1/clients/1/poke`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'hey' }) });
  j = await r.json();
  await check('poke 200', r.status === 200 && j.ok && j.data.poked);

  r = await fetch(`${BASE}/api/servers/1/clients/1/message`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'hello' }) });
  j = await r.json();
  await check('message 200', r.status === 200 && j.ok && j.data.sent);

  // 参数校验
  r = await fetch(`${BASE}/api/servers/1/clients/1/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  await check('move 缺参 400', r.status === 400);

  // ---------- 频道管理 ----------
  console.log('\n[频道管理]');
  r = await fetch(`${BASE}/api/servers/1/channels`, { headers: H });
  j = await r.json();
  await check('channellist 200', r.status === 200 && j.ok);
  await check('频道数=3', j.data && j.data.channels.length === 3);
  await check('频道成员映射', j.data && j.data.clients.length === 3);

  r = await fetch(`${BASE}/api/servers/1/channels`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Room', parent_cid: 1, max_clients: 10, password: 'pw', topic: 't' }) });
  j = await r.json();
  const newCid = j.data && j.data.cid;
  await check('channelcreate 200 且返回 cid', r.status === 200 && j.ok && Number(newCid) > 0, j.data);

  r = await fetch(`${BASE}/api/servers/1/channels/${newCid}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', max_clients: 20, order: 5 }) });
  j = await r.json();
  await check('channeledit 200', r.status === 200 && j.ok && j.data.edited);

  r = await fetch(`${BASE}/api/servers/1/channels/${newCid}`, { method: 'DELETE', headers: H });
  j = await r.json();
  await check('channeldelete 200', r.status === 200 && j.ok && j.data.deleted);

  r = await fetch(`${BASE}/api/servers/1/channels`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '  ' }) });
  await check('channelcreate 空名 400', r.status === 400);

  // ---------- 未授权 ----------
  console.log('\n[鉴权]');
  r = await fetch(`${BASE}/api/servers/1/clients`);
  await check('无 Cookie 401', r.status === 401);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
