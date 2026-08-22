/**
 * Runtime 工具管理模块
 * 
 * 本模块负责管理 Runtime 的工具相关功能，包括：
 * - 工具定义管理
 * - 工具执行
 * - 工具组管理
 * - 工具权限检查
 * 
 * 【设计目标】
 * 将 Runtime 类中的工具管理职责提取到独立模块，降低 Runtime 类的复杂度。
 * 
 * 【主要功能】
 * 1. 注册内置工具组
 * 2. 获取工具定义（全局和按智能体）
 * 3. 检查工具权限
 * 4. 执行工具调用
 * 
 * 【与其他模块的关系】
 * - 使用 ToolGroupManager 管理工具组
 * - 使用 ModuleLoader 加载模块工具
 * - 使用 ToolExecutor 执行工具调用
 * - 被 Runtime 调用提供工具管理功能
 * 
 * @module runtime/runtime_tools
 */

import { getErrorMessage } from "../utils/error_utils.js";

/**
 * Runtime 工具管理类
 * 
 * 封装 Runtime 的工具管理功能。
 */
export class RuntimeTools {
  /**
   * 创建工具管理实例
   * 
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  /**
   * 注册内置工具组的实际工具定义。
   * 在 Runtime.init() 中调用，用实际的工具定义替换 ToolGroupManager 中的占位符。
   * 
   * 【实现说明】
   * 1. 获取所有内置工具定义
   * 2. 按工具名映射到工具组
   * 3. 更新 ToolGroupManager 中的工具定义
   * 
   * @returns {void}
   */
  registerBuiltinToolGroups() {
    const runtime = this.runtime;
    
    // 获取所有内置工具定义
    const allTools = this.getToolDefinitions();
    
    // 工具名到工具组的映射
    const toolGroupMapping = {
      find_role_by_name: "org_management",
      create_role: "org_management",
      delete_role: "org_management",
      get_org_structure: "org_management",
      spawn_agent_with_task: "org_management",
      delete_agent: "org_management",
      send_message: "org_management",
      list_org_template_infos: "org_management",
      get_org_template_org: "org_management",
      file_read_lines: "workspace",
      file_search: "workspace",
      file_line_count: "workspace",
      file_read: "workspace",
      file_info: "workspace",
      file_stats: "workspace",
      file_json_tree: "workspace",
      file_json_keys: "workspace",
      file_jsonl_filter: "workspace",
      file_create_directory: "workspace",
      copy_file: "workspace",
      file_check_permission: "workspace",
      file_list_authorized_folders: "workspace",
      edit_file: "workspace",
      replace_file: "workspace",
      append_file: "workspace",
      list_files: "workspace",
      delete_file: "workspace",
      move_file: "workspace",
      search_text: "workspace",
      get_workspace_info: "workspace",
      run_javascript: "command",
      http_request: "network",
      get_context_status: "context",
      add_todo_item: "org_management",
      list_todo_items: "org_management",
      update_todo_item: "org_management",
      delete_todo_item: "org_management",
      set_org_name: "org_management",
      list_tool_groups: "model_capability",
      update_my_tool_groups: "model_capability",
      load_skill_detail: "skill",
      run_skill_script: "skill",
      skill_list: "skill",
      skill_get: "skill",
      skill_create: "skill",
      skill_copy: "skill",
      skill_read_file: "skill",
      skill_write_file: "skill",
      skill_create_file: "skill",
      skill_create_folder: "skill",
      skill_delete_entry: "skill",
      skill_rename_entry: "skill",
      skill_set_status: "skill",
      skill_delete: "skill",
      skill_bind_to_agent: "skill",
      skill_unbind_from_agent: "skill",
      forget_skill: "skill",
      get_system_prompt_appendix: "skill",
      add_system_prompt_appendix_item: "skill",
      remove_system_prompt_appendix_item: "skill",
      update_system_prompt_appendix_item: "skill"
    };
    
    // 按工具组分类
    const toolsByGroup = {
      org_management: [],
      model_capability: [],
      workspace: [],
      command: [],
      network: [],
      skill: [],
      context: [],
      console: []
    };
    
    // 分类工具定义（去重）
    const seenTools = new Set();
    for (const tool of allTools) {
      const toolName = tool?.function?.name;
      if (!toolName || seenTools.has(toolName)) continue;
      
      const groupId = toolGroupMapping[toolName] ?? (this._isModelCapabilityTool(toolName) ? "model_capability" : null);
      if (groupId && toolsByGroup[groupId]) {
        toolsByGroup[groupId].push(tool);
        seenTools.add(toolName);
      }
    }
    
    // 更新每个内置工具组的工具定义
    for (const [groupId, tools] of Object.entries(toolsByGroup)) {
      if (tools.length > 0) {
        runtime.toolGroupManager.updateGroupTools(groupId, tools);
      }
    }
    
    void runtime.log.debug("内置工具组工具定义已更新", {
      groups: Object.keys(toolsByGroup),
      toolCounts: Object.fromEntries(
        Object.entries(toolsByGroup).map(([k, v]) => [k, v.length])
      )
    });
  }

