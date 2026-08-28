'use strict';
// 验证「点歌机器人改名」支持端到端（真实 getBotChannel / getBotCurrentChannelServerSide）：
// 配置昵称 ts6mgrBotNickname='车载点播姬'，ts6-manager 里的机器人就叫这个名字（已改名），
//   客户端列表里该机器人在频道 cid=4。getBotChannel 应能按配置昵称识别出机器人并返回其频道。
// mock 全局 fetch 模拟 ts6-manager WebQuery。
// 运行：node test/bot-nickname.test.js（music 目录，需先 npm install）
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

// 配置：机器人已改名为「车载点播姬」
config.saveTsBridge({ ts6mgrBotNickname: '车载点播姬' });

function jr(o, s) { return { status: s || 200, json: async () => o, ok: () => (s || 200) < 400 }; }
global.fetch = async (url, opts) => {
  const m = (opts && opts.method) || 'GET';
  const u = String(url);
  if (u.includes('/api/auth/login')) return jr({ data: { token: 'T' } });
  if (u.includes('/api/music-bots')) return jr({ data: [{ id: 7, name: '车载点播姬', nickname: '车载点播姬', serverConfigId: 1, status: 'playing' }] });
  if (/\/api\/servers\/\d+\/virtual-servers/.test(u)) return jr({ data: [{ virtualserver_id: 1 }] });
  if (u.includes('/virtual-servers')) return jr({ data: [{ virtualserver_id: 1 }] });
  if (/\/api\/servers$/.test(u) && m === 'GET') return jr([{ id: 1, host: 'teamspeak', name: 'TS' }]);
  if (u.includes('/vs/1/clients')) return jr([{ nickname: '车载点播姬', client_nickname: '车载点播姬', cid: 4, channel_id: 4 }]);
  if (u.includes('/vs/1/channels') || u.includes('/channels')) return jr({
    data: [
      { cid: 1, pid: 0, channel_name: 'Default Channel', total_clients: 0 },
      { cid: 4, pid: 0, channel_name: '点歌专区', total_clients: 1, clients: [{ nickname: '车载点播姬', cid: 4 }] } ],
  });
  return jr({});
};

async function main() {
  const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));
  check('配置昵称已更新为「车载点播姬」', config.ts6mgrBotNickname === '车载点播姬', config.ts6mgrBotNickname);

  const ch = await tsbridge.getBotChannel();
  console.log('getBotChannel =', JSON.stringify(ch));
  check('按配置昵称识别出改名后的机器人频道', !!(ch && ch.cid === '4'), ch);
  check('频道名正确（点歌专区）', !!(ch && ch.name === '点歌专区'), ch);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('FATAL', e.message); process.exit(1); });