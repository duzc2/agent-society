<template>
  <div v-if="errorGroups.length > 0" class="error-toast-stack">
    <TransitionGroup name="error-group-card">
      <section
        v-for="group in errorGroups"
        :key="group.key"
        class="error-group-card"
        :class="`is-${group.severity}`"
        @click="openErrorDetail(group)"
      >
        <div class="error-group-header">
          <div class="error-group-header-left">
            <span class="error-group-badge" :class="`is-${group.severity}`">
              {{ formatCategoryLabel(group) }}
            </span>
            <span class="error-group-time">{{ formatTime(group.lastTimestamp) }}</span>
          </div>
          <div class="error-group-actions">
            <button
              type="button"
              class="error-group-action-btn is-retry"
              :disabled="isRetrying(group.key)"
              @click.stop="retryGroup(group)"
            >
              重试
            </button>
            <button
              type="button"
              class="error-group-action-btn"
              @click.stop="openErrorDetail(group)"
            >
              详情
            </button>
            <button
              type="button"
              class="error-group-action-btn is-close"
              @click.stop="dismissGroup(group)"
            >
              关闭
            </button>
          </div>
        </div>

        <div class="error-group-reason">{{ errorNotificationService.getGroupPreview(group) }}</div>

        <div v-if="shouldShowSecondaryMessage(group)" class="error-group-message">
          {{ group.latestUserMessage }}
        </div>

        <div class="error-group-meta">
          <span>{{ group.count }} 次失败</span>
          <span>{{ group.agents.length }} 个智能体</span>
          <span>{{ formatAgentSummary(group) }}</span>
        </div>

        <div v-if="group.retrySummary" class="error-group-retry">
          相关重试 {{ group.retrySummary.totalEvents }} 次，最高第 {{ group.retrySummary.maxAttempt }}/{{ group.retrySummary.maxRetries }} 次
        </div>
      </section>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
/**
 * 错误分组提示组件。
 *
 * 职责：
 * - 以固定卡片形式展示错误分组
 * - 强调底层原因，而不是把重试包装文案放在最显眼位置
 * - 支持查看同类错误详情和手动关闭分组
 */
import { ref } from 'vue';
import { useDialog } from 'primevue/usedialog';
import { useToast } from 'primevue/usetoast';
import { openErrorDetailWindow } from './errorDetailWindow';
import {
  errorGroups,
  errorNotificationService,
  type ErrorNotificationGroup
} from '../../services/errorNotification';

const dialog = useDialog();
const toast = useToast();

/** 正在重试的分组 key 集合，用于防止重复点击 */
const retryingKeys = ref<Set<string>>(new Set());

/**
 * 判断指定分组是否正在重试。
 * @param key 分组 key
 * @returns 是否正在重试
 */
function isRetrying(key: string): boolean {
  return retryingKeys.value.has(key);
}

/**
 * 格式化时间文本。
 * @param timestamp ISO 时间戳
 * @returns 本地化时间文本
 */
function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return timestamp;
  }
}

/**
 * 生成分组的分类标签。
 * @param group 错误分组
 * @returns 分类标签文本
 */
function formatCategoryLabel(group: ErrorNotificationGroup): string {
  switch (group.errorCategory) {
    case 'network':
      return '网络';
    case 'auth':
      return '鉴权';
    case 'rate_limit':
      return '限流';
    case 'context_length':
      return '上下文';
    case 'server':
      return '服务端';
    default:
      return '错误';
  }
}

/**
 * 生成涉及智能体的摘要文本。
 * @param group 错误分组
 * @returns 智能体摘要文本
 */
function formatAgentSummary(group: ErrorNotificationGroup): string {
  const labels = group.agents.slice(0, 3).map(agent => agent.agentName);
  if (group.agents.length > 3) {
    labels.push(`等 ${group.agents.length} 个`);
  }
  return labels.join('、');
}

/**
 * 判断是否需要展示辅助提示文案。
 * @param group 错误分组
 * @returns 是否展示辅助提示文案
 */
