// LlmAugmentService thinking 字段注入的单元测试。
// 覆盖：openai provider + thinking enabled 注入；disabled/无配置不注入；
// 非 openai provider 不注入；非 chat/completions URL 不注入；
// 已有 thinking 字段不覆盖；非法 JSON 回退并记录日志。
import { describe, it } from "node:test";
import assert from "node:assert";
import { LlmAugmentService } from "../../../../src/platform/services/llm/llm_augment_service.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

/**
 * 构造带错误调用记录的 LlmAugmentService 实例。
 * @returns {{service: LlmAugmentService, errorCalls: Array}} 服务与错误日志调用记录
 */
function createService() {
  const errorCalls = [];
  const logger = makeTestLogger("LlmAugmentService.thinking");
  const recordingLogger = {
    ...logger,
    error: (msg, data) => {
      errorCalls.push({ msg, data });
      logger.error(msg, data);
    }
  };
  const service = new LlmAugmentService({
    exchangeState: { augmentations: new Map() },
    resolveStreamFlag: () => false,
    log: recordingLogger
  });
  return { service, errorCalls };
}

describe("LlmAugmentService injectThinkingIntoRequestBody", () => {
  it("openai provider + thinking enabled → 注入 thinking 字段", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.z.ai/api/paas/v4/chat/completions",
      body,
      { provider: "openai", thinking: { type: "enabled", effort: "high" } }
    );
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed.thinking, { type: "enabled" });
    assert.strictEqual(parsed.model, "glm-5.3");
    assert.strictEqual(parsed.messages.length, 1);
  });

  it("provider 缺省视为 openai → 注入 thinking 字段", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "glm-5.3", messages: [] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.z.ai/api/paas/v4/chat/completions",
      body,
      { thinking: { type: "enabled" } }
    );
    assert.deepStrictEqual(JSON.parse(result).thinking, { type: "enabled" });
  });

  it("thinking disabled → 不注入", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.openai.com/v1/chat/completions",
      body,
      { provider: "openai", thinking: { type: "disabled" } }
    );
    assert.strictEqual(JSON.parse(result).thinking, undefined);
  });

  it("无 thinking 配置 → 不注入", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.openai.com/v1/chat/completions",
      body,
      { provider: "openai" }
    );
    assert.strictEqual(JSON.parse(result).thinking, undefined);
  });

  it("anthropic provider → 不注入", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "claude-x", messages: [] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.anthropic.com/v1/messages",
      body,
      { provider: "anthropic", thinking: { type: "enabled" } }
    );
    assert.strictEqual(JSON.parse(result).thinking, undefined);
  });

  it("Responses API URL → 不注入", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.openai.com/v1/responses",
      body,
      { provider: "openai", thinking: { type: "enabled" } }
    );
    assert.strictEqual(JSON.parse(result).thinking, undefined);
  });

  it("请求体已有 thinking 字段 → 不覆盖", () => {
    const { service } = createService();
    const body = JSON.stringify({ model: "glm-5.3", messages: [], thinking: { type: "disabled" } });
    const result = service.injectThinkingIntoRequestBody(
      "https://api.z.ai/api/paas/v4/chat/completions",
      body,
      { provider: "openai", thinking: { type: "enabled" } }
    );
    assert.deepStrictEqual(JSON.parse(result).thinking, { type: "disabled" });
  });

  it("非法 JSON 请求体 → 原样返回并记录错误日志", () => {
    const { service, errorCalls } = createService();
    const body = "{not-json";
    const result = service.injectThinkingIntoRequestBody(
      "https://api.z.ai/api/paas/v4/chat/completions",
      body,
      { provider: "openai", thinking: { type: "enabled" } }
    );
    assert.strictEqual(result, body);
    // 铁律：异常必须记录日志，不能静默吞掉
    assert.ok(errorCalls.length > 0, "必须记录错误日志");
  });

  it("请求体为空 → 原样返回", () => {
    const { service } = createService();
    assert.strictEqual(
      service.injectThinkingIntoRequestBody("https://api.z.ai/api/paas/v4/chat/completions", null, {
        provider: "openai",
        thinking: { type: "enabled" }
      }),
      null
    );
    assert.strictEqual(
      service.injectThinkingIntoRequestBody("https://api.z.ai/api/paas/v4/chat/completions", "", {
        provider: "openai",
        thinking: { type: "enabled" }
      }),
      ""
    );
  });
});
