/**
 * 智能体命令历史对话框管理器
 *
 * 使用 PrimeVue DynamicDialog 创建多例对话框，每个智能体拥有独立的命令历史窗口实例。
 * 模仿 agentFilesDialog.ts 的 Map 追踪模式。
 *
 * @module components/chat/agentCommandsDialog
 */

import { markRaw } from 'vue';
import type { useDialog } from 'primevue/usedialog';
import AgentCommandsDialog from './AgentCommandsDialog.vue';
import { ZIndex } from '@primeuix/utils';

interface AgentDialogState {
  refreshSignal: { value: number };
  dialogRef: any;
}

/** 按 agentId 追踪所有已打开的对话框 */
const openDialogs = new Map<string, AgentDialogState>();

/**
 * 将指定 agentId 的对话框提升到最前面
 */
function bringToFront(agentId: string): void {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (const dialog of dialogs) {
    if (dialog.getAttribute('data-agent-commands') === agentId) {
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
 * 打开指定智能体的命令历史对话框
 *
 * - 如果该智能体的对话框已打开，则将其提升到最前面
 * - 否则创建新对话框并自动加载命令历史
 *
 * @param dialog   PrimeVue useDialog() 实例
 * @param agentId  智能体 ID
 * @param agentName 智能体名称（用于标题）
 */
export function openAgentCommandsDialog(
  dialog: ReturnType<typeof useDialog>,
  agentId: string,
  agentName: string
) {
  const existing = openDialogs.get(agentId);
  if (existing?.dialogRef) {
    bringToFront(agentId);
    return;
  }

  const refreshSignal = markRaw({ value: 0 });

  const dialogRef = dialog.open(AgentCommandsDialog, {
    props: {
      header: `${agentName} 的命令历史`,
      style: { width: '960px', maxWidth: '94vw', height: '76vh', maxHeight: '92vh' },
      modal: true,
      closable: true,
      pt: {
        root: { class: 'agent-commands-dialog', 'data-agent-commands': agentId }
      }
    },
    data: markRaw({
      agentId,
      agentName,
      refreshSignal
    }),
    onClose: () => {
      openDialogs.delete(agentId);
    }
  });

  openDialogs.set(agentId, { refreshSignal, dialogRef });
  return dialogRef;
}

/**
 * 通知指定智能体的命令历史对话框刷新数据
 *
 * 应在智能体执行新命令后调用，确保对话框内容保持最新。
 * 如果该智能体的对话框未打开，则忽略。
 *
 * @param agentId 智能体 ID
 */
export function refreshAgentCommands(agentId: string) {
  const state = openDialogs.get(agentId);
  if (state) {
    state.refreshSignal.value++;
  }
}