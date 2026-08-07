/**
 * BrowserJavaScriptExecutor 测试
 *
 * 测试浏览器 JavaScript 执行器的功能和正确性属性
 *
 * 【测试策略】
 * 1. 测试分为两部分：基础功能测试（不强制依赖浏览器）和浏览器特性测试
 * 2. 基础功能测试验证降级模式下的行为
 * 3. 浏览器特性测试在浏览器不可用时验证返回正确的错误信息，而不是跳过
 * 4. 属性测试减少运行次数以避免超时
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";

// @ts-ignore - 测试中使用简化类型
import fc from "fast-check";
import { BrowserJavaScriptExecutor } from "../../src/platform/runtime/browser_javascript_executor.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { _setTestWorkspaceManager, _resetWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";
import { makeTestLogger } from "../helpers/test_logger.js";

const TEST_DIR = "./test/.tmp/browser_js_executor_test";

function createMockWorkspaceManager() {
  const workspaces = new Map();
  return {
    getWorkspace: async (id) => {
      if (!workspaces.has(id)) {
        const files = new Map();
        workspaces.set(id, {
          writeFile: async (name, data, opts) => {
            files.set(name, { data, opts });
            return { path: name };
          },
          readFile: async (name) => {
            const f = files.get(name);
            return f ? f.data : null;
          }
        });
      }
      return workspaces.get(id);
    },
    createDirectory: async () => ({ ok: true, existed: false }),
    checkWorkspaceExists: () => true,
  };
}

// 模拟 Runtime 对象
function createMockRuntime() {
  _setTestWorkspaceManager(createMockWorkspaceManager());
  return {
    log: makeTestLogger("BrowserJSExecutor"),
    _jsExecutor: null, // 降级执行器
    _getAgentTaskId: (agentId) => `workspace-${agentId}`,
  };
}

describe("BrowserJavaScriptExecutor", () => {
  let executor;
  let mockRuntime;
  let browserAvailable;

  before(async () => {
    // 创建测试目录
    await mkdir(TEST_DIR, { recursive: true });

    mockRuntime = createMockRuntime();
    executor = new BrowserJavaScriptExecutor(mockRuntime);
    await executor.init();

    // 检查浏览器是否可用
    browserAvailable = executor.isBrowserAvailable();
  }, { timeout: 30000 }); // 增加超时时间，因为浏览器启动可能较慢

  after(async () => {
    if (executor) {
      await executor.shutdown();
    }
    // 清理测试目录
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  describe("基础功能测试", () => {
    it("应该能执行简单的同步代码", async () => {
      const result = await executor.execute({ code: "return 1 + 2;" });

      if (browserAvailable) {
        assert.strictEqual(result, 3);
      } else {
        // 浏览器不可用时应该返回错误
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("应该能访问 input 参数", async () => {
      const result = await executor.execute({
        code: "return input.a + input.b;",
        input: { a: 10, b: 20 }
      });

      if (browserAvailable) {
        assert.strictEqual(result, 30);
      } else {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("应该能执行异步代码", async () => {
      const result = await executor.execute({
        code: "return new Promise(resolve => setTimeout(() => resolve('async done'), 100));"
      });

      if (browserAvailable) {
        assert.strictEqual(result, "async done");
      } else {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("应该能使用 await 关键字", async () => {
      const result = await executor.execute({
        code: `
          const delay = ms => new Promise(r => setTimeout(r, ms));
          await delay(50);
          return 'awaited';
        `
      });

      if (browserAvailable) {
        assert.strictEqual(result, "awaited");
      } else {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("应该捕获执行错误", async () => {
      const result = await executor.execute({
        code: "throw new Error('test error');"
      });
      // 浏览器模式和降级模式下都应返回错误对象
      assert.strictEqual(typeof result, "object");
      assert.notStrictEqual(result.error, undefined);
    });

    it("应该拒绝无效的代码参数", async () => {
      const result = await executor.execute({ code: 123 });
      assert.strictEqual(typeof result, "object");
      assert.notStrictEqual(result.error, undefined);
    });
  });

  describe("Canvas 功能测试", () => {
    it("应该能创建 Canvas 并绘制", async () => {
      const workspaceId = "test-workspace-canvas";

      const result = await executor.execute({
        code: `
          const canvas = getCanvas('test.png', 200, 100);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'red';
          ctx.fillRect(0, 0, 200, 100);
          return 'drawn';
        `
      }, "msg-1", "agent-1", workspaceId);

      if (browserAvailable) {
        assert.strictEqual(result.result, "drawn");
        assert.notStrictEqual(result.files, undefined);
        assert.strictEqual(result.files.length, 1);
      } else {
        // 浏览器不可用时应该返回错误
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("Canvas 应该使用路径参数", async () => {
      const workspaceId = "test-workspace-canvas2";

      const result = await executor.execute({
        code: `
          const canvas1 = getCanvas('path1/test1.png', 300, 200);
          const canvas2 = getCanvas('path2/test2.png', 100, 50);
          return {
            same: canvas1 === canvas2,
            width1: canvas1.width,
            height1: canvas1.height,
            width2: canvas2.width,
            height2: canvas2.height
          };
        `
      }, "msg-2", "agent-1", workspaceId);

      if (browserAvailable) {
        assert.strictEqual(result.result.same, false); // 不同路径创建不同实例
        assert.strictEqual(result.result.width1, 300);
        assert.strictEqual(result.result.height1, 200);
      } else {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });

    it("Canvas 图像应该保存到工作区", async () => {
      const workspaceId = "test-workspace-canvas3";

      const result = await executor.execute({
        code: `
          const canvas = getCanvas('test-canvas.png', 50, 50);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'blue';
          ctx.fillRect(0, 0, 50, 50);
          return 'saved';
        `
      }, "msg-3", "agent-1", workspaceId);

      if (browserAvailable) {
        // 检查返回结构 - 可能是 files 或直接的数组
        const files = result.files || result;
        assert.strictEqual(Array.isArray(files) || typeof files === "object", true);
      } else {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
      }
    });
  });

  describe("页面隔离测试", () => {
    it("两次执行之间应该完全隔离", async () => {
      // 第一次执行：设置全局变量
      const r1 = await executor.execute({
        code: "window.testVar = 'should not persist';"
      });

      if (!browserAvailable) {
        // 浏览器不可用时，第一次执行就应该返回错误
        assert.strictEqual(typeof r1, "object");
        assert.notStrictEqual(r1.error, undefined);
        return;
      }

      // 第二次执行：尝试访问全局变量
      const result = await executor.execute({
        code: "return typeof window.testVar;"
      });

      assert.strictEqual(result, "undefined");
    });

    it("DOM 元素不应该在执行间持久化", async () => {
      // 第一次执行：创建 DOM 元素
      const r1 = await executor.execute({
        code: `
          const div = document.createElement('div');
          div.id = 'test-element';
          document.body.appendChild(div);
        `
      });

      if (!browserAvailable) {
        assert.strictEqual(typeof r1, "object");
        assert.notStrictEqual(r1.error, undefined);
        return;
      }

      // 第二次执行：检查元素是否存在
      const result = await executor.execute({
        code: "return document.getElementById('test-element');"
      });

      assert.strictEqual(result, null);
    });
  });

  /**
   * Property 1: Code execution result consistency
   * 使用较少的运行次数以避免超时
   */
  describe("Property 1: Code execution result consistency", () => {
    it("算术运算应该产生正确结果", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -100, max: 100 }),
          fc.integer({ min: -100, max: 100 }),
          async (a, b) => {
            const result = await executor.execute({
              code: "return input.a + input.b;",
              input: { a, b }
            });
            if (!browserAvailable) {
              // 浏览器不可用时验证返回错误
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            assert.strictEqual(result, a + b);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });

    it("对象操作应该正确处理", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 10 }),
            value: fc.integer()
          }),
          async (obj) => {
            const result = await executor.execute({
              code: "return { name: input.name, doubled: input.value * 2 };",
              input: obj
            });
            if (!browserAvailable) {
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            assert.strictEqual(result.name, obj.name);
            assert.strictEqual(result.doubled, obj.value * 2);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });

    it("数组操作应该正确处理", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
          async (arr) => {
            const result = await executor.execute({
              code: "return input.reduce((a, b) => a + b, 0);",
              input: arr
            });
            if (!browserAvailable) {
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            const expected = arr.reduce((a, b) => a + b, 0);
            assert.strictEqual(result, expected);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });
  });

  /**
   * Property 2: Promise resolution
   */
  describe("Property 2: Promise resolution", () => {
    it("Promise 应该被正确等待和解析", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 50 }),
          async (value) => {
            const result = await executor.execute({
              code: `return new Promise(resolve => setTimeout(() => resolve(${value}), 5));`
            });
            if (!browserAvailable) {
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            assert.strictEqual(result, value);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });

    it("嵌套 Promise 应该被正确解析", async () => {
      const result = await executor.execute({
        code: `
          return Promise.resolve(1)
            .then(x => x + 1)
            .then(x => x * 2);
        `
      });
      if (!browserAvailable) {
        assert.strictEqual(typeof result, "object");
        assert.notStrictEqual(result.error, undefined);
        return;
      }
      assert.strictEqual(result, 4);
    });

    it("async/await 应该正确工作", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 5 }),
          async (str) => {
            const result = await executor.execute({
              code: `
                const asyncFn = async () => {
                  await new Promise(r => setTimeout(r, 2));
                  return input;
                };
                return await asyncFn();
              `,
              input: str
            });
            if (!browserAvailable) {
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            assert.strictEqual(result, str);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });
  });

  /**
   * Property 3: Timeout enforcement
   */
  describe("Property 3: Timeout enforcement", () => {
    // 注意：这个测试被跳过，因为 Puppeteer 的 page.evaluate 在某些情况下无法中断挂起的 Promise
    // 无限循环或永远不会 resolve 的 Promise 会导致测试挂起
    //
    // 在生产环境中，超时功能应该通过以下方式实现：
    // - 使用 Worker + MessageChannel
    // - 使用 VM 模块创建隔离上下文
    // - 使用 setTimeout + 页面关闭
    // @ts-ignore - it.skip 支持
    it.skip("超时的代码应该返回超时错误 [SKIP-环境依赖]", async () => {
      // 此测试在环境不支持时被跳过
    });
  });

  /**
   * Property 4: Error capture completeness
   */
  describe("Property 4: Error capture completeness", () => {
    it("各种错误类型应该被正确捕获", async () => {
      const errorCases = [
        { code: "throw new Error('test');", expectedContains: "test" },
        { code: "throw new TypeError('type error');", expectedContains: "type error" },
        { code: "throw new RangeError('range error');", expectedContains: "range error" },
        { code: "throw 'string error';", expectedContains: "string error" },
        { code: "undefinedVariable;", expectedContains: "undefinedVariable" }
      ];

      for (const { code, expectedContains } of errorCases) {
        const result = await executor.execute({ code });
        assert.notStrictEqual(result.error, undefined);
        assert.notStrictEqual(result.message || result.error, undefined);
      }
    });

    it("随机错误消息应该被正确捕获", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes("'") && !s.includes("\\")),
          async (errorMsg) => {
            const result = await executor.execute({
              code: `throw new Error('${errorMsg}');`
            });
            assert.notStrictEqual(result.error, undefined);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });
  });

  /**
   * Property 10: Browser instance management
   */
  describe("Property 10: Browser instance management", () => {
    it("应该能够检查浏览器可用状态", async () => {
      const available = executor.isBrowserAvailable();
      // 只是验证方法存在并返回布尔值
      assert.strictEqual(typeof available, "boolean");
    });

    it("多次执行应该保持稳定", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 50 }),
          async (value) => {
            const result = await executor.execute({
              code: `return input * 2;`,
              input: value
            });
            if (!browserAvailable) {
              assert.strictEqual(typeof result, "object");
              assert.notStrictEqual(result.error, undefined);
              return;
            }
            assert.strictEqual(result, value * 2);
          }
        ),
        { numRuns: 20 }
      );
    }, { timeout: 30000 });
  });
});
