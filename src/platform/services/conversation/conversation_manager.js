import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AutoCompressionManager } from "./auto_compression_manager.js";
import { ToolCallPairCompressor } from "./tool_call_pair_compressor.js";

/**
 * 会话上下文管理器
 * 负责管理智能体的会话上下文，包括压缩历史消息和检查上下文长度。
 * 支持基于 token 的上下文长度限制。
 * 支持对话历史持久化到磁盘。
 */
export class ConversationManager {
  /**
   * @param {{conversations?:Map, conversationsDir?:string, logger?:object, lifecycleRegistry?:object, configService?:object, llmClient?:object|null, promptsLoader?:object, agents?:Map, org?:object}} options
   */
  constructor(options = {}) {
    this.conversations = options.conversations ?? new Map();
    this._conversationsDir = options.conversationsDir ?? null;
    this._logger = options.logger;
    this._lifecycleRegistry = options.lifecycleRegistry;
    this._pendingSaves = new Map();

    // 直接注入依赖（bootstrap 在所有依赖就绪后才创建 ConversationManager）
    this._configService = options.configService ?? null;
    this._llmClient = options.llmClient ?? null;
    this._promptsLoader = options.promptsLoader ?? null;
    this._agents = options.agents ?? null;
    this._org = options.org ?? null;

    // 从配置服务读取上下文限制
    const app = this._configService?.getLoadedApp?.();
    const ctxCfg = app?.contextLimit ?? {};
    this.contextLimit = {
      maxTokens: app?.llm?.maxContextTokens ?? 128000,
      warningThreshold: ctxCfg.warningThreshold ?? 0.7,
      criticalThreshold: ctxCfg.criticalThreshold ?? 0.9,
      hardLimitThreshold: ctxCfg.hardLimitThreshold ?? 0.95
    };

    // 持久化目录（从配置推导，可被外部 setConversationsDir 覆盖）
    if (!this._conversationsDir && app?.runtimeDir) {
      this._conversationsDir = path.join(app.runtimeDir, "conversations");
    }

    // 自动压缩管理器（使用默认 LLM，始终创建）
    if (this._llmClient) {
      const compressor = new ToolCallPairCompressor();
      this._autoCompressionManager = new AutoCompressionManager(this._llmClient, this._logger, compressor);
    } else {
      this._autoCompressionManager = null;
    }

    // 提示词模板（延迟加载，首次 buildContextStatusPrompt 时从 PromptLoader 读取文件）
    this._promptsLoaded = false;
    this.promptTemplates = {
      contextStatus: '【上下文状态】已使用 {{USED_TOKENS}}/{{MAX_TOKENS}} tokens ({{USAGE_PERCENT}}%)',
      contextExceeded: '',
      contextCritical: '',
      contextWarning: '提示：上下文使用率较高({{WARNING_THRESHOLD}}%)，请注意管理上下文长度。'
    };

    this._tokenUsage = new Map();
  }

  /**
   * 异步加载提示词模板（首次调用时从 PromptLoader 读取文件，幂等）。
   */
  async _ensurePromptsLoaded() {
    if (this._promptsLoaded) return;
    this._promptsLoaded = true;

    if (!this._promptsLoader) return;

    const load = async (file) => {
      try { return await this._promptsLoader.loadSystemPromptFile(file); } catch { return null; }
    };
    this.promptTemplates = {
      contextStatus: (await load("context_status.txt")) ?? '【上下文状态】已使用 {{USED_TOKENS}}/{{MAX_TOKENS}} tokens ({{USAGE_PERCENT}}%)',
      contextExceeded: (await load("context_exceeded.txt")) ?? '',
      contextCritical: (await load("context_critical.txt")) ?? '',
      contextWarning: (await load("context_warning.txt")) ?? '提示：上下文使用率较高({{WARNING_THRESHOLD}}%)，请注意管理上下文长度。'
    };
  }

