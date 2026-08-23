/**
 * Remote 远程桥接面板 JavaScript
 *
 * 功能：
 * - Agent 可搜索选择器（支持上百个 Agent，按名称/ID/角色名过滤）
 * - 映射的增删改查
 * - 连接测试
 */

const CONFIG = {
  apiBase: '/api/modules/remote',
  initTimeout: 10000,
  // 下拉列表中单页展示数量，滚动加载
  pickerPageSize: 50,
};

const state = {
  mappings: {},
  inherited: {},   // 继承的绑定:agentId -> {sourceAgentId, config}
  agents: [],
  editingAgentId: null,
  // ---- Agent 选择器状态 ----
  selectedAgentId: null,   // 当前选中的 agent id（新增模式）
  pickerQuery: '',         // 搜索关键字
  pickerFiltered: [],      // 过滤后的结果（全量）
  pickerVisibleCount: 0,   // 当前渲染条数（虚拟滚动）
  pickerHighlight: -1,     // 高亮索引
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
 * 初始化面板
 */
function init() {
  const panel = document.querySelector('.remote-panel');
  if (!panel) {
    console.warn('Remote panel container not found');
    return;
  }

  loadMappings();
  loadAgents();
  bindPickerEvents();
}

/**
 * 切换标签页
 */
function switchTab(tabId) {
  const panel = document.querySelector('.remote-panel');
  if (!panel) return;

  panel.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  panel.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + tabId);
  });
  closePicker();
}

// ============================================================
// Agent 可搜索选择器
// ============================================================

/**
 * 绑定选择器事件
 */
function bindPickerEvents() {
  const input = document.getElementById('map-agent-search');
  const dropdown = document.getElementById('agent-picker-dropdown');
  const removeBtn = document.getElementById('chip-agent-remove');
  if (!input || !dropdown) return;

  // 聚焦/点击展开下拉
  input.addEventListener('focus', () => {
    if (state.selectedAgentId && !state.editingAgentId) {
      // 已选中时聚焦不清空选择，仅展开列表供重新选择
      state.pickerQuery = '';
      input.value = '';
      renderPickerList(true);
      openPicker();
    } else {
      renderPickerList(true);
      openPicker();
    }
  });

  input.addEventListener('input', () => {
    state.pickerQuery = input.value.trim().toLowerCase();
    state.pickerHighlight = -1;
    filterAgents();
    renderPickerList(true);
    openPicker();
  });

  input.addEventListener('keydown', (e) => {
    const list = state.pickerFiltered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.length === 0) return;
      state.pickerHighlight = (state.pickerHighlight + 1) % list.length;
      renderPickerList(false);
      scrollHighlightIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.length === 0) return;
      state.pickerHighlight = state.pickerHighlight <= 0 ? list.length - 1 : state.pickerHighlight - 1;
      renderPickerList(false);
      scrollHighlightIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = state.pickerHighlight >= 0 ? state.pickerHighlight : 0;
      if (list[idx]) {
        selectAgent(list[idx]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      input.blur();
    }
  });

  // 点击外部关闭
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('agent-picker');
    if (picker && !picker.contains(e.target)) {
      closePicker();
    }
  });

  // 清空选择按钮
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      clearPickerSelection();
      const inp = document.getElementById('map-agent-search');
      if (inp) inp.focus();
    });
  }

  // 下拉列表滚动时增量渲染（虚拟滚动）
  dropdown.addEventListener('scroll', () => {
    const total = state.pickerFiltered.length;
    if (state.pickerVisibleCount >= total) return;
    if (dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 40) {
      state.pickerVisibleCount = Math.min(total, state.pickerVisibleCount + CONFIG.pickerPageSize);
      renderPickerList(false);
    }
  });
}

/**
 * 过滤 Agent 列表
 */
function filterAgents() {
  const q = state.pickerQuery;
  const configured = new Set(Object.keys(state.mappings));

  let list = state.agents;
  if (q) {
    list = list.filter(a => {
      const name = String(a.name || '').toLowerCase();
      const role = String(a.roleName || '').toLowerCase();
      const id = String(a.id || '').toLowerCase();
      return name.includes(q) || role.includes(q) || id.includes(q);
    });
  }

  // 排序：未配置的优先，其次按名称
  list = [...list].sort((a, b) => {
    const aCfg = configured.has(String(a.id)) ? 1 : 0;
    const bCfg = configured.has(String(b.id)) ? 1 : 0;
    if (aCfg !== bCfg) return aCfg - bCfg;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });

  state.pickerFiltered = list;
  state.pickerVisibleCount = Math.min(CONFIG.pickerPageSize, list.length);
  state.pickerHighlight = state.pickerHighlight >= 0 && state.pickerHighlight < list.length ? state.pickerHighlight : (list.length > 0 ? 0 : -1);
}

