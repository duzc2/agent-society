/**
 * GroupChatService — 群聊服务（DI 注册）
 *
 * 职责：
 * - 群生命周期管理（创建、解散、成员管理）
 * - 群消息扇出（fan-out 到成员个人队列）
 * - 成员变动通知（群内系统消息）
 * - 通过心跳广播 group_message / group_event
 *
 * 设计原则：
 * - 通过 ModuleRegistry DI 获取所有依赖，不依赖 runtime
 * - 构造函数接收 deps 对象，不接收 runtime
 */

import { registry } from "../../core/module_registry.js";
import { GroupRegistry } from "./group_registry.js";
import { GroupMessageStore } from "./group_message_store.js";
import { formatGroupMessageForAgent, formatGroupSystemMessageForAgent } from "../../utils/message/group_message_formatter.js";
import path from "node:path";

export class GroupChatService {
  /**
   * @param {object} deps - DI 注入的依赖
   * @param {object} deps.bus - MessageBus 实例
   * @param {object} deps.heartbeatBroker - HeartbeatBroker 实例
   * @param {object} deps.org - OrgPrimitives 实例
   * @param {object} deps.runtimeEvents - RuntimeEvents 实例
   * @param {object} deps.logRoot - 日志根
   * @param {string} deps.dataDir - 数据目录
   * @param {string} deps.runtimeDir - 运行时目录
   */
  constructor({ bus, heartbeatBroker, org, runtimeEvents, logRoot, dataDir, runtimeDir, runtimeLlm }) {
    this.bus = bus;
    this.heartbeatBroker = heartbeatBroker;
    this.org = org;
    this.runtimeEvents = runtimeEvents;
    this.runtimeLlm = runtimeLlm;
    this.log = logRoot.forModule("group_chat");

    /** @type {GroupRegistry} */
    this.registry = new GroupRegistry({
      dataDir: path.join(dataDir, "runtime", "state"),
      logger: this.log
    });

    /** @type {GroupMessageStore} */
    this.messageStore = new GroupMessageStore({
      messagesDir: path.join(runtimeDir, "web", "messages", "groups"),
      logger: this.log
    });
  }

  /**
   * 初始化：加载群元数据，注册事件监听。
   */
  async init() {
    await this.registry.load();
    await this.messageStore.init();

    // 启动对账：清理旧数据（已删除智能体退群、不足 3 人的群解散）；archived 群不做检查
    await this._reconcileGroupsOnStartup();

    // 监听智能体终止事件，自动清理群成员身份
    this.runtimeEvents.onAgentTerminated((event) => {
      void this._onAgentTerminated(event.agentId);
    });

    // 注册群消息格式化器：成员收到的消息带 extras.senderAgentId（群身份来自 from=群ID）
    this.runtimeLlm.registerMessageFormatter(
      (message) => message?.extras?.senderAgentId != null,
      (message, getSenderInfo) => {
        if (message.extras.senderAgentId === "system") {
          return formatGroupSystemMessageForAgent(message);
        }
        return formatGroupMessageForAgent(message, getSenderInfo(message.extras.senderAgentId));
      }
    );

    this.log.info("[GroupChatService] 群聊服务初始化完成", {
      groupCount: this.registry.list("active").length
    });
  }

  // ===========================================================================
  // 群消息发送
  // ===========================================================================

