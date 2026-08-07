import { describe, it } from "node:test";
import assert from "node:assert";
import { ConversationManager } from "../../src/platform/services/conversation/conversation_manager.js";
import { Runtime } from "../../src/platform/core/runtime.js";
import { makeTestLogger } from "../helpers/test_logger.js";

describe("ConversationManager - 重新生成最后一条回复", () => {
  /**
   * 创建用于测试的会话管理器。
   * 这里直接注入内存会话，避免引入文件系统依赖。
   * @returns {ConversationManager}
   */
  function createManager() {
    return new ConversationManager({
      conversations: new Map()
    });
  }

  it("应找到最后一条 assistant 消息", () => {
    const manager = createManager();
    manager.conversations.set("agent-1", [
      { role: "system", content: "sys" },
      { role: "user", content: "u1", id: "u1" },
      { role: "assistant", content: "a1", id: "a1" },
      { role: "user", content: "u2", id: "u2" },
      { role: "assistant", content: "a2", id: "a2" }
    ]);

    const result = manager.getLastAssistantMessage("agent-1");

    assert.ok(result);
    assert.strictEqual(result?.index, 4);
    assert.strictEqual(result?.message?.id, "a2");
  });

  it("应只允许截断最后一条 assistant 消息", async () => {
    const manager = createManager();
    manager.conversations.set("agent-1", [
      { role: "system", content: "sys" },
      { role: "user", content: "u1", id: "u1" },
      { role: "assistant", content: "a1", id: "a1" },
      { role: "user", content: "u2", id: "u2" },
      { role: "assistant", content: "a2", id: "a2" }
    ]);

    const invalidResult = await manager.truncateLastAssistantMessage("agent-1", "a1");
    assert.strictEqual(invalidResult.ok, false);
    assert.strictEqual(invalidResult.error, "message_not_last_assistant");

    const validResult = await manager.truncateLastAssistantMessage("agent-1", "a2");
    assert.strictEqual(validResult.ok, true);
    assert.deepStrictEqual(validResult.removedMessageIds, ["a2"]);
    assert.deepStrictEqual(manager.conversations.get("agent-1")?.map((message) => message.id ?? message.role), [
      "system",
      "u1",
      "a1",
      "u2"
    ]);
  });

  it("应支持回滚被截断的消息", async () => {
    const manager = createManager();
    manager.conversations.set("agent-1", [
      { role: "system", content: "sys" },
      { role: "user", content: "u1", id: "u1" },
      { role: "assistant", content: "a1", id: "a1" }
    ]);

    const truncateResult = await manager.truncateLastAssistantMessage("agent-1", "a1");
    assert.strictEqual(truncateResult.ok, true);

    const restoreResult = await manager.restoreTruncatedMessages(
      "agent-1",
      truncateResult.truncatedFromIndex,
      truncateResult.removedMessages
    );

    assert.strictEqual(restoreResult.ok, true);
    assert.deepStrictEqual(manager.conversations.get("agent-1")?.map((message) => message.id ?? message.role), [
      "system",
      "u1",
      "a1"
    ]);
  });
});

describe("Runtime.regenerateLastAssistantReply", () => {
  it("应复用调度器重新发起最后一条回复", async () => {
    let capturedAgentId = null;
    let capturedMessageId = null;
    let capturedOptions = null;

    const fakeRuntime = {
      _agents: new Map([["agent-1", { id: "agent-1" }]]),
      _replyManager: {
        async regenerateLastAssistantReply(agentId, messageId, options) {
          capturedAgentId = agentId;
          capturedMessageId = messageId;
          capturedOptions = options;
          return {
            ok: true,
            turnId: "turn-1",
            removedMessageIds: ["msg-1"]
          };
        }
      },
      log: makeTestLogger("RegenerateReply")
    };

    const result = await Runtime.prototype.regenerateLastAssistantReply.call(
      fakeRuntime,
      "agent-1",
      "msg-1",
      {
        responseTarget: "user",
        taskId: "task-1"
      }
    );

    assert.deepStrictEqual(result, {
      ok: true,
      turnId: "turn-1",
      removedMessageIds: ["msg-1"]
    });
    assert.strictEqual(capturedAgentId, "agent-1");
    assert.strictEqual(capturedMessageId, "msg-1");
    assert.deepStrictEqual(capturedOptions, {
      responseTarget: "user",
      taskId: "task-1"
    });
  });

  it("当智能体非 idle 时应拒绝重新生成", async () => {
    const fakeRuntime = {
      _agents: new Map([["agent-1", { id: "agent-1" }]]),
      _replyManager: {
        async regenerateLastAssistantReply() {
          return {
            ok: false,
            error: "agent_not_idle",
            status: "processing"
          };
        }
      }
    };

    const result = await Runtime.prototype.regenerateLastAssistantReply.call(
      fakeRuntime,
      "agent-1",
      "msg-1"
    );

    assert.deepStrictEqual(result, {
      ok: false,
      error: "agent_not_idle",
      status: "processing"
    });
  });
});
