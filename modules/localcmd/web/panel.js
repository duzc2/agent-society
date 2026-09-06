/**
 * LocalCmd 模块面板 — 命令审核策略管理 v2 + 进程控制台 v3
 *
 * 职责：
 * - 加载并展示全局默认策略（白名单 / 黑名单）
 * - 加载并展示各组织独立策略
 * - 保存策略到服务端
 * - 删除某一组织的独立策略（回退到默认值）
 * - 结构化条目编辑：type/pattern/reason 三字段
 * - 进程控制台：live 进程列表（协议接入状态合并显示）；
 *   协议进程 → proc_event 消息流 + 结构化发送；普通进程 → 文本输出 + stdin 输入
 */

const BASE = '/api/modules/localcmd';
const PROC_API = '/api/proc-messaging';

/* ---- 状态 ---- */
let policies = { orgs: {}, defaults: { whitelist: [], blacklist: [] } };

/* ---- 进程控制台状态 ---- */
const procState = {
  live: [],               // GET /processes 的 live 进程
  protoByAddr: new Map(), // addr → 协议接入信息（hub.listProcs）
  expandedId: null,       // 当前展开的 processId
  pollTimer: null,
  outputOffset: 0,        // 普通进程文本输出读取位置
  procEvents: new Map()   // processId → [{ts, event, data}] 协议消息流（proc_event 心跳驱动）
};
/** 消息流每进程保留的最大条数（超出丢弃最旧的，防长跑进程撑爆 DOM/内存） */
const PROC_EVENTS_MAX = 200;

/* ---- DOM ---- */
const $ = id => document.getElementById(id);
const dwEntries = $('dw-entries'), dbEntries = $('db-entries'), dm = $('dm'),
      saveBtn = $('saveDefaults'), orgsEl = $('orgs'),
      loading = $('loading'), toastW = $('toastWrap'),
      orgHint = $('orgCountHint'),
      delModal = $('delModal'), delModalOrg = $('delModalOrg'),
      delModalConfirm = $('delModalConfirm'), delModalCancel = $('delModalCancel');

/* ---- 删除确认弹窗 ---- */
function showDelConfirm(orgId) {
  return new Promise((resolve) => {
    const policy = policies.orgs[orgId];
    const orgName = policy && policy.orgName
      ? policy.orgName + '-' + (policy.name || orgId)
      : orgId;
    delModalOrg.textContent = orgName;
    delModal.classList.add('show');

    const cleanup = () => {
      delModal.classList.remove('show');
      delModalConfirm.removeEventListener('click', onConfirm);
      delModalCancel.removeEventListener('click', onCancel);
    };

    function onConfirm() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    delModalConfirm.addEventListener('click', onConfirm);
    delModalCancel.addEventListener('click', onCancel);
  });
}

/* ---- 初始化 ---- */
document.addEventListener('DOMContentLoaded', () => {
  saveBtn.addEventListener('click', saveDefaults);
  $('dw-add').addEventListener('click', () => addEntryRow(dwEntries));
  $('db-add').addEventListener('click', () => addEntryRow(dbEntries));
  load();
  startProcConsole();
});

/* ---- 条目行渲染 ---- */

/**
 * 创建一条条目行 DOM
 * @param {{type: string, pattern: string, reason?: string}} entry
 * @returns {HTMLElement}
 */
function createEntryRow(entry) {
  const row = document.createElement('div');
  row.className = 'entry-row';

  const typeSel = document.createElement('select');
  typeSel.className = 'entry-type';
  typeSel.innerHTML = '<option value="glob">glob</option><option value="regex">regex</option>';
  typeSel.value = entry.type || 'glob';

  const patternInput = document.createElement('input');
  patternInput.className = 'entry-pattern';
  patternInput.value = entry.pattern || '';
  patternInput.placeholder = 'pattern...';

  const reasonInput = document.createElement('input');
  reasonInput.className = 'entry-reason';
  reasonInput.value = entry.reason || '';
  reasonInput.placeholder = '原因(可选)';

  const delBtn = document.createElement('button');
  delBtn.className = 'entry-del';
  delBtn.textContent = '\u2715';
  delBtn.addEventListener('click', () => row.remove());

  row.appendChild(typeSel);
  row.appendChild(patternInput);
  row.appendChild(reasonInput);
  row.appendChild(delBtn);
  return row;
}

