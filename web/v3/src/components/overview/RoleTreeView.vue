<template>
  <div class="relative flex h-[70vh] flex-col overflow-hidden rounded-b-xl bg-transparent text-[var(--text-1)]">
    <div class="z-20 grid grid-cols-3 gap-4 border-b border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div class="flex flex-col items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <Network class="mb-1 h-5 w-5 text-[var(--primary)]" />
        <span class="text-xs text-[var(--text-3)]">总岗位数</span>
        <span class="text-xl font-bold text-[var(--text-1)]">{{ totalRoles }}</span>
      </div>
      <div class="flex flex-col items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <Users class="mb-1 h-5 w-5 text-blue-500" />
        <span class="text-xs text-[var(--text-3)]">总智能体</span>
        <span class="text-xl font-bold text-[var(--text-1)]">{{ totalAgents }}</span>
      </div>
      <div class="flex flex-col items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <Activity class="mb-1 h-5 w-5 text-green-500" />
        <span class="text-xs text-[var(--text-3)]">活跃智能体</span>
        <span class="text-xl font-bold text-[var(--text-1)]">{{ totalActiveAgents }}</span>
      </div>
    </div>

    <div
      ref="containerRef"
      :class="[
        'relative flex-grow cursor-grab select-none overflow-hidden bg-[var(--bg)] active:cursor-grabbing',
        { 'fixed inset-0 z-[9999]': isFullscreen }
      ]"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseUp"
    >
      <div v-if="loading" class="absolute inset-0 z-30 flex items-center justify-center bg-[var(--bg)]/50">
        <Loader2 class="h-10 w-10 animate-spin text-[var(--primary)]" />
      </div>

      <div v-else-if="!roleTree" class="flex h-full flex-col items-center justify-center text-[var(--text-3)] opacity-60">
        <Network class="mb-4 h-12 w-12" />
        <p>暂无岗位结构数据</p>
        <Button variant="text" size="small" class="mt-4" @click="fetchData">
          <RefreshCw class="mr-2 h-4 w-4" />
          重新加载
        </Button>
      </div>

      <div
        v-else
        class="absolute origin-[0_0]"
        :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }"
      >
        <div class="p-20">
          <OrganizationChart :value="chartValue">
            <template #default="slotProps">
              <div class="role-node-card" :class="{ 'virtual-root': slotProps.node.data?.isVirtual }">
                <div class="role-node-header">
                  <Network class="h-4 w-4 text-[var(--primary)]" />
                  <span class="role-name">{{ slotProps.node.label }}</span>
                  <div v-if="!slotProps.node.data?.isVirtual" class="role-header-actions">
                    <button
                      class="icon-btn"
                      title="查看或编辑岗位"
                      @mousedown.stop
                      @click.stop="handleEditRole(slotProps.node)"
                    >
                      <Edit class="h-3.5 w-3.5" />
                    </button>
                    <button
                      class="icon-btn delete"
                      title="删除岗位"
                      @mousedown.stop
                      @click.stop="handleDeleteRole(slotProps.node)"
                    >
                      <Trash2 class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div class="role-node-body">
                  <div v-if="!slotProps.node.data?.isVirtual" class="role-id">
                    {{ getShortRoleId(slotProps.node.key) }}
                  </div>

                  <div class="role-stats">
                    <div class="stat-item" title="岗位智能体总数">
                      <Users class="h-3 w-3 text-blue-500" />
                      <span>{{ slotProps.node.data?.agentCount || 0 }}</span>
                    </div>
                    <div
                      class="stat-item"
                      :class="{ active: (slotProps.node.data?.activeAgentCount || 0) > 0 }"
                      title="岗位活跃智能体数"
                    >
                      <Activity
                        class="h-3 w-3"
                        :class="(slotProps.node.data?.activeAgentCount || 0) > 0 ? 'text-green-500' : 'text-[var(--text-3)]'"
                      />
                      <span>{{ slotProps.node.data?.activeAgentCount || 0 }}</span>
                    </div>
                  </div>

                  <div
                    v-if="!slotProps.node.data?.isVirtual"
                    class="role-agent-section"
                    :class="{ 'with-create-button': canCreateAgentForRole(slotProps.node) }"
                  >
                    <div class="role-agent-grid">
                      <div
                        v-for="agent in getVisibleAgents(slotProps.node.data)"
                        :key="agent.id"
                        class="agent-mini-card"
                        :class="getAgentMiniCardClass(agent.status)"
                        :title="getAgentMiniCardTitle(agent)"
                      >
                        <span class="agent-mini-label">{{ getAgentMiniLabel(agent.name) }}</span>
                      </div>

                      <div
                        v-if="getHiddenAgentCount(slotProps.node.data) > 0"
                        class="agent-mini-card agent-mini-overflow"
                        :title="`还有 ${getHiddenAgentCount(slotProps.node.data)} 个智能体未显示`"
                      >
                        +{{ getHiddenAgentCount(slotProps.node.data) }}
                      </div>
                    </div>

                    <button
                      v-if="canCreateAgentForRole(slotProps.node)"
                      class="create-role-agent-btn"
                      :disabled="isCreatingRole(slotProps.node.key)"
                      title="创建该岗位的智能体"
                      @mousedown.stop
                      @click.stop="handleCreateAgent(slotProps.node)"
                    >
                      <Loader2 v-if="isCreatingRole(slotProps.node.key)" class="h-3.5 w-3.5 animate-spin" />
                      <Plus v-else class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </OrganizationChart>
        </div>
      </div>

      <div class="absolute bottom-4 right-4 z-20 flex flex-col gap-2">
        <div class="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[10px] text-[var(--text-3)] shadow-lg">
          滚轮缩放 ｜ 拖拽平移
        </div>
        <div class="flex justify-end gap-2">
          <Button
            variant="text"
            size="small"
            class="!flex !h-8 !w-8 !items-center !justify-center !bg-[var(--surface-1)] !p-0 shadow-md"
            @click="zoomAtCenter(-0.1)"
          >
            <ZoomOut class="h-4 w-4 text-[var(--text-1)]" />
          </Button>
          <Button
            variant="text"
            size="small"
            class="!flex !h-8 !w-8 !items-center !justify-center !bg-[var(--surface-1)] !p-0 shadow-md"
            @click="resetView"
          >
            <RefreshCw class="h-4 w-4 text-[var(--text-1)]" />
          </Button>
          <Button
            variant="text"
            size="small"
            class="!flex !h-8 !w-8 !items-center !justify-center !bg-[var(--surface-1)] !p-0 shadow-md"
            @click="zoomAtCenter(0.1)"
          >
            <ZoomIn class="h-4 w-4 text-[var(--text-1)]" />
          </Button>
          <Button
            variant="text"
            size="small"
            class="!flex !h-8 !w-8 !items-center !justify-center !bg-[var(--surface-1)] !p-0 shadow-md"
            @click="toggleFullscreen"
          >
            <Maximize2 v-if="!isFullscreen" class="h-4 w-4 text-[var(--text-1)]" />
            <Minimize2 v-else class="h-4 w-4 text-[var(--text-1)]" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  Activity,
  Edit,
  Loader2,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  ZoomIn,
  ZoomOut
} from 'lucide-vue-next';
import Button from 'primevue/button';
import OrganizationChart from 'primevue/organizationchart';
import { useConfirm } from 'primevue/useconfirm';
import { useDialog } from 'primevue/usedialog';
import { useToast } from 'primevue/usetoast';
import { apiService } from '../../services/api';
import { useAgentStore } from '../../stores/agent';
import { useAppStore } from '../../stores/app';
import { useChatStore } from '../../stores/chat';
import { useOrgStore } from '../../stores/org';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { openAgentPropertiesWindow } from '../agent/agentPropertiesWindow';
import RoleDetailDialog from './RoleDetailDialog.vue';