  /**
   * 发送群消息（扇出到所有成员）。
   * @param {object} params
   * @param {string} params.from - 发送者 ID
   * @param {string} params.groupId - 群 ID
   * @param {object} params.payload - 消息内容
   * @param {string} [params.taskId] - 关联任务 ID
   * @returns {object} 发送结果
   */
  async sendGroupMessage({ from, groupId, payload, taskId }) {
    const group = this.registry.get(groupId);
    if (!group) {
      return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    }
    if (group.status !== "active") {
      return { error: "group_archived", message: `群 ${groupId} 已解散` };
    }

    const isMember = group.members.includes(from);
    const isUser = from === "user";
    if (!isMember && !isUser) {
      return { error: "not_member", message: `你不是群 ${groupId} 的成员` };
    }

    // 创建群消息（只存储发送者 ID，前端通过 ID 匹配名称）
    const groupMessage = this.messageStore.createMessage({
      kind: "group",
      groupId,
      from,
      taskId: taskId ?? null,
      payload
    });

    // 写入群历史
    await this.messageStore.append(groupId, groupMessage);

    // 更新群最后消息
    const preview = (payload.text || payload.content || "").slice(0, 100);
    await this.registry.updateLastMessage(groupId, preview);

    // 心跳广播群消息（单数 message，匹配前端 data.message）
    this.heartbeatBroker.broadcast("group_message", {
      groupId,
      message: groupMessage
    });

    // 扇出到所有成员（user 不接收扇出，但可以发消息）
    const groupName = group.name;
    const members = group.members.filter(m => m !== "user");
    const results = [];
    for (const memberId of members) {
      const result = this.bus.send({
        to: memberId,
        // 以群身份通知成员：from = 群ID，原发送者与群名在 extras 中描述
        from: groupId,
        payload,
        taskId: taskId ?? null,
        extras: { groupName, senderAgentId: from, skipSenderCopy: true }
      });
      results.push({ memberId, messageId: result.messageId });
    }

    this.log.info("[GroupChatService] 群消息已发送", {
      groupId,
      from,
      memberCount: members.length,
      messageId: groupMessage.id
    });

    return {
      messageId: groupMessage.id,
      recipients: members.length,
      createdAt: groupMessage.createdAt
    };
  }

  // ===========================================================================
  // 群生命周期
  // ===========================================================================

  /**
   * 创建群聊。
   * 所有成员平等，无群主概念。创建者只是普通成员之一。
   * @param {object} params
   * @param {string} params.name - 群名
   * @param {string} params.actorId - 创建者 ID（用于系统消息，不存储为 owner）
   * @param {string[]} params.memberIds - 初始成员列表（仅智能体，不含 root/user）
   * @param {string} [params.description] - 群描述
   * @param {string} params.reason - 拉群原因（必填）
   * @returns {object} 创建结果
   */
  async createGroup({ name, actorId, memberIds, description, reason }) {
    // 去重
    const allMembers = [...new Set(memberIds)];

    // root 和 user 不能成为群成员
    const forbiddenIds = allMembers.filter(id => id === "root" || id === "user");
    if (forbiddenIds.length > 0) {
      return { error: "invalid_members", message: "root 和 user 不能加入群聊" };
    }

    // 至少需要 3 个成员
    if (allMembers.length < 3) {
      return { error: "too_few_members", message: "群聊至少需要 3 个成员" };
    }

    // 校验成员存在性
    const invalidMembers = allMembers.filter(id => {
      const agent = this.org.getAgent(id);
      if (!agent) return true;
      return agent.status === "terminated";
    });

    if (invalidMembers.length > 0) {
      return {
        error: "invalid_members",
        message: `以下智能体不存在或不可用：${invalidMembers.join(", ")}`
      };
    }

    // 拉群原因（必填）
    const reasonText = (reason && String(reason).trim()) ? String(reason).trim() : "";
    if (!reasonText) {
      return { error: "missing_reason", message: "请提供拉群原因" };
    }

    const group = await this.registry.create({
      name,
      members: allMembers,
      description
    });

    // 系统消息：列出所有成员 + 原因
    const memberNames = allMembers.map(id => {
      const agent = this.org.getAgent(id);
      return agent ? agent.name : id;
    });
    const memberListText = memberNames.join("、");
    const actorName = actorId === "user" ? "用户" : (() => {
      const agent = this.org.getAgent(actorId);
      return agent ? agent.name : actorId;
    })();

    const sysMsg = this.messageStore.createSystemMessage(
      group.id,
      `${actorName} 创建了群聊「${group.name}」，群成员：${memberListText}。拉群原因：${reasonText}`
    );
    await this.messageStore.append(group.id, sysMsg);

    // 心跳广播群事件（匹配前端 data.action = "group_created"）
    this.heartbeatBroker.broadcast("group_event", {
      groupId: group.id,
      action: "group_created",
      actorId,
      group: this._serializeGroup(group)
    });

    // 通知所有成员
    const notifyText =
      `【群聊 ${group.name}】${actorName} 创建了群聊，群成员：${memberListText}。` +
      `拉群原因：${reasonText}`;
    for (const memberId of allMembers) {
      this.bus.send({
        to: memberId,
        // 以群身份通知成员（系统通知）
        from: group.id,
        payload: { text: notifyText },
        extras: { groupName: group.name, senderAgentId: "system", skipSenderCopy: true }
      });
    }

    this.log.info("[GroupChatService] 群聊已创建", {
      groupId: group.id,
      name: group.name,
      actorId,
      memberCount: allMembers.length,
      reason: reasonText
    });

    return { group: this._serializeGroup(group) };
  }

