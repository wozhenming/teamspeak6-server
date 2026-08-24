'use strict';

/**
 * 部署管理端到端测试（配合 test/mock-webquery.js）。
 *
 * 前置：
 *   1. node test/mock-webquery.js
 *   2. $env:DEPLOY_DIR='<临时目录>' 后启动面板（避免写入真实 deploy/）
 *   3. node test/deploy.test.js
 *
 * 注意：本测试会通过 POST /api/deploy/apikey 修改 panel/.env（结束后恢复为空）。
 */

const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

async function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
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

  // ---------- 综合状态 ----------
  console.log('\n[状态]');
  let r = await fetch(`${BASE}/api/deploy/status`, { headers: H });
  let j = await r.json();
  await check('status 200', r.status === 200 && j.ok);
  await check('docker 检测字段', j.data && typeof j.data.docker.installed === 'boolean' && j.data.docker.compose !== undefined, j.data && j.data.docker);
  await check('composeFile 路径', j.data && j.data.composeFile.path.endsWith('docker-compose.yml'));
  await check('distro 识别', j.data && j.data.distro && typeof j.data.distro.id === 'string');
  await check('未配置 Key 时 WebQuery 不可达', j.data && j.data.webquery && j.data.webquery.keyConfigured === false && j.data.webquery.reachable === false, j.data && j.data.webquery);
  await check('容器状态字段', j.data && j.data.container && typeof j.data.container.exists === 'boolean');

  // 幂等性：清理上次运行残留的 compose 文件
  if (j.data && j.data.composeFile.exists) {
    fs.rmSync(j.data.composeFile.path, { force: true });
    console.log('  (已清理上次残留的 compose 文件)');
  }

  // ---------- 预览 ----------
  console.log('\n[预览]');
  r = await fetch(`${BASE}/api/deploy/preview?name=ts-e2e&voice=9987&file=30033&webquery=10080&ssh=10022`, { headers: H });
  j = await r.json();
  const c = j.data && j.data.content;
  await check('preview 200', r.status === 200 && j.ok && typeof c === 'string');
  await check('容器名', c.includes('container_name: ts-e2e'));
  await check('语音端口', c.includes('"9987:9987/udp"'));
  await check('SSH Query 端口', c.includes('"10022:10022/tcp"'));
  await check('许可证环境变量', c.includes('TSSERVER_LICENSE_ACCEPTED'));

  // ---------- 生成 compose ----------
  console.log('\n[生成 compose]');
  r = await fetch(`${BASE}/api/deploy/compose`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ts-e2e', voice: 9987, file: 30033, webquery: 10080, ssh: 10022, password: 'q-admin' }),
  });
  j = await r.json();
  await check('compose 生成 200', r.status === 200 && j.ok && j.data.path.endsWith('docker-compose.yml'), j.data);
  const filePath = j.data && j.data.path;
  await check('文件已写入', filePath && fs.existsSync(filePath));
  if (filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    await check('文件含管理员密码', content.includes('TSSERVER_QUERY_ADMIN_PASSWORD=q-admin'));
  }

  r = await fetch(`${BASE}/api/deploy/compose`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ts-e2e' }),
  });
  await check('重复生成 409', r.status === 409);

  r = await fetch(`${BASE}/api/deploy/compose`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ts-e2e', force: true }),
  });
  await check('force 覆盖 200', r.status === 200);

  // ---------- 任务流 ----------
  console.log('\n[任务流]');
  const stRes = await fetch(`${BASE}/api/deploy/status`, { headers: H });
  const stJson = await stRes.json();
  const composeAvailable = !!(stJson.data && stJson.data.docker && stJson.data.docker.compose);

  if (composeAvailable) {
    // 真实环境：提交任务并轮询到收敛
    r = await fetch(`${BASE}/api/deploy/up`, { method: 'POST', headers: H });
    j = await r.json();
    await check('up 返回 taskId', r.status === 200 && j.ok && typeof j.data.taskId === 'string', j.data);
    const taskId = j.data && j.data.taskId;

    let t = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 500));
      r = await fetch(`${BASE}/api/deploy/task/${taskId}`, { headers: H });
      t = await r.json();
      if (t.data && t.data.status !== 'running') break;
    }
    await check('任务状态收敛', t && t.data && ['done', 'error'].includes(t.data.status), t);
    await check('任务有输出行', t && t.data && Array.isArray(t.data.lines), t);
  } else {
    // 受限环境（无法 spawn 子进程）：验证 400 优雅报错路径
    r = await fetch(`${BASE}/api/deploy/up`, { method: 'POST', headers: H });
    j = await r.json();
    await check('受限环境 up 返回 400 提示', r.status === 400 && /compose/i.test(j.error.message), j);
  }

  r = await fetch(`${BASE}/api/deploy/task/nonexistent`, { headers: H });
  await check('未知任务 404', r.status === 404);

  // ---------- 凭证提取 ----------
  console.log('\n[凭证]');
  r = await fetch(`${BASE}/api/deploy/credentials`, { headers: H });
  j = await r.json();
  await check('credentials 200', r.status === 200 && j.ok);
  await check('字段完整', j.data && typeof j.data.found === 'boolean' && Array.isArray(j.data.lines));

  // ---------- 日志 ----------
  r = await fetch(`${BASE}/api/deploy/logs?tail=100`, { headers: H });
  j = await r.json();
  await check('logs 200', r.status === 200 && j.ok && typeof j.data.log === 'string');

  // ---------- API Key（运行时更新，无需重启） ----------
  console.log('\n[API Key]');
  r = await fetch(`${BASE}/api/deploy/apikey`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'test-api-key' }),
  });
  j = await r.json();
  await check('保存 Key', r.status === 200 && j.ok && j.data.configured === true);

  r = await fetch(`${BASE}/api/deploy/check`, { headers: H });
  j = await r.json();
  await check('连接检测成功', r.status === 200 && j.ok && j.data.reachable === true && j.data.version === '6.0.0-beta.5', j.data);

  // 恢复 .env（清空 Key）
  await fetch(`${BASE}/api/deploy/apikey`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: '' }),
  });

  // ---------- 单元：凭证提取逻辑 ----------
  console.log('\n[凭证提取单元]');
  const docker = require('../src/docker');
  const sample = [
    '2026-01-01 00:00:01 [INFO] TeamSpeak 6 Server starting up',
    '2026-01-01 00:00:02 [INFO] License accepted, 32 slots preview license',
    '2026-01-01 00:00:03 [INFO] The initial admin token for the server is: aB3x-9Kq2-tY8w',
    '2026-01-01 00:00:03 [INFO] The server query admin password is: s3cr3t-pass',
    '2026-01-01 00:00:04 [INFO] Server listening on 0.0.0.0:9987',
  ].join('\n');
  const creds = docker.extractCredentials(sample);
  await check('提取 token 行', creds.some((l) => l.includes('aB3x-9Kq2-tY8w')), creds);
  await check('提取 password 行', creds.some((l) => l.includes('s3cr3t-pass')), creds);
  await check('过滤 license/version 行', !creds.some((l) => /license|listening/i.test(l)), creds);
  const noise = docker.extractCredentials('just some random log\nno secrets here');
  await check('无凭证返回空', Array.isArray(noise) && noise.length === 0);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
