'use strict';

/**
 * 部署管理：前端引导式一键部署 TeamSpeak 6。
 *
 * 流程：① 环境检测 → ② 部署配置（生成 compose）→ ③ 启动服务（实时日志）
 *       → ④ 初始管理员凭证 → ⑤ WebQuery API Key 配置
 */

window.TSPages = window.TSPages || {};

TSPages.deploy = async function () {
  const content = document.getElementById('page-content');
  let status = null;
  let taskTimer = null;

  content.innerHTML = `
    <div id="deploy-alert"></div>
    <div id="mode-banner"></div>

    <div class="grid grid-2">
      <!-- ① 环境检测 -->
      <div class="card">
        <h3><span class="step-badge">1</span> 环境检测</h3>
        <div id="env-check">
          <div class="empty">检测中…</div>
        </div>
        <div style="margin-top:12px" class="muted" id="env-guide"></div>
      </div>

      <!-- ② 部署配置（独立模式为表单；容器化模式为说明） -->
      <div class="card" id="card-config">
        <h3><span class="step-badge">2</span> 部署配置</h3>
        <div class="deploy-form" id="config-form">
          <div class="form-row">
            <label>容器名<input type="text" id="cfg-name" value="teamspeak-server"></label>
            <label>语音端口 (UDP)<input type="number" id="cfg-voice" value="9987"></label>
          </div>
          <div class="form-row">
            <label>文件传输端口<input type="number" id="cfg-file" value="30033"></label>
            <label>WebQuery 端口<input type="number" id="cfg-webquery" value="10080"></label>
          </div>
          <div class="form-row">
            <label>SSH Query 端口<input type="number" id="cfg-ssh" value="10022"></label>
            <label>Query 管理员密码（可选）<input type="password" id="cfg-password" placeholder="留空=自动生成"></label>
          </div>
          <pre class="yaml-preview" id="compose-preview">（配置后自动预览）</pre>
          <div class="modal-footer">
            <button class="btn btn-sm" id="btn-preview">刷新预览</button>
            <button class="btn btn-sm btn-primary" id="btn-compose">生成 docker-compose.yml</button>
          </div>
          <div class="muted" id="compose-file-info" style="font-size:12px"></div>
        </div>
        <div id="config-note" hidden></div>
      </div>
    </div>

    <!-- ③ 启动服务 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">3</span> 启动服务
        <span id="container-state" class="badge">未知</span>
      </h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-primary" id="btn-up">${TSUtils.icons.rocket} 启动服务</button>
        <button class="btn" id="btn-restart">重启</button>
        <button class="btn btn-danger" id="btn-down">停止</button>
        <button class="btn" id="btn-refresh-status">刷新状态</button>
      </div>
      <div class="term" id="task-console"><div class="term-empty">任务输出将显示在这里…</div></div>
    </div>

    <!-- ④ 初始管理员凭证 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">4</span> 初始管理员凭证
        <button class="btn btn-sm" id="btn-credentials">查看 / 重新提取</button>
      </h3>
      <div id="credentials-box"><div class="empty">凭证仅在首次启动生成，已自动保存到面板数据卷（容器重建不丢失）</div></div>
    </div>

    <!-- ⑤ API Key 配置 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">5</span> WebQuery API Key 配置</h3>
      <div class="alert" style="margin-bottom:12px">
        面板可 <b>一键生成</b>（自动经 SSH Query 执行 apikeyadd 并保存），也可手动生成后粘贴：
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-primary" id="btn-gen-key">${TSUtils.icons.zap} 一键生成 API Key</button>
        <span class="muted" style="font-size:12.5px">需要 serveradmin 密码（自动从容器配置/日志获取，失败时提示输入）</span>
      </div>
      <div class="cmd-box">
        <code>ssh -p <span id="ssh-port">10022</span> serveradmin@&lt;服务器IP&gt;</code>
        <button class="btn btn-sm" data-copy="ssh -p 10022 serveradmin@&lt;服务器IP&gt;">复制</button>
      </div>
      <div class="cmd-box">
        <code>apikeyadd scope=manage lifetime=0</code>
        <button class="btn btn-sm" data-copy="apikeyadd scope=manage lifetime=0">复制</button>
      </div>
      <details class="hint-box">
        <summary>${TSUtils.icons.help} 连接问题排查（点击展开）</summary>
        <div class="hint-body">
          <b>连接被拒绝（Connection refused）？</b>说明 SSH Query 端口只绑定了服务器本机。两种处理：
          <br>① 在<b>服务器上</b>执行（推荐）：<code class="mono">ssh -p 10022 serveradmin@127.0.0.1</code>
          <br>② 允许远程连接：编辑服务器上 <code class="mono">docker-compose.yml</code>，把 10022 端口行
          <code class="mono">127.0.0.1:\${TS_PORT_SSHQUERY:-10022}</code> 改为 <code class="mono">\${TS_PORT_SSHQUERY:-10022}</code>，
          执行 <code class="mono">docker compose up -d</code>；再把你的公网 IP
          （<code class="mono">curl ifconfig.me</code> 查看）加入 <code class="mono">query_ip_allowlist.txt</code>，
          最后 <code class="mono">docker compose restart teamspeak</code>
          <br><b>Permission denied？</b>SSH Query 登录用户名为 <b>serveradmin</b>（不是 admin），
          密码为上方 ④ 提取的密码，或 .env 中 <code class="mono">TS_QUERY_ADMIN_PASSWORD</code> 设置的值
          （设置后需 <code class="mono">docker compose up -d teamspeak</code> 重建生效）。
        </div>
      </details>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <input type="text" id="apikey-input" class="input" style="flex:1;min-width:260px" placeholder="粘贴生成的 API Key 后保存（无需重启面板）">
        <button class="btn btn-primary" id="btn-save-key">保存</button>
        <button class="btn" id="btn-check">检测连接</button>
      </div>
      <div id="apikey-result" style="margin-top:10px"></div>
    </div>

    <!-- ⑥ 服务器日志 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">6</span> 服务器日志
        <button class="btn btn-sm" id="btn-logs">刷新日志</button>
      </h3>
      <div class="term term-tall" id="logs-console"><div class="term-empty">暂无日志</div></div>
    </div>`;

  // ============ 工具 ============
  function $(id) { return document.getElementById(id); }

  function escape(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function copyText(text) {
    TSUtils.copyText(text);
  }

  function setTerm(el, lines, emptyText) {
    if (!lines || !lines.length) {
      el.innerHTML = `<div class="term-empty">${emptyText || '暂无输出'}</div>`;
      return;
    }
    el.innerHTML = lines.map(l => `<div>${escape(l)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  function taskDoneMessage(statusCode) {
    return statusCode === 0 ? '任务完成 ✓' : `任务失败（退出码 ${statusCode}）`;
  }

  // ============ ① 环境检测 ============
  async function loadStatus() {
    try {
      status = await API.deployStatus();
      renderEnv();
      renderMode();
      renderContainer();
      renderComposeInfo();
      renderApiKeyState();
    } catch (e) {
      $('env-check').innerHTML = `<div class="empty">状态获取失败：${escape(e.message)}</div>`;
    }
  }

  // 容器化模式 / 独立模式界面切换
  function renderMode() {
    const isContainer = status && status.mode === 'container';
    const banner = $('mode-banner');
    const configForm = $('config-form');
    const configNote = $('config-note');

    if (isContainer) {
      banner.innerHTML = `<div class="alert">${TSUtils.icons.box} 容器化模式：TS6 服务器与本面板由项目根目录 <b>docker-compose.yml</b> 统一管理
        （docker compose up -d 启动）。本页提供初始凭证提取、API Key 配置、日志查看与 TS6 容器快捷启停。</div>`;
      // ② 不消失：显示为说明卡片（端口/密码等由根目录 compose 管理）
      if (configForm) configForm.hidden = true;
      if (configNote) {
        configNote.hidden = false;
        configNote.innerHTML = `
          <div class="alert" style="margin-bottom:10px">当前由项目根目录 <b>docker-compose.yml</b> 统一管理，无需在此配置。
            常用调整在服务器上完成：</div>
          <div class="cmd-box"><code>nano docker-compose.yml        # 端口映射、环境变量</code></div>
          <div class="cmd-box"><code>cp .env.example .env && nano .env   # 面板密码/端口</code></div>
          <div class="cmd-box"><code>docker compose up -d          # 应用修改</code></div>
          <div class="muted" style="font-size:12px;margin-top:6px">修改后到 ① 环境检测 点「刷新状态」即可看到新配置生效。</div>`;
      }
      $('btn-up').innerHTML = `${TSUtils.icons.play} 启动 TS6 容器`;
      $('btn-up').title = 'docker start teamspeak-server';
      $('btn-restart').innerHTML = '重启容器';
      $('btn-down').innerHTML = '停止容器';
    } else {
      banner.innerHTML = '';
      if (configForm) configForm.hidden = false;
      if (configNote) configNote.hidden = true;
      $('btn-up').innerHTML = `${TSUtils.icons.rocket} 启动服务（docker compose up -d）`;
      $('btn-up').title = '';
      $('btn-restart').innerHTML = '重启';
      $('btn-down').innerHTML = '停止';
    }
  }

  function renderEnv() {
    const d = status.docker;
    const isContainer = status.mode === 'container';
    const box = $('env-check');
    const composeCell = isContainer
      ? '<span class="badge green">由主机 compose 管理</span>'
      : (d.compose
        ? `<span class="badge green">可用</span> ${escape(d.compose.command)} ${escape(d.compose.version || '')}`
        : '<span class="badge red">不可用</span>');
    const rows = [
      ['Docker', d.installed ? `<span class="badge green">已安装</span> ${escape(d.dockerVersion || '')}` : '<span class="badge red">未安装</span>'],
      ['Compose', composeCell],
      ['Docker 引擎', d.engineOk ? '<span class="badge green">连接正常</span>' : `<span class="badge red">不可用</span>${d.engineError ? '<div class="muted" style="font-size:12px">' + escape(d.engineError) + '</div>' : ''}`],
    ];
    box.innerHTML = '<table>' + rows.map(r => `<tr><td class="muted">${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>';

    const guide = $('env-guide');
    if (!isContainer && (!d.installed || !d.compose)) {
      const cmds = status.dockerInstallGuide || [];
      guide.innerHTML = '<div class="alert">Docker/Compose 未就绪，请按以下命令安装后点击「刷新状态」：</div>' +
        cmds.map(c => `<div class="cmd-box"><code>${escape(c)}</code><button class="btn btn-sm" data-copy="${escape(c)}">复制</button></div>`).join('');
    } else if (!d.engineOk) {
      guide.innerHTML = '<div class="alert">Docker 引擎不可用，请确认 Docker 服务已启动（如 systemctl start docker）。</div>';
    } else {
      guide.innerHTML = '';
    }
  }

  function renderContainer() {
    const c = status.container;
    const el = $('container-state');
    if (!c.exists) {
      el.className = 'badge';
      el.textContent = '容器未创建';
    } else {
      el.className = 'badge ' + (c.running ? 'green' : 'red');
      el.textContent = c.running ? '运行中' : '已停止';
      el.title = c.status + '\n' + (c.ports || '');
    }
  }

  function renderComposeInfo() {
    const f = status.composeFile;
    $('compose-file-info').textContent = f.exists ? `✓ 已生成：${f.path}` : '尚未生成 docker-compose.yml';
  }

  function renderApiKeyState() {
    const w = status.webquery;
    $('apikey-result').innerHTML = `
      <div class="conn-status ${w.reachable ? 'online' : (w.keyConfigured ? 'offline' : '')}">
        <span class="dot"></span>
        <span>${w.reachable ? `WebQuery 已连通（版本 ${escape(w.version || '')}）` : (w.keyConfigured ? `WebQuery 不可达：${escape(w.error || '')}` : 'API Key 未配置')}</span>
      </div>`;
  }

  // ============ ② 部署配置（仅独立模式） ============
  function previewParams() {
    return {
      name: $('cfg-name').value.trim() || 'teamspeak-server',
      voice: $('cfg-voice').value || 9987,
      file: $('cfg-file').value || 30033,
      webquery: $('cfg-webquery').value || 10080,
      ssh: $('cfg-ssh').value || '',
      password: $('cfg-password').value || '',
    };
  }

  async function refreshPreview() {
    if (!status || status.mode === 'container') return;
    try {
      const d = await API.deployPreview(previewParams());
      $('compose-preview').textContent = d.content;
      $('ssh-port').textContent = $('cfg-ssh').value || '10022';
    } catch (e) {
      $('compose-preview').textContent = '预览失败：' + e.message;
    }
  }

  async function saveCompose(force) {
    const btn = $('btn-compose');
    btn.disabled = true;
    try {
      const d = await API.deployCompose({ ...previewParams(), force });
      TSUtils.toast('docker-compose.yml 已生成', 'success');
      $('compose-file-info').textContent = `✓ 已生成：${d.path}`;
      await loadStatus();
    } catch (e) {
      if (e.message.includes('已存在') && confirm('docker-compose.yml 已存在，确定覆盖吗？')) {
        return saveCompose(true);
      }
      TSUtils.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ============ ③ 启动服务 ============
  async function runTask(apiCall, label, done) {
    const consoleEl = $('task-console');
    setTerm(consoleEl, [`[${label}] 执行中…`]);
    let d = null;
    try {
      d = await apiCall();
    } catch (e) {
      setTerm(consoleEl, [`[${label}] 提交失败：${e.message}`]);
      return;
    }
    // 容器化模式：操作即时完成（无 taskId）
    if (!d || !d.taskId) {
      setTerm(consoleEl, [`[${label}] 完成 ✓`]);
      if (done) done({ code: 0 });
      await loadStatus();
      return;
    }
    const taskId = d.taskId;
    if (taskTimer) clearInterval(taskTimer);
    taskTimer = setInterval(async () => {
      try {
        const t = await API.deployTask(taskId);
        setTerm(consoleEl, t.lines, '运行中…');
        if (t.status !== 'running') {
          clearInterval(taskTimer);
          taskTimer = null;
          setTerm(consoleEl, [...t.lines, `[${label}] ${taskDoneMessage(t.code)}`]);
          if (done) done(t);
          await loadStatus();
        }
      } catch (e) {
        clearInterval(taskTimer);
        taskTimer = null;
        setTerm(consoleEl, ['[任务查询失败] ' + e.message]);
      }
    }, 600);
  }

  // ============ ④ 凭证 ============
  async function extractCredentials() {
    const box = $('credentials-box');
    box.innerHTML = '<div class="empty">提取中…</div>';
    try {
      const d = await API.deployCredentials();
      if (d.found) {
        const sourceTag = d.source === 'saved' ? '<span class="badge green">已保存副本</span>'
          : d.source === 'env' ? '<span class="badge blue">来自容器配置</span>'
            : '<span class="badge yellow">已自动保存</span>';
        box.innerHTML = `
          <div class="cred-box">
            ${d.lines.map(l => `<div class="cred-line">${escape(l)}</div>`).join('')}
          </div>
          <div style="margin-top:8px">${sourceTag}
            <span class="muted" style="font-size:12px">${escape(d.note || '')}</span>
          </div>`;
      } else {
        box.innerHTML = `<div class="alert" style="margin:0">${escape(d.note || '未发现凭证')}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="empty">提取失败：${escape(e.message)}</div>`;
    }
  }

  // ============ ⑤ API Key ============
  async function saveApiKey() {
    const key = $('apikey-input').value.trim();
    if (!key) { TSUtils.toast('请输入 API Key', 'error'); return; }
    const btn = $('btn-save-key');
    btn.disabled = true;
    try {
      await API.deploySetApiKey(key);
      TSUtils.toast('API Key 已保存并生效', 'success');
      $('apikey-result').innerHTML = '<div class="empty">检测连接中…</div>';
      await checkConnection();
    } catch (e) {
      TSUtils.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // 一键生成：自动经 SSH Query 执行 apikeyadd 并保存
  async function generateApiKey(password) {
    const d = await API.deployGenerateKey(password ? { password } : undefined);
    $('apikey-input').value = d.apikey;
    TSUtils.toast('API Key 已生成并自动保存 ✓', 'success');
    $('apikey-result').innerHTML = '<div class="empty">检测连接中…</div>';
    await checkConnection();
  }

  function askPasswordAndGenerate() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '输入 serveradmin 密码';
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <div class="alert" style="margin-bottom:10px">未找到可用的 serveradmin 密码（容器环境变量或日志中都没有）。
        推荐在服务器 .env 设置 <b>TS_QUERY_ADMIN_PASSWORD</b> 后执行 docker compose up -d teamspeak；
        也可以在此直接输入服务器日志 ④ 中显示的 serveradmin 密码：</div>
      <label>serveradmin 密码
        <input type="password" id="gen-pwd" class="input" style="width:100%;margin-top:5px" autofocus>
      </label>
      <div class="modal-footer">
        <button class="btn" id="gen-cancel">取消</button>
        <button class="btn btn-primary" id="gen-ok">生成</button>
      </div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    body.querySelector('#gen-cancel').onclick = close;
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    body.querySelector('#gen-ok').onclick = async () => {
      const pwd = body.querySelector('#gen-pwd').value;
      if (!pwd) { TSUtils.toast('请输入密码', 'error'); return; }
      const okBtn = body.querySelector('#gen-ok');
      okBtn.disabled = true;
      try {
        await generateApiKey(pwd);
        close();
      } catch (e2) {
        TSUtils.toast(e2.message, 'error');
        okBtn.disabled = false;
      }
    };
    body.querySelector('#gen-pwd').focus();
  }

  $('btn-gen-key').onclick = async () => {
    const btn = $('btn-gen-key');
    btn.disabled = true;
    try {
      await generateApiKey();
    } catch (e) {
      if (e.code === 'NEED_PASSWORD') {
        askPasswordAndGenerate();
      } else {
        TSUtils.toast(e.message, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  };

  async function checkConnection() {
    const box = $('apikey-result');
    box.innerHTML = '<div class="empty">检测中…</div>';
    try {
      const d = await API.deployCheck();
      box.innerHTML = `<div class="conn-status online"><span class="dot"></span><span>连接成功：WebQuery ${escape(d.version || '')} @ ${escape(d.baseUrl)}</span></div>`;
      TSUtils.toast('WebQuery 连接成功', 'success');
    } catch (e) {
      box.innerHTML = `<div class="alert error">${escape(e.message)}</div>`;
    }
  }

  // ============ ⑥ 日志 ============
  async function refreshLogs() {
    try {
      const d = await API.deployLogs(300);
      setTerm($('logs-console'), d.log.split('\n'), '容器暂无日志输出');
    } catch (e) {
      setTerm($('logs-console'), ['读取日志失败：' + e.message]);
    }
  }

  // ============ 事件绑定 ============
  $('btn-preview').onclick = refreshPreview;
  $('btn-compose').onclick = () => saveCompose(false);
  $('btn-up').onclick = () => runTask(API.deployUp, '启动服务', (t) => {
    if (t.code === 0) {
      TSUtils.toast('服务启动完成，正在提取初始凭证…', 'success');
      setTimeout(extractCredentials, 1500);
      setTimeout(refreshLogs, 2000);
    } else {
      TSUtils.toast('启动失败，请查看任务输出', 'error');
    }
  });
  $('btn-restart').onclick = () => runTask(API.deployRestart, '重启服务');
  $('btn-down').onclick = () => {
    if (!confirm('确定停止 TeamSpeak 服务器吗？')) return;
    runTask(API.deployDown, '停止服务');
  };
  $('btn-refresh-status').onclick = loadStatus;
  $('btn-credentials').onclick = extractCredentials;
  $('btn-save-key').onclick = saveApiKey;
  $('btn-check').onclick = checkConnection;
  $('btn-logs').onclick = refreshLogs;

  // 复制按钮（事件委托）
  content.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-copy]');
    if (btn) copyText(btn.dataset.copy);
  });
  ['cfg-name', 'cfg-voice', 'cfg-file', 'cfg-webquery', 'cfg-ssh', 'cfg-password'].forEach(id => {
    $(id).addEventListener('input', debounce(refreshPreview, 400));
  });

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ============ 初始化 ============
  await loadStatus();
  await refreshPreview();
  await refreshLogs();
};
