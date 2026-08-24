'use strict';

/**
 * TeamSpeak 6 SSH Query 客户端（基于 ssh2，纯 JS 实现）。
 *
 * 用途：面板在前端"一键生成 API Key"——直连 TS6 的 SSH Query (10022)，
 * 以 serveradmin 身份执行命令（如 apikeyadd scope=manage lifetime=0）。
 *
 * 协议要点（已实测）：
 *  - TS6 SSH Query 不接受 exec 模式（exec request failed）与 PTY
 *    （PTY allocation request failed），只接受无 PTY 的交互式 shell；
 *  - 连接建立后直接向 stdin 写入命令即可，输出从 stdout 读取。
 */

const { Client } = require('ssh2');

/**
 * 通过 SSH Query 执行一组命令，返回完整输出文本。
 * @param {object} opts { host, port, username, password, commands, timeoutMs }
 * @returns {Promise<string>}
 */
function runQuery({ host, port = 10022, username = 'serveradmin', password, commands = [], timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch (e) { /* 忽略 */ }
      err ? reject(err) : resolve(result);
    };

    const timer = setTimeout(() => finish(new Error(`SSH Query 超时（${host}:${port}）`)), timeoutMs);

    conn.on('ready', () => {
      conn.shell(false, (err, stream) => {
        if (err) return finish(err);
        stream.on('close', () => finish(null, out));
        stream.on('data', (d) => { out += d.toString(); });
        stream.on('error', () => { /* 输出流错误不中断 */ });
        // 等待欢迎信息后逐条发送命令
        setTimeout(() => {
          for (const cmd of commands) stream.write(cmd + '\n');
          setTimeout(() => stream.write('quit\n'), 400);
        }, 500);
      });
    });

    conn.on('error', (e) => finish(e));

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 10000,
      keepaliveInterval: 5000,
    });
  });
}

/** 从 SSH Query 输出中解析 apikey=xxx */
function extractApiKey(output) {
  const m = String(output).match(/apikey=([^\s]+)/);
  return m ? m[1] : null;
}

module.exports = { runQuery, extractApiKey };
