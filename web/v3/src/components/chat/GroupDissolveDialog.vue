<script setup lang="ts">
/**
 * 解散群聊确认对话框。
 * 解散后群进入归档（已解散）区，仅可查阅历史消息，不可恢复。
 */
import { ref, inject } from 'vue';
import Button from 'primevue/button';
import { apiService } from '../../services/api';
import { refreshGroupAfterMutation } from './groupDialogs';

// ---- dialog data (markRaw'd by manager, so no unwrapping) ----
const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const groupId: string = data.groupId;
const groupName: string = data.groupName;

const loading = ref(false);
const error = ref('');

async function submit() {
  loading.value = true;
  error.value = '';
  try {
    await apiService.dissolveGroup(groupId);
    await refreshGroupAfterMutation(groupId);
    dialogRef?.value?.close?.();
  } catch (e: any) {
    console.error('[GroupDissolveDialog] 解散群失败', {
      groupId,
      message: e?.message,
      stack: e?.stack
    });
    error.value = e?.message || '解散失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 py-2">
    <p class="text-sm text-[var(--text-2)] leading-relaxed">
      确定要解散群聊 <span class="font-medium text-[var(--text-1)]">{{ groupName }}</span> 吗？
    </p>
    <p class="text-xs text-[var(--text-3)] leading-relaxed">
      解散后群将移入"已解散"归档区，所有成员退出群聊，历史消息仍可随时查阅。此操作不可恢复。
    </p>
    <div v-if="error" class="text-xs text-red-500">{{ error }}</div>
  </div>
  <!-- DynamicDialog 内容组件无 footer 槽位，按钮放 body 底部 -->
  <div class="flex items-center justify-end gap-2 pt-3">
    <Button label="取消" variant="text" @click="dialogRef?.value?.close?.()" />
    <Button
      label="解散群聊"
      class="!bg-red-500 !border-red-500 !text-white"
      :disabled="loading"
      :loading="loading"
      @click="submit"
    />
  </div>
</template>
