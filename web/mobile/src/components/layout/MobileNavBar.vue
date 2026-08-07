<script setup lang="ts">
/**
 * 顶部导航栏
 * 显示当前页面标题 + 返回按钮 + 暗色切换
 */
import { computed } from 'vue';
import { Sun, Moon, ArrowLeft, FolderOpen, Bot } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';

const appStore = useAppStore();
const agentStore = useAgentStore();
const isDark = computed(() => appStore.theme === 'dark');

const title = computed(() => {
  switch (appStore.currentPage) {
    case 'orgs': return '组织列表';
    case 'chat': return '对话';
    case 'settings': return '系统设置';
    case 'agentProps': return '智能体属性';
    case 'roleProps': return '岗位属性';
    default: return '';
  }
});

const showBack = computed(() => appStore.currentPage !== 'orgs');

function goBack() {
  if (appStore.currentPage === 'chat' || appStore.currentPage === 'settings'
      || appStore.currentPage === 'agentProps' || appStore.currentPage === 'roleProps') {
    appStore.goBack();
  }
}

/** 正在工作中的智能体数量（全局总数） */
const busyAgentCount = computed(() =>
    agentStore.allAgents.filter(a => a.status === 'busy').length
);
</script>

<template>
  <header
    class="flex items-center justify-between px-4 h-12 shrink-0 bg-[var(--surface-1)] border-b border-[var(--border)]"
    style="padding-top: var(--safe-top)"
  >
    <div class="flex items-center gap-2 min-w-0">
      <button
        v-if="showBack"
        class="p-1 -ml-1 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
        @click="goBack"
        type="button"
        aria-label="返回"
      >
        <ArrowLeft class="w-5 h-5" />
      </button>
      <h1 class="text-sm font-semibold truncate">{{ title }}</h1>
    </div>

    <div class="flex items-center gap-1">
      <!-- 工作区按钮（仅对话页面显示） -->
      <button
        v-if="appStore.currentPage === 'chat' && appStore.currentOrgId"
        class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
        @click="appStore.toggleWorkspace()"
        type="button"
        aria-label="打开工作区"
      >
        <FolderOpen class="w-5 h-5" />
      </button>
      <!-- 工作中的智能体数量 -->
      <div
        v-if="busyAgentCount > 0"
        class="flex items-center gap-0.5 text-xs font-medium text-[var(--text-2)]"
        title="正在工作的智能体数量"
      >
        <span>{{ busyAgentCount }}</span>
        <Bot class="w-4 h-4" />
      </div>
      <button
        class="p-1.5 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
        @click="appStore.setTheme(appStore.theme === 'dark' ? 'light' : 'dark')"
        type="button"
        :aria-label="isDark ? '切换到明亮模式' : '切换到黑暗模式'"
      >
        <component :is="isDark ? Sun : Moon" class="w-5 h-5" />
      </button>
    </div>
  </header>
</template>
