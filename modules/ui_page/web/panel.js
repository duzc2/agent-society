/**
 * Web JS 自动加载 — 管理面板逻辑
 *
 * 列表展示自动加载脚本（名称/路径/工作区/状态），支持搜索过滤、启用/禁用/删除。
 * 删除仅移除自动加载记录，不删除工作区文件。
 * 主题：检测宿主（同源 iframe）是否处于 .my-app-dark 深色模式，同步面板配色。
 */
const API_BASE = '/api/modules/ui_page/auto-load-scripts';

/** @type {Array<object>} 全量脚本列表（用于前端过滤） */
let allScripts = [];
/** @type {Array<object>} 全量候选列表（用于前端过滤） */
let allCandidates = [];

/** HTML 转义（name/workspaceId 等来自外部数据，渲染时必须转义） */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 按搜索词过滤（匹配名称/路径/工作区，不区分大小写） */
function matches(entry, keyword) {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return (
    String(entry.name ?? '').toLowerCase().includes(k) ||
    String(entry.path ?? '').toLowerCase().includes(k) ||
    String(entry.workspaceId ?? '').toLowerCase().includes(k)
  );
}

/* ===== 主题同步 ===== */

/**
 * 跟随宿主主题：宿主 <html> 有 .my-app-dark 时切换为深色。
 * 宿主与 iframe 同源（同一 http://localhost:port），可读父文档。
 */
function syncTheme() {
  try {
    const parentRoot = window.parent?.document?.documentElement;
    const isDark = !!parentRoot?.classList?.contains('my-app-dark');
    document.documentElement.classList.toggle('panel-dark', isDark);
  } catch {
    // 跨域或父文档不可访问时保持浅色兜底（CSS :root 已定义可读配色）
  }
}

/** 监听宿主主题切换（.my-app-dark 类变化），实时同步 */
function watchParentTheme() {
  try {
    const parentRoot = window.parent?.document?.documentElement;
    if (!parentRoot) return;
    const observer = new MutationObserver(() => syncTheme());
    observer.observe(parentRoot, { attributes: true, attributeFilter: ['class'] });
  } catch {
    // 不可访问父文档时忽略（浅色兜底）
  }
}

/* ===== 列表渲染 ===== */

/** 加载并渲染列表 */
async function load() {
  const res = await fetch(API_BASE);
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || data.error);
  allScripts = data.scripts || [];
  render();
}

