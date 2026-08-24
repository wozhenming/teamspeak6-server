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

  // 派生路径
  publicDir: path.join(__dirname, '..', 'public'),
};

// 启动时的安全提示（不阻断启动）
const warnings = [];
if (config.panelPassword === 'admin123') {
  warnings.push('面板使用默认密码 admin/admin123，请立即修改 PANEL_PASSWORD！');
}
if (config.sessionSecret === 'please-change-me') {
  warnings.push('SESSION_SECRET 使用默认值，请修改为随机字符串！');
}
if (!config.tsApiKey) {
  warnings.push('未配置 TSSERVER_API_KEY，面板将无法连接 TeamSpeak 6 WebQuery。');
}

module.exports = { config, warnings };
