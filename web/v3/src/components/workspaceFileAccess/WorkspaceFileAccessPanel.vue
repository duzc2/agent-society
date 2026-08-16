<script setup lang="ts">
/**
 * 文件权限设置窗口
 *
 * 替代旧独立工作区文件访问面板页面的 Vue 实现。
 * 保持原有“全局 + 组织”结构，并复用当前应用的 CSS 变量以支持明暗主题。
 */
import { ref, reactive, computed, watch, onMounted } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Dialog from 'primevue/dialog';
import { useToast } from 'primevue/usetoast';
import {
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  Save,
  Building2,
  ShieldCheck,
  FileText,
  TestTube2,
} from 'lucide-vue-next';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import {
  workspaceFileAccessApi,
  type WorkspaceFolder,
  type WorkspaceFolderSource,
  type WorkspaceOrg,
  type WorkspaceAccessLog,
  type WorkspaceOperation,
  type WorkspaceCheckPathResult,
} from '../../services/workspaceFileAccessApi';

const toast = useToast();

const PAGE_SIZE = 20;

const orgs = ref<WorkspaceOrg[]>([]);
const selectedOrgId = ref('');
const folders = ref<WorkspaceFolder[]>([]);
const logs = ref<WorkspaceAccessLog[]>([]);
const totalLogs = ref(0);
const page = ref(0);
const operationFilter = ref<WorkspaceOperation | ''>('');
const agentFilter = ref('');
const todayAccessCount = ref(0);
const retentionDays = ref(30);

const orgsLoading = ref(false);
const foldersLoading = ref(false);
const logsLoading = ref(false);
const statsLoading = ref(false);
const retentionSaving = ref(false);

const folderDialogVisible = ref(false);
const editingFolderId = ref('');
const folderSaving = ref(false);
const folderError = ref('');
const folderForm = reactive({
  path: '',
  description: '',
  read: true,
  write: false,
});

const pathChecking = ref(false);
const pathCheckResult = ref<WorkspaceCheckPathResult | null>(null);
const pathCheckError = ref('');

const deleteConfirmVisible = ref(false);
const pendingDeleteFolder = ref<WorkspaceFolder | null>(null);
const deletingFolder = ref(false);

let agentFilterTimer: ReturnType<typeof setTimeout> | undefined;

const isOrgMode = computed(() => selectedOrgId.value !== '');
const folderCount = computed(() => folders.value.length);
const readOnlyCount = computed(() => folders.value.filter(f => f.read && !f.write).length);
const readWriteCount = computed(() => folders.value.filter(f => f.read && f.write).length);

const globalFolders = computed(() =>
  isOrgMode.value
    ? folders.value.filter(f => f._source === 'global' || f._source === 'overridden')
    : folders.value,
);

const orgFolders = computed(() =>
  isOrgMode.value
    ? folders.value.filter(f => f._source === 'org' || f._source === 'org_override')
    : [],
);

const selectedOrgLabel = computed(() => {
  if (!selectedOrgId.value) return '';
  const org = orgs.value.find(item => item.orgId === selectedOrgId.value);
  return org ? getOrgLabel(org) : selectedOrgId.value;
});

const folderDialogTitle = computed(() =>
  editingFolderId.value ? '编辑授权文件夹' : '添加授权文件夹',
);

const deleteConfirmMessage = computed(() => {
  const folder = pendingDeleteFolder.value;
  return folder
    ? `确定要删除授权文件夹 "${folder.path}" 吗？\n\n这将移除智能体对该文件夹的访问权限。`
    : '';
});

const totalPages = computed(() => Math.max(1, Math.ceil(totalLogs.value / PAGE_SIZE)));

const operationOptions: Array<{ value: WorkspaceOperation | ''; label: string }> = [
  { value: '', label: '所有操作' },
  { value: 'read', label: '读取' },
  { value: 'write', label: '写入' },
  { value: 'list', label: '列目录' },
  { value: 'create_dir', label: '创建目录' },
  { value: 'copy', label: '复制文件' },
  { value: 'check_permission', label: '权限检查' },
];

