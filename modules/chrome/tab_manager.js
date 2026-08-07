/**
 * 标签页管理器
 * 负责 Chrome 标签页的创建、关闭和生命周期管理。
 * 每个智能体的标签页共用同一个浏览器，自动管理浏览器生命周期。
 */

import { randomUUID } from "node:crypto";
import { validateUrl } from "./utils.js";

/**
 * @typedef {object} Tab
 * @property {string} id - 标签页唯一 ID
 * @property {string} agentId - 所属智能体 ID
 * @property {import('puppeteer-core').Page} page - Puppeteer Page 对象
 * @property {string} createdAt - 创建时间 ISO 字符串
 * @property {string} status - 状态: 'active' | 'closed'
 * @property {{enabled: boolean, config: {captureConsole: boolean, capturePageError: boolean, captureRequestFailed: boolean, maxEntries: number}, entries: Array<any>, dropped: number, nextId: number}|null} devtools - DevTools 调试采集状态
 */

export class TabManager {
  /**
   * @param {{log: any, browserManager: import('./browser_manager.js').BrowserManager}} options
   */
  constructor(options) {
    this.log = options.log;
    this.browserManager = options.browserManager;
    /** @type {Map<string, Tab>} */
    this._tabs = new Map();
  }

  /**
   * 将日志文本做裁剪，避免单条日志过大导致工具返回内容膨胀
   * @param {string} text - 原始文本
   * @param {number} maxLength - 最大长度
   * @returns {string}
   */
  _truncateText(text, maxLength) {
    const s = text == null ? "" : String(text);
    if (s.length <= maxLength) return s;
    return s.slice(0, maxLength) + "…";
  }

  /**
   * 初始化/读取标签页 DevTools 采集状态
   * @param {Tab} tab
   * @returns {NonNullable<Tab["devtools"]>}
   */
  _ensureDevtoolsState(tab) {
    if (tab.devtools) return tab.devtools;
    tab.devtools = {
      enabled: false,
      config: {
        captureConsole: true,
        capturePageError: true,
        captureRequestFailed: false,
        captureNetwork: false, // 新增：捕获所有网络请求
        maxEntries: 500
      },
      entries: [], // Console 和 Error 日志
      networkEntries: [], // 新增：网络请求日志
      dropped: 0,
      nextId: 1
    };
    return tab.devtools;
  }

  /**
   * 写入一条 DevTools 日志到 ring buffer
   * @param {Tab} tab
   * @param {any} entry
   * @returns {void}
   */
  _appendDevtoolsEntry(tab, entry) {
    const state = this._ensureDevtoolsState(tab);
    
    // 网络请求存入单独的缓冲区
    if (entry.type === 'network') {
      state.networkEntries.push(entry);
      const maxEntries = Math.max(1, Math.floor(state.config.maxEntries || 500));
      while (state.networkEntries.length > maxEntries) {
        state.networkEntries.shift();
      }
      return;
    }

    // 其他日志（Console, Error）存入主缓冲区
    state.entries.push(entry);
    const maxEntries = Math.max(1, Math.floor(state.config.maxEntries || 500));
    while (state.entries.length > maxEntries) {
      state.entries.shift();
      state.dropped += 1;
    }
  }