  /**
   * 获取指定智能体可用的工具定义。
   * 根据智能体岗位配置的工具组返回相应的工具定义。
   *
   * 【权限规则】
   * - root 岗位：只有 org_management 工具组
   * - 其他岗位：根据岗位配置的 toolGroups 返回工具
   * - 未配置 toolGroups：仅返回 org_management（最保守默认值）
   * - 模块工具（如 chrome_*）：归属其模块注册的工具组，按岗位 toolGroups 过滤
   * - 智能体元数据/岗位缺失：失败关闭，仅返回 org_management（不泄漏全部工具）
   *
   * @param {string} agentId - 智能体ID
   * @returns {any[]} 工具定义列表
   */
  getToolDefinitionsForAgent(agentId) {
    const runtime = this.runtime;
    const alwaysAllowedToolNames = this._buildAlwaysAllowedToolNames();

    // root 岗位硬编码只有 org_management
    if (agentId === "root") {
      const defs = runtime.toolGroupManager.getToolDefinitions(["org_management"]);
      return this._appendAlwaysAllowedTools(defs, alwaysAllowedToolNames);
    }

    // 获取智能体元数据
    const meta = runtime._agentMetaById.get(agentId);
    if (!meta) {
      // 【安全】智能体不存在：失败关闭，仅返回 org_management，绝不泄漏全部工具
      void runtime.log.warn("工具定义获取失败关闭：智能体元数据缺失", { agentId });
      const defs = runtime.toolGroupManager.getToolDefinitions(["org_management"]);
      return this._appendAlwaysAllowedTools(defs, alwaysAllowedToolNames);
    }

    // 获取岗位信息
    const role = runtime.org.getRole(meta.roleId);
    if (!role) {
      // 【安全】岗位不存在：失败关闭，仅返回 org_management，绝不泄漏全部工具
      void runtime.log.warn("工具定义获取失败关闭：岗位不存在", { agentId, roleId: meta.roleId });
      const defs = runtime.toolGroupManager.getToolDefinitions(["org_management"]);
      return this._appendAlwaysAllowedTools(defs, alwaysAllowedToolNames);
    }
    
    // 获取岗位配置的工具组，未配置则仅使用 org_management（最保守默认值）
    let toolGroups = role.toolGroups ?? ["org_management"];
    if (role.toolGroups !== null) {
      // 强制包含 org_management（去重）
      if (!role.toolGroups.includes("org_management")) {
        toolGroups = ["org_management", ...role.toolGroups];
      }
    }
    const builtinTools = runtime.toolGroupManager.getToolDefinitions(toolGroups);

    // 模块工具已通过 ToolGroupManager 注册，getToolDefinitions(toolGroups) 自动包含
    const merged = [...builtinTools];
    return this._appendAlwaysAllowedTools(merged, alwaysAllowedToolNames);
  }

