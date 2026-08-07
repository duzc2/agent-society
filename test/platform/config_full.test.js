/**
 * Config 模块 100% 覆盖率测试
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { Config } from "../../src/platform/utils/config/config.js";
import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const TEST_DIR = "test/.tmp/config_full_test";

describe("Config 100% Coverage", () => {
  let config;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("构造函数", () => {
    it("应创建实例", () => {
      config = new Config(TEST_DIR);
      assert.notStrictEqual(config, undefined);
      assert.strictEqual(config.configDir, path.resolve(process.cwd(), TEST_DIR));
    });

    it("应设置路径", () => {
      config = new Config(TEST_DIR);
      assert.strictEqual(config.appJsonPath, path.join(path.resolve(process.cwd(), TEST_DIR), "app.json"));
      assert.strictEqual(config.appLocalJsonPath, path.join(path.resolve(process.cwd(), TEST_DIR), "app.local.json"));
      assert.strictEqual(config.llmServicesJsonPath, path.join(path.resolve(process.cwd(), TEST_DIR), "llmservices.json"));
    });
  });

  describe("loadApp - 加载配置", () => {
    it("应加载基本配置", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        artifactsDir: "./artifacts",
        runtimeDir: "./runtime"
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.promptsDir, path.resolve(process.cwd(), "./prompts"));
      assert.notStrictEqual(result.workspacesDir, undefined);
      assert.notStrictEqual(result.runtimeDir, undefined);
      assert.strictEqual(result.maxSteps, 200);
      assert.strictEqual(result.maxToolRounds, 20000);
      assert.strictEqual(result.httpPort, 3000);
      assert.strictEqual(result.enableHttp, false);
    });

    it("应使用dataDir覆盖", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime"
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp({ dataDir: "./test-data" });

      assert.strictEqual(result.dataDir, path.resolve(process.cwd(), "./test-data"));
      assert.strictEqual(result.workspacesDir, path.resolve(process.cwd(), "./test-data/workspaces"));
      assert.strictEqual(result.runtimeDir, path.resolve(process.cwd(), "./test-data/state"));
    });

    it("应合并local配置", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      const localConfig = { promptsDir: "./local-prompts", runtimeDir: "./runtime", maxSteps: 30 };

      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "app.local.json"), JSON.stringify(localConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.promptsDir, path.resolve(process.cwd(), "./local-prompts"));
      assert.strictEqual(result.maxSteps, 30);
    });

    it("配置文件不存在时应报错", async () => {
      config = new Config(TEST_DIR);

      await assert.rejects(config.loadApp());
    });

    it("应处理无效JSON", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), "invalid json");

      config = new Config(TEST_DIR);
      await assert.rejects(config.loadApp());
    });

    it("应处理带LLM配置", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: {
          baseURL: "http://localhost:1234",
          model: "gpt-4",
          apiKey: "test-key",
          maxConcurrentRequests: 5
        }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.llm.baseURL, "http://localhost:1234");
      assert.strictEqual(result.llm.model, "gpt-4");
      assert.strictEqual(result.llm.maxConcurrentRequests, 5);
    });

    it("未配置 stream 时应回退到默认开启", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: {
          baseURL: "http://localhost:1234",
          model: "gpt-4"
        }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.llm.stream, true);
    });

    it("应加载logging配置", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        loggingConfigPath: "./test-logging.json"
      };
      const loggingConfig = { level: "debug", logsDir: "./logs" };

      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile("./test-logging.json", JSON.stringify(loggingConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.logging.level, "debug");

      await rm("./test-logging.json", { force: true });
    });

    it("应从modules.json加载模块配置", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      const modulesConfig = { testModule: { enabled: true }, chrome: {} };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(modulesConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.modules.testModule.enabled, true);
      assert.strictEqual(result.modules.chrome.enabled, undefined);
    });

    it("modules.json 不存在时应返回空对象", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.deepStrictEqual(result.modules, {});
    });

    it("应处理contextLimit", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        contextLimit: 4096
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.contextLimit, 4096);
    });
  });

  describe("getLlm / saveLlm - LLM配置", () => {
    it("应获取LLM配置", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: { baseURL: "http://test", model: "m", apiKey: "k" }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.getLlm();

      assert.strictEqual(result.llm.baseURL, "http://test");
      assert.strictEqual(result.source, "default");
    });

    it("应优先从local获取", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime", llm: { baseURL: "default" } };
      const localConfig = { promptsDir: "./prompts", runtimeDir: "./runtime", llm: { baseURL: "local" } };

      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "app.local.json"), JSON.stringify(localConfig));

      config = new Config(TEST_DIR);
      const result = await config.getLlm();

      assert.strictEqual(result.llm.baseURL, "local");
      assert.strictEqual(result.source, "local");
    });

    it("应保存LLM配置", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        baseURL: "http://new-url.com",
        model: "new-model",
        apiKey: "new-key"
      });

      const saved = await config.getLlm();
      assert.strictEqual(saved.llm.baseURL, "http://new-url.com");
      assert.strictEqual(saved.llm.model, "new-model");
    });

    it("保存时应保留 provider 字段", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        provider: "open-responses",
        baseURL: "http://localhost:1234/v1",
        model: "test-model",
        apiKey: "test-key"
      });

      const saved = await config.getLlm();
      assert.strictEqual(saved.llm.provider, "open-responses");
    });

    it("保存时应保留现有apiKey", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime", llm: { apiKey: "existing-key" } };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "app.local.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        baseURL: "http://new.com",
        model: "m"
      });

      const saved = await config.getLlm();
      assert.strictEqual(saved.llm.apiKey, "existing-key");
    });

    it("保存时未传能力字段应保留现有工具调用能力", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: {
          baseURL: "http://old",
          model: "old-model",
          apiKey: "existing-key",
          capabilityTags: ["text", "tool_calling"],
          capabilities: {
            input: ["text"],
            output: ["text", "tool_calling"]
          }
        }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "app.local.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        baseURL: "http://new.com",
        model: "m"
      });

      const saved = await config.getLlm();
      assert.deepStrictEqual(saved.llm.capabilityTags, ["text", "tool_calling"]);
      assert.deepStrictEqual(saved.llm.capabilities.output, ["text", "tool_calling"]);
    });

    it("保存时缺少能力字段应回退到支持工具调用的默认能力", async () => {
      const appConfig = { promptsDir: "./prompts", runtimeDir: "./runtime" };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        baseURL: "http://new-url.com",
        model: "new-model",
        apiKey: "new-key"
      });

      const saved = await config.getLlm();
      assert.deepStrictEqual(saved.llm.capabilityTags, ["text", "tool_calling"]);
      assert.deepStrictEqual(saved.llm.capabilities, {
        input: ["text"],
        output: ["text", "tool_calling"]
      });
    });

    it("保存时未传 stream 应保留现有值", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: {
          baseURL: "http://old",
          model: "old-model",
          stream: false
        }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));
      await writeFile(path.join(TEST_DIR, "app.local.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      await config.saveLlm({
        baseURL: "http://new.com",
        model: "new-model"
      });

      const saved = await config.getLlm();
      assert.strictEqual(saved.llm.stream, false);
    });

    it("配置文件不存在时应报错", async () => {
      config = new Config(TEST_DIR);

      await assert.rejects(config.saveLlm({ baseURL: "http://test", model: "m" }));
    });
  });

  describe("validateLlm - 验证LLM配置", () => {
    beforeEach(() => {
      config = new Config(TEST_DIR);
    });

    it("应验证有效配置", () => {
      const result = config.validateLlm({ baseURL: "http://test", model: "m" });
      assert.strictEqual(result.valid, true);
    });

    it("应拒绝空baseURL", () => {
      const result = config.validateLlm({ baseURL: "", model: "m" });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.baseURL, undefined);
    });

    it("应拒绝空model", () => {
      const result = config.validateLlm({ baseURL: "http://test", model: "" });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.model, undefined);
    });

    it("应拒绝非字符串baseURL", () => {
      const result = config.validateLlm({ baseURL: 123, model: "m" });
      assert.strictEqual(result.valid, false);
    });

    it("应拒绝非字符串model", () => {
      const result = config.validateLlm({ baseURL: "http://test", model: 123 });
      assert.strictEqual(result.valid, false);
    });

    it("应验证 provider 枚举值", () => {
      const result = config.validateLlm({ provider: "open-responses", baseURL: "http://test", model: "m" });
      assert.strictEqual(result.valid, true);
    });

    it("应拒绝不支持的 provider", () => {
      const result = config.validateLlm({ provider: "unknown-provider", baseURL: "http://test", model: "m" });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.provider, undefined);
    });

    it("应拒绝非布尔 stream", () => {
      const result = config.validateLlm({ baseURL: "http://test", model: "m", stream: "true" });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.stream, undefined);
    });
  });

  describe("getServices / addService / updateService / deleteService - 服务管理", () => {
    it("空服务返回空数组", async () => {
      config = new Config(TEST_DIR);
      const result = await config.getServices();

      assert.deepStrictEqual(result.services, []);
      assert.strictEqual(result.source, "none");
    });

    it("应添加服务", async () => {
      config = new Config(TEST_DIR);

      const service = {
        id: "service-1",
        name: "Service 1",
        baseURL: "http://s1.com",
        model: "m1",
        apiKey: "k1"
      };

      const added = await config.addService(service);

      assert.strictEqual(added.id, "service-1");
      assert.ok(added.apiKey.includes("****"));

      const list = await config.getServices();
      assert.strictEqual(list.services.length, 1);
    });

    it("添加服务时应保存 provider", async () => {
      config = new Config(TEST_DIR);

      await config.addService({
        id: "service-open-responses",
        name: "Open Responses Service",
        provider: "open-responses",
        baseURL: "http://localhost:1234/v1",
        model: "m1",
        apiKey: "k1"
      });

      const list = await config.getServices();
      assert.strictEqual(list.services[0].provider, "open-responses");
    });

    it("应拒绝重复ID", async () => {
      config = new Config(TEST_DIR);

      await config.addService({ id: "s1", name: "S1", baseURL: "http://t", model: "m" });

      await assert.rejects(config.addService({ id: "s1", name: "S2", baseURL: "http://t", model: "m" }));
    });

    it("应更新服务", async () => {
      config = new Config(TEST_DIR);

      await config.addService({ id: "s1", name: "Original", baseURL: "http://old", model: "m" });

      const updated = await config.updateService("s1", { id: "s1", name: "Updated", baseURL: "http://new", model: "m" });

      assert.strictEqual(updated.name, "Updated");

      const list = await config.getServices();
      assert.strictEqual(list.services[0].name, "Updated");
    });

    it("更新服务时应保留 provider", async () => {
      config = new Config(TEST_DIR);

      await config.addService({
        id: "s-open-responses",
        name: "Original",
        provider: "open-responses",
        baseURL: "http://old",
        model: "m"
      });

      await config.updateService("s-open-responses", {
        id: "s-open-responses",
        name: "Updated",
        baseURL: "http://new",
        model: "m"
      });

      const list = await config.getServices();
      assert.strictEqual(list.services[0].provider, "open-responses");
    });

    it("更新不存在服务应报错", async () => {
      config = new Config(TEST_DIR);

      await assert.rejects(config.updateService("non-existent", { id: "x", name: "X", baseURL: "http://t", model: "m" }));
    });

    it("应删除服务", async () => {
      config = new Config(TEST_DIR);

      await config.addService({ id: "s1", name: "S1", baseURL: "http://t", model: "m" });
      await config.deleteService("s1");

      const list = await config.getServices();
      assert.strictEqual(list.services.length, 0);
    });

    it("删除不存在服务应报错", async () => {
      config = new Config(TEST_DIR);

      await assert.rejects(config.deleteService("non-existent"));
    });

    it("应设置默认maxConcurrentRequests", async () => {
      config = new Config(TEST_DIR);

      const added = await config.addService({ id: "s1", name: "S1", baseURL: "http://t", model: "m" });

      assert.strictEqual(added.maxConcurrentRequests, 2);
    });

    it("添加服务时 stream 默认应为 true", async () => {
      config = new Config(TEST_DIR);

      const added = await config.addService({ id: "s2", name: "S2", baseURL: "http://t", model: "m" });

      assert.strictEqual(added.stream, true);
      const list = await config.getServices();
      assert.strictEqual(list.services[0].stream, true);
    });

    it("更新服务时未传 stream 应保留原值", async () => {
      config = new Config(TEST_DIR);

      await config.addService({ id: "s3", name: "S3", baseURL: "http://t", model: "m", stream: false });
      await config.updateService("s3", { id: "s3", name: "S3-new", baseURL: "http://t2", model: "m2" });

      const list = await config.getServices();
      assert.strictEqual(list.services[0].stream, false);
    });
  });

  describe("validateService - 验证服务配置", () => {
    beforeEach(() => {
      config = new Config(TEST_DIR);
    });

    it("应验证有效服务", () => {
      const result = config.validateService({ id: "s1", name: "S1", baseURL: "http://t", model: "m", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, true);
    });

    it("应拒绝缺少id", () => {
      const result = config.validateService({ name: "S1", baseURL: "http://t", model: "m", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.id, undefined);
    });

    it("应拒绝空id", () => {
      const result = config.validateService({ id: "", name: "S1", baseURL: "http://t", model: "m", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, false);
    });

    it("应拒绝缺少name", () => {
      const result = config.validateService({ id: "s1", baseURL: "http://t", model: "m", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, false);
    });

    it("应拒绝缺少baseURL", () => {
      const result = config.validateService({ id: "s1", name: "S1", model: "m", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, false);
    });

    it("应拒绝缺少model", () => {
      const result = config.validateService({ id: "s1", name: "S1", baseURL: "http://t", capabilityTags: ["文本对话"] });
      assert.strictEqual(result.valid, false);
    });

    it("应接受任意字符串能力标签（值校验由 _normalizeLlmCapabilityTags 负责）", () => {
      const result = config.validateService({ id: "s1", name: "S1", baseURL: "http://t", model: "m", capabilityTags: ["随便写"] });
      // validateService 只校验 capabilityTags 是否为数组，不校验具体值
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.capabilityTags, undefined);
    });

    it("应验证服务 provider 枚举值", () => {
      const result = config.validateService({
        id: "s1",
        name: "S1",
        provider: "open-responses",
        baseURL: "http://t",
        model: "m",
        capabilityTags: ["文本对话"]
      });
      assert.strictEqual(result.valid, true);
    });

    it("应拒绝不支持的服务 provider", () => {
      const result = config.validateService({
        id: "s1",
        name: "S1",
        provider: "invalid-provider",
        baseURL: "http://t",
        model: "m",
        capabilityTags: ["文本对话"]
      });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.provider, undefined);
    });

    it("应拒绝服务配置中的非布尔 stream", () => {
      const result = config.validateService({
        id: "s1",
        name: "S1",
        baseURL: "http://t",
        model: "m",
        capabilityTags: ["文本对话"],
        stream: "true"
      });
      assert.strictEqual(result.valid, false);
      assert.notStrictEqual(result.errors.stream, undefined);
    });
  });

  describe("辅助方法", () => {
    it("hasLocalApp应检查本地配置存在", async () => {
      config = new Config(TEST_DIR);
      assert.strictEqual(config.hasLocalApp(), false);

      await writeFile(path.join(TEST_DIR, "app.local.json"), "{}");
      assert.strictEqual(config.hasLocalApp(), true);
    });

    it("hasLocalServices应检查本地服务配置", async () => {
      config = new Config(TEST_DIR);
      assert.strictEqual(config.hasLocalServices(), false);

      await writeFile(path.join(TEST_DIR, "llmservices.local.json"), "{\"services\":[]}");
      assert.strictEqual(config.hasLocalServices(), true);
    });

    it("maskApiKey应掩码API密钥", () => {
      config = new Config(TEST_DIR);

      assert.strictEqual(config.maskApiKey("sk-1234567890abcdef"), "****cdef");
      assert.strictEqual(config.maskApiKey("short"), "****hort");  // > 4 chars, shows last 4
      assert.strictEqual(config.maskApiKey("tiny"), "****");  // <= 4 chars
      assert.strictEqual(config.maskApiKey(""), "****");
      assert.strictEqual(config.maskApiKey(null), "****");
    });
  });

  describe("模块配置 — _loadModulesFromFiles / getModules / saveModules", () => {
    const catalog = { chrome: {}, ssh: { lazy: true }, automation: { lazy: true } };

    it("modules.json 存在且无 modules.enabled.json → 全部启用", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 3);
      assert.strictEqual(result.modules.ssh.lazy, true);
    });

    it("modules.enabled.json 中 enableAll 不为 false → 全部启用", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), JSON.stringify({ enableAll: true }));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 3);
    });

    it("modules.enabled.json 中 enableAll=false 且 enabled 有子集 → 仅返回子集", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), JSON.stringify({ enableAll: false, enabled: ["chrome", "ssh"] }));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 2);
      assert.ok(result.modules.chrome);
      assert.ok(result.modules.ssh);
      assert.strictEqual(result.modules.automation, undefined);
    });

    it("modules.enabled.json 中 enableAll=false 且 enabled 为空 → 返回空", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), JSON.stringify({ enableAll: false, enabled: [] }));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 0);
    });

    it("modules.enabled.json 中的 enabled 包含不在 catalog 的名称 → 被过滤", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), JSON.stringify({ enableAll: false, enabled: ["chrome", "ghost_module"] }));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 1);
      assert.ok(result.modules.chrome);
    });

    it("getModules 应返回 enableAll 和 enabled 字段", async () => {
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));

      config = new Config(TEST_DIR);
      const result = await config.getModules();
      assert.strictEqual(result.enableAll, true);
      assert.deepStrictEqual(result.enabled, ["chrome", "ssh", "automation"]);
      assert.strictEqual(result.source, "default");
    });

    it("getModules 有 modules.enabled.json 时 enableAll=false 应返回 enabled 列表", async () => {
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), JSON.stringify({ enableAll: false, enabled: ["chrome"] }));

      config = new Config(TEST_DIR);
      const result = await config.getModules();
      assert.strictEqual(result.enableAll, false);
      assert.deepStrictEqual(result.enabled, ["chrome"]);
      assert.strictEqual(result.source, "local");
    });

    it("saveModules enableAll=true → 写入 enableAll:true", async () => {
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));

      config = new Config(TEST_DIR);
      await config.saveModules({ enableAll: true, enabled: [] });

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path.join(TEST_DIR, "modules.enabled.json"), "utf8");
      const saved = JSON.parse(raw);
      assert.strictEqual(saved.enableAll, true);
      assert.strictEqual(saved.enabled, undefined);
    });

    it("saveModules enableAll=false → 写入 enabled 列表", async () => {
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));

      config = new Config(TEST_DIR);
      await config.saveModules({ enableAll: false, enabled: ["chrome", "ssh"] });

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path.join(TEST_DIR, "modules.enabled.json"), "utf8");
      const saved = JSON.parse(raw);
      assert.strictEqual(saved.enableAll, false);
      assert.deepStrictEqual(saved.enabled, ["chrome", "ssh"]);
    });

    it("modules.enabled.json 损坏时回退到全部启用", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "modules.json"), JSON.stringify(catalog));
      await writeFile(path.join(TEST_DIR, "modules.enabled.json"), "invalid json{{{");

      config = new Config(TEST_DIR);
      const result = await config.loadApp();
      assert.strictEqual(Object.keys(result.modules).length, 3);
    });
  });

  describe("边界条件", () => {
    it("应处理无效maxConcurrentRequests", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: { maxConcurrentRequests: -1 }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.llm.maxConcurrentRequests, 3);
    });

    it("应处理非数字maxConcurrentRequests", async () => {
      const appConfig = {
        promptsDir: "./prompts",
        runtimeDir: "./runtime",
        llm: { maxConcurrentRequests: "invalid" }
      };
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfig));

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.strictEqual(result.llm.maxConcurrentRequests, 3);
    });

    it("应处理无效LLM服务配置", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify({ promptsDir: "./p", runtimeDir: "./r" }));
      await writeFile(path.join(TEST_DIR, "llmservices.local.json"), "invalid json");

      config = new Config(TEST_DIR);
      const result = await config.loadApp();

      assert.deepStrictEqual(result.llmServices.services, []);
    });

    it("应处理带capabilities的服务", async () => {
      config = new Config(TEST_DIR);

      const added = await config.addService({
        id: "s1",
        name: "S1",
        baseURL: "http://t",
        model: "m",
        capabilities: { input: ["image"], output: ["text"] }
      });

      assert.ok(added.capabilities.input.includes("image"));
    });
  });

  describe("setDefaultLlmFromService - 将服务配置设为默认LLM", () => {
    const appConfigWithLlm = {
      promptsDir: "./p",
      runtimeDir: "./r",
      llm: { provider: "openai", baseURL: "http://old", model: "old-model", apiKey: "old-key", maxTokens: 2048 }
    };

    it("应将服务配置完整复制到默认 LLM，包括 apiKey", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await config.addService({
        id: "svc",
        name: "Test Service",
        provider: "anthropic",
        baseURL: "http://svc.com",
        model: "svc-model",
        apiKey: "svc-real-key",
        maxTokens: 8192,
        maxConcurrentRequests: 8,
        timeout: 60000,
        stream: false,
        capabilityTags: ["vision", "tool_calling"],
        capabilities: { input: ["text", "vision"], output: ["text", "tool_calling"] },
        thinking: { type: "enabled", budgetTokens: 4000 },
        description: "test desc",
        enabled: false
      });

      const result = await config.setDefaultLlmFromService("svc");
      const saved = await config.getLlm();

      assert.strictEqual(saved.llm.provider, "anthropic");
      assert.strictEqual(saved.llm.baseURL, "http://svc.com");
      assert.strictEqual(saved.llm.model, "svc-model");
      assert.strictEqual(saved.llm.apiKey, "svc-real-key");
      assert.strictEqual(saved.llm.maxTokens, 8192);
      assert.strictEqual(saved.llm.maxConcurrentRequests, 8);
      assert.strictEqual(saved.llm.timeout, 60000);
      assert.strictEqual(saved.llm.stream, false);
      assert.deepStrictEqual(saved.llm.capabilityTags, ["vision", "tool_calling"]);
      assert.deepStrictEqual(saved.llm.capabilities, { input: ["text", "vision"], output: ["text", "tool_calling"] });
      assert.deepStrictEqual(saved.llm.thinking, { type: "enabled", budgetTokens: 4000 });
    });

    it("应排除服务的非 LLM 配置字段", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await config.addService({
        id: "svc2",
        name: "Named Svc",
        provider: "openai",
        baseURL: "http://s2.com",
        model: "m2",
        apiKey: "k2",
        description: "my description",
        enabled: false
      });

      await config.setDefaultLlmFromService("svc2");
      const saved = await config.getLlm();

      assert.strictEqual(saved.llm.provider, "openai");
      assert.strictEqual(saved.llm.model, "m2");
      assert.strictEqual(saved.llm.apiKey, "k2");
      assert.strictEqual(saved.llm.id, undefined);
      assert.strictEqual(saved.llm.name, undefined);
      assert.strictEqual(saved.llm.description, undefined);
      assert.strictEqual(saved.llm.enabled, undefined);
    });

    it("返回值中 apiKey 应为掩码值", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await config.addService({
        id: "svc3",
        name: "S3",
        baseURL: "http://s3.com",
        model: "m3",
        apiKey: "sk-secret-key-123456"
      });

      const result = await config.setDefaultLlmFromService("svc3");

      assert.ok(result.apiKey.includes("****"));
      assert.ok(result.apiKey.endsWith("3456"));
    });

    it("服务不存在时应抛出错误", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await assert.rejects(
        config.setDefaultLlmFromService("nonexistent"),
        /不存在/
      );
    });

    it("应将中文服务能力标签映射为英文 LLM 标签", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await config.addService({
        id: "svc-cn-tags",
        name: "中文标签服务",
        baseURL: "http://cn.com",
        model: "cn-model",
        apiKey: "k-cn",
        capabilityTags: ["工具调用", "视觉理解", "编程", "指令遵从", "代码生成"]
      });

      await config.setDefaultLlmFromService("svc-cn-tags");
      const saved = await config.getLlm();

      assert.deepStrictEqual(saved.llm.capabilityTags, ["tool_calling", "vision", "coding"]);
    });

    it("无 app.local.json 时应从 app.json 自动创建", async () => {
      await writeFile(path.join(TEST_DIR, "app.json"), JSON.stringify(appConfigWithLlm));
      config = new Config(TEST_DIR);

      await config.addService({
        id: "svc4",
        name: "S4",
        baseURL: "http://s4.com",
        model: "m4",
        apiKey: "k4"
      });

      const beforeCall = existsSync(path.join(TEST_DIR, "app.local.json"));
      assert.strictEqual(beforeCall, false);

      await config.setDefaultLlmFromService("svc4");

      const afterCall = existsSync(path.join(TEST_DIR, "app.local.json"));
      assert.strictEqual(afterCall, true);
    });
  });
});
