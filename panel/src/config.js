'use strict';

const path = require('path');
const fs = require('fs');

// 配置文件路径：容器内由 PANEL_ENV_FILE 指向持久化 volume（重启不丢），本地默认 panel/.env
const envFile = process.env.PANEL_ENV_FILE || path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envFile });

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** 从持久化配置文件中读取 API Key（环境变量为空时的回退，保证部署页保存后重启仍生效） */
function readKeyFromEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^TSSERVER_API_KEY=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

const config = {
  // 面板自身
  host: env('HOST', '127.0.0.1'),
  port: parseInt(env('PORT', '3000'), 10),
  panelUsername: env('PANEL_USERNAME', 'admin'),
  panelPassword: env('PANEL_PASSWORD', 'admin123'),
  sessionSecret: env('SESSION_SECRET', 'please-change-me'),

  // TeamSpeak 6 WebQuery
  tsBaseUrl: env('TSSERVER_BASE_URL', 'http://127.0.0.1:10080').replace(/\/+$/, ''),
  tsApiKey: (() => {
    const k = env('TSSERVER_API_KEY', '');
    return k || readKeyFromEnvFile(envFile);
  })(),
  tsDefaultSid: parseInt(env('TSSERVER_DEFAULT_SID', '1'), 10),
  // SSH Query（一键生成 API Key 用）
  tsSshHost: env('TSSERVER_SSH_HOST', ''), // 留空则取 tsBaseUrl 的主机名
  tsSshPort: parseInt(env('TSSERVER_SSH_PORT', '10022'), 10),

  // 部署管理
  deployDir: env('DEPLOY_DIR', path.join(__dirname, '..', '..', 'deploy')),
  // 容器化模式（container=由根目录 docker-compose 管理，部署页操作主机 Docker 容器）
  runMode: env('PANEL_RUN_MODE', 'standalone'),
  // TS6 容器名（容器化模式下读取日志/凭证、快捷启停）
  tsContainerName: env('TSSERVER_CONTAINER_NAME', 'teamspeak-server'),

  // 派生路径
  publicDir: path.join(__dirname, '..', 'public'),
  // 初始管理员凭证持久化文件（与配置文件同目录：容器内为数据卷 /app/config）
  credentialFile: path.join(path.dirname(envFile), 'ts6-credentials.txt'),
};

/**
 * 运行时更新 WebQuery API Key：立即生效（内存）并持久化到配置文件。
 * 容器内写入 /app/config/panel.env（volume），重启不丢失。
 */
function setApiKey(key) {
  config.tsApiKey = String(key || '').trim();
  try {
    let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const re = /^TSSERVER_API_KEY=.*$/m;
    if (re.test(content)) {
      content = content.replace(re, `TSSERVER_API_KEY=${config.tsApiKey}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `TSSERVER_API_KEY=${config.tsApiKey}\n`;
    }
    fs.writeFileSync(envFile, content, 'utf8');
  } catch (err) {
    // 持久化失败不阻断（本次运行仍生效）
    console.warn('[config] 无法写入配置文件（API Key 仅在本次运行生效）:', err.message);
  }
  return config.tsApiKey;
}

// 启动时的安全提示（不阻断启动）
const warnings = [];
if (config.panelPassword === 'admin123') {
  warnings.push('面板使用默认密码 admin/admin123，请立即修改 PANEL_PASSWORD！');
}
if (config.sessionSecret === 'please-change-me') {
  warnings.push('SESSION_SECRET 使用默认值，请修改为随机字符串！');
}
if (!config.tsApiKey) {
  warnings.push('未配置 TSSERVER_API_KEY，请进入「部署管理」页生成并填写 API Key。');
}

module.exports = { config, warnings, setApiKey, envFile };
