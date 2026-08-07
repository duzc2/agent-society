/**
 * 文件差异窗口管理
 *
 * 职责：
 * - 维护文件差异窗口单例，同一文件只打开一个窗口
 * - 重复打开同一文件时仅提升层级并居中
 * - 切换到其他文件时关闭旧窗口并打开新窗口
 *
 * @module components/file-diff
 */

import type { useDialog } from 'primevue/usedialog';
import { ZIndex } from '@primeuix/utils';
import { createDragEndHandler } from '../../utils/dialogBounds';
import FileDiffDialog from './FileDiffDialog.vue';

let diffInstance: any = null;
let currentFileKey: string | null = null;

function cleanup(): void {
  diffInstance = null;
  currentFileKey = null;
}

function findDialogElement(): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dialog = dialogs[i] as HTMLElement;
    if (dialog.getAttribute('data-file-diff') === 'true') {
      return dialog;
    }
  }
  return null;
}

function bringToFront(): void {
  const dialogElement = findDialogElement();
  if (!dialogElement) return;

  const maskElement = dialogElement.closest('.p-dialog-mask') as HTMLElement | null;
  if (maskElement) {
    ZIndex.set('modal', maskElement, 1000);
  }
  dialogElement.style.zIndex = String(ZIndex.getCurrent('modal') + 10);
}

function centerWindow(dialogElement: HTMLElement): void {
  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(0, Math.min((viewportWidth - rect.width) / 2, viewportWidth - rect.width));
  const top = Math.max(0, Math.min((viewportHeight - rect.height) / 2, viewportHeight - rect.height));
  dialogElement.style.left = `${left}px`;
  dialogElement.style.top = `${top}px`;
}

function markDialogElement(): void {
  setTimeout(() => {
    const dialogElement = document.querySelector('.p-dialog:last-of-type') as HTMLElement | null;
    if (dialogElement) {
      dialogElement.setAttribute('data-file-diff', 'true');
    }
  }, 50);
}

function closeCurrentWindow(): void {
  if (!diffInstance) return;
  try {
    diffInstance.close();
  } catch {
    // already closed
  }
  cleanup();
}

/**
 * 打开文件差异对话框。
 *
 * 同一文件只允许打开一个 diff 窗口。重复调用时会将已有窗口提升到最前。
 *
 * @param dialog - PrimeVue DynamicDialog 实例
 * @param workspaceId - 工作区 ID
 * @param filePath - 文件相对路径
 * @returns 对话框实例
 */
export function openFileDiffDialog(
  dialog: ReturnType<typeof useDialog>,
  workspaceId: string,
  filePath: string
): any {
  const fileKey = `${workspaceId}/${filePath}`;

  // 同一文件: 提升到最前
  if (diffInstance && currentFileKey === fileKey) {
    bringToFront();
    const dialogElement = findDialogElement();
    if (dialogElement) centerWindow(dialogElement);
    return diffInstance;
  }

  // 不同文件: 关闭旧窗口
  if (diffInstance) {
    closeCurrentWindow();
  }

  diffInstance = dialog.open(FileDiffDialog, {
    props: {
      header: `修改历史 · ${filePath.split('/').pop() || filePath}`,
      style: {
        width: '80vw',
        height: '70vh',
        maxWidth: '96vw',
        maxHeight: '90vh'
      },
      modal: false,
      dismissableMask: false,
      maximizable: true,
      closable: true,
      closeOnEscape: true,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
      pt: {
        root: {
          'data-file-diff': 'true'
        },
        content: {
          class: 'overflow-hidden p-0'
        }
      }
    } as any,
    data: {
      workspaceId,
      filePath
    },
    onClose: cleanup
  });

  currentFileKey = fileKey;
  markDialogElement();
  return diffInstance;
}
