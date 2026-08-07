<template>
  <div class="flex flex-col h-[600px] rounded-b-xl text-[var(--text-1)]">
    <div v-if="loading" class="flex items-center justify-center py-12">
      <Loader2 class="w-8 h-8 animate-spin text-[var(--primary)]" />
      <span class="ml-3 text-[var(--text-2)]">加载中...</span>
    </div>

    <div v-else-if="error" class="p-4">
      <Message severity="error">{{ error }}</Message>
    </div>

    <div v-else class="flex h-full min-h-0 flex-col overflow-hidden">
      <Tabs v-model:value="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabList class="px-4 border-b border-[var(--border)]">
          <Tab value="info" class="flex items-center gap-2">
            <Info class="w-4 h-4" />
            <span>基本信息</span>
          </Tab>
          <Tab value="agents" class="flex items-center gap-2">
            <Bot class="w-4 h-4" />
            <span>智能体</span>
          </Tab>
          <Tab value="prompt" class="flex items-center gap-2">
            <FileText class="w-4 h-4" />
            <span>岗位职责</span>
          </Tab>
          <Tab value="config" class="flex items-center gap-2">
            <Settings class="w-4 h-4" />
            <span>配置</span>
          </Tab>
          <Tab value="skills" class="flex items-center gap-2">
            <Puzzle class="w-4 h-4" />
            <span>技能</span>
          </Tab>
        </TabList>

        <TabPanels class="min-h-0 flex-1 overflow-hidden">
          <!-- 基本信息标签页 -->
          <TabPanel value="info" class="h-full w-full overflow-y-auto p-6 space-y-6">
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                岗位ID
              </label>
              <div class="px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                <code class="text-sm text-[var(--text-1)] font-mono">{{ roleData?.id }}</code>
              </div>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                岗位名称
              </label>
              <div class="px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                <span class="text-sm text-[var(--text-1)]">{{ roleData?.name }}</span>
              </div>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                创建时间
              </label>
              <div class="px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                <span class="text-sm text-[var(--text-1)]">{{ formatTimestamp(roleData?.createdAt) }}</span>
              </div>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                创建者
              </label>
              <div class="px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                <span class="text-sm text-[var(--text-1)]">{{ roleData?.createdBy || '系统' }}</span>
              </div>
            </section>
          </TabPanel>

          <!-- 智能体标签页 -->
          <TabPanel value="agents" class="h-full w-full overflow-y-auto p-6">
            <div v-if="roleAgentsLoading" class="flex items-center justify-center py-12">
              <Loader2 class="w-6 h-6 animate-spin text-[var(--primary)]" />
              <span class="ml-3 text-sm text-[var(--text-2)]">加载岗位智能体中...</span>
            </div>

            <Message v-else-if="roleAgentsError" severity="error">
              {{ roleAgentsError }}
            </Message>

            <div v-else class="space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="text-sm text-[var(--text-2)]">
                  共 {{ roleAgents.length }} 个智能体
                </div>
                <Button
                  variant="outlined"
                  size="small"
                  class="!px-3"
                  :loading="creatingAgent"
                  :disabled="creatingAgent"
                  @click="createAgentForCurrentRole"
                >
                  创建
                </Button>
              </div>

              <div v-if="roleAgents.length === 0" class="py-12 text-center text-sm text-[var(--text-3)]">
                当前岗位下还没有智能体。
              </div>

              <div v-else class="space-y-3">
                <div
                  v-for="agent in roleAgents"
                  :key="agent.id"
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4"
                >
                  <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-medium text-[var(--text-1)]">{{ agent.name }}</span>
                        <span
                          class="rounded-full px-2 py-0.5 text-xs"
                          :class="getAgentStatusClass(agent.status)"
                        >
                          {{ getAgentStatusLabel(agent.status) }}
                        </span>
                      </div>
                      <div class="mt-2 space-y-1 text-xs text-[var(--text-3)]">
                        <div>智能体 ID：{{ agent.id }}</div>
                        <div>所在工作区：{{ agent.workspaceName }}</div>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outlined"
                        size="small"
                        class="!px-3"
                        @click="openAgentProperties(agent)"
                      >
                        打开属性
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        class="!px-3"
                        @click="openAgentChat(agent)"
                      >
                        聊天
                      </Button>
                      <Button
                        severity="danger"
                        variant="outlined"
                        size="small"
                        class="!px-3"
                        @click="confirmDeleteAgent(agent)"
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- 岗位职责标签页 -->
          <TabPanel value="prompt" class="h-full w-full overflow-y-auto p-6 space-y-6">
            <section>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-sm font-medium text-[var(--text-1)]">
                  职责提示词
                </label>
                <Button
                  v-if="hasPromptChanges"
                  variant="text"
                  size="small"
                  @click="savePrompt"
                  :loading="savingPrompt"
                  class="!px-3 !py-1.5"
                >
                  <Check class="w-4 h-4 mr-1" />
                  保存
                </Button>
              </div>
              <Textarea
                v-model="roleForm.rolePrompt"
                :rows="8"
                class="w-full"
                placeholder="描述该岗位的职责和任务..."
                :disabled="savingPrompt"
              />
              <p class="text-xs text-[var(--text-3)] mt-2">
                定义该岗位智能体的核心职责、任务范围和行为准则
              </p>
            </section>

            <section>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-sm font-medium text-[var(--text-1)]">
                  组织架构提示词
                </label>
                <Button
                  v-if="hasOrgPromptChanges"
                  variant="text"
                  size="small"
                  @click="saveOrgPrompt"
                  :loading="savingOrgPrompt"
                  class="!px-3 !py-1.5"
                >
                  <Check class="w-4 h-4 mr-1" />
                  保存
                </Button>
              </div>
              <Textarea
                v-model="roleForm.orgPrompt"
                :rows="6"
                class="w-full"
                placeholder="定义该岗位在组织架构中的定位和协作方式（可选）..."
                :disabled="savingOrgPrompt"
              />
              <p class="text-xs text-[var(--text-3)] mt-2">
                可选：描述该岗位与其他岗位的协作关系、上下级关系等
              </p>
            </section>
          </TabPanel>

          <!-- 配置标签页 -->
          <TabPanel value="config" class="h-full w-full overflow-y-auto p-6 space-y-6">
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                LLM 服务
              </label>
              <div class="space-y-2">
                <div
                  v-for="option in llmServiceOptions"
                  :key="option.value"
                  class="relative flex items-start p-3 rounded-lg border cursor-pointer transition-all"
                  :class="[
                    roleForm.llmServiceId === option.value
                      ? 'border-[var(--primary)] bg-[var(--primary)]/5'
                      : 'border-[var(--border)] hover:border-[var(--text-3)] hover:bg-[var(--surface-2)]'
                  ]"
                  @click="roleForm.llmServiceId = option.value"
                >
                  <input
                    type="radio"
                    :value="option.value"
                    v-model="roleForm.llmServiceId"
                    class="mt-1 mr-3 w-4 h-4 text-[var(--primary)] focus:ring-[var(--primary)]"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="font-medium text-sm text-[var(--text-1)] truncate">{{ option.name }}</span>
                        <span v-if="option.isDefault" class="px-1.5 py-0.5 text-xs rounded bg-[var(--surface-3)] text-[var(--text-3)] shrink-0">
                          默认
                        </span>
                      </div>
                      <span class="text-xs text-[var(--text-3)] shrink-0">{{ option.model }}</span>
                    </div>
                    <p v-if="option.description" class="mt-1 text-xs text-[var(--text-3)] line-clamp-2">
                      {{ option.description }}
                    </p>
                  </div>
                </div>
              </div>
              <p class="text-xs text-[var(--text-3)] mt-3">
                为该岗位指定专属的LLM服务，选择"默认模型"则使用系统默认服务
              </p>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                工具组
              </label>
              <MultiSelect
                v-model="roleForm.toolGroups"
                :options="toolGroupOptions"
                option-label="label"
                option-value="value"
                placeholder="默认: org_management"
                class="w-full"
                :disabled="savingToolGroups"
              />
              <p class="text-xs text-[var(--text-3)] mt-2">
                限制该岗位智能体可使用的工具组，清空所有选择后保存将恢复默认（仅 org_management）
              </p>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-3">
                功能开关
              </label>
              <div class="space-y-3">
                <div class="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--text-1)]">知识树</div>
                    <div class="text-xs text-[var(--text-3)] mt-0.5">启用后，智能体将自动从对话中提取知识并在后续对话中检索使用</div>
                  </div>
                  <ToggleSwitch
                    v-model="roleForm.knowledgeTreeEnabled"
                    :disabled="savingFeatures"
                  />
                </div>
                <div class="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--text-1)]">智能体记忆</div>
                    <div class="text-xs text-[var(--text-3)] mt-0.5">启用后，智能体将自动总结对话要点形成长期记忆</div>
                  </div>
                  <ToggleSwitch
                    v-model="roleForm.agentMemoryEnabled"
                    :disabled="savingFeatures"
                  />
                </div>
              </div>
            </section>
          </TabPanel>

          <TabPanel value="skills" class="h-full min-h-0 w-full overflow-hidden p-6">
            <SkillBindingPanel
              :target-type="'role'"
              :target-id="roleId"
              :selected-skill-id="selectedSkillId"
            />
          </TabPanel>
        </TabPanels>

        <!-- 底部保存栏 -->
        <div v-if="hasAnyChanges" class="px-6 py-4 border-t border-[var(--border)] bg-[var(--surface-1)] flex items-center justify-between">
          <span class="text-sm text-[var(--text-2)]">
            {{ changesSummary }}
          </span>
          <div class="flex gap-2">
            <Button
              v-if="hasLlmServiceChanges"
              variant="text"
              size="small"
              @click="saveLlmService"
              :loading="savingLlmService"
            >
              <Check class="w-4 h-4 mr-1" />
              保存模型
            </Button>
            <Button
              v-if="hasToolGroupsChanges"
              variant="text"
              size="small"
              @click="saveToolGroups"
              :loading="savingToolGroups"
            >
              <Check class="w-4 h-4 mr-1" />
              保存工具组
            </Button>
            <Button
              v-if="hasFeaturesChanges"
              variant="text"
              size="small"
              @click="saveFeatures"
              :loading="savingFeatures"
            >
              <Check class="w-4 h-4 mr-1" />
              保存功能开关
            </Button>
          </div>
        </div>
      </Tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import MultiSelect from 'primevue/multiselect';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import { Info, FileText, Settings, Check, Loader2, Bot, Puzzle } from 'lucide-vue-next';
