/**
 * LLM 请求增强服务。
 *
 * 提供请求体增强能力，包括 stream 注入、助手工具推理注入和请求体增强注册。
 */
import { randomUUID } from "node:crypto";

/**
 * 内部请求增强头。
 * 只在进程内传递请求体增强上下文，真正发给模型服务前会被移除。
 * @type {string}
 */
const INTERNAL_REQUEST_AUGMENTATION_HEADER = "x-agent-society-request-augmentation-id";

export class LlmAugmentService {
  /**
   * @param {{
   *   exchangeState: import("./client_exchange_state.js").ClientExchangeState,
   *   resolveStreamFlag: (config: any) => boolean,
   *   log: Logger
   * }} deps
   */
  constructor({ exchangeState, resolveStreamFlag, log }) {
    this._exchangeState = exchangeState;
    this._resolveStreamFlag = resolveStreamFlag;
    this._log = log;
  }

  /**
   * 判断是否应对该请求 URL 注入 stream 参数。
   * @param {string} requestUrl
   * @returns {boolean}
   */
  shouldInjectStreamForRequest(requestUrl) {
    if (typeof requestUrl !== "string" || requestUrl.length === 0) {
      return false;
    }
    // Anthropic Messages API 由 AI SDK 自行管理 stream 参数，不强制注入
    if (/\/messages(?:\?|$)/i.test(requestUrl)) {
      return false;
    }
    return /\/(chat\/completions|completions|responses)(?:\?|$)/i.test(requestUrl);
  }

