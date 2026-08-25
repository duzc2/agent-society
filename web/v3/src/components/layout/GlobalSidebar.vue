<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { LayoutGrid, Briefcase, Settings, ChevronLeft, ChevronRight, Home, Search, X, Loader2, Layers, Puzzle, Sparkles, FolderOpen, Pencil, Check, ChevronDown, Archive, MessageCircle, Users, Plus } from 'lucide-vue-next';
import { VueDraggable } from 'vue-draggable-plus';
import { useAppStore } from '../../stores/app';
import { useOrgStore } from '../../stores/org';
import { useChatStore } from '../../stores/chat';
import { templateApi } from '../../services/templateApi';
import { apiService } from '../../services/api';
import { orgTreeState } from '../../services/heartbeatService';
import { useDialog } from 'primevue/usedialog';
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from 'vue';
import Dialog from 'primevue/dialog';
import ArtifactsList from '../artifacts/ArtifactsList.vue';
import RoleTreeView from '../overview/RoleTreeView.vue';
import { openSettingsWindow } from '../settings/settingsWindow';
import { openSkillManagerWindow } from '../skills/skillManagerWindow';
import OrgTemplateManager from '../template/OrgTemplateManager.vue';
import ModuleManagerDialog from '../modules/ModuleManagerDialog.vue';
import MemberPicker from '../common/MemberPicker.vue';
import WorkspaceFileAccessPanel from '../workspaceFileAccess/WorkspaceFileAccessPanel.vue';
import { createDragEndHandler } from '../../utils/dialogBounds';
import { ZIndex } from '@primeuix/utils';
import { useAgentStore } from '../../stores/agent';
import type { Agent } from '../../types';

const appStore = useAppStore();
const orgStore = useOrgStore();
const chatStore = useChatStore();
const agentStore = useAgentStore();
const dialog = useDialog();


const searchQuery = ref('');
const showArchivedOrgs = ref(false);
const showCreateGroupDialog = ref(false);
const newGroupName = ref('');
const newGroupDesc = ref('');
const newGroupReason = ref('');
const selectedMembers = ref<string[]>([]);

// 可用智能体（排除 user 和 root）
const availableAgents = computed(() =>
  agentStore.allAgents.filter(a => a.id !== 'user' && a.id !== 'root')
);

// 群列表（活跃 / 已解散归档分组，解散的群可随时查阅历史）
const activeGroups = computed(() => chatStore.groupList.filter((g: any) => g.status !== 'archived'));
const dissolvedGroups = computed(() => chatStore.groupList.filter((g: any) => g.status === 'archived'));
const showDissolvedGroups = ref(false);

// 点击群
const handleGroupClick = (groupId: string) => {
  const group = chatStore.groupList.find(g => g.id === groupId);
  chatStore.setActiveGroup(groupId);
  chatStore.fetchGroupMessages(groupId);
  // 把群作为标签页打开，而不是覆盖层
  appStore.openTab({
    id: `group:${groupId}`,
    type: 'group',
    title: group?.name || '群聊'
  });
};

// 创建群
const handleCreateGroup = async () => {
  if (!newGroupName.value.trim()) return;
  if (!newGroupReason.value.trim()) {
    // 拉群原因必填
    return;
  }
  try {
    await apiService.createGroup(newGroupName.value.trim(), selectedMembers.value, newGroupDesc.value.trim(), newGroupReason.value.trim());
    showCreateGroupDialog.value = false;
    newGroupName.value = '';
    newGroupDesc.value = '';
    newGroupReason.value = '';
    selectedMembers.value = [];
    await chatStore.fetchGroupList();
  } catch (e: any) {
    console.error('[GlobalSidebar] 创建群失败', e);
  }
};

// 监听来自 WorkspaceTabs 群列表的建群请求
onMounted(() => {
  window.addEventListener('open-create-group-dialog', () => {
    showCreateGroupDialog.value = true;
    agentStore.fetchAllAgents(true);
  });
});
onUnmounted(() => {
  window.removeEventListener('open-create-group-dialog', () => {});
});

// 检查指定组织是否已删除（org root 节点的 raw status 不是 "active"）
const isOrgDeleted = (orgId: string): boolean => {
  const rootNode = orgTreeState.tree.find(n => n.id === 'root');
  if (!rootNode?.children) return false;
  const orgNode = rootNode.children.find(c => c.id === orgId);
  return orgNode ? orgNode.status !== 'active' : false;
};

// 新创建的组织ID集合，用于触发动画
const newOrgIds = ref<Set<string>>(new Set());
// 记录每个新组织的创建时间戳，防止被刷新协程中断动画
const newOrgTimestamps = new Map<string, number>();

// 用于拖拽的可变列表（首页不参与拖拽）
const draggableOrgs = ref<any[]>([]);

// 初始化 draggableOrgs（排除首页和已删除组织）
watch(
  () => orgStore.orgs,
  (newOrgs) => {
    // 如果有搜索关键词，则过滤结果
    if (searchQuery.value.trim()) {
      const query = searchQuery.value.toLowerCase().trim();
      draggableOrgs.value = newOrgs.filter(org =>
        org.id !== 'home' &&
        !isOrgDeleted(org.id) &&
        (org.name.toLowerCase().includes(query) || org.id.toLowerCase().includes(query))
      );
    } else {
      draggableOrgs.value = newOrgs.filter(org => org.id !== 'home' && !isOrgDeleted(org.id));
    }
  },
  { immediate: true }
);

