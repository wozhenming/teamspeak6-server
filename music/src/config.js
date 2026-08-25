'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = (k, f) => {
  const v = process.env[k];
  return v === undefined || v === '' ? f : v;
};

const config = {
  // music-bot 自身监听
  host: env('MUSIC_HOST', '0.0.0.0'),
  port: parseInt(env('MUSIC_BOT_PORT', '3200'), 10),

  // api-enhanced（网易云 API）内网地址
  apiBase: env('NCMAPI_BASE', 'http://neteasemusic:3000'),

  // 数据持久化目录（cookie / 队列）
  dataDir: env('MUSIC_DATA_DIR', '/app/data'),
};

module.exports = { config };