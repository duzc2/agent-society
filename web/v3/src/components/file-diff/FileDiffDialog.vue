<script setup lang="ts">
/**
 * 文件差异对比对话框
 *
 * 展示文件的修改历史版本列表，并支持两种 diff 模式：
 * - 单版本模式：显示某个版本的修改内容（修改前 vs 修改后）
 * - 跨版本模式：对比任意两个版本修改后的文件状态
 *
 * 用于 DynamicDialog 中打开，通过 dialogRef.data 接收参数。
 */
import { ref, onMounted, onBeforeUnmount, nextTick, computed, inject, type Ref } from 'vue';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { Clock, User, FileText } from 'lucide-vue-next';
import Button from 'primevue/button';
import { apiService } from '../../services/api';
import { useAgentStore } from '../../stores/agent';
import type { DynamicDialogInstance } from 'primevue/dynamicdialogoptions';

interface HistoryEntry {
  index: number;
  operator: string;
  messageId: string;
  timestamp: string;
  action: string;
  size: number;
  versionId: string;
}

const dialogRef = inject<Ref<DynamicDialogInstance>>('dialogRef');

const data = dialogRef?.value?.data || {};
const workspaceId = (data as any).workspaceId || '';
const filePath = (data as any).filePath || '';

const agentStore = useAgentStore();

/** agentId → agentName 查找表 */
const agentNameMap = computed(() => {
  const agents = agentStore.agentsMap[workspaceId] || [];
  const map: Record<string, string> = {};
  for (const a of agents) {
    map[a.id] = a.name;
  }
  return map;
});

function resolveOperatorName(operatorId: string): string {
  return agentNameMap.value[operatorId] || operatorId;
}

const loading = ref(false);
const history = ref<HistoryEntry[]>([]);
const selectedFromIndex = ref<number>(-1);
const selectedToIndex = ref<number | null>(null);
const errorMessage = ref<string | null>(null);
const beforeContent = ref<string>('');
const afterContent = ref<string>('');
const versionSwitching = ref(false);

const containerRef = ref<HTMLDivElement | null>(null);
let mergeView: MergeView | null = null;

/** 是否处于跨版本对比模式 */
const isDualMode = computed(() => selectedToIndex.value !== null);

// 显示用的倒序版本列表（最新在上）
const reversedHistory = computed(() => [...history.value].reverse());

function formattedTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

/** 获取文件当前最新内容 */
async function fetchCurrentFile(): Promise<string> {
  const url = `/workspace-files/${encodeURIComponent(workspaceId)}/${filePath.split('/').map((p: string) => encodeURIComponent(p)).join('/')}`;
  const resp = await fetch(url);
  return resp.ok ? await resp.text() : '';
}

/** 统一的 diff 加载包装器：管理 loading、异常、MergeView 重建 */
async function executeDiffLoad(fn: () => Promise<void>) {
  versionSwitching.value = true;
  errorMessage.value = null;
  try {
    await fn();
  } catch (err: any) {
    errorMessage.value = '加载版本内容失败: ' + (err.message || 'unknown');
  } finally {
    versionSwitching.value = false;
    await nextTick();
    initMergeView();
  }
}

/** 加载历史记录并自动选中最后一个版本 */
async function loadHistory() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const result = await apiService.getFileHistory(workspaceId, filePath);
    history.value = result.history.map((entry, idx) => ({ ...entry, index: idx }));
    if (history.value.length > 0) {
      loadSingleDiff(history.value.length - 1);
    }
  } catch (err: any) {
    errorMessage.value = err.message || '加载修改历史失败';
  } finally {
    loading.value = false;
  }
}

/** 单版本模式：加载 idx 版本的修改对比（修改前 vs 修改后） */
async function loadSingleDiff(idx: number) {
  if (idx < 0 || idx >= history.value.length) return;
  selectedFromIndex.value = idx;
  selectedToIndex.value = null;

  await executeDiffLoad(async () => {
    if (idx === 0) {
      beforeContent.value = '';
    } else {
      beforeContent.value = await apiService.getFileVersion(workspaceId, filePath, idx);
    }

    if (idx < history.value.length - 1) {
      afterContent.value = await apiService.getFileVersion(workspaceId, filePath, idx + 1);
    } else {
      afterContent.value = await fetchCurrentFile();
    }
  });
}

/** 跨版本模式：对比两个版本修改后的文件状态 */
async function loadCrossDiff(fromIdx: number, toIdx: number) {
  if (fromIdx < 0 || fromIdx >= history.value.length || toIdx < 0 || toIdx >= history.value.length) return;

  // 同一版本 → 回退到单版本模式
  if (fromIdx === toIdx) {
    loadSingleDiff(fromIdx);
    return;
  }

  // 保证 fromIdx < toIdx
  if (fromIdx > toIdx) {
    [fromIdx, toIdx] = [toIdx, fromIdx];
  }

  selectedFromIndex.value = fromIdx;
  selectedToIndex.value = toIdx;

  await executeDiffLoad(async () => {
    // left = 文件在 fromIdx 修改后的状态 = getFileVersion(fromIdx + 1)
    beforeContent.value = await apiService.getFileVersion(workspaceId, filePath, fromIdx + 1);

    if (toIdx < history.value.length - 1) {
      afterContent.value = await apiService.getFileVersion(workspaceId, filePath, toIdx + 1);
    } else {
      afterContent.value = await fetchCurrentFile();
    }
  });
}

