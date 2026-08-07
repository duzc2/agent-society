/**
 * KnowledgeTreeAgent - 知识树提炼智能体
 *
 * 独立于主智能体的知识提取子智能体。每个用户智能体 id 对应一个可复用实例，
 * 不注册到 Runtime._agents，不走 TurnEngine / ContextBuilder / ToolExecutor。
 *
 * @module services/knowledge_tree/knowledge_tree_agent
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// 工具定义（OpenAI function calling 格式）
// ---------------------------------------------------------------------------

const KNOWLEDGE_TREE_TOOLS = [
  {
    type: "function",
    function: {
      name: "knowledge_tree_create_entry",
      description: "在知识树中创建新的知识条目。父文件夹不存在时自动创建。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "父文件夹路径（以/结尾），如 /项目A/技术选型/，根目录为 /" },
          title: { type: "string", description: "条目标题，一句话概括核心内容" },
          content: { type: "string", description: "条目正文，Markdown 格式，只记录结论和原因，不记录推导过程" },
          type: { type: "string", enum: ["fact", "decision", "event", "knowledge", "summary", "action"], description: "条目类型标签" },
          importance: { type: "string", enum: ["high", "medium", "low"], description: "重要性" },
          sourceMessageIds: { type: "array", items: { type: "string" }, description: "关联的对话消息 ID（可选）" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_tree_get_entry",
      description: "按路径获取知识条目的完整内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "条目完整路径，如 /项目A/技术选型/数据库选型" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_tree_update_entry",
      description: "更新已有条目的标题、内容、类型或重要性。只传需要修改的字段。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "条目完整路径" },
          title: { type: "string", description: "新标题（可选）" },
          content: { type: "string", description: "新内容（可选）" },
          type: { type: "string", enum: ["fact", "decision", "event", "knowledge", "summary", "action"], description: "新类型（可选）" },
          importance: { type: "string", enum: ["high", "medium", "low"], description: "新重要性（可选）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_tree_delete",
      description: "删除知识条目或文件夹。删除文件夹需指定 recursive=true。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的条目/文件夹路径" },
          recursive: { type: "boolean", description: "删除文件夹时是否递归删除子内容" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_tree_search",
      description: "搜索知识树中的条目，支持按关键词、类型、重要性过滤。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          type: { type: "string", enum: ["fact", "decision", "event", "knowledge", "summary", "action"], description: "按类型过滤（可选）" },
          importance: { type: "string", enum: ["high", "medium", "low"], description: "按重要性过滤（可选）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_tree_move",
      description: "将条目或文件夹移动到新位置。",
      parameters: {
        type: "object",
        properties: {
          sourcePath: { type: "string", description: "源路径，如 /项目A/技术选型/数据库选型" },
          targetPath: { type: "string", description: "目标父文件夹路径（以/结尾），如 /归档/" },
        },
        required: ["sourcePath", "targetPath"],
      },
    },
  },
];

// 检索专用工具（仅 search + get_entry，不包含写操作）
const RETRIEVAL_TOOLS = [
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_search"),
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_get_entry"),
];

// 维护专用工具（不包含 create_entry，维护只做存量整理）
const MAINTENANCE_TOOLS = [
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_search"),
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_get_entry"),
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_update_entry"),
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_delete"),
  KNOWLEDGE_TREE_TOOLS.find(t => t.function.name === "knowledge_tree_move"),
];

// ---------------------------------------------------------------------------
// Agent 类
// ---------------------------------------------------------------------------

export class KnowledgeTreeAgent {
  /**
   * @param {{ manager: object, promptsDir: string }} opts
   */
  constructor({ manager, promptsDir }) {
    this.manager = manager;
    this.promptsDir = promptsDir;

    /** @type {string|null} */
    this._promptCache = null;

    /** @type {string|null} */
    this._retrievalPromptCache = null;

    /** @type {string|null} */
    this._maintenancePromptCache = null;
  }

  // -------------------------------------------------------------------------
  // 公开：维护入口
  // -------------------------------------------------------------------------

  /**
   * 从对话消息中提取知识，写入知识树
   * @param {string} agentId
   * @param {object} llmClient - 已初始化的 LLM 客户端
   * @param {object[]} messages - 对话消息数组
   * @param {number} [maxRounds=5] - 最大工具调用轮数
   * @returns {Promise<{ ok: boolean, report?: string, changes?: object[], error?: string }>}
   */
  async extractKnowledge(agentId, llmClient, messages, maxRounds = 5) {
    try {
      // 前置轻量检查
      if (!messages || messages.length === 0) {
        return { ok: true, report: "无新消息", changes: [] };
      }
      if (messages.every(m => m.role === "tool")) {
        return { ok: true, report: "仅含工具消息，跳过", changes: [] };
      }

      // 构建对话上下文
      const { system: chatSystem, messages: conv } = await this._buildMessages(agentId, messages);

      // LLM 处理循环
      const changes = [];
      let report = "";

      for (let round = 0; round < maxRounds; round++) {
        const resp = await llmClient.chat({
          messages: conv,
          system: chatSystem,
          tools: KNOWLEDGE_TREE_TOOLS,
        });

        // 将助手消息加入对话
        conv.push(resp);

        const toolCalls = Array.isArray(resp.tool_calls) ? resp.tool_calls : [];

        if (toolCalls.length === 0) {
          // 无工具调用 → 提取结束，收集报告文本
          report = typeof resp.content === "string" ? resp.content.trim() : "";
          break;
        }

        // 执行每个工具调用
        for (const tc of toolCalls) {
          const toolName = tc.function?.name;
          const callId = tc.id;
          if (!toolName || !callId) continue;

          let args = {};
          try {
            args = tc.function?.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            // 参数解析失败
          }

          const result = await this._executeTool(agentId, toolName, args);

          if (result.ok) {
            changes.push({ tool: toolName, args, result });
          }

          conv.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }
      }

      // 若循环耗尽未生成报告
      if (!report && changes.length > 0) {
        report = `已执行 ${changes.length} 次操作`;
      }

      return { ok: true, report: report || "无需记录", changes };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // 公开：维护存量
  // -------------------------------------------------------------------------

  /**
   * 审视已有知识树内容，执行合并、归档、删除等存量整理操作。
   * 不接收新消息，只阅读当前索引和条目来判断哪些内容需要维护。
   *
   * @param {string} agentId
   * @param {object} llmClient
   * @param {number} [maxRounds=8] - 最大工具调用轮数（维护操作较多）
   * @returns {Promise<{ ok: boolean, report?: string, changes?: object[], error?: string }>}
   */
  async maintainKnowledge(agentId, llmClient, maxRounds = 8) {
    try {
      const { system: chatSystem, messages: conv } = await this._buildMaintenanceMessages(agentId);

      const changes = [];
      let report = "";

      for (let round = 0; round < maxRounds; round++) {
        const resp = await llmClient.chat({
          messages: conv,
          system: chatSystem,
          tools: MAINTENANCE_TOOLS,
        });

        conv.push(resp);

        const toolCalls = Array.isArray(resp.tool_calls) ? resp.tool_calls : [];

        if (toolCalls.length === 0) {
          report = typeof resp.content === "string" ? resp.content.trim() : "";
          break;
        }

        for (const tc of toolCalls) {
          const toolName = tc.function?.name;
          const callId = tc.id;
          if (!toolName || !callId) continue;

          let args = {};
          try {
            args = tc.function?.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            // 参数解析失败
          }

          const result = await this._executeTool(agentId, toolName, args);

          if (result.ok) {
            changes.push({ tool: toolName, args, result });
          }

          conv.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
        }
      }

      if (!report && changes.length > 0) {
        report = `已执行 ${changes.length} 次维护操作`;
      }

      return { ok: true, report: report || "无需整理", changes };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // 公开：LLM 检索
  // -------------------------------------------------------------------------

  /**
   * 使用工具调用循环从知识树中检索相关知识。
   * 智能体自主使用 search + get_entry 查找相关条目，最后输出格式化结果。
   *
   * @param {string} agentId
   * @param {object} llmClient
   * @param {object[]} recentMessages 最近的对话消息
   * @param {string} query 当前用户查询文本
   * @returns {Promise<string|null>}
   */
  async retrieveKnowledge(agentId, llmClient, recentMessages, query) {
    try {
      // 知识库为空，无需检索，直接短路返回
      const indexContent = await this._readIndex(agentId);
      if (!this._hasEntries(indexContent)) return null;

      const { system: chatSystem, messages: conv } = await this._buildRetrievalMessages(agentId, recentMessages, query, indexContent);

      const maxRounds = 3;
      let result = "";

      for (let round = 0; round < maxRounds; round++) {
        const resp = await llmClient.chat({
          messages: conv,
          system: chatSystem,
          tools: RETRIEVAL_TOOLS,
        });

        conv.push(resp);

        const toolCalls = Array.isArray(resp.tool_calls) ? resp.tool_calls : [];

        if (toolCalls.length === 0) {
          result = typeof resp.content === "string" ? resp.content.trim() : "";
          break;
        }

        for (const tc of toolCalls) {
          const toolName = tc.function?.name;
          const callId = tc.id;
          if (!toolName || !callId) continue;

          let args = {};
          try {
            args = tc.function?.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            // 参数解析失败
          }

          const toolResult = await this._executeTool(agentId, toolName, args);

          conv.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // 无结果或无实际内容 → null
      if (!result || result === "无相关记录。" || result.includes("无相关记录")) return null;

      return result;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 私有：上下文构建
  // -------------------------------------------------------------------------

  /**
   * 加载 system prompt
   */
  async _loadSystemPrompt() {
    if (this._promptCache) return this._promptCache;

    const promptPath = path.join(this.promptsDir, "knowledge_tree.txt");
    try {
      this._promptCache = await readFile(promptPath, "utf-8");
    } catch {
      this._promptCache = this._defaultPrompt();
    }
    return this._promptCache;
  }

  /**
   * 默认 system prompt（配置文件缺失时使用）
   */
  _defaultPrompt() {
    return `你是知识整理助手，负责从智能体对话中提取结构化知识，并记录智能体做过的事情，写入知识树。

## 我的角色
- 接收一段对话历史，从两方面处理：
  1. 知识提取：识别值得长期保留的信息（决策、偏好、事实等）
  2. 活动记录：记录智能体完成的任务和操作，按活动→步骤→详情层级组织
- 知识树是文件系统式的文件夹结构，每个条目是一个 Markdown 文件

## 行为准则
1. 只记录结论和原因，不记录推导过程
2. 遇到已知信息则跳过（先 search 检查是否已有相似条目）
3. 遇到新信息覆盖旧信息时，应 update 已有条目而非新增
4. 若对话中既无值得记录的知识也无值得记录的活动，返回"无需记录"

## 知识提取：值得保留的信息
- 技术决策及其原因
- 用户明确表达的偏好、需求、约束
- 问题及其解决方案
- 重要的分析结论或判断依据
- 规格说明、接口约定、命名规范等

## 活动记录：智能体做过的事情
- 创建/修改/删除了什么文件
- 分析了什么需求，得出了什么结论
- 修复了什么问题，如何定位和解决的
- 活动按层级文件夹组织：活动 > 步骤 > 详情
- 活动文件夹: 描述性名称（如 /实现用户认证/）
- 步骤文件夹: 编号+描述（如 /实现用户认证/1-需求分析/）
- 每个活动/步骤的根目录创建概要（summary），具体操作创建 action 条目

## type 分类指导
- fact: 事实性信息（用户偏好、系统现状）
- decision: 技术决策（选择某个方案及其原因）
- event: 重要事件
- knowledge: 通用知识、最佳实践
- summary: 阶段性总结、活动概要、步骤概要
- action: 智能体执行的具体操作

## importance 分类指导
- high: 影响后续决策的核心信息
- medium: 有参考价值的信息
- low: 备忘性质的小信息

## 工作流程
1. 先阅读"当前知识树索引"，了解已有条目
2. 通读"待整理的对话"，识别值得提取的知识和值得记录的活动
3. 对每条待提取的知识：search → get_entry → update 或 create
4. 对每个值得记录的活动：创建活动文件夹→步骤文件夹→详情条目
5. 若所有信息都已涵盖且无新活动 → 返回"无需记录"

## 命名规范
- 知识类标题：一句话概括核心，如"数据库选型"、"用户偏好：深色主题"
- 活动类标题：概要用"活动概要"/"步骤概要"，操作用"动词+对象"
- 文件夹：知识类按主题（/技术选型/），活动类按层级（/实现认证/1-设计/）
- 内容为 Markdown，自由格式组织
`;
  }

  /**
   * 构建发送给 LLM 的消息列表
   */
  async _buildMessages(agentId, messages) {
    const systemPrompt = await this._loadSystemPrompt();

    // 获取当前 INDEX.md
    let indexContent = "";
    try {
      const indexPath = path.join(
        this.manager._dataDir,
        agentId,
        "knowledge-tree",
        "INDEX.md"
      );
      indexContent = await readFile(indexPath, "utf-8");
    } catch {
      indexContent = "(知识树为空)";
    }

    const userContent = [
      "你是智能体 " + agentId + " 的专属知识整理助手。",
      "",
      "【当前知识树索引】",
      "以下列出知识树中已有的所有条目。请在提取前先阅读，避免重复。",
      "",
      indexContent,
      "",
      "【待整理的对话】",
      "请从以下对话中提取值得保留的知识，并记录智能体完成的活动和操作：",
      "",
      this._formatMessages(messages),
    ].join("\n");

    return { system: systemPrompt, messages: [{ role: "user", content: userContent }] };
  }

  /**
   * 将消息数组格式化为可读文本
   */
  _formatMessages(messages) {
    const lines = [];
    for (const m of messages) {
      const role = m.role ?? "unknown";
      let content = m.content ?? "";
      if (typeof content !== "string") {
        content = JSON.stringify(content);
      }
      // 截断过长的单条消息
      if (content.length > 2000) {
        content = content.slice(0, 2000) + "...(内容过长已截断)";
      }
      const label =
        role === "user"
          ? "用户"
          : role === "assistant"
          ? "助手"
          : role === "system"
          ? "系统"
          : role === "tool"
          ? "工具返回"
          : role;
      lines.push(`[${label}] ${content}`);
    }
    return lines.join("\n\n---\n\n");
  }

  /**
   * 读取知识树索引文件
   */
  async _readIndex(agentId) {
    try {
      const indexPath = path.join(
        this.manager._dataDir,
        agentId,
        "knowledge-tree",
        "INDEX.md"
      );
      return await readFile(indexPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 判断 INDEX.md 是否包含实际条目
   */
  _hasEntries(indexContent) {
    if (!indexContent) return false;
    const lines = indexContent.split("\n").filter(l => l.trim());
    const entryLines = lines.filter(l => l.trim().startsWith("-"));
    return entryLines.length > 0;
  }

  /**
   * 将对话消息摘要为检索用的上下文文本
   */
  _buildConversationSummary(recentMessages, query) {
    const lines = [];

    // 先输出最近对话历史（自然时序，旧→新）
    // 放在前面防止 LLM 误认为 query 是对话的上一轮消息
    const msgs = (Array.isArray(recentMessages) ? recentMessages : []).slice(-10);
    for (const m of msgs) {
      const role = m.role === "user" ? "用户" :
                   m.role === "assistant" ? "助手" :
                   m.role === "tool" ? "工具" : m.role;
      let content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (content.length > 500) content = content.slice(0, 500) + "...";
      lines.push(`[${role}] ${content}`);
    }

    // 再输出当前提问（放在对话历史之后，语义正确）
    if (query && query.trim()) {
      if (lines.length > 0) lines.push("");
      lines.push(`【用户提问】${query.trim().slice(0, 500)}`);
    }

    return lines.join("\n") || `【用户提问】${(query || "").slice(0, 500)}`;
  }

  /**
   * 加载检索 system prompt
   */
  async _loadRetrievalPrompt() {
    if (this._retrievalPromptCache) return this._retrievalPromptCache;

    const promptPath = path.join(this.promptsDir, "knowledge_tree_retrieval.txt");
    try {
      this._retrievalPromptCache = await readFile(promptPath, "utf-8");
    } catch {
      this._retrievalPromptCache = this._defaultRetrievalPrompt();
    }
    return this._retrievalPromptCache;
  }

  /**
   * 默认检索 prompt（配置文件缺失时使用）
   */
  _defaultRetrievalPrompt() {
    return `你是知识检索助手。当智能体需要处理任务时，你来负责从知识树中查找相关信息。

## 工作流程
1. 阅读知识树索引，了解已有知识
2. 理解当前讨论中智能体正在处理什么问题
3. 用 search 查找可能相关的条目
4. 用 get_entry 读取完整内容，判断是否真的相关
5. 输出找到的相关知识，或输出"无相关记录。"

## 输出格式
【检索结果】
1. 标题: 内容简介
...
内容简介是从条目原文中提取的关键信息，控制在 300 字以内。
宁缺毋滥，最多输出 3 条最相关的知识。`;
  }

  /**
   * 构建检索用的消息列表
   */
  async _buildRetrievalMessages(agentId, recentMessages, query, indexContent = null) {
    const systemPrompt = await this._loadRetrievalPrompt();

    if (indexContent === null) {
      indexContent = await this._readIndex(agentId);
    }
    const indexStr = indexContent || "(知识树为空)";

    const convSummary = this._buildConversationSummary(recentMessages, query);

    const userContent = [
      "你是智能体 " + agentId + " 的知识检索助手。",
      "",
      "【知识树索引】",
      "以下列出知识树中已有的所有条目。请先阅读了解有哪些知识可用：",
      "",
      indexStr,
      "",
      "【当前讨论】",
      "以下智能体正在处理的讨论：",
      "",
      convSummary,
      "",
      "请查找与当前讨论相关的知识，按格式输出。",
    ].join("\n");

    return { system: systemPrompt, messages: [{ role: "user", content: userContent }] };
  }

  // -------------------------------------------------------------------------
  // 私有：维护消息构建
  // -------------------------------------------------------------------------

  /**
   * 加载维护 system prompt
   */
  async _loadMaintenancePrompt() {
    if (this._maintenancePromptCache) return this._maintenancePromptCache;

    const promptPath = path.join(this.promptsDir, "knowledge_tree_maintenance.txt");
    try {
      this._maintenancePromptCache = await readFile(promptPath, "utf-8");
    } catch {
      this._maintenancePromptCache = this._defaultMaintenancePrompt();
    }
    return this._maintenancePromptCache;
  }

  /**
   * 默认维护 prompt（配置文件缺失时使用）
   */
  _defaultMaintenancePrompt() {
    return `你是知识树维护助手，负责定期整理存量知识条目，保持知识树简洁有效。

## 我的角色
- 收到知识树的完整索引，审视已有内容，去芜存菁
- 纯粹做存量整理：归档已完成活动、合并分散条目、删除过时内容
- 禁止创建新条目 —— 只能更新、删除、移动

## 何时删除
- 信息已被覆盖多次，中间过程无参考价值
- low 重要性且已完成无复用价值的操作条目
- 与当前事实矛盾的旧信息

## 何时归档
- 已将整个活动文件夹 move 到 /归档/
- 已完成的决策条目 move 到 /归档/技术选型/

## 何时合并
- 同一主题的多个条目用 update_entry 汇聚到一个、delete 其余
- 文件夹下仅有 1-2 条目时提升到上级

## 注意事项
- 宁可保守，不确定时保留
- 合并前务必 get_entry 读全内容
- 条目总数 < 20 时通常无需维护
- 删除文件夹必须 recursive: true`;
  }

  /**
   * 构建维护用的消息列表
   */
  async _buildMaintenanceMessages(agentId) {
    const systemPrompt = await this._loadMaintenancePrompt();

    let indexContent = "(知识树为空)";
    try {
      const indexPath = path.join(
        this.manager._dataDir,
        agentId,
        "knowledge-tree",
        "INDEX.md"
      );
      indexContent = await readFile(indexPath, "utf-8");
    } catch { /* empty */ }

    const userContent = [
      "你是智能体 " + agentId + " 的知识树维护助手。",
      "",
      "【知识树索引】",
      "以下列出知识树中的所有条目。请审视哪些需要去芜存菁：",
      "",
      indexContent,
      "",
      "请按优先级排查：先删除明显过时的，再合并分散的，最后归档已完成的。",
    ].join("\n");

    return { system: systemPrompt, messages: [{ role: "user", content: userContent }] };
  }

  // -------------------------------------------------------------------------
  // 私有：工具执行
  // -------------------------------------------------------------------------

  /**
   * 分发执行工具调用
   */
  async _executeTool(agentId, toolName, args) {
    try {
      switch (toolName) {
        case "knowledge_tree_create_entry":
          return await this.manager.createEntry(agentId, {
            path: args.path ?? "/",
            title: args.title,
            content: args.content,
            type: args.type ?? null,
            importance: args.importance ?? null,
            sourceMessageIds: args.sourceMessageIds ?? [],
          });

        case "knowledge_tree_get_entry":
          return await this.manager.getEntry(agentId, args.path);

        case "knowledge_tree_update_entry":
          return await this.manager.updateEntry(agentId, args.path, {
            title: args.title,
            content: args.content,
            type: args.type,
            importance: args.importance,
          });

        case "knowledge_tree_delete":
          return await this.manager.deleteNode(
            agentId,
            args.path,
            args.recursive ?? false
          );

        case "knowledge_tree_search":
          return await this.manager.search(agentId, {
            query: args.query,
            type: args.type ?? null,
            importance: args.importance ?? null,
          });

        case "knowledge_tree_move":
          return await this.manager.moveNode(
            agentId,
            args.sourcePath,
            args.targetPath
          );

        default:
          return { ok: false, error: `未知工具: ${toolName}` };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
