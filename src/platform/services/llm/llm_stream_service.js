/**
 * LLM 流式响应服务。
 *
 * 提供流式响应的检测和组装能力，可从 SSE 流事件中重建完整的助手消息。
 */
export class LlmStreamService {
  /**
   * @param {{ log: Logger, responseService: import("./llm_response_service.js").LlmResponseService }} deps
   */
  constructor({ log, responseService }) {
    this._log = log;
    this._responseService = responseService;
  }

  /**
   * 判断响应体是否类似流式响应。
   * 通过检测 SSE 事件前缀和 JSON data 行来识别。
   *
   * @param {string} responseBody
   * @returns {boolean}
   */
  isStreamLikeResponseBody(responseBody) {
    if (typeof responseBody !== "string") {
      return false;
    }
    const normalized = responseBody.trim();
    if (!normalized) {
      return false;
    }
    // 识别 SSE 流式响应格式:
    // 1. OpenAI Responses API: event: response.*
    // 2. Anthropic Messages API: event: message_*, content_block_*, ping
    // 3. OpenAI Chat Completions: data: [DONE]
    // 4. 通用 JSON SSE: data: { ... }
    return /(^|\n)\s*event:\s*(response\.|message_|content_block_|ping)/i.test(normalized)
      || /(^|\n)\s*data:\s*\{/i.test(normalized)
      || /(^|\n)\s*data:\s*\[DONE\]\s*$/im.test(normalized);
  }

  /**
   * 从流式响应体中构建助手消息。
   *
   * @param {string} responseBody - 完整的流式响应内容
   * @returns {object|null} 助手消息对象或 null（无法构建时）
   */
  buildAssistantMessageFromStreamResponse(responseBody) {
    if (!this.isStreamLikeResponseBody(responseBody)) {
      return null;
    }

    const accumulator = {
      textParts: [],
      reasoningParts: [],
      toolCallsByItemId: new Map(),
      usage: null,
      fallbackText: "",
      fallbackReasoning: ""
    };
    const eventBlocks = String(responseBody)
      .split(/\r?\n\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    for (const block of eventBlocks) {
      this._applyStreamEventBlock(accumulator, block);
    }

    const text = accumulator.textParts.join("") || accumulator.fallbackText || "";
    const reasoning = accumulator.reasoningParts.join("") || accumulator.fallbackReasoning || null;
    const toolCalls = [...accumulator.toolCallsByItemId.values()]
      .filter((item) => item && item.name);

    if (!text && !reasoning && toolCalls.length === 0) {
      return null;
    }

    return this._responseService.buildAssistantMessage({
      text,
      reasoning,
      toolCalls,
      usage: accumulator.usage
    });
  }

  // ─── 私有流事件处理方法 ──────────────────────────────────

  _applyStreamEventBlock(accumulator, block) {
    if (!accumulator || typeof block !== "string") {
      return;
    }

    const lines = block.split(/\r?\n/);
    let eventName = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }

    const rawDataText = dataLines.join("\n");
    if (!rawDataText) {
      return;
    }

    const parsedData = this._parseStreamEventData(rawDataText);
    if (parsedData?.__done === true) {
      return;
    }

    if (this._applyChatCompletionsStreamChunk(accumulator, parsedData)) {
      return;
    }

    const resolvedEventName = eventName || parsedData?.type || "";

    if (resolvedEventName === "response.output_text.delta") {
      const delta = typeof parsedData?.delta === "string" ? parsedData.delta : "";
      if (delta) {
        accumulator.textParts.push(delta);
      }
      return;
    }

    if (resolvedEventName === "response.output_text.done") {
      if (!accumulator.textParts.length && typeof parsedData?.text === "string") {
        accumulator.fallbackText = parsedData.text;
      }
      return;
    }

    if (resolvedEventName === "response.reasoning_text.delta") {
      const delta = typeof parsedData?.delta === "string" ? parsedData.delta : "";
      if (delta) {
        accumulator.reasoningParts.push(delta);
      }
      return;
    }

    if (resolvedEventName === "response.reasoning_text.done") {
      if (!accumulator.reasoningParts.length && typeof parsedData?.text === "string") {
        accumulator.fallbackReasoning = parsedData.text;
      }
      return;
    }

    if (resolvedEventName === "response.output_item.added" || resolvedEventName === "response.output_item.done") {
      const item = parsedData?.item;
      if (item?.type === "function_call") {
        this._mergeStreamToolCall(accumulator, {
          itemId: item.id,
          id: item.call_id ?? item.id,
          name: item.name,
          arguments: item.arguments ?? ""
        });
      } else if (item?.type === "message") {
        const extractedText = this._extractMessageTextFromStreamItem(item);
        if (extractedText && !accumulator.textParts.length) {
          accumulator.fallbackText = extractedText;
        }
      } else if (item?.type === "reasoning") {
        const extractedReasoning = this._extractReasoningTextFromStreamItem(item);
        if (extractedReasoning && !accumulator.reasoningParts.length) {
          accumulator.fallbackReasoning = extractedReasoning;
        }
      }
      return;
    }

    if (resolvedEventName === "response.function_call_arguments.delta") {
      this._mergeStreamToolCall(accumulator, {
        itemId: parsedData?.item_id,
        argumentsDelta: parsedData?.delta
      });
      return;
    }

    if (resolvedEventName === "response.function_call_arguments.done") {
      this._mergeStreamToolCall(accumulator, {
        itemId: parsedData?.item_id,
        arguments: parsedData?.arguments ?? ""
      });
      return;
    }

    if (resolvedEventName === "response.completed") {
      if (parsedData?.response?.usage) {
        accumulator.usage = parsedData.response.usage;
      }
      this._mergeCompletedStreamResponse(accumulator, parsedData?.response);
    }
  }

  _parseStreamEventData(dataText) {
    if (typeof dataText !== "string" || !dataText.trim()) {
      return null;
    }
    const normalized = dataText.trim();
    if (normalized === "[DONE]") {
      return { __done: true };
    }
    try {
      return JSON.parse(normalized);
    } catch (error) {
      void this._log.warn("流式响应 data 解析失败，已忽略该事件", {
        message: error?.message ?? String(error),
        dataPreview: normalized.slice(0, 500),
        stack: error?.stack,
        name: error?.name,
        code: error?.code
      });
      return null;
    }
  }

  _applyChatCompletionsStreamChunk(accumulator, parsedData) {
    if (!this._isChatCompletionsStreamPayload(parsedData)) {
      return false;
    }

    if (parsedData?.usage) {
      accumulator.usage = parsedData.usage;
    }

    const choices = Array.isArray(parsedData?.choices) ? parsedData.choices : [];
    for (const choice of choices) {
      this._mergeChatCompletionsChoice(accumulator, choice);
    }

    return true;
  }

  _isChatCompletionsStreamPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    if (payload.object === "chat.completion.chunk" || payload.object === "chat.completion") {
      return true;
    }

    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    return choices.some((choice) => choice?.delta || choice?.message);
  }

