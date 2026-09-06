<script setup lang="ts">
/**
 * 模块管理窗口组件
 * 
 * 职责：
 * - 可拖拽移动的非模态窗口
 * - 左侧模块列表，右侧管理页面（iframe 嵌入）
 * - 支持最大化/还原
 * - 记忆窗口位置和尺寸
 * 
 * @author Agent Society
 */
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { apiService, type ModuleInfo } from '../../services/api';
import { 
  Puzzle, 
  X, 
  GripVertical, 
  Minus, 
  Maximize2, 
  Minimize2,
  RefreshCw
} from 'lucide-vue-next';
import Button from 'primevue/button';
import ScrollPanel from 'primevue/scrollpanel';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const modules = ref<ModuleInfo[]>([]);
const loading = ref(false);
const selectedModule = ref<ModuleInfo | null>(null);
const panelLoading = ref(false);
const iframeUrl = ref<string>('');

// 窗口状态
const windowX = ref(100);
const windowY = ref(100);
const windowWidth = ref(800);
const windowHeight = ref(600);
const isMaximized = ref(false);
const isDragging = ref(false);
const dragOffsetX = ref(0);
const dragOffsetY = ref(0);

// 记忆的位置（最大化前）
const prevX = ref(100);
const prevY = ref(100);
const prevWidth = ref(800);
const prevHeight = ref(600);

const STORAGE_KEY = 'module-window-state';

/**
 * 有管理界面的模块
 */
const modulesWithPanel = computed(() => {
  return modules.value.filter(m => m.hasWebComponent);
});

/**
 * 加载保存的窗口状态
 */
const loadWindowState = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const state = JSON.parse(saved);
      windowX.value = state.x ?? 100;
      windowY.value = state.y ?? 100;
      windowWidth.value = state.width ?? 800;
      windowHeight.value = state.height ?? 600;
    }
  } catch {
    // 忽略解析错误
  }
};

/**
 * 保存窗口状态
 */
const saveWindowState = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      x: windowX.value,
      y: windowY.value,
      width: windowWidth.value,
      height: windowHeight.value
    }));
  } catch {
    // 忽略保存错误
  }
};

/**
 * 加载模块列表
 */
const loadModules = async () => {
  loading.value = true;
  try {
    modules.value = await apiService.getModules();
    // 默认选中第一个有管理界面的模块
    if (modulesWithPanel.value.length > 0 && !selectedModule.value) {
      const firstModule = modulesWithPanel.value[0];
      if (firstModule) {
        selectModule(firstModule);
      }
    }
  } catch (err) {
    console.error('加载模块列表失败:', err);
    modules.value = [];
  } finally {
    loading.value = false;
  }
};

/**
 * 刷新当前模块
 */
const refreshCurrentModule = () => {
  if (selectedModule.value) {
    // iframe 刷新
    const iframe = document.getElementById('module-iframe') as HTMLIFrameElement;
    if (iframe) {
      iframe.src = iframe.src;
    }
  }
};

/**
 * 选中模块
 */
const selectModule = async (module: ModuleInfo) => {
  if (selectedModule.value?.name === module.name) return;
  
  selectedModule.value = module;
  panelLoading.value = true;
  
  // 构建 iframe URL - 从静态服务加载面板页面
  // 这样面板内的相对路径资源引用(panel.css, panel.js)才能正确解析
  iframeUrl.value = `/modules/${encodeURIComponent(module.name)}/web/panel.html`;
  
  panelLoading.value = false;
};

/**
 * iframe 加载完成
 */
const onIframeLoad = () => {
  panelLoading.value = false;
};

/**
 * 关闭窗口
 */
const close = () => {
  saveWindowState();
  emit('update:modelValue', false);
};

/**
 * 切换窗口显示
 */
const toggle = () => {
  emit('update:modelValue', !props.modelValue);
};

/**
 * 最大化/还原窗口
 */
const toggleMaximize = () => {
  if (isMaximized.value) {
    // 还原
    windowX.value = prevX.value;
    windowY.value = prevY.value;
    windowWidth.value = prevWidth.value;
    windowHeight.value = prevHeight.value;
    isMaximized.value = false;
  } else {
    // 保存当前状态
    prevX.value = windowX.value;
    prevY.value = windowY.value;
    prevWidth.value = windowWidth.value;
    prevHeight.value = windowHeight.value;
    // 最大化
    windowX.value = 0;
    windowY.value = 0;
    windowWidth.value = window.innerWidth;
    windowHeight.value = window.innerHeight;
    isMaximized.value = true;
  }
  saveWindowState();
};