  /**
   * 为指定智能体创建新标签页
   * 如果该智能体还没有浏览器，会自动启动一个
   * @param {string} agentId - 智能体ID
   * @param {string} [url] - 初始 URL
   * @returns {Promise<{ok: true, tabId: string, agentId: string, url?: string, browserStarted: boolean} | {error: string, message: string}>}
   */
  async newTab(agentId, url) {
    // 获取或创建浏览器（使用配置文件中的设置）
    const browserResult = await this.browserManager.getOrCreateBrowser(agentId);
    
    if (!("ok" in browserResult && browserResult.ok)) {
      const errorResult = /** @type {{error:string, message:string}} */(/** @type {unknown} */(browserResult));
      return { error: errorResult.error, message: errorResult.message };
    }

    const browser = this.browserManager.getPuppeteerBrowser(agentId);
    const browserInstance = this.browserManager.getBrowser(agentId);
    
    if (!browser || !browserInstance) {
      return { error: "browser_not_available", message: "浏览器不可用" };
    }

    const tabId = randomUUID();
    this.log.info("创建新标签页", { tabId, agentId, url });

    try {
      let page;
      const isFirstTab = this.browserManager.getTabCount(agentId) === 0;
      
      if (isFirstTab) {
        // 第一个标签页：接管浏览器默认创建的空白标签页
        const existingPages = await browser.pages();
        if (existingPages.length > 0) {
          page = existingPages[0];
          this.log.info("接管浏览器默认标签页", { tabId, agentId });
        } else {
          page = await browser.newPage();
        }
      } else {
        // 后续标签页：创建新页面
        page = await browser.newPage();
      }
      
      // 不设置固定视口，让页面自动跟随浏览器窗口大小
      // 浏览器使用 --start-maximized 启动已最大化
      // 设置为 null 让视口自动适应浏览器窗口的实际内容区域
      await page.setViewport(null);
      
      this.log.info("已设置视口跟随窗口", { tabId });
      
      // 如果浏览器实例有代理认证信息，为新页面设置认证
      if (browserInstance.proxy && browserInstance.proxy.username && browserInstance.proxy.password) {
        await page.authenticate({
          username: browserInstance.proxy.username,
          password: browserInstance.proxy.password
        });
        this.log.info("已为新标签页设置代理认证", { tabId });
      }
      
      const tab = {
        id: tabId,
        agentId,
        page,
        createdAt: new Date().toISOString(),
        status: "active",
        devtools: null
      };

      this._tabs.set(tabId, tab);

      // 更新标签页计数
      this.browserManager.updateTabCount(agentId, 1);

      // 监听页面关闭
      page.on("close", () => {
        this._handlePageClose(tabId, agentId);
      });

      // 如果提供了 URL，验证安全性并导航到该页面
      if (url) {
        const urlResult = validateUrl(url);
        if (!urlResult.valid) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(urlResult));
        await page.goto(url, { waitUntil: "load" });
      }

      const currentUrl = page.url();
      this.log.info("标签页创建成功", { tabId, agentId, url: currentUrl });

      return {
        ok: true,
        tabId,
        agentId,
        url: currentUrl,
        browserStarted: /** @type {{isNew:boolean}} */(browserResult).isNew
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      this.log.error("标签页创建失败", { tabId, agentId, error: message });
      return { error: "tab_create_failed", message };
    }
  }

  /**
   * 处理页面关闭事件
   * @param {string} tabId - 标签页ID
   * @param {string} agentId - 智能体ID
   * @private
   */
  _handlePageClose(tabId, agentId) {
    const tab = this._tabs.get(tabId);
    if (tab) {
      tab.status = "closed";
      this._tabs.delete(tabId);
      this.log.info("标签页已关闭", { tabId, agentId });

      // 更新标签页计数
      const remainingTabs = this.browserManager.updateTabCount(agentId, -1);
      
      // 如果没有标签页了，自动关闭浏览器
      if (remainingTabs <= 0) {
        this.log.info("该智能体没有标签页了，自动关闭浏览器", { agentId });
        this.browserManager.close(agentId).catch(err => {
          this.log.error("自动关闭浏览器失败", { agentId, error: err?.message });
        });
      }
    }
  }

