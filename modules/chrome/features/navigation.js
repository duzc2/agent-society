
import { sanitizeSelector, getPage, validateUrl } from "../utils.js";

/**
 * 导航功能模块
 * 负责页面的跳转和 URL 获取
 */
export class NavigationFeature {
  constructor(options) {
    this.log = options.log;
    this.tabManager = options.tabManager;
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chrome_navigate",
          description: "导航到指定 URL，模拟人类在浏览器地址栏输入网址访问。支持等待页面加载完成。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              url: { type: "string", description: "目标 URL。必须包含协议头（如 http:// 或 https://）。" },
              waitUntil: {
                type: "string",
                enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
                description: "页面加载完成的判断条件：load(页面的 load 事件触发), domcontentloaded(DOM 解析完成), networkidle0(500ms 内无网络请求), networkidle2(500ms 内网络请求不超过 2 个)。默认为 load"
              },
              timeoutMs: { type: "number", description: "导航超时时间（毫秒）。默认为 30000" }
            },
            required: ["tabId", "url"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_get_url",
          description: "获取标签页当前 URL，用于确认页面跳转或检查当前位置",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" }
            },
            required: ["tabId"]
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args) {
    switch (toolName) {
      case "chrome_navigate":
        return await this.navigate(args.tabId, args.url, args);
      case "chrome_get_url":
        return await this.getUrl(args.tabId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async navigate(tabId, url, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { waitUntil = "load", timeoutMs = 30000 } = options;
    /** @type {import('puppeteer-core').PuppeteerLifeCycleEvent} */
    const lifeCycleEvent = /** @type {import('puppeteer-core').PuppeteerLifeCycleEvent} */(waitUntil);

    // 验证 URL 安全性
    const urlResult = validateUrl(url);
    if (!urlResult.valid) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(urlResult));

    this.log.info("导航到 URL", { tabId, url, waitUntil });

    try {
      await page.goto(url, {
        waitUntil: lifeCycleEvent,
        timeout: timeoutMs
      });

      const finalUrl = page.url();
      const title = await page.title();

      return { ok: true, url: finalUrl, title };
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("timeout") || message.includes("Timeout")) {
        return { error: "navigation_timeout", url, timeoutMs, message };
      }
      return { error: "navigation_failed", url, message };
    }
  }

  async getUrl(tabId) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const url = page.url();
    return { ok: true, url };
  }
}
