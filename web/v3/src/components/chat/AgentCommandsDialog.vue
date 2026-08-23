<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { Loader2, Search, Terminal, ChevronUp, ChevronDown } from 'lucide-vue-next';
import { apiService, type CommandHistoryItem } from '../../services/api';
import { useToast } from 'primevue/usetoast';

// ---- dialog data ----
const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const agentId: string = data.agentId;
const agentName: string = data.agentName;
const refreshSignal: { value: number } = data.refreshSignal;
const toast = useToast();

const PAGE_SIZE = 50;
const LOG_WINDOW = 256 * 1024;           // 每块 256KB
const MAX_BUFFERED_CHARS = 8 * 1024 * 1024;
const MAX_LINES = 20000;
const LIST_POLL_MS = 5000;               // 列表轮询间隔：新命令 5 秒内出现

// ---- 左栏：列表 ----
const items = ref<CommandHistoryItem[]>([]);
const total = ref(0);
const listLoading = ref(false);
const hasMoreList = ref(false);
const listOffset = ref(0);
const search = ref('');
const searchDebounced = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;
// 列表会话计数：loadList(reset) 时递增，用于丢弃过期的在途轮询结果
let listSessionId = 0;

watch(search, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchDebounced.value = v; loadList(true); }, 300);
});

async function loadList(reset = false) {
  if (listLoading.value) return;
  if (reset) { listSessionId++; listOffset.value = 0; items.value = []; }
  listLoading.value = true;
  try {
    const r = await apiService.getCommandHistory(agentId, { offset: listOffset.value, limit: PAGE_SIZE, search: searchDebounced.value });
    if (reset) {
      items.value = r.items;
    } else {
      // 去重：轮询已把新条目前插进列表，offset 分页返回的条目可能与之重叠
      const existingIds = new Set(items.value.map(i => i.processId));
      items.value.push(...r.items.filter(i => !existingIds.has(i.processId)));
    }
    total.value = r.total;
    listOffset.value += r.items.length;
    hasMoreList.value = items.value.length < total.value;
    // 首屏自动选中第一条
    if (reset && items.value.length > 0 && !selectedProcessId.value) {
      selectCommand(items.value[0]);
    }
  } catch (e: any) {
    toast.add({ severity: 'error', summary: '加载失败', detail: e?.message || '获取命令历史失败', life: 3000 });
  } finally { listLoading.value = false; }
}

function onListScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24 && hasMoreList.value) loadList();
}

// ---- 左栏轮询：新执行的命令 5 秒内出现，不改变选中项、不打扰阅读 ----
const listScrollRef = ref<HTMLElement | null>(null);
let listPollTimer: ReturnType<typeof setInterval> | null = null;

async function pollList() {
  if (listLoading.value) return; // 单 in-flight：与用户滚动加载互斥，本轮跳过
  const mySession = listSessionId;
  listLoading.value = true;
  try {
    const r = await apiService.getCommandHistory(agentId, { offset: 0, limit: PAGE_SIZE, search: searchDebounced.value });
    if (listSessionId !== mySession) return; // 搜索词已变或列表被重置，丢弃过期结果
    mergePollResult(r.items);
    total.value = r.total;
  } catch (e: any) {
    // 轮询失败不打扰用户（不弹 toast），记录错误后下一轮重试
    console.error('[历史命令] 列表轮询失败:', e?.message ?? String(e));
  } finally { listLoading.value = false; }
}

function mergePollResult(fetched: CommandHistoryItem[]) {
  const existingById = new Map(items.value.map(i => [i.processId, i]));
  const newItems: CommandHistoryItem[] = [];
  for (const f of fetched) {
    const existing = existingById.get(f.processId);
    if (existing) {
      // 原地更新：运行中 → 已完成、退出码、文件大小等字段随执行进展变化
      Object.assign(existing, f);
    } else {
      newItems.push(f);
    }
  }
  if (newItems.length === 0) {
    hasMoreList.value = items.value.length < total.value;
    return;
  }
  // 新条目前插（列表按时间倒序）。滚动锚定：补偿高度差，保持用户视野不动
  const el = listScrollRef.value;
  const oldTop = el?.scrollTop ?? 0;
  const oldHeight = el?.scrollHeight ?? 0;
  items.value.unshift(...newItems);
  listOffset.value += newItems.length; // 已加载计数同步前移，滚动分页不错位
  hasMoreList.value = items.value.length < total.value;
  // 对话框打开时为空、第一条命令刚出现且未选中任何条目 → 自动选中（与首次加载行为一致）
  if (!selectedProcessId.value && items.value.length > 0) {
    selectCommand(items.value[0]);
    return;
  }
  nextTick(() => {
    if (el) el.scrollTop = oldTop + (el.scrollHeight - oldHeight);
  });
}

