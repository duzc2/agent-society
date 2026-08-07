/**
 * 文件查看器模块入口
 * 
 * 自己管理已打开的文件窗口，确保同一文件不会重复打开
 * 
 * @module components/file-viewer
 */

import type { useDialog } from 'primevue/usedialog';
import { h, ref, markRaw, type InjectionKey, type Ref } from 'vue';
import FileViewer from './FileViewer.vue';
import FileViewerHeader from './FileViewerHeader.vue';
import { fileViewerService } from './services/fileViewerService';
import type { FileViewerOptions } from './types';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { ZIndex } from '@primeuix/utils';

// 提供 viewMode 的 key
export const ViewModeKey: InjectionKey<Ref<'preview' | 'source'>> = Symbol('viewMode');

// 提供 copyFunction 的 key
export const CopyFunctionKey: InjectionKey<Ref<{ copy: () => void; copied: { value: boolean } } | null>> = Symbol('copyFunction');

/**
 * 打开文件查看器的选项
 */
export interface OpenFileViewerOptions {
  dialog: ReturnType<typeof useDialog>;
  workspaceId: string;
  filePath: string;
  options?: FileViewerOptions;
  width?: string;
  height?: string;
  maximized?: boolean;
}

// 自己管理已打开的文件窗口
const openedFiles = new Map<string, any>();

/**
 * 查找指定 filePath 的对话框元素
 */
function findDialogElement(filePath: string): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (const dialog of dialogs) {
    if (dialog.getAttribute('data-file-path') === filePath) {
      return dialog as HTMLElement;
    }
  }
  return null;
}

/**
 * 将窗口提升到最前面
 * 使用 PrimeVue 的 ZIndex 工具
 */
function bringToFront(filePath: string): void {
  // 找到对话框元素
  const dialogElement = findDialogElement(filePath);
  if (!dialogElement) return;
  
  // 找到 mask 元素（在 dialog 的父元素中）
  const maskElement = dialogElement.closest('.p-dialog-mask') as HTMLElement;
  
  // 使用 ZIndex.set 将 mask 置顶（如果存在）
  if (maskElement) {
    ZIndex.set('modal', maskElement, 1000);
  }
  
  // 同时设置 dialog 容器的 z-index
  dialogElement.style.zIndex = String(ZIndex.getCurrent('modal') + 10);
}

/**
 * 将指定窗口移到屏幕中央
 */
function centerWindow(dialogElement: HTMLElement): void {
  if (!dialogElement) return;

  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const newLeft = (viewportWidth - rect.width) / 2;
  const newTop = (viewportHeight - rect.height) / 2;

  const clampedLeft = Math.max(0, Math.min(newLeft, viewportWidth - rect.width));
  const clampedTop = Math.max(0, Math.min(newTop, viewportHeight - rect.height));

  dialogElement.style.left = `${clampedLeft}px`;
  dialogElement.style.top = `${clampedTop}px`;
}

/**
 * 打开文件查看器（每个文件唯一）
 */
export async function openFileViewer(params: OpenFileViewerOptions) {
  const {
    dialog,
    workspaceId,
    filePath,
    options,
    width = '80vw',
    height = '75vh',
    maximized = false
  } = params;

  if (!dialog) {
    throw new Error('openFileViewer requires a dialog instance');
  }

  // 检查是否已存在该文件的查看器
  if (openedFiles.has(filePath)) {
    // 已存在，提升到最前面、移到中央并返回
    bringToFront(filePath);
    const dialogElement = findDialogElement(filePath);
    if (dialogElement) {
      centerWindow(dialogElement);
    }
    return openedFiles.get(filePath);
  }

  const fileName = filePath.split('/').pop() || filePath;

  // 先获取文件信息
  let fileInfo: { mimeType?: string; size?: number; hasViewMode?: boolean } = {};
  try {
    const content = await fileViewerService.getFile(workspaceId, filePath);
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    fileInfo = {
      mimeType: content.mimeType,
      size: content.size,
      hasViewMode: content.mimeType === 'text/markdown' ||
                   content.mimeType === 'text/html' ||
                   ext === 'md' ||
                   ext === 'html' ||
                   ext === 'htm'
    };
  } catch {
    // 获取失败也继续打开
  }

  // 创建新窗口
  const dialogInstance = createFileViewerDialog(dialog, workspaceId, filePath, fileName, fileInfo, options, width, height, maximized);
  
  // 记录已打开的文件
  openedFiles.set(filePath, dialogInstance);
  
  // 包装 close 方法，在关闭时清理记录
  const originalClose = dialogInstance.close.bind(dialogInstance);
  dialogInstance.close = (...args: any[]) => {
    openedFiles.delete(filePath);
    return originalClose(...args);
  };
  
  return dialogInstance;
}

