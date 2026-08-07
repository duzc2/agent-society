/**
 * RuntimeState 模块测试
 * 测试状态管理：agent CRUD、compute status、active processing、interruptions、task workspace、state locks
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { RuntimeState } from "../../../src/platform/runtime/runtime_state.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

describe("RuntimeState", () => {
  // ==================== 构造函数 ====================

  describe("构造函数", () => {
    it("无参数创建实例（logger = null, _computeStatusListeners = Set）", () => {
      const state = new RuntimeState();
      assert.notStrictEqual(state, undefined);
      assert.strictEqual(state.log, null);
      assert.ok(state._computeStatusListeners instanceof Set);
    });

    it("传入 logger 选项", () => {
      const log = makeTestLogger("RuntimeState");
      const state = new RuntimeState({ logger: log });
      assert.strictEqual(state.log, log);
    });

    it("通过 addComputeStatusListener 注册回调", () => {
      let called = null;
      const cb = (agentId, status) => { called = { agentId, status }; };
      const state = new RuntimeState();
      state.addComputeStatusListener(cb);
      state.setAgentComputeStatus("a1", "processing");
      assert.deepStrictEqual(called, { agentId: "a1", status: "processing" });
    });

    it("初始化内部 Maps/Sets", () => {
      const state = new RuntimeState();
      assert.ok(state._agents instanceof Map);
      assert.ok(state._agentMetaById instanceof Map);
      assert.ok(state._agentComputeStatus instanceof Map);
      assert.ok(state._agentComputePhase instanceof Map);
      assert.ok(state._activeProcessingAgents instanceof Set);
      assert.ok(state._conversations instanceof Map);
      assert.ok(state._taskWorkspaces instanceof Map);
      assert.ok(state._agentTaskBriefs instanceof Map);
      assert.ok(state._stateLocks instanceof Map);
    });
  });

  // ==================== Agent 注册与查询 ====================

  describe("Agent 注册与查询", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("registerAgent → getAgent 返回该 agent", () => {
      const agent = { id: "a1", roleId: "r1", name: "test" };
      state.registerAgent(agent);
      assert.strictEqual(state.getAgent("a1"), agent);
    });

    it("registerAgent 支持重复注册（覆盖）", () => {
      const a1 = { id: "a1", name: "first" };
      const a2 = { id: "a1", name: "second" };
      state.registerAgent(a1);
      state.registerAgent(a2);
      assert.strictEqual(state.getAgent("a1").name, "second");
    });

    it("hasAgent 对存在/不存在的 agentId 返回正确值", () => {
      state.registerAgent({ id: "a1" });
      assert.strictEqual(state.hasAgent("a1"), true);
      assert.strictEqual(state.hasAgent("nonexistent"), false);
    });

    it("getAgentCount 返回正确的 agent 数量", () => {
      assert.strictEqual(state.getAgentCount(), 0);
      state.registerAgent({ id: "a1" });
      state.registerAgent({ id: "a2" });
      assert.strictEqual(state.getAgentCount(), 2);
    });

    it("getAllAgentIds 返回所有 agentId 的迭代器", () => {
      state.registerAgent({ id: "a1" });
      state.registerAgent({ id: "a2" });
      const ids = Array.from(state.getAllAgentIds());
      assert.ok(ids.includes("a1"));
      assert.ok(ids.includes("a2"));
      assert.strictEqual(ids.length, 2);
    });

    it("getAllAgents 返回 agent 数组", () => {
      const a1 = { id: "a1" };
      const a2 = { id: "a2" };
      state.registerAgent(a1);
      state.registerAgent(a2);
      const all = state.getAllAgents();
      assert.ok(all.includes(a1));
      assert.ok(all.includes(a2));
      assert.strictEqual(all.length, 2);
    });
  });

  // ==================== Agent Meta ====================

  describe("Agent Meta", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("setAgentMeta → getAgentMeta 返回设置的 meta", () => {
      const meta = { roleId: "r1", parentAgentId: "p1" };
      state.setAgentMeta("a1", meta);
      assert.strictEqual(state.getAgentMeta("a1"), meta);
    });

    it("getAgentMeta 对未注册的 agent 返回 undefined", () => {
      assert.strictEqual(state.getAgentMeta("nonexistent"), undefined);
    });

    it("setAgentMeta 覆盖已有 meta", () => {
      state.setAgentMeta("a1", { roleId: "r1" });
      state.setAgentMeta("a1", { roleId: "r2" });
      assert.strictEqual(state.getAgentMeta("a1").roleId, "r2");
    });
  });

  // ==================== Compute Status ====================

  describe("Compute Status", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("setAgentComputeStatus → getAgentComputeStatus 返回设置的状态", () => {
      state.setAgentComputeStatus("a1", "processing");
      assert.strictEqual(state.getAgentComputeStatus("a1"), "processing");
    });

    it("setAgentComputeStatus 触发 computeStatusListener 回调", () => {
      let captured = null;
      const s = new RuntimeState();
      s.addComputeStatusListener((agentId, status) => { captured = { agentId, status }; });
      s.setAgentComputeStatus("a1", "stopping");
      assert.deepStrictEqual(captured, { agentId: "a1", status: "stopping" });
    });

    it("getAgentComputeStatus 对未知 agent 返回 'idle' 默认值", () => {
      assert.strictEqual(state.getAgentComputeStatus("nonexistent"), "idle");
    });

    it("getAllAgentComputeStatus 返回所有 agent 状态对象", () => {
      state.setAgentComputeStatus("a1", "processing");
      state.setAgentComputeStatus("a2", "idle");
      const all = state.getAllAgentComputeStatus();
      assert.strictEqual(all.a1, "processing");
      assert.strictEqual(all.a2, "idle");
    });

    it("setAgentComputePhase → getAgentComputePhase 正确", () => {
      state.setAgentComputePhase("a1", "正在处理...");
      assert.strictEqual(state.getAgentComputePhase("a1"), "正在处理...");
    });

    it("setAgentComputePhase 传入 null 清除 phase", () => {
      state.setAgentComputePhase("a1", "test");
      state.setAgentComputePhase("a1", null);
      assert.strictEqual(state.getAgentComputePhase("a1"), null);
    });
  });

  // ==================== Active Processing ====================

  describe("Active Processing", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("markAgentAsActivelyProcessing → isAgentActivelyProcessing = true", () => {
      state.markAgentAsActivelyProcessing("a1");
      assert.strictEqual(state.isAgentActivelyProcessing("a1"), true);
    });

    it("unmarkAgentAsActivelyProcessing → isAgentActivelyProcessing = false", () => {
      state.markAgentAsActivelyProcessing("a1");
      state.unmarkAgentAsActivelyProcessing("a1");
      assert.strictEqual(state.isAgentActivelyProcessing("a1"), false);
    });

    it("unmark 未标记的 agent 不抛错", () => {
      assert.doesNotThrow(() => state.unmarkAgentAsActivelyProcessing("a1"));
    });

    it("getActiveProcessingCount 返回正确的数量", () => {
      assert.strictEqual(state.getActiveProcessingCount(), 0);
      state.markAgentAsActivelyProcessing("a1");
      state.markAgentAsActivelyProcessing("a2");
      assert.strictEqual(state.getActiveProcessingCount(), 2);
    });

    it("getActiveProcessingAgents 返回 agentId 数组", () => {
      state.markAgentAsActivelyProcessing("a1");
      state.markAgentAsActivelyProcessing("a2");
      const agents = state.getActiveProcessingAgents();
      assert.ok(agents.includes("a1"));
      assert.ok(agents.includes("a2"));
      assert.strictEqual(agents.length, 2);
    });
  });

  // ==================== Task Workspace ====================

  describe("Task Workspace", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("setTaskWorkspace → getTaskWorkspace 返回路径", () => {
      state.setTaskWorkspace("t1", "/workspace/t1");
      assert.strictEqual(state.getTaskWorkspace("t1"), "/workspace/t1");
    });

    it("getTaskWorkspace 对未知 taskId 返回 undefined", () => {
      assert.strictEqual(state.getTaskWorkspace("nonexistent"), undefined);
    });

    it("setTaskWorkspace 覆盖已有映射", () => {
      state.setTaskWorkspace("t1", "/old");
      state.setTaskWorkspace("t1", "/new");
      assert.strictEqual(state.getTaskWorkspace("t1"), "/new");
    });
  });

  // ==================== Agent Task Brief ====================

  describe("Agent Task Brief", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("setAgentTaskBrief → getAgentTaskBrief 返回 brief", () => {
      const brief = { description: "do something", deadline: "2026-01-01" };
      state.setAgentTaskBrief("a1", brief);
      assert.strictEqual(state.getAgentTaskBrief("a1"), brief);
    });

    it("getAgentTaskBrief 对未注册的 agent 返回 undefined", () => {
      assert.strictEqual(state.getAgentTaskBrief("nonexistent"), undefined);
    });
  });

  // ==================== State Locks ====================

  describe("State Locks", () => {
    let state;

    beforeEach(() => {
      state = new RuntimeState();
    });

    it("acquireLock 返回 release 函数", async () => {
      const release = await state.acquireLock("a1");
      assert.strictEqual(typeof release, "function");
    });

    it("releaseLock 后后续 acquire 可以获取锁", async () => {
      const release1 = await state.acquireLock("a1");
      state.releaseLock(release1);
      // 获取第二个锁应成功
      const release2 = await state.acquireLock("a1");
      assert.strictEqual(typeof release2, "function");
      state.releaseLock(release2);
    });

    it("同一 agentId 串行 acquire: 第二个在第一个释放后才 resolve", async () => {
      const order = [];
      const release1 = await state.acquireLock("a1");
      order.push("acquired1");

      // 启动第二个 acquire（不应立即完成）
      const promise2 = state.acquireLock("a1").then((r) => {
        order.push("acquired2");
        return r;
      });

      // 给微任务队列一些时间
      await Promise.resolve();
      assert.deepStrictEqual(order, ["acquired1"]); // 第二个还没完成

      // 释放第一个锁
      state.releaseLock(release1);
      const release2 = await promise2;
      assert.deepStrictEqual(order, ["acquired1", "acquired2"]);
      state.releaseLock(release2);
    });

    it("releaseLock 传入 falsy 值不抛错", () => {
      assert.doesNotThrow(() => state.releaseLock(null));
      assert.doesNotThrow(() => state.releaseLock(undefined));
      assert.doesNotThrow(() => state.releaseLock(0));
    });
  });

  // ==================== 额外边界情况 ====================

  describe("额外边界", () => {
    it("setAgentComputeStatus 传入空 agentId 不设置状态", () => {
      const state = new RuntimeState();
      state.setAgentComputeStatus("", "processing");
      assert.strictEqual(state.getAgentComputeStatus(""), "idle");
    });

    it("setAgentComputePhase 传入空 agentId 不抛错", () => {
      const state = new RuntimeState();
      assert.doesNotThrow(() => state.setAgentComputePhase("", "test"));
    });

  });
});
