<script setup lang="ts">
/**
 * 聊天主页面
 * 编排：AgentPills + MessageList + MessageInput
 */
import { computed, watch, onMounted } from 'vue';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import AgentPills from './AgentPills.vue';
import MessageList from './MessageList.vue';
import MessageInput from './MessageInput.vue';
import FilePreviewList from './FilePreviewList.vue';

const appStore = useAppStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

const orgId = computed(() => appStore.currentOrgId);
const activeAgentId = computed(() =>
  orgId.value ? chatStore.getActiveAgentId(orgId.value) : ''
);

// 当前智能体的消息（root 使用会话过滤，其他智能体不过滤）
const messages = computed(() => {
  if (!activeAgentId.value) return [];
  if (activeAgentId.value === 'root') {
    return chatStore.getSessionMessages('root');
  }
  return chatStore.chatMessages[activeAgentId.value] || [];
});

// 当前消息中最近的消息，提取文件信息
const recentFiles = computed(() => {
  const recent = messages.value.filter(m => {
    if (!m.payload) return false;
    if (m.payload.files && Array.isArray(m.payload.files)) return true;
    if (m.payload.file) return true;
    return false;
  });
  // 取最近 5 条有文件的消息
  return recent.slice(-5).flatMap(m => {
    const files = m.payload?.files || (m.payload?.file ? [m.payload.file] : []);
    return files.map((f: any) => ({
      name: f.name || f.path?.split('/').pop() || 'file',
      path: f.path || f.name || '',
      mimeType: f.mimeType || '',
      modifiedAt: f.modifiedAt || '',
      lastOperator: f.lastOperator || '',
      messageId: m.id
    }));
  });
});

// 智能体列表（排除 user）
const agentList = computed(() =>
  agentStore.agents.filter(a => a.id !== 'user')
);

// 当前智能体是否 busy
const isActiveAgentBusy = computed(() => {
  const agent = agentStore.agents.find(a => a.id === activeAgentId.value);
  return agent?.status === 'busy';
});

// ChatView 挂载时，如果 OrgListView 尚未完成数据加载（通过底部导航直接进入），
// 则自行加载。正常情况下 OrgListView.enterOrg 已在 navigate 后完成加载，
// 此时 agentStore.agents 已包含当前 org 的智能体。
// 注意：watch 处理的是 orgId 真正切换的场景（从 A 组织切换到 B 组织）。
let lastOrgId: string | null = appStore.currentOrgId;

onMounted(async () => {
  const orgId = appStore.currentOrgId;
  if (!orgId) return;
  // 检查是否已有智能体数据（OrgListView.enterOrg 已加载过）
  const hasAgents = agentStore.agents.length > 0 && agentStore.agents.some(a => a.orgId === orgId);
  if (!hasAgents) {
    await loadOrgData(orgId);
  }
});

// orgId 变化时（从 A 组织切换到 B 组织），重新加载
watch(() => appStore.currentOrgId, async (newId) => {
  if (newId && newId !== lastOrgId) {
    lastOrgId = newId;
    await loadOrgData(newId);
  }
});

async function loadOrgData(orgId: string) {
  try {
    await agentStore.fetchAgentsByOrg(orgId);
    // 默认选中最近活跃的智能体（lastSeen 最大的，排除 user）
    const sorted = [...agentStore.agents]
      .filter(a => a.id !== 'user')
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const activeId = sorted[0]?.id || orgId;
    chatStore.setActiveAgent(orgId, activeId);
    await chatStore.fetchMessages(activeId);
  } catch (e: any) {
    appStore.setError(e?.message || '加载智能体失败');
  }
}

function onSelectAgent(agentId: string) {
  if (!orgId.value) return;
  chatStore.setActiveAgent(orgId.value, agentId);
  chatStore.fetchMessages(agentId);
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 智能体选择器 -->
    <AgentPills
      :agents="agentList"
      :activeAgentId="activeAgentId"
      @select="onSelectAgent"
    />

    <!-- 文件缩略图 -->
    <FilePreviewList
      v-if="recentFiles.length > 0"
      :files="recentFiles"
    />

    <!-- 消息列表 -->
    <div class="flex-1 overflow-hidden">
      <MessageList
        :messages="messages"
        :loading="chatStore.loading"
        :hasMore="chatStore.hasMoreHistory[activeAgentId] || false"
        :isLoadingMore="chatStore.isLoadingMore[activeAgentId] || false"
        :agentId="activeAgentId"
        :isBusy="isActiveAgentBusy"
        @load-more="chatStore.loadMoreMessages(activeAgentId)"
      />
    </div>

    <!-- 输入区域 -->
    <MessageInput
      :agentId="activeAgentId"
      :orgId="orgId || ''"
    />
  </div>
</template>
