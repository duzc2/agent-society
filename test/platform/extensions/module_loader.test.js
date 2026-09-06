/**
 * ModuleLoader 模块测试
 * 测试模块加载、验证、延迟初始化、工具管理
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ModuleLoader } from "../../../src/platform/extensions/module_loader.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeTestLogger } from "../../helpers/test_logger.js";

const TEST_MODULES_DIR = path.resolve(process.cwd(), "test/.tmp/module_loader_test_modules");

function makeValidModule(overrides = {}) {
  return {
    name: "test_module",
    getToolDefinitions: () => [{ type: "function", function: { name: "test_tool" } }],
    executeToolCall: async (ctx, toolName, args) => ({ result: "ok", toolName, args }),
    init: async () => {},
    shutdown: async () => {},
    ...overrides
  };
}

function makeRuntimeMock() {
  return {
    toolGroupManager: {
      registerGroup: (id, opts) => ({ ok: true }),
      unregisterGroup: (id) => ({ ok: true })
    }
  };
}

/** registerGroup 记录调用参数的 runtime mock（验证模块工具组注册链路） */
function makeRecordingRuntimeMock() {
  const registered = [];
  return {
    toolGroupManager: {
      registerGroup: (id, opts) => { registered.push({ id, opts }); return { ok: true }; },
      unregisterGroup: (id) => ({ ok: true })
    },
    _registered: registered
  };
}

