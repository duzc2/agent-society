import path from "node:path";
import { Config } from "../utils/config/config.js";
import { MessageBus } from "./message_bus.js";
import { PromptLoader } from "../prompt_loader.js";
import { LlmClient } from "../services/llm/llm_client.js";
import { Logger , normalizeLoggingConfig } from "../utils/logger/logger.js";
import { ConversationManager } from "../services/conversation/conversation_manager.js";

import { ModuleLoader } from "../extensions/module_loader.js";
import { LlmServiceRegistry } from "../services/llm/llm_service_registry.js";
import { ToolGroupManager } from "../extensions/tool_group_manager.js";

// 导入子模块
import { JavaScriptExecutor } from "../runtime/javascript_executor.js";
import { BrowserJavaScriptExecutor } from "../runtime/browser_javascript_executor.js";
import { ContextBuilder } from "../runtime/context_builder.js";
import { AgentManager } from "../runtime/agent_manager.js";
import { ToolExecutor } from "../runtime/tool_executor.js";
import { ShutdownManager } from "../runtime/shutdown_manager.js";
import { RuntimeState } from "../runtime/runtime_state.js";
import { RuntimeEvents } from "../runtime/runtime_events.js";
import { RuntimeLifecycle } from "../runtime/runtime_lifecycle.js";
import { RuntimeTools } from "../runtime/runtime_tools.js";
import { RuntimeLlm } from "../runtime/runtime_llm.js";
import { AgentCancelManager } from "../runtime/agent_cancel_manager.js";
import { TurnEngine } from "../runtime/turn_engine.js";
import { AgentMemoryManager } from "../services/agent_memory/agent_memory_manager.js";
import { LifecycleRegistry } from "../runtime/resource_lifecycle.js";
import { KnowledgeTreeSystem } from "../services/knowledge_tree/knowledge_tree_system.js";
import { ComputeScheduler } from "../runtime/compute_scheduler.js";
import { Agent } from "../../agents/agent.js";
import { BootstrapManager } from "../runtime/bootstrap_manager.js";
import { ReplyManager } from "../runtime/reply_manager.js";
import { LlmClientPoolManager } from "../runtime/llm_client_pool.js";
import { provideToRegistry as _provideRuntimeEvents } from "../runtime/runtime_events.js";
import { provideToRegistry as _provideLlmConversations } from "../runtime/runtime_state.js";
import { provideToRegistry as _provideAgentLlmClients } from "../runtime/llm_client_pool.js";
import { IdleMonitor } from "../runtime/idle_monitor.js";
import { SystemPromptManager } from "../runtime/system_prompt_manager.js";
import { TaskIdResolver } from "../runtime/task_id_resolver.js";
import { AgentQueueManager } from "../runtime/agent_queue_manager.js";
import { ToolImplementations } from "../runtime/tool_implementations.js";
import { JavaScriptToolRunner } from "../runtime/javascript_tool_runner.js";
import { deleteAgentDataFolder as deleteAgentDataFolderUtility } from "../utils/delete_folder.js";
import { toJsonSafeValue } from "../utils/json_safe.js";

/**
 * Runtime - 运行时核心协调器
 * 
 * 【职责】
 * Runtime 类作为核心协调器，负责：
 * 1. 系统初始化：加载配置、初始化服务、注册智能体
 * 2. 配置管理：管理系统配置和服务配置
 * 3. 服务初始化：初始化各个平台服务（MessageBus、OrgPrimitives、WorkspaceManager 等）
 * 4. 子模块组合：导入并组合各个功能子模块
 * 5. 统一接口：提供统一的公共 API，委托给子模块实现
 * 
 * 【模块化架构】
 * Runtime 将具体功能委托给以下子模块：
 * - RuntimeState: 状态管理（智能体注册表、运算状态、插话队列等）
 * - RuntimeEvents: 事件系统（工具调用、错误、LLM 重试等事件）
 * - RuntimeLifecycle: 生命周期管理（智能体创建、恢复、注册、查询、中断等）
 * - RuntimeMessaging: 消息处理循环（消息调度、处理、插话、并发控制）
 * - RuntimeTools: 工具管理（工具定义、工具执行、工具组管理、工具权限检查）
 * - RuntimeLlm: LLM 交互管理（LLM 调用、上下文构建、错误处理）
 * - JavaScriptExecutor: JavaScript 代码执行
 * - BrowserJavaScriptExecutor: 浏览器 JavaScript 执行
 * - ContextBuilder: 上下文构建
 * - AgentManager: 智能体生命周期管理
 * - MessageProcessor: 消息调度和处理
 * - ToolExecutor: 工具定义和执行
 * - ShutdownManager: 优雅关闭管理
 * 
 * 【设计原则】
 * - 单一职责：Runtime 只负责协调，不实现具体功能
 * - 低耦合：通过子模块接口进行交互
 * - 高内聚：相关功能集中在对应的子模块中
 * - 向后兼容：保持公共 API 不变
 * 
 * 【需求】
 * Requirements: 3.2, 7.1, 7.2
 */
