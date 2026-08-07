<script setup lang="ts">
/**
 * 文件查看器自定义标题栏
 *
 * 包含：文件名 | 类型·大小 | [预览|源码] | 复制 | 下载 | 全屏 | 关闭
 */
import { computed, ref, type Ref } from 'vue';
import { X, Download, Maximize2, Minimize2, Eye, Code, Copy, Check, Play, Edit2, Save, XCircle, ImageDown, ExternalLink, History, ZoomIn, ZoomOut, RotateCcw } from 'lucide-vue-next';
import { useDialog } from 'primevue/usedialog';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { fileViewerService } from './services/fileViewerService';
import { uiCommandService } from '../../services/uiCommandService';
import { openFileDiffDialog } from '../file-diff/index';

const props = defineProps<{
  fileName: string;
  workspaceId: string;
  filePath: string;
  mimeType?: string;
  size?: number;
  hasViewMode?: boolean;
  viewMode?: Ref<'preview' | 'source'>;
  copyFunction?: Ref<{ copy: () => void; copied: { value: boolean } } | null>;
  getFileContent?: Ref<(() => string) | null>;
  downloadLongImage?: Ref<(() => void) | null>;
  maximized?: boolean;
  isEditable?: boolean | Ref<boolean>;
  isEditing?: boolean | Ref<boolean>;
  zoomLevel?: Ref<number>;
}>();

// 处理可能为 Ref 的 props
const editable = computed(() => {
  const val = props.isEditable;
  return typeof val === 'object' && val !== null && 'value' in val ? val.value : val;
});

const editing = computed(() => {
  const val = props.isEditing;
  return typeof val === 'object' && val !== null && 'value' in val ? val.value : val;
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'maximize'): void;
  (e: 'edit'): void;
  (e: 'save'): void;
  (e: 'cancel-edit'): void;
}>();

// 当前 viewMode 值
const currentMode = computed(() => props.viewMode?.value ?? 'preview');

// 设置 viewMode
const setPreview = () => {
  console.log('[FileViewerHeader] setPreview called, props.viewMode:', props.viewMode);
  if (props.viewMode) {
    console.log('[FileViewerHeader] Before set, current value:', props.viewMode.value);
    props.viewMode.value = 'preview';
    console.log('[FileViewerHeader] After set, new value:', props.viewMode.value);
  }
};
const setSource = () => {
  console.log('[FileViewerHeader] setSource called, props.viewMode:', props.viewMode);
  if (props.viewMode) {
    console.log('[FileViewerHeader] Before set, current value:', props.viewMode.value);
    props.viewMode.value = 'source';
    console.log('[FileViewerHeader] After set, new value:', props.viewMode.value);
  }
};

const formatSize = (size?: number) => {
  if (!size) return '';
  return fileViewerService.formatFileSize(size);
};

const downloadFile = () => {
  fileViewerService.downloadFile(props.workspaceId, props.filePath, props.fileName);
};

const handleMaximize = () => {
  console.log('[FileViewerHeader] handleMaximize called');
  emit('maximize');
};

const dialog = useDialog();

const handleClose = () => {
  console.log('[FileViewerHeader] handleClose called');
  emit('close');
};

const openHistory = () => {
  openFileDiffDialog(dialog, props.workspaceId, props.filePath);
};

// 打印日志用于调试
console.log('[FileViewerHeader] props.copyFunction:', props.copyFunction);

// 是否显示复制按钮
const showCopyButton = computed(() => {
  const cfValue = props.copyFunction?.value;
  const hasCopy = cfValue !== null && cfValue !== undefined;
  console.log('[FileViewerHeader] showCopyButton computed, cfValue:', cfValue, 'hasCopy:', hasCopy);
  return hasCopy;
});

// 是否是 HTML 文件
const isHtml = computed(() => {
  return (props.mimeType || '') === 'text/html';
});

// 新窗口打开 HTML 文件
const openInNewWindow = () => {
  const url = fileViewerService.getRawFileUrl(props.workspaceId, props.filePath);
  if (url) {
    window.open(url, '_blank');
  }
};

// 是否是 Markdown 文件（用于显示下载长图按钮）
const isMarkdown = computed(() => {
  const mime = props.mimeType || '';
  const name = props.fileName || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return mime === 'text/markdown' || ext === 'md' || ext === 'markdown';
});

// 下载长图
const handleDownloadLongImage = () => {
  const fn = props.downloadLongImage?.value;
  if (fn) {
    fn();
  }
};

// 缩放控制
const zoomPercent = computed(() => {
  const val = props.zoomLevel?.value ?? 1;
  return Math.round(val * 100) + '%';
});

