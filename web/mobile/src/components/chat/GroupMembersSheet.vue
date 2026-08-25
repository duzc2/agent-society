<script setup lang="ts">
/**
 * 群成员面板（底部弹出）
 * 显示成员列表；user 可邀请智能体入群、解散群聊
 */
import { ref, computed } from 'vue';
import { X, UserPlus, Trash2, Check, ChevronDown, ChevronRight, Archive } from 'lucide-vue-next';
import { useConfirm } from 'primevue/useconfirm';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { apiService } from '../../services/api';
import type { GroupMeta } from '../../types';

const props = defineProps<{
  groupId: string;
  groupMeta: GroupMeta | null;
}>();

const emit = defineEmits<{
  close: [];
  invited: [];
  dissolved: [];
}>();

const appStore = useAppStore();
const agentStore = useAgentStore();
const confirm = useConfirm();

const showInvitePicker = ref(false);
const selectedIds = ref<string[]>([]);
const inviteReason = ref('由用户邀请');
const inviting = ref(false);

const memberIds = computed(() =>
  new Set((props.groupMeta?.members ?? []).map(m => m.id))
);

// 可邀请的智能体：排除 user 和已在群成员
const candidates = computed(() =>
  agentStore.agents.filter(a => a.id !== 'user' && !memberIds.value.has(a.id))
);

const statusLabel: Record<string, string> = {
  online: '在线',
  busy: '忙碌',
  offline: '离线',
  left: '已退出',
  terminated: '已终止',
};

// 在群成员 / 已退出成员分组
const activeMembers = computed(() =>
  (props.groupMeta?.members ?? []).filter(m => m.status !== 'left' && m.status !== 'terminated')
);
const exitedMembers = computed(() =>
  (props.groupMeta?.members ?? []).filter(m => m.status === 'left' || m.status === 'terminated')
);
const showExited = ref(false);

function toggleSelect(agentId: string) {
  const idx = selectedIds.value.indexOf(agentId);
  if (idx === -1) {
    selectedIds.value = [...selectedIds.value, agentId];
  } else {
    selectedIds.value = selectedIds.value.filter(id => id !== agentId);
  }
}

async function invite() {
  const ids = selectedIds.value;
  const reason = inviteReason.value.trim();
  if (ids.length === 0 || !reason || inviting.value) return;
  inviting.value = true;
  try {
    await apiService.inviteToGroup(props.groupId, ids, reason);
    selectedIds.value = [];
    showInvitePicker.value = false;
    emit('invited');
  } catch (err: any) {
    appStore.setError(err?.message || '邀请失败');
  } finally {
    inviting.value = false;
  }
}

function askDissolve() {
  confirm.require({
    message: `确定要解散群聊「${props.groupMeta?.name ?? ''}」吗？此操作不可撤销。`,
    header: '危险操作',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '解散',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await apiService.dissolveGroup(props.groupId);
        emit('dissolved');
      } catch (err: any) {
        appStore.setError(err?.message || '解散失败');
      }
    }
  });
}
</script>

