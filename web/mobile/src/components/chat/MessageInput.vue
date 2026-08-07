<script setup lang="ts">
/**
 * 底部输入区 - 键盘感知定位
 */
import { ref, computed, watch } from 'vue';
import { SendHorizonal, Bot } from 'lucide-vue-next';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
import { useKeyboard } from '../../utils/keyboard';

const props = defineProps<{
  agentId: string;
  orgId: string;
}>();

const chatStore = useChatStore();
const appStore = useAppStore();
const { keyboardHeight } = useKeyboard();

const inputRef = ref<HTMLTextAreaElement | null>(null);
const localInput = ref('');

// 同步本地输入与 store
const inputValue = computed(() => chatStore.getInputValue(props.agentId));

watch(inputValue, (val) => {
  localInput.value = val;
}, { immediate: true });

// 发送消息
async function sendMessage() {
  const text = localInput.value.trim();
  if (!text || !props.agentId) return;

  try {
    await chatStore.sendMessage(props.agentId, text, props.agentId);
    localInput.value = '';
    chatStore.updateInputValue(props.agentId, '');
  } catch (e: any) {
    appStore.setError(e?.message || '发送失败');
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// 自动调整输入框高度
watch(localInput, () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto';
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 120) + 'px';
  }
});

function focusInput() {
  inputRef.value?.focus();
}
</script>

<template>
  <div
    class="shrink-0 bg-[var(--surface-1)] border-t border-[var(--border)]"
    :style="{ paddingBottom: keyboardHeight + 'px' }"
  >
    <div class="flex items-end gap-2 px-3 py-2">
      <!-- 智能体属性入口 -->
      <button
        v-if="agentId && agentId !== 'user'"
        class="self-center w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[var(--text-3)] hover:bg-[var(--surface-3)] hover:text-[var(--text-1)] transition-colors active:scale-95"
        @click="appStore.navigateToAgentProps(props.agentId)"
        type="button"
        aria-label="智能体属性"
      >
        <Bot class="w-4 h-4" />
      </button>

      <!-- 输入框 -->
      <div class="flex-1 relative" @click="focusInput">
        <textarea
          ref="inputRef"
          v-model="localInput"
          class="w-full resize-none rounded-xl px-3 py-2 text-sm bg-[var(--surface-2)] text-[var(--text-1)] border border-[var(--border)] focus:outline-none focus:border-[var(--primary)] max-h-[120px]"
          :placeholder="agentId ? '输入消息...' : '未选择智能体'"
          rows="1"
          @input="chatStore.updateInputValue(props.agentId, localInput)"
          @keydown="handleKeydown"
          :disabled="!agentId"
        />
      </div>

      <!-- 发送按钮 -->
      <button
        class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors active:scale-95"
        :class="localInput.trim() && agentId
          ? 'bg-[var(--primary)] text-white'
          : 'bg-[var(--surface-3)] text-[var(--text-3)]'"
        :disabled="!localInput.trim() || !agentId"
        @click="sendMessage"
        type="button"
        aria-label="发送消息"
      >
        <SendHorizonal class="w-5 h-5" />
      </button>
    </div>
  </div>
</template>
