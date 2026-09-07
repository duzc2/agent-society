<script setup lang="ts">
import { ref, computed } from 'vue';
import { User, Bot, Sparkles, Wrench, ChevronDown, ChevronUp, FileText, FileCode, File, Edit2, Trash2, CheckSquare, Square, Loader2, Copy, Check, Clock, Database, BookOpen } from 'lucide-vue-next';
import MoodGrid from '../common/MoodGrid.vue';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agent';
import { useAppStore } from '../../stores/app';
import { useOrgStore } from '../../stores/org';
import { fileViewerService } from '../file-viewer/services/fileViewerService';
import { isMoodDark } from '../../utils/moodColors';
import MessageContent from './MessageContent.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import Textarea from 'primevue/textarea';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';

const toast = useToast();

const props = defineProps<{
  agentId: string;
  regenerationAgentId?: string;
  orgId?: string;
  // 是否只显示当前会话的消息（过滤掉旧消息）
  onlyCurrentSession?: boolean;
  // 搜索关键词
  searchKeyword?: string;
  isBatchMode?: boolean;
  selectedMessageIds?: string[];
  // 智能体是否正在运算（非 idle），用于显示思考占位
  isThinking?: boolean;
  thinkingPhase?: string | null;
  // 点发送者名导航回调（群会话注入：user 短路 + 智能体跳个人对话）
  onNavigateSender?: (agentId: string, messageId: string) => void;
}>();

