import type { Message } from '../types';

/**
 * API 调用服务（移动端精简版）
 * 仅包含移动端需要的端点：
 * - 组织列表
 * - 智能体列表（按组织 + 全局）
 * - 消息获取 / 发送 / 历史
 * - 中断 LLM
 * - 根节点新会话
 * - root 发送消息（创建组织）
 * - 获取智能体文件
 */

const BASE_URL = '/api';

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
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
    console.error('[API] 请求失败', {
      endpoint: `${BASE_URL}${endpoint}`,
      method: options?.method || 'GET',
      status: response.status,
      statusText: response.statusText,
      errorMessage: message,
      detail
    });
    throw new Error(message);
  }

  return response.json();
}

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
    toolCall = {
      name: payload?.toolName || 'unknown',
      args: payload?.args,
      result: payload?.result
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
  /** root 开启新会话 */
  async rootNewSession(): Promise<void> {
    await request('/root/new-session', { method: 'POST', body: JSON.stringify({}) });
  },

  /** 获取消息历史 */
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

  /** 批量获取所有智能体的最新消息（心跳推送的首屏加载） */
  async getAllAgentMessages(limit = 50): Promise<Record<string, Message[]>> {
    const data = await request<{ agents: Record<string, { messages: any[], total: number }> }>(`/agents/messages?limit=${limit}`);
    const result: Record<string, Message[]> = {};
    for (const [agentId, { messages }] of Object.entries(data.agents)) {
      result[agentId] = messages.map(msg => normalizeHeartbeatMessage(msg, agentId));
    }
    return result;
  },

  /** 发送消息 */
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

  /** 中断 LLM 调用 */
  async abortAgentLlmCall(agentId: string): Promise<{ ok: boolean; aborted: boolean; stopped?: boolean }> {
    return request<{ ok: boolean; aborted: boolean; stopped?: boolean }>(`/agent/${encodeURIComponent(agentId)}/abort`, {
      method: 'POST'
    });
  },

  /** 删除智能体 */
  async deleteAgent(agentId: string, options: { reason?: string; deletedBy?: string } = {}): Promise<{ ok: boolean; agentId: string; termination?: any }> {
    return request(`/agent/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({
        reason: options.reason || '用户删除',
        deletedBy: options.deletedBy || 'user'
      })
    });
  },

  /** 获取智能体修改的文件列表 */
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

  /** 获取工作区文件树 */
  async getWorkspaceTree(workspaceId: string): Promise<{
    files: Array<{ name: string; path: string; size: number; extension: string; modifiedAt: string; mimeType: string; lastOperator: string; lastMessageId: string }>;
    directories: Array<{ name: string; path: string }>;
  }> {
    return request(`/workspaces/${encodeURIComponent(workspaceId)}`);
  },

  /** 读取工作区文件内容 */
  async getWorkspaceFileContent(workspaceId: string, filePath: string): Promise<{ content: string; mimeType: string }> {
    const url = `/workspace-files/${encodeURIComponent(workspaceId)}/${encodeURIComponent(filePath)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`读取文件失败: ${response.status}`);
    }
    const contentType = response.headers.get('Content-Type') || '';
    // MIME 类型文本检测
    const isTextMime = contentType.startsWith('text/') ||
      contentType === 'application/json' ||
      contentType === 'application/javascript' ||
      contentType === 'application/x-javascript' ||
      contentType === 'application/typescript' ||
      contentType === 'application/x-typescript' ||
      contentType.startsWith('image/svg') ||
      contentType.includes('xml');
    // 扩展名回退：防止工具创建的文件 MIME 类型为 application/octet-stream 时被误判为二进制
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const textExtensions = [
      'js', 'ts', 'jsx', 'tsx', 'vue', 'css', 'scss', 'less', 'html', 'htm',
      'xml', 'yaml', 'yml', 'json', 'md', 'txt', 'log', 'csv',
      'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php',
      'sh', 'bat', 'cmd', 'ini', 'conf', 'cfg', 'properties', 'env'
    ];
    const isText = isTextMime || textExtensions.includes(ext);
    if (isText) {
      const content = await response.text();
      return { content, mimeType: contentType };
    }
    // 二进制文件返回 URL
    return { content: url, mimeType: contentType };
  },

  /** 创建工作区目录 */
  async createWorkspaceDirectory(workspaceId: string, relativePath: string): Promise<any> {
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/directory`, {
      method: 'POST',
      body: JSON.stringify({ path: relativePath })
    });
  },

  /** 删除工作区文件或目录 */
  async deleteWorkspaceEntry(workspaceId: string, relativePath: string, type: 'file' | 'directory'): Promise<any> {
    const params = `?path=${encodeURIComponent(relativePath)}`;
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/${type}${params}`, {
      method: 'DELETE'
    });
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

  /** 上传文件到工作区 */
  async uploadWorkspaceFile(workspaceId: string, file: File, relativePath: string): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('workspaceId', workspaceId);
    formData.append('path', relativePath);
    formData.append('filename', file.name);

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail?.message || `上传失败: ${response.status}`);
    }
    return response.json();
  },

  // ---- 群聊 API ----

  /** 获取群列表 */
  async getGroupList(): Promise<{ groups: import('../types').GroupMeta[] }> {
    return request('/groups');
  },

  /** 获取群详情 */
  async getGroupInfo(groupId: string): Promise<import('../types').GroupMeta> {
    return request(`/groups/${encodeURIComponent(groupId)}`);
  },

  /** 获取群消息 */
  async getGroupMessages(groupId: string, params: { limit?: number; offset?: number } = {}): Promise<{ messages: import('../types').GroupMessage[]; hasMore: boolean }> {
    const q = [`limit=${params.limit ?? 50}`];
    if (params.offset) q.push(`offset=${params.offset}`);
    return request(`/groups/${encodeURIComponent(groupId)}/messages?${q.join('&')}`);
  },

  /** 创建群聊 */
  async createGroup(name: string, members: string[], reason: string, description?: string): Promise<import('../types').GroupMeta> {
    return request('/groups', {
      method: 'POST',
      body: JSON.stringify({ name, members, reason, description }),
    });
  },

  /** 发送群消息 */
  async sendGroupMessage(groupId: string, text: string): Promise<{ messageId: string }> {
    return request(`/groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  /** 邀请成员入群 */
  async inviteToGroup(groupId: string, memberIds: string[], reason: string): Promise<{ ok: boolean; group: import('../types').GroupMeta }> {
    return request(`/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds, reason }),
    });
  },

  /** 解散群聊 */
  async dissolveGroup(groupId: string): Promise<{ ok: boolean }> {
    return request(`/groups/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
    });
  },
};
