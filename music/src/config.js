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

  // ts6-manager 对接（点歌机器人语音引擎）。以下均有默认值，开箱即用，
  // 面板只需填写“频道”。改 .env 可覆盖；面板保存的配置会持久化覆盖这里。
  ts6mgrUrl: env('TS6MGR_URL', 'http://backend:3001'),
  ts6mgrUser: env('TS6MGR_USER', 'tsbot'),
  ts6mgrPass: env('TS6MGR_PASS', 'Tsbot123'),
  ts6mgrBotId: env('TS6MGR_BOT_ID', ''),
  ts6mgrChannel: env('TS6MGR_CHANNEL', ''),
  // ts6-manager 拉取本服务音频流所用的地址（同网络内用 music:3200）
  streamPublicUrl: env('STREAM_PUBLIC_URL', 'http://music:3200/api/stream'),
  // TeamSpeak 服务器连接信息（交由 ts6-manager 管理，自动建连）
  tsHost: env('TS_HOST', 'teamspeak'),
  tsWebqueryPort: parseInt(env('TS_WEBQUERY_PORT', '10080'), 10),
  tsApiKey: env('TS_API_KEY', ''),
  // TS 服务器管理员密码（仅用于首次自动生成 API Key；留空则需手动在 .env 配 TS_API_KEY）
  tsQueryAdminPassword: env('TS_QUERY_ADMIN_PASSWORD', ''),
};

// 持久化桥接配置（面板可编辑，覆盖上面的环境变量）。空串不覆盖默认值。
const tsBridgeFile = path.join(config.dataDir, 'tsbridge.json');
function loadTsBridge() {
  try {
    const o = JSON.parse(fs.readFileSync(tsBridgeFile, 'utf8'));
    if (o.ts6mgrUrl) config.ts6mgrUrl = o.ts6mgrUrl;
    if (o.ts6mgrUser) config.ts6mgrUser = o.ts6mgrUser;
    if (o.ts6mgrPass) config.ts6mgrPass = o.ts6mgrPass;
    if (o.ts6mgrBotId) config.ts6mgrBotId = o.ts6mgrBotId;
    if (o.ts6mgrChannel) config.ts6mgrChannel = o.ts6mgrChannel;
    if (o.streamPublicUrl) config.streamPublicUrl = o.streamPublicUrl;
    if (o.tsHost) config.tsHost = o.tsHost;
    if (o.tsWebqueryPort != null) config.tsWebqueryPort = parseInt(o.tsWebqueryPort, 10);
    if (o.tsApiKey) config.tsApiKey = o.tsApiKey;
  } catch (e) { /* 无持久化配置 */ }
}
loadTsBridge();
config.saveTsBridge = (o) => {
  const next = {
    ts6mgrUrl: (o.ts6mgrUrl || '').trim() || config.ts6mgrUrl,
    ts6mgrUser: (o.ts6mgrUser || '').trim() || config.ts6mgrUser,
    ts6mgrPass: (o.ts6mgrPass || '').trim() || config.ts6mgrPass,
    ts6mgrBotId: (o.ts6mgrBotId || '').trim() || config.ts6mgrBotId,
    ts6mgrChannel: (o.ts6mgrChannel || '').trim() || config.ts6mgrChannel,
    streamPublicUrl: (o.streamPublicUrl || '').trim() || config.streamPublicUrl,
    tsHost: (o.tsHost || '').trim() || config.tsHost,
    tsWebqueryPort: o.tsWebqueryPort != null ? parseInt(o.tsWebqueryPort, 10) : config.tsWebqueryPort,
    tsApiKey: (o.tsApiKey || '').trim() || config.tsApiKey,
  };
  Object.assign(config, next);
  try { fs.writeFileSync(tsBridgeFile, JSON.stringify(next, null, 2)); } catch (e) { /* 忽略 */ }
  return next;
};

module.exports = { config };