function getErrorMessage(code?: string): string {
  const messages: Record<string, string> = {
    invalid_path: '路径无效',
    path_already_exists: '该路径已存在',
    path_not_accessible: '路径不存在或无法访问',
    folder_not_found: '文件夹不存在',
    save_failed: '保存失败',
    invalid_days: '请输入有效的天数',
  };

  if (!code) return '操作失败';
  return messages[code] || code;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '未知错误';
}

function showSuccess(detail: string): void {
  toast.add({ severity: 'success', summary: '成功', detail, life: 3000 });
}

function showError(detail: string): void {
  console.error('[WorkspaceFileAccessPanel]', detail);
  toast.add({ severity: 'error', summary: '错误', detail, life: 5000 });
}

function getOrgLabel(org: WorkspaceOrg): string {
  const base = org.orgName
    ? org.orgName
    : org.orgId;
  const label = org.firstAgentName ? `${base}-${org.firstAgentName}` : base;
  return org.folderCount > 0 ? `${label} [${org.folderCount}项]` : label;
}

function sourceInfo(source?: WorkspaceFolderSource): { label: string; className: string } | null {
  switch (source) {
    case 'global':
      return { label: '继承全局', className: 'bg-[var(--surface-3)] text-[var(--text-3)]' };
    case 'overridden':
      return { label: '已被覆盖', className: 'bg-[var(--surface-3)] text-[var(--text-2)]' };
    case 'org_override':
      return { label: '覆盖全局设置', className: 'bg-[var(--primary-weak)] text-[var(--primary)]' };
    case 'org':
      return { label: '组织独有', className: 'bg-[var(--primary-weak)] text-[var(--primary)]' };
    default:
      return null;
  }
}

function operationText(operation: WorkspaceOperation): string {
  const texts: Record<WorkspaceOperation, string> = {
    read: '读取',
    write: '写入',
    list: '列目录',
    create_dir: '创建目录',
    copy: '复制文件',
    check_permission: '权限检查',
  };
  return texts[operation] || operation;
}

function operationBadgeClass(operation: WorkspaceOperation): string {
  const base = 'px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap';
  const styles: Record<WorkspaceOperation, string> = {
    read: 'bg-[var(--primary-weak)] text-[var(--primary)]',
    write: 'bg-[var(--primary-weak)] text-[var(--primary)]',
    list: 'bg-[var(--surface-3)] text-[var(--text-2)]',
    create_dir: 'bg-[var(--surface-3)] text-[var(--text-2)]',
    copy: 'bg-[var(--surface-3)] text-[var(--text-2)]',
    check_permission: 'bg-[var(--surface-3)] text-[var(--text-3)]',
  };
  return `${base} ${styles[operation] || 'bg-[var(--surface-3)] text-[var(--text-3)]'}`;
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

async function loadOrgs(): Promise<void> {
  orgsLoading.value = true;
  try {
    const data = await workspaceFileAccessApi.getOrgs();
    if (data.ok) {
      orgs.value = data.orgs || [];
    } else {
      showError(`加载组织列表失败：${getErrorMessage(data.error)}`);
      orgs.value = [];
    }
  } catch (err) {
    showError(`加载组织列表失败：${toErrorMessage(err)}`);
    orgs.value = [];
  } finally {
    orgsLoading.value = false;
  }
}

async function loadFolders(): Promise<void> {
  foldersLoading.value = true;
  try {
    const data = await workspaceFileAccessApi.getFolders(selectedOrgId.value || undefined);
    if (data.ok) {
      folders.value = data.folders || [];
    } else {
      showError(`加载文件夹失败：${getErrorMessage(data.error)}`);
      folders.value = [];
    }
  } catch (err) {
    showError(`加载文件夹失败：${toErrorMessage(err)}`);
    folders.value = [];
  } finally {
    foldersLoading.value = false;
  }
}

async function loadLogs(): Promise<void> {
  logsLoading.value = true;
  try {
    const data = await workspaceFileAccessApi.getLogs({
      limit: PAGE_SIZE,
      offset: page.value * PAGE_SIZE,
      operation: operationFilter.value || undefined,
      agentId: agentFilter.value.trim() || undefined,
    });
    logs.value = data.logs || [];
    totalLogs.value = data.total || 0;
  } catch (err) {
    showError(`加载访问日志失败：${toErrorMessage(err)}`);
    logs.value = [];
    totalLogs.value = 0;
  } finally {
    logsLoading.value = false;
  }
}

async function loadStats(): Promise<void> {
  statsLoading.value = true;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await workspaceFileAccessApi.getStats({ startTime: today.toISOString() });
    if (data.ok && data.stats) {
      todayAccessCount.value = data.stats.total || 0;
    } else {
      showError(`加载今日统计失败：${getErrorMessage(data.error)}`);
    }
  } catch (err) {
    showError(`加载今日统计失败：${toErrorMessage(err)}`);
  } finally {
    statsLoading.value = false;
  }
}

