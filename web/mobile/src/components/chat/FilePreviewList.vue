<script setup lang="ts">
/**
 * 内联文件缩略图列表
 * 显示在聊天气泡中或消息列表顶部
 */
import { useAppStore } from '../../stores/app';
import { useFileViewer } from '../../composables/useFileViewer';

defineProps<{
  files: Array<{
    name: string;
    path: string;
    mimeType: string;
    modifiedAt?: string;
    lastOperator?: string;
    messageId?: string;
  }>;
}>();

const appStore = useAppStore();
const { openWorkspaceFile } = useFileViewer();

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

async function openFile(file: { name: string; path: string; mimeType: string }) {
  if (isImage(file.mimeType)) {
    appStore.openFileViewer({
      fileName: file.name,
      mimeType: file.mimeType,
      content: '',
      src: file.path
    });
    return;
  }

  const err = await openWorkspaceFile(file);
  if (err) {
    appStore.openFileViewer({
      fileName: file.name,
      mimeType: file.mimeType,
      content: err,
      src: undefined
    });
  }
}
</script>

<template>
  <div class="px-3 py-2 overflow-x-auto no-scrollbar">
    <div class="flex gap-2">
      <button
        v-for="(file, i) in files"
        :key="i"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--surface-3)] text-xs text-[var(--text-2)] shrink-0 active:scale-95 transition-transform"
        @click="openFile(file)"
        type="button"
      >
        <span v-if="isImage(file.mimeType)">🖼</span>
        <span v-else>📄</span>
        <span class="truncate max-w-[120px]">{{ file.name }}</span>
      </button>
    </div>
  </div>
</template>