// 搜索变化时更新列表（排除首页和已删除组织）
watch(searchQuery, () => {
  const newOrgs = orgStore.orgs;
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase().trim();
    draggableOrgs.value = newOrgs.filter(org =>
      org.id !== 'home' &&
      !isOrgDeleted(org.id) &&
      (org.name.toLowerCase().includes(query) || org.id.toLowerCase().includes(query))
    );
  } else {
    draggableOrgs.value = newOrgs.filter(org => org.id !== 'home' && !isOrgDeleted(org.id));
  }
});

/**
 * 处理拖拽结束事件
 */
const onDragEnd = async () => {
  // 构建排序请求：新的 index 作为新的 sortOrder（使用较大值让新顺序排前面）
  const maxSortOrder = 1000000; // 使用较大的基准值
  const roleOrders = draggableOrgs.value.map((org, index) => ({
    id: org.id,
    sortOrder: maxSortOrder - index
  }));

  try {
    await apiService.reorderRoles(roleOrders);
    // 直接更新 store 中的 orgs（首页在第一位）
    const homeOrg = orgStore.orgs.find(org => org.id === 'home');
    if (homeOrg) {
      orgStore.orgs = [homeOrg, ...draggableOrgs.value];
    }
  } catch (err) {
    console.error('保存排序失败:', err);
  }
};

/**
 * 创建粒子效果
 * @param container 粒子容器元素
 */
