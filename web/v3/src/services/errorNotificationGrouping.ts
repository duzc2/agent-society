/**
 * 错误分组键清洗工具。
 *
 * 职责：
 * - 去掉错误正文中的动态字段噪声
 * - 统一归一化数字、时间、UUID、请求标识等不稳定片段
 * - 为错误分组提供更稳定的文本键
 *
 * @author Agent Society
 */

/**
 * 统一压缩空白和标点分隔符。
 * @param text 原始文本
 * @returns 压缩后的文本
 */
function compactGroupingWhitespace(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[()[\]{}"'`]+/g, ' ')
    .replace(/[,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 将错误消息中的动态标识归一化，避免 requestId、时间、长度等字段破坏分组。
 * @param text 原始错误文本
 * @returns 适合参与分组的稳定文本
 */
export function normalizeGroupingReason(text: string): string {
  let normalized = compactGroupingWhitespace(text).toLowerCase();

  // 优先处理常见的 ID 标签，避免值本身进入分组键。
  normalized = normalized.replace(
    /\b(request|req|trace|span|session|conversation|message|task|call)[-_ ]?id\b\s*[:=]?\s*[a-z0-9._:/-]+/gi,
    '$1_id'
  );

  // ISO 时间、常见日期和时间格式统一占位。
  normalized = normalized
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi, '<time>')
    .replace(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '<time>');

  // UUID、长十六进制串、雪花 ID 等统一占位。
  normalized = normalized
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hexid>')
    .replace(/\b\d{12,}\b/g, '<longnum>');

  // 路径或参数里的长度、计数、额度等数值统一占位。
  normalized = normalized
    .replace(/\b\d+(?:\.\d+)?\s*(?:bytes?|kb|mb|gb|tokens?|ms|s|sec|seconds?|分钟|秒|字节|字符|长度)\b/gi, '<metric>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>');

  // 清理连续占位和多余连接符，确保分组键稳定且可预测。
  normalized = normalized
    .replace(/(?:<num>\s*){2,}/g, '<num> ')
    .replace(/(?:<metric>\s*){2,}/g, '<metric> ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}
