<script setup lang="ts">
/**
 * 移动端根组件
 * 职责：布局壳、页面切换、主题管理、轮询调度
 */
import { onMounted, onUnmounted, watch, computed } from 'vue';
import { useAppStore } from './stores/app';
import { useOrgStore } from './stores/org';
import { useAgentStore } from './stores/agent';
import { useChatStore } from './stores/chat';
import MobileNavBar from './components/layout/MobileNavBar.vue';
import BottomNav from './components/layout/BottomNav.vue';
import OrgListView from './components/orgs/OrgListView.vue';
import ChatView from './components/chat/ChatView.vue';
import SettingsView from './components/settings/SettingsView.vue';
import AgentPropertiesView from './components/agent/AgentPropertiesView.vue';
import RolePropertiesView from './components/agent/RolePropertiesView.vue';
import FileView from './components/file/FileView.vue';
import WorkspaceView from './components/workspace/WorkspaceView.vue';
import ConfirmSheet from './components/common/ConfirmSheet.vue';
import ErrorBanner from './components/common/ErrorBanner.vue';
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import { heartbeatService, orgTreeHandler } from './services/heartbeatService';
import { cmdConfirmHandler } from './services/cmdConfirmService';
import { errorNotificationService } from './services/errorNotificationService';
import { apiService, normalizeHeartbeatMessage } from './services/api';
import CmdConfirmSheet from './components/common/CmdConfirmSheet.vue';

const appStore = useAppStore();
const orgStore = useOrgStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

// 主题同步
watch(() => appStore.theme, (newTheme) => {
  if (newTheme === 'dark') {
    document.documentElement.classList.add('my-app-dark');
  } else {
    document.documentElement.classList.remove('my-app-dark');
  }
}, { immediate: true });

// 错误自动清除
watch(() => appStore.errorMessage, (msg) => {
  if (msg) {
    setTimeout(() => {
      appStore.clearError();
    }, 5000);
  }
});

// 判断消息区域是否隐藏（进入聊天后才显示）
const showChat = computed(() => appStore.currentPage === 'chat');
const showOrgs = computed(() => appStore.currentPage === 'orgs');
const showSettings = computed(() => appStore.currentPage === 'settings');
const showAgentProps = computed(() => appStore.currentPage === 'agentProps');
const showRoleProps = computed(() => appStore.currentPage === 'roleProps');
const showBottomNav = computed(() => !['agentProps', 'roleProps'].includes(appStore.currentPage));

onMounted(async () => {
  // 初始加载
  appStore.loadChatFontSize();
  appStore.loadMoodColorsSetting();
  await orgStore.fetchOrgs();
  agentStore.fetchAllAgents();

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

  // 启动心跳服务（统一推送框架，含 org_tree）
  heartbeatService.onMessage('cmd_confirm', cmdConfirmHandler);
  heartbeatService.onMessage('org_tree', (msg) => {
    orgTreeHandler(msg);
    orgStore.fetchOrgs(true);
    if (appStore.currentOrgId) {
      agentStore.fetchAgentsByOrg(appStore.currentOrgId, true);
    }
    agentStore.fetchAllAgents();
  });
  heartbeatService.onMessage('mood_colors', (msg) => {
    const { agentId, colors } = msg.payload as { agentId: string; colors: string[] };
    if (agentId && Array.isArray(colors)) {
      agentStore.updateMoodColors(agentId, colors);
    }
  });
  errorNotificationService.init();
  heartbeatService.start();
});

onUnmounted(() => {
  errorNotificationService.stop();
  heartbeatService.stop();
});
</script>

<template>
  <div class="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--bg)] text-[var(--text-1)]">
    <ConfirmDialog />
    <Toast />

    <!-- 顶部导航栏 -->
    <MobileNavBar />

    <!-- 错误横幅 -->
    <ErrorBanner />

    <!-- 主内容区（flex-1 填满剩余空间） -->
    <div class="flex-1 overflow-hidden relative">
      <template v-if="showOrgs">
        <OrgListView />
      </template>
      <template v-else-if="showChat">
        <ChatView />
      </template>
      <template v-else-if="showSettings">
        <SettingsView />
      </template>
      <template v-else-if="showAgentProps">
        <AgentPropertiesView />
      </template>
      <template v-else-if="showRoleProps">
        <RolePropertiesView />
      </template>
    </div>

    <!-- 底部导航 -->
    <BottomNav v-if="showBottomNav" />

    <!-- 全屏文件查看器 -->
    <FileView />

    <!-- 工作区文件浏览器 -->
    <WorkspaceView />

    <!-- 确认面板 -->
    <ConfirmSheet />

    <!-- 命令确认面板 -->
    <CmdConfirmSheet />
  </div>
</template>

<style>
#app {
  max-width: none;
  margin: 0;
  padding: 0;
  text-align: left;
  width: 100%;
  height: 100%;
}
</style>