  /**
   * 为指定标签页启用开发者工具相关的调试采集能力（Console/页面错误/可选网络失败日志）
   * @param {string} tabId - 标签页 ID
   * @param {{captureConsole?: boolean, capturePageError?: boolean, captureRequestFailed?: boolean, maxEntries?: number, clearExisting?: boolean}} options
   * @returns {Promise<{ok: true, tabId: string, enabled: true, config: any, dropped: number, total: number} | {error: string, tabId: string}>}
   */
  async enableDevtools(tabId, options = {}) {
    const tab = this._tabs.get(tabId);
    if (!tab || tab.status !== "active") {
      return { error: "tab_not_found", tabId };
    }

    const state = this._ensureDevtoolsState(tab);
    const {
      captureConsole = state.config.captureConsole,
      capturePageError = state.config.capturePageError,
      captureRequestFailed = state.config.captureRequestFailed,
      captureNetwork = state.config.captureNetwork,
      maxEntries = state.config.maxEntries,
      clearExisting = false
    } = options;

    state.config = {
      captureConsole: Boolean(captureConsole),
      capturePageError: Boolean(capturePageError),
      captureRequestFailed: Boolean(captureRequestFailed),
      captureNetwork: Boolean(captureNetwork),
      maxEntries: Math.max(1, Math.floor(Number(maxEntries || 500)))
    };

    if (clearExisting) {
      state.entries = [];
      state.networkEntries = [];
      state.dropped = 0;
      state.nextId = 1;
    }

    if (!state.enabled) {
      state.enabled = true;
      const page = tab.page;

      // 1. Console 日志采集
      page.on("console", (msg) => {
        try {
          const current = tab.devtools;
          if (!current?.config?.captureConsole) return;
          
          // 获取调用堆栈信息（如果有）
          const location = typeof msg?.location === "function" ? msg.location() : undefined;
          
          const entry = {
            id: current.nextId++,
            ts: new Date().toISOString(),
            type: "console",
            level: typeof msg?.type === "function" ? msg.type() : undefined,
            text: this._truncateText(typeof msg?.text === "function" ? msg.text() : String(msg), 4000),
            location: location ? { url: location.url, lineNumber: location.lineNumber } : undefined,
            args: msg.args().map(arg => {
                // 尝试获取 JSHandle 的简单值描述，避免复杂对象展开
                try {
                    return arg.toString(); // 简单转字符串
                } catch {
                    return "[Object]";
                }
            })
          };
          this._appendDevtoolsEntry(tab, entry);
        } catch (err) {
          this.log.debug("DevTools console 采集失败", { tabId, error: err?.message ?? String(err) });
        }
      });

      // 2. 页面错误采集
      page.on("pageerror", (err) => {
        try {
          const current = tab.devtools;
          if (!current?.config?.capturePageError) return;
          const errorObj = /** @type {Error} */(err);
          const entry = {
            id: current.nextId++,
            ts: new Date().toISOString(),
            type: "pageerror",
            message: this._truncateText(errorObj?.message ?? String(err), 4000),
            stack: this._truncateText(errorObj?.stack ?? "", 12000)
          };
          this._appendDevtoolsEntry(tab, entry);
        } catch (e) {
          const innerError = /** @type {Error} */(e);
          this.log.debug("DevTools pageerror 采集失败", { tabId, error: innerError?.message ?? String(e) });
        }
      });

      // 3. 网络请求失败采集 (保留旧逻辑兼容)
      page.on("requestfailed", (request) => {
        try {
          const current = tab.devtools;
          if (!current?.config?.captureRequestFailed) return;
          const failure = typeof request?.failure === "function" ? request.failure() : null;
          const entry = {
            id: current.nextId++,
            ts: new Date().toISOString(),
            type: "requestfailed",
            url: this._truncateText(typeof request?.url === "function" ? request.url() : "", 4000),
            method: typeof request?.method === "function" ? request.method() : undefined,
            resourceType: typeof request?.resourceType === "function" ? request.resourceType() : undefined,
            errorText: this._truncateText(failure?.errorText ?? "", 4000)
          };
          this._appendDevtoolsEntry(tab, entry);
        } catch (e) {
          this.log.debug("DevTools requestfailed 采集失败", { tabId, error: e?.message ?? String(e) });
        }
      });

      // 4. 全量网络请求采集 (新增)
      // 使用 requestfinished 和 requestfailed 事件来捕获完整的请求周期
      const handleNetworkEvent = (request, eventType) => {
        try {
            const current = tab.devtools;
            if (!current?.config?.captureNetwork) return;

            const response = request.response();
            const failure = request.failure();

            const entry = {
                id: current.nextId++, // 这里的 ID 可能与 console ID 混用，但没关系，主要用于排序
                ts: new Date().toISOString(),
                type: "network",
                eventType, // 'finished' | 'failed'
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                status: response ? response.status() : (failure ? 'failed' : 'unknown'),
                statusText: response ? response.statusText() : (failure ? failure.errorText : ''),
                headers: response ? response.headers() : {},
                requestHeaders: request.headers(),
                postData: request.postData(), // 可能包含敏感信息，需谨慎
                timing: response ? response.timing() : null
            };

            // 限制日志大小
            if (entry.postData && entry.postData.length > 2000) {
                entry.postData = entry.postData.slice(0, 2000) + "...(truncated)";
            }

            this._appendDevtoolsEntry(tab, entry);
        } catch (e) {
            this.log.debug("DevTools network 采集失败", { tabId, error: e?.message ?? String(e) });
        }
      };

      page.on("requestfinished", (req) => handleNetworkEvent(req, "finished"));
      page.on("requestfailed", (req) => handleNetworkEvent(req, "failed"));

      this.log.info("DevTools 调试采集已启用", { tabId });
    }

    return { ok: true, tabId, enabled: true, config: state.config, dropped: state.dropped, total: state.entries.length + state.networkEntries.length };
  }

