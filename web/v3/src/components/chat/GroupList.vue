<script setup lang="ts">
/**
 * 群成员列表：复用组织页 AgentList（外部数据模式，获得状态点/心情色/中断按钮/归档分组等全部能力）
 * 点击成员 → 打开该成员所在组织的标签页并选中其个人对话
 */
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agent';
import { openAgentChatTab } from './chatSession';
import AgentList from '../agent/AgentList.vue';
import type { Agent } from '../../types';

const props = defineProps<{ groupId: string }>();

const chatStore = useChatStore();
const agentStore = useAgentStore();

// 群成员 → Agent[]：优先 allAgents（状态新鲜、含 computeStatus），查不到用 member 项兜底
const memberAgents = computed<Agent[]>(() => {
  const group = chatStore.groupMetaCache[props.groupId];
  const members = group?.members ?? [];
  return members
    .filter((m: { id: string }) => m.id !== 'user')
    .map((m: { id: string; name?: string; status?: string }): Agent => {
      // 已退出成员：无论智能体当前是否在线，一律归入归档组（offline）
      const exited = m.status === 'left' || m.status === 'terminated';
      if (!exited) {
        const found = agentStore.allAgents.find(a => a.id === m.id);
        if (found) {
          // 群成员归档只应包含已退出成员：活跃成员的离线状态不触发归档分组
          return { ...found, status: (found.status === 'busy' ? 'busy' : 'online') as Agent['status'] };
        }
      }
      return {
        id: m.id,
        orgId: '',
        name: m.name || m.id,
        role: exited ? '已退出' : '智能体',
        roleId: null,
        status: (exited ? 'offline' : 'online') as Agent['status'],
        computeStatus: 'idle',
      };
    });
});

// 点击成员 → 打开该成员所在组织的标签页并选中其个人对话（共享工具）
function openMemberChat(agentId: string) {
  openAgentChatTab(agentId);
}
</script>

<template>
  <AgentList
    :org-id="'group:' + props.groupId"
    :agents="memberAgents"
    archive-label="已退出成员"
    @select="openMemberChat"
  />
</template>
