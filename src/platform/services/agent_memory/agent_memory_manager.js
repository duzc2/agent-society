/**
 * AgentMemoryManager - 智能体记忆管理器
 * 
 * 负责管理所有智能体的 AgentMemory 实例，包括：
 * - 初始化记忆系统配置
 * - 为每个智能体创建/获取独立的 AgentMemory 实例
 * - 管理记忆系统生命周期（关闭、清理）
 * - 全局错误处理和日志记录
 * 
 * 支持多种 LLM Provider：
 * - 本地模型（llama-cpp-provider）：配置 modelPath
 * - OpenAI 兼容 API：配置 provider="openai" + baseUrl + model
 * - Anthropic API：配置 provider="anthropic" + baseUrl + model
 * - 其他 ai-sdk 兼容 provider
 * 
 * @module services/agent_memory/agent_memory_manager
 */

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { createLocalAiProvider } from "llama-cpp-provider/dist/src/index.js";
import { LocalLlamaProvider } from "llama-cpp-provider/dist/src/provider/local-llama-provider.js";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { AgentMemory } from "hmemory";
import { generateText, jsonSchema, stepCountIs } from 'ai';
import { MemoryExtractor } from 'hmemory/agent-memory';

// ===== Monkey-patch hmemory MemoryExtractor: 使用工具调用替代 JSON =====
const _originalCallLLM = MemoryExtractor.prototype.callLLM;

