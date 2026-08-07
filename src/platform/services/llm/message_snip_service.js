/**
 * MessageSnipService — 零成本消息预处理过滤器
 *
 * 在 Truncation 之前运行，移除显然无用的消息内容，
 * 不依赖 LLM 调用，不会增加额外成本。
 *
 * 过滤规则：
 * 1. 空结果工具调用：tool 消息内容为 ""、{}、[] 等空值
 * 2. 被拒绝操作：assistant 消息明确拒绝执行，或 tool 返回拒绝状态
 * 3. 截断产生的孤儿消息：tool 消息缺少对应的 assistant tool_calls 记录
 */
export class MessageSnipService {
  constructor() {}

  /**
   * 过滤消息列表，返回清理后的结果和统计信息。
   * @param {any[]} messages - 原始消息数组（不会被修改）
   * @returns {{messages: any[], stats: {emptyToolResults: number, rejectedOps: number, orphansRemoved: number}}}
   */
  filter(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, stats: { emptyToolResults: 0, rejectedOps: 0, orphansRemoved: 0 } };
    }

    // 收集所有 assistant 消息中声明的 tool_call_id
    const declaredToolCallIds = new Set();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) declaredToolCallIds.add(tc.id);
        }
      }
    }

    let emptyToolResults = 0;
    let rejectedOps = 0;
    let orphansRemoved = 0;

    const filtered = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 规则 1：空结果工具调用
      if (msg.role === "tool" && this._isEmptyToolResult(msg.content)) {
        emptyToolResults++;
        continue;
      }

      // 规则 2：被拒绝操作
      if (this._isRejectedOperation(msg)) {
        rejectedOps++;
        continue;
      }

      // 规则 3：截断产生的孤儿 tool 消息
      // tool 消息的 tool_call_id 在所有 assistant 的 tool_calls 中都找不到
      if (msg.role === "tool"
        && msg.tool_call_id
        && !declaredToolCallIds.has(msg.tool_call_id)) {
        orphansRemoved++;
        continue;
      }

      filtered.push(msg);
    }

    return {
      messages: filtered,
      stats: { emptyToolResults, rejectedOps, orphansRemoved }
    };
  }

  /**
   * 判断 tool 消息结果是否为空/无信息量。
   * @param {any} content - tool 消息的 content 字段
   * @returns {boolean}
   * @private
   */
  _isEmptyToolResult(content) {
    if (content === null || content === undefined || content === "") return true;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed === "" || trimmed === "{}" || trimmed === "[]") return true;
    }
    return false;
  }

  /**
   * 判断消息是否表示操作被拒绝。
   * @param {any} msg - 消息对象
   * @returns {boolean}
   * @private
   */
  _isRejectedOperation(msg) {
    // assistant 消息：短回复且以拒绝性语言开头
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const text = msg.content.trim();
      // 短拒绝回复（无 tool_calls 且内容很短的拒绝）
      if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
        if (text.length < 30 && (
          text.startsWith("拒绝") ||
          text.startsWith("无法") && !text.includes("无法完成") ||
          text === "rejected" ||
          text === "denied"
        )) {
          return true;
        }
      }
    }

    // tool 消息：结果中明确表示被拒绝
    if (msg.role === "tool" && typeof msg.content === "string") {
      const content = msg.content;
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (parsed.rejected === true || parsed.denied === true) return true;
          if (parsed.error && typeof parsed.error === "string"
            && /denied|refused|forbidden|unauthorized/i.test(parsed.error)) {
            return true;
          }
        }
      } catch {
        // 非 JSON 内容，不处理
      }
    }

    return false;
  }
}
