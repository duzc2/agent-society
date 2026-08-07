import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Message } from '../types';
import { apiService } from '../services/api';

/**
 * 聊天会话状态管理（移动端精简版）
 * 移除：消息搜索/编辑/重新生成/批量删除（桌面端独有）
 */
export const useChatStore = defineStore('chat', () => {
  const chatMessages = ref<Record<string, Message[]>>({});
  const loading = ref(false);
  const inputValues = ref<Record<string, string>>({});
  const activeAgentIds = ref<Record<string, string>>({});

  // 分页
  const hasMoreHistory = ref<Record<string, boolean>>({});
  const isLoadingMore = ref<Record<string, boolean>>({});

  // 存储每个会话的起始时间（用于隐藏旧消息），key 为 agentId
  const sessionStartTimes = ref<Record<string, number>>({});

  function setActiveAgent(orgId: string, agentId: string) {
    activeAgentIds.value[orgId] = agentId;
  }

  function getActiveAgentId(orgId: string): string {
    return activeAgentIds.value[orgId] || orgId;
  }

  function updateInputValue(agentId: string, value: string) {
    inputValues.value[agentId] = value;
  }

  function getInputValue(agentId: string): string {
    return inputValues.value[agentId] || '';
  }

  /** 设置首屏消息（全量替换，用于心跳批量首次加载） */
  function setMessages(agentId: string, messages: Message[]) {
    chatMessages.value[agentId] = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 追加增量消息（按 id 去重），用于心跳 agent_message 增量推送。同 id 消息已存在时合并更新（工具调用卡片收到执行结果时走这里） */
  function appendMessage(agentId: string, message: Message) {
    const existing = chatMessages.value[agentId] || [];
    const idx = existing.findIndex(m => m.id === message.id);
    if (idx !== -1) {
      const updated = [...existing];
      updated[idx] = { ...updated[idx], ...message };
      chatMessages.value[agentId] = updated;
      return;
    }
    chatMessages.value[agentId] = [...existing, message].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 获取当前会话的消息（过滤掉旧消息）
   */
  function getSessionMessages(agentId: string) {
    const messages = chatMessages.value[agentId] || [];
    const startTime = sessionStartTimes.value[agentId] || 0;
    return messages.filter(m => m.timestamp >= startTime);
  }

  /** 获取消息（初始加载） */
  async function fetchMessages(agentId: string, background = false) {
    if (isLoadingMore.value[agentId]) return;

    // 如果本地已有该智能体的消息缓存（由批量首屏加载或心跳推送），跳过 API 调用
    const cached = chatMessages.value[agentId];
    if (cached && cached.length > 0) {
      // 必须同步初始化 hasMoreHistory，否则 App.vue 中的心跳 agent_message handler
      // 会因为 hasMoreHistory[agentId] === undefined 而静默丢弃该智能体的新消息。
      if (hasMoreHistory.value[agentId] === undefined) {
        hasMoreHistory.value[agentId] = true;
      }
      return;
    }

    if (!background) loading.value = true;

    try {
      const { messages: newMessages, hasMore } = await apiService.getMessages(agentId, { limit: 50 });

      const currentMessages = chatMessages.value[agentId] || [];

      if (currentMessages.length === 0) {
        chatMessages.value[agentId] = newMessages;
        hasMoreHistory.value[agentId] = hasMore;

        // 如果是 root 且没有手动设置过 sessionStartTime，尝试从消息历史中寻找最新的"新会话"标记
        if (agentId === 'root' && !sessionStartTimes.value['root']) {
          const markerMsg = [...newMessages].reverse().find(m => m.content.includes('--- 新会话 ---'));
          if (markerMsg) {
            sessionStartTimes.value['root'] = markerMsg.timestamp;
          }
        }
      } else {
        const messageMap = new Map<string, Message>();
        currentMessages.forEach(m => messageMap.set(m.id, m));
        newMessages.forEach(m => messageMap.set(m.id, m));

        const merged = Array.from(messageMap.values()).sort((a, b) => a.timestamp - b.timestamp);
        chatMessages.value[agentId] = merged;
      }
    } catch (error) {
      console.error(`加载智能体 ${agentId} 的消息失败:`, error);
      if (!chatMessages.value[agentId]) {
        chatMessages.value[agentId] = [];
      }
    } finally {
      if (!background) loading.value = false;
    }
  }

  /** 加载更多历史消息 */
  async function loadMoreMessages(agentId: string) {
    if (isLoadingMore.value[agentId] || !hasMoreHistory.value[agentId]) return;

    isLoadingMore.value[agentId] = true;
    try {
      const currentMessages = chatMessages.value[agentId] || [];
      const oldestMessageId = currentMessages[0]?.id;

      if (!oldestMessageId) return;

      const { messages, hasMore } = await apiService.getMessages(agentId, {
        limit: 50,
        before: oldestMessageId
      });

      if (messages.length > 0) {
        chatMessages.value[agentId] = [...messages, ...currentMessages];
      }
      hasMoreHistory.value[agentId] = hasMore;
    } catch (error) {
      console.error('加载更多消息失败:', error);
    } finally {
      isLoadingMore.value[agentId] = false;
    }
  }

  /** 发送消息 */
  async function sendMessage(agentId: string, text: string, storeId?: string) {
    const targetStoreId = storeId || agentId;
    try {
      const response = await apiService.sendMessage(agentId, text);

      const userMsg: Message = {
        id: response.messageId || Date.now().toString(),
        agentId: agentId,
        senderId: 'user',
        receiverId: agentId,
        senderType: 'user',
        content: text,
        timestamp: Date.now(),
        status: 'sending',
        taskId: response.taskId
      };

      if (!chatMessages.value[targetStoreId]) {
        chatMessages.value[targetStoreId] = [];
      }
      chatMessages.value[targetStoreId].push(userMsg);

      userMsg.status = 'sent';

      return response.taskId;
    } catch (error: any) {
      console.error('[chatStore.sendMessage] 发送消息失败', {
        agentId,
        text: text.substring(0, 100),
        error: error?.message ?? String(error),
        stack: error?.stack,
        name: error?.name,
        code: error?.code
      });
      throw error;
    }
  }

  /** 清空指定智能体的消息缓存 */
  function clearAgentMessages(agentId: string) {
    chatMessages.value[agentId] = [];
    delete hasMoreHistory.value[agentId];
  }

  /** root 新会话 */
  async function rootNewSession() {
    try {
      await apiService.rootNewSession();
    } catch (error: any) {
      console.error('[chatStore.rootNewSession] root 新会话 API 调用失败', {
        error: error?.message ?? String(error),
        stack: error?.stack,
        name: error?.name,
        code: error?.code
      });
      throw error;
    }
    clearAgentMessages('root');
    await fetchMessages('root');
    // 找到"新会话"标记的时刻
    const messages = chatMessages.value['root'] || [];
    const markerMsg = [...messages].reverse().find(m => m.content.includes('--- 新会话 ---'));
    if (markerMsg) {
      sessionStartTimes.value['root'] = markerMsg.timestamp;
    } else {
      sessionStartTimes.value['root'] = Date.now();
    }
  }

  return {
    chatMessages,
    loading,
    inputValues,
    activeAgentIds,
    hasMoreHistory,
    isLoadingMore,
    sessionStartTimes,
    setActiveAgent,
    getActiveAgentId,
    updateInputValue,
    getInputValue,
    setMessages,
    appendMessage,
    fetchMessages,
    loadMoreMessages,
    sendMessage,
    getSessionMessages,
    rootNewSession,
    clearAgentMessages
  };
});
