import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// mock.fn polyfill for node:test compatibility with bun
function mockFn(impl) {
  const calls = [];
  const fn = (...args) => { calls.push({ arguments: args }); return impl ? impl(...args) : undefined; };
  fn.mock = { calls, resetCalls: () => { calls.length = 0; }, callCount: () => calls.length };
  return fn;
}

// @ts-ignore - 测试中使用简化类型
import fc from "fast-check";
import { Config } from "../../src/platform/utils/config/config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

describe("Config Concurrency Support", () => {
  const testConfigDir = "test/.tmp/config_test";
  let originalConsoleWarn;

  beforeEach(async () => {
    // 创建测试目录
    await mkdir(testConfigDir, { recursive: true });

    // Mock console.warn to capture warnings
    originalConsoleWarn = console.warn;
    /** @type {any} */
    const mockWarn = mockFn();
    console.warn = mockWarn;
  });

  afterEach(async () => {
    // 清理测试目录
    await rm(testConfigDir, { recursive: true, force: true });

    // 恢复console.warn
    console.warn = originalConsoleWarn;
  });

  // **Feature: llm-concurrency-control, Property 1: Configuration Loading and Validation**
  describe("Property 1: Configuration Loading and Validation", () => {
    it("对于任何app.json配置文件，系统应正确读取maxConcurrentLlmRequests值，未指定时使用默认值，无效值时使用默认值并警告", async () => {
      await fc.assert(fc.asyncProperty(
        fc.oneof(
          fc.constant(undefined), // 未配？
          fc.constant(null), // null？
          fc.integer({ min: 1, max: 10 }), // 有效？
          fc.integer({ min: -10, max: 0 }), // 无效值（非正数）
          fc.float(), // 无效值（小数？
          fc.string(), // 无效值（字符串）
          fc.boolean() // 无效值（布尔值）
        ),
        async (maxConcurrentRequests) => {
          // 生成值经 JSON.stringify 落盘后可能变形：Infinity/NaN 会静默写成 null，
          // undefined 则让整个键消失。断言必须基于落盘后的实际值，否则生成值与磁盘内容不一致。
          const effective = maxConcurrentRequests === undefined
            ? undefined
            : JSON.parse(JSON.stringify(maxConcurrentRequests));

          // 创建测试配置
          const config = {
            promptsDir: "config/prompts",
            artifactsDir: "data/runtime/artifacts",
            runtimeDir: "data/runtime/state",
            llm: {
              baseURL: "http://localhost:1234/v1",
              model: "test-model",
              apiKey: "test-key"
            }
          };

          // 只有当值不是undefined时才添加maxConcurrentRequests
          if (effective !== undefined) {
            config.llm.maxConcurrentRequests = effective;
          }

          const configPath = path.join(testConfigDir, "app.json");
          await writeFile(configPath, JSON.stringify(config, null, 2));

          // 重置console.warn mock
          // @ts-ignore - mock 方法
          console.warn.mock.resetCalls();

          // 加载配置
          const configManager = new Config(testConfigDir);
          const loadedConfig = await configManager.loadApp();

          // 验证结果
          assert.notStrictEqual(loadedConfig.llm, undefined);
          assert.strictEqual(typeof loadedConfig.llm.maxConcurrentRequests, "number");

          if (effective === undefined || effective === null) {
            // 未配置或null时应使用默认值
            assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 3);
            assert.strictEqual(console.warn.mock.callCount(), 0);
          } else if (Number.isInteger(effective) && effective > 0) {
            // 有效值时应使用配置值
            assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, effective);
            assert.strictEqual(console.warn.mock.callCount(), 0);
          } else {
            // 无效值时应使用默认值并记录警告
            assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 3);
            // 验证 console.warn 被调用且参数包含预期内容
            // @ts-ignore - mock 方法
            assert.ok(console.warn.mock.callCount() > 0);
            // @ts-ignore - mock 方法
            const warnCall = console.warn.mock.calls[0];
            assert.ok(String(warnCall.arguments[0]).includes(`Invalid maxConcurrentRequests value: ${effective}`));
          }
        }
      ), { numRuns: 100 });
    });
  });

  // **Feature: llm-concurrency-control, Property 2: Dynamic Configuration Updates**
  describe("Property 2: Dynamic Configuration Updates", () => {
    it("对于任何运行时配置更改，并发控制器应动态调整并发请求限制而不中断活跃请求", async () => {
      // 注意：这个属性测试主要验证配置加载的正确？
      // 动态更新的测试将在ConcurrencyController的测试中进行
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        async (initialValue, newValue) => {
          // 创建初始配置
          const initialConfig = {
            promptsDir: "config/prompts",
            artifactsDir: "data/runtime/artifacts",
            runtimeDir: "data/runtime/state",
            llm: {
              baseURL: "http://localhost:1234/v1",
              model: "test-model",
              apiKey: "test-key",
              maxConcurrentRequests: initialValue
            }
          };

          const configPath = path.join(testConfigDir, "app.json");
          await writeFile(configPath, JSON.stringify(initialConfig, null, 2));

          // 加载初始配置
          const configManager1 = new Config(testConfigDir);
          const loadedConfig1 = await configManager1.loadApp();
          assert.strictEqual(loadedConfig1.llm.maxConcurrentRequests, initialValue);

          // 更新配置
          const updatedConfig = {
            ...initialConfig,
            llm: {
              ...initialConfig.llm,
              maxConcurrentRequests: newValue
            }
          };

          await writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

          // 重新加载配置
          const configManager2 = new Config(testConfigDir);
          const loadedConfig2 = await configManager2.loadApp();
          assert.strictEqual(loadedConfig2.llm.maxConcurrentRequests, newValue);
        }
      ), { numRuns: 50 });
    });
  });

  describe("单元测试", () => {
    it("应正确处理完整的配置文件", async () => {
      const config = {
        promptsDir: "config/prompts",
        artifactsDir: "data/runtime/artifacts",
        runtimeDir: "data/runtime/state",
        llm: {
          baseURL: "http://localhost:1234/v1",
          model: "test-model",
          apiKey: "test-key",
          maxConcurrentRequests: 5
        }
      };

      const configPath = path.join(testConfigDir, "app.json");
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const configManager = new Config(testConfigDir);
      const loadedConfig = await configManager.loadApp();

      assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 5);
    });

    it("应在缺少maxConcurrentRequests时使用默认值", async () => {
      const config = {
        promptsDir: "config/prompts",
        artifactsDir: "data/runtime/artifacts",
        runtimeDir: "data/runtime/state",
        llm: {
          baseURL: "http://localhost:1234/v1",
          model: "test-model",
          apiKey: "test-key"
          // 没有maxConcurrentRequests
        }
      };

      const configPath = path.join(testConfigDir, "app.json");
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const configManager = new Config(testConfigDir);
      const loadedConfig = await configManager.loadApp();

      assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 3);
      assert.strictEqual(console.warn.mock.callCount(), 0);
    });

    it("应在无效值时使用默认值并记录警告", async () => {
      const testCases = [
        { value: 0, description: "零值" },
        { value: -1, description: "负数" },
        { value: 1.5, description: "小数" },
        { value: "invalid", description: "字符串" },
        { value: true, description: "布尔值" },
        { value: [], description: "数组" },
        { value: {}, description: "对象" }
      ];

      for (const testCase of testCases) {
        const config = {
          promptsDir: "config/prompts",
          artifactsDir: "data/runtime/artifacts",
          runtimeDir: "data/runtime/state",
          llm: {
            baseURL: "http://localhost:1234/v1",
            model: "test-model",
            apiKey: "test-key",
            maxConcurrentRequests: testCase.value
          }
        };

        const configPath = path.join(testConfigDir, "app.json");
        await writeFile(configPath, JSON.stringify(config, null, 2));

        // @ts-ignore - mock 方法
        console.warn.mock.resetCalls();

        const configManager = new Config(testConfigDir);
        const loadedConfig = await configManager.loadApp();

        assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 3);
        // 验证 console.warn 被调用且参数包含预期内容
        // @ts-ignore - mock 方法
        assert.ok(console.warn.mock.callCount() > 0);
        // @ts-ignore - mock 方法
        const warnCall = console.warn.mock.calls[0];
        assert.ok(String(warnCall.arguments[0]).includes(`Invalid maxConcurrentRequests value: ${testCase.value}`));
      }
    });

    it("应正确处理null值", async () => {
      const config = {
        promptsDir: "config/prompts",
        artifactsDir: "data/runtime/artifacts",
        runtimeDir: "data/runtime/state",
        llm: {
          baseURL: "http://localhost:1234/v1",
          model: "test-model",
          apiKey: "test-key",
          maxConcurrentRequests: null
        }
      };

      const configPath = path.join(testConfigDir, "app.json");
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const configManager = new Config(testConfigDir);
      const loadedConfig = await configManager.loadApp();

      assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, 3);
      assert.strictEqual(console.warn.mock.callCount(), 0);
    });

    it("应正确处理边界值", async () => {
      const testCases = [1, 100, 1000];

      for (const value of testCases) {
        const config = {
          promptsDir: "config/prompts",
          artifactsDir: "data/runtime/artifacts",
          runtimeDir: "data/runtime/state",
          llm: {
            baseURL: "http://localhost:1234/v1",
            model: "test-model",
            apiKey: "test-key",
            maxConcurrentRequests: value
          }
        };

        const configPath = path.join(testConfigDir, "app.json");
        await writeFile(configPath, JSON.stringify(config, null, 2));

        // @ts-ignore - mock 方法
        console.warn.mock.resetCalls();

        const configManager = new Config(testConfigDir);
        const loadedConfig = await configManager.loadApp();

        assert.strictEqual(loadedConfig.llm.maxConcurrentRequests, value);
        // @ts-ignore - mock 方法
        assert.strictEqual(console.warn.mock.callCount(), 0);
      }
    });
  });
});
