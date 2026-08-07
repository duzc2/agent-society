<template>
  <div class="space-y-4 p-4 text-[var(--text-1)]">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-[var(--text-1)]">子岗位</h3>
        <p class="mt-1 text-xs text-[var(--text-3)]">
          这里只展示当前智能体创建的岗位，以及这些岗位下已有的智能体。
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button
          variant="text"
          size="small"
          class="!px-3"
          :disabled="loading"
          @click="loadCreatedRoles"
        >
          <RefreshCw class="mr-1 h-3.5 w-3.5" />
          刷新
        </Button>
        <Button size="small" :disabled="creatingRole" @click="openCreateRoleDialog">
          <Plus class="mr-1 h-3.5 w-3.5" />
          创建子岗位
        </Button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="text-xs text-[var(--text-3)]">子岗位数量</div>
        <div class="mt-2 text-lg font-semibold text-[var(--text-1)]">{{ roleCount }}</div>
      </div>
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="text-xs text-[var(--text-3)]">岗位智能体总数</div>
        <div class="mt-2 text-lg font-semibold text-[var(--text-1)]">{{ agentCount }}</div>
      </div>
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <div class="text-xs text-[var(--text-3)]">活跃智能体</div>
        <div class="mt-2 text-lg font-semibold text-[var(--text-1)]">{{ activeAgentCount }}</div>
      </div>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-[var(--primary)]" />
      <span class="ml-2 text-sm text-[var(--text-2)]">加载子岗位中...</span>
    </div>

    <div
      v-else-if="error"
      class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
    >
      {{ error }}
    </div>

    <div
      v-else-if="roleNodes.length === 0"
      class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 py-10 text-center"
    >
      <div class="text-sm text-[var(--text-2)]">当前智能体还没有创建任何子岗位。</div>
      <div class="mt-2 text-xs text-[var(--text-3)]">可以点击右上角“创建子岗位”开始添加。</div>
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="roleNode in roleNodes"
        :key="roleNode.role.id"
        class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <Network class="h-4 w-4 shrink-0 text-[var(--primary)]" />
              <span class="truncate text-sm font-semibold text-[var(--text-1)]">
                {{ roleNode.role.name }}
              </span>
            </div>
            <div class="mt-2 space-y-1 text-xs text-[var(--text-3)]">
              <div>岗位 ID：{{ roleNode.role.id }}</div>
              <div>创建时间：{{ formatTimestamp(roleNode.role.createdAt) }}</div>
              <div>智能体数量：{{ roleNode.agents.length }}</div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="outlined"
              size="small"
              class="!px-3"
              :loading="isCreatingAgent(roleNode.role.id)"
              :disabled="isCreatingAgent(roleNode.role.id)"
              @click="createAgentForRole(roleNode)"
            >
              创建智能体
            </Button>
            <Button
              variant="outlined"
              size="small"
              class="!px-3"
              @click="openRoleProperties(roleNode)"
            >
              属性
            </Button>
            <Button
              severity="danger"
              variant="outlined"
              size="small"
              class="!px-3"
              @click="confirmDeleteRole(roleNode)"
            >
              删除
            </Button>
          </div>
        </div>

      </div>
    </div>

    <Dialog
      v-model:visible="createRoleDialogVisible"
      header="创建子岗位"
      :style="{ width: '520px', maxWidth: '95vw' }"
      modal
      :closeOnEscape="false"
    >
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium text-[var(--text-1)]">岗位名称</label>
          <InputText
            v-model="createRoleForm.name"
            class="w-full"
            maxlength="100"
            placeholder="请输入岗位名称"
          />
        </div>

        <div class="space-y-2">
          <label class="block text-sm font-medium text-[var(--text-1)]">岗位职责</label>
          <Textarea
            v-model="createRoleForm.rolePrompt"
            class="w-full"
            :rows="6"
            maxlength="4000"
            placeholder="请输入岗位职责说明"
          />
        </div>

        <div v-if="createRoleError" class="text-sm text-red-500">
          {{ createRoleError }}
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button
            variant="text"
            label="取消"
            :disabled="creatingRole"
            @click="closeCreateRoleDialog"
          />
          <Button
            label="创建"
            :loading="creatingRole"
            :disabled="creatingRole"
            @click="createChildRole"
          />
        </div>
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { Loader2, Network, Plus, RefreshCw } from 'lucide-vue-next';
import { useConfirm } from 'primevue/useconfirm';
import { useDialog } from 'primevue/usedialog';
import { useToast } from 'primevue/usetoast';
import { apiService } from '../../services/api';
import { useAgentStore } from '../../stores/agent';
import { useOrgStore } from '../../stores/org';
import { createDragEndHandler } from '../../utils/dialogBounds';
import RoleDetailDialog from '../overview/RoleDetailDialog.vue';

