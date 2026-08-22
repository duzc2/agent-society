<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import { saveNoticeState, hideSaveNotice, type SaveNoticeItem } from '../../services/saveNoticeService';

const dismiss = (item: SaveNoticeItem) => {
  hideSaveNotice(item.id, null);
};

const handleSave = (item: SaveNoticeItem) => {
  item.saveMode = true;
};

const handleConfirm = (item: SaveNoticeItem) => {
  const filename = item.inputValue.trim();
  hideSaveNotice(item.id, filename || null);
};
</script>

<template>
  <TransitionGroup name="save-notice" tag="div" class="save-notice-container">
    <!-- 多提示：items 索引 0 为最早创建的卡片；column-reverse 布局下最早的显示在底部，
         新提示追加到列表末尾（渲染在顶部），已存在的卡片位置不变 -->
    <div v-for="item in saveNoticeState.items" :key="item.id" class="save-notice-card">
      <!-- 消息状态 -->
      <template v-if="!item.saveMode">
        <div class="save-notice-body">
          <span class="save-notice-icon">💾</span>
          <div class="save-notice-text">
            <span class="save-notice-msg">{{ item.message }}</span>
            <span v-if="item.purpose" class="save-notice-purpose" :title="item.purpose">
              目的：{{ item.purpose }}
            </span>
          </div>
        </div>
        <div class="save-notice-actions">
          <Button
            label="关闭"
            severity="secondary"
            text
            size="small"
            @click="dismiss(item)"
          />
          <Button
            label="保存"
            size="small"
            @click="handleSave(item)"
          />
        </div>
      </template>

      <!-- 文件名输入状态 -->
      <template v-else>
        <div class="save-notice-input-label">
          {{ item.message }}
          <span v-if="item.purpose" class="save-notice-purpose-inline">（目的：{{ item.purpose }}）</span>
        </div>
        <div class="save-notice-input-row">
          <InputText
            v-model="item.inputValue"
            placeholder="输入文件名（不含后缀）"
            class="save-notice-input"
            autofocus
            @keydown.enter.prevent="handleConfirm(item)"
            @keydown.escape.prevent="dismiss(item)"
          />
          <Button
            label="确定"
            size="small"
            :disabled="!item.inputValue.trim()"
            @click="handleConfirm(item)"
          />
          <Button
            label="取消"
            severity="secondary"
            text
            size="small"
            @click="dismiss(item)"
          />
        </div>
        <div class="save-notice-auto-row">
          <Checkbox v-model="item.autoLoad" binary :input-id="'save-notice-autoload-' + item.id" />
          <label :for="'save-notice-autoload-' + item.id" class="save-notice-auto-label">
            自动加载（每次刷新页面时自动执行）
          </label>
        </div>
      </template>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.save-notice-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 9999;
  pointer-events: none;
  display: flex;
  flex-direction: column-reverse; /* 最早的卡片在底部，新卡片往上堆，已有关卡位置不变 */
  gap: 10px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
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

.save-notice-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.save-notice-msg {
  font-size: 14px;
  color: var(--text-color, #333);
  line-height: 1.5;
  word-break: break-word;
}

.save-notice-purpose {
  font-size: 12px;
  color: var(--text-color-secondary, #888);
  line-height: 1.5;
  word-break: break-word;
  /* 最多两行，超出省略 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.save-notice-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.save-notice-input-label {
  font-size: 12px;
  color: var(--text-color-secondary, #888);
  line-height: 1.5;
}

.save-notice-purpose-inline {
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

.save-notice-auto-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-notice-auto-label {
  font-size: 12px;
  color: var(--text-color-secondary, #888);
  cursor: pointer;
  user-select: none;
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
