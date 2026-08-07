/**
 * 工具执行器模块
 * 
 * 本模块负责定义和执行所有工具，是 Runtime 的子模块之一。
 * 
 * 【设计初衷】
 * 智能体通过工具与外部世界交互，需要一个统一的模块来：
 * - 定义所有可用工具的 schema
 * - 执行工具调用
 * - 处理工具执行错误
 * 
 * 【主要功能】
 * 1. 定义工具 schema（OpenAI tools 格式）
 * 2. 执行工具调用
 * 3. 处理特殊工具（spawn_agent_with_task 等）
 * 
 * 【工具分类】
 * - 文件操作：file_read_lines、file_search、file_line_count、edit_file、replace_file、list_files、delete_file
 * - 智能体生命周期：spawn_agent_with_task
 * - 组织原语：create_role
 * - 消息通信：send_message
 * 
 * 【与其他模块的关系】
 * - 被 LlmHandler 调用来执行工具
 * - 使用 JavaScriptExecutor 执行 run_javascript
 * - 使用 AgentManager 处理智能体相关工具
 * - 使用 Runtime 的各种服务（org、bus、workspaceManager 等）
 * 
 * @module runtime/tool_executor
 */

import { FileTools } from "./tools_file.js";
import { NetworkTools } from "./tools_network.js";
import { AgentTools } from "./tools_agent.js";
import { SystemTools } from "./tools_system.js";
import { SkillTools } from "./tools_skill.js";
import { ModelTools } from "./tools_model.js";
import { ToolSchema } from "./tools_schema.js";
import { getErrorMessage } from "../utils/error_utils.js";

/**
 * 工具执行器类
 * 
 * 负责定义和执行所有工具。
 */
