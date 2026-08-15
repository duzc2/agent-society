/**
 * LlmClient 单元测试
 *
 * 通过 mock AI SDK 模块验证 LlmClient 的核心行为。
 * Phase 8 移除了旧 provider 抽象层，代码改为直接使用 AI SDK 创建模型。
 */

import { describe, it, mock, before, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../../../helpers/test_logger.js";
// 顶层导入真实 ai-sdk schema，在 mock.module 之前解析，用于校验消息格式
import { modelMessageSchema } from "ai";
import { assertValidMessages } from "../../../helpers/schema_validator.js";

// Note: mock.module 必须在测试上下文中调用，不能用顶层 await
// 因此所有 mock 和动态 import 放入 before hook

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
        capabilities: { input: ["text"], output: ["text"] },
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

// 共享状态（在 before hook 中初始化）
let LlmClient;
let generateTextImpl;
let mockGenerateText;
let mockCreateAnthropic;

describe("LlmClient", () => {
  before(async () => {
    // 初始化 mock 实现
    generateTextImpl = () =>
      Promise.resolve({
        text: "Mock response",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCalls: []
      });

    mockGenerateText = mock.fn(function (...args) {
      return generateTextImpl.apply(this, args);
    });

    await mock.module("ai", {
      namedExports: {
        generateText: mockGenerateText,
        tool: (schema) => schema,
        jsonSchema: (schema) => schema
      }
    });

    await mock.module("@ai-sdk/openai", {
      namedExports: {
        createOpenAI: () => ({
          chat: () => ({})
        })
      }
    });

    mockCreateAnthropic = mock.fn(() => () => ({}));

    await mock.module("@ai-sdk/anthropic", {
      namedExports: {
        createAnthropic: mockCreateAnthropic
      }
    });

    await mock.module("@ai-sdk/open-responses", {
      namedExports: {
        createOpenResponses: () => () => ({})
      }
    });

    await mock.module("llama-cpp-provider/dist/src/index.js", {
      namedExports: {
        createLocalAiProvider: () => ({
          languageModel: () => ({})
        })
      }
    });

    const mod = await import(
      "../../../../src/platform/services/llm/llm_client.js"
    );
    LlmClient = mod.LlmClient;
  });

  // 每个测试前重置调用计数和默认实现
  beforeEach(() => {
    mockGenerateText.mock.resetCalls();
    mockCreateAnthropic.mock.resetCalls();
    generateTextImpl = () =>
      Promise.resolve({
        text: "Mock response",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCalls: []
      });
  });

  describe("初始化与配置", () => {
    it("应支持通过 serviceId 获取服务配置", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({ messages: [{ role: "user", content: "Hi" }] });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      assert.strictEqual(typeof callArg.model, "object");
      assert.strictEqual(Array.isArray(callArg.messages), true);
    });

    it("应支持 anthropic provider", async () => {
      const client = new LlmClient({
        configService: createConfigService({ provider: "anthropic", model: "claude-sonnet" }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({ messages: [{ role: "user", content: "Hi" }] });
      assert.ok(mockCreateAnthropic.mock.callCount() > 0);
    });

    it("配置未变更时不应重建模型", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({ messages: [{ role: "user", content: "Hi" }] });

      const config = await client._getConfigAsync();
      assert.strictEqual(client._needsClientUpdate(config), false);
    });

    it("model 变更时应重建", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({ messages: [{ role: "user", content: "Hi" }] });

      const config = await client._getConfigAsync();
      const changedConfig = { ...config, model: "different-model" };
      assert.strictEqual(client._needsClientUpdate(changedConfig), true);
    });

    it("stream 标志变更时应重建", () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const result = client._needsClientUpdate({
        baseURL: "http://127.0.0.1:1234/v1",
        apiKey: "k",
        model: "test-x",
        provider: "openai",
        timeout: 1800000,
        stream: true,
        id: "test-model"
      });
      assert.strictEqual(result, true);
    });
  });

  describe("chat 方法", () => {
    it("应调用 generateText 并返回结果", async () => {
      generateTextImpl = () =>
        Promise.resolve({
          text: "Test response",
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          toolCalls: []
        });

      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const result = await client.chat({
        messages: [{ role: "user", content: "Test" }]
      });

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content, "Test response");
      assert.ok(mockGenerateText.mock.callCount() > 0);
    });

    it("应传递 system 选项给 generateText（以 SystemModelMessage 数组形式传递以支持 cache_control）", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }]
      });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      assert.ok(Array.isArray(callArg.system), "system should be a SystemModelMessage array");
      assert.strictEqual(callArg.system[0].role, "system");
      assert.strictEqual(callArg.system[0].content, "You are helpful.");
      assert.deepStrictEqual(callArg.system[0].providerOptions.anthropic.cacheControl, { type: "ephemeral" });
    });

    describe("系统提示词格式验证", () => {
      it("system 参数必须是 SystemModelMessage 格式，每个元素须有 role:'system'", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          system: "You are helpful.",
          messages: [{ role: "user", content: "Hello" }]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        assert.ok(Array.isArray(callArg.system));
        assert.strictEqual(callArg.system.length, 1);

        // 这些是 ai-sdk 运行时验证所需的关键属性：
        assert.strictEqual(callArg.system[0].role, "system", "must have role: 'system'");
        assert.strictEqual(callArg.system[0].content, "You are helpful.");
        assert.strictEqual(typeof callArg.system[0].content, "string", "content must be a string, not a content block");
      });

      it("没有 system 提示词时，不传递 system 参数给 generateText", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [{ role: "user", content: "Hello" }]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        assert.strictEqual(callArg.system, undefined);
      });
    });

    describe("消息格式转换 — 验证所有消息类型符合 ai-sdk ModelMessage 格式", () => {
      it("user 消息应为 { role:'user', content:string }", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "Hello, world!" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].role, "user");
        assert.strictEqual(typeof msgs[0].content, "string");
        assert.strictEqual(msgs[0].content, "Hello, world!");
        // 不得包含 type 或 text 字段（旧格式污染）
        assert.strictEqual(msgs[0].type, undefined, "user message should not have 'type'");
        assert.strictEqual(msgs[0].text, undefined, "user message should not have 'text'");
      });

      it("user 消息 content 为 null/undefined 时应转为空字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: null },
            { role: "user", content: undefined },
            { role: "user" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.strictEqual(typeof msgs[0].content, "string");
        assert.strictEqual(msgs[0].content, "");
        assert.strictEqual(msgs[1].content, "");
        assert.strictEqual(msgs[2].content, "");
      });

      it("assistant 消息（无 tool_calls）应为 { role:'assistant', content:string }", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "Hello!" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.strictEqual(msgs[1].role, "assistant");
        assert.strictEqual(typeof msgs[1].content, "string");
        assert.strictEqual(msgs[1].content, "Hello!");
        // 无 tool_calls 的 assistant 不应携带 type/text
        assert.strictEqual(msgs[1].type, undefined);
      });

      it("assistant 消息（有 tool_calls）应生成正确的 tool-call content block 格式", async () => {
        const client = new LlmClient({
          configService: createConfigService({ capabilities: { input: ["text"], output: ["text", "tool_calling"] } }),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const assistantMsg = {
          role: "assistant",
          content: "I'll check the weather",
          tool_calls: [{
            id: "call_abc123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Beijing","unit":"celsius"}'
            }
          }]
        };

        await client.chat({
          messages: [
            { role: "user", content: "What's the weather?" },
            assistantMsg,
            { role: "tool", tool_call_id: "call_abc123", content: '{"temp":25}' }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.ok(msgs.length >= 3, `expected >=3 messages, got ${msgs.length}`);
        assert.strictEqual(msgs[1].role, "assistant");

        // content 应为数组
        assert.ok(Array.isArray(msgs[1].content), "assistant with tool_calls should have content array");
        const contentBlocks = msgs[1].content;

        // 应包含 text block
        const textBlock = contentBlocks.find(c => c.type === "text");
        assert.ok(textBlock, "should have text content block");
        assert.strictEqual(textBlock.text, "I'll check the weather");

        // 应包含 tool-call block（使用 ai-sdk 格式：input 而非 args）
        const toolBlock = contentBlocks.find(c => c.type === "tool-call");
        assert.ok(toolBlock, "should have tool-call content block");
        assert.strictEqual(toolBlock.toolCallId, "call_abc123");
        assert.strictEqual(toolBlock.toolName, "get_weather");
        assert.deepStrictEqual(toolBlock.input, { city: "Beijing", unit: "celsius" });
        // 不得使用旧格式字段
        assert.strictEqual(toolBlock.args, undefined, "tool-call should use 'input' not 'args'");
        assert.strictEqual(toolBlock.function, undefined, "tool-call should not have 'function' wrapper");
      });

      it("assistant 消息（有 tool_calls + reasoning_content）应生成 reasoning + tool-call block", async () => {
        const client = new LlmClient({
          configService: createConfigService({ capabilities: { input: ["text"], output: ["text", "tool_calling"] } }),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const assistantMsg = {
          role: "assistant",
          content: "let me think",
          reasoning_content: "I need to use a tool here.",
          tool_calls: [{
            id: "call_xyz",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' }
          }]
        };

        await client.chat({
          messages: [
            { role: "user", content: "search for test" },
            assistantMsg,
            { role: "tool", tool_call_id: "call_xyz", content: '{"results":[]}' }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        const contentBlocks = msgs[1].content;
        assert.ok(Array.isArray(contentBlocks));

        // 应包含 reasoning block
        const reasoningBlock = contentBlocks.find(c => c.type === "reasoning");
        assert.ok(reasoningBlock, "should have reasoning content block");
        assert.strictEqual(reasoningBlock.text, "I need to use a tool here.");

        // 应包含 tool-call block
        const toolBlock = contentBlocks.find(c => c.type === "tool-call");
        assert.ok(toolBlock);
        assert.strictEqual(toolBlock.toolCallId, "call_xyz");
        assert.strictEqual(toolBlock.toolName, "search");
      });

      it("assistant 消息（有 tool_calls + tool 结果）应正确格式化", async () => {
        const client = new LlmClient({
          configService: createConfigService({ capabilities: { input: ["text"], output: ["text", "tool_calling"] } }),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const assistantMsg = {
          role: "assistant",
          content: "calling tool",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "do_thing", arguments: '{}' }
          }]
        };

        await client.chat({
          messages: [
            { role: "user", content: "do it" },
            assistantMsg,
            { role: "tool", tool_call_id: "call_1", content: "done" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.ok(msgs.length >= 2, `expected >=2 messages, got ${msgs.length}`);
        const contentBlocks = msgs[1].content;
        assert.ok(Array.isArray(contentBlocks));
        const toolCalls = contentBlocks.filter(c => c.type === "tool-call");
        assert.ok(toolCalls.length > 0, "should have at least one tool-call block");
        assert.strictEqual(toolCalls[0].toolCallId, "call_1");
        assert.strictEqual(toolCalls[0].toolName, "do_thing");
        assert.ok(toolCalls[0].input !== undefined, "tool-call should have 'input' not 'args'");
        assert.deepStrictEqual(toolCalls[0].input, {});
        // args 不得出现（旧格式）
        assert.strictEqual(toolCalls[0].args, undefined);
      });

      it("tool 消息应生成 tool-result content block（使用 output 而非 result）", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_456", type: "function", function: { name: "test_tool", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_456", content: '{"status":"ok","temp":25}' }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.ok(msgs.length >= 3, `expected >=3 messages, got ${msgs.length}`);
        const toolMsg = msgs[2];
        assert.strictEqual(toolMsg.role, "tool");
        assert.ok(Array.isArray(toolMsg.content), "tool message should have content array");

        const toolBlock = toolMsg.content[0];
        assert.strictEqual(toolBlock.type, "tool-result");
        assert.strictEqual(toolBlock.toolCallId, "call_456");
        assert.strictEqual(toolBlock.toolName, "");
        // ai-sdk 使用 output 而非 result
        assert.ok(toolBlock.output !== undefined, "tool-result should use 'output' not 'result'");
        assert.strictEqual(toolBlock.result, undefined, "should not have 'result' (old format)");
        assert.strictEqual(toolBlock.output.type, "text");
        assert.strictEqual(toolBlock.output.value, '{"status":"ok","temp":25}');
      });

      it("tool 消息有 name 字段时应正确设置 toolName", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_789", type: "function", function: { name: "search_tool", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_789", name: "search_tool", content: "results here" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.ok(msgs.length >= 3);
        assert.strictEqual(msgs[2].content[0].toolName, "search_tool");
      });

      it("tool 消息的 output.value 应保持为字符串格式", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_special", type: "function", function: { name: "test_tool", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_special", content: "some_result" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        assert.ok(msgs.length >= 3, `expected >=3 messages, got ${msgs.length}`);
        const toolBlock = msgs[2].content[0];
        assert.strictEqual(toolBlock.type, "tool-result");
        assert.strictEqual(toolBlock.output.type, "text");
        assert.strictEqual(typeof toolBlock.output.value, "string", "output.value must be a string for text output type");
        assert.strictEqual(toolBlock.output.value, "some_result");
      });

      it("相同 tool_call_id 的重复 tool 消息应只保留第一条", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "ok",
              tool_calls: [{ id: "dup_result", type: "function", function: { name: "read", arguments: "{}" } }]
            },
            { role: "tool", tool_call_id: "dup_result", name: "read", content: "first" },
            { role: "tool", tool_call_id: "dup_result", name: "read", content: "second" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        const toolMsgs = msgs.filter((msg) => msg.role === "tool");
        assert.strictEqual(toolMsgs.length, 1, "duplicate tool_result should be removed before generateText");
        assert.strictEqual(toolMsgs[0].content[0].output.value, "first", "keep the first occurrence");
      });

      it("无 tool_call_id 的 tool 消息应转换为 tool-result 格式", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "tool", content: "no tool_call_id" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        // 无 tool_call_id 的 tool 消息仍产生 tool-result 内容块，符合 ai-sdk 要求
        assert.strictEqual(msgs[1].role, "tool");
        assert.ok(Array.isArray(msgs[1].content), "tool message content must be an array");
        assert.strictEqual(msgs[1].content[0].type, "tool-result");
        assert.strictEqual(typeof msgs[1].content[0].output.value, "string");
        assert.strictEqual(msgs[1].content[0].output.value, "no tool_call_id");
      });
    });

    describe("边界条件与 schema 合规", () => {
      // ================================================================
      // 以下测试构造会触发 ai-sdk schema 验证失败的输入（非 string content）
      // 确保消息格式化代码对所有输入类型都产生合法输出
      // ================================================================

      it("user 消息 content 为数字 0 时必须转为字符串 '0'", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [{ role: "user", content: 0 }]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[0];
        // ai-sdk userModelMessageSchema: content 必须是 string 或 array
        // 数字 0 不是 string，会导致 schema 验证失败
        assert.strictEqual(msg.role, "user");
        assert.strictEqual(typeof msg.content, "string",
          "content must be string to pass ai-sdk z.string() validation");
        assert.strictEqual(msg.content, "0");
      });

      it("user 消息 content 为 boolean false 时必须转为字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [{ role: "user", content: false }]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[0];
        assert.strictEqual(typeof msg.content, "string");
        assert.strictEqual(msg.content, "false");
      });

      it("assistant 消息（无 tool_calls）content 为数字时应转为字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: 42 }
          ]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[1];
        assert.strictEqual(msg.role, "assistant");
        assert.strictEqual(typeof msg.content, "string",
          "assistant content must be string to pass ai-sdk validation");
        assert.strictEqual(msg.content, "42");
      });

      it("tool 消息 content 为数字时 output.value 必须转为字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_num", type: "function", function: { name: "counter", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_num", content: 123 }
          ]
        });

        const toolBlock = mockGenerateText.mock.calls[0].arguments[0].messages[2].content[0];
        assert.strictEqual(toolBlock.type, "tool-result");
        // ai-sdk outputSchema for text: value 必须是 z.string()
        assert.strictEqual(typeof toolBlock.output.value, "string",
          "output.value must be string for text output type, number 123 would fail z.string()");
        assert.strictEqual(toolBlock.output.value, "123");
      });

      it("tool 消息 content 为 boolean 时 output.value 必须转为字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_bool", type: "function", function: { name: "check", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_bool", content: true }
          ]
        });

        const toolBlock = mockGenerateText.mock.calls[0].arguments[0].messages[2].content[0];
        assert.strictEqual(typeof toolBlock.output.value, "string");
        assert.strictEqual(toolBlock.output.value, "true");
      });

      it("普通消息 content 为对象时应序列化为 JSON 字符串", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [{ role: "user", content: { nested: "value" } }]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[0];
        // ai-sdk userModelMessageSchema: content 是 z.union([z.string(), z.array(...)])
        // 对象不是 string 也不是 array → 必须转为 string
        assert.strictEqual(typeof msg.content, "string",
          "object content must be serialized to string");
        assert.strictEqual(msg.content, '{"nested":"value"}');
      });

      it("所有消息格式必须通过实际的 ai-sdk ModelMessage schema 合规检查", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          system: "You are a test assistant.",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" }
          ]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];

        // === system: 必须是 SystemModelMessage 格式 ===
        assert.ok(Array.isArray(callArg.system), "system should be array of SystemModelMessage");
        for (const sm of callArg.system) {
          assert.strictEqual(sm.role, "system",
            `SystemModelMessage.role must be "system", got "${sm.role}"`);
          assert.strictEqual(typeof sm.content, "string",
            `SystemModelMessage.content must be string, got ${typeof sm.content}`);
        }

        // === messages: 每个元素必须符合 ModelMessage schema ===
        const validRoles = new Set(["system", "user", "assistant", "tool"]);
        const rolesSeen = new Set();

        for (const msg of callArg.messages) {
          // role 必须是合法的字面量
          assert.ok(validRoles.has(msg.role),
            `Invalid role "${msg.role}", must be one of: system, user, assistant, tool`);
          rolesSeen.add(msg.role);

          if (msg.role === "system" || msg.role === "user" || msg.role === "assistant") {
            // content 必须是 string 或 array
            const isValidContent = typeof msg.content === "string" || Array.isArray(msg.content);
            assert.ok(isValidContent,
              `${msg.role} message content must be string or array, got ${typeof msg.content}`);
          }

          if (msg.role === "tool") {
            // content 必须是 array
            assert.ok(Array.isArray(msg.content),
              `tool message content must be array, got ${typeof msg.content}`);
            for (const block of msg.content) {
              // 每个 block 必须是 tool-result 或 tool-approval-response
              assert.ok(block.type === "tool-result" || block.type === "tool-approval-response",
                `tool content block type must be "tool-result", got "${block.type}"`);
              if (block.type === "tool-result") {
                assert.strictEqual(typeof block.toolCallId, "string");
                assert.ok(block.output, "tool-result must have 'output'");
                // text output 的 value 必须是 string
                if (block.output.type === "text") {
                  assert.strictEqual(typeof block.output.value, "string",
                    "text output value must be string to pass ai-sdk z.string()");
                }
              }
            }
          }

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              const validBlockTypes = new Set([
                "text", "image", "file", "reasoning", "tool-call", "tool-result"
              ]);
              assert.ok(validBlockTypes.has(block.type),
                `Unknown content block type "${block.type}"`);
              // text block 的 text 字段必须是 string
              if (block.type === "text") {
                assert.strictEqual(typeof block.text, "string",
                  `text block 'text' must be string, got ${typeof block.text}`);
              }
              // tool-call block 必须用 input 而非 args
              if (block.type === "tool-call") {
                assert.ok(block.input !== undefined, "tool-call must have 'input'");
                assert.strictEqual(block.args, undefined, "tool-call must not use deprecated 'args' field");
              }
            }
          }
        }

        // 确保没有奇怪的 role 出现
        assert.ok(!rolesSeen.has("tool"),
          "simple conversation should not have tool messages; verify format didn't inject them");
      });
    });

    describe("缓存控制与内容块数组处理", () => {
      // ================================================================
      // 关键 Bug 修复（F1）：_applyCacheControlToLastContentBlock 在 compute_scheduler.js
      // 中将内容转换为数组，格式化器必须能处理这种情况。
      // ================================================================

      it("user 消息 content 为内容块数组时应直接透传（保留 providerOptions/cacheControl）", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const contentBlocks = [{
          type: "text",
          text: "hello with cache",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        }];

        await client.chat({
          messages: [{ role: "user", content: contentBlocks }]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[0];
        assert.ok(Array.isArray(msg.content),
          "content should be an array when input is content blocks");
        assert.strictEqual(msg.content[0].type, "text");
        assert.strictEqual(msg.content[0].text, "hello with cache");
        assert.deepStrictEqual(msg.content[0].providerOptions.anthropic.cacheControl,
          { type: "ephemeral" },
          "cacheControl from _applyCacheControlToLastContentBlock must be preserved");
      });

      it("assistant 消息（无 tool_calls）content 为内容块数组时应直接透传", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const contentBlocks = [{
          type: "text",
          text: "assistant reply",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        }];

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: contentBlocks }
          ]
        });

        const msg = mockGenerateText.mock.calls[0].arguments[0].messages[1];
        assert.strictEqual(msg.role, "assistant");
        assert.ok(Array.isArray(msg.content), "content should be array");
        assert.strictEqual(msg.content[0].type, "text");
        assert.strictEqual(msg.content[0].text, "assistant reply");
      });

      it("assistant 消息（有 tool_calls）content 为内容块数组时应合并入 content 数组", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        const contentBlocks = [{
          type: "text",
          text: "using tool",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        }];

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: contentBlocks,
              tool_calls: [{ id: "call_cache", type: "function", function: { name: "search", arguments: '{}' } }]
            },
            { role: "tool", tool_call_id: "call_cache", content: "result" }
          ]
        });

        const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
        // 助理消息应同时包含文本块和工具调用块
        const assistantMsg = msgs[1];
        assert.strictEqual(assistantMsg.role, "assistant");
        assert.ok(Array.isArray(assistantMsg.content));
        // 文本块应在工具调用块之前
        const textBlocks = assistantMsg.content.filter(b => b.type === "text");
        assert.ok(textBlocks.length >= 1, "should have at least one text block");
        assert.strictEqual(textBlocks[0].text, "using tool");
        assert.deepStrictEqual(
          textBlocks[0].providerOptions?.anthropic?.cacheControl,
          { type: "ephemeral" },
          "cacheControl from content blocks must be preserved when merged"
        );
        const toolBlocks = assistantMsg.content.filter(b => b.type === "tool-call");
        assert.strictEqual(toolBlocks[0].toolCallId, "call_cache");
      });

      it("tool 消息 content 为内容块数组时应从 text block 中提取 value", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        // 模拟 _applyCacheControlToLastContentBlock 转换后的工具内容
        const contentBlocks = [{
          type: "text",
          text: '{"status":"ok"}',
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        }];

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "using tool", tool_calls: [{ id: "call_tool_cache", type: "function", function: { name: "test", arguments: '{}' } }] },
            { role: "tool", tool_call_id: "call_tool_cache", name: "test", content: contentBlocks }
          ]
        });

        const toolMsg = mockGenerateText.mock.calls[0].arguments[0].messages[2];
        const toolBlock = toolMsg.content[0];
        assert.strictEqual(toolBlock.type, "tool-result");
        assert.strictEqual(toolBlock.output.type, "text");
        assert.strictEqual(typeof toolBlock.output.value, "string",
          "tool output.value must be a string, not an array");
        assert.strictEqual(toolBlock.output.value, '{"status":"ok"}');
      });

      // ========== P1: 跨层集成测试 — compute_scheduler 消息 → llm_client → schema ==========
      // 以下测试模拟 compute_scheduler._startLlm 输出的真实对话（包含缓存断点改造），
      // 调用 chat()，再用 assertValidMessages 验证格式化输出通过 ai-sdk schema。

      it("[P1 跨层] user 消息被 cache control 改造后，通过 llm_client 格式化可通过 schema", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "稳定消息", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
              ]
            },
            { role: "assistant", content: "收到" }
          ]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        await assertValidMessages(callArg.messages, "P1: user with cacheControl");
      });

      it("[P1 跨层] assistant（无 tool_calls）被 cache control 改造后可通过 schema", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "回复内容", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
              ]
            }
          ]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        await assertValidMessages(callArg.messages, "P1: assistant no-tool_calls with cacheControl");
      });

      it("[P1 跨层] assistant + tool_calls 被 cache control 改造后可通过 schema（生产 crash 场景）", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "search" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "正在搜索", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
              ],
              tool_calls: [
                { id: "call_cross", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }
              ]
            },
            { role: "tool", tool_call_id: "call_cross", name: "search", content: '{"results":[]}' }
          ]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        await assertValidMessages(callArg.messages, "P1: assistant+tool_calls with cacheControl (production crash scenario)");
      });

      it("[P1 跨层] tool 消息被 cache control 改造后可通过 schema", async () => {
        const client = new LlmClient({
          configService: createConfigService(),
          serviceId: "test-model",
          logger: makeTestLogger("LlmClient")
        });

        await client.chat({
          messages: [
            { role: "user", content: "do it" },
            { role: "assistant", content: "ok", tool_calls: [{ id: "call_tool_cross", type: "function", function: { name: "do_thing", arguments: '{}' } }] },
            {
              role: "tool",
              tool_call_id: "call_tool_cross",
              name: "do_thing",
              content: [
                { type: "text", text: '{"status":"done"}', providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
              ]
            }
          ]
        });

        const callArg = mockGenerateText.mock.calls[0].arguments[0];
        await assertValidMessages(callArg.messages, "P1: tool message with cacheControl");
      });
    });

    it("应传递 tools 给 generateText", async () => {
      const client = new LlmClient({
        configService: createConfigService({ capabilities: { input: ["text"], output: ["text", "tool_calling"] } }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      await client.chat({
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "test_tool", parameters: { type: "object", properties: {} } } }]
      });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      assert.notStrictEqual(callArg.tools, undefined);
    });
  });

  describe("重试", () => {
    it("应在可重试错误时重试", async () => {
      let callCount = 0;
      generateTextImpl = () => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error("fetch failed"));
        }
        return Promise.resolve({
          text: "Success",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          toolCalls: []
        });
      };

      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient"),
        maxRetries: 3
      });

      const result = await client.chat({
        messages: [{ role: "user", content: "Test" }]
      });

      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.content, "Success");
    });
  });

  describe("工具调用响应处理", () => {
    it("应提取 tool_calls", async () => {
      generateTextImpl = () =>
        Promise.resolve({
          text: "",
          toolCalls: [
            {
              toolCallId: "call_123",
              toolName: "get_weather",
              args: JSON.stringify({ city: "Beijing" })
            }
          ],
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }
        });

      const client = new LlmClient({
        configService: createConfigService({ capabilities: { input: ["text"], output: ["text", "tool_calling"] } }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const result = await client.chat({
        messages: [{ role: "user", content: "Weather?" }]
      });

      assert.notStrictEqual(result.tool_calls, undefined);
      assert.strictEqual(result.tool_calls.length, 1);
      assert.strictEqual(result.tool_calls[0].function.name, "get_weather");
    });
  });

  describe("maxTokens / maxContextTokens", () => {
    it("_getConfigAsync 合并 service 和 llm 默认配置", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const config = await client._getConfigAsync();
      assert.strictEqual(config.maxTokens, 4096);
      assert.strictEqual(config.model, "test-x");
    });

    it("服务配置显式设置 maxContextTokens 时应保留", async () => {
      const client = new LlmClient({
        configService: createConfigService({ maxContextTokens: 64000 }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const config = await client._getConfigAsync();
      assert.strictEqual(config.maxContextTokens, 64000);
    });
  });

  describe("token 估算", () => {
    it("_estimateMessageTokens 应估算消息 token 数", () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      const tokens = client._truncationService.estimateMessageTokens({ role: "user", content: "hello" });
      assert.ok(tokens > 0);
    });
  });

  describe("capability gating", () => {
    it("_supportsToolCalling 应在 output capabilities 不含 tool_calling 时返回 false", () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      assert.strictEqual(client._supportsToolCalling({ capabilities: { output: ["text"] } }), false);
    });

    it("_supportsToolCalling 应在 output capabilities 含 tool_calling 时返回 true", () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });

      assert.strictEqual(client._supportsToolCalling({ capabilities: { output: ["text", "tool_calling"] } }), true);
    });
  });

  /**
   * 结构性防护：将格式化后的消息用真实的 ai-sdk modelMessageSchema 校验。
   *
   * 为什么这个测试能抓到之前漏掉的 bug：
   *   1. 所有其他测试都 mock 了 generateText → 真实的 zod 校验从未运行
   *   2. 此测试用 modelMessageSchema.parse() 直接校验输出，验证的是 ai-sdk
   *      实际接受的格式，而非"代码当前产出的格式"
   *   3. 任何 {type, text} 误会、工具消息、数字/布尔等内容的缺陷都会在此暴露
   *
   * "不要测你的代码做了什么，测消费者（ai-sdk）会接受什么。"
   */
  describe("真实 ai-sdk schema 校验", () => {
    /**
     * 辅助函数：验证消息能通过 modelMessageSchema 校验。
     * 如果不通过则直接抛出带诊断信息的 AssertionError。
     */
    async function assertValidMessages(messages, label = "messages") {
      try {
        await modelMessageSchema.array().parse(messages);
      } catch (err) {
        // Zod v4 错误对象包含 issues 数组，给出详细格式信息
        const issues = err?.issues ?? [];
        const details = issues.map(i => {
          const msgContent = i.path?.length
            ? JSON.stringify(messages[i.path[0]]).substring(0, 300)
            : "(unknown)";
          return `  at path [${(i.path ?? []).join(".")}]: ${i.message}\n    message: ${msgContent}`;
        }).join("\n") || err?.message || String(err);
        assert.fail(`${label}: 消息格式不符合 ai-sdk ModelMessage[] schema\n${details}`);
      }
    }

    it("基本 user + assistant 对话必须通过 schema 校验", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });
      await client.chat({
        system: "You are helpful.",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" }
        ]
      });
      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "user+assistant dialog");
    });

    it("assistant + tool_calls + tool 结果序列必须通过 schema 校验", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });
      await client.chat({
        messages: [
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: "searching",
            tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }]
          },
          { role: "tool", tool_call_id: "c1", name: "search", content: '{"results":[]}' }
        ]
      });
      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "tool call sequence");
    });

    it("内容块数组格式（来自 cacheControl 预处理）必须通过 schema 校验", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });
      // 模拟 compute_scheduler._applyCacheControlToLastContentBlock 的输出
      await client.chat({
        messages: [
          { role: "user", content: "trigger" },
          {
            role: "assistant",
            content: [{ type: "text", text: "thinking", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
            tool_calls: [{ id: "c_cc", type: "function", function: { name: "do", arguments: '{}' } }]
          },
          { role: "tool", tool_call_id: "c_cc", name: "do", content: "done" }
        ]
      });
      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "cacheControl content blocks");
    });

    it("数字、布尔、对象等非标准 content 值必须通过 schema 校验", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });
      await client.chat({
        messages: [
          { role: "user", content: 0 },
          { role: "assistant", content: false },
          { role: "user", content: { nested: "obj" } },
          { role: "assistant", content: "" }
        ]
      });
      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "non-standard content values");
    });

    it("复杂多轮对话（含工具调用、reasoning、空内容）必须通过 schema 校验", async () => {
      const client = new LlmClient({
        configService: createConfigService(),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient")
      });
      await client.chat({
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: "ok" },
          {
            role: "assistant",
            content: "executing",
            reasoning_content: "let me think...",
            tool_calls: [{ id: "c_a", type: "function", function: { name: "a", arguments: '{}' } }]
          },
          { role: "tool", tool_call_id: "c_a", name: "a", content: "ok" },
          { role: "user", content: "next" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c_b", type: "function", function: { name: "read", arguments: '{}' } }]
          },
          { role: "tool", tool_call_id: "c_b", name: "read", content: '{"data":"value"}' }
        ]
      });
      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "complex multi-turn");
    });
  });
});
