import { formatLocalTime } from "../../../utils/logger/logger.js";
import { normalizeSystemPromptAppendix } from "./utilities.js";
import { registry } from "../../../core/module_registry.js";

/**
 * 注册智能体相关 Hono 路由。
 * 由 registry 在依赖就绪时自动调用。
 * @param {{ app: import('hono').Hono, log: any, society: any, moduleLoader: any }} deps
 */
export function registerAgentRoutes({ app, log, society, moduleLoader }) {

  // POST /api/submit — 提交需求给根智能体
  app.post('/api/submit', async (c) => {
    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const text = body?.text;
    if (!text || typeof text !== "string") {
      return c.json({ error: "missing_text", message: "请求体必须包含text字段" }, 400);
    }

    if (!society) {
      return c.json({ error: "society_not_initialized" }, 500);
    }

    const result = await society.submitRequirement(text);

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

    if (!society) {
      return c.json({ error: "society_not_initialized" }, 500);
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
    const result = await society.sendTextToAgent(agentId, messagePayload, options);

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
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const runtimeAgent = runtime._agents.get(agentId);
      const persistedAgent = runtime.org.getAgent(agentId);
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
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    if (!body || !Array.isArray(body.todoList)) {
      return c.json({ error: "invalid_todo_list", message: "todoList 必须是数组" }, 400);
    }

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const runtimeAgent = runtime._agents.get(agentId);
      const updated = await runtime.org.setAgentTodoList(agentId, body.todoList);
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
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const runtimeAgent = runtime._agents.get(agentId);
      const persistedAgent = runtime.org.getAgent(agentId);
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
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body", message: "请求体必须是 JSON 对象" }, 400);
    }

    const config = body.autoReplyConfig;

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const runtimeAgent = runtime._agents.get(agentId);
      const updated = await runtime.org.setAgentAutoReply(agentId, config);
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

  // GET /api/agent/:agentId/system-prompt — 获取智能体的完整 system prompt
  app.get('/api/agent/:agentId/system-prompt', async (c) => {
    const agentId = c.req.param('agentId');
    if (!agentId || agentId.trim() === "") {
      return c.json({ error: "missing_agent_id" }, 400);
    }

    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;

      let agent = runtime._agents.get(agentId);
      let rolePrompt = "";

      if (!agent && agentId !== "root" && agentId !== "user") {
        const org = runtime.org;
        if (org) {
          const persistedAgent = org.getAgent(agentId);
          if (persistedAgent) {
            const role = org.getRole(persistedAgent.roleId);
            rolePrompt = role?.rolePrompt || "";
            agent = {
              id: persistedAgent.id,
              roleId: persistedAgent.roleId,
              roleName: role?.name || persistedAgent.roleId,
              rolePrompt: rolePrompt
            };
          }
        }

        if (!agent) {
          return c.json({ error: "agent_not_found", agentId }, 404);
        }
      }

      const ctx = {
        agent: agent || { id: agentId, rolePrompt: "" },
        systemBasePrompt: runtime.systemBasePrompt || "",
        systemComposeTemplate: runtime.systemComposeTemplate || "",
        systemToolRules: runtime.systemToolRules || "",
        systemWorkspacePrompt: runtime.systemWorkspacePrompt || "",
        tools: {
          composePrompt: (parts) => runtime.prompts.compose(parts)
        }
      };

      const systemPrompt = await runtime._buildSystemPromptForAgent(ctx);

      void log.debug("HTTP查询智能体 system prompt", { agentId, promptLength: systemPrompt.length });
      return c.json({
        agentId,
        systemPrompt,
        length: systemPrompt.length
      });
    } catch (err) {
      void log.error("查询智能体 system prompt 失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "get_system_prompt_failed", message: err.message }, 500);
    }
  });

  // GET /api/agent/:agentId/system-prompt-appendix — 获取智能体附录条目
  app.get('/api/agent/:agentId/system-prompt-appendix', (c) => {
    const agentId = c.req.param('agentId');
    if (!agentId || agentId.trim() === "") {
      return c.json({ error: "missing_agent_id" }, 400);
    }

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const runtimeAgent = runtime._agents.get(agentId);
      const persistedAgent = runtime.org.getAgent(agentId);
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
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const runtime = society.runtime;
      const normalizedItems = normalizeSystemPromptAppendix(body.systemPromptAppendix);
      const runtimeAgent = runtime._agents.get(agentId);
      const updated = await runtime.org.setAgentSystemPromptAppendix(agentId, normalizedItems);
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

  // DELETE /api/agent/:agentId — 删除智能体（软删除）
  app.delete('/api/agent/:agentId', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => ({}));
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const reason = body?.reason || "用户删除";
    const deletedBy = body?.deletedBy || "user";

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const agent = org.getAgent(agentId);

      if (!agent) {
        return c.json({ error: "agent_not_found", message: "智能体不存在" }, 404);
      }

      if (agent.status === "deleted") {
        return c.json({ error: "agent_already_terminated", message: "智能体已被终止" }, 400);
      }

      // 不允许删除系统智能体
      if (agentId === "root" || agentId === "user") {
        return c.json({ error: "cannot_delete_system_agent", message: "不能删除系统智能体" }, 400);
      }

      const forceResult = await society.runtime.forceTerminateAgent(agentId, { deletedBy, reason });
      if (!forceResult.ok) {
        const statusCode =
          forceResult.reason === "agent_not_found" ? 404
            : forceResult.reason === "agent_already_terminated" ? 400
              : forceResult.reason === "cannot_delete_system_agent" ? 400
                : 500;
        return c.json({ error: forceResult.reason ?? "delete_failed" }, statusCode);
      }

      void log.info("删除智能体", { agentId, deletedBy, reason });
      return c.json({
        ok: true,
        agentId,
        termination: forceResult.termination
      });
    } catch (deleteErr) {
      void log.error("删除智能体失败", { agentId, error: deleteErr.message, stack: deleteErr.stack });
      return c.json({ error: "delete_failed", message: deleteErr.message }, 500);
    }
  });

  // POST /api/agent/:agentId/abort — 中断智能体的 LLM 调用
  app.post('/api/agent/:agentId/abort', async (c) => {
    const agentId = c.req.param('agentId');

    if (!society || !society.runtime) {
      void log.error("中断请求失败：系统未初始化", { agentId });
      return c.json({ error: "society_not_initialized" }, 500);
    }

    try {
      const result = await society.runtime.abortAgentLlmCall(agentId);

      if (!result.ok) {
        const statusCode = result.reason === "agent_not_found" ? 404 : 400;
        void log.warn("中断请求失败", {
          agentId,
          reason: result.reason,
          statusCode
        });
        return c.json({ error: result.reason }, statusCode);
      }

      void log.info("处理 LLM 中断请求", {
        agentId,
        aborted: result.aborted,
        reason: result.reason ?? null
      });

      return c.json({
        ok: true,
        agentId,
        aborted: result.aborted,
        reason: result.reason ?? null,
        timestamp: formatLocalTime()
      });
    } catch (err) {
      const errorMessage = err?.message ?? String(err);
      void log.error("处理中断请求时发生异常", {
        agentId,
        error: errorMessage,
        stack: err?.stack ?? null
      });

      return c.json({
        error: "internal_error",
        message: errorMessage,
        agentId
      }, 500);
    }
  });

  // GET /api/agent-custom-names — 获取所有智能体自定义名称
  app.get('/api/agent-custom-names', (c) => {
    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const org = society.runtime.org;
      const agents = org ? org.listAgents() : [];
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
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const customName = body?.customName;
    if (customName !== undefined && typeof customName !== "string") {
      return c.json({ error: "invalid_custom_name", message: "customName 必须是字符串" }, 400);
    }

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const updated = await society.runtime.org.setAgentName(agentId, customName || null);
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
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    try {
      if (!society?.runtime?.org) {
        return c.json({ error: "society_not_initialized", message: "society is not initialized" }, 500);
      }

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

      const runtime = society.runtime;
      const org = runtime.org;
      const creatorAgent = agentId === "root"
        ? { id: "root", roleId: "root", status: "active" }
        : org.getAgent(agentId);

      if (!creatorAgent) {
        return c.json({ error: "agent_not_found", message: "creator agent not found" }, 404);
      }

      if (creatorAgent.status === "deleted") {
        return c.json({ error: "agent_deleted", message: "deleted agent cannot create roles" }, 400);
      }

      const creatorRole = creatorAgent.roleId === "root"
        ? { id: "root", name: "root", orgPrompt: null }
        : org.getRole(creatorAgent.roleId);

      if (!creatorRole) {
        return c.json({ error: "creator_role_not_found", message: "creator role not found" }, 400);
      }

      const existingRole = org.findRoleByName?.(roleName) ?? null;
      if (existingRole && existingRole.status !== "deleted" && existingRole.createdBy !== agentId) {
        return c.json({
          error: "role_name_conflict",
          message: "role name is already used by another creator"
        }, 409);
      }

      const explicitLlmServiceId = typeof body?.llmServiceId === "string" ? body.llmServiceId : null;
      let llmServiceId = explicitLlmServiceId ?? null;

      if (!llmServiceId && runtime.modelSelector && runtime.serviceRegistry?.hasServices?.()) {
        try {
          const selectionResult = await runtime.modelSelector.selectService(rolePrompt);
          llmServiceId = selectionResult?.serviceId ?? null;
        } catch (selectError) {
          void log.warn("HTTP create child role model selection failed", {
            agentId,
            roleName,
            error: selectError?.message ?? String(selectError ?? "unknown"),
            stack: selectError?.stack
          });
        }
      }

      if (!llmServiceId) {
        llmServiceId = creatorRole.llmServiceId ?? null;
      }

      const role = existingRole && existingRole.status !== "deleted"
        ? existingRole
        : await org.createRole({
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
      console.error("[HTTPServer] failed to create child role for agent", {
        agentId,
        error: createError?.message,
        stack: createError?.stack
      });
      void log.error("create child role for agent failed", {
        agentId,
        error: createError.message,
        stack: createError.stack
      });
      return c.json({ error: "internal_error", message: createError.message }, 500);
    }
  });

  // DELETE /api/agent/:agentId/chrome-data — 删除智能体的Chrome用户数据目录
  app.delete('/api/agent/:agentId/chrome-data', async (c) => {
    const agentId = c.req.param('agentId');

    try {
      if (!society || !society.runtime) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      const ml = moduleLoader;
      if (!ml) {
        return c.json({ error: "module_loader_not_available" }, 500);
      }

      const chromeModule = ml.getModule("chrome");
      if (!chromeModule || typeof chromeModule.cleanupAgentData !== "function") {
        return c.json({ ok: true, message: "Chrome 模块未加载，无需清理" });
      }

      const result = await chromeModule.cleanupAgentData(agentId);
      if (result.error) {
        return c.json(result, 500);
      }

      void log.info("已删除智能体Chrome数据", { agentId });
      return c.json({ ok: true, message: "Chrome数据已删除" });
    } catch (err) {
      void log.error("删除智能体Chrome数据失败", { agentId, error: err.message, stack: err.stack });
      return c.json({ error: "delete_failed", message: err.message }, 500);
    }
  });

  // POST /api/org/:agentId/name — 设置组织显示名称
  app.post('/api/org/:agentId/name', async (c) => {
    const agentId = c.req.param('agentId');

    let body;
    try {
      body = await c.req.json().catch(() => null);
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const orgName = body?.orgName;
    if (typeof orgName !== "string") {
      return c.json({ error: "invalid_org_name", message: "orgName 必须是字符串" }, 400);
    }

    try {
      if (!society || !society.runtime || !society.runtime.org) {
        return c.json({ error: "society_not_initialized" }, 500);
      }

      await society.runtime.org.setOrgName(agentId, orgName.trim());
      const cleared = !orgName.trim();
      void log.info(cleared ? "清除组织名称" : "设置组织名称", { agentId, orgName: cleared ? "(cleared)" : orgName.trim() });
      return c.json({ ok: true, agentId, orgName: cleared ? null : orgName.trim() });
    } catch (saveErr) {
      void log.error("保存组织名称失败", { agentId, error: saveErr.message, stack: saveErr.stack });
      return c.json({ error: "save_failed", message: saveErr.message }, 500);
    }
  });
}

// 声明式注册：依赖就绪时自动初始化
registry.declare({
  name: 'agent-routes',
  requires: ['app', 'log', 'society', 'moduleLoader'],
  provides: [],
  async init(deps) { registerAgentRoutes(deps); return {}; }
});

/**
 * 构建组织层级树结构（纯函数，独立于 HTTP 上下文）。
 * 供 heartbeat 推送 org_tree 消息使用。
 * @param {object} org - OrgPrimitives 实例
 * @param {object} runtime - Runtime 实例
 * @returns {{ tree: Array, nodeCount: number }}
 */
export function buildOrgTree(org, runtime) {
  const allAgents = org.listAgents();
  const roles = org.listRoles();

  // 所有智能体（active 和 deleted）都进入树结构，由前端归档面板区分
  const agents = allAgents;

  // 创建岗位ID到信息的映射（包含sortOrder）
  const rolesWithoutOrder = roles.filter(r => r.sortOrder === undefined);

  const roleMap = new Map(roles.map((r, index) => {
    let sortOrder;
    if (r.sortOrder !== undefined) {
      sortOrder = r.sortOrder;
    } else {
      const withoutOrderIndex = rolesWithoutOrder.indexOf(r);
      sortOrder = withoutOrderIndex;
    }
    return [r.id, { name: r.name, sortOrder }];
  }));

  // 构建智能体映射
  const agentMap = new Map();
  agentMap.set("root", {
    id: "root",
    roleName: "root",
    roleId: null,
    sortOrder: 0,
    parentAgentId: null,
    status: "active",
    customName: null,
    orgName: null,
    children: [],
    computeStatus: runtime?.getAgentComputeStatus?.("root") ?? "idle",
    computePhase: runtime?.getAgentComputePhase?.("root") ?? null
  });
  agentMap.set("user", {
    id: "user",
    roleName: "user",
    roleId: null,
    sortOrder: 0,
    parentAgentId: null,
    status: "active",
    customName: null,
    orgName: null,
    children: [],
    computeStatus: runtime?.getAgentComputeStatus?.("user") ?? "idle",
    computePhase: runtime?.getAgentComputePhase?.("user") ?? null
  });

  for (const agent of agents) {
    const roleInfo = roleMap.get(agent.roleId);
    agentMap.set(agent.id, {
      id: agent.id,
      roleName: roleInfo?.name ?? agent.roleId,
      roleId: agent.roleId,
      sortOrder: roleInfo?.sortOrder ?? Date.now(),
      parentAgentId: agent.parentAgentId,
      status: agent.status ?? "active",
      customName: agent.name ?? null,
      orgName: org.getOrgName?.(agent.id) ?? null,
      children: [],
      computeStatus: runtime?.getAgentComputeStatus?.(agent.id) ?? "idle",
      computePhase: runtime?.getAgentComputePhase?.(agent.id) ?? null
    });
  }

  // 构建树结构
  const roots = [];
  for (const [id, node] of agentMap) {
    if (node.parentAgentId && agentMap.has(node.parentAgentId)) {
      agentMap.get(node.parentAgentId).children.push(node);
    } else if (id === "root" || id === "user") {
      roots.push(node);
    } else if (!node.parentAgentId) {
      roots.push(node);
    }
  }

  return {
    tree: roots,
    nodeCount: agentMap.size
  };
}