<template>
  <Teleport to="body">
    <div class="sheet-overlay" @click="emit('close')">
      <div class="sheet-content" @click.stop>
        <!-- 头部 -->
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-semibold text-[var(--text-1)]">
            群成员 ({{ props.groupMeta?.memberCount ?? 0 }})
          </h3>
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-2)] transition-colors"
            @click="emit('close')"
            type="button"
            aria-label="关闭"
          >
            <X class="w-5 h-5 text-[var(--text-2)]" />
          </button>
        </div>

        <!-- 在群成员 -->
        <div class="space-y-1 mb-4">
          <p
            v-if="activeMembers.length === 0"
            class="text-xs text-[var(--text-3)] px-3 py-2"
          >
            暂无成员信息
          </p>
          <div
            v-for="m in activeMembers"
            :key="m.id"
            class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)]"
          >
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="m.status === 'online'
                ? 'bg-green-500'
                : m.status === 'busy' ? 'bg-amber-500' : 'bg-[var(--text-4)]'"
            />
            <span class="text-sm text-[var(--text-1)] truncate">{{ m.name }}</span>
            <span class="ml-auto text-xs text-[var(--text-3)] shrink-0">
              {{ statusLabel[m.status] ?? m.status }}
            </span>
          </div>
        </div>

        <!-- 已退出成员（归档折叠） -->
        <div v-if="exitedMembers.length > 0" class="mb-4 border-t border-[var(--border)] pt-2">
          <button
            class="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-3)] active:bg-[var(--surface-2)] rounded-lg transition-colors"
            @click="showExited = !showExited"
            type="button"
          >
            <component :is="showExited ? ChevronDown : ChevronRight" class="w-3.5 h-3.5 flex-shrink-0" />
            <Archive class="w-3.5 h-3.5 flex-shrink-0" />
            <span class="font-medium">已退出成员 ({{ exitedMembers.length }})</span>
          </button>

          <div v-if="showExited" class="space-y-1 mt-1">
            <div
              v-for="m in exitedMembers"
              :key="m.id"
              class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] opacity-60"
            >
              <span class="w-2 h-2 rounded-full shrink-0 bg-[var(--text-4)]" />
              <span class="text-sm text-[var(--text-1)] truncate">{{ m.name }}</span>
              <span class="ml-auto text-xs text-[var(--text-3)] shrink-0">
                {{ statusLabel[m.status] ?? m.status }}
              </span>
            </div>
          </div>
        </div>

        <!-- 操作区（已解散的群不可邀请/解散） -->
        <div v-if="(props.groupMeta?.status ?? 'active') !== 'archived'" class="flex gap-3 mb-3">
          <button
            class="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-[var(--surface-3)] text-[var(--text-2)] text-sm font-medium active:scale-95 transition-transform"
            @click="showInvitePicker = !showInvitePicker"
            type="button"
          >
            <UserPlus class="w-4 h-4" />
            邀请成员
          </button>
          <button
            class="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-red-500/10 text-red-500 text-sm font-medium active:scale-95 transition-transform"
            @click="askDissolve"
            type="button"
          >
            <Trash2 class="w-4 h-4" />
            解散群聊
          </button>
        </div>

        <!-- 邀请选择器 -->
        <div v-if="showInvitePicker" class="border-t border-[var(--border)] pt-3">
          <div class="max-h-48 overflow-y-auto space-y-1 mb-3">
            <p
              v-if="candidates.length === 0"
              class="text-xs text-[var(--text-3)] px-1 py-2"
            >
              没有可邀请的智能体
            </p>
            <button
              v-for="a in candidates"
              :key="a.id"
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left active:scale-[0.98] transition-all"
              :class="selectedIds.includes(a.id)
                ? 'bg-[var(--primary-weak)]'
                : 'bg-[var(--surface-2)]'"
              @click="toggleSelect(a.id)"
              type="button"
            >
              <span
                class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                :class="selectedIds.includes(a.id)
                  ? 'bg-[var(--primary)] border-[var(--primary)] text-white'
                  : 'border-[var(--border)]'"
              >
                <Check v-if="selectedIds.includes(a.id)" class="w-3 h-3" />
              </span>
              <span class="text-sm text-[var(--text-1)] truncate">{{ a.name }}</span>
            </button>
          </div>
          <input
            v-model="inviteReason"
            class="w-full text-sm px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-[var(--primary)] mb-3"
            placeholder="拉群原因（必填）"
          />
          <button
            class="w-full py-3 rounded-xl bg-[var(--primary)] text-white text-sm font-medium active:scale-95 transition-transform disabled:opacity-40"
            :disabled="selectedIds.length === 0 || !inviteReason.trim() || inviting"
            @click="invite"
            type="button"
          >
            {{ inviting ? '邀请中...' : `邀请 ${selectedIds.length} 位成员` }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
