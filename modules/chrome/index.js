
/**
 * Chrome 浏览器控制模块
 * 提供无头浏览器操作能力，包括自动管理的浏览器实例、标签页管理、页面导航、内容读取、资源管理和页面交互。
 */

import { BrowserManager } from "./browser_manager.js";
import { TabManager } from "./tab_manager.js";

// 导入功能模块
import { TabsFeature } from "./features/tabs.js";
import { DevToolsFeature } from "./features/devtools.js";
import { NavigationFeature } from "./features/navigation.js";
import { ContentFeature } from "./features/content.js";
import { ResourceFeature } from "./features/resources.js";
import { InteractionFeature } from "./features/interaction.js";

/** @type {BrowserManager|null} */
let browserManager = null;

/** @type {TabManager|null} */
let tabManager = null;

/** @type {any} */
let runtime = null;

/** @type {any} */
let log = null;

/** @type {import('../../src/platform/utils/config/config.js').Config|null} */
let configService = null;

/** @type {object} */
let moduleConfig = {};

/** @type {Map<string, any>} */
let features = new Map();

/**
 * 从调用上下文中获取智能体ID
 * @param {any} ctx - 调用上下文
 * @returns {string|null}
 */
function getAgentIdFromContext(ctx) {
  // 从 ctx.agent.id 获取智能体ID
  if (ctx?.agent?.id) {
    return ctx.agent.id;
  }
  return null;
}

/**
 * 从 IncomingMessage 流中读取请求体
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function _readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Chrome 模块导出
 */
