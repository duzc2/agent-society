import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Tab } from '../types';
import { configApi } from '../services/configApi';

export const useAppStore = defineStore('app', () => {
  // 侧栏收缩状态
  const isSidebarCollapsed = ref(localStorage.getItem('sidebar_collapsed') === 'true');

  // 主题状态
  const theme = ref<'light' | 'dark'>(
    (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
  );

  // 聊天字体大小
  const chatFontSize = ref(16);

  // 智能体心情颜色开关
  const moodColorsEnabled = ref(true);

  // 活动标签页
  const activeTabs = ref<Tab[]>([]);
  const currentTabId = ref('');

  // Actions
  const toggleSidebar = () => {
    isSidebarCollapsed.value = !isSidebarCollapsed.value;
    localStorage.setItem('sidebar_collapsed', String(isSidebarCollapsed.value));
  };

  const setTheme = (newTheme: 'light' | 'dark') => {
    theme.value = newTheme;
    localStorage.setItem('theme', newTheme);
  };

  const openTab = (tab: Tab) => {
    const existingTab = activeTabs.value.find(t => t.id === tab.id);
    if (!existingTab) {
      activeTabs.value.push(tab);
    }
    currentTabId.value = tab.id;
  };

  /**
   * 初始化应用，默认打开首页
   */
  const initApp = () => {
    if (activeTabs.value.length === 0) {
      openTab({
        id: 'home',
        type: 'org',
        title: '首页'
      });
    }
  };

  const closeTab = (tabId: string) => {
    if (tabId === 'home') return; // 首页不可关闭
    const index = activeTabs.value.findIndex(t => t.id === tabId);
    if (index === -1) return;

    activeTabs.value.splice(index, 1);

    // 如果关闭的是当前标签，且还有其他标签，切换到临近标签
    if (currentTabId.value === tabId && activeTabs.value.length > 0) {
      const nextTab = activeTabs.value[Math.min(index, activeTabs.value.length - 1)];
      currentTabId.value = nextTab ? nextTab.id : '';
    } else if (activeTabs.value.length === 0) {
      currentTabId.value = '';
    }
  };

  // 从服务器加载聊天字体大小
  const loadChatFontSize = async () => {
    try {
      const data = await configApi.getChatConfig();
      chatFontSize.value = data.fontSize;
    } catch {
      // 加载失败保持默认值
    }
  };

  // 保存聊天字体大小到服务器
  const saveChatFontSize = async (size: number) => {
    try {
      await configApi.saveChatConfig({ fontSize: size });
    } catch {
      // 静默失败
    }
  };

  // 设置聊天字体大小（即时生效 + 异步保存）
  const setChatFontSize = (size: number) => {
    chatFontSize.value = size;
    saveChatFontSize(size);
  };

  // 从服务器加载心情颜色设置
  const loadMoodColorsSetting = async () => {
    try {
      const data = await configApi.getAppSettings();
      moodColorsEnabled.value = data.settings.moodColors?.enabled ?? true;
    } catch {
      // 静默失败，保持默认值
    }
  };

  // 保存心情颜色设置
  const saveMoodColorsSetting = async (enabled: boolean) => {
    moodColorsEnabled.value = enabled;
    try {
      const data = await configApi.getAppSettings();
      await configApi.saveAppSettings({
        ...data.settings,
        moodColors: { enabled }
      });
    } catch {
      // 静默失败
    }
  };

  return {
    isSidebarCollapsed,
    theme,
    chatFontSize,
    moodColorsEnabled,
    activeTabs,
    currentTabId,
    toggleSidebar,
    setTheme,
    setChatFontSize,
    loadChatFontSize,
    loadMoodColorsSetting,
    saveMoodColorsSetting,
    openTab,
    closeTab,
    initApp
  };
});
