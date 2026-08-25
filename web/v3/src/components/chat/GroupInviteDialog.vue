<script setup lang="ts">
/**
 * 拉人进群对话框：多选智能体 + 必填拉群原因（后端校验 missing_reason）。
 * 已退出成员保留可选项——重新邀请会清除其退出记录。
 */
import { ref, inject, computed } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { apiService } from '../../services/api';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agent';
import { refreshGroupAfterMutation } from './groupDialogs';
import MemberPicker from '../common/MemberPicker.vue';

// ---- dialog data (markRaw'd by manager, so no unwrapping) ----
const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const groupId: string = data.groupId;

const chatStore = useChatStore();
const agentStore = useAgentStore();

const selected = ref<string[]>([]);
const reason = ref('');
const loading = ref(false);
const error = ref('');

// 候选：全部智能体，排除 user/root 与当前活跃成员；已退出成员可被重新邀请
const candidates = computed(() => {
  const meta = chatStore.groupMetaCache[groupId];
  const activeIds = new Set(
    (meta?.members ?? [])
      .filter((m: { id: string; status?: string }) =>
        m.id !== 'user' && m.id !== 'root' &&
        m.status !== 'left' && m.status !== 'terminated' && m.status !== 'kicked')
      .map((m: { id: string }) => m.id)
  );
  return agentStore.allAgents.filter(a => a.id !== 'user' && a.id !== 'root' && !activeIds.has(a.id));
});

async function submit() {
  if (selected.value.length === 0 || !reason.value.trim()) return;
  loading.value = true;
  error.value = '';
  try {
    await apiService.inviteToGroup(groupId, selected.value, reason.value.trim());
    await refreshGroupAfterMutation(groupId);
    dialogRef?.value?.close?.();
  } catch (e: any) {
    console.error('[GroupInviteDialog] 邀请成员失败', {
      groupId,
      members: selected.value,
      message: e?.message,
      stack: e?.stack
    });
    error.value = e?.message || '邀请失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 py-2">
    <MemberPicker v-model="selected" :agents="candidates" placeholder="搜索要拉入群的智能体..." />
    <InputText
      v-model="reason"
      placeholder="拉群原因（必填，将通知给所有成员）"
      class="!w-full"
      @keydown.enter="submit"
    />
    <div v-if="error" class="text-xs text-red-500">{{ error }}</div>
  </div>
  <!-- DynamicDialog 内容组件无 footer 槽位，按钮放 body 底部 -->
  <div class="flex items-center justify-end gap-2 pt-3">
    <Button label="取消" variant="text" @click="dialogRef?.value?.close?.()" />
    <Button
      label="邀请"
      class="!bg-[var(--primary)] !text-white"
      :disabled="selected.length === 0 || !reason.trim() || loading"
      :loading="loading"
      @click="submit"
    />
  </div>
</template>
