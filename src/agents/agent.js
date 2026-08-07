import { normalizeSystemPromptAppendix } from "../platform/services/http/http_server/utilities.js";

/**
 * 智能体实例：封装岗位信息与消息处理入口。
 */
export class Agent {
  /**
   * @param {{id:string, roleId:string, roleName:string, rolePrompt:string, behavior:Function, systemPromptAppendix?:string|string[], lastMemoryMessageId?:string, name?:string}} options
   */
  constructor(options) {
    this.id = options.id;
    this.roleId = options.roleId;
    this.roleName = options.roleName;
    this.rolePrompt = options.rolePrompt;
    this._behavior = options.behavior;
    /**
     * 智能体名称
     * @type {string|null}
     */
    this.name = options.name ?? null;
    /**
     * system prompt 追加内容列表
     * 每次请求大模型时，该列表内容会被追加到 system 提示词最后
     * 由智能体通过工具函数 get_system_prompt_appendix / add/remove/update_system_prompt_appendix_item 管理
     * @type {string[]}
     */
    this.systemPromptAppendix = normalizeSystemPromptAppendix(options.systemPromptAppendix);
    /**
     * 技能提示词缓存
     * 用于缓存技能总览内容，不持久化，仅运行时存在
     * - null: 未加载，需要从文件读取
     * - 空字符串: 无技能
     * - 有内容: 技能总览内容
     * @type {string|null}
     */
    this.skillPromptCache = null;
    /**
     * 最后发送给记忆系统的消息ID
     * 用于追踪哪些聊天记录已被记忆处理，避免重复处理
     * 该字段随智能体状态持久化到 org.json
     * @type {string|null}
     */
    this.lastMemoryMessageId = options.lastMemoryMessageId ?? null;
    /**
     * 待办事项列表
     * 由智能体通过工具函数 add_todo_item / list_todo_items / update_todo_item / delete_todo_item 管理
     * @type {Array<{id:string, title:string, priority:string, status:string, createdAt:string, updatedAt:string}>}
     */
    this.todoList = Array.isArray(options.todoList) ? options.todoList : [];
    /**
     * 自动回复配置
     * 由 AutoReplyManager 读取，决定是否在智能体 idle 时自动发送回复
     * @type {{enabled:boolean, content:string, delaySeconds:number}|null}
     */
    this.autoReplyConfig = options.autoReplyConfig ?? null;
  }

  /**
   * 处理收到的异步消息。
   * @param {any} ctx 运行时上下文
   * @param {{payload:any, from:string, to:string, taskId?:string}} message
   * @returns {Promise<void>}
   */
  async onMessage(ctx, message) {
    await this._behavior(ctx, message);
  }

}