// 替换 callLLM：添加工具定义，解析工具调用结果。失败时回退原始方法
MemoryExtractor.prototype.callLLM = async function(messages) {
  const endTimer = this.logger.timer('MemoryExtractor', 'callLLM');

  try {
    // 获取当前实体列表和对话摘要
    const entitiesText = this.entityTracker.getEntitiesPromptText();
    const summaryText = this.summarizer.getSummaryText();

    // 构建对话文本（包含说话者名称）
    const conversationText = messages
      .map(msg => {
        const speaker = msg.name || msg.role;
        let text = `${speaker}: ${msg.content}`;
        if (msg.attachments?.length) {
          text += `\n[Attachments: ${msg.attachments.join(', ')}]`;
        }
        return text;
      })
      .join('\n\n');

    // 构建工具方式的系统 Prompt（不用 JSON，用工具）
    const systemPrompt = `你是一个记忆提炼助手。从对话中提取有价值的记忆信息。

## 前文摘要
以下是对话的历史摘要，帮助理解当前对话的上下文：

${summaryText}

## 已知实体列表
以下是在之前的对话中已经识别出的实体。请在处理当前对话时参考：

${entitiesText}

## 代词消解规则
在提取记忆时，必须将所有代词替换为具体实体名称：
1. "我/我们" → 替换为说话者名称
2. "你/你们" → 替换为对话对象名称
3. "他/她/它/他们" → 根据上下文，从已知实体或前文摘要中选择最可能的一个
4. 如果指代不明，保留原代词并添加 [指代不明] 标记

## 工作方式

你必须调用 \`record_memories\` 工具来提交提取的记忆。
每条记忆是一段自然语言叙述，要求：
- 使用第三人称客观叙述
- 保留关键细节（数字、时间、地点、原因、结果等）
- 所有代词必须替换为具体实体名称
- 200字以内
- 如果没有可提取的记忆，调用工具并传入空数组 []`;

    this.logger.info('MemoryExtractor', 'callLLM', '=== System Prompt (tool-based) ===');
    this.logger.info('MemoryExtractor', 'callLLM', systemPrompt.substring(0, 1000));
    this.logger.info('MemoryExtractor', 'callLLM', '=== User Content ===');
    this.logger.info('MemoryExtractor', 'callLLM', conversationText.substring(0, 2000));
    this.logger.info('MemoryExtractor', 'callLLM', '=== End Prompt ===');

    this.logger.info('MemoryExtractor', 'callLLM', 'Calling LLM with record_memories tool');

    const result = await generateText({
      model: this.model,
      system: systemPrompt,
      messages: [
        { role: 'user', content: conversationText },
      ],
      temperature: this.temperature,
      tools: {
        record_memories: {
          description: '记录从对话中提取的记忆',
          inputSchema: jsonSchema({
            type: 'object',
            properties: {
              contents: {
                type: 'array',
                items: { type: 'string' },
                description: '记忆内容字符串数组，每条200字以内'
              }
            },
            required: ['contents']
          })
        }
      },
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      // 记忆提取不需要思考，禁用 DeepSeek thinking 模式
      providerOptions: {
        anthropic: {
          thinking: { type: "disabled" }
        }
      }
    });

    const toolCalls = result.toolCalls;
    if (toolCalls?.length > 0) {
      const input = toolCalls[0].input;
      const contents = input?.contents || [];
      this.logger.info('MemoryExtractor', 'callLLM', `Tool returned ${contents.length} memories`);

      if (contents.length > 0) {
        contents.forEach((content, i) => {
          this.logger.info('MemoryExtractor', 'callLLM', `Memory #${i + 1}: [knowledge] ${content.substring(0, 80)}`);
        });
      }

      endTimer('LLM call successful (tool)');
      return {
        memories: contents.map(content => ({
          category: 'knowledge',
          summary: content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 30),
          content: content,
          keywords: []
        })),
        entityUpdates: [],
        summaryUpdate: null
      };
    }

    // 无工具调用时，回退原始方法
    this.logger.warn('MemoryExtractor', 'callLLM', 'No tool calls, falling back to original callLLM');
    endTimer('Falling back to original');
    return await _originalCallLLM.call(this, messages);
  } catch (error) {
    // 工具调用失败时，不再回退原始JSON路径（DeepSeek返回散文时同样会JSON.parse崩溃）
    // 返回空记忆，避免永久丢失该批次
    this.logger.warn('MemoryExtractor', 'callLLM', 'Tool-based call failed, returning empty memories', {
      error: error?.message || String(error),
      messageCount: messages.length,
    });
    endTimer('Tool-based call failed (empty return)');
    return {
      memories: [],
      entityUpdates: [],
      summaryUpdate: null
    };
    // 以下为原来的回退逻辑，保留以供将来 hmemory 原始路径修复后恢复：
    // endTimer('Tool-based call failed, falling back to original');
    // this.logger.warn('MemoryExtractor', 'callLLM', 'Tool-based call failed, falling back to original callLLM', {
    //   error: error?.message || String(error),
    //   messageCount: messages.length,
    // });
    // // 回退原始 JSON 方式 — hmemory 升级后如果内部结构变了，这里也可能失败
    // // 但至少不会静默吞记忆，错误会沿原始 errorReporter 路径上报
    // try {
    //   return await _originalCallLLM.call(this, messages);
    // } catch (fallbackError) {
    //   this.logger.error('MemoryExtractor', 'callLLM', 'Original callLLM fallback also failed', {
    //     toolError: error?.message || String(error),
    //     fallbackError: fallbackError?.message || String(fallbackError),
    //     stack: fallbackError?.stack,
    //     messageCount: messages.length,
    //   });
    //   this.errorReporter.report({
    //     module: 'MemoryExtractor',
    //     operation: 'callLLM',
    //     originalError: fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
    //     category: 'UNKNOWN',
    //     context: {
    //       timestamp: new Date().toISOString(),
    //       messageCount: messages.length,
    //     },
    //   });
    //   return null;
    // }
  }
};
// ===== Monkey-patch 结束 =====

/**
 * 智能体记忆管理器类
 * 
 * 每个智能体拥有独立的 AgentMemory 实例，完全隔离。
 * 数据存储在 {dataDir}/agents/{agentId}/memory/ 目录下。
 */
