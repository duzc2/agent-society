/**
 * 智能体文件列表对话框管理器
 *
 * 使用 PrimeVue DynamicDialog 创建多例对话框，每个智能体拥有独立的文件列表窗口实例。
 * 模仿 file-viewer/index.ts 的 Map 追踪模式。
 *
 * @module components/chat/agentFilesDialog
 */

import { markRaw } from 'vue';
import type { useDialog } from 'primevue/usedialog';
import AgentFilesDialog from './AgentFilesDialog.vue';
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
    if (dialog.getAttribute('data-agent-files') === agentId) {
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
 * 打开指定智能体的文件列表对话框
 *
 * - 如果该智能体的对话框已打开，则将其提升到最前面
 * - 否则创建新对话框并自动加载文件列表
 *
 * @param dialog   PrimeVue useDialog() 实例
 * @param orgId    组织 ID
 * @param agentId  智能体 ID
 * @param agentName 智能体名称（用于标题）
 */
export function openAgentFilesDialog(
  dialog: ReturnType<typeof useDialog>,
  orgId: string,
  agentId: string,
  agentName: string
) {
  const existing = openDialogs.get(agentId);
  if (existing?.dialogRef) {
    bringToFront(agentId);
    return;
  }

  const refreshSignal = markRaw({ value: 0 });

  const dialogRef = dialog.open(AgentFilesDialog, {
    props: {
      header: `${agentName} 修改的文件`,
      style: { width: '600px', maxWidth: '90vw' },
      modal: true,
      closable: true,
      pt: {
        root: { 'data-agent-files': agentId }
      }
    },
    data: markRaw({
      orgId,
      agentId,
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
 * 通知指定智能体的文件列表对话框刷新数据
 *
 * 应在智能体产生新消息（回复）时调用，确保对话框内容保持最新。
 * 如果该智能体的对话框未打开，则忽略。
 *
 * @param agentId 智能体 ID
 */
export function refreshAgentFiles(agentId: string) {
  const state = openDialogs.get(agentId);
  if (state) {
    state.refreshSignal.value++;
  }
}
