/**
 * 调度器死循环修复回归测试
 *
 * 背景（2026-08-30 生产日志 20260830-201057）：
 *   LLM API 不可用（402 → ECONNRESET）触发 ComputeScheduler 重试流程，
 *   1. ComputeScheduler 构造函数按值捕获 runtime._retryCoordinator，但该属性
 *      在 bootstrap() 阶段才赋值 → 调度器永远持有 undefined，
 *      _retryLlmCall 调用 scheduleRetry 时抛 TypeError → 未处理Promise拒绝；
 *   2. 异常逃逸导致 onLlmError 永远不执行，turn 永久卡死在 waiting_llm；
 *   3. 调度器 noop 分支发现 hasRunnable 为 true 便 _markReady 重新入队，
 *      形成 ~110ms 一圈的死循环；
 *   4. unhandledRejection 处理器只记录不退出，进程成为僵尸。
 *
 * 本文件验证上述四层修复各自生效。
 *
 * 第二部分（端到端复现）：用真实 TurnEngine 复现生产日志的完整因果链——
 * turn 卡在 waiting_llm、LLM 持续 ECONNRESET、重试链（成功/耗尽）、调度循环
 * 反复驱动——并断言循环在有限步内收敛（修复前会无限重入队）。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { ComputeScheduler } from "../../src/platform/runtime/compute_scheduler.js";
import { Runtime } from "../../src/platform/core/runtime.js";
import { RetryCoordinator } from "../../src/platform/runtime/retry_coordinator.js";
import { TurnEngine } from "../../src/platform/runtime/turn_engine.js";
import { ShutdownManager } from "../../src/platform/runtime/shutdown_manager.js";
import { makeTestLogger } from "../helpers/test_logger.js";

/** 等待若干轮事件循环，让 fire-and-forget 的 promise 链跑完 */
async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function createMockRuntime(overrides = {}) {
  const agents = new Map();
  agents.set("agent-1", { id: "agent-1", roleId: "worker", roleName: "worker" });

  return {
    _agents: agents,
    log: makeTestLogger("SchedulerDeadloopFix"),
    _state: {
      getAgentComputeStatus: () => "idle",
      setAgentComputeStatus: () => {},
      setAgentComputePhase: () => {},
      markAgentAsActivelyProcessing: () => {},
      unmarkAgentAsActivelyProcessing: () => {},
    },
    _cancelManager: {
      getEpoch: () => 0,
      newScope: () => ({ epoch: 0, signal: { aborted: false }, assertActive: () => {} })
    },
    bus: {
      deliverDueMessages: () => {},
      receiveNext: () => null,
      hasPending: () => false,
      waitForMessage: async () => {},
      send: () => {},
      getQueueDepth: () => 0
    },
    _conversationManager: {
      persistConversation: () => {},
      buildContextStatusPrompt: async () => null
    },
    _emitToolCall: () => {},
    _buildSystemPromptForAgent: async () => "system prompt",
    _llm: {
      _checkToolCallingSupport: () => true,
      appendEphemeralToMessages: (messages) => ({ messages, injectionIndex: -1 })
    },
    ...overrides
  };
}

function createMockTurnEngine(overrides = {}) {
  return {
    _byAgentId: new Map(),
    step: async () => ({ kind: "noop" }),
    hasRunnable: () => false,
    clearAgent: () => {},
    onLlmResult: () => {},
    onLlmError: () => {},
    onLlmCancelled: () => {},
    onToolResult: () => {},
    onToolError: () => {},
    maybeUpdateMemory: async () => {},
    ...overrides
  };
}

// ==================== 修复 1：RetryCoordinator 初始化顺序 ====================

