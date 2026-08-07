<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--surface-1)] text-[var(--text-1)]">
    <div v-if="error" class="px-4 pt-4">
      <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
        {{ error }}
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col">
      <Tabs v-model:value="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabList class="border-b border-[var(--border)] px-4">
          <Tab value="catalog" class="flex items-center gap-2">
            <Search class="h-4 w-4" />
            <span>技能列表</span>
          </Tab>
          <Tab value="custom" class="flex items-center gap-2">
            <Package class="h-4 w-4" />
            <span>自定义技能</span>
          </Tab>
          <Tab value="git" class="flex items-center gap-2">
            <GitBranch class="h-4 w-4" />
            <span>Git 导入</span>
          </Tab>
        </TabList>

        <TabPanels class="min-h-0 flex-1 bg-transparent">
          <TabPanel value="catalog" class="h-full p-0">
            <div class="flex h-full min-h-0 flex-col xl:flex-row">
              <div class="flex min-h-0 w-full flex-col border-b border-[var(--border)] xl:w-[420px] xl:border-r xl:border-b-0">
                <div class="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
                  <div class="relative min-w-0 flex-1">
                    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-3)]" />
                    <InputText
                      v-model="searchText"
                      placeholder="搜索技能名称、skillId、标签"
                      class="w-full !pl-9"
                    />
                  </div>
                  <Button
                    variant="text"
                    rounded
                    class="!p-2"
                    :loading="loading"
                    @click="refreshAll"
                  >
                    <RefreshCw class="h-4 w-4" />
                  </Button>
                </div>

                <div v-if="loading && skills.length === 0" class="flex flex-1 items-center justify-center">
                  <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
                </div>

                <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
                  <div v-if="filteredSkills.length === 0" class="flex h-full items-center justify-center text-sm text-[var(--text-3)]">
                    没有匹配的技能
                  </div>

                  <button
                    v-for="skill in filteredSkills"
                    :key="skill.skillId"
                    type="button"
                    class="mb-2 flex w-full flex-col rounded-lg border p-3 text-left transition-colors"
                    :class="selectedSkillId === skill.skillId
                      ? 'border-[var(--primary)] bg-[var(--primary)]/5'
                      : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--text-3)]'"
                    @click="selectSkill(skill.skillId)"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium text-[var(--text-1)]">
                          {{ skill.displayName }}
                        </div>
                        <div class="mt-1 line-clamp-2 text-xs text-[var(--text-2)]">
                          {{ skill.description || '暂无描述' }}
                        </div>
                      </div>
                      <span class="rounded-full px-2 py-0.5 text-xs" :class="installStateClass(skill.installState)">
                        {{ installStateLabel(skill.installState) }}
                      </span>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-3)]">
                      <span>{{ skill.skillId }}</span>
                      <span>岗位 {{ skill.roleUsageCount }}</span>
                      <span>智能体 {{ skill.agentUsageCount }}</span>
                    </div>
                  </button>
                </div>
              </div>

              <div class="flex min-h-0 flex-1 flex-col overflow-y-auto ">
                <div v-if="!selectedSkill" class="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">
                  请选择一个技能
                </div>

                <div v-else class="flex min-h-0 flex-1 flex-col">
                  <div class="shrink-0 border-b border-[var(--border)] px-4 py-3">
                    <div class="flex flex-col gap-2">
                      <div class="flex flex-wrap items-center gap-2">
                        <div class="text-base font-medium text-[var(--text-1)]">
                          {{ selectedSkillMeta?.displayName || selectedSkill.displayName }}
                        </div>
                        <span class="rounded-full px-2 py-0.5 text-xs" :class="installStateClass(selectedSkill.installState)">
                          {{ installStateLabel(selectedSkill.installState) }}
                        </span>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <Button
                          v-if="!selectedSkill.installed"
                          size="small"
                          :loading="installingSkillId === selectedSkill.skillId"
                          @click="installSelectedSkill"
                        >
                          一键安装
                        </Button>
                        <Button
                          v-else
                          size="small"
                          variant="outlined"
                          severity="danger"
                          :loading="uninstallingSkillId === selectedSkill.skillId"
                          @click="confirmUninstallSelectedSkill"
                        >
                          一键卸载
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          @click="openOverviewDialog"
                        >
                          查看配置
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          @click="openCopyDialog"
                        >
                          <Copy class="h-4 w-4 mr-1" />
                          复制
                        </Button>
                      </div>
                    </div>
                    <div class="mt-2 text-sm text-[var(--text-2)]">
                      {{ selectedSkillMeta?.description || selectedSkill.description || '暂无描述' }}
                    </div>
                    <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-3)]">
                      <span>技能 ID：{{ selectedSkill.skillId }}</span>
                      <span>来源：{{ selectedSkill.providerId }}</span>
                      <span>类型：{{ selectedSkill.kind }}</span>
                      <span>岗位引用：{{ selectedSkill.roleUsageCount }}</span>
                      <span>智能体引用：{{ selectedSkill.agentUsageCount }}</span>
                    </div>
                    <div v-if="selectedSkill.tags?.length" class="mt-2 flex flex-wrap gap-1">
                      <span
                        v-for="tag in selectedSkill.tags"
                        :key="tag"
                        class="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-xs text-[var(--text-2)]"
                      >
                        {{ tag }}
                      </span>
                    </div>
                  </div>

                  <div class="min-h-[320px] flex-1 p-4">
                    <div class="space-y-4">
                      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
                        <div class="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--text-1)]">
                          <Package class="h-4 w-4" />
                          <span>技能基础信息</span>
                        </div>

                        <div class="grid gap-3 lg:grid-cols-2">
                          <div
                            v-for="item in detailInfoItems"
                            :key="item.label"
                            class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3"
                          >
                            <div class="text-xs text-[var(--text-3)]">{{ item.label }}</div>
                            <a
                              v-if="item.url"
                              :href="item.url"
                              target="_blank"
                              rel="noreferrer"
                              class="mt-1 block break-all text-sm leading-5 text-[var(--primary)] hover:underline"
                            >
                              {{ item.value }}
                            </a>
                            <div v-else class="mt-1 break-all text-sm leading-5 text-[var(--text-1)]">
                              {{ item.value }}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
                        <div class="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--text-1)]">
                          <Package class="h-4 w-4" />
                          <span>技能说明</span>
                        </div>

                        <div v-if="detailLoading" class="flex items-center justify-center py-10">
                          <Loader2 class="h-5 w-5 animate-spin text-[var(--primary)]" />
                        </div>

                        <div v-else class="space-y-4">
                          <div v-if="detailError" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                            {{ detailError }}
                          </div>

                          <div v-if="selectedSkillDetail?.skillMd" class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                            <MessageContent :content="selectedSkillDetail.skillMd" />
                          </div>

                          <div v-else class="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--text-3)]">
                            当前暂时无法获取这个技能的完整说明。请检查网络连接，或稍后再试。
                          </div>

                          <div v-if="selectedSkillDetail?.referenceMd" class="space-y-2">
                            <div class="text-sm font-medium text-[var(--text-1)]">补充参考</div>
                            <div class="max-h-[420px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
                              <MessageContent :content="selectedSkillDetail.referenceMd" />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

          <TabPanel value="custom" class="h-full p-0">
            <CustomSkillTab :newly-copied-skill-id="newlyCopiedSkillId" @skill-selected="newlyCopiedSkillId = ''" />
          </TabPanel>

          <TabPanel value="git" class="h-full p-0">
            <GitSkillTab />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>

    <CopySkillDialog
      v-model:visible="copyDialogVisible"
      :source-skill-name="copySourceSkillName"
      @confirm="handleCopyConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { useDialog } from 'primevue/usedialog';
