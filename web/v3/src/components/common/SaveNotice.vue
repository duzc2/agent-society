<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { saveNoticeState, hideSaveNotice } from '../../services/saveNoticeService';

const saveMode = ref(false);
const inputValue = ref('');

const dismiss = () => {
  hideSaveNotice(null);
  saveMode.value = false;
  inputValue.value = '';
};

const handleSave = () => {
  saveMode.value = true;
};

const handleConfirm = () => {
  const filename = inputValue.value.trim();
  hideSaveNotice(filename || null);
  saveMode.value = false;
  inputValue.value = '';
};

watch([() => saveNoticeState.visible, () => saveNoticeState.version], ([v]) => {
  if (v) {
    // 每次显示（或版本递增）时重置状态
    saveMode.value = false;
    inputValue.value = '';
  } else {
    saveMode.value = false;
    inputValue.value = '';
  }
});
</script>

<template>
  <Transition name="save-notice">
    <div v-if="saveNoticeState.visible" class="save-notice-container">
      <div class="save-notice-card">
        <!-- 消息状态 -->
        <template v-if="!saveMode">
          <div class="save-notice-body">
            <span class="save-notice-icon">💾</span>
            <span class="save-notice-msg">{{ saveNoticeState.message }}</span>
          </div>
          <div class="save-notice-actions">
            <Button
              label="关闭"
              severity="secondary"
              text
              size="small"
              @click="dismiss"
            />
            <Button
              label="保存"
              size="small"
              @click="handleSave"
            />
          </div>
        </template>

        <!-- 文件名输入状态 -->
        <template v-else>
          <div class="save-notice-input-label">{{ saveNoticeState.message }}</div>
          <div class="save-notice-input-row">
            <InputText
              v-model="inputValue"
              placeholder="输入文件名（不含后缀）"
              class="save-notice-input"
              autofocus
              @keydown.enter.prevent="handleConfirm"
              @keydown.escape.prevent="dismiss"
            />
            <Button
              label="确定"
              size="small"
              :disabled="!inputValue.trim()"
              @click="handleConfirm"
            />
            <Button
              label="取消"
              severity="secondary"
              text
              size="small"
              @click="dismiss"
            />
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.save-notice-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 9999;
  pointer-events: none;
}

.save-notice-card {
  pointer-events: auto;
  background: var(--surface-0, #fff);
  border-radius: 10px;
  padding: 14px 16px;
  width: 320px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.save-notice-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.save-notice-icon {
  font-size: 16px;
  line-height: 1.4;
  flex-shrink: 0;
}

.save-notice-msg {
  font-size: 14px;
  color: var(--text-color, #333);
  line-height: 1.5;
  word-break: break-word;
}

.save-notice-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.save-notice-input-label {
  font-size: 12px;
  color: var(--text-color-secondary, #888);
}

.save-notice-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.save-notice-input {
  flex: 1;
  min-width: 0;
}

.save-notice-enter-active,
.save-notice-leave-active {
  transition: all 0.2s ease;
}

.save-notice-enter-from,
.save-notice-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
