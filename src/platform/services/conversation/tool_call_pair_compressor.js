/**
 * 工具调用对压缩器
 *
 * 将早期对话轮次中的工具调用结果替换为紧凑摘要，减少上下文占用。
 * 不调用 LLM，纯启发式处理，零成本。
 *
 * 策略：保留最后 N 轮不动，之前的轮次中所有 tool 消息的结果被截断为摘要。
 * 不修改入参，返回新数组。
 */

export class ToolCallPairCompressor {
  /**
   * 压缩消息数组中的旧工具调用结果。
   *
   * @param {Array} messages - 原始消息数组
   * @param {{keepRounds?: number, maxToolResultChars?: number}} options
   * @returns {{messages: Array, stats: {roundsTotal: number, roundsCompressed: number, pairsCompressed: number, estimatedTokensAfter: number}}}
   */
  compress(messages, { keepRounds = 10, maxToolResultChars = 200 } = {}) {
    const rounds = this._identifyRounds(messages);

    // 少于等于 keepRounds 轮，不压缩
    if (rounds.length <= keepRounds) {
      return {
        messages: [...messages],
        stats: {
          roundsTotal: rounds.length,
          roundsCompressed: 0,
          pairsCompressed: 0,
          estimatedTokensAfter: this._estimateTokensFromMessages(messages)
        }
      };
    }

    const roundsToCompress = rounds.slice(0, -keepRounds);
    const protectedRounds = rounds.slice(-keepRounds);

    let pairsCompressed = 0;
    let roundsCompressed = 0;

    const compressedSegments = roundsToCompress.map(round => {
      let changed = false;
      const newMsgs = round.messages.map(msg => {
        if (msg.role !== 'tool') return msg;
        if (!msg.tool_call_id) return msg;
        const content = this._summarizeToolResult(msg.content, msg.name, maxToolResultChars);
        if (content === msg.content) return msg;
        changed = true;
        pairsCompressed++;
        return { ...msg, content };
      });
      if (changed) roundsCompressed++;
      return newMsgs;
    });

    const result = [...compressedSegments.flat(), ...protectedRounds.flatMap(r => r.messages)];
    const estimatedTokensAfter = this._estimateTokensFromMessages(result);

    return {
      messages: result,
      stats: {
        roundsTotal: rounds.length,
        roundsCompressed,
        pairsCompressed,
        estimatedTokensAfter
      }
    };
  }

  /**
   * 以 user 消息为边界将消息分组为对话轮次。
   * 每个 round 包含一条 user 消息及紧跟其后的 assistant/tool 消息。
   *
   * @param {Array} messages
   * @returns {Array<{startIdx: number, endIdx: number, messages: Array}>}
   * @private
   */
  _identifyRounds(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    const rounds = [];
    let start = 0;

    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'user' && i > start) {
        rounds.push({
          startIdx: start,
          endIdx: i - 1,
          messages: messages.slice(start, i)
        });
        start = i;
      }
    }

    // 最后一个 round
    if (start < messages.length) {
      rounds.push({
        startIdx: start,
        endIdx: messages.length - 1,
        messages: messages.slice(start)
      });
    }

    return rounds;
  }

  /**
   * 将工具结果内容压缩为简短摘要。
   *
   * @param {string|*} content - 原始内容
   * @param {string} toolName - 工具名称
   * @param {number} maxChars - 最大保留字符数
   * @returns {string}
   * @private
   */
  _summarizeToolResult(content, toolName, maxChars) {
    const raw = typeof content === 'string' ? content : String(content ?? '');
    if (raw.length <= maxChars) return raw;

    let prefix = raw.slice(0, maxChars);

    // 尝试提取 JSON error 信息
    let errorSummary = '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.error && typeof parsed.error === 'string') {
        errorSummary = ` → 错误: ${parsed.error}`;
      } else if (parsed?.message && typeof parsed.message === 'string') {
        errorSummary = ` → ${parsed.message}`;
      }
    } catch {
      // 非 JSON 内容，不追加 errorSummary
    }

    const toolLabel = toolName ? `[工具结果: ${toolName}` : '[工具结果';
    return `${toolLabel}${errorSummary} → ${prefix}...]`;
  }

  /**
   * 估算消息数组的 token 数量。
   * 与 AutoCompressionManager 保持一致的简单启发式。
   *
   * @param {Array} messages
   * @returns {number}
   * @private
   */
  _estimateTokensFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 0;
    }

    let totalChars = 0;
    let overhead = 0;

    for (const m of messages) {
      if (m?.content && typeof m.content === 'string') {
        totalChars += m.content.length;
      }
      overhead += 20;
    }

    return Math.ceil(totalChars / 4) + overhead;
  }
}