function shouldShowSecondaryMessage(group: ErrorNotificationGroup): boolean {
  return group.latestUserMessage.trim() !== '' && group.latestUserMessage.trim() !== group.displayReason.trim();
}

/**
 * 打开错误详情对话框。
 * @param group 错误分组
 */
function openErrorDetail(group: ErrorNotificationGroup): void {
  openErrorDetailWindow(dialog, group);
}

/**
 * 手动关闭指定错误分组。
 * @param group 错误分组
 */
function dismissGroup(group: ErrorNotificationGroup): void {
  errorNotificationService.removeGroup(group);
}

/**
 * 向分组涉及的智能体发送"继续"消息，尝试恢复其处理流程。
 * 全部成功后自动关闭该分组；有失败则保留分组。
 * @param group 错误分组
 */
async function retryGroup(group: ErrorNotificationGroup): Promise<void> {
  if (retryingKeys.value.has(group.key)) {
    return;
  }
  retryingKeys.value.add(group.key);
  try {
    const result = await errorNotificationService.retryAgents(group.agents);
    if (result.total === 0) {
      toast.add({
        severity: 'warn',
        summary: '无可重试智能体',
        detail: '该错误分组没有可发送消息的智能体',
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
      errorNotificationService.removeGroup(group);
      return;
    }
    toast.add({
      severity: 'error',
      summary: '发送继续失败',
      detail: `${result.failed}/${result.total} 个智能体发送失败`,
      life: 5000
    });
  } catch (err) {
    console.error('[ErrorToast] 重试发送继续消息失败:', err);
    toast.add({
      severity: 'error',
      summary: '重试失败',
      detail: '发送继续消息时发生异常',
      life: 5000
    });
  } finally {
    retryingKeys.value.delete(group.key);
  }
}
</script>

<style scoped>
.error-toast-stack {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, calc(100vw - 32px));
  pointer-events: none;
}

.error-group-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--surface-300) 68%, transparent);
  background: color-mix(in srgb, var(--surface-0) 92%, transparent);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  pointer-events: auto;
  cursor: pointer;
}

.error-group-card.is-error {
  border-left: 4px solid #dc2626;
}

.error-group-card.is-warn {
  border-left: 4px solid #d97706;
}

.error-group-card.is-info {
  border-left: 4px solid #2563eb;
}

.error-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.error-group-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.error-group-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.error-group-action-btn {
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--surface-300) 76%, transparent);
  background: color-mix(in srgb, var(--surface-0) 88%, transparent);
  color: var(--text-color);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
}

.error-group-action-btn:hover {
  background: color-mix(in srgb, var(--surface-100) 92%, transparent);
}

.error-group-action-btn.is-retry {
  color: #1d4ed8;
  border-color: rgba(37, 99, 235, 0.28);
}

.error-group-action-btn.is-close {
  color: #b91c1c;
  border-color: rgba(220, 38, 38, 0.28);
}

.error-group-action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.error-group-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.error-group-badge.is-error {
  background: rgba(220, 38, 38, 0.14);
  color: #b91c1c;
}

.error-group-badge.is-warn {
  background: rgba(217, 119, 6, 0.14);
  color: #b45309;
}

.error-group-badge.is-info {
  background: rgba(37, 99, 235, 0.14);
  color: #1d4ed8;
}

.error-group-time {
  font-size: 12px;
  color: var(--text-color-secondary);
  white-space: nowrap;
}

.error-group-reason {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  color: var(--text-color);
  word-break: break-word;
}

.error-group-message {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-color-secondary);
  word-break: break-word;
}

.error-group-meta,
.error-group-retry {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 12px;
  color: var(--text-color-secondary);
}

.error-group-card-enter-active,
.error-group-card-leave-active {
  transition: all 0.22s ease;
}

.error-group-card-enter-from,
.error-group-card-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

@media (max-width: 768px) {
  .error-toast-stack {
    top: 12px;
    right: 12px;
    left: 12px;
    width: auto;
  }

  .error-group-card {
    padding: 12px 14px;
  }
}
</style>
