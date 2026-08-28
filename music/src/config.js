'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = (k, f) => {
  const v = process.env[k];
  return v === undefined || v === '' ? f : v;
};

// 聊天点歌可用指令（面板管理开关）：dian=点歌，play=播放，pause=暂停，next=切歌，clear=清队列，search=搜索，queue=队列，loop=循环，status=状态，switch=切频道
const CHAT_CMD_DEFAULT = { dian: true, play: true, playat: true, pause: true, next: true, clear: true, search: true, queue: true, loop: true, status: true, switch: true };

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
  // 音频流访问令牌安全开关：开启时要求 ?t=<token>，防公网随意收听；面板可开关并生成显示。
  streamTokenEnabled: process.env.STREAM_TOKEN_ENABLED !== undefined
    ? process.env.STREAM_TOKEN_ENABLED !== '0'
    : true,
  streamToken: env('STREAM_TOKEN', ''),
  // 电台流编码质量（music-bot 输出给 ts6-manager 的“源音频”；ts6-manager 会再编码为 Opus 推入 TS，
  // 因此源质量越高，最终 TS 音质越好）。默认 320k / 48k / 立体声；
  // 如服务器出网带宽吃紧可调低比特率；想进一步可把 STREAM_AUDIO_CODEC 设为 libopus（效率更高）。
  audioCodec: env('STREAM_AUDIO_CODEC', 'libmp3lame'),
  audioBitrate: env('STREAM_AUDIO_BITRATE', '320k'),
  audioRate: parseInt(env('STREAM_AUDIO_RATE', '48000'), 10),
  audioChannels: parseInt(env('STREAM_AUDIO_CHANNELS', '2'), 10),
  // 频道无人时自动暂停、有人进入自动恢复（默认开启；面板可关）
  autoPauseEmpty: env('AUTO_PAUSE_EMPTY', 'true') !== 'false',
  // TeamSpeak 服务器连接信息（交由 ts6-manager 管理，自动建连）
  tsHost: env('TS_HOST', 'teamspeak'),
  tsWebqueryPort: parseInt(env('TS_WEBQUERY_PORT', '10080'), 10),
  tsApiKey: env('TS_API_KEY', ''),
  // TS 服务器管理员密码（仅用于首次自动生成 API Key；留空则需手动在 .env 配 TS_API_KEY）
  tsQueryAdminPassword: env('TS_QUERY_ADMIN_PASSWORD', ''),
  // 机器人要加入的频道密码（频道设了密码时需填；点歌助手 clientmove 与点歌机器人加入都要用）
  ts6mgrChannelPassword: env('TS_CHANNEL_PASSWORD', ''),
  // TS 频道聊天点歌开关：默认随密码存在而启用；面板可覆盖并持久化
  tsChatEnabled: process.env.TS_CHAT_ENABLED !== undefined
    ? process.env.TS_CHAT_ENABLED !== '0'
    : true,
  // 聊天点歌可用指令（面板管理哪些可用）：点歌/播放/暂停/切歌/循环
  chatCommands: Object.assign({}, CHAT_CMD_DEFAULT),
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
    if (o.tsQueryAdminPassword) config.tsQueryAdminPassword = o.tsQueryAdminPassword;
    if (o.ts6mgrChannelPassword) config.ts6mgrChannelPassword = o.ts6mgrChannelPassword;
    if (o.tsChatEnabled != null) config.tsChatEnabled = !!o.tsChatEnabled;
    if (o.chatCommands && typeof o.chatCommands === 'object') {
      config.chatCommands = Object.assign({}, CHAT_CMD_DEFAULT, o.chatCommands);
    }
    if (o.streamTokenEnabled != null) config.streamTokenEnabled = !!o.streamTokenEnabled;
    if (o.streamToken) config.streamToken = o.streamToken;
    if (o.audioCodec) config.audioCodec = o.audioCodec;
    if (o.audioBitrate) config.audioBitrate = o.audioBitrate;
    if (o.audioRate != null) config.audioRate = parseInt(o.audioRate, 10);
    if (o.audioChannels != null) config.audioChannels = parseInt(o.audioChannels, 10);
    if (o.autoPauseEmpty != null) config.autoPauseEmpty = !!o.autoPauseEmpty;
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
    tsQueryAdminPassword: (o.tsQueryAdminPassword || '').trim() || config.tsQueryAdminPassword,
    ts6mgrChannelPassword: (o.ts6mgrChannelPassword || '').trim() || config.ts6mgrChannelPassword,
    tsChatEnabled: o.tsChatEnabled != null ? !!o.tsChatEnabled : (config.tsChatEnabled !== false),
    chatCommands: Object.assign({}, CHAT_CMD_DEFAULT,
      (o.chatCommands && typeof o.chatCommands === 'object') ? o.chatCommands : (config.chatCommands || {})),
    streamTokenEnabled: o.streamTokenEnabled != null ? !!o.streamTokenEnabled : (config.streamTokenEnabled !== false),
    streamToken: (o.streamToken || '').trim() || config.streamToken,
    audioCodec: (o.audioCodec || '').trim() || config.audioCodec,
    audioBitrate: (o.audioBitrate || '').trim() || config.audioBitrate,
    audioRate: o.audioRate != null ? parseInt(o.audioRate, 10) : config.audioRate,
    audioChannels: o.audioChannels != null ? parseInt(o.audioChannels, 10) : config.audioChannels,
    autoPauseEmpty: o.autoPauseEmpty != null ? !!o.autoPauseEmpty : config.autoPauseEmpty,
  };
  Object.assign(config, next);
  try { fs.writeFileSync(tsBridgeFile, JSON.stringify(next, null, 2)); } catch (e) { /* 忽略 */ }
  return next;
};

module.exports = { config };