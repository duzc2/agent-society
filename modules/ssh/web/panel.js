/**
 * SSH 连接与传输管理面板 JavaScript
 * 适配新框架 - 作为 ES 模块执行
 */

// 配置和状态
const CONFIG = {
  apiBase: '/api/modules/ssh',
  refreshIntervalMs: 3000,
  initTimeout: 10000
};

const state = {
  hosts: [],
  connections: [],
  transfers: [],
  autoRefresh: true,
  showCompleted: false,
  refreshTimer: null,
  isLoading: false
};

/**
 * HTML 转义
 */
function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * JS 字符串转义（用于 onclick）
 */
function escapeJs(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * 格式化时间
 */
function formatTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

/**
 * 格式化字节
 */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * 初始化面板
 */
function init() {
  const panel = document.querySelector('.ssh-panel');
  if (!panel) {
    console.warn('SSH panel container not found');
    return;
  }

  // 初始化状态
  const autoRefreshCheckbox = panel.querySelector('#ssh-auto-refresh');
  if (autoRefreshCheckbox) {
    state.autoRefresh = autoRefreshCheckbox.checked;
  }

  const showCompletedCheckbox = panel.querySelector('#ssh-show-completed');
  if (showCompletedCheckbox) {
    showCompletedCheckbox.checked = state.showCompleted;
  }

  // 绑定事件
  bindEvents(panel);

  // 加载数据
  loadData();

  // 加载模块配置
  loadConfig();

  // 启动自动刷新
  if (state.autoRefresh) {
    startAutoRefresh();
  }
}

/**
 * 绑定事件
 */
function bindEvents(panel) {
  // 自动刷新开关
  const autoRefreshCheckbox = panel.querySelector('#ssh-auto-refresh');
  if (autoRefreshCheckbox) {
    autoRefreshCheckbox.addEventListener('change', (e) => {
      toggleAutoRefresh(e.target.checked);
    });
  }

  // 显示已完成开关
  const showCompletedCheckbox = panel.querySelector('#ssh-show-completed');
  if (showCompletedCheckbox) {
    showCompletedCheckbox.addEventListener('change', (e) => {
      state.showCompleted = e.target.checked;
      loadData();
    });
  }

  // 其余按钮通过 HTML 中的 onclick 内联绑定：
  // - 标签切换: onclick="window._sshSwitchTab('...')"
  // - 加载/保存配置: onclick="window._sshLoadConfig()" / onclick="window._sshSaveConfig()"
  // - 添加主机: onclick="window._sshAddHost()"
  // - 删除主机: onclick="window._sshDeleteHost(this)"
}

/**
 * 切换自动刷新
 */
function toggleAutoRefresh(enabled) {
  state.autoRefresh = enabled;
  if (enabled) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

/**
 * 切换标签页
 */
function switchTab(tabId) {
  const panel = document.querySelector('.ssh-panel');
  if (!panel) return;

  // 切换按钮状态
  panel.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });

  // 切换面板
  panel.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + tabId);
  });

  // 切换到配置页时自动加载配置
  if (tabId === 'config') {
    loadConfig();
  }
}

/**
 * 启动自动刷新
 */
function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => {
    if (!state.isLoading) {
      loadData();
    }
  }, CONFIG.refreshIntervalMs);
}

/**
 * 停止自动刷新
 */
function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

/**
 * 加载数据
 */
