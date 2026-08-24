'use strict';

/**
 * 面板 SPA 骨架：哈希路由、页面切换、服务器选择、连接状态。
 * 各页面实现挂载到 window.TSPages。
 */

(function () {
  const PAGES = {
    deploy: { title: '部署管理', render: () => TSPages.deploy() },
    dashboard: { title: '仪表盘', render: () => TSPages.dashboard() },
    users: { title: '用户管理', render: () => TSPages.users() },
    channels: { title: '频道管理', render: () => TSPages.channels() },
  };

  let currentSid = null;

  // ---------- 全局工具 ----------
  window.TSUtils = {
    sid() {
      return currentSid;
    },
    setSid(sid) {
      currentSid = sid;
    },
    escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    fmtDuration(seconds) {
      if (seconds == null || isNaN(seconds)) return '-';
      const s = Math.max(0, Math.floor(seconds));
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (d > 0) return `${d}天 ${h}小时 ${m}分`;
      if (h > 0) return `${h}小时 ${m}分 ${sec}秒`;
      if (m > 0) return `${m}分 ${sec}秒`;
      return `${sec}秒`;
    },
    fmtBytes(b) {
      if (b == null || isNaN(b)) return '-';
      b = Number(b);
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
      return (b / 1073741824).toFixed(2) + ' GB';
    },
    fmtKbps(v) {
      if (v == null || isNaN(v)) return '-';
      return Number(v).toFixed(1) + ' Kbit/s';
    },
    fmtTime(ts) {
      if (!ts) return '-';
      return new Date(ts * 1000).toLocaleString();
    },
    toast(msg, type) {
      const box = document.getElementById('toast-container');
      const el = document.createElement('div');
      el.className = 'toast ' + (type || '');
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    },
    confirmModal(title, bodyHtml, onOk) {
      const overlay = document.getElementById('modal-overlay');
      const titleEl = document.getElementById('modal-title');
      const bodyEl = document.getElementById('modal-body');
      titleEl.textContent = title;
      bodyEl.innerHTML = bodyHtml;
      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = '取消';
      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-danger';
      okBtn.textContent = '确认';
      footer.appendChild(cancel);
      footer.appendChild(okBtn);
      bodyEl.appendChild(footer);
      overlay.hidden = false;
      const close = () => { overlay.hidden = true; };
      cancel.onclick = close;
      document.getElementById('modal-close').onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      okBtn.onclick = async () => {
        okBtn.disabled = true;
        try { await onOk(); close(); } catch (e) { TSUtils.toast(e.message, 'error'); okBtn.disabled = false; }
      };
    },
  };

  // ---------- 导航 ----------
  async function navigate() {
    const hash = location.hash || '#/dashboard';
    const name = (hash.replace(/^#\//, '').split('?')[0]) || 'dashboard';
    const page = PAGES[name];
    if (!page) { location.hash = '#/dashboard'; return; }
    document.querySelectorAll('.sidebar-nav a').forEach(a =>
      a.classList.toggle('active', a.dataset.page === name));
    document.getElementById('page-title').textContent = page.title;
    try {
      await page.render();
    } catch (e) {
      TSUtils.toast(e.message, 'error');
      document.getElementById('page-content').innerHTML =
        `<div class="empty">加载失败：${TSUtils.escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 服务器下拉 ----------
  async function loadServers() {
    const sel = document.getElementById('server-select');
    try {
      const servers = await API.servers();
      if (!servers || !servers.length) {
        sel.hidden = true;
        return;
      }
      sel.innerHTML = '';
      for (const s of servers) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `服务器 #${s.id}${s.name ? ' - ' + s.name : ''}`;
        sel.appendChild(opt);
      }
      if (!currentSid || !servers.some(s => String(s.id) === String(currentSid))) {
        currentSid = servers[0].id;
      }
      sel.value = currentSid;
      sel.hidden = false;
    } catch (e) {
      sel.hidden = true;
      console.warn('加载服务器列表失败:', e.message);
    }
  }

  // ---------- 连接状态 ----------
  async function refreshConnStatus() {
    const box = document.getElementById('conn-status');
    const text = document.getElementById('conn-status-text');
    try {
      const data = await API.overview(currentSid || 1);
      const online = data && data.server && data.server.status !== 'offline' && !data.error;
      box.classList.remove('online', 'offline');
      if (online) {
        box.classList.add('online');
        text.textContent = `已连接 · ${(data.server.name || 'TS6 服务器')}`;
      } else {
        box.classList.add('offline');
        text.textContent = '服务器离线';
      }
    } catch (e) {
      box.classList.remove('online');
      box.classList.add('offline');
      text.textContent = '无法连接';
    }
  }

  // ---------- 启动 ----------
  window.addEventListener('hashchange', navigate);
  document.getElementById('logout-btn').onclick = async () => {
    try { await API.logout(); } catch (e) { /* 忽略 */ }
    location.href = '/login.html';
  };
  document.getElementById('server-select').onchange = (e) => {
    currentSid = e.target.value;
    navigate();
    refreshConnStatus();
  };

  (async function boot() {
    try {
      const me = await API.me();
      document.getElementById('current-user').textContent = me.username;
    } catch (e) {
      location.href = '/login.html';
      return;
    }
    await loadServers();
    await navigate();
    await refreshConnStatus();
    setInterval(refreshConnStatus, 15000);
  })();
})();