export class Runtime {
  /**
   * 构造函数 - 初始化 Runtime 核心协调器
   * 
   * 【初始化流程】
   * 1. 保存配置参数
   * 2. 初始化临时日志系统
   * 3. 初始化事件系统模块
   * 4. 初始化状态管理模块
   * 5. 暴露状态属性（向后兼容）
   * 6. 初始化临时服务实例
   * 7. 初始化所有子模块
   * 
   * @param {{config?:object, configService?:Config, maxSteps?:number, configPath?:string, maxToolRounds?:number, idleWarningMs?:number, dataDir?:string, contextLimit?:{maxTokens:number, warningThreshold:number, criticalThreshold:number, hardLimitThreshold:number}}} options
   */
  constructor(options = {}) {
    // ==================== 配置参数 ====================
    this._passedConfig = options.config ?? null; // 外部传入的配置对象
    this._configService = options.configService; // 外部传入的配置服务
    
    // 如果提供了 configPath，创建 Config 服务
    if (options.configPath && !this._configService) {
      const configDir = path.dirname(options.configPath);
      this._configService = new Config(configDir);
    }
    
    this.maxSteps = options.maxSteps ?? 200;
    this.maxToolRounds = options.maxToolRounds ?? 20000;
    this.idleWarningMs = options.idleWarningMs ?? 300000; // 默认5分钟
    // dataDir 的默认值在 _getDataDir() 中处理，这里保持原始值
    this.dataDir = options.dataDir ?? null;
    this._stopRequested = false;
    this._processingLoopPromise = null;
    
    // ==================== 日志系统（临时） ====================
    // 在 init() 中会重新初始化
    this.loggerRoot = new Logger(normalizeLoggingConfig(null));
    this.log = this.loggerRoot.forModule("runtime");
    
    // ==================== 事件系统模块 ====================
    this._events = new RuntimeEvents({
      logger: this.log
    });
    
    // ==================== 状态管理模块 ====================
    this._state = new RuntimeState({
      logger: this.log
    });
    this._state.addComputeStatusListener((agentId, status) => {
      this._events.emitComputeStatusChange(agentId, status);
    });
    _provideRuntimeEvents(this._events);
    _provideLlmConversations(this._state);
    
    // ==================== 向后兼容：通过 getter 暴露状态属性 ====================
    Object.defineProperties(this, {
      _agents:               { get() { return this._state._agents; },               enumerable: true, configurable: true },
      _agentMetaById:        { get() { return this._state._agentMetaById; },        enumerable: true, configurable: true },
      _agentComputeStatus:   { get() { return this._state._agentComputeStatus; },   enumerable: true, configurable: true },
      _activeProcessingAgents:{ get() { return this._state._activeProcessingAgents; },enumerable: true, configurable: true },
      _conversations:        { get() { return this._state._conversations; },        enumerable: true, configurable: true },
      _taskWorkspaces:       { get() { return this._state._taskWorkspaces; },       enumerable: true, configurable: true },
      _agentTaskBriefs:      { get() { return this._state._agentTaskBriefs; },      enumerable: true, configurable: true },
      _stateLocks:           { get() { return this._state._stateLocks; },           enumerable: true, configurable: true },
      _agentLastActivityTime:{ get() { return this._idleMonitor._lastActivity; },   enumerable: true, configurable: true },
      _idleWarningEmitted:   { get() { return this._idleMonitor._warningEmitted; }, enumerable: true, configurable: true },
    });
    
    // ==================== 行为注册表 ====================
    this._behaviorRegistry = new Map();

    // 必须在 ConversationManager 之前初始化，因为 ConversationManager 需要 lifecycleRegistry
    /** @type {LifecycleRegistry} 资源生命周期注册表 */
    this.lifecycleRegistry = new LifecycleRegistry();

    // ConversationManager 懒加载：首次访问时自举，无需 bootstrap 代劳
    Object.defineProperty(this, '_conversationManager', {
      get() {
        const cm = new ConversationManager({
          conversations: this._state.getConversations(),
          logger: this.loggerRoot.forModule("conversation"),
          lifecycleRegistry: this.lifecycleRegistry,
          configService: this._configService,
          llmClient: this.llm,
          promptsLoader: this.prompts,
          agents: this._agents,
          org: this.org,
        });
        Object.defineProperty(this, '_conversationManager', {
          value: cm,
          enumerable: true,
          configurable: true
        });
        return cm;
      },
      enumerable: true,
      configurable: true
    });
    
    // ==================== 任务和工作空间映射 ====================
    this._rootTaskAgentByTaskId = new Map();
    this._agentIdToTaskId = new Map();  // 反向索引：agentId → taskId（O(1) 查找）
    this._rootTaskRoleByTaskId = new Map();
    this._rootTaskEntryAgentAnnouncedByTaskId = new Set();
    // _agentLastActivityTime 和 _idleWarningEmitted 已迁移到 IdleMonitor
    
    // ==================== 临时服务实例 ====================
    // workspaceManager 现在由 workspace_manager.js 的 registry.declare 统一管理
    this.moduleLoader = new ModuleLoader({ logger: this.loggerRoot.forModule("modules") });
    this.serviceRegistry = null;
    this.modelSelector = null;
    this.capabilityRouter = null;
    this.contentAdapter = null;
    /** @type {Map<string, LlmClient>} */
    // llmClientPool 已迁移到 LlmClientPoolManager，引用在 _llmClientPool 初始化后设置
    this.toolGroupManager = new ToolGroupManager({ registerBuiltins: false, logger: this.loggerRoot.forModule("tool_groups") });
    
    // ==================== 子模块初始化 ====================
    // 这些子模块封装了 Runtime 的具体功能实现
    /** @type {RuntimeState} 状态管理器 */
    this._stateManager = this._state;
    /** @type {RuntimeEvents} 事件系统 */
    this._eventsManager = this._events;
    /** @type {JavaScriptExecutor} JavaScript 执行器（Node.js 降级模式） */
    this._jsExecutor = new JavaScriptExecutor(this);
    /** @type {BrowserJavaScriptExecutor} 浏览器 JavaScript 执行器 */
    this._browserJsExecutor = new BrowserJavaScriptExecutor(this);
    /** @type {ContextBuilder} 上下文构建器 */
    this._contextBuilder = new ContextBuilder(this);
    /** @type {AgentManager} 智能体管理器 */
    this._agentManager = new AgentManager(this);
    /** @type {AgentMemoryManager} 智能体记忆管理器 */
    this.agentMemoryManager = new AgentMemoryManager(this);
    /** @type {KnowledgeTreeSystem} 知识树子系统 */
    this.knowledgeTree = new KnowledgeTreeSystem(this);
    /** @type {RuntimeLifecycle} 生命周期管理器 */
    this._lifecycle = new RuntimeLifecycle(this);
    /** @type {ToolExecutor} 工具执行器 */
    this._toolExecutor = new ToolExecutor(this);
    /** @type {RuntimeTools} 工具管理器 */
    this._tools = new RuntimeTools(this);
    /** @type {RuntimeLlm} LLM 交互管理器 */
    this._llm = new RuntimeLlm(this);
    /** @type {AgentCancelManager} 智能体取消/停止信号管理器 */
    this._cancelManager = new AgentCancelManager({ logger: this.log });
    /** @type {TurnEngine} 回合引擎（协程式） */
    this._turnEngine = new TurnEngine(this);
    /** @type {ComputeScheduler} 协程式计算调度器 */
    this._computeScheduler = new ComputeScheduler(this, this._turnEngine);
    /** @type {ShutdownManager} 关闭管理器 */
    this._shutdownManager = new ShutdownManager(this);
    /** @type {BootstrapManager} 启动管理器 */
    this._bootstrapManager = new BootstrapManager(this);
    /** @type {ReplyManager} 回复管理器 */
    this._replyManager = new ReplyManager(this);
    /** @type {LlmClientPoolManager} LLM 客户端池 */
    this._llmClientPool = new LlmClientPoolManager(this);
    _provideAgentLlmClients(this._llmClientPool);
    // 向后兼容：保留 this.llmClientPool 作为 Map 的别名
    this.llmClientPool = this._llmClientPool._pool;
    /** @type {IdleMonitor} 空闲监控器 */
    this._idleMonitor = new IdleMonitor(this);
    this._systemPromptManager = new SystemPromptManager(this);
    this._systemPromptProviders = this._systemPromptManager._providers;
    this._taskIdResolver = new TaskIdResolver(this);
    this._agentQueueManager = new AgentQueueManager(this);
    this._toolImplementations = new ToolImplementations(this);
    this._javascriptToolRunner = new JavaScriptToolRunner(this);
  }

