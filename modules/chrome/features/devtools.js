
import { sanitizeSelector, getPage } from "../utils.js";

/**
 * 开发者工具模块
 * 负责 Console 日志采集、网络请求监控、DOM 检查、Cookies 管理等调试功能
 */
export class DevToolsFeature {
  constructor(options) {
    this.log = options.log;
    this.tabManager = options.tabManager;
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chrome_open_devtools",
          description: "为指定标签页启用开发者工具相关的调试采集能力（Console/页面错误/网络请求）。用于智能体在网页里调试和查看日志。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              captureConsole: { type: "boolean", description: "是否采集 console 日志，默认 true", default: true },
              captureNetwork: { type: "boolean", description: "是否采集所有网络请求，默认 true", default: true },
              maxEntries: { type: "number", description: "最多缓存条数，默认 500", default: 500 },
              clearExisting: { type: "boolean", description: "是否清空旧日志，默认 false", default: false }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_console_logs",
          description: "获取已采集的 Console 日志和页面错误。支持筛选。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              limit: { type: "number", description: "返回条数限制，默认 50", default: 50 },
              level: { type: "string", enum: ["log", "warn", "error", "info", "debug"], description: "筛选日志级别" },
              search: { type: "string", description: "搜索关键词" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_network_logs",
          description: "获取已采集的网络请求日志。支持筛选。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              limit: { type: "number", description: "返回条数限制，默认 50", default: 50 },
              status: { type: "string", enum: ["failed", "success"], description: "筛选请求状态" },
              resourceType: { type: "string", description: "筛选资源类型 (xhr, fetch, script, image, etc)" },
              search: { type: "string", description: "搜索 URL 关键词" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_inspect_element",
          description: "检查页面元素的详细信息（计算样式、属性、盒模型）。类似 Chrome DevTools 的 Inspect 功能。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "元素 CSS 选择器" }
            },
            required: ["tabId", "selector"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_cookies",
          description: "管理页面 Cookies（获取、设置、删除）。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              action: { type: "string", enum: ["get", "set", "delete", "getAll"], description: "操作类型：get(获取指定/所有)、set(设置)、delete(删除)、getAll(获取所有)" },
              name: { type: "string", description: "Cookie 名称（get/delete 时必填，set 时必填）" },
              value: { type: "string", description: "Cookie 值（set 时必填）" },
              domain: { type: "string", description: "Cookie 域名（set/delete 时可选）" },
              path: { type: "string", description: "Cookie 路径（set/delete 时可选）" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_intercept_request",
          description: "设置网络请求拦截规则。可以阻断请求、返回模拟数据或修改请求头。注意：开启拦截可能会影响页面性能，请谨慎使用。一旦开启，所有匹配的请求都会被拦截。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              enabled: { type: "boolean", description: "是否启用拦截。设为 true 开启拦截，设为 false 关闭拦截并清空规则。默认为 true" },
              rules: {
                type: "array",
                description: "拦截规则列表。按顺序匹配，匹配到第一条即停止。",
                items: {
                  type: "object",
                  properties: {
                    pattern: { type: "string", description: "URL 匹配模式（支持 * 通配符），如 '*.png', '*/api/user*'" },
                    action: { type: "string", enum: ["abort", "mock", "modify", "continue"], description: "动作：abort(阻断), mock(返回模拟数据), modify(修改请求), continue(放行)" },
                    response: {
                      type: "object",
                      description: "模拟响应数据（仅 mock 动作有效）",
                      properties: {
                        status: { type: "number", default: 200 },
                        contentType: { type: "string", default: "application/json" },
                        body: { type: "string", description: "响应体内容" },
                        headers: { type: "object", description: "响应头" }
                      }
                    },
                    modifications: {
                      type: "object",
                      description: "修改请求数据（仅 modify 动作有效）",
                      properties: {
                        headers: { type: "object", description: "覆盖的请求头" },
                        postData: { type: "string", description: "覆盖的 POST 数据" },
                        method: { type: "string", description: "覆盖的请求方法" }
                      }
                    }
                  },
                  required: ["pattern", "action"]
                }
              }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_storage",
          description: "管理 LocalStorage 和 SessionStorage。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              type: { type: "string", enum: ["localStorage", "sessionStorage"], description: "存储类型。必须明确指定是 localStorage 还是 sessionStorage" },
              action: { type: "string", enum: ["get", "set", "delete", "clear"], description: "操作类型：get(获取值), set(设置值), delete(删除键), clear(清空所有)" },
              key: { type: "string", description: "键名。当 action 为 get/set/delete 时必须提供。" },
              value: { type: "string", description: "键值。当 action 为 set 时必须提供。" }
            },
            required: ["tabId", "type", "action"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_devtools_emulation",
          description: "模拟设备环境（UserAgent、视口、时区等）。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              userAgent: { type: "string", description: "UserAgent 字符串" },
              viewport: {
                type: "object",
                description: "视口配置",
                properties: {
                  width: { type: "number" },
                  height: { type: "number" },
                  isMobile: { type: "boolean" },
                  hasTouch: { type: "boolean" },
                  deviceScaleFactor: { type: "number" }
                }
              },
              timezone: { type: "string", description: "时区 ID (如 'Asia/Shanghai')" },
              locale: { type: "string", description: "语言环境 (如 'zh-CN')" },
              geolocation: {
                type: "object",
                properties: {
                  latitude: { type: "number" },
                  longitude: { type: "number" },
                  accuracy: { type: "number" }
                }
              }
            },
            required: ["tabId"]
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args) {
    switch (toolName) {
      case "chrome_open_devtools":
        return await this.tabManager.enableDevtools(args.tabId, args);
      
      // 旧接口兼容
      case "chrome_get_devtools_content":
        return await this.tabManager.getDevtoolsContent(args.tabId, args);

      case "chrome_devtools_console_logs":
        return await this.getConsoleLogs(args.tabId, args);
      
      case "chrome_devtools_network_logs":
        return await this.getNetworkLogs(args.tabId, args);
      
      case "chrome_devtools_inspect_element":
        return await this.inspectElement(args.tabId, args.selector);
      
      case "chrome_devtools_cookies":
        return await this.manageCookies(args.tabId, args);

      case "chrome_devtools_intercept_request":
        return await this.interceptRequest(args.tabId, args);
      
      case "chrome_devtools_storage":
        return await this.manageStorage(args.tabId, args);
      
      case "chrome_devtools_emulation":
        return await this.emulateEnvironment(args.tabId, args);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * 简单的通配符匹配
   * @param {string} str 
   * @param {string} pattern 
   */
  _matchPattern(str, pattern) {
      if (!pattern) return false;
      if (pattern === '*') return true;
      // 简单的正则转换
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return regex.test(str);
  }

  async interceptRequest(tabId, { enabled = true, rules }) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const tab = this.tabManager.getTab(tabId); // 获取 tab 对象存储状态

    try {
        if (!enabled) {
            await page.setRequestInterception(false);
            if (tab._interceptionHandler) {
                page.off('request', tab._interceptionHandler);
                tab._interceptionHandler = null;
            }
            tab._interceptionEnabled = false;
            tab._interceptionRules = [];
            return { ok: true, message: "Request interception disabled" };
        }

        tab._interceptionRules = rules || [];
        
        // 如果已经开启，只需更新规则
        if (tab._interceptionEnabled) {
            return { ok: true, message: "Interception rules updated", ruleCount: tab._interceptionRules.length };
        }

        // 开启拦截
        await page.setRequestInterception(true);
        tab._interceptionEnabled = true;

        // 定义处理器
        const handler = async (request) => {
            try {
                // 如果已经处理过（比如被其他监听器处理），则跳过
                if (request.isInterceptResolutionHandled()) return;

                const url = request.url();
                const matchedRule = tab._interceptionRules.find(r => this._matchPattern(url, r.pattern));

                if (matchedRule) {
                    this.log.info("Intercrpted request", { url, action: matchedRule.action });
                    
                    if (matchedRule.action === 'abort') {
                        return await request.abort();
                    }
                    
                    if (matchedRule.action === 'mock') {
                        const resp = matchedRule.response || {};
                        return await request.respond({
                            status: resp.status || 200,
                            contentType: resp.contentType || 'application/json',
                            body: resp.body || '',
                            headers: resp.headers
                        });
                    }
                    
                    if (matchedRule.action === 'modify') {
                        const mods = matchedRule.modifications || {};
                        const overrides = {};
                        if (mods.headers) overrides.headers = { ...request.headers(), ...mods.headers };
                        if (mods.postData) overrides.postData = mods.postData;
                        if (mods.method) overrides.method = mods.method;
                        return await request.continue(overrides);
                    }
                }
                
                // 默认放行
                await request.continue();
            } catch (err) {
                // 忽略 "Request is already handled" 错误
                if (!err.message.includes('already handled')) {
                    this.log.error("Interception handler error", err);
                }
            }
        };

        tab._interceptionHandler = handler;
        page.on('request', handler);

        return { ok: true, message: "Request interception enabled", ruleCount: tab._interceptionRules.length };

    } catch (err) {
        return { error: "interception_failed", message: err.message };
    }
  }

  async manageStorage(tabId, { type, action, key, value }) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;

    try {
        const res = await page.evaluate((t, a, k, v) => {
            const storage = t === 'localStorage' ? window.localStorage : window.sessionStorage;
            if (!storage) return { error: "storage_not_available" };

            if (a === 'get') {
                if (!k) return { all: { ...storage } }; // 获取全部
                return { value: storage.getItem(k) };
            }
            if (a === 'set') {
                if (!k) return { error: "missing_key" };
                storage.setItem(k, v);
                return { success: true };
            }
            if (a === 'delete') {
                if (!k) return { error: "missing_key" };
                storage.removeItem(k);
                return { success: true };
            }
            if (a === 'clear') {
                storage.clear();
                return { success: true };
            }
            return { error: "invalid_action", action: a };
        }, type, action, key, value);

        return { ok: true, ...res };
    } catch (err) {
        return { error: "storage_op_failed", message: err.message };
    }
  }

  async emulateEnvironment(tabId, { userAgent, viewport, timezone, locale, geolocation }) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;

    try {
        if (userAgent) {
            await page.setUserAgent(userAgent);
        }

        if (viewport) {
            await page.setViewport(viewport);
        }

        if (timezone) {
            await page.emulateTimezone(timezone);
        }

        if (locale) {
            // 设置 Accept-Language 头
            await page.setExtraHTTPHeaders({
                'Accept-Language': locale
            });
            // 尝试设置 navigator.language (可能需要重新加载)
            await page.evaluateOnNewDocument((lang) => {
                Object.defineProperty(navigator, 'language', {
                    get: () => lang
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => [lang]
                });
            }, locale);
        }

        if (geolocation) {
            // 需要 grant 权限
            const context = page.browserContext();
            await context.overridePermissions(page.url(), ['geolocation']);
            await page.setGeolocation(geolocation);
        }

        return { ok: true, message: "Environment emulated" };
    } catch (err) {
        return { error: "emulation_failed", message: err.message };
    }
  }

  async getConsoleLogs(tabId, { limit = 50, level, search }) {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) return { error: "tab_not_found", tabId };
    
    const state = tab.devtools;
    if (!state || !state.entries) return { ok: true, logs: [], message: "DevTools not enabled or no logs" };

    let logs = state.entries.filter(e => e.type === "console" || e.type === "pageerror");
    
    if (level) {
      logs = logs.filter(e => e.level === level || (level === "error" && e.type === "pageerror"));
    }
    
    if (search) {
      const lowerSearch = search.toLowerCase();
      logs = logs.filter(e => (e.text || e.message || "").toLowerCase().includes(lowerSearch));
    }

    // 取最后 limit 条
    logs = logs.slice(-limit);

    return { ok: true, logs, total: state.entries.length };
  }

