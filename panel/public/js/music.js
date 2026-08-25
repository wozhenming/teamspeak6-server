'use strict';

/**
 * 点歌页：网易云扫码登录 + 歌曲/歌单搜索 + 点歌队列。
 */

window.TSPages = window.TSPages || {};

TSPages.music = async function () {
  const content = document.getElementById('page-content');
  let searchType = 'song';
  let loginTimer = null;

  content.innerHTML = `
    <div id="music-alert"></div>
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
      <h3><span>点歌队列 <span class="muted" id="queue-count"></span></span>
        <button class="btn btn-sm btn-danger" id="btn-clear-queue">清空</button>
      </h3>
      <div id="queue-list"><div class="empty">队列为空</div></div>
    </div>`;

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDur(sec) {
    if (!sec) return '';
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtNum(n) {
    if (!n) return '0';
    if (n > 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n > 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  async function refreshLogin() {
    try {
      const d = await API.musicStatus();
      const el = $('login-state');
      el.textContent = d.loggedIn ? '✓ 已登录网易云' : '未登录（登录后可播放受版权歌曲）';
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
        loginTimer = setInterval(async () => {
          try {
            const r = await API.musicQrCheck(qr.key);
            const st = body.querySelector('#qr-status');
            if (!st) return;
            if (r.code === 803) {
              close();
              TSUtils.toast('登录成功 ✓', 'success');
            } else if (r.code === 802) {
              st.textContent = '已扫码，请在手机上确认登录…';
            } else if (r.code === 800) {
              st.textContent = '二维码已过期，请关闭重试';
              clearInterval(loginTimer);
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
  async function doSearch() {
    const q = $('search-q').value.trim();
    if (!q) return;
    const box = $('search-results');
    box.innerHTML = '<div class="empty">搜索中…</div>';
    try {
      const d = await API.musicSearch(q, searchType, 20, 0);
      if (!d.items || !d.items.length) {
        box.innerHTML = '<div class="empty">未找到结果</div>';
        return;
      }
      if (searchType === 'playlist') {
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 个歌单</div><div class="table-wrap"><table>
          <thead><tr><th>名称</th><th>曲目/播放</th><th>创建者</th><th class="actions">操作</th></tr></thead>
          <tbody>${d.items.map(p => `<tr>
            <td>${esc(p.name)}</td><td>${p.tracks} 首 · ${fmtNum(p.playCount)} 播放</td><td>${esc(p.creator)}</td>
            <td class="actions"><button class="btn btn-sm btn-primary" data-pl="${p.id}" data-name="${esc(p.name)}">加歌单进队列</button></td>
          </tr>`).join('')}</tbody></table></div>`;
      } else {
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 首</div><div class="table-wrap"><table>
          <thead><tr><th>歌曲</th><th>专辑</th><th class="num">时长</th><th class="actions">操作</th></tr></thead>
          <tbody>${d.items.map(s => `<tr>
            <td>${esc(s.name)} <span class="muted">- ${esc(s.artists)}</span></td>
            <td>${esc(s.album)}</td><td class="num">${fmtDur(s.duration)}</td>
            <td class="actions"><button class="btn btn-sm btn-primary" data-song='${JSON.stringify({ id: s.id, name: s.name, artists: s.artists, album: s.album, duration: s.duration }).replace(/"/g, '&quot;')}'>点歌</button></td>
          </tr>`).join('')}</tbody></table></div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  // ---------- 队列 ----------
  async function refreshQueue() {
    try {
      const d = await API.musicQueue();
      const items = d.items || [];
      $('queue-count').textContent = `（${items.length} 首）`;
      const box = $('queue-list');
      if (!items.length) { box.innerHTML = '<div class="empty">队列为空</div>'; return; }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>歌曲</th><th>点歌人</th><th class="actions">操作</th></tr></thead>
        <tbody>${items.map((it, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(it.title)} <span class="muted">- ${esc(it.artists)}</span></td>
          <td>${esc(it.requestedBy)}</td>
          <td class="actions"><button class="btn btn-sm btn-danger" data-del="${it.id}">移除</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 事件 ----------
  $('btn-login').onclick = openQrModal;
  $('btn-search').onclick = doSearch;
  $('search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('search-type').onchange = (e) => { searchType = e.target.value; };
  $('btn-clear-queue').onclick = async () => {
    if (!confirm('确定清空点歌队列吗？')) return;
    await API.musicClearQueue();
    refreshQueue();
  };

  $('search-results').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.song) {
        const s = JSON.parse(btn.dataset.song);
        await API.musicEnqueue(s);
        TSUtils.toast('已加入点歌队列 ✓', 'success');
        refreshQueue();
      } else if (btn.dataset.pl) {
        const tracks = await API.musicPlaylistTracks(btn.dataset.pl, 30);
        if (!tracks.tracks || !tracks.tracks.length) { TSUtils.toast('歌单为空', 'error'); return; }
        for (const t of tracks.tracks) {
          await API.musicEnqueue({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration });
        }
        TSUtils.toast(`已将歌单前 ${tracks.tracks.length} 首加入队列 ✓`, 'success');
        refreshQueue();
      }
    } catch (err) {
      TSUtils.toast(err.message, 'error');
    }
  });

  $('queue-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-del]');
    if (!btn) return;
    await API.musicDequeue(btn.dataset.del);
    refreshQueue();
  });

  await refreshLogin();
  await refreshQueue();
  setInterval(refreshQueue, 5000);
};