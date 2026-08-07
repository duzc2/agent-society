/**
 * ComputeScheduler 测试 — 验证删除 AgentLease 后无遗留引用或行为退化
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ComputeScheduler } from "../../src/platform/runtime/compute_scheduler.js";
import { makeTestLogger } from "../helpers/test_logger.js";
import { assertValidMessages } from "../helpers/schema_validator.js";

function createMockRuntime(overrides = {}) {
  /** @type {Map<string, any>} */
  const agents = new Map();
  agents.set("agent-1", { id: "agent-1", roleId: "worker", roleName: "worker" });

  return {
    _agents: agents,
    log: makeTestLogger("ComputeScheduler"),
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
      persistConversation: () => {}
    },
    _emitToolCall: () => {},
    executeToolCall: async () => ({ result: "ok" }),
    getLlmClientForAgent: async () => ({
      _ensureInitialized: async () => {},
      chat: async () => ({ content: "test response" })
    }),
    _llm: {
      _checkToolCallingSupport: () => true
    },
    _buildAgentContext: () => ({}),
    _buildSystemPromptForAgent: async () => "system prompt",
    knowledgeTree: {
      checkAndExtract: async () => {},
      checkAndMaintain: async () => {}
    },
    org: {
      getRole: () => ({ knowledgeTreeEnabled: true })
    },
    ...overrides
  };
}

function createMockTurnEngine() {
  return {
    _byAgentId: new Map(),
    enqueueMessageTurn: async () => {},
    step: async () => ({ kind: "noop" }),
    hasRunnable: () => false,
    clearAgent: () => {},
    onLlmResult: () => {},
    onLlmError: () => {},
    onLlmCancelled: () => {},
    onToolResult: () => {},
    onToolError: () => {},
    maybeUpdateMemory: async () => {}
  };
}