  /**
   * 邀请成员加入群聊。
   * 所有群成员都可以邀请他人（无群主概念）；user（用户端点智能体）操作同样放行。
   * @param {object} params
   * @param {string} params.groupId - 群 ID
   * @param {string} params.actorId - 操作者
   * @param {string[]} params.memberIds - 要邀请的成员
   * @param {string} params.reason - 拉群原因（必填）
   * @returns {object}
   */
  async inviteToGroup({ groupId, actorId, memberIds, reason }) {
    const group = this.registry.get(groupId);
    if (!group) return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    if (group.status !== "active") return { error: "group_archived", message: "群已解散" };

    // 所有群成员都可以邀请；user（用户端点智能体）操作同样放行
    if (!group.members.includes(actorId) && actorId !== "user") {
      return { error: "not_member", message: "只有群成员可以邀请他人" };
    }

    // root 和 user 不能加入群
    const forbiddenIds = memberIds.filter(id => id === "root" || id === "user");
    if (forbiddenIds.length > 0) {
      return { error: "invalid_members", message: "root 和 user 不能加入群聊" };
    }

    const newMembers = memberIds.filter(id => !group.members.includes(id));
    if (newMembers.length === 0) {
      return { error: "no_new_members", message: "所有指定成员已在群中" };
    }

    // 拉群原因（必填）
    const reasonText = (reason && String(reason).trim()) ? String(reason).trim() : "";
    if (!reasonText) {
      return { error: "missing_reason", message: "请提供拉群原因" };
    }

    await this.registry.addMembers(groupId, newMembers);

    // 系统消息
    const actorName = actorId === "user" ? "用户" : (() => {
      const agent = this.org.getAgent(actorId);
      return agent ? agent.name : actorId;
    })();
    const newMemberNames = newMembers.map(id => {
      const agent = this.org.getAgent(id);
      return agent ? agent.name : id;
    }).join("、");
    const sysMsg = this.messageStore.createSystemMessage(
      groupId,
      `${actorName} 邀请 ${newMemberNames} 加入群聊。拉群原因：${reasonText}`
    );
    await this.messageStore.append(groupId, sysMsg);

    // 心跳广播
    const updatedGroup = this.registry.get(groupId);
    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_updated",
      actorId,
      memberIds: newMembers,
      group: this._serializeGroup(updatedGroup)
    });

    // 通知所有成员
    const allMembers = group.members.filter(m => m !== "user");
    const fullMemberNames = group.members.map(id => {
      const agent = this.org.getAgent(id);
      return agent ? agent.name : id;
    }).join("、");
    const notifyText =
      `【群聊 ${group.name}】${actorName} 邀请 ${newMemberNames} 加入群聊。` +
      `当前群成员：${fullMemberNames}。拉群原因：${reasonText}`;
    for (const memberId of allMembers) {
      this.bus.send({
        to: memberId,
        // 以群身份通知成员（系统通知）
        from: groupId,
        payload: { text: notifyText },
        extras: { groupName: group.name, senderAgentId: "system", skipSenderCopy: true }
      });
    }

    return { group: this._serializeGroup(updatedGroup) };
  }

  /**
   * 退出群聊。
   * 任何成员都可以随时退群。
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.actorId
   * @returns {object}
   */
  async leaveGroup({ groupId, actorId }) {
    const group = this.registry.get(groupId);
    if (!group) return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    if (group.status !== "active") return { error: "group_archived", message: "群已解散" };
    if (!group.members.includes(actorId)) return { error: "not_member", message: "你不在此群中" };

    await this.registry.removeMembers(groupId, [actorId], "left");

    // 系统消息
    const actorName = (() => {
      const agent = this.org.getAgent(actorId);
      return agent ? agent.name : actorId;
    })();
    const sysMsg = this.messageStore.createSystemMessage(groupId, `${actorName} 退出了群聊`);
    await this.messageStore.append(groupId, sysMsg);

    // 心跳广播
    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_updated",
      actorId,
      group: this._serializeGroup(this.registry.get(groupId))
    });

    // 退群后若剩余 < 3 人，自动解散
    this._autoDissolveIfSmall(groupId);

    return { group: this._serializeGroup(this.registry.get(groupId)) };
  }

  /**
   * 解散群聊。
   * 任何群成员都可以解散群；user（用户端点智能体）操作同样放行。
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.actorId
   * @returns {object}
   */
  async dissolveGroup({ groupId, actorId }) {
    const group = this.registry.get(groupId);
    if (!group) return { error: "group_not_found", message: `群 ${groupId} 不存在` };

    // 群成员可以解散群；user（用户端点智能体）操作同样放行
    if (!group.members.includes(actorId) && actorId !== "user") {
      return { error: "not_member", message: "只有群成员可以解散群" };
    }

    await this.registry.archive(groupId);

    // 系统消息
    const actorName = actorId === "user" ? "用户" : (() => {
      const agent = this.org.getAgent(actorId);
      return agent ? agent.name : actorId;
    })();
    const sysMsg = this.messageStore.createSystemMessage(groupId, `群聊已被 ${actorName} 解散`);
    await this.messageStore.append(groupId, sysMsg);

    // 心跳广播
    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_dissolved",
      actorId,
      group: this._serializeGroup(this.registry.get(groupId))
    });

    return { group: this._serializeGroup(this.registry.get(groupId)) };
  }

  /**
   * 群成员数 < 3 时自动解散。
   * @param {string} groupId
   */
  async _autoDissolveIfSmall(groupId) {
    const group = this.registry.get(groupId);
    if (!group || group.status !== "active") return;

    const realMembers = group.members.filter(m => m !== "user");
    if (realMembers.length >= 3) return;

    await this.registry.archive(groupId);

    const sysMsg = this.messageStore.createSystemMessage(groupId, "群聊成员不足 3 人，已自动解散");
    await this.messageStore.append(groupId, sysMsg);

    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_dissolved",
      actorId: "system",
      group: this._serializeGroup(this.registry.get(groupId)),
      reason: "too_few_members"
    });

    this.log.info("[GroupChatService] 群聊已自动解散（成员不足）", {
      groupId,
      name: group.name,
      memberCount: realMembers.length
    });
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  /**
   * 获取所有群列表。
   * @returns {object[]}
   */
  listGroups() {
    // 返回全部群（含 archived）：前端按 status 分组展示"活跃/已解散"
    return this.registry.list().map(g => this._serializeGroup(g));
  }

  /**
   * 获取指定智能体所在的群列表。
   * @param {string} agentId
   * @returns {object[]}
   */
  listMyGroups(agentId) {
    return this.registry.listByMember(agentId).map(g => this._serializeGroup(g));
  }

  /**
   * 获取群完整信息。
   * HTTP 接口均为 user 操作，无需 callerId 权限校验。
   * @param {string} groupId
   * @returns {object|null}
   */
  getGroupInfo(groupId) {
    const group = this.registry.get(groupId);
    if (!group) return null;

    return this._serializeGroup(group, { includeMembers: true });
  }

  /**
   * 获取群聊消息历史。
   * @param {string} groupId
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {{ messages: GroupMessage[], hasMore: boolean }}
   */
  getGroupMessages(groupId, options = {}) {
    const limit = options.limit || 200;
    const offset = options.offset || 0;
    const allMessages = this.messageStore.getMessages(groupId);
    const messages = allMessages.slice(offset, offset + limit);
    const hasMore = offset + limit < allMessages.length;
    return { groupId, messages, hasMore };
  }

  /**
   * 加载群消息历史到内存。
   * @param {string} groupId
   * @returns {Promise<GroupMessage[]>}
   */
  async loadGroupMessages(groupId) {
    return this.messageStore.loadMessages(groupId);
  }

  /**
   * 编辑群消息（HTTP = user 操作，仅修改群历史规范副本，成员个人副本为不可变日志）。
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.messageId
   * @param {object} params.payload - 新内容（{ text }）
   * @returns {object}
   */
  async updateGroupMessage({ groupId, messageId, payload }) {
    const group = this.registry.get(groupId);
    if (!group) return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    if (group.status !== "active") return { error: "group_archived", message: "群已解散" };

    const text = (payload?.text && String(payload.text).trim()) ? String(payload.text).trim() : "";
    if (!text) {
      return { error: "missing_content", message: "消息内容不能为空" };
    }

    // 缓存可能未加载（重启后首次操作），先加载磁盘历史
    await this.loadGroupMessages(groupId);

    const updated = await this.messageStore.update(groupId, messageId, { text });
    if (!updated) {
      return { error: "message_not_found", message: `群消息 ${messageId} 不存在` };
    }

    // 若编辑的是最后一条消息，同步群列表预览
    const all = this.messageStore.getMessages(groupId);
    if (all.length > 0 && all[all.length - 1].id === messageId) {
      await this.registry.updateLastMessage(groupId, text.slice(0, 100));
    }

    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_updated",
      actorId: "user",
      group: this._serializeGroup(group)
    });

    this.log.info("[GroupChatService] 群消息已编辑", { groupId, messageId });
    return { ok: true, message: updated };
  }

  /**
   * 删除群消息（HTTP = user 操作，仅删除群历史规范副本）。
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.messageId
   * @returns {object}
   */
  async deleteGroupMessage({ groupId, messageId }) {
    const group = this.registry.get(groupId);
    if (!group) return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    if (group.status !== "active") return { error: "group_archived", message: "群已解散" };

    // 缓存可能未加载（重启后首次操作），先加载磁盘历史
    await this.loadGroupMessages(groupId);

    const removed = await this.messageStore.remove(groupId, messageId);
    if (!removed) {
      return { error: "message_not_found", message: `群消息 ${messageId} 不存在` };
    }

    // 预览回滚：取剩余最后一条的文本，全删则置空
    const all = this.messageStore.getMessages(groupId);
    const last = all[all.length - 1];
    await this.registry.updateLastMessage(
      groupId,
      last ? String(last.payload?.text || "").slice(0, 100) : ""
    );

    this.heartbeatBroker.broadcast("group_event", {
      groupId,
      action: "group_updated",
      actorId: "user",
      group: this._serializeGroup(group)
    });

    this.log.info("[GroupChatService] 群消息已删除", { groupId, messageId });
    return { ok: true };
  }

  /**
   * 获取群摘要（用于 get_org_structure）。
   * @param {string} callerId
   * @returns {object[]}
   */
  getGroupSummaries(callerId) {
    return this.registry.list("active").map(g => ({
      id: g.id,
      name: g.name,
      memberCount: g.members.length,
      isMember: g.members.includes(callerId)
    }));
  }

  // ===========================================================================
  // 内部辅助
  // ===========================================================================

  /**
   * 序列化群对象（用于 API 返回）。
   * @param {object} group - 群元数据
   * @param {object} [opts]
   * @param {boolean} [opts.includeMembers] - 是否包含成员详情
   * @returns {object}
   */
  _serializeGroup(group, opts = {}) {
    const base = {
      id: group.id,
      name: group.name,
      description: group.description,
      memberCount: group.members.length,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      lastMessageAt: group.lastMessageAt,
      lastMessagePreview: group.lastMessagePreview,
      status: group.status
    };

    if (opts.includeMembers) {
      base.members = group.members.map(id => {
        const agent = this.org.getAgent(id);
        return {
          id,
          name: agent ? agent.name : id,
          status: agent ? agent.status : "unknown"
        };
      });
      // 已退出成员记录（前端按 status 分入"已退出成员"归档组）
      const exited = group.exitedMembers ?? [];
      for (const e of exited) {
        const agent = this.org.getAgent(e.id);
        base.members.push({
          id: e.id,
          name: agent ? agent.name : e.id,
          status: e.reason === "terminated" ? "terminated" : "left"
        });
      }
    }

    return base;
  }

  /**
   * 启动对账（旧数据处理）：
   * - 仍然 active 的群里，已删除/已终止的智能体退群（留存 exitedMembers 记录）
   * - 清理后不足 3 人的群自动解散
   * - archived 群不做检查
   */
  async _reconcileGroupsOnStartup() {
    const groups = this.registry.list("active");
    let leftCount = 0;
    let dissolvedCount = 0;

    for (const group of groups) {
      // 1. 群里已删除的智能体退群
      const deadIds = group.members.filter(id => {
        const agent = this.org.getAgent(id);
        return !agent || agent.status === "terminated" || agent.status === "deleted";
      });
      for (const id of deadIds) {
        const agent = this.org.getAgent(id);
        const name = agent ? agent.name : id;
        await this.registry.removeMembers(group.id, [id], "terminated");
        const sysMsg = this.messageStore.createSystemMessage(group.id, `${name} 已离线，自动退出群聊`);
        await this.messageStore.append(group.id, sysMsg);
        leftCount++;
      }

      // 2. 清理后剩余成员不足 3 人 → 解散
      const current = this.registry.get(group.id);
      if (current && current.status === "active") {
        const realMembers = current.members.filter(m => m !== "user");
        if (realMembers.length < 3) {
          await this._autoDissolveIfSmall(group.id);
          dissolvedCount++;
        }
      }
    }

    if (leftCount > 0 || dissolvedCount > 0) {
      this.log.info("[GroupChatService] 启动对账完成", { leftCount, dissolvedCount });
    }
  }

  /**
   * 智能体终止事件处理：自动清理群成员身份。
   * @param {string} agentId
   */
  async _onAgentTerminated(agentId) {
    try {
      const groups = this.registry.listByMember(agentId);
      for (const group of groups) {
        const agent = this.org.getAgent(agentId);
        const agentName = agent ? agent.name : agentId;
        await this.registry.removeMembers(group.id, [agentId], "terminated");

        const sysMsg = this.messageStore.createSystemMessage(group.id, `${agentName} 已离线，自动退出群聊`);
        await this.messageStore.append(group.id, sysMsg);

        this.heartbeatBroker.broadcast("group_event", {
          groupId: group.id,
          action: "group_updated",
          actorId: agentId,
          group: this._serializeGroup(this.registry.get(group.id))
        });

        // 退群后检查是否需要自动解散
        this._autoDissolveIfSmall(group.id);
      }

      if (groups.length > 0) {
        this.log.info("[GroupChatService] 已终止智能体，自动退群", {
          agentId,
          groupCount: groups.length
        });
      }
    } catch (err) {
      this.log.error("[GroupChatService] 清理已终止智能体群成员失败", {
        agentId,
        message: err.message,
        stack: err.stack
      });
    }
  }
}

// ===========================================================================
// DI 注册
// ===========================================================================

registry.declare({
  name: "group-chat-service",
  requires: ["bus", "heartbeatBroker", "org", "runtimeEvents", "logRoot", "dataDir", "runtimeDir", "runtimeLlm"],
  provides: ["groupChatService"],
  async init(deps) {
    const service = new GroupChatService(deps);
    await service.init();
    return { groupChatService: service };
  }
});