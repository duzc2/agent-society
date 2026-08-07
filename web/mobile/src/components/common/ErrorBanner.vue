<script setup lang="ts">
/**
 * 错误通知横幅（移动端）
 *
 * 两层结构：
 * - 上层：app 本地错误（单条、临时、自动消失）
 * - 下层：心跳推送的后端错误分组
 *   点击后弹出底部详情面板，查看完整错误信息并关闭。
 */
import { ref } from 'vue';
import { AlertCircle, X, ChevronRight, RefreshCw } from 'lucide-vue-next';
import { useToast } from 'primevue/usetoast';
import { useAppStore } from '../../stores/app';
import { errorGroups, errorNotificationService } from '../../services/errorNotificationService';
import type { ErrorGroup } from '../../services/errorNotificationService';
import ErrorDetailSheet from './ErrorDetailSheet.vue';

const appStore = useAppStore();
const toast = useToast();
const retryingKeys = ref<Set<string>>(new Set());

function isRetrying(key: string): boolean {
  return retryingKeys.value.has(key);
}

/** 向该错误涉及的智能体发送"继续"消息；成功时移除分组，失败保留分组 */
async function retryGroup(group: ErrorGroup) {
  if (retryingKeys.value.has(group.key)) return;
  retryingKeys.value.add(group.key);
  try {
    const result = await errorNotificationService.retryGroup(group);
    if (result.ok) {
      toast.add({ severity: 'success', summary: '已发送', detail: `已向 ${group.agentName} 发送"继续"消息`, life: 3000 });
      errorNotificationService.removeGroup(group);
    } else if (result.skipped) {
      toast.add({ severity: 'warn', summary: '无法重试', detail: '缺少有效的智能体 ID', life: 3000 });
    } else {
      toast.add({ severity: 'error', summary: '重试失败', detail: '向智能体发送继续消息失败', life: 3000 });
    }
  } finally {
    retryingKeys.value.delete(group.key);
  }
}

function categoryBadge(cat: string): string {
  switch (cat) {
    case 'auth': return '鉴权';
    case 'network': return '网络';
    case 'rate_limit': return '限流';
    case 'context_length': return '上下文';
    case 'server': return '服务端';
    default: return '错误';
  }
}

function categoryColor(cat: string): string {
  switch (cat) {
    case 'auth':
    case 'server':
      return 'bg-red-600';
    case 'network':
    case 'rate_limit':
      return 'bg-orange-600';
    default:
      return 'bg-gray-600';
  }
}
</script>

<template>
  <div v-if="appStore.errorMessage || errorGroups.length > 0" class="shrink-0">
    <!-- 本地错误（临时通知） -->
    <div
      v-if="appStore.errorMessage"
      class="px-4 py-2.5 bg-red-500 text-white text-sm flex items-center gap-2 animate-fade-in-up"
    >
      <AlertCircle class="w-4 h-4 shrink-0" />
      <span class="flex-1 truncate">{{ appStore.errorMessage }}</span>
      <button
        class="p-0.5 rounded hover:bg-white/20 transition-colors shrink-0"
        @click="appStore.clearError()"
        type="button"
        aria-label="关闭"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- 后端心跳推送的同类错误分组 -->
    <TransitionGroup name="error-item" tag="div">
      <div
        v-for="group in errorGroups"
        :key="group.key"
        :class="[
          'px-3 py-2 border-b border-white/10 text-white text-xs flex items-center gap-2',
          categoryColor(group.errorCategory),
          'cursor-pointer active:opacity-80 transition-opacity'
        ]"
      >
        <AlertCircle class="w-4 h-4 shrink-0" />
        <div class="flex-1 min-w-0" @click="errorNotificationService.openDetail(group)">
          <div class="flex items-center gap-1.5">
            <span class="font-medium truncate">{{ group.agentName }}</span>
            <span class="opacity-70 rounded px-1 py-px text-[10px] bg-white/10">{{ categoryBadge(group.errorCategory) }}</span>
            <template v-if="group.count > 1">
              <span class="opacity-50">×{{ group.count }}</span>
            </template>
          </div>
          <div class="truncate opacity-90 mt-0.5 leading-tight">{{ group.displayReason }}</div>
        </div>
        <ChevronRight class="w-4 h-4 shrink-0 opacity-50" />
        <button
          class="p-0.5 rounded hover:bg-white/20 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="isRetrying(group.key) || group.agentId === 'unknown'"
          @click.stop="retryGroup(group)"
          type="button"
          aria-label="重试"
        >
          <RefreshCw :class="['w-3.5 h-3.5', isRetrying(group.key) && 'animate-spin']" />
        </button>
        <button
          class="p-0.5 rounded hover:bg-white/20 transition-colors shrink-0"
          @click.stop="errorNotificationService.removeGroup(group)"
          type="button"
          aria-label="关闭"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>

  <!-- 错误详情底部面板 -->
  <ErrorDetailSheet />
</template>

<style scoped>
.error-item-enter-active {
  transition: all 0.25s ease-out;
}
.error-item-leave-active {
  transition: all 0.2s ease-in;
}
.error-item-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.error-item-leave-to {
  opacity: 0;
  transform: translateX(8px);
}
</style>
