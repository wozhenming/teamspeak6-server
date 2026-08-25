'use strict';

/**
 * 单调计数器快照平滑（TS6 WebQuery 公共工具）。
 *
 * 实测 TS6 的 client_idle_time / connection_connected_time 均为周期性快照，
 * 两次请求间可能凭空跳变数十分钟（实测 idle 3 秒内 +3000 秒）。
 * 平滑规则：
 *  - 未重置（raw >= 上次值）：展示 min(raw, 上次值 + 真实流逝时间)
 *  - 已重置（raw < 上次值，如用户活动/重连）：直接展示 raw
 */

const counterCache = new Map(); // key -> { value, at }

function smoothCounter(key, raw) {
  const now = Date.now();
  if (raw == null || raw === '') {
    counterCache.delete(key);
    return null;
  }
  const seconds = Number(raw);
  const prev = counterCache.get(key);
  if (prev && seconds >= prev.value) {
    const estimated = prev.value + Math.floor((now - prev.at) / 1000);
    const shown = Math.min(seconds, estimated);
    counterCache.set(key, { value: shown, at: now });
    return shown;
  }
  counterCache.set(key, { value: seconds, at: now });
  return seconds;
}

// idle 与连接时长分别计数（同一 clid 两个计数器，用前缀区分）
const smoothIdle     = (clid, raw) => smoothCounter('i:' + clid, raw);
const smoothConnected = (clid, raw) => smoothCounter('c:' + clid, raw);

module.exports = { smoothCounter, smoothIdle, smoothConnected };
