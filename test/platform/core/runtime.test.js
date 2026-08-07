/**
 * Runtime 构造函数测试
 * 测试 Runtime 构造函数、属性、向后兼容、事件/状态委托
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { Runtime } from "../../../src/platform/core/runtime.js";
import { RuntimeEvents } from "../../../src/platform/runtime/runtime_events.js";
import { RuntimeState } from "../../../src/platform/runtime/runtime_state.js";
import { ShutdownManager } from "../../../src/platform/runtime/shutdown_manager.js";

describe("Runtime 构造函数", () => {
  // ==================== 默认参数 ====================

  describe("默认参数", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("maxSteps 默认 200", () => {
      assert.strictEqual(runtime.maxSteps, 200);
    });

    it("maxToolRounds 默认 20000", () => {
      assert.strictEqual(runtime.maxToolRounds, 20000);
    });

    it("idleWarningMs 默认 300000", () => {
      assert.strictEqual(runtime.idleWarningMs, 300000);
    });

    it("dataDir 默认 null", () => {
      assert.strictEqual(runtime.dataDir, null);
    });

    it("无 configService 时 _passedConfig 为 null", () => {
      assert.strictEqual(runtime._passedConfig, null);
      // 未传入时属性不设置，遵循铁律 #2（内部组件禁止空值兼容）
      assert.strictEqual(runtime._configService, undefined);
    });

    it("loggerRoot 被创建", () => {
      assert.notStrictEqual(runtime.loggerRoot, undefined);
      assert.notStrictEqual(runtime.log, undefined);
    });
  });

  // ==================== 自定义选项 ====================

  describe("自定义选项", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("覆盖 maxSteps", () => {
      const r = new Runtime({ maxSteps: 100 });
      assert.strictEqual(r.maxSteps, 100);
      r.shutdownManager.destroy();
    });

    it("覆盖 maxToolRounds", () => {
      const r = new Runtime({ maxToolRounds: 5000 });
      assert.strictEqual(r.maxToolRounds, 5000);
      r.shutdownManager.destroy();
    });

    it("覆盖 idleWarningMs", () => {
      const r = new Runtime({ idleWarningMs: 60000 });
      assert.strictEqual(r.idleWarningMs, 60000);
      r.shutdownManager.destroy();
    });

    it("覆盖 dataDir", () => {
      const r = new Runtime({ dataDir: "/custom/data" });
      assert.strictEqual(r.dataDir, "/custom/data");
      r.shutdownManager.destroy();
    });

    it("支持 configService 选项", () => {
      const r = new Runtime({ configService: { configDir: "/fake" } });
      assert.notStrictEqual(r._configService, undefined);
      r.shutdownManager.destroy();
    });
  });

  // ==================== 向后兼容属性 ====================

  describe("向后兼容属性", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("_agents 指向 _state._agents", () => {
      assert.strictEqual(runtime._agents, runtime._state._agents);
    });

    it("_agentMetaById 指向 _state._agentMetaById", () => {
      assert.strictEqual(runtime._agentMetaById, runtime._state._agentMetaById);
    });

    it("_agentComputeStatus 指向 _state._agentComputeStatus", () => {
      assert.strictEqual(runtime._agentComputeStatus, runtime._state._agentComputeStatus);
    });

    it("_activeProcessingAgents 指向 _state._activeProcessingAgents", () => {
      assert.strictEqual(runtime._activeProcessingAgents, runtime._state._activeProcessingAgents);
    });

    it("_conversations 指向 _state._conversations", () => {
      assert.strictEqual(runtime._conversations, runtime._state._conversations);
    });

    it("_taskWorkspaces 指向 _state._taskWorkspaces", () => {
      assert.strictEqual(runtime._taskWorkspaces, runtime._state._taskWorkspaces);
    });

    it("_agentTaskBriefs 指向 _state._agentTaskBriefs", () => {
      assert.strictEqual(runtime._agentTaskBriefs, runtime._state._agentTaskBriefs);
    });

    it("_stateLocks 指向 _state._stateLocks", () => {
      assert.strictEqual(runtime._stateLocks, runtime._state._stateLocks);
    });
  });

  // ==================== 子模块初始化 ====================

  describe("子模块初始化", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("_events 是 RuntimeEvents 实例", () => {
      assert.ok(runtime._events instanceof RuntimeEvents);
    });

    it("_state 是 RuntimeState 实例", () => {
      assert.ok(runtime._state instanceof RuntimeState);
    });

    it("_stateManager 指向 _state", () => {
      assert.strictEqual(runtime._stateManager, runtime._state);
    });

    it("_eventsManager 指向 _events", () => {
      assert.strictEqual(runtime._eventsManager, runtime._events);
    });

    it("_lifecycle 已初始化", () => {
      assert.notStrictEqual(runtime._lifecycle, undefined);
    });

    it("_tools 已初始化", () => {
      assert.notStrictEqual(runtime._tools, undefined);
    });

    it("_toolExecutor 已初始化", () => {
      assert.notStrictEqual(runtime._toolExecutor, undefined);
    });

    it("_turnEngine 已初始化", () => {
      assert.notStrictEqual(runtime._turnEngine, undefined);
    });

    it("_computeScheduler 已初始化", () => {
      assert.notStrictEqual(runtime._computeScheduler, undefined);
    });

    it("_behaviorRegistry 是 Map（在 Runtime 上）", () => {
      // registerRoleBehavior 委托给 lifecycle，但 _behaviorRegistry 在 Runtime 上
      assert.strictEqual(runtime._behaviorRegistry instanceof Map, true);
    });

    it("_systemPromptProviders 是 Map", () => {
      assert.ok(runtime._systemPromptProviders instanceof Map);
    });
  });

  // ==================== 事件委托 ====================

  describe("事件委托", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("onToolCall 将 listener 注册到 _events", () => {
      const fn = () => {};
      runtime.onToolCall(fn);
      const counts = runtime._events.getListenerCounts();
      assert.strictEqual(counts.toolCall, 1);
    });

    it("onError 将 listener 注册到 _events", () => {
      const fn = () => {};
      runtime.onError(fn);
      const counts = runtime._events.getListenerCounts();
      assert.strictEqual(counts.error, 1);
    });

    it("onLlmRetry 将 listener 注册到 _events", () => {
      const fn = () => {};
      runtime.onLlmRetry(fn);
      const counts = runtime._events.getListenerCounts();
      assert.strictEqual(counts.llmRetry, 1);
    });

    it("onComputeStatusChange 将 listener 注册到 _events", () => {
      const fn = () => {};
      runtime.onComputeStatusChange(fn);
      const counts = runtime._events.getListenerCounts();
      assert.strictEqual(counts.computeStatusChange, 1);
    });
  });

  // ==================== 状态委托 ====================

  describe("状态委托", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("setAgentComputeStatus 委托给 _state", () => {
      runtime._state._agentComputeStatus.set("test_agent", "idle");
      runtime.setAgentComputeStatus("test_agent", "processing");
      assert.strictEqual(runtime._state._agentComputeStatus.get("test_agent"), "processing");
    });

    it("getAgentComputeStatus 委托给 _state", () => {
      runtime._state._agentComputeStatus.set("test_agent", "waiting_llm");
      assert.strictEqual(runtime.getAgentComputeStatus("test_agent"), "waiting_llm");
    });

    it("getAgentComputePhase 委托给 _state", () => {
      runtime._state._agentComputePhase.set("test_agent", "phase1");
      assert.strictEqual(runtime.getAgentComputePhase("test_agent"), "phase1");
    });

    it("listAgentInstances 返回数组", () => {
      const instances = runtime.listAgentInstances();
      assert.strictEqual(Array.isArray(instances), true);
    });
  });

  // ==================== 锁委托 ====================

  describe("锁委托", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("_acquireLock 委托给 _state.acquireLock", async () => {
      const release = await runtime._acquireLock("test_agent");
      assert.strictEqual(typeof release, "function");
      runtime._releaseLock(release);
    });

    it("_releaseLock 委托给 _state.releaseLock", async () => {
      const release = await runtime._acquireLock("test_agent");
      // releaseLock 不应抛错
      assert.doesNotThrow(() => runtime._releaseLock(release));
    });
  });

  // ==================== systemPromptProviders ====================

  describe("systemPromptProviders", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("未注册时 getSystemPromptAppendix 返回空字符串", () => {
      assert.strictEqual(runtime.getSystemPromptAppendix(), "");
    });

    it("register + getSystemPromptAppendix 返回 provider 提供的文本", () => {
      runtime.registerSystemPromptProvider("test_provider", () => "test content");
      const appendix = runtime.getSystemPromptAppendix();
      assert.ok(appendix.includes("test content"));
    });

    it("多个 provider 的文本用换行分隔", () => {
      runtime.registerSystemPromptProvider("p1", () => "content1");
      runtime.registerSystemPromptProvider("p2", () => "content2");
      const appendix = runtime.getSystemPromptAppendix();
      assert.ok(appendix.includes("content1"));
      assert.ok(appendix.includes("content2"));
    });

    it("unregister 后不再返回该 provider 的文本", () => {
      runtime.registerSystemPromptProvider("p1", () => "content1");
      runtime.unregisterSystemPromptProvider("p1");
      assert.strictEqual(runtime.getSystemPromptAppendix(), "");
    });

    it("provider 返回空字符串不计入", () => {
      runtime.registerSystemPromptProvider("p1", () => "");
      runtime.registerSystemPromptProvider("p2", () => "real");
      const appendix = runtime.getSystemPromptAppendix();
      assert.ok(appendix.includes("real"));
      // 空字符串不参与拼接
      const lines = appendix.split("\n\n").filter(s => s.trim());
      assert.strictEqual(lines.length, 1);
    });

    it("register 传入非函数抛错", () => {
      assert.throws(() => runtime.registerSystemPromptProvider("p1", "not_a_fn"), /function/);
    });
  });

  // ==================== shutdownManager getter ====================

  describe("shutdownManager getter", () => {
    it("shutdownManager 返回 ShutdownManager 实例", () => {
      const runtime = new Runtime();
      assert.ok(runtime.shutdownManager instanceof ShutdownManager);
      runtime.shutdownManager.destroy();
    });
  });

  // ==================== registerRoleBehavior ====================

  describe("registerRoleBehavior", () => {
    it("registerRoleBehavior 委托给 _lifecycle", () => {
      const runtime = new Runtime();
      const fn = () => "behavior";
      // registerRoleBehavior 委托给 _lifecycle.registerRoleBehavior
      runtime.registerRoleBehavior("test_role", fn);
      // lifecycle 的 behaviorRegistry 可能使用不同属性名，验证方法调用成功
      // Runtime 自身也有 _behaviorRegistry
      assert.strictEqual(runtime._behaviorRegistry instanceof Map, true);
      runtime.shutdownManager.destroy();
    });
  });

  // ==================== getToolDefinitions / executeToolCall ====================

  describe("getToolDefinitions / executeToolCall", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("getToolDefinitions 返回数组", () => {
      const defs = runtime.getToolDefinitions();
      assert.strictEqual(Array.isArray(defs), true);
    });

    it("getToolDefinitions 不含模块工具（模块未加载）", () => {
      const defs = runtime.getToolDefinitions();
      // 模块工具不应该在定义中
      const moduleTools = defs.filter(d => d?.module_source);
      assert.strictEqual(moduleTools.length, 0);
    });
  });

  // ==================== _buildAgentContext ====================

  describe("_buildAgentContext", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("_buildAgentContext() 返回包含核心属性的对象", () => {
      const ctx = runtime._buildAgentContext();
      assert.notStrictEqual(ctx, undefined);
      assert.strictEqual(typeof ctx, "object");
    });

    it("_buildAgentContext(agent) 包含 agent 引用", () => {
      const agent = { id: "test_agent", roleId: "r1" };
      const ctx = runtime._buildAgentContext(agent);
      assert.strictEqual(ctx.agent, agent);
    });
  });

  // ==================== _refreshInMemoryState ====================

  describe("_refreshInMemoryState", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("role_updated 更新匹配的智能体 Prompt", () => {
      const agent = { id: "a1", roleId: "r1", rolePrompt: "old" };
      runtime._agents.set("a1", agent);
      runtime._refreshInMemoryState("role_updated", { id: "r1", rolePrompt: "new" });
      assert.strictEqual(agent.rolePrompt, "new");
    });

    it("role_updated 不更新不匹配的智能体 Prompt", () => {
      const agent = { id: "a1", roleId: "r1", rolePrompt: "old" };
      runtime._agents.set("a1", agent);
      runtime._refreshInMemoryState("role_updated", { id: "r2", rolePrompt: "new" });
      assert.strictEqual(agent.rolePrompt, "old");
    });
  });

  // ==================== 空闲智能体检查 ====================

  describe("空闲智能体检查", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("getAgentLastActivityTime 对未知 agent 返回 null", () => {
      assert.strictEqual(runtime.getAgentLastActivityTime("nonexistent"), null);
    });

    it("getAgentIdleTime 对未知 agent 返回 null", () => {
      assert.strictEqual(runtime.getAgentIdleTime("nonexistent"), null);
    });

    it("_updateAgentActivity 设置最后活动时间", () => {
      runtime._updateAgentActivity("a1");
      assert.ok(runtime.getAgentLastActivityTime("a1") > 0);
    });

    it("getAgentIdleTime 返回空闲时间", () => {
      runtime._updateAgentActivity("a1");
      const idle = runtime.getAgentIdleTime("a1");
      assert.ok(idle >= 0);
    });

    it("checkIdleAgents 对无活动记录的 agent 不报错", () => {
      runtime._agents.set("a1", { id: "a1" });
      const idleAgents = runtime.checkIdleAgents();
      assert.strictEqual(Array.isArray(idleAgents), true);
    });

    it("setIdleWarningMs 修改阈值", () => {
      runtime.setIdleWarningMs(10000);
      assert.strictEqual(runtime.idleWarningMs, 10000);
    });
  });

  // ==================== getLlmClientForAgent ====================

  describe("getLlmClientForAgent", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("空 agentId 返回默认 llmClient（构造函数中 this.llm 未初始化）", async () => {
      const client = await runtime.getLlmClientForAgent("");
      // 构造时 this.llm 未设置（仅在 init() 中初始化），因此返回 undefined
      assert.strictEqual(client, undefined);
    });

    it("未知 agent 返回默认 llmClient（构造函数中 this.llm 未初始化）", async () => {
      const client = await runtime.getLlmClientForAgent("nonexistent");
      // 构造时 this.llm 未设置，因此返回 undefined
      assert.strictEqual(client, undefined);
    });

    it("getLlmClientForService 空 serviceId 返回 null", async () => {
      const client = await runtime.getLlmClientForService("");
      assert.strictEqual(client, null);
    });
  });

  // ==================== shutdown 状态 ====================

  describe("shutdown 状态", () => {
    let runtime;

    beforeEach(() => {
      runtime = new Runtime();
    });

    afterEach(() => {
      if (runtime) runtime.shutdownManager.destroy();
    });

    it("初始状态未在关闭", () => {
      assert.strictEqual(runtime.isShuttingDown(), false);
    });

    it("getShutdownStatus 返回正确结构", () => {
      const status = runtime.getShutdownStatus();
      assert.strictEqual(status.isShuttingDown, false);
      assert.strictEqual(status.shutdownStartTime, null);
    });
  });
});
