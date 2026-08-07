import { registry } from "../../../core/module_registry.js";

/**
 * 注册配置相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, configService: any, log: any, llmStatus: string, llmLastError: any, moduleLoader: any, toolGroupManager: any }} deps
 */
function registerConfigRoutes({ app, configService, log, llmStatus, llmLastError, moduleLoader, toolGroupManager }) {

  app.get('/api/config/status', (c) => {
    try {
            const hasLocalConfig = configService.hasLocalApp();
      return c.json({
        hasLocalConfig,
        llmStatus: llmStatus,
        lastError: llmLastError
      });
    } catch (err) {
      void log.error("获取配置状态失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.get('/api/config/llm', async (c) => {
        try {
      const result = await configService.getLlm();
      const maskedLlm = {
        ...result.llm,
        apiKey: configService.maskApiKey(result.llm.apiKey)
      };
      return c.json({ llm: maskedLlm, source: result.source });
    } catch (err) {
      void log.error("获取 LLM 配置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/llm', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const validation = configService.validateLlm(body);
      if (!validation.valid) {
        return c.json({ error: "validation_error", details: validation.errors }, 400);
      }
      const saved = await configService.saveLlm(body);
      void log.info("LLM 配置已保存");
      return c.json({ ok: true, llm: saved });
    } catch (err) {
      void log.error("保存 LLM 配置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/llm/set-default', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.serviceId !== "string" || !body.serviceId.trim()) {
      return c.json({ error: "invalid_service_id", message: "serviceId 不能为空" }, 400);
    }
    try {
      const saved = await configService.setDefaultLlmFromService(body.serviceId);
      void log.info("已将服务设为默认 LLM 配置", { serviceId: body.serviceId });
      return c.json({ ok: true, llm: saved });
    } catch (err) {
      void log.error("设为默认 LLM 失败", { error: err.message, stack: err.stack, serviceId: body.serviceId });
      if (err.message && err.message.includes("不存在")) {
        return c.json({ error: "not_found", message: err.message }, 404);
      }
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.get('/api/config/modules', async (c) => {
        try {
      const result = await configService.getModules();
      const loadedModules = moduleLoader?.getLoadedModules?.() ?? [];
      const loadedModuleMap = new Map(loadedModules.map(m => [m.name, m]));
      const defaultModules = result.defaultModules && typeof result.defaultModules === "object" ? result.defaultModules : {};
      const modules = result.modules && typeof result.modules === "object" ? result.modules : {};

      // catalog 从 defaultModules（modules.json 的完整目录）迭代
      const catalog = Object.keys(defaultModules).map(moduleName => {
        const loaded = loadedModuleMap.get(moduleName);
        return {
          name: moduleName,
          enabled: Object.prototype.hasOwnProperty.call(modules, moduleName),
          config: defaultModules[moduleName] ?? {},
          defaultConfig: defaultModules[moduleName] ?? {},
          hasWebComponent: !!loaded?.hasWebComponent,
          hasHttpHandler: !!loaded?.hasHttpHandler,
          toolCount: loaded?.toolCount ?? 0,
          toolGroupId: loaded?.toolGroupId ?? moduleName,
          toolGroupDescription: loaded?.toolGroupDescription ?? ""
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      return c.json({
        modules: result.modules,
        source: result.source,
        catalog,
        enableAll: result.enableAll,
        enabled: result.enabled
      });
    } catch (err) {
      void log.error("获取模块配置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/modules', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const enableAll = body?.enableAll;
      const enabled = body?.enabled;
      if (enableAll !== false && enableAll !== true) {
        return c.json({ error: "validation_error", message: "enableAll 必须是布尔值" }, 400);
      }
      if (enableAll === false && !Array.isArray(enabled)) {
        return c.json({ error: "validation_error", message: "enableAll 为 false 时 enabled 必须是数组" }, 400);
      }
      await configService.saveModules({ enableAll, enabled });
      void log.info("模块配置已保存", { enableAll, count: enabled?.length ?? 0 });
      return c.json({ ok: true, enableAll, enabled });
    } catch (saveErr) {
      void log.error("保存模块配置失败", { error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "internal_error", message: saveErr.message }, 500);
    }
  });

  app.get('/api/config/modules/:name', async (c) => {
    const moduleName = decodeURIComponent(c.req.param('name'));
        try {
      const config = await configService.getModuleConfig(moduleName);
      const entry = configService._moduleConfigs.get(moduleName);
      const defaults = entry?.defaults ?? {};
      return c.json({ moduleName, config, defaults });
    } catch (err) {
      void log.error("获取模块配置失败", { moduleName, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/modules/:name', async (c) => {
    const moduleName = decodeURIComponent(c.req.param('name'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const merged = await configService.saveModuleConfig(moduleName, body);
      void log.info("模块配置已保存", { moduleName });
      return c.json({ ok: true, moduleName, config: merged });
    } catch (saveErr) {
      void log.error("保存模块配置失败", { moduleName, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "internal_error", message: saveErr.message }, 500);
    }
  });

  app.get('/api/config/app-settings', async (c) => {
        try {
      const result = await configService.getAppSettings();
      return c.json(result);
    } catch (err) {
      void log.error("获取应用设置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/app-settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const settings = body?.settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        return c.json({ error: "validation_error", message: "settings 必须是对象" }, 400);
      }
      await configService.saveAppSettings(settings);
      return c.json({ ok: true });
    } catch (saveErr) {
      void log.error("保存应用设置失败", { error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "internal_error", message: saveErr.message }, 500);
    }
  });

  app.get('/api/config/llm-services', async (c) => {
        try {
      const result = await configService.getServices();
      const maskedServices = result.services.map(s => ({
        ...s,
        apiKey: configService.maskApiKey(s.apiKey)
      }));
      return c.json({ services: maskedServices, source: result.source });
    } catch (err) {
      void log.error("获取 LLM 服务配置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/llm-services', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const validation = configService.validateService(body);
      if (!validation.valid) {
        return c.json({ error: "validation_error", details: validation.errors }, 400);
      }
      const service = await configService.addService(body);
      void log.info("LLM 服务已添加", { serviceId: body.id });
      return c.json({ ok: true, service });
    } catch (err) {
      if (err.message && err.message.includes("已存在")) {
        return c.json({ error: "duplicate_id", message: err.message }, 409);
      }
      void log.error("添加 LLM 服务失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/llm-services/:serviceId', async (c) => {
    const serviceId = decodeURIComponent(c.req.param('serviceId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const validation = configService.validateService(body);
      if (!validation.valid) {
        void log.warn("LLM 服务配置校验失败", { errors: validation.errors });
        return c.json({ error: "validation_error", details: validation.errors, message: JSON.stringify(validation.errors) }, 400);
      }
      const service = await configService.updateService(serviceId, body);
      void log.info("LLM 服务已更新", { serviceId });
      return c.json({ ok: true, service });
    } catch (err) {
      if (err.message && err.message.includes("不存在")) {
        return c.json({ error: "not_found", message: err.message }, 404);
      }
      void log.error("更新 LLM 服务失败", { serviceId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.delete('/api/config/llm-services/:serviceId', async (c) => {
    const serviceId = decodeURIComponent(c.req.param('serviceId'));
        try {
      await configService.deleteService(serviceId);
      void log.info("LLM 服务已删除", { serviceId });
      return c.json({ ok: true, deletedId: serviceId });
    } catch (err) {
      if (err.message && err.message.includes("不存在")) {
        return c.json({ error: "not_found", message: err.message }, 404);
      }
      void log.error("删除 LLM 服务失败", { serviceId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.get('/api/config/chat', async (c) => {
        try {
      const result = await configService.getChatConfig();
      return c.json(result);
    } catch (err) {
      void log.error("获取聊天配置失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  app.post('/api/config/chat', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
        try {
      const fontSize = typeof body?.fontSize === "number" ? body.fontSize : undefined;
      if (fontSize === undefined) {
        return c.json({ error: "validation_error", message: "fontSize 必须为数字" }, 400);
      }
      if (fontSize < 12 || fontSize > 24) {
        return c.json({ error: "validation_error", message: "fontSize 必须在 12-24 之间" }, 400);
      }
      await configService.saveChatConfig({ fontSize });
      void log.info("聊天配置已保存", { fontSize });
      return c.json({ ok: true, fontSize });
    } catch (saveErr) {
      void log.error("保存聊天配置失败", { error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "internal_error", message: saveErr.message }, 500);
    }
  });

  app.get('/api/tool-groups', (c) => {
    try {
      const mgr = toolGroupManager;
      if (!mgr) {
        return c.json({ error: "tool_group_manager_not_initialized" }, 500);
      }
      const groups = mgr.listGroups();
      void log.debug("HTTP查询工具组列表", { count: groups.length });
      return c.json({ toolGroups: groups, count: groups.length });
    } catch (err) {
      void log.error("查询工具组列表失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'config-routes',
  requires: ['app', 'log', 'configService', 'llmStatus', 'llmLastError', 'moduleLoader', 'toolGroupManager'],
  provides: [],
  async init(deps) { registerConfigRoutes(deps); return {}; }
});
