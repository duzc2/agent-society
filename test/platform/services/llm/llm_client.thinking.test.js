import { describe, it, mock, before, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../../../helpers/test_logger.js";
import { assertValidMessages } from "../../../helpers/schema_validator.js";

let LlmClient;
let mockGenerateText;

/**
 * Build a mock config service with the specified thinking config.
 * @param {object|null} thinking - thinking config to merge into the service.
 * @param {object} [overrides] - Extra service config overrides.
 * @returns {{getServices: Function, getLlm: Function}}
 */
function createConfigService(thinking, overrides = {}) {
  return {
    getServices: async () => ({
      services: [{
        id: "test-model",
        provider: "anthropic",
        baseURL: "http://127.0.0.1:1234/v1",
        model: "test-x",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000,
        capabilities: {
          input: ["text"],
          output: ["text"]
        },
        ...(thinking ? { thinking } : {}),
        ...overrides
      }]
    }),
    getLlm: async () => ({
      llm: {
        provider: "anthropic",
        baseURL: "http://127.0.0.1:1234/v1",
        model: "default-model",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000
      }
    })
  };
}

describe("LlmClient thinking budget", () => {
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

    const mod = await import("../../../../src/platform/services/llm/llm_client.js");
    LlmClient = mod.LlmClient;
  });

  beforeEach(() => {
    mockGenerateText.mock.resetCalls();
  });

  function getAnthropicThinking() {
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    return callArg.providerOptions?.anthropic?.thinking ?? null;
  }

  function getAnthropicProviderOptions() {
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    return callArg.providerOptions?.anthropic ?? null;
  }

  function getOpenAiProviderOptions() {
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    return callArg.providerOptions?.openai ?? null;
  }

  function getProviderOptions() {
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    return callArg.providerOptions ?? null;
  }

  it("thinking type=enabled + budgetTokens=4000 → 正确传递", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled", budgetTokens: 4000 }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.deepStrictEqual(thinking, { type: "enabled", budgetTokens: 4000 });
  });

  it("thinking type=enabled + budgetTokens 缺失 → 自动填入 budgetTokens: 16000", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.deepStrictEqual(thinking, { type: "enabled", budgetTokens: 16000 });
  });

  it("thinking type=enabled + budgetTokens=0 → 自动填入 budgetTokens: 16000", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled", budgetTokens: 0 }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.deepStrictEqual(thinking, { type: "enabled", budgetTokens: 16000 });
  });

  it("thinking type=enabled + budgetTokens=500 (< 1024) → 自动填入 budgetTokens: 16000", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled", budgetTokens: 500 }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.deepStrictEqual(thinking, { type: "enabled", budgetTokens: 16000 });
  });

  it("thinking type=disabled → providerOptions 不包含 thinking 或 anthropic 块不存在", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "disabled" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const anthropic = getAnthropicProviderOptions();
    assert.strictEqual(anthropic, null);
  });

  it("thinking type=adaptive → 原样传递（不走默认值逻辑）", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "adaptive" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    // adaptive type passes through as-is (it is not "enabled", so the default logic doesn't kick in)
    assert.deepStrictEqual(thinking, { type: "adaptive" });
  });

  it("thinking 对象为 undefined → providerOptions 不包含 thinking", async () => {
    const client = new LlmClient({
      configService: createConfigService(null),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const providerOptions = getProviderOptions();
    assert.strictEqual(providerOptions, null);
  });

  it("非 Anthropic provider (openai) → providerOptions 走 reasoningEffort 路径", async () => {
    const configService = {
      getServices: async () => ({
        services: [{
          id: "test-model",
          provider: "openai",
          baseURL: "http://127.0.0.1:1234/v1",
          model: "test-x",
          apiKey: "k",
          maxTokens: 4096,
          maxContextTokens: 128000,
          capabilities: { input: ["text"], output: ["text"] },
          thinking: { type: "enabled", budgetTokens: 4000 }
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

    const client = new LlmClient({
      configService,
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const openai = getOpenAiProviderOptions();
    assert.deepStrictEqual(openai, {
      reasoningEffort: "medium",
      maxReasoningTokens: 4000
    });
  });

  it("openai provider + thinking.effort=high → reasoningEffort 传递配置值", async () => {
    // z.ai glm 系列只接受 low/high/max，写死 medium 会触发错误 1210
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled", effort: "high" }, { provider: "openai" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const openai = getOpenAiProviderOptions();
    assert.deepStrictEqual(openai, { reasoningEffort: "high" });
  });

  it("openai provider + thinking 无 effort → reasoningEffort 回退 medium", async () => {
    // 兼容 OpenAI 官方 API：未配置 effort 时保持原有 medium 行为
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled" }, { provider: "openai" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const openai = getOpenAiProviderOptions();
    assert.deepStrictEqual(openai, { reasoningEffort: "medium" });
  });

  it("UI 用户只设置 type=enabled 不填 budgetTokens → 预算为 16000", async () => {    // Simulates a user who toggles thinking in the UI and leaves the budget field blank,
    // resulting in the thinking config being { type: "enabled" } without budgetTokens.
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled" }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.strictEqual(thinking.type, "enabled");
    assert.strictEqual(thinking.budgetTokens, 16000);
  });

  it("UI 用户设置 budgetTokens=8000 → 原样传递，不被覆盖", async () => {
    const client = new LlmClient({
      configService: createConfigService({ type: "enabled", budgetTokens: 8000 }),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.thinking")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const thinking = getAnthropicThinking();
    assert.strictEqual(thinking.type, "enabled");
    assert.strictEqual(thinking.budgetTokens, 8000);
  });

  // ==================== schema 校验 ====================
  // 验证 thinking 配置下 chat() 产出的消息格式通过真实 ai-sdk schema

  describe("schema 校验", () => {
    it("thinking type=enabled + budgetTokens → 消息格式通过 ai-sdk schema", async () => {
      const client = new LlmClient({
        configService: createConfigService({ type: "enabled", budgetTokens: 4000 }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient.thinking")
      });

      await client.chat({ messages: [{ role: "user", content: "hello" }] });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "thinking enabled+budget messages");
    });

    it("thinking type=disabled → 消息格式通过 ai-sdk schema", async () => {
      const client = new LlmClient({
        configService: createConfigService({ type: "disabled" }),
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient.thinking")
      });

      await client.chat({ messages: [{ role: "user", content: "hello" }] });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "thinking disabled messages");
    });

    it("openai provider + thinking → 消息格式通过 ai-sdk schema", async () => {
      const configService = {
        getServices: async () => ({
          services: [{
            id: "test-model",
            provider: "openai",
            baseURL: "http://127.0.0.1:1234/v1",
            model: "test-x",
            apiKey: "k",
            maxTokens: 4096,
            maxContextTokens: 128000,
            capabilities: { input: ["text"], output: ["text"] },
            thinking: { type: "enabled", budgetTokens: 4000 }
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

      const client = new LlmClient({
        configService,
        serviceId: "test-model",
        logger: makeTestLogger("LlmClient.thinking")
      });

      await client.chat({ messages: [{ role: "user", content: "hello" }] });

      const callArg = mockGenerateText.mock.calls[0].arguments[0];
      await assertValidMessages(callArg.messages, "openai thinking messages");
    });
  });
});