  // ==================== 公共属性访问器 ====================

  /**
   * 获取关闭管理器
   * @returns {ShutdownManager}
   */
  get shutdownManager() {
    return this._shutdownManager;
  }

  get configService() {
    return this._configService;
  }

  // ==================== 系统提示词注入接口 ====================

  /**
   * 注册系统提示词提供者
   * 模块可以通过此方法向 system prompt 注入动态内容
   * 
   * @param {string} providerId - 提供者唯一标识
   * @param {Function} providerFn - 返回提示词字符串的函数
   */
  registerSystemPromptProvider(providerId, providerFn) {
    this._systemPromptManager.registerSystemPromptProvider(providerId, providerFn);
  }

  /**
   * 注销系统提示词提供者
   * @param {string} providerId - 提供者唯一标识
   */
  unregisterSystemPromptProvider(providerId) {
    this._systemPromptManager.unregisterSystemPromptProvider(providerId);
  }

  /**
   * 获取所有系统提示词追加内容
   * @returns {string}
   */
  getSystemPromptAppendix() {
    return this._systemPromptManager.getSystemPromptAppendix();
  }

  // ==================== 事件系统接口 ====================
  // 以下方法委托给 RuntimeEvents 子模块处理

  /**
   * 注册工具调用事件监听器
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {(event: {agentId: string, toolName: string, args: object, result: any, taskId: string|null}) => void} listener
   */
  onToolCall(listener) {
    this._events.onToolCall(listener);
  }

