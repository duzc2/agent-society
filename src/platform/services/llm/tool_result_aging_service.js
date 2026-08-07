/**
 * ToolResultCompressionService — 工具结果截断处理器
 *
 * 在 Snip 之后、Truncation 之前运行，将过长的工具结果截断到
 * maxChars 以内，保留前缀内容。不做数量限制，交由 Stage 3
 * 按 token 预算自然裁剪。
 *
 * 目的：旧工具结果内容通常冗长（如文件全文、搜索结果），
 * 但完整保留对 LLM 的上下文理解有帮助。截断前缀让 LLM 仍能
 * 看到内容开头，同时控制单个消息的 token 规模。
 */
export class ToolResultCompressionService {
  /**
   * @param {{maxChars?: number}} [options]
   */
  constructor(options = {}) {
    this.maxChars = options.maxChars ?? 8192;
  }

  /**
   * 将过长的工具结果截断到前 maxChars 个字符。
   * @param {any[]} messages - 消息数组（不会被修改）
   * @returns {{messages: any[], stats: {compressedCount: number}}}
   */
  compress(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, stats: { compressedCount: 0 } };
    }

    let compressedCount = 0;
    // 创建副本，不修改原数组
    const result = messages.slice();

    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      if (
        msg?.role === "tool" &&
        typeof msg.content === "string" &&
        msg.content.length > this.maxChars
      ) {
        compressedCount++;
        const remaining = msg.content.length - this.maxChars;
        const marker = `\n\n[已截断之后${remaining}字符，内容未显示]`;
        const keepChars = Math.max(0, this.maxChars - marker.length);
        const truncated = keepChars > 0
          ? msg.content.slice(0, keepChars) + marker
          : msg.content.slice(0, this.maxChars);
        result[i] = { ...msg, content: truncated };
      }
    }

    return { messages: result, stats: { compressedCount } };
  }
}
