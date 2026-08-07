<script setup lang="ts">
/**
 * 命令确认对话框（V3 桌面端）
 *
 * 当 AI 尝试执行不在白名单也不在黑名单中的命令时，
 * 通过心跳框架推送 cmd_confirm 消息，弹出此对话框让用户决定。
 *
 * @author Agent Society
 */
import { ref, watch } from 'vue';
import { Terminal, ShieldAlert } from 'lucide-vue-next';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Dialog from 'primevue/dialog';
import { cmdConfirmState, confirmCommand, denyCommand } from '../../services/cmdConfirmService';

const rememberChoice = ref(false);
const matchPattern = ref('');

watch(() => cmdConfirmState.value.visible, (visible) => {
  if (!visible) {
    rememberChoice.value = false;
  } else {
    matchPattern.value = cmdConfirmState.value.pending?.payload?.matchPattern ?? '';
  }
});

const handleConfirm = () => {
  confirmCommand(rememberChoice.value, matchPattern.value);
};

const handleDeny = () => {
  denyCommand(rememberChoice.value, matchPattern.value);
};
</script>

<template>
  <Dialog
    v-model:visible="cmdConfirmState.visible"
    :modal="true"
    :draggable="true"
    :closable="false"
    :pt="{
      root: { style: 'width: 420px; max-width: 92vw' }
    }"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <ShieldAlert class="w-4 h-4 text-amber-500" />
        <span class="font-semibold">命令执行确认</span>
      </div>
    </template>

    <!-- 内容 -->
    <div class="space-y-4">
      <!-- 身份信息 -->
      <div class="identity-info">
        <div class="text-xs text-[var(--text-2)]">
          组织：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.pending?.payload?.orgName || cmdConfirmState.pending?.payload?.headAgentName || '(未设置)' }}</span>
        </div>
        <div v-if="cmdConfirmState.pending?.payload?.headAgentName" class="text-xs text-[var(--text-2)]">
          负责人：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.pending.payload.headAgentName }}</span>
        </div>
        <div class="text-xs text-[var(--text-2)]">
          智能体：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.pending?.payload?.agentName }}</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <Terminal class="w-4 h-4 text-[var(--text-2)]" />
        <span class="text-xs text-[var(--text-2)]">AI 请求执行以下命令：</span>
      </div>

      <div class="cmd-preview">
        <code class="text-sm font-mono text-[var(--text-1)] break-all">
          {{ cmdConfirmState.pending?.payload?.command ?? '' }}
          <span v-if="cmdConfirmState.pending?.payload?.args?.length">
            {{ cmdConfirmState.pending.payload.args.join(' ') }}
          </span>
        </code>
      </div>

      <div v-if="cmdConfirmState.pending?.payload?.cwd" class="text-xs text-[var(--text-2)]">
        工作目录: <code class="text-[var(--text-1)]">{{ cmdConfirmState.pending.payload.cwd }}</code>
      </div>

      <!-- 意图说明（必选参数，始终存在） -->
      <div class="intent-info">
        <div class="text-xs text-[var(--text-2)] mb-1">执行意图：</div>
        <div class="text-sm text-[var(--text-1)] leading-relaxed">{{ cmdConfirmState.pending?.payload?.intent }}</div>
      </div>

      <div class="flex items-start gap-2">
        <Checkbox v-model="rememberChoice" binary input-id="remember-choice" />
        <div>
          <label for="remember-choice" class="text-xs text-[var(--text-2)] cursor-pointer select-none">
            记住此选择，后续匹配的命令将自动放行或拒绝
          </label>
          <div
            v-if="rememberChoice"
            class="mt-2 p-2.5 rounded-md bg-[var(--surface-3)] border border-[var(--border)]"
          >
            <p class="text-[10px] text-[var(--text-3)] mb-1">存入策略的匹配串：</p>
            <input
              v-model="matchPattern"
              type="text"
              class="w-full px-2 py-1 text-xs font-mono text-[var(--text-1)] bg-[var(--surface-1)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--primary)]"
            />
            <p class="text-[10px] text-[var(--text-3)] mt-1.5 leading-relaxed">
              匹配的命令将不再弹出确认。支持 <code class="text-[var(--text-2)]">*</code> 通配符（如 <code class="text-[var(--text-2)]">git*</code> 匹配所有 git 命令）。
            </p>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button label="拒绝执行" severity="danger" size="small" outlined @click="handleDeny" />
        <Button label="允许执行" size="small" @click="handleConfirm" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.identity-info {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.intent-info {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.cmd-preview {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
}
</style>
