import type { useDialog } from 'primevue/usedialog';
import { ZIndex } from '@primeuix/utils';
import { createDragEndHandler } from '../../utils/dialogBounds';
import SkillOverviewDialog from './SkillOverviewDialog.vue';

const overviewDialogs = new Map<string, any>();

/**
 * 查找指定技能的对话框元素。
 */
function findDialogElement(skillId: string): HTMLElement | null {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index] as HTMLElement;
    if (dialog.getAttribute('data-skill-overview') === skillId) {
      return dialog;
    }
  }
  return null;
}

/**
 * 将指定技能的对话框提升到最前。
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
 * 打开或聚焦技能配置对话框。
 * 同一技能只会显示一个对话框，再次打开会提升层级。
 */
export function openSkillOverviewDialog(
  dialog: ReturnType<typeof useDialog>,
  skillId: string
): any {
  const existing = overviewDialogs.get(skillId);
  if (existing) {
    bringToFront(skillId);
    return existing;
  }

  const instance = dialog.open(SkillOverviewDialog, {
    props: {
      style: {
        width: '900px',
        maxWidth: '95vw',
        height: '680px'
      },
      modal: true,
      closable: true,
      dismissableMask: true,
      header: '查看配置',
      onDragend: createDragEndHandler(),
      pt: {
        content: {
          class: ['overflow-hidden', 'p-0']
        }
      }
    } as any,
    data: { skillId },
    onClose: () => {
      overviewDialogs.delete(skillId);
    }
  });

  overviewDialogs.set(skillId, instance);

  setTimeout(() => {
    const dialogElement = findDialogElement(skillId);
    if (dialogElement) {
      dialogElement.setAttribute('data-skill-overview', skillId);
    }
  }, 50);

  return instance;
}
