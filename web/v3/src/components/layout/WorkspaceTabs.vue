<script setup lang="ts">
import { computed, watch } from 'vue';
import { X, LayoutGrid, Settings } from 'lucide-vue-next';
import Button from 'primevue/button';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import { apiService } from '../../services/api';
import type { Agent } from '../../types';
import AgentList from '../agent/AgentList.vue';
import ChatArea from '../chat/ChatArea.vue';
import GroupList from '../chat/GroupList.vue';
import { useGroupChatSession } from '../chat/chatSession';
import HomeOverview from '../dashboard/HomeOverview.vue';

const appStore = useAppStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

// 群会话适配器（跟随当前活跃群；注入 ChatArea 复用完整智能体对话框）
const groupSession = useGroupChatSession(computed(() => chatStore.activeGroupId ?? ''));

// 切到群标签时自动加载成员和消息，切走时清除活跃群
  watch(() => appStore.currentTabId, (tabId) => {
    if (tabId?.startsWith('group:')) {
      const groupId = tabId.split(':')[1];
      chatStore.setActiveGroup(groupId);
      chatStore.fetchGroupMessages(groupId);
      // 拉取群成员信息
      apiService.getGroupInfo(groupId).then((info: any) => {
        if (info && !info.error) chatStore.groupMetaCache[groupId] = info;
      }).catch(() => {});
    } else if (chatStore.activeGroupId) {
      chatStore.setActiveGroup(null);
    }
  });

/**
 * 判断单个智能体是否仍处于非 idle 的工作状态。
 * 标签只需要体现“组织里是否还有工作未完成”，因此只关注真正仍在执行中的状态。
 * @param agent 智能体视图模型
 * @returns 是否仍处于非 idle 状态
 */
const isAgentNonIdle = (agent: Agent): boolean => {
  if (agent.id === 'user') {
    return false;
  }

  const computeStatus = agent.computeStatus;
  if (computeStatus === 'waiting_llm'
    || computeStatus === 'processing'
    || computeStatus === 'computing'
    || computeStatus === 'stopping'
    || computeStatus === 'terminating') {
    return true;
  }

  return agent.status === 'busy';
};

/**
 * 计算每个已打开组织标签是否存在非 idle 智能体。
 * 这里基于全量智能体的父子关系递归检查，因此切换到其他标签后仍能看到最新进度。
 */
const tabBusyMap = computed<Record<string, boolean>>(() => {
  const childrenMap = new Map<string, Agent[]>();
  const agentById = new Map<string, Agent>();

  agentStore.allAgents.forEach((agent) => {
    agentById.set(agent.id, agent);

    const parentAgentId = agent.parentAgentId;
    if (!parentAgentId) {
      return;
    }

    const siblings = childrenMap.get(parentAgentId) || [];
    siblings.push(agent);
    childrenMap.set(parentAgentId, siblings);
  });

  const busyMap: Record<string, boolean> = {};

  appStore.activeTabs.forEach((tab) => {
    if (tab.id === 'home') {
      busyMap[tab.id] = false;
      return;
    }

    const pendingAgentIds = [tab.id];
    const visitedAgentIds = new Set<string>();
    let hasNonIdleAgent = false;

    while (pendingAgentIds.length > 0 && !hasNonIdleAgent) {
      const currentAgentId = pendingAgentIds.shift();
      if (!currentAgentId || visitedAgentIds.has(currentAgentId)) {
        continue;
      }

      visitedAgentIds.add(currentAgentId);

      const currentAgent = agentById.get(currentAgentId);
      if (currentAgent && isAgentNonIdle(currentAgent)) {
        hasNonIdleAgent = true;
        break;
      }

      const childAgents = childrenMap.get(currentAgentId) || [];
      childAgents.forEach((childAgent) => {
        pendingAgentIds.push(childAgent.id);
      });
    }

    busyMap[tab.id] = hasNonIdleAgent;
  });

  return busyMap;
});
</script>

