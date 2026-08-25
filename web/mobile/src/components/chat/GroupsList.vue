<script setup lang="ts">
/**
 * 移动端群列表组件
 * 活跃群 + 已解散（归档）折叠区：解散的群保留在列表中，可随时查阅历史消息
 */
import { ref, computed } from 'vue';
import { ChevronRight, ChevronDown, Users, Archive } from 'lucide-vue-next';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
import type { GroupMeta } from '../../types';

const chatStore = useChatStore();
const appStore = useAppStore();

// 活跃 / 已解散（归档）分组
const activeGroups = computed(() => chatStore.groupList.filter(g => g.status !== 'archived'));
const dissolvedGroups = computed(() => chatStore.groupList.filter(g => g.status === 'archived'));
const showDissolved = ref(false);

function handleGroupClick(group: GroupMeta) {
  appStore.navigateToGroupChat(group.id);
  chatStore.fetchGroupMessages(group.id);
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-3 py-2 text-xs font-medium text-[var(--text-3)] uppercase tracking-wider">
      群聊
    </div>
    <div class="flex-1 overflow-y-auto">
      <div v-if="chatStore.groupList.length === 0" class="flex flex-col items-center justify-center py-12 text-[var(--text-3)]">
        <Users class="w-10 h-10 mb-2 opacity-30" />
        <p class="text-sm">暂无群聊</p>
      </div>

      <!-- 活跃群 -->
      <button
        v-for="group in activeGroups"
        :key="group.id"
        class="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-[var(--surface-2)] active:scale-[0.98] transition-all border-b border-[var(--border)]"
        @click="handleGroupClick(group)"
      >
        <div class="w-9 h-9 rounded-full bg-[var(--primary-weak)] text-[var(--primary)] flex items-center justify-center shrink-0">
          <Users class="w-4 h-4" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-[var(--text-1)] truncate">
            {{ group.name }}
          </div>
          <div class="text-xs text-[var(--text-3)]">
            {{ group.memberCount }} 人
          </div>
        </div>
        <ChevronRight class="w-4 h-4 text-[var(--text-3)] shrink-0" />
      </button>

      <!-- 已解散（归档）折叠区 -->
      <div v-if="dissolvedGroups.length > 0" class="border-t border-[var(--border)] pt-2">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-3)] active:bg-[var(--surface-2)] rounded-lg transition-colors"
          @click="showDissolved = !showDissolved"
          type="button"
        >
          <component :is="showDissolved ? ChevronDown : ChevronRight" class="w-4 h-4 flex-shrink-0" />
          <Archive class="w-4 h-4 flex-shrink-0" />
          <span class="font-medium">已解散 ({{ dissolvedGroups.length }})</span>
        </button>

        <div v-if="showDissolved" class="space-y-1 mt-1">
          <button
            v-for="group in dissolvedGroups"
            :key="group.id"
            class="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-[var(--surface-2)] active:scale-[0.98] transition-all border-b border-[var(--border)] opacity-60"
            @click="handleGroupClick(group)"
            type="button"
          >
            <div class="w-9 h-9 rounded-full bg-[var(--surface-3)] text-[var(--text-3)] flex items-center justify-center shrink-0">
              <Users class="w-4 h-4" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-[var(--text-1)] truncate">
                {{ group.name }}
              </div>
              <div class="text-xs text-[var(--text-3)]">
                已解散 · {{ group.memberCount }} 人
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-[var(--text-3)] shrink-0" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
