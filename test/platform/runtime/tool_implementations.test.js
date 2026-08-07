/**
 * ToolImplementations 单元测试
 *
 * 覆盖 _executeDeleteAgent 和 _executeSpawnAgentWithTask 的核心逻辑分支。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ToolImplementations } from "../../../src/platform/runtime/tool_implementations.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

// mock.fn polyfill for node:test compatibility with bun
function mockFn(impl) {
  const calls = [];
  const fn = (...args) => { calls.push({ arguments: args }); return impl ? impl(...args) : undefined; };
  fn.mock = { calls, resetCalls: () => { calls.length = 0; }, callCount: () => calls.length };
  return fn;
}

function createMockRuntime(overrides = {}) {
  return {
    _agents: new Map(),
    _agentMetaById: new Map(),
    _agentManager: {
      logLifecycleEvent: mockFn(() => {}),
    },
    _lifecycle: {
      forceTerminateAgent: mockFn(() => Promise.resolve({ ok: true })),
    },
    log: makeTestLogger("ToolImpl"),
    bus: {
      send: mockFn(() => ({ messageId: "msg-123" })),
    },
    spawnAgentAs: mockFn((_creatorId, opts) =>
      Promise.resolve({ id: "agent-new", roleId: opts.roleId, roleName: "Test" })
    ),
    ...overrides,
  };
}

describe("ToolImplementations — _executeDeleteAgent", () => {
  let impl;
  let runtime;
  let ctx;

  beforeEach(() => {
    runtime = createMockRuntime();
    impl = new ToolImplementations(runtime);
    ctx = { agent: { id: "agent-caller" } };
  });

  it("缺失 caller agent 时应返回错误", async () => {
    const result = await impl._executeDeleteAgent({ agent: null }, { agentId: "target" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_caller_agent");
  });

  it("缺失 agentId 时应返回错误", async () => {
    const result = await impl._executeDeleteAgent(ctx, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_agent_id");
  });

  it("目标智能体不存在时应返回错误", async () => {
    const result = await impl._executeDeleteAgent(ctx, { agentId: "nonexistent" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "agent_not_found");
  });

  it("非子智能体应返回权限错误", async () => {
    runtime._agents.set("target", { id: "target" });
    runtime._agentMetaById.set("target", { parentAgentId: "other-agent" });

    const result = await impl._executeDeleteAgent(ctx, { agentId: "target" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "not_child_agent");
  });

  it("成功删除子智能体", async () => {
    runtime._agents.set("target", { id: "target" });
    runtime._agentMetaById.set("target", { parentAgentId: "agent-caller" });

    const result = await impl._executeDeleteAgent(ctx, { agentId: "target", reason: "测试删除" });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deletedAgentId, "target");
    assert.strictEqual(runtime._lifecycle.forceTerminateAgent.mock.callCount(), 1);
    assert.deepStrictEqual(runtime._lifecycle.forceTerminateAgent.mock.calls[0].arguments, ["target", {
      deletedBy: "agent-caller",
      reason: "测试删除",
    }]);
    assert.ok(runtime._agentManager.logLifecycleEvent.mock.callCount() > 0);
  });

  it("forceTerminateAgent 失败时应返回错误", async () => {
    runtime._agents.set("target", { id: "target" });
    runtime._agentMetaById.set("target", { parentAgentId: "agent-caller" });
    runtime._lifecycle.forceTerminateAgent = mockFn(() =>
      Promise.resolve({ ok: false, reason: "already_terminated" })
    );

    const result = await impl._executeDeleteAgent(ctx, { agentId: "target" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "already_terminated");
  });
});

describe("ToolImplementations — _executeSpawnAgentWithTask", () => {
  let impl;
  let runtime;
  let ctx;

  beforeEach(() => {
    runtime = createMockRuntime();
    impl = new ToolImplementations(runtime);
    ctx = {
      agent: { id: "agent-creator" },
      currentMessage: { taskId: "task-1" },
    };
  });

  it("缺失 creator agent 时应返回错误", async () => {
    const result = await impl._executeSpawnAgentWithTask(
      { agent: null },
      { initialMessage: {} }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_creator_agent");
  });

  it("缺失 initialMessage 时应返回错误", async () => {
    const result = await impl._executeSpawnAgentWithTask(ctx, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_initial_message");
  });

  it("initialMessage 非对象时应返回错误", async () => {
    const result = await impl._executeSpawnAgentWithTask(ctx, { initialMessage: "not an object" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "missing_initial_message");
  });

  it("成功创建智能体并发送消息", async () => {
    const result = await impl._executeSpawnAgentWithTask(ctx, {
      roleId: "role-engineer",
      taskBrief: "修复 bug",
      initialMessage: {
        message_type: "task_assignment",
        text: "请修复那个 bug",
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, "agent-new");
    assert.strictEqual(result.roleId, "role-engineer");
    assert.strictEqual(result.messageId, "msg-123");

    assert.strictEqual(runtime.spawnAgentAs.mock.callCount(), 1);
    assert.deepStrictEqual(runtime.spawnAgentAs.mock.calls[0].arguments, ["agent-creator", {
      roleId: "role-engineer",
      taskBrief: "修复 bug",
    }]);

    assert.strictEqual(runtime.bus.send.mock.callCount(), 1);
    assert.deepStrictEqual(runtime.bus.send.mock.calls[0].arguments, [{
      to: "agent-new",
      from: "agent-creator",
      taskId: "task-1",
      payload: {
        message_type: "task_assignment",
        text: "请修复那个 bug",
      },
    }]);
  });

  it("bus.send 被拒绝时应回滚智能体", async () => {
    runtime.bus.send = mockFn(() => ({
      rejected: true,
      reason: "rate_limit",
    }));

    const result = await impl._executeSpawnAgentWithTask(ctx, {
      roleId: "role-engineer",
      taskBrief: "修复 bug",
      initialMessage: { text: "请修复" },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "spawn_failed");
    assert.ok(result.details.includes("rate_limit"));

    // 验证回滚：智能体被终止
    assert.ok(runtime._lifecycle.forceTerminateAgent.mock.callCount() > 0);
    const terminateArgs = runtime._lifecycle.forceTerminateAgent.mock.calls[0].arguments;
    assert.strictEqual(terminateArgs[0], "agent-new");
    assert.strictEqual(terminateArgs[1].deletedBy, "agent-creator");
    assert.ok(String(terminateArgs[1].reason).includes("rate_limit"));
  });

  it("spawnAgentAs 失败时应记录日志并返回错误", async () => {
    let errorLogged = false;
    runtime.log.error = (msg, data) => { errorLogged = true; };
    runtime.spawnAgentAs = mockFn(() => {
      throw new Error("role not found");
    });

    const result = await impl._executeSpawnAgentWithTask(ctx, {
      roleId: "invalid-role",
      initialMessage: { text: "test" },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "spawn_failed");
    assert.ok(result.details.includes("role not found"));
    assert.strictEqual(errorLogged, true);
  });

  it("ctx 无 taskId 时应正常工作", async () => {
    const result = await impl._executeSpawnAgentWithTask(
      { agent: { id: "agent-creator" } },
      {
        roleId: "role-engineer",
        initialMessage: { text: "任务描述" },
      }
    );

    assert.strictEqual(result.ok, true);
    assert.ok(runtime.bus.send.mock.callCount() > 0);
    const sendArgs = runtime.bus.send.mock.calls[0].arguments[0];
    assert.deepStrictEqual(sendArgs.taskId, null);
  });
});
