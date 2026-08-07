/**
 * 错误通知归一化工具。
 *
 * 职责：
 * - 从宽松的后端错误事件中提取稳定字段
 * - 清洗重试包装文案，突出底层报错原因
 * - 提供错误分组和重试统计的纯函数
 *
 * @author Agent Society
 */

import { errorGroups } from './errorNotificationState';
import { normalizeGroupingReason } from './errorNotificationGrouping';
import type {
  ErrorCategory,
  ErrorNotificationEntry,
  ErrorNotificationGroup,
  ErrorRetrySummary,
  ErrorSeverity,
  ErrorTechnicalInfo,
  RawErrorEvent
} from './errorNotificationState';

/**
 * 判断值是否为非空字符串。
 * @param value 待判断值
 * @returns 是否为非空字符串
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 将未知值转为对象记录。
 * @param value 待转换值
 * @returns 对象记录或 null
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * 从候选值中选择第一个非空字符串。
 * @param values 候选值列表
 * @returns 第一个有效字符串，若不存在则返回空字符串
 */
function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return '';
}

/**
 * 统一规范空白符，避免换行和多空格影响分组。
 * @param text 原始文本
 * @returns 规范化后的文本
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 去掉重试包装文案，尽量提取最底层原因。
 * @param text 原始错误文本
 * @returns 更适合展示和分组的底层原因
 */
function stripRetryWrapper(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return '';
  }

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
    /具体原因[：:]\s*/iu,
    /底层原因[：:]\s*/iu,
    /caused by:\s*/i,
    /original error:\s*/i,
    /root cause:\s*/i
  ];

  for (const pattern of markerPatterns) {
    const match = stripped.match(pattern);
    if (match && typeof match.index === 'number') {
      stripped = stripped.slice(match.index + match[0].length).trim();
    }
  }

  const lines = stripped
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const preferredLine = lines.find(line => !/尝试\s*\d+\s*次|重试/u.test(line));
  return preferredLine ?? lines[0] ?? stripped;
}

/**
 * 将文本压缩成单行预览。
 * @param text 原始文本
 * @param maxLength 最大长度
 * @returns 单行预览文本
 */