async function loadRetention(): Promise<void> {
  try {
    const data = await workspaceFileAccessApi.getRetentionDays(selectedOrgId.value || undefined);
    if (data.ok && typeof data.logRetentionDays === 'number') {
      retentionDays.value = data.logRetentionDays;
    } else {
      showError(`加载保留天数失败：${getErrorMessage(data.error)}`);
    }
  } catch (err) {
    showError(`加载保留天数失败：${toErrorMessage(err)}`);
  }
}

async function saveRetention(): Promise<void> {
  if (!Number.isFinite(retentionDays.value) || retentionDays.value < 1) {
    showError('请输入有效的天数');
    return;
  }

  retentionSaving.value = true;
  try {
    const result = await workspaceFileAccessApi.saveRetentionDays(
      retentionDays.value,
      selectedOrgId.value || undefined,
    );
    if (result.ok) {
      showSuccess('设置已保存');
    } else {
      showError(getErrorMessage(result.error));
    }
  } catch (err) {
    showError(`保存失败：${toErrorMessage(err)}`);
  } finally {
    retentionSaving.value = false;
  }
}

function openAddFolder(): void {
  editingFolderId.value = '';
  folderForm.path = '';
  folderForm.description = '';
  folderForm.read = true;
  folderForm.write = false;
  folderError.value = '';
  pathCheckResult.value = null;
  pathCheckError.value = '';
  folderDialogVisible.value = true;
}

function openEditFolder(folder: WorkspaceFolder): void {
  editingFolderId.value = folder.id;
  folderForm.path = folder.path;
  folderForm.description = folder.description || '';
  folderForm.read = folder.read;
  folderForm.write = folder.write;
  folderError.value = '';
  pathCheckResult.value = null;
  pathCheckError.value = '';
  folderDialogVisible.value = true;
}

async function saveFolder(): Promise<void> {
  const path = folderForm.path.trim();
  if (!path) {
    folderError.value = '请输入文件夹路径';
    return;
  }
  if (!folderForm.read && !folderForm.write) {
    folderError.value = '请至少选择一种权限';
    return;
  }

  folderSaving.value = true;
  folderError.value = '';
  try {
    const orgId = selectedOrgId.value || undefined;
    const result = editingFolderId.value
      ? await workspaceFileAccessApi.updateFolder(
          editingFolderId.value,
          {
            read: folderForm.read,
            write: folderForm.write,
            description: folderForm.description.trim(),
          },
          orgId,
        )
      : await workspaceFileAccessApi.addFolder(
          {
            path,
            read: folderForm.read,
            write: folderForm.write,
            description: folderForm.description.trim(),
          },
          orgId,
        );

    if (result.ok) {
      showSuccess(editingFolderId.value ? '更新成功' : '添加成功');
      folderDialogVisible.value = false;
      await loadFolders();
      await loadOrgs();
    } else {
      folderError.value = getErrorMessage(result.error);
    }
  } catch (err) {
    folderError.value = `操作失败：${toErrorMessage(err)}`;
  } finally {
    folderSaving.value = false;
  }
}

async function testPath(): Promise<void> {
  const path = folderForm.path.trim();
  pathCheckResult.value = null;
  pathCheckError.value = '';

  if (!path) {
    pathCheckError.value = '请先输入路径';
    return;
  }

  pathChecking.value = true;
  try {
    const result = await workspaceFileAccessApi.checkPath(path);
    if (result.ok) {
      pathCheckResult.value = result;
    } else {
      pathCheckError.value = getErrorMessage(result.error) || result.message || '检查失败';
    }
  } catch (err) {
    pathCheckError.value = `检查失败：${toErrorMessage(err)}`;
  } finally {
    pathChecking.value = false;
  }
}