async function loadData() {
  if (state.isLoading) return;
  state.isLoading = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.initTimeout);

    const showCompleted = state.showCompleted ? '1' : '0';
    const response = await fetch(`${CONFIG.apiBase}/overview?showCompleted=${showCompleted}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      renderError(data.message || data.error);
      return;
    }

    // 更新状态
    state.hosts = data.hosts || [];
    state.connections = data.connections || [];
    state.transfers = data.transfers || [];

    // 渲染
    renderOverview(data);
    renderConnections();
    renderTransfers();
  } catch (err) {
    console.error('加载 SSH 数据失败:', err);
    renderError(err.message);
  } finally {
    state.isLoading = false;
  }
}

/**
 * 渲染概览统计
 */
function renderOverview(data) {
  const stats = data.stats || {};
  const hostsCount = stats.hostsCount ?? state.hosts.length;
  const activeTransfersCount = stats.activeTransfersCount ?? state.transfers.filter(t => t.status === 'pending' || t.status === 'transferring').length;

  const hostsEl = document.getElementById('stat-hosts');
  const connectionsEl = document.getElementById('stat-connections');
  const transfersEl = document.getElementById('stat-transfers');
  const activeEl = document.getElementById('stat-active');

  if (hostsEl) hostsEl.textContent = hostsCount;
  if (connectionsEl) connectionsEl.textContent = state.connections.length;
  if (transfersEl) transfersEl.textContent = state.transfers.length;
  if (activeEl) activeEl.textContent = activeTransfersCount;
}

/**
 * 渲染连接列表
 */
function renderConnections() {
  const panel = document.querySelector('.ssh-panel');
  const container = panel?.querySelector('#connections-list');
  if (!container) return;

  if (state.connections.length === 0) {
    container.innerHTML = '<div class="empty-text">暂无活动连接</div>';
    return;
  }

  container.innerHTML = state.connections.map(conn => {
    const connectionId = String(conn.connectionId || '');
    const hostName = String(conn.hostName || 'unknown');
    const status = String(conn.status || 'unknown');
    const shortId = connectionId.length > 10 ? `${connectionId.slice(0, 8)}…` : connectionId;
    const createdAt = conn.createdAt ? formatTime(conn.createdAt) : '-';
    const lastUsedAt = conn.lastUsedAt ? formatTime(conn.lastUsedAt) : '-';

    return `
      <div class="list-item">
        <div class="item-content">
          <div class="item-title">
            <span>🔗</span>
            <span>${escapeHtml(hostName)}</span>
            <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
            <span class="mono" style="color: var(--text-3, #999);">${escapeHtml(shortId)}</span>
          </div>
          <div class="item-meta">
            <span>创建: ${escapeHtml(createdAt)}</span>
            <span>最近使用: ${escapeHtml(lastUsedAt)}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="btn-secondary" data-action="copy" data-id="${escapeHtml(connectionId)}">复制ID</button>
          <button class="btn-danger" data-action="disconnect" data-id="${escapeHtml(connectionId)}">断开</button>
        </div>
      </div>
    `;
  }).join('');

  // 绑定按钮事件
  container.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.id));
  });
  container.querySelectorAll('[data-action="disconnect"]').forEach(btn => {
    btn.addEventListener('click', () => disconnect(btn.dataset.id));
  });
}

/**
 * 渲染传输列表
 */
function renderTransfers() {
  const panel = document.querySelector('.ssh-panel');
  const container = panel?.querySelector('#transfers-list');
  if (!container) return;

  if (state.transfers.length === 0) {
    container.innerHTML = '<div class="empty-text">暂无传输任务</div>';
    return;
  }

  container.innerHTML = state.transfers.map(t => {
    const taskId = String(t.taskId || '');
    const type = String(t.type || '');
    const status = String(t.status || '');
    const remotePath = String(t.remotePath || '');
    const fileName = t.fileName ? String(t.fileName) : '';
    const artifactId = t.artifactId ? String(t.artifactId) : '';
    const progress = Number.isFinite(t.progress) ? Math.max(0, Math.min(100, t.progress)) : 0;
    const bytesTransferred = Number.isFinite(t.bytesTransferred) ? t.bytesTransferred : 0;
    const totalBytes = Number.isFinite(t.totalBytes) ? t.totalBytes : 0;

    const icon = type === 'download' ? '⬇️' : type === 'upload' ? '⬆️' : '📦';
    const shortTaskId = taskId.length > 10 ? `${taskId.slice(0, 8)}…` : taskId;
    const bytesText = totalBytes > 0 ? `${formatBytes(bytesTransferred)} / ${formatBytes(totalBytes)}` : formatBytes(bytesTransferred);

    const canCancel = status === 'pending' || status === 'transferring';

    let actionsHtml = `<button class="btn-secondary" data-action="copy-task" data-id="${escapeHtml(taskId)}">复制任务ID</button>`;
    
    if (artifactId) {
      actionsHtml += `<button class="btn-secondary" data-action="open-artifact" data-id="${escapeHtml(artifactId)}">打开工件</button>`;
    }
    
    if (canCancel) {
      actionsHtml += `<button class="btn-danger" data-action="cancel" data-id="${escapeHtml(taskId)}">取消</button>`;
    }

    const errorHtml = t.error ? `<span style="color: var(--danger, #f44336);">错误: ${escapeHtml(String(t.error).slice(0, 50))}</span>` : '';

    return `
      <div class="list-item">
        <div class="item-content">
          <div class="item-title">
            <span>${icon}</span>
            <span class="mono">${escapeHtml(shortTaskId)}</span>
            <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
            <span style="color: var(--text-2, #666);">${escapeHtml(remotePath || '(无路径)')}</span>
          </div>
          <div class="item-meta">
            <span class="mono">conn: ${escapeHtml(String(t.connectionId || ''))}</span>
            <span>${escapeHtml(bytesText)}</span>
            ${fileName ? `<span>文件: ${escapeHtml(fileName)}</span>` : ''}
            ${errorHtml}
          </div>
          <div class="progress-row">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <div class="progress-text">${progress}%</div>
          </div>
        </div>
        <div class="item-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join('');

  // 绑定按钮事件
  container.querySelectorAll('[data-action="copy-task"]').forEach(btn => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.id));
  });
  container.querySelectorAll('[data-action="open-artifact"]').forEach(btn => {
    btn.addEventListener('click', () => openArtifact(btn.dataset.id));
  });
  container.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => cancelTransfer(btn.dataset.id));
  });
}

