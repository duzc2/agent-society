<script setup lang="ts">
/**
 * 文件内容查看器组件
 *
 * @module components/file-viewer/FileViewer
 */
import { ref, computed, onMounted, onUnmounted, shallowRef, inject, provide, toRef, toRaw, nextTick } from 'vue';
import { AlertCircle, Loader2 } from 'lucide-vue-next';
import html2canvas from 'html2canvas';
import { fileViewerService } from './services/fileViewerService';
import { mimeTypeRegistry } from './mimeTypeRegistry';
import { ViewModeKey } from './index';
import { CopyFunctionKey } from './injectionKeys';
import type { FileContent } from './types';
import TextEditor from './renderers/TextEditor.vue';

// 注入 Dialog 数据
const dialogRef = inject<any>('dialogRef');

// 获取 dialog 数据
const dialogData = dialogRef?.value?.data;

// 响应式数据
const workspaceId = ref(dialogData?.workspaceId || '');
const filePath = ref(dialogData?.filePath || '');
const fileName = ref(dialogData?.fileName || '');

// 共享状态
// 优先使用 refs 对象中的 Ref，因为它们通过 markRaw 保护，不会被解包
const refs = dialogData?.refs || {};
const isEditing = refs.isEditing || dialogData?.isEditing || ref(false);
const isEditable = refs.isEditable || dialogData?.isEditable || ref(false);
const triggerSave = refs.triggerSave || dialogData?.triggerSave || ref<(() => void) | null>(null);
const zoomLevel = refs.zoomLevel || dialogData?.zoomLevel || ref(1);

// Ctrl/Cmd + 滚轮缩放
const onWheelZoom = (e: WheelEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  const newZoom = Math.min(2.0, Math.max(0.5, zoomLevel.value + delta));
  zoomLevel.value = newZoom;
};

// 打印调试信息，确认是否获取到了正确的 Ref 对象
console.log('[FileViewer] Shared state init:', {
  hasRefs: !!dialogData?.refs,
  isEditingType: isEditing && typeof isEditing === 'object' && 'value' in isEditing ? 'Ref' : typeof isEditing,
  isEditableType: isEditable && typeof isEditable === 'object' && 'value' in isEditable ? 'Ref' : typeof isEditable,
  isEditableValue: isEditable?.value
});

// viewMode - 优先从 refs 获取，否则使用 toRef 保持引用
const viewMode = refs.viewMode || (dialogData ? toRef(dialogData, 'viewMode') : ref<'preview' | 'source'>('preview'));

// 提供给子组件
provide(ViewModeKey, viewMode);

// 复制功能状态
const copied = ref(false);

// 设置复制函数（由 CodeRenderer 调用）
const setCopyFunction = (fn: () => void) => {
  console.log('[FileViewer] setCopyFunction called, dialogData:', dialogData);
  // 使用 toRaw 获取原始对象，避免 Vue Proxy 自动解包
  if (dialogData) {
    const rawDialogData = toRaw(dialogData);
    console.log('[FileViewer] rawDialogData:', rawDialogData);
    const cf = rawDialogData?.copyFunction;
    console.log('[FileViewer] cf from rawDialogData:', cf, 'typeof cf:', typeof cf);
    if (cf && typeof cf === 'object' && 'value' in cf) {
      cf.value = {
        copy: fn,
        copied
      };
      console.log('[FileViewer] dialogData.copyFunction.value updated:', cf.value);
    } else {
      console.log('[FileViewer] cf is invalid, cf:', cf);
    }
  } else {
    console.log('[FileViewer] dialogData is null');
  }
};

// 获取文件内容的函数（供 Header 使用）
const getFileContent = () => {
  if (fileContent.value) {
    const data = fileContent.value.data;
    if (typeof data === 'string') {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(data);
    }
  }
  return '';
};

// 提供复制功能的设置方法（给 CodeRenderer 用）
provide(CopyFunctionKey, {
  setCopyFunction,
  copied
});

// Dialog 控制方法 - 提供给子组件使用
const maximized = computed(() => {
  // 尝试从 dialogRef 获取 maximized 状态
  const dialog = dialogRef?.value;
  return dialog?.maximized || dialog?.state?.maximized || false;
});