/** 渲染脚本表格（按当前搜索词过滤） */
function render() {
  const list = document.getElementById('auto-scripts-list');
  if (!list) return;

  const keyword = (document.getElementById('search-input')?.value ?? '').trim();
  const filtered = allScripts.filter((s) => matches(s, keyword));

  const countEl = document.getElementById('list-count');
  if (countEl) {
    countEl.textContent = keyword ? `匹配 ${filtered.length} / ${allScripts.length}` : `共 ${allScripts.length} 条`;
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <tr><td colspan="5"><div class="empty-text">${
        keyword
          ? '未找到匹配的脚本。'
          : '暂无自动加载脚本。智能体执行 JS 后，在保存提示中勾选「自动加载」即可添加。'
      }</div></td></tr>`;
    return;
  }

  list.innerHTML = filtered.map((s) => `
    <tr class="${s.enabled === false ? 'disabled' : ''}">
      <td class="cell-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</td>
      <td class="cell-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</td>
      <td class="cell-ws" title="${escapeHtml(s.workspaceId)}">${escapeHtml(s.workspaceId)}</td>
      <td><span class="badge ${s.enabled === false ? 'disabled' : 'enabled'}">${s.enabled === false ? '已停用' : '已启用'}</span></td>
      <td class="cell-actions">
        <label class="toggle" title="启用/停用">
          <input type="checkbox" class="auto-toggle" data-id="${escapeHtml(s.id)}" ${s.enabled === false ? '' : 'checked'}>
          <span>启用</span>
        </label>
        <button type="button" class="btn-danger auto-remove" data-id="${escapeHtml(s.id)}" title="移除自动加载（不删除文件）">删除</button>
      </td>
    </tr>
  `).join('');
}

/** 启用/禁用 */
async function toggleEnabled(id, enabled) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, enabled })
  });
  const data = await res.json();
  if (!data.ok) {
    showResult('error', data.message || data.error);
    return;
  }
  allScripts = data.scripts || [];
  render();
}

/** 删除（仅移除自动加载记录，不删除工作区文件） */
async function removeScript(id) {
  if (!confirm('确定将该脚本从自动加载中移除吗？（不会删除工作区文件）')) return;
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, remove: true })
  });
  const data = await res.json();
  if (!data.ok) {
    showResult('error', data.message || data.error);
    return;
  }
  allScripts = data.scripts || [];
  render();
  showResult('success', '已从自动加载移除（工作区文件保留）');
}

/* ===== 添加脚本 ===== */

/** 打开"添加脚本"弹层：列出所有工作区 ui_page_js/ 下尚未加入自动加载的脚本 */
async function openAddModal() {
  const res = await fetch(API_BASE + '/available');
  const data = await res.json();
  if (!data.ok) {
    showResult('error', data.message || data.error);
    return;
  }
  allCandidates = data.candidates || [];
  document.getElementById('candidate-search').value = '';
  renderCandidates();
  document.getElementById('add-modal').style.display = 'flex';
}

/** 渲染候选列表（按当前搜索词过滤） */
function renderCandidates() {
  const body = document.getElementById('add-candidates');
  if (!body) return;

  const keyword = (document.getElementById('candidate-search')?.value ?? '').trim();
  const filtered = allCandidates.filter((c) => matches(c, keyword));

  const countEl = document.getElementById('candidate-count');
  if (countEl) {
    countEl.textContent = keyword ? `匹配 ${filtered.length} / ${allCandidates.length}` : `共 ${allCandidates.length} 个可添加`;
  }

  if (filtered.length === 0) {
    body.innerHTML = `<div class="empty-text">${
      keyword
        ? '未找到匹配的脚本。'
        : '没有可添加的脚本：所有工作区 ui_page_js/ 下的脚本都已加入自动加载。'
    }</div>`;
    return;
  }

  body.innerHTML = filtered.map((c) => `
    <div class="candidate-item" data-ws="${escapeHtml(c.workspaceId)}" data-path="${escapeHtml(c.path)}" title="点击添加">
      <span class="candidate-name">${escapeHtml(c.name)}</span>
      <span class="candidate-path">${escapeHtml(c.path)}</span>
      <span class="candidate-ws">${escapeHtml(c.workspaceId)}</span>
    </div>
  `).join('');
}

function closeAddModal() {
  document.getElementById('add-modal').style.display = 'none';
}

/** 添加脚本到自动加载（仅记录路径，不复制文件） */
async function addCandidate(workspaceId, scriptPath) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, path: scriptPath })
  });
  const data = await res.json();
  if (!data.ok) {
    showResult('error', data.message || data.error);
    return;
  }
  allScripts = data.scripts || [];
  closeAddModal();
  render();
  showResult('success', '已添加：' + scriptPath);
}

/* ===== 结果提示 ===== */

/** 结果提示（3 秒后自动消失） */
function showResult(type, message) {
  const el = document.getElementById('panel-result');
  if (!el) return;
  el.className = 'config-result config-result-' + type;
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(showResult._timer);
  showResult._timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

/* ===== 事件绑定 ===== */

// 搜索框（主列表 + 候选弹层）
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', render);
}
const candidateSearch = document.getElementById('candidate-search');
if (candidateSearch) {
  candidateSearch.addEventListener('input', renderCandidates);
}

// 主列表：事件委托（避免内联 onclick 的转义问题）
const list = document.getElementById('auto-scripts-list');
if (list) {
  list.addEventListener('change', (e) => {
    const target = e.target;
    if (target && target.classList && target.classList.contains('auto-toggle')) {
      toggleEnabled(target.dataset.id, target.checked).catch((err) => showResult('error', err.message));
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.auto-remove') : null;
    if (btn) {
      removeScript(btn.dataset.id).catch((err) => showResult('error', err.message));
    }
  });
}

// 添加脚本：打开/关闭弹层、点候选条目添加
const btnAdd = document.getElementById('btn-add-script');
if (btnAdd) {
  btnAdd.addEventListener('click', () => {
    openAddModal().catch((err) => showResult('error', err.message));
  });
}
const btnClose = document.getElementById('btn-close-modal');
if (btnClose) {
  btnClose.addEventListener('click', closeAddModal);
}
const btnCancel = document.getElementById('btn-cancel-modal');
if (btnCancel) {
  btnCancel.addEventListener('click', closeAddModal);
}
const addModal = document.getElementById('add-modal');
if (addModal) {
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) {
      // 点击遮罩关闭
      closeAddModal();
      return;
    }
    const item = e.target.closest ? e.target.closest('.candidate-item') : null;
    if (item) {
      addCandidate(item.dataset.ws, item.dataset.path).catch((err) => showResult('error', err.message));
    }
  });
}

// 初始化：主题同步 + 初始加载
syncTheme();
watchParentTheme();
load().catch((err) => showResult('error', err.message));
