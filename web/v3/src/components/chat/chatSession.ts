/**
 * 会话适配器：ChatArea 通过注入的适配器对象产生不同会话行为。
 * 不传 adapter = ChatArea 内置默认智能体适配器（行为与现状一致）；
 * 群标签页注入 useGroupChatSession 返回的群适配器。
 * 所有差异通过函数执行与返回值体现，ChatArea 内部零会话类型分支。
 */
import { computed, type ComputedRef } from 'vue';
import { useDialog } from 'primevue/usedialog';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agent';
import { useAppStore } from '../../stores/app';
import { useOrgStore } from '../../stores/org';
import { openGroupInviteDialog, openGroupKickDialog, openGroupDissolveDialog } from './groupDialogs';

/** 头部更多菜单项（由各会话适配器注入；icon 为 ChatArea #item 模板中的图标键） */
export interface ChatMenuItem {
  label: string;
  icon: string;
  command: () => void;
  disabled?: boolean;
}

export interface ChatSessionAdapter {
  /** 会话 id（消息缓存/分页键 chatMessages[id]） */
  id: string;
  /** 头部图标类型 */
  icon: 'agent' | 'user' | 'group';
  /** 头部标题 / 副标题（智能体：名称+角色；群：群名+人数） */
  title: string;
  subtitle: string;
  /** 头部描述行（仅群适配器提供；缺省不渲染） */
  description?: string;
  /** 输入框占位符 */
  placeholder: string;
  /** 空状态文案 */
  emptyTitle: string;
  emptySubtitle: string;
  /** 初始加载（onMounted + watch(id)） */
  loadInitial(): Promise<void>;
  /** 向上滚动加载更多历史（内部处理自身守卫，如 agent 的上下文模式） */
  loadMore(): Promise<void>;
  hasMore(): boolean;
  isLoadingMore(): boolean;
  /** 发送消息（抛错由 ChatArea 弹回输入框） */
  send(text: string): Promise<void>;
  /** 是否允许发送（已解散的群为只读） */
  canSend: boolean;
  /** 重新生成目标智能体（群 null → 重新生成按钮自动不显示） */
  regenerationAgentId: string | null;
  /** 思考占位 */
  isThinking(): boolean;
  thinkingPhase(): string | null;
  /** 功能开关 */
  showAutoReply: boolean;
  showSearch: boolean;
  showSuggestions: boolean;
  canClearHistory: boolean;
  /** 头部更多菜单项（智能体：文件/命令等；群：拉人/踢人/解散） */
  menuItems(): ChatMenuItem[];
  /** 自动回复配置加载钩子 */
  loadAutoReplyConfig?(): void;
  /** 消息变化副作用钩子（agent：刷新文件列表；群：无） */
  onMessagesChanged?(): void;
  /** 点发送者名导航（群：user 短路 + 智能体跳个人对话） */
  navigateSender?(agentId: string, messageId: string): void;
}

/** 跳转某智能体个人对话（群成员点击/群消息发送者名共用） */
export function openAgentChatTab(agentId: string): void {
  const agentStore = useAgentStore();
  const chatStore = useChatStore();
  const appStore = useAppStore();
  const orgStore = useOrgStore();

  const agent = agentStore.allAgents.find(a => a.id === agentId);
  if (!agent || !agent.orgId) return;
  chatStore.setActiveAgent(agent.orgId, agentId);
  const orgName = orgStore.orgs.find(o => o.id === agent.orgId)?.name ?? agent.name;
  appStore.openTab({ id: agent.orgId, type: 'org', title: orgName });
}

/**
 * 群会话适配器工厂（供 WorkspaceTabs 群标签使用）。
 * @param groupIdSource 群 ID（字符串或响应式 computed，跟随 activeGroupId 变化）
 */
export function useGroupChatSession(groupIdSource: string | ComputedRef<string>): ComputedRef<ChatSessionAdapter> {
  const chatStore = useChatStore();
  const agentStore = useAgentStore();
  const dialog = useDialog();

  const groupId = computed(() =>
    typeof groupIdSource === 'string' ? groupIdSource : groupIdSource.value
  );

  return computed<ChatSessionAdapter>(() => {
    const gid = groupId.value;
    const meta = chatStore.groupMetaCache[gid];
    return {
      id: gid,
      icon: 'group',
      title: meta?.name ?? '群聊',
      subtitle: `${meta?.memberCount ?? '?'} 人`,
      description: meta?.description ?? '',
      placeholder: '向群里发送消息',
      emptyTitle: '群聊还没有消息',
      emptySubtitle: '发一条消息开启讨论吧',
      loadInitial: () => chatStore.fetchGroupMessages(gid),
      loadMore: () => chatStore.loadMoreGroupMessages(gid),
      hasMore: () => !!chatStore.groupHasMore[gid],
      isLoadingMore: () => !!chatStore.isLoadingMore[gid],
      send: async (text: string) => {
        await chatStore.sendGroupMessageAction(gid, text);
        // 心跳也会推送，这里 300ms 兜底重拉（复刻原 GroupChatArea 模式）
        setTimeout(() => chatStore.fetchGroupMessages(gid), 300);
      },
      // 已解散（归档）的群只读；meta 未加载时默认放行
      canSend: (meta?.status ?? 'active') !== 'archived',
      regenerationAgentId: null,
      isThinking: () =>
        (meta?.members ?? []).some((m: { id: string }) =>
          agentStore.allAgents.find(a => a.id === m.id)?.status === 'busy'),
      thinkingPhase: () => '群成员正在思考…',
      showAutoReply: false,
      showSearch: false,
      showSuggestions: false,
      canClearHistory: false,
      menuItems: () => {
        // 归档群为只读：拉人/踢人/解散全部禁用（与 canSend 同判定）
        const archived = (meta?.status ?? 'active') === 'archived';
        return [
          {
            label: '拉人',
            icon: 'user-plus',
            command: () => openGroupInviteDialog(dialog, gid),
            disabled: archived
          },
          {
            label: '踢人',
            icon: 'user-minus',
            command: () => openGroupKickDialog(dialog, gid),
            disabled: archived
          },
          {
            label: '解散',
            icon: 'x-circle',
            command: () => openGroupDissolveDialog(dialog, gid, meta?.name ?? '群聊'),
            disabled: archived
          }
        ];
      },
      navigateSender: (agentId: string) => {
        if (agentId === 'user') return;
        openAgentChatTab(agentId);
      },
    };
  });
}
