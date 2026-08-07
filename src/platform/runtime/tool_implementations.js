/**
 * ToolImplementations - 工具实现
 *
 * 职责：实现 delete_agent 和 spawn_agent_with_task 两个工具的具体逻辑。
 *
 * @module runtime/tool_implementations
 */

export class ToolImplementations {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async _executeDeleteAgent(ctx, args) {
    const callerId = ctx.agent?.id ?? null;
    const targetId = args?.agentId;

    if (!callerId) {
      return { ok: false, error: "missing_caller_agent" };
    }

    if (!targetId || typeof targetId !== "string") {
      return { ok: false, error: "missing_agent_id" };
    }

    // 验证目标智能体是否存在
    if (!this.runtime._agents.has(targetId)) {
      void this.runtime.log.warn("delete_agent 目标智能体不存在", { callerId, targetId });
      return { ok: false, error: "agent_not_found", agentId: targetId };
    }

    // 验证是否为子智能体（只能删除自己创建的子智能体）
    const targetMeta = this.runtime._agentMetaById.get(targetId);
    if (!targetMeta || targetMeta.parentAgentId !== callerId) {
      void this.runtime.log.warn("delete_agent 权限验证失败：非子智能体", {
        callerId,
        targetId,
        targetParentAgentId: targetMeta?.parentAgentId ?? null
      });
      return { ok: false, error: "not_child_agent" };
    }

    void this.runtime.log.info("开始删除智能体", { callerId, targetId, reason: args.reason ?? null });

    // 调用统一的强制终止逻辑
    const result = await this.runtime._lifecycle.forceTerminateAgent(targetId, {
      deletedBy: callerId,
      reason: args.reason ?? "智能体删除工具调用"
    });

    if (!result.ok) {
      void this.runtime.log.warn("智能体删除失败", { callerId, targetId, reason: result.reason });
      return { ok: false, error: result.reason || "delete_failed", agentId: targetId };
    }

    void this.runtime.log.info("智能体删除完成", { callerId, targetId });

    // 记录智能体生命周期事件（使用 agent_terminated 类型）
    void this.runtime._agentManager.logLifecycleEvent("agent_terminated", {
      agentId: targetId,
      reason: args.reason ?? null
    });

    return { ok: true, deletedAgentId: targetId };
  }

  async _executeSpawnAgentWithTask(ctx, args) {
    const creatorId = ctx.agent?.id ?? null;
    if (!creatorId) {
      return { ok: false, error: "missing_creator_agent" };
    }

    // 验证 initialMessage 参数
    if (!args.initialMessage || typeof args.initialMessage !== "object") {
      return {
        ok: false,
        error: "missing_initial_message",
        details: "创建智能体必须包含初始消息(initialMessage)，用于激活新智能体并告知其任务目标。请在参数中添加 initialMessage 字段，例如：{ message_type: 'task_assignment', text: '你的任务是...' }"
      };
    }

    // 直接使用底层的 spawnAgentAs 方法创建智能体
    try {
      const agent = await this.runtime.spawnAgentAs(creatorId, {
        roleId: args.roleId,
        taskBrief: args.taskBrief
      });

      const newAgentId = agent.id;
      const taskId = ctx.currentMessage?.taskId ?? null;

      // 构建任务消息 payload
      const messagePayload = {
        message_type: args.initialMessage.message_type ?? "task_assignment",
        ...args.initialMessage
      };

      // 发送任务消息给新创建的智能体
      const sendResult = this.runtime.bus.send({
        to: newAgentId,
        from: creatorId,
        taskId,
        payload: messagePayload
      });

      // bus.send 被拒绝时需要回滚已创建的智能体
      if (sendResult?.rejected) {
        void this.runtime.log.warn("bus.send 被拒绝，回滚已创建的智能体", {
          creatorId,
          newAgentId,
          reason: sendResult.reason,
          taskId
        });
        await this.runtime._lifecycle.forceTerminateAgent(newAgentId, {
          deletedBy: creatorId,
          reason: `bus.send 被拒绝 (${sendResult.reason ?? "unknown"}) - 回滚`
        });
        return {
          ok: false,
          error: "spawn_failed",
          details: `消息发送失败: ${sendResult.reason || "unknown"}`,
          agentId: newAgentId
        };
      }

      void this.runtime.log.info("spawn_agent_with_task 完成", {
        creatorId,
        newAgentId,
        roleId: agent.roleId,
        roleName: agent.roleName,
        messageId: sendResult.messageId,
        taskId
      });

      // 记录智能体发送消息的生命周期事件
      void this.runtime._agentManager.logLifecycleEvent("agent_message_sent", {
        agentId: creatorId,
        messageId: sendResult.messageId,
        to: newAgentId,
        taskId
      });

      return {
        ok: true,
        id: newAgentId,
        roleId: agent.roleId,
        roleName: agent.roleName,
        messageId: sendResult.messageId
      };
    } catch (error) {
      const errorMessage = error && typeof error.message === "string" ? error.message : String(error ?? "unknown error");
      void this.runtime.log.error("spawn_agent_with_task 失败", {
        creatorId,
        roleId: args.roleId,
        error: errorMessage,
        stack: error?.stack,
        name: error?.name,
        code: error?.code
      });
      return { ok: false, error: "spawn_failed", details: errorMessage };
    }
  }
}