import { useConfirm } from 'primevue/useconfirm';
import { useDialog } from 'primevue/usedialog';
import { useToast } from 'primevue/usetoast';
import { apiService } from '../../services/api';
import { configApi } from '../../services/configApi';
import { useAppStore } from '../../stores/app';
import { useAgentStore } from '../../stores/agent';
import { useChatStore } from '../../stores/chat';
import { useOrgStore } from '../../stores/org';
import { openAgentPropertiesWindow } from '../agent/agentPropertiesWindow';
import SkillBindingPanel from '../skills/SkillBindingPanel.vue';
import { buildRoleDetailAgentList, type RoleDetailAgentListItem } from './roleDetailAgentList';

const confirm = useConfirm();
const dialog = useDialog();
const toast = useToast();
const appStore = useAppStore();
const orgStore = useOrgStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();
const dialogRef = inject<any>('dialogRef');
const loading = ref(true);
const error = ref('');

// 获取从父组件传入的数据 - dialogRef 是一个 computed ref，需要访问 .value
const data = dialogRef?.value?.data || {};
const roleId = ref(data?.roleId || '');
const activeTab = ref(data?.initialTab || 'info');
const selectedSkillId = ref(data?.selectedSkillId || '');

// 调试日志
console.log('RoleDetailDialog - dialogRef:', dialogRef);
console.log('RoleDetailDialog - dialogRef.value:', dialogRef?.value);
console.log('RoleDetailDialog - data:', data);
console.log('RoleDetailDialog - roleId:', roleId.value);

