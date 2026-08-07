import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SUPPORTED_LLM_PROVIDERS = ["openai", "anthropic", "local-llama", "open-responses"];
const SUPPORTED_CAPABILITY_INPUT_TYPES = ["text", "vision", "audio", "file"];
const SUPPORTED_CAPABILITY_OUTPUT_TYPES = ["text", "structured_output", "tool_calling"];
const DEFAULT_LLM_CAPABILITY_TAGS = ["text", "tool_calling"];
const DEFAULT_LLM_CAPABILITIES = {
  input: ["text"],
  output: ["text", "tool_calling"]
};
const DEFAULT_LLM_STREAM = true;

/**
 * 创建默认 LLM 能力标签的深拷贝，避免调用方共享同一数组引用。
 * @returns {string[]}
 */
function createDefaultLlmCapabilityTags() {
  return [...DEFAULT_LLM_CAPABILITY_TAGS];
}

/**
 * 创建默认 LLM 能力配置的深拷贝。
 * 默认策略要求主模型被视为支持工具调用，因此输出能力默认包含 tool_calling。
 * @returns {{input: string[], output: string[]}}
 */
function createDefaultLlmCapabilities() {
  return {
    input: [...DEFAULT_LLM_CAPABILITIES.input],
    output: [...DEFAULT_LLM_CAPABILITIES.output]
  };
}

/**
 * 规范化 LLM 的 stream 配置。
 * 设计约束：
 * 1. 历史配置缺少该字段时统一回退到默认值 true；
 * 2. 仅接受显式布尔值，避免脏数据进入请求层；
 * 3. 默认 LLM 与模型服务共用同一语义，保证设置和运行时一致。
 * @param {any} stream
 * @param {boolean} [fallback=DEFAULT_LLM_STREAM]
 * @returns {boolean}
 */
function normalizeLlmStream(stream, fallback = DEFAULT_LLM_STREAM) {
  return typeof stream === "boolean" ? stream : fallback;
}

/**
 * 配置管理器：管理所有配置文件的读取、写入、验证。
 * 
 * 职责：
 * - 读取和解析配置文件（app.json, llmservices.json, logging.json）
 * - 写入和更新配置文件
 * - 配置验证和安全处理（API Key 掩码）
 * 
 * 设计约束：
 * - 优先加载 .local.json 文件
 * - 写入操作总是针对 .local.json 文件
 * - 文件不存在时返回合理的默认值
 */
