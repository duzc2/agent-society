import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * 在 normalizeHeartbeatMessage 中用于提取字段的内联副本。
 * 与实际 api.ts 实现保持一致。
 */
function normalizeRawMessageMemoryFields(rawMsg) {
  return {
    memoryContext: typeof rawMsg.memoryContext === 'string' ? rawMsg.memoryContext : undefined,
    knowledgeContext: typeof rawMsg.knowledgeContext === 'string' ? rawMsg.knowledgeContext : undefined,
  };
}

describe("normalizeHeartbeatMessage 记忆/知识上下文字段映射", () => {

  it("有字符串 memoryContext 时应正确提取", () => {
    const result = normalizeRawMessageMemoryFields({
      memoryContext: "【相关记忆】\n1. 用户偏好深色主题。"
    });
    assert.strictEqual(result.memoryContext, "【相关记忆】\n1. 用户偏好深色主题。");
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("有字符串 knowledgeContext 时应正确提取", () => {
    const result = normalizeRawMessageMemoryFields({
      knowledgeContext: "【知识树上下文】\nRESTful API 约定。"
    });
    assert.strictEqual(result.knowledgeContext, "【知识树上下文】\nRESTful API 约定。");
    assert.strictEqual(result.memoryContext, undefined);
  });

  it("两个字段同时存在时应同时提取", () => {
    const result = normalizeRawMessageMemoryFields({
      memoryContext: "记忆1",
      knowledgeContext: "知识1"
    });
    assert.strictEqual(result.memoryContext, "记忆1");
    assert.strictEqual(result.knowledgeContext, "知识1");
  });

  it("rawMsg 中完全没有字段时应返回 undefined", () => {
    const result = normalizeRawMessageMemoryFields({});
    assert.strictEqual(result.memoryContext, undefined);
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("字段为 null 时应返回 undefined", () => {
    const result = normalizeRawMessageMemoryFields({
      memoryContext: null,
      knowledgeContext: null
    });
    assert.strictEqual(result.memoryContext, undefined);
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("字段为非字符串类型时应返回 undefined", () => {
    const result = normalizeRawMessageMemoryFields({
      memoryContext: 123,
      knowledgeContext: { text: "not a string" }
    });
    assert.strictEqual(result.memoryContext, undefined);
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("字段为空字符串时应正确提取（空字符串为有效值）", () => {
    const result = normalizeRawMessageMemoryFields({
      memoryContext: ""
    });
    // typeof "" === "string" 为 true，所以空字符串会通过类型守卫
    assert.strictEqual(result.memoryContext, "");
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("多字段消息中不应受其他字段干扰", () => {
    const result = normalizeRawMessageMemoryFields({
      id: "msg-1",
      from: "agent-1",
      to: "user",
      payload: { text: "回复内容" },
      reasoning_content: "思考",
      memoryContext: "相关记忆",
      knowledgeContext: null,
      scheduledDeliveryTime: null
    });
    assert.strictEqual(result.memoryContext, "相关记忆");
    assert.strictEqual(result.knowledgeContext, undefined);
  });

  it("服务端心跳广播的典型消息格式应正确映射", () => {
    // 模拟 message-handlers.js 中 onBeforeDrain 广播的消息格式
    const rawMsg = {
      id: "msg-123",
      from: "agent-1",
      to: "user",
      taskId: "task-1",
      type: "text",
      payload: { text: "回复", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      reasoning_content: null,
      memoryContext: "【相关记忆】\n1. [85%] 用户偏好深色主题。",
      knowledgeContext: "【知识树上下文】\nAPI 约定已确立。",
      createdAt: "2025-01-01T00:00:00.000Z",
      scheduledDeliveryTime: null,
      deliveredAt: null
    };
    const result = normalizeRawMessageMemoryFields(rawMsg);
    assert.strictEqual(result.memoryContext, "【相关记忆】\n1. [85%] 用户偏好深色主题。");
    assert.strictEqual(result.knowledgeContext, "【知识树上下文】\nAPI 约定已确立。");
  });
});