interface RawRoleNode {
  id: string;
  name: string;
  createdBy?: string | null;
  status?: string;
}

interface RawAgentNode {
  id: string;
  roleId: string;
  status?: string;
  computeStatus?: string;
  customName?: string | null;
}

interface RoleAgentBadge {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'busy';
}

interface RoleTreeNodeData {
  id: string;
  createdBy?: string | null;
  agentCount: number;
  activeAgentCount: number;
  agents: RoleAgentBadge[];
  isVirtual?: boolean;
}

interface RoleTreeNode {
  key: string;
  label: string;
  data: RoleTreeNodeData;
  children: RoleTreeNode[];
  expanded: boolean;
}

interface CreatedRoleAgentResponse {
  ok: boolean;
  agent: {
    id: string;
    name: string;
    roleId: string;
    roleName: string;
    status: 'online' | 'offline' | 'busy';
  };
  workspace: {
    id: string;
    name: string;
  };
}

const MAX_VISIBLE_AGENT_BADGES = 11;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2;

const confirm = useConfirm();
const toast = useToast();
const dialog = useDialog();
const appStore = useAppStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();
const orgStore = useOrgStore();

const loading = ref(true);
const containerRef = ref<HTMLElement | null>(null);
const roleTree = ref<RoleTreeNode | null>(null);
const totalRoles = ref(0);
const totalAgents = ref(0);
const totalActiveAgents = ref(0);
const creatingRoleIds = ref<Record<string, boolean>>({});