// 岗位数据
const roleData = ref<any>(null);
const originalRoleData = ref<any>(null);
const roleAgentsLoading = ref(false);
const roleAgentsError = ref('');
const roleAgents = ref<RoleDetailAgentListItem[]>([]);
const creatingAgent = ref(false);

// 表单数据
const roleForm = ref({
  rolePrompt: '',
  orgPrompt: '',
  llmServiceId: null as string | null,
  toolGroups: [] as string[],
  knowledgeTreeEnabled: true,
  agentMemoryEnabled: true
});

// 各字段保存状态
const savingPrompt = ref(false);
const savingOrgPrompt = ref(false);
const savingLlmService = ref(false);
const savingToolGroups = ref(false);
const savingFeatures = ref(false);

// LLM服务选项
interface LlmServiceOption {
  name: string;
  model: string;
  value: string;
  description?: string;
  isDefault?: boolean;
}

interface CreatedRoleAgentResponse {
  ok: boolean;
  agent: {
    id: string;
    name: string;
    roleId: string;
    roleName: string;
    status: 'online' | 'offline' | 'busy';
  };
  workspace?: {
    id: string;
    name: string;
  };
}
const llmServiceOptions = ref<LlmServiceOption[]>([]);
const toolGroupOptions = ref<Array<{ label: string; value: string }>>([]);

