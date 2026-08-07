import { registry } from "../../../core/module_registry.js";
import { openPathInFileManager } from "../../../utils/process/open_in_file_manager.js";

/**
 * 归一化技能绑定请求体。
 */
function normalizeSkillBindings(bindings) {
  if (!Array.isArray(bindings)) {
    return null;
  }
  return bindings
    .filter((item) => typeof item?.skillId === "string")
    .map((item) => ({
      skillId: item.skillId.trim(),
      enabled: item.enabled !== false
    }))
    .filter((item) => item.skillId);
}

/**
 * 注册技能相关的 Hono 路由（内部实现，由 registry.init 调用）。
 * @param {{ app: import('hono').Hono, skillsService: any, customSkillService: any, gitSkillService: any, log: any }} deps
 */
function registerSkillRoutes({ app, skillsService, customSkillService, gitSkillService, log }) {

  // --- Skills (catalog / install / uninstall) ---

  app.get('/api/skills', async (c) => {
    const query = c.req.query('q') ?? '';
    const skills = await skillsService.listCatalog({ query });
    return c.json({ skills, count: skills.length });
  });

  app.get('/api/skills/runtime', async (c) => {
    const runtimeInfo = await skillsService.getRuntimeInfo();
    return c.json(runtimeInfo);
  });

  app.post('/api/skills/install', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await skillsService.installSkill({
        providerId: body?.providerId,
        externalId: body?.externalId,
        installUrl: body?.installUrl
      });
      return c.json({ ok: true, skill });
    } catch (installErr) {
      void log.error("安装技能失败", { error: installErr?.message, stack: installErr?.stack });
      return c.json({ error: "install_skill_failed", message: installErr?.message ?? String(installErr) }, 500);
    }
  });

  app.post('/api/skills/uninstall', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    const skillId = typeof body?.skillId === "string" ? body.skillId.trim() : "";
    if (!skillId) {
      return c.json({ error: "missing_skill_id", message: "skillId 不能为空" }, 400);
    }
    try {
      const skill = await skillsService.uninstallSkill(skillId);
      if (!skill) {
        return c.json({ error: "skill_not_found", message: "技能不存在" }, 404);
      }
      return c.json({ ok: true, skill });
    } catch (uninstallErr) {
      void log.error("卸载技能失败", { error: uninstallErr?.message, stack: uninstallErr?.stack });
      return c.json({ error: "uninstall_skill_failed", message: uninstallErr?.message ?? String(uninstallErr) }, 500);
    }
  });

  app.get('/api/skills/:skillId', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const overview = await skillsService.getSkillOverview(skillId);
    if (!overview) {
      return c.json({ error: "skill_not_found", message: "技能不存在" }, 404);
    }
    return c.json(overview);
  });

  app.get('/api/skills/:skillId/content', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const content = await skillsService.getSkillContent(skillId);
    if (!content) {
      return c.json({ error: "skill_not_found", message: "技能不存在" }, 404);
    }
    return c.json(content);
  });

  // --- Role / Agent skill bindings ---

  app.get('/api/role/:roleId/skills', async (c) => {
    const roleId = decodeURIComponent(c.req.param('roleId'));
    const view = await skillsService.getRoleSkillBindingsView(roleId);
    return c.json(view);
  });

  app.put('/api/role/:roleId/skills', async (c) => {
    const roleId = decodeURIComponent(c.req.param('roleId'));
    if (roleId === "root" || roleId === "user") {
      return c.json({ error: "cannot_modify_system_role", message: "不能修改系统岗位的技能配置" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    const bindings = normalizeSkillBindings(body?.bindings);
    if (bindings === null) {
      return c.json({ error: "invalid_bindings", message: "bindings 必须是数组" }, 400);
    }
    const view = await skillsService.setRoleSkillBindings(roleId, bindings);
    if (!view) {
      return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
    }
    return c.json({ ok: true, ...view });
  });

  app.get('/api/agent/:agentId/skills', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    const view = await skillsService.getAgentSkillBindingsView(agentId);
    return c.json(view);
  });

  app.put('/api/agent/:agentId/skills', async (c) => {
    const agentId = decodeURIComponent(c.req.param('agentId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    const bindings = normalizeSkillBindings(body?.bindings);
    if (bindings === null) {
      return c.json({ error: "invalid_bindings", message: "bindings 必须是数组" }, 400);
    }
    const view = await skillsService.setAgentSkillBindings(agentId, bindings);
    if (!view) {
      return c.json({ error: "agent_not_found", message: "智能体不存在" }, 404);
    }
    return c.json({ ok: true, ...view });
  });

  // --- Custom Skills ---

  app.get('/api/custom-skills', async (c) => {
    const skills = await customSkillService.listCustomSkills();
    return c.json({ skills, count: skills.length });
  });

  app.post('/api/custom-skills', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const result = await customSkillService.createCustomSkill({
        displayName: body?.displayName
      });
      return c.json({ ok: true, ...result });
    } catch (createError) {
      return c.json({ error: "create_custom_skill_failed", message: createError?.message ?? String(createError) }, 500);
    }
  });

  app.post('/api/custom-skills/copy', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const result = await customSkillService.copySkillAsCustom({
        sourceSkillId: body?.sourceSkillId,
        displayName: body?.displayName
      });
      return c.json({ ok: true, ...result });
    } catch (copyError) {
      const statusCode = copyError?.message === "source_skill_not_found" ? 404 : 500;
      return c.json({ error: "copy_custom_skill_failed", message: copyError?.message ?? String(copyError) }, statusCode);
    }
  });

  app.get('/api/custom-skills/:skillId', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const skill = await customSkillService.getCustomSkill(skillId);
    if (!skill) {
      return c.json({ error: "custom_skill_not_found", message: "自定义技能不存在" }, 404);
    }
    return c.json(skill);
  });

  app.delete('/api/custom-skills/:skillId', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const deleted = await customSkillService.deleteCustomSkill(skillId);
    if (!deleted) {
      return c.json({ error: "custom_skill_not_found", message: "自定义技能不存在" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get('/api/custom-skills/:skillId/tree', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const tree = await customSkillService.getCustomSkillTree(skillId);
    if (!tree) {
      return c.json({ error: "custom_skill_not_found", message: "自定义技能不存在" }, 404);
    }
    return c.json({ skillId, tree });
  });

  app.get('/api/custom-skills/:skillId/file', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const filePath = c.req.query('path') ?? '';
    const file = await customSkillService.readCustomSkillFile(skillId, filePath);
    if (!file) {
      return c.json({ error: "custom_skill_file_not_found", message: "文件不存在" }, 404);
    }
    return c.json(file);
  });

  app.post('/api/custom-skills/:skillId/file', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await customSkillService.createCustomSkillFile(skillId, body?.path);
      return c.json({ ok: true, skill });
    } catch (createError) {
      const statusCode = createError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "create_custom_skill_file_failed", message: createError?.message ?? String(createError) }, statusCode);
    }
  });

  app.put('/api/custom-skills/:skillId/file', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await customSkillService.writeCustomSkillFile(skillId, body?.path, body?.content ?? "");
      return c.json({ ok: true, skill });
    } catch (writeError) {
      const statusCode = writeError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "write_custom_skill_file_failed", message: writeError?.message ?? String(writeError) }, statusCode);
    }
  });

  app.post('/api/custom-skills/:skillId/folder', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await customSkillService.createCustomSkillFolder(skillId, body?.path);
      return c.json({ ok: true, skill });
    } catch (createError) {
      const statusCode = createError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "create_custom_skill_folder_failed", message: createError?.message ?? String(createError) }, statusCode);
    }
  });

  app.delete('/api/custom-skills/:skillId/entry', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const entryPath = c.req.query('path') ?? '';
    try {
      const skill = await customSkillService.deleteCustomSkillEntry(skillId, entryPath);
      return c.json({ ok: true, skill });
    } catch (deleteError) {
      const statusCode = deleteError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "delete_custom_skill_entry_failed", message: deleteError?.message ?? String(deleteError) }, statusCode);
    }
  });

  app.post('/api/custom-skills/:skillId/entry/rename', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await customSkillService.renameCustomSkillEntry(skillId, body?.fromPath, body?.toPath);
      return c.json({ ok: true, skill });
    } catch (renameError) {
      const statusCode = renameError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "rename_custom_skill_entry_failed", message: renameError?.message ?? String(renameError) }, statusCode);
    }
  });

  app.post('/api/custom-skills/:skillId/status', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const skill = await customSkillService.setCustomSkillStatus(skillId, body?.status);
      return c.json({ ok: true, skill });
    } catch (statusError) {
      const statusCode = statusError?.message === "custom_skill_not_found" ? 404 : 400;
      return c.json({ error: "set_custom_skill_status_failed", message: statusError?.message ?? String(statusError) }, statusCode);
    }
  });

  app.post('/api/custom-skills/:skillId/open', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const record = await customSkillService._getCustomSkillRecord(skillId);
      if (!record) {
        return c.json({ error: "custom_skill_not_found", message: "自定义技能不存在" }, 404);
      }
      const relativePath = typeof body?.path === "string" ? body.path : "";
      const targetPath = customSkillService.repository.getSkillDir(record.customSkillId);
      await openPathInFileManager(targetPath);
      void log.info("HTTP调用文件管理器打开自定义技能目录", { skillId, customSkillId: record.customSkillId, targetPath });
      return c.json({
        ok: true,
        skillId,
        customSkillId: record.customSkillId,
        path: relativePath,
        targetPath
      });
    } catch (openError) {
      void log.error("打开自定义技能目录失败", {
        skillId,
        path: body?.path,
        error: openError?.message,
        stack: openError?.stack
      });
      const isMissingPath = openError?.code === "ENOENT";
      const statusCode = isMissingPath ? 404 : 500;
      const message = isMissingPath ? "技能目录不存在" : "打开系统文件管理器失败";
      return c.json({
        error: isMissingPath ? "directory_not_found" : "open_file_manager_failed",
        message
      }, statusCode);
    }
  });

  // --- Git Skills ---

  app.get('/api/git-skills', async (c) => {
    const skills = await gitSkillService.listGitSkills();
    return c.json({ skills, count: skills.length });
  });

  app.post('/api/git-skills/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    try {
      const result = await gitSkillService.importFromGit(body || {});
      return c.json(result);
    } catch (importError) {
      const message = importError?.message || "导入失败";
      if (message.includes("already_exists")) {
        return c.json({ error: "git_skill_already_exists", message: "该 git 地址已导入过" }, 409);
      } else if (message.includes("missing_git_url")) {
        return c.json({ error: "missing_git_url", message: "缺少 git 地址" }, 400);
      } else if (message.includes("skill_md_not_found")) {
        return c.json({ error: "git_skill_md_not_found", message: "仓库中未找到 SKILL.md 文件" }, 400);
      } else if (message.includes("subdir_not_found")) {
        return c.json({ error: "git_subdir_not_found", message: "指定的子目录不存在" }, 400);
      } else {
        return c.json({ error: "git_import_failed", message }, 500);
      }
    }
  });

  app.get('/api/git-skills/:skillId', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const result = await gitSkillService.getGitSkill(skillId);
    if (!result) {
      return c.json({ error: "git_skill_not_found", message: "Git 技能不存在" }, 404);
    }
    return c.json(result);
  });

  app.delete('/api/git-skills/:skillId', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const deleted = await gitSkillService.deleteGitSkill(skillId);
    if (!deleted) {
      return c.json({ error: "git_skill_not_found", message: "Git 技能不存在" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/api/git-skills/:skillId/update', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    try {
      const record = await gitSkillService.updateGitSkill(skillId);
      return c.json({ skill: record });
    } catch (updateError) {
      void log.error("更新Git技能失败", { skillId, error: updateError?.message ?? String(updateError), stack: updateError?.stack });
      return c.json({ error: "git_update_failed", message: updateError?.message || "更新失败" }, 500);
    }
  });

  app.get('/api/git-skills/:skillId/file', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const filePath = c.req.query('path') ?? 'SKILL.md';
    try {
      const file = await gitSkillService.readGitSkillFile(skillId, filePath);
      if (!file) {
        return c.json({ error: "file_not_found" }, 404);
      }
      return c.json(file);
    } catch (readError) {
      return c.json({ error: "read_failed", message: readError?.message || "读取失败" }, 500);
    }
  });

  app.post('/api/git-skills/:skillId/status', async (c) => {
    const skillId = decodeURIComponent(c.req.param('skillId'));
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json", message: "请求体 JSON 解析失败" }, 400);
    }
    const status = body?.status;
    if (status !== "enabled" && status !== "disabled") {
      return c.json({ error: "invalid_status", message: "状态必须为 enabled 或 disabled" }, 400);
    }
    try {
      const record = await gitSkillService.setGitSkillStatus(skillId, status);
      return c.json({ skill: record });
    } catch (statusError) {
      return c.json({ error: "status_update_failed", message: statusError?.message || "更新状态失败" }, 500);
    }
  });
}

// 声明式注册到模块系统：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'skill-routes',
  requires: ['app', 'skillsService', 'customSkillService', 'gitSkillService', 'log'],
  provides: [],
  async init(deps) { registerSkillRoutes(deps); return {}; }
});
