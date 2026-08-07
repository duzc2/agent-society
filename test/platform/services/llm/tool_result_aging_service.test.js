import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolResultCompressionService } from "../../../../src/platform/services/llm/tool_result_aging_service.js";

describe("ToolResultCompressionService compress", () => {
  it("should return empty array for empty input", () => {
    const service = new ToolResultCompressionService();
    const { messages, stats } = service.compress([]);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(stats.compressedCount, 0);
  });

  it("should return same messages when no tool results", () => {
    const service = new ToolResultCompressionService();
    const msgs = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.deepStrictEqual(messages, msgs);
    assert.strictEqual(stats.compressedCount, 0);
  });

  it("should not truncate tool results under maxChars", () => {
    const service = new ToolResultCompressionService({ maxChars: 100 });
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "short result" }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(messages.length, msgs.length);
    assert.strictEqual(stats.compressedCount, 0);
    assert.strictEqual(messages[2].content, "short result");
  });

  it("should truncate tool results over maxChars", () => {
    const service = new ToolResultCompressionService({ maxChars: 10 });
    const longContent = "a".repeat(50);
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: longContent }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(messages.length, msgs.length);
    assert.strictEqual(stats.compressedCount, 1);
    assert.strictEqual(messages[2].content, "a".repeat(10));
    assert.strictEqual(messages[2].tool_call_id, "c1");
  });

  it("should only truncate tool messages that exceed maxChars", () => {
    const service = new ToolResultCompressionService({ maxChars: 20 });
    const shortResult = "short";
    const longResult = "a".repeat(100);
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: shortResult },
      { role: "user", content: "b" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c2" }] },
      { role: "tool", tool_call_id: "c2", content: longResult },
      { role: "user", content: "c" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c3" }] },
      { role: "tool", tool_call_id: "c3", content: shortResult }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(messages.length, msgs.length);
    assert.strictEqual(stats.compressedCount, 1);
    // Short results unchanged
    assert.strictEqual(messages[2].content, shortResult);
    // Long result truncated (keep 2 chars of content + 18-char marker = 20 total)
    assert.strictEqual(messages[5].content, "a\n\n[已截断之后80字符，内容未显示]");
    // Another short result unchanged
    assert.strictEqual(messages[8].content, shortResult);
  });

  it("should not modify the original array", () => {
    const service = new ToolResultCompressionService({ maxChars: 5 });
    const longContent = "a".repeat(50);
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: longContent }
    ];
    const original = JSON.parse(JSON.stringify(msgs));
    const { messages } = service.compress(msgs);
    assert.deepStrictEqual(msgs, original);
    // Returned result has truncated content
    assert.strictEqual(messages[2].content, "a".repeat(5));
  });

  it("should not affect non-tool messages", () => {
    const service = new ToolResultCompressionService({ maxChars: 5 });
    const longContent = "a".repeat(50);
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: longContent },
      { role: "assistant", content: "final answer" },
      { role: "user", content: longContent }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 1);
    // Non-tool messages unchanged
    assert.strictEqual(messages[0].content, "system prompt");
    assert.strictEqual(messages[1].content, "hello");
    assert.strictEqual(messages[2].content, "ok");
    // Tool message truncated
    assert.strictEqual(messages[3].content, "a".repeat(5));
    // User message with long content — NOT truncated (only tool role)
    assert.strictEqual(messages[5].content, longContent);
  });

  it("should return empty stats for non-array input", () => {
    const service = new ToolResultCompressionService();
    const { messages, stats } = service.compress(null);
    assert.deepStrictEqual(messages, null);
    assert.strictEqual(stats.compressedCount, 0);
  });

  it("should use default maxChars of 8192", () => {
    const service = new ToolResultCompressionService();
    const content = "a".repeat(9000);
    const msgs = [
      { role: "tool", tool_call_id: "c1", content }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 1);
    assert.strictEqual(messages[0].content.length, 8192);
  });

  it("should not truncate when content equals maxChars", () => {
    const service = new ToolResultCompressionService({ maxChars: 100 });
    const content = "a".repeat(100);
    const msgs = [
      { role: "tool", tool_call_id: "c1", content }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 0);
    assert.strictEqual(messages[0].content, content);
  });

  it("should truncate multiple long tool results", () => {
    const service = new ToolResultCompressionService({ maxChars: 10 });
    const longContent = "b".repeat(200);
    const msgs = [
      { role: "tool", tool_call_id: "c1", content: longContent },
      { role: "tool", tool_call_id: "c2", content: longContent },
      { role: "tool", tool_call_id: "c3", content: "short" }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 2);
    assert.strictEqual(messages[0].content.length, 10);
    assert.strictEqual(messages[1].content.length, 10);
    assert.strictEqual(messages[2].content, "short");
  });
});

// ==================== P2: 数组 content 兼容性文档化 ====================
// 当前已知行为：compress 方法检查 typeof msg.content === "string"，
// 因此数组 content（来自 cacheControl 改造）不会被截断。
// 如果将来修复 shallow copy mutation 问题，这些测试会提醒同事
// 同时更新 compress 的 content 类型处理逻辑。

describe("ToolResultCompressionService 数组 content 已知行为", () => {
  it("compress 不应截断数组 content 的工具消息", () => {
    // compress 检查 typeof msg.content === "string"，数组格式不匹配，跳过截断
    const service = new ToolResultCompressionService({ maxChars: 5 });
    const arrayContent = [
      { type: "text", text: "a".repeat(500), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
    ];
    const msgs = [
      { role: "user", content: "action" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c_arr" }] },
      { role: "tool", tool_call_id: "c_arr", content: arrayContent }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 0,
      "数组 content 不应被截断（compress 只截断 string）");
    // 原始数组 content 保持不变
    assert.strictEqual(messages[2].content, arrayContent,
      "数组 content 原样保留");
    assert.strictEqual(messages[2].content[0].text, "a".repeat(500));
  });

  it("compress 应同时正确处理 string 和数组 content", () => {
    // 混合场景：一个 string 工具结果过短不截断，一个数组不截断
    const service = new ToolResultCompressionService({ maxChars: 10 });
    const msgs = [
      { role: "tool", tool_call_id: "c_str", content: "a".repeat(50) },
      { role: "tool", tool_call_id: "c_arr", content: [{ type: "text", text: "b".repeat(100) }] }
    ];
    const { messages, stats } = service.compress(msgs);
    assert.strictEqual(stats.compressedCount, 1,
      "只有 string content 被截断，数组 content 跳过");
    assert.strictEqual(typeof messages[0].content, "string");
    assert.strictEqual(messages[0].content.length, 10,
      "string content 正常截断");
    assert.ok(Array.isArray(messages[1].content),
      "数组 content 保持不变");
    assert.strictEqual(messages[1].content[0].text, "b".repeat(100));
  });
});