export class AgentMemoryManager {
  /**
   * 创建记忆管理器实例
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
    /** @type {Map<string, AgentMemory>} agentId -> AgentMemory 实例映射 */
    this._memories = new Map();
    /** @type {AgentMemoryConfig|null} 记忆系统配置 */
    this._config = null;
    /** @type {Promise<void>|null} 初始化 Promise（竞态保护：并发调用者等待同一个 init） */
    this._initPromise = null;
    /** @type {Map<string, Promise<AgentMemory>>} 正在创建中的 Promise（竞态保护：同一 agentId 只允许一个 create） */
    this._creatingPromises = new Map();
    /** @type {any|null} LLM Provider 实例 */
    this._llmProvider = null;
    /** @type {any|null} Embedding Provider 实例 */
    this._embeddingProvider = null;
    /** @type {string|null} 全局记忆存储目录 */
    this._globalMemoryPath = null;
  }

  /**
   * 初始化记忆管理器
   * 
   * 从 Runtime 配置中读取记忆系统配置，并创建对应的 Provider 实例。
   * 如果记忆功能被禁用，记录日志并返回。
   * 
   * @returns {Promise<void>}
   */
  async initialize() {
    const rawConfig = this.runtime.config?.agentMemory ?? null;

    if (!rawConfig?.enabled) {
      this._config = null;
      this.runtime.log.info("[AgentMemoryManager] 记忆功能已禁用");
      return;
    }

    // LLM 配置：优先使用 agentMemory.llm，未配置则回退到默认 llm 配置
    const llmConfig = rawConfig.llm ?? this._resolveDefaultLlmConfig();

    // 设置默认配置
    this._config = {
      enabled: true,
      maxEntries: rawConfig.maxEntries ?? 10000,
      llm: llmConfig,
      embedding: rawConfig.embedding,
      dbPath: rawConfig.dbPath ?? null,
      fileStoragePath: rawConfig.fileStoragePath ?? null,
      recall: {
        limit: rawConfig.recall?.limit ?? 10,
        minConfidence: rawConfig.recall?.minConfidence ?? 0.7
      }
    };
    this._globalMemoryPath = path.join(this.runtime.dataDir, "agent-memory");

    // 创建 Provider 实例
    // 【关键】如果记忆功能已启用，Provider 初始化必须成功，不允许静默降级
    this.runtime.log.info("[AgentMemoryManager] 正在初始化 Provider...");
    await this._createProviders();
    this.runtime.log.info("[AgentMemoryManager] Provider 初始化成功，记忆功能已启用", {
      maxEntries: this._config.maxEntries,
      recallLimit: this._config.recall.limit,
      recallMinConfidence: this._config.recall.minConfidence
    });
  }

  /**
   * 从默认 LLM 配置解析出记忆系统可用的 LLM 配置。
   *
   * 默认 llm 配置（如 runtime.config.llm）使用 baseURL（大写），
   * 但 _createLLMProvider 内部要求 baseUrl（驼峰）。这里做字段映射。
   *
   * @returns {object|null}
   * @private
   */
  _resolveDefaultLlmConfig() {
    const defaultLlm = this.runtime.config?.llm;
    if (!defaultLlm) return null;

    return {
      provider: defaultLlm.provider,
      baseUrl: defaultLlm.baseURL ?? defaultLlm.baseUrl,
      model: defaultLlm.model,
      apiKey: defaultLlm.apiKey,
      temperature: 0.3
    };
  }

  /**
   * 确保记忆系统已初始化（懒加载入口）
   *
   * 在首次调用 getOrCreateMemory() 时自动触发 initialize()。
   * 如果之前已初始化（成功或失败），直接返回，不会重复初始化。
   *
   * @returns {Promise<void>}
   * @private
   */
  async _ensureInitialized() {
    // 使用 Promise 竞态保护：并发调用者都等待同一个初始化 Promise，
    // 避免在 _config 已设置但 provider 尚未创建完成时提前通过检查。
    if (!this._initPromise) {
      this._initPromise = this.initialize();
    }
    await this._initPromise;
  }

  /**
   * 创建 LLM 和 Embedding Provider 实例
   * 
   * 根据配置自动判断使用哪种 provider：
   * - 如果配置了 modelPath，使用 LocalLlamaProvider（本地模型）
   * - 如果配置了 provider="openai"，使用 OpenAI SDK
   * - 如果配置了 provider="anthropic"，使用 Anthropic SDK
   * 
   * @returns {Promise<void>}
   * @private
   */
  async _createProviders() {
    // 创建 LLM Provider
    this._llmProvider = await this._createLLMProvider(this._config.llm, 'LLM');

    // 创建 Embedding Provider
    this._embeddingProvider = await this._createEmbeddingProvider(this._config.embedding, 'Embedding');
  }

  /**
   * 创建 LLM Provider
   * 
   * @param {object} config - LLM 配置
   * @param {string} label - 日志标签（用于区分 LLM/Embedding）
   * @returns {Promise<any>} LLM Provider 实例
   * @private
   */
  async _createLLMProvider(config, label) {
    if (!config) {
      throw new Error(`${label} 配置不能为空`);
    }

    // 方式1：本地模型（配置 modelPath）
    if (config.modelPath) {
      return this._createLocalLLMProvider(config, label);
    }

    // 方式2：HTTP API（需要 provider + baseUrl + model）
    if (!config.provider) {
      throw new Error(`${label} 配置无效：需要提供 provider（如 "openai"、"anthropic"）或 modelPath（本地模型）`);
    }

    if (!config.baseUrl || !config.model) {
      throw new Error(`${label} 配置无效：使用 HTTP API 时需要提供 baseUrl 和 model`);
    }

    switch (config.provider) {
      case 'openai':
        return this._createOpenAILLMProvider(config, label);
      
      case 'anthropic':
        return this._createAnthropicLLMProvider(config, label);
      
      default:
        throw new Error(`${label} 不支持的 provider: ${config.provider}，支持的选项：openai、anthropic、local`);
    }
  }

  /**
   * 创建本地 LLM Provider
   * 
   * @param {object} config - 配置
   * @param {string} label - 日志标签
   * @returns {Promise<any>} Provider 实例
   * @private
   */
  async _createLocalLLMProvider(config, label) {
    this.runtime.log.info(`[AgentMemoryManager] 使用本地 ${label} 模型`, { 
      modelPath: config.modelPath,
      temperature: config.temperature 
    });
    
    const localProvider = new LocalLlamaProvider();
    await localProvider.init({ modelPath: config.modelPath });

    const aiProvider = createLocalAiProvider(localProvider);
    return aiProvider.languageModel(config.modelPath);
  }

  /**
   * 创建 OpenAI 兼容 LLM Provider
   * 
   * @param {object} config - 配置
   * @param {string} label - 日志标签
   * @returns {any} Provider 实例
   * @private
   */
  _createOpenAILLMProvider(config, label) {
    this.runtime.log.info(`[AgentMemoryManager] 使用 OpenAI ${label} API`, { 
      baseUrl: config.baseUrl,
      model: config.model 
    });
    
    const openai = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'NOT_NEEDED'
    });
    
    // 使用 .chat() 方法获取 Chat Completions API 兼容的模型
    return openai.chat(config.model);
  }

  /**
   * 创建 Anthropic LLM Provider
   * 
   * @param {object} config - 配置
   * @param {string} label - 日志标签
   * @returns {any} Provider 实例
   * @private
   */
  _createAnthropicLLMProvider(config, label) {
    this.runtime.log.info(`[AgentMemoryManager] 使用 Anthropic ${label} API`, { 
      baseUrl: config.baseUrl,
      model: config.model 
    });
    
    const anthropic = createAnthropic({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'NOT_NEEDED'
    });
    
    return anthropic(config.model);
  }

  /**
   * 创建 Embedding Provider
   * 
   * @param {object} config - Embedding 配置
   * @param {string} label - 日志标签
   * @returns {Promise<any>} Embedding Provider 实例
   * @private
   */
  async _createEmbeddingProvider(config, label) {
    if (!config) {
      throw new Error(`${label} 配置不能为空`);
    }

    // 如果已经有缓存的 provider，复用它以避免重复创建 Worker 和加载模型
    if (this._embeddingProvider) {
      this.runtime.log.debug("[AgentMemoryManager] Reuse cached " + label + " Provider");
      return this._embeddingProvider;
    }

    // 方式1：本地模型（配置 modelPath）
    if (config.modelPath) {
      return this._createLocalEmbeddingProvider(config, label);
    }

    // 方式2：HTTP API（需要 provider + baseUrl + model）
    if (!config.provider) {
      throw new Error(`${label} 配置无效：需要提供 provider（如 "openai"）或 modelPath（本地模型）`);
    }

    if (!config.baseUrl || !config.model) {
      throw new Error(`${label} 配置无效：使用 HTTP API 时需要提供 baseUrl 和 model`);
    }

    switch (config.provider) {
      case 'openai':
        return this._createOpenAIEmbeddingProvider(config, label);
      
      default:
        throw new Error(`${label} 不支持的 provider: ${config.provider}，Embedding 支持的选项：openai、local`);
    }
  }

  /**
   * 创建本地 Embedding Provider
   * 
   * @param {object} config - 配置
   * @param {string} label - 日志标签
   * @returns {Promise<any>} Provider 实例
   * @private
   */
  async _createLocalEmbeddingProvider(config, label) {
    this.runtime.log.info(`[AgentMemoryManager] 使用本地 ${label} 模型`, { 
      modelPath: config.modelPath,
      dimensions: config.dimensions 
    });
    
    const localProvider = new LocalLlamaProvider();
    await localProvider.init({ modelPath: config.modelPath });

    const aiProvider = createLocalAiProvider(localProvider);
    return aiProvider.embeddingModel(config.modelPath);
  }

  /**
   * 创建 OpenAI 兼容 Embedding Provider
   * 
   * @param {object} config - 配置
   * @param {string} label - 日志标签
   * @returns {any} Provider 实例
   * @private
   */
  _createOpenAIEmbeddingProvider(config, label) {
    this.runtime.log.info(`[AgentMemoryManager] 使用 OpenAI ${label} API`, { 
      baseUrl: config.baseUrl,
      model: config.model 
    });
    
    const openai = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'NOT_NEEDED'
    });
    
    return openai.embedding(config.model);
  }

  /**
   * 获取或创建指定智能体的记忆实例
   * 
   * 如果该智能体已有记忆实例，直接返回缓存的实例。
   * 如果没有，创建新的 AgentMemory 实例并缓存。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<AgentMemory|null>} AgentMemory 实例，如果禁用或失败则返回 null
   */
  async getOrCreateMemory(agentId) {
    // 【懒加载】首次调用时自动初始化记忆系统（加载嵌入模型等）
    await this._ensureInitialized();

    if (!this._config?.enabled) {
      return null;
    }

    // 【关键】检查智能体是否存在且未终止
    const agent = this.runtime._agents.get(agentId);
    if (!agent || agent._isTerminating) {
      this.runtime.log.debug("[AgentMemoryManager] 智能体不存在或正在终止，跳过记忆处理", {
        agentId
      });
      return null;
    }

    // 检查缓存
    if (this._memories.has(agentId)) {
      return this._memories.get(agentId);
    }

    // 【竞态保护】如果已有同一 agentId 的创建正在进行，等待它完成
    // 避免多个并发调用同时触发 LanceDB createTable 导致间歇性失败
    if (this._creatingPromises.has(agentId)) {
      this.runtime.log.debug("[AgentMemoryManager] 等待同一 agentId 的创建完成", { agentId });
      try {
        return await this._creatingPromises.get(agentId);
      } catch {
        // 上一次创建失败，继续尝试创建（已从 _creatingPromises 中移除）
      }
    }

    // 创建新的记忆实例，将 Promise 存入 _creatingPromises 以保护并发
    // 【关键】如果记忆功能已启用且智能体存在，创建失败必须抛出异常，不允许静默返回 null
    const createPromise = this._createMemory(agentId);
    this._creatingPromises.set(agentId, createPromise);

    let memory;
    try {
      memory = await createPromise;
    } finally {
      // 无论成功还是失败，都要清理 _creatingPromises 条目，使后续调用者可重试
      this._creatingPromises.delete(agentId);
    }

    this._memories.set(agentId, memory);
    this.runtime.log.debug("[AgentMemoryManager] 创建记忆实例", { agentId });

    // 注册到生命周期注册表
    const resourceId = `agent_memory:${agentId}`;
    try {
      this.runtime.lifecycleRegistry.register({
        id: resourceId,
        type: 'agent_memory',
        ownerAgentId: agentId,
        cleanup: async () => {
          if (this._memories.has(agentId)) {
            const mem = this._memories.get(agentId);
            this._memories.delete(agentId);
            await mem.close();
          }
        }
      });
      } catch (e) {
        this.runtime.log.warn("[AgentMemoryManager] 记忆生命周期注册失败", { agentId, error: e?.message });
      }

    return memory;
  }

  /**
   * 创建 AgentMemory 实例
   * 
   * 使用 hmemory 的 AgentMemory.create() 工厂方法创建实例。
   * 设置全局错误回调，将记忆系统错误记录到日志。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<AgentMemory|null>} 创建成功返回实例，失败返回 null
   * @private
   */
  async _createMemory(agentId) {
    const memoryPath = this._globalMemoryPath || path.join(this.runtime.dataDir, "agent-memory");
    const dbPath = this._config?.dbPath || path.join(memoryPath, "memory.db");
    const fileStoragePath = this._config?.fileStoragePath || path.join(memoryPath, "files");
    this.runtime.log.info('[AgentMemoryManager] _createMemory 开始', { agentId, memoryPath, dbPath, fileStoragePath });

    // 确保目录存在，避免 hmemory 因目录不存在而初始化失败
    await mkdir(memoryPath, { recursive: true });
    await mkdir(fileStoragePath, { recursive: true });
    this.runtime.log.debug('[AgentMemoryManager] 记忆目录已确保存在', { agentId, memoryPath });
    this.runtime.log.info('[AgentMemoryManager] 调用 AgentMemory.create', { agentId });

    // 创建日志处理器，将 hmemory 的日志重定向到系统日志
    const hmemoryLogHandler = (entry) => {
      const level = entry.level;
      const message = `[hmemory][${entry.module}] ${entry.operation}: ${entry.message}`;
      const ctx = { ...(entry.context || {}) };
      // Ensure stack info is included for error/warn dispatch
      const err = entry.error || entry.context?.error || entry.context?.originalError || entry.originalError;
      if (err) {
        if (err.stack) ctx.stack = err.stack;
        if (err.name) ctx.name = err.name;
        if (err.code) ctx.code = err.code;
      }
      if (level === 'error') {
        this.runtime.log.error(message, ctx);
      } else if (level === 'warn') {
        this.runtime.log.warn(message, ctx);
      } else if (level === 'debug') {
        this.runtime.log.debug(message, ctx);
      } else {
        this.runtime.log.info(message, ctx);
      }
    };

    // 使用重试循环处理 LanceDB 残留目录问题（上次异常退出可能留下半成品目录）
    let memory = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      /* eslint-disable no-await-in-loop */
      try {
        memory = await AgentMemory.create({
          dbPath: dbPath,
          fileStoragePath: fileStoragePath,
          agentId: agentId,
          llm: {
            model: this._llmProvider,
            temperature: this._config.llm?.temperature ?? 0.3
          },
          embedding: {
            model: this._embeddingProvider,
            dimensions: this._config.embedding?.dimensions ?? 1024
          },
          maxEntries: this._config.maxEntries ?? 10000,
          logging: {
            level: 'info',
            handler: hmemoryLogHandler
          },
          onError: (error) => {
            this._handleMemoryError(agentId, error);
          }
        });
      } catch (err) {
        lastError = err;
        this.runtime.log.error('[AgentMemoryManager] AgentMemory.create 抛出异常', {
          agentId,
          attempt: attempt + 1,
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code,
          location: err?.stack?.split('\n')?.[1]?.trim()
        });
      }
      /* eslint-enable no-await-in-loop */

      if (memory) { break; }

      // 尝试清理残留表目录后重试（LanceDB 可能在上次失败时留下半成品目录）
      if (attempt === 0) {
        const tableDir = path.join(dbPath, `memories_${agentId}.lance`);
        try {
          await rm(tableDir, { recursive: true, force: true });
          this.runtime.log.info('[AgentMemoryManager] 已清理残留表目录，准备重试', { agentId, tableDir });
        } catch (cleanupErr) {
          this.runtime.log.warn('[AgentMemoryManager] 清理表目录失败，仍尝试重试', {
            agentId, tableDir,
            error: cleanupErr?.message || String(cleanupErr),
            stack: cleanupErr?.stack,
            name: cleanupErr?.name,
            code: cleanupErr?.code
          });
        }
        // 添加延迟让文件系统释放可能的锁（Windows 文件共享冲突的间歇性问题）
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      break;
    }

    if (!memory) {
      // 【关键】重试失败后必须抛出异常，不允许静默失败
      const errMsg = lastError
        ? `AgentMemory.create 失败 (已重试 2 次): agentId=${agentId}, dbPath=${dbPath}, error=${lastError.message || String(lastError)}, name=${lastError.name}, code=${lastError.code}`
        : `AgentMemory.create 失败 (已重试 2 次): agentId=${agentId}, dbPath=${dbPath}, 原因未知`;
      const err = new Error(errMsg);
      if (lastError) {
        err.cause = lastError;
        err.stack = lastError.stack;
      }
      throw err;
    }

    this.runtime.log.info('[AgentMemoryManager] AgentMemory.create 成功', { agentId });

    return memory;
  }

  /**
   * 清空指定智能体的记忆数据（分表 + 对应文件）。
   *
   * 优先复用已缓存实例；若没有缓存实例，临时创建后执行清理。
   * 无论哪种方式，都会在完成后关闭实例并从缓存中移除，避免资源泄漏。
   *
   * @param {string} agentId - 智能体ID
   * @returns {Promise<boolean>} 成功返回 true，失败返回 false
   */
  async clearMemory(agentId) {
    if (!this._config?.enabled) {
      return false;
    }

    const cached = this._memories.get(agentId);
    let memory = cached || null;
    if (!memory) {
      try {
        memory = await this._createMemory(agentId);
      } catch (err) {
        this.runtime.log.error("[AgentMemoryManager] 清空记忆时创建临时记忆实例失败", {
          agentId,
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
        return false;
      }
    }

    try {
      if (typeof memory.clearAllMemory === "function") {
        await memory.clearAllMemory();
      } else if (typeof memory.clearMemory === "function") {
        await memory.clearMemory();
      } else {
        this.runtime.log.warn("[AgentMemoryManager] 当前 AgentMemory 不支持清空接口", { agentId });
        return false;
      }
      this.runtime.log.info("[AgentMemoryManager] 清空记忆成功", { agentId });
      return true;
    } catch (err) {
      this.runtime.log.warn("[AgentMemoryManager] 清空记忆失败", {
        agentId,
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return false;
    } finally {
      if (cached) {
        await this.closeMemory(agentId);
      } else {
        try {
          await memory.close();
        } catch (closeErr) {
          this.runtime.log.warn("[AgentMemoryManager] 清理后关闭临时记忆实例失败", {
            agentId,
            error: closeErr?.message || String(closeErr),
            stack: closeErr?.stack,
            name: closeErr?.name,
            code: closeErr?.code
          });
        }
      }
      this._memories.delete(agentId);
    }
  }

  /**
   * 处理记忆系统错误的回调函数
   * 
   * 所有 AgentMemory 子模块（MemoryExtractor、Vectorizer、
   * FileStorage、HMemory、ContextManager）的错误都会触发此回调。
   * 
   * 错误会被记录到日志，但不会阻塞主流程。
   * 
   * @param {string} agentId - 智能体ID
   * @param {AgentMemoryError} error - 错误对象
   * @private
   */
  _handleMemoryError(agentId, error) {
    this.runtime.log.error("[AgentMemory] 记忆系统错误", {
      agentId,
      module: error.module,
      operation: error.operation,
      category: error.category,
      message: error.originalError?.message,
      context: error.context,
      fullError: error
    });
  }

  /**
   * 关闭指定智能体的记忆实例
   * 
   * 释放该智能体记忆系统的所有资源（数据库连接、文件句柄等）。
   * 通常在智能体终止前调用。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<void>}
   */
  async closeMemory(agentId) {
    const memory = this._memories.get(agentId);
    if (!memory) {
      return;
    }

    try {
      await memory.close();
      this._memories.delete(agentId);
      this.runtime.log.debug("[AgentMemoryManager] 关闭记忆实例", { agentId });
    } catch (err) {
      this.runtime.log.warn("[AgentMemoryManager] 关闭记忆实例失败", {
        agentId,
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
      this._memories.delete(agentId);
    }

    // 从生命周期注册表注销
    try {
      await this.runtime.lifecycleRegistry.unregister(`agent_memory:${agentId}`);
    } catch (e) {
      this.runtime.log.debug("[AgentMemoryManager] 记忆生命周期注销，正常", { agentId });
    }
  }

  /**
   * 关闭所有记忆实例
   * 
   * 系统关闭时调用，释放所有智能体的记忆资源。
   * 
   * @returns {Promise<void>}
   */
  async closeAll() {
    const agentIds = Array.from(this._memories.keys());
    const promises = [];
    for (const [agentId, memory] of this._memories) {
      promises.push(
        memory.close().catch((err) => {
          this.runtime.log.warn("[AgentMemoryManager] 关闭记忆实例失败", {
            agentId,
            error: err.message
          });
        })
      );
    }

    await Promise.all(promises);
    this._memories.clear();

    // 从生命周期注册表注销所有记忆资源
    for (const agentId of agentIds) {
      try {
        await this.runtime.lifecycleRegistry.unregister(`agent_memory:${agentId}`);
      } catch (e) {
        // 忽略注销错误
      }
    }

    this.runtime.log.info("[AgentMemoryManager] 所有记忆实例已关闭");
  }

  /**
   * 获取当前配置
   * @returns {AgentMemoryConfig|null}
   */
  get config() {
    return this._config;
  }
}

/**
 * @typedef {object} AgentMemoryConfig
 * @property {boolean} enabled - 是否启用记忆功能
 * @property {number} maxEntries - 最大记忆条目数
 * @property {object} recall - 回忆配置
 * @property {number} recall.limit - 返回最大记忆数
 * @property {number} recall.minConfidence - 最低置信度阈值
 * @property {object} llm - LLM 配置
 * @property {string} [llm.provider] - Provider 类型："openai"、"anthropic"、或省略使用本地模型
 * @property {string} [llm.modelPath] - 本地模型文件路径（与 provider 二选一）
 * @property {string} [llm.baseUrl] - API 基础 URL（使用 HTTP API 时必需）
 * @property {string} [llm.apiKey] - API 密钥（使用 HTTP API 时可选）
 * @property {string} [llm.model] - 模型名称（使用 HTTP API 时必需）
 * @property {number} [llm.temperature] - 温度参数
 * @property {object} embedding - Embedding 配置
 * @property {string} [embedding.provider] - Provider 类型："openai"、或省略使用本地模型
 * @property {string} [embedding.modelPath] - 本地模型文件路径（与 provider 二选一）
 * @property {string} [embedding.baseUrl] - API 基础 URL（使用 HTTP API 时必需）
 * @property {string} [embedding.apiKey] - API 密钥（使用 HTTP API 时可选）
 * @property {string} [embedding.model] - 模型名称（使用 HTTP API 时必需）
 * @property {number} embedding.dimensions - 向量维度
 */

/**
 * @typedef {object} AgentMemoryError
 * @property {'AgentMemory'|'MemoryExtractor'|'Vectorizer'|'FileStorage'|'ContextManager'|'HMemory'} module - 错误来源模块
 * @property {string} operation - 操作名称
 * @property {Error} originalError - 原始错误对象
 * @property {'NETWORK'|'TIMEOUT'|'PARSE'|'FILE_IO'|'DATABASE'|'UNKNOWN'} category - 错误分类
 * @property {object} context - 上下文信息
 * @property {boolean} logged - 是否已打印内部日志
 */
