'use strict';

/**
 * GET /api/servers — 虚拟服务器列表（顶部下拉框）。
 * 实例级命令 serverlist 字段：virtualserver_id / _name / _status / _clientsonline / _maxclients / _uptime
 */

const express = require('express');
const { ts } = require('../webquery');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const list = await ts.serverlist();
    const servers = (Array.isArray(list) ? list : []).map(s => ({
      id: Number(s.virtualserver_id),
      name: s.virtualserver_name || '',
      status: s.virtualserver_status || '',
      clients_online: Number(s.virtualserver_clientsonline || 0),
      max_clients: Number(s.virtualserver_maxclients || 0),
      uptime_seconds: Number(s.virtualserver_uptime || 0),
    }));
    res.json({ ok: true, data: servers });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
