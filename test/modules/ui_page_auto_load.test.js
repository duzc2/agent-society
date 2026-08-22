/**
 * ui_page 模块 — 自动加载脚本注册表与 HTTP API 测试
 *
 * 覆盖：
 *   - createAutoLoadRegistry 的 CRUD、幂等去重、持久化往返、getExecutables 各分支
 *   - getHttpHandler 的 auto-load-scripts 四个端点与错误分支
 *
 * 模板：test/modules/localcmd/policies_api.test.js（直接 import 模块 → init(mockRuntime) → 调 handler）
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
import { makeFakeConfigService } from "../helpers/fake_config_service.js";
import { createAutoLoadRegistry } from "../../modules/ui_page/auto_load.js";
import uiPageModule from "../../modules/ui_page/index.js";
import {
  WorkspaceManager,
  _setTestWorkspaceManager,
  _resetWorkspaceManager,
} from "../../src/platform/services/workspace/workspace_manager.js";

function makeTempDirs() {
  const root = path.join(os.tmpdir(), `ui_page_auto_load_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  return { root, wsDir: path.join(root, "workspaces") };
}

/** 在工作区写入一个文件（自动创建父目录） */
async function writeWorkspaceFile(wsDir, workspaceId, relPath, content) {
  const abs = path.join(wsDir, workspaceId, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
}

describe("createAutoLoadRegistry", () => {
  let configService;
  let log;

  beforeEach(() => {
    configService = makeFakeConfigService();
    log = makeTestLogger("AutoLoad|test");
  });

  it("缺少 configService/log 时应直接抛错（功能组件禁止空值兼容）", () => {
    assert.throws(() => createAutoLoadRegistry({ log }), /configService/);
    assert.throws(() => createAutoLoadRegistry({ configService }), /log/);
  });

  it("add 创建条目：id 为 workspaceId:path、enabled 默认 true、name 回退文件名", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const res = await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadyExisted, false);
    assert.strictEqual(res.entry.id, "ws-1:ui_page_js/foo.js");
    assert.strictEqual(res.entry.enabled, true);
    assert.strictEqual(res.entry.name, "foo");
    assert.strictEqual(res.entry.workspaceId, "ws-1");
    assert.strictEqual(res.entry.path, "ui_page_js/foo.js");
    assert.ok(res.entry.createdAt, "createdAt 应有值");
  });

  it("add 指定 name 时使用传入名称", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const res = await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js", name: "my-script" });
    assert.strictEqual(res.entry.name, "my-script");
  });

  it("同 id 重复 add：不新增，恢复 enabled=true 并更新名称", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });

    const disabled = await reg.setEnabled("ws-1:ui_page_js/foo.js", false);
    assert.strictEqual(disabled.ok, true);

    const res = await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js", name: "renamed" });
    assert.strictEqual(res.alreadyExisted, true);
    assert.strictEqual(res.entry.enabled, true);
    assert.strictEqual(res.entry.name, "renamed");
    assert.strictEqual(reg.list().length, 1);
  });

  it("不同 workspaceId 同名路径 → 两条独立条目", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.add({ workspaceId: "ws-2", path: "ui_page_js/foo.js" });
    assert.strictEqual(reg.list().length, 2);
  });

  it("list 返回副本：修改返回值不影响内部状态", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    reg.list()[0].enabled = false;
    assert.strictEqual(reg.list()[0].enabled, true);
  });

  it("setEnabled / remove；remove 不存在的 id 返回 false", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    const id = "ws-1:ui_page_js/foo.js";

    const off = await reg.setEnabled(id, false);
    assert.strictEqual(off.ok, true);
    assert.strictEqual(reg.list()[0].enabled, false);

    const missing = await reg.setEnabled("no:such", true);
    assert.deepStrictEqual(missing, { ok: false, error: "not_found" });

    assert.strictEqual(await reg.remove("no:such"), false);
    assert.strictEqual(await reg.remove(id), true);
    assert.strictEqual(reg.list().length, 0);
  });

  it("持久化往返：新实例 load() 后与旧实例列表一致", async () => {
    const regA = createAutoLoadRegistry({ configService, log });
    await regA.load();
    await regA.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await regA.add({ workspaceId: "ws-1", path: "ui_page_js/bar.js" });
    await regA.setEnabled("ws-1:ui_page_js/bar.js", false);

    const regB = createAutoLoadRegistry({ configService, log });
    await regB.load();
    assert.deepStrictEqual(regB.list(), regA.list());
    assert.strictEqual(regB.list()[1].enabled, false);
  });

  it("损坏配置容错：getModuleConfig 抛错或返回非法形状 → 空列表不抛", async () => {
    const throwing = makeFakeConfigService();
    throwing.getModuleConfig = async () => { throw new Error("corrupt json"); };
    const reg1 = createAutoLoadRegistry({ configService: throwing, log });
    await reg1.load();
    assert.deepStrictEqual(reg1.list(), []);

    const badShape = makeFakeConfigService();
    badShape.getModuleConfig = async () => ({ autoLoadScripts: "not-an-array" });
    const reg2 = createAutoLoadRegistry({ configService: badShape, log });
    await reg2.load();
    assert.deepStrictEqual(reg2.list(), []);

    const mixed = makeFakeConfigService();
    mixed.getModuleConfig = async () => ({ autoLoadScripts: [null, { bad: 1 }, { id: "a", workspaceId: "w", path: "p" }] });
    const reg3 = createAutoLoadRegistry({ configService: mixed, log });
    await reg3.load();
    assert.strictEqual(reg3.list().length, 1);
  });
});

