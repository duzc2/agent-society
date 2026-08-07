
import { sanitizeSelector, getPage, validateUrl } from "../utils.js";
import { getWorkspaceManager } from "../../../src/platform/services/workspace/workspace_manager.js";

/**
 * 资源管理模块
 * 负责页面资源的列出和保存
 */
export class ResourceFeature {
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
          name: "chrome_list_resources",
          description: "列出页面上的资源列表，包括图片、CSS、JavaScript、视频、音频等。主要用于分析页面资源或批量保存资源。返回资源的URL、类型、尺寸等信息。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              types: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["image", "background", "css", "script", "video", "audio"]
                },
                description: "要获取的资源类型。可选值：image(图片), background(背景图), css(样式表), script(脚本), video(视频), audio(音频)。默认只获取 image"
              },
              includeDataUrls: {
                type: "boolean",
                description: "是否包含 data URL（base64编码的内嵌资源）。默认为 false"
              }
            },
            required: ["tabId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "chrome_save_resource",
          description: "保存页面上的资源（如图片）到工作区，返回保存后的路径数组。支持一次性保存多个资源。适用于需要持久化保存页面资源的场景。注意：每个保存的资源都需要有意义的名称。",
          parameters: {
            type: "object",
            properties: {
              tabId: { type: "string", description: "标签页 ID" },
              resources: {
                type: "array",
                description: "要保存的资源列表。通常从 chrome_list_resources 的结果中获取。",
                items: { 
                  type: "object",
                  properties: {
                    url: { type: "string", description: "资源的 URL 或 data URL。必须提供。" },
                    name: { type: "string", description: "保存的文件名。如果不包含后缀，会自动根据资源类型补全。必须提供。" }
                  },
                  required: ["url", "name"]
                }
              },
              workspacePath: { type: "string", description: "保存到工作区的子目录路径。默认为 'downloads'。" },
              type: { type: "string", description: "资源类型分类（用于元数据）。默认为 'image'。" }
            },
            required: ["tabId", "resources"]
          }
        }
      }
    ];
  }

  async handleToolCall(toolName, args, ctx) {
    switch (toolName) {
      case "chrome_list_resources":
        return await this.listResources(args.tabId, args);
      case "chrome_save_resource":
        return await this.saveResource(args.tabId, args.resources, { ...args, ctx });
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async listResources(tabId, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { types = ['image'], includeDataUrls = false } = options;

    this.log.info("获取页面资源", { tabId, types, includeDataUrls });

    try {
      const resources = await page.evaluate((opts) => {
        const { resourceTypes, includeData } = opts;
        const results = [];

        // 获取图片资源
        if (resourceTypes.includes('image')) {
          document.querySelectorAll('img').forEach((img, index) => {
            const imgEl = /** @type {HTMLImageElement} */(img);
            const src = imgEl.src || imgEl.dataset.src;
            if (!src) return;
            
            // 过滤 data URL（如果不需要）
            if (!includeData && src.startsWith('data:')) return;
            
            const rect = imgEl.getBoundingClientRect();
            results.push({
              type: 'image',
              index,
              src,
              alt: imgEl.alt || '',
              width: imgEl.naturalWidth || rect.width,
              height: imgEl.naturalHeight || rect.height,
              visible: rect.width > 0 && rect.height > 0,
              selector: imgEl.id ? `#${imgEl.id}` : `img:nth-of-type(${index + 1})`
            });
          });
        }

        // 获取背景图片
        if (resourceTypes.includes('background')) {
          document.querySelectorAll('*').forEach((el, index) => {
            const style = window.getComputedStyle(el);
            const bgImage = style.backgroundImage;
            if (bgImage && bgImage !== 'none') {
              const urlMatch = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
              if (urlMatch && urlMatch[1]) {
                const url = urlMatch[1];
                if (!includeData && url.startsWith('data:')) return;
                
                results.push({
                  type: 'background',
                  index,
                  src: url,
                  element: el.tagName.toLowerCase(),
                  selector: el.id ? `#${el.id}` : null
                });
              }
            }
          });
        }

        // 获取CSS资源
        if (resourceTypes.includes('css')) {
          document.querySelectorAll('link[rel="stylesheet"]').forEach((link, index) => {
            const linkEl = /** @type {HTMLLinkElement} */(link);
            results.push({
              type: 'css',
              index,
              src: linkEl.href,
              media: linkEl.media || 'all'
            });
          });
        }

        // 获取JavaScript资源
        if (resourceTypes.includes('script')) {
          document.querySelectorAll('script[src]').forEach((script, index) => {
            const scriptEl = /** @type {HTMLScriptElement} */(script);
            results.push({
              type: 'script',
              index,
              src: scriptEl.src,
              async: scriptEl.async,
              defer: scriptEl.defer
            });
          });
        }

        // 获取视频资源
        if (resourceTypes.includes('video')) {
          document.querySelectorAll('video').forEach((video, index) => {
            const videoEl = /** @type {HTMLVideoElement} */(video);
            const sources = Array.from(videoEl.querySelectorAll('source')).map(s => ({
              src: s.src,
              type: s.type
            }));
            
            results.push({
              type: 'video',
              index,
              src: videoEl.src || (sources.length > 0 ? sources[0].src : ''),
              sources,
              poster: videoEl.poster || null,
              selector: videoEl.id ? `#${videoEl.id}` : `video:nth-of-type(${index + 1})`
            });
          });
        }

        // 获取音频资源
        if (resourceTypes.includes('audio')) {
          document.querySelectorAll('audio').forEach((audio, index) => {
            const audioEl = /** @type {HTMLAudioElement} */(audio);
            const sources = Array.from(audioEl.querySelectorAll('source')).map(s => ({
              src: s.src,
              type: s.type
            }));
            
            results.push({
              type: 'audio',
              index,
              src: audioEl.src || (sources.length > 0 ? sources[0].src : ''),
              sources,
              selector: audioEl.id ? `#${audioEl.id}` : `audio:nth-of-type(${index + 1})`
            });
          });
        }

        return results;
      }, {
        resourceTypes: types,
        includeData: includeDataUrls
      });

      return {
        ok: true,
        resources,
        count: resources.length,
        url: page.url()
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      return { error: "get_resources_failed", message };
    }
  }

  async saveResource(tabId, resources, options = {}) {
    const result = getPage(this.tabManager, tabId);
    if ("error" in result) return /** @type {{error:string, message:string}} */(/** @type {unknown} */(result));
    
    const { page } = result;
    const { ctx, type = 'image', workspacePath = 'downloads' } = options;

    // 统一处理为数组
    const resourceArray = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    
    if (resourceArray.length === 0) {
      return { error: "empty_resources", message: "资源列表不能为空" };
    }

    // 验证所有资源都有 url 和 name
    for (let i = 0; i < resourceArray.length; i++) {
      const res = resourceArray[i];
      if (!res.url || typeof res.url !== 'string') {
        return { error: "invalid_resource_url", message: `资源[${i}]的 URL 不能为空` };
      }
      if (!res.name || typeof res.name !== 'string' || res.name.trim() === '') {
        return { error: "invalid_resource_name", message: `资源[${i}]的名称不能为空` };
      }
    }

    this.log.info("保存页面资源", { tabId, count: resourceArray.length, type, workspacePath });

    // 统计成功和失败数量
    const savedFiles = [];
    const errors = [];

    // 获取工作区
    let ws = null;
    if (ctx && this.runtime) {
      const workspaceId = this.runtime.findWorkspaceIdForAgent(ctx.agent?.id);
      if (workspaceId) {
        ws = await getWorkspaceManager().getWorkspace(workspaceId);
      }
    }

    if (!ws) {
      return { error: "workspace_not_found", message: "无法获取工作空间，请确保智能体已分配工作空间" };
    }

    // 用于网络资源下载的临时页面，确保使用浏览器的 Cookie 和 Session
    let tempPage = null;

    try {
      // 逐个处理资源
      for (let i = 0; i < resourceArray.length; i++) {
        const { url: resourceUrl, name: resourceName } = resourceArray[i];
        
        try {
          // 获取资源内容
          let buffer;
          let mimeType = null;
          
          if (resourceUrl.startsWith('data:')) {
            // 处理 data URL
            const matches = resourceUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (!matches) {
              errors.push({
                index: i,
                resourceUrl,
                error: "invalid_data_url"
              });
              savedFiles.push(null);
              continue;
            }
            mimeType = matches[1];
            buffer = Buffer.from(matches[2], 'base64');
          } else {
            // 使用浏览器导航方式下载资源，确保 Cookie 和 Session 一致，并绕过 CORS 限制
            if (!tempPage) {
              const browserContext = page.browserContext();
              tempPage = await browserContext.newPage();
            }
            
            this.log.info("通过浏览器下载资源", { index: i, url: resourceUrl });

            // 验证 URL 安全性
            const urlCheck = validateUrl(resourceUrl);
            if (!urlCheck.valid) {
              errors.push({
                index: i,
                resourceUrl,
                error: urlCheck.error,
                message: urlCheck.message
              });
              savedFiles.push(null);
              continue;
            }

            // 导航到资源 URL
            const response = await tempPage.goto(resourceUrl, {
                waitUntil: 'load', 
                timeout: 30000 
            });

            if (!response || !response.ok()) {
              errors.push({
                index: i,
                resourceUrl,
                error: "fetch_resource_failed",
                message: response ? `HTTP ${response.status()}` : "无响应"
              });
              savedFiles.push(null);
              continue;
            }

            buffer = await response.buffer();
            mimeType = response.headers()['content-type'];
          }

          // 确定文件后缀
          let ext = 'png';
          if (mimeType) {
            if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
            else if (mimeType.includes('gif')) ext = 'gif';
            else if (mimeType.includes('webp')) ext = 'webp';
            else if (mimeType.includes('png')) ext = 'png';
            else if (mimeType.includes('svg')) ext = 'svg';
          } else {
            if (resourceUrl.includes('.jpg') || resourceUrl.includes('.jpeg')) {
              ext = 'jpg';
            } else if (resourceUrl.includes('.gif')) {
              ext = 'gif';
            } else if (resourceUrl.includes('.webp')) {
              ext = 'webp';
            }
          }

          // 构建保存路径
          let finalPath = resourceName;
          if (!finalPath.includes('.')) {
            finalPath += `.${ext}`;
          }
          
          // 如果提供了 workspacePath，则作为目录
          const fullPath = workspacePath ? 
            (workspacePath.endsWith('/') ? `${workspacePath}${finalPath}` : `${workspacePath}/${finalPath}`) : 
            finalPath;

          // 保存到工作区
          await ws.writeFile(fullPath, buffer, {
            mimeType,
            operator: ctx?.agent?.id,
            messageId: ctx?.currentMessage?.id,
            meta: {
              source: "chrome-save-resource",
              url: resourceUrl,
              type
            }
          });
          savedFiles.push({ path: fullPath, mimeType });

        } catch (err) {
          const message = err?.message ?? String(err);
          this.log.error("保存资源失败", { index: i, resourceUrl, resourceName, error: message });
          errors.push({
            index: i,
            resourceUrl,
            resourceName,
            error: "save_resource_failed",
            message
          });
          savedFiles.push(null);
        }
      }
    } finally {
      // 确保关闭临时页面
      if (tempPage) {
        await tempPage.close().catch(() => {});
      }
    }

    // 统计成功和失败数量
    const successCount = savedFiles.filter(f => f !== null).length;
    const failureCount = errors.length;

    // 构建文件信息数组
    const allFiles = savedFiles.filter(f => f !== null);

    // 限制返回的文件数量，避免 token 爆炸（最大返回 10 个）
    const maxReturnedFiles = 10;
    const files = allFiles.slice(0, maxReturnedFiles);
    const remainingFiles = Math.max(0, allFiles.length - maxReturnedFiles);

    return {
      ok: true,
      files,
      remainingFiles, // 告知还有多少个未列出
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors : undefined,
      totalCount: resourceArray.length
    };
  }
}
