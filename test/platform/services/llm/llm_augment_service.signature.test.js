// LlmAugmentService repairThinkingSignatureInResponseBody 的单元测试。
// 覆盖：缺 signature 的 thinking 块补占位；已有 signature 不动；
// 非 thinking 块不动；非 /messages URL 不修补；空体/非 JSON 体回退并记录日志；
// 无 content 数组不修补；混合内容只补缺失项。
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
  const logger = makeTestLogger("LlmAugmentService.signature");
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

describe("LlmAugmentService repairThinkingSignatureInResponseBody", () => {
  it("缺 signature 的 thinking 块 → 补占位签名", () => {
    const { service } = createService();
    // 真实故障样例：glm-5.3-flash 经 ccswitch 代理返回的 thinking 块只有 type/thinking
    const body = JSON.stringify({
      type: "message",
      id: "msg_001",
      model: "glm-5.3-flash",
      content: [
        { type: "thinking", thinking: "用户想让我修复 bug" },
        { type: "text", text: "好的，我来修。" }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    });
    const result = service.repairThinkingSignatureInResponseBody(
      "http://127.0.0.1:15721/v1/messages",
      body
    );
    assert.strictEqual(result.repairedCount, 1);
    const parsed = JSON.parse(result.body);
    assert.strictEqual(parsed.content[0].signature, "placeholder:missing-from-provider");
    // 其他字段不被改动
    assert.strictEqual(parsed.content[0].thinking, "用户想让我修复 bug");
    assert.strictEqual(parsed.content[1].text, "好的，我来修。");
    assert.strictEqual(parsed.model, "glm-5.3-flash");
  });

  it("已有 signature 的 thinking 块 → 不覆盖", () => {
    const { service } = createService();
    const body = JSON.stringify({
      content: [{ type: "thinking", thinking: "x", signature: "sig-abc" }]
    });
    const result = service.repairThinkingSignatureInResponseBody(
      "http://127.0.0.1:15721/v1/messages",
      body
    );
    assert.strictEqual(result.repairedCount, 0);
    assert.strictEqual(result.body, body);
    assert.strictEqual(JSON.parse(result.body).content[0].signature, "sig-abc");
  });

  it("混合内容 → 只补缺失项", () => {
    const { service } = createService();
    const body = JSON.stringify({
      content: [
        { type: "thinking", thinking: "a", signature: "sig-1" },
        { type: "thinking", thinking: "b" },
        { type: "tool_use", id: "t1", name: "run", input: {} },
        { type: "thinking", thinking: "c" }
      ]
    });
    const result = service.repairThinkingSignatureInResponseBody(
      "http://127.0.0.1:15721/v1/messages",
      body
    );
    assert.strictEqual(result.repairedCount, 2);
    const parsed = JSON.parse(result.body);
    assert.strictEqual(parsed.content[0].signature, "sig-1");
    assert.strictEqual(typeof parsed.content[1].signature, "string");
    assert.strictEqual(typeof parsed.content[3].signature, "string");
  });

  it("非 /messages URL → 不修补", () => {
    const { service } = createService();
    const body = JSON.stringify({
      content: [{ type: "thinking", thinking: "a" }]
    });
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/completions"
    ]) {
      const result = service.repairThinkingSignatureInResponseBody(url, body);
      assert.strictEqual(result.repairedCount, 0, `URL ${url} 不应修补`);
      assert.strictEqual(result.body, body);
    }
  });

  it("带查询串的 /messages URL → 修补", () => {
    const { service } = createService();
    const body = JSON.stringify({
      content: [{ type: "thinking", thinking: "a" }]
    });
    const result = service.repairThinkingSignatureInResponseBody(
      "http://127.0.0.1:15721/v1/messages?beta=true",
      body
    );
    assert.strictEqual(result.repairedCount, 1);
  });

  it("空响应体 → 原样返回", () => {
    const { service } = createService();
    assert.strictEqual(
      service.repairThinkingSignatureInResponseBody("http://x/v1/messages", "").repairedCount,
      0
    );
    assert.strictEqual(
      service.repairThinkingSignatureInResponseBody("http://x/v1/messages", null).repairedCount,
      0
    );
  });

  it("非法 JSON 响应体 → 回退并记录错误日志", () => {
    const { service, errorCalls } = createService();
    const body = "<html>gateway error</html>";
    const result = service.repairThinkingSignatureInResponseBody("http://x/v1/messages", body);
    assert.strictEqual(result.repairedCount, 0);
    assert.strictEqual(result.body, body);
    // 铁律：异常必须记录日志，不能静默吞掉
    assert.ok(errorCalls.length > 0, "必须记录错误日志");
    assert.ok(errorCalls[0].data.responseBodyPreview.includes("gateway error"));
  });

  it("JSON 无 content 数组 → 不修补", () => {
    const { service } = createService();
    const body = JSON.stringify({ error: { type: "overloaded" } });
    const result = service.repairThinkingSignatureInResponseBody("http://x/v1/messages", body);
    assert.strictEqual(result.repairedCount, 0);
    assert.strictEqual(result.body, body);
  });

  it("content 中 thinking 字段非字符串 → 不修补该块", () => {
    const { service } = createService();
    const body = JSON.stringify({
      content: [{ type: "thinking", thinking: 123 }]
    });
    const result = service.repairThinkingSignatureInResponseBody("http://x/v1/messages", body);
    assert.strictEqual(result.repairedCount, 0);
    assert.strictEqual(result.body, body);
  });
});
