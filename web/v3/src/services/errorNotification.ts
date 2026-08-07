/**
 * 错误通知服务
 *
 * 职责：
 * - 通过心跳消息接收后端错误与重试事件（替代原 /api/events 轮询）
 * - 按底层原因聚合同类错误，避免重复堆积
 * - 为错误卡片与详情对话框提供统一入口
 *
 * @author Agent Society
 */

import { apiService } from './api';
import { heartbeatService, type HeartbeatMessage } from './heartbeatService';
import { errorGroups } from './errorNotificationState';
import {
  applyRetrySummary,
  buildTechnicalInfo,
  createErrorGroup,
  mergeErrorIntoGroup,
  normalizeErrorEvent,
  resolveErrorCategory,
  sortErrorGroups,
  toSingleLinePreview,
  trimSet
} from './errorNotificationNormalizer';
import type {
  ErrorCategory,
  ErrorGroupAgent,
  ErrorNotificationGroup,
  ErrorRetrySummary,
  ErrorSeverity,
  ErrorTechnicalInfo,
  RawErrorEvent
} from './errorNotificationState';

export { errorGroups } from './errorNotificationState';
export type {
  ErrorCategory,
  ErrorGroupAgent,
  ErrorNotificationEntry,
  ErrorNotificationGroup,
  ErrorRetrySummary,
  ErrorSeverity,
  ErrorTechnicalInfo,
  RawErrorEvent
} from './errorNotificationState';

// 防止前端缓存无限增长的上限配置
const MAX_TRACKED_EVENT_IDS = 200;
const MAX_TRACKED_GROUPS = 30;
const MAX_GROUP_ENTRIES = 20;

/** 重试时向智能体发送的提示消息，与用户在对话框输入"继续"完全一致 */
const RETRY_CONTENT = '继续';

/** 原始重试事件 shape（来自心跳 retry_event 消息） */
interface RawRetryEvent {
  agentId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorMessage: string;
  timestamp: string;
}

/**
 * 错误通知服务。
 */
class ErrorNotificationService {
  private initialized = false;
  private processedErrorIds = new Set<string>();
  private processedRetryIds = new Set<string>();
  private retrySummaryByGroupKey = new Map<string, ErrorRetrySummary>();

  /**
   * 初始化服务：注册心跳消息处理器。
   */
  init(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    heartbeatService.onMessage('error_event', (msg: HeartbeatMessage) => {
      this.handleErrorEvent(msg.payload as RawErrorEvent, msg.messageId);
    });

    heartbeatService.onMessage('retry_event', (msg: HeartbeatMessage) => {
      this.handleRetryEvent(msg.payload as RawRetryEvent, msg.messageId);
    });

    console.log('[ErrorNotification] Service initialized (heartbeat)');
  }

  /**
   * 停止服务。
   */
  stop(): void {
    this.initialized = false;
  }

  /**
   * 处理单条错误事件。
   * @param rawError 原始错误事件
   * @param heartbeatMessageId 心跳消息 ID
   */
  private handleErrorEvent(rawError: RawErrorEvent, heartbeatMessageId: number): void {
    const technicalInfo = buildTechnicalInfo(rawError);
    const category = resolveErrorCategory(rawError, technicalInfo);
    const severity = this.getSeverity(category);
    const entry = normalizeErrorEvent(rawError, severity, heartbeatMessageId);

    if (this.processedErrorIds.has(entry.id)) {
      return;
    }

    this.processedErrorIds.add(entry.id);
    trimSet(this.processedErrorIds, MAX_TRACKED_EVENT_IDS);

    const retrySummary = this.retrySummaryByGroupKey.get(entry.groupKey) ?? null;
    const existingGroup = errorGroups.find(group => group.key === entry.groupKey);

    if (existingGroup) {
      mergeErrorIntoGroup(existingGroup, entry, retrySummary, MAX_GROUP_ENTRIES);
    } else {
      errorGroups.unshift(createErrorGroup(entry, retrySummary));
      if (errorGroups.length > MAX_TRACKED_GROUPS) {
        errorGroups.length = MAX_TRACKED_GROUPS;
      }
    }

    sortErrorGroups();
  }

