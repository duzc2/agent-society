import { describe, it } from "node:test";
import assert from "node:assert";
import { LlmResponseService } from "../../../../src/platform/services/llm/llm_response_service.js";

const svc = new LlmResponseService();

describe("LlmResponseService.normalizeUsage", () => {
  it("标准对象 → { promptTokens, completionTokens, totalTokens, cachedInputTokens: 0 }", () => {
    const result = svc.normalizeUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });
    assert.deepStrictEqual(result, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 0
    });
  });

  it("inputTokens 嵌套结构 → promptTokens 从 inputTokens.total 提取，cachedInputTokens 正确", () => {
    const result = svc.normalizeUsage({
      inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 },
      outputTokens: 30,
      totalTokens: 130
    });
    assert.strictEqual(result.promptTokens, 100);
    assert.strictEqual(result.completionTokens, 30);
    assert.strictEqual(result.totalTokens, 130);
    assert.strictEqual(result.cachedInputTokens, 60); // 50 + 10
  });

  it("inputTokens 嵌套结构只有 cacheRead → cachedInputTokens = cacheRead", () => {
    const result = svc.normalizeUsage({
      inputTokens: { total: 200, cacheRead: 50 },
      outputTokens: 40,
      totalTokens: 240
    });
    assert.strictEqual(result.promptTokens, 200);
    assert.strictEqual(result.cachedInputTokens, 50);
  });

  it("inputTokens 嵌套结构只有 cacheWrite → cachedInputTokens = cacheWrite", () => {
    const result = svc.normalizeUsage({
      inputTokens: { total: 200, cacheWrite: 30 },
      outputTokens: 40,
      totalTokens: 240
    });
    assert.strictEqual(result.promptTokens, 200);
    assert.strictEqual(result.cachedInputTokens, 30);
  });

  it("snake_case 兼容 → input_tokens / output_tokens / prompt_tokens / completion_tokens / total_tokens", () => {
    const result = svc.normalizeUsage({
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30
    });
    assert.deepStrictEqual(result, {
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      cachedInputTokens: 0
    });
  });

  it("undefined / null → 全部返回 0", () => {
    const resultUndef = svc.normalizeUsage(undefined);
    assert.deepStrictEqual(resultUndef, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0
    });

    const resultNull = svc.normalizeUsage(null);
    assert.deepStrictEqual(resultNull, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0
    });
  });

  it("非对象类型（string、number）→ 全部返回 0", () => {
    const resultStr = svc.normalizeUsage("not an object");
    assert.deepStrictEqual(resultStr, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0
    });

    const resultNum = svc.normalizeUsage(42);
    assert.deepStrictEqual(resultNum, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0
    });
  });

  it("非有限数值（NaN、Infinity）→ 强制为 0", () => {
    const result = svc.normalizeUsage({
      promptTokens: NaN,
      completionTokens: Infinity,
      totalTokens: NaN
    });
    assert.deepStrictEqual(result, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0
    });
  });

  it("部分字段缺失 → 缺失字段为 0，现有字段正常", () => {
    const result = svc.normalizeUsage({
      promptTokens: 10
      // completionTokens and totalTokens missing
    });
    assert.strictEqual(result.promptTokens, 10);
    assert.strictEqual(result.completionTokens, 0);
    // totalTokens should be computed from prompt + completion
    assert.strictEqual(result.totalTokens, 10);
    assert.strictEqual(result.cachedInputTokens, 0);
  });

  it("inputTokens 为数字（非嵌套对象）→ promptTokens 正常，cachedInputTokens 为 0", () => {
    const result = svc.normalizeUsage({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60
    });
    assert.strictEqual(result.promptTokens, 50);
    assert.strictEqual(result.completionTokens, 10);
    assert.strictEqual(result.totalTokens, 60);
    assert.strictEqual(result.cachedInputTokens, 0);
  });

  it("snake_case 嵌套 input_tokens → cachedInputTokens 提取", () => {
    const result = svc.normalizeUsage({
      input_tokens: { total: 300, cache_read: 80, cache_write: 20 },
      output_tokens: 50,
      total_tokens: 350
    });
    assert.strictEqual(result.promptTokens, 300);
    assert.strictEqual(result.completionTokens, 50);
    assert.strictEqual(result.totalTokens, 350);
    assert.strictEqual(result.cachedInputTokens, 100);
  });

  it("cacheRead/cacheWrite 为 NaN → 强制为 0", () => {
    const result = svc.normalizeUsage({
      inputTokens: { total: 100, cacheRead: NaN, cacheWrite: Infinity },
      outputTokens: 20,
      totalTokens: 120
    });
    assert.strictEqual(result.promptTokens, 100);
    assert.strictEqual(result.cachedInputTokens, 0);
  });
});