/**
 * 版本列表点击处理器（状态机）
 *
 * 单版本模式（toIndex === null）：
 *   - 点击相同条目 → no-op
 *   - 点击不同条目 → 进入跨版本模式
 * 跨版本模式：
 *   - 点击已选"起点" → 取消对比，"终点"变为"起点"（单版本模式）
 *   - 点击已选"终点" → "起点"保持（单版本模式）
 *   - 点击第三个条目 → 替换"终点"
 */
function handleVersionClick(idx: number) {
  if (selectedToIndex.value === null) {
    // 单版本模式
    if (selectedFromIndex.value === idx) return;
    loadCrossDiff(selectedFromIndex.value, idx);
  } else {
    // 跨版本模式
    if (selectedFromIndex.value === idx) {
      loadSingleDiff(selectedToIndex.value);
    } else if (selectedToIndex.value === idx) {
      loadSingleDiff(selectedFromIndex.value);
    } else {
      loadCrossDiff(selectedFromIndex.value, idx);
    }
  }
}

/** 清除跨版本对比，回到单版本模式 */
function clearCrossCompare() {
  loadSingleDiff(selectedFromIndex.value);
}

function prevVersion() {
  if (selectedFromIndex.value > 0) loadSingleDiff(selectedFromIndex.value - 1);
}

function nextVersion() {
  if (selectedFromIndex.value < history.value.length - 1) loadSingleDiff(selectedFromIndex.value + 1);
}

function createEditorTheme() {
  return EditorView.theme({
    '&': {
      fontSize: '13px',
      color: 'var(--text-1)',
      backgroundColor: 'var(--surface-1)'
    },
    '.cm-scroller': {
      fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace'
    },
    '.cm-content': {
      caretColor: 'var(--text-1)',
      color: 'var(--text-1)'
    },
    '.cm-deletedChunk': {
      backgroundColor: 'rgba(220, 53, 69, 0.15)'
    },
    '.cm-insertedChunk': {
      backgroundColor: 'rgba(40, 167, 69, 0.15)'
    },
    '.cm-deletedText': {
      backgroundColor: 'rgba(220, 53, 69, 0.4)'
    },
    '.cm-insertedText': {
      backgroundColor: 'rgba(40, 167, 69, 0.4)'
    },
    '.cm-merge-gap': {
      backgroundColor: 'var(--border)'
    },
    '&.cm-focused': {
      outline: 'none'
    }
  });
}

function initMergeView() {
  if (!containerRef.value) return;

  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }

  const baseExtensions = [
    createEditorTheme(),
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping
  ];

  mergeView = new MergeView({
    a: {
      doc: beforeContent.value || '',
      extensions: baseExtensions
    },
    b: {
      doc: afterContent.value || '',
      extensions: baseExtensions
    },
    parent: containerRef.value,
    orientation: 'a-b'
  });
}

function handleClose() {
  dialogRef?.value?.close();
}

onMounted(() => {
  loadHistory();
});

