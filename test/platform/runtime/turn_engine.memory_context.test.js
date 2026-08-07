import { describe, it } from "node:test";
import assert from "node:assert";
import { TurnEngine } from "../../../src/platform/runtime/turn_engine.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

/**
 * 创建供 TurnEngine 记忆/知识上下文测试使用的最小 runtime stub。
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

/**
 * 推进 TurnEngine 直到产生 send 结果。
 * 模拟一个简单的对话：enqueue → step(need_llm) → onLlmResult → step(send)
 */
async function runToSend(engine, agentId, llmContent = "回复", reasoning = null) {
  const ctx = { agent: { id: agentId } };

  await engine.enqueueMessageTurn(agentId, ctx, {
    id: "m1",
    from: "user",
    payload: { text: "用户消息" }
  });

  const firstOutcome = await engine.step(agentId, null);
  if (firstOutcome.kind !== "need_llm") {
    return firstOutcome;
  }

  const llmResult = {
    turnId: firstOutcome.turnId,
    stepId: firstOutcome.stepId,
    supportsToolCalling: false,
    msg: {
      role: "assistant",
      content: llmContent
    }
  };
  if (reasoning) llmResult.msg.reasoning_content = reasoning;

  engine.onLlmResult(agentId, llmResult);

  return engine.step(agentId, null);
}

describe("TurnEngine 记忆/知识上下文传递", () => {

  it("send 消息应携带 ephemeralMemoryContext（AgentMemory 召回结果）", async () => {
    const { runtime } = createRuntimeStub();
    runtime._llm.buildEphemeralContexts = async () => "\n\n【相关记忆】\n1. 用户偏好深色主题。";

    const engine = new TurnEngine(runtime);

    // 覆盖知识树检索，使其不影响记忆上下文测试
    engine._retrieveKnowledgeContext = async () => null;

    const outcome = await runToSend(engine, "agent-1");
    assert.strictEqual(outcome.kind, "send");
    assert.strictEqual(
      outcome.message.memoryContext,
      "\n\n【相关记忆】\n1. 用户偏好深色主题。"
    );
  });

  it("send 消息应携带 knowledgeContext（KnowledgeTree 检索结果）", async () => {
    const { runtime } = createRuntimeStub();
    const engine = new TurnEngine(runtime);

    // 记忆上下文返回 null，凸显知识树
    runtime._llm.buildEphemeralContexts = async () => null;
    engine._retrieveKnowledgeContext = async () => "\n\n【知识树上下文】\nRESTful API 接口约定。";

    const outcome = await runToSend(engine, "agent-2");
    assert.strictEqual(outcome.kind, "send");
    assert.strictEqual(
      outcome.message.knowledgeContext,
      "\n\n【知识树上下文】\nRESTful API 接口约定。"
    );
  });

  it("send 消息应同时携带两个上下文（两者都存在时）", async () => {
    const { runtime } = createRuntimeStub();
    runtime._llm.buildEphemeralContexts = async () => "记忆1; 记忆2";
    const engine = new TurnEngine(runtime);
    engine._retrieveKnowledgeContext = async () => "知识1; 知识2";

    const outcome = await runToSend(engine, "agent-3");
    assert.strictEqual(outcome.kind, "send");
    assert.strictEqual(outcome.message.memoryContext, "记忆1; 记忆2");
    assert.strictEqual(outcome.message.knowledgeContext, "知识1; 知识2");
  });

  it("两者都为 null 时，send 消息中 memoryContext 和 knowledgeContext 应为 null", async () => {
    const { runtime } = createRuntimeStub();
    runtime._llm.buildEphemeralContexts = async () => null;
    const engine = new TurnEngine(runtime);
    engine._retrieveKnowledgeContext = async () => null;

    const outcome = await runToSend(engine, "agent-4");
    assert.strictEqual(outcome.kind, "send");
    assert.strictEqual(outcome.message.memoryContext, null);
    assert.strictEqual(outcome.message.knowledgeContext, null);
  });

  it("reasoning_content 不应受记忆/知识上下文影响", async () => {
    const { runtime } = createRuntimeStub();
    runtime._llm.buildEphemeralContexts = async () => "记忆上下文";
    const engine = new TurnEngine(runtime);
    engine._retrieveKnowledgeContext = async () => "知识树上下文";

    const outcome = await runToSend(engine, "agent-5", "你好", "模型内部推理");
    assert.strictEqual(outcome.kind, "send");
    assert.strictEqual(outcome.message.reasoning_content, "模型内部推理");
    // 三者应共存
    assert.strictEqual(outcome.message.memoryContext, "记忆上下文");
    assert.strictEqual(outcome.message.knowledgeContext, "知识树上下文");
  });
});