function requestDeleteFolder(folder: WorkspaceFolder): void {
  pendingDeleteFolder.value = folder;
  deleteConfirmVisible.value = true;
}

async function handleDeleteConfirmed(): Promise<void> {
  const folder = pendingDeleteFolder.value;
  if (!folder) return;

  deletingFolder.value = true;
  try {
    const result = await workspaceFileAccessApi.deleteFolder(
      folder.id,
      selectedOrgId.value || undefined,
    );
    if (result.ok) {
      showSuccess('删除成功');
      deleteConfirmVisible.value = false;
      await loadFolders();
      await loadOrgs();
    } else {
      showError(getErrorMessage(result.error));
    }
  } catch (err) {
    showError(`删除失败：${toErrorMessage(err)}`);
  } finally {
    deletingFolder.value = false;
  }
}

function changePage(nextPage: number): void {
  if (nextPage < 0 || nextPage >= totalPages.value) return;
  page.value = nextPage;
  loadLogs();
}

watch(selectedOrgId, () => {
  page.value = 0;
  loadFolders();
  loadRetention();
});

watch(operationFilter, () => {
  page.value = 0;
  loadLogs();
});

watch(agentFilter, () => {
  if (agentFilterTimer) clearTimeout(agentFilterTimer);
  agentFilterTimer = setTimeout(() => {
    page.value = 0;
    loadLogs();
  }, 300);
});

onMounted(() => {
  loadOrgs();
  loadFolders();
  loadLogs();
  loadStats();
  loadRetention();
});
</script>

