<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--surface-1)] text-[var(--text-1)]">
    <div class="border-b border-[var(--border)] px-4 py-3">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div class="text-sm font-medium text-[var(--text-1)]">{{ skill?.displayName || '加载中' }}</div>
            <span
              v-if="skill"
              class="rounded-full px-2 py-0.5 text-xs"
              :class="skill.status === 'enabled' ? 'bg-green-500/10 text-green-600' : 'bg-[var(--surface-3)] text-[var(--text-3)]'"
            >
              {{ skill.status === 'enabled' ? '启用' : '停用' }}
            </span>
            <span
              v-if="selectedNodeType === 'file' && selectedPath"
              class="rounded-full px-2 py-0.5 text-xs"
              :class="hasUnsavedChanges ? 'bg-blue-500/10 text-blue-600' : 'bg-[var(--surface-3)] text-[var(--text-3)]'"
            >
              {{ hasUnsavedChanges ? '未保存' : '已同步' }}
            </span>
          </div>
          <div class="mt-1 text-xs text-[var(--text-3)]">{{ skillId }}</div>
          <div v-if="selectedPath" class="mt-1 text-xs text-[var(--text-3)]">当前路径：{{ selectedPath }}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" variant="outlined" :loading="openingDirectory" title="打开文件夹" @click="handleOpenDirectory">
            <FolderOpen class="w-4 h-4 text-[var(--primary)]" />
          </Button>
          <Button size="small" variant="outlined" @click="openCreateFileDialog">新建文件</Button>
          <Button size="small" variant="outlined" @click="openCreateFolderDialog">新建文件夹</Button>
          <Button size="small" variant="outlined" :disabled="!selectedPath" @click="openRenameDialog">重命名</Button>
          <Button size="small" variant="outlined" severity="danger" :disabled="!selectedPath" @click="openDeleteDialog">删除当前项</Button>
        </div>
      </div>
      <div v-if="serverUpdatedNotice" class="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        服务器内容已更新，左侧已刷新为最新内容，右侧保留当前编辑内容。
      </div>
      <div v-if="error" class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{{ error }}</div>
    </div>

    <Splitter class="flex-1 border-none">
      <SplitterPanel :size="22" :minSize="18" class="flex flex-col border-r border-[var(--border)] bg-[var(--surface-2)]">
        <div class="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-3)]">文件树</div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <button
            v-for="node in visibleNodes"
            :key="node.path"
            type="button"
            class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors"
            :class="selectedPath === node.path ? 'bg-[var(--primary)]/10 text-[var(--primary)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-3)]'"
            :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
            @click="handleNodeClick(node)"
          >
            <span class="w-4 shrink-0 text-center text-xs text-[var(--text-3)]">{{ node.type === 'directory' ? (expandedDirs.has(node.path) ? '▾' : '▸') : '·' }}</span>
            <span class="min-w-0 flex-1 truncate">{{ node.name }}</span>
            <span v-if="node.type === 'file' && fileStateMap[node.path]?.serverChanged" class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">服务器已更新</span>
            <span v-if="node.type === 'file' && fileStateMap[node.path]?.dirty" class="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-700">未保存</span>
          </button>
        </div>
      </SplitterPanel>

      <SplitterPanel :size="78" class="flex min-h-0 flex-col bg-[var(--bg)]">
        <div v-if="selectedNodeType !== 'file'" class="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">请选择一个文件开始编辑</div>

        <template v-else>
          <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <div class="flex items-center gap-4">
              <span class="text-xs text-[var(--text-3)]">本地编辑内容</span>
              <div class="flex items-center gap-2">
                <InputSwitch v-model="showDiff" inputId="diff-toggle" />
                <label for="diff-toggle" class="text-xs text-[var(--text-3)]">对比模式</label>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs text-[var(--text-3)]">字号</span>
                <Slider v-model="editorFontSize" :min="10" :max="24" :step="1" class="w-20" />
                <span class="text-xs text-[var(--text-3)] w-6">{{ editorFontSize }}</span>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <Button
                v-if="hasUnsavedChanges"
                size="small"
                variant="outlined"
                severity="warn"
                @click="openRevertDialog"
              >
                撤销全部修改
              </Button>
              <Button size="small" :disabled="selectedNodeType !== 'file'" :loading="saving" @click="saveCurrentFile">保存</Button>
            </div>
          </div>
          <div class="min-h-0 flex-1">
            <SkillDiffEditor
              v-if="showDiff"
              :leftContent="serverContentByPath[selectedPath] || ''"
              :rightContent="localDraftByPath[selectedPath] || ''"
              :fontSize="editorFontSize"
              class="h-full w-full"
              @update:rightContent="(content: string) => localDraftByPath = { ...localDraftByPath, [selectedPath]: content }"
            />
            <textarea
              v-else
              v-model="currentDraft"
              class="h-full w-full resize-none font-mono outline-none"
              :style="{
                background: 'var(--surface-1)',
                color: 'var(--text-1)',
                caretColor: 'var(--text-1)',
                padding: '12px',
                lineHeight: '20px',
                fontSize: editorFontSize + 'px'
              }"
              spellcheck="false"
            />
          </div>
        </template>
      </SplitterPanel>
    </Splitter>

    <!-- 新建文件对话框 -->
    <InputDialog
      v-model:visible="createFileDialogVisible"
      title="新建文件"
      inputLabel="文件名"
      :inputPlaceholder="createFileDefaultPath || '例如：src/utils.ts'"
      :defaultValue="createFileDefaultPath || ''"
      confirmLabel="创建"
      @confirm="handleCreateFile"
    />

    <!-- 新建文件夹对话框 -->
    <InputDialog
      v-model:visible="createFolderDialogVisible"
      title="新建文件夹"
      inputLabel="文件夹路径"
      :inputPlaceholder="createFolderDefaultPath || '例如：src/utils'"
      :defaultValue="createFolderDefaultPath || ''"
      confirmLabel="创建"
      @confirm="handleCreateFolder"
    />

    <!-- 重命名对话框 -->
    <InputDialog
      v-model:visible="renameDialogVisible"
      title="重命名"
      inputLabel="新路径"
      :inputPlaceholder="selectedPath || '请输入新路径'"
      :defaultValue="selectedPath"
      confirmLabel="确定"
      @confirm="handleRename"
    />

    <!-- 删除确认对话框 -->
    <ConfirmDialog
      v-model:visible="deleteDialogVisible"
      title="确认删除"
      :message="`确定要删除 ${selectedPath} 吗？此操作不可撤销。`"
      confirmLabel="删除"
      confirmSeverity="danger"
      @confirm="handleDelete"
    />

    <!-- 撤销确认对话框 -->
    <ConfirmDialog
      v-model:visible="revertDialogVisible"
      title="撤销修改"
      message="确定要撤销当前文件的所有修改吗？将恢复为服务器版本。"
      confirmLabel="撤销"
      confirmSeverity="primary"
      @confirm="handleRevert"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import InputSwitch from 'primevue/inputswitch';
