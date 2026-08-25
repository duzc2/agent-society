<script setup lang="ts">
import { Send, Bot, Sparkles, ArrowDown, User, Users, Search, MoreVertical, Loader2, X, Trash2, FileText, CheckSquare, Eraser, SlidersHorizontal, Lightbulb, Download, Repeat, History, UserPlus, UserMinus, XCircle } from 'lucide-vue-next';
import MoodGrid from '../common/MoodGrid.vue';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Menu from 'primevue/menu';
import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agent';
import { useAppStore } from '../../stores/app';
// import { useOrgStore } from '../../stores/org';  // 暂时未使用，保留导入以备后续功能
import { apiService } from '../../services/api';
import ChatMessageList from './ChatMessageList.vue';
import MessageNavigator from './MessageNavigator.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import { useToast } from 'primevue/usetoast';
import { useDialog } from 'primevue/usedialog';
import { openAgentPropertiesWindow } from '../agent/agentPropertiesWindow';
import { useChatExport } from './useChatExport';
import { openAgentFilesDialog, refreshAgentFiles } from './agentFilesDialog';
import { openAgentCommandsDialog } from './agentCommandsDialog';
import { isMoodDark } from '../../utils/moodColors';
import { type ChatSessionAdapter } from './chatSession';


const props = defineProps<{
  orgId: string;
  tabTitle: string;
  /** 注入的会话适配器（群标签页传入）；不传 = 内置默认智能体会话 */
  session?: ChatSessionAdapter;
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const appStore = useAppStore();
const toast = useToast();
const dialog = useDialog();

// 当前会话 ID（注入会话适配器时使用其 id，如群 ID；否则为当前选中的智能体）
const activeAgentId = computed(() => props.session?.id ?? chatStore.getActiveAgentId(props.orgId));

// 当前对话的智能体信息
const activeAgent = computed(() => {
  const orgAgents = agentStore.agentsMap[props.orgId] || [];
  return orgAgents.find(a => a.id === activeAgentId.value);
});

// 计算消息实际发送的目标智能体
const chatTarget = computed(() => {
  const orgAgents = agentStore.agentsMap[props.orgId] || [];

  // 1. 如果当前选中的是智能体（不是 user），则发送给该智能体
  if (activeAgentId.value !== 'user') {
    return activeAgent.value;
  }

  // 2. 如果当前选中是 user 视角
  const messages = chatStore.chatMessages['user'] || [];

  // a. 如果有对话记录，找到最后一个与 user 对话的智能体
  const lastResponse = [...messages].reverse().find(m => m.senderId !== 'user');
  if (lastResponse) {
    const target = orgAgents.find(a => a.id === lastResponse.senderId);
    if (target) return target;
  }

  // b. 如果没有记录，发给组织里第一个智能体（排除 user）
  return orgAgents.find(a => a.id !== 'user');
});

/**
 * 当前用于“重新生成最后一条回复”的目标智能体 ID。
 * 说明：
 * 1. 普通智能体视图下，就是当前选中的智能体；
 * 2. user 视图下，实际对话目标是 chatTarget，对应的可重生消息元信息也应从该智能体获取。
 */
const regenerationAgentId = computed(() => {
  if (activeAgentId.value !== 'user') {
    return activeAgentId.value;
  }

  const targetId = chatTarget.value?.id;
  if (!targetId || targetId === 'user') {
    return null;
  }
  return targetId;
});

// 输入框占位符
const placeholder = computed(() => {
  const name = chatTarget.value?.name || '智能体';
  return `向${name}发送信息`;
});

const message = computed({
  get: () => chatStore.inputValues[activeAgentId.value] || '',
  set: (val) => chatStore.updateInputValue(activeAgentId.value, val)
});
const isSending = ref(false);
const messageTextareaRef = ref<{ $el?: HTMLElement } | HTMLTextAreaElement | null>(null);
const messageContainer = ref<HTMLElement | null>(null);
const showScrollBottomButton = ref(false);

// 当前对话中的消息数量（用于消息导航器显示判断）
const messageCount = computed(() => {
  return (chatStore.chatMessages[activeAgentId.value] || []).length;
});
const SCROLL_THRESHOLD = 20; // 距离底部小于 20px 视为"在底部"

// 搜索功能相关状态
const isSearchActive = ref(false);
const searchKeyword = ref('');
const searchResults = ref<any[]>([]);
const isSearchingBackend = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);

// 自动回复功能相关状态
const isAutoReplyPanelOpen = ref(false);
const autoReplyEnabled = ref(false);
const autoReplyContent = ref('');
const autoReplyDelay = ref(30);
let autoReplySaveTimer: any = null;

// 下拉菜单相关状态
const moreMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const isDeleting = ref(false);
const isClearing = ref(false);
const isBatchDeleting = ref(false);

// 是否显示"生成回复"按钮：当前智能体空闲且最后一条消息是用户发出的
const canShowGenerateReply = computed(() => {
  const target = chatTarget.value;
  if (!target || target.id === 'user') return false;
  if (target.computeStatus !== 'idle') return false;
  const messages = chatStore.chatMessages[activeAgentId.value] || [];
  if (messages.length === 0) return false;
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.senderType === 'user';
});

// 智能体是否正在运算（用于显示思考占位气泡）
const isAgentProcessing = computed(() => {
  const target = chatTarget.value;
  if (!target || target.id === 'user') return false;
  return target.computeStatus !== 'idle';
});

// 当前运算阶段文本
const thinkingPhase = computed(() => {
  return chatTarget.value?.computePhase || null;
});

