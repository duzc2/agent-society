<script setup lang="ts">
/**
 * 智能体横排列表选择器
 * 少量智能体 → flex-wrap 折行；2 行仍溢出 → grid 列布局横向滚动
 */
import type { Agent } from '../../types';
import { StopCircle } from 'lucide-vue-next';
import { useAgentStore } from '../../stores/agent';
import { useAppStore } from '../../stores/app';
import MoodGrid from '../common/MoodGrid.vue';
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  agents: Agent[];
  activeAgentId: string;
}>();

const emit = defineEmits<{
  select: [agentId: string];
}>();

const agentStore = useAgentStore();
const appStore = useAppStore();

const pillContainerRef = ref<HTMLElement | null>(null);
const overflowMode = ref(false);

function isAgentBusy(agent: Agent): boolean {
  if (agent.computeStatus === 'waiting_llm' || agent.computeStatus === 'computing' || agent.computeStatus === 'processing') {
    return true;
  }
  return agent.status === 'busy';
}

function checkOverflow() {
  const container = pillContainerRef.value;
  if (!container) return;

  const pill = container.querySelector('[data-pill]') as HTMLElement | null;
  if (!pill) return;

  const pillH = pill.offsetHeight;
  const twoRowH = pillH * 2 + 8; // 2 rows + 8px gap

  const origDisplay = container.style.display;
  const origFlexWrap = container.style.flexWrap;
  const origMaxHeight = container.style.maxHeight;
  const origOverflow = container.style.overflow;

  container.style.display = 'flex';
  container.style.flexWrap = 'wrap';
  container.style.maxHeight = `${twoRowH}px`;
  container.style.overflow = 'hidden';

  // 强制回流后比较
  void container.offsetHeight;

  overflowMode.value = container.scrollHeight > container.clientHeight + 2;

  container.style.display = origDisplay;
  container.style.flexWrap = origFlexWrap;
  container.style.maxHeight = origMaxHeight;
  container.style.overflow = origOverflow;
}

onMounted(() => {
  requestAnimationFrame(checkOverflow);
  window.addEventListener('resize', checkOverflow);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkOverflow);
});
</script>

<template>
  <div class="px-3 py-2 bg-[var(--surface-1)] border-b border-[var(--border)]">
    <div
      ref="pillContainerRef"
      class="gap-2"
      :class="overflowMode
        ? 'grid overflow-x-auto no-scrollbar'
        : 'flex flex-wrap items-center'"
      :style="overflowMode
        ? { gridAutoFlow: 'column', gridTemplateRows: 'repeat(2, minmax(0, auto))' }
        : {}"
    >
      <button
        v-for="agent in agents"
        :key="agent.id"
        data-pill
        class="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 active:scale-95"
        :class="agent.id === activeAgentId
          ? 'bg-[var(--primary)] text-white'
          : 'bg-[var(--surface-3)] text-[var(--text-2)]'"
        @click="emit('select', agent.id)"
        type="button"
      >
        <!-- MoodGrid 彩色模糊背景圆点 -->
        <div
          class="relative w-3.5 h-3.5 rounded-full overflow-hidden shrink-0"
          :class="{ 'animate-breathe': isAgentBusy(agent) }"
        >
          <MoodGrid
            v-if="agent.id !== 'user' && (agentStore.moodColorsMap[agent.id]?.length ?? 0) > 0 && appStore.moodColorsEnabled"
            :mood-colors="agentStore.moodColorsMap[agent.id]"
            :enabled="appStore.moodColorsEnabled"
            class="absolute inset-0"
          />
        </div>
        <span class="truncate max-w-[80px]">{{ agent.name }}</span>

        <!-- 中断按钮（忙碌状态） -->
        <button
          v-if="isAgentBusy(agent) && agent.id !== 'user'"
          class="ml-0.5 p-0.5 rounded-full hover:bg-white/20 active:bg-white/30 transition-colors"
          @click.stop="agentStore.abortAgent(agent.id)"
          type="button"
          aria-label="中断运行"
        >
          <StopCircle class="w-3.5 h-3.5" />
        </button>
      </button>
    </div>
  </div>
</template>
