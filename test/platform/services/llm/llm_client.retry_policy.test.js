import { describe, it } from "node:test";
import assert from "node:assert";
import { LlmClient } from "../../../../src/platform/services/llm/llm_client.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

describe("LlmClient retry policy", () => {
  it("empty response wrapped as AbortError should still retry", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const emptyError = new Error("LLM service returned empty response body");
    emptyError.name = "EmptyResponseBodyError";
    emptyError.code = "LLM_EMPTY_RESPONSE_BODY";

    const wrappedAbort = new Error("wrapped");
    wrappedAbort.name = "AbortError";
    wrappedAbort.cause = emptyError;

    const shouldAbort = client._retryService.shouldTreatAsAbortError(wrappedAbort, null);
    assert.strictEqual(shouldAbort, false);
  });

  it("real abort signal should stop retry", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const abortController = new AbortController();
    abortController.abort();

    const err = new Error("aborted");
    err.name = "AbortError";

    const shouldAbort = client._retryService.shouldTreatAsAbortError(err, abortController.signal);
    assert.strictEqual(shouldAbort, true);
  });

  it("empty response retry should add harmless whitespace variance", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const emptyError = new Error("LLM service returned empty response body");
    emptyError.name = "EmptyResponseBodyError";
    emptyError.code = "LLM_EMPTY_RESPONSE_BODY";
    const messages = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "请总结这段内容" }
    ];
    const variance = client._retryService.buildRetryVarianceForEmptyResponse(1, emptyError, messages);
    assert.notStrictEqual(variance, null);
    assert.strictEqual(variance.reason, "empty_response_body");
    assert.strictEqual(variance.messages[1].content, "请总结这段内容 ");
  });

  it("non-empty-response errors should not add retry variance", () => {
    const client = new LlmClient({ logger: makeTestLogger("LlmClient") });
    const otherError = new Error("network timeout");
    otherError.name = "TimeoutError";
    const messages = [{ role: "user", content: "hello" }];
    const variance = client._retryService.buildRetryVarianceForEmptyResponse(1, otherError, messages);
    assert.strictEqual(variance, null);
  });
});
