'use strict';

/**
 * 数据统计页：汇总指标 + 用户连接记录历史。
 */

window.TSPages = window.TSPages || {};

TSPages.stats = async function () {
  const content = document.getElementById('page-content');
  const ago = (tsMs) => {
    if (!tsMs) return '-';
    const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  };

  content.innerHTML = `
    <div class="grid grid-4" id="stat-cards">
      <div class="card stat-card"><span class="stat-label">累计独立用户</span><span class="stat-value" id="s-total-users">-</span></div>
      <div class="card stat-card"><span class="stat-label">累计连接次数</span><span class="stat-value" id="s-total-conn">-</span></div>
      <div class="card stat-card"><span class="stat-label">当前在线</span><span class="stat-value" id="s-online">-</span></div>
      <div class="card stat-card"><span class="stat-label">平均连接时长</span><span class="stat-value" id="s-avg-dur">-</span></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3><span>用户连接记录</span>
        <button class="btn btn-sm" id="btn-refresh-stats">刷新</button>
      </h3>
      <div id="connections-table"><div class="empty">加载中…</div></div>
    </div>`;

  function fmtDur(sec) {
    if (sec == null || sec <= 0) return '-';
    return TSUtils.fmtDuration(sec);
  }

  async function load() {
    try {
      const data = await API.statsConnections(500);
      const s = data.stats || {};

      document.getElementById('s-total-users').textContent = s.total_users || 0;
      document.getElementById('s-total-conn').textContent = s.total_connections || 0;
      document.getElementById('s-online').textContent = s.online_now || 0;
      document.getElementById('s-avg-dur').textContent = fmtDur(s.avg_connection_seconds);

      const users = data.users || [];
      const box = document.getElementById('connections-table');
      if (!users.length) {
        box.innerHTML = '<div class="empty">暂无用户记录（面板启动后会自动记录连接）</div>';
        return;
      }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
          <th>昵称</th><th>UID</th><th>国家</th><th>状态</th>
          <th>首次连接</th><th>最后在线</th><th class="num">总连接次数</th>
        </tr></thead>
        <tbody>${users.map(u => `<tr>
          <td>${TSUtils.escapeHtml(u.nickname)}</td>
          <td class="mono muted" title="${TSUtils.escapeHtml(u.uid)}">${TSUtils.escapeHtml((u.uid || '-').slice(0, 16))}</td>
          <td>${TSUtils.escapeHtml(u.country || '-')}</td>
          <td>${u.is_online
            ? '<span class="badge green">在线</span>'
            : '<span class="badge">离线</span>'}</td>
          <td>${TSUtils.fmtTime(u.first_seen / 1000)}</td>
          <td>${ago(u.last_seen)}</td>
          <td class="num">${u.total_connections || 0}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('connections-table').innerHTML =
        `<div class="alert error">${TSUtils.escapeHtml(e.message)}</div>`;
    }
  }

  document.getElementById('btn-refresh-stats').onclick = load;
  await load();
};
