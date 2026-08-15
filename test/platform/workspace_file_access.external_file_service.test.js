/**
 * 工作区文件访问 — 外部路径文件服务直接测试
 *
 * 覆盖 ExternalFileService 的实际执行细节：
 *   - 读取：readFile / readLines / searchInFile / getLineCount / searchText
 *   - 写入：writeFile / appendFile / createDirectory / deleteFile / moveFile / editFile
 *   - 权限与错误边界：access_denied / file_not_found / is_directory / invalid_regex 等
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
import { ExternalAccessLogger } from "../../src/platform/services/workspace/file_access/external_access_logger.js";
import { ExternalFileService } from "../../src/platform/services/workspace/file_access/external_file_service.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-external-file-service-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

function ctx() {
  return { agent: { id: "agent1" } };
}

async function makeService() {
  const readDir = await makeTempDir();
  const writeDir = await makeTempDir();
  const dataDir = path.join(await makeTempDir(), "data");
  await fsp.mkdir(dataDir, { recursive: true });

  const configService = new Config(await makeTempDir(), makeTestLogger("config"));
  const configManager = new ExternalConfigManager({
    configService,
    log: makeTestLogger("external-config")
  });
  await configManager.init();
  await configManager.addFolder({ path: readDir, read: true, write: false });
  await configManager.addFolder({ path: writeDir, read: true, write: true });

  const permissionManager = new ExternalPermissionManager({
    configManager,
    log: makeTestLogger("external-permission")
  });

  const accessLogger = new ExternalAccessLogger({
    logDir: path.join(dataDir, "workspace_file_access", "logs"),
    configManager,
    log: makeTestLogger("external-access-logger")
  });
  await accessLogger.init();

  const runtime = {
    findWorkspaceIdForAgent(agentId) {
      return agentId === "agent1" ? "ws1" : null;
    }
  };

  const service = new ExternalFileService({
    permissionManager,
    accessLogger,
    runtime,
    log: makeTestLogger("external-file-service")
  });

  return { service, readDir, writeDir, configManager };
}

async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
}

describe("ExternalFileService 读取", () => {
  it("readFile 读取成功，目录/文件不存在/未授权返回明确错误", async () => {
    const { service, readDir } = await makeService();
    const file = path.join(readDir, "read.txt");
    await writeFile(file, "hello\nworld\n");

    const ok = await service.readFile(ctx(), file);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.content, "hello\nworld\n");
    assert.strictEqual(ok.path, file);

    const missing = await service.readFile(ctx(), path.join(readDir, "missing.txt"));
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "file_not_found");

    const dir = await service.readFile(ctx(), readDir);
    assert.strictEqual(dir.ok, false);
    assert.strictEqual(dir.error, "is_directory");

    const outside = path.join(await makeTempDir(), "outside.txt");
    await writeFile(outside, "secret");
    const denied = await service.readFile(ctx(), outside);
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "access_denied");
  });

  it("readLines 支持 start_line/end_line 和 start 超出总行数", async () => {
    const { service, readDir } = await makeService();
    const file = path.join(readDir, "lines.txt");
    await writeFile(file, "1\n2\n3\n4\n5\n");

    const lines = await service.readLines(ctx(), file, { start_line: 2, end_line: 4 });
    assert.strictEqual(lines.ok, true);
    assert.deepStrictEqual(lines.lines, ["2", "3", "4"]);
    assert.strictEqual(lines.start_line, 2);
    assert.strictEqual(lines.end_line, 4);
    assert.strictEqual(lines.total_lines, 6);

    const beyond = await service.readLines(ctx(), file, { start_line: 10, end_line: 20 });
    assert.strictEqual(beyond.ok, true);
    assert.deepStrictEqual(beyond.lines, []);
    assert.strictEqual(beyond.total_lines, 6);
  });

  it("searchInFile 支持普通搜索、正则搜索、max_results 和非法正则", async () => {
    const { service, readDir } = await makeService();
    const file = path.join(readDir, "search.txt");
    await writeFile(file, "alpha beta\nalpha gamma\ndelta\n");

    const plain = await service.searchInFile(ctx(), file, "alpha", { max_results: 1 });
    assert.strictEqual(plain.ok, true);
    assert.strictEqual(plain.count, 1);
    assert.strictEqual(plain.matches[0].line, 1);

    const regex = await service.searchInFile(ctx(), file, "a.*a", { is_regex: true, max_results: 5 });
    assert.strictEqual(regex.ok, true);
    assert.strictEqual(regex.count, 2);

    const invalid = await service.searchInFile(ctx(), file, "[", { is_regex: true });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error, "search_failed");
  });

  it("getLineCount 返回正确行数", async () => {
    const { service, readDir } = await makeService();
    const file = path.join(readDir, "count.txt");
    await writeFile(file, "a\nb\nc\n");
    const result = await service.getLineCount(ctx(), file);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.lines, 4);
  });

  it("searchText 递归搜索目录，跳过 .io/.versions 并受 maxResults 限制", async () => {
    const { service, readDir } = await makeService();
    const root = path.join(readDir, "tree");
    await fsp.mkdir(path.join(root, ".io"), { recursive: true });
    await fsp.mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "a.txt"), "needle one\n");
    await writeFile(path.join(root, "sub", "b.txt"), "needle two\nneedle three\n");
    await writeFile(path.join(root, ".io", "c.txt"), "needle hidden\n");

    const unlimited = await service.searchText(ctx(), root, "needle");
    assert.strictEqual(unlimited.ok, true);
    assert.strictEqual(unlimited.results.length, 3);

    const limited = await service.searchText(ctx(), root, "needle", { maxResults: 2 });
    assert.strictEqual(limited.ok, true);
    assert.strictEqual(limited.results.length, 2);
  });
});

describe("ExternalFileService 写入", () => {
  it("writeFile 写入新文件并创建授权范围内的缺失目录", async () => {
    const { service, writeDir } = await makeService();
    const file = path.join(writeDir, "nested", "new.txt");

    const result = await service.writeFile(ctx(), file, "content");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(await fsp.readFile(file, "utf8"), "content");
  });

  it("writeFile 未授权/目标目录超出授权范围被拒绝", async () => {
    const { service, writeDir } = await makeService();
    const denied = await service.writeFile(ctx(), path.join(await makeTempDir(), "x.txt"), "x");
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "access_denied");

    const outsideNested = path.join(writeDir, "..", "escape.txt");
    const outsideParent = await service.writeFile(ctx(), path.resolve(outsideNested), "x");
    assert.strictEqual(outsideParent.ok, false);
    assert.strictEqual(outsideParent.error, "access_denied");
  });

  it("appendFile 不存在则创建，存在则追加", async () => {
    const { service, writeDir } = await makeService();
    const file = path.join(writeDir, "append.txt");

    const first = await service.appendFile(ctx(), file, "a");
    assert.strictEqual(first.ok, true);
    assert.strictEqual(await fsp.readFile(file, "utf8"), "a");

    const second = await service.appendFile(ctx(), file, "b");
    assert.strictEqual(second.ok, true);
    assert.strictEqual(await fsp.readFile(file, "utf8"), "ab");
  });

  it("createDirectory 成功、已存在、同路径文件、未授权", async () => {
    const { service, writeDir } = await makeService();
    const dir = path.join(writeDir, "created");

    const created = await service.createDirectory(ctx(), dir);
    assert.strictEqual(created.ok, true);
    assert.strictEqual(existsSync(dir), true);

    const again = await service.createDirectory(ctx(), dir);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.error, "already_exists");

    const file = path.join(writeDir, "file-as-dir");
    await writeFile(file, "x");
    const fileConflict = await service.createDirectory(ctx(), file);
    assert.strictEqual(fileConflict.ok, false);
    assert.strictEqual(fileConflict.error, "path_is_file");

    const denied = await service.createDirectory(ctx(), path.join(await makeTempDir(), "x"));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "access_denied");
  });

  it("deleteFile 成功、不存在、目录、未授权", async () => {
    const { service, writeDir } = await makeService();
    const file = path.join(writeDir, "delete.txt");
    await writeFile(file, "x");

    const deleted = await service.deleteFile(ctx(), file);
    assert.strictEqual(deleted.ok, true);
    assert.strictEqual(existsSync(file), false);

    const missing = await service.deleteFile(ctx(), file);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "file_not_found");

    const dir = path.join(writeDir, "dir");
    await fsp.mkdir(dir);
    const dirResult = await service.deleteFile(ctx(), dir);
    assert.strictEqual(dirResult.ok, false);
    assert.strictEqual(dirResult.error, "is_directory");

    const denied = await service.deleteFile(ctx(), path.join(await makeTempDir(), "x.txt"));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "access_denied");
  });

  it("moveFile 支持同目录移动、overwrite、目标存在拒绝和未授权拒绝", async () => {
    const { service, writeDir } = await makeService();
    const from = path.join(writeDir, "move-from.txt");
    const to = path.join(writeDir, "move-to.txt");
    await writeFile(from, "move");

    const moved = await service.moveFile(ctx(), from, to);
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(existsSync(from), false);
    assert.strictEqual(await fsp.readFile(to, "utf8"), "move");

    await writeFile(from, "again");
    const targetExists = await service.moveFile(ctx(), from, to);
    assert.strictEqual(targetExists.ok, false);
    assert.strictEqual(targetExists.error, "target_exists");

    const overwritten = await service.moveFile(ctx(), from, to, { overwrite: true });
    assert.strictEqual(overwritten.ok, true);
    assert.strictEqual(await fsp.readFile(to, "utf8"), "again");

    const denied = await service.moveFile(ctx(), from, path.join(await makeTempDir(), "no.txt"));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error, "access_denied");
  });

  it("editFile 支持单次替换、全量替换、old_string 不存在和多次匹配拒绝", async () => {
    const { service, writeDir } = await makeService();
    const file = path.join(writeDir, "edit.txt");
    await writeFile(file, "aaa aaa");

    const multi = await service.editFile(ctx(), file, { old_string: "aaa", new_string: "b" });
    assert.strictEqual(multi.ok, false);
    assert.strictEqual(multi.error, "multiple_matches");

    const all = await service.editFile(ctx(), file, { old_string: "aaa", new_string: "b", replace_all: true });
    assert.strictEqual(all.ok, true);
    assert.strictEqual(all.occurrences, 2);
    assert.strictEqual(await fsp.readFile(file, "utf8"), "b b");

    const missing = await service.editFile(ctx(), file, { old_string: "zzz", new_string: "x" });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, "old_string_not_found");

    const single = await service.editFile(ctx(), file, { old_string: "b b", new_string: "c" });
    assert.strictEqual(single.ok, true);
    assert.strictEqual(single.occurrences, 1);
    assert.strictEqual(await fsp.readFile(file, "utf8"), "c");
  });
});

describe("ExternalFileService 权限查询", () => {
  it("checkPermission 返回 read/write 权限与 exists", async () => {
    const { service, readDir, writeDir } = await makeService();
    const readFile = path.join(readDir, "check.txt");
    await writeFile(readFile, "x");

    const readOnly = await service.checkPermission(ctx(), readFile);
    assert.strictEqual(readOnly.ok, true);
    assert.strictEqual(readOnly.canRead, true);
    assert.strictEqual(readOnly.canWrite, false);
    assert.strictEqual(readOnly.exists, true);

    const writable = await service.checkPermission(ctx(), path.join(writeDir, "check.txt"));
    assert.strictEqual(writable.ok, true);
    assert.strictEqual(writable.canRead, true);
    assert.strictEqual(writable.canWrite, true);
    assert.strictEqual(writable.exists, false);
  });

  it("getAuthorizedFolders 按 orgId 返回有效文件夹", async () => {
    const { service, readDir, writeDir } = await makeService();
    const folders = service.getAuthorizedFolders(ctx());
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders.some(f => f.path === path.resolve(readDir)), true);
    assert.strictEqual(folders.some(f => f.path === path.resolve(writeDir)), true);
  });
});
