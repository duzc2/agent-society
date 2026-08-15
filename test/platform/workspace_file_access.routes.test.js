/**
 * 工作区文件访问 — HTTP 管理路由测试
 *
 * 覆盖 /api/workspaces/file-access/* 的：
 *   - 全局文件夹 CRUD
 *   - 日志查询与统计
 *   - 保留天数设置
 *   - 组织列表、组织配置、组织文件夹 CRUD
 *   - check-path 路径检查
 */

import { Hono } from "hono";
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerWorkspaceFileAccessRoutes } from "../../src/platform/services/workspace/file_access/routes.js";
import { makeTestLogger } from "../helpers/test_logger.js";

function makeFakeService() {
  const calls = [];

  const configManager = {
    getFolders: () => [{ id: "folder-1", path: "/authorized", read: true, write: false }],
    addFolder: async input => {
      calls.push(["addFolder", input]);
      return { ok: true, folder: { id: "folder-2", ...input } };
    },
    updateFolder: async (folderId, input) => {
      calls.push(["updateFolder", folderId, input]);
      return { ok: true, folder: { id: folderId, ...input } };
    },
    removeFolder: async folderId => {
      calls.push(["removeFolder", folderId]);
      return { ok: true };
    },
    getLogRetentionDays: () => 30,
    setLogRetentionDays: async days => {
      calls.push(["setLogRetentionDays", days]);
      return { ok: true };
    },
    getAllOrgConfigs: () => [{ orgId: "org-1", config: { folders: [] } }],
    removeOrgConfig: async orgId => {
      calls.push(["removeOrgConfig", orgId]);
      return { ok: true };
    },
    getEffectiveFolders: orgId => {
      calls.push(["getEffectiveFolders", orgId]);
      return [{ id: "folder-1", path: "/authorized", _source: "global" }];
    },
    addFolderToOrg: async (orgId, input) => {
      calls.push(["addFolderToOrg", orgId, input]);
      return { ok: true, folder: { id: "org-folder", ...input } };
    },
    updateFolderInOrg: async (orgId, folderId, input) => {
      calls.push(["updateFolderInOrg", orgId, folderId, input]);
      return { ok: true, folder: { id: folderId, ...input } };
    },
    removeFolderFromOrg: async (orgId, folderId) => {
      calls.push(["removeFolderFromOrg", orgId, folderId]);
      return { ok: true };
    },
    getEffectiveLogRetentionDays: orgId => {
      calls.push(["getEffectiveLogRetentionDays", orgId]);
      return 30;
    },
    setLogRetentionDaysForOrg: async (orgId, days) => {
      calls.push(["setLogRetentionDaysForOrg", orgId, days]);
      return { ok: true };
    }
  };

  const permissionManager = {
    _normalizePath: p => {
      calls.push(["_normalizePath", p]);
      return p;
    },
    getPermissionInfo: async p => {
      calls.push(["getPermissionInfo", p]);
      return { canRead: true, canWrite: false, folder: { id: "folder-1", path: p } };
    },
    pathExists: async p => {
      calls.push(["pathExists", p]);
      return true;
    },
    isDirectory: async p => {
      calls.push(["isDirectory", p]);
      return false;
    }
  };

  const accessLogger = {
    queryLogs: async query => {
      calls.push(["queryLogs", query]);
      return { total: 0, logs: [], query };
    },
    getStats: async range => {
      calls.push(["getStats", range]);
      return { total: 0, range };
    }
  };

  return {
    service: {
      externalConfigManager: configManager,
      externalPermissionManager: permissionManager,
      externalAccessLogger: accessLogger
    },
    calls
  };
}

function createApp(service, society = { runtime: { org: { listAgents: () => [], getOrgName: () => "" } } }) {
  const app = new Hono();
  registerWorkspaceFileAccessRoutes({
    app,
    log: makeTestLogger("workspace-file-access-routes"),
    society,
    workspaceFileAccessService: service
  });
  return app;
}

async function request(app, method, path, body) {
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await app.request(path, options);
  const json = await res.json();
  return { res, json };
}

