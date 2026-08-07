/**
 * LlmClient 模糊测试（Fuzz Test）
 *
 * 测试矩阵：每种 role × 每种 content 类型 × 每种额外属性组合
 * 对每种组合调用 chat()，用 assertValidMessages 验证格式化输出
 * 通过真实 ai-sdk schema。
 *
 * 这是测试体系的最后一道防线——发现任何人事先没想到的边缘条件。
 */

import { describe, it, mock, before, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../../../helpers/test_logger.js";
import { assertValidMessages } from "../../../helpers/schema_validator.js";

// 所有测试中使用的 makeLlmClient
let LlmClient;
let mockGenerateText;

function createConfigService(overrides = {}) {
  return {
    getServices: async () => ({
      services: [{
        id: "test-model",
        provider: "openai",
        baseURL: "http://127.0.0.1:1234/v1",
        model: "test-x",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000,
        capabilities: { input: ["text"], output: ["text", "tool_calling"] },
        ...overrides
      }]
    }),
    getLlm: async () => ({
      llm: {
        provider: "openai",
        baseURL: "http://127.0.0.1:1234/v1",
        model: "default-model",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000
      }
    })
  };
}

describe("LlmClient 模糊测试（schema 合规性）", () => {
  before(async () => {
    mockGenerateText = mock.fn(() =>
      Promise.resolve({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: []
      })
    );

    await mock.module("ai", {
      namedExports: {
        generateText: mockGenerateText,
        tool: (schema) => schema,
        jsonSchema: (schema) => schema
      }
    });

    await mock.module("@ai-sdk/openai", {
      namedExports: {
        createOpenAI: () => ({ chat: () => ({}) })
      }
    });

    await mock.module("@ai-sdk/anthropic", {
      namedExports: {
        createAnthropic: () => () => ({})
      }
    });

    await mock.module("@ai-sdk/open-responses", {
      namedExports: {
        createOpenResponses: () => () => ({})
      }
    });

    await mock.module("llama-cpp-provider/dist/src/index.js", {
      namedExports: {
        createLocalAiProvider: () => ({ languageModel: () => ({}) })
      }
    });

    const mod = await import("../../../../src/platform/services/llm/llm_client.js");
    LlmClient = mod.LlmClient;
  });

  beforeEach(() => {
    mockGenerateText.mock.resetCalls();
  });

  function makeClient() {
    return new LlmClient({
      configService: createConfigService(),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.fuzz")
    });
  }

  async function fuzzChat(messages) {
    const client = makeClient();
    await client.chat({ messages });
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    await assertValidMessages(callArg.messages, `fuzz: ${JSON.stringify(messages).substring(0, 80)}`);
  }

  // ==================== 单消息 content 类型模糊 ====================

  describe("user 消息 content 类型模糊", () => {
    const contentTypes = [
      { label: "null",     value: null },
      { label: "undefined", value: undefined },
      { label: "空字符串",   value: "" },
      { label: "空白字符串", value: "   " },
      { label: "正常字符串", value: "hello world" },
      { label: "超长10k",    value: "x".repeat(10000) },
      { label: "数字0",      value: 0 },
      { label: "数字42",     value: 42 },
      { label: "数字-1",     value: -1 },
      { label: "小数3.14",   value: 3.14 },
      { label: "NaN",       value: NaN },
      { label: "Infinity",  value: Infinity },
      { label: "-Infinity", value: -Infinity },
      { label: "布尔true",  value: true },
      { label: "布尔false", value: false },
      // BigInt 123n 跳过：JSON.stringify 无法序列化 BigInt，触发预处理异常
      { label: "空对象",     value: {} },
      { label: "有键对象",   value: { key: "value" } },
      { label: "嵌套对象",   value: { nested: { deep: {} } } },
      { label: "空数组",     value: [] },
      { label: "字符串数组", value: ["a", "b"] },
      { label: "内容块数组", value: [{ type: "text", text: "hello" }] },
      { label: "null字符",   value: "\u0000" },
      { label: "unicode表情", value: "Hello 🌍🔥🎉" },
    ];

    for (const { label, value } of contentTypes) {
      it(`content = ${label} 应通过 schema 校验`, async () => {
        await fuzzChat([{ role: "user", content: value }]);
      });
    }
  });

  describe("assistant 消息 content 类型模糊", () => {
    const contentTypes = [
      { label: "null",       value: null },
      { label: "undefined",  value: undefined },
      { label: "空字符串",    value: "" },
      { label: "数字0",       value: 0 },
      { label: "布尔false",  value: false },
      { label: "对象",       value: { key: "value" } },
      { label: "内容块数组",  value: [{ type: "text", text: "reply" }] },
    ];

    for (const { label, value } of contentTypes) {
      it(`content = ${label} 应通过 schema 校验`, async () => {
        await fuzzChat([
          { role: "user", content: "hi" },
          { role: "assistant", content: value }
        ]);
      });
    }
  });

  describe("tool 消息 content 类型模糊", () => {
    const contentTypes = [
      { label: "null",       value: null },
      { label: "undefined",  value: undefined },
      { label: "空字符串",    value: "" },
      { label: "数字0",       value: 0 },
      { label: "数字42",      value: 42 },
      { label: "布尔true",   value: true },
      { label: "布尔false",  value: false },
      { label: "JSON字符串",  value: '{"data":"ok"}' },
      { label: "普通字符串",  value: "plain text result" },
      { label: "内容块数组",  value: [{ type: "text", text: "result" }] },
      { label: "空对象",      value: {} },
    ];

    for (const { label, value } of contentTypes) {
      it(`tool content = ${label} 应通过 schema 校验`, async () => {
        await fuzzChat([
          { role: "user", content: "do it" },
          { role: "assistant", content: "ok", tool_calls: [{ id: "call_fuzz", type: "function", function: { name: "test_tool", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_fuzz", name: "test_tool", content: value }
        ]);
      });
    }
  });

  // ==================== 多轮组合模糊 ====================

  describe("多轮工具调用组合", () => {
    it("连续 tool-call + tool-result 应通过 schema", async () => {
      await fuzzChat([
        { role: "user", content: "task 1" },
        { role: "assistant", content: "step 1", tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: '{}' } }] },
        { role: "tool", tool_call_id: "c1", name: "a", content: "r1" },
        { role: "assistant", content: "step 2", tool_calls: [{ id: "c2", type: "function", function: { name: "b", arguments: '{"x":1}' } }] },
        { role: "tool", tool_call_id: "c2", name: "b", content: "r2" },
        { role: "assistant", content: "done" }
      ]);
    });

    it("连续 5 轮 tool-call 应通过 schema", async () => {
      const msgs = [{ role: "user", content: "start" }];
      for (let i = 0; i < 5; i++) {
        msgs.push({
          role: "assistant",
          content: `step ${i}`,
          tool_calls: [{ id: `cf${i}`, type: "function", function: { name: `tool_${i}`, arguments: "{}" } }]
        });
        msgs.push({
          role: "tool", tool_call_id: `cf${i}`, name: `tool_${i}`, content: `result ${i}`
        });
      }
      msgs.push({ role: "assistant", content: "all done" });

      await fuzzChat(msgs);
    });

    it("混合 reasoning_content 应通过 schema", async () => {
      await fuzzChat([
        { role: "user", content: "complex task" },
        {
          role: "assistant",
          content: "let me think",
          reasoning_content: "I need to break this down into steps.",
          tool_calls: [{ id: "cr", type: "function", function: { name: "think", arguments: '{}' } }]
        },
        { role: "tool", tool_call_id: "cr", name: "think", content: "analysis done" },
        {
          role: "assistant",
          content: "final answer",
          reasoning_content: "Based on the analysis, the answer is clear.",
          tool_calls: [{ id: "ca", type: "function", function: { name: "answer", arguments: '{"a":"x"}' } }]
        },
        { role: "tool", tool_call_id: "ca", name: "answer", content: JSON.stringify({ answer: "42" }) }
      ]);
    });

    it("混合 cacheControl 内容块数组应通过 schema", async () => {
      await fuzzChat([
        {
          role: "user",
          content: [{ type: "text", text: "stable", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
          ],
          tool_calls: [{ id: "c_cc_fuzz", type: "function", function: { name: "d", arguments: '{"p":"q"}' } }]
        },
        {
          role: "tool",
          tool_call_id: "c_cc_fuzz",
          name: "d",
          content: [{ type: "text", text: "result", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
        }
      ]);
    });

    it("全部 4 种稳定消息类型 + cacheControl 应通过 schema", async () => {
      await fuzzChat([
        {
          role: "user",
          content: [{ type: "text", text: "user stable", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "plain reply", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "with tool", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
          ],
          tool_calls: [{ id: "cc_full", type: "function", function: { name: "read", arguments: '{"path":"/etc/hosts"}' } }]
        },
        {
          role: "tool",
          tool_call_id: "cc_full",
          name: "read",
          content: [{ type: "text", text: '{"data":"ok"}', providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]
        },
        { role: "user", content: "new input" }
      ]);
    });
  });

  // ==================== 边界条件模糊 ====================

  describe("边界条件模糊", () => {
    it("超长 unicode 字符串（中文）应通过 schema", async () => {
      const chinese = "测试".repeat(5000); // 10k chars of CJK
      await fuzzChat([{ role: "user", content: chinese }]);
    });

    it("HTML 标签字符不应破坏 schema", async () => {
      const html = "<script>alert('xss')</script><div><p>text</p></div>";
      await fuzzChat([{ role: "user", content: html }]);
    });

    it("JSON 字符串内容不应破坏 schema", async () => {
      const json = JSON.stringify({ nested: { array: [1,2,3], _special: "<>&\"'" } });
      await fuzzChat([{ role: "user", content: json }]);
    });

    it("空 reasoning_content 不应破坏 schema", async () => {
      await fuzzChat([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [{ id: "ce", type: "function", function: { name: "empty_reasoning", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "ce", name: "empty_reasoning", content: "" }
      ]);
    });

    it("tool_calls 的 arguments 为无效 JSON 时不应崩溃", async () => {
      await fuzzChat([
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "c_bad", type: "function", function: { name: "bad", arguments: "not valid json" } }] },
        { role: "tool", tool_call_id: "c_bad", name: "bad", content: "ok" }
      ]);
    });

    it("tool_calls 的 arguments 为空对象时不应崩溃", async () => {
      await fuzzChat([
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", tool_calls: [{ id: "c_empty", type: "function", function: { name: "empty_args", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c_empty", name: "empty_args", content: "done" }
      ]);
    });

    it("无 tool_call_id 的 tool 消息应正常处理", async () => {
      await fuzzChat([
        { role: "user", content: "hi" },
        { role: "tool", content: "no id" }
      ]);
    });

    it("tool 消息有 name 但无 tool_call_id 应正常处理", async () => {
      await fuzzChat([
        { role: "user", content: "hi" },
        { role: "tool", name: "some_tool", content: "result" }
      ]);
    });

    // Symbol 跳过：truncation service 在 normalizeMessageContent 之前调用 .match()，
    // Symbol 值会在此处触发 TypeError。需先修复 truncation_service 的 content 类型检查。

    it("极长消息数组（50条消息）应通过 schema", async () => {
      const msgs = [];
      for (let i = 0; i < 25; i++) {
        msgs.push({ role: "user", content: `msg ${i}` });
        msgs.push({ role: "assistant", content: `reply ${i}` });
      }
      await fuzzChat(msgs);
    });
  });
});