  /**
   * 获取指定标签页已缓存的开发者工具内容（结构化日志）
   * @param {string} tabId - 标签页 ID
   * @param {{types?: Array<"console"|"pageerror"|"requestfailed">, limit?: number, clearAfterRead?: boolean}} options
   * @returns {Promise<{ok: true, tabId: string, entries: Array<any>, dropped: number, total: number} | {error: string, tabId: string}>}
   */
  async getDevtoolsContent(tabId, options = {}) {
    const tab = this._tabs.get(tabId);
    if (!tab || tab.status !== "active") {
      return { error: "tab_not_found", tabId };
    }

    const state = this._ensureDevtoolsState(tab);
    const { types, limit = 200, clearAfterRead = false } = options;
    const limitNumber = Math.max(0, Math.floor(Number(limit ?? 200)));
    const typeSet = Array.isArray(types) && types.length > 0 ? new Set(types) : null;

    const filtered = typeSet
      ? state.entries.filter((e) => typeSet.has(e?.type))
      : state.entries.slice();
    const sliced = limitNumber > 0 ? filtered.slice(Math.max(0, filtered.length - limitNumber)) : [];

    const result = { ok: true, tabId, entries: sliced, dropped: state.dropped, total: state.entries.length };

    if (clearAfterRead) {
      state.entries = [];
      state.dropped = 0;
      state.nextId = 1;
    }

    return /** @type {{ok:true, tabId:string, entries:any[], dropped:number, total:number}} */(result);
  }

  /**
   * 关闭指定的标签页
   * @param {string} tabId - 标签页 ID
   * @returns {Promise<{ok: true, remainingTabs: Array<{id: string, url: string, title: string, status: string}>} | {error: string, tabId: string, message?: string, errorType?: string}>}
   */
  async closeTab(tabId) {
    const tab = this._tabs.get(tabId);
    
    if (!tab) {
      return { error: "tab_not_found", tabId };
    }

    const agentId = tab.agentId;
    this.log.info("关闭标签页", { tabId, agentId, status: tab.status });

    try {
      if (tab.status === "active" && tab.page) {
        // 检查页面是否仍然有效
        const isPageClosed = tab.page.isClosed();
        this.log.debug("页面状态检查", { tabId, isClosed: isPageClosed });
        
        if (!isPageClosed) {
          // 设置超时保护，避免无限等待
          const closePromise = tab.page.close();
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("关闭超时")), 5000);
          });
          
