/**
 * ui_page 模块 — 自动加载脚本注册表与 HTTP API 测试
 *
 * 覆盖：
 *   - createAutoLoadRegistry 的 CRUD、幂等去重、持久化往返、getExecutables 各分支
 *   - getHttpHandler 的 auto-load-scripts 四个端点与错误分支
 *
 * 模板：test/modules/localcmd/policies_api.test.js（直接 import 模块 → init(mockRuntime) → 调 handler）
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
import { makeFakeConfigService } from "../helpers/fake_config_service.js";
import { assertCalledWith } from "../helpers/test_runner.js";
import {
  createAutoLoadRegistry,
  extractPurpose,
  withPurposeHeader,
} from "../../modules/ui_page/auto_load.js";
import uiPageModule from "../../modules/ui_page/index.js";
import { _setBroker } from "../../modules/ui_page/broker.js";
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

  it("getScriptContent：条目存在且文件可读 → 返回内容", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await writeWorkspaceFile("ws-1", "ui_page_js/foo.js", "const a = 1;");
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });

    const result = await reg.getScriptContent("ws-1:ui_page_js/foo.js");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.script, "const a = 1;");
    assert.strictEqual(result.entry.path, "ui_page_js/foo.js");
  });

  it("getScriptContent：条目不存在 → not_found", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const result = await reg.getScriptContent("no:such");
    assert.deepStrictEqual(result, { ok: false, error: "not_found" });
  });

  it("getScriptContent：文件缺失 → read_failed", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/missing.js" });
    const result = await reg.getScriptContent("ws-1:ui_page_js/missing.js");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "read_failed");
  });

  it("getScriptContent：路径越界条目 → read_failed", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "../evil.js" });
    const result = await reg.getScriptContent("ws-1:../evil.js");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "read_failed");
  });

  it("getFileContent：按 workspaceId+path 直接读文件（未注册条目也可运行）", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await writeWorkspaceFile("ws-1", "ui_page_js/foo.js", "const a = 1;");

    const result = await reg.getFileContent("ws-1", "ui_page_js/foo.js");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.script, "const a = 1;");
  });

  it("getFileContent：文件缺失 → read_failed", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const result = await reg.getFileContent("ws-1", "ui_page_js/missing.js");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "read_failed");
  });

  it("getFileContent：路径越界 → read_failed", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const result = await reg.getFileContent("ws-1", "../evil.js");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "read_failed");
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

  it("GET 启动项列表带 description：从脚本文件头部注释解析，无头注释为空", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "// purpose: 自动登录\nconst a = 1;");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/bar.js", "const b = 2;");
    await initWithEntries([entry("ws-1", "ui_page_js/foo.js"), entry("ws-1", "ui_page_js/bar.js")]);

    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scripts.length, 2);
    assert.strictEqual(result.scripts.find((s) => s.path === "ui_page_js/foo.js").description, "自动登录");
    assert.strictEqual(result.scripts.find((s) => s.path === "ui_page_js/bar.js").description, "");
  });

  it("POST 启停/删除后返回的 scripts 仍带 description（面板操作后描述不消失）", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "// purpose: 自动登录\nconst a = 1;");
    await initWithEntries([entry("ws-1", "ui_page_js/foo.js")]);

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "ws-1:ui_page_js/foo.js", enabled: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scripts.length, 1);
    assert.strictEqual(result.scripts[0].description, "自动登录");
  });
});

describe("ui_page 模块 HTTP handler（运行预览）", () => {
  let handler;
  let configService;
  let dirs;
  let enqueueSpy;
  let clearSpy;

  beforeEach(async () => {
    dirs = makeTempDirs();
    configService = makeFakeConfigService();
    _setTestWorkspaceManager(new WorkspaceManager({
      dataDir: dirs.root,
      workspacesDir: dirs.wsDir,
      logger: makeTestLogger("WM|test"),
    }));
    // 注入 mock broker：验证 run 广播的 eval_js 命令与延迟清理
    enqueueSpy = mock.fn(() => ({ ok: true, commandId: "cmd-run" }));
    clearSpy = mock.fn();
    _setBroker({
      enqueueToActive: enqueueSpy,
      waitForResult: mock.fn(async () => ({ ok: true, result: null })),
      clearCommand: clearSpy,
    });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await uiPageModule.shutdown(); } catch {}
    _setBroker(null);
    try { await fsp.rm(dirs.root, { recursive: true, force: true }); } catch {}
    _resetWorkspaceManager();
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/ui_page/auto-load-scripts" };
  }

  it("POST {id, run:true} 读内容并广播 eval_js（带 _preview 标记），不弹保存提示", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "const a = 1;");
    await configService.saveModuleConfig("ui_page", {
      autoLoadScripts: [{
        id: "ws-1:ui_page_js/foo.js",
        name: "foo",
        workspaceId: "ws-1",
        path: "ui_page_js/foo.js",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "ws-1:ui_page_js/foo.js", run: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.run, true);
    assert.strictEqual(result.path, "ui_page_js/foo.js");
    assertCalledWith(enqueueSpy, {
      type: "eval_js",
      payload: { script: "const a = 1;", _ws: "ws-1", _preview: true }
    });
  });

  it("run 不存在的条目 → not_found，不广播", async () => {
    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "no:such", run: true });
    assert.strictEqual(result.error, "not_found");
    assert.strictEqual(enqueueSpy.mock.callCount(), 0);
  });

  it("run 文件缺失 → read_failed，不广播", async () => {
    await configService.saveModuleConfig("ui_page", {
      autoLoadScripts: [{
        id: "ws-1:ui_page_js/missing.js",
        name: "missing",
        workspaceId: "ws-1",
        path: "ui_page_js/missing.js",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "ws-1:ui_page_js/missing.js", run: true });
    assert.strictEqual(result.error, "read_failed");
    assert.strictEqual(enqueueSpy.mock.callCount(), 0);
  });

  it("心跳通道不可用 → dispatch_failed", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "x");
    await configService.saveModuleConfig("ui_page", {
      autoLoadScripts: [{
        id: "ws-1:ui_page_js/foo.js",
        name: "foo",
        workspaceId: "ws-1",
        path: "ui_page_js/foo.js",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();

    enqueueSpy = mock.fn(() => ({ ok: false, error: "heartbeat_broker_not_available" }));
    _setBroker({ enqueueToActive: enqueueSpy, waitForResult: mock.fn() });

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "ws-1:ui_page_js/foo.js", run: true });
    assert.strictEqual(result.error, "dispatch_failed");
  });

  it("候选运行：POST {workspaceId, path, run:true} 广播 eval_js（_preview），不要求已注册", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "const a = 1;");

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "ui_page_js/foo.js", run: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.run, true);
    assert.strictEqual(result.path, "ui_page_js/foo.js");
    assertCalledWith(enqueueSpy, {
      type: "eval_js",
      payload: { script: "const a = 1;", _ws: "ws-1", _preview: true }
    });
  });

  it("候选运行：文件缺失 → read_failed，不广播", async () => {
    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "ui_page_js/missing.js", run: true });
    assert.strictEqual(result.error, "read_failed");
    assert.strictEqual(enqueueSpy.mock.callCount(), 0);
  });

  it("候选运行：path 格式非法 → invalid_params，不广播", async () => {
    const bad = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "other.js", run: true });
    assert.strictEqual(bad.error, "invalid_params");
    assert.strictEqual(enqueueSpy.mock.callCount(), 0);
  });

  it("候选运行：心跳通道不可用 → dispatch_failed", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "x");
    enqueueSpy = mock.fn(() => ({ ok: false, error: "heartbeat_broker_not_available" }));
    _setBroker({ enqueueToActive: enqueueSpy, waitForResult: mock.fn(), clearCommand: mock.fn() });

    const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { workspaceId: "ws-1", path: "ui_page_js/foo.js", run: true });
    assert.strictEqual(result.error, "dispatch_failed");
  });

  it("预览广播后延迟 10s 清理心跳消息（clearCommand），防止刷新后重复执行", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "x");
    await configService.saveModuleConfig("ui_page", {
      autoLoadScripts: [{
        id: "ws-1:ui_page_js/foo.js",
        name: "foo",
        workspaceId: "ws-1",
        path: "ui_page_js/foo.js",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService });
    handler = uiPageModule.getHttpHandler();

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const result = await handler(makeReq("POST"), null, ["auto-load-scripts"], { id: "ws-1:ui_page_js/foo.js", run: true });
      assert.strictEqual(result.ok, true);
      // 广播后立即：未清理
      assert.strictEqual(clearSpy.mock.callCount(), 0);
      // 10s 后：清理该命令的心跳消息
      mock.timers.tick(10_000);
      assert.strictEqual(clearSpy.mock.callCount(), 1);
      assertCalledWith(clearSpy, "cmd-run");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("脚本头部目的描述（purpose）纯函数", () => {
  describe("extractPurpose", () => {
    it("无头注释 → 空字符串", () => {
      assert.strictEqual(extractPurpose("const a = 1;"), "");
      assert.strictEqual(extractPurpose(""), "");
      assert.strictEqual(extractPurpose(null), "");
    });

    it("首行 `// purpose: x` → x", () => {
      assert.strictEqual(extractPurpose("// purpose: 自动登录\nconst a = 1;"), "自动登录");
    });

    it("头部普通注释之后第二行匹配 → 解析该行", () => {
      assert.strictEqual(extractPurpose("// 说明\n// purpose: 创建小窗\nconst a = 1;"), "创建小窗");
    });

    it("容忍多余空白（`//   purpose:   x  `）", () => {
      assert.strictEqual(extractPurpose("//   purpose:   创建小窗  \nconst a = 1;"), "创建小窗");
    });

    it("容忍无空格写法 `//purpose: x`", () => {
      assert.strictEqual(extractPurpose("//purpose: x"), "x");
    });

    it("CRLF 行尾可解析", () => {
      assert.strictEqual(extractPurpose("// purpose: 自动登录\r\nconst a = 1;"), "自动登录");
    });

    it("前 20 行内首个匹配生效（多个 purpose 行取第一个）", () => {
      const content = "// purpose: 第一个\n// purpose: 第二个\nconst a = 1;";
      assert.strictEqual(extractPurpose(content), "第一个");
    });

    it("第 21 行才出现 purpose → 空字符串（扫描上限）", () => {
      const content = Array(20).fill("x").join("\n") + "\n// purpose: 太靠后了";
      assert.strictEqual(extractPurpose(content), "");
    });

    it("超出 500 字符截断", () => {
      const long = "x".repeat(600);
      assert.strictEqual(extractPurpose(`// purpose: ${long}`), "x".repeat(500));
    });
  });

  describe("withPurposeHeader", () => {
    it("正常注入：`// purpose: x\\n` + 原内容", () => {
      assert.strictEqual(
        withPurposeHeader("const a = 1;", "在右下角创建股票价格小窗口"),
        "// purpose: 在右下角创建股票价格小窗口\nconst a = 1;"
      );
    });

    it("purpose 含换行/多空白 → 折叠为单空格（防注释逃逸注入代码）", () => {
      assert.strictEqual(
        withPurposeHeader("const a = 1;", "第一行\n第二行\r\n第三行"),
        "// purpose: 第一行 第二行 第三行\nconst a = 1;"
      );
      assert.strictEqual(
        withPurposeHeader("const a = 1;", "a    b"),
        "// purpose: a b\nconst a = 1;"
      );
    });

    it("purpose 含 Unicode 行分隔符（U+2028/U+2029）→ 折叠", () => {
      // 转义序列在 JS 解析时即为真实 U+2028/U+2029（源码内不用字面字符，避免传输丢失）
      assert.strictEqual(
        withPurposeHeader("const a = 1;", "a\u2028b\u2029c"),
        "// purpose: a b c\nconst a = 1;"
      );
    });

    it("purpose 为空/纯空白/非字符串 → 原样返回 content（无头注释）", () => {
      assert.strictEqual(withPurposeHeader("const a = 1;", ""), "const a = 1;");
      assert.strictEqual(withPurposeHeader("const a = 1;", "   "), "const a = 1;");
      assert.strictEqual(withPurposeHeader("const a = 1;", undefined), "const a = 1;");
      assert.strictEqual(withPurposeHeader("const a = 1;", 123), "const a = 1;");
    });

    it("purpose 超出 200 字符截断", () => {
      const long = "x".repeat(300);
      const out = withPurposeHeader("const a = 1;", long);
      assert.ok(out.startsWith(`// purpose: ${"x".repeat(200)}\n`));
    });
  });
});

describe("createAutoLoadRegistry.listWithDescriptions", () => {
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

  it("含 purpose 头注释的文件 → description 正确；无头注释 → 空字符串", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "// purpose: 自动登录\nconst a = 1;");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/bar.js", "const b = 2;");

    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/bar.js" });

    const list = await reg.listWithDescriptions();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list.find((s) => s.path === "ui_page_js/foo.js").description, "自动登录");
    assert.strictEqual(list.find((s) => s.path === "ui_page_js/bar.js").description, "");
  });

  it("文件缺失的条目 → description 为空且其余条目正常（逐条容错）", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "// purpose: 自动登录\nconst a = 1;");

    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/missing.js" });

    const list = await reg.listWithDescriptions();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list.find((s) => s.path === "ui_page_js/foo.js").description, "自动登录");
    assert.strictEqual(list.find((s) => s.path === "ui_page_js/missing.js").description, "");
  });

  it("路径越界条目 → description 为空，不抛", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "../evil.js" });

    const list = await reg.listWithDescriptions();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].description, "");
  });

  it("空注册表 → 空数组", async () => {
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    assert.deepStrictEqual(await reg.listWithDescriptions(), []);
  });

  it("workspace_manager 未注入 → 每条 description 为空，不抛（读文件失败走逐条容错）", async () => {
    _resetWorkspaceManager();
    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    await reg.add({ workspaceId: "ws-1", path: "ui_page_js/foo.js" });
    const list = await reg.listWithDescriptions();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].description, "");
  });
});

describe("createAutoLoadRegistry.getAvailableCandidates（带描述）", () => {
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

  it("候选带 description：含头注释文件解析正确，无头注释为空", async () => {
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/foo.js", "// purpose: 股票小窗\nconst a = 1;");
    await writeWorkspaceFile(dirs.wsDir, "ws-1", "ui_page_js/bar.js", "const b = 2;");

    const reg = createAutoLoadRegistry({ configService, log });
    await reg.load();
    const candidates = await reg.getAvailableCandidates();

    assert.strictEqual(candidates.length, 2);
    assert.strictEqual(candidates.find((c) => c.path === "ui_page_js/foo.js").description, "股票小窗");
    assert.strictEqual(candidates.find((c) => c.path === "ui_page_js/bar.js").description, "");
  });
});

describe("ui_page 模块 HTTP handler（归属显示名富化）", () => {
  let handler;
  let configService;
  let dirs;
  let mockOrg;

  beforeEach(async () => {
    dirs = makeTempDirs();
    configService = makeFakeConfigService();
    // 组织 mock：head-1(顶层) → mid-1 → leaf-1(该 agent 设了组织名)；solo-1 独立 agent
    mockOrg = {
      listAgents: () => [
        { id: "head-1", name: "投资总监Agent", parentAgentId: null },
        { id: "mid-1", name: "研究员Agent", parentAgentId: "head-1" },
        { id: "leaf-1", name: "量化Agent", parentAgentId: "mid-1" },
        { id: "solo-1", name: "独立Agent", parentAgentId: null },
      ],
      getOrgName: (id) => (id === "leaf-1" ? "股票研究部" : null),
    };
    _setTestWorkspaceManager(new WorkspaceManager({
      dataDir: dirs.root,
      workspacesDir: dirs.wsDir,
      logger: makeTestLogger("WM|test"),
    }));
    try { await uiPageModule.shutdown(); } catch {}
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService, org: mockOrg });
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
    await uiPageModule.init({ loggerRoot: testLoggerRoot, configService, org: mockOrg });
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

  it("GET 启动项列表：agentName 显示「组织名 / 最上层agent名」", async () => {
    await writeWorkspaceFile(dirs.wsDir, "leaf-1", "ui_page_js/foo.js", "x");
    await initWithEntries([entry("leaf-1", "ui_page_js/foo.js")]);

    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scripts[0].agentName, "股票研究部 / 投资总监Agent");
  });

  it("无组织名 → 只显示最上层 agent 名；自己即顶层 → 显示自己", async () => {
    await writeWorkspaceFile(dirs.wsDir, "mid-1", "ui_page_js/a.js", "x");
    await writeWorkspaceFile(dirs.wsDir, "solo-1", "ui_page_js/b.js", "x");
    await initWithEntries([entry("mid-1", "ui_page_js/a.js"), entry("solo-1", "ui_page_js/b.js")]);

    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.strictEqual(result.scripts.find((s) => s.path === "ui_page_js/a.js").agentName, "投资总监Agent");
    assert.strictEqual(result.scripts.find((s) => s.path === "ui_page_js/b.js").agentName, "独立Agent");
  });

  it("org 树中不存在的 workspaceId → agentName 回退原始 id", async () => {
    await writeWorkspaceFile(dirs.wsDir, "unknown-ws", "ui_page_js/c.js", "x");
    await initWithEntries([entry("unknown-ws", "ui_page_js/c.js")]);

    const result = await handler(makeReq(), null, ["auto-load-scripts"]);
    assert.strictEqual(result.scripts[0].agentName, "unknown-ws");
  });

  it("GET available 候选同样带 agentName", async () => {
    await writeWorkspaceFile(dirs.wsDir, "leaf-1", "ui_page_js/foo.js", "x");

    const result = await handler(makeReq(), null, ["auto-load-scripts", "available"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.candidates[0].agentName, "股票研究部 / 投资总监Agent");
  });
});
