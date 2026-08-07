import type { useDialog } from 'primevue/usedialog';
import { ZIndex } from '@primeuix/utils';
import { createDragEndHandler } from '../../../utils/dialogBounds';
import CustomSkillEditorDialog from './CustomSkillEditorDialog.vue';

const editorWindows = new Map<string, any>();

/**
 * 查找指定技能对应的窗口元素。
 * @param skillId 技能标识
 */
function findDialogElement(skillId: string): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index] as HTMLElement;
    if (dialog.getAttribute('data-custom-skill-id') === skillId) {
      return dialog;
    }
  }
  return null;
}

/**
 * 提升窗口层级。
 * @param skillId 技能标识
 */
function bringToFront(skillId: string): void {
  const dialogElement = findDialogElement(skillId);
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
 * 打开或聚焦自定义技能编辑窗口。
 * @param dialog PrimeVue 对话框服务
 * @param options 初始化参数
 */
export function openCustomSkillEditorWindow(
  dialog: ReturnType<typeof useDialog>,
  options: { skillId: string; sourceContext: string }
): any {
  const existing = editorWindows.get(options.skillId);
  if (existing) {
    bringToFront(options.skillId);
    return existing;
  }

  const instance = dialog.open(CustomSkillEditorDialog, {
    props: {
      header: '自定义技能编辑',
      style: {
        width: '1280px',
        maxWidth: '96vw',
        height: '820px'
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
    data: options,
    onClose: () => {
      editorWindows.delete(options.skillId);
    }
  });

  editorWindows.set(options.skillId, instance);
  setTimeout(() => {
    const dialogElement = document.querySelector('.p-dialog:last-of-type') as HTMLElement | null;
    if (dialogElement) {
      dialogElement.setAttribute('data-custom-skill-id', options.skillId);
    }
  }, 50);

  return instance;
}