import Slider from 'primevue/slider';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import { useToast } from 'primevue/usetoast';
import { FolderOpen } from 'lucide-vue-next';
import { customSkillApi, type CustomSkillRecord, type CustomSkillTreeNode } from '../../../services/customSkillApi';
import SkillDiffEditor from './SkillDiffEditor.vue';
import ConfirmDialog from '../../common/ConfirmDialog.vue';
import InputDialog from '../../common/InputDialog.vue';

interface VisibleTreeNode extends CustomSkillTreeNode {
  depth: number;
}

const toast = useToast();
const dialogRef = inject<any>('dialogRef');
const dialogData = dialogRef?.value?.data || {};
const skillId = String(dialogData.skillId || '');
const skill = ref<CustomSkillRecord | null>(null);
const tree = ref<CustomSkillTreeNode[]>([]);
const selectedPath = ref('');
const selectedNodeType = ref<'file' | 'directory' | ''>('');
const saving = ref(false);
const openingDirectory = ref(false);
const error = ref('');
const serverUpdatedNotice = ref(false);
const expandedDirs = ref<Set<string>>(new Set());
const serverContentByPath = ref<Record<string, string>>({});
const localDraftByPath = ref<Record<string, string>>({});
const serverVersionAtPath = ref<Record<string, string>>({});
const showDiff = ref(false);
const editorFontSize = ref(14);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// 对话框状态
const createFileDialogVisible = ref(false);
const createFileDefaultPath = ref('');
const createFolderDialogVisible = ref(false);
const createFolderDefaultPath = ref('');
const renameDialogVisible = ref(false);
const deleteDialogVisible = ref(false);
const revertDialogVisible = ref(false);

const visibleNodes = computed<VisibleTreeNode[]>(() => {
  const result: VisibleTreeNode[] = [];
  const visit = (nodes: CustomSkillTreeNode[], depth: number) => {
    for (const node of nodes) {
      result.push({ ...node, depth });
      if (node.type === 'directory' && expandedDirs.value.has(node.path)) {
        visit(node.children || [], depth + 1);
      }
    }
  };
  visit(tree.value, 0);
  return result;
});

