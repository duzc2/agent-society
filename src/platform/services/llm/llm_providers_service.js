/**
 * LLM Provider 服务。
 *
 * 负责根据配置创建 AI SDK 模型实例，封装不同 provider（OpenAI、Anthropic、
 * Open Responses、Local Llama）的创建逻辑。
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { createLocalAiProvider } from "llama-cpp-provider/dist/src/index.js";

export class LlmProvidersService {
  /**
   * @param {{
   *   log: Logger,
   *   serviceId: string|null,
   *   fetchService: import("./llm_fetch_service.js").LlmFetchService
   * }} deps
   */
  constructor({ log, serviceId, fetchService }) {
    this._log = log;
    this._serviceId = serviceId;
    this._fetchService = fetchService;
  }

  /**
   * 根据配置创建对应的 AI SDK 模型实例。
   *
   * @param {any} config - 模型配置（provider, model, baseURL, apiKey, timeout 等）
   * @returns {any} AI SDK 模型实例
   */
  createModel(config) {
    void this._log.info(`[DEBUG] LlmClient._createModel`, {
      provider: config.provider,
      model: config.model,
      timeout: config.timeout
    });
    const provider = config.provider ?? "openai";
    const modelId = config.model ?? "gpt-4o";

    // 使用工厂函数创建 provider 实例，确保自定义配置生效
    // 默认导出的 openai/anthropic 实例使用默认配置（OpenAI/Anthropic 官方 API）
    switch (provider) {
      case "openai": {
        const openaiProvider = createOpenAI({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          // 使用自定义 fetch 包装器来设置超时和记录日志
          fetch: this._fetchService.createTimeoutFetch(config),
        });
        // 使用 .chat() 方法确保使用 Chat Completions API (/chat/completions)
        // provider() 默认使用 Responses API (/responses)，MiniMax 不支持
        const model = openaiProvider.chat(modelId);
        return model;
      }

      case "open-responses":
        return this.createOpenResponsesModel(config, modelId);

      case "anthropic": {
        const anthropicProvider = createAnthropic({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          // 使用自定义 fetch 包装器来设置超时
          fetch: this._fetchService.createTimeoutFetch(config),
        });
        return anthropicProvider(modelId);
      }

      case "local-llama":
        return createLocalAiProvider().languageModel(modelId);

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * 创建 Open Responses API 模型实例。
   *
   * @param {any} config
   * @param {string} modelId
   * @returns {any}
   */
  createOpenResponsesModel(config, modelId) {
    const responsesUrl = this.buildOpenResponsesUrl(config?.baseURL);
    const openResponsesProvider = createOpenResponses({
      name: config?.id ?? this._serviceId ?? "open-responses",
      url: responsesUrl,
      apiKey: config?.apiKey,
      fetch: this._fetchService.createTimeoutFetch(config),
    });

    return openResponsesProvider(modelId);
  }

  /**
   * 构建 Open Responses API 的 URL。
   *
   * @param {string|null} baseURL
   * @returns {string}
   */
  buildOpenResponsesUrl(baseURL) {
    const normalizedBaseUrl = String(baseURL ?? "").replace(/\/+$/, "");
    if (!normalizedBaseUrl) {
      throw new Error("Open Responses 配置无效：baseURL 不能为空");
    }
    if (/\/responses$/i.test(normalizedBaseUrl)) {
      return normalizedBaseUrl;
    }
    return `${normalizedBaseUrl}/responses`;
  }
}