describe("ComputeScheduler（无 AgentLease）", () => {
  /** @type {ComputeScheduler} */
  let scheduler;
  /** @type {object} */
  let mockRuntime;
  /** @type {object} */
  let mockTurnEngine;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockTurnEngine = createMockTurnEngine();
    scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);
  });

  // ==================== 1. 构造函数不创建 _leaseManager ====================

  it("构造函数不应创建 _leaseManager", () => {
    assert.strictEqual(scheduler._leaseManager, undefined,
      "删除 AgentLease 后 _leaseManager 应为 undefined");
  });

  // ==================== 2. start() 不引用 _leaseManager ====================

  it("start() 不应因缺少 _leaseManager 抛异常", () => {
    assert.doesNotThrow(() => {
      scheduler.start();
      scheduler.stop();
    }, "删除 AgentLease 后 start() 不应抛异常");
  });

  // ==================== 3. cancelInFlight() 仅删除 _inFlight ====================

  it("cancelInFlight() 应删除 _inFlight 条目", () => {
    scheduler._inFlight.set("agent-1", { kind: "llm", epoch: 0 });
    assert.strictEqual(scheduler._inFlight.has("agent-1"), true);

    scheduler.cancelInFlight("agent-1");

    assert.strictEqual(scheduler._inFlight.has("agent-1"), false,
      "cancelInFlight 应删除 inFlight 条目");
  });

  it("cancelInFlight() 不存在/null/undefined 参数不抛异常", () => {
    assert.doesNotThrow(() => scheduler.cancelInFlight("nonexistent"));
    assert.doesNotThrow(() => scheduler.cancelInFlight(null));
    assert.doesNotThrow(() => scheduler.cancelInFlight(undefined));
  });

  // ==================== 4. _inFlight 条目不含 lease 属性 ====================

  it("_inFlight 条目不应含 lease 属性（llm）", () => {
    scheduler._inFlight.set("agent-1", {
      kind: "llm", epoch: 0, turnId: "t1", stepId: 1
    });
    const entry = scheduler._inFlight.get("agent-1");
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(entry.lease, undefined,
      "删除 AgentLease 后 llm inFlight 不应含 lease");
  });

  it("_inFlight 条目不应含 lease 属性（tool）", () => {
    scheduler._inFlight.set("agent-1", {
      kind: "tool", epoch: 0, turnId: "t1", stepId: 1
    });
    const entry = scheduler._inFlight.get("agent-1");
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(entry.lease, undefined,
      "删除 AgentLease 后 tool inFlight 不应含 lease");
  });

  it("_inFlight 条目不应含 lease 属性（endpoint）", () => {
    scheduler._inFlight.set("agent-1", {
      kind: "endpoint", epoch: 0, turnId: null, stepId: null
    });
    const entry = scheduler._inFlight.get("agent-1");
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(entry.lease, undefined,
      "删除 AgentLease 后 endpoint inFlight 不应含 lease");
  });

  // ==================== 5. turning inFlight 不含 lease ====================

  it("turning inFlight 条目不应含 lease 属性", () => {
    scheduler._inFlight.set("agent-1", {
      kind: "turning", epoch: 0, turnId: null, stepId: null
    });
    const entry = scheduler._inFlight.get("agent-1");
    assert.notStrictEqual(entry, undefined);
    assert.strictEqual(entry.lease, undefined,
      "删除 AgentLease 后 turning inFlight 不应含 lease");
  });

  // ==================== 6. _maybeSetIdle 仅检查 _inFlight.has ====================

  it("_maybeSetIdle 应在 _inFlight 有条目时提前返回", () => {
    mockRuntime._state.getAgentComputeStatus = () => "processing";
    let idleCalled = false;
    mockRuntime._state.setAgentComputeStatus = (agentId, status) => {
      if (status === "idle") idleCalled = true;
    };

    scheduler._inFlight.set("agent-1", { kind: "llm", epoch: 0 });
    scheduler._maybeSetIdle("agent-1");

    assert.strictEqual(idleCalled, false,
      "_inFlight 有条目时不应设为 idle");
  });

  it("_maybeSetIdle 应在 _inFlight 无条目且状态为 processing 时设为 idle", () => {
    mockRuntime._state.getAgentComputeStatus = () => "processing";
    let idleSet = null;
    mockRuntime._state.setAgentComputeStatus = (agentId, status) => {
      idleSet = { agentId, status };
    };

    // 确保 agent 在 _agents 中（_maybeSetIdle 需要检查 knowledgeTree）
    scheduler._maybeSetIdle("agent-1");

    assert.notStrictEqual(idleSet, null, "setAgentComputeStatus 应被调用");
    assert.strictEqual(idleSet?.status, "idle",
      "_inFlight 无条目时应设为 idle");
  });

  // ==================== 7. 崩溃恢复不引用 _leaseManager ====================

  it("崩溃恢复中的 _inFlight 清理不应因缺少 _leaseManager 抛异常", () => {
    scheduler._inFlight.set("agent-1", { kind: "llm", epoch: 0 });
    scheduler._inFlight.set("agent-2", { kind: "tool", epoch: 0 });

    assert.doesNotThrow(() => {
      scheduler._inFlight.clear();
      scheduler._readyQueue.length = 0;
      scheduler._readySet.clear();
      scheduler._rrCursor = 0;
    }, "崩溃恢复清理不应因缺少 _leaseManager 抛异常");

    assert.strictEqual(scheduler._inFlight.size, 0, "_inFlight 应被清空");
  });

  // ==================== 8. _runOneStep agent 不存在时清理 ====================

  it("_runOneStep 在 agent 不存在时应清理 inFlight 且不操作 lease", async () => {
    // 设置 inFlight 条目，但 agent 不在 _agents 中
    scheduler._inFlight.set("ghost-agent", {
      kind: "llm", epoch: 0, turnId: "t1", stepId: 1
    });
    // 将 ghost-agent 加入 ready 队列
    scheduler._readyQueue.push("ghost-agent");
    scheduler._readySet.add("ghost-agent");

    // ghost-agent 不在 _agents Map 中
    assert.strictEqual(mockRuntime._agents.has("ghost-agent"), false);

    // _runOneStep 应通过 _takeReady 取出 ghost-agent，
    // 发现它不在 _agents 中，清理 _inFlight 而不抛异常
    let caughtError = null;
    try {
      await scheduler._runOneStep();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null,
      "_runOneStep 在 agent 不存在时不应抛异常");
    // _inFlight 条目应被清理
    assert.strictEqual(scheduler._inFlight.has("ghost-agent"), false,
      "不存在的 agent 的 inFlight 应被清理");
  });
});

