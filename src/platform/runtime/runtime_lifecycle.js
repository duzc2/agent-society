/**
 * Runtime 生命周期管理模块
 * 
 * 本模块负责智能体的生命周期管理，包括创建、恢复、注册、查询、中断和级联停止。
 * 
 * 【设计初衷】
 * 将智能体生命周期相关的功能从 Runtime 主类中提取出来，形成独立的模块。
 * 这样可以降低 Runtime 类的复杂度，提高代码的可维护性。
 * 
 * 【主要功能】
 * 1. 智能体创建：spawnAgent, spawnAgentAs
 * 2. 智能体恢复：restoreAgentsFromOrg
 * 3. 智能体注册：registerAgentInstance, registerRoleBehavior
 * 4. 智能体查询：getAgentStatus, listAgentInstances, getQueueDepths
 * 5. 智能体中断：abortAgentLlmCall, cascadeStopAgents
 * 6. 工作空间查找：findWorkspaceIdForAgent
 * 
 * 【与其他模块的关系】
 * - 被 Runtime 主类调用
 * - 使用 AgentManager 的功能
 * - 使用 RuntimeState 管理状态
 * 
 * @module runtime/runtime_lifecycle
 */

import { Agent } from "../../agents/agent.js";

/**
 * Runtime 生命周期管理器类
 * 
 * 负责智能体的完整生命周期管理。
 */
export class RuntimeLifecycle {
  /**
   * 创建生命周期管理器实例
   * 
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  /**
   * 创建并注册智能体实例
   * 
   * 【创建流程】
   * 1. 验证 parentAgentId 参数
   * 2. 在组织中创建智能体记录
   * 3. 获取岗位信息和行为工厂
   * 4. 创建 Agent 实例
   * 5. 注册到运行时
   * 6. 为 root 的直接子智能体分配工作空间
   * 
   * @param {object} input - 创建参数
   * @param {string} input.roleId - 岗位ID
   * @param {string} input.parentAgentId - 父智能体ID（必填）
   * @returns {Promise<Agent>} 创建的智能体实例
   * @throws {Error} 如果 parentAgentId 缺失
   */
  async spawnAgent(input) {
    return await this.runtime._agentManager.spawnAgent(input);
  }

  /**
   * 以调用者身份创建子智能体
   * 
   * parentAgentId 由系统自动填充为调用者的 ID。
   * 
   * @param {string} callerAgentId - 调用者智能体ID
   * @param {object} input - 创建参数
   * @param {string} input.roleId - 岗位ID
   * @returns {Promise<Agent>} 创建的智能体实例
   * @throws {Error} 如果 parentAgentId 与调用者不匹配
   */
  async spawnAgentAs(callerAgentId, input) {
    return await this.runtime._agentManager.spawnAgentAs(callerAgentId, input);
  }

  /**
   * 从组织状态恢复智能体实例到内存中
   * 
   * 在服务器重启后调用，确保之前创建的智能体能够继续处理消息。
   * 
   * @returns {Promise<void>}
   */
  async restoreAgentsFromOrg() {
    return await this.runtime._agentManager.restoreAgentsFromOrg();
  }

  /**
   * 注册某个岗位名对应的行为工厂
   * 
   * @param {string} roleName - 岗位名称
   * @param {(ctx: any) => Function} behaviorFactory - 行为工厂函数
   */
  registerRoleBehavior(roleName, behaviorFactory) {
    this.runtime._behaviorRegistry.set(roleName, behaviorFactory);
  }

  /**
   * 向运行时注册一个智能体实例
   * 
   * @param {Agent} agent - 智能体实例
   */
  registerAgentInstance(agent) {
    this.runtime._agentManager.registerAgentInstance(agent);
  }

  /**
   * 列出当前运行时已注册的智能体实例
   * 
   * @returns {{id: string, roleId: string, roleName: string}[]} 智能体信息数组
   */
  listAgentInstances() {
    return this.runtime._agentManager.listAgentInstances();
  }

