import { describe, it, mock, before, beforeEach } from "node:test";
import assert from "node:assert";
import { makeTestLogger } from "../../../helpers/test_logger.js";
// 顶层导入真实 ai-sdk schema，在 mock.module 之前解析，用于校验消息格式
import { modelMessageSchema } from "ai";

let LlmClient;
let mockGenerateText;

/**
 * Build a mock config service with the specified provider.
 * @param {string} provider - Provider name (anthropic, openai, open-responses, local-llama).
 * @param {object} [overrides] - Extra service config overrides.
 * @returns {{getServices: Function, getLlm: Function}}
 */
function createConfigService(provider, overrides = {}) {
  return {
    getServices: async () => ({
      services: [{
        id: "test-model",
        provider,
        baseURL: "http://127.0.0.1:1234/v1",
        model: "test-x",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000,
        capabilities: {
          input: ["text"],
          output: ["text"]
        },
        // Enable thinking so that providerOptions is constructed (needed for cacheControl to be present)
        thinking: { type: "enabled", budgetTokens: 4000 },
        ...overrides
      }]
    }),
    getLlm: async () => ({
      llm: {
        provider,
        baseURL: "http://127.0.0.1:1234/v1",
        model: "default-model",
        apiKey: "k",
        maxTokens: 4096,
        maxContextTokens: 128000
      }
    })
  };
}

describe("LlmClient prompt caching", () => {
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

  function getAnthropicProviderOptions() {
    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    return callArg.providerOptions?.anthropic ?? null;
  }

  function getCacheControl() {
    const anthropic = getAnthropicProviderOptions();
    return anthropic?.cacheControl ?? null;
  }

  it("Anthropic provider → system SystemModelMessage 包含 cacheControl", async () => {
    const client = new LlmClient({
      configService: createConfigService("anthropic"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ system: "system prompt", messages: [{ role: "user", content: "hello" }] });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    const systemBlocks = callArg.system;
    assert.ok(Array.isArray(systemBlocks) && systemBlocks.length > 0, "system should be a SystemModelMessage array");
    assert.strictEqual(systemBlocks[0]?.role, "system", "must have role: 'system'");
    assert.strictEqual(typeof systemBlocks[0]?.content, "string");
    const cc = systemBlocks[0]?.providerOptions?.anthropic?.cacheControl ?? null;
    assert.deepStrictEqual(cc, { type: "ephemeral" });
  });

  it("非 Anthropic provider (openai) → providerOptions 不包含 cacheControl", async () => {
    const client = new LlmClient({
      configService: createConfigService("openai"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const anthropic = getAnthropicProviderOptions();
    assert.strictEqual(anthropic, null);
  });

  it("非 Anthropic provider (open-responses) → providerOptions 不包含 cacheControl", async () => {
    const client = new LlmClient({
      configService: createConfigService("open-responses"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const anthropic = getAnthropicProviderOptions();
    assert.strictEqual(anthropic, null);
  });

  it("非 Anthropic provider (local-llama) → providerOptions 不包含 cacheControl", async () => {
    const client = new LlmClient({
      configService: createConfigService("local-llama"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ messages: [{ role: "user", content: "hello" }] });

    const anthropic = getAnthropicProviderOptions();
    assert.strictEqual(anthropic, null);
  });

  it("cacheControl 字段结构正确 → 不存在 ttl（使用 SDK 默认 5 分钟）", async () => {
    const client = new LlmClient({
      configService: createConfigService("anthropic"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ system: "system prompt", messages: [{ role: "user", content: "hello" }] });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.strictEqual(callArg.system[0]?.role, "system", "must have role: 'system'");
    assert.strictEqual(typeof callArg.system[0]?.content, "string");
    const cc = callArg.system[0]?.providerOptions?.anthropic?.cacheControl ?? null;
    // Must have type "ephemeral"
    assert.strictEqual(cc.type, "ephemeral");
    // Must NOT have a ttl field (SDK uses default 5 min TTL)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cc, "ttl"), false);
  });

  it("非 Anthropic provider → system 参数仍符合 SystemModelMessage 格式", async () => {
    const client = new LlmClient({
      configService: createConfigService("openai"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ system: "system prompt", messages: [{ role: "user", content: "hello" }] });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(callArg.system), "system format must be the same regardless of provider");
    assert.strictEqual(callArg.system[0]?.role, "system");
    assert.strictEqual(typeof callArg.system[0]?.content, "string");
  });

  it("SystemModelMessage 不应使用旧的内容块格式（type/text）", async () => {
    const client = new LlmClient({
      configService: createConfigService("anthropic"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({ system: "system prompt", messages: [{ role: "user", content: "hello" }] });

    const msg = mockGenerateText.mock.calls[0].arguments[0].system[0];
    assert.strictEqual(msg.role, "system");
    assert.strictEqual(msg.content, "system prompt");
    // 确保旧的内容块格式没有被重新引入：
    assert.strictEqual(msg.type, undefined, "should not have 'type' (old content-block format)");
    assert.strictEqual(msg.text, undefined, "should not have 'text' (old content-block format)");
  });

  /**
   * 结构性防护：所有 provider 的输出都必须通过真实的 ai-sdk schema 校验。
   * 不 mock schema，用 modelMessageSchema.parse() 直接验证。
   */
  it("所有 Anthropic provider 消息必须通过真实 ai-sdk schema 校验", async () => {
    const client = new LlmClient({
      configService: createConfigService("anthropic"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    // 验证真实 schema — 如果 system 格式或消息格式无效，这里直接报错
    try {
      await modelMessageSchema.array().parse(callArg.messages);
    } catch (err) {
      const issues = err?.issues ?? [];
      const details = issues.map(i => `  [${(i.path ?? []).join(".")}]: ${i.message}`).join("\n")
        || err?.message || String(err);
      assert.fail(`cache test messages fail ai-sdk schema:\n${details}`);
    }
  });

  it("所有非 Anthropic provider 消息也必须通过真实 ai-sdk schema 校验", async () => {
    const client = new LlmClient({
      configService: createConfigService("openai"),
      serviceId: "test-model",
      logger: makeTestLogger("LlmClient.cache")
    });

    await client.chat({
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }]
    });

    const callArg = mockGenerateText.mock.calls[0].arguments[0];
    try {
      await modelMessageSchema.array().parse(callArg.messages);
    } catch (err) {
      const issues = err?.issues ?? [];
      const details = issues.map(i => `  [${(i.path ?? []).join(".")}]: ${i.message}`).join("\n")
        || err?.message || String(err);
      assert.fail(`cache test messages fail ai-sdk schema:\n${details}`);
    }
  });
});
