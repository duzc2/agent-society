<script setup lang="ts">
/**
 * 文本编辑器组件
 * 
 * 提供基础的文本编辑功能，支持：
 * 1. 纯文本编辑
 * 2. 简单的行号显示（可选）
 * 3. 基础的代码样式
 * 
 * @module components/file-viewer/renderers/TextEditor
 */
import { ref, watch, onMounted, nextTick } from 'vue';

const props = defineProps<{
  content: string;
  fileName: string;
  filePath: string;
  workspaceId: string;
}>();

const emit = defineEmits<{
  (e: 'update:content', value: string): void;
  (e: 'save'): void;
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const localContent = ref(props.content);

// 监听内容变化，同步到父组件
watch(localContent, (newVal) => {
  emit('update:content', newVal);
});

// 监听外部内容变化（例如重新加载）
watch(() => props.content, (newVal) => {
  if (newVal !== localContent.value) {
    localContent.value = newVal;
  }
});

// 处理按键事件
const handleKeydown = (e: KeyboardEvent) => {
  // Ctrl+S / Cmd+S 保存
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    emit('save');
  }
  
  // Tab 键支持
  if (e.key === 'Tab') {
    e.preventDefault();
    const textarea = textareaRef.value;
    if (!textarea) return;
    
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    
    // 插入两个空格
    const spaces = '  ';
    // 更新内容前，需要确保 localContent 与 dom 保持一致，虽然 v-model 会处理，但直接操作字符串更安全
    const value = localContent.value;
    localContent.value = value.substring(0, start) + spaces + value.substring(end);
    
    // 恢复光标位置
    nextTick(() => {
      textarea.selectionStart = textarea.selectionEnd = start + spaces.length;
    });
  }
};

// 暴露 focus 方法
defineExpose({
  focus: () => {
    textareaRef.value?.focus();
  }
});

onMounted(() => {
  // 自动聚焦
  if (textareaRef.value) {
    textareaRef.value.focus();
  }
});
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--bg)] text-[var(--text-1)]">
    <div class="flex-1 relative overflow-hidden">
      <textarea
        ref="textareaRef"
        v-model="localContent"
        class="w-full h-full p-4 font-mono text-sm bg-transparent border-none resize-none outline-none focus:ring-0 leading-relaxed"
        spellcheck="false"
        @keydown="handleKeydown"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
textarea {
  tab-size: 2;
}
</style>
