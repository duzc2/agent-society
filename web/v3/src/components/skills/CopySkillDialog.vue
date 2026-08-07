<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';

interface CopySkillDialogProps {
  visible: boolean;
  sourceSkillName: string;
  copying?: boolean;
}

const props = withDefaults(defineProps<CopySkillDialogProps>(), {
  copying: false
});

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'confirm', payload: { displayName: string }): void;
}>();

const displayName = ref('');

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value)
});

/**
 * 重置表单。
 */
const resetForm = () => {
  displayName.value = '';
};

watch(() => props.visible, (visible) => {
  if (visible) {
    resetForm();
  }
});

/**
 * 关闭弹窗。
 */
const handleClose = () => {
  if (props.copying) {
    return;
  }
  visibleModel.value = false;
  resetForm();
};

/**
 * 提交复制请求。
 */
const handleSubmit = () => {
  if (props.copying) {
    return;
  }
  emit('confirm', { displayName: displayName.value.trim() });
  visibleModel.value = false;
  resetForm();
};
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    header="复制技能"
    :closable="!copying"
    :closeOnEscape="false"
    :dismissableMask="!copying"
    class="w-[28rem] max-w-[92vw]"
    @hide="resetForm"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-[var(--text-1)]" for="skill-display-name">新技能名称</label>
        <InputText
          id="skill-display-name"
          v-model="displayName"
          autocomplete="off"
          placeholder="留空将使用默认名称"
          :disabled="copying"
          @keydown.enter.prevent="handleSubmit"
        />
      </div>
      <div class="text-xs text-[var(--text-3)]">
        复制自：{{ sourceSkillName }}。留空将使用"{{ sourceSkillName }} 的副本"作为默认名称。
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <Button
          label="取消"
          severity="secondary"
          text
          :disabled="copying"
          @click="handleClose"
        />
        <Button
          label="复制"
          :loading="copying"
          @click="handleSubmit"
        />
      </div>
    </template>
  </Dialog>
</template>
