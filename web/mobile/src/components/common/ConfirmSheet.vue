<script setup lang="ts">
/**
 * 底部弹出确认面板
 * 复用 PrimeVue ConfirmationService（无需自定义 UI）
 * 此组件作为备用，用于需要简单确认的场景
 */
import { ref } from 'vue';

interface SheetState {
  visible: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  resolve: ((val: boolean) => void) | null;
}

const state = ref<SheetState>({
  visible: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  resolve: null
});

function show(opts: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    state.value = {
      visible: true,
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText || '确认',
      cancelText: opts.cancelText || '取消',
      resolve
    };
  });
}

function confirm() {
  state.value.resolve?.(true);
  state.value.visible = false;
}

function cancel() {
  state.value.resolve?.(false);
  state.value.visible = false;
}

defineExpose({ show });
</script>

<template>
  <Teleport to="body">
    <div v-if="state.visible" class="sheet-overlay" @click="cancel">
      <div class="sheet-content" @click.stop>
        <h3 class="text-base font-semibold text-[var(--text-1)] mb-2">{{ state.title }}</h3>
        <p class="text-sm text-[var(--text-2)] mb-4">{{ state.message }}</p>
        <div class="flex gap-3">
          <button
            class="flex-1 py-3 rounded-xl bg-[var(--surface-3)] text-[var(--text-2)] text-sm font-medium active:scale-95 transition-transform"
            @click="cancel"
            type="button"
          >
            {{ state.cancelText }}
          </button>
          <button
            class="flex-1 py-3 rounded-xl bg-[var(--primary)] text-white text-sm font-medium active:scale-95 transition-transform"
            @click="confirm"
            type="button"
          >
            {{ state.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