const scale = ref(1);
const offset = reactive({ x: 0, y: 0 });
const isDragging = ref(false);
const dragStart = reactive({ x: 0, y: 0 });
const isFullscreen = ref(false);

/**
 * 提供 OrganizationChart 可消费的树结构。
 */
const chartValue = computed(() => roleTree.value ?? undefined);

/**
 * 归一化智能体状态，统一前端展示颜色和计数口径。
 * @param agent 智能体原始数据
 * @returns 标准化后的展示状态
 */
const mapAgentStatus = (agent: RawAgentNode): 'online' | 'offline' | 'busy' => {
  if (agent.computeStatus === 'waiting_llm' || agent.computeStatus === 'computing' || agent.computeStatus === 'processing') {
    return 'busy';
  }
  return agent.status === 'active' ? 'online' : 'offline';
};

/**
 * 判断指定岗位是否正在创建智能体。
 * @param roleId 岗位 ID
 * @returns 是否正在创建
 */
const isCreatingRole = (roleId: string) => Boolean(creatingRoleIds.value[roleId]);

/**
 * 更新岗位创建中的状态，避免重复点击。
 * @param roleId 岗位 ID
 * @param creating 是否正在创建
 */
const setCreatingRoleState = (roleId: string, creating: boolean) => {
  creatingRoleIds.value = {
    ...creatingRoleIds.value,
    [roleId]: creating
  };
};

/**
 * 切换全屏状态，并在切换后重新居中图表。
 */
const toggleFullscreen = async () => {
  try {
    if (!document.fullscreenElement) {
      await containerRef.value?.requestFullscreen();
      isFullscreen.value = true;
    } else {
      await document.exitFullscreen();
      isFullscreen.value = false;
    }

    window.setTimeout(() => {
      void centerChart();
    }, 100);
  } catch (error) {
    console.error('切换全屏失败:', error);
  }
};

/**
 * 处理浏览器全屏状态变化。
 */
const handleFullscreenChange = () => {
  isFullscreen.value = Boolean(document.fullscreenElement);
  window.setTimeout(() => {
    void centerChart();
  }, 100);
};

/**
 * 处理滚轮缩放，并以鼠标位置为缩放中心。
 * @param event 鼠标滚轮事件
 */
const onWheel = (event: WheelEvent) => {
  event.preventDefault();
  if (!containerRef.value) {
    return;
  }

  const rect = containerRef.value.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const contentX = (mouseX - offset.x) / scale.value;
  const contentY = (mouseY - offset.y) / scale.value;
  const delta = event.deltaY > 0 ? -0.1 : 0.1;
  const nextScale = Math.min(Math.max(MIN_SCALE, scale.value + delta), MAX_SCALE);

  offset.x = mouseX - contentX * nextScale;
  offset.y = mouseY - contentY * nextScale;
  scale.value = nextScale;
};

