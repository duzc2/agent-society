/**
 * BootstrapManager - 运行时初始化管理器
 *
 * 职责：将 Runtime.init() 的初始化流程提取为独立模块，
 * 负责加载配置、初始化所有服务和子模块。
 *
 * @module runtime/bootstrap_manager
 */

import path from "node:path";
import { Logger, normalizeLoggingConfig } from "../utils/logger/logger.js";
import { MemoryMonitor } from "../utils/process/memory_monitor.js";
import { MessageBus } from "../core/message_bus.js";
import { OrgPrimitives } from "../core/org_primitives.js";
import { PromptLoader } from "../prompt_loader.js";
import { LlmClient } from "../services/llm/llm_client.js";
import { HttpClient } from "../services/http/http_client.js";
import { SkillsService } from "../services/skills/skills_service.js";
import { CustomSkillService } from "../services/skills/custom/custom_skill_service.js";
import { GitSkillService } from "../services/skills/git/git_skill_service.js";
import { registry } from "../core/module_registry.js";
import { ToolGroupManager } from "../extensions/tool_group_manager.js";
import { ModuleLoader } from "../extensions/module_loader.js";
import { LlmServiceRegistry } from "../services/llm/llm_service_registry.js";
import { ModelSelector } from "../services/llm/model_selector.js";
import { ContentAdapter } from "../utils/content/content_adapter.js";
import { ContentRouter } from "../utils/content/content_router.js";
import { OrgTemplateRepository } from "../services/org_templates/org_template_repository.js";
import { HeartbeatBroker } from "../services/heartbeat/heartbeat_broker.js";
import { _bootstrapWorkspaceManager } from "../services/workspace/workspace_manager.js";
import "../services/mood/mood_service.js";

export class BootstrapManager {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async bootstrap() {
    const r = this.runtime;

    // 优先使用外部传入的配置对象，否则使用配置服务加载
    if (!r._passedConfig) {
      if (!r._configService) {
        throw new Error("必须提供 config 对象或 configService 实例");
      }
      r.config = await r._configService.loadApp({ dataDir: r.dataDir });
    } else {
      r.config = r._passedConfig;
    }
    r.maxSteps = r.config.maxSteps ?? r.maxSteps;
    r.maxToolRounds = r.config.maxToolRounds ?? r.maxToolRounds;
    r.idleWarningMs = r.config.idleWarningMs ?? r.idleWarningMs;

    // 确保 dataDir 有值（根据 config 或默认值）
    // 此后其他地方可以直接使用 this.dataDir，无需再判断
    r.dataDir = r._getDataDir();

    r.loggerRoot = new Logger(normalizeLoggingConfig(r.config.logging));
    r.log = r.loggerRoot.forModule("runtime");

    r.heartbeatBroker = new HeartbeatBroker({ logger: r.loggerRoot.forModule("heartbeat") });

    // 更新 RuntimeState 的 logger
    r._state.log = r.log;

    // 更新 RuntimeEvents 的 logger
    r._events.log = r.log;

    void r.log.info("运行时初始化开始", {
      maxSteps: r.maxSteps,
      maxToolRounds: r.maxToolRounds,
      idleWarningMs: r.idleWarningMs
    });

    // 启动内存监控
    // 从环境变量读取配置，与启动脚本保持一致
    const rssLimit = parseInt(process.env.BUN_JSC_forceRAMSize || '2147483648', 10); // 默认 2GB
    const gcIntervalMs = parseInt(process.env.AGENT_SOCIETY_GC_INTERVAL_MS || '300000', 10); // 默认 5 分钟

    r._memoryMonitor = new MemoryMonitor({
      logger: r.log,
      rssLimit,
      gcIntervalMs
    });
    r._memoryMonitor.start();

    r.bus = new MessageBus({
      logger: r.loggerRoot.forModule("bus")
    });

    r.prompts = new PromptLoader({ promptsDir: r.config.promptsDir, logger: r.loggerRoot.forModule("prompts") });
    r.org = new OrgPrimitives({ runtimeDir: r.config.runtimeDir, logger: r.loggerRoot.forModule("org") });
    await r.org.loadIfExists();

