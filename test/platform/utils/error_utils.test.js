/**
 * error_utils 测试
 *
 * 覆盖 extractProviderErrorMessage 对各类 LLM 供应商错误响应体的提取逻辑，
 * 确保错误事件能向用户展示真实原因，而不是通用的 "HTTP 400 Bad Request"。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { extractProviderErrorMessage } from "../../../src/platform/utils/error_utils.js";

describe("extractProviderErrorMessage", () => {
  it("应提取 OpenAI 风格 error.message（deepseek 400 场景）", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify({
      error: {
        message: "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed dee.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error"
      }
    });

    assert.strictEqual(
      extractProviderErrorMessage(err),
      "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed dee."
    );
  });

  it("应提取 error 为字符串的响应体", () => {
    const err = new Error("HTTP 500 Internal Server Error");
    err.responseBody = JSON.stringify({ error: "server_error" });

    assert.strictEqual(extractProviderErrorMessage(err), "server_error");
  });

  it("应提取顶层 message 字段", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify({ message: "custom provider reason" });

    assert.strictEqual(extractProviderErrorMessage(err), "custom provider reason");
  });

  it("应支持从 err.response.body 提取（响应对象形态）", () => {
    const err = new Error("HTTP 429 Too Many Requests");
    err.response = {
      body: JSON.stringify({ error: { message: "rate limit exceeded" } })
    };

    assert.strictEqual(extractProviderErrorMessage(err), "rate limit exceeded");
  });

  it("responseBody 不是 JSON 时应返回 null", () => {
    const err = new Error("HTTP 502 Bad Gateway");
    err.responseBody = "<html>gateway timeout</html>";

    assert.strictEqual(extractProviderErrorMessage(err), null);
  });

  it("无 responseBody 时应返回 null（保留原始 message）", () => {
    const err = new Error("HTTP 400 Bad Request");
    assert.strictEqual(extractProviderErrorMessage(err), null);
  });

  it("responseBody 为空字符串时应返回 null", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = "   ";
    assert.strictEqual(extractProviderErrorMessage(err), null);
  });

  it("响应体为 JSON 数组时应返回 null", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify([{ message: "not an error object" }]);
    assert.strictEqual(extractProviderErrorMessage(err), null);
  });

  it("响应体没有可读错误字段时应返回 null", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify({ status: "failed" });
    assert.strictEqual(extractProviderErrorMessage(err), null);
  });

  it("传入 null / undefined 时应返回 null", () => {
    assert.strictEqual(extractProviderErrorMessage(null), null);
    assert.strictEqual(extractProviderErrorMessage(undefined), null);
  });

  it("应 trim 提取到的原因", () => {
    const err = new Error("HTTP 400 Bad Request");
    err.responseBody = JSON.stringify({ message: "  padded reason  " });
    assert.strictEqual(extractProviderErrorMessage(err), "padded reason");
  });
});