// 检测变更
const hasPromptChanges = computed(() => {
  return roleForm.value.rolePrompt !== originalRoleData.value?.rolePrompt;
});

const hasOrgPromptChanges = computed(() => {
  const current = roleForm.value.orgPrompt || null;
  const original = originalRoleData.value?.orgPrompt || null;
  return current !== original;
});

const hasLlmServiceChanges = computed(() => {
  const current = roleForm.value.llmServiceId;
  const original = originalRoleData.value?.llmServiceId || null;
  return current !== original;
});

const hasToolGroupsChanges = computed(() => {
  const current = roleForm.value.toolGroups || [];
  const original = originalRoleData.value?.toolGroups || [];
  if (current.length !== original.length) return true;
  return !current.every((v, i) => v === original[i]);
});

const hasFeaturesChanges = computed(() => {
  const currentKt = roleForm.value.knowledgeTreeEnabled;
  const originalKt = originalRoleData.value?.knowledgeTreeEnabled ?? true;
  const currentMem = roleForm.value.agentMemoryEnabled;
  const originalMem = originalRoleData.value?.agentMemoryEnabled ?? true;
  return currentKt !== originalKt || currentMem !== originalMem;
});

const hasAnyChanges = computed(() => {
  return hasLlmServiceChanges.value || hasToolGroupsChanges.value || hasFeaturesChanges.value;
});

const changesSummary = computed(() => {
  const changes: string[] = [];
  if (hasLlmServiceChanges.value) changes.push('LLM服务');
  if (hasToolGroupsChanges.value) changes.push('工具组');
  if (hasFeaturesChanges.value) changes.push('功能开关');
  return `已修改: ${changes.join('、')}`;
});

/**
 * 获取智能体状态文案，保持岗位详情和其他列表口径一致。
 * @param status 智能体状态
 * @returns 供界面展示的中文文案
 */
const getAgentStatusLabel = (status: 'online' | 'offline' | 'busy') => {
  if (status === 'online') return '在线';
  if (status === 'busy') return '忙碌';
  return '离线';
};

/**
 * 获取智能体状态标签样式。
 * @param status 智能体状态
 * @returns 对应的标签类名
 */
const getAgentStatusClass = (status: 'online' | 'offline' | 'busy') => {
  if (status === 'online') {
    return 'bg-green-500/10 text-green-600';
  }
  if (status === 'busy') {
    return 'bg-amber-500/10 text-amber-600';
  }
  return 'bg-[var(--surface-3)] text-[var(--text-3)]';
};

// 格式化时间戳
const formatTimestamp = (timestamp: string | null) => {
  if (!timestamp) return '未知';
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return timestamp;
  }
};

/**
 * 通知打开该弹窗的父窗口刷新数据。
 * 父窗口未监听时静默跳过，避免把刷新逻辑散落到多个调用点。
 */
const notifyRoleUpdated = () => {
  dialogRef?.value?.emit?.('update');
};

/**
 * 刷新全局组织与智能体缓存，避免聊天页和侧栏读取到旧数据。
 * @param workspaceId 受影响的工作区 ID
 */
const refreshGlobalAgentState = async (workspaceId = '') => {
  await orgStore.fetchOrgs(true);
  await agentStore.fetchAllAgents(true);

  if (workspaceId) {
    await agentStore.fetchAgentsByOrg(workspaceId, true);
    return;
  }

  if (agentStore.currentOrgId) {
    await agentStore.fetchAgentsByOrg(agentStore.currentOrgId, true);
  }
};

/**
 * 加载当前岗位下的全部智能体。
 * 通过全量智能体数据筛选岗位成员，并补齐聊天所需的工作区信息。
 */
