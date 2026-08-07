import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Agent } from '../types';
import { orgTreeState, type OrgTreeNode } from '../services/heartbeatService';
import { apiService } from '../services/api';
import { useChatStore } from './chat';

// 已触发心情加载的组织 ID 集合（避免重复请求）
const moodLoadedOrgs = new Set<string>();

function mapStatus(computeStatus?: string, agentStatus?: string): 'online' | 'offline' | 'busy' {
  if (computeStatus === 'waiting_llm' || computeStatus === 'computing' || computeStatus === 'processing') {
    return 'busy';
  }
  return agentStatus === 'active' ? 'online' : 'offline';
}

function nodeToAgent(node: OrgTreeNode, orgId: string): Agent {
  return {
    id: node.id,
    orgId,
    parentAgentId: node.parentAgentId,
    name: node.customName || node.id,
    role: node.roleName || (node.id === orgId ? '组织主管' : '智能体'),
    roleId: node.roleId,
    status: mapStatus(node.computeStatus, node.status),
    computeStatus: node.computeStatus || 'idle',
    computePhase: node.computePhase
  };
}

/** 递归收集树中的所有子节点 ID */
function collectDescendantIds(node: OrgTreeNode): Set<string> {
  const ids = new Set<string>();
  for (const child of node.children) {
    if (child.status === 'deleted') continue;
    ids.add(child.id);
    for (const id of collectDescendantIds(child)) {
      ids.add(id);
    }
  }
  return ids;
}

/** 在树中查找节点 */
function findNode(tree: OrgTreeNode[], id: string): OrgTreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * 智能体状态管理（移动端精简版）
 * 数据来源：orgTreeState（心跳推送的 org_tree 消息）
 */
export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([]);
  const allAgents = ref<Agent[]>([]);
  const loading = ref(false);
  const currentOrgId = ref<string | null>(null);

  /**
   * 智能体最后活跃时间追踪（由 agent_message 心跳更新）。
   * 用于排序：即使用户未打开过某个智能体，心跳推送的消息时间戳
   * 也能影响其列表排序。
   */
  const lastActiveMap = ref<Record<string, number>>({});

  const updateLastActive = (agentId: string, timestamp: number) => {
    if (timestamp > (lastActiveMap.value[agentId] || 0)) {
      lastActiveMap.value[agentId] = timestamp;
    }
  };

  const moodColorsMap = ref<Record<string, string[]>>({});

  const updateMoodColors = (agentId: string, colors: string[]) => {
    moodColorsMap.value = { ...moodColorsMap.value, [agentId]: colors };
  };

  const loadOrgMoods = async (orgAgentId: string) => {
    if (moodLoadedOrgs.has(orgAgentId)) return;
    moodLoadedOrgs.add(orgAgentId);
    try {
      await fetch(`/api/org/${orgAgentId}/moods`, { method: 'POST' });
    } catch {
      moodLoadedOrgs.delete(orgAgentId); // 失败则允许重试
    }
  };

  /** 从 orgTree 构建全局所有智能体的扁平列表 */
  const fetchAllAgents = () => {
    try {
      const tree = orgTreeState.tree;
      const result: Agent[] = [];

      // root 和 user 作为特殊节点
      const rootNode = findNode(tree, 'root');
      const userNode = findNode(tree, 'user');
      if (rootNode) result.push(nodeToAgent(rootNode, 'home'));
      if (userNode) result.push({ ...nodeToAgent(userNode, 'home'), name: '我 (User)', role: '用户' });

      // 递归收集所有后代，传递组织ID以正确标记每个智能体所属的组织
      function collectAll(node: OrgTreeNode, orgId: string | null = null) {
        for (const child of node.children) {
          if (child.status === 'deleted') continue;
          const childOrgId = child.parentAgentId === 'root' ? child.id : orgId ?? 'home';
          result.push(nodeToAgent(child, childOrgId));
          collectAll(child, childOrgId);
        }
      }
      if (rootNode) collectAll(rootNode);
      if (userNode) collectAll(userNode);

      allAgents.value = result;

      // 触发所有组织的智能体心情加载
      const orgIds = new Set(result.map(a => a.orgId).filter(id => id && id !== 'home'));
      for (const orgId of orgIds) {
        void loadOrgMoods(orgId);
      }

      return result;
    } catch (error) {
      console.error('[agentStore.fetchAllAgents] 加载全局智能体列表失败:', error);
      return [];
    }
  };

  const fetchAgentsByOrg = (orgId: string, silent = false) => {
    currentOrgId.value = orgId;
    if (!silent) loading.value = true;
    try {
      const tree = orgTreeState.tree;
      let result: Agent[] = [];

      // 找到该组织的根节点 + 所有后代
      const orgRoot = findNode(tree, orgId);
      if (orgRoot && orgRoot.status !== 'deleted') {
        result.push(nodeToAgent(orgRoot, orgId));
        const descIds = collectDescendantIds(orgRoot);
        function collectDesc(node: OrgTreeNode) {
          for (const child of node.children) {
            if (child.status === 'deleted') continue;
            if (descIds.has(child.id)) {
              result.push(nodeToAgent(child, orgId));
              collectDesc(child);
            }
          }
        }
        collectDesc(orgRoot);
      }

      // user 始终在第一位
      const userNode = findNode(tree, 'user');
      if (userNode) {
        result.unshift({
          id: 'user',
          orgId,
          parentAgentId: null,
          name: '我 (User)',
          role: '用户',
          roleId: null,
          status: 'online',
          computeStatus: 'idle'
        });
      }

      // user 始终在第一位，其余按最后活跃时间降序
      // 优先使用心跳推送的 lastActiveMap（覆盖未打开过的智能体），
      // 其次使用本地 chatMessages 中的最新消息时间戳。
      const chatStore = useChatStore();
      result.sort((a, b) => {
        if (a.id === 'user') return -1;
        if (b.id === 'user') return 1;
        const aTime = lastActiveMap.value[a.id]
          || chatStore.chatMessages[a.id]?.slice(-1)[0]?.timestamp
          || 0;
        const bTime = lastActiveMap.value[b.id]
          || chatStore.chatMessages[b.id]?.slice(-1)[0]?.timestamp
          || 0;
        return bTime - aTime;
      });

      agents.value = result;
    } catch (error) {
      console.error('加载智能体列表失败:', error);
      agents.value = [];
    } finally {
      if (!silent) loading.value = false;
    }
  };

  const abortAgent = async (agentId: string) => {
    try {
      await apiService.abortAgentLlmCall(agentId);
      if (currentOrgId.value) {
        await fetchAgentsByOrg(currentOrgId.value);
      }
    } catch (error) {
      console.error('中断智能体调用失败:', error);
    }
  };

  return {
    agents,
    allAgents,
    loading,
    currentOrgId,
    lastActiveMap,
    updateLastActive,
    moodColorsMap,
    updateMoodColors,
    loadOrgMoods,
    fetchAllAgents,
    fetchAgentsByOrg,
    abortAgent
  };
});
