/**
 * 核心领域模型类型定义（移动端精简版）
 * 移除：Tab, OrgTemplate, TemplateContent（桌面端独有）
 */

export interface User {
  id: string;
  name: string;
  avatar?: string;
}

export interface Organization {
  id: string;
  name: string;
  initial: string;
  role?: string;
  description?: string;
  sortOrder?: number;
}

export type AgentComputeStatus =
  | 'idle'
  | 'waiting_llm'
  | 'processing'
  | 'computing'
  | 'stopping'
  | 'stopped'
  | 'terminating'
  | string;

export interface Agent {
  id: string;
  orgId: string;
  parentAgentId?: string | null;
  name: string;
  avatar?: string;
  role: string;
  roleId?: string | null;
  status: 'online' | 'offline' | 'busy';
  computeStatus?: AgentComputeStatus;
  computePhase?: string | null;
  lastSeen?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Message {
  id: string;
  agentId: string;
  senderId: string;
  senderType: 'user' | 'agent';
  type?: string;
  receiverId?: string;
  content: string;
  timestamp: number;
  status: 'sending' | 'sent' | 'error';
  isThinking?: boolean;
  taskId?: string;
  reasoning?: string;
  toolCall?: {
    name: string;
    args: any;
    result: any;
  };
  usage?: TokenUsage;
  payload?: any;
  memoryContext?: string; // AgentMemory 召回结果
  knowledgeContext?: string; // KnowledgeTree 检索结果
  scheduledDeliveryTime?: string;
  deliveredAt?: string;
  sendTime?: string;
  senderName?: string; // 群聊消息发送者名称
  isSystem?: boolean; // 群聊系统消息标记
  groupName?: string; // 群来源消息的群名（个人视图显示"来自群聊 X"）
  senderAgentId?: string; // 群来源消息的原发送者（'system' = 群系统通知）
}

// ========== 群聊相关类型（移动端） ==========

/** 群元数据 */
export interface GroupMeta {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  members?: Array<{ id: string; name: string; status: string }>;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
}

/** 群聊摘要（轻量） */
export interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

/** 群聊消息 */
export interface GroupMessage {
  id: string;
  groupId: string;
  kind: 'group' | 'group_system';
  from: string;
  payload: { text: string };
  createdAt: string;
}