describe("ModuleLoader", () => {
  // ==================== 构造函数 ====================

  describe("构造函数", () => {
    it("无参数创建实例（modulesDir 默认值）", () => {
      const loader = new ModuleLoader();
      assert.notStrictEqual(loader, undefined);
      assert.notStrictEqual(loader.modulesDir, undefined);
      assert.ok(loader.modulesDir.includes("modules"));
    });

    it("传入 logger 选项", () => {
      const log = makeTestLogger("ModuleLoader");
      const loader = new ModuleLoader({ logger: log });
      assert.strictEqual(loader.log, log);
    });

    it("传入 modulesDir 选项", () => {
      const loader = new ModuleLoader({ modulesDir: "/custom/modules" });
      assert.strictEqual(loader.modulesDir, "/custom/modules");
    });

    it("初始化内部属性", () => {
      const loader = new ModuleLoader();
      assert.ok(loader._modules instanceof Map);
      assert.ok(loader._toolNameToModule instanceof Map);
      assert.ok(loader._moduleToolGroupIds instanceof Map);
      assert.ok(loader._lazyModules instanceof Map);
      assert.strictEqual(loader._runtime, null);
      assert.strictEqual(loader._initialized, false);
    });
  });

  // ==================== _parseModulesConfig ====================

  describe("_parseModulesConfig", () => {
    let loader;

    beforeEach(() => {
      loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
    });

    it("解析字符串数组格式 ['a', 'b']", () => {
      const { moduleNames, moduleConfigs } = loader._parseModulesConfig(["a", "b"]);
      assert.deepStrictEqual(moduleNames, ["a", "b"]);
      assert.deepStrictEqual(moduleConfigs.get("a"), {});
      assert.deepStrictEqual(moduleConfigs.get("b"), {});
    });

    it("解析对象格式 {'a': {lazy: true}, 'b': {}}", () => {
      const { moduleNames, moduleConfigs } = loader._parseModulesConfig({ a: { lazy: true }, b: {} });
      assert.ok(moduleNames.includes("a"));
      assert.ok(moduleNames.includes("b"));
      assert.deepStrictEqual(moduleConfigs.get("a"), { lazy: true });
      assert.deepStrictEqual(moduleConfigs.get("b"), {});
    });

    it("空数组返回空结果", () => {
      const { moduleNames, moduleConfigs } = loader._parseModulesConfig([]);
      assert.deepStrictEqual(moduleNames, []);
      assert.strictEqual(moduleConfigs.size, 0);
    });

    it("null/undefined 返回空结果", () => {
      const { moduleNames } = loader._parseModulesConfig(null);
      assert.deepStrictEqual(moduleNames, []);
    });
  });

  // ==================== _validateModuleInterface ====================

  describe("_validateModuleInterface", () => {
    let loader;

    beforeEach(() => {
      loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
    });

    it("有效模块通过验证", () => {
      const module = makeValidModule();
      assert.doesNotThrow(() => loader._validateModuleInterface("test", module));
    });

    it("缺少 name 抛错", () => {
      const module = makeValidModule();
      delete module.name;
      assert.throws(() => loader._validateModuleInterface("test", module), /缺少字段: name/);
    });

    it("缺少 getToolDefinitions 函数抛错", () => {
      const module = makeValidModule();
      delete module.getToolDefinitions;
      assert.throws(() => loader._validateModuleInterface("test", module), /缺少字段: getToolDefinitions/);
    });

    it("缺少 init / shutdown / executeToolCall 报错", () => {
      const module = makeValidModule();
      delete module.init;
      delete module.shutdown;
      assert.throws(() => loader._validateModuleInterface("test", module), /init/);
      assert.throws(() => loader._validateModuleInterface("test", module), /shutdown/);
    });
  });

  // ==================== loadModules - 通过动态创建模块文件测试 ====================

  describe("loadModules", () => {
    let loader, log, runtimeMock;

    beforeEach(async () => {
      log = makeTestLogger("ModuleLoader");
      loader = new ModuleLoader({ logger: log, modulesDir: TEST_MODULES_DIR });
      runtimeMock = makeRuntimeMock();

      // 清理并创建临时模块目录
      if (existsSync(TEST_MODULES_DIR)) {
        await rm(TEST_MODULES_DIR, { recursive: true, force: true });
      }
      await mkdir(TEST_MODULES_DIR, { recursive: true });
    });

    afterEach(async () => {
      if (existsSync(TEST_MODULES_DIR)) {
        await rm(TEST_MODULES_DIR, { recursive: true, force: true });
      }
    });

    async function createModuleFile(name, moduleCode) {
      const dir = path.join(TEST_MODULES_DIR, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.js"), moduleCode);
    }

    it("加载有效模块 → loaded 列表包含该模块，errors 为空", async () => {
      await createModuleFile("valid_module", `
        export default {
          name: "valid_module",
          getToolDefinitions: () => [],
          executeToolCall: async () => ({ result: "ok" }),
          init: async () => {},
          shutdown: async () => {}
        };
      `);
      const result = await loader.loadModules(["valid_module"], runtimeMock);
      assert.ok(result.loaded.includes("valid_module"));
      assert.strictEqual(result.errors.length, 0);
    });

    it("加载不存在的模块 → errors 包含该模块错误", async () => {
      const result = await loader.loadModules(["nonexistent"], runtimeMock);
      assert.ok(!result.loaded.includes("nonexistent"));
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].module, "nonexistent");
    });

    it("部分成功部分失败 → loaded + errors 都有内容", async () => {
      await createModuleFile("good_module", `
        export default {
          name: "good_module",
          getToolDefinitions: () => [],
          executeToolCall: async () => ({ result: "ok" }),
          init: async () => {},
          shutdown: async () => {}
        };
      `);
      const result = await loader.loadModules(["good_module", "bad_module"], runtimeMock);
      assert.ok(result.loaded.includes("good_module"));
      assert.strictEqual(result.errors.some((e) => e.module === "bad_module"), true);
    });

    it("加载后 _initialized = true", async () => {
      const result = await loader.loadModules([], runtimeMock);
      assert.strictEqual(result.loaded.length, 0);
      assert.strictEqual(loader._initialized, true);
    });

    it("设置 _runtime 引用", async () => {
      await loader.loadModules([], runtimeMock);
      assert.strictEqual(loader._runtime, runtimeMock);
    });

    it("空模块列表 → loaded = [], errors = []", async () => {
      const result = await loader.loadModules([], runtimeMock);
      assert.deepStrictEqual(result.loaded, []);
      assert.deepStrictEqual(result.errors, []);
    });

    it("带 toolGroupId/toolGroupDescription 的模块 → 注册进工具组时保留 id 与描述", async () => {
      await createModuleFile("desc_module", `
        export default {
          name: "desc_module",
          toolGroupId: "custom_group",
          toolGroupDescription: "自定义组描述（互相引用测试）",
          getToolDefinitions: () => [{ type: "function", function: { name: "desc_tool" } }],
          executeToolCall: async () => ({ result: "ok" }),
          init: async () => {},
          shutdown: async () => {}
        };
      `);
      const recRuntime = makeRecordingRuntimeMock();
      const result = await loader.loadModules(["desc_module"], recRuntime);
      assert.ok(result.loaded.includes("desc_module"));
      const reg = recRuntime._registered.find((r) => r.id === "custom_group");
      assert.ok(reg, "应以模块声明的 toolGroupId 注册");
      assert.strictEqual(reg.opts.description, "自定义组描述（互相引用测试）");
      assert.strictEqual(reg.opts.tools.length, 1);
      assert.strictEqual(reg.opts.tools[0].function.name, "desc_tool");
    });

    it("不带 toolGroupId/toolGroupDescription 的模块 → 注册时回退模块名与默认描述", async () => {
      await createModuleFile("bare_module", `
        export default {
          name: "bare_module",
          getToolDefinitions: () => [{ type: "function", function: { name: "bare_tool" } }],
          executeToolCall: async () => ({ result: "ok" }),
          init: async () => {},
          shutdown: async () => {}
        };
      `);
      const recRuntime = makeRecordingRuntimeMock();
      const result = await loader.loadModules(["bare_module"], recRuntime);
      assert.ok(result.loaded.includes("bare_module"));
      const reg = recRuntime._registered.find((r) => r.id === "bare_module");
      assert.ok(reg, "应以模块名作为组 id 回退");
      assert.strictEqual(reg.opts.description, "bare_module 模块提供的工具");
    });
  });

  // ==================== 延迟模块 ====================

  describe("延迟模块", () => {
    let loader, log, runtimeMock;

    beforeEach(async () => {
      log = makeTestLogger("ModuleLoader");
      loader = new ModuleLoader({ logger: log, modulesDir: TEST_MODULES_DIR });
      runtimeMock = makeRuntimeMock();

      if (existsSync(TEST_MODULES_DIR)) {
        await rm(TEST_MODULES_DIR, { recursive: true, force: true });
      }
      await mkdir(TEST_MODULES_DIR, { recursive: true });
    });

    afterEach(async () => {
      if (existsSync(TEST_MODULES_DIR)) {
        await rm(TEST_MODULES_DIR, { recursive: true, force: true });
      }
    });

    async function createLazyModule(name) {
      const dir = path.join(TEST_MODULES_DIR, name);
      await mkdir(dir, { recursive: true });
      let initCalled = false;
      // 使用全局变量来跟踪 init 调用
      await writeFile(path.join(dir, "index.js"), `
        if (!globalThis.__lazyModuleTracker) globalThis.__lazyModuleTracker = {};
        export default {
          name: "${name}",
          getToolDefinitions: () => [{ type: "function", function: { name: "${name}_tool" } }],
          executeToolCall: async () => ({ result: "lazy_ok" }),
          init: async () => { globalThis.__lazyModuleTracker["${name}"] = (globalThis.__lazyModuleTracker["${name}"] || 0) + 1; },
          shutdown: async () => {}
        };
      `);
    }

    it("lazy: true 的模块不调用 init()", async () => {
      globalThis.__lazyModuleTracker = {};
      await createLazyModule("lazy_mod");
      const result = await loader.loadModules({ lazy_mod: { lazy: true } }, runtimeMock);
      assert.ok(result.loaded.includes("lazy_mod"));
      assert.strictEqual(globalThis.__lazyModuleTracker["lazy_mod"], undefined);
    });

    it("延迟模块存于 _lazyModules", async () => {
      globalThis.__lazyModuleTracker = {};
      await createLazyModule("lazy_mod2");
      await loader.loadModules({ lazy_mod2: { lazy: true } }, runtimeMock);
      assert.strictEqual(loader._lazyModules.has("lazy_mod2"), true);
    });

    it("ensureModuleInitialized 对延迟模块调用 init()", async () => {
      globalThis.__lazyModuleTracker = {};
      await createLazyModule("lazy_mod3");
      await loader.loadModules({ lazy_mod3: { lazy: true } }, runtimeMock);
      await loader.ensureModuleInitialized("lazy_mod3");
      assert.strictEqual(globalThis.__lazyModuleTracker["lazy_mod3"], 1);
      assert.strictEqual(loader._lazyModules.has("lazy_mod3"), false);
    });

    it("ensureModuleInitialized 对已初始化模块不重复调用 init()", async () => {
      globalThis.__lazyModuleTracker = {};
      await createLazyModule("lazy_mod4");
      await loader.loadModules({ lazy_mod4: { lazy: true } }, runtimeMock);
      await loader.ensureModuleInitialized("lazy_mod4");
      // 再次调用 ensure，不应再调用 init
      await loader.ensureModuleInitialized("lazy_mod4");
      assert.strictEqual(globalThis.__lazyModuleTracker["lazy_mod4"], 1);
    });
  });

  // ==================== executeToolCall ====================

  describe("executeToolCall", () => {
    let loader, log;

    beforeEach(() => {
      log = makeTestLogger("ModuleLoader");
      loader = new ModuleLoader({ logger: log });
    });

    it("调用已加载模块的 executeToolCall", async () => {
      loader._modules.set("test", makeValidModule());
      loader._toolNameToModule.set("test_tool", "test");
      const result = await loader.executeToolCall({}, "test_tool", { k: "v" });
      assert.strictEqual(result.result, "ok");
      assert.strictEqual(result.toolName, "test_tool");
      assert.deepStrictEqual(result.args, { k: "v" });
    });

    it("调用不存在的工具返回错误结果", async () => {
      const result = await loader.executeToolCall({}, "unknown_tool", {});
      assert.strictEqual(result.error, "unknown_module_tool");
      assert.strictEqual(result.toolName, "unknown_tool");
    });

    it("模块未加载返回错误结果", async () => {
      loader._toolNameToModule.set("orphan_tool", "orphan_mod");
      const result = await loader.executeToolCall({}, "orphan_tool", {});
      assert.strictEqual(result.error, "module_not_loaded");
    });
  });

  // ==================== getToolDefinitions ====================

  describe("getToolDefinitions", () => {
    it("无模块时返回空数组", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      assert.deepStrictEqual(loader.getToolDefinitions(), []);
    });

    it("加载模块后包含模块的 tool definitions", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      const module = makeValidModule();
      loader._modules.set("test", module);
      const defs = loader.getToolDefinitions();
      assert.strictEqual(defs.length, 1);
      assert.strictEqual(defs[0].function.name, "test_tool");
    });
  });

  // ==================== hasToolName ====================

  describe("hasToolName", () => {
    it("已加载的 tool 返回 true", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      loader._toolNameToModule.set("test_tool", "test");
      assert.strictEqual(loader.hasToolName("test_tool"), true);
    });

    it("未加载的 tool 返回 false", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      assert.strictEqual(loader.hasToolName("unknown"), false);
    });
  });

  // ==================== getWebComponents ====================

  describe("getWebComponents", () => {
    it("无 web component 时返回空数组", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      loader._modules.set("test", makeValidModule());
      assert.deepStrictEqual(loader.getWebComponents(), []);
    });

    it("有 web component 的模块返回正确结构", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      const compData = { name: "TestPanel" };
      const module = makeValidModule({
        getWebComponent: () => compData
      });
      loader._modules.set("test", module);
      const comps = loader.getWebComponents();
      assert.strictEqual(comps.length, 1);
      assert.strictEqual(comps[0].moduleName, "test");
      assert.strictEqual(comps[0].component, compData);
    });
  });

  // ==================== getLoadedModules / getModule ====================

  describe("getLoadedModules / getModule", () => {
    it("getLoadedModules 返回正确的模块信息列表", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      const module = makeValidModule();
      loader._modules.set("test", module);
      const info = loader.getLoadedModules();
      assert.strictEqual(info.length, 1);
      assert.strictEqual(info[0].name, "test");
      assert.strictEqual(info[0].toolCount, 1);
    });

    it("getModule 返回模块实例，不存在的模块返回 null", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      const module = makeValidModule();
      loader._modules.set("test", module);
      assert.strictEqual(loader.getModule("test"), module);
      assert.strictEqual(loader.getModule("nonexistent"), null);
    });
  });

  // ==================== getModuleToolGroupId / getAllModuleToolGroupIds ====================

  describe("getModuleToolGroupId / getAllModuleToolGroupIds", () => {
    it("getModuleToolGroupId 未加载模块返回 null", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      assert.strictEqual(loader.getModuleToolGroupId("nonexistent"), null);
    });

    it("getAllModuleToolGroupIds 返回所有 tool group id", () => {
      const loader = new ModuleLoader({ logger: makeTestLogger("ModuleLoader") });
      loader._moduleToolGroupIds.set("mod1", "g1");
      loader._moduleToolGroupIds.set("mod2", "g2");
      const ids = loader.getAllModuleToolGroupIds();
      assert.ok(ids.includes("g1"));
      assert.ok(ids.includes("g2"));
    });
  });

  // ==================== shutdown ====================

  describe("shutdown", () => {
    it("shutdown 调用所有已加载模块的 shutdown()", async () => {
      const log = makeTestLogger("ModuleLoader");
      const loader = new ModuleLoader({ logger: log });
      let shutdownCalled = false;
      const module = makeValidModule({
        shutdown: async () => { shutdownCalled = true; }
      });
      loader._modules.set("test", module);
      await loader.shutdown();
      assert.strictEqual(shutdownCalled, true);
    });

    it("shutdown 跳过未初始化的延迟模块", async () => {
      const log = makeTestLogger("ModuleLoader");
      const loader = new ModuleLoader({ logger: log });
      let shutdownCalled = false;
      const module = makeValidModule({
        shutdown: async () => { shutdownCalled = true; }
      });
      loader._modules.set("lazy_mod", module);
      loader._lazyModules.set("lazy_mod", { moduleInstance: module, moduleConfig: {} });
      await loader.shutdown();
      assert.strictEqual(shutdownCalled, false);
    });

    it("isInitialized() 在 shutdown 前后正确反映状态", async () => {
      const log = makeTestLogger("ModuleLoader");
      const loader = new ModuleLoader({ logger: log });
      loader._initialized = true;
      assert.strictEqual(loader.isInitialized(), true);
      await loader.shutdown();
      assert.strictEqual(loader.isInitialized(), false);
    });
  });
});