// 内置默认智能体会话适配器（不传 session 时使用；行为与历史实现一致）
const agentSession = computed<ChatSessionAdapter>(() => ({
  id: activeAgentId.value,
  icon: activeAgent.value?.id === 'user' ? 'user' : 'agent',
  title: activeAgent.value?.name || props.tabTitle,
  subtitle: activeAgent.value?.role || '智能体',
  placeholder: placeholder.value,
  emptyTitle: `开始在 ${props.tabTitle} 协作`,
  emptySubtitle: '选择一个智能体或直接发送指令',
  loadInitial: loadMessages,
  loadMore: () => {
    // 上下文模式（历史跳转）下不自动加载
    if (chatStore.isContextMode[activeAgentId.value]) return Promise.resolve();
    return chatStore.loadMoreMessages(activeAgentId.value);
  },
  hasMore: () => !!chatStore.hasMoreHistory[activeAgentId.value],
  isLoadingMore: () => !!chatStore.isLoadingMore[activeAgentId.value],
  send: sendToAgent,
  canSend: true,
  regenerationAgentId: regenerationAgentId.value,
  isThinking: () => isAgentProcessing.value,
  thinkingPhase: () => thinkingPhase.value,
  showAutoReply: true,
  showSearch: true,
  showSuggestions: true,
  canClearHistory: true,
  // 智能体会话的更多菜单项（原 ChatArea 硬编码项，迁入适配器统一走注入）
  menuItems: () => [
    {
      label: '所有文件',
      icon: 'files',
      command: () => {
        const agent = activeAgent.value;
        if (agent && agent.id !== 'user') {
          openAgentFilesDialog(dialog, props.orgId, agent.id, agent.name);
        }
      },
      disabled: !activeAgent.value || activeAgent.value.id === 'user'
    },
    {
      label: '历史命令',
      icon: 'history',
      command: () => {
        const agent = activeAgent.value;
        if (agent && agent.id !== 'user') {
          openAgentCommandsDialog(dialog, agent.id, agent.name);
        }
      },
      disabled: !activeAgent.value || activeAgent.value.id === 'user'
    },
    {
      label: '批量管理',
      icon: 'check-square',
      command: () => toggleBatchMode(),
      disabled: !activeAgent.value || (chatStore.chatMessages[activeAgentId.value] || []).length === 0
    },
    {
      label: '属性',
      icon: 'sliders-horizontal',
      command: () => openAgentPropertiesDialog(),
      disabled: !activeAgent.value || activeAgent.value.id === 'user'
    },
    {
      label: '清空聊天记录',
      icon: 'eraser',
      command: () => openClearHistoryConfirm(),
      disabled: !activeAgent.value || (chatStore.chatMessages[activeAgentId.value] || []).length === 0
    },
    {
      label: '删除智能体',
      icon: 'trash-2',
      command: () => openDeleteConfirm(),
      disabled: !activeAgent.value || activeAgent.value.id === 'user' || isDeleting.value
    }
  ],
  loadAutoReplyConfig,
  onMessagesChanged: () => refreshAgentFiles(activeAgentId.value),
}));

// 生效的会话适配器
const session = computed<ChatSessionAdapter>(() => props.session ?? agentSession.value);

// 推荐回复建议状态（按智能体隔离）
const suggestionsEnabledByAgent = ref<Record<string, boolean>>({});
const suggestionsByAgent = ref<Record<string, string[]>>({});
const isLoadingSuggestionsByAgent = ref<Record<string, boolean>>({});

const isSuggestionsEnabled = computed({
  get: () => !!suggestionsEnabledByAgent.value[activeAgentId.value],
  set: (val) => { suggestionsEnabledByAgent.value[activeAgentId.value] = val; }
});
const suggestions = computed({
  get: () => suggestionsByAgent.value[activeAgentId.value] || [],
  set: (val) => { suggestionsByAgent.value[activeAgentId.value] = val; }
});
const isLoadingSuggestions = computed({
  get: () => !!isLoadingSuggestionsByAgent.value[activeAgentId.value],
  set: (val) => { isLoadingSuggestionsByAgent.value[activeAgentId.value] = val; }
});

// 批量管理状态
const isBatchMode = ref(false);
const selectedMessageIds = ref<string[]>([]);

// 导出长图
const { exportMessagesToPNG, isExporting } = useChatExport();
const handleExportToPNG = () => exportMessagesToPNG(
  activeAgentId.value,
  selectedMessageIds.value,
  activeAgent.value?.name || props.tabTitle,
);

// 确认删除对话框状态
const showDeleteConfirm = ref(false);
const deleteConfirmMessage = ref('');

// 确认清空历史对话框状态
const showClearHistoryConfirm = ref(false);


/** 更多菜单项：由会话适配器注入（智能体 6 项 / 群 3 项，ChatArea 不再硬编码） */
const moreMenuItems = computed(() => session.value.menuItems());

/**
 * 检查滚动位置，决定是否显示"返回底部"按钮，以及触发无限滚动加载
 */
const handleScroll = async () => {
  if (!messageContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = messageContainer.value;

  // 1. 检查底部按钮显示
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  showScrollBottomButton.value = distanceFromBottom > SCROLL_THRESHOLD;

  // 2. 检查顶部无限滚动加载（会话适配器提供加载逻辑与守卫）
  if (
    scrollTop < 50 &&
    !session.value.isLoadingMore() &&
    session.value.hasMore()
  ) {
    const oldScrollHeight = scrollHeight;
    await session.value.loadMore();

    // 恢复滚动位置
    nextTick(() => {
      if (messageContainer.value) {
        const newScrollHeight = messageContainer.value.scrollHeight;
        // 保持视口相对于内容的相对位置不变
        messageContainer.value.scrollTop = newScrollHeight - oldScrollHeight + scrollTop;
      }
    });
  }
};

/**
 * 滚动到底部
 * @param force 是否强制滚动，忽略当前位置
 */
const scrollToBottom = (force = false) => {
  if (!messageContainer.value) return;
  const { scrollTop, scrollHeight, clientHeight } = messageContainer.value;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

  // 如果强制滚动，或者当前已经在底部附近，则执行滚动
  if (force || distanceFromBottom <= SCROLL_THRESHOLD) {
    setTimeout(() => {
      if (messageContainer.value) {
        messageContainer.value.scrollTo({
          top: messageContainer.value.scrollHeight,
          behavior: force ? 'smooth' : 'auto'
        });
      }
    }, 50);
  }
};

/**
 * 滚动到指定消息
 */
const scrollToMessage = (messageId: string) => {
  setTimeout(() => {
    const element = document.getElementById(`msg-${messageId}`);
    if (element && messageContainer.value) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 闪烁提醒
      element.classList.add('animate-pulse-quick');
      setTimeout(() => element.classList.remove('animate-pulse-quick'), 2000);
      // 清除待滚动 ID
      chatStore.pendingScrollMessageId = null;
    }
  }, 100);
};

