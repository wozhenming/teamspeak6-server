'use strict';
// 验证修复：tsbridge.getBotCurrentChannelServerSide 优先用 ts6-manager 记录的 bot clid 定位，
// 避免普通用户改名「点歌机器人」造成跟随到错误频道。
// 场景：真机器人 clid=123 在频道4（点歌专区）；冒充者 clid=200 也叫「点歌机器人」在频道3（闲聊）。
process.env.MUSIC_DATA_DIR = '/tmp/data';
delete process.env.TS_CHAT_BOT_NICKNAME;
process.env.TS6MGR_URL = 'http://ts6mgr-mock:3001';
process.env.TS6MGR_USER = 'u';
process.env.TS6MGR_PASS = 'p';
process.env.TS_API_KEY = 'k';
process.env.TS_HOST = 'teamspeak';
const path = require('path');
const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };

config.saveTsBridge({ ts6mgrBotNickname: '点歌机器人' });

function jr(o, s) { return { status: s || 200, json: async () => o, ok: () => (s || 200) < 400 }; }
global.fetch = async (url, opts) => {
  const m = (opts && opts.method) || 'GET';
  const u = String(url);
  if (u.includes('/api/auth/login')) return jr({ data: { token: 'T' } });
  // ts6-manager 里的机器人（真机器人，name=点歌机器人，clid=123 稳定身份）
  if (u.includes('/api/music-bots')) return jr({ data: [{ id: 7, name: '点歌机器人', nickname: '点歌机器人', clid: 123, serverConfigId: 1, status: 'playing' }] });
  if (u.includes('/virtual-servers')) return jr({ data: [{ virtualserver_id: 1 }] });
  if (/\/api\/servers$/.test(u) && m === 'GET') return jr([{ id: 1, host: 'teamspeak', name: 'TS' }]);
  // 客户端列表：冒充者(叫「点歌机器人」clid=200)在 cid=3 排在前面；真机器人(clid=123)在 cid=4
  if (u.includes('/vs/1/clients')) return jr([
    { nickname: '点歌机器人', client_nickname: '点歌机器人', clid: 200, client_id: 200, cid: 3, channel_id: 3 },
    { nickname: '点歌机器人', client_nickname: '点歌机器人', clid: 123, client_id: 123, cid: 4, channel_id: 4 },
  ]);
  if (u.includes('/vs/1/channels') || u.includes('/channels')) return jr({
    data: [
      { cid: 1, pid: 0, channel_name: 'Default Channel', total_clients: 0 },
      { cid: 3, pid: 0, channel_name: '闲聊', total_clients: 1, clients: [] },
      { cid: 4, pid: 0, channel_name: '点歌专区', total_clients: 1, clients: [{ nickname: '点歌机器人', clid: 123 }] } ],
  });
  return jr({});
};

async function main() {
  const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));
  const ch = await tsbridge.getBotChannel();
  console.log('getBotChannel =', JSON.stringify(ch));
  check('定位到真正机器人频道 cid=4（clid 优先，不受同名干扰）', ch && String(ch.cid) === '4', ch);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });