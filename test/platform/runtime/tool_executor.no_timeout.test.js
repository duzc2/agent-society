/**
 * 验证 executeToolCall 不存在人造超时
 *
 * 行为需求：工具执行时长由业务决定，不应被通用超时机制强制中断。
 * 此前 tool_executor.js 中存在 Promise.race + setTimeout(timeoutMs)，
 * 对未在 TOOL_TIMEOUTS 表中注册的工具默认 10 分钟超时，
 * 导致 localcmd_spawn 等长时间工具被误杀。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger, testLoggerRoot } from "../../helpers/test_logger.js";

function createRuntimeStub(overrides = {}) {
  return {
    moduleLoader: {
      hasToolName: () => false,
      executeToolCall: async () => ({ result: "module_ok" })
    },
    log: makeTestLogger("ToolExecutor"),
    loggerRoot: testLoggerRoot,
    ...overrides
  };
}

describe("ToolExecutor — executeToolCall 不设超时", () => {
  /** @type {ToolExecutor} */
  let toolExecutor;
  /** @type {object} */
  let runtime;

  // 记录本轮测试中 setTimeout 的调用
  let setTimeoutCalls;
  /** @type {typeof globalThis.setTimeout} */
  let origSetTimeout;

  beforeEach(() => {
    runtime = createRuntimeStub();
    toolExecutor = new ToolExecutor(runtime);
    setTimeoutCalls = [];
    origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function (...args) {
      setTimeoutCalls.push({ delay: args[1] });
      return origSetTimeout.apply(this, args);
    };
  });

  afterEach(() => {
    globalThis.setTimeout = origSetTimeout;
  });

  it("同步工具（list_todo_items）执行期间不应设置任何 delay>0 的 setTimeout", async () => {
    const ctx = { agent: { id: "test-agent" } };
    const result = await toolExecutor.executeToolCall(ctx, "list_todo_items", {});

    // 结果不是超时错误
    assert.strictEqual(typeof result.error, "undefined",
      "同步工具不应返回 error");

    // executeToolCall 内部不应该调用 setTimeout 设超时
    const timerCalls = setTimeoutCalls.filter(c => c.delay > 0);
    assert.strictEqual(timerCalls.length, 0,
      "executeToolCall 不应通过 setTimeout 设置超时");
  });

  it("模块工具执行期间不应设置任何 delay>0 的 setTimeout", async () => {
    const runtimeWithModule = createRuntimeStub({
      moduleLoader: {
        hasToolName: () => true,
        executeToolCall: async () => ({ result: "done" })
      }
    });
    const executor = new ToolExecutor(runtimeWithModule);

    const ctx = { agent: { id: "test-agent" } };
    const result = await executor.executeToolCall(ctx, "localcmd_spawn", { cmd: "echo hi" });

    // 结果不是超时错误
    assert.strictEqual(typeof result.error, "undefined",
      "模块工具不应返回 error（不应有超时）");
    assert.strictEqual(result.result, "done");

    const timerCalls = setTimeoutCalls.filter(c => c.delay > 0);
    assert.strictEqual(timerCalls.length, 0,
      "executeToolCall 不应通过 setTimeout 设置超时");
  });

  it("executeToolCall 的结果不应是 'tool_timeout' 格式的错误", async () => {
    // 调用一个会正常完成的工具
    const ctx = { agent: { id: "test-agent" } };
    const result = await toolExecutor.executeToolCall(ctx, "get_workspace_info", {});

    // 即使出错也应该是业务错误，不是 timeout
    if (result?.error) {
      assert.ok(!result.error.startsWith("tool_timeout"),
        `不应返回超时错误，实际: ${result.error}`);
    }
  });

  it("工具调用失败时应返回 tool_execution_failed 而非超时", async () => {
    // 用一个不存在但会走到默认分支的未知工具，模拟业务错误
    const ctx = { agent: { id: "test-agent" } };
    const result = await toolExecutor.executeToolCall(ctx, "unknown_tool_xyz", {});

    assert.ok(result.error, "未知工具应返回错误");
    assert.ok(result.error.startsWith("unknown_tool:"),
      `未知工具错误应以 unknown_tool: 开头，实际: ${result.error}`);
  });

  it("工具执行出错时 catch 应捕获原始异常并包装为 tool_execution_failed", async () => {
    // 构造一个会抛异常的场景：使用一个会执行到 switch default 的伪工具
    // 正常路径下 executeToolCall 会走到 default 分支返回 unknown_tool
    // 这里我们通过抛异常的 moduleLoader 模拟工具执行中的异常
    const runtimeWithThrowing = createRuntimeStub({
      moduleLoader: {
        hasToolName: () => true,
        executeToolCall: () => { throw new Error("simulated_crash"); }
      }
    });
    const executor = new ToolExecutor(runtimeWithThrowing);

    const ctx = { agent: { id: "test-agent" } };
    const result = await executor.executeToolCall(ctx, "some_module_tool", {});

    assert.strictEqual(result.error, "tool_execution_failed");
    assert.strictEqual(result.toolName, "some_module_tool");
    assert.ok(result.message.includes("simulated_crash"),
      `错误消息应包含原始异常，实际: ${result.message}`);

    // 仍然不应有 setTimeout 超时调用
    const timerCalls = setTimeoutCalls.filter(c => c.delay > 0);
    assert.strictEqual(timerCalls.length, 0,
      "异常路径也不应通过 setTimeout 设置超时");
  });
});
