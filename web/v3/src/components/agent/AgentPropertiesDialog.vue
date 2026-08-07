<template>
  <div class="flex h-[720px] flex-col text-[var(--text-1)]">
    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Loader2 class="h-6 w-6 animate-spin text-[var(--primary)]" />
      <span class="ml-2 text-sm text-[var(--text-2)]">加载智能体属性中...</span>
    </div>

    <div v-else-if="error" class="p-4">
      <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
        {{ error }}
      </div>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs v-model:value="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabList class="border-b border-[var(--border)] px-4">
          <Tab value="basic" class="flex items-center gap-2">
            <Info class="h-4 w-4" />
            <span>基本信息</span>
          </Tab>
          <Tab value="prompt" class="flex items-center gap-2">
            <FileText class="h-4 w-4" />
            <span>Prompt</span>
          </Tab>
          <Tab value="subRoles" class="flex items-center gap-2">
            <Network class="h-4 w-4" />
            <span>子岗位</span>
          </Tab>
          <Tab value="skills" class="flex items-center gap-2">
            <Puzzle class="h-4 w-4" />
            <span>技能</span>
          </Tab>
          <Tab value="todo" class="flex items-center gap-2">
            <ListTodo class="h-4 w-4" />
            <span>待办</span>
          </Tab>
        </TabList>

        <TabPanels class="min-h-0 flex-1 overflow-hidden">
          <TabPanel value="basic" class="h-full overflow-y-auto p-4">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="mb-1 text-xs text-[var(--text-3)]">智能体 ID</div>
                <div class="flex items-start justify-between gap-2">
                  <div class="break-all text-sm text-[var(--text-1)]">{{ agentId || '-' }}</div>
                  <Button
                    variant="text"
                    rounded
                    class="!p-1.5 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
                    :disabled="!agentId"
                    title="复制"
                    @click="copyText(agentId)"
                  >
                    <Copy class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="mb-1 text-xs text-[var(--text-3)]">名称</div>
                <div class="flex items-start justify-between gap-2">
                  <div class="break-all text-sm text-[var(--text-1)]">{{ agentName || '-' }}</div>
                  <Button
                    variant="text"
                    rounded
                    class="!p-1.5 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
                    :disabled="!agentName"
                    title="复制"
                    @click="copyText(agentName)"
                  >
                    <Copy class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="mb-1 text-xs text-[var(--text-3)]">岗位</div>
                <div class="flex items-start justify-between gap-2">
                  <div class="break-all text-sm text-[var(--text-1)]">{{ roleName || '-' }}</div>
                  <div class="flex shrink-0 items-center gap-1">
                    <Button
                      variant="text"
                      size="small"
                      class="!px-2 !py-1 !text-xs !text-[var(--primary)] hover:!bg-[var(--surface-3)]"
                      :disabled="!roleId"
                      label="打开岗位属性"
                      @click="openRoleProperties"
                    />
                    <Button
                      variant="text"
                      rounded
                      class="!p-1.5 !text-[var(--text-3)] hover:!bg-[var(--surface-3)]"
                      :disabled="!roleName"
                      title="复制"
                      @click="copyText(roleName)"
                    >
                      <Copy class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="mb-1 text-xs text-[var(--text-3)]">状态</div>
                <div class="text-sm text-[var(--text-1)]">{{ statusLabel }}</div>
              </div>
            </div>

            <div class="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <div class="mb-2 text-xs text-[var(--text-3)]">Chrome 数据管理</div>
              <p class="mb-3 text-xs text-[var(--text-3)]">
                删除该智能体的 Chrome 浏览器用户数据（包括 cookies、缓存、浏览历史等）。下次使用浏览器工具时将重新创建。
              </p>
              <div class="flex items-center gap-2">
                <Button
                  severity="danger"
                  variant="outlined"
                  size="small"
                  :loading="deletingChromeData"
                  :disabled="deletingChromeData"
                  @click="confirmDeleteChromeData"
                >
                  <Trash2 class="mr-1 h-3.5 w-3.5" />
                  删除Chrome数据
                </Button>
                <span v-if="chromeDeleteSuccess" class="text-xs text-green-600">{{ chromeDeleteSuccess }}</span>
              </div>
            </div>
          </TabPanel>

          <TabPanel value="prompt" class="h-full overflow-y-auto p-4">
            <div class="space-y-4">
              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="mb-2 flex items-center justify-between">
                  <div class="text-xs text-[var(--text-3)]">systemPromptAppendix 条目</div>
                  <Button
                    variant="text"
                    class="!px-2 !py-1 !text-xs !text-[var(--primary)] hover:!bg-[var(--surface-3)]"
                    @click="addSystemPromptAppendixItem"
                  >
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    新增条目
                  </Button>
                </div>

                <div
                  v-if="systemPromptAppendix.length === 0"
                  class="py-3 text-xs text-[var(--text-3)]"
                >
                  暂无条目，可以点击“新增条目”添加。
                </div>

                <div v-else class="space-y-3">
                  <div
                    v-for="(item, index) in systemPromptAppendix"
                    :key="`appendix-${index}`"
                    class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2"
                  >
                    <div class="mb-2 flex items-center justify-between">
                      <div class="text-xs text-[var(--text-3)]">条目 {{ index + 1 }}</div>
                      <Button
                        variant="text"
                        class="!px-2 !py-1 !text-xs !text-red-500 hover:!bg-[var(--surface-3)]"
                        @click="removeSystemPromptAppendixItem(index)"
                      >
                        删除
                      </Button>
                    </div>
                    <Textarea
                      :model-value="item"
                      :rows="4"
                      class="w-full !bg-[var(--surface-1)] !text-sm"
                      @update:model-value="
                        (value) => updateSystemPromptAppendixItem(index, value || '')
                      "
                    />
                  </div>
                </div>

                <div v-if="saveError" class="mt-2 text-xs text-red-500">{{ saveError }}</div>
                <div v-if="saveSuccess" class="mt-2 text-xs text-green-600">{{ saveSuccess }}</div>

                <div class="mt-3 flex justify-end">
                  <Button
                    label="保存"
                    size="small"
                    :loading="saving"
                    :disabled="saving"
                    @click="saveSystemPromptAppendix"
                  />
                </div>
              </div>

              <div class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div class="flex items-center justify-between">
                  <div class="text-xs text-[var(--text-3)]">System Prompt</div>
                  <Button
                    variant="text"
                    class="!px-2 !py-1 !text-xs !text-[var(--primary)] hover:!bg-[var(--surface-3)]"
                    @click="isSystemPromptCollapsed = !isSystemPromptCollapsed"
                  >
                    {{ isSystemPromptCollapsed ? '展开' : '折叠' }}
                  </Button>
                </div>

                <div v-if="isSystemPromptCollapsed" class="mt-2 text-xs text-[var(--text-3)]">
                  已折叠，点击“展开”查看完整 system prompt。
                </div>

                <Textarea
                  v-else
                  :model-value="systemPrompt"
                  :rows="16"
                  readonly
                  class="mt-2 w-full !bg-[var(--surface-1)] !text-sm"
                />
              </div>
            </div>
          </TabPanel>

          <TabPanel value="subRoles" class="h-full overflow-y-auto p-0">
            <AgentSubRolesPanel :agent-id="agentId" />
          </TabPanel>

          <TabPanel value="skills" class="h-full overflow-y-auto p-4">
            <SkillBindingPanel
              :target-type="'agent'"
              :target-id="agentId"
              :selected-skill-id="selectedSkillId"
            />
          </TabPanel>
          <TabPanel value="todo" class="h-full overflow-y-auto p-4">
            <AgentTodoPanel :agent-id="agentId" />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import { useDialog } from 'primevue/usedialog';
