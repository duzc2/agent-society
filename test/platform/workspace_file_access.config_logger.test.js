/**
 * 工作区文件访问 — 配置管理器与访问日志记录器直接测试
 *
 * 覆盖：
 *   - ExternalConfigManager 全局/组织文件夹 CRUD
 *   - getEffectiveFolders 继承、覆盖、org override 组合
 *   - 日志保留天数全局/组织配置
 *   - ExternalAccessLogger 写入、查询、文件加载、清理、统计
 */

import { describe, it, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import { makeTestLogger } from "../helpers/test_logger.js";
import { Config } from "../../src/platform/utils/config/config.js";
import { ExternalConfigManager } from "../../src/platform/services/workspace/file_access/external_config_manager.js";
import { ExternalAccessLogger } from "../../src/platform/services/workspace/file_access/external_access_logger.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-config-logger-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

function makeConfigManager(configDir) {
  const configService = new Config(configDir, makeTestLogger("config"));
  const manager = new ExternalConfigManager({
    configService,
    log: makeTestLogger("external-config")
  });
  return { configService, manager };
}

describe("ExternalConfigManager CRUD", () => {
  it("addFolder / getFolder / updateFolder / removeFolder 完整链路", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const folderDir = await makeTempDir();
    const added = await manager.addFolder({
      path: folderDir,
      read: true,
      write: false,
      description: "docs"
    });
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.folder.path, path.resolve(folderDir));
    assert.strictEqual(added.folder.read, true);
    assert.strictEqual(added.folder.write, false);
    assert.strictEqual(manager.getFolders().length, 1);

    const folder = manager.getFolder(added.folder.id);
    assert.ok(folder);
    assert.strictEqual(folder.id, added.folder.id);

    const updated = await manager.updateFolder(added.folder.id, {
      read: false,
      write: true,
      description: "updated"
    });
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.folder.read, false);
    assert.strictEqual(updated.folder.write, true);
    assert.strictEqual(updated.folder.description, "updated");

    const removed = await manager.removeFolder(added.folder.id);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(manager.getFolders().length, 0);
  });

  it("addFolder 拒绝空路径、重复路径和不可访问路径", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const invalid = await manager.addFolder({ path: "" });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error, "invalid_path");

    const folderDir = await makeTempDir();
    const added = await manager.addFolder({ path: folderDir });
    assert.strictEqual(added.ok, true);

    const duplicate = await manager.addFolder({ path: folderDir });
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(duplicate.error, "path_already_exists");

    const missing = await manager.addFolder({ path: path.join(folderDir, "missing-dir") });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "path_not_accessible");
  });

  it("updateFolder / removeFolder 对不存在的 folderId 返回 folder_not_found", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const updated = await manager.updateFolder("missing", { read: true });
    assert.strictEqual(updated.ok, false);
    assert.strictEqual(updated.error, "folder_not_found");

    const removed = await manager.removeFolder("missing");
    assert.strictEqual(removed.ok, false);
    assert.strictEqual(removed.error, "folder_not_found");
  });
});

describe("ExternalConfigManager org 配置", () => {
  it("getEffectiveFolders 无 org 配置时返回全局文件夹", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const folderDir = await makeTempDir();
    await manager.addFolder({ path: folderDir, read: true, write: false });

    const folders = manager.getEffectiveFolders("org-no-config");
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0]._source, "global");
  });

  it("getEffectiveFolders 合并全局与组织新增文件夹", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const globalDir = await makeTempDir();
    const orgDir = await makeTempDir();
    await manager.addFolder({ path: globalDir, read: true, write: false });
    await manager.addFolderToOrg("org1", { path: orgDir, read: true, write: true });

    const folders = manager.getEffectiveFolders("org1");
    assert.strictEqual(folders.length, 2);

    const global = folders.find(f => f.path === path.resolve(globalDir));
    const org = folders.find(f => f.path === path.resolve(orgDir));
    assert.ok(global);
    assert.ok(org);
    assert.strictEqual(global._source, "global");
    assert.strictEqual(org._source, "org");
    assert.strictEqual(org.write, true);
  });

  it("getEffectiveFolders 同路径组织配置产生 overridden + org_override", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const sharedDir = await makeTempDir();
    await manager.addFolder({ path: sharedDir, read: true, write: false });
    await manager.addFolderToOrg("org1", { path: sharedDir, read: false, write: true });

    const folders = manager.getEffectiveFolders("org1");
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders.some(f => f._source === "overridden"), true);
    assert.strictEqual(folders.some(f => f._source === "org_override"), true);
  });

  it("org 文件夹 CRUD、保留天数、removeOrgConfig 完整链路", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const folderDir = await makeTempDir();
    const added = await manager.addFolderToOrg("org1", {
      path: folderDir,
      read: true,
      write: false,
      description: "org-folder"
    });
    assert.strictEqual(added.ok, true);
    assert.strictEqual(manager.getAllOrgConfigs().length, 1);
    assert.strictEqual(manager.getAllOrgConfigs()[0].config.folders.length, 1);

    const updated = await manager.updateFolderInOrg("org1", added.folder.id, {
      write: true,
      description: "updated-org"
    });
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.folder.write, true);
    assert.strictEqual(updated.folder.description, "updated-org");

    const retention = await manager.setLogRetentionDaysForOrg("org1", 45);
    assert.strictEqual(retention.ok, true);
    assert.strictEqual(manager.getEffectiveLogRetentionDays("org1"), 45);
    assert.strictEqual(manager.getEffectiveLogRetentionDays("org2"), manager.getLogRetentionDays());

    const removed = await manager.removeFolderFromOrg("org1", added.folder.id);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(manager.getAllOrgConfigs()[0].config.folders.length, 0);

    const orgRemoved = await manager.removeOrgConfig("org1");
    assert.strictEqual(orgRemoved.ok, true);
    assert.strictEqual(manager.getAllOrgConfigs().length, 0);
  });
});

