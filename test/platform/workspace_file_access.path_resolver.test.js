/**
 * 工作区文件访问 — 统一路径解析器测试
 *
 * 覆盖：
 *   - 工作区相对路径 / 根目录 / 点路径
 *   - 工作区内绝对路径
 *   - 工作区外绝对路径与相对路径
 *   - 外部路径 .io / .versions 拒绝
 *   - 未分配工作区 / 缺少 agentId
 *   - Windows 盘符、UNC、POSIX 绝对路径
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { makeTestLogger } from "../helpers/test_logger.js";
import { PathResolver } from "../../src/platform/services/workspace/file_access/path_resolver.js";
import { Workspace } from "../../src/platform/services/workspace/workspace.js";
import {
  _setTestWorkspaceManager,
  _resetWorkspaceManager
} from "../../src/platform/services/workspace/workspace_manager.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wfa-path-resolver-"));
  tempDirs.push(dir);
  return dir;
}

describe("PathResolver", () => {
  afterEach(() => {
    _resetWorkspaceManager();
  });

  after(async () => {
    await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
  });

  async function makeResolver({ workspaceId = "ws1", assignedWorkspaceId = "ws1" } = {}) {
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
        assert.strictEqual(id, assignedWorkspaceId);
        return workspace;
      }
    });

    const runtime = {
      findWorkspaceIdForAgent(agentId) {
        return agentId === "agent1" ? assignedWorkspaceId : null;
      }
    };

    const resolver = new PathResolver({
      runtime,
      log: makeTestLogger("path-resolver")
    });

    return { resolver, workspace, runtime };
  }

  it("解析工作区相对路径", async () => {
    const { resolver, workspace } = await makeResolver();
    const result = await resolver.resolvePath(
      { agent: { id: "agent1" } },
      path.join("a", "b.txt"),
      { operation: "read" }
    );

    assert.strictEqual(result.scope, "workspace");
    assert.strictEqual(result.workspaceId, "ws1");
    assert.strictEqual(result.relativePath, "a/b.txt");
    assert.strictEqual(result.absolutePath, path.join(workspace.rootPath, "a", "b.txt"));
    assert.strictEqual(result.orgId, "ws1");
    assert.strictEqual(result.operation, "read");
  });

  it("空路径按工作区根目录处理", async () => {
    const { resolver, workspace } = await makeResolver();
    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, "");

    assert.strictEqual(result.scope, "workspace");
    assert.strictEqual(result.relativePath, "");
    assert.strictEqual(result.absolutePath, workspace.rootPath);
  });

  it("点路径按工作区根目录处理", async () => {
    const { resolver, workspace } = await makeResolver();
    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, "./");

    assert.strictEqual(result.scope, "workspace");
    assert.strictEqual(result.relativePath, "");
    assert.strictEqual(result.absolutePath, workspace.rootPath);
  });

  it("工作区内绝对路径仍解析为工作区路径", async () => {
    const { resolver, workspace } = await makeResolver();
    const absolute = path.join(workspace.rootPath, "sub", "file.txt");

    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, absolute);

    assert.strictEqual(result.scope, "workspace");
    assert.strictEqual(result.relativePath, "sub/file.txt");
    assert.strictEqual(result.absolutePath, absolute);
  });

  it("工作区外绝对路径解析为外部路径", async () => {
    const { resolver } = await makeResolver();
    const outsideDir = await makeTempDir();
    const absolute = path.join(outsideDir, "file.txt");

    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, absolute);

    assert.strictEqual(result.scope, "external");
    assert.strictEqual(result.relativePath, null);
    assert.strictEqual(result.absolutePath, path.resolve(absolute));
    assert.strictEqual(result.orgId, "ws1");
  });

  it("相对路径穿越到工作区外时解析为外部路径", async () => {
    const { resolver } = await makeResolver();
    const result = await resolver.resolvePath(
      { agent: { id: "agent1" } },
      path.join("..", "outside.txt")
    );

    assert.strictEqual(result.scope, "external");
    assert.strictEqual(result.relativePath, null);
  });

  it("外部路径包含 .io 段时拒绝", async () => {
    const { resolver, workspace } = await makeResolver();
    const absolute = path.join(path.dirname(workspace.rootPath), ".io", "file.txt");

    await assert.rejects(
      () => resolver.resolvePath({ agent: { id: "agent1" } }, absolute),
      /forbidden_path_segment/
    );
  });

  it("外部路径包含 .versions 段时拒绝", async () => {
    const { resolver, workspace } = await makeResolver();
    const absolute = path.join(path.dirname(workspace.rootPath), ".versions", "file.txt");

    await assert.rejects(
      () => resolver.resolvePath({ agent: { id: "agent1" } }, absolute),
      /forbidden_path_segment/
    );
  });

  it("缺少 agentId 时抛出 agent_id_required", async () => {
    const { resolver } = await makeResolver();

    await assert.rejects(
      () => resolver.resolvePath({ agent: {} }, "file.txt"),
      /agent_id_required/
    );
  });

  it("POSIX 绝对路径解析为外部路径", async () => {
    const { resolver } = await makeResolver();
    const posixAbsolute = "/tmp/wfa-outside.txt";

    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, posixAbsolute);

    assert.strictEqual(result.scope, "external");
    assert.strictEqual(result.absolutePath, path.resolve(posixAbsolute));
  });

  it("Windows UNC 路径解析为外部路径", { skip: process.platform !== "win32" }, async () => {
    const { resolver } = await makeResolver();
    const unc = "\\\\server\\share\\file.txt";

    const result = await resolver.resolvePath({ agent: { id: "agent1" } }, unc);

    assert.strictEqual(result.scope, "external");
    assert.strictEqual(result.absolutePath, path.resolve(unc));
  });
});
