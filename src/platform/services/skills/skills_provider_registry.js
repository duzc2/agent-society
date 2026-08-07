/**
 * 技能来源注册表。
 *
 * 责任：
 * 1. 注册来源适配器。
 * 2. 统一按 providerId 读取来源能力。
 */
export class SkillsProviderRegistry {
  /**
   * @param {{logger?:any}} [options]
   */
  constructor(options = {}) {
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.providers = new Map();
  }

  /**
   * 注册来源适配器。
   * @param {{providerId:string}} provider
   */
  register(provider) {
    if (!provider || typeof provider.providerId !== "string" || !provider.providerId.trim()) {
      throw new Error("invalid_provider");
    }
    this.providers.set(provider.providerId, provider);
  }

  /**
   * 获取来源适配器。
   * @param {string} providerId
   * @returns {any|null}
   */
  get(providerId) {
    return this.providers.get(providerId) ?? null;
  }

  /**
   * 列出所有来源适配器。
   * @returns {any[]}
   */
  list() {
    return Array.from(this.providers.values());
  }
}
