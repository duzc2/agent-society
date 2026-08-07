/**
 * ModuleRegistry — 声明式模块初始化系统。
 *
 * 每个模块通过 declare() 声明自己需要的依赖 (requires) 和能提供的服务 (provides)。
 * 注册表在所有 requires 就绪时自动调用模块的 init() 回调。
 * 初始化顺序无关声明顺序 —— 只取决于依赖关系。
 * 暴露接口不需要使用export，也不需要其他模块import依赖项。
 *
 * 检测能力：
 *   - 死依赖：requires 中的名无任何模块 provides → validate() 报错
 *   - 循环依赖：A 等 B，B 等 A → 两者永远停留在 'declared'，validate() 报 timeout
 */

/**
 * @typedef {{
 *   name: string,
 *   requires: string[],
 *   provides: string[],
 *   init: (deps: Record<string, any>) => Promise<Record<string, any>>
 * }} ModuleDecl
 */

export class ModuleRegistry {
  constructor() {
    /** @type {Map<string, ModuleDecl & {status:string, error?:Error}>} */
    this._modules = new Map();
    /** @type {Map<string, any>} */
    this._services = new Map();
  }

  /**
   * 声明模块。调用時只注册意图，不触发初始化。
   * 初始化在依赖满足时自动发生。
   * @param {ModuleDecl} mod
   */
  declare(mod) {
    if (this._modules.has(mod.name)) {
      throw new Error(`Module "${mod.name}" already declared`);
    }
    for (const name of mod.provides) {
      const existing = [...this._modules.values()].find(m => m.provides.includes(name));
      if (existing) {
        throw new Error(`Service "${name}" already provided by module "${existing.name}"`);
      }
    }
    const entry = { ...mod, status: 'declared' };
    this._modules.set(mod.name, entry);
  }

  /**
   * 手动注入服务（用于非模块化的组件，如 Bootstrap、HTTPServer）。
   * @param {Record<string, any>} serviceMap
   * @returns {Promise<void>} 所有连锁激活完成后 resolve
   */
  async provide(serviceMap) {
    for (const [key, value] of Object.entries(serviceMap)) {
      this._services.set(key, value);
    }
    await this._activateAll();
  }

  /**
   * 验证依赖完整性。应在所有 provide() 之后、系统启动前调用。
   */
  async ensureReady() {
    const issues = [];
    for (const [name, mod] of this._modules) {
      if (mod.status === 'error') {
        issues.push(`  ${name}: ERROR — ${mod.error?.message ?? String(mod.error)}`);
      } else if (mod.status === 'declared') {
        const missing = [];
        const cycle = [];
        for (const r of mod.requires) {
          if (this._services.has(r)) continue;
          const providers = [...this._modules.values()].filter(m => m.provides.includes(r));
          if (providers.length === 0) {
            missing.push(r);
          } else {
            cycle.push(`${r} (from ${providers.map(p => p.name).join(', ')})`);
          }
        }
        if (missing.length > 0) {
          issues.push(`  ${name}: 死依赖 — 无模块提供 [${missing.join(', ')}]`);
        }
        if (cycle.length > 0) {
          issues.push(`  ${name}: 依赖未就绪 — [${cycle.join('; ')}]（可能循环依赖）`);
        }
      }
    }

    if (issues.length > 0) {
      throw new Error(`模块初始化失败:\n${issues.join('\n')}`);
    }
  }

  /**
   * 迭代激活：反复扫描，每轮激活所有依赖已就绪的模块。
   * 当一轮无新激活时停止（死锁/待注入）。
   * @returns {Promise<void>}
   */
  async _activateAll() {
    let progress = true;
    while (progress) {
      progress = false;
      const batch = [];

      for (const [name, mod] of this._modules) {
        if (mod.status !== 'declared') continue;

        const allReady = mod.requires.every(r => this._services.has(r));
        if (!allReady) continue;

        progress = true;
        mod.status = 'activating';

        const deps = {};
        for (const r of mod.requires) {
          deps[r] = this._services.get(r);
        }

        const p = Promise.resolve(mod.init(deps)).then(provided => {
          for (const key of mod.provides) {
            this._services.set(key, provided[key]);
          }
          mod.status = 'active';
        }).catch(err => {
          console.error(`[ModuleRegistry] 模块 "${mod.name}" 初始化失败:`, {
            moduleName: mod.name,
            error: err?.message,
            stack: err?.stack,
            name: err?.name,
            code: err?.code,
          });
          mod.status = 'error';
          mod.error = err;
        });
        batch.push(p);
      }

      await Promise.all(batch);
    }
  }
}

/** 全局单例 */
export const registry = new ModuleRegistry();
