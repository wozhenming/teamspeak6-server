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

  // 数据持久化目录（cookie / 队列 / 桥接配置）
  dataDir: env('MUSIC_DATA_DIR', '/app/data'),

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
  // TeamSpeak 服务器连接信息（交由 ts6-manager 管理，面板可编辑）
  tsHost: env('TS_HOST', ''),
  tsWebqueryPort: parseInt(env('TS_WEBQUERY_PORT', '10080'), 10),
  tsApiKey: env('TS_API_KEY', ''),
};

// 持久化桥接配置（面板可编辑，覆盖上面的环境变量）
const tsBridgeFile = path.join(config.dataDir, 'tsbridge.json');
function loadTsBridge() {
  try {
    const o = JSON.parse(fs.readFileSync(tsBridgeFile, 'utf8'));
    config.ts6mgrUrl = o.ts6mgrUrl != null ? o.ts6mgrUrl : config.ts6mgrUrl;
    config.ts6mgrUser = o.ts6mgrUser != null ? o.ts6mgrUser : config.ts6mgrUser;
    config.ts6mgrPass = o.ts6mgrPass != null ? o.ts6mgrPass : config.ts6mgrPass;
    config.ts6mgrBotId = o.ts6mgrBotId != null ? o.ts6mgrBotId : config.ts6mgrBotId;
    config.ts6mgrChannel = o.ts6mgrChannel != null ? o.ts6mgrChannel : config.ts6mgrChannel;
    config.streamPublicUrl = o.streamPublicUrl || config.streamPublicUrl;
    config.tsHost = o.tsHost != null ? o.tsHost : config.tsHost;
    config.tsWebqueryPort = o.tsWebqueryPort != null ? parseInt(o.tsWebqueryPort, 10) : config.tsWebqueryPort;
    config.tsApiKey = o.tsApiKey != null ? o.tsApiKey : config.tsApiKey;
  } catch (e) { /* 无持久化配置 */ }
}
loadTsBridge();
config.saveTsBridge = (o) => {
  const next = {
    ts6mgrUrl: o.ts6mgrUrl || '',
    ts6mgrUser: o.ts6mgrUser || '',
    ts6mgrPass: o.ts6mgrPass || '',
    ts6mgrBotId: o.ts6mgrBotId || '',
    ts6mgrChannel: o.ts6mgrChannel || '',
    streamPublicUrl: o.streamPublicUrl || 'http://music:3200/api/stream',
    tsHost: o.tsHost || '',
    tsWebqueryPort: o.tsWebqueryPort != null ? parseInt(o.tsWebqueryPort, 10) : 10080,
    tsApiKey: o.tsApiKey || '',
  };
  Object.assign(config, next);
  try { fs.writeFileSync(tsBridgeFile, JSON.stringify(next, null, 2)); } catch (e) { /* 忽略 */ }
  return next;
};

module.exports = { config };