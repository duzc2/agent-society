import { describe, it } from "node:test";
import assert from "node:assert";
import { ConversationManager } from "../../../../src/platform/services/conversation/conversation_manager.js";

/**
 * 创建用于会话上下文测试的会话管理器。
 * 这里直接注入内存会话，避免依赖文件系统。
 *
 * @returns {ConversationManager}
 */
function createManager() {
  return new ConversationManager({
    conversations: new Map()
  });
}

describe("ConversationManager 上下文窗口约束", () => {
  it("清空对话后应回到空会话，由下一次 ensureConversation 重建 system", async () => {
    const manager = createManager();
    const agentId = "agent-clear";
    // conv 中不含 system 消息，纯对话转录（user/assistant/tool）
    // system prompt 由 runtime 新鲜构建，不持久化在 conv 中
    manager.conversations.set(agentId, [
      { id: "u1", role: "user", content: "hello" }
    ]);

    const clearResult = await manager.clearConversation(agentId);

    assert.deepStrictEqual(clearResult, { ok: true });
    assert.deepStrictEqual(manager.conversations.get(agentId), []);

    // ensureConversation 不再接收 system 参数，conv 仅保存纯对话转录
    const rebuiltConversation = manager.ensureConversation(agentId);
    assert.deepStrictEqual(rebuiltConversation, []);
  });
});
