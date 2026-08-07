
import { sanitizeSelector, getPage } from "../utils.js";
import { getWorkspaceManager } from "../../../src/platform/services/workspace/workspace_manager.js";

/**
 * 内容获取模块
 * 负责获取页面截图、文本和元素信息
 */
export class ContentFeature {
  constructor(options) {
    this.log = options.log;
    this.tabManager = options.tabManager;
    this.runtime = options.runtime;
  }

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "chrome_screenshot",
          description: "获取页面截图并保存到工作区。可截取整个页面或特定元素。返回保存后的文件路径。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              fullPage: { type: "boolean", description: "是否截取整个页面（包括滚动区域）。true 为全屏截图，false 为仅可视区域截图。默认为 false" },
              selector: { type: "string", description: "截取特定元素（CSS 选择器）。如果指定了此参数，将只截取该元素区域；否则截取全页或可视区域。" },
              workspacePath: { type: "string", description: "保存到工作区的路径（如 'screenshots/page.jpg'）。如果不指定，将自动生成默认文件名并保存。" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_get_text",
          description: "获取页面纯文本内容，自动过滤 HTML 标签。可获取整个页面或特定元素的文本。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "CSS 选择器。如果指定，获取该元素的文本；如果不指定，获取整个页面的文本内容。" }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_get_elements",
          description: "获取页面可交互元素的结构化信息（JSON格式）。返回所有可见的文本、链接、按钮、输入框等控件信息，包含元素的选择器、文本内容、类型等，便于智能体分析页面并决策下一步操作（如点击、输入等）。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              selector: { type: "string", description: "限定范围的 CSS 选择器（可选）。如果不指定，则搜索整个页面。" },
              types: { 
                type: "array", 
                items: { 
                  type: "string",
                  enum: ["link", "button", "input", "text", "image", "select", "textarea", "checkbox", "radio"]
                },
                description: "要获取的元素类型列表。可选值：link, button, input, text, image, select, textarea, checkbox, radio。不指定则获取所有支持的类型。"
              },
              maxElements: { type: "number", description: "最大返回元素数量。防止返回过多数据导致上下文溢出。默认为 1000。" }
            },
            required: ["tabId"]
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args, ctx) {
    switch (toolName) {
      case "chrome_screenshot":
        return await this.screenshot(args.tabId, { ...args, ctx });
      case "chrome_get_text":
        return await this.getText(args.tabId, args.selector, ctx);
      case "chrome_get_elements":
        return await this.getElements(args.tabId, args, ctx);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async screenshot(tabId, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { fullPage = false, selector, ctx, workspacePath } = options;

    // 清理选择器（如果提供）
    let cleanedSelector = selector;
    let originalSelector;
    let selectorModified = false;
    if (selector) {
      const sanitized = sanitizeSelector(selector);
      cleanedSelector = sanitized.cleaned;
      originalSelector = sanitized.original;
      selectorModified = sanitized.modified;
      if (selectorModified) {
        this.log.info("选择器已清理", { tabId, original: originalSelector, cleaned: cleanedSelector });
      }
    }

    this.log.info("获取截图", { tabId, fullPage, selector: cleanedSelector, workspacePath });

    try {
      let screenshotBuffer;
      
      if (cleanedSelector) {
        const element = await page.$(cleanedSelector);
        if (!element) {
          return { error: "element_not_found", selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined };
        }
        screenshotBuffer = await element.screenshot({ type: "jpeg", quality: 80 });
      } else {
        screenshotBuffer = await page.screenshot({
          fullPage,
          type: "jpeg",
          quality: 80
        });
      }

      // 确定保存路径
      let targetPath = workspacePath;
      if (!targetPath && ctx) {
        // 生成默认路径
        const title = await page.title();
        const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').slice(0, 50); // 简单清理文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        targetPath = `screenshot/${safeTitle}-${timestamp}.png`;
      }

      // 如果提供了 workspacePath 或自动生成了 targetPath，且有 ctx，则保存到工作区并返回 {files: [...]}
      // 这是智能体工具调用的场景
      if (targetPath && ctx) {
        const runtime = this.runtime;
        if (runtime) {
          const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
          if (workspaceId) {
            const ws = await getWorkspaceManager().getWorkspace(workspaceId);
            await ws.writeFile(targetPath, screenshotBuffer, {
              mimeType: "image/jpeg",
              operator: ctx.agent?.id,
              messageId: ctx.currentMessage?.id,
              meta: {
                source: "chrome-screenshot",
                url: page.url(),
                title: await page.title(),
                fullPage,
                selector: cleanedSelector || null
              }
            });
            return {
              ok: true,
              files: [{
                path: targetPath,
                mimeType: "image/jpeg"
              }],
              url: page.url(),
              title: await page.title(),
              fullPage,
              selector: cleanedSelector || null
            };
          }
          return { error: "workspace_not_found", message: "无法获取工作空间，截图保存失败" };
        }
        return { error: "runtime_not_found", message: "运行时不可用，截图保存失败" };
      }

      return { error: "screenshot_failed", message: "截图生成成功但无法保存：未提供工作区路径或上下文" };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "screenshot_failed", selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined, message };
    }
  }

  /**
    * 获取截图预览数据（供 Web 面板使用）
    * @param {string} tabId 
    * @returns {Promise<{ok: boolean, buffer: Buffer, mimeType: string} | {error: string, message: string}>}
    */
   async getScreenshotPreview(tabId) {
     const result = getPage(this.tabManager, tabId);
     if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
     
     const { page } = result;
 
     try {
       const screenshotBuffer = await page.screenshot({
         fullPage: false, // 预览通常只需要可视区域
         type: "jpeg",
         quality: 60 // 预览质量稍低以提高传输速度
       });
 
       return { 
         ok: true, 
         buffer: /** @type {Buffer} */(screenshotBuffer),
         mimeType: "image/jpeg"
       };
     } catch (err) {
       const message = err?.message ?? String(err);
       return { error: "preview_failed", message };
     }
   }

  async getText(tabId, selector, ctx) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));

    const { page } = result;

    // 清理选择器（如果提供）
    let cleanedSelector = selector;
    let originalSelector;
    let selectorModified = false;
    if (selector) {
      const sanitized = sanitizeSelector(selector);
      cleanedSelector = sanitized.cleaned;
      originalSelector = sanitized.original;
      selectorModified = sanitized.modified;
      if (selectorModified) {
        this.log.info("选择器已清理", { tabId, original: originalSelector, cleaned: cleanedSelector });
      }
    }

    try {
      let text;

      if (cleanedSelector) {
        const element = await page.$(cleanedSelector);
        if (!element) {
          return { error: "element_not_found", selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined };
        }
        text = await page.evaluate(el => /** @type {HTMLElement} */(el).innerText || el.textContent, element);
      } else {
        text = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
      }

      // 将文本保存到 .io/ 目录，避免大段文本占用 LLM 上下文
      const url = page.url();
      const hostname = new URL(url).hostname;
      const workspaceId = this.runtime.findWorkspaceIdForAgent(ctx.agent?.id);
      const ws = await getWorkspaceManager().getWorkspace(workspaceId);
      const ioResult = await ws.writeFileToIO("chrome", hostname, text, { mimeType: "text/plain" });
      return { ok: true, files: [{ path: ioResult.path, mimeType: ioResult.mimeType }], url, source: hostname };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "get_text_failed", selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined, message };
    }
  }

  async getElements(tabId, options = {}, ctx) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { types, maxElements = 1000 } = options;

    // 清理选择器（如果提供）
    let cleanedSelector = options.selector;
    let originalSelector;
    let selectorModified = false;
    if (options.selector) {
      const sanitized = sanitizeSelector(options.selector);
      cleanedSelector = sanitized.cleaned;
      originalSelector = sanitized.original;
      selectorModified = sanitized.modified;
      if (selectorModified) {
        this.log.info("选择器已清理", { tabId, original: originalSelector, cleaned: cleanedSelector });
      }
    }

    // 类型别名映射：查询某类型时自动包含相关类型
    const typeAliases = {
      input: ['input', 'textarea'],           // 输入类控件
      button: ['button'],                      // 按钮类
      link: ['link','a'],              // 链接类
      text: ['text','span','p','div'],                          // 文本类
      image: ['image','img'],                        // 图片类
      select: ['select', 'checkbox', 'radio','option'], // 选择类控件
      checkbox: ['checkbox'],
      radio: ['radio'],
      textarea: ['textarea']
    };

    // 展开类型别名
    let expandedTypes = types;
    if (types && types.length > 0) {
      const typeSet = new Set();
      for (const t of types) {
        const aliases = typeAliases[t] || [t];
        aliases.forEach(a => typeSet.add(a));
      }
      expandedTypes = Array.from(typeSet);
    }

    this.log.info("获取页面元素", { tabId, selector: cleanedSelector, types, expandedTypes, maxElements });

    try {
      const elements = await page.evaluate((opts) => {
        const { rootSelector, filterTypes, limit } = opts;
        
        // 获取根元素
        const root = rootSelector ? document.querySelector(rootSelector) : document.body;
        if (!root) return { error: "root_not_found" };

        const results = [];
        
        // 检查元素是否可见
        function isVisible(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        // 生成元素的唯一选择器
        function getSelector(el) {
          // 优先使用 id
          if (el.id) {
            return `#${CSS.escape(el.id)}`;
          }
          
          // 尝试使用 name 属性
          if (el.name) {
            const byName = document.querySelectorAll(`[name="${CSS.escape(el.name)}"]`);
            if (byName.length === 1) {
              return `[name="${el.name}"]`;
            }
          }
          
          // 使用标签名 + 类名 + nth-child
          let selector = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\s+/).filter(c => c && !c.includes(':'));
            if (classes.length > 0) {
              selector += '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');
            }
          }
          
          // 添加 nth-child 确保唯一性
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(el) + 1;
              selector += `:nth-child(${index})`;
            }
          }
          
          return selector;
        }

        // 获取元素的文本内容（截断）
        function getText(el, maxLen = 100) {
          const text = (el.innerText || el.textContent || '').trim();
          return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
        }

        // 获取元素位置信息
        function getPosition(el) {
          const rect = el.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }

        // 处理链接
        function processLinks() {
          if (filterTypes && !filterTypes.includes('link')) return;
          root.querySelectorAll('a[href]').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const linkEl = /** @type {HTMLAnchorElement} */(el);
            results.push({
              type: 'link',
              selector: getSelector(el),
              text: getText(el),
              href: linkEl.href,
              position: getPosition(el)
            });
          });
        }

        // 处理按钮
        function processButtons() {
          if (filterTypes && !filterTypes.includes('button')) return;
          // button 标签
          root.querySelectorAll('button').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const btnEl = /** @type {HTMLButtonElement} */(el);
            results.push({
              type: 'button',
              selector: getSelector(el),
              text: getText(el),
              disabled: btnEl.disabled,
              position: getPosition(el)
            });
          });
          // input[type=button/submit/reset]
          root.querySelectorAll('input[type="button"], input[type="submit"], input[type="reset"]').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const inputEl = /** @type {HTMLInputElement} */(el);
            results.push({
              type: 'button',
              selector: getSelector(el),
              text: inputEl.value || inputEl.placeholder || '',
              disabled: inputEl.disabled,
              position: getPosition(el)
            });
          });
          // role="button"
          root.querySelectorAll('[role="button"]').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            if (el.tagName === 'BUTTON') return; // 避免重复
            results.push({
              type: 'button',
              selector: getSelector(el),
              text: getText(/** @type {HTMLElement} */(el)),
              position: getPosition(el)
            });
          });
        }

        // 处理输入框
        function processInputs() {
          if (filterTypes && !filterTypes.includes('input')) return;
          root.querySelectorAll('input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const inputEl = /** @type {HTMLInputElement} */(el);
            results.push({
              type: 'input',
              selector: getSelector(el),
              inputType: inputEl.type || 'text',
              name: inputEl.name || null,
              placeholder: inputEl.placeholder || null,
              value: inputEl.type === 'password' ? '***' : (inputEl.value || null),
              disabled: inputEl.disabled,
              readonly: inputEl.readOnly,
              position: getPosition(el)
            });
          });
        }

        // 处理文本域
        function processTextareas() {
          if (filterTypes && !filterTypes.includes('textarea')) return;
          root.querySelectorAll('textarea').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const textareaEl = /** @type {HTMLTextAreaElement} */(el);
            results.push({
              type: 'textarea',
              selector: getSelector(el),
              name: textareaEl.name || null,
              placeholder: textareaEl.placeholder || null,
              value: getText(el, 200),
              disabled: textareaEl.disabled,
              readonly: textareaEl.readOnly,
              position: getPosition(el)
            });
          });
        }

        // 处理下拉框
        function processSelects() {
          if (filterTypes && !filterTypes.includes('select')) return;
          root.querySelectorAll('select').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const selectEl = /** @type {HTMLSelectElement} */(el);
            const options = Array.from(selectEl.options).map(opt => ({
              value: opt.value,
              text: opt.text,
              selected: opt.selected
            }));
            results.push({
              type: 'select',
              selector: getSelector(el),
              name: selectEl.name || null,
              options: options.slice(0, 20), // 限制选项数量
              selectedValue: selectEl.value,
              disabled: selectEl.disabled,
              position: getPosition(el)
            });
          });
        }

        // 处理复选框
        function processCheckboxes() {
          if (filterTypes && !filterTypes.includes('checkbox')) return;
          root.querySelectorAll('input[type="checkbox"]').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const checkboxEl = /** @type {HTMLInputElement} */(el);
            // 尝试获取关联的 label
            let label = '';
            if (checkboxEl.id) {
              const labelEl = document.querySelector(`label[for="${checkboxEl.id}"]`);
              if (labelEl) label = getText(labelEl);
            }
            if (!label && checkboxEl.parentElement?.tagName === 'LABEL') {
              label = getText(checkboxEl.parentElement);
            }
            results.push({
              type: 'checkbox',
              selector: getSelector(el),
              name: checkboxEl.name || null,
              label: label || null,
              checked: checkboxEl.checked,
              disabled: checkboxEl.disabled,
              position: getPosition(el)
            });
          });
        }

        // 处理单选框
        function processRadios() {
          if (filterTypes && !filterTypes.includes('radio')) return;
          root.querySelectorAll('input[type="radio"]').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const radioEl = /** @type {HTMLInputElement} */(el);
            let label = '';
            if (radioEl.id) {
              const labelEl = document.querySelector(`label[for="${radioEl.id}"]`);
              if (labelEl) label = getText(labelEl);
            }
            if (!label && radioEl.parentElement?.tagName === 'LABEL') {
              label = getText(radioEl.parentElement);
            }
            results.push({
              type: 'radio',
              selector: getSelector(el),
              name: radioEl.name || null,
              value: radioEl.value || null,
              label: label || null,
              checked: radioEl.checked,
              disabled: radioEl.disabled,
              position: getPosition(el)
            });
          });
        }

        // 处理图片
        function processImages() {
          if (filterTypes && !filterTypes.includes('image')) return;
          root.querySelectorAll('img').forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            const imgEl = /** @type {HTMLImageElement} */(el);
            results.push({
              type: 'image',
              selector: getSelector(el),
              src: imgEl.src,
              alt: imgEl.alt || null,
              position: getPosition(el)
            });
          });
        }

        // 处理文本块（标题、段落等）
        function processTexts() {
          if (filterTypes && !filterTypes.includes('text')) return;
          const textSelectors = 'h1, h2, h3, h4, h5, h6, p, span, div, li, td, th, label';
          root.querySelectorAll(textSelectors).forEach(el => {
            if (!isVisible(el) || results.length >= limit) return;
            // 只处理叶子节点或直接包含文本的元素
            const directText = Array.from(el.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => n.textContent.trim())
              .join(' ')
              .trim();
            if (!directText || directText.length < 2) return;
            // 避免重复（已经作为其他类型处理的元素）
            if (el.tagName === 'LABEL' && /** @type {HTMLLabelElement} */(el).htmlFor) return;
            results.push({
              type: 'text',
              selector: getSelector(el),
              tag: el.tagName.toLowerCase(),
              text: getText(el, 200),
              position: getPosition(el)
            });
          });
        }

        // 按优先级处理各类元素
        processButtons();
        processLinks();
        processInputs();
        processTextareas();
        processSelects();
        processCheckboxes();
        processRadios();
        processImages();
        processTexts();

        return results;
      }, {
        rootSelector: cleanedSelector,
        filterTypes: expandedTypes,
        limit: maxElements
      });

      if (elements && typeof elements === 'object' && 'error' in elements) {
        return { error: elements.error, selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined };
      }

      const elementsArray = /** @type {Array<any>} */(elements);

      // 将元素数据保存到 .io/ 目录，避免大段 JSON 占用 LLM 上下文
      const url = page.url();
      const hostname = new URL(url).hostname;
      const workspaceId = this.runtime.findWorkspaceIdForAgent(ctx.agent?.id);
      const ws = await getWorkspaceManager().getWorkspace(workspaceId);
      const json = JSON.stringify(elementsArray);
      const ioResult = await ws.writeFileToIO("chrome", hostname, json, { mimeType: "application/json" });
      return {
        ok: true,
        files: [{ path: ioResult.path, mimeType: ioResult.mimeType }],
        url,
        count: elementsArray.length,
        truncated: elementsArray.length >= maxElements,
        source: hostname
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "get_elements_failed", selector: cleanedSelector, originalSelector: selectorModified ? originalSelector : undefined, message };
    }
  }
}
