/**
 * RuntimeLifecycle 测试：forceTerminateAgent() Chrome 浏览器清理
 *
 * 测试步骤 1 的修改：forceTerminateAgent() 在删除数据文件夹前，
 * 通过 moduleLoader 获取 chrome 模块并调用 cleanupAgentData()。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeLifecycle } from "../../../src/platform/runtime/runtime_lifecycle.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

/**
 * 构建 test agent 的最小 Runtime mock
 * 只包含 forceTerminateAgent 运行所需的属性/方法
 */
function makeRuntime(overrides = {}) {
  const log = makeTestLogger("Runtime");

  return {
    log,
    moduleLoader: {
      getModule: () => null,     // 默认：无 chrome 模块
    },
    _agentManager: {
      collectDescendantAgents: () => [],
    },
    _agents: new Map(),
    _conversations: new Map(),
    _conversationManager: {
      deletePersistedConversation: () => {},
    },
    _agentMetaById: new Map(),
    _agentLastActivityTime: new Map(),
    _state: {
      unmarkAgentAsActivelyProcessing: () => {},
      _agentComputeStatus: new Map(),
      _agentComputePhase: new Map(),
      setAgentComputeStatus: () => {},
      setAgentComputePhase: () => {},
      getAgentComputeStatus: () => "idle",
    },
    _cancelManager: {
      clear: () => {},
      abort: () => {},
    },
    _agentTaskBriefs: new Map(),
    _idleWarningEmitted: new Set(),
    bus: {
      clearQueue: () => [],
    },
    llm: {
      abort: () => false,
    },
    org: {
      getAgent: (id) => ({ id, status: "active" }),
      recordTermination: () => {},
      listRoles: () => [],
      getRole: () => null,
      deleteRole: () => {},
    },
    agentMemoryManager: null,  // null 以触发 ?. 短路，不调用 clearMemory
    _turnEngine: {
      clearAgent: () => {},
    },
    deleteAgentDataFolder: () => Promise.resolve(),
    ...overrides,
  };
}

/** 创建一个立即 resolve 给定值的 mock 函数，可记录调用 */
function mockResolve(value) {
  const fn = () => Promise.resolve(value);
  fn.calls = [];
  return fn;
}

