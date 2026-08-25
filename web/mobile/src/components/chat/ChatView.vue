<script setup lang="ts">
/**
 * 聊天主页面（统一对话框）
 * 智能体对话模式：AgentPills + MessageList + MessageInput
 * 群聊模式（appStore.currentGroupId 非空）：群顶栏 + MessageList + MessageInput + 成员面板
 * 两种模式共用同一套消息列表 / 输入 / 滚动加载组件
 */
import { computed, watch, onMounted, ref } from 'vue';
import { ArrowLeft, Users } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import { apiService } from '../../services/api';
import AgentPills from './AgentPills.vue';
import MessageList from './MessageList.vue';
import MessageInput from './MessageInput.vue';
import FilePreviewList from './FilePreviewList.vue';
import GroupMembersSheet from './GroupMembersSheet.vue';
import type { GroupMessage, Message, Agent } from '../../types';

const appStore = useAppStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

const orgId = computed(() => appStore.currentOrgId);
const activeAgentId = computed(() =>
  orgId.value ? chatStore.getActiveAgentId(orgId.value) : ''
);

// ========== 群聊模式状态 ==========

const isGroupMode = computed(() => !!appStore.currentGroupId);
const groupId = computed(() => appStore.currentGroupId || '');
const showMembersSheet = ref(false);

const groupMeta = computed(() =>
  groupId.value ? (chatStore.groupMetaCache[groupId.value] || null) : null
);
const groupName = computed(() => groupMeta.value?.name ?? '群聊');
const memberCount = computed(() => groupMeta.value?.memberCount ?? 0);

// 已解散（归档）的群：只读查看历史，禁用发送
const groupArchived = computed(() => groupMeta.value?.status === 'archived');

// 群成员 → Agent[]：优先 allAgents（状态新鲜、含 computeStatus），查不到用 member 项兜底
// 已退出成员（left/terminated）不出现在 pill 行——只在成员面板的"已退出成员"分组展示
const memberAgents = computed<Agent[]>(() => {
  const members = groupMeta.value?.members ?? [];
  return members
    .filter(m => m.id !== 'user' && m.status !== 'left' && m.status !== 'terminated')
    .map((m): Agent => {
      const found = agentStore.allAgents.find(a => a.id === m.id);
      if (found) return found;
      return {
        id: m.id,
        orgId: '',
        name: m.name || m.id,
        role: '智能体',
        roleId: null,
        // 后端 member.status 是 'active'/'terminated'，映射为 Agent.status 枚举
        status: (m.status === 'busy' ? 'busy' : m.status === 'active' ? 'online' : 'offline') as Agent['status'],
        computeStatus: 'idle',
      };
    });
});

// 发送者名称解析（后端只存 ID，前端按全局智能体列表匹配名称——群成员可跨组织）
function getSenderName(senderId: string): string {
  if (senderId === 'system') return '系统';
  if (senderId === 'user') return '用户';
  const agent = agentStore.allAgents.find(a => a.id === senderId);
  return agent ? agent.name : senderId;
}

// 群消息映射为 Message 格式，复用 MessageBubble 渲染
const groupMsgs = computed<Message[]>(() => {
  const msgs = chatStore.groupMessages[groupId.value] || [];
  return msgs.map((gm: GroupMessage): Message => ({
    id: gm.id,
    agentId: gm.groupId,
    senderId: gm.from || 'system',
    senderType: (gm.from === 'user' ? 'user' : 'agent') as 'user' | 'agent',
    content: gm.payload.text,
    timestamp: new Date(gm.createdAt).getTime(),
    status: 'sent' as const,
    senderName: getSenderName(gm.from),
    isSystem: gm.kind === 'group_system',
  }));
});