import { Copy, FileText, Info, ListTodo, Loader2, Network, Plus, Puzzle, Trash2 } from 'lucide-vue-next';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { apiService } from '../../services/api';
import { createDragEndHandler } from '../../utils/dialogBounds';
import RoleDetailDialog from '../overview/RoleDetailDialog.vue';
import AgentSubRolesPanel from './AgentSubRolesPanel.vue';
import SkillBindingPanel from '../skills/SkillBindingPanel.vue';
import AgentTodoPanel from './AgentTodoPanel.vue';

interface AgentPropertiesDialogData {
  agentId: string;
  agentName?: string;
  roleName?: string;
  roleId?: string | null;
  agentStatus?: 'online' | 'offline' | 'busy' | string;
  initialTab?: string;
  selectedSkillId?: string;
}

const dialog = useDialog();
const confirm = useConfirm();
const toast = useToast();
const dialogRef = inject<any>('dialogRef');
const dialogData = (dialogRef?.value?.data || {}) as AgentPropertiesDialogData;

const agentId = dialogData.agentId || '';
const agentName = dialogData.agentName || '';
const roleName = dialogData.roleName || '';
const roleId = dialogData.roleId || '';
const agentStatus = dialogData.agentStatus || '';
const activeTab = ref(dialogData.initialTab || 'basic');
const selectedSkillId = ref(dialogData.selectedSkillId || '');

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saveError = ref('');
const saveSuccess = ref('');
const systemPrompt = ref('');
const systemPromptAppendix = ref<string[]>([]);
const isSystemPromptCollapsed = ref(true);
const deletingChromeData = ref(false);
const chromeDeleteSuccess = ref('');