/**
 * 开始拖拽画布。
 * @param event 鼠标事件
 */
const onMouseDown = (event: MouseEvent) => {
  isDragging.value = true;
  dragStart.x = event.clientX - offset.x;
  dragStart.y = event.clientY - offset.y;
};

/**
 * 处理拖拽中的平移。
 * @param event 鼠标事件
 */
const onMouseMove = (event: MouseEvent) => {
  if (!isDragging.value) {
    return;
  }

  offset.x = event.clientX - dragStart.x;
  offset.y = event.clientY - dragStart.y;
};

/**
 * 结束拖拽。
 */
const onMouseUp = () => {
  isDragging.value = false;
};

/**
 * 以画布中心为基准进行缩放。
 * @param delta 缩放增量
 */
const zoomAtCenter = (delta: number) => {
  if (!containerRef.value) {
    return;
  }

  const rect = containerRef.value.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const contentX = (centerX - offset.x) / scale.value;
  const contentY = (centerY - offset.y) / scale.value;
  const nextScale = Math.min(Math.max(MIN_SCALE, scale.value + delta), MAX_SCALE);

  offset.x = centerX - contentX * nextScale;
  offset.y = centerY - contentY * nextScale;
  scale.value = nextScale;
};

/**
 * 重置视图缩放，并重新居中。
 */
const resetView = () => {
  scale.value = 1;
  void centerChart();
};

/**
 * 根据当前图表尺寸把组织图居中显示。
 */
const centerChart = async () => {
  await nextTick();
  await new Promise((resolve) => window.setTimeout(resolve, 100));

  if (!containerRef.value) {
    return;
  }

  const chartElement = containerRef.value.querySelector('.p-organizationchart') as HTMLElement | null;
  if (!chartElement) {
    offset.x = 0;
    offset.y = 0;
    return;
  }

  offset.x = (containerRef.value.clientWidth - chartElement.offsetWidth) / 2 - 80;
  offset.y = 20;
};

/**
 * 为岗位 ID 生成短展示文本。
 * @param roleId 岗位 ID
 * @returns 截短后的岗位 ID
 */
const getShortRoleId = (roleId: string) => roleId.split('-')[0] || roleId;

/**
 * 获取岗位节点中要展示的智能体方块。
 * @param nodeData 岗位节点数据
 * @returns 可见智能体列表
 */
const getVisibleAgents = (nodeData: RoleTreeNodeData) => (nodeData.agents || []).slice(0, MAX_VISIBLE_AGENT_BADGES);

/**
 * 获取岗位节点中未展示的智能体数量。
 * @param nodeData 岗位节点数据
 * @returns 未展示数量
 */
const getHiddenAgentCount = (nodeData: RoleTreeNodeData) => Math.max((nodeData.agents || []).length - MAX_VISIBLE_AGENT_BADGES, 0);

/**
 * 生成智能体方块的悬浮提示。
 * @param agent 智能体展示数据
 * @returns 悬浮提示文本
 */
const getAgentMiniCardTitle = (agent: RoleAgentBadge) => {
  const statusLabel = agent.status === 'busy' ? '忙碌' : agent.status === 'online' ? '在线' : '离线';
  return `${agent.name}｜${statusLabel}`;
};

/**
 * 根据状态返回智能体方块样式类名。
 * @param status 智能体状态
 * @returns 样式类名
 */
const getAgentMiniCardClass = (status: RoleAgentBadge['status']) => {
  if (status === 'busy') {
    return 'busy';
  }
  if (status === 'online') {
    return 'online';
  }
  return 'offline';
};

/**
 * 生成智能体方块中的单字符缩写。
 * @param name 智能体名称
 * @returns 单字符展示文本
 */
const getAgentMiniLabel = (name: string) => {
  const trimmedName = (name || '').trim();
  return trimmedName ? trimmedName.slice(0, 1).toUpperCase() : '?';
};

/**
 * 从岗位树节点中提取岗位 ID。
 * @param node 岗位树节点
 * @returns 岗位 ID
 */
