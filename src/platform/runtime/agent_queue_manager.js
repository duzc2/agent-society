/**
 * AgentQueueManager - 智能体队列管理器
 *
 * 职责：处理智能体的消息队列排空和后代收集。
 *
 * @module runtime/agent_queue_manager
 */

import { getErrorMessage } from "../utils/error_utils.js";

export class AgentQueueManager {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async _drainAgentQueue(agentId) {
    const agent = this.runtime._agents.get(agentId);
    if (!agent) return;

    let processedCount = 0;
    const maxDrainMessages = 100; // 防止无限循环

    while (processedCount < maxDrainMessages) {
      const msg = this.runtime.bus.receiveNext(agentId);
      if (!msg) break;

      processedCount += 1;
      void this.runtime.log.debug("终止前处理消息", {
        agentId,
        messageId: msg.id,
        from: msg.from,
        processedCount
      });

      try {
        await agent.onMessage(this.runtime._buildAgentContext(agent), msg);
      } catch (err) {
        const message = getErrorMessage(err);
        void this.runtime.log.error("终止前消息处理失败", { agentId, messageId: msg.id, message });
      }
    }

    if (processedCount > 0) {
      void this.runtime.log.info("终止前消息处理完成", { agentId, processedCount });
    }
  }

  /**
   * 收集指定智能体的所有后代智能体 ID（用于级联终止）。
   * @param {string} parentId - 父智能体 ID
   * @returns {string[]} 后代智能体 ID 数组
   */
  _collectDescendantAgents(parentId) {
    const descendants = [];

    // 遍历所有智能体，找到直接子智能体
    for (const [agentId, meta] of this.runtime._agentMetaById) {
      if (meta.parentAgentId === parentId) {
        descendants.push(agentId);
        // 递归收集孙子智能体
        const grandchildren = this._collectDescendantAgents(agentId);
        descendants.push(...grandchildren);
      }
    }

    return descendants;
  }
}
