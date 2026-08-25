<script setup lang="ts">
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import { useOrgStore } from '../../stores/org';
import { useDialog } from 'primevue/usedialog';
import { watch, onMounted, onUnmounted, computed, ref } from 'vue';
import { User, Bot, Circle, Square, Loader2, Briefcase, ChevronDown, ChevronRight, Archive } from 'lucide-vue-next';
import MoodGrid from '../common/MoodGrid.vue';
import { useAppStore } from '../../stores/app';
import Button from 'primevue/button';
import ArtifactsList from '../artifacts/ArtifactsList.vue';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { isMoodDark } from '../../utils/moodColors';
import { ZIndex } from '@primeuix/utils';
import type { Agent } from '../../types';

const props = defineProps<{
  orgId: string;
  /** 外部数据模式：提供智能体列表时跳过 store 拉取与轮询（群成员列表复用场景） */
  agents?: Agent[];
  /** 归档分组标题文案（默认"归档"；群成员场景传"已退出成员"） */
  archiveLabel?: string;
}>();

const emit = defineEmits<{
  /** 外部数据模式下点击智能体（正常模式内部走 chatStore.setActiveAgent） */
  select: [agentId: string];
}>();

const agentStore = useAgentStore();
const chatStore = useChatStore();
const orgStore = useOrgStore();
const appStore = useAppStore();
const dialog = useDialog();

// 当前组织的智能体列表（外部数据模式直接使用传入列表）
const currentAgents = computed(() => props.agents ?? agentStore.agentsMap[props.orgId] ?? []);

// 将智能体分为"活跃"和"已归档"两组
// 活跃：online 或 busy | 已归档：offline（包括状态非 active 的 agent）
const activeAgents = computed(() => currentAgents.value.filter(a => a.status !== 'offline'));
const archivedAgents = computed(() => currentAgents.value.filter(a => a.status === 'offline'));
const activeAgentCount = computed(() => activeAgents.value.length);
const archivedAgentCount = computed(() => archivedAgents.value.length);

const currentOrg = computed(() => orgStore.orgs.find(o => o.id === props.orgId));

// 归档面板展开/折叠
const showArchived = ref(false);

// 工件管理器窗口实例（按 orgId 索引）
const artifactsWindows = new Map<string, any>();

/**
 * 将窗口提升到最前面
 * 使用 PrimeVue 的 ZIndex 工具
 */
const bringToFront = (dialogElement: HTMLElement): void => {
  if (!dialogElement) return;
  
  // 找到 mask 元素（在 dialog 的父元素中）
  const maskElement = dialogElement.closest('.p-dialog-mask') as HTMLElement;
  
  // 使用 ZIndex.set 将 mask 置顶（如果存在）
  if (maskElement) {
    ZIndex.set('modal', maskElement, 1000);
  }
  
  // 同时设置 dialog 容器的 z-index
  dialogElement.style.zIndex = String(ZIndex.getCurrent('modal') + 10);
};

/**
 * 将指定窗口移到屏幕中央
 */
const centerWindow = (dialogElement: HTMLElement): void => {
  if (!dialogElement) return;

  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const newLeft = (viewportWidth - rect.width) / 2;
  const newTop = (viewportHeight - rect.height) / 2;

  const clampedLeft = Math.max(0, Math.min(newLeft, viewportWidth - rect.width));
  const clampedTop = Math.max(0, Math.min(newTop, viewportHeight - rect.height));

  dialogElement.style.left = `${clampedLeft}px`;
  dialogElement.style.top = `${clampedTop}px`;
};

/**
 * 查找指定 orgId 的对话框元素
 */
const findDialogElement = (orgId: string): HTMLElement | null => {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (const dialog of dialogs) {
    if (dialog.getAttribute('data-org-id') === orgId) {
      return dialog as HTMLElement;
    }
  }
  return null;
};

/**
 * 打开工件管理器（每个工作区唯一）
 */
const openArtifacts = () => {
  if (!currentOrg.value) return;
  
  // 如果该工作区的工件管理器已存在，提升到最前面、移到中央并返回
  if (artifactsWindows.has(props.orgId)) {
    const dialogElement = findDialogElement(props.orgId);
    if (dialogElement) {
      bringToFront(dialogElement);
      centerWindow(dialogElement);
    }
    return artifactsWindows.get(props.orgId);
  }
  
  const instance = dialog.open(ArtifactsList, {
    props: {
      header: `工件管理器 - ${currentOrg.value?.name}`,
      style: {
        width: '80vw',
        maxWidth: '1000px',
      },
      modal: false,
      dismissableMask: false,
      closeOnEscape: false,
      resizable: true,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
    } as any,
    data: {
      orgId: props.orgId
    },
    onClose: () => {
      artifactsWindows.delete(props.orgId);
    }
  });
  
  // 延迟标记 DOM 元素
  setTimeout(() => {
    const dialogs = document.querySelectorAll('.p-dialog');
    // 找到没有标记的最后一个对话框（应该是我们刚创建的）
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dialogEl = dialogs[i] as HTMLElement;
      if (!dialogEl.getAttribute('data-org-id')) {
        dialogEl.setAttribute('data-org-id', props.orgId);
        break;
      }
    }
  }, 50);
  
  // 记录 instance
  artifactsWindows.set(props.orgId, instance);
  
  return instance;
};