  /**
   * 触发工具调用事件
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {{agentId: string, toolName: string, args: object, result: any, taskId: string|null}} event
   */
  _emitToolCall(event) {
    this._events.emitToolCall(event);
  }

  /**
   * 注册错误事件监听器
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {(event: {agentId: string, errorType: string, message: string, timestamp: string, [key: string]: any}) => void} listener
   */
  onError(listener) {
    this._events.onError(listener);
  }

  /**
   * 触发错误事件（用于向前端广播错误）
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {{agentId: string, errorType: string, message: string, timestamp: string, [key: string]: any}} event
   */
  _emitError(event) {
    this._events.emitError(event);
  }

  /**
   * 注册 LLM 重试事件监听器
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {(event: {agentId: string, attempt: number, maxRetries: number, delayMs: number, errorMessage: string, timestamp: string}) => void} listener
   */
  onLlmRetry(listener) {
    this._events.onLlmRetry(listener);
  }

  /**
   * 触发 LLM 重试事件
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {{agentId: string, attempt: number, maxRetries: number, delayMs: number, errorMessage: string, timestamp: string}} event
   */
  _emitLlmRetry(event) {
    this._events.emitLlmRetry(event);
  }

  /**
   * 触发运算状态变更事件
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {string} agentId - 智能体ID
   * @param {'idle'|'waiting_llm'|'processing'|'stopping'|'stopped'|'terminating'} status - 新状态
   */
  _emitComputeStatusChange(agentId, status) {
    this._events.emitComputeStatusChange(agentId, status);
  }

  /**
   * 注册运算状态变更事件监听器
   * 
   * 【委托】委托给 RuntimeEvents 处理
   * 
   * @param {(event: {agentId: string, status: string, timestamp: string}) => void} listener
   */
  onComputeStatusChange(listener) {
    this._events.onComputeStatusChange(listener);
  }

  // ==================== 消息处理接口 ====================
  // 以下方法委托给 RuntimeMessaging / ComputeScheduler 处理

  /**
   * 启动常驻异步消息循环（不阻塞调用者）
   * 
   * 【委托】委托给 RuntimeMessaging 处理
   * 
   * @returns {void}
   */
  startProcessing() {
    this._computeScheduler.start();
  }

  /**
   * 运行消息循环直到消息耗尽或达到步数上限
   * 
   * 【委托】委托给 RuntimeMessaging 处理
   * 
   * @returns {void}
   */
  run() {
    this._computeScheduler.start();
  }

  // ==================== 状态管理接口 ====================
  // 以下方法委托给 RuntimeState 子模块处理

  /**
   * 获取智能体状态锁（用于原子性操作）
   * 
   * 【委托】委托给 RuntimeState 处理
   * 【实现】使用 Promise 队列实现简单的互斥锁机制
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<Function>} 返回释放锁的函数
   */
  async _acquireLock(agentId) {
    return await this._state.acquireLock(agentId);
  }

  /**
   * 释放智能体状态锁
   * 
   * 【委托】委托给 RuntimeState 处理
   * 
   * @param {Function} releaseFn - 释放函数
   */
  _releaseLock(releaseFn) {
    this._state.releaseLock(releaseFn);
  }

  /**
   * 设置智能体的运算状态
   * 
   * 【委托】委托给 RuntimeState 处理
   * 
   * @param {string} agentId - 智能体ID
   * @param {'idle'|'waiting_llm'|'processing'|'stopping'|'stopped'|'terminating'} status - 新状态
   */
  setAgentComputeStatus(agentId, status) {
    this._state.setAgentComputeStatus(agentId, status);
  }

  /**
   * 获取智能体的运算状态
   * 
   * 【委托】委托给 RuntimeState 处理
   * 
   * @param {string} agentId - 智能体ID
   * @returns {'idle'|'waiting_llm'|'processing'|'stopping'|'stopped'|'terminating'|null}
   */
  getAgentComputeStatus(agentId) {
    return this._state.getAgentComputeStatus(agentId);
  }

  /**
   * 获取智能体当前运算阶段描述（委托给 RuntimeState）。
   * @param {string} agentId
   * @returns {string|null}
   */
  getAgentComputePhase(agentId) {
    return this._state.getAgentComputePhase(agentId);
  }

  // ==================== 初始化方法 ====================
  // Runtime 核心协调器的主要职责：初始化和配置管理

  /**
   * 初始化平台能力组件
   * 
   * 【初始化流程】
   * 1. 加载配置文件
   * 2. 初始化日志系统
   * 3. 初始化核心服务（MessageBus、OrgPrimitives、PromptLoader、LlmClient）
   * 4. 加载系统提示词
   * 5. 初始化辅助服务（HttpClient、WorkspaceManager）
   * 6. 初始化工具组管理器
   * 7. 初始化模块加载器并加载模块
   * 8. 初始化 LLM 服务注册表和模型选择器
   * 9. 初始化内容适配器和内容路由器
   * 10. 配置对话历史管理
   * 11. 恢复智能体实例
   * 12. 加载对话历史
   * 13. 初始化浏览器 JavaScript 执行器
   * 
   * @returns {Promise<void>}
   */
  async init() {
    await this._bootstrapManager.bootstrap();
  }