const currentDraft = computed<string>({
  get: () => localDraftByPath.value[selectedPath.value] || '',
  set: (value: string) => {
    if (!selectedPath.value) return;
    localDraftByPath.value = {
      ...localDraftByPath.value,
      [selectedPath.value]: value
    };
  }
});

const hasUnsavedChanges = computed(() => {
  if (!selectedPath.value || selectedNodeType.value !== 'file') {
    return false;
  }
  return (serverContentByPath.value[selectedPath.value] || '') !== (localDraftByPath.value[selectedPath.value] || '');
});

const fileStateMap = computed<Record<string, { dirty: boolean; serverChanged: boolean }>>(() => {
  const state: Record<string, { dirty: boolean; serverChanged: boolean }> = {};
  const paths = new Set<string>([
    ...Object.keys(serverContentByPath.value),
    ...Object.keys(localDraftByPath.value),
    ...Object.keys(serverVersionAtPath.value)
  ]);
  for (const filePath of paths) {
    state[filePath] = {
      dirty: (serverContentByPath.value[filePath] || '') !== (localDraftByPath.value[filePath] || ''),
      serverChanged: Boolean(serverVersionAtPath.value[filePath])
    };
  }
  return state;
});

/**
 * 加载技能详情和文件树。
 */
const loadSkill = async () => {
  error.value = '';
  try {
    const result = await customSkillApi.getCustomSkill(skillId);
    skill.value = result.skill;
    tree.value = result.tree || [];
    expandRootDirectories(tree.value);
    ensureSelectedFile();
  } catch (loadError: any) {
    error.value = loadError?.message || '加载自定义技能失败';
  }
};

/**
 * 刷新文件树和当前文件服务器内容。
 */
const refreshServerState = async () => {
  if (!skillId) return;
  try {
    const nextTree = await customSkillApi.getCustomSkillTree(skillId);
    tree.value = nextTree;
    if (selectedPath.value && selectedNodeType.value === 'file') {
      const file = await customSkillApi.readCustomSkillFile(skillId, selectedPath.value);
      const previousContent = serverContentByPath.value[selectedPath.value] || '';
      serverContentByPath.value = {
        ...serverContentByPath.value,
        [selectedPath.value]: file.content
      };
      if (previousContent && previousContent !== file.content) {
        serverUpdatedNotice.value = true;
        serverVersionAtPath.value = {
          ...serverVersionAtPath.value,
          [selectedPath.value]: file.updatedAt
        };
      }
    }
    if (skill.value) {
      const nextSkill = await customSkillApi.getCustomSkill(skillId);
      skill.value = nextSkill.skill;
    }
  } catch {
    // 轮询刷新失败时保持当前界面，不打断正在编辑的内容。
  }
};

/**
 * 展开顶层目录，保证初次进入时能看到主结构。
 * 注意：新增的文件夹默认收缩，不强制展开。
 */
const expandRootDirectories = (nodes: CustomSkillTreeNode[]) => {
  const next = new Set(expandedDirs.value);
  for (const node of nodes) {
    if (node.type === 'directory' && expandedDirs.value.has(node.path)) {
      // 只展开之前已经展开过的目录，新增的目录保持收缩
      next.add(node.path);
    }
  }
  expandedDirs.value = next;
};

/**
 * 在没有选中文件时选中 SKILL.md 文件。
 */
const ensureSelectedFile = () => {
  if (selectedPath.value && findNode(selectedPath.value)?.type === 'file') {
    selectedNodeType.value = 'file';
    return;
  }
  // 优先选中 SKILL.md 文件
  const skillMdFile = visibleNodes.value.find((node) => node.type === 'file' && node.name === 'SKILL.md');
  if (skillMdFile) {
    selectedPath.value = skillMdFile.path;
    selectedNodeType.value = 'file';
    return;
  }
  // 如果没有 SKILL.md，选中第一个文件
  const firstFile = visibleNodes.value.find((node) => node.type === 'file');
  selectedPath.value = firstFile?.path || '';
  selectedNodeType.value = firstFile?.type || '';
};

/**
 * 读取当前选中文件。
 */
