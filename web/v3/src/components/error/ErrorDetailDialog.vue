<template>
  <div class="error-detail-dialog">
    <div class="root-cause-section">
      <div class="section-title">
        <AlertCircle class="icon" />
        <span>主要原因</span>
      </div>
      <div class="root-cause-text">{{ rootCause }}</div>
      <div v-if="latestUserMessage && latestUserMessage !== rootCause" class="user-message-box">
        <div class="user-message-label">界面提示</div>
        <div class="user-message-text">{{ latestUserMessage }}</div>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-card">
        <span class="overview-label">错误类型</span>
        <Tag :value="primaryEntry.errorType" :severity="tagSeverity" />
      </div>
      <div class="overview-card">
        <span class="overview-label">发生次数</span>
        <span class="overview-value">{{ occurrenceCount }}</span>
      </div>
      <div class="overview-card">
        <span class="overview-label">涉及智能体</span>
        <span class="overview-value">{{ affectedAgents.length }}</span>
      </div>
      <div class="overview-card">
        <span class="overview-label">最近时间</span>
        <span class="overview-value">{{ latestTime }}</span>
      </div>
      <div class="overview-card" v-if="group">
        <span class="overview-label">首次时间</span>
        <span class="overview-value">{{ firstTime }}</span>
      </div>
      <div class="overview-card" v-if="retryText">
        <span class="overview-label">相关重试</span>
        <span class="overview-value">{{ retryText }}</span>
      </div>
    </div>

    <div class="agent-chip-list">
      <div v-for="agent in resolvedAffectedAgents" :key="agent.agentId" class="agent-chip">
        <span class="agent-chip-name">{{ agent.resolvedName }}</span>
        <span class="agent-chip-count">{{ agent.occurrences }} 次</span>
      </div>
    </div>

    <Panel header="同类错误明细" toggleable class="detail-panel">
      <ErrorOccurrenceList :entries="entries" />
    </Panel>

    <Panel header="完整对象" toggleable collapsed class="detail-panel">
      <pre class="tech-code full-payload">{{ serializedCopyPayload }}</pre>
    </Panel>

    <div class="action-buttons">
      <Button
        label="复制错误信息"
        icon="pi pi-copy"
        severity="secondary"
        @click="copyError"
        class="action-button"
      />
      <Button
        label="重试"
        icon="pi pi-refresh"
        severity="warning"
        :disabled="retrying"
        :loading="retrying"
        @click="retryGroup"
        class="action-button"
      />
      <Button
        label="关闭"
        @click="close"
        class="action-button"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 错误详情对话框。
 *
 * 职责：
 * - 优先展示底层报错原因
 * - 展示同一根因下的所有错误明细
 * - 提供复制完整错误对象的能力
 */
import { computed, inject, ref, type Ref } from 'vue';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Panel from 'primevue/panel';
import { AlertCircle } from 'lucide-vue-next';
import { useToast } from 'primevue/usetoast';
import type { DynamicDialogInstance } from 'primevue/dynamicdialogoptions';
import ErrorOccurrenceList from './ErrorOccurrenceList.vue';
import { useAgentStore } from '../../stores/agent';
import { useOrgStore } from '../../stores/org';
import type {
  ErrorNotificationEntry,
  ErrorNotificationGroup
} from '../../services/errorNotification';
import { errorNotificationService } from '../../services/errorNotification';

const toast = useToast();

/** 是否正在重试，用于禁用按钮并展示加载态 */
const retrying = ref(false);
const dialogRef = inject<Ref<DynamicDialogInstance>>('dialogRef');
const agentStore = useAgentStore();
const orgStore = useOrgStore();

const findAgentById = (id: string) => {
  const globalAgent = agentStore.allAgents.find(a => a.id === id);
  if (globalAgent) return globalAgent;
  for (const orgId in agentStore.agentsMap) {
    const agents = agentStore.agentsMap[orgId];
    if (agents) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent;
    }
  }
  return null;
};

/**
 * 创建兜底错误条目，避免对话框在缺少数据时崩溃。
 * @returns 兜底错误条目
 */
function createFallbackEntry(): ErrorNotificationEntry {
  return {
    id: 'fallback-error',
    groupKey: 'fallback-error',
    agentId: 'unknown',
    agentName: 'unknown',
    roleId: null,
    errorType: 'unknown',
    errorCategory: 'unknown',
    severity: 'error',
    timestamp: new Date().toISOString(),
    userMessage: '无法获取错误详情',
    displayReason: '无法获取错误详情',
    technicalInfo: {
      detailedMessage: '无法获取错误详情',
      originalError: '无法获取错误详情',
      errorName: 'UnknownError',
      technicalDetails: {},
      originalMessageId: null,
      taskId: null
    },
    rawEvent: {},
    heartbeatMessageId: 0
  };
}

