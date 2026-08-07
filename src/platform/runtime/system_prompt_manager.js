/**
 * SystemPromptManager - 系统提示词管理器
 *
 * 职责：管理动态系统提示词提供者的注册、注销和追加内容获取。
 *
 * @module runtime/system_prompt_manager
 */

export class SystemPromptManager {
  constructor(runtime) {
    this.runtime = runtime;
    this._providers = new Map();
  }

  /**
   * 注册系统提示词提供者
   * @param {string} providerId - 提供者唯一标识
   * @param {Function} providerFn - 返回提示词字符串的函数
   */
  registerSystemPromptProvider(providerId, providerFn) {
    if (typeof providerFn !== "function") {
      throw new Error("providerFn must be a function");
    }
    this._providers.set(providerId, providerFn);
    void this.runtime.log.debug("注册系统提示词提供者", { providerId });
  }

  /**
   * 注销系统提示词提供者
   * @param {string} providerId - 提供者唯一标识
   */
  unregisterSystemPromptProvider(providerId) {
    this._providers.delete(providerId);
    void this.runtime.log.debug("注销系统提示词提供者", { providerId });
  }

  /**
   * 获取所有系统提示词追加内容
   * @returns {string}
   */
  getSystemPromptAppendix() {
    const sections = [];
    for (const [providerId, providerFn] of this._providers) {
      try {
        const content = providerFn();
        if (content && typeof content === "string") {
          sections.push(content);
        }
      } catch (err) {
        void this.runtime.log.warn("系统提示词提供者执行失败", {
          providerId,
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    }
    return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
  }
}