const dialogContext = {
  maximized,
  maximize: () => {
    console.log('[FileViewer] maximize called, dialogRef:', dialogRef);
    const dialog = dialogRef?.value;
    console.log('[FileViewer] dialog:', dialog);
    console.log('[FileViewer] dialog keys:', dialog ? Object.keys(dialog) : 'N/A');

    if (typeof dialog?.maximize === 'function') {
      dialog.maximize();
    } else if (typeof (dialog as any)?.toggleMaximize === 'function') {
      (dialog as any).toggleMaximize();
    } else if (dialog?.$parent) {
      console.log('[FileViewer] trying through $parent');
      const parentDialog = dialog.$parent;
      console.log('[FileViewer] parentDialog:', parentDialog);
      if (typeof (parentDialog as any)?.maximize === 'function') {
        (parentDialog as any).maximize();
      } else if (typeof (parentDialog as any)?.toggleMaximize === 'function') {
        (parentDialog as any).toggleMaximize();
      }
    }
  },
  close: () => {
    console.log('[FileViewer] close called, dialogRef:', dialogRef);
    const dialog = dialogRef?.value;

    if (typeof dialog?.close === 'function') {
      dialog.close();
    } else {
      console.error('[FileViewer] 无法找到 close 方法');
    }
  }
};

// 提供对话框控制方法
provide('dialogContext', dialogContext);

// 组件状态
const loading = ref(false);
const error = ref<string | null>(null);
const fileContent = ref<FileContent | null>(null);
const rendererComponent = shallowRef<any>(null);
const editorContent = ref('');

// 文件扩展名
const fileExtension = computed(() => {
  const path = filePath.value;
  if (!path) return '';
  const parts = path.split('.');
  return parts.length > 1 ? parts.pop()?.toLowerCase() || '' : '';
});

/**
 * 保存文件
 */
const saveFile = async () => {
  if (!workspaceId.value || !filePath.value) return;
  
  loading.value = true;
  try {
    // 传递原始的 mimeType，避免被后端错误地修改为纯文本
    await fileViewerService.saveFile(
      workspaceId.value, 
      filePath.value, 
      editorContent.value,
      fileContent.value?.mimeType
    );
    // 更新本地内容
    if (fileContent.value) {
      fileContent.value.data = editorContent.value;
    }
    isEditing.value = false;
    // 重新加载以确保一致性
    await loadFile();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
    // 3秒后清除错误，以便用户重试
    setTimeout(() => {
      error.value = null;
      loading.value = false; // 确保 loading 状态正确
    }, 3000);
  } finally {
    // 如果没有出错（或者错误已处理），取消 loading
    if (!error.value) {
      loading.value = false;
    }
  }
};

// 注册保存触发器
if (triggerSave) {
  triggerSave.value = saveFile;
}

/**
 * 加载文件内容
 */
const loadFile = async () => {
  loading.value = true;
  error.value = null;

  if (!workspaceId.value || !filePath.value) {
    error.value = '缺少必要参数';
    loading.value = false;
    return;
  }

  try {
    const content = await fileViewerService.getFile(workspaceId.value, filePath.value);
    fileContent.value = content;
    
    // 初始化编辑器内容
    if (typeof content.data === 'string') {
      editorContent.value = content.data;
      // 只有文本内容可编辑
      // 强制所有字符串类型的内容都可编辑，包括 Markdown 和代码文件
      if (isEditable) isEditable.value = true;
    } else {
      if (isEditable) isEditable.value = false;
    }

    const renderer = mimeTypeRegistry.getRenderer(content.mimeType, fileExtension.value);
    rendererComponent.value = renderer;

    // 更新 dialogData 中的 getFileContent 函数
    if (dialogData) {
      const rawDialogData = toRaw(dialogData);
      const gfc = rawDialogData?.getFileContent;
      if (gfc && typeof gfc === 'object' && 'value' in gfc) {
        gfc.value = getFileContent;
      }
    }

    // 设置下载长图函数
    setupDownloadLongImage();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载文件失败';
  } finally {
    loading.value = false;
  }
};

// 组件挂载时加载文件并注册滚轮缩放
onMounted(() => {
  document.addEventListener('wheel', onWheelZoom, { passive: false });
  loadFile();
});

onUnmounted(() => {
  document.removeEventListener('wheel', onWheelZoom);
});

/**
 * 处理打开文件请求（来自 Markdown 内部链接）
 * 创建新的文件查看器打开目标文件
 * @param path 文件路径（可能是相对路径）
 */
const handleOpenFile = (path: string) => {
  console.log('[FileViewer] handleOpenFile:', path, 'current filePath:', filePath.value);

  // 解析相对路径为绝对路径
  let resolvedPath = path;

  // 如果是相对路径，基于当前文件路径解析
  if (!path.startsWith('/') && !path.startsWith('http://') && !path.startsWith('https://')) {
    const currentDir = filePath.value.includes('/')
      ? filePath.value.substring(0, filePath.value.lastIndexOf('/') + 1)
      : '';
    resolvedPath = normalizePath(currentDir + path);
    console.log('[FileViewer] resolvedPath:', resolvedPath);
  }

  // 使用 fileViewerService 创建新的文件查看器
  fileViewerService.openFile({
    workspaceId: workspaceId.value,
    filePath: resolvedPath,
    fileName: resolvedPath.split('/').pop() || resolvedPath
  });
};