  /**
   * 将配置的 stream 标志注入请求体。
   * @param {string} requestUrl
   * @param {string} requestBody
   * @param {any} config
   * @returns {string}
   */
  injectConfiguredStreamIntoRequestBody(requestUrl, requestBody, config) {
    if (!this.shouldInjectStreamForRequest(requestUrl) || requestBody == null) {
      return requestBody;
    }

    if (typeof requestBody !== "string") {
      return requestBody;
    }

    const trimmedBody = requestBody.trim();
    if (!trimmedBody) {
      return requestBody;
    }

    try {
      const parsedBody = JSON.parse(trimmedBody);
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        return requestBody;
      }

      return JSON.stringify({
        ...parsedBody,
        stream: this._resolveStreamFlag(config)
      });
    } catch {
      return requestBody;
    }
  }

  /**
   * 判断是否应对该请求 URL 注入助手工具推理。
   * @param {string} requestUrl
   * @returns {boolean}
   */
  shouldInjectAssistantToolReasoningForRequest(requestUrl) {
    if (typeof requestUrl !== "string" || requestUrl.length === 0) {
      return false;
    }
    return /\/chat\/completions(?:\?|$)/i.test(requestUrl);
  }

  /**
   * 从消息列表中构建助手工具推理增强。
   * @param {any[]} messages
   * @returns {{ assistantToolReasoningByCallId: Record<string, string> } | null}
   */
  buildAssistantToolReasoningAugmentation(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    const assistantToolReasoningByCallId = {};
    for (const message of messages) {
      if (message?.role !== "assistant") {
        continue;
      }
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        continue;
      }

      const reasoningContent = typeof message.reasoning_content === "string" && message.reasoning_content.trim()
        ? message.reasoning_content
        : null;
      if (!reasoningContent) {
        continue;
      }

      for (const toolCall of message.tool_calls) {
        const toolCallId = typeof toolCall?.id === "string" ? toolCall.id.trim() : "";
        if (!toolCallId) {
          continue;
        }
        assistantToolReasoningByCallId[toolCallId] = reasoningContent;
      }
    }

    return Object.keys(assistantToolReasoningByCallId).length > 0
      ? { assistantToolReasoningByCallId }
      : null;
  }

  /**
   * 注册请求体增强并返回增强 ID。
   * @param {any} augmentation
   * @returns {string|null}
   */
  registerRequestBodyAugmentation(augmentation) {
    if (!augmentation || typeof augmentation !== "object") {
      return null;
    }
    const augmentationId = randomUUID();
    this._exchangeState.augmentations.set(augmentationId, augmentation);
    return augmentationId;
  }

  /**
   * 清除请求体增强。
   * @param {string|null} augmentationId
   */
  clearRequestBodyAugmentation(augmentationId) {
    if (!augmentationId) {
      return;
    }
    this._exchangeState.augmentations.delete(augmentationId);
  }

  /**
   * 从请求 headers 中提取增强 ID。
   * @param {Headers|object|null} headers
   * @returns {string|null}
   */
  extractRequestAugmentationIdFromHeaders(headers) {
    if (!headers) {
      return null;
    }
    const normalizedHeaders = new Headers(headers);
    const augmentationId = normalizedHeaders.get(INTERNAL_REQUEST_AUGMENTATION_HEADER);
    return typeof augmentationId === "string" && augmentationId.trim()
      ? augmentationId.trim()
      : null;
  }

  /**
   * 构建转发请求头（移除内部增强头）。
   * @param {Headers|object|null} headers
   * @returns {Headers}
   */
  buildForwardRequestHeaders(headers) {
    const forwardHeaders = new Headers(headers ?? {});
    forwardHeaders.delete(INTERNAL_REQUEST_AUGMENTATION_HEADER);
    return forwardHeaders;
  }

  /**
   * 将助手工具推理注入请求体。
   * @param {string} requestUrl
   * @param {string} requestBody
   * @param {any} augmentation
   * @returns {string}
   */
  injectAssistantToolReasoningIntoRequestBody(requestUrl, requestBody, augmentation) {
    if (!this.shouldInjectAssistantToolReasoningForRequest(requestUrl) || requestBody == null) {
      return requestBody;
    }

    if (typeof requestBody !== "string") {
      return requestBody;
    }

    const reasoningByCallId = augmentation?.assistantToolReasoningByCallId;
    if (!reasoningByCallId || typeof reasoningByCallId !== "object") {
      return requestBody;
    }

    const trimmedBody = requestBody.trim();
    if (!trimmedBody) {
      return requestBody;
    }

    try {
      const parsedBody = JSON.parse(trimmedBody);
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        return requestBody;
      }
      if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
        return requestBody;
      }

      let changed = false;
      for (const message of parsedBody.messages) {
        if (message?.role !== "assistant") {
          continue;
        }
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
          continue;
        }
        if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
          continue;
        }

        let matchedReasoning = null;
        for (const toolCall of message.tool_calls) {
          const toolCallId = typeof toolCall?.id === "string" ? toolCall.id.trim() : "";
          if (!toolCallId) {
            continue;
          }
          const candidate = reasoningByCallId[toolCallId];
          if (typeof candidate === "string" && candidate.trim()) {
            matchedReasoning = candidate;
            break;
          }
        }

        if (!matchedReasoning) {
          continue;
        }

        message.reasoning_content = matchedReasoning;
        changed = true;
      }

      return changed ? JSON.stringify(parsedBody) : requestBody;
    } catch (error) {
      // JSON 解析失败等异常必须记录日志，不能静默吞掉；回退为原始请求体
      void this._log.error("请求体注入助手工具推理失败，回退为原始请求体", {
        requestUrl,
        errorMessage: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
      return requestBody;
    }
  }

  /**
   * 判断是否应对该请求 URL 注入 thinking 字段。
   * 仅作用于 OpenAI Chat Completions 协议；Anthropic Messages API 与
   * OpenAI Responses API 由 providerOptions/ai-sdk 自行管理，不注入。
   * @param {string} requestUrl
   * @returns {boolean}
   */
  shouldInjectThinkingForRequest(requestUrl) {
    if (typeof requestUrl !== "string" || requestUrl.length === 0) {
      return false;
    }
    return /\/chat\/completions(?:\?|$)/i.test(requestUrl);
  }

  /**
   * 判断配置是否要求向 OpenAI 兼容请求体注入 thinking 字段。
   * 仅在 provider 为 openai（含默认值）且 thinking.type === "enabled" 时生效，
   * 避免 anthropic / open-responses 等其他协议收到不支持的字段。
   * @param {any} config - LLM 服务配置
   * @returns {boolean}
   */
  shouldInjectThinkingForConfig(config) {
    const provider = config?.provider ?? "openai";
    if (provider !== "openai") {
      return false;
    }
    return config?.thinking?.type === "enabled";
  }

  /**
   * 将 thinking 字段注入 OpenAI 兼容请求体。
   *
   * 背景：部分 OpenAI 兼容服务（如 z.ai 的 glm 系列）要求请求体携带
   * `"thinking": {"type":"enabled"}` 才开启深度思考，该字段是非标准的
   * OpenAI 字段，ai-sdk 的 providerOptions 无法传递，因此在此处注入。
   * @param {string} requestUrl
   * @param {any} requestBody - 可能是字符串的 JSON 请求体，也可能为空
   * @param {any} config - LLM 服务配置
   * @returns {any} 注入后的请求体；不满足注入条件时原样返回
   */
  injectThinkingIntoRequestBody(requestUrl, requestBody, config) {
    if (!this.shouldInjectThinkingForRequest(requestUrl) || requestBody == null) {
      return requestBody;
    }
    if (!this.shouldInjectThinkingForConfig(config)) {
      return requestBody;
    }
    if (typeof requestBody !== "string") {
      return requestBody;
    }

    const trimmedBody = requestBody.trim();
    if (!trimmedBody) {
      return requestBody;
    }

    try {
      const parsedBody = JSON.parse(trimmedBody);
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        return requestBody;
      }
      // 已有 thinking 配置时尊重 ai-sdk/provider 已写入的值，避免覆盖
      if (parsedBody.thinking !== undefined) {
        return requestBody;
      }

      return JSON.stringify({
        ...parsedBody,
        thinking: { type: "enabled" }
      });
    } catch (error) {
      // JSON 解析失败等异常必须记录日志，不能静默吞掉；回退为原始请求体
      void this._log.error("请求体注入 thinking 字段失败，回退为原始请求体", {
        requestUrl,
        errorMessage: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
      return requestBody;
    }
  }

  /**
   * 判断是否应对该请求 URL 修补响应体中的 thinking 块。
   * 仅作用于 Anthropic Messages API 的非流式 JSON 响应。
   * @param {string} requestUrl
   * @returns {boolean}
   */
  shouldRepairThinkingSignatureForRequest(requestUrl) {
    if (typeof requestUrl !== "string" || requestUrl.length === 0) {
      return false;
    }
    return /\/messages(?:\?|$)/i.test(requestUrl);
  }

  /**
   * 给响应体中缺失 signature 的 thinking 块补占位签名。
   *
   * 背景：ai-sdk 的 Anthropic 非流式响应 schema 要求 thinking 块必须携带
   * signature 字段（官方协议由 thinking 引擎签发），而部分模型经代理
   * （真实故障样例：glm-5.3-flash 经 ccswitch 本地代理）返回的 thinking 块
   * 只有 {type, thinking} 两个键。schema 校验失败会被 ai-sdk 统一包装为
   * "Invalid JSON response"，导致整次调用重试直至失败。
   * 占位签名仅用于通过本地 schema 校验；本项目把 thinking 内容作为
   * reasoning_content 使用，签名不会被回传给模型服务校验。
   * @param {string} requestUrl
   * @param {string} responseBody - 响应体文本
   * @returns {{body: string, repairedCount: number}} 修补结果；未修补时 repairedCount 为 0
   */
  repairThinkingSignatureInResponseBody(requestUrl, responseBody) {
    if (!this.shouldRepairThinkingSignatureForRequest(requestUrl)) {
      return { body: responseBody, repairedCount: 0 };
    }
    if (typeof responseBody !== "string" || responseBody.trim() === "") {
      return { body: responseBody, repairedCount: 0 };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseBody);
    } catch (error) {
      // 2xx 响应体不是 JSON（如代理返回错误页）必须记录日志，不能静默吞掉；回退为原始响应体
      void this._log.error("修补响应体 thinking 签名失败（响应体非 JSON），回退为原始响应体", {
        requestUrl,
        responseBodyPreview: responseBody.slice(0, 500),
        errorMessage: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
      return { body: responseBody, repairedCount: 0 };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { body: responseBody, repairedCount: 0 };
    }
    if (!Array.isArray(parsed.content)) {
      return { body: responseBody, repairedCount: 0 };
    }

    let repairedCount = 0;
    for (const block of parsed.content) {
      if (block?.type !== "thinking" || typeof block.thinking !== "string") {
        continue;
      }
      if (typeof block.signature === "string") {
        continue;
      }
      block.signature = "placeholder:missing-from-provider";
      repairedCount++;
    }
    if (repairedCount === 0) {
      return { body: responseBody, repairedCount: 0 };
    }

    return { body: JSON.stringify(parsed), repairedCount };
  }
}

export { INTERNAL_REQUEST_AUGMENTATION_HEADER };
