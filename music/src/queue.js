'use strict';

/**
 * 点歌队列（内存 + 持久化到数据卷）。
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const queueFile = path.join(config.dataDir, 'queue.json');
let seq = 1;
let items = []; // { id, title, artists, album, cover, duration, requestedBy, requestedAt }

// 队列变化监听（播放器据此校正"当前播放"指针）
const listeners = [];
function onChange(cb) {
  if (typeof cb === 'function') listeners.push(cb);
}
function emitChange(removedId) {
  for (const cb of listeners) {
    try { cb(removedId); } catch (e) { /* 忽略 */ }
  }
}

function load() {
  try {
    if (!fs.existsSync(queueFile)) return;
    const arr = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    if (Array.isArray(arr)) {
      items = arr.filter((i) => i && i.id);
      seq = items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
    }
  } catch (e) { /* 忽略 */ }
}

function save() {
  try {
    fs.writeFileSync(queueFile, JSON.stringify(items), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function all() {
  return items;
}

function enqueue(song, requestedBy) {
  const item = {
    id: seq++,
    songId: song.songId || song.id || null, // 网易云真实歌曲 ID（取直链必需，勿丢！）
    title: song.name,
    artists: song.artists || '',
    album: song.album || '',
    cover: song.cover || '',
    duration: song.duration || 0,
    requestedBy: requestedBy || 'panel',
    requestedAt: Date.now(),
  };
  items.push(item);
  save();
  return item;
}

// 批量入队（歌单全量加入），返回新增条目数组
function enqueueMany(songs, requestedBy) {
  const added = (Array.isArray(songs) ? songs : [])
    .filter((s) => s && s.id && s.name)
    .map((song) => ({
      id: seq++,
      songId: song.songId || song.id || null, // 网易云真实歌曲 ID
      title: song.name,
      artists: song.artists || '',
      album: song.album || '',
      cover: song.cover || '',
      duration: song.duration || 0,
      requestedBy: requestedBy || 'panel',
      requestedAt: Date.now(),
    }));
  if (added.length) {
    items.push(...added);
    save();
  }
  return added;
}

function remove(id) {
  const before = items.length;
  items = items.filter((i) => Number(i.id) !== Number(id));
  const removed = items.length !== before;
  if (removed) {
    save();
    emitChange(id);
  }
  return removed;
}

function clear() {
  const had = items.length > 0;
  items = [];
  save();
  if (had) emitChange(null);
}

module.exports = { load, save, all, enqueue, enqueueMany, remove, clear, onChange };