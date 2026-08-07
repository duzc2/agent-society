/**
 * 设置窗口管理
 * 
 * 管理设置对话框的单例，确保全局只有一个设置窗口
 * 
 * @module components/settings/settingsWindow
 */

import type { useDialog } from 'primevue/usedialog';
import SettingsDialog from './SettingsDialog.vue';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { ZIndex } from '@primeuix/utils';

// 设置窗口单例引用
let settingsInstance: any = null;

/**
 * 清理单例引用
 */
function cleanup(): void {
  settingsInstance = null;
}

/**
 * 查找设置对话框元素
 */
function findDialogElement(): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  // 从后往前找，找到最后一个没有 data-file-path 和 data-org-id 的（设置窗口没有这些标记）
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dialog = dialogs[i] as HTMLElement;
    if (!dialog.getAttribute('data-file-path') && !dialog.getAttribute('data-org-id')) {
      return dialog;
    }
  }
  return dialogs.length > 0 ? (dialogs[dialogs.length - 1] as HTMLElement) : null;
}

/**
 * 将窗口提升到最前面
 * 使用 PrimeVue 的 ZIndex 工具
 */
function bringToFront(): void {
  // 找到设置对话框元素
  const dialogElement = findDialogElement();
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
 * 将窗口移到屏幕中央
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
 * 打开设置窗口（全局单例）
 * @param dialog - PrimeVue 的 dialog 实例
 * @returns 对话框实例
 */
export function openSettingsWindow(dialog: ReturnType<typeof useDialog>): any {
  // 如果已存在有效实例，提升到最前面、移到中央并返回
  if (settingsInstance) {
    bringToFront();
    const dialogElement = findDialogElement();
    if (dialogElement) {
      centerWindow(dialogElement);
    }
    return settingsInstance;
  }

  // 创建新窗口 - 使用默认 header，通过 onClose 回调清理单例
  settingsInstance = dialog.open(SettingsDialog, {
    props: {
      header: '系统设置',
      style: {
        width: '900px',
      },
      modal: false,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
    } as any,
    onClose: () => {
      // Dialog 关闭时清理单例
      cleanup();
    }
  });

  return settingsInstance;
}

/**
 * 关闭设置窗口（如果存在）
 */
export function closeSettingsWindow(): void {
  if (settingsInstance) {
    try {
      settingsInstance.close();
    } catch (e) {
      // 忽略已关闭的情况
    }
    cleanup();
  }
}

/**
 * 获取当前设置窗口实例（用于检查是否已打开）
 * @returns 对话框实例或 null
 */
export function getSettingsWindow(): any {
  return settingsInstance;
}
