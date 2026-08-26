'use strict';

/**
 * 点歌页：网易云扫码登录 + 歌曲/歌单搜索 + 点歌队列 + 播放器控制。
 */

window.TSPages = window.TSPages || {};

TSPages.music = async function () {
  const content = document.getElementById('page-content');
  let searchType = 'song';
  let loginTimer = null;

  // 搜索分页状态
  let searchQ = '';
  let searchPage = 1;
  const searchPageSize = 20;

  // 队列分页/筛选状态
  let queueQ = '';
  let queuePage = 1;
  const queuePageSize = 10;

  // 播放器本地插值状态
  let playerState = { current: null, position: 0, playing: false, loopMode: 'all', queueLength: 0 };
  let playerTick = null;
  let pollTimer = null;
  let lastPollAt = 0;
  let seeking = false;

  // 页面卸载令牌：切换走后异步回调靠它放弃写 DOM
  const token = TSUtils.navToken();

  content.innerHTML = `
    <div id="music-alert"></div>

    <div class="card music-player" id="player-card">
      <h3><span>正在播放</span>
        <span class="muted" id="player-mode"></span>
      </h3>
      <div class="player-main">
        <img class="player-cover" id="player-cover" alt="" src="">
        <div class="player-info">
          <div class="player-title" id="player-title">未在播放</div>
          <div class="muted" id="player-artists"></div>
        </div>
        <div class="player-controls">
          <button class="btn btn-sm" id="btn-prev" title="上一首">${TSUtils.icons.prev}</button>
          <button class="btn btn-sm btn-primary" id="btn-toggle" title="播放/暂停">${TSUtils.icons.play}</button>
          <button class="btn btn-sm" id="btn-next" title="下一首">${TSUtils.icons.next}</button>
          <button class="btn btn-sm" id="btn-loop" title="循环模式">循环:列表</button>
        </div>
      </div>
      <div class="player-progress">
        <span id="player-pos">0:00</span>
        <input type="range" id="player-range" min="0" max="100" value="0" step="1">
        <span id="player-dur">0:00</span>
      </div>
    </div>

    <div class="card">
      <h3><span>TeamSpeak 推流</span>
        <span>
          <button class="btn btn-sm btn-primary" id="btn-ts-link">生成机器人</button>
          <button class="btn btn-sm" id="btn-ts-unlink">断开</button>
        </span>
      </h3>
      <div id="ts-status" class="muted" style="font-size:12.5px">未连接</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <span class="muted" style="font-size:12px">让点歌机器人加入的频道</span>
          <div style="display:flex;gap:8px">
            <select id="ts-channel" class="select" style="flex:1">
              <option value="">（加载频道中…）</option>
            </select>
            <button class="btn btn-sm" id="btn-ts-refresh" title="刷新频道列表">↻</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px">
          <span class="muted" style="font-size:12px">TeamSpeak WebQuery API Key</span>
          <input class="input" id="ts-key" type="password" placeholder="填入 apikeyadd 生成的 Key" style="flex:1">
        </div>
      </div>
      <div class="muted" style="font-size:11.5px;margin-top:8px">填好 Key、选好频道后点“生成机器人”，机器人会自动加入频道推流。</div>
    </div>

    <div class="card">
      <h3><span>网易云点歌</span>
        <span>
          <button class="btn btn-sm" id="btn-login">扫码登录</button>
        </span>
      </h3>
      <div id="login-state" class="muted" style="font-size:12.5px">未登录（登录后可播放受版权歌曲）</div>

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <input type="text" id="search-q" class="input" style="flex:1;min-width:200px" placeholder="搜索歌曲 / 歌单">
        <select id="search-type" class="select">
          <option value="song">歌曲</option>
          <option value="playlist">歌单</option>
        </select>
        <button class="btn btn-primary" id="btn-search">搜索</button>
      </div>
      <div id="search-results" style="margin-top:10px"><div class="empty">输入关键词搜索</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3><span>点歌队列 <span class="muted" id="queue-summary"></span></span>
        <button class="btn btn-sm btn-danger" id="btn-clear-queue">清空</button>
      </h3>
      <div class="list-toolbar">
        <input type="text" id="queue-q" class="input" style="flex:1;min-width:160px" placeholder="筛选队列（歌曲/歌手/点歌人）">
      </div>
      <div id="queue-list" style="margin-top:10px"><div class="empty">队列为空</div></div>
    </div>`;

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function thumb(cover) {
    if (!cover) return '';
    return `<img class="song-thumb" src="${API.musicImg(cover, '80y80')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  }
  function fmtDur(sec) {
    if (!sec) return '0:00';
    sec = Math.floor(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtNum(n) {
    if (!n) return '0';
    if (n > 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n > 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  // ---------- 通用分页条 ----------
  function pager(page, pages, onGo) {
    if (pages <= 1) return '';
    const mk = (label, p, dis) =>
      `<button class="btn btn-sm pager-btn" data-p="${p}" ${dis ? 'disabled' : ''}>${label}</button>`;
    return `<div class="pager">
      ${mk('«', 1, page === 1)}
      ${mk('‹', page - 1, page === 1)}
      <span class="pager-info">${page} / ${pages}</span>
      ${mk('›', page + 1, page >= pages)}
      ${mk('»', pages, page >= pages)}
    </div>`;
  }

  // ---------- 播放器 ----------
  function loopLabel(m) {
    return m === 'one' ? '循环:单曲' : m === 'shuffle' ? '循环:随机' : m === 'off' ? '循环:关' : '循环:列表';
  }

  function renderPlayer() {
    if (token !== TSUtils.navToken()) return;
    const st = playerState;
    $('player-cover').src = st.current && st.current.cover ? API.musicImg(st.current.cover, '112y112') : '';
    $('player-title').textContent = st.current ? st.current.title : '未在播放';
    $('player-artists').textContent = st.current ? (st.current.artists || '') : '';
    $('player-mode').textContent = st.queueLength ? `（队列 ${st.queueLength} 首）` : '';
    $('btn-toggle').innerHTML = st.playing ? TSUtils.icons.pause : TSUtils.icons.play;
    $('btn-loop').textContent = loopLabel(st.loopMode);
    const dur = st.current && st.current.duration ? st.current.duration : 0;
    $('player-range').max = dur || 0;
    if (!seeking) $('player-range').value = st.position || 0;
    $('player-pos').textContent = fmtDur(st.position || 0);
    $('player-dur').textContent = fmtDur(dur);
  }

  async function pollPlayer(force) {
    if (token !== TSUtils.navToken()) return;
    const now = Date.now();
    if (!force && now - lastPollAt < 800) return;
    lastPollAt = now;
    try {
      const d = await API.musicPlayer();
      playerState = d;
      renderPlayer();
    } catch (e) { /* 服务不可用 */ }
  }

  // 本地插值：每秒推进进度条
  function startTick() {
    if (playerTick) return;
    playerTick = TSUtils.setInterval(() => {
      if (token !== TSUtils.navToken()) { clearInterval(playerTick); playerTick = null; return; }
      const st = playerState;
      if (st.playing && st.current && !seeking) {
        const dur = st.current.duration || 0;
        let pos = st.position + 1;
        if (dur > 0 && pos >= dur) { pollPlayer(true); return; }
        st.position = pos;
        $('player-range').value = pos;
        $('player-pos').textContent = fmtDur(pos);
      }
    }, 1000);
  }

  async function refreshLogin() {
    if (token !== TSUtils.navToken()) return;
    try {
      const d = await API.musicStatus();
      const el = $('login-state');
      el.textContent = d.loggedIn ? '已登录网易云' : '未登录（登录后可播放受版权歌曲）';
      el.style.color = d.loggedIn ? 'var(--green)' : 'var(--text-muted)';
    } catch (e) { /* 服务不可用 */ }
  }

  // ---------- 扫码登录 ----------
  function openQrModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '网易云扫码登录';
    const body = document.getElementById('modal-body');
    body.innerHTML = '<div class="empty">正在生成二维码…</div>';
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; clearInterval(loginTimer); loginTimer = null; refreshLogin(); };
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    API.musicQrCreate().then((qr) => {
      body.innerHTML = `
        <div style="text-align:center">
          <img id="qr-img" src="${qr.qrDataUrl || ''}" alt="扫码" style="width:220px;height:220px;background:var(--bg);border:1px solid var(--border);border-radius:10px">
          <div class="muted" style="font-size:13px;margin-top:10px">请用网易云音乐 App 扫码，并在手机上确认登录</div>
          <div id="qr-status" class="muted" style="font-size:13px;margin-top:6px">等待扫码…</div>
        </div>
        <div class="modal-footer"><button class="btn" id="qr-close">完成</button></div>`;
      body.querySelector('#qr-close').onclick = close;
      if (qr.qrDataUrl) {
        loginTimer = TSUtils.setInterval(async () => {
          try {
            const r = await API.musicQrCheck(qr.key);
            const st = body.querySelector('#qr-status');
            if (!st) return;
            if (r.code === 803) {
              close();
              TSUtils.toast('登录成功', 'success');
            } else if (r.code === 802) {
              st.textContent = '已扫码，请在手机上确认登录…';
            } else if (r.code === 800) {
              st.textContent = '二维码已过期，请关闭重试';
              if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            } else {
              st.textContent = '等待扫码…';
            }
          } catch (e) { /* 忽略轮询错误 */ }
        }, 2500);
      } else {
        body.querySelector('#qr-status').textContent = '二维码生成失败：' + (qr.url ? '需要手动打开 ' + qr.url : '未知错误');
      }
    }).catch((e) => {
      body.innerHTML = `<div class="alert error">${esc(e.message)}</div><div class="modal-footer"><button class="btn" id="qr-close">关闭</button></div>`;
      body.querySelector('#qr-close').onclick = close;
    });
  }

  // ---------- 搜索 ----------
  async function doSearch(page) {
    if (page != null) searchPage = page;
    const q = $('search-q').value.trim();
    if (!q) return;
    searchQ = q;
    const box = $('search-results');
    box.innerHTML = '<div class="empty">搜索中…</div>';
    try {
      const d = await API.musicSearch(q, searchType, searchPageSize, (searchPage - 1) * searchPageSize);
      if (!d.items || !d.items.length) {
        box.innerHTML = '<div class="empty">未找到结果</div>';
        return;
      }
      const pages = Math.max(1, Math.ceil(d.total / searchPageSize));
      if (searchType === 'playlist') {
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 个歌单</div><div class="table-wrap"><table>
          <thead><tr><th>名称</th><th>曲目/播放</th><th>创建者</th><th class="actions">操作</th></tr></thead>
          <tbody>${d.items.map(p => `<tr>
            <td>${esc(p.name)}</td><td>${p.tracks} 首 · ${fmtNum(p.playCount)} 播放</td><td>${esc(p.creator)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-view="${p.id}" data-name="${esc(p.name)}">查看</button>
              <button class="btn btn-sm btn-primary" data-pl="${p.id}" data-name="${esc(p.name)}">加入队列</button>
            </td>
          </tr>`).join('')}</tbody></table></div>${pager(searchPage, pages, (p) => doSearch(p))}`;
      } else {
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 首</div><div class="table-wrap"><table>
          <thead><tr><th>歌曲</th><th>专辑</th><th class="num">时长</th><th class="actions">操作</th></tr></thead>
           <tbody>${d.items.map(s => `<tr>
             <td class="song-cell">${thumb(s.cover)}<span>${esc(s.name)} <span class="muted">- ${esc(s.artists)}</span></span></td>
             <td>${esc(s.album)}</td><td class="num">${fmtDur(s.duration)}</td>
            <td class="actions"><button class="btn btn-sm btn-primary" data-song='${JSON.stringify({ id: s.id, name: s.name, artists: s.artists, album: s.album, duration: s.duration, cover: s.cover }).replace(/"/g, '&quot;')}'>点歌</button></td>
          </tr>`).join('')}</tbody></table></div>${pager(searchPage, pages, (p) => doSearch(p))}`;
      }
    } catch (e) {
      box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  // ---------- 歌单浏览/全量入队 ----------
  async function openPlaylistModal(plId, plName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '歌单：' + plName;
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <div class="list-toolbar">
        <input type="text" class="input" id="pl-filter" placeholder="筛选本歌单曲目" style="flex:1;min-width:160px">
        <span class="muted" id="pl-count" style="font-size:12.5px"></span>
      </div>
      <div id="pl-list"><div class="empty">加载中…</div></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    let all = [];
    let page = 1;
    const pageSize = 20;
    try {
      const d = await API.musicPlaylistTracksAll(plId);
      all = d.tracks || [];
    } catch (e) {
      body.innerHTML = `<div class="alert error">${esc(e.message)}</div><div class="modal-footer"><button class="btn" onclick="document.getElementById('modal-close').click()">关闭</button></div>`;
      return;
    }

    function render() {
      const kw = (body.querySelector('#pl-filter').value || '').trim().toLowerCase();
      const list = kw
        ? all.filter((t) => [t.name, t.artists, t.album].join(' ').toLowerCase().includes(kw))
        : all;
      const pages = Math.max(1, Math.ceil(list.length / pageSize));
      if (page > pages) page = pages;
      const start = (page - 1) * pageSize;
      body.querySelector('#pl-count').textContent = `共 ${all.length} 首` + (kw ? `，匹配 ${list.length} 首` : '');
      const box = body.querySelector('#pl-list');
      if (!list.length) { box.innerHTML = '<div class="empty">无匹配曲目</div>'; return; }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>歌曲</th><th>专辑</th><th class="num">时长</th><th class="actions">操作</th></tr></thead>
        <tbody>${list.slice(start, start + pageSize).map(t => `<tr>
           <td class="song-cell">${thumb(t.cover)}<span>${esc(t.name)} <span class="muted">- ${esc(t.artists)}</span></span></td>
             <td>${esc(t.album)}</td><td class="num">${fmtDur(t.duration)}</td>
           <td class="actions"><button class="btn btn-sm btn-primary" data-add='${JSON.stringify({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover }).replace(/"/g, '&quot;')}'>点歌</button></td>
        </tr>`).join('')}</tbody></table></div>${pager(page, pages, (p) => { page = p; render(); })}
        <div class="modal-footer">
          <button class="btn btn-primary" id="pl-add-all">全部加入队列（${all.length}）</button>
          <button class="btn" onclick="document.getElementById('modal-close').click()">关闭</button>
        </div>`;
      box.querySelector('#pl-add-all').onclick = async () => {
        try {
          const r = await API.musicEnqueueMany(all.map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover })));
          TSUtils.toast(`已加入 ${r.count} 首`, 'success');
          refreshQueue();
        } catch (err) { TSUtils.toast(err.message, 'error'); }
      };
    }

    body.querySelector('#pl-filter').addEventListener('input', () => { page = 1; render(); });
    render();
  }

  // ---------- 队列 ----------
  async function refreshQueue() {
    if (token !== TSUtils.navToken()) return;
    try {
      const d = await API.musicQueue(queuePage, queuePageSize, queueQ);
      const items = d.items || [];
      $('queue-summary').textContent = `（共 ${d.total} 首）`;
      const box = $('queue-list');
      if (!items.length) {
        if (d.page > 1) { queuePage = d.page - 1; return refreshQueue(); }
        box.innerHTML = '<div class="empty">队列为空</div>';
        return;
      }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>歌曲</th><th>点歌人</th><th class="actions">操作</th></tr></thead>
        <tbody>${items.map((it, i) => `<tr>
          <td>${i + 1}</td>
           <td class="song-cell">${thumb(it.cover)}<span>${esc(it.title)} <span class="muted">- ${esc(it.artists)}</span></span></td>
          <td>${esc(it.requestedBy)}</td>
          <td class="actions">
            <button class="btn btn-sm" data-play="${it.id}">播放</button>
            <button class="btn btn-sm btn-danger" data-del="${it.id}">移除</button>
          </td>
        </tr>`).join('')}</tbody></table></div>${pager(d.page, d.pages, (p) => { queuePage = p; refreshQueue(); })}`;
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 事件 ----------
  $('btn-login').onclick = openQrModal;
  $('btn-search').onclick = () => { searchPage = 1; doSearch(); };
  $('search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { searchPage = 1; doSearch(); } });
  $('search-type').onchange = (e) => { searchType = e.target.value; searchPage = 1; };
  $('btn-clear-queue').onclick = async () => {
    if (!confirm('确定清空点歌队列吗？')) return;
    await API.musicClearQueue();
    queuePage = 1;
    refreshQueue();
  };
  $('queue-q').addEventListener('input', () => { queuePage = 1; refreshQueue(); });

  async function refreshTsStatus() {
    try {
      const st = await API.musicTsStatus();
      const box = $('ts-status');
      if (st.error) { box.textContent = '连接异常：' + st.error; return; }
      const np = st.nowPlaying ? `${st.nowPlaying.title || ''}${st.nowPlaying.artist ? ' - ' + st.nowPlaying.artist : ''}` : '';
      box.textContent = (st.connected ? '已连接频道（' + st.status + '）' : '未连接频道') + (np ? '　正在播放：' + np : '');
    } catch (e) { /* 忽略 */ }
  }
  $('btn-ts-link').onclick = async () => {
    try {
      const ch = $('ts-channel').value.trim();
      const key = $('ts-key').value.trim();
      if (!ch) { TSUtils.toast('请先选择频道', 'error'); return; }
      if (!key) { TSUtils.toast('请先填写 TS API Key', 'error'); return; }
      TSUtils.toast('正在生成机器人并连接 TeamSpeak…', 'success');
      // 保存频道与 Key，再自动建连（后端自动创建管理员/TS 连接/机器人并推流）
      await API.musicTsSaveConfig({ ts6mgrChannel: ch, tsApiKey: key });
      const r = await API.musicTsLink();
      TSUtils.toast('已连接：bot #' + r.botId, 'success');
      refreshTsStatus();
    } catch (e) { TSUtils.toast('生成失败：' + e.message, 'error'); }
  };
  $('btn-ts-unlink').onclick = async () => {
    try { await API.musicTsUnlink(); TSUtils.toast('已断开推流', 'success'); refreshTsStatus(); }
    catch (e) { TSUtils.toast('断开失败：' + e.message, 'error'); }
  };
  async function loadTsChannels() {
    const sel = $('ts-channel');
    try {
      const cfg = await API.musicTsConfig();
      $('ts-key').value = cfg.tsApiKey || '';
      if (!cfg.tsApiKey) {
        sel.innerHTML = '<option value="">（请先填写 TS API Key 后点 ↻ 刷新）</option>';
        return;
      }
      const channels = await API.musicTsChannels();
      const saved = cfg.ts6mgrChannel || '';
      sel.innerHTML = '';
      if (!channels.length) {
        sel.innerHTML = '<option value="">（无频道，请先在 TS 创建）</option>';
        return;
      }
      channels.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.path || c.name;
        o.textContent = c.path || c.name;
        if ((c.path || c.name) === saved) o.selected = true;
        sel.appendChild(o);
      });
      if (saved && !channels.some((c) => (c.path || c.name) === saved)) {
        const o = document.createElement('option');
        o.value = saved; o.textContent = saved + '（当前）'; o.selected = true;
        sel.appendChild(o);
      }
    } catch (e) {
      sel.innerHTML = '<option value="">（加载失败：' + e.message + '）</option>';
    }
  }
  // ↻ 先保存当前填写的 Key，再刷新频道列表
  $('btn-ts-refresh').onclick = async () => {
    const key = $('ts-key').value.trim();
    const ch = $('ts-channel').value.trim();
    if (key) {
      try { await API.musicTsSaveConfig({ tsApiKey: key, ts6mgrChannel: ch }); } catch (e) { /* 忽略 */ }
    }
    loadTsChannels();
  };
  loadTsChannels();
  refreshTsStatus();


  $('search-results').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.song) {
        const s = JSON.parse(btn.dataset.song);
        await API.musicEnqueue(s);
        TSUtils.toast('已加入点歌队列', 'success');
        refreshQueue();
      } else if (btn.dataset.pl) {
        const tracks = await API.musicPlaylistTracksAll(btn.dataset.pl);
        if (!tracks.tracks || !tracks.tracks.length) { TSUtils.toast('歌单为空', 'error'); return; }
        await API.musicEnqueueMany(tracks.tracks.map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration })));
        TSUtils.toast(`已将歌单全部 ${tracks.tracks.length} 首加入队列`, 'success');
        refreshQueue();
      } else if (btn.dataset.view) {
        openPlaylistModal(btn.dataset.view, btn.dataset.name);
      } else if (btn.classList.contains('pager-btn')) {
        const p = parseInt(btn.dataset.p, 10);
        doSearch(p);
      }
    } catch (err) {
      TSUtils.toast(err.message, 'error');
    }
  });

  $('queue-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.play != null) {
        await API.musicPlay(parseInt(btn.dataset.play, 10));
        pollPlayer(true);
        TSUtils.toast('开始播放', 'success');
      } else if (btn.dataset.del != null) {
        await API.musicDequeue(btn.dataset.del);
      } else if (btn.classList.contains('pager-btn')) {
        queuePage = parseInt(btn.dataset.p, 10);
      }
      refreshQueue();
    } catch (err) {
      TSUtils.toast(err.message, 'error');
      refreshQueue();
    }
  });

  // 播放器控制
  $('btn-prev').onclick = async () => { await API.musicPrev(); pollPlayer(true); };
  $('btn-next').onclick = async () => { await API.musicNext(); pollPlayer(true); };
  $('btn-toggle').onclick = async () => { await API.musicToggle(); pollPlayer(true); };
  $('btn-loop').onclick = async () => {
    const order = ['all', 'one', 'shuffle', 'off'];
    const next = order[(order.indexOf(playerState.loopMode) + 1) % order.length];
    await API.musicLoop(next);
    pollPlayer(true);
  };
  $('player-range').addEventListener('input', () => { seeking = true; });
  $('player-range').addEventListener('change', async () => {
    const pos = parseInt($('player-range').value, 10) || 0;
    seeking = false;
    try { await API.musicSeek(pos); } catch (e) { /* 忽略 */ }
    pollPlayer(true);
  });

  await refreshLogin();
  await refreshQueue();
  await pollPlayer(true);
  startTick();
  pollTimer = TSUtils.setInterval(() => { refreshQueue(); pollPlayer(); }, 5000);

  // 页面卸载时清理所有定时器和未关闭的弹窗，避免快速切页写入已销毁 DOM / 卡死
  TSUtils.registerCleanup(() => {
    if (playerTick) { clearInterval(playerTick); playerTick = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
    const ov = document.getElementById('modal-overlay');
    if (ov) ov.hidden = true;
  });
};
