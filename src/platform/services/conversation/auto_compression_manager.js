/**
 * 自动压缩管理器
 *
 * 负责智能体历史消息的自动压缩逻辑。
 * 当上下文使用率达到阈值时，自动触发压缩流程，
 * 通过默认 LLM 请求生成结构化摘要，直接修改消息数组实现压缩。
 *
 * 零配置：功能始终启用，使用默认 LLM，无需独立配置项。
 */

/**
 * 自动压缩管理器类
 *
 * 作为 ConversationManager 的子模块，负责所有与自动压缩相关的逻辑。
 * 接收会话消息数组的引用，自己判断、处理、直接修改数据。
 */
export class AutoCompressionManager {
  // ---- 内部常量 ----
  static THRESHOLD = 0.5;           // token 使用率触发阈值
  static KEEP_RATIO = 0.4;          // 压缩后至少保留的 token 比例
  static MIN_KEEP = 2;              // 压缩后最少保留消息数（防止比例计算过少）
  static SUMMARY_MAX_TOKENS = 8192; // 摘要输出 token 上限（足够输出 5 字段完整摘要）
  static MAX_FAILURES = 3;          // 连续失败熔断上限
  /**
   * @param {Object} llmClient - LLM 客户端引用，用于生成压缩摘要
   * @param {Object} logger - 日志记录器
   * @param {Object} compressor - 工具调用对压缩器实例
   */
  constructor(llmClient, logger, compressor) {
    this._llmClient = llmClient;
    this._logger = logger;
    this._compressor = compressor;
    this._failureCount = 0;  // 熔断计数器
  }

