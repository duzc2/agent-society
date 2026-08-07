<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import {
  hasWorkspaceEntryNameConflict,
  validateCreateFileBaseName
} from './createTextFileUtils';

interface CreateDirectoryDialogProps {
  visible: boolean;
  creating?: boolean;
  currentDirectoryPath?: string;
  existingNames?: string[];
}

const props = withDefaults(defineProps<CreateDirectoryDialogProps>(), {
  creating: false,
  currentDirectoryPath: '',
  existingNames: () => []
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'confirm', payload: { name: string }): void;
}>();

const directoryName = ref('');

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
});

const validationMessage = computed(() => validateCreateFileBaseName(directoryName.value));

const duplicateMessage = computed(() => {
  if (validationMessage.value || !directoryName.value.trim()) {
    return '';
  }

  if (!hasWorkspaceEntryNameConflict(props.existingNames, directoryName.value)) {
    return '';
  }

  return '当前目录已存在同名文件或文件夹，请重新输入名称';
});

const inputMessage = computed(() => validationMessage.value || duplicateMessage.value);

/**
 * 重置输入表单。
 */
const resetForm = () => {
  directoryName.value = '';
};

watch(() => props.visible, (visible) => {
  if (visible) {
    resetForm();
  }
});

/**
 * 关闭对话框。
 * 创建过程中不允许关闭，避免用户误判结果状态。
 */
const handleClose = () => {
  if (props.creating) {
    return;
  }

  visibleModel.value = false;
  resetForm();
};

/**
 * 提交创建目录请求。
 */
const handleSubmit = () => {
  const errorMessage = validateCreateFileBaseName(directoryName.value);
  if (errorMessage || duplicateMessage.value || props.creating) {
    return;
  }

  emit('confirm', {
    name: directoryName.value.trim()
  });
};
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    header="新建文件夹"
    :closable="!creating"
    :closeOnEscape="false"
    :dismissableMask="!creating"
    class="w-[26rem] max-w-[92vw]"
    @hide="resetForm"
  >
    <div class="flex flex-col gap-4">
      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
        <div class="text-xs text-[var(--text-3)]">创建位置</div>
        <div class="mt-1 break-all text-sm text-[var(--text-1)]">
          {{ currentDirectoryPath || '根目录' }}
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-[var(--text-1)]" for="artifact-create-directory-name">文件夹名</label>
        <InputText
          id="artifact-create-directory-name"
          v-model="directoryName"
          autocomplete="off"
          placeholder="请输入文件夹名"
          :disabled="creating"
          @keydown.enter.prevent="handleSubmit"
        />
      </div>

      <div v-if="inputMessage" class="text-sm text-red-400">
        {{ inputMessage }}
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <Button
          label="取消"
          severity="secondary"
          text
          :disabled="creating"
          @click="handleClose"
        />
        <Button
          label="创建"
          :loading="creating"
          :disabled="Boolean(inputMessage)"
          @click="handleSubmit"
        />
      </div>
    </template>
  </Dialog>
</template>