describe("修复1: Runtime 构造函数必须先创建 _retryCoordinator 再构造 ComputeScheduler", () => {
  /** @type {Runtime|null} */
  let runtime = null;

  afterEach(() => {
    if (runtime) {
      runtime.shutdownManager.destroy();
      runtime = null;
    }
  });

  it("Runtime 构造完成后 _retryCoordinator 应存在且为 RetryCoordinator 实例", () => {
    runtime = new Runtime();
    assert.ok(runtime._retryCoordinator instanceof RetryCoordinator,
      "Runtime 构造函数应创建 _retryCoordinator（修复前要到 bootstrap() 才赋值）");
  });

  it("ComputeScheduler 构造函数捕获的必须是 Runtime 上的同一个实例（修复前为 undefined）", () => {
    runtime = new Runtime();
    assert.strictEqual(runtime._computeScheduler._retryCoordinator, runtime._retryCoordinator,
      "ComputeScheduler 构造时应能捕获到已存在的 _retryCoordinator，而不是 undefined");
  });

  it("bootstrap_manager 不应再重复创建 _retryCoordinator（避免覆盖调度器持有的引用）", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../src/platform/runtime/bootstrap_manager.js", import.meta.url), "utf8");
    assert.ok(!source.includes("new RetryCoordinator()"),
      "bootstrap_manager.js 不应再创建 RetryCoordinator（创建职责已移入 Runtime 构造函数）");
  });
});

// ==================== 修复 2：重试流程崩溃时强制终结回合 ====================

describe("修复2: _retryLlmCall 自身崩溃时必须终结回合而不是让异常逃逸", () => {
  it("scheduleRetry 崩溃（_retryCoordinator 缺失）时应调用 onLlmError 并回到 idle", async () => {
    const onLlmErrorCalls = [];
    const statusCalls = [];
    const mockRuntime = createMockRuntime({
      // 故意不提供 _retryCoordinator，复现修复前的崩溃条件
      _state: {
        getAgentComputeStatus: () => "idle",
        setAgentComputeStatus: (agentId, status) => statusCalls.push(status),
        setAgentComputePhase: () => {},
        markAgentAsActivelyProcessing: () => {},
        unmarkAgentAsActivelyProcessing: () => {},
      }
    });
    const mockTurnEngine = createMockTurnEngine({
      hasRunnable: () => false,
      onLlmError: (agentId, input) => onLlmErrorCalls.push({ agentId, input })
    });
    const scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);

    // LLM 调用以可重试错误失败（ECONNRESET → 分类为 network）
    mockRuntime.getLlmClientForAgent = async () => ({
      _ensureInitialized: async () => {},
      chat: async () => {
        throw new Error("Cannot connect to API: read ECONNRESET");
      }
    });

    const outcome = {
      turnId: "t-fix2",
      stepId: 5,
      ctx: {},
      request: { messages: [{ role: "user", content: "hi" }] }
    };

    await scheduler._startLlm("agent-1", outcome, null);
    await flushMicrotasks();

    assert.strictEqual(onLlmErrorCalls.length, 1,
      "重试流程崩溃后必须调用 onLlmError 终结回合（修复前异常逃逸，turn 永久卡死在 waiting_llm）");
    assert.strictEqual(onLlmErrorCalls[0].input.turnId, "t-fix2");
    assert.ok(onLlmErrorCalls[0].input.error instanceof TypeError,
      "捕获的应是重试流程抛出的 TypeError");
    assert.ok(
      onLlmErrorCalls[0].input.error.message.includes("scheduleRetry"),
      `错误应指向 scheduleRetry 崩溃，实际: ${onLlmErrorCalls[0].input.error.message}`
    );
    assert.ok(statusCalls.includes("retrying"), "应先进入 retrying 状态");
    assert.strictEqual(statusCalls[statusCalls.length - 1], "idle", "最终必须回到 idle");
  });
});

// ==================== 修复 3：孤儿回合保护（noop 死环） ====================

