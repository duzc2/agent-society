/**
 * 智能体与组织管理工具 — 从 tool_executor.js 提取
 *
 * 包含：find_role_by_name、get_org_structure、create_role、delete_role、
 *        spawn_agent_with_task、send_message、delete_agent
 *
 * @module runtime/tools_agent
 */

import { validateTaskBrief } from "../utils/message/task_brief.js";
import { validateMessageFormat } from "../utils/message/message_validator.js";
import { getErrorMessage } from "../utils/error_utils.js";

export class AgentTools {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  _executeFindRoleByName(ctx, args) {
    const result = ctx.tools.findRoleByName(args.name);
    void this.runtime.log.debug("工具调用完成", { toolName: "find_role_by_name", ok: true });
    return result;
  }

  _executeGetOrgStructure(ctx, args) {
    const runtime = this.runtime;
    const org = ctx.org;
    const includeTerminated = Boolean(args?.includeTerminated);
    const persistedRoles = org ? org.listRoles() : [];
    const persistedAgents = org ? org.listAgents() : [];
    const agentMetaById = new Map();
    // agentMetaById.set("root", { id: "root", name: null });
    // agentMetaById.set("user", { id: "user", name: null });

    for (const a of persistedAgents) {
      if (!a || typeof a.id !== "string" || typeof a.roleId !== "string") continue;
      const status = a.status ?? "active";
      if (!includeTerminated && status === "deleted") continue;
      const computeStatus = runtime.getAgentComputeStatus?.(a.id) ?? "idle";
      agentMetaById.set(a.id, { id: a.id, name: a.name ?? null, status: computeStatus });
    }

    const selfAgentId = ctx.agent?.id ?? null;
    const self = selfAgentId
      ? {
          agentId: selfAgentId,
          roleId: ctx.agent?.roleId ?? null,
          roleName: ctx.agent?.roleName ?? null,
          agentName: agentMetaById.get(selfAgentId)?.name ?? null
        }
      : null;

    const workspaceKeyOf = (agentId) => {
      const ws = runtime.findWorkspaceIdForAgent(agentId);
      return ws ?? "null";
    };

    const roleNameByRoleId = new Map(persistedRoles.map((r) => [r.id, r.name]));
    const pushOrgRoleAgentId = (orgKey, roleId, agentId) => {
      let byRole = orgRoleAgentIdsByOrgKey.get(orgKey);
      if (!byRole) {
        byRole = new Map();
        orgRoleAgentIdsByOrgKey.set(orgKey, byRole);
      }
      const list = byRole.get(roleId);
      if (list) list.push(agentId);
      else byRole.set(roleId, [agentId]);
    };

    const orgRoleAgentIdsByOrgKey = new Map();
    pushOrgRoleAgentId(workspaceKeyOf("root"), "root", "root");
    pushOrgRoleAgentId(workspaceKeyOf("user"), "user", "user");
    for (const a of persistedAgents) {
      if (!a || typeof a.id !== "string" || typeof a.roleId !== "string") continue;
      const status = a.status ?? "active";
      if (!includeTerminated && status === "deleted") continue;
      pushOrgRoleAgentId(workspaceKeyOf(a.id), a.roleId, a.id);
    }

    // 补充没有智能体的岗位
    for (const role of persistedRoles) {
      if (!role || role.status === "deleted") continue;
      if (role.id === "root" || role.id === "user") continue;

      let orgKey = "null";
      if (role.createdBy) {
        orgKey = workspaceKeyOf(role.createdBy);
      } else {
        // 如果没有 createdBy，默认归属到 root 所在的组织
        orgKey = workspaceKeyOf("root");
      }

      let byRole = orgRoleAgentIdsByOrgKey.get(orgKey);
      if (!byRole) {
        byRole = new Map();
        orgRoleAgentIdsByOrgKey.set(orgKey, byRole);
      }

      // 如果该组织下还没有这个岗位，添加一个空列表
      if (!byRole.has(role.id)) {
        byRole.set(role.id, []);
      }
    }

    const buildOrg = (orgKey) => {
      const byRole = orgRoleAgentIdsByOrgKey.get(orgKey) ?? new Map();
      const orgRoleIds = Array.from(byRole.keys());
      const outRoles = orgRoleIds.map((roleId) => {
        const ids = byRole.get(roleId) ?? [];
        const name = roleId === "root" || roleId === "user" ? roleId : (roleNameByRoleId.get(roleId) ?? roleId);
        return {
          id: roleId,
          name,
          agents: ids.map((id) => {
            const meta = agentMetaById.get(id);
            return { id, name: meta?.name ?? null, status: meta?.status ?? "unknown" };
          })
        };
      });
      const agentIds = [];
      for (const ids of byRole.values()) {
        agentIds.push(...ids);
      }
      return {
        workspaceId: orgKey === "null" ? null : orgKey,
        agentCount: agentIds.length,
        roles: outRoles
      };
    };

    const selfOrgKey = selfAgentId ? workspaceKeyOf(selfAgentId) : "null";
    const selfOrg = buildOrg(selfOrgKey);
    const otherOrgs = Array.from(orgRoleAgentIdsByOrgKey.keys())
      .filter((k) => k !== selfOrgKey)
      .map((k) => buildOrg(k));

    void this.runtime.log.debug("工具调用完成", {
      toolName: "get_org_structure",
      ok: true,
      orgCount: 1 + otherOrgs.length,
      selfAgentId
    });

    return { self, selfOrg, otherOrgs };
  }

