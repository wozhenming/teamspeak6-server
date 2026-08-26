'use strict';

const fs = require('fs');
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
  // ts6-manager 拉取本服务音频流所用的地址。
  // 注意：ts6-manager 的 SSRF 防护会拒绝解析到内网 IP 的主机名（如 music/teamspeak），
  // 因此这里必须填“对 ts6-manager 而言可达且非内网”的地址，通常是服务器公网 IP/域名。
  // 例：STREAM_PUBLIC_HOST=8.*.*.98 → http://8.*.*.98:3200/api/stream
  streamPublicUrl: env('STREAM_PUBLIC_URL', 'http://' + env('STREAM_PUBLIC_HOST', 'music') + ':3200/api/stream'),
  // 音频流访问令牌（避免电台流被公网随意收听；ts6-manager 的电台 URL 会带上 ?t=）
  streamToken: env('STREAM_TOKEN', 'ts6bot'),
  // TeamSpeak 服务器连接信息（交由 ts6-manager 管理，自动建连）
  tsHost: env('TS_HOST', 'teamspeak'),
  tsWebqueryPort: parseInt(env('TS_WEBQUERY_PORT', '10080'), 10),
  tsApiKey: env('TS_API_KEY', ''),
  // TS 服务器管理员密码（仅用于首次自动生成 API Key；留空则需手动在 .env 配 TS_API_KEY）
  tsQueryAdminPassword: env('TS_QUERY_ADMIN_PASSWORD', ''),
  // 内部：上次成功应用到 ts6-manager 的连接参数（host/port/keyHash），用于去重更新
  appliedHost: '',
  appliedPort: 0,
  appliedKeyHash: '',
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
    if (o.tsHost) config.tsHost = o.tsHost;
    if (o.tsWebqueryPort != null) config.tsWebqueryPort = parseInt(o.tsWebqueryPort, 10);
    if (o.tsApiKey) config.tsApiKey = o.tsApiKey;
    // 内部记录：上次应用到 ts6-manager 的连接参数（避免每次都 PUT 触发其重连）
    if (o.appliedHost != null) config.appliedHost = o.appliedHost;
    if (o.appliedPort != null) config.appliedPort = o.appliedPort;
    if (o.appliedKeyHash != null) config.appliedKeyHash = o.appliedKeyHash;
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
    tsHost: (o.tsHost || '').trim() || config.tsHost,
    tsWebqueryPort: o.tsWebqueryPort != null ? parseInt(o.tsWebqueryPort, 10) : config.tsWebqueryPort,
    tsApiKey: (o.tsApiKey || '').trim() || config.tsApiKey,
    appliedHost: o.appliedHost != null ? String(o.appliedHost) : (config.appliedHost || ''),
    appliedPort: o.appliedPort != null ? parseInt(o.appliedPort, 10) : (config.appliedPort || 0),
    appliedKeyHash: o.appliedKeyHash != null ? String(o.appliedKeyHash) : (config.appliedKeyHash || ''),
  };
  Object.assign(config, next);
  try { fs.writeFileSync(tsBridgeFile, JSON.stringify(next, null, 2)); } catch (e) { /* 忽略 */ }
  return next;
};

module.exports = { config };