/**
 * 创建文件查看器对话框
 */
function createFileViewerDialog(
  dialog: ReturnType<typeof useDialog>,
  workspaceId: string,
  filePath: string,
  fileName: string,
  fileInfo: { mimeType?: string; size?: number; hasViewMode?: boolean },
  options?: FileViewerOptions,
  width = '80vw',
  height = '75vh',
  maximized = false
) {
  // 创建共享的 viewMode
  const viewMode = ref<'preview' | 'source'>('preview');

  // 创建共享的复制功能对象
  const copyFunction = ref<{ copy: () => void; copied: { value: boolean } } | null>(null);

  // 创建共享的获取文件内容函数
  const getFileContent = ref<(() => string) | null>(null);

  // 创建共享的下载长图函数
  const downloadLongImage = ref<(() => void) | null>(null);

  // 创建共享的缩放级别
  const zoomLevel = ref(1);

  // 创建共享的编辑状态
  const isEditing = ref(false);
  const isEditable = ref(false);
  const triggerSave = ref<(() => void) | null>(null);

  // 保存原始尺寸，用于还原
  const originalSize = {
    width: maximized ? width : width,
    height: maximized ? height : height,
    maxWidth: '100vw',
    maxHeight: '100vh'
  };

  const dialogInstance = dialog.open(FileViewer, {
    props: {
      header: '', // 使用自定义 header
      style: {
        width: maximized ? '100vw' : width,
        height: maximized ? '100vh' : height,
        maxWidth: '100vw',
        maxHeight: '100vh'
      },
      modal: false,
      dismissableMask: false,
      closable: false,
      closeOnEscape: false,
      maximizable: false,
      resizable: true,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
      pt: {
        root: ({ state }: any) => ({
          class: [
            state.maximized ? '!w-screen !h-screen !max-w-none !m-0' : ''
          ],
          'data-file-path': filePath
        }),
        header: {
          class: ['hidden'] // 隐藏默认 header，使用自定义
        },
        content: ({ state }: any) => ({
          class: [
            'overflow-hidden p-0',
            state.maximized ? '!w-full !h-[calc(100vh-3rem)]' : ''
          ]
        })
      }
    } as any,
    data: {
      workspaceId,
      filePath,
      fileName,
      viewMode, // 共享的 viewMode
      copyFunction, // 共享的复制功能
      getFileContent, // 共享的获取文件内容函数
      mimeType: fileInfo.mimeType,
      size: fileInfo.size,
      hasViewMode: fileInfo.hasViewMode,
      isEditing,
      isEditable,
      triggerSave,
      // 使用 markRaw 包装 refs，防止被 reactive 自动解包，确保子组件能拿到原始 Ref
      refs: markRaw({
        isEditing,
        isEditable,
        triggerSave,
        viewMode,
        zoomLevel
      }),
      downloadLongImage,
      zoomLevel,
      options
    },
    templates: {
      // 使用自定义 header
      header: (dialogProps: any) => {
        console.log('[index.ts] header called, dialogProps:', dialogProps);

        // 从 dialog 实例获取最新的数据
        const instance = dialogProps?.instance;
        const data = instance?.data;
        
        // 优先从 refs 获取原始 Ref，因为 data 中的属性可能已被解包
        const refs = data?.refs || {};
        const sharedViewMode = refs.viewMode || data?.viewMode || viewMode;
        const sharedIsEditing = refs.isEditing || data?.isEditing || isEditing;
        const sharedIsEditable = refs.isEditable || data?.isEditable || isEditable;
        const sharedTriggerSave = refs.triggerSave || data?.triggerSave || triggerSave;

        // 创建控制方法
        const handleMaximize = () => {
          console.log('[index.ts] === handleMaximize ===');

          // 找到最新的 dialog（最后创建的）
          const allDialogs = Array.from(document.querySelectorAll('.p-dialog')) as HTMLElement[];
          console.log('[index.ts] 找到', allDialogs.length, '个 dialog');

          // 最后创建的 dialog 应该就是我们的文件查看器
          const targetDialog = allDialogs[allDialogs.length - 1];
          console.log('[index.ts] targetDialog:', targetDialog);

          if (targetDialog) {
            // 获取计算后的实际宽度来判断是否最大化
            const computedStyle = window.getComputedStyle(targetDialog);
            const actualWidth = computedStyle.width;
            const viewportWidth = window.innerWidth;
            // 如果实际宽度接近视口宽度（允许5px误差），则认为是最大化状态
            const isMaximized = Math.abs(parseFloat(actualWidth) - viewportWidth) < 5;

            console.log('[index.ts] 实际宽度:', actualWidth, ', 视口宽度:', viewportWidth, ', 是否最大化:', isMaximized);

            if (isMaximized) {
              // 还原
              console.log('[index.ts] 还原到原始尺寸:', originalSize);
              targetDialog.classList.remove('maximized');
              targetDialog.style.width = originalSize.width;
              targetDialog.style.height = originalSize.height;
              targetDialog.style.maxWidth = originalSize.maxWidth;
              targetDialog.style.maxHeight = originalSize.maxHeight;
              targetDialog.style.margin = '';
            } else {
              // 最大化
              console.log('[index.ts] 最大化 dialog');
              targetDialog.classList.add('maximized');
              targetDialog.style.width = '100vw';
              targetDialog.style.height = '100vh';
              targetDialog.style.maxWidth = '100vw';
              targetDialog.style.maxHeight = '100vh';
              targetDialog.style.margin = '0';
              targetDialog.style.top = '0';
              targetDialog.style.left = '0';
            }
          } else {
            console.error('[index.ts] 无法找到 dialog 元素');
          }
        };

        const handleClose = () => {
          console.log('[index.ts] handleClose called, dialogInstance:', dialogInstance);

          const instance = dialogInstance as any;
          if (typeof instance?.close === 'function') {
            instance.close();
          } else if (typeof dialogProps?.close === 'function') {
            dialogProps.close();
          } else {
            console.error('[index.ts] 无法找到 close 方法');
          }
        };

        console.log('[index.ts] Rendering FileViewerHeader, copyFunction:', copyFunction);
        return h(FileViewerHeader, {
          fileName,
          workspaceId,
          filePath,
          mimeType: fileInfo.mimeType,
          size: fileInfo.size,
          hasViewMode: fileInfo.hasViewMode,
          viewMode: sharedViewMode,
          copyFunction: copyFunction,
          getFileContent: getFileContent,
          downloadLongImage: downloadLongImage,
          maximized: dialogProps?.state?.maximized,
          isEditing: sharedIsEditing,
          isEditable: sharedIsEditable,
          onEdit: () => { 
            console.log('[index.ts] onEdit called');
            sharedIsEditing.value = true; 
          },
          onSave: () => { 
            console.log('[index.ts] onSave called');
            sharedTriggerSave.value?.(); 
          },
          onCancelEdit: () => { 
            console.log('[index.ts] onCancelEdit called');
            sharedIsEditing.value = false; 
          },
          onMaximize: handleMaximize,
          onClose: handleClose,
          zoomLevel: zoomLevel
        });
      }
    }
  });

  return dialogInstance;
}

export { default as FileViewer } from './FileViewer.vue';
export { fileViewerService } from './services/fileViewerService';
export { mimeTypeRegistry } from './mimeTypeRegistry';
export type { 
  FileContent, 
  FileViewerOptions, 
  RendererProps, 
  FileInfo,
  WorkspaceFilesResponse,
  MimeTypeHandler 
} from './types';