  /**
   * 处理重试事件，只更新同类错误的重试统计，不单独弹出卡片。
   * @param retry 原始重试事件
   * @param heartbeatMessageId 心跳消息 ID
   */
  private handleRetryEvent(retry: RawRetryEvent, heartbeatMessageId: number): void {
    const retryId = `${retry.agentId}|${retry.timestamp}|${retry.attempt}|${retry.errorMessage}`;
    if (this.processedRetryIds.has(retryId)) {
      return;
    }

    this.processedRetryIds.add(retryId);
    trimSet(this.processedRetryIds, MAX_TRACKED_EVENT_IDS);

    const technicalInfo = this.buildRetryTechnicalInfo(retry.errorMessage);
    const retryCategory = resolveErrorCategory({ message: retry.errorMessage }, technicalInfo);
    const retryEntry = normalizeErrorEvent(
      {
        message: retry.errorMessage,
        userMessage: retry.errorMessage,
        errorCategory: retryCategory
      },
      this.getSeverity(retryCategory),
      heartbeatMessageId
    );
    const retryGroupKey = retryEntry.groupKey;

    const currentSummary = this.retrySummaryByGroupKey.get(retryGroupKey);
    const nextSummary: ErrorRetrySummary = {
      totalEvents: (currentSummary?.totalEvents ?? 0) + 1,
      maxAttempt: Math.max(currentSummary?.maxAttempt ?? 0, retry.attempt),
      maxRetries: Math.max(currentSummary?.maxRetries ?? 0, retry.maxRetries),
      latestTimestamp: retry.timestamp
    };

    this.retrySummaryByGroupKey.set(retryGroupKey, nextSummary);

    const existingGroup = errorGroups.find(group => group.key === retryGroupKey);
    if (existingGroup) {
      applyRetrySummary(existingGroup, nextSummary);
      // 追溯重试事件的心跳消息 ID
      if (heartbeatMessageId > 0 && !existingGroup.messageIds.includes(heartbeatMessageId)) {
        existingGroup.messageIds.push(heartbeatMessageId);
      }
    }
  }

  /**
   * 为重试事件构建简化技术信息。
   * @param errorMessage 重试错误消息
   * @returns 简化技术信息
   */
  private buildRetryTechnicalInfo(errorMessage: string): ErrorTechnicalInfo {
    return {
      detailedMessage: errorMessage,
      originalError: errorMessage,
      errorName: 'RetryError',
      technicalDetails: {},
      originalMessageId: null,
      taskId: null
    };
  }

  /**
   * 根据错误分类获取严重程度。
   * @param category 错误分类
   * @returns 对应的严重程度
   */
  getSeverity(category: ErrorCategory): ErrorSeverity {
    switch (category) {
      case 'auth':
      case 'server':
        return 'error';
      case 'rate_limit':
      case 'network':
        return 'warn';
      case 'context_length':
        return 'info';
      default:
        return 'error';
    }
  }

  /**
   * 移除指定错误分组，并通知服务器清除对应的心跳消息。
   * @param group 需要移除的分组
   */
  removeGroup(group: ErrorNotificationGroup): void {
    const index = errorGroups.findIndex(item => item.key === group.key);
    if (index !== -1) {
      errorGroups.splice(index, 1);
    }
    this._clearHeartbeatMessages(group.messageIds);
  }

  /**
   * 向错误分组涉及的智能体发送"继续"消息，恢复其处理流程。
   *
   * 复用 /api/send 发送链路，与用户在对话框输入"继续"完全一致，仅跳过用户输入环节。
   * agentId 为 'unknown' 是归一化兜底值（无法归属到真实智能体），必须跳过。
   * @param agents 分组内涉及的智能体列表
   * @returns 发送结果统计
   */
  async retryAgents(agents: ErrorGroupAgent[]): Promise<{ total: number; succeeded: number; failed: number }> {
    const targets = agents.filter(agent => agent.agentId && agent.agentId !== 'unknown');
    const results = await Promise.allSettled(
      targets.map(agent => apiService.sendMessage(agent.agentId, RETRY_CONTENT))
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[ErrorNotification] 向智能体 ${targets[index].agentId} 发送继续消息失败:`, result.reason);
      }
    });
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    return { total: targets.length, succeeded, failed: targets.length - succeeded };
  }

  /**
   * 清空所有错误分组与缓存。
   */
  clearAll(): void {
    const allMessageIds = errorGroups.flatMap(group => group.messageIds);
    errorGroups.length = 0;
    this.processedErrorIds.clear();
    this.processedRetryIds.clear();
    this.retrySummaryByGroupKey.clear();
    this._clearHeartbeatMessages(allMessageIds);
  }

  /**
   * 通知服务器清除指定的心跳消息。
   * 非阻塞：失败时不抛出异常，仅记录警告。
   * @param messageIds 需要清除的消息 ID 列表
   */
  private _clearHeartbeatMessages(messageIds: number[]): void {
    if (messageIds.length === 0) return;
    fetch('/api/heartbeat/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds })
    }).catch(err => {
      console.warn('[ErrorNotification] 清除心跳消息失败:', err);
    });
  }

  /**
   * 生成分组的单行原因预览。
   * @param group 错误分组
   * @returns 单行原因预览
   */
  getGroupPreview(group: ErrorNotificationGroup): string {
    return toSingleLinePreview(group.displayReason);
  }
}

// 单例实例
export const errorNotificationService = new ErrorNotificationService();
