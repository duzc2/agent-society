/**
 * 错误通知服务（移动端）
 *
 * 职责：
 * - 通过心跳消息接收后端错误与重试事件
 * - 按底层原因聚合同类错误
 * - 用户关闭时通知服务器清除对应心跳消息
 *
 * @author Agent Society
 */

import { reactive } from 'vue';
import { heartbeatService } from './heartbeatService';
import { apiService } from './api';

// ---------- 类型定义 ----------

export type ErrorCategory = 'network' | 'auth' | 'rate_limit' | 'context_length' | 'server' | 'unknown';

interface RawErrorEvent {
  agentId?: string;
  errorType?: string;
  errorCategory?: ErrorCategory | string;
  timestamp?: string;
  userMessage?: string;
  message?: string;
  rootCause?: string;
  groupKey?: string;
  agentContext?: {
    agentName?: string;
    roleId?: string | null;
  };
  technicalInfo?: {
    detailedMessage?: string;
    originalError?: string;
    errorName?: string;
    technicalDetails?: {
      status?: number;
      code?: string;
      type?: string;
      stack?: string;
    };
  };
  details?: unknown;
}

interface RawRetryEvent {
  agentId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorMessage: string;
  timestamp: string;
}

/** 技术详情 */
export interface ErrorTechnicalDetails {
  status?: number;
  code?: string;
  type?: string;
  stack?: string;
}

/** 错误分组模型 */
export interface ErrorGroup {
  key: string;
  displayReason: string;
  fullMessage: string;
  errorCategory: ErrorCategory;
  errorName: string;
  count: number;
  lastTimestamp: string;
  latestUserMessage: string;
  agentId: string;
  agentName: string;
  messageIds: number[];
  technicalDetails: ErrorTechnicalDetails;
}

/** 原始技术详情宽松类型 */
interface RawTechnicalDetails {
  status?: number;
  code?: string;
  type?: string;
  stack?: string;
}

/** 原始技术信息宽松类型 */
interface RawTechnicalInfo {
  detailedMessage?: string;
  originalError?: string;
  errorName?: string;
  technicalDetails?: RawTechnicalDetails;
}

// ---------- 工具函数 ----------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripRetryWrapper(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return '';

  let stripped = normalized
    .replace(/^尝试\s*\d+\s*次(?:都)?失败[：:，,\s-]*/u, '')
    .replace(/^已(?:连续)?重试\s*\d+\s*次(?:后)?失败[：:，,\s-]*/u, '')
    .replace(/^经过\s*\d+\s*次尝试(?:后)?仍失败[：:，,\s-]*/u, '')
    .replace(/^failed after\s*\d+\s*(?:attempts?|retries?)[\s:,-]*/i, '')
    .replace(/^request failed after\s*\d+\s*(?:attempts?|retries?)[\s:,-]*/i, '')
    .trim();

  const markerPatterns = [
    /原始错误[：:]\s*/iu,
    /具体错误[：:]\s*/iu,
    /底层原因[：:]\s*/iu,
    /caused by:\s*/i,
    /original error:\s*/i
  ];

  for (const pattern of markerPatterns) {
    const match = stripped.match(pattern);
    if (match && typeof match.index === 'number') {
      stripped = stripped.slice(match.index + match[0].length).trim();
    }
  }

  const lines = stripped.split('\n').map(line => line.trim()).filter(Boolean);
  const preferredLine = lines.find(line => !/尝试\s*\d+\s*次|重试/u.test(line));
  return preferredLine ?? lines[0] ?? stripped;
}

function resolveErrorCategory(raw: RawErrorEvent): ErrorCategory {
  const category = raw.errorCategory;
  const knownCategories: ErrorCategory[] = ['network', 'auth', 'rate_limit', 'context_length', 'server', 'unknown'];
  if (category && knownCategories.includes(category as ErrorCategory)) {
    return category as ErrorCategory;
  }

  const ti = (raw.technicalInfo ?? {}) as RawTechnicalInfo;
  const combined = [
    ti.originalError,
    ti.detailedMessage,
    ti.errorName,
    ti.technicalDetails?.code,
    ti.technicalDetails?.type,
    raw.message,
    raw.userMessage
  ].filter(v => v != null).join(' ').toLowerCase();

  if (/econnreset|econnrefused|enotfound|etimedout|offline|fetch failed|网络|连接|超时/u.test(combined)) return 'network';
  if (/401|403|unauthorized|forbidden|auth|api key|鉴权|认证/u.test(combined)) return 'auth';
  if (/429|rate limit|too many requests|quota|频率限制/u.test(combined)) return 'rate_limit';
  if (/context length|token limit|prompt too long|上下文/u.test(combined)) return 'context_length';
  if (/5\d\d|server|internal_error|服务器/u.test(combined)) return 'server';
  return 'unknown';
}

