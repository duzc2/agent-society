import { randomUUID } from "node:crypto";
import { normalizeSystemPromptAppendix } from "../utils/http_utils.js";

/**
 * 注册 OrgPrimitives 类的原型方法（运行时 + HTTP 路由）。
 * 通过参数传入类以避免循环依赖。
 * @param {Function} OrgPrimitives - OrgPrimitives 类（构造函数）
 */
export function registerOrgRoutes(OrgPrimitives) {

// ---------------------------------------------------------------------------
// 运行时方法：提交需求与发送消息
// ---------------------------------------------------------------------------

/**
 * 提交自然语言需求描述给根智能体，由根智能体自组织创建组织并启动执行。
 * @param {string} text
 * @param {{workspacePath?: string}} [options] - 可选参数
 * @returns {Promise<{taskId:string, workspacePath?:string}|{error:string}>}
 */
OrgPrimitives.prototype.submitRequirement = async function(text, options = {}) {
  const taskId = randomUUID();
  void this.log.info("提交需求", { taskId, length: String(text ?? "").length, workspacePath: options.workspacePath ?? null });

  // 如果指定了工作空间，绑定到任务
  if (options.workspacePath) {
    const bindResult = await this._workspaceManager.bindWorkspace(
      taskId,
      options.workspacePath
    );
    if (!bindResult.ok) {
      void this.log.error("工作空间绑定失败", { taskId, error: bindResult.error, stack: bindResult.error?.stack });
      return { error: bindResult.error };
    }
    void this.log.info("工作空间绑定成功", { taskId, workspacePath: options.workspacePath });
  }

  await this.sendTextToAgent("root", String(text ?? ""), { taskId });
  void this.log.info("需求处理结束", { taskId });

  const result = { taskId };
  if (options.workspacePath) {
    result.workspacePath = options.workspacePath;
  }
  return result;
};

/**
 * 用户向指定智能体发送一条文本消息（不阻塞）。
 * 消息直接发送到目标智能体，不经过用户端点的队列。
 * @param {string} agentId
 * @param {string|Promise<string>|{text:string|Promise<string>, attachments?:any[]}} text
 * @param {{taskId?:string}} [options]
 * @returns {Promise<{taskId:string, to:string, messageId:string}|{error:string}>}
 */
OrgPrimitives.prototype.sendTextToAgent = async function(agentId, text, options = {}) {
  const toAgentId = String(agentId ?? "").trim();
  if (!toAgentId) {
    return { error: "目标智能体ID不能为空" };
  }
  // 验证目标智能体ID不能是"user"
  if (toAgentId === "user") {
    void this.log.warn("用户尝试发送消息到user端点", { toAgentId });
    return { error: "不能向用户端点发送消息，请指定其他智能体ID" };
  }

  // 禁止向已删除的智能体发送消息
  if (toAgentId !== "root") {
    const targetMeta = this.getAgent?.(toAgentId) ?? null;
    if (targetMeta && targetMeta.status === "deleted") {
      void this.log.warn("用户尝试发送消息到已删除的智能体", { toAgentId });
      return { error: "目标智能体已被删除，无法发送消息" };
    }
  }
  const taskId = options?.taskId ?? randomUUID();

  // 如果 text 是 Promise，等待其解决
  /** @type {string|{text:string|Promise<string>, attachments?:any[]}|Promise<string>} */
  let resolvedText = text;
  // @ts-ignore - 类型判断在运行时进行
  if (text !== null && typeof text === 'object' && typeof text.then === 'function') {
    try {
      // @ts-ignore - 此时 text 是 Promise
      resolvedText = await text;
    } catch (err) {
      void this.log.error("sendTextToAgent 接收到的 Promise 被拒绝", { toAgentId, taskId, error: err?.message, stack: err?.stack, name: err?.name, code: err?.code });
      return { error: `promise_rejected: ${err?.message ?? String(err)}` };
    }
  }

  // 构建 payload：支持字符串或带附件的对象
  /** @type {{text:string, attachments?:any[]}} */
  let payload;
  if (typeof resolvedText === 'object' && resolvedText !== null) {
    // 已经是对象格式（带 attachments），直接使用
    // @ts-ignore - 类型判断在运行时进行
    payload = resolvedText;
    // 检查内部 text 字段是否为 Promise
    // @ts-ignore - payload.text 可能为 Promise
    if (payload.text !== null && typeof payload.text === 'object' && typeof payload.text?.then === 'function') {
      try {
        // @ts-ignore - 此时 payload.text 是 Promise
        payload.text = await payload.text;
      } catch (err) {
        void this.log.error("payload.text Promise 被拒绝", { toAgentId, taskId, error: err?.message, stack: err?.stack, name: err?.name, code: err?.code });
        payload.text = "[Error: Promise rejected]";
      }
    }
  } else {
    // 纯文本格式
    payload = { text: String(resolvedText ?? "") };
  }

  // 直接发送到目标智能体，from="user"
  const sendResult = this._bus.send({
    to: toAgentId,
    from: "user",
    taskId,
    payload
  });
  if (sendResult?.rejected) {
    return { error: sendResult.reason ?? "message_rejected" };
  }

  // 立即设置智能体状态为 processing，确保前端不会看到 idle。
  // 调度器是单线程的，可能在调用 _startLlm 为其他智能体做 LLM 初始化时
  // 阻塞整个循环，导致消息虽然已入队但状态未更新。
  // 这里提前设置状态，让用户从发送消息的那一刻起就看到"处理中"。
  this._runtimeState.setAgentComputeStatus(toAgentId, "processing");
  this._runtimeState.setAgentComputePhase(toAgentId, "正在准备...");

  void this.log.info("用户消息已发送", { toAgentId, taskId, hasAttachments: !!(payload.attachments?.length) });
  return {
    taskId,
    to: toAgentId,
    messageId: sendResult?.messageId ?? ""
  };
};

// ---------------------------------------------------------------------------
// HTTP 路由：角色相关
// ---------------------------------------------------------------------------

/**
 * 注册角色相关 Hono 路由。
 * 由 registry 在依赖就绪时自动调用。
 * @param {{ app: import('hono').Hono, logRoot: any, org: any }} deps
 */
OrgPrimitives.prototype.registerRoleRoutes = function({ app, logRoot, org }) {
  const log = logRoot.forModule('role-routes');

  // GET /api/roles — 列出所有岗位及智能体数量
  app.get('/api/roles', (c) => {
    try {
      const allRoles = this.listRoles();
      const agents = this.listAgents();

      // 过滤已删除的岗位
      const roles = allRoles.filter(r => r.status !== "deleted");

      // 统计每个岗位的智能体数量
      const agentCountByRole = new Map();
      for (const agent of agents) {
        const count = agentCountByRole.get(agent.roleId) ?? 0;
        agentCountByRole.set(agent.roleId, count + 1);
      }

      // 构建岗位列表，包含 root 和 user
      const rolesWithCount = [
        {
          id: "root",
          name: "root",
          rolePrompt: "系统根智能体",
          createdBy: null,
          createdAt: null,
          agentCount: 1,
          llmServiceId: null,
          toolGroups: ["org_management"],
          skillBindings: []
        },
        {
          id: "user",
          name: "user",
          rolePrompt: "用户端点",
          createdBy: null,
          createdAt: null,
          agentCount: 1,
          llmServiceId: null,
          toolGroups: null,
          skillBindings: []
        },
        ...roles.map(r => ({
          id: r.id,
          name: r.name,
          rolePrompt: r.rolePrompt,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          agentCount: agentCountByRole.get(r.id) ?? 0,
          llmServiceId: r.llmServiceId ?? null,
          toolGroups: r.toolGroups ?? null,
          skillBindings: Array.isArray(r.skillBindings) ? r.skillBindings : []
        }))
      ];

      void log.debug("HTTP查询岗位列表", { count: rolesWithCount.length });
      return c.json({
        roles: rolesWithCount,
        count: rolesWithCount.length
      });
    } catch (err) {
      void log.error("查询岗位列表失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // GET /api/role/:roleId — 获取单个岗位详情
  app.get('/api/role/:roleId', (c) => {
    const roleId = c.req.param('roleId');
    try {
      void log.debug("HTTP查询岗位详情 - 接收到的ID", { roleId, roleIdType: typeof roleId });


      // 特殊处理 root 和 user
      if (roleId === "root") {
        return c.json({
          role: {
            id: "root",
            name: "root",
            rolePrompt: "系统根智能体",
            orgPrompt: null,
            createdBy: null,
            createdAt: null,
            llmServiceId: null,
            toolGroups: ["org_management"],
            skillBindings: [],
            knowledgeTreeEnabled: true,
            agentMemoryEnabled: true
          }
        });
      }

      if (roleId === "user") {
        return c.json({
          role: {
            id: "user",
            name: "user",
            rolePrompt: "用户端点",
            orgPrompt: null,
            createdBy: null,
            createdAt: null,
            llmServiceId: null,
            toolGroups: null,
            skillBindings: [],
            knowledgeTreeEnabled: true,
            agentMemoryEnabled: true
          }
        });
      }

      const role = this.getRole(roleId);
      void log.debug("HTTP查询岗位详情 - 查询结果", { roleId, found: !!role, status: role?.status });

      if (!role) {
        void log.warn("岗位不存在", { roleId });
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      if (role.status === "deleted") {
        void log.warn("岗位已删除", { roleId });
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      void log.debug("HTTP查询岗位详情 - 返回成功", { roleId, roleName: role.name });
      return c.json({ role });
    } catch (err) {
      void log.error("查询岗位详情失败", { roleId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // DELETE /api/role/:roleId 已迁移至 lifecycle DI init

  // POST /api/role/:roleId/tool-groups 已迁移至 toolGroupManager DI init

  // POST /api/role/:roleId/agents 已迁移至 lifecycle DI init

  // POST /api/role/:roleId/prompt — 更新岗位提示词
  app.post('/api/role/:roleId/prompt', async (c) => {
    const roleId = c.req.param('roleId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const rolePrompt = body?.rolePrompt;
    const orgPrompt = body?.orgPrompt;

    // 必须至少提供一个要更新的字段
    if (rolePrompt === undefined && orgPrompt === undefined) {
      return c.json({ error: "invalid_request", message: "必须提供 rolePrompt 或 orgPrompt" }, 400);
    }

    // 验证 rolePrompt（如果提供）
    if (rolePrompt !== undefined && typeof rolePrompt !== "string") {
      return c.json({ error: "invalid_role_prompt", message: "rolePrompt 必须是字符串" }, 400);
    }

    // 验证 orgPrompt（如果提供）
    if (orgPrompt !== undefined && typeof orgPrompt !== "string") {
      return c.json({ error: "invalid_org_prompt", message: "orgPrompt 必须是字符串" }, 400);
    }

    // 检查是否是系统岗位
    if (roleId === "root" || roleId === "user") {
      return c.json({ error: "cannot_modify_system_role", message: "不能修改系统岗位" }, 400);
    }

    try {

      const updates = {};
      if (rolePrompt !== undefined) updates.rolePrompt = rolePrompt;
      if (orgPrompt !== undefined) updates.orgPrompt = orgPrompt;

      const updatedRole = await this.updateRole(roleId, updates);

      if (!updatedRole) {
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      void log.info("更新岗位提示词", { roleId, updates: Object.keys(updates) });
      return c.json({
        ok: true,
        role: updatedRole
      });
    } catch (saveErr) {
      void log.error("更新岗位提示词失败", { roleId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "update_failed", message: saveErr.message }, 500);
    }
  });

  // POST /api/role/:roleId/llm-service — 更新岗位 LLM 服务
  app.post('/api/role/:roleId/llm-service', async (c) => {
    const roleId = c.req.param('roleId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    // llmServiceId 可以是字符串或 null（表示使用默认服务）
    const llmServiceId = body?.llmServiceId;
    if (llmServiceId !== null && llmServiceId !== undefined && typeof llmServiceId !== "string") {
      return c.json({ error: "invalid_llm_service_id", message: "llmServiceId 必须是字符串或 null" }, 400);
    }

    // 检查是否是系统岗位
    if (roleId === "root" || roleId === "user") {
      return c.json({ error: "cannot_modify_system_role", message: "不能修改系统岗位" }, 400);
    }

    try {

      const updatedRole = await this.updateRole(roleId, { llmServiceId: llmServiceId ?? null });

      if (!updatedRole) {
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      void log.info("更新岗位LLM服务", { roleId, llmServiceId: updatedRole.llmServiceId });
      return c.json({
        ok: true,
        role: updatedRole
      });
    } catch (saveErr) {
      void log.error("更新岗位LLM服务失败", { roleId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "update_failed", message: saveErr.message }, 500);
    }
  });

  // POST /api/role/:roleId/features — 更新岗位功能开关
  app.post('/api/role/:roleId/features', async (c) => {
    const roleId = c.req.param('roleId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    // 检查是否是系统岗位
    if (roleId === "root" || roleId === "user") {
      return c.json({ error: "cannot_modify_system_role", message: "不能修改系统岗位" }, 400);
    }

    try {

      const updates = {};
      if (typeof body?.knowledgeTreeEnabled === "boolean") {
        updates.knowledgeTreeEnabled = body.knowledgeTreeEnabled;
      }
      if (typeof body?.agentMemoryEnabled === "boolean") {
        updates.agentMemoryEnabled = body.agentMemoryEnabled;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: "invalid_request", message: "必须提供 knowledgeTreeEnabled 或 agentMemoryEnabled" }, 400);
      }

      const updatedRole = await this.updateRole(roleId, updates);

      if (!updatedRole) {
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      void log.info("更新岗位功能开关", { roleId, knowledgeTreeEnabled: updatedRole.knowledgeTreeEnabled, agentMemoryEnabled: updatedRole.agentMemoryEnabled });
      return c.json({
        ok: true,
        role: updatedRole
      });
    } catch (saveErr) {
      void log.error("更新岗位功能开关失败", { roleId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "update_failed", message: saveErr.message }, 500);
    }
  });

  // PUT /api/roles/reorder — 批量更新岗位排序
  app.put('/api/roles/reorder', async (c) => {
    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.error("[批量更新岗位排序] 解析请求体失败", { error: err.message, stack: err.stack });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const roleOrders = body?.roleOrders;
    if (!Array.isArray(roleOrders)) {
      return c.json({ error: "invalid_request", message: "roleOrders must be an array" }, 400);
    }

    // 验证每个元素有 id 和 sortOrder
    for (const item of roleOrders) {
      if (typeof item?.id !== "string" || typeof item?.sortOrder !== "number") {
        return c.json({ error: "invalid_request", message: "Each roleOrders item must have id (string) and sortOrder (number)" }, 400);
      }
    }

    try {

      const result = await this.reorderRoles(roleOrders);

      void log.info("[批量更新岗位排序] 完成", { updated: result.updated });
      return c.json({ ok: true, updated: result.updated });
    } catch (reorderErr) {
      void log.error("[批量更新岗位排序] 失败", { error: reorderErr.message, stack: reorderErr.stack });
      return c.json({ error: "reorder_failed", message: reorderErr.message }, 500);
    }
  });

  // GET /api/org/role-tree — 获取岗位从属关系树结构
  app.get('/api/org/role-tree', (c) => {
    try {

      const roles = this.listRoles();
      const agents = this.listAgents();

      // 过滤已删除的岗位
      const activeRoles = roles.filter(r => r.status !== "deleted");

      // 统计每个岗位的智能体数量（区分活跃和已删除）
      const agentCountByRole = new Map();
      const activeAgentCountByRole = new Map();
      for (const agent of agents) {
        const count = agentCountByRole.get(agent.roleId) ?? 0;
        agentCountByRole.set(agent.roleId, count + 1);

        if (agent.status !== "deleted") {
          const activeCount = activeAgentCountByRole.get(agent.roleId) ?? 0;
          activeAgentCountByRole.set(agent.roleId, activeCount + 1);
        }
      }

      // 构建岗位映射
      const roleMap = new Map();

      // 添加系统岗位
      roleMap.set("root", {
        id: "root",
        name: "root",
        createdBy: null,
        agentCount: 1,
        activeAgentCount: 1,
        children: []
      });

      // 添加用户定义的岗位（只添加未删除的）
      for (const role of activeRoles) {
        roleMap.set(role.id, {
          id: role.id,
          name: role.name,
          createdBy: role.createdBy,
          createdAt: role.createdAt,
          agentCount: agentCountByRole.get(role.id) ?? 0,
          activeAgentCount: activeAgentCountByRole.get(role.id) ?? 0,
          children: []
        });
      }

      // 构建树结构（基于 createdBy 关系）
      const agentToRoleMap = new Map();
      agentToRoleMap.set("root", "root");
      for (const agent of agents) {
        agentToRoleMap.set(agent.id, agent.roleId);
      }

      const roots = [];
      for (const [id, node] of roleMap) {
        if (id === "root") {
          roots.push(node);
          continue;
        }

        const creatorAgentId = node.createdBy;
        const parentRoleId = creatorAgentId ? agentToRoleMap.get(creatorAgentId) : null;

        if (parentRoleId && roleMap.has(parentRoleId)) {
          roleMap.get(parentRoleId).children.push(node);
        } else {
          roots.push(node);
        }
      }

      void log.debug("HTTP查询岗位树", { nodeCount: roleMap.size });
      return c.json({
        tree: roots,
        nodeCount: roleMap.size
      });
    } catch (err) {
      void log.error("查询岗位树失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // GET /api/debug/roles — 调试：列出所有岗位 ID
  app.get('/api/debug/roles', (c) => {
    const allRoles = this.listRoles();
    return c.json({
      allRoleIds: allRoles.map(r => ({ id: r.id, name: r.name, status: r.status }))
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP 路由：智能体相关
// ---------------------------------------------------------------------------

/**
 * 注册智能体相关 Hono 路由。
 * 由 registry 在依赖就绪时自动调用。
 * @param {{ app: import('hono').Hono, logRoot: any, org: any }} deps
 */
OrgPrimitives.prototype.registerAgentRoutes = function({ app, logRoot, org }) {
  const log = logRoot.forModule('agent-routes');

  // POST /api/submit — 提交需求给根智能体
  app.post('/api/submit', async (c) => {
    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const text = body?.text;
    if (!text || typeof text !== "string") {
      return c.json({ error: "missing_text", message: "请求体必须包含text字段" }, 400);
    }

    const result = await this.submitRequirement(text);

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    void log.info("HTTP提交需求", { taskId: result.taskId });
    return c.json({ taskId: result.taskId });
  });

  // POST /api/send — 发送消息到指定智能体
  app.post('/api/send', async (c) => {
    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    // 支持两种字段名：agentId/to 和 text/message
    const agentId = body?.agentId ?? body?.to;
    const text = body?.text ?? body?.message;
    const taskId = body?.taskId;
    const attachments = body?.attachments;

    if (!agentId || typeof agentId !== "string") {
      return c.json({ error: "missing_agent_id", message: "请求体必须包含agentId或to字段" }, 400);
    }

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if ((!text || typeof text !== "string") && !hasAttachments) {
      return c.json({ error: "missing_text", message: "请求体必须包含text或message字段，或者包含attachments" }, 400);
    }

    let messagePayload = text || "";
    if (hasAttachments) {
      messagePayload = {
        text: text || "",
        attachments: attachments.map(att => ({
          type: att.type,
          path: att.path,
          filename: att.filename
        }))
      };
    }

    const options = taskId ? { taskId } : {};
    const result = await this.sendTextToAgent(agentId, messagePayload, options);

    if (result.error) {
      const isAgentStateError = typeof result.error === "string" && result.error.startsWith("agent_");
      const statusCode = isAgentStateError ? 409 : 400;
      return c.json({ error: result.error }, statusCode);
    }

    void log.info("HTTP发送消息", { agentId, taskId: result.taskId, hasAttachments });
    return c.json({
      ok: true,
      messageId: result.messageId,
      taskId: result.taskId,
      to: result.to
    });
  });

  // GET /api/agent/:agentId/todo-list — 获取智能体待办列表
  app.get('/api/agent/:agentId/todo-list', (c) => {
    const agentId = c.req.param('agentId');
    if (!agentId || agentId.trim() === "") {
      return c.json({ error: "missing_agent_id" }, 400);
    }

    try {

      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const persistedAgent = this.getAgent(agentId);
      if (!runtimeAgent && !persistedAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      const todoList = runtimeAgent?.todoList ?? persistedAgent?.todoList ?? [];
      return c.json({
        agentId,
        todoList: Array.isArray(todoList) ? todoList : [],
        count: Array.isArray(todoList) ? todoList.length : 0
      });
    } catch (err) {
      void log.error("查询智能体 todoList 失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "get_todo_list_failed", message: err.message }, 500);
    }
  });

  // PUT /api/agent/:agentId/todo-list — 更新智能体待办列表
  app.put('/api/agent/:agentId/todo-list', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    if (!body || !Array.isArray(body.todoList)) {
      return c.json({ error: "invalid_todo_list", message: "todoList 必须是数组" }, 400);
    }

    try {

      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const updated = await this.setAgentTodoList(agentId, body.todoList);
      if (!updated && !runtimeAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      if (runtimeAgent) {
        runtimeAgent.todoList = body.todoList;
      }

      return c.json({
        ok: true,
        agentId,
        todoList: body.todoList,
        count: body.todoList.length
      });
    } catch (saveErr) {
      void log.error("更新智能体 todoList 失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });

  // GET /api/agent/:agentId/auto-reply — 获取智能体自动回复配置
  app.get('/api/agent/:agentId/auto-reply', (c) => {
    const agentId = c.req.param('agentId');
    if (!agentId || agentId.trim() === "") {
      return c.json({ error: "missing_agent_id" }, 400);
    }

    try {

      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const persistedAgent = this.getAgent(agentId);
      if (!runtimeAgent && !persistedAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      const cfg = runtimeAgent?.autoReplyConfig ?? persistedAgent?.autoReplyConfig ?? null;
      return c.json({
        agentId,
        autoReplyConfig: cfg
      });
    } catch (err) {
      void log.error("查询智能体 autoReply 失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "get_auto_reply_failed", message: err.message }, 500);
    }
  });

  // PUT /api/agent/:agentId/auto-reply — 更新智能体自动回复配置
  app.put('/api/agent/:agentId/auto-reply', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body", message: "请求体必须是 JSON 对象" }, 400);
    }

    const config = body.autoReplyConfig;

    try {

      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const updated = await this.setAgentAutoReply(agentId, config);
      if (!updated && !runtimeAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      if (runtimeAgent) {
        runtimeAgent.autoReplyConfig = updated?.autoReplyConfig ?? config ?? null;
      }

      return c.json({
        ok: true,
        agentId,
        autoReplyConfig: updated?.autoReplyConfig ?? config ?? null
      });
    } catch (saveErr) {
      void log.error("更新智能体 autoReply 失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });

  // GET /api/agent/:agentId/system-prompt-appendix — 获取智能体附录条目
  app.get('/api/agent/:agentId/system-prompt-appendix', (c) => {
    const agentId = c.req.param('agentId');
    if (!agentId || agentId.trim() === "") {
      return c.json({ error: "missing_agent_id" }, 400);
    }

    try {

      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const persistedAgent = this.getAgent(agentId);
      if (!runtimeAgent && !persistedAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      const sourceItems = runtimeAgent?.systemPromptAppendix ?? persistedAgent?.systemPromptAppendix ?? [];
      const normalizedItems = normalizeSystemPromptAppendix(sourceItems);
      return c.json({
        agentId,
        systemPromptAppendix: normalizedItems,
        count: normalizedItems.length
      });
    } catch (err) {
      void log.error("查询智能体 systemPromptAppendix 失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "get_system_prompt_appendix_failed", message: err.message }, 500);
    }
  });

  // PUT /api/agent/:agentId/system-prompt-appendix — 更新智能体附录条目
  app.put('/api/agent/:agentId/system-prompt-appendix', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    if (!body || !Array.isArray(body.systemPromptAppendix)) {
      return c.json({ error: "invalid_system_prompt_appendix", message: "systemPromptAppendix 必须是字符串数组" }, 400);
    }

    const hasInvalidItem = body.systemPromptAppendix.some((item) => typeof item !== "string");
    if (hasInvalidItem) {
      return c.json({ error: "invalid_system_prompt_appendix_item", message: "systemPromptAppendix 条目必须全部为字符串" }, 400);
    }

    try {

      const normalizedItems = normalizeSystemPromptAppendix(body.systemPromptAppendix);
      const runtimeAgent = this._runtimeState.getAgent(agentId);
      const updated = await this.setAgentSystemPromptAppendix(agentId, normalizedItems);
      if (!updated && !runtimeAgent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在", agentId }, 404);
      }

      if (runtimeAgent) {
        runtimeAgent.systemPromptAppendix = [...normalizedItems];
      }

      return c.json({
        ok: true,
        agentId,
        systemPromptAppendix: normalizedItems,
        count: normalizedItems.length
      });
    } catch (saveErr) {
      void log.error("更新智能体 systemPromptAppendix 失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });

  // DELETE /api/agent/:agentId 已迁移至 lifecycle DI init

  // POST /api/agent/:agentId/abort 已迁移至 lifecycle DI init

  // GET /api/agent-custom-names — 获取所有智能体自定义名称
  app.get('/api/agent-custom-names', (c) => {
    try {

      const agents = this.listAgents();
      const customNames = {};
      for (const a of agents) {
        if (!a || typeof a.id !== "string") continue;
        if (typeof a.name === "string" && a.name.trim()) {
          customNames[a.id] = a.name.trim();
        }
      }
      void log.debug("HTTP查询自定义名称", { count: Object.keys(customNames).length });
      return c.json({ customNames });
    } catch (err) {
      void log.error("查询自定义名称失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // POST /api/agent/:agentId/custom-name — 设置智能体自定义名称
  app.post('/api/agent/:agentId/custom-name', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const customName = body?.customName;
    if (customName !== undefined && typeof customName !== "string") {
      return c.json({ error: "invalid_custom_name", message: "customName 必须是字符串" }, 400);
    }

    try {

      const updated = await this.setAgentName(agentId, customName || null);
      if (!updated) {
        return c.json({ error: "agent_not_found", message: "智能体不存在" }, 404);
      }
      void log.info("设置智能体自定义名称", { agentId, customName: customName || "(cleared)" });
      return c.json({
        ok: true,
        agentId,
        customName: updated.name ?? null
      });
    } catch (saveErr) {
      void log.error("保存自定义名称失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });

  // POST /api/agent/:agentId/roles — 为指定智能体创建子岗位
  app.post('/api/agent/:agentId/roles', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    try {
      if (agentId === "user") {
        return c.json({
          error: "cannot_create_role_for_user",
          message: "user proxy cannot create child roles"
        }, 400);
      }

      const roleName = typeof body?.name === "string" ? body.name.trim() : "";
      const rolePrompt = typeof body?.rolePrompt === "string" ? body.rolePrompt.trim() : "";
      const explicitOrgPrompt = typeof body?.orgPrompt === "string" ? body.orgPrompt.trim() : undefined;

      if (!roleName) {
        return c.json({ error: "missing_role_name", message: "role name is required" }, 400);
      }

      if (!rolePrompt) {
        return c.json({ error: "missing_role_prompt", message: "role prompt is required" }, 400);
      }

      const creatorAgent = agentId === "root"
        ? { id: "root", roleId: "root", status: "active" }
        : this.getAgent(agentId);

      if (!creatorAgent) {
        return c.json({ error: "agent_not_found", message: "creator agent not found" }, 404);
      }

      if (creatorAgent.status === "deleted") {
        return c.json({ error: "agent_deleted", message: "deleted agent cannot create roles" }, 400);
      }

      const creatorRole = creatorAgent.roleId === "root"
        ? { id: "root", name: "root", orgPrompt: null }
        : this.getRole(creatorAgent.roleId);

      if (!creatorRole) {
        return c.json({ error: "creator_role_not_found", message: "creator role not found" }, 400);
      }

      const existingRole = this.findRoleByName?.(roleName) ?? null;
      if (existingRole && existingRole.status !== "deleted" && existingRole.createdBy !== agentId) {
        return c.json({
          error: "role_name_conflict",
          message: "role name is already used by another creator"
        }, 409);
      }

      const explicitLlmServiceId = typeof body?.llmServiceId === "string" ? body.llmServiceId : null;
      let llmServiceId = explicitLlmServiceId ?? null;

      if (!llmServiceId) {
        llmServiceId = creatorRole.llmServiceId ?? null;
      }

      const role = existingRole && existingRole.status !== "deleted"
        ? existingRole
        : await this.createRole({
          name: roleName,
          rolePrompt,
          orgPrompt: explicitOrgPrompt !== undefined ? (explicitOrgPrompt || null) : (creatorRole.orgPrompt ?? null),
          createdBy: agentId,
          llmServiceId
        });

      void log.info("HTTP create child role for agent", {
        agentId,
        roleId: role.id,
        roleName: role.name,
        reused: role.id === existingRole?.id
      });

      return c.json({
        ok: true,
        reused: role.id === existingRole?.id,
        role
      });
    } catch (createError) {
      void log.error("create child role for agent failed", {
        agentId,
        error: createError.message,
        stack: createError.stack
      });
      return c.json({ error: "internal_error", message: createError.message }, 500);
    }
  });

  // POST /api/org/:agentId/name — 设置组织显示名称
  app.post('/api/org/:agentId/name', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      void log.warn("请求 body JSON 解析失败", { error: err?.message ?? String(err) });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const orgName = body?.orgName;
    if (typeof orgName !== "string") {
      return c.json({ error: "invalid_org_name", message: "orgName 必须是字符串" }, 400);
    }

    try {

      await this.setOrgName(agentId, orgName.trim());
      const cleared = !orgName.trim();
      void log.info(cleared ? "清除组织名称" : "设置组织名称", { agentId, orgName: cleared ? "(cleared)" : orgName.trim() });
      return c.json({ ok: true, agentId, orgName: cleared ? null : orgName.trim() });
    } catch (saveErr) {
      void log.error("保存组织名称失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });

};

}