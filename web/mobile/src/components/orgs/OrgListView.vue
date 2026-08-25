<script setup lang="ts">
/**
 * 组织列表页面
 * 显示所有组织 + 创建新组织（内联对话，与 PC 版逻辑一致）
 */
import { ref, computed, onMounted } from 'vue';
import { Plus, Loader, X, Send, Pencil, Check, ChevronDown, ChevronRight, Archive } from 'lucide-vue-next';
import { useOrgStore } from '../../stores/org';
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
import { apiService } from '../../services/api';
import { orgTreeState } from '../../services/heartbeatService';
import MessageList from '../chat/MessageList.vue';
import GroupsList from '../chat/GroupsList.vue';

const appStore = useAppStore();
const orgStore = useOrgStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

// ---- 创建组织：内联对话状态 ----
const showCreateChat = ref(false);
const createInput = ref('');
const sendingCreate = ref(false);

const showDeletedOrgs = ref(false);

// 分段控件：'agents' | 'groups'
const activeSegment = ref<'agents' | 'groups'>('agents');

// 加载群列表
onMounted(() => {
  chatStore.fetchGroupList();
});

// 检查指定组织是否已删除（org root 节点的 status 不是 "active"）
const isOrgDeleted = (orgId: string): boolean => {
  const rootNode = orgTreeState.tree.find(n => n.id === 'root');
  if (!rootNode?.children) return false;
  const orgNode = rootNode.children.find(c => c.id === orgId);
  return orgNode ? orgNode.status !== 'active' : false;
};

// 按状态分组
const activeOrganizations = computed(() => orgStore.orgs.filter(o => !isOrgDeleted(o.id)));
const deletedOrganizations = computed(() => orgStore.orgs.filter(o => isOrgDeleted(o.id)));

const rootMessages = computed(() => chatStore.chatMessages['root'] || []);

/** 开始创建组织的内联对话 */
async function startCreateChat() {
  showCreateChat.value = true;
  try {
    await chatStore.rootNewSession();
  } catch (e: any) {
    console.error('[OrgListView.startCreateChat] 创建会话失败', {
      error: e?.message ?? String(e),
      stack: e?.stack,
      name: e?.name,
      code: e?.code
    });
    appStore.setError(e?.message || '创建会话失败');
  }
}

/** 关闭创建对话（遗忘本次对话） */
function stopCreateChat() {
  showCreateChat.value = false;
  createInput.value = '';
}

/** 发送创建目标消息 */
async function sendCreateMessage() {
  const text = createInput.value.trim();
  if (!text || sendingCreate.value) return;

  sendingCreate.value = true;
  createInput.value = '';
  try {
    await chatStore.sendMessage('root', text);
  } catch (e: any) {
    console.error('[OrgListView.sendCreateMessage] 发送消息失败', {
      error: e?.message ?? String(e),
      stack: e?.stack,
      name: e?.name,
      code: e?.code
    });
    appStore.setError(e?.message || '发送失败');
  } finally {
    sendingCreate.value = false;
  }
}

// ---- 组织名称编辑 ----
const editingOrgId = ref<string | null>(null);
const editValue = ref('');
const savingOrgName = ref(false);

const startEditOrgName = (org: any, event: Event) => {
  event.stopPropagation();
  editingOrgId.value = org.id;
  editValue.value = org.name;
};

const saveEditOrgName = async (org: any, event: Event) => {
  event.stopPropagation();
  const newName = editValue.value.trim();
  if (savingOrgName.value) return;
  if (newName === org.name) { editingOrgId.value = null; return; }
  savingOrgName.value = true;
  try {
    await apiService.setOrgName(org.id, newName);
    editingOrgId.value = null;
  } catch (e: any) {
    console.error('保存组织名称失败', e);
  } finally {
    savingOrgName.value = false;
  }
};

const cancelEditOrgName = () => {
  editingOrgId.value = null;
  editValue.value = '';
};

