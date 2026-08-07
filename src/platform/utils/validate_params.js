/**
 * 验证必需参数。
 * @param {object} args - 参数对象
 * @param {string[]} requiredParams - 必需参数名列表
 * @returns {object|null} 如果验证失败返回 { error, message }，否则返回 null
 */
export function validateParams(args, requiredParams) {
  for (const param of requiredParams) {
    if (args[param] === undefined || args[param] === null) {
      return {
        error: "missing_parameter",
        message: `缺少必需参数：${param}`
      };
    }
  }
  return null;
}
