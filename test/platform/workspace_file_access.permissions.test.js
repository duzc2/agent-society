/**
 * 工作区文件访问 — 外部配置与权限层测试
 *
 * 覆盖：
 *   - ExternalConfigManager 仅注册并读取 workspace_file_access 配置
 *   - ExternalPermissionManager 最长前缀 / source 优先级 / read/write 分离
 *   - ExternalFileService.createDirectory 调用 checkWritePermission 时传递 orgId
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
import { ExternalPermissionManager } from "../../src/platform/services/workspace/file_access/external_permission_manager.js";
import { ExternalFileService } from "../../src/platform/services/workspace/file_access/external_file_service.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-permissions-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

describe("ExternalConfigManager", () => {
  function makeConfigService(configDir) {
    return new Config(configDir, makeTestLogger("config"));
  }

  it("init 仅注册并读取 workspace_file_access 配置，不读取旧 localfile 配置", async () => {
    const configDir = await makeTempDir();
    const modulesDir = path.join(configDir, "modules");
    await fsp.mkdir(modulesDir, { recursive: true });

    const authorizedDir = await makeTempDir();
    const newConfig = {
      folders: [
        {
          id: "f1",
          path: authorizedDir,
          read: true,
          write: false,
          description: "new"
        }
      ],
      logRetentionDays: 22,
      orgConfigs: {
        org1: {
          folders: [{ id: "f2", path: authorizedDir, read: false, write: true }]
        }
      }
    };
    await fsp.writeFile(
      path.join(modulesDir, "workspace_file_access.json"),
      JSON.stringify(newConfig, null, 2),
      "utf8"
    );

    const configService = makeConfigService(configDir);
    const manager = new ExternalConfigManager({
      configService,
      log: makeTestLogger("external-config")
    });
    await manager.init();

    assert.strictEqual(manager.getLogRetentionDays(), 22);
    assert.strictEqual(manager.getFolders().length, 1);
    assert.strictEqual(manager.getFolders()[0].id, "f1");
    assert.strictEqual(manager.getAllOrgConfigs().length, 1);
  });
});

describe("ExternalPermissionManager", () => {
  function makeConfigManager(folders) {
    const state = { capturedOrgId: undefined };
    return {
      state,
      getEffectiveFolders(orgId) {
        state.capturedOrgId = orgId;
        return folders;
      },
      getFolder(folderId) {
        return folders.find(f => f.id === folderId) ?? null;
      }
    };
  }

  it("read/write 权限按最长前缀匹配", async () => {
    const parent = await makeTempDir();
    const child = path.join(parent, "child");
    await fsp.mkdir(child, { recursive: true });
    const file = path.join(child, "a.txt");

    const configManager = makeConfigManager([
      { id: "p", path: parent, read: false, write: true, _source: "global" },
      { id: "c", path: child, read: true, write: false, _source: "global" }
    ]);
    const pm = new ExternalPermissionManager({
      configManager,
      log: makeTestLogger("external-permission")
    });

    const readResult = await pm.checkReadPermission(file, null);
    assert.strictEqual(readResult.allowed, true);
    assert.strictEqual(readResult.folder.id, "c");

    const writeResult = await pm.checkWritePermission(file, null);
    assert.strictEqual(writeResult.allowed, false);
  });

  it("同路径长度时按 source 优先级选择 org_override", async () => {
    const parent = await makeTempDir();
    const file = path.join(parent, "a.txt");

    const configManager = makeConfigManager([
      { id: "g", path: parent, read: false, write: true, _source: "global" },
      { id: "o", path: parent, read: true, write: false, _source: "org_override" }
    ]);
    const pm = new ExternalPermissionManager({
      configManager,
      log: makeTestLogger("external-permission")
    });

    const readResult = await pm.checkReadPermission(file, "org1");
    assert.strictEqual(readResult.allowed, true);
    assert.strictEqual(readResult.folder.id, "o");
  });

  it("checkReadPermission / checkWritePermission 将 orgId 传给配置管理器", async () => {
    const parent = await makeTempDir();
    const file = path.join(parent, "a.txt");
    const configManager = makeConfigManager([
      { id: "g", path: parent, read: true, write: true, _source: "global" }
    ]);
    const pm = new ExternalPermissionManager({
      configManager,
      log: makeTestLogger("external-permission")
    });

    await pm.checkReadPermission(file, "org9");
    assert.strictEqual(configManager.state.capturedOrgId, "org9");

    await pm.checkWritePermission(file, "org10");
    assert.strictEqual(configManager.state.capturedOrgId, "org10");
  });

  it("无效路径返回 invalid_path", async () => {
    const configManager = makeConfigManager([]);
    const pm = new ExternalPermissionManager({
      configManager,
      log: makeTestLogger("external-permission")
    });

    const result = await pm.checkReadPermission(null);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("getPermissionInfo 返回 canRead/canWrite 和匹配文件夹", async () => {
    const parent = await makeTempDir();
    const file = path.join(parent, "a.txt");
    const configManager = makeConfigManager([
      { id: "g", path: parent, read: true, write: false, _source: "global" }
    ]);
    const pm = new ExternalPermissionManager({
      configManager,
      log: makeTestLogger("external-permission")
    });

    const info = await pm.getPermissionInfo(file, "org1");
    assert.strictEqual(info.canRead, true);
    assert.strictEqual(info.canWrite, false);
    assert.strictEqual(info.folder.id, "g");
  });
});

describe("ExternalFileService.createDirectory orgId 传递", () => {
  it("createDirectory 调用 checkWritePermission 时传递 orgId", async () => {
    const parent = await makeTempDir();
    const newDir = path.join(parent, "created-by-test");
    const calls = [];

    const permissionManager = {
      async checkWritePermission(dirPath, orgId) {
        calls.push({ dirPath, orgId });
        return { allowed: true };
      }
    };
    const accessLogger = {
      async logCreateDir() {}
    };
    const runtime = {
      findWorkspaceIdForAgent(agentId) {
        return agentId === "agent1" ? "org1" : null;
      }
    };

    const service = new ExternalFileService({
      permissionManager,
      accessLogger,
      runtime,
      log: makeTestLogger("workspace-file-access")
    });

    const result = await service.createDirectory(
      { agent: { id: "agent1" }, runtime },
      newDir
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].dirPath, newDir);
    assert.strictEqual(calls[0].orgId, "org1");
    assert.strictEqual(existsSync(newDir), true);
  });
});