const loadSelectedFile = async () => {
  if (!selectedPath.value || selectedNodeType.value !== 'file') return;

  // 记录加载开始时的路径，用于检测竞态条件
  const loadingPath = selectedPath.value;

  serverUpdatedNotice.value = false;
  try {
    const file = await customSkillApi.readCustomSkillFile(skillId, selectedPath.value);

    // 【修复】检查是否发生了竞态条件：用户可能已经切换到其他文件
    if (loadingPath !== selectedPath.value) {
      console.warn('[loadSelectedFile] 路径已变化，放弃本次加载', { loadingPath, currentPath: selectedPath.value });
      return;
    }

    // 始终更新服务器内容（确保显示最新数据）
    serverContentByPath.value = {
      ...serverContentByPath.value,
      [selectedPath.value]: file.content
    };

    // 【修复】始终更新本地草稿内容，避免偶数文件打开时内容为空的问题
    // 如果用户之前有编辑内容，这次更新会覆盖，但用户可以通过重新编辑来恢复
    localDraftByPath.value = {
      ...localDraftByPath.value,
      [selectedPath.value]: file.content
    };

    const nextVersionMap = { ...serverVersionAtPath.value };
    delete nextVersionMap[selectedPath.value];
    serverVersionAtPath.value = nextVersionMap;
  } catch (fileError: any) {
    // 只有当前选中的路径才显示错误（避免竞态条件下的错误提示）
    if (loadingPath === selectedPath.value) {
      error.value = fileError?.message || '读取文件失败';
    }
  }
};

/**
 * 处理文件树节点点击。
 */
const handleNodeClick = (node: VisibleTreeNode) => {
  if (node.type === 'directory') {
    const next = new Set(expandedDirs.value);
    if (next.has(node.path)) {
      next.delete(node.path);
    } else {
      next.add(node.path);
    }
    expandedDirs.value = next;
    selectedPath.value = node.path;
    selectedNodeType.value = 'directory';
    return;
  }
  selectedPath.value = node.path;
  selectedNodeType.value = 'file';
};

/**
 * 创建文件。
 */
const openCreateFileDialog = () => {
  const baseDir = selectedDirectoryPath();
  createFileDefaultPath.value = baseDir ? `${baseDir}/new-file.txt` : 'new-file.txt';
  createFileDialogVisible.value = true;
};

const handleCreateFile = async ({ value }: { value: string }) => {
  if (!value) return;
  try {
    await customSkillApi.createCustomSkillFile(skillId, value);
    await loadSkill();
    selectedPath.value = value;
    selectedNodeType.value = 'file';
    await loadSelectedFile();
    createFileDialogVisible.value = false;
  } catch (createError: any) {
    toast.add({ severity: 'error', summary: '创建失败', detail: createError?.message || '创建文件失败', life: 4000 });
  }
};

/**
 * 创建子文件夹。
 */
const openCreateFolderDialog = () => {
  const baseDir = selectedDirectoryPath();
  createFolderDefaultPath.value = baseDir ? `${baseDir}/new-folder` : 'new-folder';
  createFolderDialogVisible.value = true;
};

const handleCreateFolder = async ({ value }: { value: string }) => {
  if (!value) return;
  try {
    await customSkillApi.createCustomSkillFolder(skillId, value);
    await loadSkill();
    createFolderDialogVisible.value = false;
  } catch (createError: any) {
    toast.add({ severity: 'error', summary: '创建失败', detail: createError?.message || '创建文件夹失败', life: 4000 });
  }
};

/**
 * 重命名当前选中项。
 */
const openRenameDialog = () => {
  if (!selectedPath.value) return;
  renameDialogVisible.value = true;
};

const handleRename = async ({ value }: { value: string }) => {
  if (!selectedPath.value || !value || value === selectedPath.value) return;
  const defaultValue = selectedPath.value;
  const nextPath = value;
  try {
    await customSkillApi.renameCustomSkillEntry(skillId, defaultValue, nextPath);
    const nextLocalDraft = { ...localDraftByPath.value };
    const nextServerContent = { ...serverContentByPath.value };
    const nextVersionMap = { ...serverVersionAtPath.value };
    if (Object.prototype.hasOwnProperty.call(nextLocalDraft, defaultValue)) {
      nextLocalDraft[nextPath] = nextLocalDraft[defaultValue] || '';
      delete nextLocalDraft[defaultValue];
    }
    if (Object.prototype.hasOwnProperty.call(nextServerContent, defaultValue)) {
      nextServerContent[nextPath] = nextServerContent[defaultValue] || '';
      delete nextServerContent[defaultValue];
    }
    if (Object.prototype.hasOwnProperty.call(nextVersionMap, defaultValue)) {
      nextVersionMap[nextPath] = nextVersionMap[defaultValue] || '';
      delete nextVersionMap[defaultValue];
    }
    localDraftByPath.value = nextLocalDraft;
    serverContentByPath.value = nextServerContent;
    serverVersionAtPath.value = nextVersionMap;
    selectedPath.value = nextPath;
    await loadSkill();
    if (selectedNodeType.value === 'file') {
      await loadSelectedFile();
    }
    renameDialogVisible.value = false;
  } catch (renameError: any) {
    toast.add({ severity: 'error', summary: '重命名失败', detail: renameError?.message || '重命名失败', life: 4000 });
  }
};

