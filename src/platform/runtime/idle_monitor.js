/**
 * IdleMonitor - 智能体空闲监控器
 *
 * 职责：跟踪智能体的活动时间，检测空闲超时并发出警告。
 *
 * @module runtime/idle_monitor
 */

export class IdleMonitor {
  constructor(runtime) {
    this.runtime = runtime;
    this._lastActivity = new Map();
    this._warningEmitted = new Set();
  }

  /**
   * 更新智能体的最后活动时间。
   * @param {string} agentId
   */
  updateActivity(agentId) {
    this._lastActivity.set(agentId, Date.now());
    // 重置空闲警告状态
    this._warningEmitted.delete(agentId);
  }

  /**
   * 获取智能体的最后活动时间。
   * @param {string} agentId
   * @returns {number|null} 时间戳（毫秒），如果智能体不存在则返回null
   */
  getLastActivityTime(agentId) {
    return this._lastActivity.get(agentId) ?? null;
  }

  /**
   * 获取智能体的空闲时长（毫秒）。
   * @param {string} agentId
   * @returns {number|null} 空闲时长（毫秒），如果智能体不存在则返回null
   */
  getIdleTime(agentId) {
    const lastActivity = this._lastActivity.get(agentId);
    if (lastActivity === undefined) {
      return null;
    }
    return Date.now() - lastActivity;
  }

  /**
   * 检查所有智能体的空闲状态，对超过配置时长的智能体发出警告。
   * @returns {{agentId:string, idleTimeMs:number}[]} 空闲超时的智能体列表
   */
  checkIdleAgents() {
    const idleAgents = [];
    const now = Date.now();

    for (const agentId of this.runtime._agents.keys()) {
      const lastActivity = this._lastActivity.get(agentId);
      if (lastActivity === undefined) continue;

      const idleTimeMs = now - lastActivity;
      if (idleTimeMs > this.runtime.idleWarningMs) {
        idleAgents.push({ agentId, idleTimeMs });

        // 只在首次超时时发出警告
        if (!this._warningEmitted.has(agentId)) {
          this._warningEmitted.add(agentId);
          void this.runtime.log.warn("智能体空闲超时", {
            agentId,
            idleTimeMs,
            idleWarningMs: this.runtime.idleWarningMs
          });
        }
      }
    }

    return idleAgents;
  }
}