  /**
   * 刷新内存中的状态（当组织数据变更时触发）。
   * @param {string} type - 变更类型
   * @param {any} data - 变更数据
   * @private
   */
  _refreshInMemoryState(type, data) {
    if (type === "role_updated") {
      const updatedRole = data;
      // 更新所有具有该 roleId 的内存智能体实例的 Prompt
      for (const agent of this._agents.values()) {
        if (agent.roleId === updatedRole.id) {
          agent.rolePrompt = updatedRole.rolePrompt;
          void this.log.debug("同步更新智能体 Prompt", { agentId: agent.id, roleId: updatedRole.id });
        }
      }
    } else if (type === "agent_updated") {
      const updatedAgentMeta = data;
      const agent = this._agents.get(updatedAgentMeta.id);
      if (agent) {
        // 如果名字有变化，可能需要更新（Agent 类目前没有 name 属性，但 meta 中有）
        // 主要是确保 meta 同步
        this._agentMetaById.set(updatedAgentMeta.id, {
          id: updatedAgentMeta.id,
          roleId: updatedAgentMeta.roleId,
          parentAgentId: updatedAgentMeta.parentAgentId ?? null
        });
        void this.log.debug("同步更新智能体元数据", { agentId: updatedAgentMeta.id });
      }
    }
    // 其他类型（如 created/deleted）通常由 lifecycle 的相应方法处理，
    // 这里主要处理由外部（如 HTTP）直接修改数据导致的同步问题。
  }

  /**
   * 从组织状态恢复智能体实例到内存中。
   * 在服务器重启后调用，确保之前创建的智能体能够继续处理消息。
   * @returns {Promise<void>}
   */
  async _restoreAgentsFromOrg() {
    return await this._lifecycle.restoreAgentsFromOrg();
  }

  /**
   * 注册某个岗位名对应的行为工厂。
   * @param {string} roleName
   * @param {(ctx: any) => Function} behaviorFactory
   */
  registerRoleBehavior(roleName, behaviorFactory) {
    this._lifecycle.registerRoleBehavior(roleName, behaviorFactory);
  }

  /**
   * 向运行时注册一个智能体实例。
   * @param {Agent} agent
   */
  registerAgentInstance(agent) {
    this._lifecycle.registerAgentInstance(agent);
  }

  /**
   * 列出当前运行时已注册的智能体实例（仅用于对外选择/检索）。
   * @returns {{id:string, roleId:string, roleName:string}[]}
   */
  listAgentInstances() {
    return this._lifecycle.listAgentInstances();
  }

  /**
   * 获取指定智能体的状态信息。
   * @param {string} agentId
   * @returns {{id:string, roleId:string, roleName:string, parentAgentId:string|null, status:string, queueDepth:number, conversationLength:number}|null}
   */
  getAgentStatus(agentId) {
    return this._lifecycle.getAgentStatus(agentId);
  }

  /**
   * 获取所有智能体的队列深度。
   * @returns {{agentId:string, queueDepth:number}[]}
   */
  getQueueDepths() {
    return this._lifecycle.getQueueDepths();
  }

  /**
   * 根据岗位创建并注册智能体实例。
   * @param {{roleId:string, parentAgentId:string}} input
   * @returns {Promise<Agent>}
   */
  async spawnAgent(input) {
    return await this._lifecycle.spawnAgent(input);
  }

  /**
   * 以“调用者智能体”身份创建子级智能体：parentAgentId 由系统自动填充。
   * @param {string} callerAgentId
   * @param {{roleId:string, taskBrief?:object, name?:string}} input
   * @returns {Promise<Agent>}
   */
  async spawnAgentAs(callerAgentId, input) {
    return await this._lifecycle.spawnAgentAs(callerAgentId, input);
  }

  /**
   * 通过祖先链查找智能体的工作空间ID。
   * 从当前智能体开始向上查找，直到找到第一个有工作空间的祖先。
   * @param {string} agentId
   * @returns {string|null} 工作空间ID，如果没有则返回 null
   */
  findWorkspaceIdForAgent(agentId) {
    return this._lifecycle.findWorkspaceIdForAgent(agentId);
  }

  /**
   * 中止智能体的 LLM 调用。
   * @param {string} agentId - 智能体ID
   * @returns {{ok: boolean, agentId: string, aborted: boolean}} 中止结果
   */
  abortAgentLlmCall(agentId) {
    return this._lifecycle.abortAgentLlmCall(agentId);
  }

  /**
   * 重新生成指定智能体最后一条 assistant 回复。
   * 该流程会先截断会话中的最后一条 assistant 消息，再复用现有调度器重新发起 LLM 回合。
   * @param {string} agentId
   * @param {string} messageId
   * @param {{responseTarget?:string|null, taskId?:string|null}} [options]
   * @returns {Promise<{ok:boolean, turnId?:string, removedMessageIds?:string[], error?:string, status?:string, message?:string}>}
   */
  async regenerateLastAssistantReply(agentId, messageId, options) {
    return this._replyManager.regenerateLastAssistantReply(agentId, messageId, options);
  }

