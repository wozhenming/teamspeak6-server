'use strict';

/**
 * /api/servers/:sid/channels — 频道管理
 *   GET     /             频道列表（含在线用户数与成员）
 *   POST    /             创建频道 { name, parent_cid, order, max_clients, password, topic }
 *   PUT     /:cid         编辑频道（名称/主题/密码/最大用户/排序）
 *   DELETE  /:cid         删除频道（force=1）
 */

const express = require('express');
const { ts } = require('../webquery');

const router = express.Router({ mergeParams: true });

function sidOf(req) {
  return parseInt(req.params.sid, 10) || 1;
}

function mapChannel(ch) {
  return {
    cid: Number(ch.cid),
    pid: Number(ch.pid || 0),
    order: Number(ch.channel_order || 0),
    name: ch.channel_name || '',
    topic: ch.channel_topic || '',
    max_clients: Number(ch.channel_maxclients != null ? ch.channel_maxclients : -1),
    has_password: ch.channel_flag_password === 1 || ch.channel_flag_password === '1',
    is_permanent: ch.channel_flag_permanent === 1 || ch.channel_flag_permanent === '1',
    clients: Number(ch.clients != null ? ch.clients : 0),
    total_clients: Number(ch.total_clients || 0),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const sid = sidOf(req);
    const [rawChannels, clients] = await Promise.all([ts.channellist(sid), ts.clientlist(sid)]);
    const channels = rawChannels.map(mapChannel);
    const mappedClients = clients.map(c => ({
      clid: Number(c.clid),
      cid: Number(c.cid),
      nickname: c.client_nickname || '?',
      idle_seconds: c.client_idle_time != null ? c.client_idle_time : c.connection_idle_time,
    }));
    res.json({ ok: true, data: { channels, clients: mappedClients } });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, parent_cid = 0, order = 0, max_clients = -1, password, topic } = req.body || {};
    if (!name || !String(name).trim()) {
      throw Object.assign(new Error('频道名称不能为空'), { status: 400 });
    }
    const body = await ts.createChannel(sidOf(req), {
      name: String(name).trim(),
      parent_cid,
      order,
      max_clients,
      password: password || undefined,
      topic: topic || undefined,
    });
    // channelcreate 返回 { cid } 或 [{ cid }]
    const arr = Array.isArray(body) ? body : [body];
    const cid = arr[0] && (arr[0].cid != null ? Number(arr[0].cid) : null);
    res.json({ ok: true, data: { cid } });
  } catch (err) { next(err); }
});

router.put('/:cid', async (req, res, next) => {
  try {
    const { name, topic, password, max_clients, order } = req.body || {};
    const opts = {};
    if (name !== undefined) opts.name = String(name).trim();
    if (topic !== undefined) opts.topic = topic;
    if (password !== undefined) opts.password = password || undefined;
    if (max_clients !== undefined) opts.max_clients = parseInt(max_clients, 10);
    if (order !== undefined) opts.order = parseInt(order, 10);
    await ts.editChannel(sidOf(req), parseInt(req.params.cid, 10), opts);
    res.json({ ok: true, data: { edited: true } });
  } catch (err) { next(err); }
});

router.delete('/:cid', async (req, res, next) => {
  try {
    await ts.deleteChannel(sidOf(req), parseInt(req.params.cid, 10));
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