function buildDisplayReason(raw: RawErrorEvent): string {
  const ti = raw.technicalInfo as RawTechnicalInfo | undefined;
  const candidates = [
    raw.rootCause,
    ti?.originalError,
    ti?.detailedMessage,
    raw.message,
    raw.userMessage
  ];
  for (const c of candidates) {
    if (isNonEmptyString(c)) return stripRetryWrapper(c!);
  }
  return raw.errorType || '未知错误';
}

function buildGroupKey(category: ErrorCategory, displayReason: string, raw: RawErrorEvent): string {
  // 优先使用服务端分配的 groupKey
  if (isNonEmptyString(raw.groupKey)) return raw.groupKey.trim();

  const ti = raw.technicalInfo as RawTechnicalInfo | undefined;
  const code = ti?.technicalDetails?.code?.toLowerCase().trim() ?? '';
  const status = ti?.technicalDetails?.status ? String(ti.technicalDetails.status) : '';
  return [category, code, status, normalizeWhitespace(displayReason)]
    .filter(Boolean)
    .join('|');
}

function toSingleLine(text: string, maxLength = 80): string {
  const single = normalizeWhitespace(text).replace(/\n+/g, ' / ');
  if (single.length <= maxLength) return single;
  return `${single.slice(0, maxLength - 1)}…`;
}

// ---------- 状态 & 服务 ----------

/** 当前待展示的错误分组列表（响应式） */
export const errorGroups = reactive<ErrorGroup[]>([]);

/** 底部详情面板状态 */
export const detailSheet = reactive<{
  visible: boolean;
  group: ErrorGroup | null;
}>({ visible: false, group: null });

const MAX_TRACKED_GROUPS = 15;
const MAX_TRACKED_EVENT_IDS = 100;

/** 重试时向智能体发送的恢复指令文本 */
const RETRY_CONTENT = '继续';

class ErrorNotificationService {
  private initialized = false;
  private processedErrorIds = new Set<string>();
  private processedRetryIds = new Set<string>();
  private retryCountByGroup = new Map<string, { totalEvents: number; maxAttempt: number }>();

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    heartbeatService.onMessage('error_event', (msg) => {
      this.handleErrorEvent(msg.payload as RawErrorEvent, msg.messageId);
    });

    heartbeatService.onMessage('retry_event', (msg) => {
      this.handleRetryEvent(msg.payload as RawRetryEvent, msg.messageId);
    });

