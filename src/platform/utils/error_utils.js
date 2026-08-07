/**
 * error_utils - 错误处理工具函数
 *
 * 提供跨模块统一的错误消息提取逻辑。
 *
 * @module utils/error_utils
 */

/**
 * 安全地从错误对象中提取消息字符串。
 *
 * 处理 err 可能为 null / undefined / 非 Error 对象的情况，
 * 确保始终返回一个可读的字符串。
 *
 * @param {*} err - 错误对象（可能是 Error 实例、普通对象、字符串、null 或 undefined）
 * @param {string} [fallback="unknown error"] - 当 err 为 null/undefined 时的回退文案
 * @returns {string} 错误消息文本
 */
export function getErrorMessage(err, fallback = "unknown error") {
  return err && typeof err.message === "string" ? err.message : String(err ?? fallback);
}

/**
 * 从 LLM 供应商的错误响应体中提取可读的错误原因。
 *
 * 当 AI SDK 抛出 HTTP 类错误时，err.message 往往只是 "HTTP 400 Bad Request"
 * 这类通用文案，而真正的失败原因在响应体里，例如 OpenAI 风格的
 * {"error":{"message":"..."}} 或 Anthropic 风格的 {"error":{"message":"..."}}。
 *
 * @param {*} err - AI SDK 或任意错误对象（可含 responseBody / response.body）
 * @returns {string|null} 提取到的供应商错误原因；无法提取时返回 null
 */
export function extractProviderErrorMessage(err) {
  const body = err?.responseBody ?? err?.response?.body ?? null;
  if (typeof body !== "string" || body.trim() === "") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidates = [];
  const errorField = parsed.error;
  if (errorField && typeof errorField === "object" && !Array.isArray(errorField)) {
    candidates.push(errorField.message, errorField.msg, errorField.detail);
  } else if (typeof errorField === "string") {
    candidates.push(errorField);
  }
  candidates.push(
    parsed.message,
    parsed.msg,
    parsed.detail,
    parsed.errorMessage,
    parsed.error_message,
    parsed.reason
  );

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}