/**
 * 规范化路径（处理 . 和 ..）
 */
const normalizePath = (path: string): string => {
  const parts = path.split('/');
  const result: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result.join('/');
};

/**
 * 设置下载长图功能
 * 仅在 Markdown 文件时注册
 */
const setupDownloadLongImage = () => {
  const mime = fileContent.value?.mimeType || '';
  const ext = fileExtension.value;
  const isMd = mime === 'text/markdown' || ext === 'md' || ext === 'markdown';

  if (!isMd || !dialogData) return;

  const rawDialogData = toRaw(dialogData);
  const dli = rawDialogData?.downloadLongImage;
  if (dli && typeof dli === 'object' && 'value' in dli) {
    dli.value = async () => {
      // 等待下一帧确保 DOM 渲染完成
      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 200));

      // 在当前 dialog 内查找 markdown 预览元素
      const dialogEl = document.querySelector(`[data-file-path="${filePath.value}"]`);
      const markdownBody = dialogEl?.querySelector('.markdown-body') as HTMLElement | null;

      if (!markdownBody) {
        console.error('[FileViewer] 无法找到 .markdown-body 元素');
        return;
      }

      try {
        // 从当前元素向上遍历，找到第一个有实际背景色的元素
        const getEffectiveBackground = (el: HTMLElement): string => {
          let current: HTMLElement | null = el;
          while (current) {
            const bg = getComputedStyle(current).backgroundColor;
            // 跳过透明背景 (rgba(0,0,0,0) / transparent)
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              return bg;
            }
            current = current.parentElement;
          }
          return '#ffffff';
        };

        const bgColor = getEffectiveBackground(markdownBody);
        const contentCanvas = await html2canvas(markdownBody, {
          backgroundColor: bgColor,
          scale: 2,
          useCORS: true,
          logging: false,
        });

        // 创建带 padding 的最终画布
        const padding = 60;
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = contentCanvas.width + padding * 2;
        finalCanvas.height = contentCanvas.height + padding * 2;
        const ctx = finalCanvas.getContext('2d')!;
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
        ctx.drawImage(contentCanvas, padding, padding);

        // 转换为 Blob 并触发下载
        finalCanvas.toBlob((blob) => {
          if (!blob) {
            console.error('[FileViewer] Canvas toBlob 失败');
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const baseName = fileName.value.replace(/\.(md|markdown)$/i, '');
          a.href = url;
          a.download = `${baseName}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 'image/png');
      } catch (err) {
        console.error('[FileViewer] 下载长图失败:', err);
      }
    };
  }
};
</script>

<template>
  <div class="file-viewer flex flex-col h-full bg-[var(--surface-1)] text-[var(--text-1)]">
    <!-- 内容区域 -->
    <div class="flex-1 overflow-auto relative">
      <!-- 加载状态 -->
      <div
        v-if="loading"
        class="absolute inset-0 flex flex-col items-center justify-center bg-[var(--bg)] z-50"
      >
        <Loader2 class="w-10 h-10 animate-spin text-[var(--primary)] mb-3" />
        <p class="text-sm text-[var(--text-3)]">加载中...</p>
      </div>

      <!-- 错误状态 -->
      <div
        v-else-if="error"
        class="absolute inset-0 flex flex-col items-center justify-center bg-[var(--bg)] p-8"
      >
        <AlertCircle class="w-12 h-12 text-red-500 mb-3" />
        <p class="text-sm text-[var(--text-1)]">{{ error }}</p>
      </div>

      <!-- 缩放包装容器 -->
      <template v-else>
        <div :style="{ zoom: zoomLevel, height: '100%' }">
          <!-- 编辑模式 -->
          <TextEditor
            v-if="isEditing"
            v-model:content="editorContent"
            :file-name="fileName"
            :file-path="filePath"
            :workspace-id="workspaceId"
            @save="saveFile"
            class="h-full"
          />

          <!-- 文件内容渲染 -->
          <component
            v-else-if="rendererComponent && fileContent"
            :is="rendererComponent"
            :content="fileContent"
            :file-name="fileName"
            :file-path="filePath"
            :workspace-id="workspaceId"
            @open-file="handleOpenFile"
            class="h-full"
          />

          <!-- 不支持的文件类型 -->
          <div
            v-else
            class="flex flex-col items-center justify-center h-full bg-[var(--bg)] p-8"
          >
            <AlertCircle class="w-12 h-12 text-[var(--text-3)] mb-3" />
            <p class="text-sm text-[var(--text-1)]">不支持的文件类型</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.file-viewer {
  width: 100%;
  height: 100%;
}
</style>
