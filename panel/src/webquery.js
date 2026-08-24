'use strict';

/**
 * TeamSpeak 6 WebQuery HTTP API 连接层。
 *
 * 协议要点（已对照社区实现 ts6-manager 确认）：
 *  - Base URL: http://<host>:10080
 *  - 认证头:   x-api-key: <api key>
 *  - URL 模式: /{sid}/{command}，实例级命令（sid=0）为 /{command}
 *  - 参数:     以 query string 传递（cleanParams 会剔除空值）
 *  - 响应:     { status: { code, message }, body: [...] }
 *              status.code !== 0 视为错误；数据取 body
 *
 * 注意：连接使用 keep-alive（Node fetch 默认），避免每次请求都被
 * TS 服务器注册为一个新的 serveradmin 查询客户端。
 */

const http = require('http');
const https = require('https');
const { config } = require('./config');

const TIMEOUT_MS = 10000;

class WebQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebQueryError';
    this.code = code;
  }
}

// ⚠️ 为什么不用全局 fetch：Node 的 fetch（undici）遵循 Fetch 规范，
// 端口 10080 在规范“禁止端口”黑名单中，会直接报 bad port。
// 因此这里使用原生 http/https 模块。
const isHttps = config.tsBaseUrl.startsWith('https:');
const AgentCtor = isHttps ? https.Agent : http.Agent;
const agent = new AgentCtor({ keepAlive: true, maxSockets: 1 });

function cleanParams(params) {
  if (!params) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function request(method, sid, command, params) {
  if (!config.tsApiKey) {
    return Promise.reject(new WebQueryError(-1, '未配置 TSSERVER_API_KEY（请通过 SSH Query 执行 apikeyadd scope=manage lifetime=0 生成）'));
  }
  const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
  const url = new URL(config.tsBaseUrl + path);
  const cleaned = cleanParams(params);
  if (cleaned) {
    for (const [k, v] of Object.entries(cleaned)) url.searchParams.set(k, String(v));
  }

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method,
      headers: { 'x-api-key': config.tsApiKey, Accept: 'application/json' },
      agent,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { /* 非 JSON */ }

        if (!res.statusCode || res.statusCode >= 400) {
          const msg = (json && json.status && json.status.message) || `WebQuery HTTP ${res.statusCode}`;
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new WebQueryError(res.statusCode, `WebQuery 认证失败（${msg}）：请检查 API Key`));
          }
          return reject(new WebQueryError(res.statusCode, `WebQuery 请求失败（${command}）：${msg}`));
        }

        if (json && json.status && json.status.code !== 0) {
          return reject(new WebQueryError(json.status.code, `WebQuery 错误 [${json.status.code}]：${json.status.message}（${command}）`));
        }

        resolve(json && json.body !== undefined ? json.body : json);
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`WebQuery 请求超时（${command}）`));
    });
    req.on('error', (err) => {
      reject(new WebQueryError(-1, `无法连接 WebQuery（${config.tsBaseUrl}）：${err.message}`));
    });
    req.end();
  });
}

const get = (sid, command, params) => request('GET', sid, command, params);

/** 通用命令执行（供路由层使用） */
const ts = {
  request,

  // ---------- 实例级（sid=0） ----------
  version: () => get(0, 'version'),
  whoami: () => get(0, 'whoami'),
  serverlist: () => get(0, 'serverlist'),

  // ---------- 服务器信息 ----------
  serverinfo: async (sid) => {
    const body = await get(sid, 'serverinfo');
    return Array.isArray(body) ? body[0] || {} : body || {};
  },
  connectionInfo: async (sid) => {
    const body = await get(sid, 'serverrequestconnectioninfo');
    return Array.isArray(body) ? body[0] || {} : body || {};
  },

  // ---------- 用户 ----------
  clientlist: (sid) => get(sid, 'clientlist', {
    '-uid': '', '-away': '', '-voice': '', '-times': '', '-groups': '', '-info': '', '-country': '', '-ip': '',
  }),
  clientinfo: async (sid, clid) => {
    const body = await get(sid, 'clientinfo', { clid });
    return Array.isArray(body) ? body[0] || {} : body || {};
  },
  kick: (sid, clid, { reason = '', from = 'server' } = {}) =>
    get(sid, 'clientkick', {
      clid,
      reasonid: 5,
      reasonmsg: reason || undefined,
      kickfrom: from === 'channel' ? 'channel' : undefined,
    }),
  ban: async (sid, clid, { reason = '', time = 0, ipban = false } = {}) => {
    await get(sid, 'banclient', { clid, time, banreason: reason || undefined });
    // 可选：额外封禁客户端 IP
    if (ipban) {
      try {
        const info = await ts.clientinfo(sid, clid);
        const ip = info.connection_client_ip || info.client_ip;
        if (ip && !['0.0.0.0', '::'].includes(ip)) {
          await get(sid, 'banadd', { ip, time, banreason: reason ? `IP: ${reason}` : undefined });
        }
      } catch (err) {
        console.warn('[webquery] IP 封禁失败（忽略）:', err.message);
      }
    }
  },
  move: (sid, clid, cid) => get(sid, 'clientmove', { clid, cid }),
  poke: (sid, clid, msg) => get(sid, 'clientpoke', { clid, msg }),
  sendTextMessage: (sid, clid, msg) => get(sid, 'sendtextmessage', { targetmode: 1, target: clid, msg }),

  // ---------- 频道 ----------
  channellist: (sid) => get(sid, 'channellist', {
    '-topic': '', '-flags': '', '-voice': '', '-limits': '', '-icon': '', '-secondsempty': '',
  }),
  channelinfo: async (sid, cid) => {
    const body = await get(sid, 'channelinfo', { cid });
    return Array.isArray(body) ? body[0] || {} : body || {};
  },
  createChannel: (sid, opts) => get(sid, 'channelcreate', {
    channel_name: opts.name,
    channel_topic: opts.topic || undefined,
    channel_password: opts.password || undefined,
    channel_maxclients: opts.max_clients,
    channel_order: opts.order,
    cpid: opts.parent_cid,
    channel_flag_permanent: 1,
  }),
  editChannel: (sid, cid, opts) => get(sid, 'channeledit', {
    cid,
    channel_name: opts.name,
    channel_topic: opts.topic,
    channel_password: opts.password,
    channel_maxclients: opts.max_clients,
    channel_order: opts.order,
  }),
  deleteChannel: (sid, cid) => get(sid, 'channeldelete', { cid, force: 1 }),
};

module.exports = { ts, WebQueryError };