  /**
   * 检查工具是否对指定智能体可用。
   *
   * 【权限规则】
   * - 始终允许：get_org_structure 与模型能力工具（call_*_model）
   * - root 岗位：只能使用 org_management 工具组
   * - 其他岗位：根据岗位配置的 toolGroups 检查（模块工具同样按工具组检查，
   *   模块工具组由模块加载时注册进 ToolGroupManager，不存在"模块工具对所有岗位可用"的例外）
   * - 智能体元数据/岗位缺失：失败关闭，仅允许 org_management（不放开全部工具）
   *
   * @param {string} agentId - 智能体ID
   * @param {string} toolName - 工具名称
   * @returns {boolean} 是否可用
   */
  isToolAvailableForAgent(agentId, toolName) {
    const runtime = this.runtime;
    if (toolName === "get_org_structure" || this._isModelCapabilityTool(toolName)) return true;

    // root 岗位硬编码只有 org_management
    if (agentId === "root") {
      return runtime.toolGroupManager.isToolInGroups(toolName, ["org_management"]);
    }

    // 获取智能体元数据
    const meta = runtime._agentMetaById.get(agentId);
    if (!meta) {
      // 【安全】智能体不存在：失败关闭，仅允许 org_management，绝不放开全部工具
      void runtime.log.warn("工具权限检查失败关闭：智能体元数据缺失", { agentId, toolName });
      return runtime.toolGroupManager.isToolInGroups(toolName, ["org_management"]);
    }

    // 获取岗位信息
    const role = runtime.org.getRole(meta.roleId);
    if (!role) {
      // 【安全】岗位不存在：失败关闭，仅允许 org_management，绝不放开全部工具
      void runtime.log.warn("工具权限检查失败关闭：岗位不存在", { agentId, roleId: meta.roleId, toolName });
      return runtime.toolGroupManager.isToolInGroups(toolName, ["org_management"]);
    }
    
    // 获取岗位配置的工具组，未配置则仅使用 org_management（最保守默认值）
    let toolGroups = role.toolGroups ?? ["org_management"];
    if (role.toolGroups !== null) {
      // 强制包含 org_management（去重）
      if (!role.toolGroups.includes("org_management")) {
        toolGroups = ["org_management", ...role.toolGroups];
      }
    }
    return runtime.toolGroupManager.isToolInGroups(toolName, toolGroups);
  }

  _appendAlwaysAllowedTools(toolDefs, alwaysAllowedToolNames) {
    const runtime = this.runtime;
    const allDefs = runtime._toolExecutor.getToolDefinitions();
    const latestByName = new Map(
      allDefs
        .map((def) => [def?.function?.name, def])
        .filter(([name, def]) => !!name && !!def)
    );
    const result = toolDefs.map((def) => {
      const name = def?.function?.name;
      if (this._isModelCapabilityTool(name) && latestByName.has(name)) {
        return latestByName.get(name);
      }
      return def;
    });
    const existing = new Set(result.map((t) => t?.function?.name).filter(Boolean));
    if (alwaysAllowedToolNames.size === 0) return result;

    for (const name of alwaysAllowedToolNames) {
      if (existing.has(name)) continue;
      const def = latestByName.get(name);
      if (def) {
        result.push(def);
        existing.add(name);
      }
    }

    return result;
  }

  _buildAlwaysAllowedToolNames() {
    const runtime = this.runtime;
    const names = new Set(["get_org_structure"]);
    const allDefs = runtime._toolExecutor.getToolDefinitions();
    for (const def of allDefs) {
      const name = def?.function?.name;
      if (this._isModelCapabilityTool(name)) {
        names.add(name);
      }
    }
    return names;
  }