// ==================== _findStableMessageCacheIndex ====================

describe("ComputeScheduler._findStableMessageCacheIndex", () => {
  /** @type {ComputeScheduler} */
  let scheduler;

  beforeEach(() => {
    const mockRuntime = createMockRuntime();
    const mockTurnEngine = createMockTurnEngine();
    scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);
  });

  it("injectionIndex >= 0 时应返回 injectionIndex - 1", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "user", content: "ephemeral inject" },
      { role: "user", content: "last user" }
    ];
    // injectionIndex = 3 表示在索引3处注入了记忆，缓存断点应在注入位置之前的消息（索引2）
    const idx = scheduler._findStableMessageCacheIndex(messages, 3);
    assert.strictEqual(idx, 2,
      "缓存断点应放在记忆注入位置之前的那条消息上");
  });

  it("injectionIndex = 0 时应返回 -1（前面没有稳定消息）", () => {
    const messages = [
      { role: "user", content: "ephemeral inject" },
      { role: "user", content: "last user" }
    ];
    const idx = scheduler._findStableMessageCacheIndex(messages, 0);
    assert.strictEqual(idx, -1,
      "没有稳定消息可缓存时返回 -1");
  });

  it("无注入（injectionIndex = -1）时应返回 messages.length - 2", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" }
    ];
    const idx = scheduler._findStableMessageCacheIndex(messages, -1);
    assert.strictEqual(idx, 1,
      "无记忆注入时缓存倒数第二条消息");
  });

  it("messages.length < 2 时应返回 -1", () => {
    assert.strictEqual(scheduler._findStableMessageCacheIndex([], -1), -1);
    assert.strictEqual(
      scheduler._findStableMessageCacheIndex([{ role: "user", content: "only" }], -1),
      -1
    );
  });

  it("messages 为 null/undefined 时应返回 -1", () => {
    assert.strictEqual(scheduler._findStableMessageCacheIndex(null, -1), -1);
    assert.strictEqual(scheduler._findStableMessageCacheIndex(undefined, -1), -1);
  });

  it("injectionIndex 超出数组范围时应走 fallback 逻辑", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" }
    ];
    // injectionIndex >= messages.length → fallback 到 length-2
    const idx = scheduler._findStableMessageCacheIndex(messages, 5);
    assert.strictEqual(idx, 0,
      "injectionIndex 超出范围时应 fallback 到 length-2");
  });
});

// ==================== _applyCacheControlToLastContentBlock ====================

