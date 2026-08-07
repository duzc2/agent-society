/**
 * LocalCmd 模块面板 — 命令审核策略管理 v2
 *
 * 职责：
 * - 加载并展示全局默认策略（白名单 / 黑名单）
 * - 加载并展示各组织独立策略
 * - 保存策略到服务端
 * - 删除某一组织的独立策略（回退到默认值）
 * - 结构化条目编辑：type/pattern/reason 三字段
 */

const BASE = '/api/modules/localcmd';

/* ---- 状态 ---- */
let policies = { orgs: {}, defaults: { whitelist: [], blacklist: [] } };

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