  /**
   * 处理会话的自动压缩
   *
   * 接收会话消息数组引用，自己判断是否需要压缩，需要则直接修改消息数组。
   * 不返回任何值，失败时不修改数据，只打印日志。
   *
   * @param {Array} messages - 会话消息数组（引用传递）
   * @param {number} [maxContextTokens=128000] - 上下文窗口大小（由调用方根据模型动态传入）
   * @returns {Promise<void>}
   */
  async process(messages, maxContextTokens = 128000) {
    try {
      if (!Array.isArray(messages)) {
        this._logger.debug('AutoCompressionManager.process: 无效的消息数组', {
          messagesType: typeof messages
        });
        return;
      }

      // 熔断检查
      if (this._failureCount >= AutoCompressionManager.MAX_FAILURES) {
        this._logger.warn('AutoCompressionManager.process: 自动压缩已熔断', {
          failureCount: this._failureCount,
          maxFailures: AutoCompressionManager.MAX_FAILURES
        });
        return;
      }

      // 消息数量检查：至少 2 条才能压缩（1 保留 + 1 压缩）
      if (messages.length < AutoCompressionManager.MIN_KEEP + 1) {
        return;
      }

      // 计算 token 使用率
      const usage = this._calculateTokenUsage(messages, maxContextTokens);

      this._logger.debug('AutoCompressionManager.process: 计算 token 使用情况', {
        totalTokens: usage.totalTokens,
        usagePercent: (usage.usagePercent * 100).toFixed(1) + '%',
        threshold: (AutoCompressionManager.THRESHOLD * 100).toFixed(1) + '%',
        messageCount: messages.length
      });

      // 阈值检查
      if (usage.usagePercent < AutoCompressionManager.THRESHOLD) {
        return;
      }

      this._logger.info('AutoCompressionManager.process: 触发自动压缩', {
        totalTokens: usage.totalTokens,
        usagePercent: (usage.usagePercent * 100).toFixed(1) + '%',
        messageCount: messages.length,
        threshold: (AutoCompressionManager.THRESHOLD * 100).toFixed(1) + '%'
      });

      // 记录压缩前的状态
      const beforeCount = messages.length;

      // ═══ Stage 1: 工具调用对压缩（最高优先级） ═══
      if (this._compressor) {
        const stage1Result = this._compressor.compress(messages, { keepRounds: 10 });

        if (stage1Result.stats.pairsCompressed > 0) {
          // 验证压缩结果
          if (!this._validateMessageArray(stage1Result.messages)) {
            this._logger.warn('Stage 1 压缩结果不满足消息要求，放弃', {
              compressedCount: stage1Result.stats.pairsCompressed,
              reason: 'validation_failed'
            });
            return;
          }

          const stage1Usage = stage1Result.stats.estimatedTokensAfter / maxContextTokens;

          if (stage1Usage < AutoCompressionManager.THRESHOLD) {
            // Stage 1 够用，应用
            messages.length = 0;
            messages.push(...stage1Result.messages);
            this._logger.info('Stage 1 完成，无需 Stage 2', stage1Result.stats);
            this._failureCount = 0;
            return;
          }

          // Stage 1 不够，先应用作为 Stage 2 的基础
          messages.length = 0;
          messages.push(...stage1Result.messages);
          this._logger.info('Stage 1 完成，但 token 仍超阈值，继续 Stage 2', stage1Result.stats);
        }
      }

      // ═══ Stage 2: 全文摘要压缩（兜底） ═══
      // 提取需要压缩的消息（同时按比例计算保留数量）
      const { toCompress, keepCount } = this._extractMessagesToCompress(messages);

      if (toCompress.length === 0) {
        this._logger.debug('AutoCompressionManager.process: 没有消息需要压缩', {
          messageCount: messages.length
        });
        return;
      }

      // 生成压缩摘要
      const summary = await this._generateSummary(toCompress);

      if (!summary) {
        this._logger.warn('AutoCompressionManager.process: 摘要生成失败，忽略本次压缩', {
          messageCount: messages.length,
          failureCount: this._failureCount,
          maxFailures: AutoCompressionManager.MAX_FAILURES
        });
        return;
      }

      // 验证并调整 keepCount：避免在 tool_call 配对边界处切开
      // _extractMessagesToCompress 的 token 累加可能在 tool 消息处停止，
      // 导致 tool 留在 recentMessages 但其 assistant（含 tool_calls）在 toCompress 中，
      // 形成孤立的 tool 消息，违反 _validateMessageArray 规则 2。
      let adjustedKeepCount = keepCount;
      while (adjustedKeepCount >= AutoCompressionManager.MIN_KEEP) {
        const recent = messages.slice(-adjustedKeepCount);
        const summaryMessage = {
          role: 'user',
          content: `[压缩摘要]\n${summary}`,
          isCompressed: true,
          compressedAt: new Date().toISOString()
        };
        const candidate = [summaryMessage, ...recent];
        if (this._validateMessageArray(candidate)) break;
        adjustedKeepCount--;
      }

      if (adjustedKeepCount < AutoCompressionManager.MIN_KEEP) {
        this._logger.warn('Stage 2 压缩结果不满足消息要求，放弃', {
          keepCount,
          adjustedKeepCount
        });
        return;
      }

      // 验证通过，应用压缩
      this._performCompression(messages, summary, adjustedKeepCount);

      // 记录压缩后的状态
      const afterCount = messages.length;
      this._logger.info('AutoCompressionManager.process: 自动压缩完成', {
        beforeCount,
        afterCount,
        compressed: true,
        summaryLength: summary.length,
        removedCount: beforeCount - afterCount
      });

    } catch (error) {
      this._logger.error('AutoCompressionManager.process: 自动压缩异常', {
        error: error.message,
        stack: error.stack,
        name: error?.name,
        code: error?.code,
        messageCount: Array.isArray(messages) ? messages.length : 0
      });
    }
  }

  /**
   * 提取需要压缩的消息（按 token 比例保留）
   *
   * 从末尾向前扫描，累积 token 估算值，直到达到 KEEP_RATIO 比例。
   * 返回需要压缩的消息和应保留的数量。
   *
   * @param {Array} messages - 会话消息数组（纯对话转录）
   * @returns {{ toCompress: Array, keepCount: number }}
   * @private
   */
  _extractMessagesToCompress(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { toCompress: [], keepCount: 0 };
    }

    const totalMessages = messages.length;
    const totalTokens = this._estimateTokensFromMessages(messages);
    const keepTokens = Math.max(
      totalTokens * AutoCompressionManager.KEEP_RATIO,
      totalTokens * 0.1 // 至少保留 10% 做下限保护
    );

    // 从末尾向前扫描，累积 token 直到达到 keepTokens
    let accumulatedTokens = 0;
    let keepCount = 0;
    for (let i = totalMessages - 1; i >= 0; i--) {
      const msg = messages[i];
      let msgTokens = 0;
      if (msg && typeof msg.content === 'string') {
        const chineseChars = (msg.content.match(/[\u4e00-\u9fff]/g) || []).length;
        const ratio = chineseChars / Math.max(msg.content.length, 1);
        const avgCharsPerToken = 4 - (ratio * 2.5);
        msgTokens = Math.ceil(msg.content.length / avgCharsPerToken) + 20;
      }
      accumulatedTokens += msgTokens;
      keepCount++;
      if (accumulatedTokens >= keepTokens) {
        break;
      }
    }

