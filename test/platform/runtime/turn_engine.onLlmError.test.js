import { describe, it } from "node:test";
import assert from "node:assert";
import { TurnEngine } from "../../../src/platform/runtime/turn_engine.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

/**
 * 构造一个带 _emitError 捕获的 TurnEngine 运行时桩。
 * @returns {{runtime: any, emittedEvents: any[]}}
 */
function createRuntimeStub() {
  const conversations = new Map();
  const emittedEvents = [];
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
    log: makeTestLogger("TurnEngine"),
    _emitError(event) {
      emittedEvents.push(event);
    }
  };
  return { runtime, emittedEvents };
}

/**
 * 为指定智能体创建一个已处于 need_llm 阶段的回合。
 * @param {TurnEngine} engine
 * @param {string} agentId
 * @returns {Promise<{turnId:string, stepId:number}>}
 */
async function enqueueAndStepToNeedLlm(engine, agentId) {
  const ctx = { agent: { id: agentId } };
  await engine.enqueueMessageTurn(agentId, ctx, {
    id: "m1",
    from: "user",
    payload: { text: "hello" }
  });
  const outcome = await engine.step(agentId, null);
  assert.strictEqual(outcome.kind, "need_llm");
  return outcome;
}

describe("TurnEngine.onLlmError", () => {
  it("应将供应商响应体原因覆盖到事件 message 与 details.message", async () => {
    const { runtime, emittedEvents } = createRuntimeStub();
    const engine = new TurnEngine(runtime);
    const outcome = await enqueueAndStepToNeedLlm(engine, "agent-1");

    const err = new Error("HTTP 400 Bad Request");
    err.name = "APICallError";
    err.statusCode = 400;
    err.responseBody = JSON.stringify({
      error: {
        message: "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed dee.",
        type: "invalid_request_error",
        code: "invalid_request_error"
      }
    });

    engine.onLlmError("agent-1", {
      turnId: outcome.turnId,
      stepId: outcome.stepId,
      error: err
    });

    const expectedReason =
      "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed dee.";
    assert.strictEqual(emittedEvents.length, 1);
    assert.strictEqual(emittedEvents[0].agentId, "agent-1");
    assert.strictEqual(emittedEvents[0].errorType, "llm_error");
    assert.strictEqual(emittedEvents[0].message, expectedReason);
    // 前端 displayReason 会优先从 details.message 提取，因此 details 也必须携带原因
    assert.strictEqual(emittedEvents[0].details.message, expectedReason);
    assert.strictEqual(emittedEvents[0].details.statusCode, 400);
  });

  it("无供应商响应体时应保留原始错误消息", async () => {
    const { runtime, emittedEvents } = createRuntimeStub();
    const engine = new TurnEngine(runtime);
    const outcome = await enqueueAndStepToNeedLlm(engine, "agent-1");

    const err = new Error("HTTP 400 Bad Request");
    engine.onLlmError("agent-1", {
      turnId: outcome.turnId,
      stepId: outcome.stepId,
      error: err
    });

    assert.strictEqual(emittedEvents.length, 1);
    assert.strictEqual(emittedEvents[0].message, "HTTP 400 Bad Request");
    assert.strictEqual(emittedEvents[0].details.message, "HTTP 400 Bad Request");
  });

  it("回合结束后应清理 activeTurn", async () => {
    const { runtime, emittedEvents } = createRuntimeStub();
    const engine = new TurnEngine(runtime);
    const outcome = await enqueueAndStepToNeedLlm(engine, "agent-1");

    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify({ error: { message: "provider reason" } });

    engine.onLlmError("agent-1", {
      turnId: outcome.turnId,
      stepId: outcome.stepId,
      error: err
    });

    assert.strictEqual(engine._byAgentId.get("agent-1").activeTurn, null);
  });
});
