<script setup lang="ts">
/**
 * 踢人对话框：从当前活跃成员中多选移出。
 * 移出后若剩余成员不足 3 人，群将自动解散（后端 _autoDissolveIfSmall），提交前提示。
 */
import { ref, inject, computed } from 'vue';
import Button from 'primevue/button';
import { apiService } from '../../services/api';
import { useChatStore } from '../../stores/chat';
import { refreshGroupAfterMutation } from './groupDialogs';
import MemberPicker from '../common/MemberPicker.vue';

// ---- dialog data (markRaw'd by manager, so no unwrapping) ----
const dialogRef: any = inject('dialogRef');
const data = dialogRef?.value?.data || {};
const groupId: string = data.groupId;

const chatStore = useChatStore();

const selected = ref<string[]>([]);
const loading = ref(false);
const error = ref('');

// 候选：当前活跃成员（排除已退出/被踢记录）
const candidates = computed(() => {
  const meta = chatStore.groupMetaCache[groupId];
  return (meta?.members ?? [])
    .filter((m: { id: string; status?: string }) =>
      m.id !== 'user' && m.id !== 'root' &&
      m.status !== 'left' && m.status !== 'terminated' && m.status !== 'kicked')
    .map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id }));
});

// 踢出后剩余活跃成员不足 3 人 → 自动解散预警
const wouldDissolve = computed(() => candidates.value.length - selected.value.length < 3);

async function submit() {
  if (selected.value.length === 0) return;
  loading.value = true;
  error.value = '';
  try {
    // 后端路由单成员；逐成员串行，每个都有独立广播与自动解散判定
    for (const id of selected.value) {
      await apiService.removeFromGroup(groupId, id);
    }
    await refreshGroupAfterMutation(groupId);
    dialogRef?.value?.close?.();
  } catch (e: any) {
    console.error('[GroupKickDialog] 移出成员失败', {
      groupId,
      members: selected.value,
      message: e?.message,
      stack: e?.stack
    });
    error.value = e?.message || '移出失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3 py-2">
    <MemberPicker v-model="selected" :agents="candidates" placeholder="搜索要移出的成员..." />
    <div v-if="wouldDissolve" class="text-xs text-amber-500">
      踢出后群成员不足 3 人，该群将自动解散并归档
    </div>
    <div v-if="error" class="text-xs text-red-500">{{ error }}</div>
  </div>
  <!-- DynamicDialog 内容组件无 footer 槽位，按钮放 body 底部 -->
  <div class="flex items-center justify-end gap-2 pt-3">
    <Button label="取消" variant="text" @click="dialogRef?.value?.close?.()" />
    <Button
      label="移出"
      class="!bg-red-500 !border-red-500 !text-white"
      :disabled="selected.length === 0 || loading"
      :loading="loading"
      @click="submit"
    />
  </div>
</template>