export class Config {
  /**
   * 构造函数
   * @param {string} configDir - 配置目录路径（相对或绝对）
   * @param {object} [logger] - 可选的日志记录器
   */
  constructor(configDir, logger = null) {
    // 确保 configDir 是绝对路径
    this.configDir = path.isAbsolute(configDir) 
      ? configDir 
      : path.resolve(process.cwd(), configDir);
    
    this.log = logger || {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
    
    // 配置文件路径
    this.appJsonPath = path.join(this.configDir, "app.json");
    this.appLocalJsonPath = path.join(this.configDir, "app.local.json");
    this.llmServicesJsonPath = path.join(this.configDir, "llmservices.json");
    this.llmServicesLocalJsonPath = path.join(this.configDir, "llmservices.local.json");
    this.chatJsonPath = path.join(this.configDir, "chat.json");
    this.modulesJsonPath = path.join(this.configDir, "modules.json");
    this.modulesEnabledJsonPath = path.join(this.configDir, "modules.enabled.json");
    this.modulesConfigDir = path.join(this.configDir, "modules");

    // 模块独立配置注册表：moduleName → { defaults }
    this._moduleConfigs = new Map();

    // 加载后缓存（loadApp 调用后填充，避免各模块重复读盘）
    /** @type {object|null} */
    this._loadedApp = null;
  }

  // ========== 应用配置 ==========
  
  /**
   * 加载应用配置
   * @param {{dataDir?:string}} [options] - 可选配置
   * @returns {Promise<object>} 配置对象
   */
  async loadApp(options = {}) {
    // 确定配置文件路径（优先 local）
    let configPath;
    if (existsSync(this.appLocalJsonPath)) {
      configPath = this.appLocalJsonPath;
    } else if (existsSync(this.appJsonPath)) {
      configPath = this.appJsonPath;
    } else {
      throw new Error(`配置文件不存在: ${this.appJsonPath}`);
    }

    const raw = await readFile(configPath, "utf8");
    const cfg = JSON.parse(raw);

    // 加载日志配置
    const loggingConfigPath = cfg.loggingConfigPath
      ? path.resolve(process.cwd(), String(cfg.loggingConfigPath))
      : null;
    let logging = loggingConfigPath ? await this._loadOptionalJson(loggingConfigPath) : null;

    // 处理 dataDir
    const dataDir = options.dataDir
      ? (path.isAbsolute(options.dataDir) ? options.dataDir : path.resolve(process.cwd(), options.dataDir))
      : null;

    // 如果提供了 dataDir，尝试加载 dataDir 下的 logging.json（优先级高于全局配置）
    if (dataDir) {
      const dataDirLoggingPath = path.resolve(dataDir, "logging.json");
      const dataDirLogging = await this._loadOptionalJson(dataDirLoggingPath);
      if (dataDirLogging) {
        logging = dataDirLogging;
      }
    }

    // 如果提供了 dataDir，覆盖日志目录配置
    if (dataDir && logging) {
      logging.logsDir = path.resolve(dataDir, "logs");
    }

    // 加载 LLM 服务配置
    const llmServices = await this._loadLlmServicesConfigInternal();

    const result = {
      promptsDir: path.resolve(process.cwd(), cfg.promptsDir),
      workspacesDir: dataDir ? path.resolve(dataDir, "workspaces") : (cfg.workspacesDir ? path.resolve(process.cwd(), cfg.workspacesDir) : path.resolve(process.cwd(), "data/workspaces")),
      runtimeDir: dataDir ? path.resolve(dataDir, "state") : path.resolve(process.cwd(), cfg.runtimeDir),
      maxSteps: Number.isFinite(cfg.maxSteps) ? cfg.maxSteps : 200,
      maxToolRounds: Number.isFinite(cfg.maxToolRounds) ? cfg.maxToolRounds : 20000,
      httpPort: Number.isFinite(cfg.httpPort) ? cfg.httpPort : 3000,
      enableHttp: typeof cfg.enableHttp === "boolean" ? cfg.enableHttp : false,
      llm: cfg.llm
        ? {
            provider: String(cfg.llm.provider ?? "openai"),
            baseURL: String(cfg.llm.baseURL ?? ""),
            model: String(cfg.llm.model ?? ""),
            apiKey: String(cfg.llm.apiKey ?? ""),
            maxConcurrentRequests: this._validateMaxConcurrentRequests(cfg.llm.maxConcurrentRequests),
            maxContextTokens: cfg.llm.maxContextTokens ?? 128000,
            timeout: cfg.llm.timeout ?? 1800000,
            stream: normalizeLlmStream(cfg.llm.stream),
            capabilityTags: this._normalizeLlmCapabilityTags(cfg.llm.capabilityTags),
            capabilities: this._normalizeLlmCapabilities(cfg.llm.capabilities),
            thinking: cfg.llm.thinking ?? undefined
          }
        : null,
      logging,
      dataDir,
      modules: await this._loadModulesFromFiles(),
      contextLimit: cfg.contextLimit ?? null,
      skills: cfg.skills ?? null,
      agentMemory: cfg.agentMemory ?? null,
      moodColors: cfg.moodColors ?? { enabled: true },
      llmServices
    };

    // 缓存加载结果，供后续同步访问
    this._loadedApp = result;
    return result;
  }

  /**
   * 同步获取已加载的应用配置（loadApp 需先调用）。
   * @returns {object|null}
   */
  getLoadedApp() {
    return this._loadedApp;
  }

  // ========== 聊天配置（chat.json）==========

  /**
   * 获取聊天配置（字体大小等）
   * @returns {Promise<{fontSize: number, source: string}>}
   */
  async getChatConfig() {
    if (!existsSync(this.chatJsonPath)) {
      return { fontSize: 16, source: "default" };
    }
    try {
      const content = await readFile(this.chatJsonPath, "utf8");
      const config = JSON.parse(content);
      return {
        fontSize: typeof config.fontSize === "number" ? config.fontSize : 16,
        source: "local"
      };
    } catch {
      return { fontSize: 16, source: "default" };
    }
  }

  /**
   * 保存聊天配置（始终覆盖写入 chat.json）
   * @param {{fontSize?: number}} config
   * @returns {Promise<void>}
   */
  async saveChatConfig(config) {
    const data = {
      fontSize: typeof config.fontSize === "number" ? config.fontSize : 16
    };
    await writeFile(this.chatJsonPath, JSON.stringify(data, null, 2), "utf8");
    void this.log.info("聊天配置已保存", { path: this.chatJsonPath });
  }

  // ========== LLM 配置 ==========

  /**
   * 获取 LLM 配置
   * @returns {Promise<{llm: object, source: string}>}
   */
  async getLlm() {
    let configPath;
    let source;

    if (existsSync(this.appLocalJsonPath)) {
      configPath = this.appLocalJsonPath;
      source = "local";
    } else if (existsSync(this.appJsonPath)) {
      configPath = this.appJsonPath;
      source = "default";
    } else {
      throw new Error("配置文件不存在");
    }

    const content = await readFile(configPath, "utf8");
    const config = JSON.parse(content);
    
    return {
      llm: {
        ...(config.llm || {}),
        stream: normalizeLlmStream(config?.llm?.stream)
      },
      source
    };
  }

  /**
   * 保存 LLM 配置
   * @param {object} llmConfig - LLM 配置对象
   * @returns {Promise<object>} 保存后的 llm 配置（apiKey 已掩码）
   */
  async saveLlm(llmConfig) {
    // 如果 app.local.json 不存在，从 app.json 复制
    if (!existsSync(this.appLocalJsonPath)) {
      if (!existsSync(this.appJsonPath)) {
        throw new Error("app.json 不存在，无法创建本地配置");
      }
      await copyFile(this.appJsonPath, this.appLocalJsonPath);
      void this.log.info("已从 app.json 复制到 app.local.json");
    }

    // 读取现有配置
    const content = await readFile(this.appLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    const existingLlmConfig = config.llm && typeof config.llm === "object" ? config.llm : {};

    // 只更新 llm 字段（如果没有传递新的 apiKey，保留原来的值）
    const existingApiKey = existingLlmConfig.apiKey || "";
    const existingTimeout = existingLlmConfig.timeout;
    const existingStream = normalizeLlmStream(existingLlmConfig.stream);
    config.llm = {
      provider: llmConfig.provider || existingLlmConfig.provider || "openai",
      baseURL: llmConfig.baseURL || "",
      model: llmConfig.model || "",
      apiKey: llmConfig.apiKey || existingApiKey,
      maxTokens: typeof llmConfig.maxTokens === "number" && llmConfig.maxTokens > 0
        ? llmConfig.maxTokens
        : (typeof existingLlmConfig.maxTokens === "number" && existingLlmConfig.maxTokens > 0
          ? existingLlmConfig.maxTokens
          : 4096),
      maxConcurrentRequests: typeof llmConfig.maxConcurrentRequests === "number"
        ? llmConfig.maxConcurrentRequests
        : 2,
      timeout: typeof llmConfig.timeout === "number"
        ? llmConfig.timeout
        : (existingTimeout ?? 1800000),
      stream: normalizeLlmStream(llmConfig.stream, existingStream),
      capabilityTags: this._normalizeLlmCapabilityTags(
        llmConfig.capabilityTags !== undefined
          ? llmConfig.capabilityTags
          : existingLlmConfig.capabilityTags
      ),
      capabilities: this._normalizeLlmCapabilities(
        llmConfig.capabilities !== undefined
          ? llmConfig.capabilities
          : existingLlmConfig.capabilities
      ),
      thinking: llmConfig.thinking !== undefined
        ? llmConfig.thinking
        : existingLlmConfig.thinking
    };

    // 保存配置
    await writeFile(this.appLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("LLM 配置已保存", { path: this.appLocalJsonPath });

    return {
      ...config.llm,
      apiKey: this.maskApiKey(config.llm.apiKey || "")
    };
  }

  /**
   * 将指定 LLM 服务的配置完整复制为默认 LLM 配置（包括 apiKey）。
   * @param {string} serviceId - 服务 ID
   * @returns {Promise<object>} 保存后的 llm 配置（apiKey 已掩码）
   * @throws {Error} 如果服务不存在
   */
  async setDefaultLlmFromService(serviceId) {
    if (!existsSync(this.appLocalJsonPath)) {
      if (!existsSync(this.appJsonPath)) {
        throw new Error("app.json 不存在，无法创建本地配置");
      }
      await copyFile(this.appJsonPath, this.appLocalJsonPath);
      void this.log.info("已从 app.json 复制到 app.local.json");
    }

    const servicesResult = await this._loadLlmServicesConfigInternal();
    const service = (servicesResult.services || []).find(s => s.id === serviceId);
    if (!service) {
      throw new Error(`服务 "${serviceId}" 不存在`);
    }

    const content = await readFile(this.appLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    const { id, name, description, enabled, ...llmFields } = service;

    // 将中文服务能力标签映射为英文 LLM 标签
    if (Array.isArray(llmFields.capabilityTags) && llmFields.capabilityTags.length > 0) {
      const SERVICE_TO_LLM_CAPABILITY_TAGS = {
        "文本对话": "text",
        "逻辑推理": "reasoning",
        "工具调用": "tool_calling",
        "结构化输出": "structured_output",
        "编程": "coding",
        "代码生成": "coding",
        "代码审查": "coding",
        "深度思考": "reasoning",
        "视觉理解": "vision",
        "image": "vision"
      };

      const mapped = llmFields.capabilityTags
        .filter((tag) => typeof tag === "string")
        .map((tag) => SERVICE_TO_LLM_CAPABILITY_TAGS[tag.trim().toLowerCase()])
        .filter(Boolean);

      if (mapped.length > 0) {
        llmFields.capabilityTags = [...new Set(mapped)];
      }
    }

    config.llm = { ...llmFields };

    await writeFile(this.appLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("已将服务配置设为默认 LLM", { serviceId, path: this.appLocalJsonPath });

    return {
      ...config.llm,
      apiKey: this.maskApiKey(config.llm.apiKey || "")
    };
  }

  /**
   * 规范化主 LLM 的能力标签。
   * 设计约束：
   * 1. 主 LLM 配置默认按“支持工具调用”处理。
   * 2. UI 未提交该字段时，必须保留已有值，避免保存其他参数时覆盖能力声明。
   * 3. 输入无效时回退到默认值，保证运行时能力判断稳定。
   * @param {any} capabilityTags
   * @returns {string[]}
   * @private
   */
  _normalizeLlmCapabilityTags(capabilityTags) {
    if (!Array.isArray(capabilityTags)) {
      return createDefaultLlmCapabilityTags();
    }
    const normalized = capabilityTags
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length > 0 ? [...new Set(normalized)] : createDefaultLlmCapabilityTags();
  }

  /**
   * 规范化主 LLM 的输入输出能力。
   * 这里不沿用“仅 text 输出”的旧默认值，避免默认配置被误判为不支持工具调用。
   * @param {any} capabilities
   * @returns {{input: string[], output: string[]}}
   * @private
   */
  _normalizeLlmCapabilities(capabilities) {
    if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
      return createDefaultLlmCapabilities();
    }

    const input = Array.isArray(capabilities.input)
      ? capabilities.input
          .filter((item) => typeof item === "string" && SUPPORTED_CAPABILITY_INPUT_TYPES.includes(item))
      : [];
    const output = Array.isArray(capabilities.output)
      ? capabilities.output
          .filter((item) => typeof item === "string" && SUPPORTED_CAPABILITY_OUTPUT_TYPES.includes(item))
      : [];

    return {
      input: input.length > 0 ? [...new Set(input)] : [...DEFAULT_LLM_CAPABILITIES.input],
      output: output.length > 0 ? [...new Set(output)] : [...DEFAULT_LLM_CAPABILITIES.output]
    };
  }

  async getModules() {
    if (!existsSync(this.modulesJsonPath)) {
      throw new Error("modules.json 不存在");
    }

    const raw = await readFile(this.modulesJsonPath, "utf8");
    const defaultModules = JSON.parse(raw);

    let enableAll = true;
    let enabled = Object.keys(defaultModules);

    if (existsSync(this.modulesEnabledJsonPath)) {
      try {
        const rawEnabled = await readFile(this.modulesEnabledJsonPath, "utf8");
        const cfg = JSON.parse(rawEnabled);
        enableAll = cfg.enableAll !== false;
        if (!enableAll && Array.isArray(cfg.enabled)) {
          enabled = cfg.enabled.filter(name => Object.prototype.hasOwnProperty.call(defaultModules, name));
        }
      } catch (err) {
        void this.log.warn("读取 modules.enabled.json 失败", { error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    }

    // 当前启用的模块（与 _loadModulesFromFiles 逻辑一致）
    const modules = {};
    if (enableAll) {
      Object.assign(modules, defaultModules);
    } else {
      for (const name of enabled) {
        if (defaultModules[name]) modules[name] = { ...defaultModules[name] };
      }
    }

    return {
      modules,
      mergedModules: { ...defaultModules },
      defaultModules: { ...defaultModules },
      enableAll,
      enabled: [...enabled],
      source: existsSync(this.modulesEnabledJsonPath) ? "local" : "default"
    };
  }

  async saveModules({ enableAll, enabled }) {
    const data = { enableAll: !!enableAll };
    if (!data.enableAll && Array.isArray(enabled)) data.enabled = enabled;
    await writeFile(this.modulesEnabledJsonPath, JSON.stringify(data, null, 2), "utf8");
    void this.log.info("模块配置已保存", { path: this.modulesEnabledJsonPath, enableAll: data.enableAll, count: data.enabled?.length ?? 0 });
  }

  async getAppSettings() {
    let configPath;
    let source;

    if (existsSync(this.appLocalJsonPath)) {
      configPath = this.appLocalJsonPath;
      source = "local";
    } else if (existsSync(this.appJsonPath)) {
      configPath = this.appJsonPath;
      source = "default";
    } else {
      throw new Error("配置文件不存在");
    }

    const content = await readFile(configPath, "utf8");
    const config = JSON.parse(content);

    return {
      source,
      settings: {
        promptsDir: config.promptsDir ?? "",
        workspacesDir: config.workspacesDir ?? "",
        runtimeDir: config.runtimeDir ?? "",
        loggingConfigPath: config.loggingConfigPath ?? "",
        maxSteps: Number.isFinite(config.maxSteps) ? config.maxSteps : 200,
        maxToolRounds: Number.isFinite(config.maxToolRounds) ? config.maxToolRounds : 20000,
        httpPort: Number.isFinite(config.httpPort) ? config.httpPort : 3000,
        contextLimit: config.contextLimit ?? null,
        skills: config.skills ?? null,
        agentMemory: config.agentMemory ?? null,
        moodColors: config.moodColors ?? { enabled: true }
      }
    };
  }

  async saveAppSettings(nextSettings) {
    if (!existsSync(this.appLocalJsonPath)) {
      if (!existsSync(this.appJsonPath)) {
        throw new Error("app.json 不存在，无法创建本地配置");
      }
      await copyFile(this.appJsonPath, this.appLocalJsonPath);
      void this.log.info("已从 app.json 复制到 app.local.json");
    }

    const content = await readFile(this.appLocalJsonPath, "utf8");
    const config = JSON.parse(content);

    if (typeof nextSettings.promptsDir === "string") config.promptsDir = nextSettings.promptsDir;
    if (typeof nextSettings.workspacesDir === "string") config.workspacesDir = nextSettings.workspacesDir;
    if (typeof nextSettings.runtimeDir === "string") config.runtimeDir = nextSettings.runtimeDir;
    if (typeof nextSettings.loggingConfigPath === "string") config.loggingConfigPath = nextSettings.loggingConfigPath;
    if (Number.isFinite(nextSettings.maxSteps)) config.maxSteps = nextSettings.maxSteps;
    if (Number.isFinite(nextSettings.maxToolRounds)) config.maxToolRounds = nextSettings.maxToolRounds;
    if (Number.isFinite(nextSettings.httpPort)) config.httpPort = nextSettings.httpPort;
    if (nextSettings.contextLimit && typeof nextSettings.contextLimit === "object") config.contextLimit = nextSettings.contextLimit;
    if (nextSettings.skills && typeof nextSettings.skills === "object") config.skills = nextSettings.skills;
    if (nextSettings.agentMemory && typeof nextSettings.agentMemory === "object") config.agentMemory = nextSettings.agentMemory;
    if (nextSettings.moodColors && typeof nextSettings.moodColors === "object") config.moodColors = nextSettings.moodColors;

    await writeFile(this.appLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("应用设置已保存", { path: this.appLocalJsonPath });
  }

  /**
   * 验证 LLM 配置
   * @param {object} config - LLM 配置对象
   * @returns {{valid: boolean, errors: object}} 验证结果
   */
  validateLlm(config) {
    const errors = {};

    if (!config.baseURL || typeof config.baseURL !== "string" || !config.baseURL.trim()) {
      errors.baseURL = "baseURL 不能为空";
    }

    if (!config.model || typeof config.model !== "string" || !config.model.trim()) {
      errors.model = "model 不能为空";
    }

    if (
      config.provider !== undefined &&
      (typeof config.provider !== "string" || !SUPPORTED_LLM_PROVIDERS.includes(config.provider))
    ) {
      errors.provider = `provider 必须是以下值之一: ${SUPPORTED_LLM_PROVIDERS.join(", ")}`;
    }

    if (config.stream !== undefined && typeof config.stream !== "boolean") {
      errors.stream = "stream 必须是布尔值";
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }

  // ========== LLM 服务配置 ==========
  
  /**
   * 获取 LLM 服务列表
   * 只读取 llmservices.local.json，不存在则返回空列表
   * llmservices_template.json 只是模板参考，不读取
   * @returns {Promise<{services: object[], source: string}>}
   */
  async getServices() {
    if (!existsSync(this.llmServicesLocalJsonPath)) {
      return { services: [], source: "none" };
    }

    const content = await readFile(this.llmServicesLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    
    return {
      services: Array.isArray(config.services)
        ? config.services.map((service) => ({
            ...service,
            stream: normalizeLlmStream(service?.stream)
          }))
        : [],
      source: "local"
    };
  }

  /**
   * 添加 LLM 服务
   * @param {object} service - 服务配置
   * @returns {Promise<object>} 添加的服务（带掩码的 apiKey）
   * @throws {Error} 如果服务 ID 已存在
   */
  async addService(service) {
    await this._ensureLocalServices();

    const content = await readFile(this.llmServicesLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    const services = Array.isArray(config.services) ? config.services : [];

    // 检查 ID 是否已存在
    if (services.some(s => s.id === service.id)) {
      throw new Error(`服务 ID "${service.id}" 已存在`);
    }

    // 添加新服务
    const newService = {
      id: service.id,
      name: service.name || "",
      provider: service.provider || "openai",
      baseURL: service.baseURL || "",
      model: service.model || "",
      apiKey: service.apiKey || "",
      maxTokens: typeof service.maxTokens === "number" && service.maxTokens > 0
        ? service.maxTokens
        : 4096,
      maxConcurrentRequests: typeof service.maxConcurrentRequests === "number"
        ? service.maxConcurrentRequests
        : 2,
      timeout: typeof service.timeout === "number" ? service.timeout : 1800000,
      stream: normalizeLlmStream(service.stream),
      capabilityTags: Array.isArray(service.capabilityTags) ? service.capabilityTags : [],
      capabilities: service.capabilities || { input: ["text"], output: ["text"] },
      thinking: service.thinking ?? undefined,
      description: service.description || "",
      enabled: typeof service.enabled === "boolean" ? service.enabled : true
    };

    services.push(newService);
    config.services = services;

    await writeFile(this.llmServicesLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("LLM 服务已添加", { serviceId: service.id });

    // 返回带掩码的服务
    return {
      ...newService,
      apiKey: this.maskApiKey(newService.apiKey)
    };
  }

  /**
   * 更新 LLM 服务
   * @param {string} serviceId - 服务 ID
   * @param {object} service - 服务配置
   * @returns {Promise<object>} 更新后的服务（带掩码的 apiKey）
   * @throws {Error} 如果服务不存在
   */
  async updateService(serviceId, service) {
    await this._ensureLocalServices();

    const content = await readFile(this.llmServicesLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    const services = Array.isArray(config.services) ? config.services : [];

    // 查找服务索引
    const index = services.findIndex(s => s.id === serviceId);
    if (index === -1) {
      throw new Error(`服务 "${serviceId}" 不存在`);
    }

    // 更新服务（如果没有传递新的 apiKey，保留原来的值）
    const existingService = services[index];
    const updatedService = {
      id: service.id || serviceId,
      name: service.name || "",
      provider: service.provider || existingService.provider || "openai",
      baseURL: service.baseURL || "",
      model: service.model || "",
      apiKey: service.apiKey || existingService.apiKey || "",
      maxTokens: typeof service.maxTokens === "number" && service.maxTokens > 0
        ? service.maxTokens
        : (typeof existingService.maxTokens === "number" && existingService.maxTokens > 0
          ? existingService.maxTokens
          : 4096),
      maxConcurrentRequests: typeof service.maxConcurrentRequests === "number"
        ? service.maxConcurrentRequests
        : 2,
      timeout: typeof service.timeout === "number"
        ? service.timeout
        : (typeof existingService.timeout === "number" ? existingService.timeout : 1800000),
      stream: normalizeLlmStream(service.stream, normalizeLlmStream(existingService.stream)),
      capabilityTags: Array.isArray(service.capabilityTags) ? service.capabilityTags : [],
      capabilities: service.capabilities || existingService.capabilities || { input: ["text"], output: ["text"] },
      thinking: service.thinking !== undefined
        ? service.thinking
        : existingService.thinking,
      description: service.description || "",
      enabled: typeof service.enabled === "boolean"
        ? service.enabled
        : (typeof existingService.enabled === "boolean" ? existingService.enabled : true)
    };

    services[index] = updatedService;
    config.services = services;

    await writeFile(this.llmServicesLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("LLM 服务已更新", { serviceId });

    // 返回带掩码的服务
    return {
      ...updatedService,
      apiKey: this.maskApiKey(updatedService.apiKey)
    };
  }

  /**
   * 删除 LLM 服务
   * @param {string} serviceId - 服务 ID
   * @returns {Promise<void>}
   * @throws {Error} 如果服务不存在
   */
  async deleteService(serviceId) {
    await this._ensureLocalServices();

    const content = await readFile(this.llmServicesLocalJsonPath, "utf8");
    const config = JSON.parse(content);
    const services = Array.isArray(config.services) ? config.services : [];

    // 查找服务索引
    const index = services.findIndex(s => s.id === serviceId);
    if (index === -1) {
      throw new Error(`服务 "${serviceId}" 不存在`);
    }

    // 删除服务
    services.splice(index, 1);
    config.services = services;

    await writeFile(this.llmServicesLocalJsonPath, JSON.stringify(config, null, 2), "utf8");
    void this.log.info("LLM 服务已删除", { serviceId });
  }

  /**
   * 验证 LLM 服务配置
   * @param {object} service - LLM 服务配置对象
   * @returns {{valid: boolean, errors: object}} 验证结果
   */
  validateService(service) {
    const errors = {};

    if (!service.id || typeof service.id !== "string" || !service.id.trim()) {
      errors.id = "id 不能为空";
    }

    if (!service.name || typeof service.name !== "string" || !service.name.trim()) {
      errors.name = "name 不能为空";
    }

    if (!service.baseURL || typeof service.baseURL !== "string" || !service.baseURL.trim()) {
      errors.baseURL = "baseURL 不能为空";
    }

    if (!service.model || typeof service.model !== "string" || !service.model.trim()) {
      errors.model = "model 不能为空";
    }

    if (
      service.provider !== undefined &&
      (typeof service.provider !== "string" || !SUPPORTED_LLM_PROVIDERS.includes(service.provider))
    ) {
      errors.provider = `provider 必须是以下值之一: ${SUPPORTED_LLM_PROVIDERS.join(", ")}`;
    }

    if (!Array.isArray(service.capabilityTags)) {
      errors.capabilityTags = "capabilityTags 必须是数组";
    }

    if (service.timeout !== undefined && (typeof service.timeout !== "number" || Number.isNaN(service.timeout) || service.timeout <= 0)) {
      errors.timeout = "timeout 必须是正数";
    }

    if (service.stream !== undefined && typeof service.stream !== "boolean") {
      errors.stream = "stream 必须是布尔值";
    }

    if (service.capabilities !== undefined) {
      if (typeof service.capabilities !== "object" || service.capabilities === null || Array.isArray(service.capabilities)) {
        errors.capabilities = "capabilities 必须是对象";
      } else {
        const input = service.capabilities.input;
        const output = service.capabilities.output;
        if (!Array.isArray(input) || input.length === 0 || input.some(item => typeof item !== "string")) {
          errors.capabilitiesInput = "capabilities.input 必须是非空字符串数组";
        }
        if (!Array.isArray(output) || output.length === 0 || output.some(item => typeof item !== "string")) {
          errors.capabilitiesOutput = "capabilities.output 必须是非空字符串数组";
        }
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }

  // ========== 工具方法 ==========
  
  /**
   * 掩码 API Key，只显示最后 4 个字符
   * @param {string} apiKey - 原始 API Key
   * @returns {string} 掩码后的 API Key
   */
  maskApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== "string") {
      return "****";
    }
    // 去除首尾空白后检查长度
    const trimmed = apiKey.trim();
    if (trimmed.length <= 4) {
      return "****";
    }
    return "****" + apiKey.slice(-4);
  }

  /**
   * 检查本地应用配置文件是否存在
   * @returns {boolean} 是否存在 app.local.json
   */
  hasLocalApp() {
    return existsSync(this.appLocalJsonPath);
  }

  /**
   * 检查本地 LLM 服务配置文件是否存在
   * @returns {boolean} 是否存在 llmservices.local.json
   */
  hasLocalServices() {
    return existsSync(this.llmServicesLocalJsonPath);
  }

  // ========== 私有方法 ==========
  
  /**
   * 从 modules.json / modules.enabled.json 加载启用的模块配置。
   * 返回的 object 供 bootstrap_manager 使用，格式与旧 modules 字段兼容。
   * @returns {Promise<object>} 模块名 → 配置的映射
   * @private
   */
  async _loadModulesFromFiles() {
    if (!existsSync(this.modulesJsonPath)) {
      return {};
    }

    const raw = await readFile(this.modulesJsonPath, "utf8");
    const catalog = JSON.parse(raw);

    if (!existsSync(this.modulesEnabledJsonPath)) {
      return { ...catalog };
    }

    let cfg;
    try {
      const rawEnabled = await readFile(this.modulesEnabledJsonPath, "utf8");
      cfg = JSON.parse(rawEnabled);
    } catch (err) {
      void this.log.warn("读取 modules.enabled.json 失败，回退到全部启用", { error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      return { ...catalog };
    }

    if (cfg.enableAll !== false) return { ...catalog };

    const enabledList = Array.isArray(cfg.enabled) ? cfg.enabled : [];
    const result = {};
    for (const name of enabledList) {
      if (catalog[name]) result[name] = { ...catalog[name] };
    }
    return result;
  }

  /**
   * 尝试加载 JSON 文件；不存在则返回 null
   * @private
   * @param {string} absPath - 文件绝对路径
   * @returns {Promise<any|null>}
   */
  async _loadOptionalJson(absPath) {
    try {
      const raw = await readFile(absPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * 验证并返回有效的最大并发请求数
   * @private
   * @param {any} value - 配置值
   * @returns {number} 有效的最大并发请求数
   */
  _validateMaxConcurrentRequests(value) {
    const defaultValue = 3;
    
    // 如果未配置，使用默认值
    if (value === undefined || value === null) {
      return defaultValue;
    }
    
    // 必须是数字类型且为正整数（排除 NaN）
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
      console.warn(`Invalid maxConcurrentRequests value: ${value}. Using default value: ${defaultValue}`);
      return defaultValue;
    }
    
    return value;
  }

  /**
   * 加载 LLM 服务配置（内部使用）
   * @private
   * @returns {Promise<{services: any[], configPath: string|null, configSource: string|null}>}
   */
  async _loadLlmServicesConfigInternal() {
    let configPath = null;
    let configSource = null;
    
    // 只读取 llmservices.local.json，llmservices_template.json 只是模板参考
    if (!existsSync(this.llmServicesLocalJsonPath)) {
      return { services: [], configPath: null, configSource: null };
    }
    
    configPath = this.llmServicesLocalJsonPath;
    configSource = "local";
    
    try {
      const raw = await readFile(configPath, "utf8");
      const data = JSON.parse(raw);
      const services = Array.isArray(data?.services)
        ? data.services.map((service) => ({
            ...service,
            stream: normalizeLlmStream(service?.stream)
          }))
        : [];
      return { services, configPath, configSource };
    } catch {
      // 解析失败时返回空配置
      return { services: [], configPath, configSource };
    }
  }

  /**
   * 确保本地 LLM 服务配置文件存在
   * @private
   * @returns {Promise<void>}
   */
  async _ensureLocalServices() {
    if (existsSync(this.llmServicesLocalJsonPath)) {
      return;
    }

    // 创建空配置（llmservices_template.json 只是模板参考，不自动复制）
    await writeFile(this.llmServicesLocalJsonPath, JSON.stringify({ services: [] }, null, 2), "utf8");
    void this.log.info("已创建空的 llmservices.local.json");
  }

  // ========== 模块独立配置 ==========

  /**
   * 注册模块配置默认值。
   * 模块在 getConfigRegistration() 中声明默认值，由 ModuleLoader 调用此方法注册。
   * @param {string} moduleName - 模块名称
   * @param {object} defaults - 默认配置
   */
  registerModuleConfig(moduleName, defaults) {
    this._moduleConfigs.set(moduleName, { defaults: defaults ?? {} });
  }

  /**
   * 获取模块配置（合并默认值与 config/modules/<name>.json）。
   * 优先级：模块代码默认值 → config/modules/<name>.json（可选覆盖）
   * @param {string} moduleName - 模块名称
   * @returns {Promise<object>} 合并后的配置
   */
  async getModuleConfig(moduleName) {
    const entry = this._moduleConfigs.get(moduleName);
    const defaults = entry?.defaults ?? {};

    const filePath = path.join(this.modulesConfigDir, `${moduleName}.json`);
    const fileConfig = await this._loadOptionalJson(filePath);

    if (fileConfig && typeof fileConfig === "object") {
      return { ...defaults, ...fileConfig };
    }

    return { ...defaults };
  }

  /**
   * 保存模块配置（写入 config/modules/<name>.json）。
   * partialConfig 会与当前全量合并后写入。
   * @param {string} moduleName - 模块名称
   * @param {object} partialConfig - 要保存的配置字段
   * @returns {Promise<object>} 保存后的全量配置
   */
  async saveModuleConfig(moduleName, partialConfig) {
    const current = await this.getModuleConfig(moduleName);
    const merged = { ...current, ...partialConfig };

    // 确保 config/modules/ 目录存在
    const dirPath = this.modulesConfigDir;
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    const filePath = path.join(dirPath, `${moduleName}.json`);
    await writeFile(filePath, JSON.stringify(merged, null, 2), "utf8");
    void this.log.info("模块配置已保存", { module: moduleName, path: filePath });

    return merged;
  }
}
