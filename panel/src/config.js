'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
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
  tsApiKey: env('TSSERVER_API_KEY', ''),
  tsDefaultSid: parseInt(env('TSSERVER_DEFAULT_SID', '1'), 10),

  // 部署管理（Docker Compose 文件目录）
  deployDir: env('DEPLOY_DIR', path.join(__dirname, '..', '..', 'deploy')),

  // 派生路径
  publicDir: path.join(__dirname, '..', 'public'),
};

/**
 * 运行时更新 WebQuery API Key：立即生效（内存）并持久化到 .env。
 * 这样在部署页填入 Key 后无需重启面板。
 */
function setApiKey(key) {
  config.tsApiKey = String(key || '').trim();
  const envPath = path.join(__dirname, '..', '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const re = /^TSSERVER_API_KEY=.*$/m;
    if (re.test(content)) {
      content = content.replace(re, `TSSERVER_API_KEY=${config.tsApiKey}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `TSSERVER_API_KEY=${config.tsApiKey}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    // 持久化失败不阻断（本次运行仍生效）
    console.warn('[config] 无法写入 .env（API Key 仅在本次运行生效）:', err.message);
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

module.exports = { config, warnings, setApiKey };