/** 进入组织聊天（点击已有组织） */
async function enterOrg(orgId: string) {
  try {
    // 如果正在创建对话中，先停止
    if (showCreateChat.value) stopCreateChat();

    appStore.setError(null);
    appStore.navigateTo('chat', orgId);

    // 加载该组织的智能体
    await agentStore.fetchAgentsByOrg(orgId);

    // 默认选中最近活跃的智能体（lastSeen 最大的，排除 user）
    const sorted = [...agentStore.agents]
      .filter(a => a.id !== 'user')
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const defaultAgent = sorted[0]?.id || orgId;
    chatStore.setActiveAgent(orgId, defaultAgent);
    await chatStore.fetchMessages(defaultAgent);
  } catch (e: any) {
    appStore.setError(e?.message || '进入组织失败');
  }
}

</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 分段控件：智能体 / 群 -->
    <div class="flex shrink-0 bg-[var(--surface-1)] border-b border-[var(--border)]">
      <button
        class="flex-1 py-3 text-sm font-medium transition-all border-b-2"
        :class="activeSegment === 'agents'
          ? 'text-[var(--primary)] border-[var(--primary)]'
          : 'text-[var(--text-3)] border-transparent'"
        @click="activeSegment = 'agents'"
      >
        智能体
      </button>
      <button
        class="flex-1 py-3 text-sm font-medium transition-all border-b-2"
        :class="activeSegment === 'groups'
          ? 'text-[var(--primary)] border-[var(--primary)]'
          : 'text-[var(--text-3)] border-transparent'"
        @click="activeSegment = 'groups'; chatStore.fetchGroupList()"
      >
        群
      </button>
    </div>

    <!-- 群列表 -->
    <GroupsList v-if="activeSegment === 'groups'" />

    <!-- 组织列表（智能体段） -->
    <template v-else>
    <div
      class="overflow-y-auto px-4 py-3"
      :class="showCreateChat ? 'max-h-[38%] border-b border-[var(--border)]' : 'flex-1'"
    >
      <div v-if="orgStore.loading && orgStore.orgs.length === 0"
           class="flex items-center justify-center h-full">
        <Loader class="w-6 h-6 text-[var(--text-3)] animate-spin" />
      </div>

      <div v-else-if="orgStore.orgs.length === 0 && !showCreateChat"
           class="flex flex-col items-center justify-center h-full text-center gap-3">
        <p class="text-sm text-[var(--text-3)]">暂无组织</p>
        <p class="text-xs text-[var(--text-3)]">点击下方按钮创建第一个组织</p>
      </div>

      <div v-else class="space-y-2">
        <button
          v-for="org in activeOrganizations"
          :key="org.id"
          class="w-full flex items-center gap-3 p-3 rounded-xl bg-[var(--surface-1)] border border-[var(--border)] active:scale-[0.98] transition-transform"
          @click="enterOrg(org.id)"
          type="button"
        >
          <div class="w-10 h-10 rounded-xl bg-[var(--primary-weak)] flex items-center justify-center text-[var(--primary)] font-bold text-base shrink-0">
            {{ org.initial }}
          </div>
          <div class="text-left min-w-0 flex-1">
            <!-- 编辑模式 -->
            <div v-if="editingOrgId === org.id" class="flex items-center gap-1" @click.stop>
              <input
                v-model="editValue"
                class="flex-1 min-w-0 text-sm px-2 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-[var(--primary)]"
                :disabled="savingOrgName"
                @keydown.enter.stop="saveEditOrgName(org, $event)"
                @keydown.escape.stop="cancelEditOrgName"
              />
              <Check
                class="w-5 h-5 text-[var(--primary)] cursor-pointer shrink-0 p-0.5"
                :class="{ 'opacity-40': savingOrgName }"
                @click.stop="saveEditOrgName(org, $event)"
              />
              <X
                class="w-5 h-5 text-[var(--text-3)] cursor-pointer shrink-0 p-0.5"
                @click.stop="cancelEditOrgName"
              />
            </div>
            <!-- 显示模式 -->
            <template v-else>
              <div class="text-sm font-medium text-[var(--text-1)] truncate flex items-center gap-1">
                <span class="truncate">{{ org.name }}</span>
                <Pencil
                  class="w-3.5 h-3.5 text-[var(--text-4)] shrink-0 cursor-pointer opacity-60 hover:opacity-100"
                  @click.stop="startEditOrgName(org, $event)"
                />
              </div>
              <div class="text-xs text-[var(--text-3)] truncate">{{ org.description || org.role || '' }}</div>
            </template>
          </div>
        </button>

        <!-- 已删除的组织（折叠区域） -->
        <div v-if="deletedOrganizations.length > 0" class="border-t border-[var(--border)] pt-2">
          <button
            class="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-3)] active:bg-[var(--surface-2)] rounded-lg transition-colors"
            @click="showDeletedOrgs = !showDeletedOrgs"
            type="button"
          >
            <component :is="showDeletedOrgs ? ChevronDown : ChevronRight" class="w-4 h-4 flex-shrink-0" />
            <Archive class="w-4 h-4 flex-shrink-0" />
            <span class="font-medium">已删除的组织 ({{ deletedOrganizations.length }})</span>
          </button>

          <div v-if="showDeletedOrgs" class="space-y-1.5 mt-1.5">
            <button
              v-for="org in deletedOrganizations"
              :key="org.id"
              class="w-full flex items-center gap-3 p-3 rounded-xl bg-[var(--surface-1)] border border-[var(--border)] opacity-60 active:opacity-100 active:scale-[0.98] transition-all"
              @click="enterOrg(org.id)"
              type="button"
            >
              <div class="w-10 h-10 rounded-xl bg-[var(--surface-3)] flex items-center justify-center text-[var(--text-3)] font-bold text-base shrink-0">
                {{ org.initial }}
              </div>
              <div class="text-left min-w-0 flex-1">
                <div class="text-sm font-medium text-[var(--text-1)] truncate">{{ org.name }}</div>
                <div class="text-xs text-[var(--text-3)] truncate">{{ org.description || org.role || '' }}</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 创建组织：内联对话区 -->
    <div v-if="showCreateChat" class="flex-1 flex flex-col min-h-0 bg-[var(--surface-2)]">
      <!-- 对话头部 -->
      <div class="flex items-center gap-2 px-4 py-2 bg-[var(--surface-1)] border-b border-[var(--border)] shrink-0">
        <button
          class="p-1 -ml-1 rounded-lg hover:bg-[var(--surface-3)] transition-colors text-[var(--text-2)]"
          @click="stopCreateChat"
          type="button"
          aria-label="关闭创建对话"
        >
          <X class="w-5 h-5" />
        </button>
        <span class="text-sm font-medium text-[var(--text-1)]">创建新组织</span>
      </div>

      <!-- 消息列表 -->
      <div class="flex-1 overflow-hidden">
        <MessageList
          :messages="rootMessages"
          :loading="false"
          :hasMore="chatStore.hasMoreHistory['root'] || false"
          :isLoadingMore="chatStore.isLoadingMore['root'] || false"
          agentId="root"
          :isBusy="false"
          @load-more="chatStore.loadMoreMessages('root')"
        />
      </div>

      <!-- 输入区域 -->
      <div class="px-3 py-2 bg-[var(--surface-1)] border-t border-[var(--border)] shrink-0"
           style="padding-bottom: calc(8px + var(--safe-bottom))">
        <div class="flex items-end gap-2">
          <textarea
            v-model="createInput"
            class="flex-1 resize-none rounded-xl px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:border-[var(--primary)] placeholder:text-[var(--text-4)]"
            placeholder="输入一个目标或者任务，我为你创造一个团队"
            rows="2"
            @keydown.enter.exact.prevent="sendCreateMessage"
          />
          <button
            class="shrink-0 w-9 h-9 rounded-full bg-[var(--primary)] text-white flex items-center justify-center active:opacity-80 disabled:opacity-40 transition-opacity"
            :disabled="sendingCreate || !createInput.trim()"
            @click="sendCreateMessage"
            type="button"
            aria-label="发送"
          >
            <Send v-if="!sendingCreate" class="w-4 h-4" />
            <Loader v-else class="w-4 h-4 animate-spin" />
          </button>
        </div>
      </div>
    </div>

    <!-- 创建按钮（未创建时显示） -->
    <div v-if="!showCreateChat" class="px-4 py-3 bg-[var(--surface-1)] border-t border-[var(--border)]"
         style="padding-bottom: calc(12px + var(--safe-bottom))">
      <button
        class="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-[var(--border)] text-[var(--text-2)] text-sm font-medium active:scale-[0.98] transition-all active:border-[var(--primary)] active:text-[var(--primary)]"
        @click="startCreateChat"
        type="button"
      >
        <Plus class="w-4 h-4" />
        创建新组织
      </button>
    </div>
  </template>
  </div>
</template>
