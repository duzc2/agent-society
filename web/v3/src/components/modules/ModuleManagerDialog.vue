<script setup lang="ts">
/**
 * 模块管理对话框组件
 *
 * 职责：
 * - 显示所有模块的启用/禁用开关
 * - 左侧模块列表（全部模块），右侧管理页面（iframe 嵌入，仅对有 webComponent 的模块）
 * - "全部启用" toggle 控制所有模块开关
 *
 * @author Agent Society
 */
import { ref, onMounted, computed } from 'vue';
import { configApi, type ModuleCatalogItem } from '../../services/configApi';
import {
  Puzzle,
  RefreshCw,
  Power,
  Save,
  Loader2
} from 'lucide-vue-next';
import Button from 'primevue/button';

const loading = ref(false);
const moduleCatalog = ref<ModuleCatalogItem[]>([]);
const selectedModule = ref<ModuleCatalogItem | null>(null);
const panelLoading = ref(false);
const iframeUrl = ref<string>('');

// 模块启用状态
const enableAllModules = ref<boolean>(true);
const enabledModuleNames = ref<string[]>([]);
const originalEnableAllModules = ref<boolean>(true);
const originalEnabledModuleNames = ref<string[]>([]);

const moduleSaving = ref(false);
const moduleError = ref('');
const moduleSuccess = ref(false);

/**
 * 有管理界面的模块
 */
const modulesWithPanel = computed(() => {
  return moduleCatalog.value.filter(m => m.hasWebComponent);
});

/**
 * 是否有未保存的更改
 */
const hasModuleChanges = computed(() => {
  if (enableAllModules.value !== originalEnableAllModules.value) return true;
  if (enableAllModules.value) return false;
  const sorted = [...enabledModuleNames.value].sort();
  const orig = [...originalEnabledModuleNames.value].sort();
  return JSON.stringify(sorted) !== JSON.stringify(orig);
});

/**
 * 加载模块配置和目录
 */
const loadModules = async () => {
  loading.value = true;
  moduleError.value = '';
  try {
    const data = await configApi.getModulesConfig();
    enableAllModules.value = data.enableAll ?? true;
    enabledModuleNames.value = Array.isArray(data.enabled) ? [...data.enabled] : [];
    originalEnableAllModules.value = enableAllModules.value;
    originalEnabledModuleNames.value = [...enabledModuleNames.value];
    moduleCatalog.value = data.catalog || [];

    // 默认选中第一个有管理界面的模块
    if (modulesWithPanel.value.length > 0 && !selectedModule.value) {
      const firstModule = modulesWithPanel.value[0];
      if (firstModule) {
        selectModule(firstModule);
      }
    }
  } catch (err) {
    console.error('加载模块列表失败:', err);
    moduleError.value = err instanceof Error ? err.message : '加载模块配置失败';
    moduleCatalog.value = [];
  } finally {
    loading.value = false;
  }
};

/**
 * 选中模块
 */
