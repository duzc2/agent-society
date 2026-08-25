/**
 * 群聊 HTTP 路由（DI 注册）
 *
 * 职责：
 * - 提供群聊 REST API
 * - 群消息历史查询、群消息发送
 * - 群元数据查询
 *
 * 所有 HTTP 接口均为 user 操作，智能体通过工具函数操作群聊。
 * 在 http_server/index.js 中以副作用 import 触发注册。
 */

import { registry } from "../../core/module_registry.js";

/**
 * @param {object} deps
 * @param {object} deps.app - Hono 应用实例
 * @param {object} deps.groupChatService - GroupChatService 实例
 * @param {object} deps.log - 日志
 */
async function registerGroupRoutes({ app, groupChatService, log }) {

  /**
   * GET /api/groups — 获取所有群列表
   */
  app.get("/api/groups", async (c) => {
    try {
      const groups = groupChatService.listGroups();
      return c.json({ groups });
    } catch (err) {
      log.error("[GroupRoutes] 获取群列表失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "获取群列表失败" }, 500);
    }
  });

  /**
   * GET /api/groups/:id — 获取群详情
   */
  app.get("/api/groups/:id", async (c) => {
    try {
      const groupId = c.req.param("id");
      const group = groupChatService.getGroupInfo(groupId);
      if (!group) {
        return c.json({ error: "group_not_found", message: "群不存在" }, 404);
      }
      return c.json(group);
    } catch (err) {
      log.error("[GroupRoutes] 获取群详情失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "获取群详情失败" }, 500);
    }
  });

  /**
   * GET /api/groups/:id/messages — 获取群消息历史
   */
  app.get("/api/groups/:id/messages", async (c) => {
    try {
      const groupId = c.req.param("id");
      const limit = parseInt(c.req.query("limit") || "200", 10);
      const offset = parseInt(c.req.query("offset") || "0", 10);

      // 先从磁盘加载（首次访问）
      await groupChatService.loadGroupMessages(groupId);
      const result = groupChatService.getGroupMessages(groupId, { limit, offset });

      return c.json(result);
    } catch (err) {
      log.error("[GroupRoutes] 获取群消息失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "获取群消息失败" }, 500);
    }
  });

  /**
   * POST /api/groups/:id/messages — 发送群消息（from='user'）
   */
  app.post("/api/groups/:id/messages", async (c) => {
    try {
      const groupId = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      // 兼容 { text } 和 { payload: { text } } 两种格式
      let payload = body.payload;
      if (!payload && body.text) {
        payload = { text: body.text };
      }

      if (!payload) {
        return c.json({ error: "missing_payload", message: "请提供消息内容" }, 400);
      }

      const result = await groupChatService.sendGroupMessage({
        from: "user",
        groupId,
        payload
      });

      if (result.error) {
        return c.json(result, 400);
      }

      return c.json(result);
    } catch (err) {
      log.error("[GroupRoutes] 发送群消息失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "发送群消息失败" }, 500);
    }
  });

  /**
   * PUT /api/groups/:id/messages/:messageId — 编辑群消息（user 操作）
   */
  app.put("/api/groups/:id/messages/:messageId", async (c) => {
    try {
      const groupId = c.req.param("id");
      const messageId = c.req.param("messageId");
      const body = await c.req.json().catch(() => ({}));
      // 兼容 { text } 和 { payload: { text } } 两种格式
      let payload = body.payload;
      if (!payload && body.text) {
        payload = { text: body.text };
      }

      if (!payload) {
        return c.json({ error: "missing_content", message: "请提供消息内容" }, 400);
      }

      const result = await groupChatService.updateGroupMessage({
        groupId,
        messageId,
        payload
      });

      if (result.error) {
        const status = result.error === "message_not_found" ? 404 : 400;
        return c.json(result, status);
      }

      return c.json({ ok: true, message: result.message });
    } catch (err) {
      log.error("[GroupRoutes] 编辑群消息失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "编辑群消息失败" }, 500);
    }
  });

  /**
   * DELETE /api/groups/:id/messages/:messageId — 删除群消息（user 操作）
   */
  app.delete("/api/groups/:id/messages/:messageId", async (c) => {
    try {
      const groupId = c.req.param("id");
      const messageId = c.req.param("messageId");

      const result = await groupChatService.deleteGroupMessage({
        groupId,
        messageId
      });

      if (result.error) {
        const status = result.error === "message_not_found" ? 404 : 400;
        return c.json(result, status);
      }

      return c.json({ ok: true });
    } catch (err) {
      log.error("[GroupRoutes] 删除群消息失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "删除群消息失败" }, 500);
    }
  });

  /**
   * POST /api/groups — 创建群聊（user 作为创建者，智能体为成员）
   */
  app.post("/api/groups", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { name, members, memberIds, description, reason } = body;
      const ids = members || memberIds || [];

      if (!name || typeof name !== "string" || !name.trim()) {
        return c.json({ error: "invalid_name", message: "群名不能为空" }, 400);
      }

      const result = await groupChatService.createGroup({
        name: name.trim(),
        actorId: "user",
        memberIds: ids,
        description: description || "",
        reason: reason || ""
      });

      if (result.error) {
        return c.json(result, 400);
      }

      return c.json(result.group);
    } catch (err) {
      log.error("[GroupRoutes] 创建群聊失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "创建群聊失败" }, 500);
    }
  });

  /**
   * POST /api/groups/:id/members — 邀请成员入群（user 操作）
   */
  app.post("/api/groups/:id/members", async (c) => {
    try {
      const groupId = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const { memberIds, members, reason } = body;
      const ids = memberIds || members || [];

      const result = await groupChatService.inviteToGroup({
        groupId,
        actorId: "user",
        memberIds: ids,
        reason: reason || ""
      });

      if (result.error) {
        return c.json(result, 400);
      }
      return c.json({ ok: true, group: result.group });
    } catch (err) {
      log.error("[GroupRoutes] 邀请成员失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "邀请成员失败" }, 500);
    }
  });

  /**
   * DELETE /api/groups/:id — 解散群（user 操作）
   */
  app.delete("/api/groups/:id", async (c) => {
    try {
      const groupId = c.req.param("id");

      const result = await groupChatService.dissolveGroup({
        groupId,
        actorId: "user"
      });

      if (result.error) {
        return c.json(result, 400);
      }
      return c.json({ ok: true });
    } catch (err) {
      log.error("[GroupRoutes] 解散群失败", {
        message: err.message,
        stack: err.stack
      });
      return c.json({ error: "internal_error", message: "解散群失败" }, 500);
    }
  });

  log.info("[GroupRoutes] 群聊 API 路由已注册");
}

// ===========================================================================
// DI 注册
// ===========================================================================

registry.declare({
  name: "group-routes",
  requires: ["app", "groupChatService", "log"],
  provides: [],
  async init(deps) {
    await registerGroupRoutes(deps);
    return {};
  }
});