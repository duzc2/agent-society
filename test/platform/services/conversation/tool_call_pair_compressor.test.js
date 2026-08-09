import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolCallPairCompressor } from "../../../../src/platform/services/conversation/tool_call_pair_compressor.js";

/**
 * 构造 N 轮对话消息，每轮含 [user, assistant, tool] 三条。
 * @param {number} roundCount - 轮次数
 * @param {string} toolResultContent - tool 消息的内容
 * @returns {Array} 消息数组
 */
function makeRounds(roundCount, toolResultContent = "some tool output result data") {
  const messages = [];
  for (let i = 1; i <= roundCount; i++) {
    messages.push({ role: "user", content: `Question ${i}` });
    messages.push({
      role: "assistant",
      content: `Answer ${i}`,
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "test_tool", arguments: "{}" } }]
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, name: "test_tool", content: toolResultContent });
  }
  return messages;
}

describe("ToolCallPairCompressor", () => {

  describe("compress() — 空输入", () => {
    it("空消息数组应返回空", () => {
      const compressor = new ToolCallPairCompressor();
      const result = compressor.compress([]);
      assert.deepStrictEqual(result.messages, []);
      assert.strictEqual(result.stats.roundsTotal, 0);
      assert.strictEqual(result.stats.roundsCompressed, 0);
      assert.strictEqual(result.stats.pairsCompressed, 0);
    });
  });

  describe("compress() — 轮次边界", () => {
    it("≤10 轮不应压缩任何消息", () => {
      const compressor = new ToolCallPairCompressor();
      const messages = makeRounds(10);
      const result = compressor.compress(messages, { keepRounds: 10 });

      assert.deepStrictEqual(result.messages, messages);
      assert.strictEqual(result.stats.roundsCompressed, 0);
      assert.strictEqual(result.stats.pairsCompressed, 0);
    });

    it("11 轮时，第 1 轮的 tool 结果应被压缩", () => {
      const compressor = new ToolCallPairCompressor();
      const longContent = "x".repeat(500);
      const messages = makeRounds(11, longContent);
      const result = compressor.compress(messages, { keepRounds: 10 });

      assert.ok(result.stats.pairsCompressed > 0, "应有至少一个 tool 结果被压缩");
      assert.strictEqual(result.messages.length, messages.length, "消息总数不应改变");

      // 被压缩的应是最早的 round
      const firstToolMsg = result.messages.find(m => m.role === "tool");
      assert.ok(firstToolMsg.content.length < longContent.length, "tool 内容应被截断");
    });
  });

  describe("compress() — 纯文本无工具调用", () => {
    it("纯文本对话不应触发压缩", () => {
      const compressor = new ToolCallPairCompressor();
      const messages = [];
      for (let i = 1; i <= 15; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({ role: "assistant", content: `Answer ${i}` });
      }

      const result = compressor.compress(messages, { keepRounds: 10 });

      assert.strictEqual(result.stats.pairsCompressed, 0);
      assert.deepStrictEqual(result.messages, messages);
    });
  });

  describe("compress() — 单轮多个工具调用", () => {
    it("单轮内多个 tool 结果各自独立压缩", () => {
      const compressor = new ToolCallPairCompressor();
      const longContent = "y".repeat(500);
      const messages = [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: "calling tools",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "tool_a", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "tool_b", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "call_a", name: "tool_a", content: longContent },
        { role: "tool", tool_call_id: "call_b", name: "tool_b", content: longContent },
      ];
      // 加满到 11 轮
      const extraRounds = makeRounds(10);
      const allMessages = [...messages, ...extraRounds];

      const result = compressor.compress(allMessages, { keepRounds: 10 });

      assert.strictEqual(result.stats.pairsCompressed, 2, "两个 tool 结果都应被压缩");
    });
  });

  describe("compress() — JSON error 对象摘要", () => {
    it("JSON 错误对象应包含 error 信息在摘要中", () => {
      const compressor = new ToolCallPairCompressor();
      const errorContent = JSON.stringify({ error: "file not found", status: 404 });
      const messages = [
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "call_err", type: "function", function: { name: "read", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_err", name: "read", content: errorContent },
      ];
      // 确保 >10 轮
      const extraRounds = makeRounds(10);
      const allMessages = [...messages, ...extraRounds];

      const result = compressor.compress(allMessages, { keepRounds: 10, maxToolResultChars: 10 });

      const compressedToolMsg = result.messages.find(
        m => m.role === "tool" && m.tool_call_id === "call_err"
      );
      assert.ok(compressedToolMsg, "应存在被压缩的 tool 消息");
      assert.ok(compressedToolMsg.content.includes("错误: file not found"),
        "摘要应包含 error 信息");
    });
  });

  describe("compress() — 首条非 user", () => {
    it("首条消息非 user 时，round 应从 index 0 正确识别", () => {
      const compressor = new ToolCallPairCompressor();
      const longContent = "z".repeat(500);
      // 以 tool 消息开头（模拟截断/恢复场景）
      const messages = [
        { role: "tool", tool_call_id: "orphaned", name: "orphan", content: "residual" },
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "A1",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_1", name: "t", content: longContent },
      ];
      const extraRounds = makeRounds(10);
      const allMessages = [...messages, ...extraRounds];

      const result = compressor.compress(allMessages, { keepRounds: 10 });

      // 不应崩溃，应正常返回
      assert.ok(Array.isArray(result.messages));
      assert.strictEqual(result.messages.length, allMessages.length);
    });
  });

  describe("compress() — 压缩后通过 _validateMessageArray", () => {
    /**
     * _validateMessageArray 的等价验证逻辑：
     * 1. 非空
     * 2. 存在 user 消息
     * 3. 所有 tool 的 tool_call_id 都存在对应的 assistant.tool_calls entry
     */
    function validateMessages(messages) {
      if (!Array.isArray(messages) || messages.length === 0) return false;
      if (!messages.some(m => m?.role === "user")) return false;
      const validIds = new Set();
      for (const m of messages) {
        if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc.id) validIds.add(tc.id);
          }
        }
      }
      for (const m of messages) {
        if (m?.role === "tool" && m.tool_call_id && !validIds.has(m.tool_call_id)) return false;
      }
      return true;
    }

    it("压缩后的消息应通过完整验证", () => {
      const compressor = new ToolCallPairCompressor();
      const longContent = "x".repeat(500);
      const messages = makeRounds(15, longContent);
      const result = compressor.compress(messages, { keepRounds: 10 });

      assert.ok(validateMessages(result.messages), "压缩后应满足消息数组验证要求");
    });
  });

  describe("_identifyRounds()", () => {
    it("以 user 为边界正确分组", () => {
      const compressor = new ToolCallPairCompressor();
      const messages = [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
        { role: "assistant", content: "A2" },
        { role: "user", content: "Q3" },
      ];

      const rounds = compressor._identifyRounds(messages);

      assert.strictEqual(rounds.length, 3);
      assert.strictEqual(rounds[0].messages[0].content, "Q1");
      assert.strictEqual(rounds[1].messages[0].content, "Q2");
      assert.strictEqual(rounds[2].messages[0].content, "Q3");
    });

    it("空数组返回空 rounds", () => {
      const compressor = new ToolCallPairCompressor();
      assert.deepStrictEqual(compressor._identifyRounds([]), []);
    });
  });

  describe("_summarizeToolResult()", () => {
    it("短内容不截断", () => {
      const compressor = new ToolCallPairCompressor();
      const short = "hello";
      assert.strictEqual(compressor._summarizeToolResult(short, "test", 200), short);
    });

    it("长内容截断并保留前缀", () => {
      const compressor = new ToolCallPairCompressor();
      const long = "a".repeat(500);
      const result = compressor._summarizeToolResult(long, "myTool", 200);
      assert.ok(result.length < 500, "应被截断");
      assert.ok(result.includes("[工具结果: myTool"), "应包含工具名");
      assert.ok(result.includes("a".repeat(200)), "应保留内容前缀");
    });

    it("无 toolName 时降级显示", () => {
      const compressor = new ToolCallPairCompressor();
      const result = compressor._summarizeToolResult("x".repeat(300), undefined, 200);
      assert.ok(result.includes("[工具结果"));
    });
  });
});