function startListPoll() {
  stopListPoll();
  listPollTimer = setInterval(() => { pollList(); }, LIST_POLL_MS);
}
function stopListPoll() {
  if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
}

// ---- 右栏：日志 ----
const selectedProcessId = ref<string | null>(null);
const selectedItem = computed(() => items.value.find(i => i.processId === selectedProcessId.value) || null);
type LogLine = { type: 'meta' | 'stdout' | 'stderr' | 'stdin'; text: string };
const logLines = ref<LogLine[]>([]);
const logLoading = ref(false);
const logError = ref('');
const readOffset = ref(0);
const totalLength = ref(0);
const hasMore = ref(false);
const logStatus = ref('');
const droppedChars = ref(0);
let lineCarry = '';
let tailTimer: ReturnType<typeof setInterval> | null = null;
let sessionId = 0;

// 自动滚动
const autoScroll = ref(true);
const logScrollRef = ref<HTMLElement | null>(null);
let _isAutoScrolling = false;

// 日志内搜索
const logSearch = ref('');
const logSearchDebounced = ref('');
let logSearchTimer: ReturnType<typeof setTimeout> | null = null;
const currentMatchIndex = ref(0);
watch(logSearch, (v) => {
  if (logSearchTimer) clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => { logSearchDebounced.value = v; currentMatchIndex.value = 0; }, 300);
});

const searchMatches = computed(() => {
  if (!logSearchDebounced.value) return [];
  const q = logSearchDebounced.value.toLowerCase();
  const matches: Array<{ lineIndex: number; start: number; end: number }> = [];
  for (let i = 0; i < logLines.value.length; i++) {
    const text = logLines.value[i].text.toLowerCase();
    let pos = 0;
    while ((pos = text.indexOf(q, pos)) !== -1) {
      matches.push({ lineIndex: i, start: pos, end: pos + q.length });
      pos += q.length;
    }
  }
  return matches;
});

function prevMatch() {
  if (searchMatches.value.length === 0) return;
  currentMatchIndex.value = (currentMatchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length;
  scrollToMatch(currentMatchIndex.value);
}
function nextMatch() {
  if (searchMatches.value.length === 0) return;
  currentMatchIndex.value = (currentMatchIndex.value + 1) % searchMatches.value.length;
  scrollToMatch(currentMatchIndex.value);
}
function scrollToMatch(index: number) {
  const match = searchMatches.value[index];
  if (!match || !logScrollRef.value) return;
  const lineEl = logScrollRef.value.children[match.lineIndex + (droppedChars.value > 0 ? 1 : 0)] as HTMLElement;
  if (lineEl) lineEl.scrollIntoView({ block: 'center' });
}

// 判断某行某位置是否为当前匹配
function isCurrentMatch(lineIndex: number, start: number): boolean {
  const match = searchMatches.value[currentMatchIndex.value];
  return !!match && match.lineIndex === lineIndex && match.start === start;
}

// 将某行按搜索匹配拆分为高亮片段
function highlightLine(line: LogLine, lineIndex: number) {
  if (!logSearchDebounced.value) return [{ text: line.text, highlight: false, current: false }];
  const q = logSearchDebounced.value.toLowerCase();
  const text = line.text;
  const textLower = text.toLowerCase();
  const segments: Array<{ text: string; highlight: boolean; current: boolean }> = [];
  let pos = 0;
  while (pos < text.length) {
    const matchPos = textLower.indexOf(q, pos);
    if (matchPos === -1) {
      segments.push({ text: text.slice(pos), highlight: false, current: false });
      break;
    }
    if (matchPos > pos) {
      segments.push({ text: text.slice(pos, matchPos), highlight: false, current: false });
    }
    segments.push({
      text: text.slice(matchPos, matchPos + q.length),
      highlight: true,
      current: isCurrentMatch(lineIndex, matchPos)
    });
    pos = matchPos + q.length;
  }
  return segments;
}

function selectCommand(item: CommandHistoryItem | null) {
  stopTail();
  sessionId++;
  selectedProcessId.value = item?.processId ?? null;
  logLines.value = []; readOffset.value = 0; totalLength.value = 0;
  hasMore.value = false; logError.value = ''; lineCarry = ''; droppedChars.value = 0;
  logStatus.value = item?.status ?? '';
  autoScroll.value = true;
  logSearch.value = '';
  logSearchDebounced.value = '';
  currentMatchIndex.value = 0;
  if (item) fetchLogChunk();
}

async function fetchLogChunk() {
  const pid = selectedProcessId.value;
  if (!pid || logLoading.value) return;
  const mySession = sessionId;
  logLoading.value = true;
  try {
    const chunk = await apiService.getCommandOutput(pid, { offset: readOffset.value, window: LOG_WINDOW });
    if (mySession !== sessionId) return;
    readOffset.value = chunk.nextOffset;
    totalLength.value = chunk.totalLength;
    hasMore.value = chunk.hasMore;
    logStatus.value = chunk.status;
    appendChunk(chunk.content);
    if (chunk.status === 'running') scheduleTail();
  } catch (e: any) {
    if (mySession !== sessionId) return;
    logError.value = e?.message || '读取日志失败';
  } finally { logLoading.value = false; }
}

const LINE_RE = /^\[(STDOUT|STDERR|STDIN)\]\s?(.*)$/;
function appendChunk(content: string) {
  const all = lineCarry + content;
  const parts = all.split('\n');
  lineCarry = parts.pop() ?? '';
  for (const raw of parts) {
    const m = LINE_RE.exec(raw);
    if (m) {
      logLines.value.push({ type: (m[1] === 'STDOUT' ? 'stdout' : m[1] === 'STDERR' ? 'stderr' : 'stdin') as LogLine['type'], text: m[2] });
    } else {
      logLines.value.push({ type: 'meta', text: raw });
    }
  }
  trimBuffer();
  // 自动滚动
  if (autoScroll.value && logScrollRef.value) {
    _isAutoScrolling = true;
    nextTick(() => {
      if (logScrollRef.value) {
        logScrollRef.value.scrollTo({ top: logScrollRef.value.scrollHeight });
      }
      _isAutoScrolling = false;
    });
  }
}

function trimBuffer() {
  let byteSum = 0;
  for (const l of logLines.value) byteSum += l.text.length;
  while (logLines.value.length > MAX_LINES || byteSum > MAX_BUFFERED_CHARS) {
    const removed = logLines.value.shift();
    if (removed) { droppedChars.value += removed.text.length + 1; byteSum -= removed.text.length; }
  }
}

function scheduleTail() {
  if (tailTimer) return;
  tailTimer = setInterval(() => { fetchLogChunk(); }, 5000);
}
function stopTail() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
}

