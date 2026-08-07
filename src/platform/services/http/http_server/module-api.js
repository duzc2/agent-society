import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readJsonBody, sendJson } from "./utilities.js";
import { registry } from "../../../core/module_registry.js";

let log = null;

/**
 * 注册模块 API 的 Hono 路由（可直接处理的端点）。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, logRoot: any, moduleLoader: any }} deps
 */
function registerModuleApiRoutes({ app, logRoot, moduleLoader }) {
  log = logRoot.forModule('module-api');

  // GET /api/modules — 列出所有已加载模块
  app.get('/api/modules', (c) => {
    if (!moduleLoader) {
      return c.json({ error: "modules_not_initialized" }, 500);
    }
    const modules = moduleLoader.getLoadedModules();
    return c.json({ ok: true, modules, count: modules.length });
  });

  // GET /api/modules/:name — 获取指定模块详情
  app.get('/api/modules/:name', (c) => {
    const moduleName = c.req.param('name');
    if (!moduleLoader) {
      return c.json({ error: "modules_not_initialized" }, 500);
    }
    const modules = moduleLoader.getLoadedModules();
    const moduleInfo = modules.find(m => m.name === moduleName);
    if (!moduleInfo) {
      return c.json({ error: "module_not_found", moduleName }, 404);
    }
    return c.json({ ok: true, module: moduleInfo });
  });

  // GET /api/modules/:name/web-component — 获取模块的 Web 组件定义
  app.get('/api/modules/:name/web-component', async (c) => {
    const moduleName = c.req.param('name');
    if (!moduleLoader) {
      return c.json({ error: "modules_not_initialized" }, 500);
    }
    const components = moduleLoader.getWebComponents();
    const component = components.find(c => c.moduleName === moduleName);
    if (!component) {
      return c.json({ error: "web_component_not_found", moduleName }, 404);
    }

    const componentDef = component.component;
    if (componentDef.panelPath) {
      try {
        const panelDir = path.dirname(componentDef.panelPath);
        const baseName = path.basename(componentDef.panelPath, '.html');

        let html = '', css = '', js = '';

        const htmlPath = path.join(process.cwd(), componentDef.panelPath);
        const cssPath = path.join(process.cwd(), panelDir, `${baseName}.css`);
        const jsPath = path.join(process.cwd(), panelDir, `${baseName}.js`);

        if (existsSync(htmlPath)) {
          const htmlContent = await readFile(htmlPath, 'utf8');
          const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          html = bodyMatch ? bodyMatch[1].trim() : htmlContent;
        }

        if (existsSync(cssPath)) {
          css = await readFile(cssPath, 'utf8');
        }

        if (existsSync(jsPath)) {
          js = await readFile(jsPath, 'utf8');
        }

        return c.json({
          ok: true,
          html,
          css,
          js,
          moduleName: componentDef.moduleName,
          displayName: componentDef.displayName,
          icon: componentDef.icon
        });
      } catch (err) {
        void log.error("读取模块 Web 组件文件失败", {
          moduleName,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
        return c.json({ error: "read_component_failed", message: err.message }, 500);
      }
    }

    return c.json({ ok: true, component: componentDef });
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'module-api-routes',
  requires: ['app', 'logRoot', 'moduleLoader'],
  provides: [],
  async init(deps) { registerModuleApiRoutes(deps); return {}; }
});

// ============================================================
// 以下 _handleModuleApi 保留给旧 router 的回退处理
// 用于模块 HTTP handler 的路由分发（需要原始 req/res 对象）
// ============================================================

/**
 * 处理模块 API 请求（回退端点：路由到模块的 HTTP 处理器）。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} method
 * @param {string} pathname
 * @param {any} society
 */
export async function _handleModuleApi(req, res, method, pathname, society) {
  // 检查 runtime 是否可用
  if (!society || !society.runtime || !society.runtime.moduleLoader) {
    sendJson(res, 500, { error: "modules_not_initialized" });
    return;
  }

  const moduleLoader = society.runtime.moduleLoader;

  // 解析路径: /api/modules/:name/...
  const pathParts = pathname.slice("/api/modules".length).split("/").filter(Boolean);

  // 如果路径是 /api/modules 或 /api/modules/:name 或 /api/modules/:name/web-component
  // 已经被 Hono 路由处理，此处作为回退不应该到达，但保留以策安全
  if (pathParts.length === 0) {
    sendJson(res, 404, { error: "not_found", path: pathname });
    return;
  }

  const moduleName = pathParts[0];
  const subPath = pathParts.slice(1);

  if (subPath.length === 1 && subPath[0] === "web-component") {
    sendJson(res, 404, { error: "not_found", path: pathname });
    return;
  }

  // 路由到模块的 HTTP 处理器
  await moduleLoader.ensureModuleInitialized(moduleName);

  const httpHandler = moduleLoader.getModuleHttpHandler(moduleName);
  if (!httpHandler) {
    sendJson(res, 404, { error: "module_http_handler_not_found", moduleName });
    return;
  }

  try {
    // 对于 POST 请求，读取请求体
    let body = null;
    if (method === "POST") {
      body = await new Promise((resolve, reject) => {
        readJsonBody(req, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
    }

    // 调用模块的 HTTP 处理器
    void log.info('[HTTP Server] 正在调用模块处理器:', { moduleName, subPath, method });
    const result = await httpHandler(req, res, subPath, body);
    void log.info('[HTTP Server] 模块处理器结果:', { moduleName, result });

    // 如果模块已经直接处理了响应（如返回 HTML），则不再发送 JSON
    if (result?.handled) {
      void log.info('[HTTP Server] 模块已直接处理响应');
      return;
    }

    sendJson(res, 200, result);
  } catch (err) {
    const message = err?.message ?? String(err);
    void log.error("模块 HTTP 处理器错误", {
      moduleName,
      subPath,
      method,
      error: message,
      stack: err?.stack,
      name: err?.name,
      code: err?.code
    });
    sendJson(res, 500, { error: "module_handler_error", moduleName, message });
  }
}
