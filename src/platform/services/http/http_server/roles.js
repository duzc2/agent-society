import { registry } from "../../../core/module_registry.js";

/**
 * 注册角色相关 Hono 路由。
 * 由 registry 在依赖就绪时自动调用。
 * @param {{ app: import('hono').Hono, log: any, society: any }} deps
 */
export function registerRoleRoutes({ app, log, society }) {

  // GET /api/roles — 列出所有岗位及智能体数量
  app.get('/api/roles', (c) => {
    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const allRoles = org ? org.listRoles() : [];
      const agents = org ? org.listAgents() : [];

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
          toolGroups: ["org_management"],
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
          toolGroups: (r.toolGroups && r.toolGroups.length > 0) ? r.toolGroups : ["org_management"],
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

      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;

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
            toolGroups: ["org_management"],
            skillBindings: [],
            knowledgeTreeEnabled: true,
            agentMemoryEnabled: true
          }
        });
      }

      const role = org.getRole(roleId);
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

      // 兼容历史数据中的 null/空数组，返回实际默认值
      if (!role.toolGroups || (Array.isArray(role.toolGroups) && role.toolGroups.length === 0)) {
        role.toolGroups = ["org_management"];
      }

      return c.json({ role });
    } catch (err) {
      void log.error("查询岗位详情失败", { roleId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // DELETE /api/role/:roleId — 软删除岗位
  app.delete('/api/role/:roleId', async (c) => {
    const roleId = c.req.param('roleId');
    void log.info("[删除岗位] 收到请求", { roleId });

    let body;
    try {
      body = await c.req.json().catch(() => ({}));
    } catch (err) {
      void log.error("[删除岗位] 解析请求体失败", { roleId, error: err.message, stack: err.stack });
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const reason = body?.reason || "用户删除";
    const deletedBy = body?.deletedBy || "user";

    void log.info("[删除岗位] 开始处理", { roleId, deletedBy, reason });

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        void log.error("[删除岗位] 系统未初始化", { roleId });
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const role = org.getRole(roleId);

      void log.debug("[删除岗位] 获取岗位信息", { roleId, found: !!role, status: role?.status });

      if (!role) {
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      if (role.status === "deleted") {
        return c.json({ error: "role_already_deleted", message: "岗位已被删除" }, 400);
      }

      // 不允许删除系统岗位
      if (roleId === "root" || roleId === "user") {
        return c.json({ error: "cannot_delete_system_role", message: "不能删除系统岗位" }, 400);
      }

      const result = await society.runtime.deleteRole(roleId, deletedBy, reason);

      if (!result.ok) {
        const statusCode =
          result.error === "role_not_found" ? 404 :
            result.error === "role_already_deleted" ? 400 :
              result.error === "cannot_delete_system_role" ? 400 :
                500;
        return c.json({ error: result.error, message: "删除岗位失败" }, statusCode);
      }

      void log.info("删除岗位", {
        roleId,
        roleName: role.name,
        deletedBy,
        reason,
        affectedAgentsCount: result.deleteResult?.affectedAgents?.length ?? 0,
        affectedRolesCount: result.deleteResult?.affectedRoles?.length ?? 0,
        terminatedAgentsCount: result.deleteResult?.terminatedAgents?.length ?? 0,
        failedAgentsCount: result.deleteResult?.failedAgents?.length ?? 0
      });

      return c.json({
        ok: true,
        roleId,
        roleName: role.name,
        deleteResult: result.deleteResult
      });
    } catch (deleteErr) {
      void log.error("删除岗位失败", { roleId, error: deleteErr.message, stack: deleteErr.stack });
      return c.json({ error: "delete_failed", message: deleteErr.message }, 500);
    }
  });

  // POST /api/role/:roleId/tool-groups — 更新岗位工具组配置
  app.post('/api/role/:roleId/tool-groups', async (c) => {
    const roleId = c.req.param('roleId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      // 不允许修改 root 和 user 岗位的工具组
      if (roleId === "root" || roleId === "user") {
        return c.json({
          error: "cannot_modify_system_role",
          message: "不能修改系统岗位的工具组配置"
        }, 400);
      }

      const org = society.runtime.org;
      if (!org) {
        return c.json({ error: "org_not_initialized" }, 500);
      }

      const role = org.getRole(roleId);
      if (!role) {
        return c.json({ error: "role_not_found", roleId }, 404);
      }

      const data = body || {};

      // toolGroups 可以是数组或 null
      const toolGroups = data.toolGroups;
      if (toolGroups !== null && !Array.isArray(toolGroups)) {
        return c.json({
          error: "invalid_tool_groups",
          message: "toolGroups 必须是数组或 null"
        }, 400);
      }

      // 验证工具组是否存在
      if (Array.isArray(toolGroups) && toolGroups.length > 0) {
        const toolGroupManager = society.runtime.toolGroupManager;
        if (toolGroupManager) {
          const invalidGroups = toolGroups.filter(g => !toolGroupManager.hasGroup(g));
          if (invalidGroups.length > 0) {
            return c.json({
              error: "invalid_tool_group_ids",
              message: `以下工具组不存在: ${invalidGroups.join(", ")}`,
              invalidGroups
            }, 400);
          }
        }
      }

      // 更新岗位
      const updatedRole = await org.updateRole(roleId, { toolGroups });

      if (!updatedRole) {
        return c.json({ error: "update_failed" }, 500);
      }

      void log.info("HTTP更新岗位工具组", {
        roleId,
        roleName: role.name,
        toolGroups: updatedRole.toolGroups
      });

      return c.json({
        ok: true,
        role: {
          id: updatedRole.id,
          name: updatedRole.name,
          toolGroups: updatedRole.toolGroups
        }
      });
    } catch (err) {
      void log.error("更新岗位工具组失败", { roleId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // POST /api/role/:roleId/agents — 在指定岗位下创建智能体
  app.post('/api/role/:roleId/agents', async (c) => {
    const roleId = c.req.param('roleId');

    try {
      await c.req.json().catch(() => null);
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    try {
      if (!society?.runtime?.org) {
        return c.json({ error: "society_not_initialized", message: "系统尚未初始化完成" }, 500);
      }

      if (roleId === "root" || roleId === "user") {
        return c.json({
          error: "cannot_create_agent_for_system_role",
          message: "系统岗位不支持通过该接口创建智能体"
        }, 400);
      }

      const runtime = society.runtime;
      const org = runtime.org;
      const role = org.getRole(roleId);
      if (!role || role.status === "deleted") {
        return c.json({ error: "role_not_found", message: "岗位不存在" }, 404);
      }

      const creatorAgentId = typeof role.createdBy === "string" ? role.createdBy.trim() : "";
      if (!creatorAgentId) {
        return c.json({
          error: "role_creator_not_found",
          message: "该岗位缺少创建者信息，无法创建新智能体"
        }, 400);
      }

      const creatorAgent = org.getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.status === "deleted") {
        return c.json({
          error: "role_creator_unavailable",
          message: "该岗位的创建者已不存在或已终止，无法创建新智能体"
        }, 400);
      }

      const agent = await runtime.spawnAgentAs(creatorAgentId, { roleId });
      const workspaceId = runtime.findWorkspaceIdForAgent(agent.id) || agent.id;
      const workspaceAgent = org.getAgent(workspaceId);

      void log.info("HTTP在岗位下创建智能体", {
        roleId,
        roleName: role.name,
        creatorAgentId,
        agentId: agent.id,
        workspaceId
      });

      return c.json({
        ok: true,
        agent: {
          id: agent.id,
          name: agent.name ?? agent.id,
          roleId: agent.roleId,
          roleName: agent.roleName ?? role.name,
          status: "online"
        },
        workspace: {
          id: workspaceId,
          name: workspaceAgent?.name ?? workspaceId
        }
      });
    } catch (err) {
      console.error("[HTTPServer] 在岗位下创建智能体失败", {
        roleId,
        error: err?.message,
        stack: err?.stack
      });
      void log.error("在岗位下创建智能体失败", { roleId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // POST /api/role/:roleId/prompt — 更新岗位提示词
  app.post('/api/role/:roleId/prompt', async (c) => {
    const roleId = c.req.param('roleId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
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
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const updates = {};
      if (rolePrompt !== undefined) updates.rolePrompt = rolePrompt;
      if (orgPrompt !== undefined) updates.orgPrompt = orgPrompt;

      const updatedRole = await org.updateRole(roleId, updates);

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
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const updatedRole = await org.updateRole(roleId, { llmServiceId: llmServiceId ?? null });

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
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    // 检查是否是系统岗位
    if (roleId === "root" || roleId === "user") {
      return c.json({ error: "cannot_modify_system_role", message: "不能修改系统岗位" }, 400);
    }

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
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

      const updatedRole = await org.updateRole(roleId, updates);

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
      if (!society || !society.runtime || !society.runtime.org) {
        void log.error("[批量更新岗位排序] 系统未初始化", {
          societyExists: !!society,
          runtimeExists: !!(society?.runtime),
          orgExists: !!(society?.runtime?.org),
          roleOrderCount: roleOrders?.length ?? 0
        });
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const result = await org.reorderRoles(roleOrders);

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
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const roles = org ? org.listRoles() : [];
      const agents = org ? org.listAgents() : [];

      // 过滤已删除的岗位
      const activeRoles = roles.filter(r => r.status !== "deleted");

      // 统计每个岗位的智能体数量（区分活跃和已终止）
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
    if (society?.runtime?.org) {
      const allRoles = society.runtime.org.listRoles();
      return c.json({
        allRoleIds: allRoles.map(r => ({ id: r.id, name: r.name, status: r.status }))
      });
    }
    return c.json({ error: "society_not_initialized" }, 500);
  });

  // GET /api/llm-services — 获取所有 LLM 服务列表
  app.get('/api/llm-services', async (c) => {
    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const serviceRegistry = runtime.serviceRegistry;

      if (!serviceRegistry) {
        return c.json({ services: [], count: 0 });
      }

      const services = (await serviceRegistry.getServices()).map(s => ({
        id: s.id,
        name: s.name,
        description: s.description || "",
        capabilityTags: s.capabilityTags || [],
        model: s.model
      }));

      void log.debug("HTTP查询LLM服务列表", { count: services.length });
      return c.json({ services, count: services.length });
    } catch (err) {
      void log.error("查询LLM服务列表失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化
registry.declare({
  name: 'role-routes',
  requires: ['app', 'log', 'society'],
  provides: [],
  async init(deps) { registerRoleRoutes(deps); return {}; }
});
