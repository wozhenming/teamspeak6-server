'use strict';

/**
 * 网易云音乐 API 客户端（对接 api-enhanced）。
 *
 * - 维护 cookie jar（扫码登录产生），持久化到数据卷，重启不丢
 * - 提供：扫码登录、登录状态、歌曲/歌单搜索、歌曲 URL、歌单内容
 * - 所有请求走后端代理（内网），不暴露 api-enhanced 端口
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { config } = require('./config');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

// ---------- Cookie jar ----------
const cookieFile = path.join(config.dataDir, 'cookie.txt');
const cookies = new Map(); // name -> value

function loadCookies() {
  try {
    if (!fs.existsSync(cookieFile)) return;
    const raw = fs.readFileSync(cookieFile, 'utf8');
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  } catch (e) { /* 忽略 */ }
}

function saveCookies() {
  try {
    const str = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    fs.writeFileSync(cookieFile, str, 'utf8');
  } catch (e) { /* 忽略 */ }
}

// 吸收 Set-Cookie 头
function absorb(setCookieHeader) {
  if (!setCookieHeader) return;
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of parts) {
    const seg = c.split(';')[0]; // name=value
    const idx = seg.indexOf('=');
    if (idx > 0) {
      const name = seg.slice(0, idx).trim();
      const value = seg.slice(idx + 1).trim();
      if (name === 'MUSIC_U' || name === 'os' || name === 'osver' || name === 'appver' ||
          name === 'NMTID' || name === 'MUSIC_A_T' || name === 'MUSIC_A_N' || name === '__csrf') {
        cookies.set(name, value);
      }
    }
  }
  saveCookies();
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------- 基础请求 ----------
async function req(pathname, { method = 'GET', qs = {} } = {}) {
  const url = new URL(config.apiBase + pathname);
  qs.timestamp = Date.now(); // 防缓存
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = {
    'User-Agent': UA,
    Referer: 'https://music.163.com',
    Accept: 'application/json',
    Cookie: cookieHeader(),
  };
  let res;
  try {
    res = await fetch(url, { method, headers });
  } catch (e) {
    throw new Error(`无法连接网易云 API（${config.apiBase}）：${e.message}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) absorb(setCookie);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { code: -1, message: text.slice(0, 200) }; }
  return json;
}

// ---------- 扫码登录 ----------
async function anonymousToken() {
  return req('/register/anonymous', { method: 'POST' });
}

// 生成登录二维码，返回 Base64 图片数据
async function qrCreate() {
  await anonymousToken().catch(() => {});
  const keyRes = await req('/login/qr/key');
  const key = keyRes && keyRes.data && keyRes.data.unikey;
  if (!key) throw new Error('获取二维码 key 失败：' + JSON.stringify(keyRes).slice(0, 200));
  const createRes = await req('/login/qr/create', { qs: { key, qrimg: 'true', noloading: 'true' } });
  const data = createRes && createRes.data;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(data.qrurl || '');
  } catch (e) { /* 二维码库失败则跳过 */ }
  return { key, qrurl: data.qrurl, unikey: data.unikey, qrDataUrl };
}

// 轮询扫码状态: 800 过期 / 801 等待 / 802 已扫未确认 / 803 成功
async function qrCheck(key) {
  const res = await req('/login/qr/check', { qs: { key, noloading: 'true' } });
  return { code: res.code, message: res.message || (res.data && res.data.message) || '' };
}

async function loginStatus() {
  const res = await req('/login/status');
  return res;
}

// ---------- 搜索 ----------
const SEARCH_TYPES = { song: 1, playlist: 1000, album: 10, artist: 100, singer: 100 };
async function search(keywords, type = 'song', limit = 20, offset = 0) {
  const typeId = SEARCH_TYPES[type] || 1;
  const res = await req('/cloudsearch', { qs: { keywords, type: typeId, limit, offset } });
  return res.result || { songs: [], playlists: [] };
}

// ---------- 歌曲 / 歌单 ----------
async function songDetail(ids) {
  const res = await req('/song/detail', { qs: { ids: Array.isArray(ids) ? ids.join(',') : String(ids) } });
  return res;
}

async function songUrl(id, level = 'standard') {
  const res = await req('/song/url/v1', { qs: { id, level } });
  const arr = (res.data && Array.isArray(res.data)) ? res.data : ((res.data && res.data[0]) ? [res.data[0]] : []);
  const item = arr[0] || {};
  return { url: item.url || '', br: item.br || 0, size: item.size || 0, type: item.type || '' };
}

async function playlist(id) {
  const res = await req('/playlist/detail', { qs: { id } });
  return res;
}

async function playlistTracks(id, limit = 60, offset = 0) {
  const res = await req('/playlist/track/all', { qs: { id, limit, offset } });
  return (res.songs || []).map(s => ({
    id: s.id,
    name: s.name,
    artists: (s.ar || []).map(a => a.name).join(' '),
    album: (s.al || {}).name || '',
    duration: s.dt ? Math.round(s.dt / 1000) : 0,
  }));
}

module.exports = {
  qrCreate,
  qrCheck,
  loginStatus,
  search,
  songDetail,
  songUrl,
  playlist,
  playlistTracks,
};