const getRoleIdFromNode = (node: RoleTreeNode) => node?.key || node?.data?.id || '';

/**
 * 判断岗位是否允许在总览视图中直接创建智能体。
 * 约束：
 * 1. 虚拟根节点不允许创建；
 * 2. root 的直接下级岗位不允许创建；
 * 3. 其他岗位沿用现有前端创建入口。
 * @param node 岗位树节点
 * @returns 是否允许创建
 */
const canCreateAgentForRole = (node: RoleTreeNode) => {
  if (!node || node.data?.isVirtual) {
    return false;
  }

  return node.data?.createdBy !== 'root';
};

/**
 * 把岗位列表和智能体列表组装成总览岗位树。
 * 组树规则沿用现有组织模型：岗位的 createdBy 对应创建该岗位的智能体，
 * 再根据该智能体所属岗位推导父岗位。
 * @param roles 岗位原始列表
 * @param agents 智能体原始列表
 * @returns 根岗位节点
 */
const buildTree = (roles: RawRoleNode[], agents: RawAgentNode[]): RoleTreeNode | null => {
  const filteredRoles = roles.filter((role) => role.id !== 'root' && role.id !== 'user' && role.status !== 'deleted');
  const filteredAgents = agents.filter((agent) => agent.id !== 'root' && agent.id !== 'user' && agent.status !== 'terminated');
  const roleMap = new Map<string, RoleTreeNode>();
  const agentBadgesByRole = new Map<string, RoleAgentBadge[]>();
  const agentStatsByRole = new Map<string, { total: number; active: number }>();

  for (const agent of filteredAgents) {
    const mappedStatus = mapAgentStatus(agent);
    const currentBadges = agentBadgesByRole.get(agent.roleId) || [];
    currentBadges.push({
      id: agent.id,
      name: agent.customName || agent.id,
      status: mappedStatus
    });
    agentBadgesByRole.set(agent.roleId, currentBadges);

    const currentStats = agentStatsByRole.get(agent.roleId) || { total: 0, active: 0 };
    currentStats.total += 1;
    if (mappedStatus !== 'offline') {
      currentStats.active += 1;
    }
    agentStatsByRole.set(agent.roleId, currentStats);
  }

  for (const role of filteredRoles) {
    const stats = agentStatsByRole.get(role.id) || { total: 0, active: 0 };
    roleMap.set(role.id, {
      key: role.id,
      label: role.name,
      data: {
        id: role.id,
        createdBy: role.createdBy || null,
        agentCount: stats.total,
        activeAgentCount: stats.active,
        agents: agentBadgesByRole.get(role.id) || []
      },
      children: [],
      expanded: true
    });
  }

  const rootNodes: RoleTreeNode[] = [];
  for (const node of roleMap.values()) {
    const creatorId = node.data.createdBy;
    if (!creatorId || creatorId === 'root') {
      rootNodes.push(node);
      continue;
    }

    const creatorAgent = filteredAgents.find((agent) => agent.id === creatorId);
    const parentRoleId = creatorAgent?.roleId;
    if (parentRoleId && roleMap.has(parentRoleId)) {
      roleMap.get(parentRoleId)?.children.push(node);
      continue;
    }

    rootNodes.push(node);
  }

  if (rootNodes.length === 0) {
    return null;
  }

  if (rootNodes.length === 1) {
    return rootNodes[0] ?? null;
  }

  return {
    key: 'society-root',
    label: '岗位总览',
    data: {
      id: 'society-root',
      agentCount: totalAgents.value,
      activeAgentCount: totalActiveAgents.value,
      agents: [],
      isVirtual: true
    },
    children: rootNodes,
    expanded: true
  };
};

/**
 * 重新拉取岗位与智能体数据并刷新总览树。
 */
