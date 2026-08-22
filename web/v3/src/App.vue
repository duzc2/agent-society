<script setup lang="ts">
/**
 * 应用根组件
 * 
 * 职责：
 * - 应用整体布局（侧边栏 + 主内容区）
 * - 主题管理（亮/暗模式切换）
 * - 全局数据同步轮询
 * - 首次运行配置检查
 * - 新手引导初始化（v4.1新增）
 * 
 * @author Agent Society
 */
import GlobalSidebar from './components/layout/GlobalSidebar.vue';
import WorkspaceTabs from './components/layout/WorkspaceTabs.vue';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import ErrorToast from './components/error/ErrorToast.vue';
import SaveNotice from './components/common/SaveNotice.vue';
import CmdConfirmDialog from './components/common/CmdConfirmDialog.vue';
import Button from 'primevue/button';
import { Sun, Moon, AlertCircle, Bot } from 'lucide-vue-next';
import { ref, onMounted, onUnmounted, watch, onErrorCaptured, computed } from 'vue';
import { useAppStore } from './stores/app';
import { useAgentStore } from './stores/agent';
import { useOrgStore } from './stores/org';

import DynamicDialog from 'primevue/dynamicdialog';
import { configApi } from './services/configApi';
import { initGlobalDragListener } from './utils/dialogBounds';
import { useToast } from 'primevue/usetoast';

// 初始化全局拖拽监听器（确保弹窗拖拽时顶部不能超出视口）
initGlobalDragListener();
import { errorNotificationService } from './services/errorNotification';
import { uiCommandService } from './services/uiCommandService';
import { heartbeatService, orgTreeHandler } from './services/heartbeatService';
import { cmdConfirmHandler } from './services/cmdConfirmService';
import { apiService, normalizeHeartbeatMessage } from './services/api';
import { useChatStore } from './stores/chat';


const appStore = useAppStore();
const agentStore = useAgentStore();
const orgStore = useOrgStore();
const chatStore = useChatStore();

const isDark = ref(false);

// 将 dialog 引用注册到模块单例，供 fileViewerService 使用
import { registerOpenFileViewer } from './components/file-viewer/services/fileViewerService';
import { openFileViewer } from './components/file-viewer';
import { useDialog } from 'primevue/usedialog';
import { setDialogRef } from './services/dialogRef';

const dialog = useDialog();

onMounted(() => {
  // 注册 dialog 引用到模块单例
  setDialogRef(dialog);
  // 注册打开文件查看器函数
  registerOpenFileViewer(openFileViewer);
});

// 配置检查状态
const configChecked = ref(false);
const hasLocalConfig = ref(true); // 默认假设有配置，避免闪烁

// 监听主题变化并更新 DOM
watch(() => appStore.theme, (newTheme) => {
    isDark.value = newTheme === 'dark';
    if (newTheme === 'dark') {
        document.documentElement.classList.add('my-app-dark');
    } else {
        document.documentElement.classList.remove('my-app-dark');
    }
}, { immediate: true });

const toggleDarkMode = () => {
    const newTheme = appStore.theme === 'dark' ? 'light' : 'dark';
    appStore.setTheme(newTheme);
};

/** 正在工作中的智能体数量 */
const busyAgentCount = computed(() =>
    agentStore.allAgents.filter(a => a.status === 'busy').length
);


import { openSettingsWindow } from './components/settings/settingsWindow';

/**
 * 打开设置对话框（全局唯一）
 */
const openSettings = () => {
    return openSettingsWindow(dialog);
};

/**
 * 检查配置状态
 */
const checkConfigStatus = async () => {
    try {
        const status = await configApi.getConfigStatus();
        hasLocalConfig.value = status.hasLocalConfig;
        
        // 如果没有本地配置，认为是首次运行，弹出设置对话框
        if (!status.hasLocalConfig) {
            openSettings();
        }
    } catch (err) {
        console.warn('检查配置状态失败:', err);
    } finally {
        configChecked.value = true;
    }
};