interface AgentSubRolesPanelProps {
  agentId: string;
}

interface RawRole {
  id: string;
  name: string;
  createdBy?: string | null;
  createdAt?: string | null;
  status?: string;
}

interface RawAgent {
  id: string;
  roleId: string;
  status?: string;
  computeStatus?: string;
  customName?: string | null;
  createdAt?: string | null;
}

interface RoleNode {
  role: RawRole;
  agents: RawAgent[];
}

const props = defineProps<AgentSubRolesPanelProps>();

const confirm = useConfirm();
const dialog = useDialog();
const toast = useToast();
const agentStore = useAgentStore();
const orgStore = useOrgStore();

const loading = ref(true);
const error = ref('');
const roleNodes = ref<RoleNode[]>([]);
const createRoleDialogVisible = ref(false);
const creatingRole = ref(false);
const creatingAgentRoleIds = ref<Record<string, boolean>>({});
const createRoleError = ref('');
const createRoleForm = reactive({
  name: '',
  rolePrompt: ''
});

/**
 * 统计当前智能体创建的岗位数量。
 */
const roleCount = computed(() => roleNodes.value.length);

/**
 * 统计当前岗位树中的智能体总数。
 */
const agentCount = computed(() =>
  roleNodes.value.reduce((sum, roleNode) => sum + roleNode.agents.length, 0)
);

/**
 * 统计当前岗位树中的活跃智能体数量。
 */
const activeAgentCount = computed(() =>
  roleNodes.value.reduce(
    (sum, roleNode) =>
      sum
      + roleNode.agents.filter((agent) => normalizeAgentStatus(agent) !== 'offline').length,
    0
  )
);

/**
 * 判断指定岗位是否正在创建智能体。
 * @param roleId 岗位 ID
 * @returns 是否处于创建中
 */
const isCreatingAgent = (roleId: string) => Boolean(creatingAgentRoleIds.value[roleId]);

/**
 * 更新指定岗位的创建智能体状态。
 * @param roleId 岗位 ID
 * @param creating 是否正在创建
 */
const setCreatingAgentState = (roleId: string, creating: boolean) => {
  creatingAgentRoleIds.value = {
    ...creatingAgentRoleIds.value,
    [roleId]: creating
  };
};

/**
 * 归一化智能体状态，保证前端展示口径一致。
 * @param agent 智能体原始数据
 * @returns 标准化状态
 */
const normalizeAgentStatus = (agent: RawAgent): 'online' | 'offline' | 'busy' => {
  if (
    agent.computeStatus === 'waiting_llm'
    || agent.computeStatus === 'computing'
    || agent.computeStatus === 'processing'
  ) {
    return 'busy';
  }

  return agent.status === 'active' ? 'online' : 'offline';
};

/**
 * 格式化时间戳，缺失时返回占位文本。
 * @param timestamp 原始时间戳
 * @returns 格式化后的时间
 */
const formatTimestamp = (timestamp?: string | null) => {
  if (!timestamp) {
    return '-';
  }

  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return timestamp;
  }
};

/**
 * 统一刷新全局组织与智能体缓存，避免其他界面显示过期数据。
 */
const refreshGlobalState = async () => {
  await orgStore.fetchOrgs(true);
  await agentStore.fetchAllAgents(true);

  if (agentStore.currentOrgId) {
    await agentStore.fetchAgentsByOrg(agentStore.currentOrgId, true);
  }
};

/**
 * 重新加载当前智能体创建的岗位与岗位智能体。
 */
const loadCreatedRoles = async () => {
  if (!props.agentId) {
    error.value = '缺少智能体 ID。';
    roleNodes.value = [];
    loading.value = false;
    return;
  }

  loading.value = true;
  error.value = '';

  try {
    const [roles, agents] = await Promise.all([
      apiService.getRoles(),
      apiService.getAllAgentsRaw()
    ]);

    const visibleRoles = (roles as RawRole[])
      .filter((role) => role.createdBy === props.agentId && role.status !== 'deleted')
      .sort((left, right) => {
        const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
        const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
        return leftTime - rightTime;
      });

    const roleIdSet = new Set(visibleRoles.map((role) => role.id));
    const visibleAgents = (agents as RawAgent[])
      .filter((agent) => roleIdSet.has(agent.roleId) && agent.status !== 'terminated')
      .sort((left, right) => {
        const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
        const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
        return leftTime - rightTime;
      });

    roleNodes.value = visibleRoles.map((role) => ({
      role,
      agents: visibleAgents.filter((agent) => agent.roleId === role.id)
    }));
  } catch (loadError: any) {
    console.error('加载子岗位失败:', loadError);
    error.value = loadError?.message || '加载子岗位失败。';
    roleNodes.value = [];
  } finally {
    loading.value = false;
  }
};

/**
 * 打开岗位属性弹窗。
 * @param roleNode 岗位节点
 */
