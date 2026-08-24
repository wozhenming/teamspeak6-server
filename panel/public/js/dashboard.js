'use strict';

/**
 * 仪表盘：服务器概览 + 历史图表（可切换时间范围）+ 最近加入用户（保留历史）。
 */

window.TSPages = window.TSPages || {};

TSPages.dashboard = async function () {
  const content = document.getElementById('page-content');
  const sid = TSUtils.sid() || 1;

  // 时间范围（分钟）：30 分钟 / 1 小时 / 6 小时 / 24 小时
  const RANGES = [
    { m: 30, label: '30分' },
    { m: 60, label: '1小时' },
    { m: 360, label: '6小时' },
    { m: 1440, label: '24小时' },
  ];
  let range = 60;
  let historyCache = []; // { t, clients, up, down }（升序）
  let clientsChart = null;
  let bandwidthChart = null;

  content.innerHTML = `
    <div class="grid grid-4" id="stat-cards">
      <div class="card stat-card"><span class="stat-label">在线用户</span><span class="stat-value" id="st-clients">-</span><span class="stat-sub" id="st-clients-sub"></span></div>
      <div class="card stat-card"><span class="stat-label">服务器运行时长</span><span class="stat-value" id="st-uptime">-</span><span class="stat-sub" id="st-uptime-sub"></span></div>
      <div class="card stat-card"><span class="stat-label">当前上行带宽</span><span class="stat-value" id="st-up">-</span><span class="stat-sub">发送速率</span></div>
      <div class="card stat-card"><span class="stat-label">当前下行带宽</span><span class="stat-value" id="st-down">-</span><span class="stat-sub">接收速率</span></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3>在线人数趋势
        <span class="range-btns" id="range-btns"></span>
      </h3><div class="chart-box"><canvas id="chart-clients"></canvas></div></div>
      <div class="card"><h3>带宽使用（近 <span id="range-label">1 小时</span>）</h3><div class="chart-box"><canvas id="chart-bandwidth"></canvas></div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <h3>服务器信息
          <button class="btn btn-sm" id="btn-edit-server">${TSUtils.icons.edit} 修改名称</button>
        </h3>
        <div id="server-info"><div class="empty">加载中…</div></div>
      </div>
      <div class="card">
        <h3>最近加入的用户 <span class="muted" id="recent-count" style="font-weight:400"></span></h3>
        <div id="recent-clients"><div class="empty">加载中…</div></div>
      </div>
    </div>`;

  // ---------- 时间范围按钮 ----------
  const rangeBtns = document.getElementById('range-btns');
  rangeBtns.innerHTML = RANGES.map(r =>
    `<button class="btn btn-sm range-btn${r.m === range ? ' active' : ''}" data-m="${r.m}">${r.label}</button>`).join('');
  rangeBtns.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    range = parseInt(btn.dataset.m, 10);
    rangeBtns.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('range-label').textContent = RANGES.find(r => r.m === range).label;
    loadHistory();
  });

  // ---------- 图表 ----------
  function ensureCharts() {
    if (clientsChart || !window.Chart) return;
    clientsChart = new Chart(document.getElementById('chart-clients'), {
      type: 'line',
      data: {
        labels: [], datasets: [{
          label: '在线人数', data: [], borderColor: '#3d7eff', backgroundColor: 'rgba(61,126,255,.12)',
          fill: true, tension: .3, pointRadius: 0, spanGaps: true,
        }],
      },
      options: { animation: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    bandwidthChart = new Chart(document.getElementById('chart-bandwidth'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: '上行 Kbit/s', data: [], borderColor: '#2ecc71', tension: .3, pointRadius: 0, spanGaps: true },
          { label: '下行 Kbit/s', data: [], borderColor: '#f1c40f', tension: .3, pointRadius: 0, spanGaps: true },
        ],
      },
      options: { animation: false,
        scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { beginAtZero: true } } },
    });
  }

  function renderCharts() {
    ensureCharts();
    if (!clientsChart) return;
    const labels = historyCache.map(h => new Date(h.t).toLocaleTimeString('zh-CN', { hour12: false }));
    clientsChart.data.labels = labels;
    clientsChart.data.datasets[0].data = historyCache.map(h => h.clients);
    clientsChart.update('none');
    bandwidthChart.data.labels = labels;
    bandwidthChart.data.datasets[0].data = historyCache.map(h => h.up);
    bandwidthChart.data.datasets[1].data = historyCache.map(h => h.down);
    bandwidthChart.update('none');
  }

  async function loadHistory() {
    try {
      const d = await API.overviewHistory(range);
      historyCache = d.points || [];
      renderCharts();
    } catch (e) { /* 图表保持现状 */ }
  }

  // 实时点追加（与采样器数据合并去重）
  function appendLivePoint(ov, now) {
    const last = historyCache[historyCache.length - 1];
    const p = {
      t: now,
      clients: (ov.server && ov.server.clients_online) || 0,
      up: ov.bandwidth_sent_rate || 0,
      down: ov.bandwidth_received_rate || 0,
    };
    if (last && now - last.t < 4000) {
      historyCache[historyCache.length - 1] = p; // 覆盖刚写入的采样点
    } else {
      historyCache.push(p);
    }
    const cutoff = now - range * 60000;
    while (historyCache.length && historyCache[0].t < cutoff) historyCache.shift();
  }

  // ---------- 服务器信息 ----------
  function renderServerInfo(ov) {
    const s = ov.server || {};
    const rows = [
      ['服务器名称', s.name || '-'],
      ['状态', s.status || '-'],
      ['WebQuery 版本', ov.version || '-'],
      ['最大用户数', s.max_clients == null ? '-' : s.max_clients],
      ['服务器创建时间', TSUtils.fmtTime(s.created_at)],
      ['累计发送', TSUtils.fmtBytes(s.bandwidth_sent)],
      ['累计接收', TSUtils.fmtBytes(s.bandwidth_received)],
      ['累计数据包', (s.packets_sent || 0) + ' / ' + (s.packets_received || 0) + ' (发/收)'],
    ];
    document.getElementById('server-info').innerHTML =
      '<table>' + rows.map(r =>
        `<tr><td class="muted">${TSUtils.escapeHtml(r[0])}</td><td>${TSUtils.escapeHtml(String(r[1]))}</td></tr>`
      ).join('') + '</table>';
  }

  // ---------- 最近加入用户（含历史，退出不消失） ----------
  function ago(tsMs) {
    const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  async function loadRecent() {
    try {
      const d = await API.recentClients();
      const list = d.clients || [];
      const el = document.getElementById('recent-clients');
      document.getElementById('recent-count').textContent = list.length ? `（${list.length} 条记录）` : '';
      if (!list.length) {
        el.innerHTML = '<div class="empty">暂无加入记录</div>';
        return;
      }
      el.innerHTML = '<table><tr><th>昵称</th><th>频道</th><th>加入时间</th></tr>' +
        list.map(c => `<tr>
          <td>${TSUtils.escapeHtml(c.nickname)}</td>
          <td>${TSUtils.escapeHtml(c.channel_name || '')}</td>
          <td>${ago(c.joined_at)}</td>
        </tr>`).join('') + '</table>';
    } catch (e) { /* 静默 */ }
  }

  // ---------- 状态卡 ----------
  function updateStats(ov) {
    const s = ov.server || {};
    document.getElementById('st-clients').textContent = s.clients_online == null ? '-' : s.clients_online;
    document.getElementById('st-clients-sub').textContent = s.max_clients ? `最大 ${s.max_clients} 人` : '';
    document.getElementById('st-uptime').textContent = TSUtils.fmtDuration(s.uptime_seconds);
    document.getElementById('st-uptime-sub').textContent = s.uptime_seconds ? '累计运行' : '';
    document.getElementById('st-up').textContent = TSUtils.fmtKbps(ov.bandwidth_sent_rate);
    document.getElementById('st-down').textContent = TSUtils.fmtKbps(ov.bandwidth_received_rate);
  }

  async function tick(initial) {
    try {
      const ov = await API.overview(sid);
      if (ov.error) {
        document.getElementById('stat-cards').insertAdjacentHTML('beforebegin',
          `<div class="alert error">WebQuery 返回错误：${TSUtils.escapeHtml(ov.error)}</div>`);
        return;
      }
      appendLivePoint(ov, Date.now());
      renderCharts();
      updateStats(ov);
      if (initial) renderServerInfo(ov);
    } catch (e) {
      document.getElementById('stat-cards').insertAdjacentHTML('beforebegin',
        `<div class="alert error">${TSUtils.escapeHtml(e.message)}</div>`);
    }
  }

  // ---------- 修改服务器名称 ----------
  document.getElementById('btn-edit-server').onclick = async () => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '修改服务器名称';
    const body = document.getElementById('modal-body');
    let current = '';
    try {
      const ov = await API.overview(sid);
      current = (ov.server && ov.server.name) || '';
    } catch (e) { /* 忽略 */ }
    body.innerHTML = `
      <label>新名称
        <input type="text" id="srv-name" class="input" style="width:100%;margin-top:5px"
          value="${TSUtils.escapeHtml(current)}" maxlength="100">
      </label>
      <div class="muted" style="font-size:12.5px">修改后所有客户端看到的服务器名称立即更新。</div>
      <div class="modal-footer">
        <button class="btn" id="srv-cancel">取消</button>
        <button class="btn btn-primary" id="srv-ok">保存</button>
      </div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    body.querySelector('#srv-cancel').onclick = close;
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    body.querySelector('#srv-ok').onclick = async () => {
      const name = body.querySelector('#srv-name').value.trim();
      if (!name) { TSUtils.toast('名称不能为空', 'error'); return; }
      const btn = body.querySelector('#srv-ok');
      btn.disabled = true;
      try {
        await API.editServer(sid, name);
        close();
        TSUtils.toast('服务器名称已更新', 'success');
        await tick(true);
        const box = document.getElementById('conn-status');
        if (box) {
          box.classList.add('online');
          document.getElementById('conn-status-text').textContent = `已连接 · ${name}`;
        }
      } catch (e) {
        TSUtils.toast(e.message, 'error');
        btn.disabled = false;
      }
    };
    body.querySelector('#srv-name').focus();
    body.querySelector('#srv-name').select();
  };

  // ---------- 初始化 ----------
  await Promise.all([loadHistory(), loadRecent()]);
  await tick(true);
  const timer = setInterval(() => tick(false), 5000);
  const recentTimer = setInterval(loadRecent, 15000);
  window.addEventListener('hashchange', () => { clearInterval(timer); clearInterval(recentTimer); }, { once: true });
};