import { Loader2, Package, RefreshCw, Search, Copy, GitBranch } from 'lucide-vue-next';
import { skillApi, type SkillCatalogItem, type SkillContentResponse } from '../../services/skillApi';
import { customSkillApi } from '../../services/customSkillApi';
import { openCustomSkillEditorWindow } from './custom/customSkillWindow';
import { openSkillOverviewDialog } from './skillOverviewWindow';
import MessageContent from '../chat/MessageContent.vue';
import CustomSkillTab from './custom/CustomSkillTab.vue';
import GitSkillTab from './git/GitSkillTab.vue';
import CopySkillDialog from './CopySkillDialog.vue';

interface SkillDetailInfoItem {
  label: string;
  value: string;
  url?: string;
}

const confirm = useConfirm();
const toast = useToast();
const dialog = useDialog();

const activeTab = ref<'catalog' | 'custom' | 'git'>('catalog');
const loading = ref(false);
const error = ref('');
const detailError = ref('');
const searchText = ref('');
const skills = ref<SkillCatalogItem[]>([]);
const selectedSkillId = ref('');
const installingSkillId = ref('');
const uninstallingSkillId = ref('');
const copyingSkillId = ref('');
const copyDialogVisible = ref(false);
const copySourceSkillName = ref('');
const newlyCopiedSkillId = ref('');
const refreshToken = ref(0);
const detailLoading = ref(false);
const selectedSkillDetail = ref<SkillContentResponse | null>(null);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let listRequestSerial = 0;

