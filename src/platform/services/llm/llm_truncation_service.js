/**
 * LLM 截断服务。
 *
 * 提供消息 token 估算和上下文窗口截断能力。
 * 此服务是无状态的，不持有任何实例状态。
 */
export class LlmTruncationService {
  constructor() {}

  /**
   * 估算单条消息的 token 数。
   * @param {any} msg
   * @returns {number}
   */
  estimateMessageTokens(msg) {
    if (!msg) return 0;

    let contentTokens = 0;
    if (msg.content) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherChars = content.length - chineseChars;
      contentTokens = Math.ceil(chineseChars + otherChars / 4);
    }

    let toolCallsTokens = 0;
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const tcStr = JSON.stringify(tc);
        const tcChineseChars = (tcStr.match(/[\u4e00-\u9fff]/g) || []).length;
        const tcOtherChars = tcStr.length - tcChineseChars;
        toolCallsTokens += Math.ceil(tcChineseChars + tcOtherChars / 4);
      }
    }

    let toolMetaTokens = 0;
    if (msg.tool_call_id) {
      toolMetaTokens += Math.ceil(msg.tool_call_id.length / 4);
    }
    if (msg.name) {
      toolMetaTokens += Math.ceil(msg.name.length / 4);
    }

    return contentTokens + toolCallsTokens + toolMetaTokens + 20;
  }

  /**
   * 估算工具定义列表的 token 数。
   * @param {any[]} tools
   * @returns {number}
   */
  estimateToolsTokens(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
      return 0;
    }

    const toolsStr = JSON.stringify(tools);
    const chineseChars = (toolsStr.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = toolsStr.length - chineseChars;
    return Math.ceil(chineseChars + otherChars / 4);
  }

  /**
   * 估算消息列表的 token 数。
   * @param {any[]} messages
   * @returns {number}
   */
  estimateMessagesTokens(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 0;
    }

    let total = 0;
    for (const message of messages) {
      total += this.estimateMessageTokens(message);
    }
    return total;
  }

  /**
   * 对消息列表进行上下文窗口截断。
   *
   * 核心策略：
   * 1. 从最早记录开始裁剪。
   * 2. user / 普通消息整条删除。
   * 3. assistant 含 tool_calls 时，只删除该 assistant 中最早的 tool_call + tool 结果对。
   * 4. 当一条 assistant 的所有工具调用都删完后，再删除 assistant 自身。
   * 5. 若只剩最后一条记录，则保留它，避免请求消息为空。
   *
   * @param {any[]} messages - 原始消息列表
   * @param {number} maxTokens - 最大 token 预算
   * @returns {{ messages: any[], stats: object }}
   */
  truncateMessagesForContextWindow(messages, maxTokens) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, stats: { originalCount: 0, truncatedCount: 0, systemCount: 0, droppedCount: 0 } };
    }

    // system 不再混入 messages 数组，所有消息都是非 system 的对话转录
    const systemTokens = 0;
    const availableTokensForNonSystem = Math.max(0, Math.floor(maxTokens * 0.9));

    const nonSystemMessages = messages;
    const originalRecords = this._buildTruncationRecords(nonSystemMessages);
    let keptRecords = [...originalRecords];
    let droppedRecordCount = 0;
    let droppedToolPairCount = 0;
    let forcedKeepLatestRecord = false;

    let usedTokens = keptRecords.reduce(
      (total, record) => total + this._estimateTruncationRecordTokens(record),
      0
    );

    while (keptRecords.length > 0 && usedTokens > availableTokensForNonSystem) {
      const earliestRecord = keptRecords[0];
      const canPartiallyTrimAssistant = earliestRecord?.type === "assistant_tool_record"
        && Array.isArray(earliestRecord.toolEntries)
        && earliestRecord.toolEntries.length > 1;

      if (keptRecords.length === 1 && !canPartiallyTrimAssistant) {
        forcedKeepLatestRecord = true;
        break;
      }

      const beforeTokens = this._estimateTruncationRecordTokens(earliestRecord);
      const trimmedRecord = this._dropEarliestContentFromRecord(earliestRecord);

      if (trimmedRecord) {
        const afterTokens = this._estimateTruncationRecordTokens(trimmedRecord);
        droppedToolPairCount += 1;

        if (Array.isArray(trimmedRecord.toolEntries) && trimmedRecord.toolEntries.length === 0) {
          keptRecords.shift();
          usedTokens -= beforeTokens;
          droppedRecordCount += 1;
          continue;
        }

        keptRecords[0] = trimmedRecord;
        usedTokens -= Math.max(0, beforeTokens - afterTokens);
        continue;
      }

      keptRecords.shift();
      usedTokens -= beforeTokens;
      droppedRecordCount += 1;
    }

    // 如果最前面出现孤立 tool，说明它已经失去前置 assistant，继续按最早记录删除。
    while (keptRecords.length > 0 && keptRecords[0]?.type === "orphan_tool_record") {
      const recordTokens = this._estimateTruncationRecordTokens(keptRecords[0]);
      keptRecords.shift();
      usedTokens -= recordTokens;
      droppedRecordCount += 1;
    }

    // 记录经过 token 裁剪后仍可恢复的候选项。
    // 后续如果"首条必须为 user"的约束把记录继续删空，就从这里挑选兜底记录。
    const recoverableRecords = [...keptRecords];

    // 某些模型模板要求消息列表首条必须是 user。
    // 截断后如果最前面的记录变成 assistant / tool，需要继续删除，
    // 直到首条消息为 user，避免构造出非法的对话前缀。
    while (keptRecords.length > 0) {
      const leadingRole = this._getTruncationRecordLeadingRole(keptRecords[0]);
      if (leadingRole === "user") {
        break;
      }
      const recordTokens = this._estimateTruncationRecordTokens(keptRecords[0]);
      keptRecords.shift();
      usedTokens -= recordTokens;
      droppedRecordCount += 1;
    }

    let recoveredFallbackRecord = false;
    let recoveredFallbackRole = null;
    if (keptRecords.length === 0 && originalRecords.length > 0) {
      const fallbackRecord = this._selectFallbackTruncationRecord(originalRecords, recoverableRecords);
      if (fallbackRecord) {
        keptRecords = [fallbackRecord];
        usedTokens = this._estimateTruncationRecordTokens(fallbackRecord);
        forcedKeepLatestRecord = true;
        recoveredFallbackRecord = true;
        recoveredFallbackRole = this._getTruncationRecordLeadingRole(fallbackRecord);
      }
    }

    const keptMessages = keptRecords.flatMap((record) => this._materializeTruncationRecord(record));

    const result = keptMessages;
    const stats = {
      originalCount: messages.length,
      truncatedCount: result.length,
      systemCount: 0,
      keptNonSystem: keptMessages.length,
      droppedCount: messages.length - result.length,
      estimatedSystemTokens: 0,
      estimatedNonSystemTokens: usedTokens,
      maxTokensBudget: maxTokens,
      truncationRecordCount: originalRecords.length,
      keptRecordCount: keptRecords.length,
      droppedRecordCount,
      droppedToolPairCount,
      forcedKeepLatestRecord,
      recoveredFallbackRecord,
      recoveredFallbackRole
    };

    return { messages: result, stats };
  }

  // ─── 私有截断辅助方法 ────────────────────────────────────

  _cloneToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== "object") {
      return toolCall;
    }

    return {
      ...toolCall,
      function: toolCall.function && typeof toolCall.function === "object"
        ? { ...toolCall.function }
        : toolCall.function
    };
  }

  _cloneMessage(message) {
    if (!message || typeof message !== "object") {
      return message;
    }

    const cloned = { ...message };
    if (Array.isArray(message.tool_calls)) {
      cloned.tool_calls = message.tool_calls.map((toolCall) => this._cloneToolCall(toolCall));
    }
    return cloned;
  }

  _buildTruncationRecords(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    const records = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

      if (message?.role === "assistant" && toolCalls.length > 0) {
        const consecutiveTools = [];
        let j = i + 1;
        while (j < messages.length && messages[j]?.role === "tool") {
          consecutiveTools.push({
            message: this._cloneMessage(messages[j]),
            originalIndex: j
          });
          j += 1;
        }

        const toolMessageQueues = new Map();
        for (const toolInfo of consecutiveTools) {
          const toolCallId = toolInfo.message?.tool_call_id;
          if (!toolMessageQueues.has(toolCallId)) {
            toolMessageQueues.set(toolCallId, []);
          }
          toolMessageQueues.get(toolCallId).push(toolInfo);
        }

        const matchedToolIndexes = new Set();
        const toolEntries = toolCalls.map((toolCall, toolCallOrder) => {
          const clonedToolCall = this._cloneToolCall(toolCall);
          const toolCallId = clonedToolCall?.id;
          const queue = toolMessageQueues.get(toolCallId) ?? [];
          const matchedTool = queue.length > 0 ? queue.shift() : null;
          if (matchedTool) {
            matchedToolIndexes.add(matchedTool.originalIndex);
          }
          return {
            toolCall: clonedToolCall,
            toolCallOrder,
            toolMessage: matchedTool?.message ?? null,
            toolMessageOrder: matchedTool?.originalIndex ?? null
          };
        });

        const assistantMessage = this._cloneMessage(message);
        delete assistantMessage.tool_calls;

        records.push({
          type: "assistant_tool_record",
          assistantMessage,
          toolEntries
        });

        for (const toolInfo of consecutiveTools) {
          if (matchedToolIndexes.has(toolInfo.originalIndex)) {
            continue;
          }
          records.push({
            type: "orphan_tool_record",
            message: toolInfo.message
          });
        }

        i = j - 1;
        continue;
      }

      records.push({
        type: message?.role === "tool" ? "orphan_tool_record" : "message_record",
        message: this._cloneMessage(message)
      });
    }

    return records;
  }

  _materializeTruncationRecord(record) {
    if (!record || typeof record !== "object") {
      return [];
    }

    if (record.type === "assistant_tool_record") {
      const toolEntries = Array.isArray(record.toolEntries) ? record.toolEntries : [];
      if (toolEntries.length === 0) {
        return [];
      }

      // 只保留有对应 tool 结果的 tool_call，确保 tool_call 与 tool_result 严格配对。
      const validEntries = toolEntries.filter((entry) => entry?.toolMessage);
      if (validEntries.length === 0) {
        return [];
      }

      // 按 toolMessageOrder 排序，保证 tool 结果的顺序与原始顺序一致
      validEntries.sort(
        (left, right) => (left.toolMessageOrder ?? 0) - (right.toolMessageOrder ?? 0)
      );

      const assistantMessage = {
        ...record.assistantMessage,
        tool_calls: validEntries.map((entry) => this._cloneToolCall(entry.toolCall))
      };

      const toolMessages = validEntries.map((entry) =>
        this._cloneMessage(entry.toolMessage)
      );

      return [assistantMessage, ...toolMessages];
    }

    if (record.message) {
      return [this._cloneMessage(record.message)];
    }

    return [];
  }

  _estimateTruncationRecordTokens(record) {
    const materializedMessages = this._materializeTruncationRecord(record);
    return this.estimateMessagesTokens(materializedMessages);
  }

  _dropEarliestContentFromRecord(record) {
    if (!record || typeof record !== "object") {
      return null;
    }

    if (record.type !== "assistant_tool_record") {
      return null;
    }

    const toolEntries = Array.isArray(record.toolEntries) ? [...record.toolEntries] : [];
    if (toolEntries.length === 0) {
      return null;
    }

    toolEntries.shift();
    return {
      ...record,
      toolEntries
    };
  }

  _getTruncationRecordLeadingRole(record) {
    const materializedMessages = this._materializeTruncationRecord(record);
    if (!Array.isArray(materializedMessages) || materializedMessages.length === 0) {
      return null;
    }
    return typeof materializedMessages[0]?.role === "string"
      ? materializedMessages[0].role
      : null;
  }

  _selectFallbackTruncationRecord(originalRecords, recoverableRecords) {
    const originalRecordList = Array.isArray(originalRecords) ? originalRecords : [];
    const recoverableRecordList = Array.isArray(recoverableRecords) ? recoverableRecords : [];

    const findLatestUserRecord = (records) => {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (this._getTruncationRecordLeadingRole(record) === "user") {
          return record;
        }
      }
      return null;
    };

    const latestUserRecord = findLatestUserRecord(originalRecordList);
    if (latestUserRecord) {
      return latestUserRecord;
    }

    if (recoverableRecordList.length > 0) {
      return recoverableRecordList[recoverableRecordList.length - 1];
    }

    if (originalRecordList.length > 0) {
      return originalRecordList[originalRecordList.length - 1];
    }

    return null;
  }
}
