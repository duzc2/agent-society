<script setup lang="ts">
/**
 * 图片渲染器
 * 
 * 支持格式：PNG, JPG, GIF, WebP, SVG, BMP, ICO 等
 * 支持功能：缩放、旋转、全屏预览、拖拽
 * 
 * @module components/file-viewer/renderers/ImageRenderer
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ZoomIn, ZoomOut, RotateCcw, AlertCircle, X } from 'lucide-vue-next';
import Button from 'primevue/button';
import { fileViewerService } from '../services/fileViewerService';
import type { RendererProps } from '../types';

const props = defineProps<RendererProps>();

// 状态
const scale = ref(1);
const rotation = ref(0);
const imageUrl = ref<string>('');
const loading = ref(true);
const error = ref<string | null>(null);

// 全屏预览状态
const isFullscreen = ref(false);

// 拖拽状态
const isDragging = ref(false);
const position = ref({ x: 0, y: 0 });
const dragStart = ref({ x: 0, y: 0 });
const positionStart = ref({ x: 0, y: 0 });

/**
 * 初始化图片
 */
onMounted(() => {
  // 直接使用原始文件 URL
  imageUrl.value = fileViewerService.getRawFileUrl(props.workspaceId, props.filePath);
  loading.value = false;
});

/**
 * 打开全屏预览
 */
const openFullscreen = () => {
  isFullscreen.value = true;
  // 重置缩放和位置
  reset();
};

/**
 * 关闭全屏预览
 */
const closeFullscreen = () => {
  isFullscreen.value = false;
  reset();
};

/**
 * 缩放
 */
const zoom = (delta: number) => {
  const newScale = scale.value + delta;
  if (newScale >= 0.1 && newScale <= 5) {
    scale.value = newScale;
  }
};

/**
 * 旋转
 */
const rotate = () => {
  rotation.value = (rotation.value + 90) % 360;
};

/**
 * 重置
 */
const reset = () => {
  scale.value = 1;
  rotation.value = 0;
  position.value = { x: 0, y: 0 };
};

/**
 * 获取图片样式（普通模式）
 */
const imageStyle = computed(() => ({
  transform: `scale(${scale.value}) rotate(${rotation.value}deg)`,
  transition: 'transform 0.2s ease',
  maxWidth: '100%',
  maxHeight: '100%'
}));

/**
 * 获取图片样式（全屏模式）
 */
const fullscreenImageStyle = computed(() => ({
  transform: `translate(${position.value.x}px, ${position.value.y}px) scale(${scale.value}) rotate(${rotation.value}deg)`,
  transition: isDragging.value ? 'none' : 'transform 0.2s ease',
  cursor: isDragging.value ? 'grabbing' : 'grab',
  maxWidth: '90vw',
  maxHeight: '90vh'
}));

// ============ 拖拽处理 ============

/**
 * 鼠标按下 - 开始拖拽
 */
const onMouseDown = (e: MouseEvent) => {
  // 只有左键可以拖拽
  if (e.button !== 0) return;
  
  isDragging.value = true;
  dragStart.value = { x: e.clientX, y: e.clientY };
  positionStart.value = { ...position.value };
  
  // 添加全局事件监听
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};

/**
 * 鼠标移动 - 拖拽中
 */
const onMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  
  const deltaX = e.clientX - dragStart.value.x;
  const deltaY = e.clientY - dragStart.value.y;
  
  position.value = {
    x: positionStart.value.x + deltaX,
    y: positionStart.value.y + deltaY
  };
};

/**
 * 鼠标释放 - 结束拖拽
 */
const onMouseUp = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
};

/**
 * 滚轮缩放
 */
const onWheel = (e: WheelEvent) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  zoom(delta);
};

/**
 * 组件卸载时清理事件监听
 */
onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});
</script>

