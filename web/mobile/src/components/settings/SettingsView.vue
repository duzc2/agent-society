<script setup lang="ts">
/**
 * 移动端系统设置页面
 * 包含：主题切换、字体大小调整
 */
import { Sun, Moon } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';

const appStore = useAppStore();
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto">
    <!-- 顶部信息条 -->
    <div class="px-4 pt-4 pb-2">
      <p class="text-xs text-[var(--text-3)]">外观展示</p>
    </div>

    <!-- 主题切换 -->
    <div class="px-4">
      <div class="flex items-center justify-between py-3 border-b border-[var(--border)]">
        <div>
          <p class="text-sm font-medium text-[var(--text-1)]">深色模式</p>
          <p class="text-xs text-[var(--text-3)]">调整应用界面的显示主题</p>
        </div>
        <button
          class="p-2 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
          @click="appStore.setTheme(appStore.theme === 'dark' ? 'light' : 'dark')"
          type="button"
        >
          <component :is="appStore.theme === 'dark' ? Sun : Moon" class="w-5 h-5" />
        </button>
      </div>
    </div>

    <!-- 字体大小 -->
    <div class="px-4">
      <div class="flex items-center justify-between py-3 border-b border-[var(--border)]">
        <div>
          <p class="text-sm font-medium text-[var(--text-1)]">字体大小</p>
          <p class="text-xs text-[var(--text-3)]">调整对话内容的文字大小</p>
        </div>
      </div>
      <div class="flex items-center gap-3 py-3">
        <span class="text-xs text-[var(--text-3)]">A</span>
        <input
          type="range"
          min="12"
          max="24"
          step="1"
          :value="appStore.chatFontSize"
          @input="(e) => appStore.setChatFontSize(Number((e.target as HTMLInputElement).value))"
          class="flex-1"
        />
        <span class="text-sm text-[var(--text-3)]">A</span>
        <span class="text-xs text-[var(--text-2)] min-w-[36px] text-right">{{ appStore.chatFontSize }}px</span>
      </div>
    </div>

    <!-- 智能体心情颜色 -->
    <div class="px-4">
      <div class="flex items-center justify-between py-3 border-b border-[var(--border)]">
        <div>
          <p class="text-sm font-medium text-[var(--text-1)]">智能体心情颜色</p>
          <p class="text-xs text-[var(--text-3)]">用 5×5 颜色网格替代通用图标</p>
        </div>
        <label class="relative inline-flex items-center cursor-pointer select-none">
          <input type="checkbox" class="sr-only peer" role="switch"
            :checked="appStore.moodColorsEnabled"
            @change="appStore.setMoodColorsEnabled(($event.target as HTMLInputElement).checked)"
          />
          <div class="w-11 h-6 bg-[var(--surface-3)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--primary-weak)] rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
          <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
        </label>
      </div>
    </div>
  </div>
</template>
