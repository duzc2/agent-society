<script setup lang="ts">
/**
 * 消息列表 - 滚动 + 无限加载历史
 */
import { ref, watch, nextTick, onMounted } from 'vue';
import type { Message } from '../../types';
import MessageBubble from './MessageBubble.vue';
import MessageNavigator from './MessageNavigator.vue';
import { Loader } from 'lucide-vue-next';

const props = defineProps<{
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  agentId: string;
  isBusy: boolean;
}>();

const emit = defineEmits<{
  'load-more': [];
}>();

const listRef = ref<HTMLElement | null>(null);
const isAtBottom = ref(true);

// 自动滚动到底部（新消息到达时）
watch(
  () => props.messages.length,
  async () => {
    if (isAtBottom.value) {
      await nextTick();
      scrollToBottom();
    }
  }
);

// 首次加载完成后滚动到底部
watch(
  () => props.loading,
  async (loading) => {
    if (!loading && props.messages.length > 0) {
      await nextTick();
      scrollToBottom();
    }
  }
);

function scrollToBottom() {
  if (listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight;
  }
}

function handleScroll() {
  if (!listRef.value) return;

  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  isAtBottom.value = scrollHeight - scrollTop - clientHeight < 60;

  // 滚动到顶部时加载更多
  if (scrollTop < 40 && props.hasMore && !props.isLoadingMore) {
    emit('load-more');
  }
}

onMounted(() => {
  scrollToBottom();
});
</script>

<template>
  <div class="relative h-full">
    <div
      ref="listRef"
      class="h-full overflow-y-auto px-4 py-3"
      @scroll="handleScroll"
    >
      <!-- 加载更多指示器 -->
    <div v-if="isLoadingMore" class="flex justify-center py-3">
      <Loader class="w-5 h-5 text-[var(--text-3)] animate-spin" />
    </div>

    <div v-if="hasMore && !isLoadingMore" class="text-center py-2">
      <span class="text-xs text-[var(--text-3)]">上滑加载更多</span>
    </div>

    <!-- 空状态 -->
    <div v-if="!loading && messages.length === 0" class="flex items-center justify-center h-full">
      <p class="text-sm text-[var(--text-3)]">发送消息开始对话</p>
    </div>

    <!-- 消息列表 -->
    <div v-else class="space-y-3 pb-2">
      <MessageBubble
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
      />
      <!-- busy 指示器 -->
      <div v-if="isBusy" class="flex items-center gap-2 py-1">
        <div class="flex gap-1">
          <span class="w-2 h-2 rounded-full bg-[var(--text-3)] animate-pulse" />
          <span class="w-2 h-2 rounded-full bg-[var(--text-3)] animate-pulse" style="animation-delay: 0.2s" />
          <span class="w-2 h-2 rounded-full bg-[var(--text-3)] animate-pulse" style="animation-delay: 0.4s" />
        </div>
        <span class="text-xs text-[var(--text-3)]">思考中...</span>
      </div>
    </div>
    </div>
    <MessageNavigator :container-el="listRef" :message-count="messages.length" />
  </div>
</template>
