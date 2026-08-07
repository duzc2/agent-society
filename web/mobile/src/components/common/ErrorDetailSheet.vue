<script setup lang="ts">
/**
 * 错误详情底部面板（移动端）
 *
 * 遵循项目已有模式（参考 CmdConfirmSheet.vue）：
 * - 半透明遮罩层 + 底部滑入面板
 * - 点击遮罩关闭
 */
import { computed, ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { detailSheet, errorNotificationService } from '../../services/errorNotificationService';
import type { ErrorGroup } from '../../services/errorNotificationService';
import { useAgentStore } from '../../stores/agent';
import { useOrgStore } from '../../stores/org';

const group = computed<ErrorGroup | null>(() => detailSheet.group);
const agentStore = useAgentStore();
const orgStore = useOrgStore();
const toast = useToast();
const retrying = ref(false);

const findAgentById = (id: string) => {
  return agentStore.allAgents.find(a => a.id === id) ?? null;
};

const resolvedAgentInfo = computed(() => {
  if (!group.value) return { resolvedName: '', orgName: '' };
  const agent = findAgentById(group.value.agentId);
  const resolvedName = agent ? agent.name : group.value.agentName;
  const orgName = agent ? (orgStore.orgs.find(o => o.id === agent.orgId)?.name ?? '') : '';
  return { resolvedName, orgName };
});

function close() {
  errorNotificationService.closeDetail();
}

function dismiss() {
  if (group.value) {
    errorNotificationService.removeGroup(group.value);
  }
}

/** 向该错误涉及的智能体发送"继续"消息；成功时 removeGroup 会自动关闭详情面板 */
async function retry() {
  if (!group.value || retrying.value) return;
  retrying.value = true;
  try {
    const result = await errorNotificationService.retryGroup(group.value);
    if (result.ok) {
      toast.add({ severity: 'success', summary: '已发送', detail: `已向 ${resolvedAgentInfo.value.resolvedName} 发送"继续"消息`, life: 3000 });
      errorNotificationService.removeGroup(group.value);
    } else if (result.skipped) {
      toast.add({ severity: 'warn', summary: '无法重试', detail: '缺少有效的智能体 ID', life: 3000 });
    } else {
      toast.add({ severity: 'error', summary: '重试失败', detail: '向智能体发送继续消息失败', life: 3000 });
    }
  } finally {
    retrying.value = false;
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'auth': return '鉴权错误';
    case 'network': return '网络错误';
    case 'rate_limit': return '频率限制';
    case 'context_length': return '上下文超限';
    case 'server': return '服务端错误';
    default: return '错误';
  }
}

function categoryAccent(cat: string): string {
  switch (cat) {
    case 'auth':
    case 'server':
      return '#ef4444';
    case 'network':
    case 'rate_limit':
      return '#f97316';
    default:
      return '#6b7280';
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="detailSheet.visible"
      class="sheet-overlay"
      @click="close"
    >
      <div class="sheet-content" @click.stop>
        <!-- 拖拽示意条 -->
        <div class="drag-handle">
          <div class="drag-bar" />
        </div>

        <!-- 标题：错误分类 + 智能体 -->
        <div class="flex items-center gap-2 mb-3">
          <div
            class="w-1.5 h-5 rounded-full flex-shrink-0"
            :style="{ backgroundColor: group ? categoryAccent(group.errorCategory) : '#6b7280' }"
          />
          <h3 class="text-base font-semibold text-[var(--text-1)] flex-1">
            {{ group ? categoryLabel(group.errorCategory) : '错误详情' }}
          </h3>
        </div>

        <template v-if="group">
          <!-- 智能体 -->
          <div class="mb-3">
            <div class="flex items-center gap-2">
              <span v-if="resolvedAgentInfo.orgName" class="text-[11px] text-[var(--text-3)] bg-[var(--surface-3)] border border-[var(--border)] rounded-md px-2 py-0.5">{{ resolvedAgentInfo.orgName }}</span>
              <span class="text-sm text-[var(--text-1)] font-medium">{{ resolvedAgentInfo.resolvedName }}</span>
            </div>
            <p class="text-[10px] text-[var(--text-3)] mt-1 opacity-65 font-mono" :title="group.agentId">{{ group.agentId }}</p>
          </div>

          <!-- 错误消息（主要内容，允许换行） -->
          <div class="message-box mb-3">
            <p class="text-sm text-[var(--text-1)] leading-relaxed whitespace-pre-wrap break-all">
              {{ group.fullMessage || group.displayReason }}
            </p>
          </div>

          <!-- 元信息行 -->
          <div class="flex gap-2 flex-wrap mb-3">
            <div class="meta-chip">
              <span class="text-[var(--text-3)] text-[10px]">发生</span>
              <span class="text-[var(--text-1)] text-xs font-medium">{{ group.count }} 次</span>
            </div>
            <div class="meta-chip">
              <span class="text-[var(--text-3)] text-[10px]">类型</span>
              <span class="text-[var(--text-1)] text-xs font-medium font-mono">{{ group.errorName }}</span>
            </div>
            <div class="meta-chip" v-if="group.technicalDetails.status">
              <span class="text-[var(--text-3)] text-[10px]">状态码</span>
              <span class="text-[var(--text-1)] text-xs font-medium">{{ group.technicalDetails.status }}</span>
            </div>
            <div class="meta-chip" v-if="group.technicalDetails.code">
              <span class="text-[var(--text-3)] text-[10px]">代码</span>
              <span class="text-[var(--text-1)] text-xs font-medium font-mono">{{ group.technicalDetails.code }}</span>
            </div>
          </div>

          <!-- 时间 -->
          <p class="text-xs text-[var(--text-3)] mb-3">
            {{ formatTime(group.lastTimestamp) }}
          </p>

          <!-- 堆栈（可折叠） -->
          <details v-if="group.technicalDetails.stack" class="stack-section mb-3">
            <summary class="text-xs text-[var(--text-3)] cursor-pointer select-none py-1">
              查看堆栈跟踪
            </summary>
            <pre class="mt-2 text-[11px] text-[var(--text-2)] font-mono whitespace-pre-wrap break-all leading-relaxed bg-[var(--surface-3)] rounded-lg p-2.5 max-h-48 overflow-auto border border-[var(--border)]">{{ group.technicalDetails.stack }}</pre>
          </details>

          <!-- 操作按钮 -->
          <div class="flex gap-3 pt-1">
            <button
              class="flex-1 py-3 rounded-xl bg-[var(--surface-3)] text-[var(--text-2)] text-sm font-medium active:scale-95 transition-transform"
              @click="close"
              type="button"
            >
              关闭
            </button>
            <button
              class="flex-1 py-3 rounded-xl bg-blue-500 text-white text-sm font-medium active:scale-95 transition-transform disabled:opacity-50"
              :disabled="retrying || group.agentId === 'unknown'"
              @click="retry"
              type="button"
            >
              重试
            </button>
            <button
              class="flex-1 py-3 rounded-xl bg-red-500 text-white text-sm font-medium active:scale-95 transition-transform"
              @click="dismiss"
              type="button"
            >
              清除此错误
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  animation: fadeIn 0.2s ease-out;
}

.sheet-content {
  width: 100%;
  max-width: 480px;
  max-height: 85vh;
  overflow-y: auto;
  background: var(--surface-1);
  border-radius: 16px 16px 0 0;
  padding: 8px 20px 28px;
  animation: slideUp 0.25s ease-out;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
}

.drag-handle {
  display: flex;
  justify-content: center;
  padding: 8px 0 12px;
}

.drag-bar {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
}

.message-box {
  padding: 12px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.meta-chip {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 10px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.stack-section > summary {
  list-style: none;
}
.stack-section > summary::before {
  content: '▸ ';
}
.stack-section[open] > summary::before {
  content: '▾ ';
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