/**
 * 删除当前选中项。
 */
const openDeleteDialog = () => {
  if (!selectedPath.value) return;
  deleteDialogVisible.value = true;
};

const handleDelete = async () => {
  if (!selectedPath.value) return;
  try {
    await customSkillApi.deleteCustomSkillEntry(skillId, selectedPath.value);
    const nextLocalDraft = { ...localDraftByPath.value };
    const nextServerContent = { ...serverContentByPath.value };
    const nextVersionMap = { ...serverVersionAtPath.value };
    delete nextLocalDraft[selectedPath.value];
    delete nextServerContent[selectedPath.value];
    delete nextVersionMap[selectedPath.value];
    localDraftByPath.value = nextLocalDraft;
    serverContentByPath.value = nextServerContent;
    serverVersionAtPath.value = nextVersionMap;
    selectedPath.value = '';
    selectedNodeType.value = '';
    await loadSkill();
    await loadSelectedFile();
    deleteDialogVisible.value = false;
  } catch (deleteError: any) {
    toast.add({ severity: 'error', summary: '删除失败', detail: deleteError?.message || '删除失败', life: 4000 });
  }
};

/**
 * 保存当前文件。
 */
const saveCurrentFile = async () => {
  if (!selectedPath.value || selectedNodeType.value !== 'file') return;
  saving.value = true;
  try {
    await customSkillApi.writeCustomSkillFile(skillId, selectedPath.value, currentDraft.value);
    serverContentByPath.value = {
      ...serverContentByPath.value,
      [selectedPath.value]: currentDraft.value
    };
    const nextVersionMap = { ...serverVersionAtPath.value };
    delete nextVersionMap[selectedPath.value];
    serverVersionAtPath.value = nextVersionMap;
    serverUpdatedNotice.value = false;
    await loadSkill();
  } catch (saveError: any) {
    toast.add({ severity: 'error', summary: '保存失败', detail: saveError?.message || '保存失败', life: 4000 });
  } finally {
    saving.value = false;
  }
};

/**
 * 撤销当前文件的所有修改，恢复到服务器版本。
 */
const openRevertDialog = () => {
  if (!selectedPath.value || !hasUnsavedChanges.value) return;
  revertDialogVisible.value = true;
};

const handleRevert = () => {
  if (!selectedPath.value) return;
  localDraftByPath.value = {
    ...localDraftByPath.value,
    [selectedPath.value]: serverContentByPath.value[selectedPath.value] || ''
  };
  toast.add({ severity: 'info', summary: '已撤销', detail: '已恢复为服务器版本', life: 2000 });
  revertDialogVisible.value = false;
};

/**
 * 根据选中项推断默认目录。
 */
const selectedDirectoryPath = () => {
  const node = findNode(selectedPath.value);
  if (!node) return '';
  if (node.type === 'directory') return node.path;
  const lastSlash = node.path.lastIndexOf('/');
  return lastSlash >= 0 ? node.path.slice(0, lastSlash) : '';
};

/**
 * 调用系统文件管理器打开技能内容文件夹。
 */
const handleOpenDirectory = async () => {
  if (openingDirectory.value) {
    return;
  }
  openingDirectory.value = true;
  const currentPath = selectedDirectoryPath();
  try {
    await customSkillApi.openCustomSkillDirectory(skillId, currentPath);
  } catch (err: any) {
    console.error('打开文件夹失败:', err);
    toast.add({
      severity: 'error',
      summary: '打开文件夹失败',
      detail: err?.message || '打开文件夹失败',
      life: 3500
    });
  } finally {
    openingDirectory.value = false;
  }
};

/**
 * 通过路径查找节点。
 */
const findNode = (targetPath: string): CustomSkillTreeNode | null => {
  const visit = (nodes: CustomSkillTreeNode[]): CustomSkillTreeNode | null => {
    for (const node of nodes) {
      if (node.path === targetPath) {
        return node;
      }
      const found = node.children ? visit(node.children) : null;
      if (found) {
        return found;
      }
    }
    return null;
  };
  return visit(tree.value);
};

watch(selectedPath, () => {
  if (selectedPath.value && selectedNodeType.value === 'file') {
    void loadSelectedFile();
  }
});

onMounted(async () => {
  await loadSkill();
  if (selectedPath.value) {
    await loadSelectedFile();
  }
  refreshTimer = setInterval(() => {
    void refreshServerState();
  }, 3000);
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>
