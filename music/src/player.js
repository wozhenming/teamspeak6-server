'use strict';

/**
 * 播放器状态机：维护"当前播放"的进度、暂停/播放、上一首/下一首、循环模式。
 *
 * - 队列本身只是歌曲列表；本模块在其上维护 currentId 指针
 * - 进度按时间推算（basePosition + 流逝时间），读取时惰性计算
 * - 歌曲自然播完时按循环模式自动切歌（one 重播 / all 绕回 / off 停止）
 * - 状态持久化到数据卷；服务重启后恢复当前曲目但保持暂停
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const queue = require('./queue');

const LOOP_MODES = ['all', 'one', 'shuffle', 'off'];
const stateFile = path.join(config.dataDir, 'player.json');

let state = {
  currentId: null,
  basePosition: 0,
  updatedAt: 0,
  playing: false,
  loopMode: 'all',
};

// 状态版本号：任何会影响实际出声的操作(播放/暂停/切歌/seek/循环)都自增，
// 电台流据此感知变化并重启转码进程（如带 -ss 跳转）
let rev = 0;

function load() {
  try {
    if (!fs.existsSync(stateFile)) return;
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      state.currentId = raw.currentId != null ? Number(raw.currentId) : null;
      state.basePosition = Number(raw.position) || 0;
      state.loopMode = LOOP_MODES.includes(raw.loopMode) ? raw.loopMode : 'all';
    }
  } catch (e) { /* 忽略 */ }
  // 重启后不自动续播，停在保存的进度上
  state.playing = false;
  state.updatedAt = Date.now();
  // 当前曲目已不在队列则丢弃指针
  if (state.currentId != null && !currentItem()) state.currentId = null;
}

function save() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      currentId: state.currentId,
      position: Math.round(positionSec()),
      playing: state.playing,
      loopMode: state.loopMode,
    }), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function currentItem() {
  return queue.all().find((i) => Number(i.id) === Number(state.currentId)) || null;
}

function durationOf(item) {
  return item && item.duration > 0 ? item.duration : 0;
}

// 有效进度（秒），已按时长截断
function positionSec() {
  if (!state.currentId) return 0;
  let pos = state.playing
    ? state.basePosition + (Date.now() - state.updatedAt) / 1000
    : state.basePosition;
  const dur = durationOf(currentItem());
  if (dur > 0 && pos > dur) pos = dur;
  if (pos < 0) pos = 0;
  return pos;
}

function playItem(id) {
  const item = queue.all().find((i) => Number(i.id) === Number(id));
  state.currentId = item ? Number(item.id) : null;
  state.basePosition = 0;
  state.updatedAt = Date.now();
  state.playing = !!item;
  rev++;
  save();
  return currentItem();
}

function stopInternal() {
  state.currentId = null;
  state.basePosition = 0;
  state.updatedAt = Date.now();
  state.playing = false;
  rev++;
  save();
}

// 随机取一首（排除当前曲，仅一首时退化为自身）
function pickRandomId(excludeId) {
  const items = queue.all();
  if (!items.length) return null;
  const pool = items.filter((i) => Number(i.id) !== Number(excludeId));
  const cand = pool.length ? pool : items;
  return Number(cand[Math.floor(Math.random() * cand.length)].id);
}

// dir=1 下一曲 dir=-1 上一曲；到边界时按 wrap 决定绕回或停止
// 随机模式忽略方向与边界，直接跳到随机曲目（排除当前曲）
function step(dir, wrap) {
  if (state.loopMode === 'shuffle') {
    const rid = pickRandomId(state.currentId);
    if (rid == null) return stopInternal();
    return playItem(rid);
  }
  const items = queue.all();
  if (!items.length) return stopInternal();
  const idx = items.findIndex((i) => Number(i.id) === Number(state.currentId));
  let nextIdx;
  if (idx === -1) nextIdx = dir > 0 ? 0 : items.length - 1;
  else nextIdx = idx + dir;
  if (nextIdx >= items.length) nextIdx = (wrap || state.loopMode === 'all') ? 0 : -1;
  else if (nextIdx < 0) nextIdx = (wrap || state.loopMode === 'all') ? items.length - 1 : (idx === -1 ? 0 : idx);
  if (nextIdx < 0 || nextIdx >= items.length) return stopInternal();
  return playItem(items[nextIdx].id);
}