<template>
  <div class="image-renderer flex flex-col h-full bg-[var(--bg)] relative">
    <!-- 悬浮工具栏 -->
    <div class="absolute bottom-4 right-4 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--surface-1)]/90 backdrop-blur shadow-lg border border-[var(--border)]">
      <Button variant="text" size="small" v-tooltip.bottom="'缩小'" @click="zoom(-0.2)">
        <ZoomOut class="w-4 h-4" />
      </Button>
      <span class="text-xs text-[var(--text-3)] min-w-[50px] text-center">
        {{ Math.round(scale * 100) }}%
      </span>
      <Button variant="text" size="small" v-tooltip.bottom="'放大'" @click="zoom(0.2)">
        <ZoomIn class="w-4 h-4" />
      </Button>
      <div class="w-px h-3 bg-[var(--border)] mx-1" />
      <Button variant="text" size="small" v-tooltip.bottom="'旋转'" @click="rotate">
        <RotateCcw class="w-4 h-4" />
      </Button>
      <Button variant="text" size="small" v-tooltip.bottom="'重置'" @click="reset">
        <span class="text-xs">重置</span>
      </Button>
    </div>

    <!-- 图片显示区域 -->
    <div class="flex-1 overflow-auto flex items-center justify-center p-4">
      <div v-if="loading" class="flex items-center justify-center">
        <div class="animate-spin w-8 h-8 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
      </div>
      
      <div v-else-if="error" class="flex flex-col items-center text-[var(--text-3)]">
        <AlertCircle class="w-12 h-12 mb-2" />
        <p class="text-sm">{{ error }}</p>
      </div>
      
      <img
        v-else
        :src="imageUrl"
        :alt="fileName"
        class="object-contain cursor-zoom-in"
        :style="imageStyle"
        @load="loading = false"
        @error="error = '图片加载失败'"
        @click="openFullscreen"
      />
    </div>

    <!-- 全屏预览遮罩层 -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="isFullscreen"
          class="fixed inset-0 z-[9999] bg-black/95 flex items-center justify-center"
          @click.self="closeFullscreen"
          @wheel.prevent="onWheel"
        >
          <!-- 关闭按钮 -->
          <button
            class="absolute top-4 right-4 z-50 w-10 h-10 flex items-center justify-center rounded-full bg-white text-gray-800 hover:bg-gray-100 shadow-lg border border-gray-200 transition-all"
            @click="closeFullscreen"
          >
            <X class="w-5 h-5" />
          </button>

          <!-- 全屏工具栏 -->
          <div class="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur shadow-lg border border-white/20">
            <Button variant="text" size="small" class="text-white/80 hover:text-white" @click="zoom(-0.2)">
              <ZoomOut class="w-5 h-5" />
            </Button>
            <span class="text-sm text-white/80 min-w-[60px] text-center">
              {{ Math.round(scale * 100) }}%
            </span>
            <Button variant="text" size="small" class="text-white/80 hover:text-white" @click="zoom(0.2)">
              <ZoomIn class="w-5 h-5" />
            </Button>
            <div class="w-px h-4 bg-white/30 mx-1" />
            <Button variant="text" size="small" class="text-white/80 hover:text-white" @click="rotate">
              <RotateCcw class="w-5 h-5" />
            </Button>
            <Button variant="text" size="small" class="text-white/80 hover:text-white" @click="reset">
              <span class="text-sm">重置</span>
            </Button>
          </div>

          <!-- 提示文字 -->
          <div class="absolute top-4 left-1/2 -translate-x-1/2 text-white/50 text-sm pointer-events-none">
            滚轮缩放 · 拖拽移动 · 点击空白关闭
          </div>

          <!-- 全屏图片 -->
          <img
            :src="imageUrl"
            :alt="fileName"
            class="object-contain select-none"
            :style="fullscreenImageStyle"
            @mousedown.prevent="onMouseDown"
          />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.image-renderer {
  width: 100%;
  height: 100%;
}

img {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
