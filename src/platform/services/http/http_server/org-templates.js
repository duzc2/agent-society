import { registry } from "../../../core/module_registry.js";

/**
 * 注册组织模板相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, log: any, orgTemplatesSystem: any }} deps
 */
function registerOrgTemplateRoutes({ app, log, orgTemplatesSystem }) {

  function checkTemplates(c) {
    if (!orgTemplatesSystem) {
      return c.json({ error: "org_templates_not_initialized" }, 500);
    }
    return null;
  }

  // GET /api/org-templates — 列出所有模板
  app.get('/api/org-templates', async (c) => {
    const err = checkTemplates(c);
    if (err) return err;
    const templates = await orgTemplatesSystem.listTemplateInfos();
    return c.json({ templates, count: templates.length });
  });

  // POST /api/org-templates — 创建模板
  app.post('/api/org-templates', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    const orgName = body?.orgName;
    if (!orgName || typeof orgName !== "string") {
      return c.json({ error: "missing_org_name", message: "请求体必须包含 orgName 字段" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      const result = await orgTemplatesSystem.createTemplate(orgName);
      return c.json(result);
    } catch (createErr) {
      if (createErr?.code === "EEXIST") {
        return c.json({ error: "already_exists", message: "组织模板已存在" }, 409);
      }
      if (createErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "invalid_org_name", message: createErr.message }, 400);
      }
      void log.error("创建组织模板失败", { orgName, error: createErr.message, stack: createErr.stack });
      return c.json({ error: "create_failed", message: createErr.message }, 500);
    }
  });

  // POST /api/org-templates/:orgName/rename — 重命名模板
  app.post('/api/org-templates/:orgName/rename', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    const newOrgName = body?.newOrgName;
    if (!newOrgName || typeof newOrgName !== "string") {
      return c.json({ error: "missing_new_org_name", message: "请求体必须包含 newOrgName 字段" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      const result = await orgTemplatesSystem.renameTemplate(orgName, newOrgName);
      return c.json(result);
    } catch (renameErr) {
      if (renameErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "invalid_org_name", message: renameErr.message }, 400);
      }
      if (renameErr?.code === "ENOENT") {
        return c.json({ error: "not_found", orgName }, 404);
      }
      if (renameErr?.code === "EEXIST" || renameErr?.code === "ENOTEMPTY") {
        return c.json({ error: "already_exists", message: "目标组织模板已存在" }, 409);
      }
      if (renameErr?.code === "CANNOT_RENAME_BUILTIN") {
        return c.json({ error: "cannot_rename_builtin", message: "不能对内置模板重命名" }, 400);
      }
      void log.error("重命名组织模板失败", { orgName, newOrgName, error: renameErr.message, stack: renameErr.stack });
      return c.json({ error: "rename_failed", message: renameErr.message }, 500);
    }
  });

  // DELETE /api/org-templates/:orgName — 删除模板
  app.delete('/api/org-templates/:orgName', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    if (!orgName || typeof orgName !== "string") {
      return c.json({ error: "missing_org_name" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      await orgTemplatesSystem.deleteTemplate(orgName);
      return c.json({ ok: true, orgName });
    } catch (deleteErr) {
      if (deleteErr?.code === "ENOENT" || deleteErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "not_found", orgName }, 404);
      }
      if (deleteErr?.code === "CANNOT_DELETE_BUILTIN") {
        return c.json({ error: "cannot_delete_builtin", message: "不能删除内置模板" }, 400);
      }
      void log.error("删除组织模板失败", { orgName, error: deleteErr.message, stack: deleteErr.stack });
      return c.json({ error: "delete_failed", message: deleteErr.message }, 500);
    }
  });

  // GET /api/org-templates/:orgName/info — 读取 info.md
  app.get('/api/org-templates/:orgName/info', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    if (!orgName || typeof orgName !== "string") {
      return c.json({ error: "missing_org_name" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      const infoMd = await orgTemplatesSystem.readInfo(orgName);
      return c.json({ orgName, infoMd });
    } catch (readErr) {
      if (readErr?.code === "ENOENT" || readErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "not_found", orgName }, 404);
      }
      void log.error("读取组织模板 info.md 失败", { orgName, error: readErr.message, stack: readErr.stack });
      return c.json({ error: "read_failed", message: readErr.message }, 500);
    }
  });

  // PUT /api/org-templates/:orgName/info — 更新 info.md
  app.put('/api/org-templates/:orgName/info', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    const content = body?.content ?? body?.infoMd;
    if (content === undefined || typeof content !== "string") {
      return c.json({ error: "invalid_content", message: "content 必须是字符串" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      await orgTemplatesSystem.readInfo(orgName);
    } catch (readErr) {
      if (readErr?.code === "ENOENT" || readErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "not_found", orgName }, 404);
      }
    }
    try {
      await orgTemplatesSystem.writeInfo(orgName, content);
      return c.json({ ok: true, orgName });
    } catch (saveErr) {
      if (saveErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "invalid_org_name", message: saveErr.message }, 400);
      }
      void log.error("更新组织模板 info.md 失败", { orgName, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "update_failed", message: saveErr.message }, 500);
    }
  });

  // GET /api/org-templates/:orgName/org — 读取 org.md
  app.get('/api/org-templates/:orgName/org', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    if (!orgName || typeof orgName !== "string") {
      return c.json({ error: "missing_org_name" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      const orgMd = await orgTemplatesSystem.readOrg(orgName);
      return c.json({ orgName, orgMd });
    } catch (readErr) {
      if (readErr?.code === "ENOENT" || readErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "not_found", orgName }, 404);
      }
      void log.error("读取组织模板 org.md 失败", { orgName, error: readErr.message, stack: readErr.stack });
      return c.json({ error: "read_failed", message: readErr.message }, 500);
    }
  });

  // PUT /api/org-templates/:orgName/org — 更新 org.md
  app.put('/api/org-templates/:orgName/org', async (c) => {
    const orgName = decodeURIComponent(c.req.param('orgName'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    const content = body?.content ?? body?.orgMd;
    if (content === undefined || typeof content !== "string") {
      return c.json({ error: "invalid_content", message: "content 必须是字符串" }, 400);
    }
    const err = checkTemplates(c);
    if (err) return err;
    try {
      await orgTemplatesSystem.readOrg(orgName);
    } catch (readErr) {
      if (readErr?.code === "ENOENT" || readErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "not_found", orgName }, 404);
      }
    }
    try {
      await orgTemplatesSystem.writeOrg(orgName, content);
      return c.json({ ok: true, orgName });
    } catch (saveErr) {
      if (saveErr?.code === "INVALID_ORG_NAME") {
        return c.json({ error: "invalid_org_name", message: saveErr.message }, 400);
      }
      void log.error("更新组织模板 org.md 失败", { orgName, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "update_failed", message: saveErr.message }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'org-template-routes',
  requires: ['app', 'log', 'orgTemplatesSystem'],
  provides: [],
  async init(deps) { registerOrgTemplateRoutes(deps); return {}; }
});
