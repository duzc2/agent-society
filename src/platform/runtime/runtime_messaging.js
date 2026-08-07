/**
 * RuntimeMessaging - 消息处理循环模块
 *
 * 职责：
 * - 消息调度：生产者-消费者模式的消息循环
 * - 消息处理：单个智能体的消息处理
 * - 并发控制：控制并发处理的智能体数量
 *
 * 设计原则：
 * - 单智能体串行约束：同一智能体同时只能处理一条消息
 * - 多智能体并发：不同智能体可以并发处理消息
 * - 优雅关闭：支持等待活跃消息处理完成
 * - 异常隔离：单个智能体的异常不影响其他智能体
 */

import { randomUUID } from "node:crypto";

export class RuntimeMessaging {
  /**
   * @param {object} runtime - Runtime 实例
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.log = runtime.log;
  }

  /**
   * 启动常驻异步消息循环（不阻塞调用者）。
   * 注意：此方法立即返回，消息循环在后台运行。
   * @returns {void}
   */
  startProcessing() {
    if (this.runtime._processingLoopPromise) return;
    this.runtime._stopRequested = false;
    this.runtime._processingLoopPromise = this._processingLoop().finally(() => {
      this.runtime._processingLoopPromise = null;
    });
    // 不返回 Promise，让循环在后台运行
  }

  /**
   * 消息处理循环（生产者-消费者模式）
   * @private
   */
  async _processingLoop() {
    void this.log.info("运行时常驻消息循环开始（生产者-消费者模式）");
    
    // 获取最大并发数（从LLM客户端配置）
    const maxConcurrent = this.runtime.llm?.concurrencyController?.maxConcurrentRequests ?? 3;
    
    while (!this.runtime._stopRequested) {
      // 检查并投递到期的延迟消息
      this.runtime.bus.deliverDueMessages();
      
      // 尝试调度新的消息处理
      const scheduled = await this._scheduleMessageProcessing(maxConcurrent);
      
      if (!scheduled && !this.runtime.bus.hasPending()) {
        // 没有调度成功且没有待处理消息，等待新消息
        await this.runtime.bus.waitForMessage({ timeoutMs: 100 });
      } else if (!scheduled) {
        // 有待处理消息但无法调度（可能是并发已满或智能体正在处理）
        // 短暂等待后重试
        await new Promise((r) => setTimeout(r, 10));
      }
      
      // 让出事件循环
      await new Promise((r) => setImmediate(r));
    }
    
    if (this.runtime._forceExit) {
      return;
    }
    
    // 优雅关闭时强制投递所有延迟消息
    const forcedCount = this.runtime.bus.forceDeliverAllDelayed();
    if (forcedCount > 0) {
      void this.log.info("关闭时强制投递延迟消息", { count: forcedCount });
    }
    
    // 等待所有正在处理的消息完成（除非强制退出）
    while (this.runtime._activeProcessingAgents.size > 0 && !this.runtime._forceExit) {
      void this.log.info("等待活跃消息处理完成", { 
        activeCount: this.runtime._activeProcessingAgents.size,
        activeAgents: [...this.runtime._activeProcessingAgents]
      });
      await new Promise((r) => setTimeout(r, 100));
    }
    
    void this.log.info("运行时常驻消息循环结束", { stopRequested: this.runtime._stopRequested });
  }

  /**
   * 调度消息处理（生产者-消费者模式的调度器）
   * @param {number} maxConcurrent 最大并发数
   * @returns {Promise<boolean>} 是否成功调度了新的消息处理
   * @private
   */
  async _scheduleMessageProcessing(maxConcurrent) {
    // 检查是否还有并发槽位
    if (this.runtime._activeProcessingAgents.size >= maxConcurrent) {
      return false;
    }
    
    // 遍历所有智能体，找到有待处理消息且当前未在处理中的智能体
    for (const agentId of this.runtime._agents.keys()) {
      if (this.runtime._stopRequested) break;
      
      // 跳过正在处理消息的智能体（单智能体串行约束）
      if (this.runtime._activeProcessingAgents.has(agentId)) {
        continue;
      }
      
      // 检查是否有待处理消息
      const msg = this.runtime.bus.receiveNext(agentId);
      if (!msg) continue;
      
      // 标记智能体为处理中
      this.runtime._activeProcessingAgents.add(agentId);
      
      // 异步处理消息（不等待完成）
      this._processAgentMessage(agentId, msg).finally(() => {
        this.runtime._activeProcessingAgents.delete(agentId);
      });
      
      void this.log.debug("调度消息处理", {
        agentId,
        messageId: msg.id,
        activeCount: this.runtime._activeProcessingAgents.size,
        maxConcurrent
      });
      
      return true; // 成功调度了一个
    }
    
    return false;
  }

