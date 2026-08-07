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
   * @param {{ exchangeState: import("./client_exchange_state.js").ClientExchangeState, resolveStreamFlag: (config: any) => boolean }} deps
   */
  constructor({ exchangeState, resolveStreamFlag }) {
    this._exchangeState = exchangeState;
    this._resolveStreamFlag = resolveStreamFlag;
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
    } catch {
      return requestBody;
    }
  }
}

export { INTERNAL_REQUEST_AUGMENTATION_HEADER };
