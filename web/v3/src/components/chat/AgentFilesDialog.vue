<script setup lang="ts">
import { ref, inject, onMounted, watch } from 'vue';
import { Loader2, FileText } from 'lucide-vue-next';
import { apiService } from '../../services/api';
import { getDialogRef } from '../../services/dialogRef';
import { openFileViewer } from '../file-viewer';

// ---- dialog data (markRaw'd by manager, so no unwrapping) ----
const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const orgId: string = data.orgId;
const agentId: string = data.agentId;
const refreshSignal: { value: number } = data.refreshSignal;

// ---- internal state ----
interface AgentFile {
  name: string;
  path: string;
  size: number;
  extension: string;
  modifiedAt: string;
  mimeType: string;
  lastOperator: string;
  lastMessageId: string;
}

const files = ref<AgentFile[]>([]);
const loading = ref(false);
const error = ref('');

// ---- helpers ----
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ---- data loading ----
async function loadFiles() {
  if (!orgId || !agentId) return;

  loading.value = true;
  error.value = '';

  try {
    const response = await apiService.getAgentFiles(orgId, agentId);
    files.value = response.files;
  } catch (e: any) {
    console.error('获取智能体文件列表失败:', e);
    error.value = e?.message || '获取文件列表失败';
  } finally {
    loading.value = false;
  }
}

// ---- file click handler ----
async function handleFileClick(file: AgentFile) {
  try {
    const dialog = getDialogRef();
    if (!dialog) return;

    await openFileViewer({
      dialog,
      workspaceId: orgId,
      filePath: file.path,
      width: '85vw',
      height: '80vh'
    });
  } catch (e) {
    console.error('打开文件失败:', e);
  }
}

// ---- lifecycle ----
onMounted(() => {
  loadFiles();
});

// Auto-refresh when external signal triggers
watch(() => refreshSignal?.value, () => {
  loadFiles();
});
</script>

<template>
  <div class="agent-files-content">
    <!-- 加载状态 -->
    <div v-if="loading" class="flex items-center justify-center py-8">
      <Loader2 class="w-6 h-6 animate-spin text-[var(--primary)]" />
      <span class="ml-2 text-[var(--text-2)]">加载中...</span>
    </div>

    <!-- 错误提示 -->
    <div v-else-if="error" class="text-center py-8 text-red-500">
      <p>{{ error }}</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="files.length === 0" class="text-center py-8 text-[var(--text-3)]">
      <FileText class="w-12 h-12 mx-auto mb-3 opacity-50" />
      <p>暂无修改的文件</p>
    </div>

    <!-- 文件列表 -->
    <div v-else class="file-list">
      <div class="file-count text-xs text-[var(--text-3)] mb-3">
        共 {{ files.length }} 个文件
      </div>
      <div class="file-items space-y-2 max-h-[400px] overflow-y-auto">
        <div
          v-for="file in files"
          :key="file.path"
          class="file-item flex items-center justify-between p-3 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
          @click="handleFileClick(file)"
        >
          <div class="flex items-center min-w-0 flex-1">
            <FileText class="w-4 h-4 mr-3 text-[var(--primary)] shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="file-name text-sm text-[var(--text-1)] truncate" :title="file.path">
                {{ file.name }}
              </div>
              <div class="file-path text-xs text-[var(--text-3)] truncate" :title="file.path">
                {{ file.path }}
              </div>
            </div>
          </div>
          <div class="file-meta text-right shrink-0 ml-4">
            <div class="file-size text-xs text-[var(--text-2)]">
              {{ formatFileSize(file.size) }}
            </div>
            <div class="file-date text-xs text-[var(--text-3)]">
              {{ formatDate(file.modifiedAt) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-files-content {
  min-height: 120px;
}

.file-list {
  width: 100%;
}

.file-item {
  border: 1px solid transparent;
}

.file-item:hover {
  border-color: var(--surface-3);
}
</style>