describe("WorkspaceFileAccess 路由 — 全局文件夹", () => {
  it("GET /folders 返回文件夹列表", async () => {
    const { service } = makeFakeService();
    const app = createApp(service);
    const { res, json } = await request(app, "GET", "/api/workspaces/file-access/folders");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.folders.length, 1);
    assert.strictEqual(json.folders[0].id, "folder-1");
  });

  it("POST /folders 缺少 path 返回 400，有效 path 调用 addFolder", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const invalid = await request(app, "POST", "/api/workspaces/file-access/folders", { write: true });
    assert.strictEqual(invalid.res.status, 400);
    assert.strictEqual(invalid.json.error, "invalid_params");

    const valid = await request(app, "POST", "/api/workspaces/file-access/folders", {
      path: "/authorized",
      read: true,
      write: true,
      description: "docs"
    });
    assert.strictEqual(valid.res.status, 200);
    assert.strictEqual(valid.json.ok, true);
    assert.deepStrictEqual(calls.find(c => c[0] === "addFolder")[1], {
      path: "/authorized",
      read: true,
      write: true,
      description: "docs"
    });
  });

  it("PUT/DELETE /folders/:folderId 调用 updateFolder/removeFolder", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const updated = await request(app, "PUT", "/api/workspaces/file-access/folders/folder-1", {
      read: false,
      write: true,
      description: "updated"
    });
    assert.strictEqual(updated.res.status, 200);
    assert.strictEqual(updated.json.ok, true);

    const deleted = await request(app, "DELETE", "/api/workspaces/file-access/folders/folder-1");
    assert.strictEqual(deleted.res.status, 200);
    assert.strictEqual(deleted.json.ok, true);

    assert.strictEqual(calls.some(c => c[0] === "updateFolder" && c[1] === "folder-1"), true);
    assert.strictEqual(calls.some(c => c[0] === "removeFolder" && c[1] === "folder-1"), true);
  });
});

describe("WorkspaceFileAccess 路由 — 日志、统计、保留天数", () => {
  it("GET /logs 正确解析查询参数并调用 queryLogs", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const { res, json } = await request(
      app,
      "GET",
      "/api/workspaces/file-access/logs?limit=20&offset=5&operation=read&agentId=agent-1"
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.total, 0);
    const query = calls.find(c => c[0] === "queryLogs")[1];
    assert.strictEqual(query.limit, 20);
    assert.strictEqual(query.offset, 5);
    assert.strictEqual(query.operation, "read");
    assert.strictEqual(query.agentId, "agent-1");
  });

  it("GET /stats 调用 getStats", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const { res, json } = await request(app, "GET", "/api/workspaces/file-access/stats");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.stats.total, 0);
    assert.strictEqual(calls.some(c => c[0] === "getStats"), true);
  });

  it("GET/PUT /settings/retention 调用 get/set 保留天数", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const getRetention = await request(app, "GET", "/api/workspaces/file-access/settings/retention");
    assert.strictEqual(getRetention.res.status, 200);
    assert.strictEqual(getRetention.json.logRetentionDays, 30);

    const putRetention = await request(app, "PUT", "/api/workspaces/file-access/settings/retention", { days: 45 });
    assert.strictEqual(putRetention.res.status, 200);
    assert.strictEqual(calls.some(c => c[0] === "setLogRetentionDays" && c[1] === 45), true);
  });
});

