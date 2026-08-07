/**
 * 资源生命周期注册表 (LifecycleRegistry)
 *
 * 所有资源（Chrome 浏览器、子进程、AgentMemory 实例等）都必须注册到此，
 * 关联到其所属的智能体 ID。当智能体被终止时，系统能自动清理该智能体持有
 * 的所有资源。
 *
 * 用法：
 *   const registry = new LifecycleRegistry();
 *   registry.register({
 *     id: 'chrome:agent-1:123',
 *     type: 'chrome',
 *     ownerAgentId: 'agent-1',
 *     cleanup: () => browser.close()
 *   });
 *   await registry.forceCleanupAgent('agent-1', 'terminated');
 *
 * @module runtime/resource_lifecycle
 */

class LifecycleRegistry {
  constructor() {
    /** @type {Map<string, {id:string, type:string, ownerAgentId:string, createdAt:number, state:string, cleanup:Function}>} */
    this._resources = new Map();    // resourceId → { type, ownerAgentId, createdAt, state, cleanup }

    /** @type {Map<string, Set<string>>} */
    this._byAgent = new Map();      // agentId → Set<resourceId>

    /** @type {Map<string, Set<string>>} */
    this._byType = new Map();       // resourceType → Set<resourceId>
  }

  /**
   * 注册一个资源。
   * @param {{id:string, type:string, ownerAgentId:string, cleanup?:Function}} options
   * @returns {string} 资源 ID
   */
  register({ id, type, ownerAgentId, cleanup }) {
    const entry = {
      id,
      type,
      ownerAgentId,
      createdAt: Date.now(),
      state: 'active',
      cleanup
    };
    this._resources.set(id, entry);

    if (!this._byAgent.has(ownerAgentId)) {
      this._byAgent.set(ownerAgentId, new Set());
    }
    this._byAgent.get(ownerAgentId).add(id);

    if (!this._byType.has(type)) {
      this._byType.set(type, new Set());
    }
    this._byType.get(type).add(id);

    return id;
  }

  /**
   * 按智能体获取所有资源。
   * @param {string} agentId
   * @returns {Array<{id:string, type:string, ownerAgentId:string, createdAt:number, state:string, cleanup:Function}>}
   */
  getByAgent(agentId) {
    const ids = this._byAgent.get(agentId);
    if (!ids) return [];
    const result = [];
    for (const id of ids) {
      const r = this._resources.get(id);
      if (r) result.push(r);
    }
    return result;
  }

  /**
   * 按类型获取所有资源。
   * @param {string} type
   * @returns {Array<{id:string, type:string, ownerAgentId:string, createdAt:number, state:string, cleanup:Function}>}
   */
  getByType(type) {
    const ids = this._byType.get(type);
    if (!ids) return [];
    const result = [];
    for (const id of ids) {
      const r = this._resources.get(id);
      if (r) result.push(r);
    }
    return result;
  }

  /**
   * 注销并清理一个资源。
   * @param {string} id
   * @returns {Promise<void>}
   */
  async unregister(id) {
    const entry = this._resources.get(id);
    if (!entry) return;

    entry.state = 'cleaning';
    try {
      if (entry.cleanup) {
        await entry.cleanup();
      }
      entry.state = 'released';
    } catch (err) {
      entry.state = 'error';
      throw err;
    } finally {
      this._resources.delete(id);
      this._byAgent.get(entry.ownerAgentId)?.delete(id);
      this._byType.get(entry.type)?.delete(id);
    }
  }

  /**
   * 强制清理某个智能体的所有资源。
   * 按顺序清理：chrome → subprocess → agent_memory → conversation → data_folder
   * @param {string} agentId
   * @param {string} [reason]
   * @returns {Promise<Array<{id:string, status:string, error?:string}>>}
   */
  async forceCleanupAgent(agentId, reason) {
    const resources = this.getByAgent(agentId);
    const order = ['chrome', 'subprocess', 'agent_memory', 'conversation', 'data_folder'];
    const sorted = resources.sort((a, b) =>
      order.indexOf(a.type) - order.indexOf(b.type)
    );

    /** @type {Array<{id:string, status:string, error?:string}>} */
    const results = [];
    for (const res of sorted) {
      try {
        await this.unregister(res.id);
        results.push({ id: res.id, status: 'ok' });
      } catch (err) {
        results.push({ id: res.id, status: 'error', error: err?.message ?? String(err) });
      }
    }
    return results;
  }

  /**
   * 获取注册表统计信息。
   * @returns {{total:number, byType:Record<string,number>, byAgent:number}}
   */
  getStats() {
    let total = 0;
    /** @type {Record<string,number>} */
    const byType = {};
    for (const [type, ids] of this._byType) {
      byType[type] = ids.size;
      total += ids.size;
    }
    return { total, byType, byAgent: this._byAgent.size };
  }
}

export { LifecycleRegistry };
