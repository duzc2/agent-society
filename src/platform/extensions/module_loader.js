import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

/**
 * 模块加载器：负责加载、初始化和管理可插拔模块。
 * 模块从 modules 文件夹加载，通过 app.json 配置启用。
 */
export class ModuleLoader {
  /**
   * @param {{logger?: any, modulesDir?: string}} options
   */
  constructor(options = {}) {
    this.log = options.logger ;
    this.modulesDir = options.modulesDir ?? path.resolve(process.cwd(), "modules");
    this._modules = new Map(); // moduleName -> moduleInstance
    this._toolNameToModule = new Map(); // toolName -> moduleName
    this._moduleToolGroupIds = new Map(); // moduleName -> toolGroupId
    this._lazyModules = new Map(); // moduleName -> {moduleInstance, moduleConfig} 待初始化
    this._runtime = null;
    this._initialized = false;
  }

  /**
   * 解析模块配置。
   * 支持两种格式：
   * - 字符串数组: ["chrome", "other"] - 向后兼容
   * - 对象: { "chrome": { headless: false }, "other": {} } - 带配置
   * @param {string[]|object} modulesConfig - 模块配置
   * @returns {{moduleNames: string[], moduleConfigs: Map<string, object>}}
   */
  _parseModulesConfig(modulesConfig) {
    const moduleNames = [];
    const moduleConfigs = new Map();

    if (!modulesConfig) {
      return { moduleNames, moduleConfigs };
    }

    // 字符串数组格式（向后兼容）
    if (Array.isArray(modulesConfig)) {
      for (const item of modulesConfig) {
        if (typeof item === "string") {
          moduleNames.push(item);
          moduleConfigs.set(item, {});
        }
      }
      return { moduleNames, moduleConfigs };
    }

    // 对象格式（带配置）
    if (typeof modulesConfig === "object") {
      for (const [moduleName, config] of Object.entries(modulesConfig)) {
        moduleNames.push(moduleName);
        moduleConfigs.set(moduleName, config ?? {});
      }
    }

    return { moduleNames, moduleConfigs };
  }

  /**
   * 加载配置中启用的模块。
   * @param {string[]|object} modulesConfig - 模块配置（字符串数组或对象）
   * @param {any} runtime - 运行时实例
   * @returns {Promise<{loaded: string[], errors: Array<{module: string, error: string}>}>}
   */
  async loadModules(modulesConfig, runtime) {
    this._runtime = runtime;
    const loaded = [];
    const errors = [];

    const { moduleNames, moduleConfigs } = this._parseModulesConfig(modulesConfig);
    this._moduleConfigs = moduleConfigs;

    if (moduleNames.length === 0) {
      void this.log.info("没有启用的模块");
      this._initialized = true;
      return { loaded, errors };
    }

    void this.log.info("开始加载模块", { count: moduleNames.length, modules: moduleNames });

    for (const moduleName of moduleNames) {
      try {
        const moduleConfig = moduleConfigs.get(moduleName) ?? {};
        await this._loadModule(moduleName, moduleConfig);
        loaded.push(moduleName);
      } catch (err) {
        const errorMessage = err?.message ?? String(err);
        void this.log.error("模块加载失败", { module: moduleName, error: errorMessage, stack: err?.stack, name: err?.name, code: err?.code });
        errors.push({ module: moduleName, error: errorMessage });
        // 继续加载其他模块，不中断
      }
    }

    this._initialized = true;
    void this.log.info("模块加载完成", { loaded: loaded.length, errors: errors.length });
    return { loaded, errors };
  }

