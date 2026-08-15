import { generateText, jsonSchema, tool } from "ai";
import { ConcurrencyController } from "./concurrency_controller.js";

import { ClientExchangeState } from "./client_exchange_state.js";
import { LlmRetryService } from "./llm_retry_service.js";
import { LlmResponseService } from "./llm_response_service.js";
import { LlmTruncationService } from "./llm_truncation_service.js";
import { LlmStreamService } from "./llm_stream_service.js";
import { LlmAugmentService, INTERNAL_REQUEST_AUGMENTATION_HEADER } from "./llm_augment_service.js";
import { LlmFetchService } from "./llm_fetch_service.js";
import { LlmProvidersService } from "./llm_providers_service.js";
import { MessageSnipService } from "./message_snip_service.js";
import { ToolResultCompressionService } from "./tool_result_aging_service.js";
import { getErrorMessage } from "../../utils/error_utils.js";

/**
 * LLM 客户端 - 使用 ai-sdk 统一接口
 */
export class LlmClient {
  constructor(options) {
    this.configService = options.configService;
    this.serviceId = options.serviceId ?? null;
    this.maxRetries = options.maxRetries ?? 3;
    this.log = options.logger;
    this._onRetry = options.onRetry;
    this._retryCoordinator = options.retryCoordinator;

    this._model = null;
    this._clientConfig = null;
    // 在构造函数中创建默认 ConcurrencyController，
    // 防止 abort/hasActiveRequest/getConcurrencyStats 等方法在 _ensureInitialized 之前被调用时崩溃
    this.concurrencyController = new ConcurrencyController(3, this.log);
    this._activeRequests = new Map();
    this._initialized = false;

    // ── DI 组件：替代旧的 Object.assign 混入模式 ──
    this._exchangeState = new ClientExchangeState();
    this._retryService = new LlmRetryService();
    this._responseService = new LlmResponseService();
    this._truncationService = new LlmTruncationService();
    this._streamService = new LlmStreamService({
      log: this.log,
      responseService: this._responseService
    });
    this._augmentService = new LlmAugmentService({
      exchangeState: this._exchangeState,
      resolveStreamFlag: this._resolveStreamFlag.bind(this)
    });
    this._fetchService = new LlmFetchService({
      log: this.log,
      exchangeState: this._exchangeState,
      augmentService: this._augmentService,
      streamService: this._streamService,
      resolveStreamFlag: this._resolveStreamFlag.bind(this)
    });
    this._providersService = new LlmProvidersService({
      log: this.log,
      serviceId: this.serviceId,
      fetchService: this._fetchService
    });
    this._snipService = new MessageSnipService();
    this._compressionService = new ToolResultCompressionService();
  }

  async _ensureInitialized() {
    void this.log.info(`[DEBUG] LlmClient._ensureInitialized called, initialized=${this._initialized}`);
    if (this._initialized) return;

    const config = await this._getConfigAsync();
    void this.log.info(`[DEBUG] LlmClient config loaded`, {
      baseURL: config?.baseURL,
      model: config?.model,
      timeout: config?.timeout
    });
    if (!config) {
      throw new Error("LLM 配置不存在");
    }

    this._model = this._providersService.createModel(config);
    this._clientConfig = { ...config };

    const maxConcurrent = config.maxConcurrentRequests ?? 3;
    await this.concurrencyController.updateMaxConcurrentRequests(maxConcurrent);

    this._initialized = true;
    void this.log.info(`[DEBUG] LlmClient initialization complete`);
  }


  async _getConfigAsync() {
    if (this.serviceId) {
      const { services } = await this.configService.getServices();
      const service = services.find(s => s.id === this.serviceId) ?? null;
      let defaultLlmConfig = null;
      if (typeof this.configService.getLlm === "function") {
        try {
          const llmResult = await this.configService.getLlm();
          defaultLlmConfig = llmResult?.llm ?? null;
        } catch (error) {
          void this.log.warn(`[DEBUG] _getConfigAsync failed to load default llm config`, {
            serviceId: this.serviceId,
            message: error?.message ?? String(error),
            stack: error?.stack,
            name: error?.name,
            code: error?.code
          });
        }
      }
      const mergedServiceConfig = service
        ? {
            ...defaultLlmConfig,
            ...service
          }
        : null;
      void this.log.info(`[DEBUG] _getConfigAsync Service config`, {
        id: mergedServiceConfig?.id,
        timeout: mergedServiceConfig?.timeout,
        maxContextTokens: mergedServiceConfig?.maxContextTokens
      });
      return mergedServiceConfig;
    } else {
      const { llm } = await this.configService.getLlm();
      void this.log.info(`[DEBUG] _getConfigAsync LLM config`, {
        baseURL: llm?.baseURL,
        timeout: llm?.timeout
      });
      return llm;
    }
  }