<template>
  <div class="flex-grow flex flex-col h-full bg-[var(--bg)]">
    <Tabs v-model:value="appStore.currentTabId" class="flex flex-col h-full !bg-transparent overflow-visible" :pt="{ root: { class: 'bg-transparent border-none overflow-visible' } }">
      <TabList class="px-3 py-2 !bg-[var(--bg)] gap-2 flex items-center border-b border-[var(--border)] relative z-10 [--tablist-bg:var(--bg)]" :pt="{ root: { class: '!bg-transparent border-none overflow-visible' }, content: { class: '!bg-transparent overflow-visible' } }">
        <Tab v-for="tab in appStore.activeTabs" :key="tab.id" :value="tab.id" class="custom-tab group">
          <div class="flex items-center min-w-0">
            <Settings
              v-if="tabBusyMap[tab.id]"
              class="workspace-tab-activity-icon w-3.5 h-3.5 mr-2 shrink-0 text-current"
              title="该组织内有智能体正在工作"
            />
            <span class="truncate">{{ tab.title }}</span>
          </div>
          <Button 
            v-if="tab.id !== 'home'"
            variant="text" 
            rounded 
            class="!p-0.5 ml-2 opacity-0 group-hover:opacity-100 transition-opacity hover:!bg-[var(--surface-3)]"
            @click.stop="appStore.closeTab(tab.id)"
          >
            <X class="w-3 h-3 text-[var(--text-3)]" />
          </Button>
        </Tab>
      </TabList>
      
      <TabPanels class="!p-0 flex-grow overflow-hidden bg-transparent">
              <div v-if="appStore.activeTabs.length === 0" class="flex flex-col items-center justify-center h-full text-[var(--text-3)]">
                <div class="w-16 h-16 mb-4 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
                  <LayoutGrid class="w-8 h-8 opacity-20" />
                </div>
                <p>暂无活动工作区</p>
                <p class="text-sm mt-1">请从侧栏选择一个组织开始工作</p>
              </div>

              <TabPanel v-for="tab in appStore.activeTabs" :key="tab.id" :value="tab.id" class="h-full">
                <!-- 首页展示概览视图 -->
                <HomeOverview v-if="tab.id === 'home'" />

                <!-- 群标签页：群列表 + 聊天 -->
                <Splitter v-else-if="tab.type === 'group'" class="h-full border-none rounded-none bg-transparent">
                  <SplitterPanel :size="25" :minSize="20" class="flex flex-col bg-[var(--surface-2)] border-r border-[var(--border)]">
                    <GroupList :group-id="chatStore.activeGroupId || tab.id.split(':')[1]" />
                  </SplitterPanel>
                  <SplitterPanel :size="75" class="flex flex-col bg-[var(--bg)]">
                    <ChatArea
                      v-if="chatStore.activeGroupId"
                      :orgId="chatStore.activeGroupId"
                      :tabTitle="tab.title"
                      :session="groupSession"
                      class="h-full"
                    />
                    <div v-else class="flex items-center justify-center h-full text-[var(--text-3)] text-sm">
                      选择一个群聊开始对话
                    </div>
                  </SplitterPanel>
                </Splitter>

                <!-- 其他组织展示三段式布局：中（智能体列表） + 右（主内容） -->
                <Splitter v-else class="h-full border-none rounded-none bg-transparent">
                  <!-- 中：智能体列表 (Workspace Sidebar) -->
                  <SplitterPanel :size="25" :minSize="20" class="flex flex-col bg-[var(--surface-2)] border-r border-[var(--border)]">
                    <AgentList :orgId="tab.id" />
                  </SplitterPanel>

                  <!-- 右：主内容 (Main Content) -->
                  <SplitterPanel :size="75" class="flex flex-col bg-[var(--bg)]">
                    <ChatArea :orgId="tab.id" :tabTitle="tab.title" />
                  </SplitterPanel>
                </Splitter>
              </TabPanel>
            </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
/* 强制所有容器 overflow visible 以防止阴影被截断 */
:deep(.p-tablist),
:deep(.p-tablist-content),
:deep(.p-tablist-tab-list) {
  border: none !important;
  background: transparent !important;
  overflow: visible !important;
}

:deep(.p-tablist-tab-list) {
  gap: 0.5rem;
}

:deep(.custom-tab) {
  background: transparent !important;
  border: none !important;
  color: var(--text-2) !important;
  padding: 0.5rem 1.25rem !important;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  border-radius: 0.5rem !important; /* rounded-lg */
  margin: 0 !important;
}

:deep(.custom-tab.p-tab-active) {
  color: var(--primary) !important;
  background: var(--surface-1) !important;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.05) !important;
  border: 1px solid var(--border) !important;
  z-index: 20;
}

:deep(.custom-tab:hover:not(.p-tab-active)) {
  background: var(--surface-3) !important;
  color: var(--text-1) !important;
}

.workspace-tab-activity-icon {
  opacity: 0.8;
  animation: workspace-tab-gear-spin 1.4s linear infinite;
}

@keyframes workspace-tab-gear-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

/* 隐藏 PrimeVue 默认的下划线和墨水条 */
:deep(.p-tablist-active-bar) {
  display: none !important;
}

:deep(.p-tabs-ink-bar) {
  display: none !important;
}

/* Splitter 样式微调：精简分割线 */
:deep(.p-splitter) {
  background: transparent !important;
  border: none !important;
}

:deep(.p-splitter-gutter) {
  background: var(--border) !important;
  width: 1px !important;
  transition: background 0.2s;
}

:deep(.p-splitter-gutter:hover) {
  background: var(--primary) !important;
}

:deep(.p-splitter-gutter-handle) {
  display: none !important;
}
</style>