/**
 * 预加载“重新生成”所需的目标智能体消息元数据。
 * 这里复用现有的 fetchMessages 接口，不新增前端轮询通道。
 */
const loadRegenerationMetadata = async () => {
  if (props.session) return; // 注入会话（如群）不加载智能体重新生成元数据
  if (!regenerationAgentId.value) {
    return;
  }
  if (regenerationAgentId.value === activeAgentId.value) {
    return;
  }
  await chatStore.fetchMessages(regenerationAgentId.value, true);
};

const loadMessages = async () => {
  if (activeAgentId.value) {
    await chatStore.fetchMessages(activeAgentId.value);
    await loadRegenerationMetadata();
    // 如果有待滚动的消息，加载完后执行滚动
    if (chatStore.pendingScrollMessageId) {
      scrollToMessage(chatStore.pendingScrollMessageId);
    }
  }
};

onMounted(async () => {
  await session.value.loadInitial();
  session.value.loadAutoReplyConfig?.();
  if (messageContainer.value) {
    messageContainer.value.addEventListener('scroll', handleScroll);
  }
  // 初始加载完成后强制滚动到底部
  scrollToBottom(true);
});

onUnmounted(() => {
  if (messageContainer.value) {
    messageContainer.value.removeEventListener('scroll', handleScroll);
  }
});

// 监听 activeAgentId 的变化，重新加载消息
watch(activeAgentId, async () => {
  await session.value.loadInitial();
  if (!chatStore.pendingScrollMessageId) {
    scrollToBottom(true);
  }
  // 切换会话时加载自动回复配置（仅支持自动回复的会话）
  session.value.loadAutoReplyConfig?.();
});

// 监听最后一条消息：当智能体回复后，重新生成建议
watch(() => {
  const msgs = chatStore.chatMessages[activeAgentId.value];
  return msgs?.[msgs.length - 1];
}, (newMsg, oldMsg) => {
  if (
    session.value.showSuggestions &&
    isSuggestionsEnabled.value &&
    newMsg &&
    newMsg.id !== oldMsg?.id &&
    newMsg.senderType === 'agent'
  ) {
    void loadSuggestions();
  }
  // 消息变化副作用（默认智能体会话：智能体回复后刷新"所有文件"对话框）
  if (newMsg && newMsg.id !== oldMsg?.id && newMsg.senderType === 'agent') {
    session.value.onMessagesChanged?.();
  }
});

// 监听 orgId 变化
watch(() => props.orgId, async () => {
  await session.value.loadInitial();
  if (!chatStore.pendingScrollMessageId) {
    scrollToBottom(true);
  }
});

// 监听“重新生成目标”变化。
// user 视图下最后一个回复者变化时，需要立刻同步新的可重生消息 ID。
watch(regenerationAgentId, async () => {
  await loadRegenerationMetadata();
});

// 监听待滚动消息 ID，实现同页面跳转
watch(() => chatStore.pendingScrollMessageId, (newId) => {
  if (newId) {
    scrollToMessage(newId);
  }
});

// 自动滚动到底部（仅在最新消息变化时）
watch(() => {
  const msgs = chatStore.chatMessages[activeAgentId.value];
  return msgs?.[msgs.length - 1]?.id;
}, (newId, oldId) => {
  // 只有当最新消息 ID 发生变化时，才触发自动滚动
  if (newId && newId !== oldId) {
    scrollToBottom(false);
  }
});

/**
 * 获取聊天输入框对应的原生 textarea。
 * PrimeVue Textarea 在不同渲染情况下可能直接暴露 textarea，也可能通过组件根节点暴露。
 */
const getMessageTextareaElement = () => {
  const textareaRefValue = messageTextareaRef.value;
  if (!textareaRefValue) return null;

  if (textareaRefValue instanceof HTMLTextAreaElement) {
    return textareaRefValue;
  }

  const rootElement = textareaRefValue.$el;
  if (rootElement instanceof HTMLTextAreaElement) {
    return rootElement;
  }

  return rootElement?.querySelector('textarea') ?? null;
};

/**
 * 根据当前内容重新计算聊天输入框高度。
 * 当输入框内容为空时，会恢复到单行高度。
 */