/**
 * 填充一个 entries-wrap 容器
 * @param {HTMLElement} container
 * @param {Array} entries
 */
function renderEntryList(container, entries) {
  container.innerHTML = '';
  if (!entries || !entries.length) return;
  for (const entry of entries) {
    container.appendChild(createEntryRow(entry));
  }
}

/**
 * 在容器末尾添加一个空条目行
 * @param {HTMLElement} container
 */
function addEntryRow(container) {
  container.appendChild(createEntryRow({ type: 'glob', pattern: '' }));
}

/**
 * 从容器中收集 PolicyEntry 数组
 * @param {HTMLElement} container
 * @returns {{type: string, pattern: string, reason?: string}[]}
 */
function collectEntries(container) {
  const result = [];
  const rows = container.querySelectorAll('.entry-row');
  for (const row of rows) {
    const type = row.querySelector('.entry-type')?.value || 'glob';
    const pattern = (row.querySelector('.entry-pattern')?.value || '').trim();
    const reason = (row.querySelector('.entry-reason')?.value || '').trim();
    if (pattern) {
      const entry = { type, pattern };
      if (reason) entry.reason = reason;
      result.push(entry);
    }
  }
  return result;
}

/* ---- 加载 ---- */
async function load() {
  showLoad(true);
  try {
    const r = await fetch(BASE + '/policies');
    const d = await r.json();
    policies.orgs = d.orgs || {};
    policies.defaults = d.defaults || { whitelist: [], blacklist: [] };
    renderEntryList(dwEntries, policies.defaults.whitelist);
    renderEntryList(dbEntries, policies.defaults.blacklist);
    renderOrgs();
  } catch (e) {
    toast('加载失败: ' + e.message);
  } finally {
    showLoad(false);
  }
}

/* ---- 渲染组织策略列表 ---- */
function renderOrgs() {
  const ids = Object.keys(policies.orgs);
  orgHint.textContent = ids.length
    ? '已为 ' + ids.length + ' 个组织设置了独立策略，将覆盖默认策略'
    : '暂无，将沿用默认策略';

  // 清除旧组织卡片
  orgsEl.querySelectorAll('.org-card').forEach(el => el.remove());

  for (const id of ids) {
    const policy = policies.orgs[id];
    const orgName = policy.orgName
      ? policy.orgName + '-' + (policy.name || id)
      : id;
    const card = document.createElement('div');
    card.className = 'org-card';

    card.innerHTML =
      '<div class="org-card-head">' +
        '<h3>' + esc(orgName) + '</h3>' +
        '<button class="btn btn-sm btn-danger" data-org="' + esc(id) + '" data-act="del">删除</button>' +
      '</div>' +
      '<div class="org-card-body">' +
        '<div class="half">' +
          '<label>白名单 · 允许执行</label>' +
          '<div class="entries-wrap" data-org="' + esc(id) + '" data-fld="wl"></div>' +
          '<button class="entry-add-btn" data-org="' + esc(id) + '" data-fld="wl" data-act="add">+ 添加</button>' +
        '</div>' +
        '<div class="half">' +
          '<label>黑名单 · 禁止执行</label>' +
          '<div class="entries-wrap" data-org="' + esc(id) + '" data-fld="bl"></div>' +
          '<button class="entry-add-btn" data-org="' + esc(id) + '" data-fld="bl" data-act="add">+ 添加</button>' +
        '</div>' +
      '</div>' +
      '<div class="org-card-foot">' +
        '<button class="btn btn-sm" data-org="' + esc(id) + '" data-act="save">保存</button>' +
      '</div>';

    orgsEl.appendChild(card);

    // 填充条目
    const wlWrap = card.querySelector('[data-fld="wl"]');
    const blWrap = card.querySelector('[data-fld="bl"]');
    renderEntryList(wlWrap, policy.whitelist || []);
    renderEntryList(blWrap, policy.blacklist || []);
  }

  // 绑定事件
  orgsEl.querySelectorAll('[data-act="save"]').forEach(b =>
    b.addEventListener('click', () => saveOrg(b.dataset.org)));
  orgsEl.querySelectorAll('[data-act="del"]').forEach(b =>
    b.addEventListener('click', () => delOrg(b.dataset.org)));
  orgsEl.querySelectorAll('[data-act="add"]').forEach(b =>
    b.addEventListener('click', () => {
      const wrap = document.querySelector(
        '[data-org="' + CSS.escape(b.dataset.org) + '"][data-fld="' + b.dataset.fld + '"]'
      );
      if (wrap) addEntryRow(wrap);
    }));
}