const selectModule = (module: ModuleCatalogItem) => {
  if (!module.hasWebComponent) return;
  if (selectedModule.value?.name === module.name) return;

  selectedModule.value = module;
  panelLoading.value = true;
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
 * 切换单个模块
 */
const toggleModule = (item: ModuleCatalogItem, checked: boolean) => {
  if (enableAllModules.value) return;
  if (checked) {
    if (!enabledModuleNames.value.includes(item.name)) {
      enabledModuleNames.value = [...enabledModuleNames.value, item.name];
    }
  } else {
    enabledModuleNames.value = enabledModuleNames.value.filter(n => n !== item.name);
  }
  moduleSuccess.value = false;
  moduleError.value = '';
};

/**
 * 保存模块配置
 */
const saveModulesConfig = async () => {
  moduleSaving.value = true;
  moduleError.value = '';
  moduleSuccess.value = false;
  try {
    await configApi.saveModulesConfig({
      enableAll: enableAllModules.value,
      enabled: [...enabledModuleNames.value]
    });
    originalEnableAllModules.value = enableAllModules.value;
    originalEnabledModuleNames.value = [...enabledModuleNames.value];
    moduleSuccess.value = true;
    setTimeout(() => { moduleSuccess.value = false; }, 3000);
  } catch (err) {
    moduleError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    moduleSaving.value = false;
  }
};

/**
 * 重置模块配置
 */
const resetModulesConfig = () => {
  enableAllModules.value = originalEnableAllModules.value;
  enabledModuleNames.value = [...originalEnabledModuleNames.value];
  moduleSuccess.value = false;
  moduleError.value = '';
};

/**
 * 刷新当前模块 iframe
 */
const refreshCurrentModule = () => {
  if (selectedModule.value) {
    const iframe = document.getElementById('module-iframe') as HTMLIFrameElement;
    if (iframe) {
      iframe.src = iframe.src;
    }
  }
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

onMounted(() => {
  loadModules();
});
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--surface-1)]">
    <!-- 顶部：全部启用 + 提醒 + 保存/重置 -->
    <div class="border-b border-[var(--border)] bg-[var(--surface-2)]">
      <!-- 提醒条 -->
      <div v-if="moduleError" class="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">
        {{ moduleError }}
      </div>
      <div v-if="moduleSuccess" class="px-4 py-2 text-sm text-green-700 bg-green-50 border-b border-green-200">
        已保存到 modules.enabled.json，重启后生效
      </div>
      <div class="px-4 py-2 text-xs text-yellow-700 bg-yellow-50 border-b border-yellow-200">
        模块启用状态在重启后生效。
      </div>

      <!-- 全部启用 + 操作按钮 -->
      <div class="flex items-center justify-between px-4 py-3">
        <div class="flex items-center gap-3">
          <Power class="w-4 h-4 text-[var(--primary)]" />
          <span class="text-sm font-medium text-[var(--text-1)]">全部启用</span>
          <label class="relative inline-flex items-center cursor-pointer select-none">
            <input
              v-model="enableAllModules"
              type="checkbox"
              class="sr-only peer"
              aria-label="全部启用模块"
              role="switch"
              @change="moduleSuccess = false; moduleError = ''"
            />
            <div class="w-11 h-6 bg-[var(--surface-3)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--primary-weak)] rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
            <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
          </label>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="primary"
            size="small"
            :disabled="!hasModuleChanges || moduleSaving"
            :loading="moduleSaving"
            @click="saveModulesConfig"
          >
            <Save class="w-4 h-4 mr-1" />
            保存
          </Button>
          <Button
            variant="text"
            size="small"
            :disabled="!hasModuleChanges || moduleSaving"
            @click="resetModulesConfig"
          >
            重置
          </Button>
          <span v-if="hasModuleChanges" class="text-xs text-orange-500 ml-1">
            有未保存的修改
          </span>
        </div>
      </div>
    </div>

    <!-- 窗口主体：左右布局 -->
    <div class="flex flex-1 overflow-hidden">

      <!-- 左侧：全部模块列表 -->
      <div class="w-[220px] flex-shrink-0 min-h-0 border-r border-[var(--border)] bg-[var(--surface-2)] overflow-y-auto">
        <div class="p-2 space-y-1">
            <!-- 加载中 -->
            <div v-if="loading" class="flex justify-center py-4">
              <Loader2 class="w-5 h-5 animate-spin text-[var(--text-3)]" />
            </div>

            <!-- 空状态 -->
            <div v-else-if="moduleCatalog.length === 0" class="text-center py-4 text-[var(--text-3)] text-xs">
              未发现模块
            </div>

            <!-- 全部模块项 -->
            <button
              v-for="item in moduleCatalog"
              :key="item.name"
              class="w-full text-left p-2.5 rounded-lg transition-colors text-sm"
              :class="[
                selectedModule?.name === item.name
                  ? 'bg-[var(--primary-weak)] text-[var(--primary)]'
                  : item.hasWebComponent
                    ? 'text-[var(--text-2)] hover:bg-[var(--surface-3)] cursor-pointer'
                    : 'text-[var(--text-2)] cursor-default'
              ]"
              :disabled="!item.hasWebComponent"
              @click="selectModule(item)"
            >
              <div class="flex items-center gap-2">
                <span class="text-sm">{{ getModuleIcon(item.name) }}</span>
                <span class="font-medium truncate flex-1">{{ item.name }}</span>
                <!-- 启用 toggle（全部启用时禁用） -->
                <label class="relative inline-flex items-center cursor-pointer select-none shrink-0"
                  :class="{ 'opacity-50 cursor-not-allowed': enableAllModules }"
                  @click.stop>
                  <input
                    :checked="enableAllModules || enabledModuleNames.includes(item.name)"
                    :disabled="enableAllModules"
                    type="checkbox"
                    class="sr-only peer"
                    @change="toggleModule(item, ($event.target as HTMLInputElement).checked)"
                  />
                  <div class="w-8 h-5 bg-[var(--surface-3)] peer-focus:outline-none rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
                  <div class="absolute left-[2px] top-[2px] w-4 h-4 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>
              <div class="flex items-center gap-1 mt-1 ml-6">
                <span class="text-[10px] px-1 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-3)]">
                  {{ item.toolCount }} 工具
                </span>
                <span class="text-[10px] text-[var(--text-3)]">·</span>
                <span class="text-[10px] text-[var(--text-3)]">
                  {{ enableAllModules || enabledModuleNames.includes(item.name) ? '已启用' : '已停用' }}
                </span>
              </div>
            </button>
          </div>
      </div>

      <!-- 右侧：管理页面（iframe） -->
      <div class="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
        <!-- 子标题栏 -->
        <div class="h-10 flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--surface-1)]">
          <span class="font-semibold text-sm text-[var(--text-1)]">
            {{ selectedModule?.name || '模块配置' }}
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
            <p class="text-sm">选择左侧模块查看配置</p>
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
</template>

<style scoped>
iframe {
  background: var(--surface-1);
}
</style>