const loadRoleAgents = async () => {
  if (!roleId.value) {
    roleAgents.value = [];
    roleAgentsError.value = '缺少岗位 ID。';
    return;
  }

  roleAgentsLoading.value = true;
  roleAgentsError.value = '';

  try {
    const rawAgents = await apiService.getAllAgentsRaw();
    roleAgents.value = buildRoleDetailAgentList(rawAgents, roleId.value, apiService.mapStatus);
  } catch (loadAgentsError: any) {
    console.error('加载岗位智能体失败:', loadAgentsError);
    roleAgentsError.value = loadAgentsError?.message || '加载岗位智能体失败';
    roleAgents.value = [];
  } finally {
    roleAgentsLoading.value = false;
  }
};

// 加载岗位详情
const loadRole = async () => {
  loading.value = true;
  error.value = '';

  // 调试日志
  console.log('loadRole - roleId.value:', roleId.value);
  console.log('loadRole - data:', data);

  try {
    const role = await apiService.getRole(roleId.value);
    roleData.value = role;
    originalRoleData.value = JSON.parse(JSON.stringify(role));

    // 填充表单数据
    roleForm.value = {
      rolePrompt: role.rolePrompt || '',
      orgPrompt: role.orgPrompt || '',
      llmServiceId: role.llmServiceId || null,
      toolGroups: Array.isArray(role.toolGroups) ? [...role.toolGroups] : [],
      knowledgeTreeEnabled: role.knowledgeTreeEnabled !== false,
      agentMemoryEnabled: role.agentMemoryEnabled !== false
    };
  } catch (err: any) {
    error.value = err.message || '加载岗位详情失败';
    console.error('加载岗位详情失败:', err);
  } finally {
    loading.value = false;
  }
};

/**
 * 打开岗位下某个智能体的属性弹窗。
 * @param agent 岗位智能体列表项
 */
const openAgentProperties = (agent: RoleDetailAgentListItem) => {
  openAgentPropertiesWindow(dialog, {
    agentId: agent.id,
    agentName: agent.name,
    roleName: agent.roleName,
    roleId: agent.roleId,
    agentStatus: agent.status
  });
};

/**
 * 切换到指定智能体的聊天界面。
 * 先确保对应工作区标签存在，再切换到该工作区的目标智能体。
 * @param agent 岗位智能体列表项
 */
const openAgentChat = async (agent: RoleDetailAgentListItem) => {
  if (!agent.workspaceId) {
    toast.add({
      severity: 'error',
      summary: '打开失败',
      detail: '未找到该智能体所属工作区。',
      life: 5000
    });
    return;
  }

  try {
    appStore.openTab({
      id: agent.workspaceId,
      type: 'org',
      title: agent.workspaceName || '组织'
    });
    await agentStore.fetchAgentsByOrg(agent.workspaceId, true);
    await chatStore.setActiveAgent(agent.workspaceId, agent.id);
  } catch (openChatError: any) {
    console.error('打开智能体聊天失败:', openChatError);
    toast.add({
      severity: 'error',
      summary: '打开失败',
      detail: openChatError?.message || '打开聊天失败',
      life: 5000
    });
  }
};

/**
 * 创建成功后切换到新智能体所在工作区，并打开其属性弹窗。
 * 这里保持和岗位树页面一致的创建后行为，避免不同入口交互不一致。
 * @param response 创建岗位智能体后的返回结果
 */
const openCreatedAgentWorkspace = async (response: CreatedRoleAgentResponse) => {
  const workspaceId = response.workspace?.id || response.agent.id;
  const workspaceTitle = response.workspace?.name || response.agent.name || response.agent.id;

  appStore.openTab({
    id: workspaceId,
    type: 'org',
    title: workspaceTitle
  });
  await agentStore.fetchAgentsByOrg(workspaceId, true);
  await chatStore.setActiveAgent(workspaceId, response.agent.id);

  openAgentPropertiesWindow(dialog, {
    agentId: response.agent.id,
    agentName: response.agent.name,
    roleName: response.agent.roleName,
    roleId: response.agent.roleId,
    agentStatus: response.agent.status
  });
};

/**
 * 在当前岗位下创建新的智能体。
 * 创建后刷新岗位智能体列表，并打开新智能体对应界面。
 */