  /**
   * 对用户最后一条消息生成回复。
   * - 如果有用户消息且有 assistant 回复，使用 enqueueRegenerateTurn 重新生成
   * - 如果有用户消息但没有 assistant 回复，触发调度器继续处理（不重复添加消息）
   * - 如果没有用户消息，使用 bus.send() 发送新消息
   * @param {string} agentId
   * @param {string} [messageContent] - 用户消息内容（可选）
   * @returns {Promise<{ok:boolean, turnId?:string, error?:string, status?:string, message?:string}>}
   */
  async generateReplyForLastUserMessage(agentId, messageContent) {
    return this._replyManager.generateReplyForLastUserMessage(agentId, messageContent);
  }

  /**
   * 强制终止指定智能体及其后代（用于 HTTP/管理员侧删除）。
   * @param {string} agentId
   * @param {{deletedBy?:string, reason?:string}} [options]
   * @returns {Promise<{ok:boolean, agentId:string, termination?:any, reason?:string}>}
   */
  async forceTerminateAgent(agentId, options = {}) {
    return await this._lifecycle.forceTerminateAgent(agentId, options);
  }

  /**
   * 删除岗位及其所有子岗位和智能体。
   * 会先停止所有相关智能体的执行，然后删除岗位数据。
   * @param {string} roleId - 要删除的岗位ID
   * @param {string} deletedBy - 执行删除的用户或智能体ID
   * @param {string} [reason] - 删除原因
   * @returns {Promise<{ok:boolean, roleId:string, deleteResult?:object, error?:string}>}
   */
  async deleteRole(roleId, deletedBy, reason) {
    return await this._lifecycle.deleteRole(roleId, deletedBy, reason);
  }

  /**
   * 注册内置工具组的实际工具定义。
   * 在 init() 中调用，用实际的工具定义替换 ToolGroupManager 中的占位符。
   * @private
   */
  _registerBuiltinToolGroups() {
    this._tools.registerBuiltinToolGroups();
  }

  /**
   * 获取指定智能体可用的工具定义。
   * 根据智能体岗位配置的工具组返回相应的工具定义。
   * @param {string} agentId - 智能体ID
   * @returns {any[]} 工具定义列表
   */
  getToolDefinitionsForAgent(agentId) {
    return this._tools.getToolDefinitionsForAgent(agentId);
  }

  /**
   * 检查工具是否对指定智能体可用。
   * @param {string} agentId - 智能体ID
   * @param {string} toolName - 工具名称
   * @returns {boolean}
   */
  isToolAvailableForAgent(agentId, toolName) {
    return this._tools.isToolAvailableForAgent(agentId, toolName);
  }

  /**
   * 返回可供 LLM 工具调用的工具定义（OpenAI tools schema）。
   * @returns {any[]}
   */
  /**
   * 生成工具组可选值的描述文本。
   * 从 toolGroupManager 动态获取所有已注册的工具组。
   * @returns {string}
   */
  _generateToolGroupsDescription() {
    return this._tools.generateToolGroupsDescription();
  }

  getToolDefinitions() {
    return this._tools.getToolDefinitions();
  }

  /**
   * 执行一次工具调用并返回可序列化结果。
   * 
   * 本方法将工具执行委托给 ToolExecutor 子模块，避免代码重复。
   * 
   * @param {any} ctx - 智能体上下文
  }

  /**
   * 执行一次工具调用并返回可序列化结果。
   * 
   * 本方法将工具执行委托给 ToolExecutor 子模块，避免代码重复。
   * 
   * @param {any} ctx - 智能体上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>} 执行结果
   */
  async executeToolCall(ctx, toolName, args) {
    return await this._tools.executeToolCall(ctx, toolName, args);
  }

  /**
   * 生成当前智能体的 system prompt（包含工具调用规则）。
   * @param {any} ctx - 智能体上下文
   * @param {any} [llmClient] - 可选的 LlmClient 实例，用于判断是否支持工具调用
   * @returns {Promise<string>}
   */
  async _buildSystemPromptForAgent(ctx, llmClient) {
    // 委托给 RuntimeLlm 处理
    return await this._llm.buildSystemPromptForAgent(ctx, llmClient);
  }

  /**
   * 将运行时消息格式化为 LLM 可理解的文本输入。
   * @param {any} ctx - 智能体上下文
   * @param {any} message - 消息对象
   * @param {{trailingText?: string}} [options] - 需要在记忆前追加到消息正文末尾的附加文本
   * @returns {Promise<string|any[]>}
   */
  async _formatMessageForLlm(ctx, message, options) {
    // 委托给 RuntimeLlm 处理
    return await this._llm.formatMessageForLlm(ctx, message, options);
  }

  /**
   * 获取发送者信息（用于消息格式化）
   * @param {string} senderId - 发送者ID
   * @returns {{role: string}|null}
   */
  _getSenderInfo(senderId) {
    // 委托给 RuntimeLlm 处理
    return this._llm.getSenderInfo(senderId);
  }

