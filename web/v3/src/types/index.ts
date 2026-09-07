/**
 * 核心领域模型类型定义
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
  role?: string; // 岗位名称
  description?: string;
  sortOrder?: number; // 排序顺序
}

/**
 * 智能体计算状态。
 * 前端保留原始状态，用于跨组织判断某个组织内是否仍有未 idle 的智能体。
 */
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
  senderId: string; // User ID or Agent ID
  senderType: 'user' | 'agent';
  type?: string; // 消息类型，如 tool_call, text 等
  receiverId?: string;
  content: string;
  timestamp: number;
  status: 'sending' | 'sent' | 'error';
  isThinking?: boolean;
  taskId?: string; // 关联的任务 ID
  reasoning?: string; // 思考过程（懒加载后填充）
  toolCall?: {
    name: string;
    args?: any; // 工具参数（服务端存根不下发，懒加载后填充）
    result?: any; // 工具结果正文（服务端存根不下发，懒加载后填充；文件列表另经 payload.result.files）
    hasResult?: boolean; // 服务端存根标记：存在执行结果但未随推送下发
  };
  usage?: TokenUsage; // Token 使用量
  payload?: any; // 原始 payload，用于提取文件等额外数据
  hasReasoning?: boolean; // 服务端存根标记：存在思考内容但未随推送下发（展开时懒加载）
  hasMemoryContext?: boolean; // 服务端存根标记：存在记忆召回但未随推送下发
  hasKnowledgeContext?: boolean; // 服务端存根标记：存在知识树检索但未随推送下发
  memoryContext?: string; // AgentMemory 召回结果（懒加载后填充）
  knowledgeContext?: string; // KnowledgeTree 检索结果（懒加载后填充）
  scheduledDeliveryTime?: string; // 预计送达时间（ISO 字符串）
  deliveredAt?: string; // 实际投递时间
  sendTime?: string; // 原始发送时间（接收方视角）
  isSystem?: boolean; // 群系统消息标记（居中灰色胶囊渲染）
  groupId?: string; // 群消息标记（store 编辑/删除按此路由到群消息端点）
  groupName?: string; // 群来源消息的群名（个人视图显示"群聊 X"）
  senderAgentId?: string; // 群来源消息的原发送者（'system' = 群系统通知）
}

export interface Tab {
  id: string;
  type: 'org' | 'tool' | 'group';
  title: string;
  params?: any;
}

/**
 * 组织模板
 * 对应 org 目录下的一个文件夹
 */
export interface OrgTemplate {
  id: string;
  name: string;
  description?: string;
}

/**
 * 模板文件内容
 * 包含 info.md 和 org.md 的内容
 */
export interface TemplateContent {
  /** info.md 文件内容 */
  info: string;
  /** org.md 文件内容 */
  org: string;
}

/**
 * 待办事项
 */
export interface TodoItem {
  id: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

// ========== 群聊相关类型 ==========

/** 群元数据 */
export interface GroupMeta {
  id: string;
  name: string;
  description?: string;
  orgKey: string;
  creatorId: string;
  /** 群成员（后端 getGroupInfo 返回对象数组：id/name/status） */
  members: Array<{ id: string; name: string; status: string }>;
  createdAt: string;
  /** 是否已解散 */
  dissolved?: boolean;
}

/** 群聊摘要（轻量，用于 get_org_structure 和群列表） */
export interface GroupSummary {
  id: string;
  name: string;
  creatorId: string;
  memberCount: number;
  /** 当前调用者是否在群中 */
  isMember: boolean;
}

/** 群聊消息 */
export interface GroupMessage {
  id: string;
  groupId: string;
  kind: 'group' | 'group_system';
  from: string;          // 发送者 agentId（system 消息为空）
  taskId?: string;       // 关联任务（后端返回）
  payload: { text: string };
  createdAt: string;
}
