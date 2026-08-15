/**
 * 工作区文件访问 — BigfileService 外部权限拒绝测试
 *
 * 覆盖：
 *   - 不 patch _resolveAbsolutePath，而是使用真实 PathResolver + ExternalPermissionManager。
 *   - 对外部未授权路径调用 read / getInfo / getLineCount / readLines / search /
 *     stats / jsonTree / jsonKeys / jsonlFilter，均应拒绝并返回 access_denied。
 *   - 对已授权外部路径至少验证一个方法可正常执行，证明测试环境不是全量失败。
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { makeTestLogger } from "../helpers/test_logger.js";
import { Config } from "../../src/platform/utils/config/config.js";
import { Workspace } from "../../src/platform/services/workspace/workspace.js";
import {
  _setTestWorkspaceManager,
  _resetWorkspaceManager
} from "../../src/platform/services/workspace/workspace_manager.js";
import { PathResolver } from "../../src/platform/services/workspace/file_access/path_resolver.js";
import { ExternalConfigManager } from "../../src/platform/services/workspace/file_access/external_config_manager.js";
import { ExternalPermissionManager } from "../../src/platform/services/workspace/file_access/external_permission_manager.js";
import { BigfileService } from "../../src/platform/services/workspace/file_access/bigfile_service.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-bigfile-permissions-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  _resetWorkspaceManager();
});

async function makeService() {
  const workspaceId = "ws1";
  const workspacesDir = await makeTempDir();
  const dataDir = path.join(await makeTempDir(), "data");
  await fsp.mkdir(dataDir, { recursive: true });

  const workspace = new Workspace(workspaceId, workspacesDir, {
    dataDir,
    logger: makeTestLogger("workspace")
  });
  await fsp.mkdir(workspace.rootPath, { recursive: true });

  _setTestWorkspaceManager({
    async getWorkspace(id) {
      assert.strictEqual(id, workspaceId);
      return workspace;
    }
  });

  const runtime = {
    findWorkspaceIdForAgent(agentId) {
      return agentId === "agent1" ? workspaceId : null;
    }
  };

  const authorizedDir = await makeTempDir();
  const deniedDir = await makeTempDir();

  const configService = new Config(await makeTempDir(), makeTestLogger("config"));
  const configManager = new ExternalConfigManager({
    configService,
    log: makeTestLogger("external-config")
  });
  await configManager.init();
  await configManager.addFolder({ path: authorizedDir, read: true, write: false });

  const permissionManager = new ExternalPermissionManager({
    configManager,
    log: makeTestLogger("external-permission")
  });

  const pathResolver = new PathResolver({
    runtime,
    log: makeTestLogger("path-resolver")
  });

  const service = new BigfileService({
    pathResolver,
    permissionManager,
    log: makeTestLogger("bigfile")
  });

  return { service, workspace, authorizedDir, deniedDir };
}

async function writeExternalFile(dir, name, content) {
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("BigfileService 外部权限", () => {
  it("未授权外部路径在所有大文件工具中被拒绝为 access_denied", async () => {
    const { service, deniedDir } = await makeService();
    const deniedPath = await writeExternalFile(deniedDir, "secret.txt", "line1\nline2\n");
    const ctx = { agent: { id: "agent1" } };

    const cases = [
      await service.read(ctx, { path: deniedPath, offset: 0, length: 10 }),
      await service.getInfo(ctx, { path: deniedPath }),
      await service.getLineCount(ctx, { path: deniedPath }),
      await service.readLines(ctx, { path: deniedPath, start_line: 1, end_line: 10 }),
      await service.search(ctx, { path: deniedPath, pattern: "line" }),
      await service.stats(ctx, { path: deniedPath, rules: [{ name: "line", pattern: "line" }] }),
      await service.jsonTree(ctx, { path: deniedPath, path_expr: "" }),
      await service.jsonKeys(ctx, { path: deniedPath, path_expr: "" }),
      await service.jsonlFilter(ctx, { path: deniedPath, field: "id", pattern: "1" })
    ];

    for (const result of cases) {
      assert.strictEqual(result.ok, false, JSON.stringify(result));
      assert.strictEqual(result.error, "access_denied", JSON.stringify(result));
    }
  });

  it("已授权外部路径可以正常完成读取", async () => {
    const { service, authorizedDir } = await makeService();
    const authorizedPath = await writeExternalFile(authorizedDir, "ok.txt", "a\nb\nc\n");
    const ctx = { agent: { id: "agent1" } };

    const result = await service.getLineCount(ctx, { path: authorizedPath });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.lines, 3);
  });
});