    // AgentMemoryManager 延迟初始化：首次调用 getOrCreateMemory() 时自动触发
    // 避免启动时加载本地嵌入模型（GGUF）阻塞系统资源

    r.knowledgeTree.initialize().catch((err) => {
      r.log.warn("[Runtime] KnowledgeTree 初始化失败", {
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
      // 不影响系统其他功能继续启动
    });

    // 监听组织数据变更，同步刷新内存状态
    r.org.onDataChange((type, data) => {
      void r.log.debug("检测到组织数据变更，正在同步内存状态", { type });
      r._refreshInMemoryState(type, data);
    });

    r.orgTemplates = new OrgTemplateRepository({ baseDir: path.resolve(process.cwd(), "org"), userBaseDir: path.join(r.dataDir, "org"), logger: r.loggerRoot.forModule("org_templates") });
    r.systemBasePrompt = await r.prompts.loadSystemPromptFile("base.txt");
    r.systemComposeTemplate = await r.prompts.loadSystemPromptFile("compose.txt");
    r.systemToolRules = await r.prompts.loadSystemPromptFile("tool_rules.txt");
    // 加载工作空间使用指南（可选，文件不存在时使用空字符串）
    try {
      r.systemWorkspacePrompt = await r.prompts.loadSystemPromptFile("workspace.txt");
    } catch {
      r.systemWorkspacePrompt = "";
      void r.log.debug("工作空间提示词文件不存在，跳过加载");
    }
    // 全局重试协调器，供 LlmClient 和 ComputeScheduler 共用
    const { RetryCoordinator } = await import("./retry_coordinator.js");
    r._retryCoordinator = new RetryCoordinator();
    r.llm = r.config.llm ? new LlmClient({
      configService: r._configService,
      logger: r.loggerRoot.forModule("llm"),
      retryCoordinator: r._retryCoordinator,
      onRetry: (event) => {
        if (event.agentId && event.attempt != null) {
          r._state.setAgentComputePhase(event.agentId, `正在重试 LLM 调用（第 ${event.attempt} 次）...`);
        }
        r._emitLlmRetry(event);
      }
    }) : null;
    r.httpClient = new HttpClient({ logger: r.loggerRoot.forModule("http") });

    // 初始化新技能系统
    const skillsConfig = r.config?.skills ?? {};
    r.skillsService = new SkillsService({
      runtime: r,
      org: r.org,
      config: skillsConfig,
      dataDir: r._getDataDir(),
      logger: r.loggerRoot.forModule("skills")
    });
    await r.skillsService.initialize();
    r.customSkillService = new CustomSkillService({
      rootDir: r.skillsService.rootDir,
      skillsRepository: r.skillsService.repository,
      logger: r.loggerRoot.forModule("custom_skills")
    });
    await r.customSkillService.initialize();
    r.gitSkillService = new GitSkillService({
      rootDir: r.skillsService.rootDir,
      skillsRepository: r.skillsService.repository,
      logger: r.loggerRoot.forModule("git_skills")
    });
    await r.gitSkillService.initialize();

    // 发布到注册表，等待依赖模块激活
    await registry.provide({
      skillsService: r.skillsService,
      customSkillService: r.customSkillService,
      gitSkillService: r.gitSkillService,
      dataDir: r.dataDir,
    });
    void r.log.info("技能系统已初始化", {
      providers: Object.keys(skillsConfig?.providers ?? {})
    });

    // 初始化工具组管理器（带 logger，注册内置工具组）
    r.toolGroupManager = new ToolGroupManager({
      logger: r.loggerRoot.forModule("tool_groups"),
      registerBuiltins: true
    });
    // 用实际的工具定义更新内置工具组
    r._registerBuiltinToolGroups();

    // 初始化模块加载器并加载配置中启用的模块
    r.moduleLoader = new ModuleLoader({ logger: r.loggerRoot.forModule("modules") });
    // 支持数组格式 (length > 0) 和对象格式 (Object.keys().length > 0)
    const hasModules = r.config.modules && (
      (Array.isArray(r.config.modules) && r.config.modules.length > 0) ||
      (!Array.isArray(r.config.modules) && typeof r.config.modules === "object" && Object.keys(r.config.modules).length > 0)
    );
    if (hasModules) {
      const moduleResult = await r.moduleLoader.loadModules(r.config.modules, r);
      void r.log.info("模块加载完成", {
        loaded: moduleResult.loaded,
        errors: moduleResult.errors.length
      });
    }

    // 初始化 LLM 服务注册表和模型选择器
    // 获取配置目录：优先使用配置服务的目录，否则使用默认目录
    const configDir = r._configService?.configDir ?? "config";
    r.serviceRegistry = new LlmServiceRegistry({
      configDir: configDir,
      logger: r.loggerRoot.forModule("llm_service_registry"),
      configService: r._configService
    });
    await r.serviceRegistry.load();
    r._llmServicesSnapshot = await r.serviceRegistry.getServices();
    r._registerBuiltinToolGroups();

    // 初始化模型选择器 (ModelSelector)
    await this._tryInitModelSelector();

    // 初始化内容适配器
    r.contentAdapter = new ContentAdapter({
      serviceRegistry: r.serviceRegistry,
      logger: r.loggerRoot.forModule("content_adapter")
    });

    // 初始化内容路由器
    r.contentRouter = new ContentRouter({
      serviceRegistry: r.serviceRegistry,
      contentAdapter: r.contentAdapter,
      logger: r.loggerRoot.forModule("content_router")
    });

    void r.log.info("内容路由器初始化完成");

    // 在 registry.declare 激活前，提前创建 WorkspaceManager 模块单例
    // 因为 restoreAgentsFromOrg 需要通过 getWorkspaceManager() 访问工作区
    _bootstrapWorkspaceManager({
      workspacesDir: r.config.workspacesDir ?? null,
      dataDir: r.dataDir,
      logger: r.loggerRoot.forModule("workspace")
    });

    // 从持久化的组织状态恢复智能体实例
    await r._restoreAgentsFromOrg();

    // 对话历史延迟加载：首次访问某个智能体的对话时，
    // getConversation() 会通过 loadConversationSync() 自动从磁盘加载
    // 不再在启动时全量加载所有对话文件

    // 延迟初始化浏览器 JavaScript 执行器：首次执行 JS 时通过 _ensureBrowser() 自动启动
    // 避免 ~700ms 的 Puppeteer Chrome 启动阻塞
    r._browserJsExecutor.init().catch((err) => {
      r.log.warn("[Runtime] JS执行器浏览器初始化失败", {
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
    });

    void r.log.info("运行时初始化完成", {
      agents: r._agents.size,
      browserJsExecutorAvailable: false  // 延迟初始化，启动时不阻塞
    });
  }

  async _tryInitModelSelector() {
    const r = this.runtime;
    if (r.modelSelector) return;

    try {
      // 加载模型选择提示词模板
      let modelSelectorPrompt = "";
      try {
        modelSelectorPrompt = await r.prompts.loadSystemPromptFile("model_selector.txt");
      } catch {
        void r.log.debug("模型选择提示词模板加载失败，暂不初始化模型选择器");
        return;
      }

      // 初始化模型选择器（仅当有默认 LLM 和提示词模板时）
      if (r.llm && modelSelectorPrompt) {
        r.modelSelector = new ModelSelector({
          llmClient: r.llm,
          serviceRegistry: r.serviceRegistry,
          promptTemplate: modelSelectorPrompt,
          logger: r.loggerRoot.forModule("model_selector")
        });
        void r.log.info("模型选择器已延迟初始化完成", {
          hasServices: (await r.serviceRegistry?.hasServices()) ?? false,
          serviceCount: (await r.serviceRegistry?.getServiceCount()) ?? 0
        });
      }
    } catch (err) {
      void r.log.warn("尝试延迟初始化模型选择器失败", {
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
    }
  }
}