/**
 * 打开下拉
 */
function openPicker() {
  const dropdown = document.getElementById('agent-picker-dropdown');
  if (dropdown) dropdown.classList.add('open');
}

/**
 * 关闭下拉
 */
function closePicker() {
  const dropdown = document.getElementById('agent-picker-dropdown');
  if (dropdown) dropdown.classList.remove('open');
}

/**
 * 渲染下拉列表（支持增量渲染）
 * @param {boolean} rebuild - 是否重建 DOM（true=过滤条件变化，false=仅更新高亮/增量追加）
 */
function renderPickerList(rebuild) {
  const dropdown = document.getElementById('agent-picker-dropdown');
  if (!dropdown) return;

  const configured = new Set(Object.keys(state.mappings));
  const total = state.pickerFiltered.length;
  const count = state.pickerVisibleCount;

  if (rebuild) {
    if (total === 0) {
      dropdown.innerHTML = `<div class="agent-picker-empty">${state.pickerQuery ? '没有匹配的 Agent' : '暂无可选 Agent'}</div>`;
      return;
    }

    const items = [];
    for (let i = 0; i < count; i++) {
      items.push(renderPickerItem(state.pickerFiltered[i], i, configured));
    }
    if (count < total) {
      items.push(`<div class="agent-picker-more">滚动加载更多（${count}/${total}）…</div>`);
    }
    dropdown.innerHTML = items.join('');
  } else {
    // 增量追加
    const existing = dropdown.querySelectorAll('.agent-picker-item').length;
    if (count > existing) {
      let html = '';
      for (let i = existing; i < count; i++) {
        html += renderPickerItem(state.pickerFiltered[i], i, configured);
      }
      dropdown.insertAdjacentHTML('beforeend', html);
    }
    // 更新高亮
    dropdown.querySelectorAll('.agent-picker-item').forEach((el, i) => {
      el.classList.toggle('highlight', i === state.pickerHighlight);
    });
  }
}

/**
 * 渲染单个选择器条目
 */
function renderPickerItem(agent, index, configured) {
  const name = String(agent.name || agent.roleName || agent.id || '?');
  const role = agent.roleName ? String(agent.roleName) : '';
  const id = String(agent.id || '');
  const isConfigured = configured.has(id);
  const highlight = index === state.pickerHighlight ? ' highlight' : '';

  const subParts = [];
  if (role && role !== name) subParts.push(role);
  subParts.push(id);

  return `
    <div class="agent-picker-item${highlight}" data-id="${escapeHtml(id)}" data-index="${index}"
         onclick="window._remotePickAgent('${escapeHtml(id)}')"
         onmouseenter="window._remoteHighlightAgent(${index})">
      <div class="agent-picker-item-main">
        <span class="agent-picker-item-name">🤖 ${escapeHtml(name)}</span>
        ${isConfigured ? '<span class="agent-picker-item-cfg">已配置</span>' : ''}
      </div>
      <div class="agent-picker-item-sub">${escapeHtml(subParts.join(' · '))}</div>
    </div>
  `;
}

/**
 * 滚动高亮项到可视区域
 */
