import { normalizeSystemPromptAppendix } from "../services/http/http_server/utilities.js";

/**
 * 系统与组织配置工具 — 从 tool_executor.js 提取
 * @module runtime/系统与组织配置工具
 */

import { randomUUID } from "node:crypto";
import { getErrorMessage } from "../utils/error_utils.js";

function _formatTimestamp(d = new Date()) {
  return d.toISOString();
}

export class SystemTools {
  constructor(runtime) {
    this.runtime = runtime;
  }

  _executeGetContextStatus(ctx, args) {
    const runtime = this.runtime;
    const agentId = ctx.agent?.id ?? null;
    if (!agentId) return { error: "missing_agent_id" };
    
    const status = runtime._conversationManager.getContextStatus(agentId);
    return {
      usedTokens: status.usedTokens,
      maxTokens: status.maxTokens,
      usagePercent: status.usagePercent,
      usagePercentStr: (status.usagePercent * 100).toFixed(1) + '%',
      status: status.status,
      thresholds: {
        warning: runtime._conversationManager.contextLimit.warningThreshold,
        critical: runtime._conversationManager.contextLimit.criticalThreshold,
        hardLimit: runtime._conversationManager.contextLimit.hardLimitThreshold
      }
    };
  }

  async _executeListOrgTemplateInfos(ctx) {
    const runtime = this.runtime;
    if (!runtime.orgTemplates) return { error: "org_templates_not_initialized" };
    const templates = await runtime.orgTemplates.listTemplateInfos();
    return { templates };
  }

  async _executeGetOrgTemplateOrg(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.orgTemplates) return { error: "org_templates_not_initialized" };
    const orgName = args?.orgName;
    if (!orgName || typeof orgName !== "string") {
      return { error: "missing_org_name", message: "必须提供 orgName 参数" };
    }
    try {
      const orgMd = await runtime.orgTemplates.readOrg(orgName);
      return { orgName, orgMd };
    } catch (err) {
      if (err && (err.code === "INVALID_ORG_NAME" || err.code === "ENOENT")) {
        return { error: "org_template_not_found", orgName };
      }
      const message = getErrorMessage(err);
      return { error: "org_template_read_failed", orgName, message };
    }
  }

/**
   * 获取当前智能体的 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @returns {{items: string[], count: number} | {error: string, message: string}}
   */
  _executeGetSystemPromptAppendix(ctx) {
    const agent = ctx.agent;
    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }
    const items = normalizeSystemPromptAppendix(agent.systemPromptAppendix);
    void this.runtime.log.debug("工具调用完成", {
      toolName: "get_system_prompt_appendix",
      itemCount: items.length
    });
    return { items, count: items.length };
  }

