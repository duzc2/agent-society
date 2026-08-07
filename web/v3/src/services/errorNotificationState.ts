/**
 * 错误通知状态定义。
 *
 * 职责：
 * - 定义错误通知领域模型
 * - 提供全局响应式错误分组状态
 * - 统一描述前端可消费的错误事件结构
 *
 * @author Agent Society
 */

import { reactive } from 'vue';

/**
 * 错误严重程度类型。
 */
export type ErrorSeverity = 'error' | 'warn' | 'info';

/**
 * 错误分类类型。
 */
export type ErrorCategory = 'network' | 'auth' | 'rate_limit' | 'context_length' | 'server' | 'unknown';

/**
 * 错误事件 shape（原来自 api.ts，现内联定义）
 */
interface ErrorEventShape {
  agentId: string;
  errorType: string;
  errorCategory: ErrorCategory;
  timestamp: string;
  userMessage: string;
  technicalInfo: {
    detailedMessage: string;
    originalError: string;
    errorName: string;
    technicalDetails: {
      status?: number;
      code?: string;
      type?: string;
      stack?: string;
    };
    originalMessageId: string | null;
    taskId: string | null;
  };
  agentContext: {
    agentName: string;
    roleId: string | null;
  };
}

/**
 * 原始技术细节的宽松类型。
 */
type RawTechnicalDetails = {
  status?: number;
  code?: string;
  type?: string;
  stack?: string;
};

/**
 * 原始技术信息的宽松类型。
 */
type RawTechnicalInfo = Partial<ErrorEventShape['technicalInfo']> & {
  technicalDetails?: RawTechnicalDetails;
};

/**
 * 原始智能体上下文的宽松类型。
 */
type RawAgentContext = Partial<ErrorEventShape['agentContext']>;

/**
 * 后端错误事件的宽松结构。
 *
 * 说明：
 * - 当前前后端字段并不完全一致；
 * - 前端统一容忍不同结构，再转换成标准模型。
 */
export type RawErrorEvent = Partial<ErrorEventShape> & {
  agentId?: string;
  errorType?: string;
  errorCategory?: ErrorCategory | string;
  timestamp?: string;
  userMessage?: string;
  technicalInfo?: RawTechnicalInfo;
  agentContext?: RawAgentContext;
  message?: string;
  details?: unknown;
  rootCause?: string;
  groupKey?: string;
};

/**
 * 归一化后的技术信息。
 */
export interface ErrorTechnicalInfo {
  detailedMessage: string;
  originalError: string;
  errorName: string;
  technicalDetails: {
    status?: number;
    code?: string;
    type?: string;
    stack?: string;
  };
  originalMessageId: string | null;
  taskId: string | null;
}

/**
 * 归一化后的单条错误事件。
 */
export interface ErrorNotificationEntry {
  id: string;
  groupKey: string;
  agentId: string;
  agentName: string;
  roleId: string | null;
  errorType: string;
  errorCategory: ErrorCategory;
  severity: ErrorSeverity;
  timestamp: string;
  userMessage: string;
  displayReason: string;
  technicalInfo: ErrorTechnicalInfo;
  rawEvent: RawErrorEvent;
  heartbeatMessageId: number;
}

/**
 * 分组内的智能体聚合信息。
 */
export interface ErrorGroupAgent {
  agentId: string;
  agentName: string;
  occurrences: number;
  latestTimestamp: string;
}

/**
 * 与同类错误关联的重试统计。
 */
export interface ErrorRetrySummary {
  totalEvents: number;
  maxAttempt: number;
  maxRetries: number;
  latestTimestamp: string;
}

/**
 * 错误分组模型。
 */
export interface ErrorNotificationGroup {
  key: string;
  displayReason: string;
  errorCategory: ErrorCategory;
  severity: ErrorSeverity;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
  latestUserMessage: string;
  latestEntry: ErrorNotificationEntry;
  entries: ErrorNotificationEntry[];
  agents: ErrorGroupAgent[];
  retrySummary: ErrorRetrySummary | null;
  messageIds: number[];
}

// 响应式错误分组，供界面直接渲染
export const errorGroups = reactive<ErrorNotificationGroup[]>([]);
