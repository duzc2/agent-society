/**
 * LLM 响应处理服务。
 *
 * 提供响应标准化、助手消息构建等响应处理能力。
 * 此服务是无状态的，不持有任何实例状态。
 */
export class LlmResponseService {
  constructor() {}

  /**
   * 标准化 token 用量数据。
   * 兼容不同 provider 的字段命名差异（camelCase vs snake_case, inputTokens vs promptTokens 等）。
   *
   * @param {any} usage - 原始用量对象
   * @returns {{ promptTokens: number, completionTokens: number, totalTokens: number }}
   */
  normalizeUsage(usage) {
    if (!usage || typeof usage !== "object") {
      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0
      };
    }

    // promptTokens 优先取 camelCase/snake_case 标量字段
    let promptTokens = usage.promptTokens ?? usage.prompt_tokens;

    // inputTokens / input_tokens 可能是数字，也可能是以 total 为键的嵌套对象
    let inputTokensObj = null;
    if (promptTokens === undefined) {
      const raw = usage.inputTokens ?? usage.input_tokens;
      if (typeof raw === "number") {
        promptTokens = raw;
      } else if (raw && typeof raw === "object") {
        inputTokensObj = raw;
        promptTokens = raw.total ?? 0;
      }
    }
    promptTokens = promptTokens ?? 0;

    const completionTokens = usage.completionTokens
      ?? usage.completion_tokens
      ?? usage.outputTokens
      ?? usage.output_tokens
      ?? 0;

    const totalTokens = usage.totalTokens
      ?? usage.total_tokens
      ?? ((Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0));

    // 从嵌套 inputTokens 对象中提取缓存 token 数
    let cachedInputTokens = 0;
    if (inputTokensObj) {
      const cacheRead = inputTokensObj.cacheRead ?? inputTokensObj.cache_read ?? 0;
      const cacheWrite = inputTokensObj.cacheWrite ?? inputTokensObj.cache_write ?? 0;
      const rawCache = cacheRead + cacheWrite;
      cachedInputTokens = Number.isFinite(rawCache) ? rawCache : 0;
    }

    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      cachedInputTokens
    };
  }

  /**
   * 从 LLM 原始输出构建统一的助手消息对象。
   *
   * @param {object} [input={}]
   * @param {string} [input.text] - 文本内容
   * @param {string|null} [input.reasoning] - 推理内容
   * @param {any[]} [input.reasoningParts] - ai-sdk reasoning 详情
   * @param {any[]} [input.toolCalls] - 工具调用列表
   * @param {any} [input.usage] - token 用量
   * @param {string} [input.finishReason] - 完成原因
   * @returns {object} 助手消息对象
   */
  buildAssistantMessage(input = {}) {
    const rawText = this._normalizeSuspiciousText(typeof input?.text === "string" ? input.text : "");
    const externalReasoning = typeof input?.reasoning === "string" && input.reasoning.trim()
      ? input.reasoning.trim()
      : null;
    const { content, reasoning } = this._extractUnifiedReasoning(
      externalReasoning ? { reasoningText: externalReasoning } : {},
      rawText
    );
    const normalizedUsage = this.normalizeUsage(input?.usage);
    const msg = {
      role: "assistant",
      content,
      _usage: normalizedUsage
    };

    if (reasoning) {
      msg.reasoning_content = reasoning;
    }

    // 保留 reasoning 的 providerMetadata（如 Anthropic thinking signature）
    // DeepSeek 等启用了 thinking mode 的 API 要求后续请求必须包含前一轮的 thinking 块及其签名
    if (Array.isArray(input?.reasoningParts)) {
      const reasoningMeta = input.reasoningParts
        .filter(part => part?.providerMetadata)
        .map(part => part.providerMetadata);
      if (reasoningMeta.length > 0) {
        msg.reasoningProviderMetadata = reasoningMeta[0];
      }
    }

    if (Array.isArray(input?.toolCalls) && input.toolCalls.length > 0) {
      msg.tool_calls = input.toolCalls.map((toolCall) => {
        const args = toolCall?.arguments ?? toolCall?.args ?? toolCall?.input;
        return {
          id: toolCall?.id ?? toolCall?.toolCallId ?? toolCall?.call_id ?? toolCall?.itemId ?? "",
          type: "function",
          function: {
            name: toolCall?.name ?? toolCall?.toolName ?? "",
            arguments: typeof args === "string"
              ? args
              : JSON.stringify(args ?? {})
          }
        };
      });
    }

    // 保存 finishReason，用于 TurnEngine 判断是否需要自动续接
    if (input?.finishReason) {
      msg._finishReason = input.finishReason;
    }

    return msg;
  }

  // ─── 私有辅助方法 ────────────────────────────────────────

  /**
   * 自愈防御：识别"完整的 Anthropic Messages 响应体被误当作文本内容"的形态并提取真实文本。
   * 背景：个别模型/代理组合在长响应下会把整包响应 JSON 填进 text（真实故障样例：
   * glm-5.3-flash 经本地代理的长代码生成任务）。触发条件苛刻（type=message +
   * role=assistant + content 数组三者同时命中），不会误伤模型正常输出的 JSON 文本。
   * @param {string} text
   * @returns {string}
   * @private
   */
  _normalizeSuspiciousText(text) {
    if (typeof text !== "string") {
      return text;
    }
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{")) {
      return text;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed?.type === "message"
        && parsed?.role === "assistant"
        && Array.isArray(parsed.content)
        && parsed.content.some((block) => block?.type === "text" && typeof block.text === "string")
      ) {
        return parsed.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("");
      }
    } catch {
      // 非 JSON，按普通文本原样返回
    }
    return text;
  }

  _extractReasoning(text) {
    if (!text || typeof text !== "string") {
      return { content: text || "", reasoning: null };
    }

    // 匹配 <think> 标签内容（支持多行、大小写、多段）
    const thinkMatches = [...text.matchAll(/<think\b[^>]*>([\s\S]*?)<\/think>/gi)];
    if (thinkMatches.length === 0) {
      return { content: text, reasoning: null };
    }

    const reasoning = thinkMatches
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");

    // 移除 <think> 标签及其内容，获取正文
    let content = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();

    // 如果正文为空，但思考内容不为空，将思考内容作为正文
    if (!content && reasoning) {
      content = reasoning;
    }

    return { content, reasoning };
  }

  _extractUnifiedReasoning(result, rawText) {
    const extracted = this._extractReasoning(rawText);
    const candidates = [];

    if (typeof result?.reasoningText === "string" && result.reasoningText.trim()) {
      candidates.push(result.reasoningText.trim());
    }

    if (Array.isArray(result?.reasoning)) {
      const reasoningFromParts = result.reasoning
        .map((part) => {
          if (typeof part === "string") {
            return part.trim();
          }
          if (typeof part?.text === "string") {
            return part.text.trim();
          }
          if (typeof part?.reasoning === "string") {
            return part.reasoning.trim();
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
      if (reasoningFromParts) {
        candidates.push(reasoningFromParts);
      }
    }

    if (extracted.reasoning) {
      candidates.push(extracted.reasoning);
    }

    const uniqueCandidates = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!uniqueCandidates.includes(candidate)) {
        uniqueCandidates.push(candidate);
      }
    }

    return {
      content: extracted.content,
      reasoning: uniqueCandidates.length > 0 ? uniqueCandidates.join("\n\n") : null
    };
  }
}