describe("WorkspaceFileAccess 路由 — 组织配置", () => {
  it("GET /orgs 构建组织列表", async () => {
    const { service } = makeFakeService();
    const society = {
      runtime: {
        org: {
          listAgents: () => [
            { id: "org-1", parentAgentId: "root", status: "active", name: "First Agent" }
          ],
          getOrgName: () => "Org One"
        }
      }
    };
    const app = createApp(service, society);

    const { res, json } = await request(app, "GET", "/api/workspaces/file-access/orgs");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.orgs.length, 1);
    assert.strictEqual(json.orgs[0].orgId, "org-1");
    assert.strictEqual(json.orgs[0].orgName, "Org One");
    assert.strictEqual(json.orgs[0].hasConfig, true);
  });

  it("GET/DELETE /org-configs 和 org 文件夹 CRUD", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const getConfigs = await request(app, "GET", "/api/workspaces/file-access/org-configs");
    assert.strictEqual(getConfigs.res.status, 200);
    assert.strictEqual(getConfigs.json.orgConfigs.length, 1);

    const deleteConfig = await request(app, "DELETE", "/api/workspaces/file-access/org-configs/org-1");
    assert.strictEqual(deleteConfig.res.status, 200);
    assert.strictEqual(calls.some(c => c[0] === "removeOrgConfig" && c[1] === "org-1"), true);

    const getFolders = await request(app, "GET", "/api/workspaces/file-access/org-configs/org-1/folders");
    assert.strictEqual(getFolders.res.status, 200);
    assert.strictEqual(getFolders.json.folders.length, 1);

    const addFolder = await request(app, "POST", "/api/workspaces/file-access/org-configs/org-1/folders", {
      path: "/org-dir",
      read: true,
      write: true,
      description: "org"
    });
    assert.strictEqual(addFolder.res.status, 200);
    assert.strictEqual(addFolder.json.ok, true);

    const updateFolder = await request(
      app,
      "PUT",
      "/api/workspaces/file-access/org-configs/org-1/folders/org-folder",
      { read: false, write: true, description: "updated" }
    );
    assert.strictEqual(updateFolder.res.status, 200);
    assert.strictEqual(updateFolder.json.ok, true);

    const deleteFolder = await request(
      app,
      "DELETE",
      "/api/workspaces/file-access/org-configs/org-1/folders/org-folder"
    );
    assert.strictEqual(deleteFolder.res.status, 200);
    assert.strictEqual(deleteFolder.json.ok, true);

    assert.strictEqual(calls.some(c => c[0] === "getEffectiveFolders" && c[1] === "org-1"), true);
    assert.strictEqual(calls.some(c => c[0] === "addFolderToOrg" && c[1] === "org-1"), true);
    assert.strictEqual(calls.some(c => c[0] === "updateFolderInOrg" && c[1] === "org-1"), true);
    assert.strictEqual(calls.some(c => c[0] === "removeFolderFromOrg" && c[1] === "org-1"), true);
  });

  it("org 保留天数 GET/PUT", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const getRetention = await request(
      app,
      "GET",
      "/api/workspaces/file-access/org-configs/org-1/settings/retention"
    );
    assert.strictEqual(getRetention.res.status, 200);
    assert.strictEqual(getRetention.json.logRetentionDays, 30);

    const putRetention = await request(
      app,
      "PUT",
      "/api/workspaces/file-access/org-configs/org-1/settings/retention",
      { days: 15 }
    );
    assert.strictEqual(putRetention.res.status, 200);
    assert.strictEqual(calls.some(c => c[0] === "setLogRetentionDaysForOrg" && c[1] === "org-1" && c[2] === 15), true);
  });
});

describe("WorkspaceFileAccess 路由 — check-path", () => {
  it("POST /check-path 缺少 path 返回 400，有效 path 返回权限信息", async () => {
    const { service, calls } = makeFakeService();
    const app = createApp(service);

    const invalid = await request(app, "POST", "/api/workspaces/file-access/check-path", {});
    assert.strictEqual(invalid.res.status, 400);
    assert.strictEqual(invalid.json.error, "invalid_params");

    const valid = await request(app, "POST", "/api/workspaces/file-access/check-path", { path: "/authorized" });
    assert.strictEqual(valid.res.status, 200);
    assert.strictEqual(valid.json.ok, true);
    assert.strictEqual(valid.json.exists, true);
    assert.strictEqual(valid.json.isDirectory, false);
    assert.strictEqual(valid.json.canRead, true);
    assert.strictEqual(valid.json.canWrite, false);
    assert.strictEqual(calls.some(c => c[0] === "_normalizePath" && c[1] === "/authorized"), true);
  });

  it("POST /check-path 未配置路径仍会测试是否存在及类型", async () => {
    const { service } = makeFakeService();
    service.externalPermissionManager.getPermissionInfo = async () => ({
      canRead: false,
      canWrite: false
    });

    const app = createApp(service);
    const response = await request(app, "POST", "/api/workspaces/file-access/check-path", { path: "/secret" });

    assert.strictEqual(response.res.status, 200);
    assert.strictEqual(response.json.ok, true);
    assert.strictEqual(response.json.canRead, false);
    assert.strictEqual(response.json.canWrite, false);
    assert.strictEqual(response.json.exists, true);
    assert.strictEqual(response.json.isDirectory, false);
  });
});