// 当前会话的消息（root 使用会话过滤，其他智能体不过滤；群模式使用群消息）
const messages = computed(() => {
  if (isGroupMode.value) return groupMsgs.value;
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

// busy 指示：群模式看任一成员，智能体模式看当前智能体
const isBusy = computed(() => {
  if (isGroupMode.value) {
    // allAgents 的 status 已由 mapStatus 把 computeStatus 折算，兜底对象永不为 busy
    return memberAgents.value.some(a => a.status === 'busy');
  }
  const agent = agentStore.agents.find(a => a.id === activeAgentId.value);
  return agent?.status === 'busy';
});

// 分页状态（按模式取对应的 store 状态）
const loading = computed(() =>
  isGroupMode.value ? chatStore.groupLoading : chatStore.loading
);
const hasMore = computed(() =>
  isGroupMode.value
    ? (chatStore.groupHasMore[groupId.value] || false)
    : (chatStore.hasMoreHistory[activeAgentId.value] || false)
);
const isLoadingMore = computed(() =>
  isGroupMode.value
    ? (chatStore.groupLoadingMore[groupId.value] || false)
    : (chatStore.isLoadingMore[activeAgentId.value] || false)
);

// ChatView 挂载时，如果 OrgListView 尚未完成数据加载（通过底部导航直接进入），
// 则自行加载。正常情况下 OrgListView.enterOrg 已在 navigate 后完成加载，
// 此时 agentStore.agents 已包含当前 org 的智能体。
// 注意：watch 处理的是 orgId 真正切换的场景（从 A 组织切换到 B 组织）。
let lastOrgId: string | null = appStore.currentOrgId;

onMounted(async () => {
  if (isGroupMode.value) return; // 群模式：群信息由 currentGroupId watcher 加载
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

// 群模式：进入/切换群时加载群信息（含成员列表）
watch(() => appStore.currentGroupId, async (gid) => {
  if (!gid) return;
  try {
    chatStore.groupMetaCache[gid] = await apiService.getGroupInfo(gid);
  } catch (e) {
    console.error('获取群信息失败', e);
  }
}, { immediate: true });

// 从群聊点击成员 pill 跳转个人对话时，需要覆盖 loadOrgData 的"最近活跃"自动选中
let pendingAgentId: string | null = null;

async function loadOrgData(orgId: string) {
  try {
    await agentStore.fetchAgentsByOrg(orgId);
    // 群成员跳转优先；否则默认选中最近活跃的智能体（lastSeen 最大的，排除 user）
    const target = pendingAgentId;
    pendingAgentId = null;
    const sorted = [...agentStore.agents]
      .filter(a => a.id !== 'user')
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const activeId = target ?? sorted[0]?.id ?? orgId;
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

/** 群模式：点成员 pill → 切换到该成员的个人对话（自动切换其所在组织并选中） */
function onSelectMemberAgent(agentId: string) {
  const agent = agentStore.allAgents.find(a => a.id === agentId);
  if (!agent || !agent.orgId) return;
  pendingAgentId = agent.id;
  appStore.navigateTo('chat', agent.orgId); // 清 currentGroupId + 设 currentOrgId
  chatStore.setActiveAgent(agent.orgId, agent.id);
  void chatStore.fetchMessages(agent.id);
}

function exitGroupChat() {
  appStore.navigateTo('orgs'); // navigateTo 会清空 currentGroupId
}

function handleLoadMore() {
  if (isGroupMode.value) {
    chatStore.loadMoreGroupMessages(groupId.value);
  } else {
    chatStore.loadMoreMessages(activeAgentId.value);
  }
}

async function handleSendMessage(text: string) {
  if (isGroupMode.value) {
    if (!groupId.value) return;
    if (groupArchived.value) return; // 已解散的群只读
    try {
      const result = await apiService.sendGroupMessage(groupId.value, text);
      // 乐观更新：本地追加已发送消息（心跳也会推送，appendGroupMessage 按 id 去重）
      chatStore.appendGroupMessage({
        id: result.messageId || Date.now().toString(),
        groupId: groupId.value,
        kind: 'group',
        from: 'user',
        payload: { text },
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
    } catch (e: any) {
      appStore.setError(e?.message || '发送失败');
    }
    return;
  }
  if (!activeAgentId.value) return;
  try {
    await chatStore.sendMessage(activeAgentId.value, text, activeAgentId.value);
  } catch (e: any) {
    appStore.setError(e?.message || '发送失败');
  }
}

/** 邀请成功后：关闭面板、刷新群列表与成员缓存 */
function onMembersInvited() {
  showMembersSheet.value = false;
  chatStore.fetchGroupList();
  if (groupId.value) {
    apiService.getGroupInfo(groupId.value).then(info => {
      chatStore.groupMetaCache[groupId.value] = info;
    }).catch(e => console.error('刷新群信息失败', e));
  }
}

/** 解散成功后：留在群内查看历史（输入自动禁用）；心跳 group_dissolved 会把群移入归档分类 */
function onGroupDissolved() {
  showMembersSheet.value = false;
  if (chatStore.groupMetaCache[groupId.value]) {
    chatStore.groupMetaCache[groupId.value].status = 'archived';
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 群聊模式顶栏 -->
    <div
      v-if="isGroupMode"
      class="flex items-center gap-3 px-3 py-3 border-b border-[var(--border)] bg-[var(--surface-1)] shrink-0"
    >
      <button
        class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-2)] active:scale-95 transition-all shrink-0"
        @click="exitGroupChat"
        type="button"
        aria-label="返回"
      >
        <ArrowLeft class="w-5 h-5 text-[var(--text-2)]" />
      </button>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-[var(--text-1)] truncate">
          {{ groupName }}
        </div>
        <div class="text-xs text-[var(--text-3)]">
          {{ memberCount }} 人
        </div>
      </div>
      <button
        class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-2)] active:scale-95 transition-all shrink-0"
        @click="showMembersSheet = true"
        type="button"
        aria-label="群成员"
      >
        <Users class="w-5 h-5 text-[var(--text-2)]" />
      </button>
    </div>

    <!-- 智能体模式：智能体选择器 / 群聊模式：群成员选择器（复用同一 AgentPills） -->
    <AgentPills
      :agents="isGroupMode ? memberAgents : agentList"
      :activeAgentId="isGroupMode ? '' : activeAgentId"
      @select="isGroupMode ? onSelectMemberAgent : onSelectAgent"
    />

    <!-- 文件缩略图（智能体模式） -->
    <FilePreviewList
      v-if="!isGroupMode && recentFiles.length > 0"
      :files="recentFiles"
    />

    <!-- 消息列表 -->
    <div class="flex-1 overflow-hidden">
      <MessageList
        :messages="messages"
        :loading="loading"
        :hasMore="hasMore"
        :isLoadingMore="isLoadingMore"
        :agentId="isGroupMode ? groupId : activeAgentId"
        :isBusy="isBusy"
        @load-more="handleLoadMore"
      />
    </div>

    <!-- 输入区域 -->
    <MessageInput
      :agentId="isGroupMode ? groupId : activeAgentId"
      :orgId="orgId || ''"
      :placeholder="isGroupMode ? (groupArchived ? '群已解散，仅可查看历史' : '发送群消息...') : undefined"
      :hideAgentProps="isGroupMode"
      :disabled="isGroupMode && groupArchived"
      @send="handleSendMessage"
    />

    <!-- 群成员面板 -->
    <GroupMembersSheet
      v-if="isGroupMode && showMembersSheet"
      :group-id="groupId"
      :group-meta="groupMeta"
      @close="showMembersSheet = false"
      @invited="onMembersInvited"
      @dissolved="onGroupDissolved"
    />
  </div>
</template>
