<template>
  <div class="occurrence-list">
    <article v-for="entry in props.entries" :key="entry.id" class="occurrence-card">
      <div class="occurrence-header">
        <div class="occurrence-header-left">
          <span v-if="resolvedAgentInfo[entry.id]?.orgName" class="occurrence-org">{{ resolvedAgentInfo[entry.id].orgName }}</span>
          <span class="occurrence-agent">{{ resolvedAgentInfo[entry.id]?.resolvedName || entry.agentName }}</span>
          <span class="occurrence-agent-id" :title="entry.agentId">{{ entry.agentId }}</span>
        </div>
        <div class="occurrence-time">{{ formatDateTime(entry.timestamp) }}</div>
      </div>

      <div class="occurrence-block">
        <div class="occurrence-label">原始错误</div>
        <pre class="tech-code">{{ entry.technicalInfo.originalError || entry.displayReason }}</pre>
      </div>

      <div
        v-if="entry.userMessage && entry.userMessage !== entry.technicalInfo.originalError"
        class="occurrence-block"
      >
        <div class="occurrence-label">界面提示</div>
        <pre class="tech-code">{{ entry.userMessage }}</pre>
      </div>

      <div
        v-if="entry.technicalInfo.detailedMessage
          && entry.technicalInfo.detailedMessage !== entry.userMessage
          && entry.technicalInfo.detailedMessage !== entry.technicalInfo.originalError"
        class="occurrence-block"
      >
        <div class="occurrence-label">详细信息</div>
        <pre class="tech-code">{{ entry.technicalInfo.detailedMessage }}</pre>
      </div>

      <div v-if="hasTechnicalMeta(entry)" class="occurrence-meta">
        <span v-if="entry.technicalInfo.technicalDetails.status">HTTP {{ entry.technicalInfo.technicalDetails.status }}</span>
        <span v-if="entry.technicalInfo.technicalDetails.code">代码 {{ entry.technicalInfo.technicalDetails.code }}</span>
        <span v-if="entry.technicalInfo.technicalDetails.type">类型 {{ entry.technicalInfo.technicalDetails.type }}</span>
        <span v-if="entry.roleId">岗位 {{ entry.roleId }}</span>
      </div>

      <div v-if="entry.technicalInfo.technicalDetails.stack" class="occurrence-block">
        <div class="occurrence-label">堆栈</div>
        <pre class="tech-code stack-trace">{{ entry.technicalInfo.technicalDetails.stack }}</pre>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
/**
 * 错误发生明细列表。
 *
 * 职责：
 * - 渲染同类错误的逐条明细
 * - 保持每条错误的原始原因、界面提示和技术信息可见
 */
import { computed } from 'vue';
import { useAgentStore } from '../../stores/agent';
import { useOrgStore } from '../../stores/org';
import type { ErrorNotificationEntry } from '../../services/errorNotification';

interface Props {
  entries: ErrorNotificationEntry[];
}

const props = defineProps<Props>();
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

const resolvedAgentInfo = computed(() => {
  const info: Record<string, { resolvedName: string; orgName: string }> = {};
  for (const entry of props.entries) {
    const agent = findAgentById(entry.agentId);
    const agentName = agent ? agent.name : entry.agentName;

    let orgName = '';
    if (agent) {
      orgName = orgStore.orgs.find(o => o.id === agent.orgId)?.name ?? '';
      if (!orgName) {
        const orgAgents = agentStore.agentsMap[agent.orgId];
        if (orgAgents) {
          const firstAgent = orgAgents.find(a => a.id !== 'user');
          if (firstAgent) orgName = firstAgent.name;
        }
      }
    }

    info[entry.id] = {
      resolvedName: orgName ? `${orgName}-${agentName}` : agentName,
      orgName
    };
  }
  return info;
});

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
 * 判断条目是否包含额外技术元信息。
 * @param entry 错误条目
 * @returns 是否存在技术元信息
 */
function hasTechnicalMeta(entry: ErrorNotificationEntry): boolean {
  return Boolean(
    entry.technicalInfo.technicalDetails.status
    || entry.technicalInfo.technicalDetails.code
    || entry.technicalInfo.technicalDetails.type
    || entry.roleId
  );
}

</script>

<style scoped>
.occurrence-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0;
}

.occurrence-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-50) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--surface-200) 70%, transparent);
}

.occurrence-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.occurrence-header-left {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.occurrence-agent {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-color);
}

.occurrence-org {
  font-size: 11px;
  color: var(--text-color-secondary);
  background: color-mix(in srgb, var(--surface-200) 50%, transparent);
  padding: 1px 6px;
  border-radius: 6px;
}

.occurrence-agent-id {
  font-size: 10px;
  color: var(--text-color-secondary);
  font-family: 'Courier New', monospace;
  opacity: 0.65;
}

.occurrence-time {
  font-size: 12px;
  color: var(--text-color-secondary);
  font-family: 'Courier New', monospace;
}

.occurrence-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.occurrence-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-color-secondary);
}

.occurrence-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 12px;
  color: var(--text-color-secondary);
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

.stack-trace {
  max-height: 260px;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .occurrence-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