  /**
   * 获取或确保某个智能体的会话上下文已准备就绪。
   * 
   * 【职责】
   * 将会话上下文的确保逻辑委托给 ConversationManager。
   *
   * @param {string} agentId - 智能体ID
   * @returns {any[]} 会话消息数组（纯对话转录，不含 system）
   */
  _ensureConversation(agentId) {
    return this._conversationManager.ensureConversation(agentId);
  }

  /**
   * 构建注入给智能体的运行时上下文。
   * @param {Agent} [agent]
   * @returns {any}
   */
  _buildAgentContext(agent) {
    // 委托给 ContextBuilder 处理
    return this._contextBuilder.buildAgentContext(agent);
  }

  /**
   * 获取指定 LLM 服务的客户端实例。
   * 如果服务不存在或未配置，返回 null。
   * @param {string} serviceId - LLM 服务 ID
   * @returns {Promise<LlmClient|null>} LlmClient 实例，如果服务不存在则返回 null
   */
  async getLlmClientForService(serviceId) {
    return this._llmClientPool.getClientForService(serviceId);
  }

  /**
   * 获取智能体应使用的 LlmClient。
   * 根据智能体岗位的 llmServiceId 获取对应的 LlmClient，如果未指定或服务不可用则使用默认 LlmClient。
   * @param {string} agentId - 智能体ID
   * @returns {Promise<LlmClient|null>} LlmClient 实例
   */
  async getLlmClientForAgent(agentId) {
    return this._llmClientPool.getClientForAgent(agentId);
  }

  /**
   * 为指定智能体生成推荐回复建议。
   *
   * 【设计原则】
   * 1. 上下文隔离：此调用完全绕过 TurnEngine、ConversationManager、ComputeScheduler
   * 2. 只读上下文：从对话管理器中读取最近几条消息作为上下文，不修改任何对话状态
   * 3. 同模型服务：使用智能体相同的 LlmClient 实例（相同模型、提供商、API 密钥）
   *
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean, suggestions: string[], error?: string}>}
   */
  async suggestRepliesForAgent(agentId) {
    return this._replyManager.suggestRepliesForAgent(agentId);
  }

  /**
   * 获取智能体使用的 LLM 服务 ID
   * @param {string} agentId - 智能体ID
   * @returns {string|null} LLM 服务 ID，如果使用默认服务则返回 null
   */
  getLlmServiceIdForAgent(agentId) {
    return this._llmClientPool.getServiceIdForAgent(agentId);
  }

  /**
   * 尝试初始化模型选择器。
   * 检查是否具备初始化条件（默认 LLM 和提示词模板），如果具备且尚未初始化，则执行初始化。
   * @private
   * @returns {Promise<void>}
   */
  async _tryInitModelSelector() {
    return this._bootstrapManager._tryInitModelSelector();
  }

  /**
   * 获取智能体所属的 taskId。
   * 通过追溯智能体的创建链，找到由 root 创建的入口智能体对应的 taskId。
   * @param {string} agentId
   * @returns {string|null}
   */
  _getAgentTaskId(agentId) {
    return this._taskIdResolver._getAgentTaskId(agentId);
  }

  /**
   * 获取智能体对应的 taskId（用于工作空间访问）。
   * 这是 _getAgentTaskId 的别名，用于工具执行时查找工作空间。
   * @param {string} agentId
   * @returns {string|null}
   */
  _getTaskIdForAgent(agentId) {
    return this._taskIdResolver.getTaskIdForAgent(agentId);
  }

  /**
   * 执行智能体删除操作。
   * 权限校验后调用 forceTerminateAgent 执行实际的终止逻辑。
   * @param {any} ctx
   * @param {{agentId:string, reason?:string}} args
   * @returns {Promise<{ok:boolean, deletedAgentId?:string, error?:string, agentId?:string}>}
   */
  async _executeDeleteAgent(ctx, args) {
    return this._toolImplementations._executeDeleteAgent(ctx, args);
  }

  /**
   * 获取数据目录路径
   * 
   * 优先级：
   * 1. config.runtimeDir 的父目录
   * 2. 构造函数传入的 dataDir
   * 3. 默认的 'agent-society-data'
   * 
   * 【约束】
   * 此方法仅在 Runtime 初始化期间调用，用于确定数据目录。
   * 其他地方应直接使用 this.dataDir，如果为 null/undefined 则抛出异常。
   * 
   * @returns {string}
   * @private
   */
  _getDataDir() {
    if (this.config?.runtimeDir) {
      return path.dirname(this.config.runtimeDir);
    }
    if (this.dataDir) {
      return this.dataDir;
    }
    return "agent-society-data";
  }

  /**
   * 删除智能体数据文件夹
   * 
   * 最多尝试5次，间隔2秒，失败打印警告日志不中断程序。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<void>}
   * @private
   */
  async deleteAgentDataFolder(agentId) {
    return deleteAgentDataFolderUtility(this._getDataDir(), agentId, this.log);
  }

