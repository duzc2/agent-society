/**
 * 群成员管理对话框管理器（拉人 / 踢人 / 解散）
 *
 * 使用 PrimeVue DynamicDialog 打开一次性对话框。
 * 与 agentFilesDialog 不同，群聊为单活跃群场景，无需 Map 多例追踪——每次打开都是新实例。
 *
 * @module components/chat/groupDialogs
 */

import { markRaw } from 'vue';
import type { useDialog } from 'primevue/usedialog';
import GroupInviteDialog from './GroupInviteDialog.vue';
import GroupKickDialog from './GroupKickDialog.vue';
import GroupDissolveDialog from './GroupDissolveDialog.vue';
import { apiService } from '../../services/api';
import { useChatStore } from '../../stores/chat';

/**
 * 打开拉人对话框。
 * @param dialog   PrimeVue useDialog() 实例
 * @param groupId  群 ID
 */
export function openGroupInviteDialog(dialog: ReturnType<typeof useDialog>, groupId: string) {
  dialog.open(GroupInviteDialog, {
    props: {
      header: '拉人进群',
      style: { width: '520px', maxWidth: '90vw' },
      modal: true,
      closable: true
    },
    data: markRaw({ groupId }),
    onClose: () => {}
  });
}

/**
 * 打开踢人对话框。
 * @param dialog   PrimeVue useDialog() 实例
 * @param groupId  群 ID
 */
export function openGroupKickDialog(dialog: ReturnType<typeof useDialog>, groupId: string) {
  dialog.open(GroupKickDialog, {
    props: {
      header: '移出成员',
      style: { width: '520px', maxWidth: '90vw' },
      modal: true,
      closable: true
    },
    data: markRaw({ groupId }),
    onClose: () => {}
  });
}

/**
 * 打开解散确认对话框。
 * @param dialog     PrimeVue useDialog() 实例
 * @param groupId    群 ID
 * @param groupName  群名（用于确认文案）
 */
export function openGroupDissolveDialog(
  dialog: ReturnType<typeof useDialog>,
  groupId: string,
  groupName: string
) {
  dialog.open(GroupDissolveDialog, {
    props: {
      header: '解散群聊',
      style: { width: '440px', maxWidth: '90vw' },
      modal: true,
      closable: true
    },
    data: markRaw({ groupId, groupName }),
    onClose: () => {}
  });
}

/**
 * 群成员变更后的本地同步（拉人/踢人/解散成功后调用）。
 * 心跳 group_event 也会推送刷新，这里做双保险：立即同步列表、元信息与消息。
 * @param groupId 群 ID
 */
export async function refreshGroupAfterMutation(groupId: string) {
  const chatStore = useChatStore();
  await chatStore.fetchGroupList();
  try {
    const info: any = await apiService.getGroupInfo(groupId);
    if (info && !info.error) {
      chatStore.groupMetaCache[groupId] = info;
    }
  } catch (err: any) {
    console.error('[groupDialogs] 刷新群信息失败', {
      groupId,
      message: err?.message,
      stack: err?.stack
    });
  }
  await chatStore.fetchGroupMessages(groupId);
}
