<script setup lang="ts">
import { ref, inject, onMounted } from 'vue';
import { Loader2, FileJson } from 'lucide-vue-next';
import { apiService } from '../../services/api';

const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const workspaceId: string = data.workspaceId;
const filePath: string = data.filePath;

const meta = ref<Record<string, any> | null>(null);
const loading = ref(false);
const error = ref('');

async function loadMeta() {
  if (!workspaceId || !filePath) return;

  loading.value = true;
  error.value = '';

  try {
    meta.value = await apiService.getFileMeta(workspaceId, filePath);
  } catch (e: any) {
    console.error('获取文件元数据失败:', e);
    error.value = e?.message || '获取文件元数据失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadMeta();
});
</script>

<template>
  <div class="file-meta-content min-h-[120px]">
    <!-- 加载状态 -->
    <div v-if="loading" class="flex items-center justify-center py-8">
      <Loader2 class="w-6 h-6 animate-spin text-[var(--primary)]" />
      <span class="ml-2 text-[var(--text-2)]">加载中...</span>
    </div>

    <!-- 错误提示 -->
    <div v-else-if="error" class="text-center py-8 text-red-500">
      <p>{{ error }}</p>
    </div>

    <!-- 元数据内容 -->
    <div v-else-if="meta" class="meta-content">
      <div class="flex items-center mb-3">
        <FileJson class="w-4 h-4 mr-2 text-[var(--primary)]" />
        <span class="text-xs text-[var(--text-3)]">{{ filePath }}</span>
      </div>
      <pre class="meta-json text-xs text-[var(--text-1)] bg-[var(--surface-2)] rounded-lg p-4 overflow-auto max-h-[500px]">{{ JSON.stringify(meta, null, 2) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.file-meta-content {
  width: 100%;
}

.meta-json {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