    // 最少保留 MIN_KEEP 条
    keepCount = Math.max(keepCount, AutoCompressionManager.MIN_KEEP);
    // 但不能超过总数 - 1（至少留 1 条压缩）
    keepCount = Math.min(keepCount, totalMessages - 1);

    const compressEndIndex = totalMessages - keepCount;
    const toCompress = messages.slice(0, compressEndIndex);

    this._logger.debug('AutoCompressionManager._extractMessagesToCompress: 消息提取完成', {
      totalMessages,
      totalTokens,
      keepTokens: Math.round(keepTokens),
      accumulatedTokens: Math.round(accumulatedTokens),
      keepCount,
      compressCount: toCompress.length,
      keepRatio: AutoCompressionManager.KEEP_RATIO
    });

    return { toCompress, keepCount };
  }

  /**
   * 计算消息数组的 token 使用情况
   *
   * 统一使用启发式估算方法（与 _extractMessagesToCompress 保持一致）。
   *
   * @param {Array} messages - 会话消息数组
   * @param {number} maxContextTokens - 上下文窗口大小
   * @returns {{totalTokens: number, usagePercent: number}} token 使用情况
   * @private
   */
  _calculateTokenUsage(messages, maxContextTokens) {
    const maxTokens = maxContextTokens;

    const estimatedTokens = this._estimateTokensFromMessages(messages);
    return {
      totalTokens: estimatedTokens,
      usagePercent: Math.min(estimatedTokens / maxTokens, 1.0)
    };
  }

  /**
   * 估算消息数组的 token 数量
   *
   * 使用简单的启发式方法估算 token 数量：
   * - 英文：约 4 个字符 = 1 个 token
   * - 中文：约 1.5 个字符 = 1 个 token
   * - 考虑消息结构的额外开销
   *
   * @param {Array} messages - 会话消息数组
   * @returns {number} 估算的 token 数量
   * @private
   */
  _estimateTokensFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 0;
    }

    let totalChars = 0;
    let structureOverhead = 0;
    let allContent = '';

    for (const message of messages) {
      if (!message || typeof message.content !== 'string') {
        continue;
      }

      const content = message.content;
      totalChars += content.length;
      allContent += content;

      // 消息结构的额外开销
      structureOverhead += 20;

      // 如果有工具调用，增加额外开销
      if (message.tool_calls && Array.isArray(message.tool_calls)) {
        structureOverhead += message.tool_calls.length * 50;
      }
    }

    const chineseCharCount = (allContent.match(/[\u4e00-\u9fff]/g) || []).length;
    const chineseRatio = totalChars > 0 ? chineseCharCount / totalChars : 0;

    const avgCharsPerToken = 4 - (chineseRatio * 2.5);
    const contentTokens = totalChars > 0 ? Math.ceil(totalChars / avgCharsPerToken) : 0;

    const estimatedTokens = contentTokens + structureOverhead;

    return estimatedTokens;
  }

  /**
   * 生成压缩摘要
   *
   * 调用默认 LLM 生成需要压缩的消息的结构化摘要。
   * 成功时重置 failureCount，失败时递增。
   *
   * @param {Array} messagesToCompress - 需要压缩的消息数组
   * @returns {Promise<string|null>} 生成的摘要，失败时返回 null
   * @private
   */
  async _generateSummary(messagesToCompress) {
    try {
      const prompt = this._buildSummaryPrompt(messagesToCompress);

      this._logger.debug('AutoCompressionManager._generateSummary: 开始生成摘要', {
        messageCount: messagesToCompress.length
      });

      const startTime = Date.now();

      const response = await this._llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: AutoCompressionManager.SUMMARY_MAX_TOKENS,
      });

      const elapsedTime = Date.now() - startTime;

      const summary = response?.content ?? null;

      if (typeof summary !== 'string' || !summary.trim()) {
        this._failureCount++;
        this._logger.warn('AutoCompressionManager._generateSummary: LLM 返回空摘要', {
          messageCount: messagesToCompress.length,
          elapsedTime,
          failureCount: this._failureCount
        });
        return null;
      }

      // 成功：重置熔断计数器
      this._failureCount = 0;

      this._logger.info('AutoCompressionManager._generateSummary: 摘要生成成功', {
        messageCount: messagesToCompress.length,
        summaryLength: summary.length,
        elapsedTime
      });

      return summary;

    } catch (error) {
      this._failureCount++;
      this._logger.warn('AutoCompressionManager._generateSummary: 摘要生成失败', {
        error: error.message,
        stack: error.stack,
        name: error?.name,
        code: error?.code,
        messageCount: messagesToCompress.length,
        failureCount: this._failureCount
      });
      return null;
    }
  }

  /**
   * 构建摘要生成提示词
   *
   * 结构化输出格式，强调精确值保留和反冗余。
   *
   * @param {Array} messagesToCompress - 需要压缩的消息数组
   * @returns {string} 格式化的提示词
   * @private
   */
  _buildSummaryPrompt(messagesToCompress) {
    const formattedMessages = messagesToCompress
      .map((msg, index) => {
        const roleMap = { assistant: '助手', user: '用户', tool: '工具' };
        const role = roleMap[msg.role] || msg.role;
        return `[${index + 1}] ${role}: ${msg.content}`;
      })
      .join('\n\n');

    const prompt = `你是一个对话压缩助手。将以下对话历史压缩为一份高信息密度的结构化摘要，供后续 Agent 决策参考。

## 输出格式（严格遵循）
\`\`\`
[关键决策]
- <决策内容及原因>
[重要事实]
- <事实、配置、约定>
[用户约束]
- <明确限制或偏好>
[任务进度]
- <已完成步骤及下一步>
[失败教训]
- <已证实错误的方案及原因>
\`\`\`

## 压缩规则
1. 精确值保留：文件路径、端口号、版本号等一字不改。
2. 禁止冗余：最近 3 轮对话中已明确的信息不要重复。
3. 错误即信息：记录失败方案是防止重蹈覆辙。
4. 面向当前任务：与当前任务直接相关的信息优先保留。

## 对话历史
${formattedMessages}

## 输出
\`\`\``;

    return prompt;
  }

  /**
   * 执行压缩操作
   *
   * 直接修改消息数组：
   * 结构：[摘要消息, ...最近 keepCount 条消息]
   *
   * @param {Array} messages - 会话消息数组（直接修改）
   * @param {string} summary - 压缩摘要
   * @param {number} keepCount - 保留的消息数量
   * @private
   */
  _performCompression(messages, summary, keepCount) {
    const recentMessages = messages.slice(-keepCount);

    // 创建摘要消息（role: user 而非 assistant，确保 llm_truncation_service 不会删光消息）
    const summaryMessage = {
      role: 'user',
      content: `[压缩摘要]\n${summary}`,
      isCompressed: true,
      compressedAt: new Date().toISOString()
    };

    const newMessages = [summaryMessage, ...recentMessages];

    // 最终验证（双保险）
    if (!this._validateMessageArray(newMessages)) {
      this._logger.warn('_performCompression: 压缩结果不满足消息要求，放弃写入');
      return;
    }

    // 清空原数组并填充新消息
    messages.length = 0;
    messages.push(...newMessages);

    this._logger.debug('AutoCompressionManager._performCompression: 压缩执行完成', {
      afterCount: messages.length,
      keepCount,
      summaryLength: summary.length
    });
  }

  /**
   * 验证压缩后的消息数组是否满足 LLM 调用的基本要求。
   * 验证不通过时，压缩操作应被放弃。
   *
   * @param {Array} messages
   * @returns {boolean}
   */
  _validateMessageArray(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    // 规则 1：必须至少有一条约 user 消息
    const hasAnyUser = messages.some(m => m?.role === 'user');
    if (!hasAnyUser) {
      return false;
    }

    // 规则 2：所有 tool 消息的 tool_call_id 必须在某条 assistant.tool_calls 中出现
    const validToolCallIds = new Set();
    for (const msg of messages) {
      if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) validToolCallIds.add(tc.id);
        }
      }
    }
    for (const msg of messages) {
      if (msg?.role === 'tool' && msg.tool_call_id && !validToolCallIds.has(msg.tool_call_id)) {
        return false;
      }
    }

    return true;
  }
}