describe("forceTerminateAgent — Chrome 浏览器清理", () => {

  // ==================== 1. cleanupAgentData 被正常调用 ====================

  it("chrome 模块存在且 cleanupAgentData 为函数时，应被调用一次", async () => {
    let cleanupCalls = [];
    const chromeModule = {
      cleanupAgentData: (agentId) => {
        cleanupCalls.push(agentId);
        return Promise.resolve({ ok: true });
      },
    };

    const runtime = makeRuntime({
      moduleLoader: {
        getModule: (name) => name === "chrome" ? chromeModule : null,
      },
    });

    const lifecycle = new RuntimeLifecycle(runtime);
    await lifecycle.forceTerminateAgent("agent-1");

    assert.strictEqual(cleanupCalls.length, 1);
    assert.strictEqual(cleanupCalls[0], "agent-1");
  });

  // ==================== 2. moduleLoader 为 null/undefined 不崩溃 ====================

  it("moduleLoader 为 null 时不应崩溃，正常完成终止", async () => {
    const runtime = makeRuntime({ moduleLoader: null });

    const lifecycle = new RuntimeLifecycle(runtime);
    const result = await lifecycle.forceTerminateAgent("agent-1");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agentId, "agent-1");
  });

  it("moduleLoader.getModule 不是函数时不应崩溃", async () => {
    const runtime = makeRuntime({
      moduleLoader: { getModule: null },
    });

    const lifecycle = new RuntimeLifecycle(runtime);
    const result = await lifecycle.forceTerminateAgent("agent-1");

    assert.strictEqual(result.ok, true);
  });

  // ==================== 3. chrome 模块不存在时正常终止 ====================

  it("chrome 模块不存在时（getModule 返回 null），正常完成终止", async () => {
    const runtime = makeRuntime({
      moduleLoader: {
        getModule: () => null,
      },
    });

    const lifecycle = new RuntimeLifecycle(runtime);
    const result = await lifecycle.forceTerminateAgent("agent-1");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agentId, "agent-1");
  });

  // ==================== 4. chrome 模块存在但无 cleanupAgentData 方法 ====================

  it("chrome 模块存在但 cleanupAgentData 不是函数时，正常完成终止", async () => {
    const chromeModule = {}; // 无 cleanupAgentData 属性

    const runtime = makeRuntime({
      moduleLoader: {
        getModule: () => chromeModule,
      },
    });

    const lifecycle = new RuntimeLifecycle(runtime);
    const result = await lifecycle.forceTerminateAgent("agent-1");

    assert.strictEqual(result.ok, true);
  });

  // ==================== 5. cleanupAgentData 抛异常时不阻塞后续逻辑 ====================

  it("cleanupAgentData 抛出异常时，deleteAgentDataFolder 仍应被调用", async () => {
    let deleteCalls = [];
    const chromeModule = {
      cleanupAgentData: () => Promise.reject(new Error("cleanup failed")),
    };

    const runtime = makeRuntime({
      moduleLoader: {
        getModule: () => chromeModule,
      },
      deleteAgentDataFolder: (id) => {
        deleteCalls.push(id);
        return Promise.resolve();
      },
    });

    const lifecycle = new RuntimeLifecycle(runtime);
    const result = await lifecycle.forceTerminateAgent("agent-1");

    // 终止应正常完成
    assert.strictEqual(result.ok, true);
    // deleteAgentDataFolder 仍然被调用
    assert.strictEqual(deleteCalls.length, 1);
    assert.strictEqual(deleteCalls[0], "agent-1");
  });

  // ==================== 6. cleanupAgentData 失败时记录 warn 日志 ====================

  it("cleanupAgentData 失败时，应记录 warn 日志", async () => {
    const chromeModule = {
      cleanupAgentData: () => Promise.reject(new Error("test error")),
    };

    const runtime = makeRuntime({
      moduleLoader: {
        getModule: () => chromeModule,
      },
    });

    const warnCalls = [];
    const origWarn = runtime.log.warn;
    runtime.log.warn = (msg, data) => { warnCalls.push([msg, data]); origWarn(msg, data); };

    const lifecycle = new RuntimeLifecycle(runtime);
    await lifecycle.forceTerminateAgent("agent-1");

    const cleanupWarn = warnCalls.find(c =>
      c[0] && c[0].includes("清理 Chrome")
    );
    assert.notStrictEqual(cleanupWarn, undefined);
    assert.strictEqual(cleanupWarn[1].error, "test error");
    assert.strictEqual(cleanupWarn[1].agentId, "agent-1");
  });

  // ==================== 7. 多个子智能体时每个都被清理 ====================

  it("有子智能体时，每个智能体的 Chrome 都应被清理", async () => {
    let cleanupCalls = [];
    const chromeModule = {
      cleanupAgentData: (agentId) => {
        cleanupCalls.push(agentId);
        return Promise.resolve({ ok: true });
      },
    };

    const runtime = makeRuntime({
      moduleLoader: {
        getModule: () => chromeModule,
      },
      _agentManager: {
        collectDescendantAgents: () => ["child-1", "child-2"],
      },
    });

    // 为子智能体注册 org agent
    runtime.org.getAgent = (id) => {
      if (id === "agent-1") return { id: "agent-1", status: "active" };
      if (id === "child-1") return { id: "child-1", parentAgentId: "agent-1", status: "active" };
      if (id === "child-2") return { id: "child-2", parentAgentId: "agent-1", status: "active" };
      return null;
    };

    const lifecycle = new RuntimeLifecycle(runtime);
    await lifecycle.forceTerminateAgent("agent-1");

    // 父 + 两个子 = 3 次调用
    assert.strictEqual(cleanupCalls.length, 3);
    assert.ok(cleanupCalls.includes("agent-1"));
    assert.ok(cleanupCalls.includes("child-1"));
    assert.ok(cleanupCalls.includes("child-2"));
  });
});