describe("createAutoLoadRegistry.getExecutables", () => {
  let configService;
  let log;
  let dirs;

  beforeEach(() => {
    configService = makeFakeConfigService();
    log = makeTestLogger("AutoLoad|test");
    dirs = makeTempDirs();
    _setTestWorkspaceManager(new WorkspaceManager({
      dataDir: dirs.root,
      workspacesDir: dirs.wsDir,
      logger: makeTestLogger("WM|test"),
    }));
  });

  afterEach(() => {
    _resetWorkspaceManager();
  });

  async function writeWorkspaceFile(workspaceId, relPath, content) {
    const abs = path.join(dirs.wsDir, workspaceId, relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  }

  it("正常分支：读取文件内容、跳过禁用项、errors 为空", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await writeWorkspaceFile("ws-1", "ui_page_js/foo.js", "const a = 1;");
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/bar.js" });
    await reg.setEnabled("ws-1:ui_page_js/bar.js", false);

    const { scripts, errors } = await reg.getExecutables();
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(scripts.length, 1);
    assert.strictEqual(scripts[0].path, "ui_page_js/foo.js");
    assert.strictEqual(scripts[0].script, "const a = 1;");
  });

  it("缺文件分支：进 errors 不抛整批，其余脚本正常返回", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await writeWorkspaceFile("ws-1", "ui_page_js/foo.js", "ok;");
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/missing.js" });

    const { scripts, errors } = await reg.getExecutables();
    assert.strictEqual(scripts.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].path, "ui_page_js/missing.js");
    assert.ok(errors[0].error, "error 应有内容");
  });

  it("路径越界防护：path 指向工作区外 → errors 含越界错误", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    // 手工构造非法条目（正常保存流程不会产生，但配置文件是外部数据，必须防护）
    await reg.add({ workspaceId: "ws-1", path: "../evil.js" });

    const { scripts, errors } = await reg.getExecutables();
    assert.strictEqual(scripts.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /超出工作区范围/);
  });
});