  /**
   * 查询智能体使用的 LLM 服务 ID。
   *
   * @param {string} agentId
   * @returns {string|null}
   * @private
   */
  _getAgentLlmServiceId(agentId) {
    const agent = this._agents?.get(agentId);
    return this._org?.getRole(agent?.roleId)?.llmServiceId ?? null;
  }

  /**
   * 执行自动压缩。
   * 
   * 直接传递会话消息数组给压缩管理器处理。
   * 压缩管理器会自己判断是否需要压缩，需要则直接修改消息数组。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<void>}
   */
  async processAutoCompression(agentId) {
    if (!this._autoCompressionManager) return;

    // 获取会话消息数组
    const conv = this.conversations.get(agentId);
    if (!conv) {
      this._logger.debug('ConversationManager.processAutoCompression: 会话不存在，跳过自动压缩', { agentId });
      return;
    }

    try {
      const maxContextTokens = this._resolveMaxTokens(agentId);

      this._logger.debug('ConversationManager.processAutoCompression: 开始自动压缩', {
        agentId,
        messageCount: conv.length,
        maxContextTokens
      });

      // 调用压缩管理器处理，直接传递会话消息数组
      await this._autoCompressionManager.process(conv, maxContextTokens);

      this._logger.debug('ConversationManager.processAutoCompression: 自动压缩完成', {
        agentId,
        messageCount: conv.length
      });

    } catch (error) {
      // 捕获异常，确保不影响业务流程
      this._logger.error('ConversationManager.processAutoCompression: 自动压缩异常', {
        agentId,
        error: error.message,
        stack: error.stack,
        name: error?.name,
        code: error?.code
      });
    }
  }