const createAgentForCurrentRole = async () => {
  if (!roleId.value || creatingAgent.value) {
    return;
  }

  creatingAgent.value = true;
  try {
    const response = await apiService.createAgentForRole(roleId.value) as CreatedRoleAgentResponse;
    await loadRoleAgents();
    await refreshGlobalAgentState(response.workspace?.id || response.agent.id);
    notifyRoleUpdated();
    await openCreatedAgentWorkspace(response);

    toast.add({
      severity: 'success',
      summary: '创建成功',
      detail: `已在岗位“${roleData.value?.name || roleId.value}”下创建新智能体。`,
      life: 3000
    });
  } catch (createError: any) {
    console.error('岗位详情创建智能体失败:', createError);
    toast.add({
      severity: 'error',
      summary: '创建失败',
      detail: createError?.message || '创建智能体失败',
      life: 5000
    });
  } finally {
    creatingAgent.value = false;
  }
};

/**
 * 删除岗位下的智能体。
 * 删除成功后同步刷新岗位列表、全局缓存和父窗口数据。
 * @param agent 岗位智能体列表项
 */
const deleteAgent = async (agent: RoleDetailAgentListItem) => {
  await apiService.deleteAgent(agent.id, {
    reason: `用户在岗位 ${roleData.value?.name || roleId.value} 页面删除智能体`,
    deletedBy: 'user'
  });

  if (agent.workspaceId && chatStore.activeAgentIds[agent.workspaceId] === agent.id) {
    await chatStore.setActiveAgent(agent.workspaceId, 'user');
  }

  await loadRoleAgents();
  await refreshGlobalAgentState(agent.workspaceId);
  notifyRoleUpdated();
};

/**
 * 确认删除岗位下的智能体。
 * @param agent 岗位智能体列表项
 */
const confirmDeleteAgent = (agent: RoleDetailAgentListItem) => {
  confirm.require({
    message: `确定要删除智能体“${agent.name}”吗？删除后将无法恢复。`,
    header: '删除智能体',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: {
      label: '取消',
      severity: 'secondary',
      outlined: true
    },
    acceptProps: {
      label: '确认删除',
      severity: 'danger'
    },
    accept: async () => {
      try {
        await deleteAgent(agent);
        toast.add({
          severity: 'success',
          summary: '删除成功',
          detail: `智能体“${agent.name}”已删除。`,
          life: 3000
        });
      } catch (deleteError: any) {
        console.error('删除岗位智能体失败:', deleteError);
        toast.add({
          severity: 'error',
          summary: '删除失败',
          detail: deleteError?.message || '删除智能体失败',
          life: 5000
        });
      }
    }
  });
};

// 加载LLM服务列表
const loadLlmServices = async () => {
  try {
    const options: LlmServiceOption[] = [];

    // 加载默认 LLM 配置
    try {
      const defaultLlm = await configApi.getLlmConfig();
      if (defaultLlm.llm?.model) {
        options.push({
          name: '默认模型',
          model: defaultLlm.llm.model,
          value: '__default__',
          description: defaultLlm.llm.baseURL ? `API: ${defaultLlm.llm.baseURL}` : undefined,
          isDefault: true
        });
      }
    } catch (err) {
      console.warn('加载默认LLM配置失败:', err);
    }

    // 加载 LLM 服务列表
    try {
      const services = await configApi.getLlmServicesConfig();
      if (services.services && services.services.length > 0) {
        const enabledServices = services.services.filter((s: any) => s.enabled !== false);
        for (const service of enabledServices) {
          options.push({
            name: service.name,
            model: service.model,
            value: service.id,
            description: service.description || undefined
          });
        }
      }
    } catch (err) {
      console.warn('加载LLM服务列表失败:', err);
    }

    llmServiceOptions.value = options;

    // 如果岗位当前没有指定 LLM 服务（llmServiceId 为 null），自动选中"默认模型"选项
    if (roleForm.value.llmServiceId === null || roleForm.value.llmServiceId === undefined || roleForm.value.llmServiceId === '') {
      roleForm.value.llmServiceId = '__default__';
      // 同时更新 originalRoleData 以避免显示"未保存"的提示
      if (originalRoleData.value) {
        originalRoleData.value.llmServiceId = '__default__';
      }
    }
  } catch (err) {
    console.error('加载LLM服务列表失败:', err);
  }
};

// 加载工具组列表
const loadToolGroups = async () => {
  try {
    const toolGroups = await apiService.getToolGroups();
    toolGroupOptions.value = toolGroups.map((tg: any) => ({
      label: tg.name || tg.id,
      value: tg.id
    }));
  } catch (err) {
    console.error('加载工具组列表失败:', err);
  }
};

