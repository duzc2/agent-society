import type { Message, TodoItem } from '../types';
import { orgTreeState, type OrgTreeNode } from './heartbeatService';

export interface AutoReplyConfig {
  enabled: boolean;
  content: string;
  delaySeconds: number;
}

export interface CommandHistoryItem {
  processId: string;
  command: string;
  agentId?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'completed' | 'error' | 'killed' | 'interrupted';
  exitCode: number | null;
  size: number;
}

export interface CommandOutputChunk {
  ok: boolean;
  content: string;
  offset: number;
  nextOffset: number;
  totalLength: number;
  hasMore: boolean;
  status: string;
  exitCode: number | null;
}

/**
 * API 调用服务
 * 封装与后端服务器的 HTTP 请求，将后端数据结构映射到前端领域模型
 */

const BASE_URL = '/api';
const DEFAULT_TIMEOUT_MS = 30000;

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  console.log('API request:', url, options);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch {
        // 忽略 JSON 解析错误
      }
      const message = detail?.message || detail?.error || `HTTP 错误: ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 统一提取消息中的 token 使用量。
 * 协议约束：
 * - 后端负责把所有 usage 统一成 camelCase；
 * - 前端只消费标准字段，不承担兼容不同服务端格式的责任。
 * @param usageSource 原始 usage 对象
 * @returns 标准化后的 token 使用量；若不存在则返回 undefined
 */
function normalizeTokenUsage(usageSource: any): Message['usage'] | undefined {
  if (!usageSource || typeof usageSource !== 'object') {
    return undefined;
  }

  const promptTokens = usageSource.promptTokens ?? 0;
  const completionTokens = usageSource.completionTokens ?? 0;
  const totalTokens =
    usageSource.totalTokens
    ?? (promptTokens + completionTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

/**
 * 将服务端原始消息（来自心跳 agent_message 或批量 API 响应）规范化为前端 Message 类型。
 * 同时被 API getMessages 和心跳 handler 使用，保证归一化逻辑一致。
 */
export function normalizeHeartbeatMessage(rawMsg: any, agentId: string): Message {
  let content = '';
  let toolCall: Message['toolCall'] = undefined;
  let usage: Message['usage'] = undefined;

  let payload = rawMsg.payload;
  if (typeof payload === 'string' && payload.trim().startsWith('{')) {
    try { payload = JSON.parse(payload); } catch { /* keep raw */ }
  }

  if (rawMsg.type === 'tool_call') {
    // 服务端存根：payload 为 { toolName, usage, hasResult, result: { files } | null }。
    // args 与 result 正文不随推送下发；result 在存根形态下保持 undefined（hasResult 标记
    // 存在性），文件列表经 payload.result.files 供 getFilesFromPayload 消费，
    // 展开时经 detail 端点懒加载正文后填充。旧服务端兼容：payload 若带全量
    // args/result（无 hasResult 字段）则直接采用。
    const isStub = payload?.hasResult !== undefined;
    toolCall = {
      name: payload?.toolName || 'unknown',
      args: payload?.args,
      result: isStub ? undefined : payload?.result,
      hasResult: isStub ? payload.hasResult === true : undefined
    };
    content = `调用工具: ${toolCall.name}`;
    usage = normalizeTokenUsage(payload?.usage);
  } else if (payload) {
    const rawContent = payload.text || payload.content || payload;
    content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2);
    usage = normalizeTokenUsage(payload.usage);
  } else {
    const rawContent = rawMsg.content || rawMsg.message || '';
    content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2);
  }

  return {
    id: rawMsg.id || Math.random().toString(36).substring(7),
    agentId,
    senderId: rawMsg.from || 'system',
    receiverId: rawMsg.to,
    senderType: (rawMsg.from === 'user' ? 'user' : 'agent') as 'user' | 'agent',
    type: rawMsg.type,
    content,
    timestamp: rawMsg.createdAt ? new Date(rawMsg.createdAt).getTime() : Date.now(),
    status: 'sent' as 'sending' | 'sent' | 'error',
    reasoning: typeof rawMsg.reasoning_content === 'string'
      ? rawMsg.reasoning_content
      : (rawMsg.reasoning_content ? JSON.stringify(rawMsg.reasoning_content, null, 2) : undefined),
    toolCall,
    taskId: rawMsg.taskId,
    usage,
    payload,
    // 存根布尔：服务端标记存在对应内容但未随推送下发，展开时懒加载
    hasReasoning: rawMsg.hasReasoning === true || undefined,
    hasMemoryContext: rawMsg.hasMemoryContext === true || undefined,
    hasKnowledgeContext: rawMsg.hasKnowledgeContext === true || undefined,
    memoryContext: typeof rawMsg.memoryContext === 'string' ? rawMsg.memoryContext : undefined,
    knowledgeContext: typeof rawMsg.knowledgeContext === 'string' ? rawMsg.knowledgeContext : undefined,
    scheduledDeliveryTime: rawMsg.scheduledDeliveryTime,
    deliveredAt: rawMsg.deliveredAt,
    // 群扇出消息的通用附加字段（extras.senderAgentId 存在 = 群来源）
    groupName: rawMsg.extras?.groupName ?? undefined,
    senderAgentId: rawMsg.extras?.senderAgentId ?? undefined,
    isSystem: rawMsg.extras?.senderAgentId === 'system' ? true : undefined,
  };
}

export const apiService = {
  /**
   * 获取所有智能体原始数据（扁平化 org_tree，同步读取）。
   * 替代原 GET /api/agents。
   */
  getAllAgentsRaw() {
    const result: any[] = [];
    function flatten(nodes: OrgTreeNode[]) {
      for (const node of nodes) {
        result.push({
          id: node.id,
          roleName: node.roleName,
          roleId: node.roleId,
          parentAgentId: node.parentAgentId,
          status: node.status,
          customName: node.customName,
          computeStatus: node.computeStatus,
          computePhase: node.computePhase
        });
        flatten(node.children);
      }
    }
    flatten(orgTreeState.tree);
    return result;
  },

  /**
   * 状态映射逻辑
   */
  mapStatus(computeStatus?: string, agentStatus?: string): 'online' | 'offline' | 'busy' {
    if (computeStatus === 'waiting_llm' || computeStatus === 'computing' || computeStatus === 'processing') {
      return 'busy';
    }
    return agentStatus === 'active' ? 'online' : 'offline';
  },

  /**
   * 获取所有岗位列表
   */
  async getRoles(): Promise<any[]> {
    const data = await request<{ roles: any[] }>('/roles');
    return data.roles || [];
  },

  /**
   * 删除岗位
   */
  async deleteRole(roleId: string, options: { reason: string, deletedBy: string }): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}`, {
      method: 'DELETE',
      body: JSON.stringify(options)
    });
  },

  /**
   * 获取单个岗位详情
   */
  async getRole(roleId: string): Promise<any> {
    const data = await request<{ role: any }>(`/role/${encodeURIComponent(roleId)}`);
    return data.role;
  },

  /**
   * 更新岗位职责提示词
   */
  async updateRolePrompt(roleId: string, rolePrompt: string): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ rolePrompt })
    });
  },

  /**
   * 更新岗位组织架构提示词
   */
  async updateRoleOrgPrompt(roleId: string, orgPrompt: string): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ orgPrompt })
    });
  },

  /**
   * 更新岗位 LLM 服务
   */
  async updateRoleLlmService(roleId: string, llmServiceId: string | null): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/llm-service`, {
      method: 'POST',
      body: JSON.stringify({ llmServiceId })
    });
  },

  /**
   * 更新岗位工具组
   */
  async updateRoleToolGroups(roleId: string, toolGroups: string[] | null): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/tool-groups`, {
      method: 'POST',
      body: JSON.stringify({ toolGroups })
    });
  },

  /**
   * 在指定岗位下创建新的智能体。
   */
  async createAgentForRole(roleId: string): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/agents`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  },

  /**
   * Create a child role for the specified agent.
   * @param agentId Creator agent ID
   * @param payload Role creation payload
   */
  async createRoleForAgent(
    agentId: string,
    payload: { name: string; rolePrompt: string }
  ): Promise<{
    ok: boolean;
    reused?: boolean;
    role: {
      id: string;
      name: string;
      rolePrompt: string;
      orgPrompt: string | null;
      createdBy: string | null;
      createdAt: string | null;
      llmServiceId: string | null;
      toolGroups: string[] | null;
    };
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/roles`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * 批量更新岗位排序顺序
   * @param roleOrders Array<{id: string, sortOrder: number}>
   */
  async reorderRoles(roleOrders: Array<{id: string, sortOrder: number}>): Promise<{ok: boolean, updated: number}> {
    return request('/roles/reorder', {
      method: 'PUT',
      body: JSON.stringify({ roleOrders })
    });
  },

  /**
   * 更新岗位功能开关（知识树、智能体记忆）
   * @param roleId 岗位ID
   * @param features { knowledgeTreeEnabled: boolean, agentMemoryEnabled: boolean }
   */
  async updateRoleFeatures(roleId: string, features: { knowledgeTreeEnabled?: boolean; agentMemoryEnabled?: boolean }): Promise<any> {
    return request(`/role/${encodeURIComponent(roleId)}/features`, {
      method: 'POST',
      body: JSON.stringify(features)
    });
  },

  /**
   * 删除智能体的Chrome用户数据目录
   * @param agentId 智能体ID
   */
  async deleteAgentChromeData(agentId: string): Promise<{ ok: boolean; message?: string }> {
    return request(`/agent/${encodeURIComponent(agentId)}/chrome-data`, {
      method: 'DELETE'
    });
  },

  /**
   * 获取工具组列表
   */
  async getToolGroups(): Promise<any[]> {
    const data = await request<{ toolGroups: any[] }>('/tool-groups');
    return data.toolGroups || [];
  },

  /**
   * 为 root 开启新会话
   */
  async rootNewSession(): Promise<void> {
    await request('/root/new-session', { method: 'POST', body: JSON.stringify({}) });
  },

  /**
   * 获取消息历史
   * @param agentId 智能体ID
   * @param params 分页参数 { limit: number, before: string, around: string }
   */
  async getMessages(agentId: string, params?: { limit?: number; before?: string; around?: string }): Promise<{ messages: Message[], hasMore: boolean, total: number, regenerableMessageId?: string | null }> {
    const queryParts = [];
    if (params?.limit) queryParts.push(`limit=${params.limit}`);
    if (params?.before) queryParts.push(`before=${encodeURIComponent(params.before)}`);
    if (params?.around) queryParts.push(`around=${encodeURIComponent(params.around)}`);

    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    const data = await request<{ messages: any[], hasMore?: boolean, total?: number, regenerableMessageId?: string | null }>(`/agent-messages/${encodeURIComponent(agentId)}${queryString}`);

    const messages = data.messages.map(msg => normalizeHeartbeatMessage(msg, agentId));

    return {
      messages,
      hasMore: data.hasMore ?? false,
      total: data.total ?? messages.length,
      regenerableMessageId: data.regenerableMessageId ?? null
    };
  },

  /**
   * 批量获取所有智能体的最新消息（心跳推送的首屏加载）。
   * @param limit 每个智能体返回的最大消息数，默认 50
   */
  async getAllAgentMessages(limit = 50): Promise<Record<string, Message[]>> {
    const data = await request<{ agents: Record<string, { messages: any[], total: number }> }>(`/agents/messages?limit=${limit}`);
    const result: Record<string, Message[]> = {};
    for (const [agentId, { messages }] of Object.entries(data.agents)) {
      result[agentId] = messages.map(msg => normalizeHeartbeatMessage(msg, agentId));
    }
    return result;
  },

  /**
   * 搜索消息
   */
  async searchMessages(agentId: string, query: string): Promise<any[]> {
    const data = await request<{ matches: any[] }>(`/agent-messages/${encodeURIComponent(agentId)}/search?q=${encodeURIComponent(query)}`);
    return data.matches || [];
  },

  /**
   * 获取单条消息完整详情（懒加载用）。
   * 服务端推送/列表为裁剪存根（不含思考/记忆/知识/工具正文），
   * 展开时按消息 ID 经此端点回查全量。
   * @returns 服务端原始消息对象（未 normalize）
   */
  async getMessageDetail(agentId: string, messageId: string): Promise<any> {
    const data = await request<{ message: any }>(`/agent-messages/${encodeURIComponent(agentId)}/detail/${encodeURIComponent(messageId)}`);
    return data.message;
  },

  /**
   * 发送消息
   */
  async sendMessage(toAgentId: string, content: string): Promise<{
    ok: boolean;
    messageId: string;
    taskId: string;
    to: string;
  }> {
    return request('/send', {
      method: 'POST',
      body: JSON.stringify({
        to: toAgentId,
        message: content,
      }),
    });
  },

  /**
   * 中断指定智能体的 LLM 调用
   */
  async abortAgentLlmCall(agentId: string): Promise<{ ok: boolean; aborted: boolean; stopped?: boolean }> {
    return request<{ ok: boolean; aborted: boolean; stopped?: boolean }>(`/agent/${encodeURIComponent(agentId)}/abort`, {
      method: 'POST'
    });
  },

  /**
   * 删除智能体（软删除）
   * @param agentId 智能体ID
   * @param options 删除选项
   */
  async deleteAgent(agentId: string, options: { reason?: string; deletedBy?: string } = {}): Promise<{ ok: boolean; agentId: string; termination?: any }> {
    return request(`/agent/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({
        reason: options.reason || '用户删除',
        deletedBy: options.deletedBy || 'user'
      })
    });
  },

  /**
   * 更新消息内容
   */
  async updateMessage(agentId: string, messageId: string, content: string): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
  },

  /**
   * 重新生成最后一条大模型回复
   */
  async regenerateMessage(agentId: string, messageId: string): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  },

  /**
   * 对用户最后一条消息生成回复
   */
  async generateReply(agentId: string, messageContent: string): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/generate-reply`, {
      method: 'POST',
      body: JSON.stringify({ messageContent })
    });
  },

  /**
   * 获取推荐回复建议
   */
  async suggestReplies(agentId: string): Promise<{ ok: boolean; suggestions: string[] }> {
    return request(`/agent/${encodeURIComponent(agentId)}/suggest-replies`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  /**
   * 删除单条消息
   */
  async deleteMessage(agentId: string, messageId: string): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE'
    });
  },

  /**
   * 批量删除消息
   */
  async deleteMessages(agentId: string, messageIds: string[]): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/messages/batch-delete`, {
      method: 'POST',
      body: JSON.stringify({ messageIds })
    });
  },

  /**
   * 清空聊天记录
   */
  async clearHistory(agentId: string): Promise<any> {
    return request(`/agent/${encodeURIComponent(agentId)}/history`, {
      method: 'DELETE'
    });
  },

  /**
   * 获取智能体修改的文件列表
   * @param workspaceId 工作区ID
   * @param agentId 智能体ID
   */
  async getAgentFiles(workspaceId: string, agentId: string): Promise<{
    workspaceId: string;
    agentId: string;
    files: Array<{
      name: string;
      path: string;
      size: number;
      extension: string;
      modifiedAt: string;
      mimeType: string;
      lastOperator: string;
      lastMessageId: string;
    }>;
    count: number;
  }> {
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/agent-files/${encodeURIComponent(agentId)}`);
  },

  /**
   * 获取文件完整元数据
   * @param workspaceId 工作区ID
   * @param filePath 文件路径
   */
  async getFileMeta(workspaceId: string, filePath: string): Promise<Record<string, any>> {
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/file-meta?path=${encodeURIComponent(filePath)}`);
  },

  /**
   * 获取文件修改历史
   * @param workspaceId 工作区ID
   * @param filePath 文件路径
   */
  async getFileHistory(workspaceId: string, filePath: string): Promise<{
    history: Array<{
      index: number;
      operator: string;
      messageId: string;
      timestamp: string;
      action: string;
      size: number;
      versionId: string;
    }>;
  }> {
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/file-history?path=${encodeURIComponent(filePath)}`);
  },

  /**
   * 获取指定版本文件内容
   * @param workspaceId 工作区ID
   * @param filePath 文件路径
   * @param index 版本索引
   */
  async getFileVersion(workspaceId: string, filePath: string, index: number): Promise<string> {
    const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/file-version?path=${encodeURIComponent(filePath)}&index=${index}`;
    const response = await fetch(url);
    if (!response.ok) {
      let detail: any = null;
      try { detail = await response.json(); } catch { /* ignore */ }
      throw new Error(detail?.error || `获取版本内容失败: HTTP ${response.status}`);
    }
    return response.text();
  },

  async getAgentSystemPrompt(agentId: string): Promise<{
    agentId: string;
    systemPrompt: string;
    length: number;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/system-prompt`);
  },

  /**
   * 获取智能体 systemPromptAppendix 条目列表。
   * @param agentId 智能体 ID
   */
  async getAgentSystemPromptAppendix(agentId: string): Promise<{
    agentId: string;
    systemPromptAppendix: string[];
    count: number;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/system-prompt-appendix`);
  },

  /**
   * 保存智能体 systemPromptAppendix 条目列表。
   * @param agentId 智能体 ID
   * @param systemPromptAppendix 需要覆盖保存的附录条目列表
   */
  async updateAgentSystemPromptAppendix(agentId: string, systemPromptAppendix: string[]): Promise<{
    ok: boolean;
    agentId: string;
    systemPromptAppendix: string[];
    count: number;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/system-prompt-appendix`, {
      method: 'PUT',
      body: JSON.stringify({ systemPromptAppendix })
    });
  },

  /**
   * 获取智能体待办列表。
   * @param agentId 智能体 ID
   */
  async getAgentTodoList(agentId: string): Promise<{
    agentId: string;
    todoList: TodoItem[];
    count: number;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/todo-list`);
  },

  /**
   * 保存智能体待办列表。
   * @param agentId 智能体 ID
   * @param todoList 需要覆盖保存的待办列表
   */
  async updateAgentTodoList(agentId: string, todoList: TodoItem[]): Promise<{
    ok: boolean;
    agentId: string;
    todoList: TodoItem[];
    count: number;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/todo-list`, {
      method: 'PUT',
      body: JSON.stringify({ todoList })
    });
  },

  /**
   * 获取智能体自动回复配置。
   * @param agentId 智能体 ID
   */
  async getAutoReply(agentId: string): Promise<{
    agentId: string;
    autoReplyConfig: AutoReplyConfig | null;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/auto-reply`);
  },

  /**
   * 保存智能体自动回复配置。
   * @param agentId 智能体 ID
   * @param config 自动回复配置，传入 null 表示禁用并清除
   */
  async updateAutoReply(agentId: string, config: AutoReplyConfig | null): Promise<{
    ok: boolean;
    agentId: string;
    autoReplyConfig: AutoReplyConfig | null;
  }> {
    return request(`/agent/${encodeURIComponent(agentId)}/auto-reply`, {
      method: 'PUT',
      body: JSON.stringify({ autoReplyConfig: config })
    });
  },

  /**
   * 获取所有已加载模块列表
   */
  async getModules(): Promise<ModuleInfo[]> {
    const data = await request<{ ok: boolean; modules: ModuleInfo[]; count: number }>('/modules');
    return data.modules || [];
  },

  /**
   * 获取指定模块的 Web 组件定义
   * @param moduleName 模块名称
   */
  async getModuleWebComponent(moduleName: string): Promise<ModuleWebComponent | null> {
    try {
      const data = await request<{
        ok: boolean;
        component?: ModuleWebComponent;
        html?: string;
        css?: string;
        js?: string;
        moduleName?: string;
        displayName?: string;
        icon?: string;
      }>(`/modules/${encodeURIComponent(moduleName)}/web-component`);

      // 如果有 component 字段，直接返回
      if (data.component) {
        return data.component;
      }

      // 如果有 html 字段，构造组件对象（有 panelPath 的情况）
      if (data.html !== undefined) {
        return {
          moduleName: data.moduleName || moduleName,
          displayName: data.displayName || moduleName,
          icon: data.icon || '📦',
          html: data.html,
          css: data.css,
          js: data.js
        };
      }

      return null;
    } catch {
      return null;
    }
  },

  /**
   * 设置组织显示名称
   * @param agentId 组织入口智能体ID
   * @param orgName 组织名称
   */
  async setOrgName(agentId: string, orgName: string): Promise<{ ok: boolean; agentId: string; orgName: string }> {
    return request(`/org/${encodeURIComponent(agentId)}/name`, {
      method: 'POST',
      body: JSON.stringify({ orgName })
    });
  },

  // ---- 历史命令 ----

  async getCommandHistory(agentId: string, params: { offset?: number; limit?: number; search?: string } = {}): Promise<{ items: CommandHistoryItem[]; total: number }> {
    const q = [`agentId=${encodeURIComponent(agentId)}`];
    if (params.offset != null) q.push(`offset=${params.offset}`);
    if (params.limit != null) q.push(`limit=${params.limit}`);
    if (params.search) q.push(`search=${encodeURIComponent(params.search)}`);
    const data = await request<{ items: CommandHistoryItem[]; total: number }>(`/modules/localcmd/history?${q.join('&')}`);
    return { items: data.items || [], total: data.total ?? 0 };
  },

  async getCommandOutput(processId: string, params: { offset?: number; window?: number } = {}): Promise<CommandOutputChunk> {
    const q = [];
    if (params.offset != null) q.push(`offset=${params.offset}`);
    if (params.window != null) q.push(`window=${params.window}`);
    const qs = q.length ? `?${q.join('&')}` : '';
    return request<CommandOutputChunk>(`/modules/localcmd/history/${encodeURIComponent(processId)}/output${qs}`);
  },

  async clearCommandHistory(agentId: string): Promise<{ ok: boolean; deletedCount: number; skippedCount: number }> {
    return request(`/modules/localcmd/history?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  },

  // ---- 群聊 ----

  /** 获取所有群列表 */
  async getGroups(orgId?: string): Promise<{ groups: Array<{ id: string; name: string; creatorId: string; memberCount: number; isMember: boolean }> }> {
    const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
    return request(`/groups${q}`);
  },

  /** 获取群详情 */
  async getGroupInfo(groupId: string): Promise<{
    id: string; name: string; description?: string; orgKey: string;
    creatorId: string; members: string[]; createdAt: string; dissolved?: boolean;
  }> {
    return request(`/groups/${encodeURIComponent(groupId)}`);
  },

  /** 获取群消息历史（后端分页仅支持 limit+offset） */
  async getGroupMessages(groupId: string, params: { limit?: number; offset?: number } = {}): Promise<{
    messages: Array<{ id: string; groupId: string; kind: string; from: string; taskId?: string | null; payload: { text: string }; createdAt: string }>;
    hasMore: boolean;
  }> {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    const qs = q.toString();
    return request(`/groups/${encodeURIComponent(groupId)}/messages${qs ? `?${qs}` : ''}`);
  },

  /** 创建群聊 */
  async createGroup(name: string, memberIds: string[], description?: string, reason?: string): Promise<{ id: string; name: string }> {
    return request('/groups', {
      method: 'POST',
      body: JSON.stringify({ name, memberIds, description, reason }),
    });
  },

  /** 发送群消息 */
  async sendGroupMessage(groupId: string, text: string): Promise<{ messageId: string; memberCount: number }> {
    return request(`/groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  /** 邀请成员入群 */
  async inviteToGroup(groupId: string, memberIds: string[], reason?: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds, reason }),
    });
  },

  /** 编辑群消息 */
  async updateGroupMessage(groupId: string, messageId: string, text: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: JSON.stringify({ text }),
    });
  },

  /** 删除群消息 */
  async deleteGroupMessage(groupId: string, messageId: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  },

  /** 移出成员 */
  async removeFromGroup(groupId: string, memberId: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'DELETE',
    });
  },

  /** 退群 */
  async leaveGroup(groupId: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}/leave`, { method: 'POST' });
  },

  /** 解散群 */
  async dissolveGroup(groupId: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  },

};

/**
 * 模块信息
 */
export interface ModuleInfo {
  name: string;
  toolGroupId: string;
  toolGroupDescription: string;
  hasWebComponent: boolean;
  hasHttpHandler: boolean;
}

/**
 * 模块 Web 组件定义
 */
export interface ModuleWebComponent {
  moduleName: string;
  displayName: string;
  icon: string;
  html: string;
  css?: string;
  js?: string;
}