  _needsClientUpdate(config) {
    if (!this._clientConfig) return true;
    return (
      this._clientConfig.baseURL !== config?.baseURL ||
      this._clientConfig.apiKey !== config?.apiKey ||
      this._clientConfig.model !== config?.model ||
      this._clientConfig.provider !== (config?.provider ?? "openai") ||
      this._clientConfig.timeout !== config?.timeout ||
      this._resolveStreamFlag(this._clientConfig) !== this._resolveStreamFlag(config) ||
      this._clientConfig.id !== config?.id
    );
  }

  async _updateClient(config) {
    this._model = this._providersService.createModel(config);
    this._clientConfig = { ...config };
  }

  /**
   * 解析当前请求应使用的 temperature。
   * 规则：
   * 1. 显式传入的请求参数优先。
   * 2. 其次使用配置中的 temperature。
   * 3. 两者都没有时，不向 provider 传递该字段。
   * 这样可以避免客户端擅自注入默认采样参数，破坏不同后端的兼容性。
   * @param {any} input - 当前 chat 调用输入
   * @param {any} config - 当前生效配置
   * @returns {number|undefined}
   * @private
   */
  _resolveTemperature(input, config) {
    if (typeof input?.temperature === "number") {
      return input.temperature;
    }
    if (typeof config?.temperature === "number") {
      return config.temperature;
    }
    return undefined;
  }

  /**
   * 解析当前请求应使用的 stream 配置。
   * 设计约束：
   * 1. 历史配置缺失该字段时默认开启，满足必须要求 stream=true 的兼容服务；
   * 2. 只接受显式布尔值，避免字符串配置污染请求体；
   * 3. 请求层与设置页共享同一默认语义，避免界面展示与实际发送不一致。
   * @param {any} config - 当前生效配置
   * @returns {boolean}
   * @private
   */
  _resolveStreamFlag(config) {
    return typeof config?.stream === "boolean" ? config.stream : true;
  }


  async chat(input) {
    await this._ensureInitialized();

    const agentId = input?.meta?.agentId ?? null;
    const externalSignal = input?.abortSignal ?? null;

    const config = await this._getConfigAsync();
    if (!config) {
      throw new Error("LLM 配置不存在");
    }

    if (this._needsClientUpdate(config)) {
      await this._updateClient(config);
    }

    if (!agentId) {
      return this._executeChatRequestLegacy(input, config, externalSignal);
    }

    return this.concurrencyController.executeRequest(
      agentId,
      () => this._executeChatRequest(input, config, externalSignal)
    );
  }

  async _executeChatRequestLegacy(input, config, externalSignal = null) {
    const agentId = input?.meta?.agentId ?? null;
    const abortController = externalSignal ? null : new AbortController();
    const signal = externalSignal ?? abortController.signal;

    if (agentId && abortController) {
      this._activeRequests.set(agentId, abortController);
    }

    try {
      return await this._chatWithRetry(input, this.maxRetries, signal, config);
    } finally {
      if (agentId && abortController) {
        this._activeRequests.delete(agentId);
      }
    }
  }

  async _executeChatRequest(input, config, externalSignal = null) {
    const agentId = input?.meta?.agentId ?? null;
    const abortController = externalSignal ? null : new AbortController();
    const signal = externalSignal ?? abortController.signal;

    if (agentId && abortController) {
      this._activeRequests.set(agentId, abortController);
    }

    try {
      return await this._chatWithRetry(input, this.maxRetries, signal, config);
    } finally {
      if (agentId && abortController) {
        this._activeRequests.delete(agentId);
      }
    }
  }


  async _logChunkedJson(meta, tag, data) {
    if (process.env.LLM_DEBUG_DUMP !== "true") {
      return;
    }
    let serialized = "";
    try {
      serialized = JSON.stringify(data);
    } catch (error) {
      serialized = JSON.stringify({ error: error?.message ?? String(error) });
    }
    const chunkSize = 280;
    const totalChunks = Math.max(1, Math.ceil(serialized.length / chunkSize));
    for (let i = 0; i < totalChunks; i++) {
      const chunk = serialized.slice(i * chunkSize, (i + 1) * chunkSize);
      await this.log.info(`[DEBUG ${tag} ${i + 1}/${totalChunks}] ${chunk}`, { meta });
    }
  }