// 当组件挂载或 orgId 改变时加载智能体（外部数据模式不拉取）
const loadAgents = (silent = false) => {
  if (props.orgId && !props.agents) {
    agentStore.fetchAgentsByOrg(props.orgId, silent);
  }
};

// 定时器用于轮询刷新
let pollTimer: ReturnType<typeof setInterval> | null = null;

const startPolling = () => {
  stopPolling();
  // 每3秒轮询一次当前组织的智能体列表
  pollTimer = setInterval(() => {
    loadAgents(true); // 静默刷新，不显示 loading
  }, 3000);
};

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

onMounted(() => {
  loadAgents();
  // 外部数据模式不轮询（数据由父组件响应式提供）
  if (!props.agents) startPolling();
});

onUnmounted(() => {
  stopPolling();
});

watch(() => props.orgId, () => {
  loadAgents();
});

/**
 * 处理智能体点击事件
 */
const handleAgentClick = (agent: any) => {
  // 外部数据模式（群成员列表）：交给父组件决定（打开成员个人对话）
  if (props.agents) {
    emit('select', agent.id);
    return;
  }
  // 更新当前组织选中的智能体，切换对话内容
  chatStore.setActiveAgent(props.orgId, agent.id);
};

/**
 * 处理停止智能体调用
 */