/**
   * 新增当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{content: string}} args - 工具参数
   * @returns {Promise<{success: boolean, index: number, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeAddSystemPromptAppendixItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }
    const item = typeof args?.item === "string" ? args.item.trim() : "";
    if (!item) {
      return { error: "invalid_item", message: "item 不能为空" };
    }
    const items = normalizeSystemPromptAppendix(agent.systemPromptAppendix);
    items.push(item);
    agent.systemPromptAppendix = items;
    await ctx.org.setAgentSystemPromptAppendix(agent.id, items);
    const index = items.length - 1;
    void this.runtime.log.debug("工具调用完成", {
      toolName: "add_system_prompt_appendix_item",
      index,
      itemCount: items.length
    });
    return { success: true, index, items, count: items.length };
  }

/**
   * 删除当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{index: number}} args - 工具参数
   * @returns {Promise<{success: boolean, removed: string, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeRemoveSystemPromptAppendixItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }
    const rawIndex = Number(args?.index);
    if (!Number.isInteger(rawIndex)) {
      return { error: "invalid_index", message: "index 必须是整数" };
    }
    const items = normalizeSystemPromptAppendix(agent.systemPromptAppendix);
    if (rawIndex < 0 || rawIndex >= items.length) {
      return {
        error: "index_out_of_range",
        message: `index 超出范围，当前可用范围为 0 到 ${Math.max(items.length - 1, 0)}`
      };
    }
    const [removed] = items.splice(rawIndex, 1);
    agent.systemPromptAppendix = items;
    await ctx.org.setAgentSystemPromptAppendix(agent.id, items);
    void this.runtime.log.debug("工具调用完成", {
      toolName: "remove_system_prompt_appendix_item",
      index: rawIndex,
      itemCount: items.length
    });
    return { success: true, removed, items, count: items.length };
  }

/**
   * 修改当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{index: number, content: string}} args - 工具参数
   * @returns {Promise<{success: boolean, index: number, item: string, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeUpdateSystemPromptAppendixItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }
    const rawIndex = Number(args?.index);
    if (!Number.isInteger(rawIndex)) {
      return { error: "invalid_index", message: "index 必须是整数" };
    }
    const content = typeof args?.content === "string" ? args.content.trim() : "";
    if (!content) {
      return { error: "invalid_content", message: "content 不能为空" };
    }
    const items = normalizeSystemPromptAppendix(agent.systemPromptAppendix);
    if (rawIndex < 0 || rawIndex >= items.length) {
      return {
        error: "index_out_of_range",
        message: `index 超出范围，当前可用范围为 0 到 ${Math.max(items.length - 1, 0)}`
      };
    }
    items[rawIndex] = content;
    agent.systemPromptAppendix = items;
    await ctx.org.setAgentSystemPromptAppendix(agent.id, items);
    void this.runtime.log.debug("工具调用完成", {
      toolName: "update_system_prompt_appendix_item",
      index: rawIndex,
      itemCount: items.length
    });
    return { success: true, index: rawIndex, item: content, items, count: items.length };
  }

  /**
   * 向当前智能体添加待办事项。
   * @param {object} ctx - 智能体上下文
   * @param {{title: string, priority?: string}} args - 工具参数
   * @returns {Promise<{item: object, count: number} | {error: string, message: string}>}
   */
  async _executeAddTodoItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) return { error: "missing_agent", message: "无法获取智能体信息" };

    const title = (args?.title ?? "").trim();
    if (!title) return { error: "invalid_title", message: "待办事项标题不能为空" };

    const priority = ["high", "medium", "low"].includes(args?.priority) ? args.priority : "medium";
    const now = _formatTimestamp();

    const item = {
      id: randomUUID(),
      title,
      priority,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };

    if (!Array.isArray(agent.todoList)) {
      agent.todoList = [];
    }
    agent.todoList.push(item);

    try {
      const org = this.runtime.org;
      if (org && typeof org.setAgentTodoList === "function") {
        await org.setAgentTodoList(agent.id, agent.todoList);
      }
    } catch (e) {
      void this.runtime.log.warn("持久化 todoList 失败", {
        // 业务信息：哪个 agent 的添加操作触发了持久化失败
        agentId: agent.id,
        operation: "add",
        // 触发参数：被添加的 todo item 全量数据
        newItem: { id: item.id, title: item.title, priority: item.priority, status: item.status },
        itemCount: agent.todoList.length,
        // 技术信息：异常详情
        error: e.message,
        stack: e.stack,
        name: e?.name,
        code: e?.code
      });
    }

    return { item, count: agent.todoList.length };
  }

  /**
   * 列出当前智能体的待办事项。
   * @param {object} ctx - 智能体上下文
   * @param {{status?: string}} args - 工具参数
   * @returns {{items: object[], count: number} | {error: string, message: string}}
   */
  _executeListTodoItems(ctx, args) {
    const agent = ctx.agent;
    if (!agent) return { error: "missing_agent", message: "无法获取智能体信息" };

    const todos = Array.isArray(agent.todoList) ? agent.todoList : [];
    const statusFilter = args?.status;

    if (["pending", "in_progress", "completed", "cancelled"].includes(statusFilter)) {
      const filtered = todos.filter((item) => item.status === statusFilter);
      return { items: filtered, count: filtered.length, filter: statusFilter };
    }

    return { items: todos, count: todos.length };
  }

  /**
   * 更新当前智能体的待办事项。
   * @param {object} ctx - 智能体上下文
   * @param {{id: string, title?: string, priority?: string, status?: string}} args - 工具参数
   * @returns {Promise<{item: object, count: number} | {error: string, message: string}>}
   */
  async _executeUpdateTodoItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) return { error: "missing_agent", message: "无法获取智能体信息" };

    const id = (args?.id ?? "").trim();
    if (!id) return { error: "invalid_id", message: "待办事项 ID 不能为空" };

    if (!Array.isArray(agent.todoList)) {
      agent.todoList = [];
    }

    const index = agent.todoList.findIndex((item) => item.id === id);
    if (index === -1) {
      return { error: "todo_not_found", message: `未找到 ID 为 ${id} 的待办事项` };
    }

    const changes = {};
    if (typeof args?.title === "string") {
      const title = args.title.trim();
      if (!title) return { error: "invalid_title", message: "标题不能为空" };
      changes.title = title;
    }
    if (typeof args?.priority === "string" && ["high", "medium", "low"].includes(args.priority)) {
      changes.priority = args.priority;
    }
    if (typeof args?.status === "string" && ["pending", "in_progress", "completed", "cancelled"].includes(args.status)) {
      changes.status = args.status;
    }

    if (Object.keys(changes).length === 0) {
      return { error: "no_changes", message: "没有提供任何要更新的字段" };
    }

    Object.assign(agent.todoList[index], changes, { updatedAt: _formatTimestamp() });

    try {
      const org = this.runtime.org;
      if (org && typeof org.setAgentTodoList === "function") {
        await org.setAgentTodoList(agent.id, agent.todoList);
      }
    } catch (e) {
      void this.runtime.log.warn("持久化 todoList 失败", {
        // 业务信息：哪个 agent 的更新操作触发了持久化失败
        agentId: agent.id,
        operation: "update",
        // 触发参数：被更新的 item ID 及变更前后数据
        itemId: id,
        changes: changes,
        originalItem: { id: agent.todoList[index].id, title: agent.todoList[index].title, priority: agent.todoList[index].priority, status: agent.todoList[index].status },
        // 技术信息：异常详情
        error: e.message,
        stack: e.stack,
        name: e?.name,
        code: e?.code
      });
    }

    return { item: agent.todoList[index], count: agent.todoList.length };
  }

  /**
   * 删除当前智能体的待办事项。
   * @param {object} ctx - 智能体上下文
   * @param {{id: string}} args - 工具参数
   * @returns {Promise<{deleted: object, count: number} | {error: string, message: string}>}
   */
  async _executeDeleteTodoItem(ctx, args) {
    const agent = ctx.agent;
    if (!agent) return { error: "missing_agent", message: "无法获取智能体信息" };

    const id = (args?.id ?? "").trim();
    if (!id) return { error: "invalid_id", message: "待办事项 ID 不能为空" };

    if (!Array.isArray(agent.todoList)) {
      agent.todoList = [];
      return { error: "todo_not_found", message: `未找到 ID 为 ${id} 的待办事项` };
    }

    const index = agent.todoList.findIndex((item) => item.id === id);
    if (index === -1) {
      return { error: "todo_not_found", message: `未找到 ID 为 ${id} 的待办事项` };
    }

    const [deleted] = agent.todoList.splice(index, 1);

    try {
      const org = this.runtime.org;
      if (org && typeof org.setAgentTodoList === "function") {
        await org.setAgentTodoList(agent.id, agent.todoList);
      }
    } catch (e) {
      void this.runtime.log.warn("持久化 todoList 失败", {
        // 业务信息：哪个 agent 的删除操作触发了持久化失败
        agentId: agent.id,
        operation: "delete",
        // 触发参数：被删除的 todo item 全量数据
        itemId: id,
        deletedItem: deleted ? { id: deleted.id, title: deleted.title, priority: deleted.priority, status: deleted.status } : null,
        // 技术信息：异常详情
        error: e.message,
        stack: e.stack,
        name: e?.name,
        code: e?.code
      });
    }

    return { deleted, count: agent.todoList.length };
  }
}