  /**
   * 加载所有持久化的对话历史。
   * @returns {Promise<{loaded: number, errors: string[]}>}
   */
  async loadAllConversations() {
    if (!this._conversationsDir) {
      return { loaded: 0, errors: ["conversationsDir not set"] };
    }

    const errors = [];
    let loaded = 0;

    try {
      await mkdir(this._conversationsDir, { recursive: true });
      const files = await readdir(this._conversationsDir);
      
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        
        const agentId = file.slice(0, -5); // 移除 .json 后缀
        const filePath = path.join(this._conversationsDir, file);
        
        try {
          const raw = await readFile(filePath, "utf8");
          const data = JSON.parse(raw);
          const normalized = this._normalizePersistedConversationData(data);
          if (!normalized) {
            errors.push(`${agentId}: invalid format`);
            continue;
          }

          this.conversations.set(agentId, normalized.messages);
          
          // 恢复 token 使用统计
          if (normalized.tokenUsage) {
            this._tokenUsage.set(agentId, normalized.tokenUsage);
          }

          // 补全缺失的消息 ID（兼容旧数据）
          const patched = this._patchConversationMessageIds(normalized.messages);
          if (patched) {
            void this.persistConversation(agentId);
          }
          
          loaded++;
        } catch (err) {
          errors.push(`${agentId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`readdir: ${err.message}`);
    }

    void this._logger.info("加载对话历史完成", { loaded, errors: errors.length });

    return { loaded, errors };
  }

  /**
   * 持久化单个智能体的对话历史（带防抖）。
   * @param {string} agentId
   * @returns {Promise<void>}
   */
  async persistConversation(agentId) {
    if (!this._conversationsDir) return;

    // 防抖：取消之前的保存计划
    const pending = this._pendingSaves.get(agentId);
    if (pending) {
      pending.cancelled = true;
    }

    // 使用 async IIFE 替代 setTimeout(async)，确保异常能被正确捕获
    const entry = { cancelled: false };
    this._pendingSaves.set(agentId, entry);

    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (entry.cancelled) return;
        this._pendingSaves.delete(agentId);
        await this._doSaveConversation(agentId);
      } catch (err) {
        const errorMsg = err?.message ?? String(err);
        void this._logger.error("[ConversationManager] 延迟保存失败", { agentId, error: errorMsg, stack: err.stack, name: err?.name, code: err?.code });
      }
    })();
  }

  /**
   * 立即持久化单个智能体的对话历史（无防抖）。
   * @param {string} agentId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async persistConversationNow(agentId) {
    if (!this._conversationsDir) {
      return { ok: false, error: "conversationsDir not set" };
    }

    // 取消防抖计划
    const pending = this._pendingSaves.get(agentId);
    if (pending) {
      pending.cancelled = true;
      this._pendingSaves.delete(agentId);
    }

    return await this._doSaveConversation(agentId);
  }

  /**
   * 实际执行保存操作。
   * @param {string} agentId
   * @returns {Promise<{ok: boolean, error?: string}>}
   * @private
   */
  async _doSaveConversation(agentId) {
    try {
      await mkdir(this._conversationsDir, { recursive: true });
      
      const conv = this.conversations.get(agentId);
      if (!conv) {
        return { ok: true }; // 没有对话，无需保存
      }

      const filePath = path.join(this._conversationsDir, `${agentId}.json`);
      const data = {
        agentId,
        messages: conv,
        tokenUsage: this._tokenUsage.get(agentId) ?? null,
        updatedAt: new Date().toISOString()
      };

      await writeFile(filePath, JSON.stringify(data, null), "utf8");
      
      void this._logger.debug("持久化对话历史", { agentId, messageCount: conv.length });
      
      return { ok: true };
    } catch (err) {
      void this._logger.error("持久化对话历史失败", { agentId, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 删除智能体的持久化对话历史文件。
   * @param {string} agentId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deletePersistedConversation(agentId) {
    if (!this._conversationsDir) {
      return { ok: true };
    }

    // 取消防抖计划
    const pending = this._pendingSaves.get(agentId);
    if (pending) {
      pending.cancelled = true;
      this._pendingSaves.delete(agentId);
    }

    try {
      const filePath = path.join(this._conversationsDir, `${agentId}.json`);
      await unlink(filePath);
      return { ok: true };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { ok: true }; // 文件不存在，视为成功
      }
      return { ok: false, error: err.message };
    }
  }

  /**
   * 等待所有待保存的对话完成。
   * @returns {Promise<void>}
   */
  async flushAll() {
    const promises = [];
    for (const [agentId, entry] of this._pendingSaves) {
      entry.cancelled = true;
      promises.push(this._doSaveConversation(agentId));
    }
    this._pendingSaves.clear();
    await Promise.all(promises);
  }

  /**
   * 设置提示词模板。
   * @param {{contextStatus?:string, contextExceeded?:string, contextCritical?:string, contextWarning?:string}} templates
   */
  setPromptTemplates(templates) {
    this.promptTemplates = { ...this.promptTemplates, ...templates };
  }

  /**
   * 更新智能体的 token 使用统计（基于 LLM 返回的实际值）。
   * @param {string} agentId
   * @param {{promptTokens:number, completionTokens:number, totalTokens:number}} usage
   */
  updateTokenUsage(agentId, usage) {

    if (!agentId) {
      void this._logger.error("tokenUsage 缺少 agentId", {
        // 业务/技术信息：记录传入的 usage 数据结构和调用栈，便于追查调用方
        usageProvided: usage ? "yes" : "no",
        usageType: typeof usage,
        usageKeys: usage && typeof usage === "object" ? Object.keys(usage) : null,
        callStack: new Error("调用栈捕获").stack
      });
      return;
    }

    if (!usage) {
      void this._logger.error("tokenUsage 缺少 usage", { agentId });
      return;
    }

    const tokenUsage = {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      updatedAt: Date.now()
    };
    this._tokenUsage.set(agentId, tokenUsage);

    // 同时尝试使用 logger（如果可用）
    try {
        this._logger.info("updateTokenUsage 被调用", {
          agentId,
          input: usage,
          saved: tokenUsage
        });
      } catch (logErr) {
        console.error("[ConversationManager.updateTokenUsage] logger.info 失败:", logErr, { stack: logErr?.stack, name: logErr?.name, code: logErr?.code });
      }
  }

  /**
   * 同步加载单个智能体的持久化对话历史到内存（用于启动早期/调度器同步路径）。
   *
   * 说明：
   * - TurnEngine/ComputeScheduler 的关键路径是同步的，无法 await；
   * - 当运行时尚未完成 loadAllConversations，或 conversations Map 尚未包含该 agentId 时，
   *   该方法允许在首次对话时按需同步恢复历史，确保发送给 LLM 的 messages 包含重启前内容。
   *
   * @param {string} agentId
   * @returns {{ok:boolean, loaded:boolean, messageCount?:number, error?:string}}
   */
  loadConversationSync(agentId) {
    if (!this._conversationsDir) {
      return { ok: false, loaded: false, error: "conversationsDir not set" };
    }
    if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
      return { ok: false, loaded: false, error: "missing_agent_id" };
    }

    const filePath = path.join(this._conversationsDir, `${agentId}.json`);
    if (!existsSync(filePath)) {
      return { ok: true, loaded: false };
    }

    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      const normalized = this._normalizePersistedConversationData(data);
      if (!normalized) {
        return { ok: false, loaded: false, error: "invalid_format" };
      }

      this.conversations.set(agentId, normalized.messages);
      if (normalized.tokenUsage) {
        this._tokenUsage.set(agentId, normalized.tokenUsage);
      }
      const patched = this._patchConversationMessageIds(normalized.messages);
      if (patched) {
        void this.persistConversation(agentId);
      }

      return { ok: true, loaded: true, messageCount: normalized.messages.length };
    } catch (err) {
      return { ok: false, loaded: false, error: err?.message ?? String(err ?? "unknown_error") };
    }
  }

  /**
   * 兼容多种持久化对话格式。
   * 老版本可能直接保存消息数组，新版本保存为包含 messages 的对象。
   * @param {any} data - 反序列化后的持久化数据
   * @returns {{messages:any[], tokenUsage:any}|null}
   * @private
   */
  _normalizePersistedConversationData(data) {
    /** @type {any[]|null} */
    let messages = null;
    /** @type {any|null} */
    let tokenUsage = null;

    if (Array.isArray(data)) {
      messages = data;
      tokenUsage = null;
    } else if (Array.isArray(data?.messages)) {
      messages = data.messages;
      tokenUsage = data.tokenUsage ?? null;
    } else {
      return null;
    }

    // 向后兼容：剥离旧持久化文件中开头的 system 消息
    // 旧格式: [{ role: "system" }, ...] → 剥离 system 后返回纯对话转录
    // 新格式无 system → 直接返回
    let stripCount = 0;
    while (messages.length > 0 && messages[0]?.role === "system") {
      messages = messages.slice(1);
      stripCount += 1;
    }

    return {
      messages,
      tokenUsage
    };
  }

  /**
   * 为缺失 ID 的历史消息补齐 ID。
   * 旧对话没有消息 ID 时，会影响重新生成、定位和前端历史识别。
   * @param {any[]} messages - 会话消息数组
   * @returns {boolean} 是否发生了补丁写入
   * @private
   */
  _patchConversationMessageIds(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return false;
    }
    let patched = false;
    for (const msg of messages) {
      if (!msg?.id) {
        msg.id = randomUUID();
        patched = true;
      }
    }
    return patched;
  }

  /**
   * 获取智能体的 token 使用统计。
   * @param {string} agentId
   * @returns {{promptTokens:number, completionTokens:number, totalTokens:number, updatedAt:number}|null}
   */
  getTokenUsage(agentId) {
    return this._tokenUsage.get(agentId) ?? null;
  }

  /**
   * 按智能体解析实际的最大上下文 token 数。
   *
   * 通过配置服务读取 LLM 配置，推导当前智能体使用的模型的上下文窗口大小。
   * 解析顺序：智能体 → LLM 服务 → 服务级 maxContextTokens → 全局默认。
   *
   * @param {string} agentId
   * @returns {number}
   * @private
   */
  _resolveMaxTokens(agentId) {
    const app = this._configService?.getLoadedApp?.();
    if (!app?.llm) {
      return this.contextLimit.maxTokens ?? 128000;
    }

    // 1. 查询智能体正在使用的 LLM 服务
    const serviceId = this._getAgentLlmServiceId(agentId);
    if (serviceId) {
      // 2. 服务可能有自己的 maxContextTokens
      const services = app.llmServices?.services ?? [];
      const svc = services.find(s => s.id === serviceId);
      if (svc?.maxContextTokens) {
        return svc.maxContextTokens;
      }
    }

    // 3. 回退到默认 LLM 的 maxContextTokens
    if (typeof app.llm.maxContextTokens === 'number') {
      return app.llm.maxContextTokens;
    }

    // 4. 最终兜底
    return 128000;
  }

  /**
   * 获取智能体的上下文使用百分比。
   * @param {string} agentId
   * @returns {number} 0-1 之间的百分比，如果没有数据则返回 0
   */
  getContextUsagePercent(agentId) {
    const usage = this._tokenUsage.get(agentId);
    if (!usage || !usage.promptTokens) {
      return 0;
    }
    return usage.promptTokens / this._resolveMaxTokens(agentId);
  }

  /**
   * 获取智能体的上下文状态信息。
   * @param {string} agentId
   * @returns {{usedTokens:number, maxTokens:number, usagePercent:number, status:'normal'|'warning'|'critical'|'exceeded'}}
   */
  getContextStatus(agentId) {
    const usage = this._tokenUsage.get(agentId);
    const usedTokens = usage?.promptTokens ?? 0;
    const maxTokens = this._resolveMaxTokens(agentId);
    const usagePercent = usedTokens / maxTokens;
    
    /** @type {'normal'|'warning'|'critical'|'exceeded'} */
    let status = 'normal';
    if (usagePercent >= this.contextLimit.hardLimitThreshold) {
      status = 'exceeded';
    } else if (usagePercent >= this.contextLimit.criticalThreshold) {
      status = 'critical';
    } else if (usagePercent >= this.contextLimit.warningThreshold) {
      status = 'warning';
    }
    
    return {
      usedTokens,
      maxTokens,
      usagePercent,
      status
    };
  }

  /**
   * 清除智能体的 token 使用统计。
   * @param {string} agentId
   */
  clearTokenUsage(agentId) {
    this._tokenUsage.delete(agentId);
  }

  /**
   * 获取或确保某个智能体的会话上下文已准备就绪。
   *
   * System prompt 是运行时上下文，不持久化在 conv 中。
   * conv 仅保存纯对话转录（user/assistant/tool），每次 LLM 调用时 system prompt 由 runtime 新鲜构建。
   *
   * @param {string} agentId - 智能体ID
   * @returns {any[]} 准备就绪的会话消息数组（纯对话转录，不含 system）
   */
  ensureConversation(agentId) {
    let conv = this.getConversation(agentId);

    // 1. 如果完全没有会话，初始化一个空数组
    if (!conv) {
      conv = [];
      this.conversations.set(agentId, conv);

      // 注册到生命周期注册表
      try {
        this._lifecycleRegistry.register({
          id: `conversation:${agentId}`,
          type: 'conversation',
          ownerAgentId: agentId,
          cleanup: async () => {
            this.conversations.delete(agentId);
            await this.deletePersistedConversation(agentId);
          }
        });
      } catch (e) {
        void this._logger.warn("[ConversationManager] 会话生命周期注册失败", { agentId, error: e?.message });
      }

      return conv;
    }

    // 2. conv 已存在（从磁盘恢复或内存中已有），直接返回
    return conv;
  }

  /**
   * 获取智能体的会话上下文。
   * 如果内存中不存在，会尝试从磁盘同步加载。
   * 
   * @param {string} agentId
   * @returns {any[]|undefined}
   */
  getConversation(agentId) {
    // 1. 优先从内存获取
    let conv = this.conversations.get(agentId);
    if (conv) return conv;

    // 2. 内存没有，尝试同步加载
    const loadResult = this.loadConversationSync(agentId);
    if (loadResult.ok && loadResult.loaded) {
      return this.conversations.get(agentId);
    }

    return undefined;
  }

  /**
   * 检查智能体是否有会话上下文。
   * @param {string} agentId
   * @returns {boolean}
   */
  hasConversation(agentId) {
    return this.getConversation(agentId) !== undefined;
  }

  /**
   * 删除智能体的会话上下文。
   * @param {string} agentId
   * @returns {boolean}
   */
  async deleteConversation(agentId) {
    const result = this.conversations.delete(agentId);
    // 从生命周期注册表注销
    try {
      await this._lifecycleRegistry.unregister(`conversation:${agentId}`);
    } catch (e) {
      // 忽略注销错误
    }
    return result;
  }

  /**
   * 获取智能体会话的当前消息数量。
   * @param {string} agentId
   * @returns {number}
   */
  getMessageCount(agentId) {
    const conv = this.conversations.get(agentId);
    return conv ? conv.length : 0;
  }

  /**
   * 生成上下文状态提示文本，用于注入到智能体的消息中。
   * @param {string} agentId
   * @returns {string} 上下文状态提示文本
   */
  async buildContextStatusPrompt(agentId) {
    await this._ensurePromptsLoaded();
    const status = this.getContextStatus(agentId);
    const percentStr = (status.usagePercent * 100).toFixed(1);
    
    // 使用模板生成基础状态提示
    let prompt = '\n\n' + this.promptTemplates.contextStatus;
    
    // 根据状态添加警告提示
    if (status.status === 'exceeded') {
      prompt += '\n' + this.promptTemplates.contextExceeded;
    } else if (status.status === 'critical') {
      prompt += '\n' + this.promptTemplates.contextCritical;
    } else if (status.status === 'warning') {
      prompt += '\n' + this.promptTemplates.contextWarning;
    }
    prompt = prompt
      .replace('{{USED_TOKENS}}', String(status.usedTokens))
      .replace('{{MAX_TOKENS}}', String(status.maxTokens))
      .replace('{{USAGE_PERCENT}}', percentStr)
      .replace('{{WARNING_THRESHOLD}}', (this.contextLimit.warningThreshold * 100).toFixed(0))
      .replace('{{CRITICAL_THRESHOLD}}', (this.contextLimit.criticalThreshold * 100).toFixed(0))
      .replace('{{HARD_LIMIT_THRESHOLD}}', (this.contextLimit.hardLimitThreshold * 100).toFixed(0));
    return prompt;
  }

  /**
   * 获取智能体对话历史中最后一个工具调用。
   * @param {string} agentId - 智能体ID
   * @returns {{id: string, function: {name: string, arguments: string}}|null} 最后一个工具调用，如果没有则返回 null
   */
  getLastToolCall(agentId) {
    const conv = this.conversations.get(agentId);
    
    if (!conv) {
      return null;
    }

    // 从后向前遍历，查找最后一个包含工具调用的 assistant 消息
    for (let i = conv.length - 1; i >= 0; i--) {
      const msg = conv[i];
      
      if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // 返回最后一个工具调用
        return msg.tool_calls[msg.tool_calls.length - 1];
      }
    }

    return null;
  }

  /**
   * 获取最后一条 assistant 消息。
   * 用于“重新生成最后一条回复”场景，只允许针对最后一个 assistant 节点重放。
   * @param {string} agentId
   * @returns {{index:number, message:any}|null}
   */
  getLastAssistantMessage(agentId) {
    const conv = this.getConversation(agentId);
    if (!conv) {
      return null;
    }

    for (let i = conv.length - 1; i >= 0; i -= 1) {
      const message = conv[i];
      if (message?.role === "assistant") {
        return {
          index: i,
          message
        };
      }
    }

    return null;
  }

  /**
   * 验证对话历史的一致性，确保没有孤立的工具响应。
   * 孤立的工具响应是指：存在 tool_call_id 但对应的工具调用不存在。
   * @param {string} agentId - 智能体ID
   * @returns {{consistent: boolean, orphanedResponses: string[], error?: string}}
   *   - consistent: 对话历史是否一致
   *   - orphanedResponses: 孤立的工具响应的 tool_call_id 列表
   *   - error: 错误信息（如果有）
   */
  verifyHistoryConsistency(agentId) {
    const conv = this.conversations.get(agentId);
    
    if (!conv) {
      return { consistent: false, orphanedResponses: [], error: "conversation_not_found" };
    }

    // 收集所有工具调用的 ID
    const toolCallIds = new Set();
    for (const msg of conv) {
      if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (call.id) {
            toolCallIds.add(call.id);
          }
        }
      }
    }

    // 检查所有工具响应是否有对应的工具调用
    const orphanedResponses = [];
    for (const msg of conv) {
      if (msg.role === "tool" && msg.tool_call_id) {
        if (!toolCallIds.has(msg.tool_call_id)) {
          orphanedResponses.push(msg.tool_call_id);
        }
      }
    }

    const consistent = orphanedResponses.length === 0;

    if (!consistent && this._logger) {
      void this._logger.warn("检测到对话历史不一致", {
        agentId,
        orphanedCount: orphanedResponses.length,
        orphanedResponses
      });
    }

    return { consistent, orphanedResponses };
  }

  /**
   * 截断最后一条 assistant 消息及其之后的所有对话节点。
   * 这样可以在不重复追加用户消息的前提下，复用现有 LLM 流程重新生成回复。
   * @param {string} agentId
   * @param {string} messageId
   * @returns {Promise<{ok:boolean, truncatedFromIndex?:number, removedMessages?:any[], removedMessageIds?:string[], error?:string}>}
   */
  async truncateLastAssistantMessage(agentId, messageId) {
    const conv = this.getConversation(agentId);
    if (!conv) {
      return { ok: false, error: "conversation_not_found" };
    }

    const targetIndex = conv.findIndex((message) => message?.id === messageId);
    if (targetIndex === -1) {
      return { ok: false, error: "message_not_found" };
    }

    const targetMessage = conv[targetIndex];
    if (targetMessage?.role !== "assistant") {
      return { ok: false, error: "message_not_assistant" };
    }

    const lastAssistant = this.getLastAssistantMessage(agentId);
    if (!lastAssistant || lastAssistant.index !== targetIndex) {
      return { ok: false, error: "message_not_last_assistant" };
    }

    const removedMessages = conv.splice(targetIndex);
    await this.persistConversationNow(agentId);

    return {
      ok: true,
      truncatedFromIndex: targetIndex,
      removedMessages,
      removedMessageIds: removedMessages
        .map((message) => message?.id)
        .filter((id) => typeof id === "string" && id.length > 0)
    };
  }

  /**
   * 恢复一次截断操作移除的消息。
   * 当“重新生成”在进入调度前失败时，需要回滚会话历史，避免用户丢失原始回复。
   * @param {string} agentId
   * @param {number} index
   * @param {any[]} messages
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async restoreTruncatedMessages(agentId, index, messages) {
    const conv = this.getConversation(agentId);
    if (!conv) {
      return { ok: false, error: "conversation_not_found" };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, error: "messages_empty" };
    }
    if (!Number.isInteger(index) || index < 0 || index > conv.length) {
      return { ok: false, error: "invalid_index" };
    }

    conv.splice(index, 0, ...messages);
    await this.persistConversationNow(agentId);
    return { ok: true };
  }

  /**
   * 删除单条消息。
   * @param {string} agentId
   * @param {string} messageId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deleteMessage(agentId, messageId) {
    const conv = this.getConversation(agentId);
    if (!conv) return { ok: false, error: "conversation_not_found" };

    const index = conv.findIndex(m => m.id === messageId);
    if (index === -1) return { ok: false, error: "message_not_found" };

    conv.splice(index, 1);
    await this.persistConversationNow(agentId);
    return { ok: true };
  }

  /**
   * 批量删除消息。
   * @param {string} agentId
   * @param {string[]} messageIds
   * @returns {Promise<{ok: boolean, deletedCount?: number, error?: string}>}
   */
  async deleteMessages(agentId, messageIds) {
    const conv = this.getConversation(agentId);
    if (!conv) return { ok: false, error: "conversation_not_found" };

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return { ok: true, deletedCount: 0 };
    }

    const idsSet = new Set(messageIds);
    const initialLength = conv.length;

    void this._logger.info("[deleteMessages] 开始删除消息", {
      agentId,
      requestedMessageIds: messageIds,
      requestedCount: messageIds.length,
      conversationLength: initialLength,
      existingMessageIds: conv.map(m => m.id)
    });

    // 反向遍历原地删除，避免索引偏移
    // 同时确保 TurnEngine 的 turn.conv 引用能立即看到删除结果
    for (let i = conv.length - 1; i >= 0; i--) {
      if (conv[i]?.id != null && idsSet.has(String(conv[i].id))) {
        conv.splice(i, 1);
      }
    }

    const deletedCount = initialLength - conv.length;

    if (deletedCount === 0) {
      void this._logger.warn("[deleteMessages] 未找到匹配的消息 ID", {
        agentId,
        requestedMessageIds: messageIds,
        existingMessageIds: conv.map(m => m.id)
      });
      return { ok: true, deletedCount: 0 };
    }

    void this._logger.info("[deleteMessages] 成功删除消息", {
      agentId,
      deletedCount,
      remainingCount: conv.length
    });

    try {
      await this.persistConversationNow(agentId);
      void this._logger.info("[deleteMessages] 持久化完成", {
        agentId,
        deletedCount
      });
    } catch (persistErr) {
      void this._logger.error("[deleteMessages] 持久化失败", {
        agentId,
        error: persistErr?.message ?? String(persistErr),
        stack: persistErr.stack,
        name: persistErr?.name,
        code: persistErr?.code
      });
      return { ok: false, error: "persist_failed" };
    }

    return { ok: true, deletedCount };
  }

  /**
   * 更新消息内容。
   * @param {string} agentId
   * @param {string} messageId
   * @param {string} content
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async updateMessage(agentId, messageId, content) {
    const conv = this.conversations.get(agentId);
    if (!conv) return { ok: false, error: "conversation_not_found" };

    const msg = conv.find(m => m.id === messageId);
    if (!msg) return { ok: false, error: "message_not_found" };

    msg.content = content;
    await this.persistConversation(agentId);
    return { ok: true };
  }

  /**
   * 清空对话历史。
   * @param {string} agentId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async clearConversation(agentId) {
    const conv = this.getConversation(agentId);
    if (!conv) return { ok: false, error: "conversation_not_found" };

    // 清空为"空会话"。System prompt 由 runtime 在每次 LLM 调用时新鲜构建。
    const newConv = [];
    
    this.conversations.set(agentId, newConv);
    this.clearTokenUsage(agentId);
    
    await this.persistConversationNow(agentId);
    return { ok: true };
  }
}
