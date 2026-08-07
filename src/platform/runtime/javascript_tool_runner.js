/**
 * JavaScriptToolRunner - JavaScript 工具执行器
 *
 * 职责：执行 JavaScript 工具和检测被阻止的 JavaScript token。
 *
 * @module runtime/javascript_tool_runner
 */

import { detectBlockedTokens as _detectBlockedFn } from "./blocked_tokens.js";

export class JavaScriptToolRunner {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async _runJavaScriptTool(args, messageId = null, agentId = null, workspaceId = null) {
    // 使用浏览器 JavaScript 执行器
    // 浏览器执行器会自动处理：
    // - 代码验证
    // - 异步代码支持（Promise/await）
    // - Canvas 绘图和导出
    // - 浏览器不可用时降级到 Node.js 执行
    return await this.runtime._browserJsExecutor.execute(args, messageId, agentId, workspaceId);
  }

  /**
   * 检测代码中是否包含被阻止的 JavaScript token。
   * @param {string} code
   * @returns {string[]} 被检测到的 token 名称列表
   */
  _detectBlockedJavaScriptTokens(code) {
    return _detectBlockedFn(code).blocked;
  }
}
