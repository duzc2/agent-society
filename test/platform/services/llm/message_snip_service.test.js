import { describe, it } from "node:test";
import assert from "node:assert";
import { MessageSnipService } from "../../../../src/platform/services/llm/message_snip_service.js";

describe("MessageSnipService filter", () => {
  it("should return empty array for empty input", () => {
    const service = new MessageSnipService();
    const { messages, stats } = service.filter([]);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(stats.emptyToolResults, 0);
    assert.strictEqual(stats.rejectedOps, 0);
    assert.strictEqual(stats.orphansRemoved, 0);
  });

  it("should return same messages for clean input", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.deepStrictEqual(messages, msgs);
    assert.strictEqual(stats.emptyToolResults, 0);
    assert.strictEqual(stats.rejectedOps, 0);
    assert.strictEqual(stats.orphansRemoved, 0);
  });

  it("should filter empty string tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "read file" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", function: { name: "read_file" } }] },
      { role: "tool", tool_call_id: "call_1", content: "" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.emptyToolResults, 1);
  });

  it("should filter null tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "read file" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: null }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.emptyToolResults, 1);
  });

  it("should filter empty JSON tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "search" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "{}" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.emptyToolResults, 1);
  });

  it("should keep non-empty tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "read file" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: '{"result": "file content here"}' }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(stats.emptyToolResults, 0);
  });

  it("should filter short rejection assistant messages", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "delete all files" },
      { role: "assistant", content: "拒绝" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(stats.rejectedOps, 1);
  });

  it("should filter short '无法' rejection assistant messages", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "无法执行" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(stats.rejectedOps, 1);
  });

  it("should keep longer assistant messages even if they start with refusal", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "delete files" },
      { role: "assistant", content: "拒绝删除这些文件，因为它们包含重要的项目配置文件，删除后将无法恢复原始状态，请先备份重要数据" }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.rejectedOps, 0);
  });

  it("should filter rejected tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "delete" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: '{"rejected":true}' }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.rejectedOps, 1);
  });

  it("should filter denied tool results", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "action" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: '{"denied":true}' }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(stats.rejectedOps, 1);
  });

  it("should filter orphan tool messages (no matching assistant tool_call)", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "tool", tool_call_id: "orphan_1", content: '{"result": "data"}' }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(stats.orphansRemoved, 1);
  });

  it("should keep tool messages that match assistant tool_calls", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "read" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: '{"result": "file content"}' }
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(stats.orphansRemoved, 0);
  });

  it("should count multiple stats correctly", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "do stuff" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "" },            // empty
      { role: "assistant", content: "拒绝" },                            // rejected
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_2" }] },
      { role: "tool", tool_call_id: "call_2", content: '{"rejected":true}' } // rejected
    ];
    const { messages, stats } = service.filter(msgs);
    assert.strictEqual(messages.length, 3); // user + assistant(call_2) + nothing
    assert.strictEqual(stats.emptyToolResults, 1);
    assert.strictEqual(stats.rejectedOps, 2);
    assert.strictEqual(stats.orphansRemoved, 0);
  });

  it("should not modify the original array", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "test" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "" }
    ];
    const original = [...msgs];
    service.filter(msgs);
    assert.deepStrictEqual(msgs, original);
  });

  it("should return empty stats for non-array input", () => {
    const service = new MessageSnipService();
    const { messages, stats } = service.filter(null);
    assert.deepStrictEqual(messages, null);
    assert.strictEqual(stats.emptyToolResults, 0);
    assert.strictEqual(stats.rejectedOps, 0);
    assert.strictEqual(stats.orphansRemoved, 0);
  });
});

// ==================== P2: 数组 content 兼容性文档化 ====================
// 当前已知行为：_isEmptyToolResult 只检查 string content。
// 当 _applyCacheControlToLastContentBlock 将 content 转为数组后，
// 数组 content 永远不会被标记为"空结果"，因此数组格式的工具消息不会被 snip 过滤掉。
// 这些测试文档化当前行为，不是 bug fix。如果将来修复 shallow copy mutation 问题，
// 这些测试会提醒同事更新 snip/compress 的 content 类型处理逻辑。

describe("MessageSnipService 数组 content 已知行为", () => {
  it("_isEmptyToolResult 对数组 content 返回 false（数组永不视为空）", () => {
    const service = new MessageSnipService();
    // 模拟 cacheControl 改造后的 content 数组——空数组和只有空文本块的数组
    assert.strictEqual(service._isEmptyToolResult([]), false,
      "空数组不被视为空结果（_isEmptyToolResult 只处理 string）");
    assert.strictEqual(service._isEmptyToolResult([{ type: "text", text: "" }]), false,
      "内容块数组不被视为空结果");
    assert.strictEqual(service._isEmptyToolResult([{ type: "text", text: "data" }]), false,
      "非空内容块数组也不被视为空结果");
  });

  it("filter 不应过滤 content 为数组格式的工具消息", () => {
    const service = new MessageSnipService();
    const msgs = [
      { role: "user", content: "action" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_arr", function: { name: "do_thing" } }] },
      {
        role: "tool",
        tool_call_id: "call_arr",
        content: [{ type: "text", text: "result", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
      }
    ];
    const { messages, stats } = service.filter(msgs);
    // 数组 content 的工具消息不应被过滤（即使内容可能视为"空"）
    assert.strictEqual(messages.length, 3,
      "数组 content 的工具消息应保留（当前行为：_isEmptyToolResult 不识别数组）");
    assert.strictEqual(stats.emptyToolResults, 0);
    assert.strictEqual(stats.rejectedOps, 0);
    assert.strictEqual(stats.orphansRemoved, 0);
  });
});
