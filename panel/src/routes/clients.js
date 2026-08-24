'use strict';

/**
 * /api/servers/:sid/clients — 用户管理
 *   GET    /                      在线用户列表（含频道名）
 *   POST   /:clid/kick            踢出 { reason, from: server|channel }
 *   POST   /:clid/ban             封禁 { reason, time 分钟, ipban }
 *   POST   /:clid/move            移动到频道 { cid }
 *   POST   /:clid/poke            Poke { msg }
 *   POST   /:clid/message         私聊 { msg }
 */

const express = require('express');
const { ts } = require('../webquery');

const router = express.Router({ mergeParams: true });

function sidOf(req) {
  return parseInt(req.params.sid, 10) || 1;
}

function mapClient(c) {
  return {
    clid: Number(c.clid),
    cid: Number(c.cid),
    nickname: c.client_nickname || '?',
    uid: c.client_unique_identifier || '',
    country: c.client_country || '',
    ping: c.connection_ping != null ? c.connection_ping : c.client_ping,
    connected_seconds: c.client_connected_time != null ? c.client_connected_time : c.connection_connected_time,
    idle_seconds: c.client_idle_time != null ? c.client_idle_time : c.connection_idle_time,
    away: c.client_away === 1 || c.client_away === '1',
    is_query: String(c.client_type) === '1',
  };
}

// 在线用户列表
router.get('/', async (req, res, next) => {
  try {
    const sid = sidOf(req);
    const [clients, channels] = await Promise.all([ts.clientlist(sid), ts.channellist(sid)]);
    const channelById = new Map(channels.map(c => [Number(c.cid), c]));
    const list = clients.map(c => {
      const m = mapClient(c);
      m.channel_name = (channelById.get(m.cid) || {}).channel_name || '';
      return m;
    });
    res.json({ ok: true, data: { clients: list } });
  } catch (err) {
    next(err);
  }
});

router.post('/:clid/kick', async (req, res, next) => {
  try {
    const { reason = '', from = 'server' } = req.body || {};
    await ts.kick(sidOf(req), parseInt(req.params.clid, 10), { reason, from });
    res.json({ ok: true, data: { kicked: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/ban', async (req, res, next) => {
  try {
    const { reason = '', time = 0, ipban = false } = req.body || {};
    // 面板 UI 以“分钟”为单位，WebQuery banclient 的 time 单位为秒
    const minutes = parseInt(time, 10);
    const seconds = isNaN(minutes) || minutes <= 0 ? 0 : minutes * 60;
    await ts.ban(sidOf(req), parseInt(req.params.clid, 10), { reason, time: seconds, ipban });
    res.json({ ok: true, data: { banned: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/move', async (req, res, next) => {
  try {
    const { cid } = req.body || {};
    if (!cid) throw Object.assign(new Error('缺少目标频道 cid'), { status: 400 });
    await ts.move(sidOf(req), parseInt(req.params.clid, 10), parseInt(cid, 10));
    res.json({ ok: true, data: { moved: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/poke', async (req, res, next) => {
  try {
    const { msg = '' } = req.body || {};
    if (!msg) throw Object.assign(new Error('缺少 Poke 消息'), { status: 400 });
    await ts.poke(sidOf(req), parseInt(req.params.clid, 10), msg);
    res.json({ ok: true, data: { poked: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/message', async (req, res, next) => {
  try {
    const { msg = '' } = req.body || {};
    if (!msg) throw Object.assign(new Error('缺少消息内容'), { status: 400 });
    await ts.sendTextMessage(sidOf(req), parseInt(req.params.clid, 10), msg);
    res.json({ ok: true, data: { sent: true } });
  } catch (err) { next(err); }
});

module.exports = router;
