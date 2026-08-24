'use strict';

/**
 * 模拟 TeamSpeak 6 WebQuery 服务器（开发/测试用，无需真实 TS6）。
 *
 * 用法：
 *   node test/mock-webquery.js            # 监听 10080
 *   node test/mock-webquery.js 10081      # 指定端口
 *
 * 行为（对齐 ts6-manager 确认的协议）：
 *   - 校验 x-api-key 头（默认 test-api-key）
 *   - URL: /{sid}/{command}，参数走 query string
 *   - 响应: { status: { code, message }, body: [...] }
 *   - 记录收到的命令到 stdout（[mock] 前缀）
 */

const http = require('http');

const PORT = parseInt(process.argv[2], 10) || 10080;
const API_KEY = process.env.MOCK_API_KEY || 'test-api-key';

// ---------- 模拟数据 ----------
const channels = [
  { cid: 1, pid: 0, channel_name: 'Lobby', channel_topic: 'Welcome!', channel_order: 0,
    channel_maxclients: -1, channel_flag_password: 0, channel_flag_permanent: 1, clients: 2, total_clients: 2 },
  { cid: 2, pid: 1, channel_name: 'Secret Room', channel_topic: '', channel_order: 1,
    channel_maxclients: 5, channel_flag_password: 1, channel_flag_permanent: 1, clients: 0, total_clients: 0 },
  { cid: 3, pid: 0, channel_name: 'Gaming', channel_topic: '', channel_order: 2,
    channel_maxclients: -1, channel_flag_password: 0, channel_flag_permanent: 1, clients: 1, total_clients: 1 },
];

const clients = [
  { clid: 1, cid: 1, client_nickname: 'Alice', client_unique_identifier: 'uid-alice-001',
    client_type: '0', client_country: 'CN', connection_ping: 21, client_connected_time: 3600, client_idle_time: 120 },
  { clid: 2, cid: 3, client_nickname: 'Bob', client_unique_identifier: 'uid-bob-002',
    client_type: '0', client_country: 'DE', connection_ping: 88, client_connected_time: 180, client_idle_time: 5 },
  { clid: 3, cid: 1, client_nickname: 'serveradmin', client_unique_identifier: 'serveradmin',
    client_type: '1', client_country: '', connection_ping: 0, client_connected_time: 7200, client_idle_time: 0 },
];

let channelSeq = 100;

function ok(body) {
  return { status: { code: 0, message: 'ok' }, body };
}
function err(code, message) {
  return { status: { code, message }, body: [] };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname; // e.g. /1/clientlist 或 /version
  const params = Object.fromEntries(url.searchParams.entries());

  // 认证
  if (req.headers['x-api-key'] !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(err(256, 'invalid api key')));
    return;
  }

  const parts = path.split('/').filter(Boolean); // ['1','clientlist'] | ['version']
  const sid = parts.length > 1 ? Number(parts[0]) : 0;
  const command = parts.length > 1 ? parts[1] : parts[0];
  console.log(`[mock] ${req.method} /${sid}/${command}`, JSON.stringify(params));

  let body;
  switch (command) {
    case 'version':
      body = ok({ version: '6.0.0-beta.5', platform: 'Linux' });
      break;
    case 'whoami':
      body = ok({ whoami: { id: 1, client_login_name: 'serveradmin', client_unique_identifier: 'serveradmin' } });
      break;
    case 'serverlist':
      body = ok([{ virtualserver_id: 1, virtualserver_name: 'Test Server', virtualserver_status: 'online',
        virtualserver_clientsonline: 2, virtualserver_maxclients: 32, virtualserver_uptime: 86400 }]);
      break;
    case 'serverinfo':
      body = ok([{ virtualserver_name: 'Test Server', virtualserver_status: 'online', virtualserver_platform: 'Linux',
        virtualserver_version: '6.0.0-beta.5', virtualserver_clientsonline: 2, virtualserver_maxclients: 32,
        virtualserver_uptime: 86400, virtualserver_created: 1700000000,
        virtualserver_total_packetloss_total: 0.12, virtualserver_total_ping: 25,
        connection_bandwidth_sent: 100000000, connection_bandwidth_received: 50000000 }]);
      break;
    case 'serverrequestconnectioninfo':
      body = ok([{ connection_bandwidth_sent_last_second_total: 2048, connection_bandwidth_received_last_second_total: 1024 }]);
      break;
    case 'clientlist': {
      // 模拟真实 TS6：带 flag 参数才返回扩展字段（uid/国家/时长/空闲等）
      const hasFlags = Object.keys(params).some((k) => k.startsWith('-'));
      if (hasFlags) {
        body = ok(clients);
      } else {
        body = ok(clients.map((c) => ({
          clid: String(c.clid), cid: String(c.cid),
          client_database_id: String(c.clid),
          client_nickname: c.client_nickname, client_type: c.client_type,
        })));
      }
      break;
    }
    case 'clientinfo':
      body = ok([{ ...clients[0], connection_client_ip: '203.0.113.7' }]);
      break;
    case 'channellist': {
      // 模拟真实 TS6：带 flag 参数才返回密码/主题等扩展字段
      const hasFlags = Object.keys(params).some((k) => k.startsWith('-'));
      if (hasFlags) {
        body = ok(channels);
      } else {
        body = ok(channels.map((ch) => ({
          cid: String(ch.cid), pid: String(ch.pid),
          channel_name: ch.channel_name, channel_order: String(ch.channel_order),
          total_clients: String(ch.total_clients),
        })));
      }
      break;
    }
    case 'channelcreate':
      channelSeq += 1;
      body = ok([{ cid: channelSeq }]);
      break;
    case 'serveredit':
      body = ok([]);
      break;
    case 'channeledit':
    case 'channeldelete':
    case 'clientkick':
    case 'banclient':
    case 'banadd':
    case 'clientmove':
    case 'clientpoke':
    case 'sendtextmessage':
      body = ok([]);
      break;
    case 'nope':
      body = err(1792, 'command not found');
      break;
    default:
      body = err(1792, `unknown command: ${command}`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] TS6 WebQuery mock listening on http://127.0.0.1:${PORT} (api key: ${API_KEY})`);
});
