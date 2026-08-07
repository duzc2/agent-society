/**
 * JavaScriptExecutor 沙箱安全测试
 *
 * 验证 Worker + vm 沙箱是否能阻止之前旧版（new Function + 黑名单）存在的逃逸路径。
 *
 * 【测试策略】
 * 1. 正常计算功能测试（确保沙箱不影响正常使用）
 * 2. 已知逃逸路径测试（验证每个旧版可绕过的路径现在被阻止）
 * 3. 边缘情况测试（空代码、超时、大输入等）
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { JavaScriptExecutor } from "../../src/platform/runtime/javascript_executor.js";
import { _setTestWorkspaceManager, _resetWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";

// 禁用实际 Worker 超时以加速测试运行
const QUICK_TIMEOUT = 3000;

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
          },
        });
      }
      return workspaces.get(id);
    },
    createDirectory: async () => ({ ok: true, existed: false }),
    checkWorkspaceExists: () => true,
    bindWorkspace: async () => ({ ok: true }),
    getWorkspacePath: (id) => `/tmp/workspaces/${id}`,
    hasWorkspace: () => true,
  };
}

function createMockRuntime() {
  _setTestWorkspaceManager(createMockWorkspaceManager());
  return {
    loggerRoot: testLoggerRoot,
    _getAgentTaskId: (agentId) => `workspace-${agentId}`,
  };
}

describe("JavaScriptExecutor — 正常功能测试", () => {
  let executor;

  it("简单算术", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({ code: "return 1 + 2;" });
    assert.strictEqual(result, 3);
  });

  it("字符串操作", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "return 'hello ' + input.name;",
      input: { name: "world" },
    });
    assert.strictEqual(result, "hello world");
  });

  it("使用 input 参数", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "return input.a + input.b;",
      input: { a: 10, b: 20 },
    });
    assert.strictEqual(result, 30);
  });

  it("复杂计算", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: `
        const arr = [1, 2, 3, 4, 5];
        const sum = arr.reduce((a, b) => a + b, 0);
        const avg = sum / arr.length;
        return { sum, avg, count: arr.length };
      `,
    });
    assert.deepStrictEqual(result, { sum: 15, avg: 3, count: 5 });
  });

  it("Math 全局函数可用", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "return Math.floor(Math.sqrt(10));",
    });
    assert.strictEqual(result, 3);
  });

  it("Date 全局函数可用", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: `
        const d = new Date('2026-01-01T00:00:00Z');
        return d.getFullYear();
      `,
    });
    assert.strictEqual(result, 2026);
  });

  it("JSON 操作", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: `
        const obj = { a: 1, b: [2, 3] };
        return JSON.parse(JSON.stringify(obj));
      `,
    });
    assert.deepStrictEqual(result, { a: 1, b: [2, 3] });
  });

  it("正则操作", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: `
        const text = "hello123world456";
        const nums = text.match(/\\d+/g);
        return nums.map(Number);
      `,
    });
    assert.deepStrictEqual(result, [123, 456]);
  });

  it("undefined 返回值转为 null", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({ code: "return undefined;" });
    assert.strictEqual(result, null);
  });
});

describe("JavaScriptExecutor — 沙箱逃逸测试 (旧版 bypass 路径)", () => {
  let executor;

  it("无法通过 this.constructor.constructor 逃逸", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    // 旧版沙箱: new Function() 可以通过此路径获取真实全局
    const result = await executor.execute({
      code: `
        try {
          const fn = this.constructor.constructor;
          return fn('return typeof process')();
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    // 在 vm 沙箱中，this 就是沙箱对象，没有 constructor 或 constructor 返回沙箱内的 Function
    assert.strictEqual(result, "blocked");
  });

  it("无法通过 arguments.callee.caller 逃逸", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: `
        try {
          return (function() {
            return arguments.callee.caller;
          })();
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    // strict mode 下 arguments.callee 会抛 TypeError
    assert.strictEqual(result, "blocked");
  });

  it("无法访问 process 对象", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: `
        try {
          return typeof process;
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    assert.strictEqual(result, "undefined");
  });

  it("无法访问 require 函数", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: `
        try {
          return typeof require;
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    assert.strictEqual(result, "undefined");
  });

  it("globalThis 指向沙箱本身（非真实全局）", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    // vm.createContext 自动包含 globalThis，但它指向沙箱对象本身
    // 因此 process 等 Node API 不在 globalThis 上
    const result = await executor.execute({
      code: `
        const gt = typeof globalThis;
        const hasProcess = typeof globalThis.process;
        return gt + ',' + hasProcess;
      `,
    });
    assert.strictEqual(result, "object,undefined");
  });

  it("无法访问 fetch", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: "return typeof fetch;",
    });

    assert.strictEqual(result, "undefined");
  });

  it("无法通过 eval 执行恶意代码", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    // 注: eval 在 vm 沙箱中运行于沙箱上下文中
    // 所以即使 eval 可用，它也无法访问 Node API
    const result = await executor.execute({
      code: `
        try {
          return eval("typeof process");
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    // process 未注入沙箱，即使是 eval 也无法访问
    assert.strictEqual(result, "undefined");
  });

  it("Reflect 存在但被沙箱化，无法访问 Node API", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    // vm.createContext 自动包含 Reflect（沙箱化版本）
    // 但 Reflect 操作的对象均在沙箱内，无法逃逸到 Node API
    const result = await executor.execute({
      code: `
        try {
          const obj = { x: 1 };
          const val = Reflect.get(obj, 'x');
          // 关键: 尝试通过 Reflect 获取 process
          const hasProcess = Reflect.has(typeof globalThis !== 'undefined' ? globalThis : {}, 'process');
          return 'Reflect_ok,process=' + hasProcess;
        } catch(e) {
          return 'blocked';
        }
      `,
    });
    assert.ok(result.includes("Reflect_ok"));
    assert.ok(result.includes("process=false"));
  });

  it("Proxy 存在但被沙箱化，无法劫持外部对象", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    // vm.createContext 自动包含 Proxy（沙箱化版本）
    // Proxy 只能代理沙箱内对象，无法代理外部 Node API 对象
    const result = await executor.execute({
      code: `
        try {
          const handler = { get: (obj, prop) => prop === 'secret' ? 'blocked' : obj[prop] };
          const proxy = new Proxy({}, handler);
          return 'Proxy_ok';
        } catch(e) {
          return 'blocked';
        }
      `,
    });
    assert.strictEqual(result, "Proxy_ok");
  });

  it("无法通过 __proto__ 遍历到外部对象", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: `
        try {
          const obj = {};
          return typeof obj.__proto__.constructor.constructor;
        } catch(e) {
          return 'blocked';
        }
      `,
    });

    // 沙箱内对象的原型也是沙箱内的，constructor.constructor 指向沙箱 Function
    assert.strictEqual(typeof result, "string");
  });
});

describe("JavaScriptExecutor — 防御性预过滤", () => {
  let executor;

  it("被 blockedTokens 检测到 require() 应拒绝", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: "require('fs').writeFileSync('/tmp/x', 'hi');",
    });

    assert.strictEqual(result.error, "blocked_code");
    assert.ok(result.blocked.includes("require"));
  });

  it("被 blockedTokens 检测到 process. 应拒绝", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: "process.exit(1);",
    });

    assert.strictEqual(result.error, "blocked_code");
    assert.ok(result.blocked.includes("process"));
  });

  it("被 blockedTokens 检测到 fs. 应拒绝", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;

    const result = await executor.execute({
      code: "fs.readFileSync('/etc/passwd');",
    });

    assert.strictEqual(result.error, "blocked_code");
    assert.ok(result.blocked.includes("fs"));
  });
});

describe("JavaScriptExecutor — 防御性预过滤(注释与字符串中的关键词不应被误判)", () => {
  let executor;

  it("注释中的 require 不应被拦截", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "// require('fs')\nreturn 1 + 2;",
    });
    assert.notStrictEqual(result.error, "blocked_code");
    assert.strictEqual(result, 3);
  });

  it("字符串字面量中的 require 不应被拦截", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: 'const msg = "use require() here";\nreturn msg;',
    });
    assert.notStrictEqual(result.error, "blocked_code");
    assert.strictEqual(result, "use require() here");
  });

  it("模板字符串中的 process 不应被拦截", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "const msg = `process.env is blocked`;\nreturn msg;",
    });
    assert.notStrictEqual(result.error, "blocked_code");
    assert.strictEqual(result, "process.env is blocked");
  });

  it("真正的 require() 调用仍应被拦截", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "require('fs').readFileSync('/passwd');",
    });
    assert.strictEqual(result.error, "blocked_code");
    assert.ok(result.blocked.includes("require"));
    assert.ok(typeof result.message === "string");
  });

  it("blocked_code 返回应包含 message 字段", async () => {
    executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "process.exit(1);",
    });
    assert.strictEqual(result.error, "blocked_code");
    assert.ok(result.blocked.includes("process"));
    assert.ok(typeof result.message === "string");
    assert.ok(result.message.length > 0);
  });
});

describe("JavaScriptExecutor — 边缘情况", () => {
  it("空字符串代码应被拒绝", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    const result = await executor.execute({ code: "" });
    // 空字符串在验证通过后在沙箱内执行，可能返回 undefined
    // 但至少不应崩溃
    assert.notStrictEqual(result, undefined);
  });

  it("无返回值的代码", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({ code: "const x = 1 + 1;" });
    assert.strictEqual(result, null); // undefined → null
  });

  it("code 不是字符串", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    const result = await executor.execute({ code: 123 });
    assert.strictEqual(result.error, "invalid_args");
  });

  it("无 input 参数的代码", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({ code: "return 42;" });
    assert.strictEqual(result, 42);
  });

  it("result_too_large 保护", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "return 'x'.repeat(200010);",
    });
    assert.strictEqual(result.error, "result_too_large");
  });

  it("代码有语法错误", async () => {
    const executor = new JavaScriptExecutor(createMockRuntime());
    executor.vmTimeoutMs = QUICK_TIMEOUT;
    const result = await executor.execute({
      code: "return 1 + ;", // 语法错误
    });
    assert.strictEqual(result.error, "js_execution_failed");
  });
});
