<script setup lang="ts">
/**
 * 岗位属性页
 * 展示岗位基本信息 + 该岗位下的智能体列表
 */
import { computed } from 'vue';
import { Copy, ChevronRight } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { orgTreeState, type OrgTreeNode } from '../../services/heartbeatService';
import { useToast } from 'primevue/usetoast';

const appStore = useAppStore();
const toast = useToast();

const roleName = computed(() => appStore.rolePropsRoleName || '');
const roleId = computed(() => appStore.rolePropsRoleId || '');

function countAgentsByRole(tree: OrgTreeNode[], roleId: string): { count: number; agents: { id: string; name: string }[] } {
  let count = 0;
  const agents: { id: string; name: string }[] = [];
  function walk(nodes: OrgTreeNode[]) {
    for (const node of nodes) {
      if (node.status === 'deleted') continue;
      if (node.roleId === roleId) {
        count++;
        agents.push({ id: node.id, name: node.customName || node.id });
      }
      if (node.children?.length) walk(node.children);
    }
  }
  walk(tree);
  return { count, agents };
}

const roleData = computed(() => countAgentsByRole(orgTreeState.tree, roleId.value));
const displayAgents = computed(() => roleData.value.agents.slice(0, 20));
const remainingCount = computed(() => Math.max(0, roleData.value.count - 20));

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    toast.add({ severity: 'success', summary: '已复制', life: 2000 });
  }).catch(() => {
    toast.add({ severity: 'error', summary: '复制失败', life: 2000 });
  });
}

function goToAgent(agentId: string) {
  appStore.navigateToAgentProps(agentId);
}
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto">
    <!-- 标题区 -->
    <div class="px-4 pt-6 pb-4">
      <h2 class="text-lg font-bold text-[var(--text-1)]">{{ roleName }}</h2>
    </div>

    <!-- 属性列表 -->
    <div class="flex flex-col">
      <!-- 岗位 ID -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span class="text-sm text-[var(--text-2)] shrink-0 mr-3">岗位 ID</span>
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-sm text-[var(--text-1)] truncate">{{ roleId }}</span>
          <button
            class="p-1 rounded hover:bg-[var(--surface-3)] transition-colors shrink-0"
            @click="copyToClipboard(roleId)"
            type="button"
            aria-label="复制岗位 ID"
          >
            <Copy class="w-3.5 h-3.5 text-[var(--text-3)]" />
          </button>
        </div>
      </div>

      <!-- 智能体数量 -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span class="text-sm text-[var(--text-2)]">智能体数量</span>
        <span class="text-sm text-[var(--text-1)]">{{ roleData.count }}</span>
      </div>
    </div>

    <!-- 智能体列表 -->
    <div v-if="displayAgents.length > 0" class="px-4 pt-6 pb-2">
      <p class="text-sm font-medium text-[var(--text-2)] mb-2">该岗位下的智能体</p>
      <div class="flex flex-col">
        <button
          v-for="agent in displayAgents"
          :key="agent.id"
          class="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-[var(--surface-3)] active:bg-[var(--surface-4)] transition-colors"
          @click="goToAgent(agent.id)"
          type="button"
        >
          <span class="text-sm text-[var(--text-1)] truncate">{{ agent.name }}</span>
          <ChevronRight class="w-4 h-4 text-[var(--text-3)] shrink-0" />
        </button>
      </div>
      <p v-if="remainingCount > 0" class="text-xs text-[var(--text-3)] mt-2 pl-3">
        还有 {{ remainingCount }} 个智能体未显示
      </p>
    </div>
    <div v-else class="flex items-center justify-center flex-1 p-6 text-[var(--text-3)]">
      <p class="text-sm">该岗位下暂无智能体</p>
    </div>
  </div>
</template>
