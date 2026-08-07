/**
 * 清理钩子链 (CleanupHookChain)
 *
 * 将系统关闭过程分为 6 个有序阶段，每个阶段有独立的超时保护。
 * 替代当前混乱的关闭逻辑，确保关闭流程确定、可靠。
 *
 * 六阶段关闭顺序：
 *   1. stop_accepting   — 停止接收新消息
 *   2. drain_inflight   — 等待当前在处理的操作完成
 *   3. persist_state    — 原子持久化当前状态
 *   4. close_resources  — 调用 LifecycleRegistry 清理所有注册的资源
 *   5. flush_logs       — 刷新日志缓冲区
 *   6. exit             — 调用 process.exit()
 *
 * 用法：
 *   const hooks = new CleanupHookChain(runtime);
 *   hooks.register('persist_state', () => saveData());
 *   await hooks.execute();
 *
 * @module runtime/cleanup_hooks
 */

class CleanupHookChain {
  /**
   * @param {object} runtime — 运行时对象（用于日志记录）
   */
  constructor(runtime) {
    this.runtime = runtime;
    this._phases = [
      { name: 'stop_accepting', timeoutMs: 2000, hooks: [] },
      { name: 'drain_inflight', timeoutMs: 30000, hooks: [] },
      { name: 'persist_state', timeoutMs: 5000, hooks: [] },
      { name: 'close_resources', timeoutMs: 10000, hooks: [] },
      { name: 'flush_logs', timeoutMs: 2000, hooks: [] },
      { name: 'exit', timeoutMs: 1000, hooks: [] }
    ];
  }

  /**
   * 在指定阶段注册一个钩子函数。
   * 如果阶段不存在则静默忽略。
   * @param {string} phaseName
   * @param {Function} hook — 异步或同步函数
   */
  register(phaseName, hook) {
    const phase = this._phases.find(p => p.name === phaseName);
    if (phase) {
      phase.hooks.push(hook);
    }
  }

  /**
   * 按序执行所有阶段的钩子。
   * 每个阶段有独立的超时保护，阶段失败/超时不会阻止后续阶段。
   * @returns {Promise<void>}
   */
  async execute() {
    for (const phase of this._phases) {
      if (!phase.hooks.length) {
        continue;
      }

      const log = this.runtime.log;

      try {
        log.info("[Shutdown] 进入阶段: " + phase.name);

        await Promise.race([
          Promise.all(phase.hooks.map(h => {
            try {
              return Promise.resolve(h());
            } catch (syncErr) {
              return Promise.reject(syncErr);
            }
          })),
          new Promise((resolve) => {
            const timer = setTimeout(() => {
              log.warn("[Shutdown] 阶段超时", {
                phase: phase.name,
                timeoutMs: phase.timeoutMs,
                hookCount: phase.hooks.length
              });
              resolve();
            }, phase.timeoutMs);
            if (timer && typeof timer.unref === 'function') {
              timer.unref();
            }
          })
        ]);
      } catch (err) {
        const msg = err?.message ?? String(err);
        log.error("[Shutdown] 阶段失败", {
          phase: phase.name,
          timeoutMs: phase.timeoutMs,
          hookCount: phase.hooks.length,
          error: msg,
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    }
  }

  /**
   * 获取所有阶段名称列表（按执行顺序）。
   * @returns {string[]}
   */
  getPhaseNames() {
    return this._phases.map(p => p.name);
  }

  /**
   * 获取指定阶段包含的钩子数量。
   * @param {string} phaseName
   * @returns {number} 钩子数，阶段不存在返回 -1
   */
  getHookCount(phaseName) {
    const phase = this._phases.find(p => p.name === phaseName);
    return phase ? phase.hooks.length : -1;
  }
}

export { CleanupHookChain };