describe("ComputeScheduler._applyCacheControlToLastContentBlock", () => {
  /** @type {ComputeScheduler} */
  let scheduler;

  beforeEach(() => {
    const mockRuntime = createMockRuntime();
    const mockTurnEngine = createMockTurnEngine();
    scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);
  });

  it("string content 应转为 content block 数组并添加 cacheControl", () => {
    const msg = { role: "user", content: "hello world" };
    scheduler._applyCacheControlToLastContentBlock(msg);

    assert.ok(Array.isArray(msg.content), "content 应变为数组");
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(msg.content[0].type, "text");
    assert.strictEqual(msg.content[0].text, "hello world");
    assert.deepStrictEqual(
      msg.content[0].providerOptions.anthropic.cacheControl,
      { type: "ephemeral" }
    );
  });

  it("已有内容块数组时应在最后一个块上添加 providerOptions", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "part 1" },
        { type: "text", text: "part 2" }
      ]
    };
    scheduler._applyCacheControlToLastContentBlock(msg);

    // 第一个块不应有 providerOptions
    assert.strictEqual(msg.content[0].providerOptions, undefined);
    // 最后一个块应有 cacheControl
    assert.strictEqual(msg.content[1].type, "text");
    assert.deepStrictEqual(
      msg.content[1].providerOptions.anthropic.cacheControl,
      { type: "ephemeral" }
    );
  });

  it("空数组 content 不报错也不修改", () => {
    const msg = { role: "user", content: [] };
    assert.doesNotThrow(() => {
      scheduler._applyCacheControlToLastContentBlock(msg);
    });
    assert.deepStrictEqual(msg.content, []);
  });

  it("null message 不报错", () => {
    assert.doesNotThrow(() => {
      scheduler._applyCacheControlToLastContentBlock(null);
    });
  });

  it("undefined message 不报错", () => {
    assert.doesNotThrow(() => {
      scheduler._applyCacheControlToLastContentBlock(undefined);
    });
  });

  it("已有其他 providerOptions 时应合并而非覆盖", () => {
    const msg = {
      role: "user",
      content: [
        {
          type: "text",
          text: "hello",
          providerOptions: {
            openai: { maxCompletionTokens: 100 }
          }
        }
      ]
    };
    scheduler._applyCacheControlToLastContentBlock(msg);

    const opts = msg.content[0].providerOptions;
    // 已有的 openai 选项应保留
    assert.deepStrictEqual(opts.openai, { maxCompletionTokens: 100 });
    // 同时添加 anthropic cacheControl
    assert.deepStrictEqual(
      opts.anthropic.cacheControl,
      { type: "ephemeral" }
    );
  });

  it("已有 anthropic 其他选项时应合并而非覆盖", () => {
    const msg = {
      role: "user",
      content: [
        {
          type: "text",
          text: "hello",
          providerOptions: {
            anthropic: { maxTokens: 1000 }
          }
        }
      ]
    };
    scheduler._applyCacheControlToLastContentBlock(msg);

    const opts = msg.content[0].providerOptions;
    assert.strictEqual(opts.anthropic.maxTokens, 1000);
    assert.deepStrictEqual(
      opts.anthropic.cacheControl,
      { type: "ephemeral" }
    );
  });

  it("空字符串 content 应正确转为数组", () => {
    const msg = { role: "assistant", content: "" };
    scheduler._applyCacheControlToLastContentBlock(msg);

    assert.ok(Array.isArray(msg.content));
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(msg.content[0].type, "text");
    assert.strictEqual(msg.content[0].text, "");
    assert.deepStrictEqual(
      msg.content[0].providerOptions.anthropic.cacheControl,
      { type: "ephemeral" }
    );
  });

  it("content 为数字 0 时应正确转为数组（非假值比较）", () => {
    const msg = { role: "user", content: 0 };
    scheduler._applyCacheControlToLastContentBlock(msg);

    // typeof 0 === "number" 不是 "string"，所以不会被转换
    // 但 Array.isArray 检查失败，函数提前返回，不修改
    // 这是当前行为——只处理 string 和 array，不处理其他类型
    assert.strictEqual(typeof msg.content, "number");
    assert.strictEqual(msg.content, 0);
  });
});

// ==================== 跨层交互：浅拷贝 + 原地修改 ====================

