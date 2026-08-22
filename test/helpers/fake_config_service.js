/**
 * 内存版 configService fake — test/helpers/fake_config_service.js
 *
 * 模拟 Config 的模块配置三方法（registerModuleConfig / getModuleConfig / saveModuleConfig）：
 * - 合并语义与真实 Config 一致（saveModuleConfig 浅合并，不丢其它键）
 * - 返回深拷贝，避免测试间互相污染
 */

/**
 * 创建一个内存版 configService。
 * @returns {{
 *   registerModuleConfig: (name: string, defaults?: object) => void,
 *   getModuleConfig: (name: string) => Promise<object>,
 *   saveModuleConfig: (name: string, partial: object) => Promise<object>,
 *   _store: Map<string, object>
 * }}
 */
export function makeFakeConfigService() {
  const store = new Map();

  return {
    /** 暴露内部存储，便于测试断言持久化内容 */
    _store: store,

    registerModuleConfig(name, defaults) {
      store.set(name, { ...(defaults ?? {}) });
    },

    async getModuleConfig(name) {
      const value = store.get(name);
      return value ? JSON.parse(JSON.stringify(value)) : {};
    },

    async saveModuleConfig(name, partialConfig) {
      const merged = { ...(store.get(name) ?? {}), ...partialConfig };
      store.set(name, JSON.parse(JSON.stringify(merged)));
      return merged;
    },
  };
}