export class ToolExecutor {
  /**
   * 创建工具执行器实例
   * 
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
    /** @type {FileTools} 文件操作工具 */
    this.fileTools = new FileTools(runtime);
    /** @type {NetworkTools} 网络请求工具 */
    this.networkTools = new NetworkTools(runtime);
    /** @type {AgentTools} 智能体与组织管理工具 */
    this.agentTools = new AgentTools(runtime);
    /** @type {SystemTools} 系统与组织配置工具 */
    this.systemTools = new SystemTools(runtime);
    /** @type {SkillTools} 技能管理工具 */
    this.skillTools = new SkillTools(runtime);
    /** @type {ModelTools} 模型能力工具 */
    this.modelTools = new ModelTools(runtime);
    this.toolSchema = new ToolSchema(runtime, this.modelTools);
  }

  /**
   * 获取所有工具定义
   * 
   * 返回 OpenAI tools schema 格式的工具定义数组。
   * 
   * @returns {object[]} 工具定义数组
   */
  getToolDefinitions() {
    return this.toolSchema.getToolDefinitions();
  }

  /**
   * 执行工具调用
   * 
   * @param {object} ctx - 智能体上下文
   * @param {string} toolName - 工具名称
   * @param {object} args - 工具参数
   * @returns {Promise<any>} 执行结果
   */
  async executeToolCall(ctx, toolName, args) {
    const runtime = this.runtime;
    const agentId = ctx.agent?.id ?? null;

    try {
      // 【调试日志】工具执行入口，记录原始参数
      void runtime.log.info("[TOOL_EXEC_RAW] 工具执行原始参数", {
        agentId,
        toolName,
        argsType: typeof args,
        argsKeys: args ? Object.keys(args) : [],
        argsRaw: JSON.stringify(args),
        hasTaskBrief: args?.taskBrief !== undefined,
        taskBriefType: typeof args?.taskBrief,
        hasInitialMessage: args?.initialMessage !== undefined,
        initialMessageType: typeof args?.initialMessage,
        hasToolGroups: args?.toolGroups !== undefined,
        toolGroupsType: typeof args?.toolGroups
      });

      const capabilityFromToolName = this._parseCapabilityFromToolName(toolName);
      if (capabilityFromToolName) {
        return await this._executeCapabilityModelTool(ctx, capabilityFromToolName, args);
      }

      // 检查模块工具
      if (runtime.moduleLoader.hasToolName(toolName)) {
        const result = await runtime.moduleLoader.executeToolCall(ctx, toolName, args);
        void runtime.log.debug("模块工具调用完成", { toolName, ok: !result?.error });
        return result;
      }

      // 分发到具体的工具处理方法
      switch (toolName) {
        case "find_role_by_name":
          return this._executeFindRoleByName(ctx, args);
        case "create_role":
          return await this._executeCreateRole(ctx, args);
        case "delete_role":
          return await this._executeDeleteRole(ctx, args);
        case "list_org_template_infos":
          return await this._executeListOrgTemplateInfos(ctx);
        case "get_org_template_org":
          return await this._executeGetOrgTemplateOrg(ctx, args);
        case "get_org_structure":
          return this._executeGetOrgStructure(ctx, args);
        case "spawn_agent_with_task":
          return await this._executeSpawnAgentWithTask(ctx, args);
        case "send_message":
          return this._executeSendMessage(ctx, args);
        case "delete_agent":
          return await this._executeDeleteAgent(ctx, args);
        case "run_javascript":
          return await this._executeRunJavaScript(ctx, args);
        case "get_context_status":
          return this._executeGetContextStatus(ctx, args);
        case "http_request":
          return await this._executeHttpRequest(ctx, args);
        case "file_read_lines":
          return await this._executeFileReadLines(ctx, args);
        case "file_search":
          return await this._executeFileSearch(ctx, args);
        case "file_line_count":
          return await this._executeFileLineCount(ctx, args);
        case "edit_file":
          return await this._executeEditFile(ctx, args);
        case "replace_file":
          return await this._executeWriteFile(ctx, args);
        case "append_file":
          return await this._executeAppendFile(ctx, args);
        case "list_files":
          return await this._executeListFiles(ctx, args);
        case "delete_file":
          return await this._executeDeleteFile(ctx, args);
        case "move_file":
          return await this._executeMoveFile(ctx, args);
        case "get_workspace_info":
          return await this._executeGetWorkspaceInfo(ctx, args);
        case "search_text":
          return await this._executeSearchText(ctx, args);
        case "get_system_prompt_appendix":
          return this._executeGetSystemPromptAppendix(ctx);
        case "add_system_prompt_appendix_item":
          return await this._executeAddSystemPromptAppendixItem(ctx, args);
        case "remove_system_prompt_appendix_item":
          return await this._executeRemoveSystemPromptAppendixItem(ctx, args);
        case "update_system_prompt_appendix_item":
          return await this._executeUpdateSystemPromptAppendixItem(ctx, args);
        case "load_skill_detail":
          return await this._executeLoadSkillDetail(ctx, args);
        case "run_skill_script":
          return await this._executeRunSkillScript(ctx, args);
        case "skill_list":
          return await this._executeSkillList(ctx, args);
        case "skill_get":
          return await this._executeSkillGet(ctx, args);
        case "skill_create":
          return await this._executeSkillCreate(ctx, args);
        case "skill_copy":
          return await this._executeSkillCopy(ctx, args);
        case "skill_read_file":
          return await this._executeSkillReadFile(ctx, args);
        case "skill_write_file":
          return await this._executeSkillWriteFile(ctx, args);
        case "skill_create_file":
          return await this._executeSkillCreateFile(ctx, args);
        case "skill_create_folder":
          return await this._executeSkillCreateFolder(ctx, args);
        case "skill_delete_entry":
          return await this._executeSkillDeleteEntry(ctx, args);
        case "skill_rename_entry":
          return await this._executeSkillRenameEntry(ctx, args);
        case "skill_set_status":
          return await this._executeSkillSetStatus(ctx, args);
        case "skill_delete":
          return await this._executeSkillDelete(ctx, args);
        case "skill_bind_to_agent":
          return await this._executeSkillBindToAgent(ctx, args);
        case "skill_unbind_from_agent":
          return await this._executeSkillUnbindFromAgent(ctx, args);
        case "forget_skill":
          return await this._executeForgetSkill(ctx, args);
        case "add_todo_item":
          return await this._executeAddTodoItem(ctx, args);
        case "list_todo_items":
          return this._executeListTodoItems(ctx, args);
        case "update_todo_item":
          return await this._executeUpdateTodoItem(ctx, args);
        case "delete_todo_item":
          return await this._executeDeleteTodoItem(ctx, args);
        case "set_org_name":
          return await this._executeSetOrgName(ctx, args);
        case "list_tool_groups":
          return this.agentTools._executeListToolGroups(ctx);
        case "update_my_tool_groups":
          return await this.agentTools._executeUpdateMyToolGroups(ctx, args);
        default:
          void runtime.log.warn("未知工具调用", {
            // 业务信息：哪个 agent 调用了什么未知工具，传了什么参数
            agentId,
            toolName,
            args: args
          });
          return { error: `unknown_tool:${toolName}` };
      }
    } catch (err) {
      const message = getErrorMessage(err);
      const stack = err && typeof err.stack === "string" ? err.stack : undefined;
      void runtime.log.error("工具调用执行失败", {
        // 业务信息：哪个 agent 调用什么工具时失败，传了哪些参数
        agentId,
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

  // ========== 工具执行方法 ==========

  _executeFindRoleByName(ctx, args) {
    return this.agentTools._executeFindRoleByName(ctx, args);
  }

  _executeGetOrgStructure(ctx, args) {
    return this.agentTools._executeGetOrgStructure(ctx, args);
  }

  async _executeCreateRole(ctx, args) {
    return this.agentTools._executeCreateRole(ctx, args);
  }

  async _executeDeleteRole(ctx, args) {
    return this.agentTools._executeDeleteRole(ctx, args);
  }

  async _executeSpawnAgentWithTask(ctx, args) {
    return this.agentTools._executeSpawnAgentWithTask(ctx, args);
  }

  _executeSendMessage(ctx, args) {
    return this.agentTools._executeSendMessage(ctx, args);
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
    return this.agentTools._normalizeSendMessagePayload(args);
  }

  /**
   * 验证 quickReplies 参数
   * 
   * @param {any} quickReplies - 快速回复选项
   * @returns {{valid: boolean, quickReplies?: string[], error?: string, message?: string}}
   */
  _validateQuickReplies(quickReplies) {
    return this.agentTools._validateQuickReplies(quickReplies);
  }

  async _executeDeleteAgent(ctx, args) {
    return this.agentTools._executeDeleteAgent(ctx, args);
  }

  async _executeSetOrgName(ctx, args) {
    return this.agentTools._executeSetOrgName(ctx, args);
  }

  async _executeRunJavaScript(ctx, args) {
    const messageId = ctx.currentMessage?.id ?? null;
    const agentId = ctx.agent?.id ?? null;
    // 获取工作区ID
    const workspaceId = agentId ? this.runtime.findWorkspaceIdForAgent(agentId) : null;
    
    const result = await this.runtime._runJavaScriptTool(args, messageId, agentId, workspaceId);
    const hasError = result?.error !== undefined;
    
    // 如果有错误，记录错误日志
    if (hasError) {
      void this.runtime.log.error("run_javascript 执行失败", {
        toolName: "run_javascript",
        // 业务信息：哪个 agent 执行了什么 JS 代码
        agentId,
        messageId,
        workspaceId,
        codePreview: typeof args?.code === 'string' ? args.code.substring(0, 500) : null,
        argsKeys: args ? Object.keys(args).slice(0, 20) : null,
        // 技术信息：执行结果中的错误
        error: result.error,
        message: result.message
      });
    } else {
      void this.runtime.log.debug("工具调用完成", { toolName: "run_javascript", ok: true });
    }
    
    return result;
  }

  _executeGetContextStatus(ctx, args) {
    return this.systemTools._executeGetContextStatus(ctx, args);
  }

  async _executeListOrgTemplateInfos(ctx) {
    return this.systemTools._executeListOrgTemplateInfos(ctx);
  }

  async _executeGetOrgTemplateOrg(ctx, args) {
    return this.systemTools._executeGetOrgTemplateOrg(ctx, args);
  }

  async _executeHttpRequest(ctx, args) {
    return this.networkTools._executeHttpRequest(ctx, args);
  }
  
  _generateDownloadFileName(url, mimeType) {
    return this.networkTools._generateDownloadFileName(url, mimeType);
  }

  async _executeFileReadLines(ctx, args) {
    return this.fileTools._executeFileReadLines(ctx, args);
  }

  async _executeFileSearch(ctx, args) {
    return this.fileTools._executeFileSearch(ctx, args);
  }

  async _executeFileLineCount(ctx, args) {
    return this.fileTools._executeFileLineCount(ctx, args);
  }

  async _executeEditFile(ctx, args) {
    return this.fileTools._executeEditFile(ctx, args);
  }

  async _executeWriteFile(ctx, args) {
    return this.fileTools._executeWriteFile(ctx, args);
  }

  async _executeAppendFile(ctx, args) {
    return this.fileTools._executeAppendFile(ctx, args);
  }

  async _executeListFiles(ctx, args) {
    return this.fileTools._executeListFiles(ctx, args);
  }

  async _executeDeleteFile(ctx, args) {
    return this.fileTools._executeDeleteFile(ctx, args);
  }

  /**
   * 移动/重命名文件的工具执行函数
   */
  async _executeMoveFile(ctx, args) {
    return this.fileTools._executeMoveFile(ctx, args);
  }

  async _executeGetWorkspaceInfo(ctx, args) {
    return this.fileTools._executeGetWorkspaceInfo(ctx, args);
  }

  async _executeSearchText(ctx, args) {
    return this.fileTools._executeSearchText(ctx, args);
  }

  /**
   * 获取当前智能体的 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @returns {{items: string[], count: number} | {error: string, message: string}}
   */
  _executeGetSystemPromptAppendix(ctx) {
    return this.systemTools._executeGetSystemPromptAppendix(ctx);
  }

  /**
   * 新增当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{content: string}} args - 工具参数
   * @returns {Promise<{success: boolean, index: number, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeAddSystemPromptAppendixItem(ctx, args) {
    return this.systemTools._executeAddSystemPromptAppendixItem(ctx, args);
  }

  /**
   * 删除当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{index: number}} args - 工具参数
   * @returns {Promise<{success: boolean, removed: string, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeRemoveSystemPromptAppendixItem(ctx, args) {
    return this.systemTools._executeRemoveSystemPromptAppendixItem(ctx, args);
  }

  /**
   * 修改当前智能体的一条 system prompt 追加内容
   * @param {object} ctx - 智能体上下文
   * @param {{index: number, content: string}} args - 工具参数
   * @returns {Promise<{success: boolean, index: number, item: string, items: string[], count: number} | {error: string, message: string}>}
   */
  async _executeUpdateSystemPromptAppendixItem(ctx, args) {
    return this.systemTools._executeUpdateSystemPromptAppendixItem(ctx, args);
  }

  /**
   * 添加待办事项
   * @param {object} ctx - 智能体上下文
   * @param {{title: string, priority?: string}} args - 工具参数
   * @returns {Promise<{item: object, count: number} | {error: string, message: string}>}
   */
  async _executeAddTodoItem(ctx, args) {
    return this.systemTools._executeAddTodoItem(ctx, args);
  }

  /**
   * 列出待办事项
   * @param {object} ctx - 智能体上下文
   * @param {{status?: string}} args - 工具参数
   * @returns {{items: object[], count: number} | {error: string, message: string}}
   */
  _executeListTodoItems(ctx, args) {
    return this.systemTools._executeListTodoItems(ctx, args);
  }

  /**
   * 更新待办事项
   * @param {object} ctx - 智能体上下文
   * @param {{id: string, title?: string, priority?: string, status?: string}} args - 工具参数
   * @returns {Promise<{item: object, count: number} | {error: string, message: string}>}
   */
  async _executeUpdateTodoItem(ctx, args) {
    return this.systemTools._executeUpdateTodoItem(ctx, args);
  }

  /**
   * 删除待办事项
   * @param {object} ctx - 智能体上下文
   * @param {{id: string}} args - 工具参数
   * @returns {Promise<{deleted: object, count: number} | {error: string, message: string}>}
   */
  async _executeDeleteTodoItem(ctx, args) {
    return this.systemTools._executeDeleteTodoItem(ctx, args);
  }



  /**
   * 加载技能详情。
   * @param {object} ctx - 智能体上下文
   * @param {{skill?: string, skillId?: string, path?: string}} args - 工具参数
   * @returns {Promise<{skillId:string, skillName:string, path:string, content:string} | {error: string, message: string}>}
   */
  async _executeLoadSkillDetail(ctx, args) {
    return this.skillTools._executeLoadSkillDetail(ctx, args);
  }

  /**
   * 执行技能脚本。
   * @param {object} ctx - 智能体上下文
   * @param {{skill?: string, skillId?: string, scriptPath: string, args?: string[]}} args - 工具参数
   * @returns {Promise<any>}
   */
  async _executeRunSkillScript(ctx, args) {
    return this.skillTools._executeRunSkillScript(ctx, args);
  }

  // ========== 自定义技能管理工具实现 ==========

  // 简化技能记录，只返回大模型需要的字段
  _simplifySkillRecord(record) {
    return this.skillTools._simplifySkillRecord(record);
  }

  async _executeSkillList(ctx, args) {
    return this.skillTools._executeSkillList(ctx, args);
  }

  async _executeSkillGet(ctx, args) {
    return this.skillTools._executeSkillGet(ctx, args);
  }

  async _executeSkillCreate(ctx, args) {
    return this.skillTools._executeSkillCreate(ctx, args);
  }

  async _executeSkillCopy(ctx, args) {
    return this.skillTools._executeSkillCopy(ctx, args);
  }

  async _executeSkillReadFile(ctx, args) {
    return this.skillTools._executeSkillReadFile(ctx, args);
  }

  async _executeSkillWriteFile(ctx, args) {
    return this.skillTools._executeSkillWriteFile(ctx, args);
  }

  async _executeSkillCreateFile(ctx, args) {
    return this.skillTools._executeSkillCreateFile(ctx, args);
  }

  async _executeSkillCreateFolder(ctx, args) {
    return this.skillTools._executeSkillCreateFolder(ctx, args);
  }

  async _executeSkillDeleteEntry(ctx, args) {
    return this.skillTools._executeSkillDeleteEntry(ctx, args);
  }

  async _executeSkillRenameEntry(ctx, args) {
    return this.skillTools._executeSkillRenameEntry(ctx, args);
  }

  async _executeSkillSetStatus(ctx, args) {
    return this.skillTools._executeSkillSetStatus(ctx, args);
  }

  async _executeSkillDelete(ctx, args) {
    return this.skillTools._executeSkillDelete(ctx, args);
  }

  async _executeSkillBindToAgent(ctx, args) {
    return this.skillTools._executeSkillBindToAgent(ctx, args);
  }

  async _executeSkillUnbindFromAgent(ctx, args) {
    return this.skillTools._executeSkillUnbindFromAgent(ctx, args);
  }

  async _executeForgetSkill(ctx, args) {
    return this.skillTools._executeForgetSkill(ctx, args);
  }

  _buildCapabilityToolDefinitions() {
    return this.modelTools._buildCapabilityToolDefinitions();
  }

  _buildCapabilityServiceIdProperty(enumIds) {
    return this.modelTools._buildCapabilityServiceIdProperty(enumIds);
  }

  _buildCapabilityToolParameters(capability, enumIds) {
    return this.modelTools._buildCapabilityToolParameters(capability, enumIds);
  }

  _collectCapabilityServiceGroups() {
    return this.modelTools._collectCapabilityServiceGroups();
  }

  _toCapabilityToolName(capability) {
    return this.modelTools._toCapabilityToolName(capability);
  }

  _parseCapabilityFromToolName(toolName) {
    return this.modelTools._parseCapabilityFromToolName(toolName);
  }

  async _executeCapabilityModelTool(ctx, capabilitySlug, args) {
    return this.modelTools._executeCapabilityModelTool(ctx, capabilitySlug, args);
  }

  async _executeImageCapabilityTool(ctx, selectedService, prompt, args) {
    return this.modelTools._executeImageCapabilityTool(ctx, selectedService, prompt, args);
  }

  async _requestImageGeneration(service, payload) {
    return this.modelTools._requestImageGeneration(service, payload);
  }

  async _extractImageBinaryFromGenerationResponse(data) {
    return this.modelTools._extractImageBinaryFromGenerationResponse(data);
  }

  _extractTotalTokensFromGenerationResponse(data) {
    return this.modelTools._extractTotalTokensFromGenerationResponse(data);
  }

  _extensionFromMimeType(mimeType) {
    return this.modelTools._extensionFromMimeType(mimeType);
  }

  _resolveImageOutputPath(args, extension) {
    return this.modelTools._resolveImageOutputPath(args, extension);
  }

  _buildDefaultImageOutputPath(extension) {
    return this.modelTools._buildDefaultImageOutputPath(extension);
  }

  _resolveImageGenerationOptions(args) {
    return this.modelTools._resolveImageGenerationOptions(args);
  }

  _normalizeImageSizeString(value) {
    return this.modelTools._normalizeImageSizeString(value);
  }

  _validateImageSize(size) {
    return this.modelTools._validateImageSize(size);
  }

  async _buildCapabilityToolUserContent(ctx, capability, prompt, attachments) {
    return this.modelTools._buildCapabilityToolUserContent(ctx, capability, prompt, attachments);
  }

  _normalizeCapabilityAttachments(args) {
    return this.modelTools._normalizeCapabilityAttachments(args);
  }

  _resolveCapabilityPrompt(args) {
    return this.modelTools._resolveCapabilityPrompt(args);
  }

  _normalizeWorkspaceRelativePath(inputPath) {
    return this.modelTools._normalizeWorkspaceRelativePath(inputPath);
  }

  async _resolveAttachmentPathInWorkspace(ws, rawPath) {
    return this.modelTools._resolveAttachmentPathInWorkspace(ws, rawPath);
  }

  async _findPathByFilename(ws, filename, currentDir) {
    return this.modelTools._findPathByFilename(ws, filename, currentDir);
  }
}