onMounted(() => {
    appStore.initApp();
    appStore.loadChatFontSize();
    appStore.loadMoodColorsSetting();

    // 初始加载
    orgStore.fetchOrgs();
    agentStore.fetchAllAgents();

    // 检查配置状态（首次运行检测）
    checkConfigStatus();
    
    // 初始化错误通知服务
    errorNotificationService.init();

    // 一次性批量加载所有智能体的首屏消息（替代 agent-messages 轮询）
    apiService.getAllAgentMessages(50).then(agents => {
      for (const [agentId, messages] of Object.entries(agents)) {
        chatStore.setMessages(agentId, messages);
      }
    }).catch(err => {
      console.warn('[App] 批量加载首屏消息失败:', err);
    });

    // 注册心跳 handler：后续增量消息通过 agent_message 推送
    heartbeatService.onMessage('agent_message', (msg) => {
      const agents = msg.payload?.agents as Record<string, any[]> | undefined;
      if (!agents) return;
      for (const [agentId, rawMessages] of Object.entries(agents)) {
        if (!Array.isArray(rawMessages)) continue;
        // 未打开过的智能体：不缓存消息全文，但提取最后活跃时间戳用于列表排序。
        // 否则新创建的智能体永远沉在列表底部，无论它有多活跃。
        if (chatStore.hasMoreHistory[agentId] === undefined) {
          const maxTimestamp = rawMessages.reduce((max, m) => {
            const ts = m.createdAt ? new Date(m.createdAt).getTime() : 0;
            return Math.max(max, ts);
          }, 0);
          if (maxTimestamp > 0) {
            agentStore.updateLastActive(agentId, maxTimestamp);
          }
          continue;
        }
        for (const rawMsg of rawMessages) {
          const normalized = normalizeHeartbeatMessage(rawMsg, agentId);
          chatStore.appendMessage(agentId, normalized);
        }
      }
    });

    // 启动心跳服务（统一推送框架）
    heartbeatService.onMessage('cmd_confirm', cmdConfirmHandler);
    heartbeatService.onMessage('org_tree', (msg) => {
      orgTreeHandler(msg);
      orgStore.fetchOrgs(true);
      agentStore.fetchAllAgents(true);
      if (agentStore.currentOrgId) {
        agentStore.fetchAgentsByOrg(agentStore.currentOrgId, true);
      }
    });
    heartbeatService.onMessage('mood_colors', (msg) => {
      const { agentId, colors } = msg.payload as { agentId: string; colors: string[] };
      if (agentId && Array.isArray(colors)) {
        agentStore.updateMoodColors(agentId, colors);
      }
    });
    heartbeatService.start();

    // 启动 UI 命令服务（处理智能体的页面操作请求）
    uiCommandService.start();

    // 执行自动加载脚本（每次页面刷新时按注册顺序执行）
    void uiCommandService.runAutoLoadScripts();

});

// 全局错误边界：捕获未处理的 Vue 组件错误
const appToast = useToast();
onErrorCaptured((err: unknown, _instance: any, info: string) => {
  const message = err instanceof Error ? err.message : String(err);
  // 同时打印完整 Error 对象（包含 stack trace）和 Vue 上下文
  console.error('[App] 全局错误捕获:', err, '\n  Vue info:', info);
  appToast.add({
    severity: 'error',
    summary: '应用错误',
    detail: message,
    life: 5000
  });
  // 返回 false 阻止错误继续传播
  return false;
});

onUnmounted(() => {
    heartbeatService.stop();
    uiCommandService.stop();
});
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text-1)]">
    <DynamicDialog />
    
    <!-- 首次运行提示条 -->
    <div 
      v-if="configChecked && !hasLocalConfig" 
      class="fixed top-0 left-0 right-0 z-[100] bg-orange-500 text-white px-4 py-2 flex items-center justify-center gap-2"
    >
      <AlertCircle class="w-4 h-4" />
      <span class="text-sm">首次运行，请先配置大模型参数</span>
    </div>
    
    <!-- 全局侧栏 -->
    <GlobalSidebar />

    <!-- 主容器 -->
    <main class="flex-grow flex flex-col min-w-0 relative">
      <!-- 顶部工具栏 -->
      <div class="absolute top-2 right-4 z-20 flex items-center gap-1">
        <!-- 模块管理 -->
        <ModuleManager ref="moduleManagerRef" />
        
        <!-- 工作中的智能体数量 -->
        <div
          v-if="busyAgentCount > 0"
          class="flex items-center gap-0.5 text-xs font-medium text-[var(--text-2)] px-1.5"
          title="正在工作的智能体数量"
        >
          <span>{{ busyAgentCount }}</span>
          <Bot class="w-4 h-4" />
        </div>

        <!-- 主题切换 -->
        <Button
          variant="text"
          rounded
          @click="toggleDarkMode"
          :title="isDark ? '切换到明亮模式' : '切换到黑暗模式'"
          class="text-[var(--text-2)]"
        >
          <component :is="isDark ? Sun : Moon" class="w-5 h-5" />
        </Button>
      </div>

      <!-- 核心工作区标签页 -->
      <WorkspaceTabs />
    </main>

    <ConfirmDialog />
    <Toast />
    <!-- 错误通知 Toast（自定义模板） -->
    <ErrorToast />
    <!-- 保存提示 Notice -->
    <SaveNotice />

    <!-- 命令确认对话框 -->
    <CmdConfirmDialog />
  </div>
</template>

<style>
/* 移除默认样式限制 */
#app {
  max-width: none;
  margin: 0;
  padding: 0;
  text-align: left;
  width: 100%;
  height: 100%;
}
body {
  margin: 0;
  overflow: hidden;
}
</style>