describe("createAutoLoadRegistry.getAvailableCandidates", () => {
  let configService;
  let log;
  let dirs;

  beforeEach(() => {
    configService = makeFakeConfigService();
    log = makeTestLogger("AutoLoad|test");
    dirs = makeTempDirs();
    _setTestWorkspaceManager(new WorkspaceManager({
      dataDir: dirs.root,
      workspacesDir: dirs.wsDir,
      logger: makeTestLogger("WM|test"),
    }));
  });

  afterEach(() => {
    _resetWorkspaceManager();
  });

  it("枚举所有工作区 ui_page_js/*.js，过滤非 js 文件与不在该目录下的文件", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "a");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/bar.js", "b");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/readme.txt", "x");
    await writeWorkspaceFile(dirs.wsDir, "ws-2", "ui_page_js/baz.js", "c");
    await writeWorkspaceFile(dirs.wsDir, "ws-3", "other/not-ui-page.js", "d");

    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const candidates = await reg.getAvailableCandidates();

    // listWorkspaces 按 mtime 降序，顺序不可依赖——用集合断言成员
    assert.strictEqual(candidates.length, 3);
    const keySet = new Set(candidates.map((c) => `${c.workspaceId}:${c.path}:${c.name}`));
    assert.ok(keySet.has("ws-1:ui_page_js/foo.js:foo"));
    assert.ok(keySet.has("ws-1:ui_page_js/bar.js:bar"));
    assert.ok(keySet.has("ws-2:ui_page_js/baz.js:baz"));
    assert.ok(!candidates.some((c) => c.path === "other/not-ui-page.js"));
  });

  it("排除已在注册表中的条目（含已禁用条目）", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "a");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/bar.js", "b");

    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.setEnabled("ws-1:ui_page_js/foo.js", false);

    const candidates = await reg.getAvailableCandidates();
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].path, "ui_page_js/bar.js");
  });

  it("无 ui_page_js 目录的工作区 → 跳过，不产生候选", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "other.js", "a");
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const candidates = await reg.getAvailableCandidates();
    assert.deepStrictEqual(candidates, []);
  });
});

describe("ui_page 模块 HTTP handler", () => {
  let handler;
  let configService;
  let dirs;

  beforeEach(async () => {
    dirs = makeTempDirs();
    configService = makeFakeConfigService();
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({
      loggerRoot: testLoggerRoot,
      configService,
    });
    handler = uiPageModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await uiPageModule.shutdown(); } catch {}
    try { await fsp.rm(dirs.root, { recursive: true, force: true }); } catch {}
    _resetWorkspaceManager();
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/ui_page/auto-load-scripts" };
  }

  /** 预置注册表条目后重新初始化模块（模拟重启后从配置加载），handler 会指向新实例 */
  async function initWithEntries(entries) {
    await configService.saveModuleConfig("ui_page", { autoLoadScripts: entries });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({
      loggerRoot: testLoggerRoot,
      configService,
    });
    handler = uiPageModule.getHttpHandler();
  }

  function entry(workspaceId, relPath, enabled = true) {
    return {
      id: `${workspaceId}:${relPath}`,
      name: path.basename(relPath, ".js"),
      workspaceId,
      path: relPath,
      enabled,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("GET 空列表返回 { ok: true, scripts: [] }", async () => {
    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.deepStrictEqual(result, { ok: true, scripts: [] });
  });

  it("预置条目后 GET 列表包含条目", async () => {
    await initWithEntries([entry("ws-1", "ui_page_js/foo.js")]);

    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scripts.length, 1);
    assert.strictEqual(result.scripts[0].id, "ws-1:ui_page_js/foo.js");
  });

  it("POST {id, enabled:false} 禁用并持久化；POST {id, remove:true} 移除并持久化", async () => {
    await initWithEntries([entry("ws-1", "ui_page_js/foo.js")]);
    const id = "ws-1:ui_page_js/foo.js";

    const off = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id, enabled: false });
    assert.strictEqual(off.ok, true);
    assert.strictEqual(off.scripts[0].enabled, false);
    // 持久化同步：新建实例读回也是禁用
    const persisted = createAutoLoadRegistry({ configService, log: makeTestLogger("AutoLoad|test") });
    await persisted.load();
    assert.strictEqual(persisted.list()[0].enabled, false);

    const removed = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id, remove: true });
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.scripts.length, 0);
    const persisted2 = createAutoLoadRegistry({ configService, log: makeTestLogger("AutoLoad|test") });
    await persisted2.load();
    assert.strictEqual(persisted2.list().length, 0);
  });

  it("POST 无参数（无 id 也无 workspaceId/path）→ missing_params", async () => {
    const noParams = await handler(makeReq("POST"), null, ["auto-load-scripts"], { enabled: true });
    assert.strictEqual(noParams.error, "missing_params");
  });

  it("POST 有 id 但无 enabled/remove → invalid_params", async () => {
    const noAction = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "x:y" });
    assert.strictEqual(noAction.error, "invalid_params");
  });

  it("POST remove 不存在的 id → not_found", async () => {
    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "no:such", remove: true });
    assert.strictEqual(result.error, "not_found");
  });

  it("GET executables 返回 { ok, scripts, errors } 结构", async () => {
    const result = await handler(makeReq(), null, ["auto-load-scripts", "executables"]);
    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.scripts));
    assert.ok(Array.isArray(result.errors));
  });

  it("未知资源/子路径/方法 → not_found / invalid_method", async () => {
    assert.strictEqual((await handler(makeReq(), null, ["foo"])).error, "not_found");
    assert.strictEqual((await handler(makeReq(), null, ["auto-load-scripts", "foo"])).error, "not_found");
    assert.strictEqual((await handler(makeReq("PUT"), null, ["auto-load-scripts"])).error, "invalid_method");
  });
});