describe("修复3: noop + hasRunnable 的孤儿回合必须被终结而不是重新入队", () => {
  it("turn 卡在等待阶段且无 in-flight LLM/tool 时，应走 onLlmError 强制终结", async () => {
    const onLlmErrorCalls = [];
    const statusCalls = [];
    const mockRuntime = createMockRuntime({
      _state: {
        getAgentComputeStatus: () => "idle",
        setAgentComputeStatus: (agentId, status) => statusCalls.push(status),
        setAgentComputePhase: () => {},
        markAgentAsActivelyProcessing: () => {},
        unmarkAgentAsActivelyProcessing: () => {},
      }
    });
    const orphanEntry = {
      activeTurn: { turnId: "t-orphan", phase: "waiting_llm", round: 1, lastStepId: 3 },
      queue: []
    };
    const mockTurnEngine = createMockTurnEngine({
      _byAgentId: new Map([["agent-1", orphanEntry]]),
      hasRunnable: () => true, // 卡死的 activeTurn 使 hasRunnable 恒为 true（死环条件）
      step: async () => ({ kind: "noop" }),
      onLlmError: (agentId, input) => onLlmErrorCalls.push({ agentId, input })
    });
    const scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);

    scheduler._markReady("agent-1");
    const progressed = await scheduler._runOneStep();

    assert.strictEqual(progressed, false);
    assert.strictEqual(onLlmErrorCalls.length, 1,
      "孤儿回合必须被强制终结（修复前会 _markReady 重新入队形成死循环）");
    assert.strictEqual(onLlmErrorCalls[0].input.turnId, "t-orphan");
    assert.ok(
      onLlmErrorCalls[0].input.error.message.includes("孤儿回合"),
      `错误信息应说明孤儿回合保护，实际: ${onLlmErrorCalls[0].input.error.message}`
    );
    assert.strictEqual(statusCalls[statusCalls.length - 1], "idle");
  });

  it("正常 noop（无可运行回合）不应触发孤儿终结", async () => {
    const onLlmErrorCalls = [];
    const mockRuntime = createMockRuntime();
    const mockTurnEngine = createMockTurnEngine({
      hasRunnable: () => false,
      step: async () => ({ kind: "noop" }),
      onLlmError: (agentId, input) => onLlmErrorCalls.push({ agentId, input })
    });
    const scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);

    scheduler._markReady("agent-1");
    await scheduler._runOneStep();

    assert.strictEqual(onLlmErrorCalls.length, 0,
      "无回合时的正常 noop 应走 _maybeSetIdle，不应误伤");
  });
});

// ==================== 修复 4：unhandledRejection 必须触发优雅关机 ====================

describe("修复4: unhandledRejection 应记录完整堆栈并触发优雅关机", () => {
  it("拒绝发生时应记录事件（含 stack）、启动关机并以 exit(1) 结束", async () => {
    const runtime = new Runtime();
    const sm = runtime.shutdownManager;
    const exitCalls = [];
    const shutdownSignals = [];
    const originalExit = process.exit;

    try {
      // 替换 _shutdown，避免真实执行六阶段清理钩子
      sm._shutdown = async (signal) => { shutdownSignals.push(signal); };
      // 替换 process.exit，防止测试进程被杀
      process.exit = (code) => { exitCalls.push(code); };

      const boom = new TypeError("Cannot read properties of undefined (reading 'scheduleRetry')");
      sm._unhandledRejectionHandler(boom);
      await new Promise((r) => setImmediate(r));

      assert.deepStrictEqual(shutdownSignals, ["unhandledRejection"],
        "应触发优雅关机，信号名为 unhandledRejection");
      assert.deepStrictEqual(exitCalls, [1], "关机完成后应以 exit(1) 结束");

      const lastEvent = sm._exitEvents[sm._exitEvents.length - 1];
      assert.strictEqual(lastEvent.event, "UNHANDLED_REJECTION");
      assert.ok(lastEvent.details.stack?.includes("scheduleRetry"),
        "记录的退出事件必须包含完整堆栈（修复前只有 message）");
    } finally {
      process.exit = originalExit;
      sm.destroy();
    }
  });
});

// ==================== 第二部分：端到端复现生产事故因果链 ====================
//
// 用【真实的 TurnEngine】（不是 mock）复现生产日志 20260830-201057 的完整时序：
//   1. 消息入队 → turn 进入 waiting_llm，LLM 以 ECONNRESET 持续失败
//   2. 调度器尝试重试：第一次 scheduleRetry 崩溃（修复前 _retryCoordinator 为 undefined）
//      → 验证修复 2 兜底终结回合
//   3. 无论哪条路终结，循环必须在有限步内收敛为 idle，不允许出现
//      生产日志里 ~110ms 一圈的 "step() 入口 → noop → _markReady" 重入队死循环
//   4. 并验证正常路径：重试后 LLM 恢复 → 回合正常完成发送回复

