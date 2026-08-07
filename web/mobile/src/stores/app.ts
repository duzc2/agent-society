import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 应用全局状态（移动端精简版）
 * - 主题（亮/暗）
 * - 当前页面（orgs / chat / settings）
 * - 文件查看器状态
 * - 错误信息
 */
export type PageName = 'orgs' | 'chat' | 'settings' | 'agentProps' | 'roleProps';

export interface FileViewerState {
  open: boolean;
  fileName: string;
  mimeType: string;
  content: string;
  // 如果是图片 URL，直接用 src
  src?: string;
  // 工作区文件路径（HTML 用 iframe src 加载时需要）
  filePath?: string;
}

export interface WorkspaceFileItem {
  name: string;
  path: string;
  size: number;
  extension: string;
  modifiedAt: string;
  mimeType: string;
  lastOperator: string;
  lastMessageId: string;
  type: 'file';
}

export interface WorkspaceDirItem {
  name: string;
  path: string;
  type: 'directory';
  children?: WorkspaceEntry[];
}

export type WorkspaceEntry = WorkspaceFileItem | WorkspaceDirItem;

export const useAppStore = defineStore('app', () => {
  const theme = ref<'light' | 'dark'>(
    (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
  );

  const currentPage = ref<PageName>('orgs');

  // 当前选中的组织 ID（进入聊天时设置）
  const currentOrgId = ref<string | null>(null);

  // 聊天字体大小
  const chatFontSize = ref(16);

  // 智能体心情颜色开关
  const moodColorsEnabled = ref(true);

  // 文件查看器
  const fileViewer = ref<FileViewerState>({
    open: false,
    fileName: '',
    mimeType: '',
    content: '',
    src: undefined,
    filePath: undefined
  });

  // 工作区
  const showWorkspace = ref(false);

  // 属性页参数
  const agentPropsAgentId = ref<string | null>(null);
  const rolePropsRoleId = ref<string | null>(null);
  const rolePropsRoleName = ref<string | null>(null);

  // 页面栈（仅属性页返回使用）
  const pageStack = ref<PageName[]>([]);

  // 错误横幅
  const errorMessage = ref<string | null>(null);

  function setTheme(newTheme: 'light' | 'dark') {
    theme.value = newTheme;
    localStorage.setItem('theme', newTheme);
  }

  function navigateTo(page: PageName, orgId?: string | null) {
    currentPage.value = page;
    if (orgId !== undefined) {
      currentOrgId.value = orgId;
    }
    if (page === 'orgs' || page === 'chat' || page === 'settings') {
      pageStack.value = [];
    }
  }

  function navigateToAgentProps(agentId: string) {
    pageStack.value.push(currentPage.value);
    agentPropsAgentId.value = agentId;
    currentPage.value = 'agentProps';
  }

  function navigateToRoleProps(roleId: string, roleName: string) {
    pageStack.value.push(currentPage.value);
    rolePropsRoleId.value = roleId;
    rolePropsRoleName.value = roleName;
    currentPage.value = 'roleProps';
  }

  function goBack() {
    const prev = pageStack.value.pop();
    if (prev) {
      currentPage.value = prev;
    } else {
      currentPage.value = 'orgs';
    }
  }

  function openFileViewer(opts: Omit<FileViewerState, 'open'>) {
    fileViewer.value = {
      ...opts,
      open: true
    };
  }

  function closeFileViewer() {
    fileViewer.value.open = false;
  }

  function setError(msg: string | null) {
    errorMessage.value = msg;
  }

  function clearError() {
    errorMessage.value = null;
  }

  function toggleWorkspace() {
    showWorkspace.value = !showWorkspace.value;
  }

  // 设置聊天字体大小（即时生效 + 异步保存）
  function setChatFontSize(size: number) {
    chatFontSize.value = size;
    fetch('/api/config/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fontSize: size })
    }).catch(() => {});
  }

  // 从服务器加载聊天字体大小
  async function loadChatFontSize() {
    try {
      const res = await fetch('/api/config/chat');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.fontSize === 'number') {
          chatFontSize.value = data.fontSize;
        }
      }
    } catch {
      // 加载失败保持默认值
    }
  }

  // 从服务器加载心情颜色设置
  async function loadMoodColorsSetting() {
    try {
      const res = await fetch('/api/config/app-settings');
      if (res.ok) {
        const data = await res.json();
        moodColorsEnabled.value = data.settings?.moodColors?.enabled ?? true;
      }
    } catch {
      // 静默失败
    }
  }

  // 保存心情颜色设置
  function setMoodColorsEnabled(enabled: boolean) {
    moodColorsEnabled.value = enabled;
    fetch('/api/config/app-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { moodColors: { enabled } } })
    }).catch(() => {});
  }

  return {
    theme,
    currentPage,
    currentOrgId,
    chatFontSize,
    moodColorsEnabled,
    fileViewer,
    showWorkspace,
    agentPropsAgentId,
    rolePropsRoleId,
    rolePropsRoleName,
    pageStack,
    errorMessage,
    setTheme,
    navigateTo,
    navigateToAgentProps,
    navigateToRoleProps,
    goBack,
    setChatFontSize,
    loadChatFontSize,
    loadMoodColorsSetting,
    setMoodColorsEnabled,
    openFileViewer,
    closeFileViewer,
    toggleWorkspace,
    setError,
    clearError
  };
});