describe("ExternalConfigManager retention", () => {
  it("setLogRetentionDays 接受有效天数并拒绝无效值", async () => {
    const configDir = await makeTempDir();
    const { manager } = makeConfigManager(configDir);
    await manager.init();

    const valid = await manager.setLogRetentionDays(15);
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(manager.getLogRetentionDays(), 15);

    const invalid = await manager.setLogRetentionDays(0);
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error, "invalid_days");
  });
});

describe("ExternalAccessLogger", () => {
  async function makeLogger() {
    const logDir = await makeTempDir();
    const configManager = { getLogRetentionDays: () => 30 };
    const logger = new ExternalAccessLogger({
      logDir,
      configManager,
      log: makeTestLogger("external-access-logger")
    });
    await logger.init();
    return { logger, logDir, configManager };
  }

  function todayLogName() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `access-${y}-${m}-${d}.log`;
  }

  it("log 写入内存并可通过 queryLogs 查询/过滤", async () => {
    const { logger } = await makeLogger();

    await logger.log({
      agentId: "agent-1",
      agentName: "Alice",
      operation: "read",
      path: "/data/a.txt",
      success: true,
      orgId: "org-1"
    });
    await logger.log({
      agentId: "agent-2",
      agentName: "Bob",
      operation: "write",
      path: "/data/b.txt",
      success: false,
      error: "access_denied"
    });

    const all = await logger.queryLogs({});
    assert.strictEqual(all.total, 2);
    assert.strictEqual(all.logs.length, 2);

    const readOnly = await logger.queryLogs({ operation: "read" });
    assert.strictEqual(readOnly.total, 1);
    assert.strictEqual(readOnly.logs[0].agentId, "agent-1");
    assert.strictEqual(readOnly.logs[0].path, "/data/a.txt");

    const agentFiltered = await logger.queryLogs({ agentId: "agent-2" });
    assert.strictEqual(agentFiltered.total, 1);
    assert.strictEqual(agentFiltered.logs[0].success, false);
    assert.strictEqual(agentFiltered.logs[0].error, "access_denied");
  });

  it("queryLogs 支持 limit/offset 和文件加载去重", async () => {
    const { logger } = await makeLogger();

    await logger.log({ agentId: "agent-1", agentName: "A", operation: "read", path: "/a", success: true });
    await logger.log({ agentId: "agent-2", agentName: "B", operation: "write", path: "/b", success: true });
    await logger.log({ agentId: "agent-3", agentName: "C", operation: "list", path: "/c", success: true });

    const page = await logger.queryLogs({ limit: 2, offset: 0 });
    assert.strictEqual(page.total, 3);
    assert.strictEqual(page.logs.length, 2);

    // 清空内存，强制从日志文件加载。
    logger.recentLogs = [];
    const fromFile = await logger.queryLogs({ agentId: "agent-2" });
    assert.strictEqual(fromFile.total, 1);
    assert.strictEqual(fromFile.logs[0].path, "/b");
  });

  it("cleanupOldLogs 删除过期日志并保留当前日志", async () => {
    const { logger, logDir } = await makeLogger();

    const oldName = "access-2000-01-01.log";
    const currentName = todayLogName();
    const oldPath = path.join(logDir, oldName);
    const currentPath = path.join(logDir, currentName);

    await fsp.writeFile(oldPath, "{}\n", "utf8");
    await fsp.writeFile(currentPath, "{}\n", "utf8");

    const result = await logger.cleanupOldLogs();
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(existsSync(oldPath), false);
    assert.strictEqual(existsSync(currentPath), true);
  });

  it("getStats 聚合 total/byOperation/byAgent/success/failed", async () => {
    const { logger } = await makeLogger();

    await logger.log({ agentId: "agent-1", agentName: "Alice", operation: "read", path: "/a", success: true });
    await logger.log({ agentId: "agent-1", agentName: "Alice", operation: "read", path: "/b", success: false });
    await logger.log({ agentId: "agent-2", agentName: "Bob", operation: "write", path: "/c", success: true });

    const stats = await logger.getStats({});
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.byOperation.read, 2);
    assert.strictEqual(stats.byOperation.write, 1);
    assert.strictEqual(stats.byAgent.Alice, 2);
    assert.strictEqual(stats.byAgent.Bob, 1);
    assert.strictEqual(stats.success, 2);
    assert.strictEqual(stats.failed, 1);
  });
});