/**
 * 计算状态展示文本，保持弹窗与主界面口径一致。
 */
const statusLabel = computed(() => {
  if (agentStatus === 'online') return '在线';
  if (agentStatus === 'busy') return '忙碌';
  if (agentStatus === 'offline') return '离线';
  return '-';
});

/**
 * 归一化附录条目，避免空字符串写入后端。
 * @param items 原始条目列表
 * @returns 过滤后的有效条目
 */
const normalizeSystemPromptAppendixItems = (items: string[]): string[] => {
  return (items || [])
    .map((item) => (item ?? '').trim())
    .filter((item) => item.length > 0);
};

/**
 * 加载智能体属性数据。
 */
const loadAgentProperties = async () => {
  if (!agentId) {
    error.value = '缺少智能体 ID。';
    loading.value = false;
    return;
  }

  loading.value = true;
  error.value = '';
  saveError.value = '';
  saveSuccess.value = '';
  systemPrompt.value = '';
  systemPromptAppendix.value = [];
  isSystemPromptCollapsed.value = true;

  try {
    const [systemPromptResponse, appendixResponse] = await Promise.all([
      apiService.getAgentSystemPrompt(agentId),
      apiService.getAgentSystemPromptAppendix(agentId)
    ]);

    systemPrompt.value = systemPromptResponse.systemPrompt || '';
    systemPromptAppendix.value = normalizeSystemPromptAppendixItems(
      appendixResponse.systemPromptAppendix || []
    );
  } catch (loadError: any) {
    console.error('加载智能体属性失败:', loadError);
    error.value = loadError?.message || '加载属性失败。';
  } finally {
    loading.value = false;
  }
};

/**
 * 新增一个可编辑的附录条目。
 */
const addSystemPromptAppendixItem = () => {
  saveError.value = '';
  saveSuccess.value = '';
  systemPromptAppendix.value.push('');
};

/**
 * 删除指定下标的附录条目。
 * @param index 条目下标
 */
const removeSystemPromptAppendixItem = (index: number) => {
  if (index < 0 || index >= systemPromptAppendix.value.length) {
    return;
  }

  saveError.value = '';
  saveSuccess.value = '';
  systemPromptAppendix.value.splice(index, 1);
};

