<script setup lang="ts">
/**
 * 工作区文件浏览器（移动端全屏）
 * 功能：浏览文件树、预览文件、上传、新建文件夹/文件、删除
 */
import { ref, computed, watch } from 'vue';
import {
  X, Folder, FileText, FolderPlus, FilePlus, Upload, Trash2, Download,
  ChevronRight, ArrowLeft, Loader, RefreshCw
} from 'lucide-vue-next';
import { useAppStore, type WorkspaceEntry, type WorkspaceFileItem, type WorkspaceDirItem } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { apiService } from '../../services/api';
import { useFileViewer } from '../../composables/useFileViewer';

const appStore = useAppStore();
const agentStore = useAgentStore();
const { openWorkspaceFile } = useFileViewer();

// 智能体 ID → 名称映射（用于将 lastOperator 从 ID 解析为显示名）
const agentNameMap = computed(() => {
  const map: Record<string, string> = {};
  for (const agent of agentStore.allAgents) {
    map[agent.id] = agent.name;
  }
  return map;
});

function resolveOperatorName(operatorId: string): string {
  return agentNameMap.value[operatorId] || operatorId;
}
const loading = ref(false);
const error = ref<string | null>(null);

// 当前浏览路径（相对于工作区根目录）
const currentPath = ref<string[]>([]);

// 文件树数据
const entries = ref<WorkspaceEntry[]>([]);

// 新建表单
const showCreateForm = ref(false);
const createMode = ref<'file' | 'directory'>('file');
const createName = ref('');
const creating = ref(false);

// 删除确认
const deleteTarget = ref<WorkspaceEntry | null>(null);

const orgId = computed(() => appStore.currentOrgId);

// 面包屑路径
const breadcrumbs = computed(() => {
  const parts = ['工作区', ...currentPath.value];
  return parts;
});

// 当前目录下的条目（已排序：目录在前，文件在后，各自按名称排序）
const currentEntries = computed(() => {
  let target = entries.value;
  for (const segment of currentPath.value) {
    const dir = target.find(e => e.type === 'directory' && e.name === segment) as WorkspaceDirItem | undefined;
    if (!dir || !dir.children) return [];
    target = dir.children;
  }
  return [...target].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (a.type === 'directory') {
      return a.name.localeCompare(b.name);
    }
    return new Date((b as WorkspaceFileItem).modifiedAt).getTime() - new Date((a as WorkspaceFileItem).modifiedAt).getTime();
  });
});

// 根据文件扩展名推断 MIME 类型
const extMimeMap: Record<string, string> = {
  'txt': 'text/plain',
  'md': 'text/markdown',
  'json': 'application/json',
  'js': 'text/javascript',
  'ts': 'text/typescript',
  'jsx': 'text/javascript',
  'tsx': 'text/typescript',
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'scss': 'text/x-scss',
  'less': 'text/x-less',
  'xml': 'application/xml',
  'yaml': 'text/yaml',
  'yml': 'text/yaml',
  'csv': 'text/csv',
  'log': 'text/plain',
  'sh': 'text/x-sh',
  'bat': 'text/plain',
  'ps1': 'text/plain',
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'hpp': 'text/x-c++',
  'go': 'text/x-go',
  'rs': 'text/x-rust',
  'vue': 'text/x-vue',
  'sql': 'text/sql',
  'graphql': 'application/graphql',
  'env': 'text/plain',
  'gitignore': 'text/plain',
  'dockerfile': 'text/plain',
};

function getMimeType(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx === -1) return 'text/plain';
  const ext = filename.slice(dotIdx + 1).toLowerCase();
  return extMimeMap[ext] || 'text/plain';
}

/** 解析文件名：没有后缀时自动补 .txt */
function resolveFileName(name: string): string {
  return name.includes('.') ? name : `${name}.txt`;
}