onBeforeUnmount(() => {
  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }
});
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Error state -->
    <div v-if="errorMessage && !loading" class="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div class="text-red-500 text-center">{{ errorMessage }}</div>
      <Button label="重试" @click="loadHistory" variant="text" />
    </div>

    <!-- Loading state -->
    <div v-else-if="loading" class="flex items-center justify-center h-full">
      <div class="flex flex-col items-center gap-3 text-[var(--text-3)]">
        <div class="w-8 h-8 animate-spin border-2 border-current border-t-transparent rounded-full" />
        <span>加载修改历史...</span>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="history.length === 0" class="flex items-center justify-center h-full text-[var(--text-3)]">
      该文件暂无修改记录
    </div>

    <!-- Normal state -->
    <template v-else>
      <div class="flex flex-1 min-h-0">
        <!-- Left: Version list -->
        <div class="w-56 border-r border-[var(--border)] overflow-y-auto flex-shrink-0 bg-[var(--surface-2)]">
          <div class="px-3 py-2 text-xs text-[var(--text-3)] border-b border-[var(--border)]">
            共 {{ history.length }} 次修改
          </div>
          <div
            v-for="entry in reversedHistory"
            :key="entry.index"
            class="cursor-pointer px-3 py-2.5 border-b border-[var(--border)] transition-colors"
            :class="selectedFromIndex === entry.index || selectedToIndex === entry.index
              ? 'bg-[var(--primary)]/10 border-l-2 border-l-[var(--primary)]'
              : 'hover:bg-[var(--surface-3)] border-l-2 border-l-transparent'"
            @click="handleVersionClick(entry.index)"
          >
            <div class="flex items-center gap-1.5">
              <div
                class="w-2 h-2 rounded-full flex-shrink-0"
                :class="entry.action === 'create' ? 'bg-green-500' : 'bg-blue-500'"
              />
              <span class="text-sm font-medium text-[var(--text-1)]">第 {{ entry.index + 1 }} 次</span>
              <span
                v-if="selectedFromIndex === entry.index"
                class="text-[10px] px-1 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)]"
              >起点</span>
              <span
                v-if="selectedToIndex === entry.index"
                class="text-[10px] px-1 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)]"
              >终点</span>
              <span
                v-else-if="entry.index === history.length - 1"
                class="text-[10px] px-1 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)]"
              >最新</span>
            </div>
            <div class="flex items-center gap-1 mt-1 text-[11px] text-[var(--text-3)]">
              <Clock class="w-3 h-3" />
              <span>{{ formattedTime(entry.timestamp) }}</span>
            </div>
            <div class="flex items-center gap-1 mt-0.5 text-[11px] text-[var(--text-3)]">
              <User class="w-3 h-3" />
              <span class="truncate">{{ resolveOperatorName(entry.operator) }}</span>
            </div>
            <div class="flex items-center gap-1 mt-0.5">
              <span class="px-1 py-0.5 rounded text-[10px]"
                :class="entry.action === 'create' ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'">
                {{ entry.action === 'create' ? '创建' : '修改' }}
              </span>
              <span v-if="entry.size" class="ml-auto text-[10px] text-[var(--text-3)]">{{ (entry.size / 1024).toFixed(1) }}KB</span>
            </div>
          </div>
        </div>

        <!-- Right: Diff view -->
        <div class="flex-1 flex flex-col min-w-0">
          <!-- Header: single vs cross mode -->
          <div class="px-4 py-2 border-b border-[var(--border)] text-xs text-[var(--text-3)] flex items-center gap-2">
            <FileText class="w-3.5 h-3.5" />
            <template v-if="isDualMode">
              <span>第{{ selectedFromIndex + 1 }}次修改结果</span>
              <span class="text-[var(--border)]">vs</span>
              <span>第{{ (selectedToIndex ?? 0) + 1 }}次修改结果</span>
            </template>
            <template v-else>
              <span>修改前</span>
              <span class="text-[var(--border)]">vs</span>
              <span>修改后</span>
            </template>
          </div>

          <div class="flex-1 min-h-0 relative">
            <div v-if="versionSwitching" class="absolute inset-0 flex items-center justify-center bg-[var(--surface-1)]/50 z-10">
              <div class="w-6 h-6 animate-spin border-2 border-[var(--primary)] border-t-transparent rounded-full" />
            </div>
            <div ref="containerRef" class="h-full w-full overflow-auto" />
          </div>

          <!-- Navigation bar: single vs cross mode -->
          <div class="flex items-center justify-center gap-3 px-4 py-2 border-t border-[var(--border)] bg-[var(--surface-2)]">
            <template v-if="isDualMode">
              <span class="text-xs text-[var(--text-2)] font-mono">
                第 {{ selectedFromIndex + 1 }} 次 → 第 {{ (selectedToIndex ?? 0) + 1 }} 次
              </span>
              <Button
                variant="text"
                size="small"
                @click="clearCrossCompare"
                class="!px-2 !py-1"
              >
                <span class="text-xs">清除对比</span>
              </Button>
            </template>
            <template v-else>
              <Button
                variant="text"
                size="small"
                :disabled="selectedFromIndex <= 0"
                @click="prevVersion"
                class="!px-2 !py-1"
              >
                <span class="text-xs">◀ 上一版</span>
              </Button>
              <span class="text-xs text-[var(--text-2)] font-mono">
                第 {{ selectedFromIndex + 1 }} / {{ history.length }} 次
              </span>
              <Button
                variant="text"
                size="small"
                :disabled="selectedFromIndex >= history.length - 1"
                @click="nextVersion"
                class="!px-2 !py-1"
              >
                <span class="text-xs">下一版 ▶</span>
              </Button>
            </template>

            <Button
              variant="text"
              size="small"
              @click="handleClose"
              class="!px-2 !py-1 ml-auto"
            >
              <span class="text-xs text-[var(--text-3)]">关闭</span>
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* CodeMirror MergeView 自行管理布局与滚动：
   .cm-mergeView = 以内容全高渲染，外层容器 overflow:auto 承接滚动
   .cm-mergeViewEditors = display:flex, 左右两个 .cm-mergeViewEditor = flex:1
   编辑器 .cm-scroller 被 CodeMirror baseTheme 覆盖为 height:auto / overflow:visible */
:deep(.cm-merge-view) {
  background-color: var(--surface-1);
}

:deep(.cm-merge-view .cm-editor) {
  background-color: var(--surface-1);
}
</style>