/**
 * 最小化窗口（暂时关闭，保留状态）
 */
const minimize = () => {
  saveWindowState();
  emit('update:modelValue', false);
};

/**
 * 开始拖拽
 */
const startDrag = (e: MouseEvent) => {
  // 最大化时不可拖拽
  if (isMaximized.value) return;
  
  isDragging.value = true;
  dragOffsetX.value = e.clientX - windowX.value;
  dragOffsetY.value = e.clientY - windowY.value;
  
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', stopDrag);
};

/**
 * 拖拽中
 */
const onDrag = (e: MouseEvent) => {
  if (!isDragging.value) return;
  
  windowX.value = e.clientX - dragOffsetX.value;
  windowY.value = e.clientY - dragOffsetY.value;
  
  // 限制在视口内（保留 20px 边界）
  const maxX = window.innerWidth - 100;
  const maxY = window.innerHeight - 50;
  windowX.value = Math.max(20, Math.min(windowX.value, maxX));
  windowY.value = Math.max(20, Math.min(windowY.value, maxY));
};

/**
 * 停止拖拽
 */
const stopDrag = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
  saveWindowState();
};

/**
 * 获取模块图标
 */
const getModuleIcon = (name: string) => {
  const icons: Record<string, string> = {
    chrome: '🌐',
    ffmpeg: '🎞️',
    ssh: '🔐',
    ui_page: '📄'
  };
  return icons[name] || '📦';
};

// 监听窗口打开，加载模块和状态
watch(() => props.modelValue, (open) => {
  if (open) {
    loadWindowState();
    if (modules.value.length === 0) {
      loadModules();
    }
  }
}, { immediate: true });

// 窗口大小变化时约束位置
const handleResize = () => {
  if (isMaximized.value) {
    windowWidth.value = window.innerWidth;
    windowHeight.value = window.innerHeight;
  } else {
    const maxX = window.innerWidth - 100;
    const maxY = window.innerHeight - 50;
    windowX.value = Math.max(20, Math.min(windowX.value, maxX));
    windowY.value = Math.max(20, Math.min(windowY.value, maxY));
  }
};

onMounted(() => {
  loadModules();
  window.addEventListener('resize', handleResize);
  // 心跳派生事件（proc-event/agent-notify）转发进面板 iframe：
  // CustomEvent 不跨 iframe 边界，主窗口分发后需手动投递到 contentWindow
  window.addEventListener('proc-event', forwardEventToIframe);
  window.addEventListener('agent-notify', forwardEventToIframe);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('proc-event', forwardEventToIframe);
  window.removeEventListener('agent-notify', forwardEventToIframe);
});

/** 把主窗口心跳派生事件原样转发到当前面板 iframe */
function forwardEventToIframe(e: Event) {
  const iframe = document.getElementById('module-iframe') as HTMLIFrameElement | null;
  iframe?.contentWindow?.dispatchEvent(new CustomEvent(e.type, { detail: (e as CustomEvent).detail }));
}

defineExpose({
  toggle,
  loadModules
});
</script>

