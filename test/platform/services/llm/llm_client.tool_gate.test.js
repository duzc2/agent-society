import { describe, it, mock, before, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../../../helpers/test_logger.js";
// 顶层导入真实 ai-sdk schema，在 mock.module 之前解析，用于校验消息格式
import { modelMessageSchema } from "ai";

// Note: mock.module 必须在测试上下文中调用，不能用顶层 await
// 因此所有 mock 和动态 import 放入 before hook

// 共享状态（在 before hook 中初始化）
let LlmClient;
let generateTextImpl;
let mockGenerateText;
let mockCreateOpenResponses;

/**
 * Build a mock config service with the specified output capabilities.
 * @param {string[]} outputCapabilities - Configured output capabilities.
 * @param {Partial<any>} [overrides] - Extra service config overrides.
 * @returns {{getServices: Function, getLlm: Function}}
 */
function createConfigService(outputCapabilities, overrides = {}) {
  return {
    getServices: async () => ({
      services: [{
        id: "test-model",
        provider: "openai",
        baseURL: "http://127.0.0.1:1234/v1",
        model: "test-x",
        apiKey: "k",
        maxTokens: 4096,
        capabilities: {
          input: ["text"],
          output: outputCapabilities
        },
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

/**
 * Build a tool definition, optionally with a very large schema payload.
 * @param {number} [paddingSize=0] - Extra text size used to inflate the tool schema.
 * @returns {any}
 */
function createToolDefinition(paddingSize = 0) {
  const padding = "x".repeat(paddingSize);
  return {
    type: "function",
    function: {
      name: "dummy",
      description: `tool-${padding}`,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: `prompt-${padding}`
          }
        },
        required: ["prompt"]
      }
    }
  };
}

/**
 * 创建带工具调用的 assistant 消息。
 * @param {string[]} toolCallIds - 工具调用 ID 列表。
 * @param {string} [content=""] - assistant 文本内容。
 * @param {string|null} [reasoningContent=null] - assistant 思考内容。
 * @returns {any}
 */
function createAssistantToolCallMessage(toolCallIds, content = "", reasoningContent = null) {
  const message = {
    role: "assistant",
    content,
    tool_calls: toolCallIds.map((toolCallId, index) => ({
      id: toolCallId,
      type: "function",
      function: {
        name: `tool_${index + 1}`,
        arguments: JSON.stringify({ toolCallId })
      }
    }))
  };
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    message.reasoning_content = reasoningContent;
  }
  return message;
}

/**
 * 创建 tool 结果消息。
 * @param {string} toolCallId - 对应的工具调用 ID。
 * @param {string} content - 工具结果内容。
 * @returns {any}
 */
function createToolResultMessage(toolCallId, content) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content
  };
}

describe("LlmClient tools gate", () => {
  before(async () => {
    generateTextImpl = () =>
      Promise.resolve({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: []
      });

    mockGenerateText = mock.fn(function (...args) {
      return generateTextImpl.apply(this, args);
    });

    mockCreateOpenResponses = mock.fn(() => (() => ({})));

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

    await mock.module("@ai-sdk/anthropic", {
      namedExports: {
        createAnthropic: () => () => ({})
      }
    });

    await mock.module("@ai-sdk/open-responses", {
      namedExports: {
        createOpenResponses: mockCreateOpenResponses
      }
    });

    await mock.module("llama-cpp-provider/dist/src/index.js", {
      namedExports: {
        createLocalAiProvider: () => ({
          languageModel: () => ({})
        })
      }
    });

    const mod = await import("../../../../src/platform/services/llm/llm_client.js");
    LlmClient = mod.LlmClient;
  });

  beforeEach(() => {
    mockGenerateText.mock.resetCalls();
    mockCreateOpenResponses.mock.resetCalls();
    generateTextImpl = () =>
      Promise.resolve({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: []
      });
  });

  it("unsupported models should omit tools", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }],
      tools: [createToolDefinition()]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(callArg, "tools"), false);
  });

  it("tool-capable models should send tools", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }],
      tools: [createToolDefinition()]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(callArg, "tools"), true);
  });

  it("should not inject default temperature when request and config both omit it", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(callArg, "temperature"), false);
  });

  it("should use configured temperature when request does not provide one", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"], { temperature: 0.65 }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(callArg.temperature, 0.65);
  });

  it("open-responses provider should create model from responses endpoint", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"], {
        provider: "open-responses",
        baseURL: "http://127.0.0.1:1234/v1"
      }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.strictEqual(mockCreateOpenResponses.mock.callCount(), 1);
    const callArg = mockCreateOpenResponses.mock.calls[0].arguments[0];
    assert.strictEqual(callArg.name, "test-model");
    assert.strictEqual(callArg.url, "http://127.0.0.1:1234/v1/responses");
    assert.strictEqual(callArg.apiKey, "k");
  });

  it("open-responses provider should preserve full responses endpoint url", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"], {
        provider: "open-responses",
        baseURL: "http://127.0.0.1:1234/v1/responses"
      }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.strictEqual(mockCreateOpenResponses.mock.callCount(), 1);
    assert.strictEqual(mockCreateOpenResponses.mock.calls[0].arguments[0].url, "http://127.0.0.1:1234/v1/responses");
  });

  it("should assemble stream-like response body into the existing non-stream callback shape", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    client._exchangeState.lastHttpExchange = {
      response: {
        body: [
          "event: response.output_text.delta",
          'data: {"delta":"你好"}',
          "",
          "event: response.reasoning_text.delta",
          'data: {"delta":"思考中"}',
          "",
          "event: response.output_item.done",
          'data: {"item":{"id":"item-1","type":"function_call","call_id":"call-1","name":"send_message","arguments":"{\\"text\\":\\"hello\\"}"}}',
          "",
          "event: response.completed",
          'data: {"response":{"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}'
        ].join("\n")
      }
    };

    generateTextImpl = () => Promise.reject(new Error("Invalid JSON response"));

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.deepStrictEqual(result, {
      role: "assistant",
      content: "你好",
      reasoning_content: "思考中",
      _usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 0
      },
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "send_message",
          arguments: "{\"text\":\"hello\"}"
        }
      }]
    });
  });

  it("should assemble chat-completions stream chunks into a normal assistant message", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    client._exchangeState.lastHttpExchange = {
      response: {
        body: [
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello","reasoning_content":"plan"}}],"usage":null}',
          "",
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
          "",
          "data: [DONE]"
        ].join("\n")
      }
    };

    generateTextImpl = () => Promise.reject(new Error("Invalid JSON response"));

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.deepStrictEqual(result, {
      role: "assistant",
      content: "hello world",
      reasoning_content: "plan",
      _usage: {
        promptTokens: 5,
        completionTokens: 2,
        totalTokens: 7,
        cachedInputTokens: 0
      }
    });
  });

  it("should assemble chat-completions tool call chunks into a normal assistant message", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    client._exchangeState.lastHttpExchange = {
      response: {
        body: [
          'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"hel"}}]}}],"usage":null}',
          "",
          'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lo\\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
          "",
          "data: [DONE]"
        ].join("\n")
      }
    };

    generateTextImpl = () => Promise.reject(new Error("Invalid JSON response"));

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.deepStrictEqual(result, {
      role: "assistant",
      content: "",
      _usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
        cachedInputTokens: 0
      },
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "search",
          arguments: "{\"q\":\"hello\"}"
        }
      }]
    });
  });

  it("unsupported models should keep system prompt and message history", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      system: "SYSTEM",
      messages: [
        { role: "user", content: "first user" },
        { role: "assistant", content: "first assistant" },
        { role: "user", content: "latest user" }
      ],
      tools: [createToolDefinition(4000)]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.deepStrictEqual(callArg.messages.map((message) => message.role), [
      "user",
      "assistant",
      "user"
    ]);
    assert.strictEqual(callArg.messages[0].content, "first user");
    assert.strictEqual(callArg.messages[1].content, "first assistant");
    assert.strictEqual(callArg.messages[2].content, "latest user");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(callArg, "tools"), false);
  });

  it("service config should use configured maxTokens for both output and context window", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"], { maxContextTokens: undefined }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const mergedConfig = await client._getConfigAsync();
    assert.strictEqual(mergedConfig.maxTokens, 4096);
    assert.strictEqual(mergedConfig.maxContextTokens, undefined);

    await client.chat({
      messages: [
        { role: "user", content: "history-1" },
        { role: "assistant", content: "history-2" },
        { role: "user", content: "latest" }
      ]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(callArg.messages.length, 3);
    assert.strictEqual(callArg.messages[0].content, "history-1");
    assert.strictEqual(callArg.messages[1].content, "history-2");
    assert.strictEqual(callArg.messages[2].content, "latest");
  });

  it("should keep history when configured maxTokens equals context window and system prompt is long", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text"], { maxTokens: 12000, maxContextTokens: undefined }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      system: "S".repeat(5000),
      messages: [
        { role: "user", content: "第一句用户消息" },
        { role: "assistant", content: "第一句助手回复" },
        { role: "user", content: "第二句用户消息" }
      ]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.deepStrictEqual(callArg.messages.map((message) => message.role), [
      "user",
      "assistant",
      "user"
    ]);
    assert.strictEqual(callArg.messages[0].content, "第一句用户消息");
    assert.strictEqual(callArg.messages[1].content, "第一句助手回复");
    assert.strictEqual(callArg.messages[2].content, "第二句用户消息");
  });

  it("should expose reasoning_content from reasoningText", async () => {
    generateTextImpl = () =>
      Promise.resolve({
        text: "final answer",
        reasoningText: "independent reasoning",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: []
      });

    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.strictEqual(result.content, "final answer");
    assert.strictEqual(result.reasoning_content, "independent reasoning");
  });

  it("should extract reasoning_content from think tags in text", async () => {
    generateTextImpl = () =>
      Promise.resolve({
        text: "<think>hidden reasoning</think>\nfinal answer",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: []
      });

    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.strictEqual(result.content, "final answer");
    assert.strictEqual(result.reasoning_content, "hidden reasoning");
  });

  it("should normalize inputTokens/outputTokens usage fields", async () => {
    generateTextImpl = () =>
      Promise.resolve({
        text: "final answer",
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
        toolCalls: []
      });

    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const result = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    assert.deepStrictEqual(result._usage, {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
      cachedInputTokens: 0
    });
  });

  it("should continue deleting leading non-user records until the first non-system message becomes user", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const messages = [
      { role: "user", content: "earliest user context ".repeat(30) },
      createAssistantToolCallMessage(["old_a", "old_b"], "assistant with two tool calls"),
      createToolResultMessage("old_a", "a".repeat(700)),
      createToolResultMessage("old_b", "b".repeat(700)),
      { role: "user", content: "keep latest plain user" },
    ];

    const expectedRemainingMessages = [
      messages[1],
      messages[3],
      messages[4]
    ];
    const expectedRemainingTokens = expectedRemainingMessages.reduce(
      (total, message) => total + client._truncationService.estimateMessageTokens(message),
      0
    );
    const availableTokensForNonSystem = expectedRemainingTokens + 20;
    const maxTokens = Math.ceil(availableTokensForNonSystem / 0.9);

    const { messages: truncated, stats } = client._truncationService.truncateMessagesForContextWindow(messages, maxTokens);

    assert.deepStrictEqual(truncated.map((message) => message.role), [
      "user"
    ]);
    assert.strictEqual(truncated[0].content, "keep latest plain user");
    assert.strictEqual(stats.droppedRecordCount, 2);
    assert.strictEqual(stats.droppedToolPairCount, 1);
    assert.strictEqual(stats.keptNonSystem, 1);
  });

  it("should delete the assistant record after all its tool pairs are removed", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const messages = [
      createAssistantToolCallMessage(["old_only"], "assistant that should disappear"),
      createToolResultMessage("old_only", "x".repeat(900)),
      { role: "user", content: "latest surviving user" }
    ];

    const latestUserTokens = client._truncationService.estimateMessageTokens(messages[2]);
    const availableTokensForNonSystem = latestUserTokens + 20;
    const maxTokens = Math.ceil(availableTokensForNonSystem / 0.9);

    const { messages: truncated, stats } = client._truncationService.truncateMessagesForContextWindow(messages, maxTokens);

    assert.deepStrictEqual(truncated.map((message) => message.role), [
      "user"
    ]);
    assert.strictEqual(truncated[0].content, "latest surviving user");
    assert.strictEqual(stats.droppedRecordCount, 1);
    assert.strictEqual(stats.droppedToolPairCount, 1);
  });

  it("should drop the remaining assistant/tool record when no leading user can be preserved", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const messages = [
      createAssistantToolCallMessage(["first_pair", "last_pair"], "last remaining assistant"),
      createToolResultMessage("first_pair", "f".repeat(700)),
      createToolResultMessage("last_pair", "l".repeat(700))
    ];

    const lastPairTokens = client._truncationService.estimateMessageTokens(messages[2]);
    const lastAssistantTokens = client._truncationService.estimateMessageTokens({
      ...messages[0],
      tool_calls: [messages[0].tool_calls[1]]
    });
    const availableTokensForNonSystem = lastAssistantTokens + lastPairTokens + 20;
    const maxTokens = Math.ceil(availableTokensForNonSystem / 0.9);

    const { messages: truncated, stats } = client._truncationService.truncateMessagesForContextWindow(messages, maxTokens);

    assert.deepStrictEqual(truncated.map((message) => message.role), [
      "assistant",
      "tool"
    ]);
    assert.strictEqual(truncated[0].tool_calls.length, 1);
    assert.strictEqual(truncated[0].tool_calls[0]?.id, "last_pair");
    assert.strictEqual(truncated[1].tool_call_id, "last_pair");
    assert.strictEqual(stats.droppedRecordCount, 1);
    assert.strictEqual(stats.droppedToolPairCount, 1);
    assert.strictEqual(stats.forcedKeepLatestRecord, true);
    assert.strictEqual(stats.recoveredFallbackRecord, true);
    assert.strictEqual(stats.recoveredFallbackRole, "assistant");
  });

  it("should recover the latest user record when truncation would otherwise leave only assistant/tool messages", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const messages = [
      { role: "user", content: "latest user request ".repeat(90) },
      createAssistantToolCallMessage(["first_pair", "last_pair"], "assistant follow-up"),
      createToolResultMessage("first_pair", "f".repeat(700)),
      createToolResultMessage("last_pair", "l".repeat(700))
    ];

    const lastAssistantTokens = client._truncationService.estimateMessageTokens({
      ...messages[1],
      tool_calls: [messages[1].tool_calls[1]]
    });
    const lastPairTokens = client._truncationService.estimateMessageTokens(messages[3]);
    const availableTokensForNonSystem = lastAssistantTokens + lastPairTokens + 20;
    const maxTokens = Math.ceil(availableTokensForNonSystem / 0.9);

    const { messages: truncated, stats } = client._truncationService.truncateMessagesForContextWindow(messages, maxTokens);

    assert.deepStrictEqual(truncated.map((message) => message.role), [
      "user"
    ]);
    assert.strictEqual(truncated[0].content, messages[0].content);
    assert.strictEqual(stats.forcedKeepLatestRecord, true);
    assert.strictEqual(stats.recoveredFallbackRecord, true);
    assert.strictEqual(stats.recoveredFallbackRole, "user");
  });

  it("should attach an internal augmentation header when prior assistant tool calls carry reasoning_content", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [
        { role: "user", content: "hello" },
        createAssistantToolCallMessage(["call_1"], "", "先查看模板再决定创建岗位"),
        createToolResultMessage("call_1", "{\"ok\":true}")
      ]
    });

    const callArg = mockGenerateText.mock.calls[mockGenerateText.mock.callCount() - 1].arguments[0];
    assert.strictEqual(typeof callArg.headers["x-agent-society-request-augmentation-id"], "string");
  });

  it("should keep normal requests unchanged when assistant tool calls do not carry reasoning_content", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [
        { role: "user", content: "hello" },
        createAssistantToolCallMessage(["call_1"]),
        createToolResultMessage("call_1", "{\"ok\":true}")
      ]
    });

    const callArg = mockGenerateText.mock.calls[mockGenerateText.mock.callCount() - 1].arguments[0];
    assert.strictEqual(Object.prototype.hasOwnProperty.call(callArg, "headers"), false);
  });

  it("should backfill reasoning_content into assistant tool-call request messages by tool_call id", () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const augmentation = client._augmentService.buildAssistantToolReasoningAugmentation([
      createAssistantToolCallMessage(["call_1"], "", "先查看模板再决定创建岗位")
    ]);

    const body = client._augmentService.injectAssistantToolReasoningIntoRequestBody(
      "http://127.0.0.1:1234/v1/chat/completions",
      JSON.stringify({
        model: "test-x",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "list_org_template_infos",
                arguments: "{}"
              }
            }]
          },
          { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
        ]
      }),
      augmentation
    );

    assert.strictEqual(JSON.parse(body).messages[1].reasoning_content, "先查看模板再决定创建岗位");
  });

  it("should inject configured stream flag into generation request body", () => {
    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    const body = client._augmentService.injectConfiguredStreamIntoRequestBody(
      "http://127.0.0.1:1234/v1/chat/completions",
      JSON.stringify({ model: "test-x", messages: [{ role: "user", content: "hello" }] }),
      { stream: false }
    );

    assert.strictEqual(JSON.parse(body).stream, false);
  });

  it("should not include reasoning in formatted messages for assistant without tool_calls", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [
        { role: "user", content: "hello" },
        // 无 tool_calls，但有 reasoning_content → 旧逻辑会携带 reasoning，新逻辑不应携带
        { role: "assistant", content: "final answer", reasoning_content: "hidden thinking" },
        { role: "user", content: "thanks" }
      ]
    });

    const callArg = mockGenerateText.mock.calls[mockGenerateText.mock.callCount() - 1].arguments[0];
    // assistant 无 tool_calls → content 应为纯字符串，不做数组化（表示无 reasoning）
    const assistMsg = callArg.messages[1];
    assert.strictEqual(assistMsg.role, "assistant");
    assert.strictEqual(typeof assistMsg.content, "string", "content should be plain string, not array");
    assert.strictEqual(assistMsg.content, "final answer");
  });

  it("should include reasoning in formatted messages for assistant with tool_calls", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [
        { role: "user", content: "hello" },
        createAssistantToolCallMessage(["call_1"], "", "先查看模板"),
        createToolResultMessage("call_1", "{\"ok\":true}")
      ]
    });

    const callArg = mockGenerateText.mock.calls[mockGenerateText.mock.callCount() - 1].arguments[0];
    // 有 tool_calls 的 assistant 应携带 reasoning
    const assistMsg = callArg.messages[1];
    assert.strictEqual(assistMsg.role, "assistant");
    assert.ok(Array.isArray(assistMsg.content), "content should be array with reasoning + tool-call parts");
    const reasoningParts = assistMsg.content.filter(p => p.type === "reasoning");
    assert.strictEqual(reasoningParts.length, 1);
    assert.strictEqual(reasoningParts[0].text, "先查看模板");
  });

  it("should preserve all messages in mixed reasoning state instead of stripping", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    await client.chat({
      messages: [
        { role: "user", content: "hello" },
        // 无 tool_calls、无 reasoning 的 plain assistant — 旧代码 stripMissingReasoningMessages 会删除整条
        { role: "assistant", content: "plain reply" },
        // 有 tool_calls、有 reasoning — 造成混合状态，触发旧代码的删除逻辑
        createAssistantToolCallMessage(["call_1"], "", "let me search"),
        createToolResultMessage("call_1", "{\"ok\":true}"),
        // 另一个无 tool_calls 的 plain assistant
        { role: "assistant", content: "done" },
        { role: "user", content: "thanks" }
      ]
    });

    const callArg = mockGenerateText.mock.calls[mockGenerateText.mock.callCount() - 1].arguments[0];
    // 旧逻辑会删除无 reasoning 的 assistant → 输出只有 4 条；新逻辑不删除 → 6 条全保留
    assert.strictEqual(callArg.messages.length, 6, "all 6 messages should be preserved (was: stripping dropped 2)");

    // 两条 plain assistant 都应作为纯字符串，不携带 reasoning
    const plain1 = callArg.messages[1];
    assert.strictEqual(plain1.role, "assistant");
    assert.strictEqual(typeof plain1.content, "string");
    assert.strictEqual(plain1.content, "plain reply");

    const plain2 = callArg.messages[4];
    assert.strictEqual(plain2.role, "assistant");
    assert.strictEqual(typeof plain2.content, "string");
    assert.strictEqual(plain2.content, "done");

    // 有 tool_calls 的 assistant 仍携带 reasoning
    const toolAssist = callArg.messages[2];
    assert.strictEqual(toolAssist.role, "assistant");
    assert.ok(Array.isArray(toolAssist.content));
    const reasoningParts = toolAssist.content.filter(p => p.type === "reasoning");
    assert.strictEqual(reasoningParts.length, 1);
    assert.strictEqual(reasoningParts[0].text, "let me search");
  });

  it("stream config changes should trigger client rebuild", () => {
    const client = new LlmClient({
      configService: createConfigService(["text"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient")
    });

    client._clientConfig = {
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "k",
      model: "test-x",
      provider: "openai",
      timeout: 1800000,
      stream: true,
      id: "test-model"
    };

    assert.strictEqual(client._needsClientUpdate({
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "k",
      model: "test-x",
      provider: "openai",
      timeout: 1800000,
      stream: false,
      id: "test-model"
    }), true);
  });

  /**
   * 结构性防护：所有 tool_gate 测试的消息都必须通过真实 ai-sdk schema 校验。
   * 不 mock schema，不 mock validator — 用 modelMessageSchema.parse() 直接验证。
   */
  it("工具调用消息（含 tool-call + tool-result）必须通过真实 ai-sdk schema 校验", async () => {
    const client = new LlmClient({
      configService: createConfigService(["text", "tool_calling"]),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.tool_gate")
    });

    await client.chat({
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: "executing",
          tool_calls: [{ id: "c_schema", type: "function", function: { name: "tool1", arguments: '{"a":1}' } }]
        },
        { role: "tool", tool_call_id: "c_schema", name: "tool1", content: '{"result":"ok"}' }
      ],
      tools: [{ type: "function", function: { name: "tool1", description: "desc", parameters: {} } }]
    });

    const msgs = mockGenerateText.mock.calls[0].arguments[0].messages;
    try {
      await modelMessageSchema.array().parse(msgs);
    } catch (err) {
      const issues = err?.issues ?? [];
      const details = issues.map(i => `  [${(i.path ?? []).join(".")}]: ${i.message}`).join("\n")
        || err?.message || String(err);
      assert.fail(`tool_gate messages fail ai-sdk schema:\n${details}`);
    }
  });
});