function scrollHighlightIntoView() {
  const dropdown = document.getElementById('agent-picker-dropdown');
  if (!dropdown) return;
  const el = dropdown.querySelector('.agent-picker-item.highlight');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

/**
 * 高亮指定索引（鼠标悬停）
 */
function highlightAgent(index) {
  state.pickerHighlight = index;
  renderPickerList(false);
}

/**
 * 选中 Agent
 */
function selectAgent(agent) {
  if (!agent) return;
  state.selectedAgentId = String(agent.id);

  const input = document.getElementById('map-agent-search');
  const chip = document.getElementById('agent-picker-selected');
  const hint = document.getElementById('picker-hint');

  if (input) {
    input.value = '';
    input.placeholder = '已选择，可继续搜索以更换…';
  }
  if (chip) {
    chip.style.display = 'inline-flex';
    const nameEl = document.getElementById('chip-agent-name');
    const subEl = document.getElementById('chip-agent-sub');
    if (nameEl) nameEl.textContent = String(agent.name || agent.roleName || agent.id);
    if (subEl) {
      const parts = [];
      if (agent.roleName && String(agent.roleName) !== String(agent.name)) parts.push(String(agent.roleName));
      parts.push(String(agent.id));
      subEl.textContent = parts.join(' · ');
    }
  }
  if (hint) hint.textContent = '';
  closePicker();
}

/**
 * 清空当前选择
 */
function clearPickerSelection() {
  state.selectedAgentId = null;
  const input = document.getElementById('map-agent-search');
  const chip = document.getElementById('agent-picker-selected');
  if (input) {
    input.value = '';
    input.placeholder = '输入 Agent 名称 / ID / 角色名搜索…';
  }
  if (chip) chip.style.display = 'none';
  filterAgents();
  renderPickerList(true);
}

// ============================================================
// 数据加载
// ============================================================

/**
 * 加载 Agent 列表
 */
async function loadAgents() {
  try {
    const response = await fetch(`${CONFIG.apiBase}/agents`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.ok) {
      state.agents = data.agents || [];
      filterAgents();
      // agents 就绪后重渲染映射列表：loadMappings 可能先完成，
      // 此时 agents 未加载会导致卡片回退显示 agentId（渲染竞态）
      renderMappings();
      // 若表单可见且未选择，刷新列表
      const form = document.getElementById('mapping-form');
      if (form && form.style.display !== 'none' && !state.editingAgentId) {
        renderPickerList(true);
      }
    }
  } catch (err) {
    console.error('加载 Agent 列表失败:', err);
    const hint = document.getElementById('picker-hint');
    if (hint) hint.textContent = `⚠️ 加载 Agent 列表失败: ${err.message}`;
  }
}

/**
 * 加载映射配置
 */
async function loadMappings() {
  try {
    const response = await fetch(`${CONFIG.apiBase}/mappings`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.ok) {
      state.mappings = data.mappings || {};
      state.inherited = data.inherited || {};
      renderMappings();
    }
  } catch (err) {
    console.error('加载映射失败:', err);
    showResult('error', `加载失败: ${err.message}`);
  }
}

/**
 * 渲染映射列表
 */
function renderMappings() {
  const list = document.getElementById('mappings-list');
  if (!list) return;

  const entries = Object.entries(state.mappings);

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-text">暂无映射，点击 + 添加</div>';
    return;
  }

  const entries = Object.entries(state.mappings);
  const inheritedEntries = Object.entries(state.inherited);

  if (entries.length === 0 && inheritedEntries.length === 0) {
    list.innerHTML = '<div class="empty-text">暂无映射，点击 + 添加</div>';
    return;
  }

  // 显式配置的映射卡片（可编辑/删除）
  const explicitCards = entries.map(([agentId, config]) => {
    const agent = state.agents.find(a => String(a.id) === String(agentId));
    // 智能体名称（后端已拼好显示名：自定义名优先，其次岗位名；映射过期时回退 ID）
    const agentName = agent ? (agent.name || agentId) : agentId;
    // 组织名称-组织管理者名称（组织名称必有值；若为 null 说明组织数据链路异常，直接暴露）
    const orgLine = agent ? `${agent.orgName}-${agent.orgManagerName || agent.name || agentId}` : agentName;
    const enabled = config.enabled !== false;
    const serverInfo = `${config.username || '?'}@${config.host || '?'}:${config.port || 22}`;

    return `
      <div class="mapping-card${enabled ? '' : ' disabled'}">
        <div class="mapping-info">
          <div class="mapping-agent">
            🤖 ${escapeHtml(agentName)}
            <span class="badge ${enabled ? 'enabled' : 'disabled'}">${enabled ? '启用' : '禁用'}</span>
          </div>
          <div class="mapping-org">🏢 ${escapeHtml(orgLine)}</div>
          <div class="mapping-server">🖧 ${escapeHtml(serverInfo)}</div>
        </div>
        <div class="mapping-actions">
          <button class="btn-sm" onclick="window._remoteEditMapping('${escapeHtml(String(agentId))}')">编辑</button>
          <button class="btn-sm btn-danger" onclick="window._remoteDeleteMapping('${escapeHtml(String(agentId))}')">删除</button>
        </div>
      </div>
    `;
  });

  // 继承的映射卡片（跟随父级绑定，不可直接编辑/删除）
  const inheritedCards = inheritedEntries.map(([agentId, info]) => {
    const agent = state.agents.find(a => String(a.id) === String(agentId));
    const agentName = agent ? (agent.name || agentId) : agentId;
    const orgLine = agent ? `${agent.orgName}-${agent.orgManagerName || agent.name || agentId}` : agentName;
    const source = state.agents.find(a => String(a.id) === String(info.sourceAgentId));
    const sourceName = source ? (source.name || info.sourceAgentId) : info.sourceAgentId;
    const enabled = info.config?.enabled !== false;
    const serverInfo = `${info.config?.username || '?'}@${info.config?.host || '?'}:${info.config?.port || 22}`;

    return `
      <div class="mapping-card inherited${enabled ? '' : ' disabled'}">
        <div class="mapping-info">
          <div class="mapping-agent">
            🤖 ${escapeHtml(agentName)}
            <span class="badge inherited">继承</span>
          </div>
          <div class="mapping-org">🏢 ${escapeHtml(orgLine)}</div>
          <div class="mapping-server">🖧 ${escapeHtml(serverInfo)}</div>
          <div class="mapping-inherited-from">⬇ 继承自 ${escapeHtml(sourceName)}</div>
        </div>
      </div>
    `;
  });

  list.innerHTML = explicitCards.concat(inheritedCards).join('');
}

