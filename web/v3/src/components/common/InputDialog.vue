<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';

interface InputDialogProps {
  visible: boolean;
  title?: string;
  message?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  inputType?: 'text' | 'path';
}

const props = withDefaults(defineProps<InputDialogProps>(), {
  title: '输入',
  message: '',
  inputLabel: '输入内容',
  inputPlaceholder: '',
  defaultValue: '',
  confirmLabel: '确定',
  cancelLabel: '取消',
  loading: false,
  inputType: 'text'
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'confirm', payload: { value: string }): void;
  (event: 'cancel'): void;
}>();

const inputValue = ref('');

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
});

/**
 * 重置表单。
 * 每次关闭弹窗后都恢复默认状态。
 */
const resetForm = () => {
  inputValue.value = '';
};

watch(() => props.visible, (visible) => {
  if (visible) {
    inputValue.value = props.defaultValue;
  }
});

watch(() => props.defaultValue, (newVal) => {
  if (props.visible) {
    inputValue.value = newVal;
  }
});

/**
 * 关闭弹窗。
 */
const handleClose = () => {
  if (props.loading) {
    return;
  }
  emit('cancel');
  emit('update:visible', false);
  resetForm();
};

/**
 * 提交输入内容。
 */
const handleSubmit = () => {
  if (props.loading || !inputValue.value.trim()) {
    return;
  }
  emit('confirm', { value: inputValue.value.trim() });
};
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    :header="title"
    :closable="!loading"
    :closeOnEscape="false"
    :dismissableMask="!loading"
    class="w-[28rem] max-w-[92vw]"
    @hide="resetForm"
  >
    <div class="flex flex-col gap-4">
      <div v-if="message" class="text-sm text-[var(--text-2)]">
        {{ message }}
      </div>
      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-[var(--text-1)]" for="input-dialog-value">{{ inputLabel }}</label>
        <InputText
          id="input-dialog-value"
          v-model="inputValue"
          :placeholder="inputPlaceholder"
          :disabled="loading"
          :class="inputType === 'path' ? 'font-mono text-xs' : ''"
          @keydown.enter.prevent="handleSubmit"
        />
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <Button
          :label="cancelLabel"
          severity="secondary"
          text
          :disabled="loading"
          @click="handleClose"
        />
        <Button
          :label="confirmLabel"
          :loading="loading"
          :disabled="!inputValue.trim()"
          @click="handleSubmit"
        />
      </div>
    </template>
  </Dialog>
</template>