  /**
   * 处理智能体队列中的待处理消息（在终止前调用）。
   * @param {string} agentId
   * @returns {Promise<void>}
   */
  async _drainAgentQueue(agentId) {
    return this._agentQueueManager._drainAgentQueue(agentId);
  }

  /**
   * 收集指定智能体的所有后代智能体 ID（用于级联终止）。
   * @param {string} parentId - 父智能体 ID
   * @returns {string[]} 后代智能体 ID 数组
   */
  _collectDescendantAgents(parentId) {
    return this._agentQueueManager._collectDescendantAgents(parentId);
  }

  /**
   * 级联停止所有子智能体。
   * @param {string} parentAgentId - 父智能体 ID
   * @returns {string[]} 被停止的智能体 ID 列表
   */
  _cascadeStopAgents(parentAgentId) {
    return this._lifecycle.cascadeStopAgents(parentAgentId);
  }

  /**
   * 执行 spawn_agent_with_task：创建智能体并立即发送任务消息。
   * @param {any} ctx
   * @param {{roleId:string, taskBrief?:object, initialMessage:object}} args
   * @returns {Promise<{ok:true, id:string, roleId:string, roleName:string, messageId:string}|{ok:false, error:string, details?:string}>}
   */
  async _executeSpawnAgentWithTask(ctx, args) {
    return this._toolImplementations._executeSpawnAgentWithTask(ctx, args);
  }

  async _runJavaScriptTool(args, messageId = null, agentId = null, workspaceId = null) {
    return await this._javascriptToolRunner._runJavaScriptTool(args, messageId, agentId, workspaceId);
  }

  _detectBlockedJavaScriptTokens(code) {
    return this._javascriptToolRunner._detectBlockedJavaScriptTokens(code);
  }

  _toJsonSafeValue(value) {
    return toJsonSafeValue(value);
  }

  /**
   * 更新智能体的最后活动时间。
   * @param {string} agentId
   */
  _updateAgentActivity(agentId) {
    this._idleMonitor.updateActivity(agentId);
  }

  /**
   * 获取智能体的最后活动时间。
   * @param {string} agentId
   * @returns {number|null} 时间戳（毫秒），如果智能体不存在则返回null
   */
  getAgentLastActivityTime(agentId) {
    return this._idleMonitor.getLastActivityTime(agentId);
  }

  /**
   * 获取智能体的空闲时长（毫秒）。
   * @param {string} agentId
   * @returns {number|null} 空闲时长（毫秒），如果智能体不存在则返回null
   */
  getAgentIdleTime(agentId) {
    return this._idleMonitor.getIdleTime(agentId);
  }

  /**
   * 检查所有智能体的空闲状态，对超过配置时长的智能体发出警告。
   * @returns {{agentId:string, idleTimeMs:number}[]} 空闲超时的智能体列表
   */
  checkIdleAgents() {
    return this._idleMonitor.checkIdleAgents();
  }

  /**
   * 设置空闲警告阈值（毫秒）。
   * @param {number} ms
   */
  setIdleWarningMs(ms) {
    this.idleWarningMs = ms;
  }

  /**
   * 设置优雅关闭处理。
   * 监听 SIGINT 和 SIGTERM 信号，执行优雅关闭流程。
   * 第一次 Ctrl+C 触发优雅关闭，第二次 Ctrl+C 强制退出。
   * @param {{httpServer?:any, shutdownTimeoutMs?:number}} [options]
   * @returns {void}
   */
  setupGracefulShutdown(options = {}) {
    if(this._forceExit){
      process.stderr.write("[runtime] _forceExit 为 true，通过 ShutdownManager 退出\n");
      void this._shutdownManager.shutdown();
      return;
    }
    const httpServer = options.httpServer ?? null;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30000;

    // 防止重复设置
    if (this._gracefulShutdownSetup) {
      void this.log.warn("优雅关闭已设置，跳过重复设置", {
        callStack: new Error("重复调用检测").stack
      });
      return;
    }
    this._gracefulShutdownSetup = true;
    this._httpServerRef = httpServer;
    this._shutdownTimeoutMs = shutdownTimeoutMs;

    // 信号处理已由 ShutdownManager 统一管理，此处仅完成运行时引用注入
    void this.log.info("关闭引用已注入 ShutdownManager", { shutdownTimeoutMs });
  }

  /**
   * 检查是否正在关闭中。
   * @returns {boolean}
   */
  isShuttingDown() {
    return this._shutdownManager.isShuttingDown();
  }

  /**
   * 获取关闭状态信息。
   * @returns {{isShuttingDown:boolean, shutdownStartTime:number|null, shutdownTimeoutMs:number|null}}
   */
  getShutdownStatus() {
    return this._shutdownManager.getShutdownStatus();
  }

  /**
   * 手动触发优雅关闭（用于测试或程序化关闭）。
   * 委托给 ShutdownManager 统一处理。
   * @param {{signal?:string}} [options]
   * @returns {Promise<{ok:boolean, pendingMessages:number, activeAgents:number, shutdownDuration:number}>}
   */
  async shutdown(options = {}) {
    return this._shutdownManager.shutdown(options);
  }
}
