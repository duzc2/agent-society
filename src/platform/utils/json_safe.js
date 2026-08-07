/**
 * json_safe - JSON 安全序列化工具
 *
 * 从 Runtime 中提取为独立工具函数。
 *
 * @module utils/json_safe
 */

import { getErrorMessage } from "./error_utils.js";

/**
 * 将值转换为 JSON 安全的值。
 * - undefined → { value: null }
 * - 序列化后过长 → { error: "result_too_large", ... }
 * - 含有不可序列化内容 → { error: "non_json_serializable_return", ... }
 *
 * @param {*} value - 要转换的值
 * @returns {{value?: any, error?: string, maxJsonLength?: number, jsonLength?: number, message?: string}}
 */
export function toJsonSafeValue(value) {
  if (value === undefined) return { value: null };
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { value: null };
    if (json.length > 200000) return { error: "result_too_large", maxJsonLength: 200000, jsonLength: json.length };
    return { value: JSON.parse(json) };
  } catch (err) {
    const message = getErrorMessage(err);
    return { error: "non_json_serializable_return", message };
  }
}