const handleAbortAgent = async (e: Event, agentId: string) => {
  e.stopPropagation(); // 阻止触发 handleAgentClick
  await agentStore.abortAgent(agentId);
};
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 头部功能区 -->
    <div class="p-2 border-b border-[var(--border)] bg-[var(--surface-1)]">
      <div class="flex items-center space-x-1 mb-1 px-1">
        <Button
          v-if="props.orgId !== 'home' && !props.agents"
          variant="text"
          size="small"
          class="!p-2 hover:!bg-[var(--surface-3)] group transition-all !min-w-0"
          title="工件管理器"
          @click="openArtifacts"
        >
          <Briefcase class="w-4 h-4 text-[var(--text-3)] group-hover:text-[var(--primary)]" />
        </Button>
      </div>
      
      <div class="px-2 pb-1 flex items-center justify-between">
        <span class="text-xs font-semibold text-[var(--text-3)] uppercase tracking-wider">
          智能体 ({{ activeAgentCount }})
        </span>
      </div>
    </div>

    <!-- 列表内容 -->
    <div class="flex-grow overflow-y-auto">
      <!-- 加载中 -->
      <div v-if="agentStore.loading && activeAgents.length === 0 && archivedAgentCount === 0" class="flex flex-col items-center justify-center h-32 text-[var(--text-3)]">
        <Loader2 class="w-6 h-6 mb-2 animate-spin" />
        <span class="text-xs">同步中...</span>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!agentStore.loading && activeAgents.length === 0 && archivedAgentCount === 0" class="flex flex-col items-center justify-center h-32 text-[var(--text-3)] opacity-50 px-4 text-center">
        <Bot class="w-8 h-8 mb-2" />
        <span class="text-xs">{{ props.agents ? '暂无群成员' : '该组织暂无智能体' }}</span>
      </div>

      <!-- 智能体列表 -->
      <template v-else>
        <!-- 活跃智能体 -->
        <div class="p-2 space-y-1">
          <button
            v-for="agent in activeAgents"
            :key="agent.id"
            class="w-full flex items-center p-3 rounded-lg transition-all duration-200 group hover:bg-[var(--surface-3)] active:scale-[0.98]"
            :class="[
              chatStore.getActiveAgentId(props.orgId) === agent.id
                ? 'bg-[var(--surface-3)] border-[var(--primary-weak)] border'
                : 'border border-transparent'
            ]"
            @click="handleAgentClick(agent)"
          >
            <!-- 头像/图标 -->
            <div class="relative mr-3">
              <div class="relative w-11 h-11 rounded-full overflow-hidden flex items-center justify-center border border-[var(--border)] group-hover:border-[var(--primary-weak)] transition-colors"
                   :class="agent.id === 'user' ? 'bg-[var(--surface-3)]' : ''">
                <MoodGrid
                  v-if="agent.id !== 'user' && (agentStore.moodColorsMap[agent.id]?.length ?? 0) > 0 && appStore.moodColorsEnabled"
                  :mood-colors="agentStore.moodColorsMap[agent.id]"
                  :enabled="appStore.moodColorsEnabled"
                  class="absolute inset-0"
                />
                <User v-if="agent.id === 'user'" class="relative z-10 w-5 h-5 text-[var(--text-2)]" />
                <Bot v-else class="relative z-10 w-5 h-5" :class="isMoodDark(agentStore.moodColorsMap[agent.id]) ? 'text-white' : 'text-[var(--primary)]'" />
              </div>
              <!-- 状态指示器 -->
              <div
                class="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[var(--surface-2)] flex items-center justify-center shadow-sm"
                :class="[
                  agent.status === 'busy' ? 'bg-amber-500' :
                  agent.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                ]"
              >
                <Loader2 v-if="agent.status === 'busy'" class="w-2 h-2 text-white animate-spin" />
                <Circle v-else class="w-1.5 h-1.5 text-white fill-white" />
              </div>
            </div>

            <!-- 信息 -->
            <div class="flex-grow min-w-0 text-left">
              <div class="flex items-center justify-between mb-0.5">
                <span class="font-semibold text-sm text-[var(--text-1)] truncate">{{ agent.name }}</span>
                <!-- 停止按钮 (仅在 busy 状态显示) -->
                <button
                  v-if="agent.status === 'busy'"
                  class="p-1 rounded bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all ml-2"
                  title="停止请求"
                  @click="handleAbortAgent($event, agent.id)"
                >
                  <Square class="w-3 h-3 fill-current" />
                </button>
              </div>
              <div class="text-xs text-[var(--text-3)] truncate flex items-center">
                <span class="inline-block px-1.5 py-0.5 rounded bg-[var(--surface-1)] mr-2 border border-[var(--border)]">
                  {{ agent.role }}
                </span>
              </div>
            </div>
          </button>
        </div>

        <!-- 归档智能体（可折叠面板） -->
        <div v-if="archivedAgentCount > 0" class="border-t border-[var(--border)]">
          <button
            class="w-full flex items-center px-4 py-2.5 text-xs text-[var(--text-3)] hover:bg-[var(--surface-2)] transition-colors"
            @click="showArchived = !showArchived"
          >
            <component :is="showArchived ? ChevronDown : ChevronRight" class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
            <Archive class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
            <span class="font-medium">{{ props.archiveLabel ?? '归档' }} ({{ archivedAgentCount }})</span>
          </button>

          <!-- 展开时显示归档列表 -->
          <div v-if="showArchived" class="p-2 space-y-1">
            <button
              v-for="agent in archivedAgents"
              :key="agent.id"
              class="w-full flex items-center p-2.5 rounded-lg transition-all duration-200 group hover:bg-[var(--surface-3)] active:scale-[0.98] opacity-60 hover:opacity-100"
              :class="[
                chatStore.getActiveAgentId(props.orgId) === agent.id
                  ? 'bg-[var(--surface-3)] border-[var(--primary-weak)] border'
                  : 'border border-transparent'
              ]"
              @click="handleAgentClick(agent)"
            >
              <!-- 头像/图标 -->
              <div class="relative mr-2.5">
                <div class="relative w-9 h-9 rounded-full overflow-hidden flex items-center justify-center border border-[var(--border)] group-hover:border-[var(--primary-weak)] transition-colors">
                  <MoodGrid
                    v-if="(agentStore.moodColorsMap[agent.id]?.length ?? 0) > 0 && appStore.moodColorsEnabled"
                    :mood-colors="agentStore.moodColorsMap[agent.id]"
                    :enabled="appStore.moodColorsEnabled"
                    class="absolute inset-0"
                  />
                  <Bot class="relative z-10 w-4 h-4" :class="isMoodDark(agentStore.moodColorsMap[agent.id]) ? 'text-white' : 'text-[var(--text-3)]'" />
                </div>
                <!-- 离线状态指示器 -->
                <div class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--surface-2)] bg-gray-400 flex items-center justify-center shadow-sm">
                  <Circle class="w-1.5 h-1.5 text-white fill-white" />
                </div>
              </div>

              <!-- 信息 -->
              <div class="flex-grow min-w-0 text-left">
                <div class="flex items-center justify-between mb-0.5">
                  <span class="font-medium text-xs text-[var(--text-2)] truncate">{{ agent.name }}</span>
                </div>
                <div class="text-[11px] text-[var(--text-3)] truncate flex items-center">
                  <span class="inline-block px-1 py-0.5 rounded bg-[var(--surface-1)] mr-1.5 border border-[var(--border)]">
                    {{ agent.role }}
                  </span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>

.overflow-y-auto {
  scrollbar-width: thin;
  -ms-overflow-style: thin;
  overflow-y: auto;
}
.overflow-y-auto::-webkit-scrollbar {
  display: thin;
}
</style>