const emit = defineEmits<{
  (e: 'update:selectedMessageIds', ids: string[]): void;
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const appStore = useAppStore();
const orgStore = useOrgStore();

const expandedToolCalls = ref<Record<string, boolean>>({});
const expandedReasoning = ref<Record<string, boolean>>({});
const expandedGroups = ref<Record<string, boolean>>({});
const expandedMemoryContext = ref<Record<string, boolean>>({});
const expandedKnowledgeContext = ref<Record<string, boolean>>({});

// 展开区懒加载状态（服务端推送为裁剪存根，展开时经 detail 端点按消息 ID 回查全量）
const detailLoading = ref<Record<string, boolean>>({});
const detailError = ref<Record<string, boolean>>({});

// 编辑状态
const editingMessageId = ref<string | null>(null);
const editContent = ref('');
const isSavingEdit = ref(false);
const regeneratingMessageId = ref<string | null>(null);
const copiedMessageId = ref<string | null>(null);

// 单条删除确认
const showDeleteOneConfirm = ref(false);
const deleteOneId = ref<string | string[] | null>(null);
const isDeletingOne = ref(false);

// 悬停详情
const hoveredAgentId = ref<string | null>(null);
const tooltipPosition = ref({ x: 0, y: 0 });
const tooltipTimer = ref<any>(null);

// Token tooltip 状态
const tokenTooltip = ref<{
  show: boolean;
  x: number;
  y: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}>({ show: false, x: 0, y: 0, usage: null });

// 多收件人弹窗状态
const multiReceiverPopup = ref<{
  show: boolean;
  x: number;
  y: number;
  receivers: string[];
}>({ show: false, x: 0, y: 0, receivers: [] });

let popupHideTimer: any = null;
let isMouseOverPopup = false;

const showMultiReceiverPopup = (event: MouseEvent, receivers: string[]) => {
  // 清除关闭定时器
  if (popupHideTimer) {
    clearTimeout(popupHideTimer);
    popupHideTimer = null;
  }
  const rect = (event.target as HTMLElement).getBoundingClientRect();
  multiReceiverPopup.value = {
    show: true,
    x: rect.left + rect.width / 2,
    y: rect.bottom + 4,
    receivers
  };
};

const hideMultiReceiverPopup = () => {
  // 延迟关闭，给鼠标移动到弹窗的时间
  popupHideTimer = setTimeout(() => {
    if (!isMouseOverPopup) {
      multiReceiverPopup.value.show = false;
    }
  }, 100);
};

const handlePopupMouseEnter = () => {
  isMouseOverPopup = true;
  if (popupHideTimer) {
    clearTimeout(popupHideTimer);
    popupHideTimer = null;
  }
};

const handlePopupMouseLeave = () => {
  isMouseOverPopup = false;
  multiReceiverPopup.value.show = false;
};

const showTokenTooltip = (event: MouseEvent, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => {
  const rect = (event.target as HTMLElement).getBoundingClientRect();
  tokenTooltip.value = {
    show: true,
    x: rect.left + rect.width / 2,
    y: rect.bottom + 4,
    usage
  };
};

const hideTokenTooltip = () => {
  tokenTooltip.value.show = false;
};



const handleMouseEnter = (event: MouseEvent, agentId: string) => {
  if (agentId === 'user' || agentId === 'system') return;
  
  // 清除之前的定时器
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  // 设置延迟显示，避免快速划过时闪烁
  tooltipTimer.value = setTimeout(() => {
    hoveredAgentId.value = agentId;
    // 获取元素位置，让 tooltip 出现在元素上方
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    tooltipPosition.value = {
      x: rect.left + rect.width / 2,
      y: rect.top
    };
  }, 400);
};

const handleMouseLeave = () => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  hoveredAgentId.value = null;
};

// 处理收件人悬停：单人显示原有 tooltip，多人显示弹窗
const handleReceiverMouseEnter = (event: MouseEvent, item: any) => {
  if (item._mergedReceivers && item._mergedReceivers.length > 1) {
    // 多人情况：显示多收件人弹窗
    showMultiReceiverPopup(event, item._mergedReceivers);
  } else {
    // 单人情况：使用原有 tooltip
    handleMouseEnter(event, item.receiverId);
  }
};

const handleReceiverMouseLeave = () => {
  hideMultiReceiverPopup();
  handleMouseLeave();
};

const hoveredAgent = computed(() => {
  if (!hoveredAgentId.value) return null;
  return findAgentById(hoveredAgentId.value);
});

/** 当前智能体名称（用于思考占位显示） */
const agentName = computed(() => {
  return findAgentById(props.agentId)?.name || '智能体';
});

/**
 * 当前允许执行“重新生成”的目标智能体。
 * user 视图下，显示的消息来自 user 日志，但真正可重生的目标应是当前对话智能体。
 */
const currentRegenerationAgent = computed(() => {
  if (!props.regenerationAgentId) return null;
  return findAgentById(props.regenerationAgentId);
});

/**
 * 当前目标智能体最后一条允许“重新生成”的回复消息 ID。
 */
const regenerableMessageId = computed(() => {
  if (!props.regenerationAgentId) return null;
  return chatStore.regenerableMessageIds[props.regenerationAgentId] || null;
});

const toggleGroup = (groupId: string) => {
  expandedGroups.value[groupId] = !expandedGroups.value[groupId];
};

const toggleToolCall = (msgId: string) => {
  expandedToolCalls.value[msgId] = !expandedToolCalls.value[msgId];
};

const parseJson = (str: any) => {
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
};

const toggleReasoning = (msgId: string) => {
  expandedReasoning.value[msgId] = !expandedReasoning.value[msgId];
};

const toggleMemoryContext = (msgId: string) => {
  expandedMemoryContext.value[msgId] = !expandedMemoryContext.value[msgId];
};

const toggleKnowledgeContext = (msgId: string) => {
  expandedKnowledgeContext.value[msgId] = !expandedKnowledgeContext.value[msgId];
};

/**
 * 展开区懒加载判定：某区块是否需要拉取详情。
 * 依据服务端存根布尔 hasXxx 与本地内容 undefined 的组合。
 */
const needsSectionDetail = (item: any, section: 'reasoning' | 'memory' | 'knowledge' | 'tool'): boolean => {
  if (section === 'reasoning') return item.hasReasoning === true && item.reasoning === undefined;
  if (section === 'memory') return item.hasMemoryContext === true && item.memoryContext === undefined;
  if (section === 'knowledge') return item.hasKnowledgeContext === true && item.knowledgeContext === undefined;
  // 工具正文：args 或 result 正文任一未下发即需要拉取
  if (item.type !== 'tool_call' && !item.toolCall) return false;
  const argsMissing = item.toolCall?.args === undefined;
  const resultMissing = item.toolCall?.hasResult === true && item.toolCall?.result === undefined;
  return argsMissing || resultMissing;
};

/**
 * 展开时确保详情已在手：需要且未在加载时触发懒加载。
 * store 的 loadMessageDetail 有 in-flight 去重；此处维护局部 loading/error 态供三分支渲染。
 */
const ensureDetail = (item: any, sections: Array<'reasoning' | 'memory' | 'knowledge' | 'tool'>) => {
  const needed = sections.filter(section => needsSectionDetail(item, section));
  if (needed.length === 0) return;
  if (detailLoading.value[item.id] || detailError.value[item.id]) return;
  detailLoading.value[item.id] = true;
  detailError.value[item.id] = false;
  chatStore.loadMessageDetail(item.agentId || props.agentId, item.id).then(() => {
    detailLoading.value[item.id] = false;
    // 加载完成后从 store 重读最新消息判定（item 可能是 currentMessages 计算属性
    // 产出的浅拷贝，详情写入了 store 的原始消息，用旧拷贝判定会误标错误）
    const fresh = (chatStore.chatMessages[item.agentId || props.agentId] || [])
      .find(m => m.id === item.id);
    if (!fresh) return;
    const still = needed.filter(section => needsSectionDetail(fresh, section));
    if (still.length > 0) {
      detailError.value[item.id] = true;
    }
  });
};

const retryDetail = (item: any, sections: Array<'reasoning' | 'memory' | 'knowledge' | 'tool'>) => {
  detailError.value[item.id] = false;
  ensureDetail(item, sections);
};

const currentMessages = computed(() => {
  let msgs = props.onlyCurrentSession 
    ? chatStore.getSessionMessages(props.agentId)
    : (chatStore.chatMessages[props.agentId] || []);
  
  let filteredMsgs = msgs;
  
  // 如果当前是 user 视图，过滤出与当前组织成员相关的消息
  if (props.agentId === 'user' && props.orgId) {
    const orgAgentIds = (agentStore.agentsMap[props.orgId] || [])
      .map(a => a.id)
      .filter(id => id !== 'user');

    filteredMsgs = msgs.filter(m => {
      const isFromOrgAgent = m.senderId !== 'user' && orgAgentIds.includes(m.senderId);
      const isToOrgAgent = m.receiverId && orgAgentIds.includes(m.receiverId);
      return isFromOrgAgent || isToOrgAgent;
    });
  }
  
  // 第一步：合并同一发送者、同一内容、近似时间的多目标消息
  const MERGE_TIME_WINDOW = 5000; // 5秒内的消息认为是同一批发送
  const mergedMsgs: any[] = [];
  
  for (const msg of filteredMsgs) {
    // 这里使用浅拷贝构造展示对象，避免在计算属性重算时直接污染 store 内的原始消息对象。
    // 否则 _mergedReceivers 这类临时展示字段会被重复累积，导致同一收件人被渲染多次。
    const displayMsg: any = { ...msg };
    delete displayMsg._mergedReceivers;

    // 工具调用不合并
    if (displayMsg.toolCall) {
      mergedMsgs.push(displayMsg);
      continue;
    }
    
    // 查找是否可以合并的前一条消息
    const lastMsg = mergedMsgs.length > 0 ? mergedMsgs[mergedMsgs.length - 1] : null;
    const canMerge = lastMsg && 
      !lastMsg.toolCall &&
      lastMsg.senderId === displayMsg.senderId &&
      lastMsg.content === displayMsg.content &&
      lastMsg.type === displayMsg.type &&
      Math.abs(lastMsg.timestamp - displayMsg.timestamp) < MERGE_TIME_WINDOW;
    
    if (canMerge) {
      // 合并到前一条消息
      if (!lastMsg._mergedReceivers) {
        lastMsg._mergedReceivers = [lastMsg.receiverId];
      }
      // 这里必须去重，避免“乐观消息 + 后端真实消息”或其他重复数据把同一收件人渲染成多次。
      if (!lastMsg._mergedReceivers.includes(displayMsg.receiverId)) {
        lastMsg._mergedReceivers.push(displayMsg.receiverId);
      }
      // 保留最早的时间戳，或者可以更新为最新的
      // lastMsg.timestamp = msg.timestamp;
    } else {
      mergedMsgs.push(displayMsg);
    }
  }
  
  // 第二步：处理连续的函数调用折叠逻辑
  const groupedMsgs: any[] = [];
  let currentGroup: any = null;

  mergedMsgs.forEach((msg) => {
    const isToolCall = !!msg.toolCall;
    
    if (isToolCall) {
      if (!currentGroup) {
        currentGroup = {
          id: `group-${msg.id}`,
          type: 'tool-group',
          senderId: msg.senderId,
          receiverId: msg.receiverId,
          senderType: msg.senderType,
          timestamp: msg.timestamp,
          messages: [msg]
        };
        groupedMsgs.push(currentGroup);
      } else if (currentGroup.senderId === msg.senderId && currentGroup.receiverId === msg.receiverId) {
        currentGroup.messages.push(msg);
      } else {
        currentGroup = {
          id: `group-${msg.id}`,
          type: 'tool-group',
          senderId: msg.senderId,
          receiverId: msg.receiverId,
          senderType: msg.senderType,
          timestamp: msg.timestamp,
          messages: [msg]
        };
        groupedMsgs.push(currentGroup);
      }
    } else {
      currentGroup = null;
      groupedMsgs.push(msg);
    }
  });
  
  return groupedMsgs;
});

const getSenderName = (msg: any) => {
  if (msg.senderType === 'user') return '我';
  // 群来源消息（extras.senderAgentId 存在）：发送者为群身份，显示"群聊 X"
  if (msg.senderAgentId) return '群聊 ' + (msg.groupName || msg.senderId);
  const agent = findAgentById(msg.senderId);
  return agent ? agent.name : msg.senderId;
};

const getReceiverName = (msg: any) => {
  // 处理合并的多目标消息
  if (msg._mergedReceivers && msg._mergedReceivers.length > 1) {
    const names = msg._mergedReceivers.map((id: string) => {
      if (id === 'user') return '我';
      const agent = findAgentById(id);
      return agent ? agent.name : id;
    });
    // 去重展示名称，避免不同重复数据或同名收件人把同一个名字渲染多次。
    const uniqueNames = [...new Set(names)];
    // 如果人数太多，显示前几个 + 等多人
    if (uniqueNames.length > 3) {
      return uniqueNames.slice(0, 3).join('、') + `等${uniqueNames.length}人`;
    }
    return uniqueNames.join('、');
  }
  
  // 单目标
  if (!msg.receiverId) return null;
  if (msg.receiverId === 'user') return '我';
  const agent = findAgentById(msg.receiverId);
  return agent ? agent.name : msg.receiverId;
};

const findAgentById = (id: string) => {
  // 1. 先从全局列表中找（最全，支持跨组织）
  const globalAgent = agentStore.allAgents.find(a => a.id === id);
  if (globalAgent) return globalAgent;

  // 2. 兜底：从各组织 Map 中找
  for (const orgId in agentStore.agentsMap) {
    const agents = agentStore.agentsMap[orgId];
    if (agents) {
      const agent = agents.find(a => a.id === id);
      if (agent) return agent;
    }
  }
  return null;
};

/**
 * 跳转到指定智能体的对话位置
 */
const navigateToMessage = (agentId: string, messageId: string) => {
  // 注入导航回调（群会话）：由回调决定行为（user 短路 + 智能体跳个人对话）
  if (props.onNavigateSender) {
    props.onNavigateSender(agentId, messageId);
    return;
  }

  let targetOrgId = '';
  let targetAgentId = agentId;

  if (agentId === 'user') {
    // 如果点击的是 user，优先跳转到当前组件所属的组织（保持上下文）
    targetOrgId = props.orgId || 'home';
  } else {
    // 如果点击的是智能体，通过智能体信息定位组织
    const agent = findAgentById(agentId);
    if (!agent) return;
    targetOrgId = agent.orgId;
  }

  // 设置待滚动消息 ID
  chatStore.pendingScrollMessageId = messageId;
  
  // 切换智能体和组织
  chatStore.setActiveAgent(targetOrgId, targetAgentId);
  
  // 确定组织名称
  let orgName = targetOrgId === 'home' ? '首页' : '组织';
  
  // 优先从已打开的标签中找名称
  const existingTab = appStore.activeTabs.find(t => t.id === targetOrgId);
  if (existingTab) {
    orgName = existingTab.title;
  } else {
    // 其次从组织仓库中找名称
    const org = orgStore.orgs.find(o => o.id === targetOrgId);
    if (org) orgName = org.name;
  }

  // 打开或切换标签页
  appStore.openTab({
    id: targetOrgId,
    type: 'org',
    title: orgName
  });
};

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
};

