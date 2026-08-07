/**
 * 文件属性对话框管理器
 *
 * 使用 PrimeVue DynamicDialog 创建多例对话框，每个文件拥有独立的属性窗口实例。
 * 模仿 agentFilesDialog.ts 的 Map 追踪模式。
 *
 * @module components/artifacts/fileMetaDialog
 */

import { markRaw } from 'vue';
import type { useDialog } from 'primevue/usedialog';
import FileMetaDialog from './FileMetaDialog.vue';
import { ZIndex } from '@primeuix/utils';

interface FileDialogState {
  dialogRef: any;
}

/** 按 filePath 追踪所有已打开的对话框 */
const openDialogs = new Map<string, FileDialogState>();

/**
 * 将指定 filePath 的对话框提升到最前面
 */
function bringToFront(filePath: string): void {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (const dialog of dialogs) {
    if (dialog.getAttribute('data-file-meta') === filePath) {
      const mask = (dialog as HTMLElement).closest('.p-dialog-mask') as HTMLElement;
      if (mask) {
        ZIndex.set('modal', mask, 1000);
      }
      (dialog as HTMLElement).style.zIndex = String(ZIndex.getCurrent('modal') + 10);
      break;
    }
  }
}

/**
 * 打开指定文件的属性对话框
 *
 * - 如果该文件的对话框已打开，则将其提升到最前面
 * - 否则创建新对话框并自动加载文件元数据
 *
 * @param dialog    PrimeVue useDialog() 实例
 * @param workspaceId 工作区 ID
 * @param filePath    文件路径
 * @param fileName    文件名（用于标题）
 */
export function openFileMetaDialog(
  dialog: ReturnType<typeof useDialog>,
  workspaceId: string,
  filePath: string,
  fileName: string
) {
  const existing = openDialogs.get(filePath);
  if (existing?.dialogRef) {
    bringToFront(filePath);
    return;
  }

  const dialogRef = dialog.open(FileMetaDialog, {
    props: {
      header: `${fileName} 属性`,
      style: { width: '600px', maxWidth: '90vw' },
      modal: false,
      closable: true,
      pt: {
        root: { 'data-file-meta': filePath }
      }
    },
    data: markRaw({
      workspaceId,
      filePath
    }),
    onClose: () => {
      openDialogs.delete(filePath);
    }
  });

  openDialogs.set(filePath, { dialogRef });
  return dialogRef;
}