          await Promise.race([closePromise, timeoutPromise]);
          this.log.debug("页面关闭成功", { tabId });
        } else {
          this.log.info("页面已经关闭", { tabId });
        }
      }
      
      // _handlePageClose 会处理标签页清理和浏览器自动关闭
      // 获取剩余标签页列表
      const remainingTabsResult = await this.listTabs(agentId);
      const remainingTabs = remainingTabsResult.ok ? remainingTabsResult.tabs : [];
      
      return { ok: true, remainingTabs };
    } catch (err) {
      const message = err?.message ?? String(err);
      const errorType = this._categorizeError(err);
      
      this.log.error("标签页关闭失败", { 
        tabId, 
        agentId,
        error: message, 
        errorType,
        stack: err?.stack 
      });
      
      // 即使关闭失败，也清理状态
      this._handlePageClose(tabId, agentId);
      
      return { 
        error: "tab_close_failed", 
        tabId, 
        message,
        errorType 
      };
    }
  }

  /**
   * 分类错误类型，便于调试
   * @param {Error} err - 错误对象
   * @returns {string} 错误类型
   */
  _categorizeError(err) {
    const message = err?.message ?? String(err);
    
    if (message.includes("Protocol error") || message.includes("Target closed")) {
      return "connection_lost";
    }
    if (message.includes("关闭超时") || message.includes("timeout")) {
      return "timeout";
    }
    if (message.includes("Session closed") || message.includes("Connection closed")) {
      return "session_closed";
    }
    
    return "unknown";
  }

  /**
   * 列出指定智能体的所有标签页
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean, tabs: Array<{id: string, url: string, title: string, status: string}>} | {error: string}>}
   */
  async listTabs(agentId) {
    const browser = this.browserManager.getBrowser(agentId);
    
    if (!browser) {
      return { ok: true, tabs: [] };
    }

    const tabs = [];
    for (const [tabId, tab] of this._tabs) {
      if (tab.agentId === agentId && tab.status === "active") {
        try {
          const url = tab.page.url();
          const title = await tab.page.title();
          tabs.push({
            id: tabId,
            url,
            title,
            status: tab.status,
            createdAt: tab.createdAt
          });
        } catch (e) {
          this.log.warn('[TabManager] 获取标签页URL/标题失败，页面可能已关闭', { tabId, error: e.message, stack: e.stack });
          tabs.push({
            id: tabId,
            url: "unknown",
            title: "unknown",
            status: "error",
            createdAt: tab.createdAt
          });
        }
      }
    }

    return { ok: true, tabs };
  }

  /**
   * 获取标签页
   * @param {string} tabId - 标签页 ID
   * @returns {Tab|null}
   */
  getTab(tabId) {
    return this._tabs.get(tabId) ?? null;
  }

  /**
   * 获取 Puppeteer Page 对象
   * @param {string} tabId - 标签页 ID
   * @returns {import('puppeteer-core').Page|null}
   */
  getPage(tabId) {
    const tab = this._tabs.get(tabId);
    return tab?.page ?? null;
  }

  /**
   * 关闭指定智能体的所有标签页
   * @param {string} agentId - 智能体ID
   * @returns {Promise<void>}
   */
  async closeTabsForAgent(agentId) {
    const tabsToClose = [];
    for (const [tabId, tab] of this._tabs) {
      if (tab.agentId === agentId) {
        tabsToClose.push(tabId);
      }
    }

    for (const tabId of tabsToClose) {
      await this.closeTab(tabId);
    }
  }

  /**
   * 获取标签页数量
   * @returns {number}
   */
  getTabCount() {
    return this._tabs.size;
  }

  /**
   * 获取指定智能体的标签页数量
   * @param {string} agentId - 智能体ID
   * @returns {number}
   */
  getTabCountForAgent(agentId) {
    let count = 0;
    for (const tab of this._tabs.values()) {
      if (tab.agentId === agentId && tab.status === "active") {
        count++;
      }
    }
    return count;
  }
}