  /**
   * 处理单个智能体的消息
   * @param {string} agentId 智能体ID
   * @param {object} msg 消息对象
   * @private
   */
  async _processAgentMessage(agentId, msg) {
    const agent = this.runtime._agents.get(agentId);
    if (!agent) {
      void this.log.warn("智能体不存在，跳过消息处理", { agentId, messageId: msg.id });
      return;
    }
    
    // 检查智能体状态：如果已停止或正在停止，跳过处理
    const status = this.runtime._state.getAgentComputeStatus(agentId);
    if (status === 'stopped' || status === 'stopping' || status === 'terminating') {
      void this.log.info("智能体已停止，跳过消息处理", {
        agentId,
        status,
        messageId: msg.id,
        from: msg.from
      });
      return;
    }
    
    // 更新智能体最后活动时间
    this.runtime._updateAgentActivity(agentId);
    
    void this.log.debug("开始处理消息", {
      agentId,
      from: msg.from,
      taskId: msg.taskId ?? null,
      messageId: msg.id ?? null
    });
    
    // 记录智能体收到消息的生命周期事件
    void this.runtime._agentManager.logLifecycleEvent("agent_message_received", {
      agentId,
      messageId: msg.id ?? null,
      from: msg.from,
      taskId: msg.taskId ?? null
    });
    
    try {
      await agent.onMessage(this.runtime._buildAgentContext(agent), msg);
    } catch (err) {
      // 打印完整的原始错误信息（包含堆栈和行号）
      void this.log.error("智能体消息处理异常（已隔离）", {
        agentId,
        messageId: msg.id ?? null,
        from: msg.from,
        taskId: msg.taskId ?? null,
        error: err, // 直接传递原始错误对象，让日志系统处理
        willContinueProcessing: true
      });
      
      // 确保智能体状态重置为空闲
      this.runtime._state.setAgentComputeStatus(agentId, 'idle');
      
    }
  }

  /**
   * 投递一轮消息（并发处理多个智能体的消息）
   * @returns {Promise<boolean>} 是否成功投递了消息
   * @private
   */
  async _deliverOneRound() {
    if (this.runtime._stopRequested) return false;
    
    // 获取最大并发数
    const maxConcurrent = this.runtime.llm?.concurrencyController?.maxConcurrentRequests ?? 3;
    
    // 收集可以处理的消息（不超过并发限制）
    const pendingDeliveries = [];
    for (const agentId of this.runtime._agents.keys()) {
      if (pendingDeliveries.length >= maxConcurrent) break;
      if (this.runtime._activeProcessingAgents.has(agentId)) continue;
      
      const msg = this.runtime.bus.receiveNext(agentId);
      if (!msg) continue;
      
      const agent = this.runtime._agents.get(agentId);
      pendingDeliveries.push({ agentId, agent, msg });
      this.runtime._activeProcessingAgents.add(agentId);
    }
    
    if (pendingDeliveries.length === 0) {
      return false;
    }
    
    void this.log.debug("并发投递消息", {
      count: pendingDeliveries.length,
      agents: pendingDeliveries.map(d => d.agentId)
    });
    
    // 并发处理所有消息
    const deliveryPromises = pendingDeliveries.map(async ({ agentId, msg }) => {
      try {
        await this._processAgentMessage(agentId, msg);
      } finally {
        this.runtime._activeProcessingAgents.delete(agentId);
      }
    });
    
    await Promise.all(deliveryPromises);
    
    return true;
  }

  /**
   * 运行消息循环直到消息耗尽或达到步数上限。
   * 
   * 【退出条件】
   * 1. 请求停止（_stopRequested = true）
   * 2. 达到最大步数限制
   * 3. 没有待处理消息且没有活跃处理的智能体（完全空闲）
   * 4. 连续多轮无法投递消息且无活跃处理
   * 
   * 【处理流程】
   * 1. 检查是否完全空闲（无待处理消息且无活跃处理）
   * 2. 尝试投递一轮消息
   * 3. 如果投递成功，重置空闲计数并继续
   * 4. 如果投递失败但有活跃处理，等待后继续
   * 5. 如果投递失败且无活跃处理，增加空闲计数
   * 6. 空闲计数达到上限时退出
   * 
   * @returns {Promise<void>}
   */
  async run() {
    this.runtime._stopRequested = false;
    let steps = 0;
    let idleRounds = 0;
    const maxIdleRounds = 10; // 连续10轮完全空闲则认为完成
    
    void this.log.info("运行时消息循环开始", { maxSteps: this.runtime.maxSteps });
    
    while (!this.runtime._stopRequested && steps < this.runtime.maxSteps) {
      const hasPending = this.runtime.bus.hasPending();
      const hasActive = this.runtime._activeProcessingAgents.size > 0;
      
      // 完全空闲检查：没有待处理消息且没有活跃处理
      if (!hasPending && !hasActive) {
        idleRounds += 1;
        
        if (idleRounds >= maxIdleRounds) {
          void this.log.debug("连续完全空闲轮次达到上限，退出循环", { 
            idleRounds,
            hasPending,
            hasActive
          });
          break;
        }
        
        // 短暂等待，防止过早退出
        await new Promise(r => setTimeout(r, 5));
        continue;
      }
      
      // 重置空闲计数（有待处理消息或有活跃处理）
      idleRounds = 0;
      
      // 尝试投递一轮消息
      const delivered = await this._deliverOneRound();
      
      if (delivered) {
        // 成功投递消息
        steps += 1;
      } else if (hasActive) {
        // 没有投递但有活跃处理，等待活跃处理完成
        await new Promise(r => setTimeout(r, 10));
      } else if (hasPending) {
        // 有待处理消息但无法投递（可能所有智能体都在处理中）
        await new Promise(r => setTimeout(r, 10));
      }
    }
    
    void this.log.info("运行时消息循环结束", {
      steps,
      stopRequested: this.runtime._stopRequested,
      hasPending: this.runtime.bus.hasPending(),
      activeProcessing: this.runtime._activeProcessingAgents.size,
      reason: this.runtime._stopRequested ? "stop_requested" : 
              steps >= this.runtime.maxSteps ? "max_steps_reached" : 
              "idle_complete"
    });
  }
}