const createParticles = (container: HTMLElement) => {
  const timestamp = now();
  
  setTimeout(() => {
    // 获取容器在视口中的位置（目标位置）
    const rect = container.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;
    
    console.log(`[${timestamp}] [OrgAnimation] Target position:`, targetX, targetY);
    
    // 创建20个粒子，从视口四周飞向目标
    const colors = ['#FFEA00', '#00E5FF', '#39FF14', '#FF6B6B', '#FF00FF', '#00FFFF', '#FFD700', '#FF4500'];
    
    for (let i = 0; i < 20; i++) {
      const color = colors[i % colors.length];
      const delay = i * 50; // 错开时间
      
      // 随机选择起始边：0=上, 1=右, 2=下, 3=左
      const side = Math.floor(Math.random() * 4);
      let startX = 0;
      let startY = 0;
      const padding = 50;
      
      switch(side) {
        case 0: // 上边
          startX = Math.random() * window.innerWidth;
          startY = -padding;
          break;
        case 1: // 右边
          startX = window.innerWidth + padding;
          startY = Math.random() * window.innerHeight;
          break;
        case 2: // 下边
          startX = Math.random() * window.innerWidth;
          startY = window.innerHeight + padding;
          break;
        case 3: // 左边
          startX = -padding;
          startY = Math.random() * window.innerHeight;
          break;
      }
      
      const particle = document.createElement('div');
      particle.style.cssText = `
        position: fixed;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        left: ${startX}px;
        top: ${startY}px;
        margin-left: -8px;
        margin-top: -8px;
        background-color: ${color};
        border: 2px solid rgba(255, 255, 255, 0.8);
        box-shadow: 0 0 20px 8px ${color}, 0 0 40px 16px ${color}80;
        z-index: 2147483647;
        pointer-events: none;
        opacity: 1;
      `;
      
      document.body.appendChild(particle);
      
      // 计算飞向目标
      const deltaX = targetX - startX;
      const deltaY = targetY - startY;
      
      // 动画飞向目标
      requestAnimationFrame(() => {
        setTimeout(() => {
          particle.style.transition = 'all 0.8s cubic-bezier(0.25, 0.1, 0.25, 1)';
          particle.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(0.3)`;
          particle.style.opacity = '0';
        }, delay);
      });
      
      // 清理
      setTimeout(() => particle.remove(), 1000 + delay);
    }
    
    console.log(`[${timestamp}] [OrgAnimation] 20 particles created flying to target`);
  }, 100);
};

/**
 * 判断单个智能体是否处于非 idle 的工作状态。
 * 与 WorkspaceTabs.vue 中的逻辑保持一致。
 */
const isAgentNonIdle = (agent: Agent): boolean => {
  if (agent.id === 'user') return false;
  const cs = agent.computeStatus;
  return cs === 'waiting_llm' || cs === 'processing' || cs === 'computing' || cs === 'stopping' || cs === 'terminating' || agent.status === 'busy';
};

/**
 * 计算每个组织是否存在正在工作的智能体。
 * 递归遍历每个组织根智能体下的智能体树，结果用于侧边栏组织列表的动画指示。
 */
const orgBusyMap = computed<Record<string, boolean>>(() => {
  const childrenMap = new Map<string, Agent[]>();
  const agentById = new Map<string, Agent>();

  agentStore.allAgents.forEach((agent) => {
    agentById.set(agent.id, agent);
    const pid = agent.parentAgentId;
    if (!pid) return;
    const siblings = childrenMap.get(pid) || [];
    siblings.push(agent);
    childrenMap.set(pid, siblings);
  });

  const busyMap: Record<string, boolean> = {};

  orgStore.orgs.forEach((org) => {
    if (org.id === 'home') {
      busyMap[org.id] = false;
      return;
    }

    const pendingIds = [org.id];
    const visited = new Set<string>();
    let hasBusy = false;

    while (pendingIds.length > 0 && !hasBusy) {
      const currentId = pendingIds.shift();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      const agent = agentById.get(currentId);
      if (agent && isAgentNonIdle(agent)) {
        hasBusy = true;
        break;
      }

      const children = childrenMap.get(currentId) || [];
      children.forEach((c) => pendingIds.push(c.id));
    }

    busyMap[org.id] = hasBusy;
  });

  return busyMap;
});

// 已归档的组织列表（org root 节点 status 不为 "active"，即已删除）
const archivedOrgs = computed(() => {
  return orgStore.orgs.filter(org => org.id !== 'home' && isOrgDeleted(org.id));
});

/**
 * 检查组织是否是新创建的（需要播放动画）
 */
const isNewOrg = (orgId: string): boolean => {
  return newOrgIds.value.has(orgId);
};

/**
 * 处理组织项动画结束
 */
const handleAnimationEnd = (orgId: string, event: AnimationEvent) => {
  const d = new Date();
  const timestamp = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  console.log(`[${timestamp}] [OrgAnimation] [${orgId}] CSS animation ended:`, event.animationName);
  if (event.animationName === 'org-item-enter') {
    newOrgIds.value.delete(orgId);
    newOrgTimestamps.delete(orgId);
    console.log(`[${timestamp}] [OrgAnimation] [${orgId}] >>> Animation class removed by CSS event`);
  }
};

// 监听组织列表变化，检测新组织
let previousOrgIds = new Set<string>();
let isInitialized = false;

const now = () => {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
};

watch(() => orgStore.orgs, (newOrgs) => {
  const timestamp = now();
  console.log(`[${timestamp}] [OrgAnimation] ========== Orgs changed: ${newOrgs.length} items ==========`);
  
  // 初始化时记录所有现有组织ID
  if (!isInitialized && newOrgs.length > 0) {
    previousOrgIds = new Set(newOrgs.map(org => org.id));
    isInitialized = true;
    console.log(`[${timestamp}] [OrgAnimation] Initialized with ${previousOrgIds.size} IDs`);
    return;
  }
  
  // 找出新添加的组织（不在previousOrgIds中的）
  const currentIds = new Set(newOrgs.map(org => org.id));
  const addedIds = [...currentIds].filter(id => !previousOrgIds.has(id));
  
  console.log(`[${timestamp}] [OrgAnimation] Current: ${currentIds.size}, Previous: ${previousOrgIds.size}, Added: ${addedIds.length}`);
  
  if (addedIds.length > 0) {
    console.log(`[${timestamp}] [OrgAnimation] >>> NEW ORGS DETECTED:`, addedIds);
    
    // 为每个新组织记录时间戳并标记动画
    addedIds.forEach(id => {
      newOrgTimestamps.set(id, Date.now());
      newOrgIds.value.add(id);
      console.log(`[${timestamp}] [OrgAnimation] [${id}] Marked for animation`);
    });
    
    // 更新已知组织ID集合（包含新组织）
    previousOrgIds = currentIds;
    
    // 在下一个tick创建粒子效果
    nextTick(() => {
      const tickTime = now();
      console.log(`[${tickTime}] [OrgAnimation] [nextTick] Creating particles...`);
      addedIds.forEach(id => {
        const orgElement = document.querySelector(`[data-org-id="${id}"]`);
        console.log(`[${tickTime}] [OrgAnimation] [${id}] Element found:`, orgElement ? 'YES' : 'NO');
        if (orgElement) {
          console.log(`[${tickTime}] [OrgAnimation] [${id}] Element classes:`, orgElement.className);
          const particleContainer = orgElement.querySelector('.org-item-particles');
          console.log(`[${tickTime}] [OrgAnimation] [${id}] Particle container found:`, particleContainer ? 'YES' : 'NO');
          if (particleContainer) {
            createParticles(particleContainer as HTMLElement);
            console.log(`[${tickTime}] [OrgAnimation] [${id}] Particles created!`);
          }
        }
      });
    });
    
    // 2.5秒后清理动画类，但检查是否还在保护期内
    setTimeout(() => {
      const timeoutTime = now();
      addedIds.forEach(id => {
        const createdTime = newOrgTimestamps.get(id);
        const elapsed = Date.now() - (createdTime || 0);
        console.log(`[${timeoutTime}] [OrgAnimation] [${id}] Animation timeout. Elapsed: ${elapsed}ms`);
        
        // 只有超过3秒才真正移除
        if (elapsed >= 2900) {
          newOrgIds.value.delete(id);
          newOrgTimestamps.delete(id);
          console.log(`[${timeoutTime}] [OrgAnimation] [${id}] >>> Animation class REMOVED`);
        } else {
          console.log(`[${timeoutTime}] [OrgAnimation] [${id}] Keeping animation (not enough time elapsed)`);
        }
      });
    }, 1500);
  } else {
    // 没有新组织，但还是要更新集合（处理删除的情况）
    // 但保留正在动画中的组织ID，不要被刷新覆盖
    const animatingIds = [...newOrgIds.value];
    const protectedIds = animatingIds.filter(id => {
      const createdTime = newOrgTimestamps.get(id);
      const elapsed = Date.now() - (createdTime || 0);
      return elapsed < 3000; // 还在动画保护期内
    });
    
    console.log(`[${timestamp}] [OrgAnimation] No new orgs. Animating: ${animatingIds.length}, Protected: ${protectedIds.length}`);
    
    // 合并当前ID和保护中的ID
    previousOrgIds = new Set([...currentIds, ...protectedIds]);
  }
}, { deep: true });

// 全局窗口实例（各类型单例）
const globalWindows: Record<string, any> = {};

// 工作区窗口实例（按 orgId 索引）
const workspaceWindows = new Map<string, any>();

/**
 * 将窗口提升到最前面
 * 使用 PrimeVue 的 ZIndex 工具
 */
const bringToFront = (dialogElement: HTMLElement): void => {
  if (!dialogElement) return;
  
  // 找到 mask 元素（在 dialog 的父元素中）
  const maskElement = dialogElement.closest('.p-dialog-mask') as HTMLElement;
  
  // 使用 ZIndex.set 将 mask 置顶（如果存在）
  if (maskElement) {
    ZIndex.set('modal', maskElement, 1000);
  }
  
  // 同时设置 dialog 容器的 z-index
  dialogElement.style.zIndex = String(ZIndex.getCurrent('modal') + 10);
};

/**
 * 将窗口移到屏幕中央
 */
const centerWindow = (dialogElement: HTMLElement): void => {
  if (!dialogElement) return;

  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const newLeft = (viewportWidth - rect.width) / 2;
  const newTop = (viewportHeight - rect.height) / 2;

  const clampedLeft = Math.max(0, Math.min(newLeft, viewportWidth - rect.width));
  const clampedTop = Math.max(0, Math.min(newTop, viewportHeight - rect.height));

  dialogElement.style.left = `${clampedLeft}px`;
  dialogElement.style.top = `${clampedTop}px`;
};

/**
 * 查找非工件管理器的对话框（用于单例窗口）
 */
const findSingletonDialog = (): HTMLElement | null => {
  const dialogs = document.querySelectorAll('.p-dialog');
  // 从后往前找，找到最后一个没有 data-org-id 和 data-file-path 的单例窗口
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dialog = dialogs[i] as HTMLElement;
    if (!dialog.getAttribute('data-org-id') && !dialog.getAttribute('data-file-path')) {
      return dialog;
    }
  }
  return dialogs.length > 0 ? (dialogs[dialogs.length - 1] as HTMLElement) : null;
};

/**
 * 创建单例窗口的辅助函数
 */
const createSingletonWindow = (key: string, createFn: () => any) => {
  if (globalWindows[key]) {
    // 已存在，提升到最前面、移到中央并返回
    const dialogElement = findSingletonDialog();
    if (dialogElement) {
      bringToFront(dialogElement);
      centerWindow(dialogElement);
    }
    return globalWindows[key];
  }
  
  const instance = createFn();
  globalWindows[key] = instance;
  
  return instance;
};

const openOverview = () => {
  return createSingletonWindow('overview', () => {
    return dialog.open(RoleTreeView, {
      props: {
        header: '组织架构总览',
        style: {
          width: '800px',
        },
        modal: false,
        dismissableMask: false,
        closeOnEscape: false,
        keepInViewport: false,
        onDragend: createDragEndHandler(),
      } as any,
      onClose: () => {
        delete globalWindows['overview'];
      }
    });
  });
};

/**
 * 查找指定 orgId 的对话框元素
 */
const findDialogElement = (orgId: string): HTMLElement | null => {
  const dialogs = document.querySelectorAll('.p-dialog');
  for (const dialog of dialogs) {
    if (dialog.getAttribute('data-org-id') === orgId) {
      return dialog as HTMLElement;
    }
  }
  return null;
};

/**
 * 将指定窗口移到屏幕中央
 */
const centerWindowByElement = (dialogElement: HTMLElement): void => {
  if (!dialogElement) return;

  const rect = dialogElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const newLeft = (viewportWidth - rect.width) / 2;
  const newTop = (viewportHeight - rect.height) / 2;

  const clampedLeft = Math.max(0, Math.min(newLeft, viewportWidth - rect.width));
  const clampedTop = Math.max(0, Math.min(newTop, viewportHeight - rect.height));

  dialogElement.style.left = `${clampedLeft}px`;
  dialogElement.style.top = `${clampedTop}px`;
};

const openArtifacts = (org: any) => {
  // 如果该工作区的工件管理器已存在，提升到最前面、移到中央并返回
  if (workspaceWindows.has(org.id)) {
    const dialogElement = findDialogElement(org.id);
    if (dialogElement) {
      bringToFront(dialogElement);
      centerWindowByElement(dialogElement);
    }
    return workspaceWindows.get(org.id);
  }
  
  const instance = dialog.open(ArtifactsList, {
    props: {
      header: `工件管理器 - ${org.name}`,
      style: {
        width: '80vw',
        maxWidth: '1000px',
      },
      modal: false,
      dismissableMask: false,
      closeOnEscape: false,
      resizable: true,
      keepInViewport: false,
      onDragend: createDragEndHandler(),
    } as any,
    data: {
      orgId: org.id
    },
    onClose: () => {
      workspaceWindows.delete(org.id);
    }
  });
  
  // 延迟标记 DOM 元素
  setTimeout(() => {
    const dialogs = document.querySelectorAll('.p-dialog');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dialogEl = dialogs[i] as HTMLElement;
      if (!dialogEl.getAttribute('data-org-id')) {
        dialogEl.setAttribute('data-org-id', org.id);
        break;
      }
    }
  }, 50);
  
  // 记录实例
  workspaceWindows.set(org.id, instance);
  
  return instance;
};

const openSettings = () => {
  return openSettingsWindow(dialog);
};

const openSkillManager = () => {
  return openSkillManagerWindow(dialog);
};

const openWorkspaceFileAccess = () => {
  return createSingletonWindow('workspaceFileAccess', () => {
    return dialog.open(WorkspaceFileAccessPanel, {
      props: {
        header: '文件权限设置',
        style: {
          width: '1000px',
          height: '80vh'
        },
        modal: false,
        dismissableMask: false,
        closeOnEscape: false,
        keepInViewport: false,
        maximizable: true,
        onDragend: createDragEndHandler(),
        pt: {
          content: {
            class: ['p-0', 'overflow-hidden']
          }
        }
      } as any,
      onClose: () => {
        delete globalWindows['workspaceFileAccess'];
      }
    });
  });
};

const openModuleManager = () => {
  return createSingletonWindow('module', () => {
    return dialog.open(ModuleManagerDialog, {
      props: {
        header: '模块管理',
        style: {
          width: '900px',
          height: '600px',
        },
        modal: false,
        dismissableMask: false,
        closeOnEscape: false,
        maximizable: true,
        keepInViewport: false,
        onDragend: createDragEndHandler(),
        pt: {
          content: {
            class: ['p-0', 'overflow-hidden']
          }
        }
      } as any,
      onClose: () => {
        delete globalWindows['module'];
      }
    });
  });
};

// 处理使用模板的事件（用于组织模板管理器）
const handleUseTemplate = async (template: { id: string; name: string }) => {
  // 关闭组织模板窗口
  if (globalWindows.template) {
    globalWindows.template.close();
    globalWindows.template = null;
  }
  
  // 跳转到首页
  appStore.openTab({
    id: 'home',
    type: 'org',
    title: '首页'
  });
  
  // 触发首页聊天对话框展开
  chatStore.homeChatOpenTrigger++;
  
  try {
    // 获取模板内容（包含 org.md）
    const content = await templateApi.getTemplateContent(template.id);
    
    // 开启 root 新会话
    await chatStore.rootNewSession();
    
    // 构造提示词，包含 org.md 内容
    const prompt = `请基于以下组织模板创建一个新的组织：

## 组织模板名称
${template.name}

## 组织架构定义 (org.md)
\`\`\`markdown
${content.org}
\`\`\`

请根据以上模板创建组织，建立相应的岗位和智能体。`;
    
    // 发送消息给 root
    await chatStore.sendMessage('root', prompt);
  } catch (error) {
    console.error('使用模板创建组织失败:', error);
  }
};

const openTemplateManager = () => {
  return createSingletonWindow('template', () => {
    return dialog.open(OrgTemplateManager, {
      props: {
        header: '组织模板管理器',
        style: {
          width: '90vw',
          height: '80vh',
          maxWidth: '1200px',
        },
        modal: false,
        dismissableMask: false,
        closeOnEscape: false,
        maximizable: true,
        keepInViewport: false,
        onDragend: createDragEndHandler(),
        pt: {
          root: ({ state }: { state: { maximized: boolean } }) => ({
            class: [
              state.maximized ? '!w-screen !h-screen !max-w-none !m-0' : ''
            ]
          }),
          content: ({ state }: { state: { maximized: boolean } }) => ({
            class: [
              'overflow-hidden p-0',
              state.maximized ? '!w-full !h-[calc(100vh-4rem)]' : ''
            ]
          })
        }
      } as any,
      data: {
        onUseTemplate: handleUseTemplate
      },
      onClose: () => {
        delete globalWindows['template'];
      }
    });
  });
};

const tools = [
  { id: 'overview', icon: LayoutGrid, label: '总览视图', action: openOverview },
  { id: 'templates', icon: Layers, label: '组织模板', action: openTemplateManager },
  { id: 'modules', icon: Puzzle, label: '模块管理', action: openModuleManager },
  { id: 'skills', icon: Sparkles, label: '技能管理', action: openSkillManager },
  { id: 'workspaceFileAccess', icon: FolderOpen, label: '文件权限设置', action: openWorkspaceFileAccess },
  { id: 'settings', icon: Settings, label: '系统设置', action: openSettings },
];

// ---- 组织名称编辑 ----
const editingOrgId = ref<string | null>(null);
const editValue = ref('');
const savingOrgName = ref(false);

const startEditOrgName = (org: any) => {
  editingOrgId.value = org.id;
  editValue.value = org.name;
};

const saveEditOrgName = async (org: any) => {
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

const handleOrgClick = (org: any) => {
  appStore.openTab({
    id: org.id,
    type: 'org',
    title: org.name
  });
};
</script>

<template>
  <aside 
    class="flex flex-col bg-[var(--surface-2)] border-r border-[var(--border)] transition-all duration-300 ease-in-out h-full"
    :class="[appStore.isSidebarCollapsed ? 'w-16' : 'w-64']"
  >
    <!-- 顶部 Logo/收缩按钮 -->
    <div class="p-4 flex items-center justify-between">
      <span v-if="!appStore.isSidebarCollapsed" class="font-bold text-lg text-primary truncate">Agent Society</span>
      <Button 
        variant="text" 
        rounded 
        class="!p-1 min-w-8 active:translate-y-[1px] active:scale-[0.98] transition-all"
        @click="appStore.toggleSidebar()"
      >
        <component :is="appStore.isSidebarCollapsed ? ChevronRight : ChevronLeft" class="w-5 h-5" />
      </Button>
    </div>

    <!-- 全局工具栏 -->
    <div class="p-2">
      <div v-if="!appStore.isSidebarCollapsed" class="px-3 py-2 text-xs font-semibold text-[var(--text-3)] uppercase tracking-wider">工具栏</div>
      <div class="flex items-center gap-1 px-2" :class="[appStore.isSidebarCollapsed ? 'flex-wrap justify-center' : 'overflow-x-auto no-scrollbar']">
        <Button 
          v-for="tool in tools" 
          :key="tool.id"
          variant="text" 
          rounded
          class="!p-1.5 active:translate-y-[1px] active:scale-[0.98] transition-all"

          v-tooltip.bottom="tool.label"
          @click="tool.action"
        >
          <component 
            :is="tool.icon" 
            class="w-4 h-4 transition-colors" 
            :class="['text-[var(--text-2)] hover:text-[var(--primary)]']"
          />
        </Button>
      </div>
    </div>

    <div class="flex-grow overflow-y-auto p-2 space-y-1">
      <div v-if="!appStore.isSidebarCollapsed" class="px-3 py-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-[var(--text-3)] uppercase tracking-wider shrink-0">{{ appStore.activeSidebarTab === 'groups' ? '群' : '组织' }}</span>
        <div v-if="appStore.activeSidebarTab === 'agents'" class="relative ml-2 flex-grow max-w-[120px]">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-3)]" />
          <InputText 
            v-model="searchQuery" 
            placeholder="搜索..." 
            class="!text-[10px] !py-1 !pl-6 !pr-6 !w-full !bg-[var(--surface-3)] !border-none !rounded-md focus:!ring-1 focus:!ring-[var(--primary)]"
          />
          <button 
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-[var(--surface-4)] text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors"
          >
            <X class="w-2.5 h-2.5" />
          </button>
        </div>
      </div>
      
      <!-- 加载状态 -->
      <div v-if="orgStore.loading" class="flex justify-center p-4">
        <Loader2 class="w-5 h-5 animate-spin text-[var(--text-3)]" />
      </div>

      <!-- 首页（固定，不参与拖拽） -->
      <Button
        v-if="orgStore.orgs.some(o => o.id === 'home')"
        variant="text"
        class="w-full !justify-start !px-3 !py-2 text-[var(--text-2)] hover:text-[var(--text-1)] active:translate-y-[1px] active:scale-[0.98] transition-all group relative"
        :class="{ '!bg-[var(--surface-3)] !text-[var(--primary)]': appStore.currentTabId === 'home' }"
        v-tooltip.right="appStore.isSidebarCollapsed ? '首页' : null"
        @click="handleOrgClick({ id: 'home', name: '首页', initial: 'H', description: '系统总览与核心智能体' })"
      >
        <div class="org-icon w-5 h-5 mr-3 shrink-0 flex items-center justify-center bg-[var(--primary-weak)] text-[var(--primary)] rounded text-xs font-bold transition-transform group-active:scale-95 relative z-10">
          <Home class="w-3.5 h-3.5" />
        </div>
        <div v-if="!appStore.isSidebarCollapsed" class="flex flex-col min-w-0 items-start text-left flex-grow relative z-10">
          <span class="truncate font-medium leading-tight w-full text-left">首页</span>
          <span class="truncate text-[10px] text-[var(--text-3)] leading-tight mt-0.5 w-full text-left">系统总览与核心智能体</span>
        </div>
      </Button>

      <!-- 侧边栏标签页：智能体 / 群（始终可见，收缩模式仅显示图标） -->
      <div class="border-b border-[var(--border)]" :class="appStore.isSidebarCollapsed ? 'flex flex-col items-center gap-0.5 py-1' : 'flex items-center gap-1 px-2 mt-1 mb-1'">
        <button
          type="button"
          class="transition-colors"
          :class="appStore.isSidebarCollapsed
            ? ['p-1.5 rounded', appStore.activeSidebarTab === 'agents' ? 'bg-[var(--surface-3)] text-[var(--primary)]' : 'text-[var(--text-3)]']
            : ['flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-t', appStore.activeSidebarTab === 'agents' ? 'text-[var(--primary)] border-b-2 border-[var(--primary)]' : 'text-[var(--text-3)]']"
          :title="appStore.isSidebarCollapsed ? '组织' : ''"
          @click="appStore.activeSidebarTab = 'agents'"
        >
          <Users :class="appStore.isSidebarCollapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'" />
          <template v-if="!appStore.isSidebarCollapsed">组织</template>
        </button>
        <button
          type="button"
          class="transition-colors"
          :class="appStore.isSidebarCollapsed
            ? ['p-1.5 rounded', appStore.activeSidebarTab === 'groups' ? 'bg-[var(--surface-3)] text-[var(--primary)]' : 'text-[var(--text-3)]']
            : ['flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-t', appStore.activeSidebarTab === 'groups' ? 'text-[var(--primary)] border-b-2 border-[var(--primary)]' : 'text-[var(--text-3)]']"
          :title="appStore.isSidebarCollapsed ? '群' : ''"
          @click="appStore.activeSidebarTab = 'groups'; chatStore.fetchGroupList()"
        >
          <MessageCircle :class="appStore.isSidebarCollapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'" />
          <template v-if="!appStore.isSidebarCollapsed">群</template>
        </button>
      </div>

      <!-- 群 页 -->
      <template v-if="appStore.activeSidebarTab === 'groups'">
        <!-- 新建群聊按钮：置顶于群列表上方（不随列表滚动） -->
        <div class="px-1 pt-1 pb-0.5">
          <Button
            variant="outlined"
            class="w-full !justify-center !text-xs !py-1.5"
            :class="appStore.isSidebarCollapsed ? '!px-1' : ''"
            @click="showCreateGroupDialog = true"
          >
            <Plus class="w-3.5 h-3.5" :class="appStore.isSidebarCollapsed ? '' : 'mr-1'" />
            <template v-if="!appStore.isSidebarCollapsed">新建群聊</template>
          </Button>
        </div>
        <div class="flex-1 overflow-y-auto min-h-0">
          <div class="space-y-1 px-1 py-1">
            <div
              v-for="g in activeGroups"
              :key="g.id"
              class="w-full flex items-center rounded cursor-pointer transition-colors text-[var(--text-2)] hover:bg-[var(--surface-2)]"
              :class="[appStore.isSidebarCollapsed ? 'justify-center px-1 py-2' : 'justify-between px-3 py-2', chatStore.activeGroupId === g.id ? '!bg-[var(--surface-3)] !text-[var(--primary)]' : '']"
              @click="handleGroupClick(g.id)"
            >
              <div class="flex items-center min-w-0" :class="appStore.isSidebarCollapsed ? 'justify-center' : ''">
                <div class="shrink-0 flex items-center justify-center bg-[var(--primary-weak)] text-[var(--primary)] rounded font-bold"
                  :class="appStore.isSidebarCollapsed ? 'w-8 h-8 text-xs' : 'w-5 h-5 mr-3 text-xs'">
                  <MessageCircle :class="appStore.isSidebarCollapsed ? 'w-4 h-4' : 'w-3 h-3'" />
                </div>
                <template v-if="!appStore.isSidebarCollapsed">
                  <div class="flex flex-col min-w-0">
                    <span class="truncate font-medium leading-tight">{{ g.name }}</span>
                    <span class="text-[10px] text-[var(--text-3)]">{{ g.memberCount }} 人</span>
                  </div>
                </template>
              </div>
            </div>

            <!-- 已解散（归档）折叠区 -->
            <div v-if="dissolvedGroups.length > 0 && !appStore.isSidebarCollapsed" class="mt-2 border-t border-[var(--border)] pt-1">
              <button
                class="w-full flex items-center px-3 py-1.5 text-[11px] text-[var(--text-3)] rounded hover:bg-[var(--surface-2)] transition-colors"
                @click="showDissolvedGroups = !showDissolvedGroups"
                type="button"
              >
                <component :is="showDissolvedGroups ? ChevronDown : ChevronRight" class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
                <Archive class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
                <span>已解散 ({{ dissolvedGroups.length }})</span>
              </button>
              <template v-if="showDissolvedGroups">
                <div
                  v-for="g in dissolvedGroups"
                  :key="g.id"
                  class="w-full flex items-center rounded cursor-pointer transition-colors text-[var(--text-2)] hover:bg-[var(--surface-2)] opacity-60 px-3 py-2"
                  :class="chatStore.activeGroupId === g.id ? '!bg-[var(--surface-3)] !text-[var(--primary)]' : ''"
                  @click="handleGroupClick(g.id)"
                >
                  <div class="shrink-0 w-5 h-5 mr-3 flex items-center justify-center bg-[var(--surface-3)] text-[var(--text-3)] rounded">
                    <MessageCircle class="w-3 h-3" />
                  </div>
                  <div class="flex flex-col min-w-0">
                    <span class="truncate font-medium leading-tight">{{ g.name }}</span>
                    <span class="text-[10px] text-[var(--text-3)]">已解散 · {{ g.memberCount }} 人</span>
                  </div>
                </div>
              </template>
            </div>

            <div v-if="chatStore.groupList.length === 0" class="text-center text-[var(--text-3)] text-xs py-6">
              暂无群聊
            </div>
          </div>
        </div>
      </template>

      <!-- 智能体 页（可拖拽的组织列表） -->
      <template v-if="appStore.activeSidebarTab === 'agents'">
      <!-- 可拖拽的组织列表 -->
      <VueDraggable
        v-model="draggableOrgs"
        class="space-y-1"
        @end="onDragEnd"
      >
        <Button
          v-for="org in draggableOrgs"
          :key="org.id"
          :data-org-id="org.id"
          variant="text"
          class="w-full !justify-start !px-3 !py-2 text-[var(--text-2)] hover:text-[var(--text-1)] active:translate-y-[1px] active:scale-[0.98] transition-all group relative"
          :class="{
            '!bg-[var(--surface-3)] !text-[var(--primary)]': appStore.currentTabId === org.id,
            'org-item-new': isNewOrg(org.id)
          }"
          v-tooltip.right="appStore.isSidebarCollapsed ? org.name : null"
          @click="handleOrgClick(org)"
          @animationend="handleAnimationEnd(org.id, $event)"
        >
          <!-- 粒子效果容器 - 绝对定位在图标位置 -->
          <div v-if="isNewOrg(org.id)" class="org-item-particles"></div>

          <div class="org-icon w-5 h-5 mr-3 shrink-0 flex items-center justify-center bg-[var(--primary-weak)] text-[var(--primary)] rounded text-xs font-bold transition-transform group-active:scale-95 relative z-10"
            :class="{ 'org-icon-busy': orgBusyMap[org.id] }">
            {{ org.initial }}
          </div>
          <div v-if="!appStore.isSidebarCollapsed" class="flex flex-col min-w-0 items-start text-left flex-grow relative z-10">
            <!-- 编辑模式 -->
            <div v-if="editingOrgId === org.id" class="flex items-center gap-1 w-full" @click.stop>
              <InputText
                v-model="editValue"
                size="small"
                class="w-full !text-xs !py-0.5 !px-1"
                :disabled="savingOrgName"
                @click.stop
                @keydown.enter.stop="saveEditOrgName(org)"
                @keydown.escape.stop="cancelEditOrgName"
              />
              <Check
                class="w-3.5 h-3.5 text-[var(--primary)] cursor-pointer shrink-0"
                :class="{ 'opacity-40': savingOrgName }"
                @click.stop="saveEditOrgName(org)"
              />
              <X
                class="w-3.5 h-3.5 text-[var(--text-3)] cursor-pointer shrink-0"
                @click.stop="cancelEditOrgName"
              />
            </div>
            <!-- 显示模式 -->
            <template v-else>
              <div class="relative w-full">
                <span class="truncate font-medium leading-tight w-full text-left block pr-5">
                  {{ org.name }}
                </span>
                <Pencil
                  class="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 opacity-0 group-hover:opacity-50 hover:!opacity-80 cursor-pointer text-[var(--text-3)]"
                  @click.stop="startEditOrgName(org)"
                />
              </div>
              <span v-if="org.role" class="truncate text-[10px] text-[var(--text-3)] leading-tight mt-0.5 w-full text-left">{{ org.role }}</span>
            </template>
          </div>
          <!-- 工件管理器按钮 -->
          <Button
            v-if="!appStore.isSidebarCollapsed && org.id !== 'home'"
            variant="text"
            rounded
            class="!p-1.5 hover:!bg-[var(--surface-4)] transition-all shrink-0 relative z-10"
            v-tooltip.top="'工件管理'"
            @click.stop="openArtifacts(org)"
          >
            <Briefcase class="w-3.5 h-3.5 text-[var(--text-3)] hover:text-[var(--primary)]" />
          </Button>
        </Button>
      </VueDraggable>

      <!-- 已归档的组织（仅在智能体标签页内展示） -->
      <div v-if="archivedOrgs.length > 0 && !searchQuery" class="border-t border-[var(--border)] mt-2 pt-1">
        <button
          class="w-full flex items-center px-3 py-2 text-xs text-[var(--text-3)] hover:bg-[var(--surface-2)] transition-colors rounded"
          v-tooltip.right="appStore.isSidebarCollapsed ? `归档 (${archivedOrgs.length})` : null"
          @click="showArchivedOrgs = !showArchivedOrgs"
        >
          <component :is="showArchivedOrgs ? ChevronDown : ChevronRight" class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
          <Archive class="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
          <span v-if="!appStore.isSidebarCollapsed" class="font-medium truncate">归档 ({{ archivedOrgs.length }})</span>
        </button>

        <!-- 展开时显示归档列表 -->
        <div v-if="showArchivedOrgs" class="space-y-1 p-1">
          <Button
            v-for="org in archivedOrgs"
            :key="org.id"
            :data-org-id="org.id"
            variant="text"
            class="w-full !justify-start !px-3 !py-2 text-[var(--text-3)] hover:text-[var(--text-2)] active:translate-y-[1px] active:scale-[0.98] transition-all group opacity-60 hover:opacity-100"
            :class="{
              '!bg-[var(--surface-3)] !text-[var(--primary)]': appStore.currentTabId === org.id
            }"
            v-tooltip.right="appStore.isSidebarCollapsed ? org.name : null"
            @click="handleOrgClick(org)"
          >
            <div class="org-icon w-5 h-5 mr-3 shrink-0 flex items-center justify-center bg-[var(--surface-3)] text-[var(--text-3)] rounded text-xs font-bold transition-transform group-active:scale-95 relative z-10">
              {{ org.initial }}
            </div>
            <div v-if="!appStore.isSidebarCollapsed" class="flex flex-col min-w-0 items-start text-left flex-grow relative z-10">
              <span class="truncate font-medium leading-tight w-full text-left text-xs">{{ org.name }}</span>
              <span v-if="org.role" class="truncate text-[10px] text-[var(--text-3)] leading-tight mt-0.5 w-full text-left">{{ org.role }}</span>
            </div>
          </Button>
        </div>
      </div>
      </template>
    </div>
  </aside>

  <!-- 新建群聊对话框 -->
  <Dialog
    v-model:visible="showCreateGroupDialog"
    header="新建群聊"
    modal
    :style="{ width: '560px' }"
    :draggable="false"
    @show="agentStore.fetchAllAgents(true)"
  >
    <div class="flex flex-col gap-3 py-2">
      <InputText
        v-model="newGroupName"
        placeholder="群聊名称（必填）"
        class="!w-full"
        @keydown.enter="handleCreateGroup"
      />
      <InputText
        v-model="newGroupDesc"
        placeholder="群聊描述（选填）"
        class="!w-full"
      />
      <InputText
        v-model="newGroupReason"
        placeholder="拉群原因（必填，将通知给所有成员）"
        class="!w-full"
        @keydown.enter="handleCreateGroup"
      />
      <!-- 成员选择（搜索 + 勾选复用 MemberPicker） -->
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-[var(--text-3)]">选择成员</span>
        <MemberPicker v-model="selectedMembers" :agents="availableAgents" />
        <span v-if="selectedMembers.length > 0" class="text-xs" :class="selectedMembers.length <= 2 ? 'text-red-400' : 'text-[var(--text-3)]'">
          已选 {{ selectedMembers.length }} 个成员{{ selectedMembers.length <= 2 ? '（至少需要 3 个）' : '' }}
        </span>
      </div>
    </div>
    <template #footer>
      <Button
        label="取消"
        variant="text"
        @click="showCreateGroupDialog = false; selectedMembers = []; newGroupReason = ''"
      />
      <Button
        label="创建"
        class="!bg-[var(--primary)] !text-white"
        :disabled="!newGroupName.trim() || selectedMembers.length <= 2 || !newGroupReason.trim()"
        @click="handleCreateGroup"
      />
    </template>
  </Dialog>
</template>

<style scoped>
/* 组织列表：有忙碌智能体时，首字母图标旋转 */
.org-icon-busy {
  animation: org-icon-spin 1.4s linear infinite;
}

.overflow-y-auto {
  scrollbar-width: thin;
  -ms-overflow-style: thin;
  overflow-y: auto;
}
.overflow-y-auto::-webkit-scrollbar {
  display: thin;
}
@keyframes org-icon-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