    console.log('[ErrorNotification] Service initialized (heartbeat)');
  }

  stop(): void {
    this.initialized = false;
  }

  /** 打开错误详情底部面板 */
  openDetail(group: ErrorGroup): void {
    detailSheet.group = group;
    detailSheet.visible = true;
  }

  /** 关闭错误详情底部面板 */
  closeDetail(): void {
    detailSheet.visible = false;
    detailSheet.group = null;
  }

  /** 移除单个错误分组（含详情面板中的），并通知服务器清除消息 */
  removeGroup(group: ErrorGroup): void {
    if (detailSheet.group?.key === group.key) {
      this.closeDetail();
    }
    const idx = errorGroups.findIndex(g => g.key === group.key);
    if (idx !== -1) {
      errorGroups.splice(idx, 1);
    }
    this.clearHeartbeatMessages(group.messageIds);
  }

  /** 清空所有错误分组 */
  clearAll(): void {
    const allIds = errorGroups.flatMap(g => g.messageIds);
    errorGroups.length = 0;
    this.processedErrorIds.clear();
    this.processedRetryIds.clear();
    this.retryCountByGroup.clear();
    this.clearHeartbeatMessages(allIds);
  }

  /**
   * 向该错误涉及的智能体发送"继续"消息，恢复其处理。
   * 与用户在对话框输入"继续"完全一致（POST /api/send），仅跳过用户输入环节。
   * 返回发送结果；skipped 表示缺少有效 agentId，未发起请求。
   */
  async retryGroup(group: ErrorGroup): Promise<{ ok: boolean; skipped: boolean }> {
    if (!group.agentId || group.agentId === 'unknown') {
      return { ok: false, skipped: true };
    }
    try {
      await apiService.sendMessage(group.agentId, RETRY_CONTENT);
      return { ok: true, skipped: false };
    } catch (error: any) {
      console.warn('[ErrorNotification] 重试失败：向智能体发送继续消息', {
        agentId: group.agentId,
        message: error?.message ?? String(error),
        stack: error?.stack
      });
      return { ok: false, skipped: false };
    }
  }

  private handleErrorEvent(rawError: RawErrorEvent, messageId: number): void {
    console.error('[ErrorNotification] 收到错误事件 (heartbeat)', {
      messageId,
      agentId: rawError.agentId,
      errorType: rawError.errorType,
      errorCategory: rawError.errorCategory,
      message: rawError.message,
      userMessage: rawError.userMessage,
      rootCause: rawError.rootCause,
      technicalInfo: rawError.technicalInfo,
      timestamp: rawError.timestamp
    });

    const category = resolveErrorCategory(rawError);
    const fullMessage = buildDisplayReason(rawError);
    const displayReason = toSingleLine(fullMessage);
    const groupKey = buildGroupKey(category, displayReason, rawError);
    const timestamp = rawError.timestamp || new Date().toISOString();
    const agentId = rawError.agentId || 'unknown';
    const agentName = rawError.agentContext?.agentName || agentId;
    const userMessage = rawError.userMessage || rawError.message || fullMessage;
    const ti = rawError.technicalInfo as RawTechnicalInfo | undefined;

    const errorName = ti?.errorName || rawError.errorType || 'UnknownError';
    const technicalDetails: ErrorTechnicalDetails = {
      status: ti?.technicalDetails?.status,
      code: ti?.technicalDetails?.code,
      type: ti?.technicalDetails?.type,
      stack: ti?.technicalDetails?.stack
    };

    const eventId = `${agentId}|${timestamp}|${rawError.errorType || ''}|${groupKey}`;
    if (this.processedErrorIds.has(eventId)) return;
    this.processedErrorIds.add(eventId);
    this.trimSet(this.processedErrorIds, MAX_TRACKED_EVENT_IDS);

    const existingGroup = errorGroups.find(g => g.key === groupKey);

    if (existingGroup) {
      existingGroup.count += 1;
      existingGroup.lastTimestamp = timestamp;
      existingGroup.latestUserMessage = userMessage;
      existingGroup.displayReason = displayReason;
      existingGroup.fullMessage = fullMessage;
      existingGroup.errorName = errorName;
      existingGroup.agentId = agentId;
      existingGroup.agentName = agentName;
      existingGroup.technicalDetails = technicalDetails;
      if (messageId > 0 && !existingGroup.messageIds.includes(messageId)) {
        existingGroup.messageIds.push(messageId);
      }
    } else {
      errorGroups.unshift({
        key: groupKey,
        displayReason,
        fullMessage,
        errorCategory: category,
        errorName,
        count: 1,
        lastTimestamp: timestamp,
        latestUserMessage: userMessage,
        agentId,
        agentName,
        messageIds: messageId > 0 ? [messageId] : [],
        technicalDetails
      });
      if (errorGroups.length > MAX_TRACKED_GROUPS) {
        errorGroups.length = MAX_TRACKED_GROUPS;
      }
    }

    // 按最近时间排序
    errorGroups.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  }

  private handleRetryEvent(retry: RawRetryEvent, messageId: number): void {
    const retryId = `${retry.agentId}|${retry.timestamp}|${retry.attempt}|${retry.errorMessage}`;
    if (this.processedRetryIds.has(retryId)) return;
    this.processedRetryIds.add(retryId);
    this.trimSet(this.processedRetryIds, MAX_TRACKED_EVENT_IDS);

    // 通过错误消息原文推断分组键
    const category = resolveErrorCategory({ message: retry.errorMessage });
    const displayReason = stripRetryWrapper(retry.errorMessage);
    const groupKey = [category, normalizeWhitespace(displayReason)].filter(Boolean).join('|');

    const current = this.retryCountByGroup.get(groupKey);
    this.retryCountByGroup.set(groupKey, {
      totalEvents: (current?.totalEvents ?? 0) + 1,
      maxAttempt: Math.max(current?.maxAttempt ?? 0, retry.attempt)
    });

    const existingGroup = errorGroups.find(g => g.key === groupKey);
    if (existingGroup && messageId > 0 && !existingGroup.messageIds.includes(messageId)) {
      existingGroup.messageIds.push(messageId);
    }
  }

  private async clearHeartbeatMessages(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    fetch('/api/heartbeat/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds })
    }).catch(err => {
      console.warn('[ErrorNotification] 清除心跳消息失败:', err);
    });
  }

  private trimSet(set: Set<string>, max: number): void {
    while (set.size > max) {
      const first = set.values().next().value;
      if (!first) return;
      set.delete(first);
    }
  }
}

export const errorNotificationService = new ErrorNotificationService();
