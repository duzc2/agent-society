import type { useDialog } from 'primevue/usedialog';
import { ZIndex } from '@primeuix/utils';
import { createDragEndHandler } from '../../utils/dialogBounds';
import SkillManagerDialog from './SkillManagerDialog.vue';

let skillManagerInstance: any = null;

/**
 * 清理单例引用。
 */
function cleanup(): void {
  skillManagerInstance = null;
}

/**
 * 查找技能管理窗口对应的对话框元素。
 */
function findDialogElement(): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index] as HTMLElement;
    if (dialog.getAttribute('data-skill-manager') === 'true') {
      return dialog;
    }
  }
  return null;
}

/**
 * 将技能管理窗口提升到最前。
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
 * 打开技能管理窗口。
 * 这是全局单例窗口，重复打开时仅提升层级并居中。
 * @param dialog PrimeVue 动态对话框服务
 * @param data 可选窗口初始化数据
 * @returns 对话框实例
 */
export function openSkillManagerWindow(dialog: ReturnType<typeof useDialog>, data: Record<string, any> = {}): any {
  if (skillManagerInstance) {
    bringToFront();
    const dialogElement = findDialogElement();
    if (dialogElement) {
      centerWindow(dialogElement);
    }
    return skillManagerInstance;
  }

  skillManagerInstance = dialog.open(SkillManagerDialog, {
    props: {
      header: '技能管理',
      style: {
        width: '1100px',
        maxWidth: '95vw',
        height: '760px'
      },
      modal: false,
      dismissableMask: false,
      closeOnEscape: false,
      maximizable: true,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
      pt: {
        content: {
          class: ['overflow-hidden', 'p-0']
        }
      }
    } as any,
    data,
    onClose: cleanup
  });

  setTimeout(() => {
    const dialogElement = document.querySelector('.p-dialog:last-of-type') as HTMLElement | null;
    if (dialogElement) {
      dialogElement.setAttribute('data-skill-manager', 'true');
    }
  }, 50);

  return skillManagerInstance;
}