const fetchData = async () => {
  loading.value = true;
  try {
    const [roles, agents] = await Promise.all([apiService.getRoles(), apiService.getAllAgentsRaw()]);
    const filteredRoles = roles.filter((role: RawRoleNode) => role.id !== 'root' && role.id !== 'user' && role.status !== 'deleted');
    const filteredAgents = agents.filter((agent: RawAgentNode) => agent.id !== 'root' && agent.id !== 'user' && agent.status !== 'terminated');

    totalRoles.value = filteredRoles.length;
    totalAgents.value = filteredAgents.length;
    totalActiveAgents.value = filteredAgents.filter((agent: RawAgentNode) => mapAgentStatus(agent) !== 'offline').length;
    roleTree.value = buildTree(roles, agents);
    await centerChart();
  } catch (error) {
    console.error('加载岗位总览失败:', error);
    roleTree.value = null;
  } finally {
    loading.value = false;
  }
};

/**
 * 打开岗位详情弹窗。
 * @param node 岗位树节点
 */
const handleEditRole = (node: RoleTreeNode) => {
  const roleId = getRoleIdFromNode(node);
  if (!roleId || roleId === 'society-root') {
    toast.add({
      severity: 'warn',
      summary: '无法编辑',
      detail: '当前节点不是可编辑岗位。',
      life: 3000
    });
    return;
  }

  dialog.open(RoleDetailDialog, {
    props: {
      header: `岗位详情：${node.label}`,
      style: { width: '860px', maxWidth: '95vw' },
      modal: false,
      closable: true,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: {
      roleId,
      roleName: node.label
    },
    emits: {
      onUpdate: async () => {
        await fetchData();
      }
    }
  });
};

/**
 * 删除岗位，并刷新总览数据。
 * @param node 岗位树节点
 */
const handleDeleteRole = (node: RoleTreeNode) => {
  const roleId = getRoleIdFromNode(node);
  if (!roleId || roleId === 'society-root') {
    return;
  }

  confirm.require({
    message: `确定要删除岗位“${node.label}”吗？\n该岗位及其下级岗位会一起删除，相关智能体也会被终止。`,
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
        await apiService.deleteRole(roleId, {
          reason: '用户在总览视图删除岗位',
          deletedBy: 'user'
        });
        toast.add({
          severity: 'success',
          summary: '删除成功',
          detail: `岗位“${node.label}”已删除。`,
          life: 3000
        });
        await fetchData();
        await orgStore.fetchOrgs(true);
        await agentStore.fetchAllAgents(true);
      } catch (error: any) {
        console.error('删除岗位失败:', error);
        toast.add({
          severity: 'error',
          summary: '删除失败',
          detail: error?.message || '删除岗位失败。',
          life: 5000
        });
      }
    }
  });
};

/**
 * 创建成功后切换到对应工作区，并同时打开聊天和属性窗口。
 * @param response 创建结果
 */
const openCreatedAgentWorkspace = async (response: CreatedRoleAgentResponse) => {
  const workspaceId = response.workspace?.id || response.agent.id;
  const workspaceTitle = response.workspace?.name || response.agent.name || response.agent.id;

  await orgStore.fetchOrgs(true);
  await agentStore.fetchAllAgents(true);
  appStore.openTab({
    id: workspaceId,
    type: 'org',
    title: workspaceTitle
  });
  await agentStore.fetchAgentsByOrg(workspaceId, true);
  await chatStore.setActiveAgent(workspaceId, response.agent.id);

  openAgentPropertiesWindow(dialog, {
    agentId: response.agent.id,
    agentName: response.agent.name,
    roleName: response.agent.roleName,
    roleId: response.agent.roleId,
    agentStatus: response.agent.status
  });
};

/**
 * 在指定岗位下创建新的智能体。
 * @param node 岗位树节点
 */