  async _executeCreateRole(ctx, args) {
    const runtime = this.runtime;
    const isRoot = ctx.agent?.id === "root";
    const taskId = ctx.currentMessage?.taskId ?? null;
    const isFromUser = ctx.currentMessage?.from === "user";

    // 复用逻辑
    if (isRoot && isFromUser && taskId) {
      const existingRoleId = runtime._rootTaskRoleByTaskId.get(taskId);
      if (existingRoleId) {
        const existing = runtime.org.getRole(existingRoleId);
        if (existing) {
          void runtime.log.debug("根智能体复用岗位（按 taskId）", { taskId, roleId: existingRoleId });
          return existing;
        }
      }
    }

    const existing = ctx.tools.findRoleByName(args.name);
    if (existing && existing.status !== "deleted") {
      if (isRoot && isFromUser && taskId) {
        runtime._rootTaskRoleByTaskId.set(taskId, existing.id);
      }
      void runtime.log.debug("工具调用完成", { toolName: "create_role", ok: true, reused: true });
      return existing;
    }

    const callerRoleId = ctx.agent?.roleId ?? null;
    const callerRole = callerRoleId ? runtime.org.getRole(callerRoleId) : null;

    // 优先使用用户明确指定的服务，其次模型选择器，最后才用继承的岗位模型
    const explicitLlmServiceId = typeof args.llmServiceId === "string" ? args.llmServiceId : null;
    let llmServiceId = explicitLlmServiceId ?? null;

    // 模型选择器作为主要 fallback
    if (!llmServiceId && runtime.modelSelector && (await runtime.serviceRegistry?.hasServices())) {
      try {
        const selectionResult = await runtime.modelSelector.selectService(args.rolePrompt);
        llmServiceId = selectionResult?.serviceId ?? null;
        if (llmServiceId) {
          void runtime.log.info("模型选择器选择了 LLM 服务", {
            roleName: args.name,
            llmServiceId,
            reason: selectionResult?.reason ?? null
          });
        }
      } catch (err) {
        void runtime.log.warn("模型选择失败，使用继承的岗位模型", {
          // 触发参数：哪个 agent 创建岗位时模型选择失败
          agentId: ctx.agent?.id ?? null,
          taskId: ctx.currentMessage?.taskId ?? null,
          roleName: args.name,
          explicitLlmServiceId,
          // 技术信息
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    }

    // 继承调用者岗位的模型作为最终保底
    if (!llmServiceId) {
      llmServiceId = callerRole?.llmServiceId ?? null;
    }

    const inheritedOrgPrompt = callerRole?.orgPrompt ?? null;
    const explicitOrgPrompt =(!isRoot)? null :
      typeof args.orgPrompt === "string"
        ? (args.orgPrompt.trim() ? args.orgPrompt : null)
        : undefined;
    const effectiveOrgPrompt = explicitOrgPrompt ? explicitOrgPrompt : inheritedOrgPrompt;

    // 处理 toolGroups：可能是字符串JSON或数组
    let toolGroups = args.toolGroups;
    void runtime.log.info("[CREATE_ROLE_PARSE] toolGroups 处理前", {
      toolGroupsRaw: args.toolGroups,
      toolGroupsType: typeof args.toolGroups
    });
    if (typeof toolGroups === "string") {
      try {
        toolGroups = JSON.parse(toolGroups);
        void runtime.log.info("[CREATE_ROLE_PARSE] toolGroups JSON.parse 成功", { toolGroups });
      } catch (e) {
        // 解析失败则视为 null
        void runtime.log.error("[CREATE_ROLE_PARSE] toolGroups JSON.parse 失败", {
          // 触发参数：哪个 agent 创建岗位时 toolGroups 解析失败
          agentId: ctx.agent?.id ?? null,
          taskId: ctx.currentMessage?.taskId ?? null,
          raw: args.toolGroups,
          // 技术信息
          error: e.message,
          stack: e.stack,
          name: e?.name,
          code: e?.code
        });
        toolGroups = null;
      }
    }
    // 确保是数组，否则设为 null
    if (toolGroups !== undefined && toolGroups !== null && !Array.isArray(toolGroups)) {
      toolGroups = null;
    }
    void runtime.log.info("[CREATE_ROLE_PARSE] toolGroups 处理后", { toolGroups });

    const result = await ctx.tools.createRole({
      name: args.name,
      rolePrompt: args.rolePrompt,
      orgPrompt: effectiveOrgPrompt,
      llmServiceId,
      toolGroups
    });

    if (isRoot && isFromUser && taskId) {
      runtime._rootTaskRoleByTaskId.set(taskId, result.id);
    }

    void runtime.log.debug("工具调用完成", { toolName: "create_role", ok: true, roleId: result?.id ?? null });
    return result;
  }

  async _executeDeleteRole(ctx, args) {
    const runtime = this.runtime;
    const callerId = ctx.agent?.id ?? null;
    const roleId = args?.roleId;

    if (!callerId) {
      return { error: "missing_caller_agent" };
    }

    if (!roleId || typeof roleId !== "string") {
      return { error: "missing_role_id" };
    }

    // 权限检查：只能删除自己创建的岗位
    const role = runtime.org.getRole(roleId);
    if (!role) {
      return { error: "role_not_found" };
    }

    // 严格遵守用户指令：只能删除自己创建的岗位
    // 如果 role.createdBy 缺失（旧数据），则禁止删除
    if (role.createdBy !== callerId) {
      void runtime.log.warn("delete_role 权限拒绝", {
        callerId,
        roleId,
        roleCreatedBy: role.createdBy
      });
      return {
        error: "permission_denied",
        message: `你没有权限删除此岗位。你只能删除你自己创建的岗位 (createdBy=${callerId})，而此岗位的创建者是 ${role.createdBy || "unknown"}。`
      };
    }

    void runtime.log.info("开始删除岗位", { callerId, roleId, reason: args.reason ?? null });

    try {
      const result = await runtime.deleteRole(roleId, callerId, args.reason);
      if (!result.ok) {
        return { error: result.error, message: "删除岗位失败" };
      }
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      void runtime.log.error("delete_role 执行失败", {
        // 触发参数：哪个 agent 删除哪个岗位时失败
        callerId,
        taskId: ctx.currentMessage?.taskId ?? null,
        roleId,
        // 技术信息
        error: message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return { error: "delete_role_failed", message };
    }
  }

  async _executeSpawnAgentWithTask(ctx, args) {
    const runtime = this.runtime;
    const creatorId = ctx.agent?.id ?? null;

    if (!creatorId) return { error: "missing_creator_agent" };

    // 【调试日志】记录原始参数
    void runtime.log.info("[SPAWN_AGENT_PARSE] 原始参数", {
      taskBriefRaw: args.taskBrief,
      taskBriefType: typeof args.taskBrief,
      initialMessageRaw: args.initialMessage,
      initialMessageType: typeof args.initialMessage,
      roleId: args.roleId
    });

    // 处理 taskBrief：如果大模型传的是 JSON 字符串，解析为对象
    let taskBrief = args.taskBrief;
    if (typeof taskBrief === "string") {
      try {
        taskBrief = JSON.parse(taskBrief);
        void runtime.log.info("[SPAWN_AGENT_PARSE] taskBrief JSON.parse 成功", { taskBrief });
      } catch (e) {
        void runtime.log.error("[SPAWN_AGENT_PARSE] taskBrief JSON.parse 失败", {
          // 触发参数：哪个 agent spawn 时 taskBrief 解析失败
          creatorId,
          taskId: ctx.currentMessage?.taskId ?? null,
          raw: args.taskBrief,
          // 技术信息
          error: e.message,
          stack: e.stack,
          name: e?.name,
          code: e?.code
        });
        return { error: "invalid_task_brief", message: "taskBrief 必须是有效的 JSON 对象" };
      }
    }

    // 处理 initialMessage：如果大模型传的是 JSON 字符串，解析为对象
    let initialMessage = args.initialMessage;
    if (typeof initialMessage === "string") {
      try {
        const parsed = JSON.parse(initialMessage);
        // 如果解析后是对象，用它；否则视为纯文本消息
        initialMessage = (parsed && typeof parsed === "object") ? parsed : { message_type: "task_assignment", text: initialMessage };
        void runtime.log.info("[SPAWN_AGENT_PARSE] initialMessage JSON.parse 成功", { initialMessage });
      } catch (e) {
        // 解析失败视为纯文本
        void runtime.log.info("[SPAWN_AGENT_PARSE] initialMessage JSON.parse 失败，视为纯文本", { error: e.message });
        initialMessage = { message_type: "task_assignment", text: initialMessage };
      }
    }

    void runtime.log.info("[SPAWN_AGENT_PARSE] 处理后参数", {
      taskBriefType: typeof taskBrief,
      initialMessageType: typeof initialMessage
    });

    if (!initialMessage) {
      return {
        error: "missing_initial_message",
        details: "创建智能体必须包含初始消息(initialMessage)，用于激活新智能体并告知其任务目标。请在参数中添加 initialMessage 字段，例如：{ message_type: 'task_assignment', text: '你的任务是...' } 或直接使用字符串 '你的任务是...'"
      };
    }

    const normalizedInitialMessage =
      typeof initialMessage === "string"
        ? { message_type: "task_assignment", text: initialMessage }
        : initialMessage;

    if (!normalizedInitialMessage || typeof normalizedInitialMessage !== "object") {
      return {
        error: "missing_initial_message",
        details: "创建智能体必须包含初始消息(initialMessage)，用于激活新智能体并告知其任务目标。请在参数中添加 initialMessage 字段，例如：{ message_type: 'task_assignment', text: '你的任务是...' } 或直接使用字符串 '你的任务是...'"
      };
    }
    if (typeof args.roleId !== "string" || !args.roleId.trim()) {
      return { error: "roleId_required" };
    }
    if (!runtime.org?.getRole?.(args.roleId)) {
      return { error: "role_not_found" };
    }

    // 验证 taskBrief 参数
    const taskBriefValidation = validateTaskBrief(taskBrief);
    if (!taskBriefValidation.valid) {
      return { error: "invalid_task_brief", details: taskBriefValidation.errors };
    }

    // 直接使用底层的 spawnAgentAs 方法创建智能体
    try {
      const agent = await runtime.spawnAgentAs(creatorId, {
        roleId: args.roleId,
        name: args.name || args.agentName || args.agent_name,
        taskBrief: taskBrief
      });

      const newAgentId = agent.id;
      const taskId = ctx.currentMessage?.taskId ?? null;

      // 发送任务消息
      const messagePayload = {
        message_type: normalizedInitialMessage.messageType || normalizedInitialMessage.message_type || "task_assignment",
        ...normalizedInitialMessage
      };

      const createdMeta = runtime.org?.getAgent?.(newAgentId) ?? null;
      const createdName = createdMeta && typeof createdMeta.name === "string" && createdMeta.name.trim() ? createdMeta.name.trim() : null;
      if (createdName && typeof messagePayload.text === "string") {
        messagePayload.text = `${messagePayload.text}\n\n【你的姓名】${createdName}`;
      }

      const sendResult = runtime.bus.send({
        to: newAgentId,
        from: creatorId,
        taskId,
        payload: messagePayload
      });

      // bus.send 被拒绝时需要回滚已创建的智能体
      if (sendResult?.rejected) {
        void runtime.log.warn("bus.send 被拒绝，回滚已创建的智能体", {
          creatorId,
          newAgentId,
          reason: sendResult.reason,
          taskId
        });
        await runtime._lifecycle.forceTerminateAgent(newAgentId, {
          deletedBy: creatorId,
          reason: `bus.send 被拒绝 (${sendResult.reason ?? "unknown"}) - 回滚`
        });
        return {
          error: "spawn_failed",
          message: `消息发送失败: ${sendResult.reason || "unknown"}`,
          agentId: newAgentId
        };
      }

      void runtime.log.info("spawn_agent_with_task 完成", {
        creatorId,
        newAgentId,
        roleId: agent.roleId,
        messageId: sendResult.messageId,
        taskId
      });

      return {
        id: newAgentId,
        name: createdName,
        roleId: agent.roleId,
        roleName: agent.roleName,
        messageId: sendResult.messageId
      };
    } catch (error) {
      void runtime.log.error("spawn_agent_with_task 失败", {
        creatorId,
        // 触发参数：创建 agent 时使用的 args
        roleId: args.roleId,
        taskBrief: typeof args.taskBrief === 'string' ? args.taskBrief.substring(0, 300) : String(args.taskBrief ?? '').substring(0, 300),
        initialMessage: typeof args.initialMessage === 'string' ? args.initialMessage.substring(0, 300) : null,
        toolGroups: args.toolGroups,
        // 技术信息
        error: error.message,
        stack: error.stack,
        name: error?.name,
        code: error?.code
      });
      return { error: "spawn_failed", message: error.message };
    }
  }

  _executeSendMessage(ctx, args) {
    const runtime = this.runtime;
    const senderId = ctx.agent?.id ?? "unknown";

    // 打印原始参数，用于调试
    void runtime.log.debug("send_message 工具调用参数", {
      senderId,
      argsType: typeof args,
      argsKeys: args ? Object.keys(args) : null,
      toType: typeof args?.to,
      toValue: args?.to,
      isToArray: Array.isArray(args?.to)
    });

    // 收件人参数必须是数组
    let rawTo = args?.to;
    if (rawTo !== undefined && !Array.isArray(rawTo)) {
      if(typeof(rawTo)=='string'){
        rawTo = [rawTo];
      }else{
        void runtime.log.error("send_message 参数类型错误", {
          // 业务信息：哪个 agent 在什么时候发送了什么格式的消息
          senderId,
          messageId: ctx.currentMessage?.id ?? null,
          taskId: ctx.currentMessage?.taskId ?? null,
          // 触发参数：to 的实际值和 payload 内容
          toType: typeof rawTo,
          toValue: rawTo,
          payloadText: typeof args?.payload?.text === 'string' ? args.payload.text.substring(0, 300) : null,
          argsKeys: args ? Object.keys(args).slice(0, 20) : null,
          // 技术信息
          message: "to 参数必须是数组"
        });
        return {
          error: "invalid_recipients_type",
          message: `to 参数必须是数组，收到类型: ${typeof rawTo}`
        };
      }
    }

    const recipientIds = rawTo ?? [];

    // 过滤空值并转为字符串
    const validRecipientIds = recipientIds
      .filter(id => id != null && id !== "")
      .map(id => String(id));

    if (validRecipientIds.length === 0) {
      return { error: "missing_recipients", message: "至少需要指定一个收件人" };
    }

    // 检查发送者是否已终止
    if (senderId !== "root" && senderId !== "user" && senderId !== "unknown") {
      const senderMeta = runtime.org?.getAgent?.(senderId);
      if (senderMeta && senderMeta.status === "deleted") {
        return { error: "sender_terminated" };
      }
    }

    // 兼容 payload / message / text 三种写法，避免旧提示词生成空白消息。
    const normalizedPayload = this._normalizeSendMessagePayload(args);
    if (!normalizedPayload) {
      return {
        error: "missing_payload",
        message: "send_message 需要提供 payload，或提供 message/text 字符串内容"
      };
    }

    // 消息验证
    const messageValidation = validateMessageFormat(normalizedPayload);
    if (!messageValidation.valid) {
      void runtime.log.warn("send_message 消息格式验证警告", {
        // 业务信息：哪个 agent 发出的消息未通过格式验证
        from: senderId,
        messageId: ctx.currentMessage?.id ?? null,
        taskId: ctx.currentMessage?.taskId ?? null,
        // 触发参数：消息内容和收件人
        payloadText: typeof normalizedPayload?.text === 'string' ? normalizedPayload.text.substring(0, 500) : null,
        recipientCount: validRecipientIds.length,
        recipients: validRecipientIds.slice(0, 20),
        // 技术信息：验证失败详情
        errors: messageValidation.errors,
        payloadKeys: Object.keys(normalizedPayload ?? {})
      });
    }

    // 验证 quickReplies 参数
    const quickRepliesValidation = this._validateQuickReplies(args.quickReplies);
    if (!quickRepliesValidation.valid) {
      return {
        error: quickRepliesValidation.error,
        message: quickRepliesValidation.message
      };
    }

    // 构建最终的 payload，如果有有效的 quickReplies 则添加到 payload 中
    let finalPayload = normalizedPayload;
    if (quickRepliesValidation.quickReplies) {
      finalPayload = {
        ...normalizedPayload,
        quickReplies: quickRepliesValidation.quickReplies
      };
    }

    const currentTaskId = ctx.currentMessage?.taskId ?? null;

    // 循环处理每个收件人
    const results = [];
    const errors = [];

    for (const recipientId of validRecipientIds) {
      // 验证收件人
      const isRecipientSpecial = recipientId === "root" || recipientId === "user";
      if (!isRecipientSpecial && !runtime._agents.has(recipientId)) {
        errors.push({ recipient: recipientId, error: "unknown_recipient" });
        continue;
      }

      // 发送消息
      const result = ctx.tools.sendMessage({
        to: recipientId,
        from: senderId,
        taskId: currentTaskId,
        payload: finalPayload,
        delayMs: args.delayMs
      });

      results.push({ recipient: recipientId, messageId: result.messageId });

      void runtime._agentManager.logLifecycleEvent("agent_message_sent", {
        agentId: senderId,
        messageId: result.messageId,
        to: recipientId,
        taskId: currentTaskId,
        delayMs: args.delayMs ?? null
      });
    }

    // 返回结果
    if (errors.length > 0 && results.length === 0) {
      // 全部失败
      return {
        error: "all_recipients_failed",
        errors,
        successCount: 0,
        failedCount: errors.length
      };
    }

    // 部分或全部成功
    const result = {
      success: true,
      messageCount: results.length,
      recipients: results.map(r => r.recipient),
      messageIds: results.map(r => r.messageId)
    };

    if (errors.length > 0) {
      result.partialErrors = errors;
      result.failedCount = errors.length;
    }

    return result;
  }

  /**
   * 规范化 send_message 的消息体参数。
   *
   * 设计说明：
   * - 运行时历史提示词和模型习惯里，既出现过 payload，也出现过 message/text；
   * - 前端空白消息问题就是因为模型传了 message，但执行层只读取 payload；
   * - 这里统一收敛成 payload，避免旧数据和旧提示词继续丢正文。
   *
   * @param {any} args - send_message 原始参数
   * @returns {object|null} 标准化后的 payload；缺失内容时返回 null
   */
  _normalizeSendMessagePayload(args) {
    const payload = args?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload;
    }

    const rawText = typeof args?.message === "string"
      ? args.message
      : typeof args?.text === "string"
        ? args.text
        : null;

    if (rawText === null) {
      return null;
    }

    return { text: rawText };
  }

  /**
   * 验证 quickReplies 参数
   *
   * @param {any} quickReplies - 快速回复选项
   * @returns {{valid: boolean, quickReplies?: string[], error?: string, message?: string}}
   */
  _validateQuickReplies(quickReplies) {
    // 未提供或空数组，视为有效但忽略
    if (!quickReplies || !Array.isArray(quickReplies) || quickReplies.length === 0) {
      return { valid: true, quickReplies: null };
    }

    // 超过10个则截取前10个，保证业务继续执行
    let processedQuickReplies = quickReplies;
    if (quickReplies.length > 10) {
      processedQuickReplies = quickReplies.slice(0, 10);
    }

    // 元素类型检查
    for (let i = 0; i < processedQuickReplies.length; i++) {
      const item = processedQuickReplies[i];
      if (typeof item !== "string") {
        return {
          valid: false,
          error: "quickReplies_invalid_type",
          message: `快速回复选项[${i}]必须是字符串`
        };
      }
      if (item.trim() === "") {
        return {
          valid: false,
          error: "quickReplies_empty_string",
          message: `快速回复选项[${i}]不能为空`
        };
      }
    }

    return { valid: true, quickReplies: processedQuickReplies };
  }

  async _executeDeleteAgent(ctx, args) {
    const result = await this.runtime._executeDeleteAgent(ctx, args);
    void this.runtime.log.debug("工具调用完成", { toolName: "delete_agent", ok: !result.error });
    return result;
  }

  async _executeSetOrgName(ctx, args) {
    const runtime = this.runtime;
    const callerId = ctx.agent?.id ?? null;

    if (callerId !== "root") {
      void runtime.log.warn("set_org_name 权限拒绝：非root调用", { callerId });
      return { error: "permission_denied", message: "只有 root 智能体可以设置组织名称" };
    }

    const agentId = args?.agentId;
    const orgName = args?.orgName;

    if (!agentId || typeof agentId !== "string") {
      return { error: "missing_agent_id", message: "必须提供 agentId 参数" };
    }
    if (!orgName || typeof orgName !== "string") {
      return { error: "missing_org_name", message: "必须提供 orgName 参数" };
    }

    // 验证 agentId 是 root 的直接子智能体
    const agent = runtime.org.getAgent(agentId);
    if (!agent) {
      return { error: "agent_not_found", message: `智能体 ${agentId} 不存在` };
    }
    if (agent.parentAgentId !== "root") {
      return { error: "not_direct_child", message: `智能体 ${agentId} 不是 root 的直接子智能体` };
    }

    try {
      await runtime.org.setOrgName(agentId, orgName);
      void runtime.log.info("set_org_name 完成", { callerId, agentId, orgName });
      return { ok: true, agentId, orgName };
    } catch (err) {
      void runtime.log.error("set_org_name 执行失败", {
        callerId,
        agentId,
        orgName,
        error: err.message,
        stack: err.stack,
        name: err?.name,
        code: err?.code
      });
      return { error: "set_org_name_failed", message: err.message };
    }
  }

  _executeListToolGroups(_ctx) {
    const groups = this.runtime.toolGroupManager.listGroups();
    return { toolGroups: groups };
  }

  async _executeUpdateMyToolGroups(ctx, args = {}) {
    if (!ctx.agent) return { error: "missing_agent_context" };

    const agentId = ctx.agent.id;
    const meta = this.runtime._agentMetaById?.get(agentId);
    if (!meta) return { error: "agent_meta_not_found" };

    const role = this.runtime.org?.getRole(meta.roleId);
    if (!role) return { error: "role_not_found" };

    const toolGroups = args.toolGroups;
    if (Array.isArray(toolGroups) && toolGroups.length > 0) {
      const validIds = this.runtime.toolGroupManager.getAllGroupIds();
      const invalid = toolGroups.filter(id => !validIds.includes(id));
      if (invalid.length > 0) {
        return { error: "invalid_tool_groups", message: `无效的工具组: ${invalid.join(", ")}` };
      }
    }

    const normalized = Array.isArray(toolGroups) && toolGroups.length > 0 ? toolGroups : null;
    const updated = await this.runtime.org.updateRole(role.id, { toolGroups: normalized });
    return { ok: true, roleId: role.id, toolGroups: updated?.toolGroups ?? normalized };
  }
}
