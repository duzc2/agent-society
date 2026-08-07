/**
 * 错误详情窗口管理。
 *
 * 职责：
 * - 维护错误详情窗口单例，避免重复点击时打开多个相同窗口
 * - 重复打开同一错误时仅提升层级并居中
 * - 切换到其他错误分组时关闭旧窗口并打开新窗口
 *
 * @author Agent Society
 */

import type { useDialog } from 'primevue/usedialog';
import { ZIndex } from '@primeuix/utils';
import { createDragEndHandler } from '../../utils/dialogBounds';
import ErrorDetailDialog from './ErrorDetailDialog.vue';
import type { ErrorNotificationGroup } from '../../services/errorNotification';

let errorDetailInstance: any = null;
let currentGroupKey: string | null = null;

/**
 * 清理错误详情窗口单例引用。
 */
function cleanup(): void {
  errorDetailInstance = null;
  currentGroupKey = null;
}

/**
 * 查找错误详情窗口对应的对话框元素。
 * @returns 对话框根元素
 */
function findDialogElement(): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index] as HTMLElement;
    if (dialog.getAttribute('data-error-detail') === 'true') {
      return dialog;
    }
  }
  return null;
}

/**
 * 将错误详情窗口提升到最前。
 */
function bringToFront(): void {
  const dialogElement = findDialogElement();
  if (!dialogElement) {
    return;
  }

  const maskElement = dialogElement.closest('.p-dialog-mask') as HTMLElement | null;
  if (maskElement) {
    ZIndex.set('modal', maskElement, 1000);
  }
  dialogElement.style.zIndex = String(ZIndex.getCurrent('modal') + 10);
}

/**
 * 将窗口移动到视口中央。
 * @param dialogElement 对话框根元素
 */
function centerWindow(dialogElement: HTMLElement): void {
  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(0, Math.min((viewportWidth - rect.width) / 2, viewportWidth - rect.width));
  const top = Math.max(0, Math.min((viewportHeight - rect.height) / 2, viewportHeight - rect.height));
  dialogElement.style.left = `${left}px`;
  dialogElement.style.top = `${top}px`;
}

/**
 * 标记新创建的对话框元素，方便后续查找和复用。
 */
function markDialogElement(): void {
  setTimeout(() => {
    const dialogElement = document.querySelector('.p-dialog:last-of-type') as HTMLElement | null;
    if (dialogElement) {
      dialogElement.setAttribute('data-error-detail', 'true');
    }
  }, 50);
}

/**
 * 关闭当前错误详情窗口。
 */
function closeCurrentWindow(): void {
  if (!errorDetailInstance) {
    return;
  }

  try {
    errorDetailInstance.close();
  } catch {
    // 对话框已经关闭时无需额外处理。
  }
  cleanup();
}

/**
 * 打开错误详情窗口。
 * @param dialog PrimeVue 动态对话框服务
 * @param group 错误分组
 * @returns 对话框实例
 */
export function openErrorDetailWindow(
  dialog: ReturnType<typeof useDialog>,
  group: ErrorNotificationGroup
): any {
  if (errorDetailInstance && currentGroupKey === group.key) {
    bringToFront();
    const dialogElement = findDialogElement();
    if (dialogElement) {
      centerWindow(dialogElement);
    }
    return errorDetailInstance;
  }

  if (errorDetailInstance && currentGroupKey !== group.key) {
    closeCurrentWindow();
  }

  errorDetailInstance = dialog.open(ErrorDetailDialog, {
    props: {
      header: '同类错误详情',
      style: {
        width: '760px',
        maxWidth: '92vw'
      },
      modal: false,
      dismissableMask: false,
      closable: true,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: {
      group
    },
    onClose: cleanup
  });

  currentGroupKey = group.key;
  markDialogElement();
  return errorDetailInstance;
}