const handleCreateAgent = async (node: RoleTreeNode) => {
  const roleId = getRoleIdFromNode(node);
  if (!roleId || roleId === 'society-root' || isCreatingRole(roleId) || !canCreateAgentForRole(node)) {
    return;
  }

  setCreatingRoleState(roleId, true);
  try {
    const response = await apiService.createAgentForRole(roleId) as CreatedRoleAgentResponse;
    await fetchData();
    // 在打开弹窗前重置创建状态，避免 finally 块中的
    // 响应式更新与 PrimeVue Dialog 的 DOM 操作产生时序冲突
    setCreatingRoleState(roleId, false);
    await openCreatedAgentWorkspace(response);

    toast.add({
      severity: 'success',
      summary: '创建成功',
      detail: `已在岗位"${node.label}"下创建新智能体，并打开对应界面。`,
      life: 3000
    });
  } catch (error: any) {
    setCreatingRoleState(roleId, false);
    console.error('创建岗位智能体失败:', error);
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: error?.message || '创建智能体失败。',
      life: 5000
    });
  }
};

onMounted(() => {
  void fetchData();
  document.addEventListener('fullscreenchange', handleFullscreenChange);
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
});
</script>

<style scoped>
.role-node-card {
  min-width: 200px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
  box-shadow: 0 4px 20px -5px rgba(0, 0, 0, 0.1);
  transition: all 0.25s ease;
}

.role-node-card:hover {
  transform: translateY(-2px);
  border-color: var(--primary);
  box-shadow: 0 8px 25px -5px rgba(0, 0, 0, 0.15);
}

.role-node-card.virtual-root {
  background: linear-gradient(135deg, var(--surface-1) 0%, var(--surface-2) 100%);
  border-color: var(--primary);
}

.role-node-card.virtual-root .role-node-header {
  background: rgba(var(--primary-rgb), 0.1);
}

.role-node-card.virtual-root .role-name {
  color: var(--primary);
}

.role-node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  padding: 8px 12px;
}

.role-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}

.role-header-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  padding: 4px;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  color: var(--primary);
  background: var(--primary-weak);
}

.icon-btn.delete:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.role-node-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 12px;
}

.role-id {
  align-self: flex-start;
  border-radius: 4px;
  background: var(--surface-2);
  padding: 2px 6px;
  font-family: monospace;
  font-size: 10px;
  color: var(--text-3);
}

.role-stats {
  display: flex;
  gap: 8px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}

.stat-item.active {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.05);
}

.role-agent-section {
  position: relative;
  min-height: 72px;
}

.role-agent-section.with-create-button {
  padding-right: 34px;
  padding-bottom: 34px;
}

.role-agent-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.agent-mini-card {
  display: flex;
  aspect-ratio: 1 / 1;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-2);
}

.agent-mini-card.online {
  border-color: rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.08);
  color: #2563eb;
}

.agent-mini-card.busy {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.1);
  color: #d97706;
}

.agent-mini-card.offline,
.agent-mini-overflow {
  color: var(--text-3);
}

.agent-mini-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.create-role-agent-btn {
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  height: 28px;
  width: 28px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--primary-rgb), 0.35);
  border-radius: 9999px;
  background: var(--surface-1);
  color: var(--primary);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition: all 0.2s;
}

.create-role-agent-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: var(--primary);
  background: var(--primary-weak);
}

.create-role-agent-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}

:deep(.p-organizationchart-table) {
  margin: 0 auto;
  border-collapse: separate;
  border-spacing: 0;
}

:deep(.p-organizationchart-node-content) {
  border: none;
  background: transparent !important;
  padding: 10px 20px;
}

:deep(.p-organizationchart-node) {
  border: none !important;
  background: transparent !important;
}

:deep(.p-organizationchart-connectors) {
  border-collapse: separate;
}

:deep(.p-organizationchart-connector-down) {
  width: 2px;
  margin: 0 auto;
  background: var(--primary);
}

:deep(.p-organizationchart-connector-left) {
  border-right: 1px solid var(--primary);
}

:deep(.p-organizationchart-connector-right) {
  border-left: 1px solid var(--primary);
}

:deep(.p-organizationchart-connector-top) {
  border-top: 2px solid var(--primary);
}

:deep(.p-organizationchart-line-down) {
  width: 2px;
  background: var(--primary);
}

:deep(.p-organizationchart-line-left),
:deep(.p-organizationchart-line-right),
:deep(.p-organizationchart-line-top) {
  border-width: 2px;
  border-color: var(--primary);
}
</style>