describe("端到端复现: 生产死循环因果链（真实 TurnEngine + 真实状态机）", () => {
  /**
   * 构建一个接近真实的运行时 mock：真实 TurnEngine + ComputeScheduler，
   * 其余依赖用最小 stub。返回 { runtime, turnEngine, scheduler }。
   */
  function buildE2ERuntime({ chatImpl }) {
    const statusMap = new Map();
    const phaseMap = new Map();
    const emittedErrors = [];
    const sentMessages = [];

    const mockRuntime = {
      _agents: new Map([["agent-1", { id: "agent-1", roleId: "worker", roleName: "worker" }]]),
      log: makeTestLogger("E2E-Deadloop"),
      _state: {
        getAgentComputeStatus: (id) => statusMap.get(id) ?? "idle",
        setAgentComputeStatus: (id, s) => { statusMap.set(id, s); },
        setAgentComputePhase: (id, p) => { phaseMap.set(id, p); },
        markAgentAsActivelyProcessing: () => {},
        unmarkAgentAsActivelyProcessing: () => {},
      },
      _cancelManager: {
        getEpoch: () => 0,
        newScope: () => ({ epoch: 0, signal: { aborted: false }, assertActive: () => {} })
      },
      _retryCoordinator: new RetryCoordinator({ slotMs: 1, baseDelayMs: 1, maxDelayMs: 5 }), // 加速退避
      bus: {
        deliverDueMessages: () => {},
        receiveNext: () => null,
        hasPending: () => false,
        waitForMessage: async () => {},
        send: (msg) => sentMessages.push(msg),
        getQueueDepth: () => 0,
        drainAll: () => []
      },
      _conversationManager: {
        persistConversation: () => {},
        buildContextStatusPrompt: async () => null,
        updateTokenUsage: () => {},
        processAutoCompression: async () => {}
      },
      _emitToolCall: () => {},
      _emitError: (evt) => emittedErrors.push(evt),
      _formatMessageForLlm: async (_ctx, msg) => (msg?.payload?.text ?? "msg"),
      _ensureConversation: () => [],
      _buildAgentContext: () => ({}),
      _buildSystemPromptForAgent: async () => "system prompt",
      getToolDefinitionsForAgent: () => [],
      _llm: {
        _checkToolCallingSupport: () => true,
        buildEphemeralContexts: async () => null,
        appendEphemeralToMessages: (messages) => ({ messages, injectionIndex: -1 })
      },
      org: { getRole: () => ({ knowledgeTreeEnabled: false }) },
      knowledgeTree: null,
      executeToolCall: async () => ({ result: "ok" }),
      getLlmClientForAgent: async () => ({
        _ensureInitialized: async () => {},
        chat: chatImpl
      })
    };

    const turnEngine = new TurnEngine(mockRuntime);
    const scheduler = new ComputeScheduler(mockRuntime, turnEngine);
    return { mockRuntime, turnEngine, scheduler, statusMap, phaseMap, emittedErrors, sentMessages };
  }

  /** 驱动调度器：反复 _runOneStep，直到收敛或达到步数上限。返回 { steps, converged } */
  async function driveUntilIdle(scheduler, maxSteps = 60) {
    // 首轮：把 agent 放入就绪队列
    scheduler._markReady("agent-1");
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      const progressed = await scheduler._runOneStep();
      // 等待本步触发的 fire-and-forget 链（LLM 调用、重试退避、.finally()）落地。
      // 重试退避含 setTimeout，setImmediate 轮询足以让真实定时器在测试内跑完
      //（RetryCoordinator 在 mock 中已配置 1ms 级延迟）。
      for (let w = 0; w < 40; w++) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 1));
        // LLM in-flight 结束且回合状态稳定后即可继续下一步
        if (!scheduler._inFlight.has("agent-1") || scheduler._inFlight.get("agent-1")?.kind === "turning") {
          await flushMicrotasks(4);
          break;
        }
      }
      // 收敛判据：与生产日志死循环相反——不再有可运行回合且状态归 idle
      if (!scheduler.turnEngine.hasRunnable("agent-1")
        && (scheduler.runtime._state.getAgentComputeStatus("agent-1") ?? "idle") === "idle") {
        return { steps: steps + 1, converged: true };
      }
      if (!progressed && !scheduler.turnEngine.hasRunnable("agent-1")) {
        return { steps: steps + 1, converged: true };
      }
      if (!progressed) break; // 无进展也不再 runnable，交由上层判断
    }
    return { steps, converged: false };
  }

  it("场景1（复现事故）：重试流程崩溃后，循环必须在有限步内收敛，不允许 noop 重入队死循环", async () => {
    const { mockRuntime, turnEngine, scheduler, statusMap, emittedErrors } = buildE2ERuntime({
      // LLM 恒定 ECONNRESET —— 与生产日志一致
      chatImpl: async () => { throw new Error("Cannot connect to API: read ECONNRESET"); }
    });
    // 【复现修复前崩溃条件】移除 _retryCoordinator，让 scheduleRetry 抛 TypeError
    scheduler._retryCoordinator = undefined;

    // 入队一条消息回合（真实 TurnEngine 状态机：init → need_llm → waiting_llm）
    await turnEngine.enqueueMessageTurn("agent-1", {}, { id: "m1", from: "user", payload: { text: "你好" } });

    const { steps, converged } = await driveUntilIdle(scheduler);

    assert.strictEqual(converged, true,
      `循环必须在 ${steps} 步内收敛（修复前会无限 noop 重入队，生产日志刷了 2 万多行）`);
    assert.ok(emittedErrors.some(e => e.errorType === "llm_error"),
      "必须产生 llm_error 事件（用户可见的错误通知）");
    assert.strictEqual(statusMap.get("agent-1"), "idle");
    assert.strictEqual(turnEngine.hasRunnable("agent-1"), false,
      "卡死的回合必须被终结，不能残留 activeTurn");
  });

  it("场景2（复现事故的完整重试链）：ECONNRESET 重试全部耗尽后必须终结回合并收敛", async () => {
    const { mockRuntime, turnEngine, scheduler, statusMap, emittedErrors } = buildE2ERuntime({
      chatImpl: async () => { throw new Error("Cannot connect to API: read ECONNRESET"); }
    });

    await turnEngine.enqueueMessageTurn("agent-1", {}, { id: "m1", from: "user", payload: { text: "你好" } });
    const { steps, converged } = await driveUntilIdle(scheduler, 200);

    assert.strictEqual(converged, true,
      `重试耗尽后必须在 ${steps} 步内收敛为 idle`);
    assert.ok(emittedErrors.some(e => e.errorType === "llm_error"));
    assert.strictEqual(statusMap.get("agent-1"), "idle");
    assert.strictEqual(turnEngine.hasRunnable("agent-1"), false);
  });

  it("场景3（生产时序的正路）：LLM 短暂故障后恢复，重试应成功且回合正常完成", async () => {
    let attempts = 0;
    const { mockRuntime, turnEngine, scheduler, statusMap, sentMessages } = buildE2ERuntime({
      chatImpl: async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error("Cannot connect to API: read ECONNRESET");
        return { id: "assistant-1", content: "恢复后的回复" };
      }
    });

    await turnEngine.enqueueMessageTurn("agent-1", {}, { id: "m1", from: "user", payload: { text: "你好" } });
    const { converged } = await driveUntilIdle(scheduler, 200);

    assert.strictEqual(converged, true);
    assert.ok(attempts >= 3, `LLM 应被调用至少 3 次（2 次失败 + 1 次成功），实际 ${attempts}`);
    assert.strictEqual(sentMessages.length, 1, "恢复后应发出一条回复消息");
    assert.strictEqual(sentMessages[0]?.payload?.text, "恢复后的回复");
    assert.strictEqual(statusMap.get("agent-1"), "idle");
  });
});