/**
 * 技能搜索以服务端结果为准。
 * 前端不再对本次结果做二次裁剪，避免把远端搜索结果误过滤掉。
 */
const filteredSkills = computed(() => skills.value);

/**
 * 获取当前选中的技能概览对象。
 */
const selectedSkill = computed(() => {
  return skills.value.find((item) => item.skillId === selectedSkillId.value) || null;
});

/**
 * 获取当前用于详情展示的技能元数据。
 * 优先使用详情接口返回的远端补全信息，其次使用列表概览。
 */
const selectedSkillMeta = computed(() => {
  return selectedSkillDetail.value?.skill || selectedSkill.value || null;
});

/**
 * 构建技能基础信息卡片数据。
 * 长链接统一单独成块展示，避免和包名挤在一行。
 */
const detailInfoItems = computed<SkillDetailInfoItem[]>(() => {
  const skill = selectedSkillMeta.value;
  if (!skill) {
    return [];
  }

  return [
    { label: '技能 ID', value: skill.skillId },
    { label: '来源', value: skill.providerId },
    { label: '类型', value: skill.kind },
    { label: '包名', value: skill.externalId },
    { label: '安装状态', value: installStateLabel(skill.installState) },
    { label: '岗位引用', value: String(skill.roleUsageCount) },
    { label: '智能体引用', value: String(skill.agentUsageCount) },
    { label: '技能页面', value: skill.homepageUrl || '无', url: skill.homepageUrl || undefined },
    { label: '安装地址', value: skill.installUrl || '无', url: skill.installUrl || undefined },
    { label: '源码地址', value: skill.sourceUrl || '无', url: skill.sourceUrl || undefined }
  ];
});

/**
 * 选择技能。
 * @param skillId 技能 ID
 */
const selectSkill = (skillId: string) => {
  selectedSkillId.value = skillId;
};

/**
 * 加载当前选中技能的详细内容。
 * 未安装技能优先尝试读取来源侧说明文档，已安装技能优先读取本地包内文档。
 */
const loadSelectedSkillDetail = async () => {
  if (!selectedSkillId.value) {
    selectedSkillDetail.value = null;
    detailError.value = '';
    return;
  }

  detailLoading.value = true;
  detailError.value = '';
  try {
    selectedSkillDetail.value = await skillApi.getSkillContent(selectedSkillId.value);
  } catch (detailLoadError: any) {
    console.error('加载技能详细内容失败', detailLoadError);
    selectedSkillDetail.value = null;
    detailError.value = detailLoadError?.message || '加载技能详细内容失败';
  } finally {
    detailLoading.value = false;
  }
};

/**
 * 刷新技能列表与当前选中技能详情。
 */
const refreshAll = async (query?: string | Event) => {
  const requestSerial = ++listRequestSerial;
  const normalizedQuery = typeof query === 'string' ? query.trim() : searchText.value.trim();
  loading.value = true;
  error.value = '';
  try {
    const list = await skillApi.listSkills(normalizedQuery);
    if (requestSerial !== listRequestSerial) {
      return;
    }
    skills.value = list;

    if (!selectedSkillId.value || !list.some((item) => item.skillId === selectedSkillId.value)) {
      selectedSkillId.value = list[0]?.skillId || '';
    }

    refreshToken.value += 1;
    await loadSelectedSkillDetail();
  } catch (loadError: any) {
    console.error('加载技能管理数据失败', loadError);
    error.value = loadError?.message || '加载技能管理数据失败';
  } finally {
    loading.value = false;
  }
};

/**
 * 安装当前选中的技能。
 */
const installSelectedSkill = async () => {
  const skill = selectedSkill.value;
  if (!skill || installingSkillId.value) {
    return;
  }

  installingSkillId.value = skill.skillId;
  try {
    await skillApi.installSkill({
      providerId: skill.providerId,
      externalId: skill.externalId,
      installUrl: skill.installUrl || undefined
    });
    toast.add({
      severity: 'success',
      summary: '安装成功',
      detail: `${skill.displayName} 已安装`,
      life: 3000
    });
    await refreshAll();
  } catch (installError: any) {
    console.error('安装技能失败', installError);
    toast.add({
      severity: 'error',
      summary: '安装失败',
      detail: installError?.message || '安装技能失败',
      life: 5000
    });
  } finally {
    installingSkillId.value = '';
  }
};

