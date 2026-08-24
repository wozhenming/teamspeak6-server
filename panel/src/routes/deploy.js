'use strict';

/**
 * /api/deploy — 部署管理（前端引导式一键部署）
 *
 *   GET    /status        环境/文件/容器/WebQuery 综合状态
 *   GET    /preview       预览 docker-compose.yml 内容
 *   POST   /compose       生成 docker-compose.yml { ...opts, force }
 *   POST   /up            启动服务（后台任务，返回 taskId）
 *   POST   /down          停止服务（后台任务）
 *   POST   /restart       重启服务（后台任务）
 *   GET    /task/:id      查询后台任务进度 { status, lines, code }
 *   GET    /logs?tail=N   容器日志
 *   GET    /credentials   从日志提取初始管理员凭证
 *   POST   /apikey        保存 API Key 到 .env 并立即生效 { key }
 *   GET    /check         检测 WebQuery 连通性（whoami/version）
 */

const express = require('express');
const fs = require('fs');
const { config, setApiKey } = require('../config');
const { ts } = require('../webquery');
const docker = require('../docker');
const dockerApi = require('../docker-api');

const router = express.Router();

const isContainerMode = () => config.runMode === 'container';

function num(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ---------- 综合状态 ----------
router.get('/status', async (req, res, next) => {
  try {
    const containerName = req.query.name || config.tsContainerName;
    const [env, container, composeFile, wq] = await Promise.all([
      isContainerMode() ? dockerApi.detect() : docker.detectDocker(),
      isContainerMode() ? dockerApi.containerStatus(containerName) : docker.containerStatus(containerName),
      docker.composeFilePath(),
      ts.version().then((v) => ({ reachable: true, version: v.version || v })).catch((e) => ({ reachable: false, error: e.message })),
    ]);

    let composeContent = null;
    try { composeContent = fs.existsSync(composeFile) ? fs.readFileSync(composeFile, 'utf8') : null; } catch (e) { composeContent = null; }

    res.json({
      ok: true,
      data: {
        mode: config.runMode,
        containerName,
        distro: docker.detectDistro(),
        docker: env,
        dockerInstallGuide: env.installed ? [] : docker.dockerInstallGuide(docker.detectDistro()),
        composeFile: { path: composeFile, exists: !!composeContent, content: composeContent },
        container,
        webquery: {
          baseUrl: config.tsBaseUrl,
          keyConfigured: !!config.tsApiKey,
          reachable: wq.reachable,
          version: wq.reachable ? wq.version : null,
          error: wq.reachable ? null : wq.error,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- 预览 compose（容器化模式下由根目录 compose 管理，不适用） ----------
router.get('/preview', (req, res) => {
  if (config.runMode === 'container') {
    return res.status(400).json({ ok: false, error: { code: 'CONTAINER_MODE', message: '容器化模式下 docker-compose.yml 由项目根目录管理，无需在此生成' } });
  }
  const content = docker.renderCompose({
    containerName: req.query.name || undefined,
    voicePort: num(req.query.voice, 9987),
    filePort: num(req.query.file, 30033),
    webqueryPort: num(req.query.webquery, 10080),
    sshPort: req.query.ssh ? num(req.query.ssh, 10022) : undefined,
    queryPassword: req.query.password || undefined,
  });
  res.json({ ok: true, data: { content } });
});

// ---------- 生成 compose（容器化模式下不适用） ----------
router.post('/compose', async (req, res, next) => {
  try {
    if (config.runMode === 'container') {
      throw Object.assign(new Error('容器化模式下 docker-compose.yml 由项目根目录管理，无需在此生成'), { status: 400 });
    }
    const b = req.body || {};
    const result = await docker.saveComposeFile({
      containerName: b.name || undefined,
      voicePort: num(b.voice, 9987),
      filePort: num(b.file, 30033),
      webqueryPort: num(b.webquery, 10080),
      sshPort: b.ssh ? num(b.ssh, 10022) : undefined,
      queryPassword: b.password || undefined,
    }, !!b.force);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------- 启动 / 停止 / 重启 ----------
// 容器化模式：经 docker.sock 直接操作 TS6 容器（由根目录 compose 创建），即时返回；
// 独立模式：compose 后台任务（返回 taskId 供轮询）
const CONTAINER_ACTIONS = { up: 'start', down: 'stop', restart: 'restart' };

async function containerActionOrComposeTask(action) {
  if (isContainerMode()) {
    const result = await dockerApi.containerAction(config.tsContainerName, CONTAINER_ACTIONS[action]);
    if (!result.ok) {
      throw Object.assign(new Error(`容器操作失败：${result.error}`), { status: 502 });
    }
    return { taskId: null, action, success: true };
  }
  const taskMap = { up: ['up', '-d'], down: ['down'], restart: ['restart'] };
  if (action === 'up' && !fs.existsSync(docker.composeFilePath())) {
    throw Object.assign(new Error('尚未生成 docker-compose.yml，请先在「部署配置」中生成'), { status: 400 });
  }
  const taskId = await docker.composeTask(`compose-${action}`, taskMap[action]);
  return { taskId, action };
}

router.post('/up', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('up');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

router.post('/down', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('down');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

router.post('/restart', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('restart');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

// ---------- 任务查询 ----------
router.get('/task/:id', (req, res) => {
  const task = docker.getTask(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在或已过期' } });
  res.json({ ok: true, data: { id: task.id, name: task.name, status: task.status, code: task.code, lines: task.lines } });
});

// ---------- 容器日志 ----------
router.get('/logs', async (req, res, next) => {
  try {
    const name = req.query.name || config.tsContainerName;
    const log = isContainerMode()
      ? await dockerApi.containerLogs(name, num(req.query.tail, 300))
      : await docker.containerLogs(name, num(req.query.tail, 300));
    res.json({ ok: true, data: { name, log } });
  } catch (err) { next(err); }
});

// ---------- 初始管理员凭证 ----------
router.get('/credentials', async (req, res, next) => {
  try {
    const name = req.query.name || config.tsContainerName;
    const log = isContainerMode()
      ? await dockerApi.containerLogs(name, 2000)
      : await docker.containerLogs(name, 2000);
    const lines = docker.extractCredentials(log);
    res.json({ ok: true, data: { found: lines.length > 0, lines, note: lines.length ? null : '日志中未发现凭证关键字，可查看完整日志确认' } });
  } catch (err) { next(err); }
});

// ---------- API Key ----------
router.post('/apikey', (req, res) => {
  const { key } = req.body || {};
  if (key === undefined) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '缺少 key 参数' } });
  }
  const saved = setApiKey(key);
  res.json({ ok: true, data: { configured: !!saved } });
});

// ---------- WebQuery 连通性检测 ----------
router.get('/check', async (req, res, next) => {
  try {
    const v = await ts.version();
    res.json({ ok: true, data: { reachable: true, version: v.version || v, baseUrl: config.tsBaseUrl, keyConfigured: !!config.tsApiKey } });
  } catch (err) {
    res.status(502).json({ ok: false, error: { code: err.code || 'WEBQUERY_UNREACHABLE', message: err.message } });
  }
});

module.exports = router;
