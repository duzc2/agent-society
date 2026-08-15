import path from "node:path";
import { registry } from "../../../core/module_registry.js";

const BASE = "/api/workspaces/file-access";

/**
 * 从 Hono 请求中读取 JSON body；非法 JSON 返回空对象，由具体路由做必填校验。
 * @param {import('hono').Context} c
 * @returns {Promise<object>}
 */
async function readBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/**
 * 校验必填字符串参数，缺失时返回 { valid: false, response }。
 * @param {object} body
 * @param {string} key
 */
function requireString(body, key) {
  if (typeof body?.[key] !== "string" || body[key].trim() === "") {
    return {
      valid: false,
      response: {
        error: "invalid_params",
        message: `缺少必填参数 ${key}`
      }
    };
  }
  return { valid: true, value: body[key].trim() };
}

/**
 * 注册工作区文件访问管理 HTTP 路由。
 * 替代旧 localfile 模块的管理 API。
 *
 * @param {{ app: import('hono').Hono, log: any, society: any, workspaceFileAccessService: any }} deps
 */
export function registerWorkspaceFileAccessRoutes({
  app,
  log,
  society,
  workspaceFileAccessService
}) {
  const configManager = workspaceFileAccessService.externalConfigManager;
  const permissionManager = workspaceFileAccessService.externalPermissionManager;
  const accessLogger = workspaceFileAccessService.externalAccessLogger;

  // GET /folders — 全局授权文件夹列表
  app.get(`${BASE}/folders`, (c) => {
    try {
      return c.json({ ok: true, folders: configManager.getFolders() });
    } catch (err) {
      void log.error("工作区文件访问：获取文件夹列表失败", {
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "list_folders_failed", message: err.message }, 500);
    }
  });

  // POST /folders — 添加全局授权文件夹
  app.post(`${BASE}/folders`, async (c) => {
    const body = await readBody(c);
    const pathCheck = requireString(body, "path");
    if (!pathCheck.valid) return c.json(pathCheck.response, 400);

    try {
      const result = await configManager.addFolder({
        path: pathCheck.value,
        read: body.read !== false,
        write: Boolean(body.write),
        description: body.description ?? ""
      });
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：添加文件夹失败", {
        path: body.path,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "add_folder_failed", message: err.message }, 500);
    }
  });

  // PUT /folders/:folderId — 更新全局授权文件夹
  app.put(`${BASE}/folders/:folderId`, async (c) => {
    const folderId = c.req.param("folderId");
    const body = await readBody(c);

    try {
      const result = await configManager.updateFolder(folderId, {
        read: body.read,
        write: body.write,
        description: body.description
      });
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：更新文件夹失败", {
        folderId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "update_folder_failed", message: err.message }, 500);
    }
  });

  // DELETE /folders/:folderId — 删除全局授权文件夹
  app.delete(`${BASE}/folders/:folderId`, async (c) => {
    const folderId = c.req.param("folderId");

    try {
      const result = await configManager.removeFolder(folderId);
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：删除文件夹失败", {
        folderId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "delete_folder_failed", message: err.message }, 500);
    }
  });

  // GET /logs — 查询访问日志
  app.get(`${BASE}/logs`, async (c) => {
    const url = new URL(c.req.url, "http://localhost");
    const query = {
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
      operation: url.searchParams.get("operation") || undefined,
      agentId: url.searchParams.get("agentId") || undefined,
      orgId: url.searchParams.get("orgId") || undefined,
      startTime: url.searchParams.get("startTime") || undefined,
      endTime: url.searchParams.get("endTime") || undefined
    };

    try {
      const result = await accessLogger.queryLogs(query);
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：查询日志失败", {
        query,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "query_logs_failed", message: err.message }, 500);
    }
  });

  // GET /stats — 访问统计
  app.get(`${BASE}/stats`, async (c) => {
    const url = new URL(c.req.url, "http://localhost");
    const range = {
      startTime: url.searchParams.get("startTime") || undefined,
      endTime: url.searchParams.get("endTime") || undefined
    };

    try {
      return c.json({ ok: true, stats: await accessLogger.getStats(range) });
    } catch (err) {
      void log.error("工作区文件访问：获取统计失败", {
        range,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "get_stats_failed", message: err.message }, 500);
    }
  });

  // GET /settings/retention — 获取全局日志保留天数
  app.get(`${BASE}/settings/retention`, (c) => {
    try {
      return c.json({ ok: true, logRetentionDays: configManager.getLogRetentionDays() });
    } catch (err) {
      void log.error("工作区文件访问：获取保留天数失败", {
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "get_retention_failed", message: err.message }, 500);
    }
  });

  // PUT /settings/retention — 更新全局日志保留天数
  app.put(`${BASE}/settings/retention`, async (c) => {
    const body = await readBody(c);

    try {
      const result = await configManager.setLogRetentionDays(body.days);
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：更新保留天数失败", {
        days: body.days,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "update_retention_failed", message: err.message }, 500);
    }
  });

  // GET /orgs — 从组织运行时构建可选组织列表
  app.get(`${BASE}/orgs`, (c) => {
    try {
      if (!society?.runtime?.org) {
        return c.json({ error: "org_runtime_unavailable", message: "组织运行时不可用" }, 500);
      }

      const runtime = society.runtime;
      const allAgents = runtime.org.listAgents();
      if (!Array.isArray(allAgents)) {
        return c.json({ ok: true, orgs: [] });
      }

      const orgConfigMap = new Map();
      for (const orgConfig of configManager.getAllOrgConfigs()) {
        orgConfigMap.set(orgConfig.orgId, orgConfig);
      }

      const orgs = [];
      for (const agent of allAgents) {
        if (!agent) continue;
        if (agent.parentAgentId !== "root" || agent.status === "deleted") continue;
        const orgConfig = orgConfigMap.get(agent.id);
        orgs.push({
          orgId: agent.id,
          orgName: runtime.org.getOrgName(agent.id) || agent.name || agent.id,
          firstAgentName: agent.name,
          hasConfig: Boolean(orgConfig),
          folderCount: orgConfig?.config?.folders?.length ?? 0
        });
      }

      return c.json({ ok: true, orgs });
    } catch (err) {
      void log.error("工作区文件访问：获取组织列表失败", {
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "list_orgs_failed", message: err.message }, 500);
    }
  });

  // GET /org-configs — 获取所有组织配置
  app.get(`${BASE}/org-configs`, (c) => {
    try {
      return c.json({ ok: true, orgConfigs: configManager.getAllOrgConfigs() });
    } catch (err) {
      void log.error("工作区文件访问：获取组织配置失败", {
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "list_org_configs_failed", message: err.message }, 500);
    }
  });

  // DELETE /org-configs/:orgId — 移除组织配置
  app.delete(`${BASE}/org-configs/:orgId`, async (c) => {
    const orgId = c.req.param("orgId");

    try {
      return c.json(await configManager.removeOrgConfig(orgId));
    } catch (err) {
      void log.error("工作区文件访问：移除组织配置失败", {
        orgId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "remove_org_config_failed", message: err.message }, 500);
    }
  });

  // GET /org-configs/:orgId/folders — 获取组织有效文件夹
  app.get(`${BASE}/org-configs/:orgId/folders`, (c) => {
    const orgId = c.req.param("orgId");
    try {
      return c.json({ ok: true, folders: configManager.getEffectiveFolders(orgId) });
    } catch (err) {
      void log.error("工作区文件访问：获取组织文件夹失败", {
        orgId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "get_org_folders_failed", message: err.message }, 500);
    }
  });

  // POST /org-configs/:orgId/folders — 为组织添加文件夹
  app.post(`${BASE}/org-configs/:orgId/folders`, async (c) => {
    const orgId = c.req.param("orgId");
    const body = await readBody(c);
    const pathCheck = requireString(body, "path");
    if (!pathCheck.valid) return c.json(pathCheck.response, 400);

    try {
      const result = await configManager.addFolderToOrg(orgId, {
        path: pathCheck.value,
        read: body.read !== false,
        write: Boolean(body.write),
        description: body.description ?? ""
      });
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：添加组织文件夹失败", {
        orgId,
        path: body.path,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "add_org_folder_failed", message: err.message }, 500);
    }
  });

  // PUT /org-configs/:orgId/folders/:folderId — 更新组织文件夹
  app.put(`${BASE}/org-configs/:orgId/folders/:folderId`, async (c) => {
    const orgId = c.req.param("orgId");
    const folderId = c.req.param("folderId");
    const body = await readBody(c);

    try {
      const result = await configManager.updateFolderInOrg(orgId, folderId, {
        read: body.read,
        write: body.write,
        description: body.description
      });
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：更新组织文件夹失败", {
        orgId,
        folderId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "update_org_folder_failed", message: err.message }, 500);
    }
  });

  // DELETE /org-configs/:orgId/folders/:folderId — 删除组织文件夹
  app.delete(`${BASE}/org-configs/:orgId/folders/:folderId`, async (c) => {
    const orgId = c.req.param("orgId");
    const folderId = c.req.param("folderId");

    try {
      const result = await configManager.removeFolderFromOrg(orgId, folderId);
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：删除组织文件夹失败", {
        orgId,
        folderId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "delete_org_folder_failed", message: err.message }, 500);
    }
  });

  // GET /org-configs/:orgId/settings/retention — 获取组织有效保留天数
  app.get(`${BASE}/org-configs/:orgId/settings/retention`, (c) => {
    const orgId = c.req.param("orgId");
    try {
      return c.json({
        ok: true,
        logRetentionDays: configManager.getEffectiveLogRetentionDays(orgId)
      });
    } catch (err) {
      void log.error("工作区文件访问：获取组织保留天数失败", {
        orgId,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "get_org_retention_failed", message: err.message }, 500);
    }
  });

  // PUT /org-configs/:orgId/settings/retention — 更新组织日志保留天数
  app.put(`${BASE}/org-configs/:orgId/settings/retention`, async (c) => {
    const orgId = c.req.param("orgId");
    const body = await readBody(c);

    try {
      const result = await configManager.setLogRetentionDaysForOrg(orgId, body.days);
      return c.json(result);
    } catch (err) {
      void log.error("工作区文件访问：更新组织保留天数失败", {
        orgId,
        days: body.days,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "update_org_retention_failed", message: err.message }, 500);
    }
  });

  // POST /check-path — 测试路径是否存在及权限
  app.post(`${BASE}/check-path`, async (c) => {
    const body = await readBody(c);
    const pathCheck = requireString(body, "path");
    if (!pathCheck.valid) return c.json(pathCheck.response, 400);

    const targetPath = pathCheck.value;
    try {
      const normalizedPath = permissionManager._normalizePath(targetPath);
      const permission = await permissionManager.getPermissionInfo(normalizedPath);
      const exists = await permissionManager.pathExists(normalizedPath);
      const isDirectory = exists ? await permissionManager.isDirectory(normalizedPath) : false;

      // 该接口用于“文件权限设置”面板在添加授权前测试路径，
      // 因此必须探测路径是否存在，而不是只返回当前授权范围内的状态。
      return c.json({
        ok: true,
        path: targetPath,
        exists,
        isDirectory,
        canRead: permission.canRead,
        canWrite: permission.canWrite,
        folder: permission.folder ?? null
      });
    } catch (err) {
      void log.error("工作区文件访问：检查路径失败", {
        path: targetPath,
        error: err.message,
        stack: err.stack
      });
      return c.json({ error: "check_path_failed", message: err.message }, 500);
    }
  });
}

registry.declare({
  name: "workspace-file-access-routes",
  requires: ["app", "log", "society", "workspaceFileAccessService"],
  provides: [],
  async init(deps) {
    registerWorkspaceFileAccessRoutes(deps);
    return {};
  }
});
