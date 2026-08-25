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

function remove(id) {
  const before = items.length;
  items = items.filter((i) => Number(i.id) !== Number(id));
  if (items.length !== before) save();
  return items.length !== before;
}

function clear() {
  items = [];
  save();
}

module.exports = { load, save, all, enqueue, remove, clear };