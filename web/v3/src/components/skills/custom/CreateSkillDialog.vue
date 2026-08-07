<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';

interface CreateSkillDialogProps {
  visible: boolean;
  creating?: boolean;
}

const props = withDefaults(defineProps<CreateSkillDialogProps>(), {
  creating: false
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
 * 每次关闭弹窗后都恢复默认状态，避免保留上一次输入污染下一次操作。
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
 * 创建过程中禁止关闭。
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
 */
const handleSubmit = () => {
  if (props.creating) {
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
    header="创建自定义技能"
    :closable="!creating"
    :closeOnEscape="false"
    :dismissableMask="!creating"
    class="w-[28rem] max-w-[92vw]"
    @hide="resetForm"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <label class="text-sm font-medium text-[var(--text-1)]" for="skill-display-name">技能名称</label>
        <InputText
          id="skill-display-name"
          v-model="displayName"
          autocomplete="off"
          placeholder="可留空，使用默认名称"
          :disabled="creating"
          @keydown.enter.prevent="handleSubmit"
        />
      </div>
      <div class="text-xs text-[var(--text-3)]">留空将使用系统默认名称。</div>
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
          @click="handleSubmit"
        />
      </div>
    </template>
  </Dialog>
</template>