export function toSingleLinePreview(text: string, maxLength = 160): string {
  const singleLine = normalizeWhitespace(text).replace(/\n+/g, ' / ');
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

/**
 * 从宽松 details 对象中提取字符串字段。
 * @param details 原始 details
 * @param keys 候选字段名
 * @returns 提取到的字符串
 */
function readStringFromDetails(details: unknown, keys: string[]): string {
  const record = asRecord(details);
  if (!record) {
    return '';
  }

  for (const key of keys) {
    const value = record[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return '';
}

/**
 * 从宽松 details 对象中提取数值字段。
 * @param details 原始 details
 * @param keys 候选字段名
 * @returns 提取到的数值
 */
function readNumberFromDetails(details: unknown, keys: string[]): number | undefined {
  const record = asRecord(details);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

/**
 * 把宽松错误事件归一化为统一技术信息。
 * @param raw 原始错误事件
 * @returns 统一技术信息
 */
export function buildTechnicalInfo(raw: RawErrorEvent): ErrorTechnicalInfo {
  const technicalInfo = (raw.technicalInfo ?? {}) as NonNullable<RawErrorEvent['technicalInfo']>;
  const rawDetails = technicalInfo.technicalDetails ?? {};
  const detailFromPayload = isNonEmptyString(raw.message)
    ? raw.message
    : readStringFromDetails(raw.details, ['message', 'originalError', 'detail']);

  const originalError = pickFirstString(
    raw.rootCause,
    technicalInfo.originalError,
    readStringFromDetails(raw.details, ['originalError', 'message', 'cause']),
    raw.message,
    raw.userMessage,
    raw.errorType,
    '未知错误'
  );

  const detailedMessage = pickFirstString(
    technicalInfo.detailedMessage,
    detailFromPayload,
    originalError
  );

  return {
    detailedMessage,
    originalError,
    errorName: pickFirstString(
      technicalInfo.errorName,
      readStringFromDetails(raw.details, ['errorName', 'name', 'type']),
      raw.errorType,
      'UnknownError'
    ),
    technicalDetails: {
      status: typeof rawDetails.status === 'number'
        ? rawDetails.status
        : readNumberFromDetails(raw.details, ['status', 'statusCode']),
      code: pickFirstString(rawDetails.code, readStringFromDetails(raw.details, ['code'])),
      type: pickFirstString(rawDetails.type, readStringFromDetails(raw.details, ['type'])),
      stack: pickFirstString(rawDetails.stack, readStringFromDetails(raw.details, ['stack']))
    },
    originalMessageId: isNonEmptyString(technicalInfo.originalMessageId)
      ? technicalInfo.originalMessageId
      : null,
    taskId: isNonEmptyString(technicalInfo.taskId)
      ? technicalInfo.taskId
      : null
  };
}

/**
 * 推断错误分类。
 * @param raw 原始错误事件
 * @param technicalInfo 归一化技术信息
 * @returns 错误分类
 */
export function resolveErrorCategory(raw: RawErrorEvent, technicalInfo: ErrorTechnicalInfo): ErrorCategory {
  const category = raw.errorCategory;
  if (
    category === 'network'
    || category === 'auth'
    || category === 'rate_limit'
    || category === 'context_length'
    || category === 'server'
    || category === 'unknown'
  ) {
    return category;
  }

  const combinedText = [
    technicalInfo.originalError,
    technicalInfo.detailedMessage,
    technicalInfo.errorName,
    technicalInfo.technicalDetails.code,
    technicalInfo.technicalDetails.type,
    technicalInfo.technicalDetails.status
  ]
    .filter(value => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase();

  if (/econnreset|econnrefused|enotfound|etimedout|socket|offline|fetch failed|failed to fetch|network|网络|连接|超时/u.test(combinedText)) {
    return 'network';
  }

  if (/401|403|unauthorized|forbidden|authentication|auth|api key|令牌|鉴权|认证/u.test(combinedText)) {
    return 'auth';
  }

  if (/429|rate limit|too many requests|quota|频率限制|请求过多/u.test(combinedText)) {
    return 'rate_limit';
  }

  if (/context length|maximum context|token limit|prompt too long|上下文|token 超限/u.test(combinedText)) {
    return 'context_length';
  }

  if (/5\d\d|server|internal_error|internal server error|服务器/u.test(combinedText)) {
    return 'server';
  }

  return 'unknown';
}

/**
 * 构建稳定的分组键，确保同类错误进入同一组。
 * @param category 错误分类
 * @param displayReason 展示用底层原因
 * @param technicalInfo 技术信息
 * @returns 分组键
 */
export function buildGroupKey(
  category: ErrorCategory,
  displayReason: string,
  technicalInfo: ErrorTechnicalInfo
): string {
  const normalizedReason = normalizeGroupingReason(displayReason);
  const code = technicalInfo.technicalDetails.code?.toLowerCase().trim() ?? '';
  const status = technicalInfo.technicalDetails.status ? String(technicalInfo.technicalDetails.status) : '';
  const type = technicalInfo.technicalDetails.type?.toLowerCase().trim() ?? '';

  return [category, code, status, type, normalizedReason]
    .filter(Boolean)
    .join('|');
}

/**
 * 将原始错误事件归一化为界面可直接消费的结构。
 * @param raw 原始错误事件
 * @param severity 错误严重程度
 * @returns 归一化后的单条错误事件
 */
export function normalizeErrorEvent(raw: RawErrorEvent, severity: ErrorSeverity, heartbeatMessageId?: number): ErrorNotificationEntry {
  const technicalInfo = buildTechnicalInfo(raw);
  const errorCategory = resolveErrorCategory(raw, technicalInfo);
  const displayReason = pickFirstString(
    stripRetryWrapper(raw.rootCause ?? ''),
    stripRetryWrapper(technicalInfo.originalError),
    stripRetryWrapper(technicalInfo.detailedMessage),
    stripRetryWrapper(raw.message ?? ''),
    stripRetryWrapper(raw.userMessage ?? ''),
    raw.errorType,
    '未知错误'
  );

  const userMessage = pickFirstString(
    raw.userMessage,
    raw.message,
    technicalInfo.detailedMessage,
    displayReason
  );

  const groupKey = isNonEmptyString(raw.groupKey)
    ? raw.groupKey.trim()
    : buildGroupKey(errorCategory, displayReason, technicalInfo);
  const timestamp = pickFirstString(raw.timestamp, new Date().toISOString());
  const agentId = pickFirstString(raw.agentId, 'unknown');
  const agentName = pickFirstString(raw.agentContext?.agentName, agentId);
  const roleId = pickFirstString(raw.agentContext?.roleId, '') || null;
  const errorType = pickFirstString(raw.errorType, technicalInfo.errorName, 'unknown');

  return {
    id: `${agentId}|${timestamp}|${errorType}|${groupKey}`,
    groupKey,
    agentId,
    agentName,
    roleId,
    errorType,
    errorCategory,
    severity,
    timestamp,
    userMessage,
    displayReason,
    technicalInfo,
    rawEvent: raw,
    heartbeatMessageId: heartbeatMessageId ?? 0
  };
}

/**
 * 构建新的错误分组对象。
 * @param entry 当前错误条目
 * @param retrySummary 关联的重试摘要
 * @returns 新的错误分组对象
 */
export function createErrorGroup(
  entry: ErrorNotificationEntry,
  retrySummary: ErrorRetrySummary | null
): ErrorNotificationGroup {
  const messageIds = entry.heartbeatMessageId > 0 ? [entry.heartbeatMessageId] : [];
  return {
    key: entry.groupKey,
    displayReason: entry.displayReason,
    errorCategory: entry.errorCategory,
    severity: entry.severity,
    count: 1,
    firstTimestamp: entry.timestamp,
    lastTimestamp: entry.timestamp,
    latestUserMessage: entry.userMessage,
    latestEntry: entry,
    entries: [entry],
    agents: [
      {
        agentId: entry.agentId,
        agentName: entry.agentName,
        occurrences: 1,
        latestTimestamp: entry.timestamp
      }
    ],
    retrySummary,
    messageIds
  };
}

/**
 * 更新分组内的智能体统计。
 * @param group 错误分组
 * @param entry 新错误条目
 */
function updateGroupAgent(group: ErrorNotificationGroup, entry: ErrorNotificationEntry): void {
  const existingAgent = group.agents.find(agent => agent.agentId === entry.agentId);
  if (existingAgent) {
    existingAgent.occurrences += 1;
    existingAgent.latestTimestamp = entry.timestamp;
    existingAgent.agentName = entry.agentName;
  } else {
    group.agents.push({
      agentId: entry.agentId,
      agentName: entry.agentName,
      occurrences: 1,
      latestTimestamp: entry.timestamp
    });
  }

  group.agents.sort((left, right) => {
    if (left.occurrences !== right.occurrences) {
      return right.occurrences - left.occurrences;
    }
    return right.latestTimestamp.localeCompare(left.latestTimestamp);
  });
}

/**
 * 把一条错误合并到已有分组中。
 * @param group 目标分组
 * @param entry 新错误条目
 * @param retrySummary 关联的重试摘要
 * @param maxEntries 分组内保留的最大条目数
 */
export function mergeErrorIntoGroup(
  group: ErrorNotificationGroup,
  entry: ErrorNotificationEntry,
  retrySummary: ErrorRetrySummary | null,
  maxEntries: number
): void {
  group.count += 1;
  group.lastTimestamp = entry.timestamp;
  group.latestEntry = entry;
  group.latestUserMessage = entry.userMessage;
  group.displayReason = entry.displayReason;
  group.errorCategory = entry.errorCategory;
  group.severity = entry.severity;
  group.retrySummary = retrySummary;

  if (entry.heartbeatMessageId > 0 && !group.messageIds.includes(entry.heartbeatMessageId)) {
    group.messageIds.push(entry.heartbeatMessageId);
  }

  group.entries.unshift(entry);
  if (group.entries.length > maxEntries) {
    group.entries.length = maxEntries;
  }

  updateGroupAgent(group, entry);
}

/**
 * 为分组同步最新的重试摘要。
 * @param group 错误分组
 * @param retrySummary 关联的重试摘要
 */
export function applyRetrySummary(
  group: ErrorNotificationGroup,
  retrySummary: ErrorRetrySummary | null
): void {
  group.retrySummary = retrySummary;
}

/**
 * 限制集合大小，防止缓存无限增长。
 * @param set 目标集合
 * @param maxSize 最大容量
 */
export function trimSet(set: Set<string>, maxSize: number): void {
  while (set.size > maxSize) {
    const first = set.values().next().value;
    if (!first) {
      return;
    }
    set.delete(first);
  }
}

/**
 * 按最近时间对错误分组重新排序。
 */
export function sortErrorGroups(): void {
  errorGroups.sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}