/**
 * 更新指定下标的附录条目内容。
 * @param index 条目下标
 * @param value 条目内容
 */
const updateSystemPromptAppendixItem = (index: number, value: string) => {
  if (index < 0 || index >= systemPromptAppendix.value.length) {
    return;
  }

  saveError.value = '';
  saveSuccess.value = '';
  systemPromptAppendix.value[index] = value;
};

/**
 * 保存附录条目，保持前后端数据格式一致。
 */
const saveSystemPromptAppendix = async () => {
  if (!agentId) {
    return;
  }

  saving.value = true;
  saveError.value = '';
  saveSuccess.value = '';

  try {
    const normalizedItems = normalizeSystemPromptAppendixItems(systemPromptAppendix.value);
    const response = await apiService.updateAgentSystemPromptAppendix(agentId, normalizedItems);
    systemPromptAppendix.value = normalizeSystemPromptAppendixItems(
      response.systemPromptAppendix || []
    );
    saveSuccess.value = `保存成功，共 ${systemPromptAppendix.value.length} 条。`;
  } catch (savePropertiesError: any) {
    console.error('保存 systemPromptAppendix 失败:', savePropertiesError);
    saveError.value = savePropertiesError?.message || '保存失败。';
  } finally {
    saving.value = false;
  }
};

/**
 * 复制文本，优先使用剪贴板 API，失败时回退到 textarea 方案。
 * @param value 需要复制的文本
 */
const copyText = async (value: string) => {
  const text = (value || '').trim();
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
};

/**
 * 打开当前智能体所属岗位的属性弹窗。
 * 没有岗位 ID 时不继续执行，避免打开无效弹窗。
 */
/**
 * 确认并删除智能体Chrome数据。
 * 弹出确认对话框，确认后调用后端API删除Chrome用户数据目录。
 */
const confirmDeleteChromeData = () => {
  if (!agentId) return;

  confirm.require({
    message: `确定要删除智能体 "${agentName || agentId}" 的 Chrome 浏览器数据吗？\n\n这将删除 cookies、缓存、浏览历史等数据。`,
    header: '删除Chrome数据',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: '取消',
    acceptLabel: '确认删除',
    acceptClass: 'p-button-danger',
    accept: async () => {
      deletingChromeData.value = true;
      chromeDeleteSuccess.value = '';
      try {
        await apiService.deleteAgentChromeData(agentId);
        chromeDeleteSuccess.value = 'Chrome数据已删除';
        toast.add({
          severity: 'success',
          summary: '删除成功',
          detail: 'Chrome浏览器数据已删除',
          life: 3000
        });
      } catch (err: any) {
        toast.add({
          severity: 'error',
          summary: '删除失败',
          detail: err?.message || '删除Chrome数据失败',
          life: 5000
        });
      } finally {
        deletingChromeData.value = false;
      }
    }
  });
};

const openRoleProperties = () => {
  if (!roleId) {
    return;
  }

  dialog.open(RoleDetailDialog, {
    props: {
      header: `岗位属性：${roleName || roleId}`,
      style: { width: '860px', maxWidth: '95vw' },
      modal: false,
      closable: true,
      dismissableMask: false,
      closeOnEscape: false,
      keepInViewport: false,
      onDragend: createDragEndHandler()
    } as any,
    data: {
      roleId,
      roleName,
      initialTab: activeTab.value === 'skills' ? 'skills' : 'info',
      selectedSkillId: selectedSkillId.value || undefined
    }
  });
};

onMounted(() => {
  void loadAgentProperties();
});
</script>

<style scoped>
:deep(.p-tablist) {
  background: transparent;
}

:deep(.p-tabpanels) {
  background: transparent;
}

:deep(.p-tabpanel) {
  background: transparent;
}

:deep(.p-textarea) {
  font-family: inherit;
}
</style>
