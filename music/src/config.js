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

  // 图片代理上游：留空则 music-bot 直接抓取封面；
  // 若 music-bot 容器无外网，可指向 neteasemusic 容器内已开好的图片代理
  // （如 http://neteasemusic:3100），借助其外网出口绕过防盗链。
  imgProxy: env('NETEASE_IMG_PROXY', ''),

  // ts6-manager 对接（点歌机器人语音引擎）：留空表示不启用 TS 推流
  ts6mgrUrl: env('TS6MGR_URL', ''),
  ts6mgrUser: env('TS6MGR_USER', ''),
  ts6mgrPass: env('TS6MGR_PASS', ''),
  ts6mgrBotId: env('TS6MGR_BOT_ID', ''),
  ts6mgrChannel: env('TS6MGR_CHANNEL', ''),
  // ts6-manager 拉取本服务音频流所用的地址（同网络内用 music:3200）
  streamPublicUrl: env('STREAM_PUBLIC_URL', 'http://music:3200/api/stream'),

  // 数据持久化目录（cookie / 队列）
  dataDir: env('MUSIC_DATA_DIR', '/app/data'),
};

module.exports = { config };