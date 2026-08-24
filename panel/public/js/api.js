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
      throw new Error(msg);
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
  };
})();