  async getNetworkLogs(tabId, { limit = 50, status, resourceType, search }) {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) return { error: "tab_not_found", tabId };
    
    const state = tab.devtools;
    if (!state || !state.networkEntries) return { ok: true, logs: [], message: "DevTools network capture not enabled" };

    let logs = state.networkEntries;

    if (status) {
        if (status === "failed") {
            logs = logs.filter(e => e.status >= 400 || e.statusText === "failed");
        } else if (status === "success") {
            logs = logs.filter(e => e.status >= 200 && e.status < 400);
        }
    }

    if (resourceType) {
        const lowerType = resourceType.toLowerCase();
        logs = logs.filter(e => (e.resourceType || "").toLowerCase() === lowerType);
    }

    if (search) {
        const lowerSearch = search.toLowerCase();
        logs = logs.filter(e => (e.url || "").toLowerCase().includes(lowerSearch));
    }

    // 取最后 limit 条
    logs = logs.slice(-limit);

    return { ok: true, logs, total: state.networkEntries.length };
  }

  async inspectElement(tabId, selector) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { cleaned } = sanitizeSelector(selector);

    try {
        const info = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;

            const computed = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            
            // 提取重要样式
            const styles = {};
            ['display', 'position', 'width', 'height', 'margin', 'padding', 'border', 'font-size', 'color', 'background-color', 'opacity', 'visibility', 'z-index'].forEach(prop => {
                styles[prop] = computed.getPropertyValue(prop);
            });

            // 提取属性
            const attrs = {};
            for (const attr of el.attributes) {
                attrs[attr.name] = attr.value;
            }

            return {
                tagName: el.tagName.toLowerCase(),
                id: el.id,
                className: el.className,
                rect: {
                    x: rect.x, y: rect.y, width: rect.width, height: rect.height
                },
                computedStyle: styles,
                attributes: attrs,
                innerText: el.innerText ? el.innerText.slice(0, 200) : ''
            };
        }, cleaned);

        if (!info) return { error: "element_not_found", selector: cleaned };

        return { ok: true, element: info };
    } catch (err) {
        return { error: "inspect_failed", message: err.message };
    }
  }

  async manageCookies(tabId, { action = "get", name, value, domain, path }) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;

    try {
        if (action === "get" || action === "getAll") {
            let cookies;
            if (name) {
                // Puppeteer 没有直接 getCookie(name) 的 API，需遍历
                const all = await page.cookies();
                cookies = all.filter(c => c.name === name);
            } else {
                cookies = await page.cookies();
            }
            return { ok: true, cookies };
        } 
        
        if (action === "set") {
            if (!name || !value) return { error: "missing_params", message: "name and value required for set" };
            const cookie = { name, value, url: page.url() }; // 默认使用当前 URL
            if (domain) cookie.domain = domain;
            if (path) cookie.path = path;
            
            await page.setCookie(cookie);
            return { ok: true, message: "Cookie set successfully" };
        }

        if (action === "delete") {
            if (!name) return { error: "missing_params", message: "name required for delete" };
            await page.deleteCookie({ name, url: page.url() }); // 尽力删除
            return { ok: true, message: "Cookie deleted" };
        }

        return { error: "invalid_action", action };
    } catch (err) {
        return { error: "cookie_op_failed", message: err.message };
    }
  }
}