const resizeMessageTextarea = (textarea: HTMLTextAreaElement) => {
  // 重置高度以便正确计算 scrollHeight。
  textarea.style.height = 'auto';

  // 限制最大高度，避免输入框无限增长。
  const maxHeight = window.innerHeight * 0.5;
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${newHeight}px`;
};

/**
 * 自动调整 textarea 高度。
 * 兼容 Safari 等不支持 field-sizing 的浏览器。
 */
const autoResize = (event?: Event) => {
  const textarea = (event?.target as HTMLTextAreaElement | undefined) ?? getMessageTextareaElement();
  if (!textarea) return;

  resizeMessageTextarea(textarea);
};

/**
 * 处理键盘事件。
 * Enter 发送消息，Shift+Enter 换行。
 */
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
};

/**
 * 发送给当前智能体会话（默认适配器的 send 实现）。
 */
const sendToAgent = async (text: string) => {
  const targetId = chatTarget.value?.id;
  if (!targetId) {
    throw new Error('无法确定消息目标智能体');
  }
  await chatStore.sendMessage(targetId, text, activeAgentId.value);
};

/**
 * 发送当前输入框中的消息（会话适配器决定实际发送行为）。
 * 发送完成后重新计算输入框高度，保证清空内容后恢复到单行。
 */
const sendMessage = async () => {
  if (!message.value.trim() || isSending.value) return;
  const text = message.value;
  chatStore.updateInputValue(activeAgentId.value, ''); // 清空当前对话的输入框

  isSending.value = true;

  try {
    await session.value.send(text);
  } catch (error: any) {
    console.error('发送失败:', error);
    // 如果发送失败，把消息弹回来。
    chatStore.updateInputValue(activeAgentId.value, text);
    const errMsg = error?.message || '消息发送失败，请重试';
    toast.add({ severity: 'error', summary: '发送失败', detail: errMsg, life: 5000 });
  } finally {
    isSending.value = false;
    // 清空或恢复内容后，等待 DOM 同步完成，再重新计算高度。
    nextTick(() => {
      const textareaEl = getMessageTextareaElement();
      if (textareaEl) {
        resizeMessageTextarea(textareaEl);
      }
    });
  }
};

/**
 * 生成回复 - 触发智能体重新生成最后一条回复
 */
const handleGenerateReply = async () => {
  const targetId = chatTarget.value?.id;
  if (!targetId || targetId === 'user') return;

  const messages = chatStore.chatMessages[activeAgentId.value] || [];
  if (messages.length === 0) return;

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.senderType !== 'user') return;

  // 触发大模型对用户最后一条消息生成回复
  try {
    isSending.value = true;
    await apiService.generateReply(targetId, lastMessage.content);
  } catch (error: any) {
    console.error('生成回复失败:', error);
  } finally {
    isSending.value = false;
  }
};

/**
 * 切换推荐回复建议
 */
const toggleSuggestions = async () => {
  if (isSuggestionsEnabled.value) {
    // 关闭：清空该智能体的建议数据
    delete suggestionsEnabledByAgent.value[activeAgentId.value];
    delete suggestionsByAgent.value[activeAgentId.value];
    delete isLoadingSuggestionsByAgent.value[activeAgentId.value];
  } else {
    // 开启：如果已有数据则直接显示，否则走生成流程
    suggestionsEnabledByAgent.value[activeAgentId.value] = true;
    if (!suggestionsByAgent.value[activeAgentId.value]?.length) {
      await loadSuggestions();
    }
  }
};

/**
 * 加载推荐回复建议
 */
const loadSuggestions = async () => {
  const currentAgentId = activeAgentId.value; // 快照：防止切换智能体后写入错误 key
  const targetId = chatTarget.value?.id;
  if (!targetId || targetId === 'user') return;

  // 严格约束：对话中最后一条消息必须是智能体发出的，才能请求推荐回复
  const messages = chatStore.chatMessages[activeAgentId.value] || [];
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.senderType !== 'agent') return;

  isLoadingSuggestionsByAgent.value[currentAgentId] = true;
  try {
    const result = await apiService.suggestReplies(targetId);
    if (result.ok) {
      suggestionsByAgent.value[currentAgentId] = result.suggestions || [];
    }
  } catch (error) {
    console.error('获取推荐回复建议失败:', error);
  } finally {
    isLoadingSuggestionsByAgent.value[currentAgentId] = false;
  }
};

/**
 * 发送推荐建议
 */
const sendSuggestion = (text: string) => {
  chatStore.updateInputValue(activeAgentId.value, text);
  nextTick(() => {
    sendMessage();
  });
};

/**
 * 切换搜索框显示状态
 */
const toggleSearch = () => {
  isSearchActive.value = !isSearchActive.value;
  if (isSearchActive.value) {
    // 激活搜索框后自动聚焦
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  } else {
    // 关闭搜索时清空搜索状态
    clearSearch();
  }
};

/**
 * 清空搜索状态
 */
const clearSearch = () => {
  searchKeyword.value = '';
  searchResults.value = [];
  isSearchingBackend.value = false;
};

/**
 * 关闭搜索
 */
const closeSearch = () => {
  isSearchActive.value = false;
  clearSearch();

  // 如果处于上下文模式，退出并回到最新消息
  if (chatStore.isContextMode[activeAgentId.value]) {
    chatStore.exitContextMode(activeAgentId.value);
  }
};

// --- 自动回复功能 ---

/**
 * 加载自动回复配置。
 */
const loadAutoReplyConfig = async () => {
  try {
    const result = await apiService.getAutoReply(activeAgentId.value);
    const cfg = result.autoReplyConfig;
    if (cfg) {
      autoReplyEnabled.value = cfg.enabled;
      autoReplyContent.value = cfg.content || '';
      autoReplyDelay.value = cfg.delaySeconds || 30;
    } else {
      autoReplyEnabled.value = false;
      autoReplyContent.value = '';
      autoReplyDelay.value = 30;
    }
  } catch {
    // 配置加载失败，保持默认状态
  }
};

/**
 * 保存自动回复配置（带防抖）。
 */
const saveAutoReplyConfig = () => {
  if (autoReplySaveTimer) clearTimeout(autoReplySaveTimer);
  autoReplySaveTimer = setTimeout(async () => {
    try {
      const config = {
        enabled: autoReplyEnabled.value,
        content: autoReplyContent.value,
        delaySeconds: autoReplyDelay.value
      };
      await apiService.updateAutoReply(activeAgentId.value, config);
    } catch {
      // 保存失败，静默处理
    }
  }, 400);
};

/**
 * 切换自动回复面板（仅支持自动回复的会话）。
 */
const toggleAutoReply = () => {
  if (!session.value.showAutoReply) return;
  isAutoReplyPanelOpen.value = !isAutoReplyPanelOpen.value;
  if (isAutoReplyPanelOpen.value) {
    loadAutoReplyConfig();
  }
};

/**
 * 关闭自动回复面板。
 */
const closeAutoReply = () => {
  isAutoReplyPanelOpen.value = false;
};

let searchDebounceTimer: any = null;

/**
 * 处理搜索输入变化
 */
const handleSearchInput = () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

  searchDebounceTimer = setTimeout(() => {
    performSearch();
  }, 300); // 300ms 防抖
};

/**
 * 执行后端搜索
 */
const performSearch = async () => {
  const keyword = searchKeyword.value.trim();
  if (!keyword) {
    searchResults.value = [];
    return;
  }

  isSearchingBackend.value = true;
  try {
    const results = await apiService.searchMessages(activeAgentId.value, keyword);
    searchResults.value = results;
  } catch (error) {
    console.error('搜索失败:', error);
    searchResults.value = [];
  } finally {
    isSearchingBackend.value = false;
  }
};

/**
 * 点击搜索结果
 */
const handleResultClick = async (match: any) => {
  try {
    await chatStore.jumpToMessage(activeAgentId.value, match.id);
    // 滚动到该消息
    scrollToMessage(match.id);
    // 不关闭搜索框，但清空结果列表以显示内容? 或者保持结果列表？
    // 这里选择隐藏结果列表，让用户看消息。用户可以通过再次聚焦输入框或者输入来再次显示列表。
    // 为了体验，我们可以清空 searchResults 但保留 keyword 以便高亮
    searchResults.value = [];
  } catch (error) {
    console.error('跳转失败:', error);
  }
};

/**
 * 键盘事件处理
 */
const handleSearchKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    closeSearch();
  } else if (e.key === 'Enter') {
    performSearch();
  }
};

/**
 * 切换更多菜单
 */
const toggleMoreMenu = (event: Event) => {
  moreMenuRef.value?.toggle(event);
};

/**
 * 打开删除确认对话框
 */
const openDeleteConfirm = () => {
  const agent = activeAgent.value;
  if (!agent || agent.id === 'user') return;

  deleteConfirmMessage.value = `确定要删除智能体 "${agent.name}" 吗？删除后，该智能体将被终止且无法恢复。`;
  showDeleteConfirm.value = true;
};

/**
 * 格式化日期
 */
const formatDate = (dateStr: string): string => {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * 打开智能体属性弹窗。
 */
const openAgentPropertiesDialog = async () => {
  const agent = activeAgent.value;
  if (!agent || agent.id === 'user') return;

  openAgentPropertiesWindow(dialog, {
    agentId: agent.id,
    agentName: agent.name,
    roleName: agent.role,
    roleId: agent.roleId,
    agentStatus: agent.status
  });
};

/**
 * 处理删除智能体
 */
const handleDeleteAgent = async () => {
  const agent = activeAgent.value;
  if (!agent || agent.id === 'user') return;

  isDeleting.value = true;
  try {
    await apiService.deleteAgent(agent.id, {
      reason: '用户手动删除',
      deletedBy: 'user'
    });

    // 关闭确认对话框
    showDeleteConfirm.value = false;

    // 删除成功后，刷新智能体列表
    await agentStore.fetchAgentsByOrg(props.orgId);
    await agentStore.fetchAllAgents(true);

    // 如果删除的是当前对话的智能体，切换到 user
    if (chatStore.activeAgentIds[props.orgId] === agent.id) {
      chatStore.setActiveAgent(props.orgId, 'user');
    }
  } catch (error: any) {
    console.error('删除智能体失败:', error);
    const message = error?.message || '删除失败，请重试';
    toast.add({ severity: 'error', summary: '删除失败', detail: message, life: 3000 });
  } finally {
    isDeleting.value = false;
  }
};

/**
 * 切换批量模式
 */
const toggleBatchMode = () => {
  isBatchMode.value = !isBatchMode.value;
  if (!isBatchMode.value) {
    selectedMessageIds.value = [];
  }
};

/**
 * 批量删除消息
 */
const handleBatchDelete = async () => {
  if (selectedMessageIds.value.length === 0) return;

  isBatchDeleting.value = true;
  try {
    await chatStore.deleteMessages(activeAgentId.value, selectedMessageIds.value);
    // 退出批量模式
    toggleBatchMode();
  } catch (error: any) {
    console.error('批量删除失败:', error);
    toast.add({ severity: 'error', summary: '批量删除失败', detail: error?.message || '删除失败，请重试', life: 3000 });
  } finally {
    isBatchDeleting.value = false;
  }
};

/**
 * 打开清空历史确认框
 */
const openClearHistoryConfirm = () => {
  showClearHistoryConfirm.value = true;
};

/**
 * 清空历史记录
 */
const handleClearHistory = async () => {
  isClearing.value = true;
  try {
    await chatStore.clearHistory(activeAgentId.value);
    showClearHistoryConfirm.value = false;
  } catch (error: any) {
    console.error('清空记录失败:', error);
    toast.add({ severity: 'error', summary: '清空失败', detail: error?.message || '清空失败，请重试', life: 3000 });
  } finally {
    isClearing.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--bg)]">
    <!-- 聊天头部 -->
    <header class="h-16 border-b border-[var(--border)] flex items-center justify-between px-6 bg-[var(--surface-1)] shrink-0">
      <div class="flex items-center space-x-3 min-w-0">
        <div class="shrink-0">
          <div class="relative w-11 h-11 rounded-full overflow-hidden flex items-center justify-center"
               :class="session.icon === 'user' || session.icon === 'group' ? 'bg-[var(--primary-weak)]' : ''">
            <MoodGrid
              v-if="session.icon === 'agent' && (agentStore.moodColorsMap[activeAgentId]?.length ?? 0) > 0 && appStore.moodColorsEnabled"
              :mood-colors="agentStore.moodColorsMap[activeAgentId]"
              :enabled="appStore.moodColorsEnabled"
              class="absolute inset-0"
            />
            <User v-if="session.icon === 'user'" class="relative z-10 w-5 h-5 text-[var(--primary)]" />
            <Users v-else-if="session.icon === 'group'" class="relative z-10 w-5 h-5 text-[var(--primary)]" />
            <Bot v-else class="relative z-10 w-5 h-5" :class="isMoodDark(agentStore.moodColorsMap[activeAgentId]) ? 'text-white' : 'text-[var(--primary)]'" />
          </div>
        </div>
        <div class="min-w-0">
          <h2 class="font-bold text-[var(--text-1)] truncate">{{ session.title }}</h2>
          <div class="flex items-center text-xs text-[var(--text-3)]">
            <span v-if="session.icon === 'agent'" class="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
            <span class="truncate">{{ session.subtitle }}</span>
          </div>
          <!-- 描述行：仅群适配器提供（智能体适配器无该字段，不渲染） -->
          <div v-if="session.description" class="text-[11px] text-[var(--text-3)] truncate leading-tight mt-0.5">{{ session.description }}</div>
        </div>
      </div>
      <div class="flex items-center space-x-1">
        <Button
          v-if="session.showAutoReply"
          variant="text"
          rounded
          class="!p-2 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
          :class="{
            'auto-reply-active': autoReplyEnabled,
            '!text-[var(--primary)] !bg-[var(--primary-weak)]': isAutoReplyPanelOpen
          }"
          @click="toggleAutoReply"
          title="自动回复"
        >
          <Repeat class="w-4 h-4" :class="{ 'animate-reply-pulse': autoReplyEnabled }" />
        </Button>
        <Button
          v-if="session.showSearch"
          variant="text"
          rounded
          class="!p-2 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
          :class="{ '!text-[var(--primary)] !bg-[var(--primary-weak)]': isSearchActive }"
          @click="toggleSearch"
          title="搜索对话内容"
        >
          <Search class="w-4 h-4" />
        </Button>
        <Button
          variant="text"
          rounded
          class="!p-2 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
          @click="toggleMoreMenu"
          :disabled="isDeleting"
        >
          <MoreVertical class="w-4 h-4" />
        </Button>
        <Menu ref="moreMenuRef" :model="moreMenuItems" popup>
          <template #item="{ item }">
            <div class="flex items-center px-3 py-2" :class="{ 'opacity-50 cursor-not-allowed': item.disabled }">
              <FileText v-if="item.icon === 'files'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <History v-if="item.icon === 'history'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <CheckSquare v-if="item.icon === 'check-square'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <SlidersHorizontal v-if="item.icon === 'sliders-horizontal'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <Eraser v-if="item.icon === 'eraser'" class="w-4 h-4 mr-2 text-red-500" />
              <Trash2 v-if="item.icon === 'trash-2'" class="w-4 h-4 mr-2 text-red-500" />
              <UserPlus v-if="item.icon === 'user-plus'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <UserMinus v-if="item.icon === 'user-minus'" class="w-4 h-4 mr-2 text-[var(--text-1)]" />
              <XCircle v-if="item.icon === 'x-circle'" class="w-4 h-4 mr-2 text-red-500" />
              <span class="text-sm" :class="(item.icon === 'trash-2' || item.icon === 'eraser' || item.icon === 'x-circle') ? 'text-red-500' : 'text-[var(--text-1)]'">
                {{ item.label }}
              </span>
            </div>
          </template>
        </Menu>
      </div>
    </header>

    <!-- 自动回复面板 -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform -translate-y-2 opacity-0"
      enter-to-class="transform translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="transform translate-y-0 opacity-100"
      leave-to-class="transform -translate-y-2 opacity-0"
    >
      <div v-if="isAutoReplyPanelOpen" class="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 shrink-0">
        <div class="flex items-center space-x-3 max-w-4xl mx-auto">
          <!-- 启用开关 -->
          <label class="flex items-center space-x-2 text-sm text-[var(--text-2)] shrink-0">
            <input type="checkbox" v-model="autoReplyEnabled" @change="saveAutoReplyConfig"
              class="w-4 h-4 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]" />
            <span>启用</span>
          </label>
          <!-- 回复内容 -->
          <div class="flex-1">
            <input
              v-model="autoReplyContent"
              type="text"
              placeholder="回复内容，如：继续"
              class="w-full px-3 py-1.5 text-sm bg-[var(--surface-2)] border border-[var(--border)] rounded text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]"
              @blur="saveAutoReplyConfig"
            />
          </div>
          <!-- 延迟时间 -->
          <div class="flex items-center space-x-1 text-sm text-[var(--text-2)] shrink-0">
            <input
              v-model.number="autoReplyDelay"
              type="number"
              min="1"
              class="w-16 px-2 py-1.5 text-sm bg-[var(--surface-2)] border border-[var(--border)] rounded text-center text-[var(--text-1)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]"
              @blur="saveAutoReplyConfig"
            />
            <span>秒</span>
          </div>
          <Button
            variant="text"
            rounded
            class="!p-1.5 !text-[var(--text-3)] hover:!bg-[var(--surface-3)] shrink-0"
            @click="closeAutoReply"
            title="关闭"
          >
            <X class="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Transition>

    <!-- 搜索栏 -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform -translate-y-2 opacity-0"
      enter-to-class="transform translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="transform translate-y-0 opacity-100"
      leave-to-class="transform -translate-y-2 opacity-0"
    >
      <div v-if="isSearchActive" class="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 shrink-0 z-20 relative">
        <div class="flex items-center space-x-3 max-w-4xl mx-auto">
          <div class="flex-1 relative group/search">
            <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              ref="searchInputRef"
              v-model="searchKeyword"
              type="text"
              placeholder="搜索所有历史记录..."
              class="w-full pl-9 pr-4 py-1.5 text-sm bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]"
              @input="handleSearchInput"
              @keydown="handleSearchKeydown"
            />

            <!-- 搜索结果下拉面板 -->
            <div
              v-if="searchKeyword.trim() && (searchResults.length > 0 || isSearchingBackend)"
              class="absolute top-full left-0 right-0 mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-xl max-h-[400px] overflow-y-auto z-50"
            >
              <div v-if="isSearchingBackend" class="p-4 text-center text-[var(--text-3)] flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin mr-2" />
                搜索中...
              </div>
              <div v-else-if="searchResults.length === 0" class="p-4 text-center text-[var(--text-3)]">
                无匹配结果
              </div>
              <div v-else class="py-1">
                 <div class="px-3 py-1.5 text-xs font-medium text-[var(--text-3)] bg-[var(--surface-2)]">
                   找到 {{ searchResults.length }} 条结果
                 </div>
                 <div
                   v-for="result in searchResults"
                   :key="result.id"
                   class="px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer border-b border-[var(--border)] last:border-0 transition-colors"
                   @click="handleResultClick(result)"
                 >
                   <div class="flex items-center justify-between mb-1">
                     <span class="text-xs font-bold" :class="result.role === 'user' ? 'text-[var(--primary)]' : 'text-purple-500'">
                       {{ result.role === 'user' ? '我' : (activeAgent?.name || '智能体') }}
                     </span>
                     <span class="text-[10px] text-[var(--text-3)]">{{ formatDate(new Date(result.timestamp).toISOString()) }}</span>
                   </div>
                   <div class="text-sm text-[var(--text-2)] line-clamp-2 break-all" v-html="result.content"></div>
                 </div>
              </div>
            </div>
          </div>

          <Button
            variant="text"
            rounded
            class="!p-1.5 !text-[var(--text-3)] hover:!bg-[var(--surface-3)] shrink-0"
            @click="closeSearch"
            title="关闭搜索 (Esc)"
          >
            <X class="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Transition>

    <!-- 消息流区域 -->
    <div class="flex-grow overflow-hidden relative group/chat">
      <div ref="messageContainer" class="absolute inset-0 overflow-y-auto p-6 space-y-6">
        <!-- 空状态（无消息且无思考占位才显示） -->
        <div v-if="!(chatStore.chatMessages[activeAgentId] || []).length && !session.isThinking()" class="flex flex-col items-center justify-center h-full text-[var(--text-3)] space-y-4 opacity-50">
          <div class="p-4 rounded-2xl bg-[var(--surface-2)] border border-[var(--border)]">
            <Sparkles class="w-12 h-12" />
          </div>
          <div class="text-center">
            <p class="text-lg font-medium text-[var(--text-2)]">{{ session.emptyTitle }}</p>
            <p class="text-sm mt-1">{{ session.emptySubtitle }}</p>
          </div>
        </div>

        <!-- 消息列表 -->
        <div v-else class="mx-auto">
          <ChatMessageList
            :agent-id="activeAgentId"
            :org-id="orgId"
            :regeneration-agent-id="session.regenerationAgentId || undefined"
            :search-keyword="searchKeyword"
            :is-batch-mode="isBatchMode"
            v-model:selected-message-ids="selectedMessageIds"
            :is-thinking="session.isThinking()"
            :thinking-phase="session.thinkingPhase()"
            :on-navigate-sender="session.navigateSender"
          />
        </div>
      </div>

      <!-- 消息导航器（上下条） -->
      <MessageNavigator
        :container-el="messageContainer"
        :message-count="messageCount"
      />

      <!-- 滚动到底部按钮 -->
      <Transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="transform translate-y-4 opacity-0"
        enter-to-class="transform translate-y-0 opacity-100"
        leave-active-class="transition duration-200 ease-in"
        leave-from-class="transform translate-y-0 opacity-100"
        leave-to-class="transform translate-y-4 opacity-0"
      >
        <button
          v-if="showScrollBottomButton"
          @click="scrollToBottom(true)"
          class="absolute bottom-6 right-6 w-10 h-10 rounded-full bg-[var(--primary)] text-white shadow-lg flex items-center justify-center hover:bg-[var(--primary-hover)] transition-all z-30 group"
          title="滚动到底部"
        >
          <ArrowDown class="w-5 h-5 group-hover:translate-y-0.5 transition-transform" />
        </button>
      </Transition>
    </div>

    <!-- 输入区域 / 批量操作栏 -->
    <div class="p-6 border-t border-[var(--border)] bg-[var(--bg)]">
      <div class="max-w-4xl mx-auto relative group">

        <!-- 批量操作栏 -->
        <div v-if="isBatchMode" class="flex items-center justify-between bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div class="flex items-center space-x-4">
            <span class="text-sm font-medium text-[var(--text-1)]">已选择 {{ selectedMessageIds.length }} 条消息</span>
            <Button
              variant="text"
              class="!text-[var(--text-2)] !text-sm hover:!bg-[var(--surface-3)] !px-3 !py-1.5"
              @click="toggleBatchMode"
            >
              取消
            </Button>
          </div>
          <div class="flex items-center space-x-2">
            <Button
              severity="secondary"
              :disabled="selectedMessageIds.length === 0 || isExporting"
              class="!rounded-xl !px-4 !py-2 flex items-center space-x-2"
              @click="handleExportToPNG"
            >
              <Loader2 v-if="isExporting" class="w-4 h-4 animate-spin" />
              <Download v-else class="w-4 h-4" />
              <span>导出长图</span>
            </Button>
            <Button
              severity="danger"
              :disabled="selectedMessageIds.length === 0 || isBatchDeleting"
              class="!rounded-xl !px-4 !py-2 flex items-center space-x-2"
              @click="handleBatchDelete"
            >
              <Loader2 v-if="isBatchDeleting" class="w-4 h-4 animate-spin" />
              <Trash2 v-else class="w-4 h-4" />
              <span>删除</span>
            </Button>
          </div>
        </div>

        <!-- 生成回复按钮 - 当智能体空闲且最后一条是用户消息时显示 -->
        <div
          v-if="canShowGenerateReply"
          class="mb-3 flex justify-center"
        >
          <Button
            severity="secondary"
            class="!rounded-full !px-4 !py-1.5 !text-xs !font-medium !border-[var(--border)] !bg-[var(--surface-2)] hover:!bg-[var(--surface-3)] hover:!border-[var(--primary)] !text-[var(--text-2)] transition-all duration-200 flex items-center gap-1.5"
            @click="handleGenerateReply"
          >
            <Sparkles class="w-3.5 h-3.5" />
            生成回复
          </Button>
        </div>

        <!-- 推荐回复建议区域 -->
        <div v-if="isSuggestionsEnabled" class="mb-3 space-y-2">
          <div v-if="isLoadingSuggestions" class="flex items-center justify-center py-2">
            <Loader2 class="w-4 h-4 animate-spin text-[var(--text-3)]" />
            <span class="ml-2 text-xs text-[var(--text-3)]">生成建议中...</span>
          </div>
          <div v-else v-for="(sug, idx) in suggestions" :key="idx"
            class="px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:border-[var(--primary)] cursor-pointer transition-colors"
            @click="sendSuggestion(sug)">
            {{ sug }}
          </div>
        </div>

        <!-- 非阻塞设计：输入区域容器 -->
        <div class="input-area-container relative group">
          <div class="absolute -inset-0.5 bg-gradient-to-r from-[var(--primary)] to-blue-500 rounded-2xl blur opacity-0 group-focus-within:opacity-20 transition duration-500"></div>
          <div class="input-area relative flex items-center bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl p-2 pl-4 transition-all duration-300 group-focus-within:border-[var(--primary)]">
            <Textarea
              ref="messageTextareaRef"
              v-model="message"
              :placeholder="session.placeholder"
              :rows="1"
              class="flex-grow !bg-transparent !border-none !ring-0 !shadow-none !py-3 text-sm max-h-[50vh] chat-textarea"
              @keydown="handleKeydown"
              @input="autoResize"
              :disabled="!session.canSend"
            />
            <Button
              v-if="session.showSuggestions"
              variant="text"
              rounded
              @click="toggleSuggestions"
              :class="isSuggestionsEnabled ? '!text-[var(--primary)]' : '!text-[var(--text-3)]'"
              class="!p-2 hover:!bg-[var(--surface-3)] mx-0.5"
              title="推荐回复"
            >
              <Lightbulb class="w-4 h-4" />
            </Button>
            <Button
              ref="sendButtonRef"
              @click="sendMessage"
              :disabled="!message.trim() || isSending || !session.canSend"
              class="!rounded-xl !p-3 transition-all duration-200 min-w-[44px]"
              :class="message.trim() && !isSending && session.canSend
                ? '!bg-[var(--primary)] !text-white hover:!brightness-110 hover:!shadow-md'
                : '!bg-[var(--surface-3)] !text-[var(--text-3)]'"
            >
              <Loader2 v-if="isSending" class="w-4 h-4 animate-spin" />
              <Send v-else class="w-4 h-4" />
            </Button>


          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 删除确认对话框 -->
  <ConfirmDialog
    v-model:visible="showDeleteConfirm"
    title="删除智能体"
    :message="deleteConfirmMessage"
    confirm-label="删除"
    cancel-label="取消"
    confirm-severity="danger"
    :loading="isDeleting"
    @confirm="handleDeleteAgent"
  />

  <!-- 清空历史确认对话框 -->
  <ConfirmDialog
    v-model:visible="showClearHistoryConfirm"
    title="清空聊天记录"
    message="确定要清空所有聊天记录吗？此操作无法撤销。"
    confirm-label="清空"
    cancel-label="取消"
    confirm-severity="danger"
    :loading="isClearing"
    @confirm="handleClearHistory"
  />

</template>

<style scoped>
/* ============================================
   Non-Blocking Design
   非阻塞设计：确保输入框和按钮始终可交互
   基于docs/新手引导功能用户体验设计方案_v4.md
   ============================================ */

/* 输入区域容器 */
.input-area-container {
  position: relative;
  pointer-events: auto;  /* 始终可交互 */
}

.input-area {
  position: relative;
  pointer-events: auto;  /* 始终可交互 */
}

/* 输入框和发送按钮保持最高优先级 */
.input-area > :deep(.p-textarea),
.input-area > button {
  position: relative;
  pointer-events: auto;  /* 始终可交互 */
}

/* ============================================
   自定义输入框样式，确保 PrimeVue 默认样式不冲突
   ============================================ */

/* 覆盖 PrimeVue Textarea 默认样式 */
:deep(.p-textarea),
:deep(.p-textarea:focus),
:deep(.p-textarea.p-focus) {
  background: transparent !important;
  border: none !important;
  border-color: transparent !important;
  box-shadow: none !important;
  outline: none !important;
  resize: none !important;
  overflow: hidden !important;
  min-height: unset !important;
  field-sizing: content !important;
}

/* ============================================
   搜索高亮样式
   ============================================ */

:deep(.search-highlight) {
  background-color: rgba(250, 204, 21, 0.4);
  border-radius: 2px;
  padding: 0 2px;
  color: inherit;
}

:deep(.search-highlight-current) {
  background-color: rgba(250, 204, 21, 0.8);
  box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.5);
  animation: searchPulse 1.5s ease-in-out infinite;
}

@keyframes searchPulse {
  0%, 100% {
    box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.5);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.3);
  }
}

/* 深色模式适配 */
.my-app-dark :deep(.search-highlight) {
  background-color: rgba(234, 179, 8, 0.3);
}

.my-app-dark :deep(.search-highlight-current) {
  background-color: rgba(234, 179, 8, 0.7);
  box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.4);
  animation: searchPulseDark 1.5s ease-in-out infinite;
}

@keyframes searchPulseDark {
  0%, 100% {
    box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(234, 179, 8, 0.2);
  }
}

/* ============================================
   Responsive Design
   响应式适配
   ============================================ */

/* 移动端 */
@media (max-width: 768px) {
  /* 移动端特定样式 */
}

/* 小屏手机 */
@media (max-width: 480px) {
  /* 小屏手机特定样式 */
}

/* ============================================
   Accessibility
   可访问性
   ============================================ */

/* 禁用默认焦点样式，发光效果由外层 blur 实现 */
.input-area > :deep(.p-textarea:focus),
.input-area > button:focus-visible {
  outline: none !important;
}

/* ============================================
   自动回复按钮动画
   ============================================ */

.auto-reply-active {
  position: relative;
}

/* 脉冲光环 */
.auto-reply-active::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 2px solid var(--primary);
  animation: auto-reply-ring 1.8s ease-in-out infinite;
  pointer-events: none;
}

@keyframes auto-reply-ring {
  0% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 0;
    transform: scale(1.25);
  }
  100% {
    opacity: 0;
    transform: scale(1.25);
  }
}

/* 图标呼吸 + 旋转 */
.animate-reply-pulse {
  animation: auto-reply-breath 1.8s ease-in-out infinite;
}

@keyframes auto-reply-breath {
  0% {
    opacity: 0.5;
    transform: rotate(0deg) scale(0.9);
    color: var(--text-3);
  }
  50% {
    opacity: 1;
    transform: rotate(180deg) scale(1.1);
    color: var(--primary);
  }
  100% {
    opacity: 0.5;
    transform: rotate(360deg) scale(0.9);
    color: var(--text-3);
  }
}
</style>