  /**
   * 将 OpenAI 格式工具转换为 ai-sdk 格式
   * ai-sdk 需要 Record<string, Tool> 格式，而不是数组
   * @param {any[]} openaiTools - OpenAI 格式工具数组
   * @returns {Record<string, any>} ai-sdk 格式工具对象
   */
  _convertToolsToAiSdkFormat(openaiTools) {
    if (!Array.isArray(openaiTools) || openaiTools.length === 0) {
      return undefined;
    }

    const aiSdkTools = {};
    const toolEntries = openaiTools.filter(t => t.type === "function" && t.function);
    for (let i = 0; i < toolEntries.length; i++) {
      const func = toolEntries[i].function;
      const isLast = i === toolEntries.length - 1;
      aiSdkTools[func.name] = tool({
        description: func.description || "",
        inputSchema: jsonSchema(func.parameters || { type: "object", properties: {} }),
        ...(isLast ? {
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } }
          }
        } : {}),
        // 不设置 execute，让模型只返回工具调用而不自动执行
      });
    }
    return aiSdkTools;
  }

  _supportsToolCalling(config) {
    const outputCapabilities = Array.isArray(config?.capabilities?.output)
      ? config.capabilities.output
      : null;
    if (outputCapabilities) {
      return outputCapabilities.includes("tool_calling");
    }
    const capabilityTags = Array.isArray(config?.capabilityTags) ? config.capabilityTags : null;
    if (capabilityTags) {
      return capabilityTags.includes("tool_calling");
    }
    return true;
  }

  _isCapabilityToolInvocation(meta) {
    const toolName = meta?.toolName;
    return typeof toolName === "string" && /^call_[a-z0-9_]+_model$/i.test(toolName);
  }


  async _chatWithRetry(input, maxRetries, signal, config) {
    const meta = input?.meta ?? null;

    const maxContextTokens = config.maxContextTokens ?? 128000;

    // 从 input.system 提取 system 字符串（不再混入 messages 数组）
    const systemStr = typeof input.system === "string" && input.system.trim()
      ? input.system.trim()
      : null;

    // 手动估算 system tokens（用于 token budget 计算）
    const systemTokens = systemStr
      ? this._truncationService.estimateMessageTokens({ role: "system", content: systemStr })
      : 0;

    // Respect capability gating before calculating the token budget.
    // Only tools that will actually be sent may consume prompt space, otherwise history can be truncated incorrectly.
    const supportsToolCalling = this._supportsToolCalling(config);
    const tools = input.tools;
    const shouldSendTools = Array.isArray(input.tools)
      && input.tools.length > 0
      && supportsToolCalling;
    const toolsTokens = shouldSendTools ? this._truncationService.estimateToolsTokens(tools) : 0;

    // Reserve buffer for request overhead (tools serialization, system prompt, etc.)
    // so messages don't consume the full context window.
    const availableTokensForMessages = Math.max(
      0,
      maxContextTokens - systemTokens - toolsTokens - 500
    );

    // Log the effective token budget after the capability gate is applied.
    void this.log.info(`[Token Limit] Token budget details`, {
      meta,
      maxContextTokens,
      systemTokens,
      toolsTokens,
      buffer: 500,
      availableTokensForMessages,
      supportsToolCalling,
      shouldSendTools
    });

    const originalMessages = input.messages;

    // 预处理管道：snip → compress，在截断之前清理无用内容、截断过长工具结果
    const { messages: snippedMessages, stats: snipStats } = this._snipService.filter(originalMessages);
    const { messages: compressedMessages, stats: compressStats } = this._compressionService.compress(snippedMessages);

    if (snipStats.emptyToolResults > 0 || snipStats.rejectedOps > 0 || snipStats.orphansRemoved > 0 || compressStats.compressedCount > 0) {
      void this.log.info("[LLM Preprocess] 预处理完成", {
        meta,
        originalCount: originalMessages.length,
        snippedCount: snippedMessages.length,
        compressedCount: compressedMessages.length,
        snip: snipStats,
        compress: compressStats
      });
    }

    const { messages: truncatedMessages, stats: truncateStats } = this._truncationService.truncateMessagesForContextWindow(
      compressedMessages,
      availableTokensForMessages
    );

    if (truncateStats.droppedCount > 0 || availableTokensForMessages < 2000) {
      void this.log.info(`[Token Limit] Context truncation result`, {
        meta,
        ...truncateStats,
        maxContextTokens,
        systemTokens,
        toolsTokens,
        availableTokensForMessages,
        supportsToolCalling,
        shouldSendTools
      });
    }

    // 动态计算输出 token 上限：用模型上下文窗口减去实际估算的输入 token 数，
    // 使输出上限自适应不同模型的上下文长度（128K / 200K / 1M 等）。
    const estimatedInputTokens =
      (truncateStats.estimatedSystemTokens ?? 0) +
      (truncateStats.estimatedNonSystemTokens ?? 0) +
      systemTokens +
      toolsTokens +
      1000; // formatting / reasoning prefix overhead
    // 调用方可传入 input.maxTokens 覆盖自动计算的输出上限
    const maxOutputTokens = typeof input.maxTokens === 'number'
      ? input.maxTokens
      : Math.max(512, maxContextTokens - estimatedInputTokens);

    void this.log.info(`[Token Limit] Output budget calculated`, {
      meta,
      maxContextTokens,
      systemTokens,
      estimatedSystemTokens: truncateStats.estimatedSystemTokens ?? 0,
      estimatedNonSystemTokens: truncateStats.estimatedNonSystemTokens ?? 0,
      toolsTokens,
      overhead: 1000,
      estimatedInputTokens,
      maxOutputTokens
    });

    // thinking 内容在格式化阶段按消息粒度条件性追加：有 tool_calls 的 assistant 消息
    // 才携带 reasoning_content，无 tool_calls 的 assistant 消息不携带（符合 DeepSeek API 要求）。
    // 不再需要独立的"剥离缺失 thinking 块"阶段。
    let cleanedMessages = truncatedMessages;

    const currentMessage = cleanedMessages.length > 0 ? cleanedMessages[cleanedMessages.length - 1] : null;

    // Convert OpenAI-style tool definitions to ai-sdk format only when needed.
    if (process.env.LLM_DEBUG_DUMP === 'true') {
      await this.log.debug("LLM request payload", {
        meta,
        payload: {
          model: config.model,
          tool_names: shouldSendTools && Array.isArray(tools) ? tools.map((t) => t?.function?.name).filter(Boolean) : [],
          current_message: currentMessage
        }
      });
    }

    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        const abortError = new Error("LLM 请求已被中断");
        abortError.name = "AbortError";
        void this.log.info("LLM 请求在开始前已被中断", { meta, attempt: attempt + 1 });
        throw abortError;
      }

      const startTime = Date.now();
      try {
        // 安全网：过滤掉 messages 中残留的 system 角色消息
        // system 应通过 generateText({ system }) 选项传递，不应混入 messages 数组
        if (cleanedMessages.length > 0 && cleanedMessages[0]?.role === "system") {
          cleanedMessages = cleanedMessages.slice(1);
        }

        // 最终 tool 配对校验：移除任何缺少匹配 assistant tool_call 的 tool 消息。
        // 前置处理（snip/age/truncation/stripReasoning）可能在某些边界场景下
        // 遗留孤立的 tool_result，Anthropic 等严格 API 会拒绝此类请求。
        {
          const postValidToolIds = new Set();
          for (const msg of cleanedMessages) {
            if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                if (tc.id) postValidToolIds.add(tc.id);
              }
            }
          }
          const preCheckCount = cleanedMessages.length;
          cleanedMessages = cleanedMessages.filter(
            m => m.role !== "tool" || !m.tool_call_id || postValidToolIds.has(m.tool_call_id)
          );
          const droppedToolCount = preCheckCount - cleanedMessages.length;
          if (droppedToolCount > 0) {
            void this.log.warn("[LLM] 隔离了缺少匹配 tool_call 的孤立 tool 结果", {
              meta,
              droppedToolCount
            });
          }
        }

        // 同一次 tool_use 只允许一个 tool_result。历史持久化或并发边界可能产生
        // 相同 tool_call_id 的多条 tool 消息；Anthropic 等严格 provider 会拒绝
        // 这种请求，因此必须在发送前移除重复结果，只保留第一次出现的结果。
        {
          const seenToolResultIds = new Set();
          const duplicateToolResultIds = [];
          const beforeDedupeCount = cleanedMessages.length;
          cleanedMessages = cleanedMessages.filter((msg) => {
            if (msg.role !== "tool" || !msg.tool_call_id) {
              return true;
            }
            if (seenToolResultIds.has(msg.tool_call_id)) {
              duplicateToolResultIds.push(msg.tool_call_id);
              return false;
            }
            seenToolResultIds.add(msg.tool_call_id);
            return true;
          });
          const duplicateToolResultCount = beforeDedupeCount - cleanedMessages.length;
          if (duplicateToolResultCount > 0) {
            void this.log.warn("[LLM] 移除了重复的 tool_result", {
              meta,
              duplicateToolResultCount,
              duplicateToolResultIds: duplicateToolResultIds.slice(0, 20)
            });
          }
        }

        // 确保消息 content 符合 ai-sdk zod schema 要求：
        // - string → 透传
        // - null/undefined → ""
        // - ai-sdk 内容块数组 (如 [{type:"text", text, providerOptions}]) → 透传
        // - 普通 object → JSON.stringify（不是内容块数组）
        // - 数字/布尔等原始值 → String()
        const normalizeMessageContent = (val) => {
          if (val == null) return "";
          if (typeof val === "string") return val;
          // ai-sdk content block arrays: non-empty arrays of objects
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
            return val;
          }
          return typeof val === "object" ? JSON.stringify(val) : String(val);
        };

        // 转换消息格式以符合 ai-sdk 要求
        const formattedMessages = cleanedMessages.map(msg => {
          // Assistant 消息且有 tool_calls → 按 DeepSeek API 要求，有 tool_calls 的 assistant
          // 消息必须包含 reasoning_content（含 signature）。无 tool_calls 的 assistant 消息
          // 不携带 thinking，以节省 token 并符合 API 规则。
          if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
            // 构建 reasoning content parts
            const reasoningContentParts = [];
            if (msg.reasoning_content) {
              const reasoningPart = { type: "reasoning", text: msg.reasoning_content };
              if (msg.reasoningProviderMetadata) {
                reasoningPart.providerOptions = msg.reasoningProviderMetadata;
              }
              reasoningContentParts.push(reasoningPart);
            }

            const toolParts = msg.tool_calls.map(tc => {
              let parsedInput = {};
              try {
                // 防御性解析，避免 JSON Parse error
                if (typeof tc.function?.arguments === 'string') {
                    parsedInput = JSON.parse(tc.function.arguments);
                } else if (typeof tc.function?.arguments === 'object') {
                    parsedInput = tc.function.arguments;
                }
              } catch (e) {
                void this.log.warn("解析工具参数失败", {
                  // 业务信息：哪个 agent 的消息中哪个工具参数解析失败
                  agentId: meta?.agentId ?? null,
                  toolName: tc.function?.name,
                  // 技术信息：参数内容和异常详情
                  args: tc.function?.arguments,
                  error: e?.message ?? String(e),
                  stack: e?.stack,
                  name: e?.name,
                  code: e?.code
                });
              }
              return {
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.function?.name ?? "",
                input: parsedInput
              };
            });

            // 如果有文本内容，将文本和工具调用组合在一起
            if (msg.content) {
                // msg.content 可能是 string 或 ai-sdk 内容块数组（来自 cacheControl 预处理）
                const textContentBlocks = Array.isArray(msg.content)
                    ? msg.content
                    : [{ type: "text", text: msg.content }];
                return {
                    role: "assistant",
                    content: [
                        ...reasoningContentParts,
                        ...textContentBlocks,
                        ...toolParts
                    ]
                };
            }

            // 否则直接返回工具调用数组（ai-sdk 格式）
            return {
              role: "assistant",
              content: [
                ...reasoningContentParts,
                ...toolParts
              ]
            };
          }

          // Assistant 消息（无 tool_calls）→ 不携带 reasoning，只传纯文本
          if (msg.role === "assistant") {
            return {
              role: "assistant",
              content: normalizeMessageContent(msg.content)
            };
          }

          // Tool 消息 → 转换为 ai-sdk tool-result 格式
          if (msg.role === "tool") {
            const toolContent = normalizeMessageContent(msg.content);
            // 若 content 已被转换为内容块数组（来自 cacheControl 预处理），提取文本
            const toolOutputValue = Array.isArray(toolContent)
              ? toolContent.filter(b => b.type === "text").map(b => b.text).join("\n")
              : toolContent;
            const toolCallId = msg.tool_call_id || `unmatched-${Date.now()}`;
            const toolName = msg.name ?? "";
            return {
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId,
                toolName,
                output: {
                  type: "text",
                  value: toolOutputValue
                }
              }]
            };
          }
          // 普通消息
          return {
            role: msg.role,
            content: normalizeMessageContent(msg.content)
          };
        });

        const retryVariance = this._retryService.buildRetryVarianceForEmptyResponse(attempt, lastError, formattedMessages);
        const requestMessages = retryVariance?.messages ?? formattedMessages;
        const requestTemperature = this._resolveTemperature(input, config);

        // 是否支持工具调用都应检查配置，不支持的模型不发送工具定义
        const aiSdkTools = shouldSendTools ? this._convertToolsToAiSdkFormat(input.tools) : undefined;

        // 从配置中读取超时时间，默认30分钟（1800000毫秒）
        const timeoutMs = config.timeout ?? 1800000;

        // 【调试】打印请求详情
        void this.log.info('[DEBUG] LlmClient.generateText', {
          model: config.model,
          baseURL: config.baseURL,
          messageCount: requestMessages.length,
          messageRoles: requestMessages.map((message) => message?.role ?? "unknown"),
          hasTools: !!input.tools && input.tools.length > 0,
          supportsToolCalling,
          aiSdkToolCount: Object.keys(aiSdkTools ?? {}).length,
          temperature: requestTemperature,
          timeoutMs,
          retryVariance: retryVariance ?? null
        });
        await this._logChunkedJson(meta, "BEFORE_RETURN_REQUEST", {
          model: config.model,
          ...(requestTemperature !== undefined ? { temperature: requestTemperature } : {}),
          supportsToolCalling,
          shouldSendTools,
          retryVariance: retryVariance ?? null,
          messages: requestMessages,
          tools: Array.isArray(input.tools) ? input.tools : []
        });

        const requestAugmentation = this._augmentService.buildAssistantToolReasoningAugmentation(cleanedMessages);
        const requestAugmentationId = requestAugmentation
          ? this._augmentService.registerRequestBodyAugmentation(requestAugmentation)
          : null;

        let result;
        try {
          // 将动态计算的输出 token 上限存入实例，供 fetch 层覆盖 ai-sdk 内部的默认值
          this._exchangeState.maxTokensOverride = maxOutputTokens;
          result = await generateText({
            model: this._model,
            messages: requestMessages,
            // 缓存断点 1/4：system prompt 使用 Anthropic ephemeral cache
            ...(systemStr ? {
              system: [{
                role: "system",
                content: systemStr,
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral" } }
                }
              }]
            } : {}),
            maxTokens: maxOutputTokens,
            ...(aiSdkTools ? { tools: aiSdkTools } : {}),
            ...(requestTemperature !== undefined ? { temperature: requestTemperature } : {}),
            ...(requestAugmentationId
              ? {
                  headers: {
                    [INTERNAL_REQUEST_AUGMENTATION_HEADER]: requestAugmentationId
                  }
                }
              : {}),
            ...(config.thinking && config.thinking.type !== "disabled"
              ? {
                  providerOptions: config.provider === "anthropic"
                    ? {
                        anthropic: {
                          thinking: {
                            type: config.thinking.type,
                            ...(config.thinking.type === "enabled"
                              ? { budgetTokens: (config.thinking.budgetTokens >= 1024 ? config.thinking.budgetTokens : 16000) }
                              : (config.thinking.budgetTokens ? { budgetTokens: config.thinking.budgetTokens } : {}))
                          },
                          ...(config.thinking.effort ? { output_config: { effort: config.thinking.effort } } : {})
                        }
                      }
                    : { openai: { reasoningEffort: "medium", ...(config.thinking.budgetTokens ? { maxReasoningTokens: config.thinking.budgetTokens } : {}) } }
                }
              : {}),
            abortSignal: signal,
          });
        } finally {
          this._exchangeState.maxTokensOverride = null;
          this._augmentService.clearRequestBodyAugmentation(requestAugmentationId);
        }

        const { text, usage, toolCalls, finishReason } = result;

        const latencyMs = Date.now() - startTime;
        const normalizedUsage = this._responseService.normalizeUsage(usage);
        const promptTokens = normalizedUsage.promptTokens;
        const completionTokens = normalizedUsage.completionTokens;
        const totalTokens = normalizedUsage.totalTokens;

        await this.log.info("LLM Token 使用信息", {
          meta,
          usage,
          promptTokens,
          completionTokens,
          totalTokens,
          finishReason,
          hasUsage: !!usage,
          hasToolCalls: !!toolCalls && toolCalls.length > 0,
          toolCallCount: toolCalls?.length ?? 0
        });

        const msg = this._responseService.buildAssistantMessage({
          text,
          reasoning: result?.reasoningText ?? null,
          // reasoningDetails (ai-sdk v4+) 优先于 reasoning，前者更可能包含 Anthropic thinking 签名
          reasoningParts: result?.reasoningDetails ?? result?.reasoning,
          toolCalls: Array.isArray(toolCalls)
            ? toolCalls.map((tc) => ({
                id: tc.toolCallId,
                name: tc.toolName,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input)
              }))
            : [],
          usage: { promptTokens, completionTokens, totalTokens },
          finishReason
        });

        await this.log.info("LLM 响应内容", { meta, message: msg });
        await this._logChunkedJson(meta, "BEFORE_RETURN_RESPONSE", {
          message: msg
        });

        await this._logLlmMetrics({
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          success: true,
          model: config.model ?? "unknown"
        }, meta);

        return msg;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        lastError = err;
        const text = getErrorMessage(err);
        const errorType = err?.name ?? "UnknownError";
        const errorCode = err?.code ?? null;
        const lastHttpExchange = this._exchangeState.lastHttpExchange;

        void this.log.error("LLM 请求失败", {
          // 业务信息：哪个 agent 的第几次尝试在哪个模型上失败
          agentId: meta?.agentId ?? null,
          attempt: attempt + 1,
          maxRetries,
          latencyMs,
          // 触发参数：发送给 LLM 的请求摘要
          model: config.model ?? "unknown",
          messageCount: cleanedMessages.length,
          originalMessageCount: originalMessages?.length ?? 0,
          sentTools: shouldSendTools && Array.isArray(tools) ? tools.map((t) => t?.function?.name).filter(Boolean).slice(0, 20) : [],
          hasThinkingStripped: false,
          estimatedInputTokens: truncateStats?.estimatedNonSystemTokens ?? null,
          // 技术信息：HTTP 层面错误详情
          errorType,
          message: text,
          url: err?.url || 'unknown',
          statusCode: err?.statusCode || err?.response?.status || 'unknown',
          responseBody: err?.responseBody || err?.response?.body || 'unknown',
          // 原始错误的完整信息
          name: err?.name,
          code: err?.code,
          stack: err?.stack
        });

        // 若是 429 响应，通知 RetryCoordinator 记录，用于全局限流判断
        const statusCode = err?.statusCode || err?.response?.status || err?.status;
        if (statusCode === 429 && meta?.agentId) {
          this._retryCoordinator.record429(meta.agentId);
        }

        if (this._retryService.shouldTreatAsAbortError(err, signal)) {
          void this.log.info("LLM 请求已被中断", {
            meta,
            attempt: attempt + 1,
            latencyMs,
            errorMessage: text
          });
          const abortError = new Error("LLM 请求已被中断");
          abortError.name = "AbortError";
          throw abortError;
        }

        const streamFallbackMsg = this._streamService.buildAssistantMessageFromStreamResponse(lastHttpExchange?.response?.body);
        if (streamFallbackMsg) {
          const streamUsage = this._responseService.normalizeUsage(streamFallbackMsg._usage);
          await this.log.info("检测到流式响应，已在接收侧拼装为非流式结果", {
            meta,
            attempt: attempt + 1,
            errorType,
            errorMessage: text,
            promptTokens: streamUsage.promptTokens,
            completionTokens: streamUsage.completionTokens,
            totalTokens: streamUsage.totalTokens,
            hasToolCalls: Array.isArray(streamFallbackMsg.tool_calls) && streamFallbackMsg.tool_calls.length > 0
          });
          await this._logChunkedJson(meta, "STREAM_FALLBACK_RESPONSE", {
            message: streamFallbackMsg
          });
          await this._logLlmMetrics({
            latencyMs,
            promptTokens: streamUsage.promptTokens,
            completionTokens: streamUsage.completionTokens,
            totalTokens: streamUsage.totalTokens,
            success: true,
            model: config.model ?? "unknown"
          }, meta);
          return streamFallbackMsg;
        }

        await this._logLlmMetrics({
          latencyMs,
          success: false,
          model: config.model ?? "unknown",
          errorType,
          errorMessage: text
        }, meta);

        if (meta?.agentId) {
          const isLastAttempt = attempt >= maxRetries - 1;
          const delayMs = isLastAttempt ? 0 : Math.pow(2, attempt) * 1000;
          try {
            this._onRetry({
              agentId: meta.agentId,
              attempt: attempt + 1,
              maxRetries,
              delayMs,
              errorMessage: text,
              isFinalFailure: isLastAttempt,
              timestamp: new Date().toISOString()
            });
          } catch (retryErr) {
            void this.log.warn("触发重试事件失败", {
              agentId: meta?.agentId ?? null,
              attempt: attempt + 1,
              maxRetries,
              error: retryErr?.message ?? String(retryErr),
              stack: retryErr?.stack,
              name: retryErr?.name,
              code: retryErr?.code
            });
          }
        }

        if (attempt >= maxRetries - 1) {
          void this.log.error("LLM 请求失败（已达最大重试次数）", {
            meta,
            message: text,
            errorType,
            errorCode,
            attempt: attempt + 1,
            maxRetries,
            stack: err?.stack ?? null,
            // 【调试】打印关键配置参数，帮助排查配置问题
            config: {
              provider: config.provider ?? "openai",
              model: config.model ?? "gpt-4o",
              baseURL: config.baseURL ?? "未设置（将使用默认值）",
              apiKey: config.apiKey ? "已配置" : "未设置",
              maxContextTokens: config.maxContextTokens ?? "未设置"
            },
            lastHttpExchange
          });
          throw err;
        }

        const delayMs = Math.pow(2, attempt) * 1000;
        void this.log.warn("LLM 调用失败，重试中", {
          meta,
          message: text,
          errorType,
          errorCode,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          stack: err?.stack ?? null,
          lastHttpExchange,
          // 【调试】首次重试时打印配置参数
          ...(attempt === 0 ? {
            config: {
              provider: config.provider ?? "openai",
              model: config.model ?? "gpt-4o",
              baseURL: config.baseURL ?? "未设置（将使用默认值）",
              apiKey: config.apiKey ? "已配置" : "未设置"
            }
          } : {})
        });

        await this._retryService.sleep(delayMs, signal);
      }
    }

    throw lastError;
  }


  /**
   * 记录LLM调用指标。
   * @param {{latencyMs:number, promptTokens?:number, completionTokens?:number, totalTokens?:number, success:boolean, model?:string, errorType?:string, errorMessage?:string}} metrics
   * @param {{agentId?:string, roleId?:string, roleName?:string, messageId?:string, taskId?:string}} [meta]
   */
  async _logLlmMetrics(metrics, meta) {
    const message = metrics.success ? "LLM调用成功" : "LLM调用失败";
    const data = {
      ...meta,
      eventType: metrics.success ? "llm_call_success" : "llm_call_error",
      latencyMs: metrics.latencyMs,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      totalTokens: metrics.totalTokens,
      model: metrics.model
    };
    if (metrics.success) {
      void this.log.info(message, data);
    } else {
      void this.log.error(message, data);
    }
  }

  /**
   * 简化版 LLM 调用：不走重试、不走并发控制、非流式。
   * 用于心情请求等轻量级旁路调用。
   * @param {{messages: any[], system?: string, tools?: any[], toolChoice?: string|object}} input
   * @returns {Promise<object>}
   */
  async chatSimple({ messages, system, tools, toolChoice }) {
    await this._ensureInitialized();
    const config = await this._getConfigAsync();
    const aiSdkTools = Array.isArray(tools) && tools.length > 0
      ? this._convertToolsToAiSdkFormat(tools)
      : undefined;

    // 与 chat() 一致的 token 预算计算
    const maxContextTokens = config.maxContextTokens ?? 128000;
    const systemStr = typeof system === "string" ? system.trim() : "";
    const systemTokens = systemStr
      ? this._truncationService.estimateMessageTokens({ role: "system", content: systemStr })
      : 0;
    const toolsTokens = Array.isArray(tools) && tools.length > 0
      ? this._truncationService.estimateToolsTokens(tools)
      : 0;
    const messageTokens = Array.isArray(messages)
      ? this._truncationService.estimateMessagesTokens(messages)
      : 0;
    const maxOutputTokens = Math.max(512, maxContextTokens - systemTokens - toolsTokens - messageTokens);

    const prevOverride = this._exchangeState.maxTokensOverride;
    this._exchangeState.maxTokensOverride = maxOutputTokens;
    try {
      const result = await generateText({
        model: this._model,
        messages,
        ...(system ? { system } : {}),
        ...(aiSdkTools ? { tools: aiSdkTools, toolChoice: toolChoice ?? "auto" } : {}),
      });
      return this._responseService.buildAssistantMessage(result);
    } finally {
      this._exchangeState.maxTokensOverride = prevOverride;
    }
  }

  abort(agentId) {
    let cancelled = false;

    const controller = this._activeRequests.get(agentId);
    if (controller) {
      controller.abort();
      this._activeRequests.delete(agentId);
      cancelled = true;
    }

    if (!this.concurrencyController) {
      void this.log.error("[LlmClient.abort] concurrencyController 未初始化", {
        agentId,
        hasActiveRequests: this._activeRequests.size > 0,
        initialized: this._initialized
      });
      return cancelled;
    }

    try {
      const activeRequest = this.concurrencyController.activeRequests.get(agentId);
      if (activeRequest && activeRequest.abortController) {
        activeRequest.abortController.abort();
      }

      this.concurrencyController.cancelRequest(agentId).catch(() => { return false; });
      cancelled = true;
    } catch (err) {
      void this.log.error("[LlmClient.abort] 中止并发控制器请求时出错", {
        agentId,
        error: err?.message ?? String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
    }

    return cancelled;
  }

  hasActiveRequest(agentId) {
    if (!this.concurrencyController) {
      void this.log.warn("[LlmClient.hasActiveRequest] concurrencyController 未初始化", { agentId });
      return this._activeRequests.has(agentId);
    }
    const hasActiveInController = this.concurrencyController.hasActiveRequest(agentId);
    const hasActiveInLegacy = this._activeRequests.has(agentId);
    return hasActiveInController || hasActiveInLegacy;
  }

  async updateMaxConcurrentRequests(maxConcurrentRequests) {
    if (!this.concurrencyController) {
      void this.log.warn("[LlmClient.updateMaxConcurrentRequests] concurrencyController 未初始化", {
        requestedMaxConcurrent: maxConcurrentRequests
      });
      return;
    }
    await this.concurrencyController.updateMaxConcurrentRequests(maxConcurrentRequests);
  }

  getConcurrencyStats() {
    if (!this.concurrencyController) {
      void this.log.warn("[LlmClient.getConcurrencyStats] concurrencyController 未初始化");
      return { activeCount: 0, queueLength: 0, totalRequests: 0, completedRequests: 0, rejectedRequests: 0 };
    }
    return this.concurrencyController.getStats();
  }

}