<template>
  <div>
    <!-- 窗口 -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="modelValue"
        class="fixed z-40 flex flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface-1)]"
        :class="[
          isDragging ? 'opacity-90' : '',
          isMaximized ? '' : 'shadow-2xl rounded-lg'
        ]"
        :style="{
          left: windowX + 'px',
          top: windowY + 'px',
          width: windowWidth + 'px',
          height: windowHeight + 'px'
        }"
      >
        <!-- 标题栏（可拖拽区域） -->
        <div 
          class="h-12 flex items-center justify-between px-3 border-b border-[var(--border)] bg-[var(--surface-2)] select-none"
          :class="isMaximized ? '' : 'rounded-t-lg'"
          :style="isDragging ? 'cursor: move;' : 'cursor: default;'"
          @mousedown="startDrag"
        >
          <!-- 左侧：拖拽图标 + 标题 -->
          <div class="flex items-center gap-2">
            <GripVertical class="w-4 h-4 text-[var(--text-3)]" />
            <span class="font-semibold text-sm text-[var(--text-1)]">模块管理</span>
          </div>
          
          <!-- 右侧：窗口控制按钮 -->
          <div class="flex items-center">
            <Button 
              variant="text" 
              rounded
              class="!p-1.5 !w-8 !h-8"
              v-tooltip.bottom="'最小化'"
              @click.stop="minimize"
            >
              <Minus class="w-3.5 h-3.5 text-[var(--text-3)] hover:text-[var(--text-1)]" />
            </Button>
            <Button 
              variant="text" 
              rounded
              class="!p-1.5 !w-8 !h-8"
              v-tooltip.bottom="isMaximized ? '还原' : '最大化'"
              @click.stop="toggleMaximize"
            >
              <component 
                :is="isMaximized ? Minimize2 : Maximize2" 
                class="w-3.5 h-3.5 text-[var(--text-3)] hover:text-[var(--text-1)]" 
              />
            </Button>
            <Button 
              variant="text" 
              rounded
              class="!p-1.5 !w-8 !h-8"
              v-tooltip.bottom="'关闭'"
              @click.stop="close"
            >
              <X class="w-3.5 h-3.5 text-[var(--text-3)] hover:text-[var(--text-1)]" />
            </Button>
          </div>
        </div>

        <!-- 窗口主体：左右布局 -->
        <div class="flex flex-1 overflow-hidden">
          
          <!-- 左侧：模块列表（Sidebar） -->
          <div class="w-[200px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface-2)] flex flex-col">
            <!-- 模块列表 -->
            <ScrollPanel class="flex-1" style="width: 100%;">
              <div class="p-2 space-y-1">
                <!-- 加载中 -->
                <div v-if="loading" class="flex justify-center py-4">
                  <div class="animate-spin w-5 h-5 border-2 border-[var(--primary)] border-t-transparent rounded-full"></div>
                </div>

                <!-- 空状态 -->
                <div v-else-if="modulesWithPanel.length === 0" class="text-center py-4 text-[var(--text-3)] text-xs">
                  暂无管理界面
                </div>

                <!-- 模块项 -->
                <button
                  v-for="module in modulesWithPanel"
                  :key="module.name"
                  class="w-full text-left p-3 rounded-lg transition-colors text-sm"
                  :class="[
                    selectedModule?.name === module.name 
                      ? 'bg-[var(--primary-weak)] text-[var(--primary)]' 
                      : 'text-[var(--text-2)] hover:bg-[var(--surface-3)]'
                  ]"
                  @click="selectModule(module)"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-base">{{ getModuleIcon(module.name) }}</span>
                    <span class="font-medium truncate">{{ module.name }}</span>
                  </div>
                  <p class="text-xs mt-1 truncate opacity-70 leading-tight">
                    {{ module.toolGroupDescription }}
                  </p>
                </button>
              </div>
            </ScrollPanel>
          </div>

          <!-- 右侧：管理页面（iframe） -->
          <div class="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
            <!-- 子标题栏 -->
            <div class="h-12 flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--surface-1)]">
              <span class="font-semibold text-sm text-[var(--text-1)]">
                {{ selectedModule?.name || '模块详情' }}
              </span>
              <Button 
                variant="text" 
                rounded
                class="!p-1.5"
                :loading="panelLoading"
                v-tooltip.bottom="'刷新'"
                @click="refreshCurrentModule"
              >
                <RefreshCw class="w-4 h-4 text-[var(--text-3)] hover:text-[var(--primary)]" />
              </Button>
            </div>

            <!-- iframe 内容区 -->
            <div class="flex-1 relative overflow-hidden">
              <!-- 加载中 -->
              <div v-if="panelLoading" class="absolute inset-0 flex items-center justify-center bg-[var(--surface-1)]">
                <div class="animate-spin w-8 h-8 border-2 border-[var(--primary)] border-t-transparent rounded-full"></div>
              </div>

              <!-- 空状态 -->
              <div v-else-if="!selectedModule" class="absolute inset-0 flex flex-col items-center justify-center text-[var(--text-3)]">
                <Puzzle class="w-12 h-12 mb-2 opacity-50" />
                <p class="text-sm">请选择一个模块</p>
              </div>

              <!-- iframe 嵌入模块面板 -->
              <iframe
                v-else
                id="module-iframe"
                :src="iframeUrl"
                class="w-full h-full border-0"
                @load="onIframeLoad"
              ></iframe>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
iframe {
  background: var(--surface-1);
}
</style>
