/**
 * 岗位详情中的智能体原始数据。
 * 这里直接对应 /api/agents 返回的字段，避免在组件里散落结构判断。
 */
export interface RawRoleDetailAgent {
  id: string;
  roleId: string;
  roleName?: string;
  parentAgentId?: string | null;
  status?: string;
  computeStatus?: string;
  customName?: string | null;
}

/**
 * 岗位详情标签页展示用的智能体数据。
 * 这里补齐了工作区信息，供“聊天”按钮直接使用。
 */
export interface RoleDetailAgentListItem {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  status: 'online' | 'offline' | 'busy';
  workspaceId: string;
  workspaceName: string;
}

/**
 * 解析智能体所属工作区。
 * 工作区定义为 parentAgentId 为 root 的顶层智能体。
 * @param agent 原始智能体
 * @param agentMap 原始智能体索引
 * @returns 工作区 ID 和名称
 */
const resolveWorkspaceInfo = (
  agent: RawRoleDetailAgent,
  agentMap: Map<string, RawRoleDetailAgent>
): { workspaceId: string; workspaceName: string } => {
  let currentAgent = agent;

  while (currentAgent.parentAgentId && currentAgent.parentAgentId !== 'root') {
    const parentAgent = agentMap.get(currentAgent.parentAgentId);
    if (!parentAgent) {
      break;
    }
    currentAgent = parentAgent;
  }

  return {
    workspaceId: currentAgent.id,
    workspaceName: currentAgent.customName || currentAgent.id
  };
};

/**
 * 构建岗位详情中的智能体列表。
 * 只筛选属于当前岗位的智能体，并提前补齐工作区信息，减少组件逻辑分散。
 * @param agents 原始智能体列表
 * @param roleId 当前岗位 ID
 * @param mapStatus 状态映射函数
 * @returns 可直接渲染的智能体列表
 */
export const buildRoleDetailAgentList = (
  agents: RawRoleDetailAgent[],
  roleId: string,
  mapStatus: (
    computeStatus?: string,
    agentStatus?: string
  ) => 'online' | 'offline' | 'busy'
): RoleDetailAgentListItem[] => {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));

  return agents
    .filter((agent) => agent.roleId === roleId && agent.id !== 'root' && agent.id !== 'user')
    .map((agent) => {
      const workspaceInfo = resolveWorkspaceInfo(agent, agentMap);
      return {
        id: agent.id,
        name: agent.customName || agent.id,
        roleId: agent.roleId,
        roleName: agent.roleName || roleId,
        status: mapStatus(agent.computeStatus, agent.status),
        workspaceId: workspaceInfo.workspaceId,
        workspaceName: workspaceInfo.workspaceName
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
};
