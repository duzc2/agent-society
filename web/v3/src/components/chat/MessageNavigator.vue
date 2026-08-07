<script setup lang="ts">
import { ChevronUp, ChevronDown } from 'lucide-vue-next';
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

  // 从上往下遍历，找到第一个底部还在视口内的消息
  // 它的前一条就是完全滚出视口的最后一条消息
  for (let i = 0; i < messages.length; i++) {
    const el = messages[i]!;
    const bottom = el.offsetTop + el.offsetHeight;
    if (bottom > viewportTop + tolerance) {
      // 这条消息还有一部分在视口内，上一条（i-1）就是我们要滚到的目标
      const targetIdx = i - 1;
      if (targetIdx >= 0) {
        const targetEl = messages[targetIdx]!;
        container.scrollTo({
          top: Math.max(0, targetEl.offsetTop - 60),
          behavior: 'smooth',
        });
      } else {
        // 没有上一条消息，滚到当前消息的顶部
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

  // 从上往下遍历，找到第一条顶部在视口下方（未进入视口）的消息
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
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="transform translate-x-4 opacity-0"
    enter-to-class="transform translate-x-0 opacity-100"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="transform translate-x-0 opacity-100"
    leave-to-class="transform translate-x-4 opacity-0"
  >
    <div
      v-if="show"
      class="absolute right-3 top-1/3 -translate-y-1/2 z-20 flex flex-col gap-1"
    >
      <button
        class="w-8 h-8 rounded-full bg-[var(--surface-1)]/80 backdrop-blur-sm border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--primary)] hover:border-[var(--primary)] hover:bg-[var(--primary-weak)] shadow-sm flex items-center justify-center transition-all"
        title="上一条消息"
        @click="scrollToPrev"
      >
        <ChevronUp class="w-4 h-4" />
      </button>
      <button
        class="w-8 h-8 rounded-full bg-[var(--surface-1)]/80 backdrop-blur-sm border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--primary)] hover:border-[var(--primary)] hover:bg-[var(--primary-weak)] shadow-sm flex items-center justify-center transition-all"
        title="下一条消息"
        @click="scrollToNext"
      >
        <ChevronDown class="w-4 h-4" />
      </button>
    </div>
  </Transition>
</template>