export default {
  name: "chrome",
  
  // 工具组标识符，用于工具组管理
  toolGroupId: "chrome",
  
  // 工具组描述
  toolGroupDescription: "Chrome 浏览器控制工具，提供无头浏览器操作能力。浏览器实例按智能体自动管理，无需手动创建/关闭。",

  /**
   * 初始化模块
   * @param {any} rt - 运行时实例
   * @returns {Promise<void>}
   */
  async init(rt) {
    runtime = rt;
    configService = rt.configService;

    // 向 configService 注册默认值，然后获取与 config/modules/chrome.json 合并后的配置
    configService.registerModuleConfig('chrome', {
      headless: false,
      proxy: { enabled: false, server: "", username: "", password: "" }
    });
    moduleConfig = await configService.getModuleConfig('chrome');
    log = runtime.loggerRoot.forModule("chrome");

    // 合并全局配置中的 dataDir 到模块配置
    const configWithDataDir = {
      ...moduleConfig,
      dataDir: runtime.dataDir
    };

    browserManager = new BrowserManager({ log, config: configWithDataDir, lifecycleRegistry: runtime.lifecycleRegistry });
    tabManager = new TabManager({ log, browserManager });

    // 初始化各个功能模块
    const featureOptions = { log, tabManager, runtime, browserManager };
    
    const featureInstances = [
      new TabsFeature(featureOptions),
      new DevToolsFeature(featureOptions),
      new NavigationFeature(featureOptions),
      new ContentFeature(featureOptions),
      new ResourceFeature(featureOptions),
      new InteractionFeature(featureOptions)
    ];

    // 注册功能模块
    features.clear();
    for (const feature of featureInstances) {
      const defs = feature.getToolDefinitions();
      for (const def of defs) {
        features.set(def.function.name, feature);
      }
    }

    log.info("Chrome 模块初始化完成", { config: moduleConfig, configWithDataDir, registeredTools: features.size });
  },

  /**
   * 获取工具定义列表
   * @returns {Array<{type: string, function: object}>}
   */
  getToolDefinitions() {
    const allDefs = [];
    const processedFeatures = new Set();
    
    // 遍历所有注册的 feature 实例，收集工具定义
    for (const feature of features.values()) {
      if (processedFeatures.has(feature)) continue;
      processedFeatures.add(feature);
      allDefs.push(...feature.getToolDefinitions());
    }
    
    return allDefs;
  },

  /**
   * 执行工具调用
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>}
   */
  async executeToolCall(ctx, toolName, args) {
    // 获取智能体ID
    const agentId = getAgentIdFromContext(ctx);
    if (!agentId) {
      return { error: "missing_agent_id", message: "无法确定调用者智能体ID" };
    }

    const feature = features.get(toolName);
    if (!feature) {
      return { error: "unknown_tool", toolName };
    }

    try {
      return await feature.handleToolCall(toolName, args, ctx, agentId);
    } catch (err) {
      const message = err?.message ?? String(err);
      log.error("Chrome 工具调用失败", { toolName, agentId, error: message });
      return { error: "tool_error", toolName, message };
    }
  },

  /**
   * 获取 Web 管理界面组件定义
   * @returns {object}
   */
  getWebComponent() {
    return {
      moduleName: "chrome",
      displayName: "Chrome 浏览器管理",
      icon: "🌐",
      panelPath: "modules/chrome/web/panel.html"
    };
  },

  /**
   * 获取 HTTP API 路由处理器
   * @returns {Function}
   */
  getHttpHandler() {
    return async (req, res, pathParts) => {
      log.info('[Chrome] Handler called:', { pathParts, method: req?.method });
      
      const [resource, id, action] = pathParts;

      try {
        if (resource === "browsers") {
          if (!id) {
            const browsers = browserManager.listBrowsers();
            return { ok: true, browsers };
          }
          // id 是 agentId
          if (action === "close") {
            const result = await browserManager.close(id);
            return result;
          }
          if (action === "tabs") {
            const tabs = await tabManager.listTabs(id);
            return tabs;
          }
          const browser = browserManager.getBrowser(id);
          return browser ? { ok: true, browser } : { error: "browser_not_found", agentId: id };
        }

        if (resource === "tabs") {
          if (id && action === "screenshot") {
            // 通过 feature 获取截图预览
            const contentFeature = Array.from(features.values()).find(f => f instanceof ContentFeature);
            if (contentFeature) {
                const result = await contentFeature.getScreenshotPreview(id);
                if (result.error) return result;

                // 直接发送图片二进制流
                res.writeHead(200, {
                  'Content-Type': result.mimeType,
                  'Content-Length': result.buffer.length
                });
                res.end(result.buffer);
                return { handled: true }; // 已手动处理响应
            }
            return { error: "feature_not_found", message: "ContentFeature not available" };
          }
          if (id && action === "close") {
            log.info("HTTP请求关闭标签页", { tabId: id, method: req.method });
            const result = await tabManager.closeTab(id);
            log.info("标签页关闭结果", { tabId: id, result });
            return result;
          }
        }

        if (resource === "settings") {
          if (req?.method === "GET") {
            // 确保返回的 proxy 有 enabled 字段（迁移兼容：旧配置没有 enabled 字段时，按 server 非空判断）
            const proxy = { ...moduleConfig.proxy };
            if (proxy.enabled === undefined) {
              proxy.enabled = !!proxy.server;
            }
            return { ok: true, proxy };
          }
          if (req?.method === "PUT") {
            // 从原始请求流读取 body（module-api 只对 POST 读取了 body）
            const rawBody = await _readRequestBody(req);
            const body = JSON.parse(rawBody || "{}");
            const { proxy } = body;
            if (!proxy || typeof proxy !== "object") {
              return { error: "invalid_params", message: "缺少 proxy 配置" };
            }
            // 保存到配置文件
            moduleConfig = await configService.saveModuleConfig("chrome", { proxy: { ...proxy } });
            log.info("代理设置已更新", { proxy: moduleConfig.proxy });
            return { ok: true, proxy: moduleConfig.proxy };
          }
          return { error: "method_not_allowed", method: req?.method };
        }

        return { error: "not_found", path: pathParts.join("/") };
      } catch (err) {
        const message = err?.message ?? String(err);
        log.error("Chrome HTTP处理器错误", { error: message });
        return { error: "handler_error", message };
      }
    };
  },

  /**
   * 清理指定智能体的Chrome用户数据目录。
   * 会先关闭该智能体的浏览器实例（如果正在运行），然后删除数据目录。
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean} | {error: string, message: string}>}
   */
  cleanupAgentData(agentId) {
    if (!browserManager) {
      return Promise.resolve({ error: "module_not_initialized", message: "Chrome 模块未初始化" });
    }
    return browserManager.cleanupAgentData(agentId);
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info("Chrome 模块开始关闭");
    
    if (browserManager) {
      await browserManager.closeAll();
    }
    
    browserManager = null;
    tabManager = null;
    runtime = null;
    features.clear();
    
    log.info("Chrome 模块已关闭");
  }
};
