<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import {
  DEFAULT_TEXT_FILE_TYPE_OPTION,
  TEXT_FILE_TYPE_OPTIONS,
  buildCreateFileName,
  hasWorkspaceEntryNameConflict,
  validateCreateFileBaseName
} from './createTextFileUtils';
import type { TextFileTypeOption } from './createTextFileUtils';

interface CreateTextFileDialogProps {
  visible: boolean;
  creating?: boolean;
  currentDirectoryPath?: string;
  existingNames?: string[];
}

const props = withDefaults(defineProps<CreateTextFileDialogProps>(), {
  creating: false,
  currentDirectoryPath: '',
  existingNames: () => []
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'confirm', payload: { baseName: string; typeOption: TextFileTypeOption }): void;
}>();

const baseName = ref('');
const selectedExtension = ref(DEFAULT_TEXT_FILE_TYPE_OPTION.extension);

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
});

const selectedTypeOption = computed<TextFileTypeOption>(() => {
  return TEXT_FILE_TYPE_OPTIONS.find((option) => option.extension === selectedExtension.value)
    || DEFAULT_TEXT_FILE_TYPE_OPTION;
});

const validationMessage = computed(() => {
  return validateCreateFileBaseName(baseName.value);
});

const previewFilename = computed(() => {
  if (validationMessage.value) {
    return '';
  }
  return buildCreateFileName(baseName.value, selectedTypeOption.value.extension);
});

const duplicateMessage = computed(() => {
  if (!previewFilename.value) {
    return '';
  }

  if (!hasWorkspaceEntryNameConflict(props.existingNames, previewFilename.value)) {
    return '';
  }

  return '当前目录已存在同名文件或文件夹，请重新输入名称';
});

const inputMessage = computed(() => {
  return validationMessage.value || duplicateMessage.value;
});

/**
 * 重置创建文件表单。
 * 每次关闭弹窗后都恢复默认状态，避免保留上一次输入污染下一次操作。
 */
const resetForm = () => {
  baseName.value = '';
  selectedExtension.value = DEFAULT_TEXT_FILE_TYPE_OPTION.extension;
};

watch(() => props.visible, (visible) => {
  if (visible) {
    resetForm();
  }
});

/**
 * 关闭弹窗。
 * 创建过程中禁止关闭，避免用户误以为请求已取消但后台仍在写文件。
 */
const handleClose = () => {
  if (props.creating) {
    return;
  }

  visibleModel.value = false;
  resetForm();
};

/**
 * 提交创建请求。
 * 只把经过校验的文件名主体和选中的文件类型向父组件上报，由父组件负责调用上传接口。
 */
const handleSubmit = () => {
  const errorMessage = validateCreateFileBaseName(baseName.value);
  if (errorMessage || duplicateMessage.value || props.creating) {
    return;
  }

  emit('confirm', {
    baseName: baseName.value.trim(),
    typeOption: selectedTypeOption.value
  });
};
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    header="新建文本文件"
    :closable="!creating"
    :closeOnEscape="false"
    :dismissableMask="!creating"
    class="w-[28rem] max-w-[92vw]"
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
        <label class="text-sm font-medium text-[var(--text-1)]" for="artifact-create-file-name">文件名</label>
        <InputText
          id="artifact-create-file-name"
          v-model="baseName"
          autocomplete="off"
          placeholder="请输入文件名，不含后缀"
          :disabled="creating"
          @keydown.enter.prevent="handleSubmit"
        />
      </div>

      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-[var(--text-1)]" for="artifact-create-file-type">文件类型</label>
        <select
          id="artifact-create-file-type"
          v-model="selectedExtension"
          class="h-10 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-1)] outline-none"
          :disabled="creating"
        >
          <option
            v-for="option in TEXT_FILE_TYPE_OPTIONS"
            :key="option.extension"
            :value="option.extension"
          >
            {{ option.label }} (.{{ option.extension }}) - {{ option.description }}
          </option>
        </select>
      </div>

      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
        <div class="text-xs text-[var(--text-3)]">文件后缀</div>
        <div class="mt-1 text-sm text-[var(--text-1)]">.{{ selectedTypeOption.extension }}</div>
      </div>

      <div v-if="previewFilename" class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
        <div class="text-xs text-[var(--text-3)]">最终文件名</div>
        <div class="mt-1 break-all text-sm text-[var(--text-1)]">{{ previewFilename }}</div>
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
