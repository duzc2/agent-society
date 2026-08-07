<script setup lang="ts">
/**
 * 智能体属性页
 * 展示基本信息 + 删除功能
 */
import { computed } from 'vue';
import { Copy, Trash2, ExternalLink } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { orgTreeState, type OrgTreeNode } from '../../services/heartbeatService';
import { apiService } from '../../services/api';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';

const appStore = useAppStore();
const confirm = useConfirm();
const toast = useToast();

const STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  waiting_llm: '等待大模型',
  computing: '计算中',
  processing: '处理中',
  stopping: '停止中',
  stopped: '已停止',
  terminating: '终止中',
  busy: '忙碌',
  online: '在线',
  offline: '离线'
};

function mapStatus(computeStatus?: string, agentStatus?: string): 'online' | 'offline' | 'busy' {
  if (computeStatus === 'waiting_llm' || computeStatus === 'computing' || computeStatus === 'processing') {
    return 'busy';
  }
  return agentStatus === 'active' ? 'online' : 'offline';
}

function findNode(tree: OrgTreeNode[], id: string): OrgTreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

const agentNode = computed(() => {
  const agentId = appStore.agentPropsAgentId;
  if (!agentId) return undefined;
  return findNode(orgTreeState.tree, agentId);
});

const agentName = computed(() => {
  const node = agentNode.value;
  if (!node) return '';
  return node.customName || node.id;
});

const agentStatus = computed(() => {
  const node = agentNode.value;
  if (!node) return '';
  return mapStatus(node.computeStatus, node.status);
});

/** 沿 parentAgentId 向上查找所属组织的名称 */
const agentOrgName = computed(() => {
  const node = agentNode.value;
  if (!node) return null;
  // 如果当前节点就是组织根节点（parentAgentId === 'root'），直接返回其名称
  if (node.parentAgentId === 'root') return node.orgName || node.customName || node.id;
  // 否则沿着 parentAgentId 链向上找
  let current = node;
  while (current.parentAgentId && current.parentAgentId !== 'root') {
    const parent = findNode(orgTreeState.tree, current.parentAgentId);
    if (!parent) break;
    current = parent;
  }
  return current.orgName || current.customName || current.id;
});

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    toast.add({ severity: 'success', summary: '已复制', life: 2000 });
  }).catch(() => {
    toast.add({ severity: 'error', summary: '复制失败', life: 2000 });
  });
}

function navigateToRole() {
  const node = agentNode.value;
  if (!node?.roleId || !node?.roleName) return;
  appStore.navigateToRoleProps(node.roleId, node.roleName);
}

function handleDelete() {
  const node = agentNode.value;
  if (!node) return;

  confirm.require({
    message: `确定要删除智能体 "${agentName.value}" 吗？此操作不可撤销。`,
    header: '危险操作',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '删除',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await apiService.deleteAgent(node.id);
        toast.add({ severity: 'success', summary: '已删除', detail: `智能体 "${agentName.value}" 已删除`, life: 3000 });
        appStore.goBack();
      } catch (err: any) {
        appStore.setError(err.message || '删除失败');
      }
    }
  });
}
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto">
    <!-- 智能体不存在 -->
    <template v-if="!agentNode">
      <div class="flex flex-col items-center justify-center flex-1 gap-4 p-6 text-[var(--text-2)]">
        <p class="text-lg font-medium">智能体不存在</p>
        <p class="text-sm">该智能体可能已被删除或当前不可用</p>
      </div>
    </template>

    <!-- 智能体属性 -->
    <template v-else>
      <!-- 标题区 -->
      <div class="px-4 pt-6 pb-4">
        <h2 class="text-lg font-bold text-[var(--text-1)]">{{ agentName }}</h2>
      </div>

      <!-- 属性列表 -->
      <div class="flex flex-col">
        <!-- ID -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)] shrink-0 mr-3">ID</span>
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-sm text-[var(--text-1)] truncate">{{ agentNode.id }}</span>
            <button
              class="p-1 rounded hover:bg-[var(--surface-3)] transition-colors shrink-0"
              @click="copyToClipboard(agentNode.id)"
              type="button"
              aria-label="复制 ID"
            >
              <Copy class="w-3.5 h-3.5 text-[var(--text-3)]" />
            </button>
          </div>
        </div>

        <!-- 状态 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">状态</span>
          <div class="flex items-center gap-2">
            <span
              class="w-2 h-2 rounded-full"
              :class="{
                'bg-green-500': agentStatus === 'online',
                'bg-yellow-500': agentStatus === 'busy',
                'bg-gray-400': agentStatus === 'offline'
              }"
            />
            <span class="text-sm text-[var(--text-1)]">{{ STATUS_LABELS[agentStatus] || agentStatus }}</span>
          </div>
        </div>

        <!-- 计算状态 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">计算状态</span>
          <span class="text-sm text-[var(--text-1)]">{{ STATUS_LABELS[agentNode.computeStatus] || agentNode.computeStatus }}</span>
        </div>

        <!-- 计算阶段 -->
        <div
          v-if="agentNode.computePhase"
          class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]"
        >
          <span class="text-sm text-[var(--text-2)]">计算阶段</span>
          <span class="text-sm text-[var(--text-1)]">{{ agentNode.computePhase }}</span>
        </div>

        <!-- 岗位 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">岗位</span>
          <button
            v-if="agentNode.roleId && agentNode.roleName"
            class="flex items-center gap-1 text-sm text-[var(--primary)] hover:underline"
            @click="navigateToRole"
            type="button"
          >
            <span>{{ agentNode.roleName }}</span>
            <ExternalLink class="w-3.5 h-3.5" />
          </button>
          <span v-else class="text-sm text-[var(--text-3)]">-</span>
        </div>

        <!-- 岗位 ID -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">岗位 ID</span>
          <span class="text-sm text-[var(--text-1)]">{{ agentNode.roleId || '-' }}</span>
        </div>

        <!-- 父智能体 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">父智能体</span>
          <span class="text-sm text-[var(--text-1)]">{{ agentNode.parentAgentId || '-' }}</span>
        </div>

        <!-- 组织 -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span class="text-sm text-[var(--text-2)]">组织</span>
          <span class="text-sm text-[var(--text-1)]">{{ agentOrgName || '-' }}</span>
        </div>
      </div>

      <!-- 危险操作区 -->
      <div class="px-4 pt-8 pb-6">
        <p class="text-sm font-medium text-[var(--text-2)] mb-3">危险操作</p>
        <button
          class="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 active:bg-red-500/30 transition-colors text-sm font-medium"
          @click="handleDelete"
          type="button"
        >
          <Trash2 class="w-4 h-4" />
          <span>删除智能体</span>
        </button>
      </div>
    </template>
  </div>
</template>