// ============================================================
// 表单逻辑
// ============================================================

/**
 * 显示添加/编辑表单
 */
function showAddForm(agentId) {
  const form = document.getElementById('mapping-form');
  const title = document.getElementById('form-title');
  if (!form || !title) return;

  state.editingAgentId = agentId || null;

  if (agentId) {
    title.textContent = '编辑 Agent 映射';
    const config = state.mappings[agentId] || {};

    // 编辑模式：显示只读 chip，禁用搜索框
    const agent = state.agents.find(a => String(a.id) === String(agentId));
    state.selectedAgentId = String(agentId);
    const input = document.getElementById('map-agent-search');
    if (input) {
      input.disabled = true;
      input.value = '';
      input.placeholder = '编辑模式下不可更换 Agent';
    }
    const chip = document.getElementById('agent-picker-selected');
    if (chip) {
      chip.style.display = 'inline-flex';
      const nameEl = document.getElementById('chip-agent-name');
      const subEl = document.getElementById('chip-agent-sub');
      if (nameEl) nameEl.textContent = agent ? (agent.name || agent.roleName || agentId) : agentId;
      if (subEl) {
        const parts = [];
        if (agent && agent.roleName && String(agent.roleName) !== String(agent.name)) parts.push(String(agent.roleName));
        parts.push(String(agentId));
        subEl.textContent = parts.join(' · ');
      }
    }
    const removeBtn = document.getElementById('chip-agent-remove');
    if (removeBtn) removeBtn.style.display = 'none';
    const hint = document.getElementById('picker-hint');
    if (hint) hint.textContent = '';

    setFieldValue('map-host', config.host || '');
    setFieldValue('map-port', config.port || 22);
    setFieldValue('map-username', config.username || '');
    setFieldValue('map-password', config.password || '');
    setFieldValue('map-privateKey', config.privateKey || '');
    setFieldValue('map-passphrase', config.passphrase || '');
    const enabledCheck = document.getElementById('map-enabled');
    if (enabledCheck) enabledCheck.checked = config.enabled !== false;
  } else {
    title.textContent = '添加 Agent 映射';
    clearPickerSelection();
    const input = document.getElementById('map-agent-search');
    if (input) input.disabled = false;
    const removeBtn = document.getElementById('chip-agent-remove');
    if (removeBtn) removeBtn.style.display = '';
    const hint = document.getElementById('picker-hint');
    if (hint) hint.textContent = `共 ${state.agents.length} 个 Agent，输入关键字快速过滤`;

    setFieldValue('map-host', '');
    setFieldValue('map-port', 22);
    setFieldValue('map-username', '');
    setFieldValue('map-password', '');
    setFieldValue('map-privateKey', '');
    setFieldValue('map-passphrase', '');
    const enabledCheck = document.getElementById('map-enabled');
    if (enabledCheck) enabledCheck.checked = true;

    // 打开下拉，方便直接浏览
    setTimeout(() => {
      const inputEl = document.getElementById('map-agent-search');
      if (inputEl) {
        inputEl.focus();
        filterAgents();
        renderPickerList(true);
        openPicker();
      }
    }, 50);
  }

  hideResult();
  form.style.display = 'flex';
  form.scrollIntoView({ behavior: 'smooth' });
}

/**
 * 隐藏表单
 */
function hideAddForm() {
  const form = document.getElementById('mapping-form');
  if (form) form.style.display = 'none';
  state.editingAgentId = null;
  state.selectedAgentId = null;
  clearPickerSelection();
  const input = document.getElementById('map-agent-search');
  if (input) input.disabled = false;
}