describe("ui_page 模块 HTTP handler（添加脚本）", () => {
  let handler;
  let configService;
  let dirs;

  beforeEach(async () => {
    dirs = makeTempDirs();
    configService = makeFakeConfigService();
    _setTestWorkspaceManager(new WorkspaceManager({
      dataDir: dirs.root,
      workspacesDir: dirs.wsDir,
      logger: makeTestLogger("WM|test"),
    }));
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await uiPageModule.shutdown(); } catch {}
    try { await fsp.rm(dirs.root, { recursive: true, force: true }); } catch {}
    _resetWorkspaceManager();
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/ui_page/auto-load-scripts" };
  }

  /** 预置注册表条目后重新初始化模块（模拟重启后从配置加载） */
  async function initWithEntries(entries) {
    await configService.saveModuleConfig("ui_page", { autoLoadScripts: entries });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();
  }

  function entry(workspaceId, relPath, enabled = true) {
    return {
      id: `${workspaceId}:${relPath}`,
      name: path.basename(relPath, ".js"),
      workspaceId,
      path: relPath,
      enabled,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("GET available 返回所有工作区可添加脚本（排除已注册）", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "a");
    await writeWorkspaceFile(dirs.wsDir, "ws-2", "ui_page_js/bar.js", "b");
    // 预置 ws-1/foo.js 已注册（含禁用条目也应被排除）
    await initWithEntries([entry("ws-1", "ui_page_js/foo.js", false)]);

    const result = await handler(makeReq(), null, ["auto-load-scripts", "available"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0].workspaceId, "ws-2");
    assert.strictEqual(result.candidates[0].path, "ui_page_js/bar.js");
  });

  it("POST {workspaceId, path} 添加脚本并持久化，返回全量列表", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "a");

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scripts.length, 1);
    assert.strictEqual(result.scripts[0].id, "ws-1:ui_page_js/foo.js");
    assert.strictEqual(result.scripts[0].enabled, true);

    // 持久化同步：新建实例读回一致
    const persisted = createAutoLoadRegistry({ configService, log: makeTestLogger("AutoLoad|test") });
    await persisted.load();
    assert.strictEqual(persisted.list().length, 1);
  });

  it("POST path 不在 ui_page_js/ 下或非 .js 结尾 → invalid_params", async () => {
    const bad1 = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "other.js" });
    assert.strictEqual(bad1.error, "invalid_params");
    const bad2 = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "ui_page_js/foo.txt" });
    assert.strictEqual(bad2.error, "invalid_params");
    const bad3 = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "../ui_page_js/foo.js" });
    assert.strictEqual(bad3.error, "invalid_params");
  });
});
