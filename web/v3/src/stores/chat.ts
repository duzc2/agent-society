import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Message } from '../types';
import { apiService } from '../services/api';

/**
 * 聊天会话状态管理
 * 负责管理不同组织的聊天消息流
 */
export const useChatStore = defineStore('chat', () => {
  // 使用 Map 存储每个会话的聊天记录，key 为 agentId
  const chatMessages = ref<Record<string, Message[]>>({});
  const loading = ref(false);
  const inputValues = ref<Record<string, string>>({}); // 存储每个会话的输入框内容
  
  // 存储每个组织当前选中的智能体 ID，key 为 orgId
  const activeAgentIds = ref<Record<string, string>>({});

  // 待滚动的消息 ID
  const pendingScrollMessageId = ref<string | null>(null);

  // 每个智能体当前允许“重新生成”的最后一条回复消息 ID
  const regenerableMessageIds = ref<Record<string, string | null>>({});

  // 触发首页聊天对话框展开的信号（通过改变值来触发监听）
  const homeChatOpenTrigger = ref(0);

  // 存储每个会话的起始时间（用于隐藏旧消息），key 为 agentId
  const sessionStartTimes = ref<Record<string, number>>({});

  // 分页加载状态
  const hasMoreHistory = ref<Record<string, boolean>>({});
  const isLoadingMore = ref<Record<string, boolean>>({});
  const isContextMode = ref<Record<string, boolean>>({}); // 是否处于上下文查看模式

  /**
   * 为 root 开启新会话
   */
  const rootNewSession = async () => {
    await apiService.rootNewSession();
    // 立即刷新消息，并找到“新会话”标记的时刻
    await fetchMessages('root');
    const messages = chatMessages.value['root'] || [];
    const markerMsg = [...messages].reverse().find(m => m.content.includes('--- 新会话 ---'));
    if (markerMsg) {
      sessionStartTimes.value['root'] = markerMsg.timestamp;
    } else {
      sessionStartTimes.value['root'] = Date.now();
    }
  };

  /**
   * 设置首屏消息（全量替换，用于心跳批量首次加载）。
   */
  const setMessages = (agentId: string, messages: Message[]) => {
    chatMessages.value[agentId] = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * 追加增量消息（按 id 去重），用于心跳 agent_message 增量推送。
   * 同 id 消息已存在时合并更新（工具调用卡片收到执行结果时走这里）。
   */
  const appendMessage = (agentId: string, message: Message) => {
    const existing = chatMessages.value[agentId] || [];
    const idx = existing.findIndex(m => m.id === message.id);
    if (idx !== -1) {
      const updated = [...existing];
      updated[idx] = { ...updated[idx], ...message };
      chatMessages.value[agentId] = updated;
      return;
    }
    chatMessages.value[agentId] = [...existing, message].sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * 获取当前会话的消息（过滤掉旧消息）
   */
  const getSessionMessages = (agentId: string) => {
    const messages = chatMessages.value[agentId] || [];
    const startTime = sessionStartTimes.value[agentId] || 0;
    return messages.filter(m => m.timestamp >= startTime);
  };

  /**
   * 更新当前组织选中的智能体
   */
  const setActiveAgent = async (orgId: string, agentId: string) => {
    activeAgentIds.value[orgId] = agentId;
    // 切换智能体时自动加载消息
    await fetchMessages(agentId);
  };

  /**
   * 获取当前组织选中的智能体 ID
   */
  const getActiveAgentId = (orgId: string) => {
    return activeAgentIds.value[orgId] || orgId;
  };

  /**
   * 更新输入框内容
   */
  const updateInputValue = (agentId: string, value: string) => {
    inputValues.value[agentId] = value;
  };

  /**
   * 获取指定智能体的聊天消息 (初始加载/轮询更新)
   * @param agentId 智能体 ID
   * @param background 是否后台更新 (轮询时为 true，不显示全局 loading)
   */
  const fetchMessages = async (agentId: string, background = false) => {
    // 如果正在加载更多历史，暂停轮询更新，以免冲突
    if (isLoadingMore.value[agentId]) return;

    // 如果本地已有该智能体的消息缓存（由批量首屏加载或心跳推送），跳过 API 调用。
    // 消息通过心跳 agent_message 持续推送，无需在此处重复拉取。
    const cached = chatMessages.value[agentId];
    if (cached && cached.length > 0) {
      // 必须同步初始化 hasMoreHistory，否则 App.vue 中的心跳 agent_message handler
      // 会因为 hasMoreHistory[agentId] === undefined 而静默丢弃该智能体的新消息。
      // hasMoreHistory 缺失导致用户打开智能体对话后，新回复无法实时显示。
      if (hasMoreHistory.value[agentId] === undefined) {
        hasMoreHistory.value[agentId] = true;
      }
      return;
    }

    if (!background) {
      loading.value = true;
    }

    try {
      const { messages: newMessages, hasMore, regenerableMessageId } = await apiService.getMessages(agentId, { limit: 50 });
      
      regenerableMessageIds.value[agentId] = regenerableMessageId ?? null;

      const currentMessages = chatMessages.value[agentId] || [];
      
      // 初始加载或本地无数据，直接赋值
      if (currentMessages.length === 0) {
        chatMessages.value[agentId] = newMessages;
        hasMoreHistory.value[agentId] = hasMore;
      } else {
        // 增量合并逻辑：保留本地历史，更新/追加新消息
        // 1. 建立现有消息 Map (ID -> Message)
        const messageMap = new Map();
        currentMessages.forEach(m => messageMap.set(m.id, m));
        
        // 2. 用新消息更新 Map (如果存在则覆盖，不存在则追加)
        // 注意：这也会更新状态变化的旧消息（如 sending -> sent）
        newMessages.forEach(m => messageMap.set(m.id, m));
        
        // 3. 转回数组并按时间戳排序
        const mergedMessages = Array.from(messageMap.values()).sort((a, b) => a.timestamp - b.timestamp);
        
        chatMessages.value[agentId] = mergedMessages;
        
        // 注意：hasMore 状态我们暂时保持不变，或者只在初始加载时更新。
        // 因为轮询获取的是最新的，不应该影响"是否还有更早历史"的状态，
        // 除非我们确定 newMessages 已经包含了所有历史（即 count < limit）。
        if (newMessages.length < 50 && !hasMore) {
           // 如果新获取的不满 50 条且后端说没更多了，那确实没更多了
           // 但这只有在数据总量很少时才成立。
           // 对于增量更新，维持现有 hasMore 比较安全。
        }
      }

      isContextMode.value[agentId] = false;

      // 如果是 root 且没有手动设置过 sessionStartTime，尝试从消息历史中寻找最新的“新会话”标记
      if (agentId === 'root' && !sessionStartTimes.value['root']) {
        const markerMsg = [...(chatMessages.value[agentId] || [])].reverse().find(m => m.content.includes('--- 新会话 ---'));
        if (markerMsg) {
          sessionStartTimes.value['root'] = markerMsg.timestamp;
        }
      }
    } catch (error) {
      console.error(`加载智能体 ${agentId} 的消息失败:`, error);
      regenerableMessageIds.value[agentId] = null;
      if (!chatMessages.value[agentId]) {
        chatMessages.value[agentId] = [];
      }
    } finally {
      if (!background) {
        loading.value = false;
      }
    }
  };

  /**
   * 加载更多历史消息
   */
  const loadMoreMessages = async (agentId: string) => {
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
      console.error(`加载更多消息失败:`, error);
    } finally {
      isLoadingMore.value[agentId] = false;
    }
  };

  /**
   * 跳转到指定消息上下文
   */
  const jumpToMessage = async (agentId: string, messageId: string) => {
    loading.value = true;
    try {
      const { messages, regenerableMessageId } = await apiService.getMessages(agentId, { 
        limit: 50, 
        around: messageId 
      });
      chatMessages.value[agentId] = messages;
      regenerableMessageIds.value[agentId] = regenerableMessageId ?? null;
      hasMoreHistory.value[agentId] = false; // 上下文模式暂不支持无限加载历史（简化逻辑）
      isContextMode.value[agentId] = true;
    } catch (error) {
      console.error(`跳转消息上下文失败:`, error);
    } finally {
      loading.value = false;
    }
  };

  /**
   * 退出上下文模式（回到最新）
   */
  const exitContextMode = async (agentId: string) => {
    await fetchMessages(agentId);
  };

  /**
   * 发送消息
   * @param agentId 目标智能体 ID
   * @param text 消息内容
   * @param storeId 消息存储的目标 ID (默认为 agentId，如果是 user 视图则为 'user')
   */
  const sendMessage = async (agentId: string, text: string, storeId?: string) => {
    const targetStoreId = storeId || agentId;
    try {
      const response = await apiService.sendMessage(agentId, text);
      
      // 乐观更新：先在本地添加用户消息
      const userMsg: Message = {
        // 直接复用后端真实 messageId，确保轮询回来的同一条消息会按 ID 覆盖，而不是重复显示。
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
      
      // 更新为已发送状态
      userMsg.status = 'sent';
      
      return response.taskId;
    } catch (error) {
      console.error('发送消息失败:', error);
      throw error;
    }
  };

  /**
   * 更新消息内容
   */
  const updateMessage = async (agentId: string, messageId: string, content: string) => {
    try {
      await apiService.updateMessage(agentId, messageId, content);
      
      // 更新本地状态
      const messages = chatMessages.value[agentId];
      if (messages) {
        const msg = messages.find(m => m.id === messageId);
        if (msg) {
          msg.content = content;
        }
      }
    } catch (error) {
      console.error('更新消息失败:', error);
      throw error;
    }
  };

  /**
   * 重新生成最后一条大模型回复
   * 这里会同步移除所有缓存会话中的旧消息，等待轮询把新回复带回来。
   */
  const regenerateMessage = async (agentId: string, messageId: string) => {
    try {
      await apiService.regenerateMessage(agentId, messageId);

      const nextMessages: Record<string, Message[]> = {};
      for (const [storeAgentId, messages] of Object.entries(chatMessages.value)) {
        nextMessages[storeAgentId] = messages.filter(message => message.id !== messageId);
      }
      chatMessages.value = nextMessages;
      regenerableMessageIds.value[agentId] = null;
    } catch (error) {
      console.error('重新生成消息失败:', error);
      throw error;
    }
  };

  /**
   * 删除单条消息
   */
  const deleteMessage = async (agentId: string, messageId: string) => {
    try {
      await apiService.deleteMessage(agentId, messageId);
      
      // 更新本地状态
      const messages = chatMessages.value[agentId];
      if (messages) {
        const index = messages.findIndex(m => m.id === messageId);
        if (index !== -1) {
          messages.splice(index, 1);
        }
      }
    } catch (error) {
      console.error('删除消息失败:', error);
      throw error;
    }
  };

  /**
   * 批量删除消息
   */
  const deleteMessages = async (agentId: string, messageIds: string[]) => {
    try {
      await apiService.deleteMessages(agentId, messageIds);
      
      // 更新本地状态
      const messages = chatMessages.value[agentId];
      if (messages) {
        const idsSet = new Set(messageIds);
        chatMessages.value[agentId] = messages.filter(m => !idsSet.has(m.id));
      }
    } catch (error) {
      console.error('批量删除消息失败:', error);
      throw error;
    }
  };

  /**
   * 清空聊天记录
   */
  const clearHistory = async (agentId: string) => {
    try {
      await apiService.clearHistory(agentId);
      
      // 更新本地状态
      chatMessages.value[agentId] = [];
      delete hasMoreHistory.value[agentId];
    } catch (error) {
      console.error('清空聊天记录失败:', error);
      throw error;
    }
  };

  return {
    hasMoreHistory,
    isLoadingMore,
    isContextMode,
    loadMoreMessages,
    jumpToMessage,
    exitContextMode,
    chatMessages,
    loading,
    inputValues,
    activeAgentIds,
    setActiveAgent,
    getActiveAgentId,
    updateInputValue,
    setMessages,
    appendMessage,
    fetchMessages,
    sendMessage,
    updateMessage,
    regenerateMessage,
    deleteMessage,
    deleteMessages,
    clearHistory,
    rootNewSession,
    getSessionMessages,
    sessionStartTimes,
    pendingScrollMessageId,
    regenerableMessageIds,
    homeChatOpenTrigger
  };
});
