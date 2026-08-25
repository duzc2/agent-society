/**
 * 群聊工具实现（DI 注册）
 *
 * 职责：
 * - 实现群聊工具执行逻辑
 * - 通过 DI 获取 groupChatService
 *
 * 在 tool_executor.js 中以副作用 import 触发注册。
 * 工具 schema 定义在 tools_schema.js 中。
 */

import { registry } from "../core/module_registry.js";

/**
 * 群聊工具实现集合。
 * 每个方法签名：execute(ctx, args) => result
 */
export class GroupTools {
  /**
   * @param {object} deps
   * @param {object} deps.groupChatService - GroupChatService 实例
   * @param {object} deps.bus - MessageBus 实例
   * @param {object} deps.org - OrgPrimitives 实例
   */
  constructor({ groupChatService, bus, org }) {
    this.svc = groupChatService;
    this.bus = bus;
    this.org = org;
  }

  /**
   * 创建群聊。
   */
  createGroup(ctx, args) {
    const { name, memberIds, description, reason } = args;
    if (!name || typeof name !== "string" || !name.trim()) {
      return { error: "invalid_name", message: "群名不能为空" };
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return { error: "no_members", message: "至少需要指定一个成员" };
    }
    return this.svc.createGroup({
      name: name.trim(),
      actorId: ctx.agent.id,
      memberIds,
      description: description || "",
      reason: reason || ""
    });
  }

  /**
   * 发送群消息。
   */
  sendGroupMessage(ctx, args) {
    const { groupId, payload } = args;
    if (!groupId) {
      return { error: "missing_groupId", message: "请指定群 ID" };
    }
    return this.svc.sendGroupMessage({
      from: ctx.agent.id,
      groupId,
      payload: payload || {},
      taskId: ctx.currentMessage ? ctx.currentMessage.taskId : null
    });
  }

  /**
   * 邀请成员加入群聊。所有群成员都可以邀请。
   */
  inviteToGroup(ctx, args) {
    const { groupId, memberIds, reason } = args;
    if (!groupId) return { error: "missing_groupId", message: "请指定群 ID" };
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return { error: "no_members", message: "请指定要邀请的成员" };
    }
    return this.svc.inviteToGroup({
      groupId,
      actorId: ctx.agent.id,
      memberIds,
      reason: reason || ""
    });
  }

  /**
   * 退出群聊。
   */
  leaveGroup(ctx, args) {
    const { groupId } = args;
    if (!groupId) return { error: "missing_groupId", message: "请指定群 ID" };
    return this.svc.leaveGroup({
      groupId,
      actorId: ctx.agent.id
    });
  }

  /**
   * 解散群聊。所有群成员都可以解散。
   */
  dissolveGroup(ctx, args) {
    const { groupId } = args;
    if (!groupId) return { error: "missing_groupId", message: "请指定群 ID" };
    return this.svc.dissolveGroup({
      groupId,
      actorId: ctx.agent.id
    });
  }

  /**
   * 查看群详情。
   */
  getGroupInfo(ctx, args) {
    const { groupId } = args;
    if (!groupId) return { error: "missing_groupId", message: "请指定群 ID" };
    const result = this.svc.getGroupInfo(groupId);
    if (!result) return { error: "group_not_found", message: `群 ${groupId} 不存在` };
    return result;
  }

  /**
   * 列出我所在的群。
   */
  listMyGroups(ctx) {
    const agentId = ctx.agent.id;
    return { groups: this.svc.listMyGroups(agentId) };
  }
}

// ===========================================================================
// DI 注册
// ===========================================================================

registry.declare({
  name: "group-tools",
  requires: ["groupChatService", "bus", "org"],
  provides: ["groupTools"],
  async init(deps) {
    const tools = new GroupTools(deps);
    return { groupTools: tools };
  }
});