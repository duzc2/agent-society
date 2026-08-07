<script setup lang="ts">
/**
 * 底部导航栏
 * 两个 Tab：组织 | 对话
 */
import { Building2, MessageCircle, Settings } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';

const appStore = useAppStore();

const tabs = [
  { page: 'orgs' as const, icon: Building2, label: '组织' },
  { page: 'chat' as const, icon: MessageCircle, label: '对话' },
  { page: 'settings' as const, icon: Settings, label: '设置' },
];

function navigateTo(page: typeof tabs[number]['page']) {
  if (page === 'chat') {
    if (!appStore.currentOrgId) {
      appStore.navigateTo('orgs');
      return;
    }
  }
  appStore.navigateTo(page);
}
</script>

<template>
  <nav
    class="flex items-center justify-around h-14 shrink-0 bg-[var(--surface-1)] border-t border-[var(--border)]"
    style="padding-bottom: var(--safe-bottom)"
  >
    <button
      v-for="tab in tabs"
      :key="tab.page"
      class="flex flex-col items-center justify-center gap-0.5 px-4 py-1 rounded-lg transition-colors active:scale-95"
      :class="appStore.currentPage === tab.page
        ? 'text-[var(--primary)]'
        : 'text-[var(--text-3)]'"
      @click="navigateTo(tab.page)"
      type="button"
    >
      <component :is="tab.icon" class="w-5 h-5" />
      <span class="text-[10px] font-medium">{{ tab.label }}</span>
    </button>
  </nav>
</template>