<template>
  <div class="h-full flex flex-col bg-[var(--surface-1)] text-[var(--text-1)]">
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <!-- 组织选择区 -->
      <section class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2 min-w-[220px] flex-1">
            <Building2 class="w-4 h-4 text-[var(--text-3)] shrink-0" />
            <span class="text-sm font-medium text-[var(--text-2)] shrink-0">组织</span>
            <select
              v-model="selectedOrgId"
              class="flex-1 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-weak)]"
            >
              <option value="">-- 全局配置 --</option>
              <option
                v-for="org in orgs"
                :key="org.orgId"
                :value="org.orgId"
              >
                {{ getOrgLabel(org) }}
              </option>
            </select>
            <Loader2 v-if="orgsLoading" class="w-4 h-4 animate-spin text-[var(--text-3)] shrink-0" />
          </div>

          <div v-if="isOrgMode" class="flex items-center gap-2">
            <span class="inline-flex items-center rounded-full bg-[var(--primary-weak)] px-3 py-1 text-xs font-medium text-[var(--primary)]">
              <ShieldCheck class="w-3.5 h-3.5 mr-1" />
              {{ selectedOrgLabel }}
            </span>
            <Button
              variant="text"
              size="small"
              @click="selectedOrgId = ''"
            >
              ✕ 返回全局
            </Button>
          </div>
        </div>
      </section>

      <!-- 统计卡片 -->
      <section class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
          <div class="text-2xl font-bold text-[var(--primary)]">{{ folderCount }}</div>
          <div class="mt-1 text-xs text-[var(--text-3)]">授权文件夹</div>
        </div>
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
          <div class="text-2xl font-bold text-[var(--primary)]">{{ readOnlyCount }}</div>
          <div class="mt-1 text-xs text-[var(--text-3)]">只读权限</div>
        </div>
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
          <div class="text-2xl font-bold text-[var(--primary)]">{{ readWriteCount }}</div>
          <div class="mt-1 text-xs text-[var(--text-3)]">读写权限</div>
        </div>
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
          <Loader2 v-if="statsLoading" class="mx-auto h-6 w-6 animate-spin text-[var(--text-3)]" />
          <div v-else class="text-2xl font-bold text-[var(--primary)]">{{ todayAccessCount }}</div>
          <div class="mt-1 text-xs text-[var(--text-3)]">今日访问</div>
        </div>
      </section>

      <!-- 授权文件夹列表 -->
      <section class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
        <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div class="flex items-center gap-2">
            <FolderOpen class="w-4 h-4 text-[var(--primary)]" />
            <h2 class="text-sm font-semibold">授权文件夹列表</h2>
          </div>
          <Button
            variant="primary"
            size="small"
            @click="openAddFolder"
          >
            <Plus class="w-4 h-4 mr-1" />
            添加文件夹
          </Button>
        </div>

        <div v-if="foldersLoading" class="flex items-center justify-center py-10">
          <Loader2 class="h-6 w-6 animate-spin text-[var(--text-3)]" />
        </div>

        <div v-else class="p-3 space-y-3">
          <div v-if="folders.length === 0" class="py-10 text-center text-sm text-[var(--text-3)]">
            <FolderOpen class="mx-auto mb-2 h-10 w-10 opacity-40" />
            <p>暂无授权的文件夹</p>
            <p class="mt-1 text-xs">点击“添加文件夹”按钮开始配置</p>
          </div>

          <template v-else-if="!isOrgMode">
            <div
              v-for="folder in globalFolders"
              :key="folder.id"
              class="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3"
            >
              <FolderOpen class="w-5 h-5 text-[var(--primary)] shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="break-all font-mono text-sm text-[var(--text-1)]">{{ folder.path }}</span>
                  <span
                    v-if="sourceInfo(folder._source)"
                    class="px-2 py-0.5 rounded text-[10px] font-medium"
                    :class="sourceInfo(folder._source)!.className"
                  >
                    {{ sourceInfo(folder._source)!.label }}
                  </span>
                </div>
                <p v-if="folder.description" class="mt-1 text-xs text-[var(--text-3)]">{{ folder.description }}</p>
              </div>
              <div class="flex items-center gap-1.5">
                <span v-if="folder.read" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可读</span>
                <span v-if="folder.write" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可写</span>
              </div>
              <div class="flex items-center gap-1">
                <Button
                  variant="text"
                  size="small"
                  @click="openEditFolder(folder)"
                >
                  <Pencil class="w-3.5 h-3.5 mr-1" />
                  编辑
                </Button>
                <Button
                  variant="text"
                  size="small"
                  class="!text-red-500"
                  @click="requestDeleteFolder(folder)"
                >
                  <Trash2 class="w-3.5 h-3.5 mr-1" />
                  删除
                </Button>
              </div>
            </div>
          </template>

          <template v-else>
            <div>
              <div class="mb-2 text-xs font-semibold text-[var(--text-2)]">继承全局 ({{ globalFolders.length }})</div>
              <div v-if="globalFolders.length === 0" class="rounded-lg border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-3)]">（无继承项）</div>
              <div v-else class="space-y-2">
                <div
                  v-for="folder in globalFolders"
                  :key="folder.id"
                  class="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3"
                >
                  <FolderOpen class="w-5 h-5 text-[var(--primary)] shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all font-mono text-sm text-[var(--text-1)]">{{ folder.path }}</span>
                      <span
                        v-if="sourceInfo(folder._source)"
                        class="px-2 py-0.5 rounded text-[10px] font-medium"
                        :class="sourceInfo(folder._source)!.className"
                      >
                        {{ sourceInfo(folder._source)!.label }}
                      </span>
                    </div>
                    <p v-if="folder.description" class="mt-1 text-xs text-[var(--text-3)]">{{ folder.description }}</p>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span v-if="folder.read" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可读</span>
                    <span v-if="folder.write" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可写</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="text"
                      size="small"
                      @click="openEditFolder(folder)"
                    >
                      <Pencil class="w-3.5 h-3.5 mr-1" />
                      编辑
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      class="!text-red-500"
                      @click="requestDeleteFolder(folder)"
                    >
                      <Trash2 class="w-3.5 h-3.5 mr-1" />
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div class="border-t border-dashed border-[var(--border)] pt-3">
              <div class="mb-2 text-xs font-semibold text-[var(--text-2)]">组织独有 ({{ orgFolders.length }})</div>
              <div v-if="orgFolders.length === 0" class="rounded-lg border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-3)]">（无独有项）</div>
              <div v-else class="space-y-2">
                <div
                  v-for="folder in orgFolders"
                  :key="folder.id"
                  class="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3"
                >
                  <FolderOpen class="w-5 h-5 text-[var(--primary)] shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="break-all font-mono text-sm text-[var(--text-1)]">{{ folder.path }}</span>
                      <span
                        v-if="sourceInfo(folder._source)"
                        class="px-2 py-0.5 rounded text-[10px] font-medium"
                        :class="sourceInfo(folder._source)!.className"
                      >
                        {{ sourceInfo(folder._source)!.label }}
                      </span>
                    </div>
                    <p v-if="folder.description" class="mt-1 text-xs text-[var(--text-3)]">{{ folder.description }}</p>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span v-if="folder.read" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可读</span>
                    <span v-if="folder.write" class="px-2 py-0.5 rounded bg-[var(--primary-weak)] text-[10px] text-[var(--primary)]">可写</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="text"
                      size="small"
                      @click="openEditFolder(folder)"
                    >
                      <Pencil class="w-3.5 h-3.5 mr-1" />
                      编辑
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      class="!text-red-500"
                      @click="requestDeleteFolder(folder)"
                    >
                      <Trash2 class="w-3.5 h-3.5 mr-1" />
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- 访问日志 -->
      <section class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div class="flex items-center gap-2">
            <FileText class="w-4 h-4 text-[var(--primary)]" />
            <h2 class="text-sm font-semibold">访问日志</h2>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <select
              v-model="operationFilter"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text-1)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-weak)]"
            >
              <option
                v-for="option in operationOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <InputText
              v-model="agentFilter"
              placeholder="智能体名称/ID"
              class="!w-36 !text-xs !py-1.5 !bg-[var(--surface-1)]"
            />
            <Button
              variant="text"
              size="small"
              @click="page = 0; loadLogs()"
            >
              <RefreshCw class="w-3.5 h-3.5 mr-1" />
              刷新
            </Button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-left text-sm">
            <thead class="bg-[var(--surface-3)] text-xs text-[var(--text-2)]">
              <tr>
                <th class="px-3 py-2 font-medium">时间</th>
                <th class="px-3 py-2 font-medium">智能体</th>
                <th class="px-3 py-2 font-medium">组织</th>
                <th class="px-3 py-2 font-medium">操作</th>
                <th class="px-3 py-2 font-medium">路径</th>
                <th class="px-3 py-2 font-medium">结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="logsLoading">
                <td colspan="6" class="px-3 py-8 text-center text-[var(--text-3)]">
                  <Loader2 class="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
              <tr v-else-if="logs.length === 0">
                <td colspan="6" class="px-3 py-8 text-center text-xs text-[var(--text-3)]">暂无日志记录</td>
              </tr>
              <tr
                v-for="log in logs"
                :key="log.id"
                class="border-b border-[var(--border)] bg-[var(--surface-1)] last:border-b-0"
              >
                <td class="px-3 py-2 font-mono text-xs text-[var(--text-2)] whitespace-nowrap">{{ formatDate(log.timestamp) }}</td>
                <td class="px-3 py-2 text-xs text-[var(--text-2)]" :title="`ID: ${log.agentId}`">{{ log.agentName }}</td>
                <td class="px-3 py-2 text-xs text-[var(--text-2)]">{{ log.orgName || '—' }}</td>
                <td class="px-3 py-2">
                  <span :class="operationBadgeClass(log.operation)">{{ operationText(log.operation) }}</span>
                </td>
                <td class="px-3 py-2 max-w-[300px] truncate font-mono text-xs text-[var(--text-2)]" :title="log.path">{{ log.path }}</td>
                <td class="px-3 py-2 text-xs">
                  <span :class="log.success ? 'text-green-500' : 'text-red-500'">
                    {{ log.success ? '✓ 成功' : '✗ 失败' }}
                  </span>
                  <p v-if="log.error" class="mt-1 text-[10px] text-red-400">{{ log.error }}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 border-t border-[var(--border)] px-4 py-3">
          <Button
            variant="text"
            size="small"
            :disabled="page === 0"
            @click="changePage(page - 1)"
          >
            上一页
          </Button>
          <span class="text-xs text-[var(--text-2)]">第 {{ page + 1 }} / {{ totalPages }} 页</span>
          <Button
            variant="text"
            size="small"
            :disabled="page >= totalPages - 1"
            @click="changePage(page + 1)"
          >
            下一页
          </Button>
        </div>
      </section>

      <!-- 保留天数设置 -->
      <section class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div class="flex items-center gap-2">
            <ShieldCheck class="w-4 h-4 text-[var(--primary)]" />
            <h2 class="text-sm font-semibold">设置</h2>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <label class="text-sm text-[var(--text-2)]">日志保留天数</label>
          <div class="flex items-center gap-2">
            <InputNumber
              v-model="retentionDays"
              :min="1"
              :max="365"
              class="!w-28"
            />
            <Button
              variant="primary"
              size="small"
              :loading="retentionSaving"
              @click="saveRetention"
            >
              <Save class="w-3.5 h-3.5 mr-1" />
              保存
            </Button>
          </div>
        </div>
      </section>
    </div>

    <!-- 添加/编辑授权文件夹对话框 -->
    <Dialog
      v-model:visible="folderDialogVisible"
      :header="folderDialogTitle"
      :style="{ width: '520px' }"
      :modal="false"
      :dismissable-mask="false"
      :closable="!folderSaving"
      :close-on-escape="false"
      :keep-in-viewport="false"
      pt:content:class="!p-0"
    >
      <div class="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        <div v-if="folderError" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ folderError }}
        </div>

        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            文件夹路径 <span class="text-red-500">*</span>
          </label>
          <InputText
            v-model="folderForm.path"
            placeholder="/path/to/folder"
            class="w-full"
          />
          <p class="mt-1 text-xs text-[var(--text-3)]">绝对路径，如 /home/user/documents</p>
        </section>

        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">描述</label>
          <InputText
            v-model="folderForm.description"
            placeholder="文件夹用途描述"
            class="w-full"
          />
        </section>

        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">权限</label>
          <div class="flex items-center gap-6">
            <label class="flex items-center gap-2 text-sm text-[var(--text-2)] cursor-pointer">
              <input
                v-model="folderForm.read"
                type="checkbox"
                class="h-4 w-4 rounded border-[var(--border)]"
              />
              允许读取
            </label>
            <label class="flex items-center gap-2 text-sm text-[var(--text-2)] cursor-pointer">
              <input
                v-model="folderForm.write"
                type="checkbox"
                class="h-4 w-4 rounded border-[var(--border)]"
              />
              允许写入
            </label>
          </div>
        </section>

        <div class="flex items-center justify-between gap-2">
          <Button
            variant="text"
            size="small"
            :loading="pathChecking"
            @click="testPath"
          >
            <TestTube2 class="w-3.5 h-3.5 mr-1" />
            测试路径
          </Button>
        </div>

        <div v-if="pathCheckResult" class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-2)]">
          <p>路径存在：{{ pathCheckResult.exists ? '是' : '否' }}</p>
          <p>类型：{{ pathCheckResult.isDirectory ? '目录' : '文件' }}</p>
          <p>读取权限：{{ pathCheckResult.canRead ? '✓' : '✗' }}</p>
          <p>写入权限：{{ pathCheckResult.canWrite ? '✓' : '✗' }}</p>
        </div>
        <div v-else-if="pathCheckError" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {{ pathCheckError }}
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2 px-6 py-3">
          <Button
            variant="text"
            :disabled="folderSaving"
            @click="folderDialogVisible = false"
          >
            取消
          </Button>
          <Button
            variant="primary"
            :loading="folderSaving"
            @click="saveFolder"
          >
            <Save class="w-4 h-4 mr-1" />
            {{ editingFolderId ? '保存' : '添加' }}
          </Button>
        </div>
      </template>
    </Dialog>

    <ConfirmDialog
      v-model:visible="deleteConfirmVisible"
      title="删除授权文件夹"
      :message="deleteConfirmMessage"
      confirm-label="删除"
      cancel-label="取消"
      confirm-severity="danger"
      :loading="deletingFolder"
      @confirm="handleDeleteConfirmed"
    />
  </div>
</template>
