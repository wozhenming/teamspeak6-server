'use strict';

/**
 * 面板前端 API 封装。
 * 所有请求都经由面板后端代理，浏览器不直接接触 TS6 WebQuery / API Key。
 */

const API = (function () {
  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('无法连接管理面板，请检查面板服务是否运行');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (res.status === 401) {
      // 会话失效：跳转登录页
      if (location.pathname.endsWith('login.html')) {
        throw new Error('登录失败');
      }
      location.href = '/login.html';
      throw new Error('会话已过期，请重新登录');
    }
    if (!res.ok || !json || !json.ok) {
      const msg = (json && json.error && json.error.message) || ('请求失败 (HTTP ' + res.status + ')');
      const err = new Error(msg);
      if (json && json.error && json.error.code) err.code = json.error.code;
      throw err;
    }
    return json.data;
  }

  return {
    login: (username, password) => request('POST', '/api/login', { username, password }),
    logout: () => request('POST', '/api/logout'),
    me: () => request('GET', '/api/me'),

    overview: (sid) => request('GET', `/api/overview?sid=${encodeURIComponent(sid)}`),
    servers: () => request('GET', '/api/servers'),

    // 用户管理
    clients: (sid) => request('GET', `/api/servers/${sid}/clients`),
    kickClient: (sid, clid, reason) => request('POST', `/api/servers/${sid}/clients/${clid}/kick`, { reason }),
    banClient: (sid, clid, params) => request('POST', `/api/servers/${sid}/clients/${clid}/ban`, params),
    moveClient: (sid, clid, cid) => request('POST', `/api/servers/${sid}/clients/${clid}/move`, { cid }),
    pokeClient: (sid, clid, msg) => request('POST', `/api/servers/${sid}/clients/${clid}/poke`, { msg }),
    sendMessage: (sid, clid, msg) => request('POST', `/api/servers/${sid}/clients/${clid}/message`, { msg }),

    // 频道管理
    channels: (sid) => request('GET', `/api/servers/${sid}/channels`),
    createChannel: (sid, data) => request('POST', `/api/servers/${sid}/channels`, data),
    editChannel: (sid, cid, data) => request('PUT', `/api/servers/${sid}/channels/${cid}`, data),
    deleteChannel: (sid, cid) => request('DELETE', `/api/servers/${sid}/channels/${cid}`),

    // 部署管理
    deployStatus: (name) => request('GET', `/api/deploy/status${name ? '?name=' + encodeURIComponent(name) : ''}`),
    deployPreview: (p) => request('GET', '/api/deploy/preview?' + Object.keys(p || {}).map(k => `${k}=${encodeURIComponent(p[k] == null ? '' : p[k])}`).join('&')),
    deployCompose: (data) => request('POST', '/api/deploy/compose', data),
    deployUp: () => request('POST', '/api/deploy/up'),
    deployDown: () => request('POST', '/api/deploy/down'),
    deployRestart: () => request('POST', '/api/deploy/restart'),
    deployTask: (id) => request('GET', `/api/deploy/task/${id}`),
    deployLogs: (tail) => request('GET', `/api/deploy/logs?tail=${tail || 300}`),
    deployCredentials: () => request('GET', '/api/deploy/credentials'),
    deploySetApiKey: (key) => request('POST', '/api/deploy/apikey', { key }),
    deployGenerateKey: (body) => request('POST', '/api/deploy/apikey/generate', body || {}),
    deployCheck: () => request('GET', '/api/deploy/check'),
  };
})();