  /**
   * 获取指定智能体的状态信息
   * 
   * @param {string} agentId - 智能体ID
   * @returns {{id: string, roleId: string, roleName: string, parentAgentId: string|null, status: string, queueDepth: number, conversationLength: number}|null}
   */
  getAgentStatus(agentId) {
    return this.runtime._agentManager.getAgentStatus(agentId);
  }

  /**
   * 获取所有智能体的队列深度
   * 
   * @returns {{agentId: string, queueDepth: number}[]} 队列深度数组
   */
  getQueueDepths() {
    const result = [];
    for (const agentId of this.runtime._agents.keys()) {
      const queueDepth = this.runtime.bus.getQueueDepth(agentId);
      result.push({ agentId, queueDepth });
    }
    return result;
  }

  /**
   * 中止智能体的 LLM 调用
   * 
   * 【中止流程】
   * 1. 验证智能体是否存在
   * 2. 检查智能体是否正在等待 LLM 响应
   * 3. 调用 LLM 客户端的 abort 方法
   * 4. 更新智能体状态
   * 
   * @param {string} agentId - 智能体ID
   * @returns {{ok: boolean, agentId: string, aborted: boolean, reason?: string}} 中止结果
   */
  abortAgentLlmCall(agentId) {
    const runtime = this.runtime;
    
    if (agentId === "user") {
      return { ok: false, agentId, aborted: false, reason: "cannot_stop_user" };
    }

    // 验证智能体是否存在
    if (!runtime._agents.has(agentId)) {
      void runtime.log.warn("中止 LLM 调用失败：智能体不存在", { agentId });
      return { ok: false, agentId, aborted: false, reason: "agent_not_found" };
    }

    runtime._state.setAgentComputeStatus(agentId, "stopping");

    runtime._cancelManager?.abort(agentId, { reason: "user_stop" });

    let aborted = false;
    try {
      aborted = runtime.llm?.abort(agentId) ?? false;
    } catch (err) {
      void runtime.log.error("[abortAgentLlmCall] LlmClient.abort 调用异常", {
        agentId,
        error: err?.message ?? String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
    }

    runtime._turnEngine?.clearAgent?.(agentId);
    runtime._computeScheduler?.cancelInFlight?.(agentId);
    runtime.bus?.clearQueue?.(agentId);
    runtime._state.unmarkAgentAsActivelyProcessing(agentId);

    runtime._state.setAgentComputeStatus(agentId, "idle");

    if (aborted) {
      void runtime.log.info("已发起 LLM 中止请求", { agentId });
    } else {
      void runtime.log.info("未发现可中止的 LLM 请求，但已触发取消 epoch", { agentId });
    }

    return { ok: true, agentId, aborted };
  }

  /**
   * 级联停止所有子智能体
   * 
   * 【停止流程】
   * 1. 收集所有子智能体（递归）
   * 2. 对每个子智能体执行停止操作：
   *    - 设置状态为 stopping
   *    - 中止 LLM 调用
   *    - 清空消息队列
   *    - 设置最终状态为 stopped
   * 
   * @param {string} parentAgentId - 父智能体ID
   * @returns {string[]} 被停止的智能体ID列表
   */
  cascadeStopAgents(parentAgentId) {
    const runtime = this.runtime;
    const stoppedAgents = [];
    
    // 收集所有子智能体
    const descendants = runtime._agentManager.collectDescendantAgents(parentAgentId);
    
    // 对每个子智能体执行停止操作
    for (const agentId of descendants) {
      const agent = runtime._agents.get(agentId);
      if (!agent) continue;
      
      const currentStatus = runtime._state.getAgentComputeStatus(agentId);
      
      // 只停止活跃的智能体
      if (currentStatus === 'waiting_llm' || currentStatus === 'processing' || currentStatus === 'idle') {
        // 设置状态为 stopping
        runtime._state.setAgentComputeStatus(agentId, 'stopping');

        // 统一取消语义：递增 epoch + abort signal（用于丢弃晚到结果）
        runtime._cancelManager?.abort(agentId, { reason: "cascade_stop" });
        
        // 中止 LLM 调用
        const aborted = runtime.llm?.abort(agentId) ?? false;
        if (aborted) {
          void runtime.log.info("级联停止：中止 LLM 调用", { agentId, parentAgentId });
        }
        
        // 清空消息队列
        const clearedMessages = runtime.bus?.clearQueue(agentId) ?? [];
        const clearedCount = Array.isArray(clearedMessages) ? clearedMessages.length : 0;
        if (clearedCount > 0) {
          void runtime.log.info("级联停止：清空消息队列", { agentId, parentAgentId, clearedCount });
        }
        
        // 设置最终状态为 stopped
        runtime._state.setAgentComputeStatus(agentId, 'stopped');
        
        stoppedAgents.push(agentId);
        
        void runtime.log.info("级联停止智能体", { agentId, parentAgentId });
      }
    }
    
    return stoppedAgents;
  }

  /**
   * 强制终止指定智能体及其所有后代（用于 HTTP/管理员侧删除）。
   * @param {string} agentId
   * @param {{deletedBy?:string, reason?:string}} [options]
   * @returns {Promise<{ok:boolean, agentId:string, termination?:any, reason?:string}>}
   */
  async forceTerminateAgent(agentId, options = {}) {
    const runtime = this.runtime;
    const targetId = String(agentId ?? "").trim();
    const deletedBy = String(options.deletedBy ?? "user");
    const reason = String(options.reason ?? "用户删除");

    if (!targetId) return { ok: false, agentId: targetId, reason: "missing_agent_id" };
    if (targetId === "root" || targetId === "user") {
      return { ok: false, agentId: targetId, reason: "cannot_delete_system_agent" };
    }

    const meta = runtime.org?.getAgent?.(targetId) ?? null;
    if (!meta) return { ok: false, agentId: targetId, reason: "agent_not_found" };
    if (meta.status === "deleted") {
      return { ok: false, agentId: targetId, reason: "agent_already_terminated" };
    }

    const descendants = runtime._agentManager.collectDescendantAgents(targetId);
    const agentsToTerminate = [targetId, ...descendants];

    // 收集这些智能体创建的所有岗位（用于后续删除）
    // 注意：要遍历所有岗位，检查 createdBy 是否在被终止的智能体列表中
    const rolesToDelete = new Set();
    const allRoles = runtime.org?.listRoles?.() ?? [];
    for (const role of allRoles) {
      if (role?.createdBy && agentsToTerminate.includes(role.createdBy)) {
        rolesToDelete.add(role.id);
      }
    }

    for (const id of agentsToTerminate) {
      await runtime.agentMemoryManager?.clearMemory(id).catch((err) => {
        void runtime.log.warn("[强制终止] 清空智能体记忆失败", {
          agentId: id,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      });
      runtime._state.setAgentComputeStatus(id, "terminating");
      runtime._cancelManager?.abort(id, { reason: "force_terminate" });
      runtime.llm?.abort(id);
      runtime.bus?.clearQueue?.(id);
      runtime._turnEngine?.clearAgent?.(id);
    }

    for (const id of [...agentsToTerminate].reverse()) {
      runtime._agents.delete(id);
      runtime._conversations.delete(id);
      void runtime._conversationManager?.deletePersistedConversation?.(id);
      runtime._agentMetaById.delete(id);
      runtime._agentTaskBriefs?.delete?.(id);
      runtime._agentLastActivityTime.delete(id);
      runtime._idleWarningEmitted?.delete?.(id);
      runtime._state.unmarkAgentAsActivelyProcessing(id);
      runtime._state._agentComputeStatus.delete(id);
      runtime._state._agentComputePhase.delete(id);
      runtime._cancelManager?.clear(id);

      // 更新 org 中的智能体状态为已终止
      if (runtime.org?.recordTermination) {
        await runtime.org.recordTermination(id, deletedBy, reason);
      }

      // 清理 Chrome 浏览器进程（关闭浏览器，删除用户数据目录）
      const chromeModule = runtime.moduleLoader?.getModule?.("chrome");
      if (chromeModule && typeof chromeModule.cleanupAgentData === "function") {
        await chromeModule.cleanupAgentData(id).catch(err => {
          void runtime.log.warn("[强制终止] 清理 Chrome 浏览器数据失败", {
            agentId: id,
            error: err?.message ?? String(err),
            stack: err?.stack,
            name: err?.name,
            code: err?.code
          });
        });
      }

      // 删除智能体数据文件夹
      if (typeof runtime.deleteAgentDataFolder === "function") {
        runtime.deleteAgentDataFolder(id).catch(err => {
          void runtime.log.warn("[强制终止] 删除智能体文件夹失败", {
          agentId: id,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
        });
      }
    }

    // 删除这些智能体创建的岗位
    // 策略：只删除"根岗位"（创建该岗位的智能体的父智能体不在被终止列表中）
    // 让 org.deleteRole 自动级联删除子岗位
    const deletedRoles = [];
    const failedRoles = [];
    
    // 找出根岗位：创建该岗位的智能体的父智能体不在 agentsToTerminate 中
    const rootRoleIds = [];
    for (const roleId of rolesToDelete) {
      const role = runtime.org?.getRole?.(roleId);
      if (!role || role.status === "deleted") continue;
      
      const creatorAgentId = role?.createdBy;
      if (!creatorAgentId) continue;
      
      const creatorAgent = runtime.org?.getAgent?.(creatorAgentId);
      const parentAgentId = creatorAgent?.parentAgentId;
      
      // 如果父智能体不在被终止列表中，说明这是一个根岗位
      if (!parentAgentId || !agentsToTerminate.includes(parentAgentId)) {
        rootRoleIds.push(roleId);
      }
    }
    
    // 只删除根岗位，让级联机制处理子岗位
    for (const roleId of rootRoleIds) {
      try {
        const role = runtime.org?.getRole?.(roleId);
        if (role && role.status !== "deleted") {
          await runtime.org?.deleteRole?.(roleId, targetId, `创建者智能体被删除: ${reason}`);
          deletedRoles.push(roleId);
        }
      } catch (err) {
        failedRoles.push({ roleId, error: err.message });
      }
    }

    /** @type {{ok: boolean, agentId: string, deletedRoles?: string[], failedRoles?: Array<{roleId: string, error: string}>}} */
    const result = { ok: true, agentId: targetId, deletedRoles, failedRoles };
    return result;
  }

  /**
   * 删除岗位及其所有子岗位和智能体。
   * 
   * 【删除流程】
   * 1. 递归收集该岗位及其所有子岗位
   * 2. 收集这些岗位上的所有智能体
   * 3. 对每个智能体执行强制终止（停止执行、清理资源）
   * 4. 在组织中删除岗位（软删除，标记状态）
   * 
   * @param {string} roleId - 要删除的岗位ID
   * @param {string} deletedBy - 执行删除的用户或智能体ID
   * @param {string} [reason] - 删除原因
   * @returns {Promise<{ok:boolean, roleId:string, deleteResult?:object, error?:string}>}
   */
  async deleteRole(roleId, deletedBy, reason) {
    const runtime = this.runtime;
    const org = runtime.org;
    
    void runtime.log.info("[RuntimeLifecycle] 开始删除岗位", { roleId, deletedBy, reason });
    
    const role = org.getRole(roleId);
    if (!role) {
      void runtime.log.warn("[RuntimeLifecycle] 岗位不存在", { roleId });
      return { ok: false, roleId, error: "role_not_found" };
    }
    
    if (role.status === "deleted") {
      return { ok: false, roleId, error: "role_already_deleted" };
    }
    
    // 不允许删除系统岗位
    if (roleId === "root" || roleId === "user") {
      return { ok: false, roleId, error: "cannot_delete_system_role" };
    }

    // 1. 递归收集所有相关岗位ID（当前岗位及其所有子岗位）
    // 注意：必须从 org.listAgents() 获取智能体，而不是从 runtime._agentMetaById
    // 因为 _agentMetaById 只包含已注册到运行时的智能体，可能遗漏未恢复的智能体
    const roleIdsToDelete = new Set([roleId]);
    
    /**
     * 递归收集子岗位
     * 通过智能体的父子关系推断岗位层级：
     * - 找到岗位下的所有智能体（从 org.listAgents() 获取）
     * - 找到这些智能体创建的子智能体
     * - 子智能体所在的岗位就是子岗位
     */
    const allAgents = org.listAgents();
    const agentMap = new Map(allAgents.map(a => [a.id, a]));
    
    const collectChildRoles = (parentRoleId) => {
      for (const agent of allAgents) {
        if (agent.roleId === parentRoleId) {
          // 找到该岗位下的智能体，然后找它们创建的子智能体
          for (const childAgent of allAgents) {
            if (childAgent.parentAgentId === agent.id && childAgent.roleId !== parentRoleId) {
              if (!roleIdsToDelete.has(childAgent.roleId)) {
                roleIdsToDelete.add(childAgent.roleId);
                collectChildRoles(childAgent.roleId);
              }
            }
          }
        }
      }
    };
    collectChildRoles(roleId);

    // 2. 收集所有需要终止的智能体
    const agentsToTerminate = [];
    for (const agent of allAgents) {
      if (roleIdsToDelete.has(agent.roleId) && agent.status !== "deleted") {
        agentsToTerminate.push(agent.id);
      }
    }

    // 3. 先强制终止所有智能体，确保它们停止执行
    const terminatedAgents = [];
    const failedAgents = [];
    
    for (const agentId of agentsToTerminate) {
      try {
        // 检查智能体是否已注册到运行时（在 runtime._agents 中）
        const isAgentRegistered = runtime._agents.has(agentId);
        
        if (isAgentRegistered) {
          // 对已注册的运行时智能体执行完整的终止流程
          runtime._state.setAgentComputeStatus(agentId, "terminating");
          runtime._cancelManager?.abort(agentId, { reason: "role_deleted" });
          runtime.llm?.abort(agentId);
          runtime.bus?.clearQueue?.(agentId);
          runtime._turnEngine?.clearAgent?.(agentId);
          
          // 从 runtime 内存中清理
          runtime._agents.delete(agentId);
          runtime._conversations.delete(agentId);
          void runtime._conversationManager?.deletePersistedConversation?.(agentId);
          runtime._agentMetaById.delete(agentId);
          runtime._agentLastActivityTime.delete(agentId);
          runtime._idleWarningEmitted?.delete?.(agentId);
          runtime._state.unmarkAgentAsActivelyProcessing(agentId);
          runtime._state._agentComputeStatus.delete(agentId);
          runtime._state._agentComputePhase.delete(agentId);
          runtime._cancelManager?.clear(agentId);
        }
        
        // 删除智能体数据文件夹（复用 runtime.js 中的方法）
        if (typeof runtime.deleteAgentDataFolder === "function") {
          runtime.deleteAgentDataFolder(agentId).catch(err => {
            void runtime.log.warn("[删除岗位] 删除智能体文件夹失败", {
              agentId,
              error: err.message,
              stack: err.stack,
              name: err?.name,
              code: err?.code
            });
          });
        }
        
        terminatedAgents.push(agentId);
      } catch (termErr) {
        failedAgents.push({ agentId, error: termErr.message });
      }
    }

    // 4. 在组织中删除岗位（软删除，会标记智能体为已终止）
    const deleteResult = await org.deleteRole(roleId, deletedBy, reason);

    void runtime.log.info("删除岗位完成", {
      roleId,
      roleName: role.name,
      deletedBy,
      reason: reason ?? null,
      totalRoles: roleIdsToDelete.size,
      totalAgents: agentsToTerminate.length,
      terminatedAgentsCount: terminatedAgents.length,
      failedAgentsCount: failedAgents.length
    });

    return {
      ok: true,
      roleId,
      deleteResult: {
        ...deleteResult,
        terminatedAgents,
        failedAgents,
        roleIdsDeleted: Array.from(roleIdsToDelete)
      }
    };
  }

  /**
   * 通过祖先链查找智能体的工作空间ID
   * 
   * 从当前智能体开始向上查找，直到找到第一个有工作空间的祖先。
   * 
   * @param {string} agentId - 智能体ID
   * @returns {string|null} 工作空间ID，如果没有则返回 null
   */
  findWorkspaceIdForAgent(agentId) {
    return this.runtime._agentManager.findWorkspaceIdForAgent(agentId);
  }
}