  _mergeChatCompletionsChoice(accumulator, choice) {
    if (choice?.delta && typeof choice.delta === "object") {
      this._mergeChatCompletionsMessageLike(accumulator, choice.delta, choice?.index, true);
    }
    if (choice?.message && typeof choice.message === "object") {
      this._mergeChatCompletionsMessageLike(accumulator, choice.message, choice?.index, false);
    }
  }

  _mergeChatCompletionsMessageLike(accumulator, messageLike, choiceIndex, isDelta) {
    const text = this._extractChatCompletionsContentText(messageLike?.content);
    if (text) {
      if (isDelta) {
        accumulator.textParts.push(text);
      } else if (!accumulator.textParts.length) {
        accumulator.fallbackText = text;
      }
    }

    const reasoning = this._extractChatCompletionsReasoningText(messageLike);
    if (reasoning) {
      if (isDelta) {
        accumulator.reasoningParts.push(reasoning);
      } else if (!accumulator.reasoningParts.length) {
        accumulator.fallbackReasoning = reasoning;
      }
    }

    this._mergeChatCompletionsToolCalls(
      accumulator,
      messageLike?.tool_calls,
      Number.isInteger(choiceIndex) ? choiceIndex : 0,
      isDelta
    );

    if (messageLike?.function_call && typeof messageLike.function_call === "object") {
      const safeChoiceIndex = Number.isInteger(choiceIndex) ? choiceIndex : 0;
      const itemId = `choice-${safeChoiceIndex}-function-call`;
      this._mergeStreamToolCall(accumulator, {
        itemId,
        id: itemId,
        name: messageLike.function_call.name,
        arguments: isDelta ? undefined : (messageLike.function_call.arguments ?? ""),
        argumentsDelta: isDelta ? messageLike.function_call.arguments : undefined
      });
    }
  }