/**
 * 渲染错误
 */
function renderError(message) {
  const panel = document.querySelector('.ssh-panel');
  const containers = [
    panel?.querySelector('#stat-bar'),
    panel?.querySelector('#connections-list'),
    panel?.querySelector('#transfers-list')
  ];
  
  containers.forEach((container, index) => {
    if (container) {
      if (index === 0) {
        container.innerHTML = `<div class="error-text" style="grid-column: 1 / -1;">加载失败: ${escapeHtml(message)}</div>`;
      } else {
        container.innerHTML = `<div class="error-text">加载失败: ${escapeHtml(message)}</div>`;
      }
    }
  });
}

/**
 * 断开连接
 */
async function disconnect(connectionId) {
  if (!confirm('确定要断开该连接吗？')) return;

  try {
    const response = await fetch(`${CONFIG.apiBase}/connections/${encodeURIComponent(connectionId)}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (data.error) {
      alert(`断开失败: ${data.message || data.error}`);
      return;
    }

    await loadData();
  } catch (err) {
    alert(`断开失败: ${err.message}`);
  }
}

/**
 * 取消传输
 */
async function cancelTransfer(taskId) {
  if (!confirm('确定要取消该传输任务吗？')) return;

  try {
    const response = await fetch(`${CONFIG.apiBase}/transfers/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (data.error) {
      alert(`取消失败: ${data.message || data.error}`);
      return;
    }

    await loadData();
  } catch (err) {
    alert(`取消失败: ${err.message}`);
  }
}

/**
 * 打开工件
 */
function openArtifact(artifactId) {
  if (!artifactId) return;
  window.open(`/api/artifacts/${encodeURIComponent(artifactId)}`, '_blank', 'noopener,noreferrer');
}

/**
 * 复制到剪贴板
 */
async function copyToClipboard(text) {
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 回退方案
  }

  // 使用 textarea 复制
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * 加载模块配置
 */
async function loadConfig() {
  try {
    const response = await fetch('/api/config/modules/ssh');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const config = data.config || {};

    // 填充表单字段
    setInputValue('cfg-maxConnections', config.maxConnections, 10);
    setInputValue('cfg-connectionTimeout', config.connectionTimeout, 30000);
    setInputValue('cfg-commandTimeout', config.commandTimeout, 30000);
    setInputValue('cfg-idleTimeout', config.idleTimeout, 300000);
    setInputValue('cfg-maxOutputSize', config.maxOutputSize, 10485760);
    setInputValue('cfg-keepaliveInterval', config.keepaliveInterval, 10000);

    const verifyEl = document.getElementById('cfg-verifyHostKey');
    if (verifyEl) verifyEl.checked = !!config.verifyHostKey;

    const hosts = config.hosts || {};
    renderHostsTable(hosts);

    showConfigResult('success', '配置已加载');
  } catch (err) {
    console.error('加载 SSH 配置失败:', err);
    showConfigResult('error', `加载配置失败: ${err.message}`);
  }
}

/**
 * 保存模块配置
 */
async function saveConfig() {
  console.log('[SSH Panel] saveConfig called');

  const config = {
    maxConnections: getInputNumber('cfg-maxConnections'),
    connectionTimeout: getInputNumber('cfg-connectionTimeout'),
    commandTimeout: getInputNumber('cfg-commandTimeout'),
    idleTimeout: getInputNumber('cfg-idleTimeout'),
    maxOutputSize: getInputNumber('cfg-maxOutputSize'),
    keepaliveInterval: getInputNumber('cfg-keepaliveInterval'),
    verifyHostKey: false
  };

  const verifyEl = document.getElementById('cfg-verifyHostKey');
  if (verifyEl) config.verifyHostKey = verifyEl.checked;

  config.hosts = collectHostsFromTable();
  console.log('[SSH Panel] collected hosts:', JSON.stringify(config.hosts));
  console.log('[SSH Panel] full config to save:', JSON.stringify(config));

  try {
    const response = await fetch('/api/config/modules/ssh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.message || data.error);
    }

    showConfigResult('success', '配置已保存');
  } catch (err) {
    console.error('保存 SSH 配置失败:', err);
    showConfigResult('error', `保存配置失败: ${err.message}`);
  }
}

/**
 * 渲染主机卡片列表
 * @param {object} hosts - { hostName: { description, host, port, username, password } }
 */
function renderHostsTable(hosts) {
  const list = document.getElementById('hosts-list');
  if (!list) return;

  const entries = Object.entries(hosts || {});

  if (entries.length === 0) {
    list.innerHTML = '<div class="hosts-empty-row empty-text">暂无主机，点击 + 添加</div>';
    return;
  }

  list.innerHTML = entries.map(([name, h]) => renderHostCard(name, h)).join('');
}

function renderHostCard(name, h) {
  return `
    <div class="host-card">
      <div class="host-card-row host-card-header">
        <input class="host-card-input host-card-name" data-field="name" value="${escapeHtml(name)}" placeholder="主机名">
        <button class="btn-sm btn-danger-text" onclick="window._sshDeleteHost(this)">删除</button>
      </div>
      <div class="host-card-row">
        <input class="host-card-input" data-field="description" value="${escapeHtml(h?.description || '')}" placeholder="描述">
      </div>
      <div class="host-card-row host-card-split">
        <div class="host-card-field" style="flex:1">
          <input class="host-card-input" data-field="host" value="${escapeHtml(h?.host || '')}" placeholder="地址 192.168.1.1">
        </div>
        <div class="host-card-field host-card-field-sm">
          <input class="host-card-input" data-field="port" type="number" value="${h?.port || 22}" placeholder="22">
        </div>
      </div>
      <div class="host-card-row host-card-split">
        <div class="host-card-field" style="flex:1">
          <input class="host-card-input" data-field="username" value="${escapeHtml(h?.username || '')}" placeholder="用户名">
        </div>
        <div class="host-card-field host-card-field-sm">
          <input class="host-card-input" data-field="password" type="password" value="${escapeHtml(h?.password || '')}" placeholder="密码">
        </div>
      </div>
    </div>`;
}

function addHostRow(hostName, hostData) {
  const list = document.getElementById('hosts-list');
  if (!list) return;

  // 移除空状态
  const emptyRow = list.querySelector('.hosts-empty-row');
  if (emptyRow) emptyRow.remove();

  const data = hostData || {};
  const temp = document.createElement('div');
  temp.innerHTML = renderHostCard(hostName || '', data);

  while (temp.firstChild) {
    list.appendChild(temp.firstChild);
  }
}

function collectHostsFromTable() {
  const hosts = {};
  const list = document.getElementById('hosts-list');
  if (!list) return hosts;

  const cards = list.querySelectorAll('.host-card');
  cards.forEach(card => {
    const inputs = card.querySelectorAll('.host-card-input');
    const hostData = {};
    let hostName = '';

    inputs.forEach(input => {
      const field = input.getAttribute('data-field');
      let value = input.value.trim();
      if (field === 'port') {
        const v = parseInt(value, 10);
        value = Number.isFinite(v) ? v : 22;
      }
      if (field === 'name') {
        hostName = value;
      } else {
        hostData[field] = value;
      }
    });

    if (hostName) {
      hosts[hostName] = hostData;
    }
  });

  return hosts;
}

function setInputValue(id, value, defaultValue) {
  const el = document.getElementById(id);
  if (el) el.value = value != null ? value : defaultValue;
}

function getInputNumber(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? v : 0;
}

function showConfigResult(type, message) {
  const el = document.getElementById('config-result');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'config-result config-result-' + type;
  el.textContent = message;
  setTimeout(() => { if (el) el.style.display = 'none'; }, 3000);
}

// 自动初始化
setTimeout(init, 0);

// 导出到全局
if (typeof window !== 'undefined') {
  window.SshPanel = { init, state, loadData };
  window._sshSwitchTab = switchTab;
  window._sshLoadConfig = loadConfig;
  window._sshSaveConfig = saveConfig;
  window._sshAddHost = () => addHostRow();
  window._sshDeleteHost = (el) => {
    const card = el.closest('.host-card');
    if (card) {
      card.remove();
      const list = document.getElementById('hosts-list');
      if (list && !list.querySelector('.host-card')) {
        list.innerHTML = '<div class="hosts-empty-row empty-text">暂无主机，点击 + 添加</div>';
      }
    }
  };
}