  /**
   * 加载单个模块。
   * @param {string} moduleName - 模块名称
   * @param {object} moduleConfig - 模块配置
   * @returns {Promise<void>}
   */
  async _loadModule(moduleName, moduleConfig = {}) {
    const modulePath = path.join(this.modulesDir, moduleName, "index.js");
    
    if (!existsSync(modulePath)) {
      throw new Error(`模块文件不存在: ${modulePath}`);
    }

    void this.log.debug("加载模块", { module: moduleName, path: modulePath, config: moduleConfig });

    // 动态导入模块
    const moduleUrl = `file://${modulePath.replace(/\\/g, "/")}`;
    const moduleExports = await import(moduleUrl);
    const moduleInstance = moduleExports.default ?? moduleExports;

    // 验证模块接口
    this._validateModuleInterface(moduleName, moduleInstance);

    const isLazy = !!moduleConfig?.lazy;

    // 初始化模块（非延迟模块立即初始化，延迟模块跳过 init 等到首次使用时再初始化）
    if (typeof moduleInstance.init === "function") {
      if (isLazy) {
        void this.log.debug("跳过延迟模块初始化", { module: moduleName });
        this._lazyModules.set(moduleName, { moduleInstance });
      } else {
        void this.log.debug("初始化模块", { module: moduleName });
        await moduleInstance.init(this._runtime);
      }
    }

    // 注册模块（延迟模块也需注册，以便工具定义可用）
    this._modules.set(moduleName, moduleInstance);

    // 注册工具名到模块的映射
    const tools = moduleInstance.getToolDefinitions?.() ?? [];
    for (const tool of tools) {
      const toolName = tool?.function?.name;
      if (toolName) {
        if (this._toolNameToModule.has(toolName)) {
          void this.log.warn("工具名冲突，后加载的模块覆盖", { 
            toolName, 
            existingModule: this._toolNameToModule.get(toolName),
            newModule: moduleName 
          });
        }
        this._toolNameToModule.set(toolName, moduleName);
      }
    }

    // 向 ToolGroupManager 注册模块工具组
    if (tools.length > 0) {
      const toolGroupId = moduleInstance.toolGroupId ?? moduleName;
      const toolGroupDescription = moduleInstance.toolGroupDescription ?? `${moduleName} 模块提供的工具`;
      
      const result = this._runtime.toolGroupManager.registerGroup(toolGroupId, {
        description: toolGroupDescription,
        tools: tools
      });
      
      if (result.ok) {
        this._moduleToolGroupIds.set(moduleName, toolGroupId);
        void this.log.info("模块工具组注册成功", { 
          module: moduleName, 
          toolGroupId,
          toolCount: tools.length 
        });
      } else {
        void this.log.warn("模块工具组注册失败", { 
          module: moduleName, 
          toolGroupId,
          error: result.error 
        });
      }
    }

    void this.log.info("模块加载成功", { 
      module: moduleName, 
      toolCount: tools.length,
      tools: tools.map(t => t?.function?.name).filter(Boolean)
    });
  }

  /**
   * 验证模块接口是否符合规范。
   * @param {string} moduleName - 模块名称
   * @param {any} moduleInstance - 模块实例
   */
  _validateModuleInterface(moduleName, moduleInstance) {
    const requiredFields = [
      { name: "name", type: "string" },
      { name: "getToolDefinitions", type: "function" },
      { name: "executeToolCall", type: "function" },
      { name: "init", type: "function" },
      { name: "shutdown", type: "function" }
    ];

    const missing = [];
    const wrongType = [];

    for (const field of requiredFields) {
      if (!(field.name in moduleInstance)) {
        missing.push(field.name);
      } else if (typeof moduleInstance[field.name] !== field.type) {
        wrongType.push({ name: field.name, expected: field.type, actual: typeof moduleInstance[field.name] });
      }
    }

    if (missing.length > 0 || wrongType.length > 0) {
      const details = [];
      if (missing.length > 0) details.push(`缺少字段: ${missing.join(", ")}`);
      if (wrongType.length > 0) details.push(`类型错误: ${wrongType.map(w => `${w.name}(期望${w.expected},实际${w.actual})`).join(", ")}`);
      throw new Error(`模块接口不符合规范: ${details.join("; ")}`);
    }
  }