const zoomIn = () => {
  if (props.zoomLevel) {
    props.zoomLevel.value = Math.min(2.0, props.zoomLevel.value + 0.1);
  }
};

const zoomOut = () => {
  if (props.zoomLevel) {
    props.zoomLevel.value = Math.max(0.5, props.zoomLevel.value - 0.1);
  }
};

const zoomReset = () => {
  if (props.zoomLevel) {
    props.zoomLevel.value = 1;
  }
};

// 是否是 JavaScript 文件
const isJavaScript = computed(() => {
  const mimeType = props.mimeType || '';
  const fileName = props.fileName || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  return mimeType === 'text/javascript' ||
         mimeType === 'application/javascript' ||
         mimeType === 'application/x-javascript' ||
         ext === 'js' ||
         ext === 'mjs' ||
         ext === 'cjs';
});

// 运行状态
const running = ref(false);
const runResult = ref<any>(null);
const runError = ref<string | null>(null);
const showResult = ref(false);

// 运行 JavaScript 代码
const handleRun = async () => {
  if (!props.getFileContent?.value) {
    console.error('[FileViewerHeader] getFileContent not available');
    return;
  }

  const code = props.getFileContent.value();
  if (!code) {
    console.error('[FileViewerHeader] No code content available');
    return;
  }

  running.value = true;
  runError.value = null;
  runResult.value = null;

  try {
    const result = await uiCommandService.executeScript(code);
    console.log('[FileViewerHeader] Run result:', result);

    if (result.ok) {
      runResult.value = result.result;
      showResult.value = true;
    } else {
      runError.value = result.error || '运行失败';
      showResult.value = true;
    }
  } catch (err) {
    const error = err instanceof Error ? (err.stack || err.message) : String(err);
    runError.value = error;
    showResult.value = true;
    console.error('[FileViewerHeader] Run error:', error);
  } finally {
    running.value = false;
  }
};

// 复制状态
const copiedState = computed(() => {
  const cfValue = props.copyFunction?.value;
  if (!cfValue) return false;
  // copied 可能是 Ref 或普通对象
  const copied = (cfValue as any).copied;
  if (typeof copied === 'object' && 'value' in copied) {
    return copied.value;
  }
  if (typeof copied === 'boolean') {
    return copied;
  }
  return false;
});

// 复制处理函数
const handleCopy = () => {
  console.log('[FileViewerHeader] handleCopy called, props.copyFunction?.value:', props.copyFunction?.value);
  props.copyFunction?.value?.copy();
};
</script>

