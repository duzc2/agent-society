/**
 * 工作区文件访问 — 门面服务测试
 *
 * 覆盖：
 *   - workspace 相对/绝对路径的读、写、行读、搜索、行数、列表
 *   - external 已授权只读：readLines / searchInFile / getLineCount / listFiles / searchText
 *   - external 已授权可写：writeFile / appendFile / editFile / deleteFile / moveFile
 *   - external 未授权读写拒绝
 *   - external 只读目录写操作拒绝
 *   - external .io / .versions 路径拒绝
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
import { ExternalAccessLogger } from "../../src/platform/services/workspace/file_access/external_access_logger.js";
import { ExternalFileService } from "../../src/platform/services/workspace/file_access/external_file_service.js";
import { BigfileService } from "../../src/platform/services/workspace/file_access/bigfile_service.js";
import { WorkspaceFileAccessService } from "../../src/platform/services/workspace/file_access/workspace_file_access_service.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-service-"));
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

  const configDir = await makeTempDir();
  const configService = new Config(configDir, makeTestLogger("config"));
  const externalConfigManager = new ExternalConfigManager({
    configService,
    log: makeTestLogger("external-config")
  });
  await externalConfigManager.init();

  const externalPermissionManager = new ExternalPermissionManager({
    configManager: externalConfigManager,
    log: makeTestLogger("external-permission")
  });

  const externalAccessLogger = new ExternalAccessLogger({
    logDir: path.join(dataDir, "workspace_file_access", "logs"),
    configManager: externalConfigManager,
    log: makeTestLogger("external-access-logger")
  });
  await externalAccessLogger.init();

  const externalFileService = new ExternalFileService({
    permissionManager: externalPermissionManager,
    accessLogger: externalAccessLogger,
    runtime,
    log: makeTestLogger("external-file-service")
  });

  const pathResolver = new PathResolver({
    runtime,
    log: makeTestLogger("path-resolver")
  });

  const bigfileService = new BigfileService({
    pathResolver,
    permissionManager: externalPermissionManager,
    log: makeTestLogger("bigfile")
  });

  const service = new WorkspaceFileAccessService({
    pathResolver,
    externalConfigManager,
    externalPermissionManager,
    externalAccessLogger,
    externalFileService,
    bigfileService,
    log: makeTestLogger("workspace-file-access-service")
  });

  return {
    service,
    workspace,
    runtime,
    externalConfigManager
  };
}

function ctx() {
  return {
    agent: { id: "agent1" },
    currentMessage: { id: "msg-1" }
  };
}

describe("WorkspaceFileAccessService", () => {
  it("workspace 相对/绝对路径：读、写、行读、搜索、行数、列表", async () => {
    const { service, workspace } = await makeService();

    const write = await service.writeFile(ctx(), "sub/file.txt", "alpha\nbeta\nalpha\n", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(write.ok, true);

    const read = await service.readLines(ctx(), "sub/file.txt");
    assert.strictEqual(read.lines.length, 3);
    assert.strictEqual(read.total_lines, 3);

    const workspaceAbsolute = path.join(workspace.rootPath, "sub", "file.txt");
    const readAbsolute = await service.readLines(ctx(), workspaceAbsolute);
    assert.strictEqual(readAbsolute.lines[1], "beta");

    const search = await service.searchInFile(ctx(), "sub/file.txt", "alpha");
    assert.strictEqual(search.count, 2);

    const lineCount = await service.getLineCount(ctx(), "sub/file.txt");
    assert.strictEqual(lineCount.lines, 3);

    const list = await service.listFiles(ctx(), "sub");
    assert.ok(Array.isArray(list));
    assert.ok(list.some(entry => entry.name === "file.txt"));

    const writeAbsolute = await service.writeFile(ctx(), workspaceAbsolute, "gamma\n", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(writeAbsolute.ok, true);
  });

  it("external 已授权只读：readLines / searchInFile / getLineCount / listFiles / searchText", async () => {
    const { service, externalConfigManager } = await makeService();
    const readDir = await makeTempDir();
    await fsp.writeFile(path.join(readDir, "a.txt"), "one\ntwo\none\n", "utf8");
    await fsp.mkdir(path.join(readDir, "sub"), { recursive: true });
    await fsp.writeFile(path.join(readDir, "sub", "b.txt"), "two\n", "utf8");

    const added = await externalConfigManager.addFolder({
      path: readDir,
      read: true,
      write: false
    });
    assert.strictEqual(added.ok, true);

    const read = await service.readLines(ctx(), path.join(readDir, "a.txt"));
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.total_lines, 3);

    const search = await service.searchInFile(ctx(), path.join(readDir, "a.txt"), "one");
    assert.strictEqual(search.ok, true);
    assert.strictEqual(search.count, 2);

    const count = await service.getLineCount(ctx(), path.join(readDir, "a.txt"));
    assert.strictEqual(count.ok, true);
    assert.strictEqual(count.lines, 3);

    const list = await service.listFiles(ctx(), readDir);
    assert.ok(Array.isArray(list));
    assert.ok(list.some(entry => entry.name === "a.txt"));
    assert.ok(list.some(entry => entry.name === "sub"));

    const textSearch = await service.searchText(ctx(), readDir, "two");
    assert.strictEqual(textSearch.ok, true);
    assert.strictEqual(textSearch.count, 2);
  });

  it("external 已授权可写：writeFile / appendFile / editFile / deleteFile / moveFile", async () => {
    const { service, externalConfigManager } = await makeService();
    const writeDir = await makeTempDir();
    const added = await externalConfigManager.addFolder({
      path: writeDir,
      read: true,
      write: true
    });
    assert.strictEqual(added.ok, true);

    const fileA = path.join(writeDir, "a.txt");
    const fileB = path.join(writeDir, "b.txt");

    const write = await service.writeFile(ctx(), fileA, "hello\nworld\n", {
      mimeType: "text/plain"
    });
    assert.strictEqual(write.ok, true);
    assert.strictEqual(write.size, "hello\nworld\n".length);

    const append = await service.appendFile(ctx(), fileA, "again\n", {
      mimeType: "text/plain"
    });
    assert.strictEqual(append.ok, true);
    const read = await service.readLines(ctx(), fileA);
    assert.strictEqual(read.total_lines, 3);

    const edit = await service.editFile(ctx(), fileA, {
      old_string: "world",
      new_string: "planet",
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(edit.ok, true);
    assert.strictEqual(edit.occurrences, 1);
    assert.strictEqual((await fsp.readFile(fileA, "utf8")).includes("planet"), true);

    const move = await service.moveFile(ctx(), fileA, fileB, {});
    assert.strictEqual(move.ok, true);
    assert.strictEqual((await fsp.readFile(fileB, "utf8")).includes("planet"), true);

    const del = await service.deleteFile(ctx(), fileB);
    assert.strictEqual(del.ok, true);
    await assert.rejects(() => fsp.access(fileB));
  });

  it("createDirectory：workspace 与 external 均按 scope 创建目录", async () => {
    const { service, externalConfigManager } = await makeService();
    const workspaceCreate = await service.createDirectory(ctx(), "docs/notes", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(workspaceCreate.ok, true);

    const writeDir = await makeTempDir();
    const added = await externalConfigManager.addFolder({
      path: writeDir,
      read: true,
      write: true
    });
    assert.strictEqual(added.ok, true);

    const externalCreate = await service.createDirectory(ctx(), path.join(writeDir, "a", "b"));
    assert.strictEqual(externalCreate.ok, true);
    assert.strictEqual((await fsp.stat(path.join(writeDir, "a", "b"))).isDirectory(), true);
  });

  it("copyFile：外部源复制到工作区，并补 overwrite=false 时 target_exists", async () => {
    const { service, externalConfigManager } = await makeService();
    const readDir = await makeTempDir();
    await fsp.writeFile(path.join(readDir, "source.txt"), "external-content\n", "utf8");
    const added = await externalConfigManager.addFolder({
      path: readDir,
      read: true,
      write: false
    });
    assert.strictEqual(added.ok, true);

    const copied = await service.copyFile(ctx(), path.join(readDir, "source.txt"), "imported/source.txt");
    assert.strictEqual(copied.ok, true);
    assert.strictEqual(copied.to, "imported/source.txt");
    assert.strictEqual(copied.size, "external-content\n".length);

    const readBack = await service.readLines(ctx(), "imported/source.txt");
    assert.strictEqual(readBack.lines[0], "external-content");

    const existing = await service.copyFile(ctx(), path.join(readDir, "source.txt"), "imported/source.txt");
    assert.strictEqual(existing.ok, false);
    assert.strictEqual(existing.error, "target_exists");
  });

  it("copyFile：工作区源复制到已授权可写外部路径", async () => {
    const { service, externalConfigManager } = await makeService();
    const write = await service.writeFile(ctx(), "out/source.txt", "workspace-content\n", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(write.ok, true);

    const writeDir = await makeTempDir();
    const added = await externalConfigManager.addFolder({
      path: writeDir,
      read: true,
      write: true
    });
    assert.strictEqual(added.ok, true);

    const copied = await service.copyFile(ctx(), "out/source.txt", path.join(writeDir, "copied.txt"));
    assert.strictEqual(copied.ok, true);
    assert.strictEqual(copied.from, "out/source.txt");
    assert.strictEqual((await fsp.readFile(path.join(writeDir, "copied.txt"), "utf8")), "workspace-content\n");
  });

  it("copyFile：外部源复制到已授权可写外部目标", async () => {
    const { service, externalConfigManager } = await makeService();
    const sourceDir = await makeTempDir();
    const destDir = await makeTempDir();
    const sourcePath = path.join(sourceDir, "source.txt");
    const destPath = path.join(destDir, "copied.txt");
    await fsp.writeFile(sourcePath, "external-to-external\n", "utf8");

    await externalConfigManager.addFolder({ path: sourceDir, read: true, write: false });
    await externalConfigManager.addFolder({ path: destDir, read: true, write: true });

    const copied = await service.copyFile(ctx(), sourcePath, destPath);
    assert.strictEqual(copied.ok, true);
    assert.strictEqual(copied.from, sourcePath);
    assert.strictEqual(copied.to, destPath);
    assert.strictEqual((await fsp.readFile(destPath, "utf8")), "external-to-external\n");
  });

  it("copyFile：工作区源复制到工作区目标", async () => {
    const { service } = await makeService();
    const write = await service.writeFile(ctx(), "ws/src.txt", "workspace-to-workspace\n", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(write.ok, true);

    const copied = await service.copyFile(ctx(), "ws/src.txt", "ws/dst.txt");
    assert.strictEqual(copied.ok, true);
    assert.strictEqual(copied.from, "ws/src.txt");
    assert.strictEqual(copied.to, "ws/dst.txt");
    assert.strictEqual((await service.readLines(ctx(), "ws/dst.txt")).lines[0], "workspace-to-workspace");
  });

  it("moveFile：跨 scope 工作区源移动到已授权可写外部目标", async () => {
    const { service, externalConfigManager, workspace } = await makeService();
    const write = await service.writeFile(ctx(), "move/ws.txt", "move-ws\n", {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(write.ok, true);

    const writeDir = await makeTempDir();
    await externalConfigManager.addFolder({ path: writeDir, read: true, write: true });
    const destPath = path.join(writeDir, "moved.txt");

    const moved = await service.moveFile(ctx(), "move/ws.txt", destPath, {
      operator: "agent1",
      messageId: "msg-1"
    });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.from, "move/ws.txt");
    assert.strictEqual(moved.to, destPath);
    assert.strictEqual((await fsp.readFile(destPath, "utf8")), "move-ws\n");
    await assert.rejects(() => fsp.access(path.join(workspace.rootPath, "move", "ws.txt")));
  });

  it("moveFile：跨 scope 外部源移动到工作区目标", async () => {
    const { service, externalConfigManager } = await makeService();
    const sourceDir = await makeTempDir();
    const sourcePath = path.join(sourceDir, "source.txt");
    await fsp.writeFile(sourcePath, "move-external\n", "utf8");
    await externalConfigManager.addFolder({ path: sourceDir, read: true, write: true });

    const moved = await service.moveFile(ctx(), sourcePath, "moved/from-ext.txt", {});
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.from, sourcePath);
    assert.strictEqual(moved.to, "moved/from-ext.txt");
    assert.strictEqual((await service.readLines(ctx(), "moved/from-ext.txt")).lines[0], "move-external");
    await assert.rejects(() => fsp.access(sourcePath));
  });

  it("external 未授权读写被拒绝", async () => {
    const { service } = await makeService();
    const unauthorizedDir = await makeTempDir();
    const file = path.join(unauthorizedDir, "secret.txt");
    await fsp.writeFile(file, "secret\n", "utf8");

    const read = await service.readLines(ctx(), file);
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.error, "access_denied");

    const write = await service.writeFile(ctx(), path.join(unauthorizedDir, "new.txt"), "x", {});
    assert.strictEqual(write.ok, false);
    assert.strictEqual(write.error, "access_denied");
  });

  it("external 只读目录写操作被拒绝", async () => {
    const { service, externalConfigManager } = await makeService();
    const readDir = await makeTempDir();
    const added = await externalConfigManager.addFolder({
      path: readDir,
      read: true,
      write: false
    });
    assert.strictEqual(added.ok, true);

    const write = await service.writeFile(ctx(), path.join(readDir, "x.txt"), "x", {});
    assert.strictEqual(write.ok, false);
    assert.strictEqual(write.error, "access_denied");
  });

  it("external .io / .versions 路径段被拒绝", async () => {
    const { service } = await makeService();
    const parent = await makeTempDir();
    const ioDir = path.join(parent, ".io");
    const versionsDir = path.join(parent, ".versions");
    await fsp.mkdir(ioDir, { recursive: true });
    await fsp.mkdir(versionsDir, { recursive: true });

    const ioResult = await service.readLines(ctx(), path.join(ioDir, "file.txt"));
    assert.strictEqual(ioResult.ok, false);
    assert.strictEqual(ioResult.error, "forbidden_path_segment");

    const versionsResult = await service.readLines(ctx(), path.join(versionsDir, "file.txt"));
    assert.strictEqual(versionsResult.ok, false);
    assert.strictEqual(versionsResult.error, "forbidden_path_segment");
  });

  it("file_check_permission 工作区路径始终返回可读可写", async () => {
    const { service } = await makeService();
    const result = await service.checkPermission(ctx(), ".");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scope, "workspace");
    assert.strictEqual(result.canRead, true);
    assert.strictEqual(result.canWrite, true);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.folder, null);
  });

  it("file_check_permission 外部授权路径按 read/write 返回权限与 exists", async () => {
    const { service, externalConfigManager } = await makeService();
    const readDir = await makeTempDir();
    const writeDir = await makeTempDir();
    await externalConfigManager.addFolder({ path: readDir, read: true, write: false });
    await externalConfigManager.addFolder({ path: writeDir, read: true, write: true });

    const readFile = path.join(readDir, "read.txt");
    await fsp.writeFile(readFile, "x", "utf8");

    const readOnly = await service.checkPermission(ctx(), readFile);
    assert.strictEqual(readOnly.ok, true);
    assert.strictEqual(readOnly.canRead, true);
    assert.strictEqual(readOnly.canWrite, false);
    assert.strictEqual(readOnly.exists, true);
    assert.strictEqual(readOnly.folder.path, path.resolve(readDir));

    const writable = await service.checkPermission(ctx(), path.join(writeDir, "not-exist.txt"));
    assert.strictEqual(writable.ok, true);
    assert.strictEqual(writable.canRead, true);
    assert.strictEqual(writable.canWrite, true);
    assert.strictEqual(writable.exists, false);
  });

  it("file_check_permission 外部未授权路径拒绝读和写", async () => {
    const { service } = await makeService();
    const unauthorizedDir = await makeTempDir();
    const file = path.join(unauthorizedDir, "secret.txt");
    await fsp.writeFile(file, "secret", "utf8");

    const result = await service.checkPermission(ctx(), file);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.canRead, false);
    assert.strictEqual(result.canWrite, false);
    assert.strictEqual("exists" in result, false);
    assert.strictEqual("isDirectory" in result, false);
  });

  it("file_list_authorized_folders 返回当前 org 的有效授权文件夹", async () => {
    const { service, externalConfigManager } = await makeService();

    const empty = service.getAuthorizedFolders(ctx());
    assert.deepStrictEqual(empty, []);

    const readDir = await makeTempDir();
    const writeDir = await makeTempDir();
    await externalConfigManager.addFolder({ path: readDir, read: true, write: false });
    await externalConfigManager.addFolder({ path: writeDir, read: true, write: true });

    const folders = service.getAuthorizedFolders(ctx());
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders.some(f => f.path === path.resolve(readDir)), true);
    assert.strictEqual(folders.some(f => f.path === path.resolve(writeDir)), true);
  });
});