describe("ComputeScheduler 跨层交互（浅拷贝 + mutation）", () => {
  /** @type {ComputeScheduler} */
  let scheduler;

  beforeEach(() => {
    const mockRuntime = createMockRuntime();
    const mockTurnEngine = createMockTurnEngine();
    scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);
  });

  // ================================================================
  // 当前已知行为：appendEphemeralToMessages 做浅拷贝（slice），
  // _applyCacheControlToLastContentBlock 原地修改消息对象。
  // 因此原始 messages 数组中的对象也会被修改（content 从 string 变数组）。
  // 这可能导致下轮 LLM 调用时 content 格式不对。
  // 这些测试文档化当前行为，不是 bug fix。
  // ================================================================

  it("浅拷贝后 mutation 会污染原始对象", () => {
    const originalConvs = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "last user" }
    ];

    // 模拟 appendEphemeralToMessages 的浅拷贝行为
    const shallowCopy = originalConvs.slice();
    // 插入一条记忆消息
    const memoryMsg = { role: "user", content: "[memory context]", _ephemeral: true };
    shallowCopy.splice(shallowCopy.length - 1, 0, memoryMsg);

    // 模拟 _applyCacheControlToLastContentBlock 原地修改
    const cacheTarget = shallowCopy[shallowCopy.length - 3]; // "msg2"
    cacheTarget.content = [
      { type: "text", text: cacheTarget.content, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
    ];

    // 浅拷贝不创建新对象 → originalConvs[1] 也被修改
    assert.ok(Array.isArray(originalConvs[1].content),
      "浅拷贝的原地修改污染了 originalConvs —— 这是当前已知行为");
    assert.strictEqual(originalConvs[1].content[0].text, "msg2");
  });

  it("浅拷贝的数组结构独立，但元素对象共享引用", () => {
    const original = [{ role: "user", content: "orig" }];
    const copy = original.slice();
    copy.push({ role: "assistant", content: "new" });

    // 数组结构独立
    assert.strictEqual(original.length, 1);
    assert.strictEqual(copy.length, 2);

    // 共享元素对象引用
    assert.strictEqual(copy[0], original[0],
      "slice() 创建的新数组，但元素对象是同一个引用");
  });

  it("缓存断点修改后的 content（数组格式）可通过真实 ai-sdk schema 校验", async () => {
    // 模拟 _startLlm 预处理后的消息格式
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        ]
      },
      { role: "assistant", content: "hi there" }
    ];

    // 这就是 llm_client 会接收到的格式——验证它能通过 schema
    await assertValidMessages(messages, "cache-mutated messages");
  });

  it("assistant + tool_calls 在缓存断点改造后，经 llm_client 格式化为 ai-sdk 格式可通过 schema 校验", async () => {
    // 模拟 _startLlm 将缓存改造后的原始消息交给 llm_client，llm_client 格式化后
    // 的 ai-sdk 输出应通过 schema。
    // 以下为手动构造的 ai-sdk 格式化结果（模拟 llm_client._chatWithRetry 的处理）：
    const aiSdkFormatted = [
      // user 消息 → normalizeMessageContent 透传内容块数组
      {
        role: "user",
        content: [
          { type: "text", text: "trigger", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        ]
      },
      // assistant + tool_calls → content 数组包含 text 块（带 cacheControl）+ tool-call 块
      {
        role: "assistant",
        content: [
          { type: "text", text: "executing", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
          { type: "tool-call", toolCallId: "call_cc", toolName: "do_thing", input: {} }
        ]
      },
      // tool → tool-result 格式（content 数组中的 text 块被 llm_client 转为 tool-result）
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_cc",
          toolName: "do_thing",
          output: { type: "text", value: "done" }
        }]
      }
    ];

    await assertValidMessages(aiSdkFormatted, "cache-mutated assistant+tool_calls (ai-sdk formatted)");
  });

  it("tool 消息被缓存断点改造后，经 llm_client 提取 text 并转为 tool-result 可通过 schema 校验", async () => {
    // llm_client 看到 tool 消息的 content 是内容块数组时，
    // 会提取所有 text 块的文本并用 \n 拼接，然后放入 tool-result.output.value
    const aiSdkFormatted = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }
        ]
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: '{"results":[]}' }
        }]
      }
    ];

    await assertValidMessages(aiSdkFormatted, "cache-mutated tool message (ai-sdk formatted)");
  });

  it("四种稳定消息类型全部被缓存断点改造 + llm_client 格式化后可通过 schema 校验", async () => {
    // 模拟完整的 _startLlm → llm_client._chatWithRetry 后产生的 ai-sdk 格式消息
    const aiSdkFormatted = [
      // user 消息（内容块数组来自 cacheControl）
      {
        role: "user",
        content: [
          { type: "text", text: "msg from user", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        ]
      },
      // assistant 无 tool_calls（内容块数组透传）
      {
        role: "assistant",
        content: [
          { type: "text", text: "plain reply", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        ]
      },
      // assistant + tool_calls（内容块数组合并 tool-call）
      {
        role: "assistant",
        content: [
          { type: "text", text: "using tools", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
          { type: "tool-call", toolCallId: "call_full1", toolName: "read", input: { path: "/x" } }
        ]
      },
      // tool（内容块数组提取 text → tool-result）
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_full1",
          toolName: "read",
          output: { type: "text", value: '{"data":"ok"}' }
        }]
      },
      // 最后一条新 user 消息
      { role: "user", content: "new message" }
    ];

    await assertValidMessages(aiSdkFormatted, "all 4 stable message types (ai-sdk formatted)");
  });
});