function onLogScroll(e: Event) {
  if (_isAutoScrolling) return;
  const el = e.target as HTMLElement;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (dist > 120) {
    autoScroll.value = false;
  } else if (dist < 24) {
    autoScroll.value = true;
  }
  // 滚动触底续载
  if (dist < 120 && hasMore.value) fetchLogChunk();
}

// ---- 清空历史 ----
const showClearConfirm = ref(false);
const isClearing = ref(false);
async function handleClearHistory() {
  isClearing.value = true;
  try {
    const r = await apiService.clearCommandHistory(agentId);
    showClearConfirm.value = false;
    toast.add({
      severity: 'success', summary: '已清空',
      detail: `删除 ${r.deletedCount} 条历史` + (r.skippedCount ? `，跳过 ${r.skippedCount} 条` : ''),
      life: 3000
    });
    selectCommand(null);
    await loadList(true);
  } catch (e: any) {
    toast.add({ severity: 'error', summary: '清空失败', detail: e?.message || '清空失败，请重试', life: 3000 });
  } finally { isClearing.value = false; }
}

// ---- 格式化函数 ----
function formatTime(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round(ms % 60000 / 1000)}s`;
}
function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
const statusMeta: Record<string, { label: string; dotCls: string; badgeCls: string }> = {
  running: { label: '运行中', dotCls: 'bg-[var(--primary)] animate-pulse', badgeCls: 'text-[var(--primary)] bg-[var(--primary-weak)]' },
  completed: { label: '已完成', dotCls: 'bg-green-500', badgeCls: 'text-green-500 bg-green-50 dark:bg-green-900/20' },
  error: { label: '错误', dotCls: 'bg-red-500', badgeCls: 'text-red-500 bg-red-50 dark:bg-red-900/20' },
  killed: { label: '已终止', dotCls: 'bg-orange-500', badgeCls: 'text-orange-500 bg-orange-50 dark:bg-orange-900/20' },
  interrupted: { label: '中断', dotCls: 'bg-amber-500', badgeCls: 'text-amber-500 bg-amber-50 dark:bg-amber-900/20' },
};

// ---- lifecycle ----
onMounted(() => {
  loadList(true);
  startListPoll();
});
onUnmounted(() => {
  stopTail();
  stopListPoll();
});
watch(() => refreshSignal?.value, () => loadList(true));
</script>

<template>
  <div class="flex gap-4 h-[58vh] min-h-[380px]">
    <!-- 左栏 300px -->
    <aside class="w-[300px] shrink-0 flex flex-col min-h-0">
      <div class="flex items-center justify-between mb-3 shrink-0">
        <span class="text-xs text-[var(--text-3)]">共 {{ total }} 条</span>
        <button v-if="total > 0" class="text-xs text-red-500 hover:bg-[var(--surface-3)] rounded px-2 py-1 transition-colors"
                @click="showClearConfirm = true" :disabled="isClearing">清空历史</button>
      </div>
      <div class="relative mb-3 shrink-0">
        <Search class="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
        <input v-model="search" placeholder="搜索命令..."
               class="w-full h-9 pl-8 pr-3 text-sm bg-[var(--surface-2)] border border-[var(--border)] rounded-lg
                      text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none
                      focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]" />
      </div>
      <div ref="listScrollRef" class="flex-1 min-h-0 overflow-y-auto space-y-1.5" @scroll="onListScroll">
        <div v-if="listLoading && items.length === 0" class="flex justify-center py-6">
          <Loader2 class="w-5 h-5 animate-spin text-[var(--primary)]" />
        </div>
        <div v-else-if="items.length === 0" class="text-center py-6 text-xs text-[var(--text-3)]">
          <Terminal class="w-10 h-10 mx-auto mb-2 opacity-40" />
          <p>暂无命令记录</p>
          <p class="mt-1">新执行的命令会出现在这里</p>
        </div>
        <div v-for="item in items" :key="item.processId"
             class="px-3 py-2 rounded-lg cursor-pointer transition-colors border"
             :class="item.processId === selectedProcessId
               ? 'bg-[var(--primary-weak)] border-[var(--primary)]'
               : 'bg-[var(--surface-2)] border-transparent hover:bg-[var(--surface-3)]'"
             @click="selectCommand(item)">
          <div class="text-xs font-mono text-[var(--text-1)] truncate" :title="item.command">{{ item.command || '(空命令)' }}</div>
          <div class="text-[11px] text-[var(--text-3)] mt-1 flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="statusMeta[item.status]?.dotCls"></span>
            <span class="truncate">{{ formatTime(item.startedAt) }}</span>
            <span>{{ formatDuration(item.durationMs) }}</span>
            <span>{{ formatBytes(item.size) }}</span>
            <span v-if="item.exitCode != null" class="text-[var(--text-2)]">exit={{ item.exitCode }}</span>
          </div>
        </div>
        <div v-if="listLoading && items.length > 0" class="flex justify-center py-2">
          <Loader2 class="w-4 h-4 animate-spin text-[var(--text-3)]" />
        </div>
      </div>
    </aside>

    <!-- 右栏：日志查看器 -->
    <section class="flex-1 min-w-0 flex flex-col min-h-0">
      <!-- 信息卡 + 工具栏 -->
      <div v-if="selectedItem" class="shrink-0 mb-3 px-3 py-2 rounded-lg bg-[var(--surface-2)]">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-mono text-[var(--text-1)] truncate flex-1 min-w-0" :title="selectedItem.command">
            {{ selectedItem.command || '(空命令)' }}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <label class="flex items-center gap-1 text-[11px] text-[var(--text-2)] cursor-pointer whitespace-nowrap">
              <input type="checkbox" v-model="autoScroll" class="w-3 h-3 accent-[var(--primary)]" />
              自动滚动
            </label>
          </div>
        </div>
        <div class="text-[11px] text-[var(--text-2)] mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span class="px-1.5 py-0.5 rounded text-[11px] font-medium" :class="statusMeta[logStatus]?.badgeCls">{{ statusMeta[logStatus]?.label || logStatus }}</span>
          <span>开始：{{ formatTime(selectedItem.startedAt) }}</span>
          <span v-if="selectedItem.endedAt">结束：{{ formatTime(selectedItem.endedAt) }}</span>
          <span>耗时：{{ formatDuration(selectedItem.durationMs) }}</span>
          <span v-if="selectedItem.exitCode !== null">退出码：{{ selectedItem.exitCode }}</span>
          <span>大小：{{ formatBytes(selectedItem.size) }}</span>
        </div>
        <!-- 日志搜索栏 -->
        <div class="flex items-center gap-1.5 mt-2">
          <div class="relative flex-1">
            <Search class="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input v-model="logSearch" placeholder="搜索日志..."
                   class="w-full h-7 pl-7 pr-2 text-xs bg-[var(--surface-3)] border border-[var(--border)] rounded
                          text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none
                          focus:border-[var(--primary)]" />
          </div>
          <span v-if="searchMatches.length > 0" class="text-[11px] text-[var(--text-2)] whitespace-nowrap">
            {{ currentMatchIndex + 1 }}/{{ searchMatches.length }}
          </span>
          <button v-if="searchMatches.length > 0" @click="prevMatch"
                  class="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-3)] text-[var(--text-2)]"
                  title="上一个匹配">
            <ChevronUp class="w-3.5 h-3.5" />
          </button>
          <button v-if="searchMatches.length > 0" @click="nextMatch"
                  class="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--surface-3)] text-[var(--text-2)]"
                  title="下一个匹配">
            <ChevronDown class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- 日志内容区 -->
      <div v-if="!selectedItem" class="flex-1 flex flex-col items-center justify-center text-sm text-[var(--text-3)]">
        <Terminal class="w-10 h-10 mb-2 opacity-40" />
        <p>点击左侧命令查看日志</p>
      </div>
      <div v-else ref="logScrollRef" class="flex-1 min-h-0 overflow-y-auto rounded-lg bg-[var(--surface-2)] p-3
                      font-mono text-xs leading-5 whitespace-pre-wrap break-all" @scroll="onLogScroll">
        <div v-if="droppedChars > 0" class="text-[11px] text-amber-500 mb-1">
          已省略最前 {{ formatBytes(droppedChars) }} 的旧内容
        </div>
        <div v-if="logError" class="text-red-500 mb-1">{{ logError }}</div>
        <template v-for="(line, idx) in logLines" :key="idx">
          <div v-if="!logSearchDebounced" :class="line.type === 'stdout' ? 'log-stdout' : line.type === 'stderr' ? 'log-stderr' : line.type === 'stdin' ? 'log-stdin' : 'log-meta'">
            {{ line.text }}
          </div>
          <div v-else :class="line.type === 'stdout' ? 'log-stdout' : line.type === 'stderr' ? 'log-stderr' : line.type === 'stdin' ? 'log-stdin' : 'log-meta'">
            <template v-for="(seg, si) in highlightLine(line, idx)" :key="si">
              <mark v-if="seg.highlight" :class="seg.current ? 'search-highlight-current' : 'search-highlight'">{{ seg.text }}</mark>
              <span v-else>{{ seg.text }}</span>
            </template>
          </div>
        </template>
        <div v-if="logLoading" class="flex items-center gap-2 text-[var(--text-3)] py-1">
          <Loader2 class="w-3.5 h-3.5 animate-spin" /> 加载中...
        </div>
      </div>

      <!-- 底部状态栏 -->
      <div class="shrink-0 pt-2 text-[11px] text-[var(--text-3)] flex justify-between" v-if="selectedItem">
        <span>{{ formatBytes(readOffset) }} / {{ formatBytes(totalLength) }}</span>
        <span>{{ hasMore ? '继续滚动加载...' : (logStatus === 'running' ? '运行中，等待新内容...' : '已加载全部') }}</span>
      </div>
    </section>

    <!-- 清空历史确认对话框 -->
    <Teleport to="body">
      <div v-if="showClearConfirm" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
        <div class="bg-[var(--surface-1)] rounded-xl shadow-2xl p-6 w-[400px] max-w-[90vw]">
          <h3 class="text-base font-semibold text-[var(--text-1)] mb-2">清空命令历史</h3>
          <p class="text-sm text-[var(--text-2)] mb-6">将删除 <strong>{{ agentName }}</strong> 的所有历史命令日志，运行中的进程不受影响。此操作无法撤销，确定继续？</p>
          <div class="flex justify-end gap-3">
            <button @click="showClearConfirm = false" :disabled="isClearing"
                    class="px-4 py-2 text-sm rounded-lg bg-[var(--surface-2)] text-[var(--text-1)] hover:bg-[var(--surface-3)] transition-colors">取消</button>
            <button @click="handleClearHistory" :disabled="isClearing"
                    class="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors flex items-center gap-2">
              <Loader2 v-if="isClearing" class="w-3.5 h-3.5 animate-spin" />
              清空
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.log-meta { color: var(--text-3); }
.log-stdout { color: var(--text-1); }
.log-stdin { color: var(--primary); }
.log-stderr { color: #dc2626; }
.my-app-dark .log-stderr { color: #f87171; }

.search-highlight {
  background: var(--primary-weak);
  border-radius: 2px;
}
.search-highlight-current {
  background: var(--primary);
  color: white;
  border-radius: 2px;
}
</style>