/**
 * 卸载当前选中的技能。
 */
const uninstallSelectedSkill = async () => {
  const skill = selectedSkill.value;
  if (!skill || uninstallingSkillId.value) {
    return;
  }

  uninstallingSkillId.value = skill.skillId;
  try {
    await skillApi.uninstallSkill(skill.skillId);
    toast.add({
      severity: 'success',
      summary: '卸载成功',
      detail: `${skill.displayName} 已卸载`,
      life: 3000
    });
    await refreshAll();
  } catch (uninstallError: any) {
    console.error('卸载技能失败', uninstallError);
    toast.add({
      severity: 'error',
      summary: '卸载失败',
      detail: uninstallError?.message || '卸载技能失败',
      life: 5000
    });
  } finally {
    uninstallingSkillId.value = '';
  }
};

/**
 * 弹出卸载确认。
 */
const confirmUninstallSelectedSkill = () => {
  const skill = selectedSkill.value;
  if (!skill) {
    return;
  }

  confirm.require({
    message: `确认卸载技能“${skill.displayName}”？已配置的岗位和智能体会保留配置，但运行时不可见。`,
    header: '卸载技能',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: {
      label: '取消',
      severity: 'secondary',
      outlined: true
    },
    acceptProps: {
      label: '确认卸载',
      severity: 'danger'
    },
    accept: () => {
      void uninstallSelectedSkill();
    }
  });
};

/**
 * 复制选中技能为自定义技能并打开编辑器。
 */
const copySelectedSkill = async (displayName?: string) => {
  const skill = selectedSkill.value;
  if (!skill || copyingSkillId.value) {
    return;
  }

  copyingSkillId.value = skill.skillId;
  try {
    const result = await customSkillApi.copySkillAsCustom(skill.skillId, displayName || undefined);
    toast.add({
      severity: 'success',
      summary: '复制成功',
      detail: '已创建新的自定义技能',
      life: 2500
    });
    newlyCopiedSkillId.value = result.skill.skillId;
    activeTab.value = 'custom';
    openCustomSkillEditorWindow(dialog, { skillId: result.skill.skillId, sourceContext: 'skill_manager_tab' });
  } catch (copyError: any) {
    console.error('复制技能失败', copyError);
    toast.add({
      severity: 'error',
      summary: '复制失败',
      detail: copyError?.message || '复制技能失败',
      life: 5000
    });
  } finally {
    copyingSkillId.value = '';
  }
};

/**
 * 打开复制对话框。
 */
const openCopyDialog = () => {
  const skill = selectedSkill.value;
  if (!skill) return;
  copySourceSkillName.value = skill.displayName;
  copyDialogVisible.value = true;
};

/**
 * 打开查看配置对话框。
 */
const openOverviewDialog = () => {
  const skill = selectedSkill.value;
  if (!skill) return;
  openSkillOverviewDialog(dialog, skill.skillId);
};

/**
 * 处理复制对话框确认。
 */
const handleCopyConfirm = ({ displayName }: { displayName: string }) => {
  void copySelectedSkill(displayName || undefined);
};

/**
 * 获取安装状态文案。
 * @param state 安装状态
 */
const installStateLabel = (state: string) => {
  if (state === 'installed') return '已安装';
  if (state === 'installing') return '安装中';
  if (state === 'corrupted') return '已损坏';
  return '未安装';
};

/**
 * 获取安装状态样式。
 * @param state 安装状态
 */
const installStateClass = (state: string) => {
  if (state === 'installed') return 'bg-green-500/10 text-green-600';
  if (state === 'corrupted') return 'bg-red-500/10 text-red-600';
  if (state === 'installing') return 'bg-amber-500/10 text-amber-600';
  return 'bg-[var(--surface-3)] text-[var(--text-3)]';
};

onMounted(() => {
  void refreshAll();
});

watch(selectedSkillId, () => {
  void loadSelectedSkillDetail();
});

watch(searchText, (value) => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    void refreshAll(value);
  }, 250);
});
</script>

<style scoped>
:deep(.p-tabpanels) {
  background: transparent;
}

:deep(.p-tabpanel) {
  background: transparent;
}
</style>