<template>
  <div class="flex items-center justify-between w-full px-2">
    <!-- 左侧：文件名 | 类型·大小 -->
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <span class="font-medium text-sm truncate" :title="fileName">
        {{ fileName }}
      </span>
      <span class="text-xs text-[var(--text-3)]">
        {{ props.filePath }}
      </span>
      <span v-if="mimeType" class="text-xs text-[var(--text-3)]">
        · {{ mimeType }} · {{ formatSize(size) }}
      </span>
    </div>

    <!-- 右侧按钮组 -->
    <div class="flex items-center gap-0.5 shrink-0">
      <!-- 编辑模式按钮 -->
      <template v-if="editable">
        <template v-if="editing">
          <Button
            variant="text"
            size="small"
            @click="() => { console.log('[Header] Save clicked'); emit('save'); }"
            class="!w-8 !h-8 text-green-500"
            v-tooltip.bottom="'保存'"
          >
            <Save class="w-4 h-4" />
          </Button>
          <Button
            variant="text"
            size="small"
            @click="emit('cancel-edit')"
            class="!w-8 !h-8 text-red-500"
            v-tooltip.bottom="'取消编辑'"
          >
            <XCircle class="w-4 h-4" />
          </Button>
        </template>
        <Button
            v-else
            variant="text"
            size="small"
            @click="() => { console.log('[Header] Edit clicked'); emit('edit'); }"
            class="!w-8 !h-8"
            v-tooltip.bottom="'编辑'"
          >
            <Edit2 class="w-4 h-4" />
          </Button>
      </template>

      <!-- 预览/源码切换 -->
      <div v-if="hasViewMode && viewMode" class="flex items-center gap-0.5 mr-2">
        <Button
          :variant="currentMode === 'preview' ? 'primary' : 'text'"
          size="small"
          class="!px-2 !py-1"
          @click="setPreview"
        >
          <Eye class="w-3.5 h-3.5 mr-1" />
          预览
        </Button>
        <Button
          :variant="currentMode === 'source' ? 'primary' : 'text'"
          size="small"
          class="!px-2 !py-1"
          @click="setSource"
        >
          <Code class="w-3.5 h-3.5 mr-1" />
          源码
        </Button>
      </div>

      <!-- 修改历史（仅文本文件显示） -->
      <Button
        v-if="editable"
        variant="text"
        size="small"
        @click="openHistory"
        class="!w-8 !h-8"
        v-tooltip.bottom="'修改历史'"
      >
        <History class="w-4 h-4" />
      </Button>

      <!-- 新窗口打开（仅 HTML 文件显示） -->
      <Button
        v-if="isHtml"
        variant="text"
        size="small"
        @click="openInNewWindow"
        class="!w-8 !h-8"
        v-tooltip.bottom="'新窗口打开'"
      >
        <ExternalLink class="w-4 h-4" />
      </Button>

      <!-- 运行按钮（仅 JavaScript 文件显示） -->
      <Button
        v-if="isJavaScript"
        variant="text"
        size="small"
        @click="handleRun"
        :disabled="running"
        class="!w-8 !h-8"
        v-tooltip.bottom="'运行代码'"
      >
        <Play v-if="!running" class="w-4 h-4" />
        <div v-else class="w-4 h-4 animate-spin border-2 border-current border-t-transparent rounded-full" />
      </Button>

      <!-- 复制按钮（仅代码渲染器显示） -->
      <Button
        v-if="showCopyButton"
        variant="text"
        size="small"
        @click="handleCopy"
        class="!w-8 !h-8"
        v-tooltip.bottom="copiedState ? '已复制' : '复制代码'"
      >
        <Check v-if="copiedState" class="w-4 h-4 text-green-500" />
        <Copy v-else class="w-4 h-4" />
      </Button>

      <!-- 下载 -->
      <Button
        variant="text"
        size="small"
        @click="downloadFile"
        class="!w-8 !h-8"
        v-tooltip.bottom="'下载'"
      >
        <Download class="w-4 h-4" />
      </Button>

      <!-- 下载长图（仅 Markdown 预览模式显示） -->
      <Button
        v-if="isMarkdown && currentMode === 'preview' && downloadLongImage"
        variant="text"
        size="small"
        @click="handleDownloadLongImage"
        class="!w-8 !h-8"
        v-tooltip.bottom="'下载长图'"
      >
        <ImageDown class="w-4 h-4" />
      </Button>

      <!-- 缩放控制 -->
      <template v-if="zoomLevel">
        <div class="flex items-center gap-0 mx-1">
          <Button
            variant="text"
            size="small"
            @click="zoomOut"
            class="!w-7 !h-8"
            v-tooltip.bottom="'缩小'"
          >
            <ZoomOut class="w-3.5 h-3.5" />
          </Button>
          <span class="text-xs text-[var(--text-2)] min-w-[3rem] text-center select-none tabular-nums">
            {{ zoomPercent }}
          </span>
          <Button
            variant="text"
            size="small"
            @click="zoomIn"
            class="!w-7 !h-8"
            v-tooltip.bottom="'放大'"
          >
            <ZoomIn class="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="text"
            size="small"
            @click="zoomReset"
            class="!w-7 !h-8"
            v-tooltip.bottom="'重置缩放'"
          >
            <RotateCcw class="w-3 h-3" />
          </Button>
        </div>
      </template>

      <!-- 全屏 -->
      <Button
        variant="text"
        size="small"
        @click="handleMaximize"
        class="!w-8 !h-8"
        v-tooltip.bottom="maximized ? '还原' : '全屏'"
      >
        <Minimize2 v-if="maximized" class="w-4 h-4" />
        <Maximize2 v-else class="w-4 h-4" />
      </Button>
      
      <!-- 关闭 -->
      <Button
        variant="text"
        size="small"
        @click="handleClose"
        class="!w-8 !h-8"
        v-tooltip.bottom="'关闭'"
      >
        <X class="w-4 h-4" />
      </Button>
    </div>
  </div>

  <!-- 运行结果对话框 -->
  <Dialog
    v-model:visible="showResult"
    modal
    header="运行结果"
    :style="{ width: '600px' }"
    :dismissableMask="false"
    :closeOnEscape="false"
  >
    <div v-if="runError" class="text-red-500">
      <p class="font-medium mb-2">运行出错：</p>
      <pre class="bg-red-50 p-3 rounded text-sm overflow-auto max-h-96">{{ runError }}</pre>
    </div>
    <div v-else class="text-green-600">
      <p class="font-medium mb-2">运行成功：</p>
      <pre v-if="runResult !== null" class="bg-green-50 p-3 rounded text-sm overflow-auto max-h-96">{{ JSON.stringify(runResult, null, 2) }}</pre>
      <pre v-else class="bg-green-50 p-3 rounded text-sm overflow-auto max-h-96">运行成功</pre>
    </div>
    <template #footer>
      <Button label="关闭" @click="showResult = false" variant="text" />
    </template>
  </Dialog>
</template>