  _extractChatCompletionsContentText(content) {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts = [];
    for (const part of content) {
      if (typeof part === "string" && part) {
        parts.push(part);
        continue;
      }
      if (typeof part?.text === "string" && part.text) {
        parts.push(part.text);
        continue;
      }
      if (typeof part?.text?.value === "string" && part.text.value) {
        parts.push(part.text.value);
      }
    }
    return parts.join("");
  }

  _extractChatCompletionsReasoningText(messageLike) {
    const directReasoning = this._extractChatCompletionsContentText(
      messageLike?.reasoning_content ?? messageLike?.reasoning
    );
    if (directReasoning) {
      return directReasoning;
    }

    const details = Array.isArray(messageLike?.reasoning_details) ? messageLike.reasoning_details : [];
    const parts = [];
    for (const detail of details) {
      const text = this._extractChatCompletionsContentText(detail?.text ?? detail?.content);
      if (text) {
        parts.push(text);
      }
    }
    return parts.join("");
  }

  _mergeChatCompletionsToolCalls(accumulator, toolCalls, choiceIndex, isDelta) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return;
    }

    for (let index = 0; index < toolCalls.length; index++) {
      const toolCall = toolCalls[index];
      const toolIndex = Number.isInteger(toolCall?.index) ? toolCall.index : index;
      const itemId = `choice-${choiceIndex}-tool-${toolIndex}`;
      const functionPayload = toolCall?.function && typeof toolCall.function === "object"
        ? toolCall.function
        : {};

      this._mergeStreamToolCall(accumulator, {
        itemId,
        id: toolCall?.id,
        name: functionPayload?.name,
        arguments: isDelta ? undefined : (functionPayload?.arguments ?? ""),
        argumentsDelta: isDelta ? functionPayload?.arguments : undefined
      });
    }
  }

  _mergeStreamToolCall(accumulator, partial) {
    const itemId = partial?.itemId;
    if (!itemId) {
      return;
    }
    const existing = accumulator.toolCallsByItemId.get(itemId) ?? {
      itemId,
      id: partial?.id ?? itemId,
      name: partial?.name ?? "",
      arguments: ""
    };

    if (partial?.id) {
      existing.id = partial.id;
    }
    if (partial?.name) {
      existing.name = partial.name;
    }
    if (typeof partial?.arguments === "string") {
      existing.arguments = partial.arguments;
    } else if (typeof partial?.argumentsDelta === "string" && partial.argumentsDelta) {
      existing.arguments += partial.argumentsDelta;
    }

    accumulator.toolCallsByItemId.set(itemId, existing);
  }

  _mergeCompletedStreamResponse(accumulator, response) {
    const outputs = Array.isArray(response?.output) ? response.output : [];
    for (const item of outputs) {
      if (item?.type === "message") {
        const extractedText = this._extractMessageTextFromStreamItem(item);
        if (extractedText && !accumulator.textParts.length) {
          accumulator.fallbackText = extractedText;
        }
        continue;
      }
      if (item?.type === "reasoning") {
        const extractedReasoning = this._extractReasoningTextFromStreamItem(item);
        if (extractedReasoning && !accumulator.reasoningParts.length) {
          accumulator.fallbackReasoning = extractedReasoning;
        }
        continue;
      }
      if (item?.type === "function_call") {
        this._mergeStreamToolCall(accumulator, {
          itemId: item.id,
          id: item.call_id ?? item.id,
          name: item.name,
          arguments: item.arguments ?? ""
        });
      }
    }
  }

  _extractMessageTextFromStreamItem(item) {
    const contentList = Array.isArray(item?.content) ? item.content : [];
    const parts = [];
    for (const part of contentList) {
      if (typeof part?.text === "string" && part.text) {
        parts.push(part.text);
      }
    }
    return parts.join("");
  }

  _extractReasoningTextFromStreamItem(item) {
    const summaryList = Array.isArray(item?.summary) ? item.summary : [];
    const parts = [];
    for (const part of summaryList) {
      if (typeof part?.text === "string" && part.text) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("");
    }
    return typeof item?.text === "string" ? item.text : "";
  }
}