/**
 * 格式化时间字符串。
 * @param timestamp ISO 时间戳
 * @returns 本地化时间文本
 */
function formatDateTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return timestamp;
  }
}

/**
 * 构建可复制的纯对象载荷。
 * @param group 错误分组
 * @param entries 错误条目列表
 * @returns 纯对象载荷
 */
function buildCopyPayload(
  group: ErrorNotificationGroup | null,
  entries: ErrorNotificationEntry[]
): Record<string, unknown> {
  if (group) {
    return {
      key: group.key,
      displayReason: group.displayReason,
      errorCategory: group.errorCategory,
      severity: group.severity,
      count: group.count,
      firstTimestamp: group.firstTimestamp,
      lastTimestamp: group.lastTimestamp,
      latestUserMessage: group.latestUserMessage,
      agents: group.agents.map(agent => ({
        agentId: agent.agentId,
        agentName: agent.agentName,
        occurrences: agent.occurrences,
        latestTimestamp: agent.latestTimestamp
      })),
      retrySummary: group.retrySummary,
      entries: entries.map(entry => ({
        id: entry.id,
        agentId: entry.agentId,
        agentName: entry.agentName,
        roleId: entry.roleId,
        errorType: entry.errorType,
        errorCategory: entry.errorCategory,
        timestamp: entry.timestamp,
        userMessage: entry.userMessage,
        displayReason: entry.displayReason,
        technicalInfo: entry.technicalInfo,
        rawEvent: entry.rawEvent
      }))
    };
  }

  const entry = entries[0] ?? createFallbackEntry();
  return {
    id: entry.id,
    agentId: entry.agentId,
    agentName: entry.agentName,
    roleId: entry.roleId,
    errorType: entry.errorType,
    errorCategory: entry.errorCategory,
    timestamp: entry.timestamp,
    userMessage: entry.userMessage,
    displayReason: entry.displayReason,
    technicalInfo: entry.technicalInfo,
    rawEvent: entry.rawEvent
  };
}

const group = computed<ErrorNotificationGroup | null>(() => {
  return (dialogRef?.value?.data?.group as ErrorNotificationGroup | undefined) ?? null;
});

const primaryEntry = computed<ErrorNotificationEntry>(() => {
  return (dialogRef?.value?.data?.error as ErrorNotificationEntry | undefined)
    ?? group.value?.latestEntry
    ?? createFallbackEntry();
});

const entries = computed<ErrorNotificationEntry[]>(() => {
  return group.value?.entries ?? [primaryEntry.value];
});

const rootCause = computed(() => {
  return group.value?.displayReason ?? primaryEntry.value.displayReason;
});

const latestUserMessage = computed(() => {
  return group.value?.latestUserMessage ?? primaryEntry.value.userMessage;
});

const occurrenceCount = computed(() => {
  return group.value?.count ?? 1;
});

const latestTime = computed(() => {
  return formatDateTime(group.value?.lastTimestamp ?? primaryEntry.value.timestamp);
});

const firstTime = computed(() => {
  return formatDateTime(group.value?.firstTimestamp ?? primaryEntry.value.timestamp);
});

const affectedAgents = computed(() => {
  return group.value?.agents ?? [
    {
      agentId: primaryEntry.value.agentId,
      agentName: primaryEntry.value.agentName,
      occurrences: 1,
      latestTimestamp: primaryEntry.value.timestamp
    }
  ];
});

const resolvedAffectedAgents = computed(() => {
  return affectedAgents.value.map(agent => {
    const found = findAgentById(agent.agentId);
    const agentName = found ? found.name : agent.agentName;

    let orgName = '';
    if (found) {
      orgName = orgStore.orgs.find(o => o.id === found.orgId)?.name ?? '';
      if (!orgName) {
        const orgAgents = agentStore.agentsMap[found.orgId];
        if (orgAgents) {
          const firstAgent = orgAgents.find(a => a.id !== 'user');
          if (firstAgent) orgName = firstAgent.name;
        }
      }
    }

    return {
      ...agent,
      resolvedName: orgName ? `${orgName}-${agentName}` : agentName,
      orgName
    };
  });
});

