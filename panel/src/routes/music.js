'use strict';

/**
 * /api/music — 点歌机器人代理。
 * 把面板 /api/music/* 转发到 music-bot 服务（内网），保持面板登录鉴权。
 */

const http = require('http');
const express = require('express');
const { config } = require('../config');

const router = express.Router();

router.use('/', (req, res) => {
  const base = config.musicBaseUrl || 'http://music:3200';
  let upstream;
  try {
    upstream = new URL(base + req.originalUrl.replace(/^\/api\/music/, '/api'));
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: 'BAD_PROXY', message: '点歌服务地址配置错误' } });
  }

  const headers = JSON.parse(JSON.stringify(req.headers));
  headers.host = upstream.host;
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];

  const proxy = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: upstream.pathname + upstream.search,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 200, {
        'content-type': up.headers['content-type'] || 'application/json',
      });
      up.pipe(res);
    }
  );

  proxy.on('error', (e) => {
    if (res.headersSent) { proxy.destroy(); return; }
    res.status(502).json({ ok: false, error: { code: 'MUSIC_UNREACHABLE', message: '点歌服务不可用：' + e.message } });
  });

  const body = JSON.stringify(req.body || {});
  if (req.method !== 'GET' && body !== '{}') {
    proxy.setHeader('content-type', 'application/json');
    proxy.end(body);
  } else {
    proxy.end();
  }
});

module.exports = router;