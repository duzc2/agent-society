/**
 * 消息格式转换器测试
 *
 * 使用 Mock 数据测试 OpenAI 和 Anthropic 格式之间的转换
 * 无需启动服务器或连接真实 API
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  toAnthropicMessages,
  fromAnthropicResponse,
  convertToolsToAnthropic,
} from "../../../../../src/platform/services/llm/utils/message_adapter.js";

describe("message_adapter", () => {
  describe("toAnthropicMessages", () => {
    it("应正确处理空消息数组", () => {
      const result = toAnthropicMessages([]);
      assert.strictEqual(result.system, null);
      assert.deepStrictEqual(result.messages, []);
    });

    it("应正确处理 undefined", () => {
      const result = toAnthropicMessages(undefined);
      assert.strictEqual(result.system, null);
      assert.deepStrictEqual(result.messages, []);
    });

    it("应提取 system 消息为独立参数", () => {
      const openAiMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.system, "You are a helpful assistant.");
      assert.strictEqual(result.messages.length, 1);
      assert.deepStrictEqual(result.messages[0], {
        role: "user",
        content: "Hello",
      });
    });

    it("应合并多个 system 消息", () => {
      const openAiMessages = [
        { role: "system", content: "First system message." },
        { role: "system", content: "Second system message." },
        { role: "user", content: "Hello" },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.system, "First system message.\nSecond system message.");
      assert.strictEqual(result.messages.length, 1);
    });

    it("应正确处理 user 消息", () => {
      const openAiMessages = [
        { role: "user", content: "What is the weather?" },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.system, null);
      assert.deepStrictEqual(result.messages, [
        { role: "user", content: "What is the weather?" },
      ]);
    });

    it("应正确处理简单 assistant 消息", () => {
      const openAiMessages = [
        { role: "assistant", content: "The weather is sunny." },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].role, "assistant");
      assert.deepStrictEqual(result.messages[0].content, {
        type: "text",
        text: "The weather is sunny.",
      });
    });

    it("应将 tool_calls 转换为 tool_use blocks", () => {
      const openAiMessages = [
        {
          role: "assistant",
          content: "I'll check the weather for you.",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "Beijing"}',
              },
            },
          ],
        },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].role, "assistant");
      assert.deepStrictEqual(result.messages[0].content, [
        { type: "text", text: "I'll check the weather for you." },
        {
          type: "tool_use",
          id: "call_123",
          name: "get_weather",
          input: { location: "Beijing" },
        },
      ]);
    });

    it("应将 tool 消息转换为 tool_result blocks", () => {
      const openAiMessages = [
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"temperature": 25, "condition": "sunny"}',
        },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].role, "user");
      assert.deepStrictEqual(result.messages[0].content, [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: '{"temperature": 25, "condition": "sunny"}',
        },
      ]);
    });

    it("应处理完整的工具调用对话流程", () => {
      const openAiMessages = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What's the weather in Beijing?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location": "Beijing"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_abc",
          content: '{"temp": 25}',
        },
      ];

      const result = toAnthropicMessages(openAiMessages);

      assert.strictEqual(result.system, "You are helpful.");
      assert.strictEqual(result.messages.length, 3);
      assert.deepStrictEqual(result.messages[0], {
        role: "user",
        content: "What's the weather in Beijing?",
      });
      assert.strictEqual(result.messages[1].role, "assistant");
      assert.deepStrictEqual(result.messages[2], {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_abc",
            content: '{"temp": 25}',
          },
        ],
      });
    });
  });

  describe("fromAnthropicResponse", () => {
    it("应处理空响应", () => {
      const result = fromAnthropicResponse(null);
      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content, null);
    });

    it("应处理简单文本响应", () => {
      const anthropicResp = {
        content: [{ type: "text", text: "Hello, world!" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content, "Hello, world!");
      assert.deepStrictEqual(result._usage, {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it("应合并多个 text blocks", () => {
      const anthropicResp = {
        content: [
          { type: "text", text: "First part. " },
          { type: "text", text: "Second part." },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.strictEqual(result.content, "First part. Second part.");
    });

    it("应将 tool_use blocks 转换为 tool_calls", () => {
      const anthropicResp = {
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "calculator",
            input: { a: 1, b: 2 },
          },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.strictEqual(result.content, null);
      assert.deepStrictEqual(result.tool_calls, [
        {
          id: "tool_123",
          type: "function",
          function: {
            name: "calculator",
            arguments: '{"a":1,"b":2}',
          },
        },
      ]);
    });

    it("应同时处理 text 和 tool_use blocks", () => {
      const anthropicResp = {
        content: [
          { type: "text", text: "I'll calculate that for you." },
          {
            type: "tool_use",
            id: "tool_456",
            name: "add",
            input: { x: 5, y: 3 },
          },
        ],
        usage: { input_tokens: 30, output_tokens: 15 },
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.strictEqual(result.content, "I'll calculate that for you.");
      assert.strictEqual(result.tool_calls.length, 1);
      assert.strictEqual(result.tool_calls[0].id, "tool_456");
    });

    it("应保留 thinking blocks", () => {
      const anthropicResp = {
        content: [
          { type: "thinking", thinking: "Let me think...", signature: "sig123" },
          { type: "text", text: "The answer is 42." },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.strictEqual(result.content, "The answer is 42.");
      assert.deepStrictEqual(result._thinking, [
        { thinking: "Let me think...", signature: "sig123" },
      ]);
    });

    it("应处理无 usage 的情况", () => {
      const anthropicResp = {
        content: [{ type: "text", text: "Hello" }],
      };

      const result = fromAnthropicResponse(anthropicResp);

      assert.deepStrictEqual(result._usage, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });
  });

  describe("convertToolsToAnthropic", () => {
    it("应转换 OpenAI tools 格式", () => {
      const openAiTools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ];

      const result = convertToolsToAnthropic(openAiTools);

      assert.deepStrictEqual(result, [
        {
          name: "get_weather",
          description: "Get weather for a location",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      ]);
    });

    it("应过滤非 function 类型的工具", () => {
      const openAiTools = [
        { type: "function", function: { name: "valid_tool" } },
        { type: "invalid", name: "skip_this" },
        { type: "function" }, // missing function object
      ];

      const result = convertToolsToAnthropic(openAiTools);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "valid_tool");
    });

    it("应处理空数组", () => {
      const result = convertToolsToAnthropic([]);
      assert.strictEqual(result, undefined);
    });

    it("应处理 undefined", () => {
      const result = convertToolsToAnthropic(undefined);
      assert.strictEqual(result, undefined);
    });
  });
});
