import { describe, it } from "node:test";
import assert from "node:assert";
import { TurnEngine } from "../../../src/platform/runtime/turn_engine.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

/**
 * Create a minimal runtime stub for TurnEngine history tests.
 * @returns {{runtime: any, conversations: Map<string, any[]>}}
 */
function createRuntimeStub() {
  const conversations = new Map();
  const runtime = {
    _conversations: conversations,
    _buildSystemPromptForAgent: async () => "SYSTEM_PROMPT",
    _llm: {
      buildEphemeralContexts: async () => null,
      appendEphemeralToMessages: (msgs) => ({ messages: msgs, injectionIndex: -1 })
    },
    _ensureConversation(agentId, systemPrompt) {
      let conv = conversations.get(agentId);
      if (!conv) {
        conv = [{ role: "system", content: systemPrompt }];
        conversations.set(agentId, conv);
      }
      return conv;
    },
    _conversationManager: {
      buildContextStatusPrompt: () => "",
      updateTokenUsage: () => undefined
    },
    _formatMessageForLlm: async (_ctx, message) =>
      message?.payload?.text ?? "",
    _state: {
      setAgentComputePhase: () => undefined
    },
    getToolDefinitions: () => [],
    getToolDefinitionsForAgent: () => [],
    log: makeTestLogger("TurnEngine")
  };
  return { runtime, conversations };
}

describe("TurnEngine conversation history", () => {
  it("should keep previous user and assistant messages for the next llm request", async () => {
    const { runtime } = createRuntimeStub();
    const engine = new TurnEngine(runtime);
    const ctx = { agent: { id: "agent-1" } };

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m1",
      from: "user",
      payload: { text: "first user" }
    });

    const firstOutcome = await engine.step("agent-1", null);
    assert.strictEqual(firstOutcome.kind, "need_llm");
    assert.deepStrictEqual(firstOutcome.request.messages.map((message) => message.role), [
      "system",
      "user"
    ]);

    engine.onLlmResult("agent-1", {
      turnId: firstOutcome.turnId,
      stepId: firstOutcome.stepId,
      supportsToolCalling: false,
      msg: {
        role: "assistant",
        content: "first assistant"
      }
    });

    const sendOutcome = await engine.step("agent-1", null);
    assert.strictEqual(sendOutcome.kind, "send");
    await engine.step("agent-1", null);

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m2",
      from: "user",
      payload: { text: "second user" }
    });

    const secondOutcome = await engine.step("agent-1", null);
    assert.strictEqual(secondOutcome.kind, "need_llm");
    assert.deepStrictEqual(secondOutcome.request.messages.map((message) => message.role), [
      "system",
      "user",
      "assistant",
      "user"
    ]);
    assert.strictEqual(secondOutcome.request.messages[1].content, "first user");
    assert.strictEqual(secondOutcome.request.messages[2].content, "first assistant");
    assert.strictEqual(secondOutcome.request.messages[3].content, "second user");
  });

  it("should carry reasoning_content when sending the final assistant message", async () => {
    const { runtime } = createRuntimeStub();
    const engine = new TurnEngine(runtime);
    const ctx = { agent: { id: "agent-1" } };

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m1",
      from: "user",
      payload: { text: "first user" }
    });

    const firstOutcome = await engine.step("agent-1", null);
    assert.strictEqual(firstOutcome.kind, "need_llm");

    engine.onLlmResult("agent-1", {
      turnId: firstOutcome.turnId,
      stepId: firstOutcome.stepId,
      supportsToolCalling: false,
      msg: {
        role: "assistant",
        content: "first assistant",
        reasoning_content: "internal reasoning"
      }
    });

    const sendOutcome = await engine.step("agent-1", null);
    assert.strictEqual(sendOutcome.kind, "send");
    assert.strictEqual(sendOutcome.message.reasoning_content, "internal reasoning");
  });

  it("should NOT inject context status or memory into conv messages", async () => {
    const { runtime } = createRuntimeStub();
    runtime._conversationManager.buildContextStatusPrompt = () => "\n\nCONTEXT_STATUS\n\nMEMORY_CONTEXT";
    runtime._formatMessageForLlm = async (_ctx, message) =>
      message?.payload?.text ?? "";

    const engine = new TurnEngine(runtime);
    const ctx = { agent: { id: "agent-1" } };

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m1",
      from: "user",
      payload: { text: "first user" }
    });

    const outcome = await engine.step("agent-1", null);
    assert.strictEqual(outcome.kind, "need_llm");
    // contextStatus 和 memory 不应出现在 conv 中——它们现在是临时注入的
    assert.strictEqual(outcome.request.messages[1].content, "first user");
  });

  it("should store ephemeral memory context on turn for later injection", async () => {
    const { runtime } = createRuntimeStub();
    runtime._llm.buildEphemeralContexts = async () => "\n\nMEMORY_CONTEXT";
    runtime._formatMessageForLlm = async (_ctx, message) =>
      message?.payload?.text ?? "";

    const engine = new TurnEngine(runtime);
    const ctx = { agent: { id: "agent-1" } };

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m1",
      from: "user",
      payload: { text: "first user" }
    });

    const outcome = await engine.step("agent-1", null);
    assert.strictEqual(outcome.kind, "need_llm");
    // conv 中的消息不应包含 memory
    assert.strictEqual(outcome.request.messages[1].content, "first user");
    // ephemeral memory 应该存储在 turn 上（通过 turnEngine 内部状态验证）
    const turn = engine._byAgentId.get("agent-1")?.activeTurn;
    assert.ok(turn);
    assert.strictEqual(turn.ephemeralMemoryContext, "\n\nMEMORY_CONTEXT");
  });

  it("should call getToolDefinitionsForAgent instead of getToolDefinitions", async () => {
    let getToolDefsCalled = false;
    let getToolDefsForAgentCalled = false;
    let receivedAgentId = null;

    const { runtime } = createRuntimeStub();
    runtime.getToolDefinitions = () => { getToolDefsCalled = true; return []; };
    runtime.getToolDefinitionsForAgent = (agentId) => {
      getToolDefsForAgentCalled = true;
      receivedAgentId = agentId;
      return [{ type: "function", function: { name: "test_tool" } }];
    };

    const engine = new TurnEngine(runtime);
    const ctx = { agentId: "agent-1", agent: { id: "agent-1" } };

    await engine.enqueueMessageTurn("agent-1", ctx, {
      id: "m1",
      from: "user",
      payload: { text: "hello" }
    });

    const outcome = await engine.step("agent-1", null);
    assert.strictEqual(outcome.kind, "need_llm");
    assert.strictEqual(getToolDefsForAgentCalled, true, "应调用 getToolDefinitionsForAgent");
    assert.strictEqual(getToolDefsCalled, false, "不应调用 getToolDefinitions");
    assert.strictEqual(receivedAgentId, "agent-1", "应传入正确的 agentId");
    assert.deepStrictEqual(outcome.request.tools, [{ type: "function", function: { name: "test_tool" } }]);
  });
});