/* ---- 保存默认策略 ---- */
async function saveDefaults() {
  const body = {
    whitelist: collectEntries(dwEntries),
    blacklist: collectEntries(dbEntries)
  };
  dm.className = 'msg';
  dm.textContent = '';
  showLoad(true);
  try {
    await fetch(BASE + '/policies/defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    dm.className = 'msg msg-ok';
    dm.textContent = '已保存';
    setTimeout(() => { dm.textContent = ''; }, 2500);
  } catch (e) {
    dm.className = 'msg msg-err';
    dm.textContent = e.message;
  } finally {
    showLoad(false);
  }
}

/* ---- 保存组织策略 ---- */
async function saveOrg(orgId) {
  const wlWrap = document.querySelector('[data-org="' + CSS.escape(orgId) + '"][data-fld="wl"]');
  const blWrap = document.querySelector('[data-org="' + CSS.escape(orgId) + '"][data-fld="bl"]');

  const body = {
    whitelist: wlWrap ? collectEntries(wlWrap) : [],
    blacklist: blWrap ? collectEntries(blWrap) : []
  };
  showLoad(true);
  try {
    await fetch(BASE + '/policies/' + encodeURIComponent(orgId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    toast('已保存');
    await load();
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  } finally {
    showLoad(false);
  }
}

/* ---- 删除组织策略 ---- */
async function delOrg(orgId) {
  const ok = await showDelConfirm(orgId);
  if (!ok) return;
  showLoad(true);
  try {
    await fetch(BASE + '/policies/' + encodeURIComponent(orgId), { method: 'DELETE' });
    toast('已删除');
    await load();
  } catch (e) {
    toast('删除失败: ' + e.message, true);
  } finally {
    showLoad(false);
  }
}

/* ---- 工具 ---- */
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function showLoad(v) { loading.classList.toggle('show', v); }

function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast ' + (err ? 'toast-err' : 'toast-ok');
  el.textContent = msg;
  toastW.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

/* ============================================================
 * 进程控制台（v3）
 * ============================================================ */

/** proc_event 心跳处理：追加到对应进程的消息流（面板为 iframe，父页面心跳；无心跳时仅列表轮询） */
function onProcEvent(msg) {
  const p = msg.payload || {};
  const pid = p.processId;
  if (!pid || !procState.procEvents.has(pid)) return; // 未展开/未知进程不积累
  const list = procState.procEvents.get(pid);
  list.push({ ts: p.ts || Date.now(), event: p.event || '', data: p.data ?? null, procError: p.event === 'proc_error' });
  if (list.length > PROC_EVENTS_MAX) list.splice(0, list.length - PROC_EVENTS_MAX);
  if (procState.expandedId === pid) renderProcStream(pid);
}

/** 启动控制台：先订阅 proc_event 心跳（若父页面注入 heartbeatService 不可用则仅轮询），再 3s 轮询列表 */
function startProcConsole() {
  try {
    // 面板以 iframe 嵌入主应用；父窗口心跳服务通过 CustomEvent 广播 proc_event（与 agent-notify 同约定）
    window.addEventListener('proc-event', (e) => onProcEvent(e.detail));
  } catch (e) { /* 事件源不可用时仅列表轮询 */ }

  refreshProcs();
  procState.pollTimer = setInterval(refreshProcs, 3000);
}

/** 轮询：live 进程 + 协议接入状态，合并渲染 */
async function refreshProcs() {
  try {
    const [liveR, protoR] = await Promise.all([
      fetch(BASE + '/processes').then(r => r.json()).catch(() => null),
      fetch(PROC_API + '/processes').then(r => r.json()).catch(() => null)
    ]);
    procState.live = (liveR && liveR.processes) || [];
    procState.protoByAddr = new Map();
    if (protoR && protoR.ok && Array.isArray(protoR.processes)) {
      for (const p of protoR.processes) procState.protoByAddr.set(p.addr, p);
    }
    renderProcList();
  } catch (e) {
    // 轮询失败静默（下一轮重试），不弹 toast 刷屏
  }
}

/** 渲染进程列表（合并视图：命令摘要 + 状态 + 协议标记） */
function renderProcList() {
  const wrap = $('procList');
  if (!procState.live.length) {
    wrap.innerHTML = '<div class="empty">暂无进程记录</div>';
    return;
  }
  // 新进程在前（列表接口本身无序，按 createdAt 倒序）
  const items = [...procState.live].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  wrap.innerHTML = items.map(p => {
    const running = p.status === 'running';
    return '<div class="proc-item' + (procState.expandedId === p.id ? ' expanded' : '') + '" data-pid="' + esc(p.id) + '">' +
      '<div class="proc-head">' +
        '<span class="proc-dot ' + (running ? 'on' : 'off') + '"></span>' +
        '<span class="proc-cmd" title="' + esc(p.command + ' ' + (p.args || []).join(' ')) + '">' + esc(p.command + ' ' + (p.args || []).join(' ')) + '</span>' +
        '<span class="proc-status">' + esc(p.status) + (p.exitCode !== null && p.exitCode !== undefined ? ' (' + p.exitCode + ')' : '') + '</span>' +
      '</div>' +
      '<div class="proc-body" id="proc-body-' + esc(p.id) + '"></div>' +
    '</div>';
  }).join('');

  for (const el of wrap.querySelectorAll('.proc-item')) {
    el.querySelector('.proc-head').addEventListener('click', () => toggleProc(el.dataset.pid));
  }

  // 展开态保持：重渲染后重建展开区内容
  if (procState.expandedId) {
    const still = items.some(p => p.id === procState.expandedId);
    if (still) toggleProc(procState.expandedId, true);
    else collapseProc();
  }
}

/** 展开/收起一个进程的控制台区（force 展开用于重渲染恢复） */
function toggleProc(processId, force) {
  if (!force && procState.expandedId === processId) { collapseProc(); return; }
  collapseProc();
  procState.expandedId = processId;
  procState.outputOffset = 0;
  if (!procState.procEvents.has(processId)) procState.procEvents.set(processId, []);
  const el = document.querySelector('[data-pid="' + CSS.escape(processId) + '"]');
  if (el) el.classList.add('expanded');
  renderProcConsole(processId);
}

/** 收起全部 */
function collapseProc() {
  if (!procState.expandedId) return;
  const el = document.querySelector('[data-pid="' + CSS.escape(procState.expandedId) + '"]');
  if (el) el.classList.remove('expanded');
  procState.expandedId = null;
}

/** 渲染展开区：协议进程 → 消息流 + 结构化发送；普通进程 → 文本输出 + stdin 输入 */
function renderProcConsole(processId) {
  const body = document.getElementById('proc-body-' + CSS.escape(processId));
  if (!body) return;
  const live = procState.live.find(p => p.id === processId);
  const isProto = live && live.status === 'running' && isProtoConnected(processId);

  body.innerHTML = isProto
    ? '<div class="proc-stream" id="proc-stream-' + esc(processId) + '"></div>' +
      '<div class="proc-input-row">' +
        '<input class="proc-input" id="proc-input-' + esc(processId) + '" placeholder=\'消息 JSON，如 {"text":"hi"}；纯文本自动包为 {"text":"..."}\'>' +
        '<button class="btn btn-sm" id="proc-send-' + esc(processId) + '">发送</button>' +
      '</div>' +
      '<div class="proc-warn" id="proc-warn-' + esc(processId) + '"></div>'
    : '<pre class="proc-output" id="proc-output-' + esc(processId) + '"></pre>' +
      '<div class="proc-input-row">' +
        '<input class="proc-input" id="proc-stdin-' + esc(processId) + '" placeholder="发送到 stdin（自动补换行）" ' + (live && live.status === 'running' ? '' : 'disabled') + '>' +
        '<button class="btn btn-sm" id="proc-stdin-send-' + esc(processId) + '" ' + (live && live.status === 'running' ? '' : 'disabled') + '>发送</button>' +
      '</div>';

  if (isProto) {
    document.getElementById('proc-send-' + CSS.escape(processId)).addEventListener('click', () => sendProtoMessage(processId));
    document.getElementById('proc-input-' + CSS.escape(processId)).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendProtoMessage(processId);
    });
    renderProcStream(processId);
  } else {
    document.getElementById('proc-stdin-send-' + CSS.escape(processId))?.addEventListener('click', () => sendStdin(processId));
    pollProcOutput(processId);
  }
}

/** 协议连接判定：live 进程的 command 无法直接对上 hub 注册的 name——
 *  简化处理：展开时查一次 /api/proc-messaging/processes 的最新缓存中
 *  是否存在 connectedAt 晚于进程启动且 agent 侧 processId === 该进程 id 的记录。
 *  hub.listProcs 不带 localcmd processId 时（未握手），退化为显示普通文本控制台。 */
function isProtoConnected(processId) {
  for (const p of procState.protoByAddr.values()) {
    if (p.processId === processId) return true;
  }
  return false;
}

/** 渲染协议进程消息流（procEvents 内该进程的条目） */
function renderProcStream(processId) {
  const el = document.getElementById('proc-stream-' + CSS.escape(processId));
  if (!el) return;
  const list = procState.procEvents.get(processId) || [];
  el.innerHTML = list.length
    ? list.map(e =>
        '<div class="stream-line' + (e.procError ? ' err' : '') + '">' +
          '<span class="stream-ts">' + new Date(e.ts).toLocaleTimeString() + '</span>' +
          '<span class="stream-event">' + esc(e.event) + '</span>' +
          '<span class="stream-data">' + esc(typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? '')) + '</span>' +
        '</div>'
      ).join('')
    : '<div class="empty">暂无消息（进程 notifyWeb 的事件在此显示）</div>';
  el.scrollTop = el.scrollHeight;
}

