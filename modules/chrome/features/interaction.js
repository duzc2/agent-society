
import { sanitizeSelector, getPage } from "../utils.js";

/**
 * 页面交互模块
 * 负责点击、输入、滚动、执行脚本等操作
 */
export class InteractionFeature {
  constructor(options) {
    this.log = options.log;
    this.tabManager = options.tabManager;
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chrome_click",
          description: "点击页面元素，模拟人类鼠标点击操作。通过 CSS 选择器定位元素。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "CSS 选择器。用于定位需要点击的元素。" },
              waitForSelector: { type: "boolean", description: "点击前是否等待元素出现在 DOM 中。默认为 true。" },
              timeoutMs: { type: "number", description: "等待超时时间（毫秒）。默认为 5000。" }
            },
            required: ["tabId", "selector"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_click_at",
          description: "在页面指定坐标位置点击，用于无法通过选择器定位的元素或需要精确点击位置的场景。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              x: { type: "number", description: "X 坐标（像素）。相对于整个页面文档左上角的绝对坐标（Page Coordinates），会自动转换为视口坐标。" },
              y: { type: "number", description: "Y 坐标（像素）。相对于整个页面文档左上角的绝对坐标（Page Coordinates），会自动转换为视口坐标。" },
              button: { 
                type: "string", 
                enum: ["left", "right", "middle"],
                description: "鼠标按键：left(左键), right(右键), middle(中键)。默认为 left" 
              },
              clickCount: { type: "number", description: "点击次数。1 为单击，2 为双击。默认为 1" }
            },
            required: ["tabId", "x", "y"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_type",
          description: "在元素中输入文本（追加模式），模拟人类键盘输入。不会清空原有内容。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "输入框的 CSS 选择器" },
              text: { type: "string", description: "要输入的文本内容" },
              delay: { type: "number", description: "字符输入间隔（毫秒），用于模拟人类打字速度。默认为 0（瞬间完成）" }
            },
            required: ["tabId", "selector", "text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_fill",
          description: "清空输入框并填入新文本，相当于先清空再输入。适用于需要替换原有内容的场景。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "输入框的 CSS 选择器" },
              value: { type: "string", description: "要设置的完整值" }
            },
            required: ["tabId", "selector", "value"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_evaluate",
          description: "在页面上下文中执行 JavaScript 代码，可访问页面 DOM 和 JavaScript 环境。用于复杂的页面操作或数据提取。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              script: { type: "string", description: "要执行的 JavaScript 代码。代码将在页面上下文中运行。可以使用 'return' 返回结果。" }
            },
            required: ["tabId", "script"]
          }
        }
      },
      // {
      //   type: "function",
      //   function: {
      //     name: "chrome_wait_for",
      //     description: "等待元素出现或满足条件，用于处理动态加载的页面内容。",
      //     parameters: {
      //       type: "object",
      //       properties: {
      //         tabId: { type: "string", description: "标签页 ID" },
      //         selector: { type: "string", description: "CSS 选择器" },
      //         state: {
      //           type: "string",
      //           enum: ["attached", "detached", "visible", "hidden"],
      //           description: "等待的目标状态：visible(可见), hidden(隐藏), attached(存在于DOM), detached(从DOM移除)。默认为 visible"
      //         },
      //         timeoutMs: { type: "number", description: "超时时间（毫秒）。默认为 30000" }
      //       },
      //       required: ["tabId", "selector"]
      //     }
      //   }
      // },
      {
        type: "function",
        function: {
          name: "chrome_scroll",
          description: "滚动页面，模拟人类鼠标滚轮操作。可以向上/向下滚动指定距离，或直接滚动到顶部/底部/指定元素。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              direction: { 
                type: "string", 
                enum: ["up", "down", "top", "bottom", "element"],
                description: "滚动行为：up(向上滚), down(向下滚), top(回到顶部), bottom(滚到底部), element(滚动到元素)。默认为 down"
              },
              distance: { type: "number", description: "滚动距离（像素）。当 direction 为 up/down 时生效。默认为 800" },
              selector: { type: "string", description: "目标元素选择器。当 direction 为 element 时必须提供。" }
            },
            required: ["tabId"]
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args) {
    switch (toolName) {
      case "chrome_click":
        return await this.click(args.tabId, args.selector, args);
      case "chrome_click_at":
        return await this.clickAt(args.tabId, args.x, args.y, args);
      case "chrome_type":
        return await this.type(args.tabId, args.selector, args.text, args);
      case "chrome_fill":
        return await this.fill(args.tabId, args.selector, args.value);
      case "chrome_evaluate":
        return await this.evaluate(args.tabId, args.script);
      case "chrome_wait_for":
        return await this.waitFor(args.tabId, args.selector, args);
      case "chrome_scroll":
        return await this.scroll(args.tabId, args);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async click(tabId, selector, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { waitForSelector = true, timeoutMs = 5000 } = options;

    // 清理选择器
    const { original, cleaned, modified } = sanitizeSelector(selector);
    if (modified) {
      this.log.info("选择器已清理", { tabId, original, cleaned });
    }

    this.log.info("点击元素", { tabId, selector: cleaned });

    try {
      if (waitForSelector) {
        await page.waitForSelector(cleaned, { timeout: timeoutMs });
      }
      
      await page.click(cleaned);
      return { ok: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("No element found") || message.includes("not found")) {
        return { error: "element_not_found", selector: cleaned, originalSelector: modified ? original : undefined };
      }
      if (message.includes("timeout") || message.includes("Timeout")) {
        return { error: "wait_timeout", selector: cleaned, originalSelector: modified ? original : undefined, timeoutMs };
      }
      return { error: "click_failed", selector: cleaned, originalSelector: modified ? original : undefined, message };
    }
  }

  async clickAt(tabId, x, y, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { button = "left", clickCount = 1 } = options;

    this.log.info("按坐标点击", { tabId, x, y, button, clickCount });

    try {
      // 1. 坐标转换：将页面坐标转换为视口坐标 (Viewport Coordinates)
      // Puppeteer 的 mouse API 使用的是相对于视口左上角的坐标
      // 如果用户提供的是相对于页面文档的坐标（Page Coordinates），需要减去当前的滚动偏移量
      const { scrollX, scrollY } = await page.evaluate(() => ({
          scrollX: window.scrollX,
          scrollY: window.scrollY
      }));

      const viewportX = x - scrollX;
      const viewportY = y - scrollY;

      // 检查坐标是否在视口内
      const viewport = page.viewport();
      if (viewport) {
          if (viewportX < 0 || viewportX > viewport.width || viewportY < 0 || viewportY > viewport.height) {
              // 如果目标在视口外，尝试滚动到该位置
              // 计算需要的滚动距离
              await page.evaluate((targetX, targetY) => {
                  window.scrollTo(targetX - window.innerWidth / 2, targetY - window.innerHeight / 2);
              }, x, y);
              
              // 重新获取滚动偏移量
              const newScroll = await page.evaluate(() => ({
                  scrollX: window.scrollX,
                  scrollY: window.scrollY
              }));
              
              // 更新视口坐标（此时目标应该在视口中心附近）
              // 注意：这里重新计算，使用新的 scroll 值
              const newViewportX = x - newScroll.scrollX;
              const newViewportY = y - newScroll.scrollY;
              
              // 再次移动鼠标
              await page.mouse.move(newViewportX, newViewportY, { steps: 10 });
              await page.mouse.click(newViewportX, newViewportY, { button, clickCount, delay: 100 });
              return { ok: true, x, y, viewportX: newViewportX, viewportY: newViewportY, scrolled: true };
          }
      }

      // 2. 移动鼠标到目标位置 (平滑移动，模拟人类)
      await page.mouse.move(viewportX, viewportY, { steps: 10 });
      
      // 3. 执行点击
      await page.mouse.click(viewportX, viewportY, { 
          button, 
          clickCount,
          delay: 100 
      });

      return { ok: true, x, y, viewportX, viewportY };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "click_at_failed", x, y, message };
    }
  }

  async type(tabId, selector, text, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { delay = 0 } = options;

    // 清理选择器
    const { original, cleaned, modified } = sanitizeSelector(selector);
    if (modified) {
      this.log.info("选择器已清理", { tabId, original, cleaned });
    }

    this.log.info("输入文本", { tabId, selector: cleaned, textLength: text?.length });

    try {
      await page.waitForSelector(cleaned, { timeout: 5000 });
      await page.type(cleaned, text, { delay });
      return { ok: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("No element found") || message.includes("not found")) {
        return { error: "element_not_found", selector: cleaned, originalSelector: modified ? original : undefined };
      }
      return { error: "type_failed", selector: cleaned, originalSelector: modified ? original : undefined, message };
    }
  }

  async fill(tabId, selector, value) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;

    // 清理选择器
    const { original, cleaned, modified } = sanitizeSelector(selector);
    if (modified) {
      this.log.info("选择器已清理", { tabId, original, cleaned });
    }

    this.log.info("填充文本", { tabId, selector: cleaned, valueLength: value?.length });

    try {
      await page.waitForSelector(cleaned, { timeout: 5000 });
      
      // 清空现有内容
      await page.$eval(cleaned, el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = "";
        }
      });
      
      // 填入新值
      await page.type(cleaned, value);
      return { ok: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("No element found") || message.includes("not found")) {
        return { error: "element_not_found", selector: cleaned, originalSelector: modified ? original : undefined };
      }
      return { error: "fill_failed", selector: cleaned, originalSelector: modified ? original : undefined, message };
    }
  }

  async evaluate(tabId, script) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;

    this.log.info("执行脚本", { tabId, scriptLength: script?.length });

    try {
      // 检查脚本是否包含 return 语句
      // 如果用户没有写 return，尝试隐式返回最后一条语句的值（类似控制台行为）
      // 但为了稳健性，我们主要依赖用户显式 return，或者将整个脚本包装在 async function 中
      
      const evalResult = await page.evaluate(async (code) => {
        try {
            // 尝试直接作为表达式执行
            const func = new Function(`return (async () => { ${code} })()`);
            return await func();
        } catch (e) {
            // 如果代码包含语句（如 const x = 1），上面的方式可能失败
            // 回退到常规执行，此时需要用户显式 return
            const func = new Function(`return (async () => { 
                try {
                    ${code} 
                } catch(err) {
                    throw err;
                }
            })()`);
            return await func();
        }
      }, script);
      
      return { ok: true, result: evalResult };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "evaluate_error", message };
    }
  }

  async waitFor(tabId, selector, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { state = "visible", timeoutMs = 30000 } = options;

    // 清理选择器
    const { original, cleaned, modified } = sanitizeSelector(selector);
    if (modified) {
      this.log.info("选择器已清理", { tabId, original, cleaned });
    }

    this.log.info("等待元素", { tabId, selector: cleaned, state });

    try {
      const waitOptions = { timeout: timeoutMs };
      
      switch (state) {
        case "attached":
          await page.waitForSelector(cleaned, { ...waitOptions });
          break;
        case "detached":
          await page.waitForSelector(cleaned, { ...waitOptions, hidden: true });
          break;
        case "visible":
          await page.waitForSelector(cleaned, { ...waitOptions, visible: true });
          break;
        case "hidden":
          await page.waitForSelector(cleaned, { ...waitOptions, hidden: true });
          break;
        default:
          await page.waitForSelector(cleaned, { ...waitOptions, visible: true });
      }
      
      return { ok: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("timeout") || message.includes("Timeout")) {
        return { error: "wait_timeout", selector: cleaned, originalSelector: modified ? original : undefined, state, timeoutMs };
      }
      return { error: "wait_failed", selector: cleaned, originalSelector: modified ? original : undefined, message };
    }
  }

  async scroll(tabId, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { direction = 'down', distance = 800, selector } = options;

    this.log.info("滚动页面", { tabId, direction, distance, selector });

    try {
      // 滚动函数：模拟滚轮平滑滚动
      // deltaY: 总滚动距离（正数向下，负数向上）
      const smoothScroll = async (deltaY) => {
        const stepSize = 100;
        const steps = Math.max(1, Math.ceil(Math.abs(deltaY) / stepSize));
        const stepDelta = deltaY / steps;

        for (let i = 0; i < steps; i++) {
          // 主滚动：通过 Runtime 域执行 JS，后台页面也不会阻塞
          await page.evaluate(
            (dy) => window.scrollBy({ top: dy, behavior: 'instant' }),
            stepDelta
          );

          // 辅助：尝试在 500ms 内派发真实 WheelEvent
          // 后台页面超时跳过，不影响滚动结果
          try {
            await Promise.race([
              page.mouse.wheel({ deltaY: stepDelta }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('wheel_timeout')), 500)
              )
            ]);
          } catch (wheelErr) {
            const msg = wheelErr?.message ?? String(wheelErr);
            this.log.debug('wheel_event_skipped', {
              step: i, stepDelta,
              reason: msg.includes('wheel_timeout') ? 'timeout_500ms' : 'cdp_error',
              message: msg
            });
          }

          await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
        }
      };

      if (direction === 'top') {
          // 滚动到顶部：当前 scrollY 的负值
          const currentScrollY = await page.evaluate(() => window.scrollY);
          await smoothScroll(-currentScrollY);
      } else if (direction === 'bottom') {
          // 滚动到底部：总高度 - 当前 scrollY - 视口高度
          const { scrollHeight, scrollY, innerHeight } = await page.evaluate(() => ({
              scrollHeight: document.body.scrollHeight,
              scrollY: window.scrollY,
              innerHeight: window.innerHeight
          }));
          const distanceToBottom = scrollHeight - scrollY - innerHeight;
          if (distanceToBottom > 0) {
              await smoothScroll(distanceToBottom);
          }
      } else if (direction === 'element' && selector) {
          // 滚动到元素
          // 1. 先找到元素
          const element = await page.$(selector);
          if (!element) return { error: "element_not_found", selector };
          
          // 2. 计算元素位置相对于视口的距离
          const box = await element.boundingBox();
          if (box) {
             // 滚动到元素上方 100px 处，确保元素不被顶部遮挡
             const deltaY = box.y - 100; 
             await smoothScroll(deltaY);
          }
      } else if (direction === 'up') {
          await smoothScroll(-Math.abs(distance));
      } else {
          // down (default)
          await smoothScroll(Math.abs(distance));
      }

      // 返回滚动后的位置
      const newScrollY = await page.evaluate(() => window.scrollY);
      return { ok: true, scrollY: newScrollY };

    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "scroll_failed", message };
    }
  }
}
