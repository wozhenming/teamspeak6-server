'use strict';

/**
 * 仪表盘：服务器概览 + 在线人数/带宽实时图表。
 */

window.TSPages = window.TSPages || {};

TSPages.dashboard = async function () {
  const content = document.getElementById('page-content');
  const sid = TSUtils.sid() || 1;

  content.innerHTML = `
    <div class="grid grid-4" id="stat-cards">
      <div class="card stat-card"><span class="stat-label">在线用户</span><span class="stat-value" id="st-clients">-</span><span class="stat-sub" id="st-clients-sub"></span></div>
      <div class="card stat-card"><span class="stat-label">服务器运行时长</span><span class="stat-value" id="st-uptime">-</span><span class="stat-sub" id="st-uptime-sub"></span></div>
      <div class="card stat-card"><span class="stat-label">当前上行带宽</span><span class="stat-value" id="st-up">-</span><span class="stat-sub">发送速率</span></div>
      <div class="card stat-card"><span class="stat-label">当前下行带宽</span><span class="stat-value" id="st-down">-</span><span class="stat-sub">接收速率</span></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3>在线人数趋势（近 5 分钟）</h3><div class="chart-box"><canvas id="chart-clients"></canvas></div></div>
      <div class="card"><h3>带宽使用（近 5 分钟）</h3><div class="chart-box"><canvas id="chart-bandwidth"></canvas></div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card">
        <h3>服务器信息</h3>
        <div id="server-info"><div class="empty">加载中…</div></div>
      </div>
      <div class="card">
        <h3>最近加入的用户</h3>
        <div id="recent-clients"><div class="empty">加载中…</div></div>
      </div>
    </div>`;

  let clientsChart = null;
  let bandwidthChart = null;
  const history = []; // { t, clients, up, down }

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

  function renderRecentClients(ov) {
    const clients = (ov.clients || []).slice(0, 8);
    const el = document.getElementById('recent-clients');
    if (!clients.length) { el.innerHTML = '<div class="empty">暂无在线用户</div>'; return; }
    el.innerHTML = '<table><tr><th>昵称</th><th>频道</th><th>连接时长</th></tr>' +
      clients.map(c => `<tr>
        <td>${TSUtils.escapeHtml(c.nickname)}</td>
        <td>${TSUtils.escapeHtml(c.channel_name || '')}</td>
        <td>${TSUtils.fmtDuration(c.connected_seconds)}</td>
      </tr>`).join('') + '</table>';
  }

  function updateCharts(ov, now) {
    const up = ov.bandwidth_sent_rate || 0;   // Kbit/s（后端换算）
    const down = ov.bandwidth_received_rate || 0;
    const clients = (ov.server && ov.server.clients_online) || 0;
    history.push({ t: now, clients, up, down });
    while (history.length > 60) history.shift(); // 5 分钟 @5s

    if (!clientsChart && window.Chart) {
      clientsChart = new Chart(document.getElementById('chart-clients'), {
        type: 'line',
        data: {
          labels: [], datasets: [{
            label: '在线人数', data: [], borderColor: '#3d7eff', backgroundColor: 'rgba(61,126,255,.12)',
            fill: true, tension: .3, pointRadius: 0,
          }],
        },
        options: { animation: false, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
      });
      bandwidthChart = new Chart(document.getElementById('chart-bandwidth'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: '上行 Kbit/s', data: [], borderColor: '#2ecc71', tension: .3, pointRadius: 0 },
            { label: '下行 Kbit/s', data: [], borderColor: '#f1c40f', tension: .3, pointRadius: 0 },
          ],
        },
        options: { animation: false,
          scales: { y: { beginAtZero: true } } },
      });
    }
    if (clientsChart) {
      const labels = history.map(h => new Date(h.t).toLocaleTimeString('zh-CN', { hour12: false }));
      clientsChart.data.labels = labels;
      clientsChart.data.datasets[0].data = history.map(h => h.clients);
      clientsChart.update('none');
      bandwidthChart.data.labels = labels;
      bandwidthChart.data.datasets[0].data = history.map(h => h.up);
      bandwidthChart.data.datasets[1].data = history.map(h => h.down);
      bandwidthChart.update('none');
    }
  }

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
      if (initial) {
        renderServerInfo(ov);
        renderRecentClients(ov);
      }
      updateStats(ov);
      updateCharts(ov, Date.now());
    } catch (e) {
      document.getElementById('stat-cards').insertAdjacentHTML('beforebegin',
        `<div class="alert error">${TSUtils.escapeHtml(e.message)}</div>`);
    }
  }

  await tick(true);
  const timer = setInterval(() => tick(false), 5000);
  // 页面切换时停止轮询
  window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
};