  _isModelCapabilityTool(toolName) {
    return typeof toolName === "string" && /^call_[a-z0-9_]+_model$/i.test(toolName);
  }

  /**
   * 生成工具组可选值的描述文本。
   * 从 toolGroupManager 动态获取所有已注册的工具组。
   * 
   * 【用途】
   * 用于 create_role 工具的 toolGroups 参数描述，让 LLM 知道可用的工具组。
   * 
   * @returns {string} 工具组描述文本
   */
  generateToolGroupsDescription() {
    const runtime = this.runtime;
    const groups = runtime.toolGroupManager.listGroups();
    
    if (groups.length === 0) {
      return "工具组标识符列表，限制该岗位可用的工具函数。不指定则使用全部工具组。";
    }
    
    const groupDescriptions = groups
      .map(g => `${g.id}（${g.description}）`)
      .join("、");
    
    return `工具组标识符列表，限制该岗位可用的工具函数。可选值：${groupDescriptions}。不指定则使用全部工具组。`;
  }

  /**
   * 返回可供 LLM 工具调用的工具定义（OpenAI tools schema）。
   * 
   * 【实现说明】
   * 委托给 ToolExecutor 获取工具定义，这里只是提供一个统一的入口。
   * 
   * @returns {any[]} 工具定义数组
   */
  getToolDefinitions() {
    const runtime = this.runtime;
    return runtime._toolExecutor.getToolDefinitions();
  }

  /**
   * 执行一次工具调用并返回可序列化结果。
   * 
   * 【实现说明】
   * 委托给 ToolExecutor 执行工具调用，这里只是提供一个统一的入口并处理错误。
   * 
   * @param {any} ctx - 智能体上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>} 执行结果
   */
  async executeToolCall(ctx, toolName, args) {
    const runtime = this.runtime;
    const agentId = ctx?.agent?.id ?? null;

    try {
      // 【安全】工具组归属校验：本方法是唯一执行漏斗，在此强制拦截未授权工具调用。
      // 即使 LLM 工具列表已被正确过滤，也要在执行业拦截"列表外但被硬调"的工具
      // （如提示词注入诱导），执行端是最终安全边界。
      if (agentId === null || !this.isToolAvailableForAgent(agentId, toolName)) {
        const message = `agent ${agentId ?? "<unknown>"} 未获授权调用工具 ${toolName}`;
        const err = new Error(message);
        void runtime.log.error("工具调用被拒绝（未授权）", {
          // 业务信息：哪个 agent 尝试调用什么未授权工具，传了哪些参数
          agentId,
          toolName,
          args: args ?? null,
          messageId: ctx?.currentMessage?.id ?? null,
          taskId: ctx?.currentMessage?.taskId ?? null,
          // 技术信息：异常详情
          message,
          stack: err.stack,
          name: err.name,
          code: "tool_not_authorized"
        });
        // 可序列化拒绝结果：会作为 tool result 回传给 LLM，模型能感知到被拒绝
        return { error: "tool_not_authorized", toolName, agentId, message };
      }

      void runtime.log.debug("执行工具调用", {
        agentId,
        toolName,
        args: args ?? null
      });

      // 委托给 ToolExecutor 处理所有工具调用
      return await runtime._toolExecutor.executeToolCall(ctx, toolName, args);
    } catch (err) {
      const message = getErrorMessage(err);
      const stack = err && typeof err.stack === "string" ? err.stack : undefined;
      void runtime.log.error("工具调用执行失败", {
        // 业务信息：哪个 agent 调用什么工具时失败，传了哪些参数
        agentId: ctx.agent?.id ?? null,
        toolName,
        args: args,
        messageId: ctx.currentMessage?.id ?? null,
        taskId: ctx.currentMessage?.taskId ?? null,
        // 技术信息：异常详情
        message,
        stack,
        name: err?.name,
        code: err?.code
      });
      return { error: "tool_execution_failed", toolName, message, stack };
    }
  }
}