const retryText = computed(() => {
  if (!group.value?.retrySummary) {
    return '';
  }
  return `${group.value.retrySummary.totalEvents} 次，最高第 ${group.value.retrySummary.maxAttempt}/${group.value.retrySummary.maxRetries} 次`;
});

const tagSeverity = computed(() => {
  switch (primaryEntry.value.errorCategory) {
    case 'auth':
    case 'server':
      return 'danger';
    case 'rate_limit':
    case 'network':
      return 'warning';
    case 'context_length':
      return 'info';
    default:
      return 'secondary';
  }
});

const serializedCopyPayload = computed(() => {
  return JSON.stringify(buildCopyPayload(group.value, entries.value), null, 2);
});

/**
 * 复制完整错误信息到剪贴板。
 */
async function copyError(): Promise<void> {
  try {
    await navigator.clipboard.writeText(serializedCopyPayload.value);
    toast.add({
      severity: 'success',
      summary: '已复制',
      detail: '错误信息已复制到剪贴板',
      life: 2000
    });
  } catch {
    toast.add({
      severity: 'error',
      summary: '复制失败',
      detail: '无法复制到剪贴板',
      life: 2000
    });
  }
}

/**
 * 向涉及的智能体发送"继续"消息，尝试恢复其处理流程。
 * 全部成功后关闭分组与对话框；有失败则保留分组。
 */
async function retryGroup(): Promise<void> {
  if (retrying.value) {
    return;
  }
  retrying.value = true;
  try {
    const result = await errorNotificationService.retryAgents(affectedAgents.value);
    if (result.total === 0) {
      toast.add({
        severity: 'warn',
        summary: '无可重试智能体',
        detail: '该错误没有可发送消息的智能体',
        life: 3000
      });
      return;
    }
    if (result.failed === 0) {
      toast.add({
        severity: 'success',
        summary: '已发送继续',
        detail: `已向 ${result.succeeded} 个智能体发送继续`,
        life: 3000
      });
      const currentGroup = group.value;
      if (currentGroup) {
        errorNotificationService.removeGroup(currentGroup);
      }
      close();
      return;
    }
    toast.add({
      severity: 'error',
      summary: '发送继续失败',
      detail: `${result.failed}/${result.total} 个智能体发送失败`,
      life: 5000
    });
  } catch (err) {
    console.error('[ErrorDetailDialog] 重试发送继续消息失败:', err);
    toast.add({
      severity: 'error',
      summary: '重试失败',
      detail: '发送继续消息时发生异常',
      life: 5000
    });
  } finally {
    retrying.value = false;
  }
}

/**
 * 关闭对话框。
 */
function close(): void {
  dialogRef?.value?.close?.();
}
</script>

<style scoped>
.error-detail-dialog {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.root-cause-section {
  background: color-mix(in srgb, var(--surface-100) 85%, transparent);
  border-radius: 12px;
  padding: 16px;
  border-left: 4px solid #dc2626;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: var(--text-color);
  margin-bottom: 10px;
}

.icon {
  width: 20px;
  height: 20px;
  color: #dc2626;
}

.root-cause-text {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.7;
  color: var(--text-color);
  word-break: break-word;
}

.user-message-box {
  margin-top: 12px;
  padding: 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-50) 85%, transparent);
}

.user-message-label,
.overview-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-color-secondary);
}

.user-message-text {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-color);
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.overview-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-50) 85%, transparent);
  border: 1px solid color-mix(in srgb, var(--surface-200) 70%, transparent);
}

.overview-value {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-color);
  font-family: 'Courier New', monospace;
  word-break: break-word;
}

.agent-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-100) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--surface-200) 68%, transparent);
}

.agent-chip-org {
  font-size: 11px;
  color: var(--text-color-secondary);
  background: color-mix(in srgb, var(--surface-200) 50%, transparent);
  padding: 1px 6px;
  border-radius: 6px;
}

.agent-chip-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-color);
}

.agent-chip-count {
  font-size: 12px;
  color: var(--text-color-secondary);
}

.detail-panel :deep(.p-panel-header) {
  font-size: 13px;
  padding: 12px;
}

.tech-code {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  background: color-mix(in srgb, var(--surface-100) 88%, transparent);
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-color);
  margin: 0;
}

.full-payload {
  max-height: 320px;
  overflow-y: auto;
}

.action-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 8px;
}

.action-button {
  font-size: 13px;
}

@media (max-width: 768px) {
  .action-buttons {
    flex-direction: column-reverse;
  }
}
</style>