/**
 * 获取延迟消息信息
 */
const getDelayInfo = (item: any) => {
  // 已投递：显示投递信息
  if (item.deliveredAt) {
    if (item.sendTime) {
      const d = new Date(item.sendTime);
      const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return { detail: `于 ${time} 发送` };
    }
    return { detail: '已送达' };
  }
  // 未投递：显示预计送达时间
  if (item.scheduledDeliveryTime) {
    const d = new Date(item.scheduledDeliveryTime);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return { detail: `预计送达 ${time}` };
  }
  return null;
};

/**
 * 渲染带高亮的消息内容
 * @param content 消息内容
 * @param messageId 消息ID
 */
const renderHighlightedContent = (content: string, messageId: string): string => {
  if (!props.searchKeyword || !props.searchKeyword.trim()) return content;
  
  const keyword = props.searchKeyword.trim();
  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedKeyword})`, 'gi');
  
  return content.replace(regex, `<mark class="search-highlight" data-message-id="${messageId}">$1</mark>`);
};

/**
 * 计算工具调用组的总 Token 数
 */
const getGroupTotalTokens = (messages: any[]): number => {
  return messages.reduce((sum: number, m: any) => sum + (m.usage?.totalTokens || 0), 0);
};

/**
 * 计算工具调用组的总输入 Token 数
 */
const getGroupPromptTokens = (messages: any[]): number => {
  return messages.reduce((sum: number, m: any) => sum + (m.usage?.promptTokens || 0), 0);
};

/**
 * 计算工具调用组的总输出 Token 数
 */
const getGroupCompletionTokens = (messages: any[]): number => {
  return messages.reduce((sum: number, m: any) => sum + (m.usage?.completionTokens || 0), 0);
};

/**
 * 获取工具调用组中的所有文件
 * 遍历组内所有消息，收集每个工具调用产生的文件
 * @param messages 组内消息数组
 * @returns 文件列表数组（已排序，图片在前）
 */
const getGroupFiles = (messages: any[]): Array<{path: string; size: number; mimeType?: string; workspaceId?: string}> => {
  const allFiles: Array<{path: string; size: number; mimeType?: string; workspaceId?: string}> = [];
  for (const msg of messages) {
    const files = getFilesFromPayload(msg);
    if (files.length > 0) {
      allFiles.push(...files);
    }
  }
  return sortFiles(allFiles);
};

/**
 * 从消息中提取文件列表
 * 检查位置：toolCall.result.files (工具调用结果) 或 payload.result.files (直接payload)
 * @param item 消息对象
 * @returns 文件列表数组，包含 workspaceId
 */
const getFilesFromPayload = (item: any): Array<{path: string; size: number; mimeType?: string; workspaceId?: string}> => {
  // 1. 首先检查 toolCall.result.files (API层将payload.result映射到这里)
  if (item.toolCall?.result?.files && Array.isArray(item.toolCall.result.files)) {
    return item.toolCall.result.files;
  }
  
  // 2. 检查原始 payload.result.files
  if (!item.payload) return [];
  
  let payload = item.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      return [];
    }
  }
  
  const files = payload?.result?.files;
  if (Array.isArray(files)) {
    return files;
  }
  return [];
};

/**
 * 根据 MIME 类型获取对应的图标组件
 * @param mimeType MIME 类型
 */
const getFileIcon = (mimeType?: string) => {
  if (!mimeType) return File;
  if (mimeType.includes('text') || mimeType.includes('markdown')) return FileText;
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('typescript')) return FileCode;
  return File;
};

/**
 * 从文件路径中提取文件名
 * @param path 文件路径
 * @returns 文件名
 */
const getFileName = (path: string): string => {
  if (!path) return '未知文件';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/**
 * 判断文件是否为图片
 * @param mimeType MIME 类型
 * @returns 是否为图片
 */
const isImage = (mimeType?: string): boolean => {
  if (!mimeType) return false;
  return mimeType.startsWith('image/');
};

/**
 * 获取文件缩略图 URL
 * @param filePath 文件路径
 * @returns 缩略图 URL
 */
const getThumbnailUrl = (filePath: string): string => {
  const workspaceId = props.orgId;
  if (!workspaceId) return '';
  return fileViewerService.getRawFileUrl(workspaceId, filePath);
};

/**
 * 对文件列表进行排序，图片排在前面
 * @param files 文件列表
 * @returns 排序后的文件列表
 */
const sortFiles = (files: Array<{path: string; size: number; mimeType?: string}>): Array<{path: string; size: number; mimeType?: string}> => {
  return [...files].sort((a, b) => {
    const aIsImage = isImage(a.mimeType);
    const bIsImage = isImage(b.mimeType);
    if (aIsImage && !bIsImage) return -1;
    if (!aIsImage && bIsImage) return 1;
    return 0;
  });
};

/**
 * 处理文件点击 - 打开文件查看器
 * @param file 文件对象 {path, size, mimeType}
 */
const handleFileClick = (file: {path: string; size: number; mimeType?: string} | undefined) => {
  console.log('[ChatMessageList] 点击文件:', file);
  
  if (!file?.path) {
    console.warn('[ChatMessageList] 文件路径为空');
    return;
  }
  
  // 使用 orgId 作为 workspaceId（组织ID就是工作空间ID）
  const workspaceId = props.orgId;
  if (!workspaceId) {
    console.warn('[ChatMessageList] orgId 为空，无法确定工作空间');
    return;
  }
  
  const fileName = getFileName(file.path);
  
  console.log('[ChatMessageList] 打开文件:', { workspaceId, filePath: file.path, fileName });
  
  fileViewerService.openFile({
    workspaceId,
    filePath: file.path,
    fileName
  });
};

/**
 * 处理选择/取消选择消息
 */
const toggleSelection = (id: string) => {
  if (!props.selectedMessageIds) return;
  
  const newSelection = [...props.selectedMessageIds];
  const index = newSelection.indexOf(id);
  
  if (index > -1) {
    newSelection.splice(index, 1);
  } else {
    newSelection.push(id);
  }
  
  emit('update:selectedMessageIds', newSelection);
};

/**
 * 处理工具组的选择/取消选择
 */
const toggleGroupSelection = (messages: any[]) => {
  if (!props.selectedMessageIds) return;
  
  const ids = messages.map(m => m.id);
  const newSelection = [...props.selectedMessageIds];
  
  // 检查是否全选
  const allSelected = ids.every(id => newSelection.includes(id));
  
  if (allSelected) {
    // 取消全选
    ids.forEach(id => {
      const index = newSelection.indexOf(id);
      if (index > -1) newSelection.splice(index, 1);
    });
  } else {
    // 全选
    ids.forEach(id => {
      if (!newSelection.includes(id)) newSelection.push(id);
    });
  }
  
  emit('update:selectedMessageIds', newSelection);
};

/**
 * 判断消息是否被选中
 */
const isSelected = (id: string) => {
  return props.selectedMessageIds?.includes(id) || false;
};

/**
 * 判断工具组是否被选中（只要有一个被选中就算选中，用于UI显示）
 * 或者严格全选？通常 checkbox 是全选状态。
 */
const isGroupSelected = (messages: any[]) => {
  if (!props.selectedMessageIds || props.selectedMessageIds.length === 0) return false;
  // 只要组内所有消息都被选中，才算选中
  return messages.every(m => props.selectedMessageIds!.includes(m.id));
};

/**
 * 开始编辑消息
 */
const startEdit = (msg: any) => {
  editingMessageId.value = msg.id;
  editContent.value = msg.content || '';
};

/**
 * 取消编辑
 */
const cancelEdit = () => {
  editingMessageId.value = null;
  editContent.value = '';
};

/**
 * 保存编辑
 */
const saveEdit = async () => {
  if (!editingMessageId.value || !editContent.value.trim()) return;
  
  isSavingEdit.value = true;
  try {
    await chatStore.updateMessage(props.agentId, editingMessageId.value, editContent.value);
    cancelEdit();
  } catch (error: any) {
    console.error('更新消息失败:', error);
    toast.add({ severity: 'error', summary: '更新失败', detail: error?.message || '更新失败', life: 3000 });
  } finally {
    isSavingEdit.value = false;
  }
};

/**
 * 构建消息复制文本。
 * 复制内容尽量与当前界面可见信息保持一致，避免用户复制到与界面不一致的结果。
 */
const buildCopyTextForMessage = (msg: any): string => {
  const parts: string[] = [];

  if (typeof msg?.reasoning === 'string' && msg.reasoning.trim()) {
    parts.push(`思考过程:\n${msg.reasoning.trim()}`);
  }

  if (msg?.toolCall) {
    const toolName = typeof msg.toolCall.name === 'string' ? msg.toolCall.name : 'unknown';
    parts.push(`工具调用: ${toolName}`);

    if (msg.toolCall.args !== undefined) {
      parts.push(`参数:\n${JSON.stringify(parseJson(msg.toolCall.args), null, 2)}`);
    }

    if (msg.toolCall.result !== undefined) {
      parts.push(`结果:\n${JSON.stringify(parseJson(msg.toolCall.result), null, 2)}`);
    }
  }

  if (typeof msg?.content === 'string' && msg.content.trim()) {
    parts.push(msg.content.trim());
  }

  if (parts.length === 0 && msg?.payload) {
    parts.push(JSON.stringify(msg.payload, null, 2));
  }

  return parts.join('\n\n').trim();
};

/**
 * 复制单条消息内容到剪贴板。
 * 成功后短暂记录消息 ID，给操作菜单提供已复制的轻量反馈。
 */
const copyMessageContent = async (msg: any) => {
  const text = buildCopyTextForMessage(msg);
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    copiedMessageId.value = msg.id;
    setTimeout(() => {
      if (copiedMessageId.value === msg.id) {
        copiedMessageId.value = null;
      }
    }, 2000);
  } catch (error) {
    console.error('复制消息失败:', error);
    toast.add({ severity: 'error', summary: '复制失败', detail: '复制失败', life: 3000 });
  }
};

/**
 * 判断某条消息是否显示“重新生成”按钮。
 */
const canRegenerateMessage = (msg: any) => {
  if (props.isBatchMode) return false;
  if (!props.regenerationAgentId) return false;
  if (editingMessageId.value === msg.id) return false;
  if (msg.senderType === 'user') return false;
  if (msg.toolCall) return false;
  if (msg.senderId !== props.regenerationAgentId) return false;
  if (msg.id !== regenerableMessageId.value) return false;
  return currentRegenerationAgent.value?.status === 'online';
};

/**
 * 重新生成最后一条大模型回复。
 */
const regenerateMessage = async (msg: any) => {
  if (!props.regenerationAgentId) return;
  if (!canRegenerateMessage(msg)) return;

  regeneratingMessageId.value = msg.id;
  try {
    await chatStore.regenerateMessage(props.regenerationAgentId, msg.id);
  } catch (error: any) {
    console.error('重新生成消息失败:', error);
    toast.add({ severity: 'error', summary: '重新生成失败', detail: error?.message || '重新生成失败', life: 3000 });
  } finally {
    regeneratingMessageId.value = null;
  }
};

/**
 * 确认删除单条消息
 */
const confirmDeleteOne = (idOrIds: string | string[]) => {
  // 如果传入的是逗号分隔的字符串（hacky way from template），转回数组
  if (typeof idOrIds === 'string' && idOrIds.includes(',')) {
      deleteOneId.value = idOrIds.split(',');
  } else {
      deleteOneId.value = idOrIds;
  }
  showDeleteOneConfirm.value = true;
};

/**
 * 执行删除单条消息
 */
const executeDeleteOne = async () => {
  if (!deleteOneId.value) return;
  
  isDeletingOne.value = true;
  try {
    if (Array.isArray(deleteOneId.value)) {
        await chatStore.deleteMessages(props.agentId, deleteOneId.value);
    } else {
        await chatStore.deleteMessage(props.agentId, deleteOneId.value as string);
    }
    showDeleteOneConfirm.value = false;
    deleteOneId.value = null;
  } catch (error: any) {
    console.error('删除消息失败:', error);
    toast.add({ severity: 'error', summary: '删除失败', detail: error?.message || '删除失败', life: 3000 });
  } finally {
    isDeletingOne.value = false;
  }
};
</script>

<template>
  <div class="space-y-6">
    <!-- 加载更多历史指示器 -->
    <div v-if="chatStore.isLoadingMore[agentId]" class="flex justify-center py-2">
      <Loader2 class="w-5 h-5 animate-spin text-[var(--primary)]" />
    </div>

    <!-- 上下文模式提示 -->
    <div v-if="chatStore.isContextMode[agentId]" class="flex justify-center py-2 sticky top-0 z-20">
      <div class="bg-[var(--surface-3)] text-[var(--text-2)] text-xs px-3 py-1 rounded-full shadow-sm flex items-center space-x-2">
        <Sparkles class="w-3 h-3" />
        <span>正在查看历史上下文</span>
        <button class="text-[var(--primary)] hover:underline ml-2" @click="chatStore.exitContextMode(agentId)">返回最新</button>
      </div>
    </div>

    <template v-for="item in currentMessages" :key="item.id">
      <!-- 群系统消息（居中灰色胶囊） -->
      <div v-if="item.isSystem" class="flex justify-center py-1.5">
        <span class="text-xs text-[var(--text-3)] bg-[var(--surface-3)] px-3 py-1 rounded-full">
          {{ item.content }}
        </span>
      </div>

      <!-- 普通消息 -->
      <div
        v-else-if="item.type !== 'tool-group'"
        :id="'msg-' + item.id"
        class="flex group relative pl-8 pr-2 transition-colors duration-200 rounded-lg hover:bg-[var(--surface-2)]/50"
        :class="item.senderType === 'user' ? 'justify-end' : 'justify-start'"
      >
        <!-- 批量选择 Checkbox -->
        <div v-if="isBatchMode" class="absolute left-0 top-3 flex items-center justify-center w-8 h-8 cursor-pointer z-10" @click.stop="toggleSelection(item.id)">
          <CheckSquare v-if="isSelected(item.id)" class="w-5 h-5 text-[var(--primary)]" />
          <Square v-else class="w-5 h-5 text-[var(--text-3)]" />
        </div>

        <!-- 悬停操作栏 (非批量模式) -->
        <div 
          class="flex max-w-[90%] items-start space-x-3"
          :class="item.senderType === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'"
        >
          <!-- 头像 -->
          <div class="shrink-0">
            <div class="relative w-9 h-9 rounded-full overflow-hidden border border-[var(--border)] flex items-center justify-center"
                 :class="item.senderType === 'user' ? 'bg-[var(--surface-3)]' : ''">
              <MoodGrid
                v-if="item.senderType !== 'user' && (agentStore.moodColorsMap[item.senderId]?.length ?? 0) > 0 && appStore.moodColorsEnabled"
                :mood-colors="agentStore.moodColorsMap[item.senderId]"
                :enabled="appStore.moodColorsEnabled"
                class="absolute inset-0"
              />
              <User v-if="item.senderType === 'user'" class="relative z-10 w-4 h-4 text-[var(--text-2)]" />
              <Bot v-else class="relative z-10 w-4 h-4" :class="isMoodDark(agentStore.moodColorsMap[item.senderId]) ? 'text-white' : 'text-[var(--primary)]'" />
            </div>
          </div>

          <!-- 消息气泡 -->
          <div class="flex flex-col min-w-0" :class="item.senderType === 'user' ? 'items-end' : 'items-start'">
            <div class="flex items-center space-x-2 mb-1 px-1">
              <div class="flex items-center space-x-1 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">
                <span
                  class="hover:text-[var(--primary)] cursor-pointer transition-colors"
                  @click="navigateToMessage(item.senderId, item.id)"
                  @mouseenter="handleMouseEnter($event, item.senderId)"
                  @mouseleave="handleMouseLeave"
                >{{ getSenderName(item) }}</span>
                <span
                  v-if="item.senderAgentId && item.senderAgentId !== 'system'"
                  class="text-[10px] font-normal text-[var(--text-3)] normal-case tracking-normal"
                >
                  由 {{ findAgentById(item.senderAgentId)?.name || item.senderAgentId }} 发送
                </span>
                <template v-if="getReceiverName(item)">
                  <span class="opacity-50 mx-1">→</span>
                  <span 
                    class="hover:text-[var(--primary)] cursor-pointer transition-colors"
                    @click="navigateToMessage(item.receiverId, item.id)"
                    @mouseenter="(e) => handleReceiverMouseEnter(e, item)"
                    @mouseleave="handleReceiverMouseLeave"
                  >{{ getReceiverName(item) }}</span>
                </template>
              </div>
              <span class="text-[10px] text-[var(--text-3)]">{{ formatTime(item.timestamp) }}</span>
              <span v-if="getDelayInfo(item)" class="text-[10px] text-[var(--text-3)] flex items-center gap-0.5">
                <Clock class="w-2.5 h-2.5" />
                {{ getDelayInfo(item)!.detail }}
              </span>
            </div>
            <div
              class="px-4 py-2.5 rounded-2xl text-sm shadow-sm relative group/msg overflow-visible"
              :class="[
                item.senderType === 'user'
                  ? 'bg-[var(--primary)] text-white rounded-tr-none'
                  : 'bg-[var(--surface-2)] text-[var(--text-1)] border border-[var(--border)] rounded-tl-none',
                item.status === 'sending' ? 'opacity-70' : ''
              ]"
            >
              <!-- 记忆召回 (AgentMemory) -->
              <div v-if="item.memoryContext || item.hasMemoryContext" class="mb-2">
                <div
                  class="flex items-center space-x-2 py-1 px-2 rounded bg-[var(--surface-3)] border border-[var(--border)] cursor-pointer hover:bg-[var(--surface-4)] transition-colors opacity-80"
                  @click="toggleMemoryContext(item.id); ensureDetail(item, ['memory'])"
                >
                  <Database class="w-3 h-3 text-[var(--primary)]" />
                  <span class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">记忆召回</span>
                  <span class="flex-grow"></span>
                  <ChevronDown v-if="!expandedMemoryContext[item.id]" class="w-3 h-3" />
                  <ChevronUp v-else class="w-3 h-3" />
                </div>
                <div v-if="expandedMemoryContext[item.id]" class="mt-2 p-3 bg-[var(--surface-3)] rounded-lg text-xs italic text-[var(--text-2)] whitespace-pre-wrap border-l-2 border-[var(--primary)] animate-in fade-in slide-in-from-top-1 duration-200">
                  <span v-if="detailLoading[item.id]">加载中…</span>
                  <template v-else-if="detailError[item.id]">
                    <span class="text-[var(--text-3)]">加载失败</span>
                    <button class="text-[var(--primary)] hover:underline ml-2" @click.stop="retryDetail(item, ['memory'])">重试</button>
                  </template>
                  <template v-else>{{ item.memoryContext }}</template>
                </div>
              </div>

              <!-- 知识树检索 (KnowledgeTree) -->
              <div v-if="item.knowledgeContext || item.hasKnowledgeContext" class="mb-2">
                <div
                  class="flex items-center space-x-2 py-1 px-2 rounded bg-[var(--surface-3)] border border-[var(--border)] cursor-pointer hover:bg-[var(--surface-4)] transition-colors opacity-80"
                  @click="toggleKnowledgeContext(item.id); ensureDetail(item, ['knowledge'])"
                >
                  <BookOpen class="w-3 h-3 text-[var(--primary)]" />
                  <span class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">知识树</span>
                  <span class="flex-grow"></span>
                  <ChevronDown v-if="!expandedKnowledgeContext[item.id]" class="w-3 h-3" />
                  <ChevronUp v-else class="w-3 h-3" />
                </div>
                <div v-if="expandedKnowledgeContext[item.id]" class="mt-2 p-3 bg-[var(--surface-3)] rounded-lg text-xs italic text-[var(--text-2)] whitespace-pre-wrap border-l-2 border-[var(--primary)] animate-in fade-in slide-in-from-top-1 duration-200">
                  <span v-if="detailLoading[item.id]">加载中…</span>
                  <template v-else-if="detailError[item.id]">
                    <span class="text-[var(--text-3)]">加载失败</span>
                    <button class="text-[var(--primary)] hover:underline ml-2" @click.stop="retryDetail(item, ['knowledge'])">重试</button>
                  </template>
                  <template v-else>{{ item.knowledgeContext }}</template>
                </div>
              </div>

              <!-- 思考过程 (Reasoning) -->
              <div v-if="item.reasoning || item.hasReasoning" class="mb-3">
                <div
                  class="flex items-center space-x-2 py-1 px-2 rounded bg-[var(--surface-3)] border border-[var(--border)] cursor-pointer hover:bg-[var(--surface-4)] transition-colors opacity-80"
                  @click="toggleReasoning(item.id); ensureDetail(item, ['reasoning'])"
                >
                  <Sparkles class="w-3 h-3 text-[var(--primary)]" />
                  <span class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">思考过程</span>
                  <span class="flex-grow"></span>
                  <ChevronDown v-if="!expandedReasoning[item.id]" class="w-3 h-3" />
                  <ChevronUp v-else class="w-3 h-3" />
                </div>

                <!-- 思考过程展开内容复用工具调用内思考内容的视觉风格，避免亮色主题下出现纯白背景。 -->
                <div v-if="expandedReasoning[item.id]" class="mt-2 p-3 bg-[var(--surface-3)] rounded-lg text-xs italic text-[var(--text-2)] whitespace-pre-wrap border-l-2 border-[var(--primary)] animate-in fade-in slide-in-from-top-1 duration-200">
                  <span v-if="detailLoading[item.id]">加载中…</span>
                  <template v-else-if="detailError[item.id]">
                    <span class="text-[var(--text-3)]">加载失败</span>
                    <button class="text-[var(--primary)] hover:underline ml-2" @click.stop="retryDetail(item, ['reasoning'])">重试</button>
                  </template>
                  <template v-else>
                    <template v-if="searchKeyword?.trim()">
                      <span v-html="renderHighlightedContent(item.reasoning, item.id)"></span>
                    </template>
                    <template v-else>{{ item.reasoning }}</template>
                  </template>
                </div>
              </div>

              <!-- 单个工具调用 (非组内) -->
              <div v-if="item.toolCall" class="mb-2">
                <div
                  class="flex items-center space-x-2 py-1 px-2 rounded bg-[var(--surface-3)] border border-[var(--border)] cursor-pointer hover:bg-[var(--surface-4)] transition-colors"
                  @click="toggleToolCall(item.id); ensureDetail(item, ['tool'])"
                >
                  <Wrench class="w-3 h-3 text-[var(--primary)]" />
                  <span class="text-xs font-mono font-bold text-[var(--text-1)]">{{ item.toolCall.name }}</span>
                  <span class="text-[10px] text-[var(--text-3)] flex-grow">工具调用</span>
                  <ChevronDown v-if="!expandedToolCalls[item.id]" class="w-3 h-3" />
                  <ChevronUp v-else class="w-3 h-3" />
                </div>

                <div v-if="expandedToolCalls[item.id]" class="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                  <!-- 存根正文未加载时显示加载/重试分支 -->
                  <template v-if="detailLoading[item.id] || detailError[item.id] || (item.toolCall.args === undefined && item.toolCall.result === undefined)">
                    <div class="p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-3)]">
                      <span v-if="detailLoading[item.id]">加载详情中…</span>
                      <template v-else-if="detailError[item.id]">
                        加载失败
                        <button class="text-[var(--primary)] hover:underline ml-1" @click.stop="retryDetail(item, ['tool'])">重试</button>
                      </template>
                    </div>
                  </template>
                  <div v-if="item.toolCall.args !== undefined" class="p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg">
                    <div class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider mb-1">参数</div>
                    <MessageContent
                      :content="JSON.stringify(parseJson(item.toolCall.args), null, 2)"
                      :search-keyword="searchKeyword"
                      :message-id="item.id"
                    />
                  </div>
                  <div v-if="item.toolCall.result !== undefined" class="p-3 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg">
                    <div class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider mb-1">执行结果</div>
                    <MessageContent
                      :content="JSON.stringify(parseJson(item.toolCall.result), null, 2)"
                      :search-keyword="searchKeyword"
                      :message-id="item.id"
                    />
                  </div>
                </div>
              </div>

              <!-- 消息内容 -->
              <div v-if="item.content && !item.toolCall">
                <!-- 编辑模式 -->
                <div v-if="editingMessageId === item.id" class="min-w-[300px]">
                  <Textarea 
                    v-model="editContent" 
                    rows="3" 
                    class="w-full !bg-[var(--bg)] !text-[var(--text-1)] !border-[var(--border)] text-sm mb-2"
                    autoResize
                  />
                  <div class="flex items-center justify-end space-x-2">
                    <Button 
                      size="small" 
                      variant="text" 
                      class="!text-[var(--text-2)] !py-1 !px-2 !h-8" 
                      @click="cancelEdit"
                    >
                      取消
                    </Button>
                    <Button 
                      size="small" 
                      class="!bg-[var(--primary)] !text-white !py-1 !px-3 !h-8"
                      :disabled="!editContent.trim() || isSavingEdit"
                      @click="saveEdit"
                    >
                      <Loader2 v-if="isSavingEdit" class="w-3 h-3 animate-spin mr-1" />
                      保存
                    </Button>
                  </div>
                </div>
                <!-- 正常显示 -->
                <MessageContent
                  v-else
                  :content="item.content"
                  :search-keyword="searchKeyword"
                  :message-id="item.id"
                />
              </div>
              
              <!-- 如果是工具调用且有额外内容（非自动生成的提示）才显示 -->
              <div v-if="item.content && item.toolCall && !item.content.startsWith('调用工具:')" class="mt-2 border-t border-[var(--border)] pt-2 opacity-80">
                <MessageContent
                  :content="item.content"
                  :search-keyword="searchKeyword"
                  :message-id="item.id"
                />
              </div>

              <!-- 负载 (Payload) -->
              <div v-if="item.payload && !item.content && !item.toolCall" class="mt-2">
                <MessageContent
                  :content="typeof item.payload === 'object' ? JSON.stringify(item.payload, null, 2) : item.payload"
                  :search-keyword="searchKeyword"
                  :message-id="item.id"
                />
              </div>

              <!-- 文件列表 - 当消息包含文件时显示 -->
              <div v-if="getFilesFromPayload(item).length > 0" class="mt-3 pt-2 border-t border-[var(--border)]/50">
                <div class="flex flex-wrap gap-3">
                  <div 
                    v-for="(file, index) in sortFiles(getFilesFromPayload(item))" 
                    :key="index"
                    class="relative bg-[var(--surface-3)] border border-[var(--border)] rounded-lg hover:bg-[var(--surface-4)] transition-colors cursor-pointer overflow-hidden"
                    :class="isImage(file.mimeType) ? 'w-[250px] h-[250px]' : 'flex items-center space-x-2 px-3 py-1.5'"
                    :title="file.path"
                    @click="handleFileClick(file)"
                  >
                    <!-- 图片缩略图 -->
                    <template v-if="isImage(file.mimeType)">
                      <img 
                        :src="getThumbnailUrl(file.path)" 
                        class="w-full h-full object-cover"
                        loading="lazy"
                        @error="($event.target as HTMLImageElement).style.display='none'"
                      />
                      <div class="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1">
                        <span class="text-xs text-white truncate block">{{ getFileName(file.path) }}</span>
                      </div>
                    </template>
                    <!-- 非图片文件 -->
                    <template v-else>
                      <component :is="getFileIcon(file.mimeType)" class="w-4 h-4 text-[var(--primary)]" />
                      <span class="text-xs text-[var(--text-2)] truncate max-w-[200px]">{{ getFileName(file.path) }}</span>
                    </template>
                  </div>
                </div>
              </div>

              <!-- Token 使用量 - 只要消息有 usage 就显示 -->
              <div v-if="item.usage && item.usage.totalTokens > 0" class="mt-1">
                <span 
                  class="text-[10px] text-[var(--text-3)] cursor-help"
                  @mouseenter="showTokenTooltip($event, item.usage)"
                  @mouseleave="hideTokenTooltip"
                >
                  {{ item.usage.totalTokens }} tokens
                </span>
              </div>

              <!-- 消息操作菜单固定在消息内容底部右侧，避免遮挡头像。 -->
              <div v-if="!isBatchMode && editingMessageId !== item.id" class="absolute -bottom-4 right-2 hidden group-hover/msg:flex z-10">
                <div class="flex items-center bg-[var(--surface-1)] border border-[var(--border)] rounded-full shadow-sm p-1 space-x-1 animate-in fade-in zoom-in-95 duration-200">
                  <button
                    v-if="canRegenerateMessage(item)"
                    class="p-1.5 rounded-full hover:bg-[var(--surface-3)] text-[var(--text-2)] transition-colors"
                    :title="regeneratingMessageId === item.id ? '正在重新生成' : '重新生成'"
                    :disabled="regeneratingMessageId === item.id"
                    @click="regenerateMessage(item)"
                  >
                    <Loader2 v-if="regeneratingMessageId === item.id" class="w-3.5 h-3.5 animate-spin" />
                    <Sparkles v-else class="w-3.5 h-3.5" />
                  </button>
                  <button
                    class="p-1.5 rounded-full hover:bg-[var(--surface-3)] text-[var(--text-2)] transition-colors"
                    :title="copiedMessageId === item.id ? '已复制' : '复制'"
                    @click="copyMessageContent(item)"
                  >
                    <Check v-if="copiedMessageId === item.id" class="w-3.5 h-3.5" />
                    <Copy v-else class="w-3.5 h-3.5" />
                  </button>
                  <button class="p-1.5 rounded-full hover:bg-[var(--surface-3)] text-[var(--text-2)] transition-colors" title="编辑" @click="startEdit(item)">
                    <Edit2 class="w-3.5 h-3.5" />
                  </button>
                  <button class="p-1.5 rounded-full hover:bg-red-50 text-[var(--text-2)] hover:text-red-500 transition-colors" title="删除" @click="confirmDeleteOne(item.id)">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 连续工具调用组 -->

      <div 
        v-else
        :id="'msg-' + item.messages[0].id"
        class="flex justify-start group relative pl-8 pr-2 transition-colors duration-200 rounded-lg hover:bg-[var(--surface-2)]/50"
      >
        <!-- 批量选择 Checkbox -->
        <div v-if="isBatchMode" class="absolute left-0 top-3 flex items-center justify-center w-8 h-8 cursor-pointer z-10" @click.stop="toggleGroupSelection(item.messages)">
          <CheckSquare v-if="isGroupSelected(item.messages)" class="w-5 h-5 text-[var(--primary)]" />
          <Square v-else class="w-5 h-5 text-[var(--text-3)]" />
        </div>

        <!-- 悬停操作栏 (非批量模式) -->
        <div class="flex max-w-[90%] items-start space-x-3 flex-row">
          <!-- 头像 -->
          <div class="w-8 h-8 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center shrink-0">
            <Bot class="w-4 h-4 text-[var(--primary)]" />
          </div>

          <!-- 组气泡 -->
          <div class="flex flex-col items-start w-full min-w-0">
            <div class="flex items-center space-x-2 mb-1 px-1">
              <div class="flex items-center space-x-1 text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider">
                <span 
                  class="hover:text-[var(--primary)] cursor-pointer transition-colors"
                  @click="navigateToMessage(item.senderId, item.messages[0].id)"
                  @mouseenter="handleMouseEnter($event, item.senderId)"
                  @mouseleave="handleMouseLeave"
                >{{ getSenderName(item.messages[0]) }}</span>
                <template v-if="getReceiverName(item)">
                  <span class="opacity-50 mx-1">→</span>
                  <span 
                    class="hover:text-[var(--primary)] cursor-pointer transition-colors"
                    @click="navigateToMessage(item.receiverId, item.messages[0].id)"
                    @mouseenter="handleMouseEnter($event, item.receiverId)"
                    @mouseleave="handleMouseLeave"
                  >{{ getReceiverName(item) }}</span>
                </template>
              </div>
              <span class="text-[10px] text-[var(--text-3)]">{{ formatTime(item.timestamp) }}</span>
            </div>
            
            <div class="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl rounded-tl-none overflow-visible shadow-sm relative group/msg">
              <!-- 组头：显示调用次数 -->
              <div 
                class="px-4 py-2 bg-[var(--surface-3)] border-b border-[var(--border)] flex items-center justify-between cursor-pointer hover:bg-[var(--surface-4)] transition-colors"
                @click="toggleGroup(item.id)"
              >
                <div class="flex items-center space-x-2">
                  <Wrench class="w-4 h-4 text-[var(--primary)]" />
                  <span class="text-xs font-bold text-[var(--text-2)]">连续执行了 {{ item.messages.length }} 个工具</span>
                </div>
                <div class="flex items-center space-x-2">
                  <span class="text-[10px] text-[var(--text-3)] uppercase tracking-wider">{{ expandedGroups[item.id] ? '收起详情' : '展开详情' }}</span>
                  <ChevronDown v-if="!expandedGroups[item.id]" class="w-3 h-3" />
                  <ChevronUp v-else class="w-3 h-3" />
                </div>
              </div>

              <!-- 组内容：展开时显示所有调用 -->
              <div v-if="expandedGroups[item.id]" class="p-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                <div v-for="msg in item.messages" :key="msg.id" class="border border-[var(--border)] rounded-xl overflow-hidden bg-[var(--surface-1)]">
                  <div 
                    class="px-3 py-1.5 bg-[var(--surface-2)] flex items-center justify-between cursor-pointer hover:bg-[var(--surface-3)]"
                    @click="toggleToolCall(msg.id); ensureDetail(msg, ['tool', 'reasoning'])"
                  >
                    <div class="flex items-center space-x-2">
                      <Wrench class="w-3 h-3 text-[var(--primary)] opacity-70" />
                      <span class="text-xs font-mono font-medium text-[var(--text-1)]">{{ msg.toolCall.name }}</span>
                    </div>
                    <ChevronDown v-if="!expandedToolCalls[msg.id]" class="w-3 h-3 opacity-50" />
                    <ChevronUp v-else class="w-3 h-3 opacity-50" />
                  </div>

                  <div v-if="expandedToolCalls[msg.id]" class="p-3 space-y-2 border-t border-[var(--border)]">
                    <!-- 组内消息的思考过程（存根时随单条详情懒加载回填） -->
                    <div v-if="msg.reasoning" class="mb-2 p-2 bg-[var(--surface-3)] rounded text-[11px] italic text-[var(--text-3)] whitespace-pre-wrap border-l-2 border-[var(--primary)]">
                      <template v-if="searchKeyword?.trim()">
                        <span v-html="renderHighlightedContent(msg.reasoning, msg.id)"></span>
                      </template>
                      <template v-else>{{ msg.reasoning }}</template>
                    </div>
                    <!-- 存根正文未加载时显示加载/重试分支 -->
                    <div v-if="detailLoading[msg.id] || detailError[msg.id] || (msg.toolCall.args === undefined && msg.toolCall.result === undefined)" class="text-xs text-[var(--text-3)]">
                      <span v-if="detailLoading[msg.id]">加载详情中…</span>
                      <template v-else-if="detailError[msg.id]">
                        加载失败
                        <button class="text-[var(--primary)] hover:underline ml-1" @click.stop="retryDetail(msg, ['tool', 'reasoning'])">重试</button>
                      </template>
                    </div>
                    <div v-if="msg.toolCall.args !== undefined" class="space-y-1">
                      <div class="text-[10px] font-bold text-[var(--text-3)] uppercase">参数</div>
                      <MessageContent
                        :content="JSON.stringify(parseJson(msg.toolCall.args), null, 2)"
                        :search-keyword="searchKeyword"
                        :message-id="msg.id"
                      />
                    </div>
                    <div v-if="msg.toolCall.result !== undefined" class="space-y-1">
                      <div class="text-[10px] font-bold text-[var(--text-3)] uppercase">结果</div>
                      <MessageContent
                        :content="JSON.stringify(parseJson(msg.toolCall.result), null, 2)"
                        :search-keyword="searchKeyword"
                        :message-id="msg.id"
                      />
                    </div>
                    <!-- 单个工具调用的 Token 使用量 -->
                    <div v-if="msg.usage && msg.usage.totalTokens > 0" class="pt-1 border-t border-[var(--border)]">
                      <span
                        class="text-[10px] text-[var(--text-3)] cursor-help"
                        @mouseenter="showTokenTooltip($event, msg.usage)"
                        @mouseleave="hideTokenTooltip"
                      >
                        {{ msg.usage.totalTokens }} tokens
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              
              <!-- 工具调用组的文件列表汇总 -->
              <div v-if="getGroupFiles(item.messages).length > 0" class="px-4 py-2 bg-[var(--surface-2)] border-t border-[var(--border)]">
                <div class="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-wider mb-2">生成文件 ({{ getGroupFiles(item.messages).length }})</div>
                <!-- 图片文件组 -->
                <div v-if="getGroupFiles(item.messages).filter(f => isImage(f.mimeType)).length > 0" class="flex flex-wrap gap-3 mb-3">
                  <div 
                    v-for="(file, index) in getGroupFiles(item.messages).filter(f => isImage(f.mimeType))" 
                    :key="'img-'+index"
                    class="relative w-[250px] h-[250px] bg-[var(--surface-3)] border border-[var(--border)] rounded-lg hover:bg-[var(--surface-4)] transition-colors cursor-pointer overflow-hidden"
                    :title="file.path"
                    @click="handleFileClick(file)"
                  >
                    <img 
                      :src="getThumbnailUrl(file.path)" 
                      class="w-full h-full object-cover"
                      loading="lazy"
                      @error="($event.target as HTMLImageElement).style.display='none'"
                    />
                    <div class="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1">
                      <span class="text-xs text-white truncate block">{{ getFileName(file.path) }}</span>
                    </div>
                  </div>
                </div>
                <!-- 非图片文件组 -->
                <div v-if="getGroupFiles(item.messages).filter(f => !isImage(f.mimeType)).length > 0" class="flex flex-wrap gap-2">
                  <div 
                    v-for="(file, index) in getGroupFiles(item.messages).filter(f => !isImage(f.mimeType))" 
                    :key="'file-'+index"
                    class="flex items-center space-x-2 px-3 py-1.5 bg-[var(--surface-3)] border border-[var(--border)] rounded-lg hover:bg-[var(--surface-4)] transition-colors cursor-pointer"
                    :title="file.path"
                    @click="handleFileClick(file)"
                  >
                    <component :is="getFileIcon(file.mimeType)" class="w-4 h-4 text-[var(--primary)]" />
                    <span class="text-xs text-[var(--text-2)] truncate max-w-[200px]">{{ getFileName(file.path) }}</span>
                  </div>
                </div>
              </div>
              
              <!-- 工具调用组的总 Token 使用量 -->
              <div v-if="getGroupTotalTokens(item.messages) > 0" class="px-4 py-1.5 bg-[var(--surface-3)] border-t border-[var(--border)] flex justify-end">
                <span 
                  class="text-[10px] text-[var(--text-3)] cursor-help"
                  @mouseenter="showTokenTooltip($event, { 
                    promptTokens: getGroupPromptTokens(item.messages), 
                    completionTokens: getGroupCompletionTokens(item.messages), 
                    totalTokens: getGroupTotalTokens(item.messages) 
                  })"
                  @mouseleave="hideTokenTooltip"
                >
                  总计 {{ getGroupTotalTokens(item.messages) }} tokens
                </span>
              </div>

              <!-- 工具组操作菜单固定在内容底部右侧，避免遮挡头像。 -->
              <div v-if="!isBatchMode" class="absolute -bottom-4 right-2 hidden group-hover/msg:flex z-10">
                <div class="flex items-center bg-[var(--surface-1)] border border-[var(--border)] rounded-full shadow-sm p-1 space-x-1 animate-in fade-in zoom-in-95 duration-200">
                  <button class="p-1.5 rounded-full hover:bg-red-50 text-[var(--text-2)] hover:text-red-500 transition-colors" title="删除整组" @click="confirmDeleteOne(item.messages.map((m: any) => m.id).join(','))">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 思考中占位提示 - 当智能体正在运算时显示 -->
    <div
      v-if="isThinking"
      class="flex justify-start group relative pl-8 pr-2 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div class="flex items-start space-x-3 max-w-[90%]">
        <div class="w-8 h-8 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center shrink-0">
          <Loader2 class="w-4 h-4 text-[var(--primary)] animate-spin" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[10px] text-[var(--text-3)] mb-1 px-1">
            {{ agentName || '智能体' }}
          </div>
          <div class="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-4 py-3 inline-flex items-center space-x-2">
            <Loader2 class="w-3.5 h-3.5 text-[var(--primary)] animate-spin shrink-0" />
            <span class="text-sm text-[var(--text-2)]">{{ thinkingPhase || '正在处理...' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 智能体详情 Tooltip -->
    <Teleport to="body">
      <div 
        v-if="hoveredAgent"
        class="fixed z-[9999] pointer-events-none transition-all duration-200"
        :style="{
          left: tooltipPosition.x + 'px',
          top: (tooltipPosition.y - 10) + 'px',
          transform: 'translate(-50%, -100%)'
        }"
      >
        <div class="bg-[var(--surface-4)] border border-[var(--border)] rounded-xl shadow-xl p-4 min-w-[240px] backdrop-blur-md animate-in fade-in zoom-in-95 duration-200">
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center space-x-3">
              <div class="w-10 h-10 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center shrink-0">
                <Bot class="w-6 h-6 text-[var(--primary)]" />
              </div>
              <div>
                <div class="text-sm font-bold text-[var(--text-1)]">{{ hoveredAgent.name }}</div>
                <div class="text-[10px] text-[var(--text-3)] font-mono opacity-70">{{ hoveredAgent.id }}</div>
              </div>
            </div>
            <div 
              class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
              :class="{
                'bg-green-500/10 text-green-500': hoveredAgent.status === 'online',
                'bg-orange-500/10 text-orange-500': hoveredAgent.status === 'busy',
                'bg-gray-500/10 text-gray-300': hoveredAgent.status === 'offline'
              }"
            >
              {{ hoveredAgent.status === 'online' ? '在线' : (hoveredAgent.status === 'busy' ? '忙碌' : '离线') }}
            </div>
          </div>
          
          <div class="space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="text-[var(--text-3)]">岗位</span>
              <span class="text-[var(--text-2)] font-medium">{{ hoveredAgent.role }}</span>
            </div>
            <div v-if="hoveredAgent.lastSeen" class="flex items-center justify-between text-xs">
              <span class="text-[var(--text-3)]">最后活动</span>
              <span class="text-[var(--text-2)]">{{ formatTime(hoveredAgent.lastSeen) }}</span>
            </div>
          </div>
          
          <!-- 装饰三角形 -->
          <div class="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-[var(--border)]"></div>
        </div>
      </div>
    </Teleport>

    <!-- Token 使用量 Tooltip - 传送到 body 层级 -->
    <Teleport to="body">
      <div
        v-if="tokenTooltip.show && tokenTooltip.usage"
        class="fixed z-[9999] pointer-events-none"
        :style="{
          left: tokenTooltip.x + 'px',
          top: tokenTooltip.y + 'px',
          transform: 'translateX(-50%)'
        }"
      >
        <div class="bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-lg p-2 whitespace-nowrap">
          <div class="text-[10px] text-[var(--text-3)] space-y-1">
            <div class="flex items-center space-x-2">
              <span class="text-[var(--text-3)] opacity-70">输入:</span>
              <span class="font-mono text-[var(--text-2)]">{{ tokenTooltip.usage.promptTokens }}</span>
            </div>
            <div class="flex items-center space-x-2">
              <span class="text-[var(--text-3)] opacity-70">输出:</span>
              <span class="font-mono text-[var(--text-2)]">{{ tokenTooltip.usage.completionTokens }}</span>
            </div>
            <div class="border-t border-[var(--border)] pt-1 mt-1 flex items-center space-x-2">
              <span class="text-[var(--text-3)] opacity-70">总计:</span>
              <span class="font-mono font-medium text-[var(--text-1)]">{{ tokenTooltip.usage.totalTokens }}</span>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 多收件人弹窗 - 传送到 body 层级 -->
    <Teleport to="body">
      <div
        v-if="multiReceiverPopup.show && multiReceiverPopup.receivers.length > 0"
        class="fixed z-[9999]"
        :style="{
          left: multiReceiverPopup.x + 'px',
          top: multiReceiverPopup.y + 'px',
          transform: 'translateX(-50%)'
        }"
        @mouseenter="handlePopupMouseEnter"
        @mouseleave="handlePopupMouseLeave"
      >
        <div class="bg-[var(--surface-4)] border border-[var(--border)] rounded-xl shadow-xl p-4 min-w-[260px] max-w-[340px] backdrop-blur-md animate-in fade-in zoom-in-95 duration-200 max-h-[280px] overflow-y-auto">
          <div class="text-xs font-bold text-[var(--text-3)] uppercase tracking-wider mb-3">收件人 ({{ multiReceiverPopup.receivers.length }})</div>
          <div class="space-y-2">
            <div 
              v-for="receiverId in multiReceiverPopup.receivers" 
              :key="receiverId"
              class="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-3)]/50 border border-[var(--border)] gap-2"
            >
              <div class="flex items-center space-x-2 min-w-0 flex-1">
                <div class="w-8 h-8 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center shrink-0">
                  <User v-if="receiverId === 'user'" class="w-4 h-4 text-[var(--text-2)]" />
                  <Bot v-else class="w-4 h-4 text-[var(--primary)]" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-[var(--text-1)] truncate">{{ findAgentById(receiverId)?.name || receiverId }}</div>
                  <div class="text-[10px] text-[var(--text-3)] font-mono opacity-70 truncate">{{ receiverId }}</div>
                </div>
              </div>
              <div 
                class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider whitespace-nowrap shrink-0"
                :class="{
                  'bg-green-500/10 text-green-500': findAgentById(receiverId)?.status === 'online',
                  'bg-orange-500/10 text-orange-500': findAgentById(receiverId)?.status === 'busy',
                  'bg-gray-500/10 text-gray-300': !findAgentById(receiverId) || findAgentById(receiverId)?.status === 'offline'
                }"
              >
                {{ findAgentById(receiverId)?.status === 'online' ? '在线' : (findAgentById(receiverId)?.status === 'busy' ? '忙碌' : '离线') }}
              </div>
            </div>
          </div>
          <!-- 装饰三角形 -->
          <div class="absolute -top-[6px] left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[6px] border-b-[var(--border)]"></div>
        </div>
      </div>
    </Teleport>

    <!-- 单条删除确认框 -->
    <ConfirmDialog
      v-model:visible="showDeleteOneConfirm"
      title="删除消息"
      message="确定要删除这条消息吗？"
      confirm-label="删除"
      cancel-label="取消"
      confirm-severity="danger"
      :loading="isDeletingOne"
      @confirm="executeDeleteOne"
    />
  </div>
</template>