const openRoleProperties = (roleNode: RoleNode) => {
  dialog.open(RoleDetailDialog, {
    props: {
      header: `岗位属性：${roleNode.role.name}`,
      style: { width: '860px', maxWidth: '95vw' },
      modal: false,
      closable: true,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: {
      roleId: roleNode.role.id,
      roleName: roleNode.role.name
    },
    emits: {
      onUpdate: async () => {
        await loadCreatedRoles();
        await refreshGlobalState();
      }
    }
  });
};
/**
 * 打开创建子岗位弹窗，并重置表单状态。
 */
const openCreateRoleDialog = () => {
  createRoleForm.name = '';
  createRoleForm.rolePrompt = '';
  createRoleError.value = '';
  createRoleDialogVisible.value = true;
};

/**
 * 关闭创建子岗位弹窗，并清理错误提示。
 */
const closeCreateRoleDialog = () => {
  if (creatingRole.value) {
    return;
  }

  createRoleError.value = '';
  createRoleDialogVisible.value = false;
};

/**
 * 提交创建子岗位请求。
 */
const createChildRole = async () => {
  const roleName = createRoleForm.name.trim();
  const rolePrompt = createRoleForm.rolePrompt.trim();

  if (!roleName) {
    createRoleError.value = '岗位名称不能为空。';
    return;
  }

  if (!rolePrompt) {
    createRoleError.value = '岗位职责不能为空。';
    return;
  }

  creatingRole.value = true;
  createRoleError.value = '';

  try {
    const response = await apiService.createRoleForAgent(props.agentId, {
      name: roleName,
      rolePrompt
    });

    toast.add({
      severity: 'success',
      summary: response.reused ? '岗位已存在' : '创建成功',
      detail: response.reused
        ? `已复用岗位“${response.role.name}”。`
        : `已创建岗位“${response.role.name}”。`,
      life: 3000
    });

    createRoleDialogVisible.value = false;
    await loadCreatedRoles();
    await refreshGlobalState();
  } catch (createError: any) {
    console.error('创建子岗位失败:', createError);
    createRoleError.value = createError?.message || '创建子岗位失败。';
  } finally {
    creatingRole.value = false;
  }
};

/**
 * 在指定子岗位下创建智能体。
 * 只负责触发创建与刷新当前页面，不额外打开其他窗口，避免超出当前需求。
 * @param roleNode 岗位节点
 */
const createAgentForRole = async (roleNode: RoleNode) => {
  const roleId = roleNode.role.id;
  if (!roleId || isCreatingAgent(roleId)) {
    return;
  }

  setCreatingAgentState(roleId, true);
  try {
    await apiService.createAgentForRole(roleId);

    toast.add({
      severity: 'success',
      summary: '创建成功',
      detail: `已在岗位“${roleNode.role.name}”下创建新智能体。`,
      life: 3000
    });

    await loadCreatedRoles();
    await refreshGlobalState();
  } catch (createError: any) {
    console.error('创建岗位智能体失败:', createError);
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: createError?.message || '创建智能体失败。',
      life: 5000
    });
  } finally {
    setCreatingAgentState(roleId, false);
  }
};

/**
 * 确认删除岗位，并在删除成功后刷新页面状态。
 * @param roleNode 岗位节点
 */
const confirmDeleteRole = (roleNode: RoleNode) => {
  confirm.require({
    message: `确定要删除岗位“${roleNode.role.name}”吗？\n该岗位及其下级岗位会一起删除，相关智能体也会被终止。`,
    header: '删除岗位',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: {
      label: '取消',
      severity: 'secondary',
      outlined: true
    },
    acceptProps: {
      label: '确认删除',
      severity: 'danger'
    },
    accept: async () => {
      try {
        await apiService.deleteRole(roleNode.role.id, {
          reason: `用户在智能体 ${props.agentId} 的子岗位页面删除岗位`,
          deletedBy: 'user'
        });

        toast.add({
          severity: 'success',
          summary: '删除成功',
          detail: `岗位“${roleNode.role.name}”已删除。`,
          life: 3000
        });

        await loadCreatedRoles();
        await refreshGlobalState();
      } catch (deleteError: any) {
        console.error('删除岗位失败:', deleteError);
        toast.add({
          severity: 'error',
          summary: '删除失败',
          detail: deleteError?.message || '删除岗位失败。',
          life: 5000
        });
      }
    }
  });
};

onMounted(() => {
  void loadCreatedRoles();
});
</script>

<style scoped>
.agent-status-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.4;
}

.agent-status-badge.online {
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
}

.agent-status-badge.busy {
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
}

.agent-status-badge.offline {
  background: var(--surface-3);
  color: var(--text-3);
}

:deep(.p-inputtext),
:deep(.p-textarea) {
  font-family: inherit;
}
</style>