// 文件修改时间格式化
function formatModifiedTime(isoString: string): string {
  const date = new Date(isoString);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

// 文件大小格式化
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 加载工作区文件树
async function loadWorkspace() {
  if (!orgId.value) return;
  loading.value = true;
  error.value = null;
  try {
    const data = await apiService.getWorkspaceTree(orgId.value);

    // 构建根节点
    const rootChildren: WorkspaceEntry[] = [];

    // 添加目录
    for (const dir of data.directories || []) {
      const parts = dir.path.replace(/^root\//, '').split('/');
      if (parts.length === 1 && parts[0]) {
        rootChildren.push({
          name: parts[0],
          path: dir.path,
          type: 'directory',
          children: []
        });
      }
    }

    // 添加文件（根目录下的）
    for (const file of data.files || []) {
      const relativePath = file.path.replace(/^root\//, '');
      if (!relativePath.includes('/')) {
        rootChildren.push({
          name: file.name,
          path: file.path,
          size: file.size,
          extension: file.extension,
          modifiedAt: file.modifiedAt,
          mimeType: file.mimeType,
          lastOperator: file.lastOperator,
          lastMessageId: file.lastMessageId,
          type: 'file'
        });
      }
    }

    // 递归构建子目录的文件
    async function populateDirectory(dir: WorkspaceDirItem) {
      const dirPath = dir.path.replace(/^root\//, '') + '/';
      const children: WorkspaceEntry[] = [];

      // 子目录
      for (const subDir of data.directories || []) {
        const subPath = subDir.path.replace(/^root\//, '');
        if (subPath.startsWith(dirPath) && subPath !== dirPath.replace(/\/$/, '')) {
          const remaining = subPath.slice(dirPath.length);
          if (!remaining.includes('/')) {
            const childDir: WorkspaceDirItem = {
              name: remaining,
              path: subDir.path,
              type: 'directory',
              children: []
            };
            await populateDirectory(childDir);
            children.push(childDir);
          }
        }
      }

      // 文件
      for (const file of data.files || []) {
        const fileRelative = file.path.replace(/^root\//, '');
        if (fileRelative.startsWith(dirPath) && !fileRelative.slice(dirPath.length).includes('/')) {
          children.push({
            name: file.name,
            path: file.path,
            size: file.size,
            extension: file.extension,
            modifiedAt: file.modifiedAt,
            mimeType: file.mimeType,
            lastOperator: file.lastOperator,
            lastMessageId: file.lastMessageId,
            type: 'file'
          });
        }
      }

      dir.children = children;
    }

    for (const entry of rootChildren) {
      if (entry.type === 'directory') {
        await populateDirectory(entry);
      }
    }

    entries.value = rootChildren;
  } catch (e: any) {
    error.value = e?.message || '加载工作区失败';
  } finally {
    loading.value = false;
  }
}

// 导航到子目录
function navigateToDir(dirName: string) {
  currentPath.value = [...currentPath.value, dirName];
}

// 面包屑导航
function navigateToBreadcrumb(index: number) {
  if (index === 0) {
    currentPath.value = [];
  } else {
    currentPath.value = currentPath.value.slice(0, index - 1);
  }
}

// 返回上一级
function goBack() {
  if (currentPath.value.length > 0) {
    currentPath.value.pop();
  }
}

// 点击条目
function onEntryClick(entry: WorkspaceEntry) {
  if (entry.type === 'directory') {
    navigateToDir(entry.name);
  } else {
    openFile(entry);
  }
}

// 打开文件
async function openFile(file: WorkspaceFileItem) {
  const err = await openWorkspaceFile(file);
  if (err) error.value = err;
}

// 新建文件/文件夹
async function handleCreate() {
  const name = createName.value.trim();
  if (!name || !orgId.value) return;

  creating.value = true;
  try {
    const basePath = currentPath.value.join('/');
    const relativePath = basePath ? `${basePath}/${name}` : name;

    if (createMode.value === 'directory') {
      await apiService.createWorkspaceDirectory(orgId.value, relativePath);
    } else {
      // 没有后缀自动补 .txt，根据扩展名推断 MIME 类型
      const fileName = resolveFileName(name);
      const mimeType = getMimeType(fileName);
      const fullPath = basePath ? `${basePath}/${fileName}` : fileName;
      // path 参数需包含文件名（与桌面版一致），
      // 避免空 Blob 被 multipart 解析器丢弃后服务端把目录当成文件写入。
      await apiService.uploadWorkspaceFile(orgId.value, new File(['\n'], fileName, { type: mimeType }), fullPath);
    }

    createName.value = '';
    showCreateForm.value = false;
    await loadWorkspace();
  } catch (e: any) {
    error.value = e?.message || '创建失败';
  } finally {
    creating.value = false;
  }
}

// 上传文件
async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files || !orgId.value) return;

  const basePath = currentPath.value.join('/');
  try {
    for (const file of Array.from(files)) {
      await apiService.uploadWorkspaceFile(orgId.value, file, basePath || '');
    }
    await loadWorkspace();
  } catch (e: any) {
    error.value = e?.message || '上传失败';
  } finally {
    input.value = '';
  }
}

// 下载文件
function downloadFile(entry: WorkspaceEntry) {
  if (!orgId.value) return;
  const relativePath = entry.path.replace(/^root\//, '');
  const url = `/workspace-files/${encodeURIComponent(orgId.value)}/${encodeURIComponent(relativePath)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.name;
  a.click();
}

// 删除确认
function confirmDelete(entry: WorkspaceEntry) {
  deleteTarget.value = entry;
}

async function handleDelete() {
  if (!deleteTarget.value || !orgId.value) return;
  const target = deleteTarget.value;
  try {
    const relativePath = target.path.replace(/^root\//, '');
    await apiService.deleteWorkspaceEntry(orgId.value, relativePath, target.type);
    deleteTarget.value = null;
    await loadWorkspace();
  } catch (e: any) {
    error.value = e?.message || '删除失败';
  }
}

// 关闭工作区
function close() {
  currentPath.value = [];
  entries.value = [];
  error.value = null;
  appStore.showWorkspace = false;
}

// 打开工作区时自动加载内容
watch(() => appStore.showWorkspace, (visible) => {
  if (visible) {
    currentPath.value = [];
    loadWorkspace();
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="appStore.showWorkspace"
      class="fixed inset-0 z-[150] flex flex-col bg-[var(--bg)]"
    >
      <!-- 头部 -->
      <div
        class="flex items-center gap-2 px-3 h-12 shrink-0 bg-[var(--surface-1)] border-b border-[var(--border)]"
        style="padding-top: var(--safe-top)"
      >
        <button
          class="p-1.5 -ml-1 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)] shrink-0"
          @click="close"
          type="button"
          aria-label="关闭工作区"
        >
          <X class="w-5 h-5" />
        </button>
        <h2 class="text-sm font-semibold text-[var(--text-1)] truncate flex-1">工作区</h2>
        <button
          class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
          @click="loadWorkspace"
          type="button"
          aria-label="刷新"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
        </button>
      </div>

      <!-- 错误提示 -->
      <div v-if="error" class="px-4 py-2 bg-red-500 text-white text-xs flex items-center justify-between shrink-0">
        <span class="truncate flex-1">{{ error }}</span>
        <button class="p-0.5 rounded hover:bg-white/20 shrink-0 ml-2" @click="error = null" type="button">
          <X class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- 面包屑 -->
      <div class="px-3 py-2 bg-[var(--surface-2)] flex items-center gap-1 overflow-x-auto no-scrollbar text-xs shrink-0">
        <button
          v-for="(crumb, i) in breadcrumbs"
          :key="i"
          class="shrink-0 px-1.5 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors"
          :class="i === breadcrumbs.length - 1 ? 'text-[var(--primary)] font-medium' : 'text-[var(--text-3)]'"
          @click="navigateToBreadcrumb(i)"
          type="button"
        >
          {{ crumb }}
        </button>
        <ChevronRight v-for="i in breadcrumbs.length - 1" :key="'sep-' + i" class="w-3 h-3 text-[var(--text-3)] shrink-0" />
      </div>

      <!-- 返回上级 -->
      <button
        v-if="currentPath.length > 0"
        class="flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-2)] hover:bg-[var(--surface-3)] transition-colors shrink-0 border-b border-[var(--border)]"
        @click="goBack"
        type="button"
      >
        <ArrowLeft class="w-4 h-4" />
        <span>返回上级目录</span>
      </button>

      <!-- 文件列表 -->
      <div class="flex-1 overflow-y-auto">
        <div v-if="loading && entries.length === 0" class="flex items-center justify-center h-full">
          <Loader class="w-6 h-6 text-[var(--text-3)] animate-spin" />
        </div>

        <div v-else-if="currentEntries.length === 0 && !loading" class="flex flex-col items-center justify-center h-full text-center gap-2">
          <Folder class="w-10 h-10 text-[var(--text-3)]" />
          <p class="text-sm text-[var(--text-3)]">此目录为空</p>
        </div>

        <div v-else class="py-1">
          <button
            v-for="entry in currentEntries"
            :key="entry.path"
            class="w-full flex items-center gap-3 px-4 py-2.5 active:bg-[var(--surface-3)] transition-colors text-left relative group"
            @click="onEntryClick(entry)"
            type="button"
          >
            <!-- 图标 -->
            <component
              :is="entry.type === 'directory' ? Folder : FileText"
              class="w-5 h-5 shrink-0"
              :class="entry.type === 'directory' ? 'text-[var(--primary)]' : 'text-[var(--text-3)]'"
            />

            <!-- 名称 -->
            <div class="flex-1 min-w-0">
              <div class="text-sm text-[var(--text-1)] truncate">{{ entry.name }}</div>
              <div v-if="entry.type === 'file'" class="text-xs text-[var(--text-3)] mt-0.5">
                {{ entry.extension ? entry.extension.toUpperCase() : '?' }} · {{ formatSize(entry.size) }}
                <span v-if="entry.lastOperator"> · {{ resolveOperatorName(entry.lastOperator) }}</span>
                <span v-if="entry.modifiedAt"> · {{ formatModifiedTime(entry.modifiedAt) }}</span>
              </div>
            </div>

            <!-- 下载按钮 -->
            <button
              v-if="entry.type === 'file'"
              class="p-1.5 rounded-lg text-[var(--text-3)] hover:bg-[var(--surface-3)] shrink-0"
              @click.stop="downloadFile(entry)"
              type="button"
              aria-label="下载"
            >
              <Download class="w-4 h-4" />
            </button>

            <!-- 删除按钮 -->
            <button
              class="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 shrink-0"
              @click.stop="confirmDelete(entry)"
              type="button"
              aria-label="删除"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </button>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div
        class="flex items-center gap-2 px-4 py-3 bg-[var(--surface-1)] border-t border-[var(--border)] shrink-0"
        style="padding-bottom: calc(12px + var(--safe-bottom))"
      >
        <button
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--surface-3)] text-[var(--text-2)] text-xs font-medium active:scale-95 transition-transform"
          @click="showCreateForm = true; createMode = 'directory'"
          type="button"
        >
          <FolderPlus class="w-4 h-4" />
          新建文件夹
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--surface-3)] text-[var(--text-2)] text-xs font-medium active:scale-95 transition-transform"
          @click="showCreateForm = true; createMode = 'file'"
          type="button"
        >
          <FilePlus class="w-4 h-4" />
          新建文件
        </button>
        <label class="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--surface-3)] text-[var(--text-2)] text-xs font-medium active:scale-95 transition-transform cursor-pointer">
          <Upload class="w-4 h-4" />
          上传
          <input type="file" multiple class="hidden" @change="handleUpload" />
        </label>
      </div>

      <!-- 新建表单面板 -->
      <div v-if="showCreateForm" class="fixed inset-0 z-[160] flex items-end bg-black/30" @click.self="showCreateForm = false">
        <div class="w-full bg-[var(--surface-1)] rounded-t-2xl p-4 animate-slide-up" style="padding-bottom: calc(16px + var(--safe-bottom))">
          <h3 class="text-sm font-semibold text-[var(--text-1)] mb-3">
            {{ createMode === 'directory' ? '新建文件夹' : '新建文件' }}
          </h3>
          <input
            v-model="createName"
            type="text"
            class="w-full px-3 py-2.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:border-[var(--primary)] mb-3"
            :placeholder="createMode === 'directory' ? '文件夹名称' : '文件名'"
            @keyup.enter="handleCreate"
          />
          <div class="flex gap-3">
            <button
              class="flex-1 py-2.5 rounded-lg bg-[var(--surface-3)] text-[var(--text-2)] text-sm font-medium active:scale-95 transition-transform"
              @click="showCreateForm = false; createName = ''"
              type="button"
            >
              取消
            </button>
            <button
              class="flex-1 py-2.5 rounded-lg bg-[var(--primary)] text-white text-sm font-medium active:scale-95 transition-transform disabled:opacity-50"
              :disabled="creating || !createName.trim()"
              @click="handleCreate"
              type="button"
            >
              {{ creating ? '创建中...' : '确认' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 删除确认面板 -->
      <div v-if="deleteTarget" class="fixed inset-0 z-[160] flex items-end bg-black/30" @click.self="deleteTarget = null">
        <div class="w-full bg-[var(--surface-1)] rounded-t-2xl p-4 animate-slide-up" style="padding-bottom: calc(16px + var(--safe-bottom))">
          <h3 class="text-sm font-semibold text-[var(--text-1)] mb-2">确认删除</h3>
          <p class="text-sm text-[var(--text-2)] mb-4">
            {{ deleteTarget.type === 'directory' ? `删除目录 "${deleteTarget.name}" 及其所有内容？` : `删除文件 "${deleteTarget.name}"？` }}
          </p>
          <div class="flex gap-3">
            <button
              class="flex-1 py-2.5 rounded-lg bg-[var(--surface-3)] text-[var(--text-2)] text-sm font-medium active:scale-95 transition-transform"
              @click="deleteTarget = null"
              type="button"
            >
              取消
            </button>
            <button
              class="flex-1 py-2.5 rounded-lg bg-red-500 text-white text-sm font-medium active:scale-95 transition-transform"
              @click="handleDelete"
              type="button"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
