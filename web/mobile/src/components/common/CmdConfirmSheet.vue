<script setup lang="ts">
/**
 * 命令确认面板（移动端底部弹出）
 *
 * 当 AI 尝试执行不在白名单也不在黑名单中的命令时，
 * 通过心跳框架推送 cmd_confirm 消息，弹出此面板让用户决定。
 *
 * @author Agent Society
 */
import { cmdConfirmState, confirmCommand, denyCommand, toggleRemember } from '../../services/cmdConfirmService';
</script>

<template>
  <Teleport to="body">
    <div
      v-if="cmdConfirmState.visible"
      class="sheet-overlay"
      @click="denyCommand"
    >
      <div class="sheet-content" @click.stop>
        <!-- 标题 -->
        <div class="flex items-center gap-2 mb-3">
          <span class="text-amber-500 text-lg">&#9888;</span>
          <h3 class="text-base font-semibold text-[var(--text-1)]">命令执行确认</h3>
        </div>

        <!-- 身份信息 -->
        <div class="identity-info mb-3">
          <div class="text-xs text-[var(--text-2)]">
            组织：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.payload?.orgName || cmdConfirmState.payload?.headAgentName || '(未设置)' }}</span>
          </div>
          <div v-if="cmdConfirmState.payload?.headAgentName" class="text-xs text-[var(--text-2)]">
            负责人：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.payload.headAgentName }}</span>
          </div>
          <div class="text-xs text-[var(--text-2)]">
            智能体：<span class="text-[var(--text-1)] font-medium">{{ cmdConfirmState.payload?.agentName }}</span>
          </div>
        </div>

        <!-- 命令预览 -->
        <div class="cmd-preview mb-3">
          <code class="text-sm font-mono text-[var(--text-1)] break-all">
            {{ cmdConfirmState.payload?.command ?? '' }}
            <span v-if="cmdConfirmState.payload?.args?.length">
              {{ cmdConfirmState.payload.args.join(' ') }}
            </span>
          </code>
        </div>

        <!-- 工作目录 -->
        <div
          v-if="cmdConfirmState.payload?.cwd"
          class="text-xs text-[var(--text-2)] mb-3"
        >
          工作目录: {{ cmdConfirmState.payload.cwd }}
        </div>

        <!-- 意图说明（必选参数，始终存在） -->
        <div class="intent-info mb-4">
          <div class="text-xs text-[var(--text-2)] mb-1">执行意图：</div>
          <div class="text-sm text-[var(--text-1)] leading-relaxed">{{ cmdConfirmState.payload?.intent }}</div>
        </div>

        <!-- 记住选择 -->
        <div class="mb-4">
          <label
            class="flex items-center gap-2 cursor-pointer select-none"
            @click="toggleRemember"
          >
            <div
              class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
              :class="cmdConfirmState.rememberChoice
                ? 'bg-[var(--primary)] border-[var(--primary)]'
                : 'border-[var(--border)]'"
            >
              <span v-if="cmdConfirmState.rememberChoice" class="text-white text-xs">&#10003;</span>
            </div>
            <span class="text-xs text-[var(--text-2)]">记住此选择</span>
          </label>
          <!-- 勾选后展示可编辑的匹配串 -->
          <div
            v-if="cmdConfirmState.rememberChoice"
            class="mt-2 p-2.5 rounded-lg bg-[var(--surface-3)] border border-[var(--border)]"
          >
            <p class="text-[10px] text-[var(--text-3)] mb-1">存入策略的匹配串：</p>
            <input
              v-model="cmdConfirmState.matchPattern"
              type="text"
              class="w-full px-2 py-1 text-xs font-mono text-[var(--text-1)] bg-[var(--surface-1)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--primary)]"
            />
            <p class="text-[10px] text-[var(--text-3)] mt-1.5 leading-relaxed">
              匹配的命令将不再弹出确认。支持 <code class="text-[var(--text-2)]">*</code> 通配符（如 <code class="text-[var(--text-2)]">git*</code> 匹配所有 git 命令）。
            </p>
          </div>
        </div>

        <!-- 按钮 -->
        <div class="flex gap-3">
          <button
            class="flex-1 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 text-sm font-medium active:scale-95 transition-transform"
            @click="denyCommand"
            type="button"
          >
            拒绝
          </button>
          <button
            class="flex-1 py-3 rounded-xl bg-[var(--primary)] text-white text-sm font-medium active:scale-95 transition-transform"
            @click="confirmCommand"
            type="button"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  animation: fadeIn 0.2s ease-out;
}

.sheet-content {
  width: 100%;
  max-width: 480px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--surface-1);
  border-radius: 16px 16px 0 0;
  padding: 20px 20px 28px;
  animation: slideUp 0.25s ease-out;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
}

.identity-info {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.intent-info {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.cmd-preview {
  padding: 10px 14px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow-x: auto;
  white-space: pre-wrap;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