// 保存职责提示词
const savePrompt = async () => {
  if (!hasPromptChanges.value || savingPrompt.value) return;

  savingPrompt.value = true;
  try {
    await apiService.updateRolePrompt(roleId.value, roleForm.value.rolePrompt);
    originalRoleData.value.rolePrompt = roleForm.value.rolePrompt;

    toast.add({
      severity: 'success',
      summary: '保存成功',
      detail: '职责提示词已更新',
      life: 3000
    });
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: err.message || '更新职责提示词失败',
      life: 5000
    });
  } finally {
    savingPrompt.value = false;
  }
};

// 保存组织架构提示词
const saveOrgPrompt = async () => {
  if (!hasOrgPromptChanges.value || savingOrgPrompt.value) return;

  savingOrgPrompt.value = true;
  try {
    await apiService.updateRoleOrgPrompt(roleId.value, roleForm.value.orgPrompt);
    originalRoleData.value.orgPrompt = roleForm.value.orgPrompt;

    toast.add({
      severity: 'success',
      summary: '保存成功',
      detail: '组织架构提示词已更新',
      life: 3000
    });
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: err.message || '更新组织架构提示词失败',
      life: 5000
    });
  } finally {
    savingOrgPrompt.value = false;
  }
};

// 保存LLM服务
const saveLlmService = async () => {
  if (!hasLlmServiceChanges.value || savingLlmService.value) return;

  savingLlmService.value = true;
  try {
    // __default__ 表示使用默认模型，传递 null 给后端
    const serviceIdToSave = roleForm.value.llmServiceId === '__default__' ? null : roleForm.value.llmServiceId;
    await apiService.updateRoleLlmService(roleId.value, serviceIdToSave);
    originalRoleData.value.llmServiceId = roleForm.value.llmServiceId;

    toast.add({
      severity: 'success',
      summary: '保存成功',
      detail: 'LLM服务配置已更新',
      life: 3000
    });
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: err.message || '更新LLM服务失败',
      life: 5000
    });
  } finally {
    savingLlmService.value = false;
  }
};

// 保存工具组
const saveToolGroups = async () => {
  if (!hasToolGroupsChanges.value || savingToolGroups.value) return;

  savingToolGroups.value = true;
  try {
    const toolGroups = [...roleForm.value.toolGroups];
    await apiService.updateRoleToolGroups(roleId.value, toolGroups);
    originalRoleData.value.toolGroups = [...toolGroups];

    toast.add({
      severity: 'success',
      summary: '保存成功',
      detail: '工具组配置已更新',
      life: 3000
    });
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: err.message || '更新工具组失败',
      life: 5000
    });
  } finally {
    savingToolGroups.value = false;
  }
};

// 保存功能开关
const saveFeatures = async () => {
  if (!hasFeaturesChanges.value || savingFeatures.value) return;

  savingFeatures.value = true;
  try {
    await apiService.updateRoleFeatures(roleId.value, {
      knowledgeTreeEnabled: roleForm.value.knowledgeTreeEnabled,
      agentMemoryEnabled: roleForm.value.agentMemoryEnabled
    });
    originalRoleData.value.knowledgeTreeEnabled = roleForm.value.knowledgeTreeEnabled;
    originalRoleData.value.agentMemoryEnabled = roleForm.value.agentMemoryEnabled;

    toast.add({
      severity: 'success',
      summary: '保存成功',
      detail: '功能开关已更新',
      life: 3000
    });
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: '保存失败',
      detail: err.message || '更新功能开关失败',
      life: 5000
    });
  } finally {
    savingFeatures.value = false;
  }
};

onMounted(async () => {
  await loadRole();
  await loadRoleAgents();
  loadLlmServices();
  loadToolGroups();
});
</script>

<style scoped>
:deep(.p-dialog-content) {
  padding: 0;
}

:deep(.p-tablist) {
  background: transparent;
  border-bottom: 1px solid var(--border);
}

:deep(.p-tab) {
  padding: 12px 16px;
  color: var(--text-2);
  transition: all 0.2s;
}

:deep(.p-tab[data-p-active="true"]) {
  color: var(--primary);
  background: var(--surface-1);
  border-bottom: 2px solid var(--primary);
}

:deep(.p-tab:hover:not([data-p-active="true"])) {
  color: var(--text-1);
  background: var(--surface-3);
}

:deep(.p-tabpanel) {
  background: transparent;
}

:deep(.p-textarea) {
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
}

:deep(.p-dropdown),
:deep(.p-multiselect) {
  font-size: 14px;
}
</style>
