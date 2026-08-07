/**
 * TaskIdResolver - 任务 ID 解析器
 *
 * 职责：根据智能体 ID 解析其所属的任务 ID。
 *
 * @module runtime/task_id_resolver
 */

export class TaskIdResolver {
  constructor(runtime) {
    this.runtime = runtime;
  }

  /**
   * 确保反向索引（agentId → taskId）已构建（惰性构建，O(1) 查找用）。
   * @private
   */
  _ensureAgentIdToTaskIdIndex() {
    const rt = this.runtime;
    if (rt._agentIdToTaskId.size !== rt._rootTaskAgentByTaskId.size) {
      rt._agentIdToTaskId.clear();
      for (const [taskId, agentInfo] of rt._rootTaskAgentByTaskId.entries()) {
        rt._agentIdToTaskId.set(agentInfo.id, taskId);
      }
    }
  }

  /**
   * 获取智能体对应的任务 ID（O(1) 反向索引 + O(L) 父链追溯）。
   * @param {string} agentId
   * @returns {string|null}
   */
  _getAgentTaskId(agentId) {
    // root 和 user 不属于任何 task
    if (agentId === "root" || agentId === "user") {
      return null;
    }

    this._ensureAgentIdToTaskIdIndex();

    // O(1) 反向索引直接查找
    const taskId = this.runtime._agentIdToTaskId.get(agentId);
    if (taskId) return taskId;

    // 追溯父链（每步 O(1) 查找 _agentMetaById + _agentIdToTaskId）
    let currentId = agentId;
    const visited = new Set();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const parentTaskId = this.runtime._agentIdToTaskId.get(currentId);
      if (parentTaskId) return parentTaskId;

      // 获取父智能体
      const meta = this.runtime._agentMetaById.get(currentId);
      if (!meta || !meta.parentAgentId) {
        break;
      }

      // 如果父智能体是 root，当前智能体就是组织根
      if (meta.parentAgentId === "root") {
        return currentId;
      }

      currentId = meta.parentAgentId;
    }

    return null;
  }

  /**
   * 获取智能体对应的 taskId（用于工作空间访问）。
   * 这是 _getAgentTaskId 的别名，用于工具执行时查找工作空间。
   * @param {string} agentId
   * @returns {string|null}
   */
  getTaskIdForAgent(agentId) {
    return this._getAgentTaskId(agentId);
  }
}