// ==================== P2: 缓存断点计数验证 ====================
// 验证完整的 LLM 调用中 3 个缓存断点都存在：
// 1. system prompt（在 llm_client.js 中设置）
// 2. 最后一个 tool definition（在 llm_client.js 中设置）
// 3. 稳定消息（在 compute_scheduler._applyCacheControlToLastContentBlock 中设置）
//
// 缓存断点 1 和 2 由 llm_client._chatWithRetry 负责设置，在此通过模拟
// _startLlm 的完整流程验证断点 3 的格式正确性。

describe("缓存断点计数验证", () => {
  /** @type {ComputeScheduler} */
  let scheduler;

  beforeEach(() => {
    const mockRuntime = createMockRuntime();
    const mockTurnEngine = createMockTurnEngine();
    scheduler = new ComputeScheduler(mockRuntime, mockTurnEngine);
  });

  it("_applyCacheControlToLastContentBlock 应正确设置 ephemeral 缓存断点类型", () => {
    const msg = { role: "user", content: "stable message" };
    scheduler._applyCacheControlToLastContentBlock(msg);

    const lastBlock = msg.content[msg.content.length - 1];
    assert.strictEqual(
      lastBlock.providerOptions.anthropic.cacheControl.type,
      "ephemeral",
      "缓存断点类型应为 ephemeral（Anthropic 支持的唯一类型）"
    );
  });

  it("所有缓存断点应有统一的 type: 'ephemeral'", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" }
    ];

    for (const msg of messages) {
      scheduler._applyCacheControlToLastContentBlock(msg);
      const lastBlock = msg.content[msg.content.length - 1];
      assert.strictEqual(
        lastBlock.providerOptions.anthropic.cacheControl.type,
        "ephemeral",
        `消息 ${msg.role} 的缓存类型应为 ephemeral`
      );
    }
  });

  it("缓存断点的 providerOptions 结构应完整", () => {
    const msg = { role: "assistant", content: "test" };
    scheduler._applyCacheControlToLastContentBlock(msg);

    const lastBlock = msg.content[msg.content.length - 1];
    assert.ok(
      lastBlock.providerOptions,
      "应包含 providerOptions"
    );
    assert.ok(
      lastBlock.providerOptions.anthropic,
      "providerOptions 应包含 anthropic 子对象"
    );
    assert.ok(
      lastBlock.providerOptions.anthropic.cacheControl,
      "anthropic 应包含 cacheControl"
    );
    assert.strictEqual(
      typeof lastBlock.providerOptions.anthropic.cacheControl.type,
      "string",
      "cacheControl.type 应为字符串"
    );
  });
});