<script setup lang="ts">
import { ChevronUp, ChevronDown, ArrowDown } from 'lucide-vue-next';
import { computed } from 'vue';

const props = defineProps<{
  containerEl: HTMLElement | null;
  messageCount: number;
}>();

const show = computed(() => props.messageCount > 0);

function getMessageElements(): HTMLElement[] {
  if (!props.containerEl) return [];
  return Array.from(
    props.containerEl.querySelectorAll<HTMLElement>('[id^="msg-"]')
  );
}

function scrollToPrev() {
  const messages = getMessageElements();
  if (!props.containerEl || messages.length === 0) return;

  const container = props.containerEl;
  const viewportTop = container.scrollTop;
  const tolerance = 5;

  for (let i = 0; i < messages.length; i++) {
    const el = messages[i]!;
    const bottom = el.offsetTop + el.offsetHeight;
    if (bottom > viewportTop + tolerance) {
      const targetIdx = i - 1;
      if (targetIdx >= 0) {
        const targetEl = messages[targetIdx]!;
        container.scrollTo({
          top: Math.max(0, targetEl.offsetTop - 60),
          behavior: 'smooth',
        });
      } else {
        container.scrollTo({
          top: Math.max(0, el.offsetTop - 60),
          behavior: 'smooth',
        });
      }
      return;
    }
  }
}

function scrollToNext() {
  const messages = getMessageElements();
  if (!props.containerEl || messages.length === 0) return;

  const container = props.containerEl;
  const viewportBottom = container.scrollTop + container.clientHeight;
  const tolerance = 5;

  for (let i = 0; i < messages.length; i++) {
    const el = messages[i]!;
    if (el.offsetTop > viewportBottom - tolerance) {
      container.scrollTo({
        top: Math.max(0, el.offsetTop - 60),
        behavior: 'smooth',
      });
      return;
    }
  }
}

function scrollToBottom() {
  if (!props.containerEl) return;
  props.containerEl.scrollTo({
    top: props.containerEl.scrollHeight,
    behavior: 'smooth',
  });
}
</script>

<template>
  <div
    v-if="show"
    class="absolute right-1 top-1/3 -translate-y-1/2 z-10 flex flex-col gap-1.5"
  >
    <button
      class="w-10 h-10 rounded-full bg-[var(--surface-1)]/75 backdrop-blur-sm border border-[var(--border)] text-[var(--text-2)] flex items-center justify-center transition-colors active:scale-90 active:bg-[var(--primary-weak)] active:text-[var(--primary)] active:border-[var(--primary)]"
      title="上一条消息"
      @click="scrollToPrev"
    >
      <ChevronUp class="w-5 h-5" />
    </button>
    <button
      class="w-10 h-10 rounded-full bg-[var(--surface-1)]/75 backdrop-blur-sm border border-[var(--border)] text-[var(--text-2)] flex items-center justify-center transition-colors active:scale-90 active:bg-[var(--primary-weak)] active:text-[var(--primary)] active:border-[var(--primary)]"
      title="下一条消息"
      @click="scrollToNext"
    >
      <ChevronDown class="w-5 h-5" />
    </button>
    <!-- 分隔线 -->
    <div class="w-6 h-px bg-[var(--border)] mx-auto my-0.5" />
    <button
      class="w-10 h-10 rounded-full bg-[var(--surface-1)]/75 backdrop-blur-sm border border-[var(--border)] text-[var(--text-2)] flex items-center justify-center transition-colors active:scale-90 active:bg-[var(--primary-weak)] active:text-[var(--primary)] active:border-[var(--primary)]"
      title="滚动到底部"
      @click="scrollToBottom"
    >
      <ArrowDown class="w-5 h-5" />
    </button>
  </div>
</template>