/** 发送结构化消息到协议进程 */
async function sendProtoMessage(processId) {
  const input = document.getElementById('proc-input-' + CSS.escape(processId));
  const warn = document.getElementById('proc-warn-' + CSS.escape(processId));
  const raw = (input.value || '').trim();
  if (!raw) return;
  let payload;
  try {
    payload = raw.startsWith('{') ? JSON.parse(raw) : { text: raw };
  } catch (e) {
    warn.textContent = 'JSON 解析失败: ' + e.message;
    return;
  }
  warn.textContent = '';
  try {
    const r = await fetch(PROC_API + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: processId, payload })
    });
    const d = await r.json();
    if (!d.ok) { warn.textContent = '发送失败: ' + (d.error || r.status); return; }
    input.value = '';
  } catch (e) {
    warn.textContent = '发送失败: ' + e.message;
  }
}

/** 普通进程：文本输出 offset 轮询（3s，与列表轮询共用节拍） */
async function pollProcOutput(processId) {
  const el = document.getElementById('proc-output-' + CSS.escape(processId));
  if (!el || procState.expandedId !== processId) return;
  try {
    const r = await fetch(BASE + '/history/' + encodeURIComponent(processId) + '/output?offset=' + procState.outputOffset + '&window=65536');
    const d = await r.json();
    if (d.ok && d.content) {
      el.textContent += d.content;
      procState.outputOffset = d.nextOffset;
      el.scrollTop = el.scrollHeight;
    }
  } catch (e) { /* 下一轮重试 */ }
  if (procState.expandedId === processId) {
    setTimeout(() => pollProcOutput(processId), 3000);
  }
}

/** 普通进程：stdin 输入 */
async function sendStdin(processId) {
  const input = document.getElementById('proc-stdin-' + CSS.escape(processId));
  const raw = input.value || '';
  if (!raw) return;
  try {
    const r = await fetch(BASE + '/processes/' + encodeURIComponent(processId) + '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: raw + '\n' })
    });
    const d = await r.json();
    if (d.ok) input.value = '';
    else toast('发送失败: ' + (d.error || '未知错误'), true);
  } catch (e) {
    toast('发送失败: ' + e.message, true);
  }
}