  /**
   * 获取所有已加载模块的工具定义。
   * @returns {Array<{type: string, function: object}>}
   */
  getToolDefinitions() {
    const allTools = [];
    
    for (const [moduleName, moduleInstance] of this._modules) {
      try {
        const tools = moduleInstance.getToolDefinitions?.() ?? [];
        allTools.push(...tools);
      } catch (err) {
        void this.log.error("获取模块工具定义失败", { module: moduleName, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    }

    return allTools;
  }

  /**
   * 检查工具名是否属于某个模块。
   * @param {string} toolName - 工具名称
   * @returns {boolean}
   */
  hasToolName(toolName) {
    return this._toolNameToModule.has(toolName);
  }

  /**
   * 执行模块工具调用。
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>}
   */
  /**
   * 确保延迟模块已完成初始化（懒加载入口）。
   * 在首次调用延迟模块的 tool 时自动触发 init()。
   * @param {string} moduleName - 模块名称
   * @returns {Promise<void>}
   */
  async ensureModuleInitialized(moduleName) {
    const lazy = this._lazyModules.get(moduleName);
    if (!lazy) return; // 不是延迟模块或已完成初始化

    void this.log.info("延迟初始化模块", { module: moduleName });
    try {
      await lazy.moduleInstance.init(this._runtime);
      this._lazyModules.delete(moduleName);
      void this.log.info("延迟模块初始化完成", { module: moduleName });
    } catch (err) {
      this._lazyModules.delete(moduleName);
      void this.log.error("延迟模块初始化失败", { module: moduleName, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      throw err;
    }
  }

  async executeToolCall(ctx, toolName, args) {
    const moduleName = this._toolNameToModule.get(toolName);

    if (!moduleName) {
      return { error: "unknown_module_tool", toolName };
    }

    const moduleInstance = this._modules.get(moduleName);

    if (!moduleInstance) {
      return { error: "module_not_loaded", module: moduleName, toolName };
    }

    // 延迟模块首次调用时自动初始化
    if (this._lazyModules.has(moduleName)) {
      await this.ensureModuleInitialized(moduleName);
    }

    try {
      void this.log.debug("执行模块工具调用", { module: moduleName, toolName, args });
      const result = await moduleInstance.executeToolCall(ctx, toolName, args);
      void this.log.debug("模块工具调用完成", { module: moduleName, toolName, ok: true });
      return result;
    } catch (err) {
      const errorMessage = err?.message ?? String(err);
      void this.log.error("模块工具调用失败", { module: moduleName, toolName, error: errorMessage, stack: err?.stack, name: err?.name, code: err?.code });
      return {
        error: "module_tool_error",
        module: moduleName,
        toolName,
        message: errorMessage
      };
    }
  }

  /**
   * 获取所有已加载模块的 Web 组件定义。
   * @returns {Array<{moduleName: string, component: object}>}
   */
  getWebComponents() {
    const components = [];
    
    for (const [moduleName, moduleInstance] of this._modules) {
      try {
        if (typeof moduleInstance.getWebComponent === "function") {
          const component = moduleInstance.getWebComponent();
          if (component) {
            components.push({ moduleName, component });
          }
        }
      } catch (err) {
        void this.log.error("获取模块 Web 组件失败", { module: moduleName, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
      }
    }

    return components;
  }

  /**
   * 获取模块的 HTTP 路由处理器。
   * @param {string} moduleName - 模块名称
   * @returns {Function|null}
   */
  getModuleHttpHandler(moduleName) {
    const moduleInstance = this._modules.get(moduleName);
    
    if (!moduleInstance) {
      return null;
    }

    if (typeof moduleInstance.getHttpHandler === "function") {
      return moduleInstance.getHttpHandler();
    }

    return null;
  }

  /**
   * 获取所有已加载模块的信息。
   * @returns {Array<{name: string, toolCount: number, toolGroupId: string, hasWebComponent: boolean, hasHttpHandler: boolean}>}
   */
  getLoadedModules() {
    const modules = [];

    for (const [moduleName, moduleInstance] of this._modules) {
      const tools = moduleInstance.getToolDefinitions?.() ?? [];
      modules.push({
        name: moduleName,
        toolCount: tools.length,
        toolGroupId: this._moduleToolGroupIds.get(moduleName) ?? moduleName,
        toolGroupDescription: moduleInstance.toolGroupDescription ?? `${moduleName} 模块提供的工具`,
        hasWebComponent: typeof moduleInstance.getWebComponent === "function",
        hasHttpHandler: typeof moduleInstance.getHttpHandler === "function"
      });
    }

    return modules;
  }

  /**
   * 按名称获取已加载的模块实例。
   * @param {string} moduleName - 模块名称（如 "chrome"）
   * @returns {object|null} - 模块实例或 null
   */
  getModule(moduleName) {
    return this._modules.get(moduleName) ?? null;
  }

  /**
   * 获取模块的工具组ID。
   * @param {string} moduleName - 模块名称
   * @returns {string|null}
   */
  getModuleToolGroupId(moduleName) {
    return this._moduleToolGroupIds.get(moduleName) ?? null;
  }

  /**
   * 获取所有模块的工具组ID列表。
   * @returns {string[]}
   */
  getAllModuleToolGroupIds() {
    return Array.from(this._moduleToolGroupIds.values());
  }

  /**
   * 关闭所有模块。
   * @returns {Promise<void>}
   */
  async shutdown() {
    void this.log.info("开始关闭所有模块", { count: this._modules.size });

    for (const [moduleName, moduleInstance] of this._modules) {
      try {
        // 从 ToolGroupManager 注销模块工具组
        const toolGroupId = this._moduleToolGroupIds.get(moduleName);
        if (toolGroupId) {
          const result = this._runtime.toolGroupManager.unregisterGroup(toolGroupId);
          if (result.ok) {
            void this.log.debug("模块工具组注销成功", { module: moduleName, toolGroupId });
          } else {
            void this.log.warn("模块工具组注销失败", { module: moduleName, toolGroupId, error: result.error });
          }
        }
        
        if (typeof moduleInstance.shutdown === "function") {
          // 跳过从未初始化的延迟模块，避免 shutdown 报错
          if (this._lazyModules.has(moduleName)) {
            void this.log.debug("跳过未初始化的延迟模块", { module: moduleName });
          } else {
            void this.log.debug("关闭模块", { module: moduleName });
            await moduleInstance.shutdown();
          }
        }
      } catch (err) {
        void this.log.error("模块关闭失败", { module: moduleName, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
        // 继续关闭其他模块
      }
    }

    this._modules.clear();
    this._toolNameToModule.clear();
    this._moduleToolGroupIds.clear();
    this._lazyModules.clear();
    this._initialized = false;

    void this.log.info("所有模块已关闭");
  }

  /**
   * 检查模块加载器是否已初始化。
   * @returns {boolean}
   */
  isInitialized() {
    return this._initialized;
  }
}