/**
 * 编辑映射
 */
function editMapping(agentId) {
  showAddForm(agentId);
}

/**
 * 删除映射
 */
async function deleteMapping(agentId) {
  const agent = state.agents.find(a => String(a.id) === String(agentId));
  const label = agent ? (agent.name || agent.roleName || agentId) : agentId;
  if (!confirm(`确定要删除 Agent "${label}" 的远程映射吗？`)) return;

  try {
    const response = await fetch(`${CONFIG.apiBase}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, config: null }),
    });

    const data = await response.json();
    if (data.error) {
      showResult('error', `删除失败: ${data.message || data.error}`);
      return;
    }

    state.mappings = data.mappings || {};
    state.inherited = data.inherited || {};
    renderMappings();
    filterAgents();
    showResult('success', '映射已删除');
  } catch (err) {
    showResult('error', `删除失败: ${err.message}`);
  }
}

/**
 * 保存映射
 */
async function saveMapping() {
  const agentId = state.editingAgentId || state.selectedAgentId;
  if (!agentId) {
    showResult('error', '请先选择 Agent（可输入名称 / ID / 角色名搜索）');
    return;
  }

  const host = getFieldValue('map-host');
  if (!host) {
    showResult('error', '请输入远程主机地址');
    return;
  }

  const config = {
    host: host,
    port: parseInt(getFieldValue('map-port'), 10) || 22,
    username: getFieldValue('map-username') || 'root',
    password: getFieldValue('map-password') || undefined,
    privateKey: getFieldValue('map-privateKey') || undefined,
    passphrase: getFieldValue('map-passphrase') || undefined,
    enabled: document.getElementById('map-enabled')?.checked ?? true,
  };

  // 清理空值
  if (!config.password) delete config.password;
  if (!config.privateKey) delete config.privateKey;
  if (!config.passphrase) delete config.passphrase;

  try {
    const response = await fetch(`${CONFIG.apiBase}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, config }),
    });

    const data = await response.json();
    if (data.error) {
      showResult('error', `保存失败: ${data.message || data.error}`);
      return;
    }

    state.mappings = data.mappings || {};
    state.inherited = data.inherited || {};
    renderMappings();
    filterAgents();
    hideAddForm();
    showResult('success', '映射已保存（立即生效）');
  } catch (err) {
    showResult('error', `保存失败: ${err.message}`);
  }
}

/**
 * 测试连接
 */
async function testConnection() {
  const host = getFieldValue('map-host');
  const username = getFieldValue('map-username');

  if (!host || !username) {
    showResult('error', '请填写主机地址和用户名');
    return;
  }

  showResult('info', '正在测试连接...');

  const config = {
    host: host,
    port: parseInt(getFieldValue('map-port'), 10) || 22,
    username: username,
    password: getFieldValue('map-password') || undefined,
    privateKey: getFieldValue('map-privateKey') || undefined,
    passphrase: getFieldValue('map-passphrase') || undefined,
  };

  if (!config.password) delete config.password;
  if (!config.privateKey) delete config.privateKey;
  if (!config.passphrase) delete config.passphrase;

  try {
    const response = await fetch(`${CONFIG.apiBase}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    const data = await response.json();
    if (data.error) {
      showResult('error', `连接失败: ${data.message || data.error}`);
      return;
    }

    showResult('success', `✅ 连接成功！系统: ${data.systemInfo || 'N/A'}`);
  } catch (err) {
    showResult('error', `连接失败: ${err.message}`);
  }
}

// ===== 工具函数 =====

function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value != null ? value : '';
}

function getFieldValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function showResult(type, message) {
  const el = document.getElementById('form-result');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'config-result config-result-' + type;
  el.textContent = message;
  setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
}

function hideResult() {
  const el = document.getElementById('form-result');
  if (el) el.style.display = 'none';
}

// 自动初始化
setTimeout(init, 0);

// 导出到全局
if (typeof window !== 'undefined') {
  window._remoteSwitchTab = switchTab;
  window._remoteShowAddForm = () => showAddForm(null);
  window._remoteHideAddForm = hideAddForm;
  window._remoteEditMapping = editMapping;
  window._remoteDeleteMapping = deleteMapping;
  window._remoteSaveMapping = saveMapping;
  window._remoteTestConnection = testConnection;
  window._remotePickAgent = (id) => {
    const agent = state.agents.find(a => String(a.id) === String(id));
    if (agent) selectAgent(agent);
  };
  window._remoteHighlightAgent = highlightAgent;
}