// 自然播完后的自动切换：one 重播当前，shuffle 随机，all 绕回下一首，off 到队尾停止
function autoAdvance() {
  if (!state.currentId || !state.playing) return;
  const cur = currentItem();
  if (!cur) return stopInternal();
  const dur = durationOf(cur);
  if (dur <= 0) return; // 无时长信息不自动切
  const elapsed = state.basePosition + (Date.now() - state.updatedAt) / 1000;
  if (elapsed < dur) return;
  if (state.loopMode === 'one') playItem(cur.id);
  else if (state.loopMode === 'shuffle') {
    const rid = pickRandomId(cur.id);
    if (rid != null) playItem(rid);
  } else step(1, state.loopMode === 'all');
}

// ---------- 对外接口 ----------

function get() {
  autoAdvance();
  return {
    current: currentItem(),
    position: Math.round(positionSec()),
    playing: !!state.playing && !!currentItem(),
    loopMode: state.loopMode,
    queueLength: queue.all().length,
    rev,
  };
}

// 播放指定曲目；不带 id 则继续播放当前/队首
function play(id) {
  if (id != null) return { ...get(), current: playItem(id), playing: true };
  if (!state.currentId) {
    const first = queue.all()[0];
    if (!first) return get();
    return { ...get(), current: playItem(first.id), playing: true };
  }
  if (!state.playing) {
    state.updatedAt = Date.now();
    state.playing = true;
    rev++;
    save();
  }
  return get();
}

function pause() {
  if (!state.playing) return get();
  state.basePosition = positionSec();
  state.playing = false;
  state.updatedAt = Date.now();
  rev++;
  save();
  return get();
}

function resume() {
  if (state.playing) return get();
  if (!state.currentId) return play();
  state.basePosition = positionSec();
  state.updatedAt = Date.now();
  state.playing = true;
  rev++;
  save();
  return get();
}

function toggle() {
  return state.playing ? pause() : resume();
}

// 跳转到指定秒数
function seek(sec) {
  if (!state.currentId) return get();
  const dur = durationOf(currentItem());
  let pos = Number(sec);
  if (!Number.isFinite(pos)) pos = 0;
  if (dur > 0) pos = Math.min(pos, dur);
  if (pos < 0) pos = 0;
  state.basePosition = pos;
  state.updatedAt = Date.now();
  rev++;
  save();
  return get();
}

// 手动切歌：one/all 模式到边界绕回，off 模式到边界停止
function next() { step(1, state.loopMode !== 'off'); return get(); }
function prev() { step(-1, state.loopMode !== 'off'); return get(); }

function setLoop(mode) {
  if (!LOOP_MODES.includes(mode)) return get();
  // 注意：循环模式只影响“播完后的切歌方式”，不改变当前出声，
  // 因此这里绝不能 bump rev（否则电台流会被无谓重启，产生电音毛刺）
  if (state.loopMode !== mode) { state.loopMode = mode; save(); }
  return get();
}

// 队列变化后校正指针：当前曲目被删则接管它原来位置的下一首，队列空则停止
function onQueueChanged(removedId) {
  if (removedId == null) { stopInternal(); return; }
  if (Number(removedId) !== Number(state.currentId)) return;
  const items = queue.all();
  if (!items.length) return stopInternal();
  const fallback = items.find((i) => Number(i.id) !== Number(removedId));
  if (!fallback) return stopInternal();
  if (state.playing) playItem(fallback.id);
  else {
    state.currentId = Number(fallback.id);
    state.basePosition = 0;
    rev++;
    save();
  }
}

module.exports = {
  load,
  save,
  get,
  play,
  pause,
  resume,
  toggle,
  seek,
  next,
  prev,
  setLoop,
  onQueueChanged,
};
