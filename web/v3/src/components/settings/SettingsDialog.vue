<script setup lang="ts">
/**
 * 系统设置对话框组件
 * 
 * 功能：提供系统配置管理，包括主题设置、LLM 配置编辑、LLM 服务管理
 * 
 * @author Agent Society
 */
import { ref, onMounted, computed, inject } from 'vue';
import { Settings, Info, Moon, Sun, Server, Key, Globe, Cpu, Save, Loader2, AlertCircle, Plus } from 'lucide-vue-next';
import Button from 'primevue/button';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Message from 'primevue/message';
import Dialog from 'primevue/dialog';
import Textarea from 'primevue/textarea';
import MultiSelect from 'primevue/multiselect';
import { useToast } from 'primevue/usetoast';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import { useAppStore } from '../../stores/app';
import { configApi, type AppSettingsConfig, type LlmConfig, type ThinkingConfig, type ModelCapabilities } from '../../services/configApi';

const appStore = useAppStore();
const toast = useToast();
type LlmProviderType = 'chat' | 'responses' | 'anthropic';

// 从 Dialog 注入获取数据
const dialogRef = inject<any>('dialogRef');
const dialogData = computed(() => dialogRef?.data);

// 是否为首次运行模式
const isFirstRun = computed(() => dialogData.value?.firstRun === true);

/**
 * 创建主 LLM 配置的默认能力对象。
 * 默认策略要求主模型被视为支持工具调用，因此输出能力默认包含 tool_calling。
 */
const createDefaultLlmCapabilities = (): ModelCapabilities => ({
  input: ['text'],
  output: ['text', 'tool_calling']
});

/**
 * 创建主 LLM 配置的默认能力标签。
 * 前后端使用同一默认值，避免保存其他字段时把工具能力覆盖掉。
 */
const createDefaultLlmCapabilityTags = (): string[] => ['text', 'tool_calling'];


/**
 * Provider type options for the settings panel.
 * Default stays on chat so existing configuration behavior does not change.
 */
const llmProviderOptions = [
  { label: 'OpenAI Chat Completions', value: 'chat' as LlmProviderType },
  { label: 'OpenAI Responses', value: 'responses' as LlmProviderType },
  { label: 'Anthropic Messages', value: 'anthropic' as LlmProviderType }
];

/**
 * Check whether the provider is configurable via the UI selector.
 * Non-configurable providers (e.g. local-llama) are preserved to avoid overwriting unrelated config.
 */
const isConfigurableProvider = (provider: string | undefined): boolean => {
  return !provider || provider === 'openai' || provider === 'open-responses' || provider === 'anthropic';
};

/**
 * Map a stored provider value to the UI provider type selector.
 * `open-responses` → `responses`, `anthropic` → `anthropic`, everything else → `chat`.
 */
const resolveProviderType = (provider: string | undefined): LlmProviderType => {
  if (provider === 'open-responses') return 'responses';
  if (provider === 'anthropic') return 'anthropic';
  return 'chat';
};

/**
 * Resolve the provider that should be saved from the selector state.
 * Non-configurable providers are kept untouched.
 */
const resolveProviderForSave = (
  provider: string | undefined,
  interfaceType: LlmProviderType
): string => {
  if (!isConfigurableProvider(provider)) {
    return provider || 'openai';
  }
  if (interfaceType === 'anthropic') return 'anthropic';
  return interfaceType === 'responses' ? 'open-responses' : 'openai';
};

// 主题设置
const themeOptions = ref([
  { icon: Sun, value: 'light', label: '明亮' },
  { icon: Moon, value: 'dark', label: '暗黑' }
]);

// LLM 配置状态
const llmCapabilityTagOptions = [
  { label: 'text', value: 'text' },
  { label: 'tool_calling', value: 'tool_calling' },
  { label: 'structured_output', value: 'structured_output' },
  { label: 'reasoning', value: 'reasoning' },
  { label: 'coding', value: 'coding' },
  { label: 'vision', value: 'vision' },
  { label: 'audio', value: 'audio' },
  { label: 'file', value: 'file' }
];
const llmCapabilityTagValueSet = new Set(llmCapabilityTagOptions.map((item) => item.value));
const llmConfig = ref<LlmConfig>({
  provider: 'openai',
  baseURL: '',
  model: '',
  apiKey: '',
  maxTokens: 4096,
  maxConcurrentRequests: 2,
  timeout: 1800000,
  stream: true,
  capabilityTags: createDefaultLlmCapabilityTags(),
  capabilities: createDefaultLlmCapabilities(),
  thinking: { type: 'disabled' } as ThinkingConfig
});
const originalLlmConfig = ref<LlmConfig>(JSON.parse(JSON.stringify(llmConfig.value)));
const llmLoading = ref(false);
const llmSaving = ref(false);
const llmError = ref('');
const llmSuccess = ref(false);

const llmProviderType = computed<LlmProviderType>({
  get: () => resolveProviderType(llmConfig.value.provider),
  set: (value) => {
    llmConfig.value.provider = resolveProviderForSave(llmConfig.value.provider, value);
  }
});
const isLlmProviderEditable = computed(() => isConfigurableProvider(llmConfig.value.provider));

// LLM Services 状态
const llmServices = ref<any[]>([]);
const servicesLoading = ref(false);

// 服务编辑对话框状态
const serviceDialogVisible = ref(false);
const isEditingService = ref(false);
const serviceForm = ref({
  id: '',
  name: '',
  provider: 'openai',
  baseURL: '',
  model: '',
  apiKey: '',
  maxTokens: 4096,
  maxConcurrentRequests: 2,
  timeout: 1800000,
  stream: true,
  capabilityTags: [] as string[],
  description: '',
  capabilities: { input: ['text'], output: ['text'] },
  thinking: { type: 'disabled' } as ThinkingConfig,
  enabled: true
});
const serviceSaving = ref(false);
const serviceError = ref('');
const showDeleteServiceConfirm = ref(false);
const pendingDeleteServiceId = ref('');

// "设置为默认" 确认对话框状态
const showSetDefaultConfirm = ref(false);
const pendingSetDefaultService = ref<any>(null);
const setDefaultSaving = ref(false);
const setDefaultConfirmMessage = computed(() =>
  `确定要将服务 "${pendingSetDefaultService.value?.name}" 的配置设为系统默认大模型吗？这将覆盖当前的默认大模型配置。`
);

const serviceProviderType = computed<LlmProviderType>({
  get: () => resolveProviderType(serviceForm.value.provider),
  set: (value) => {
    serviceForm.value.provider = resolveProviderForSave(serviceForm.value.provider, value);
  }
});
const isServiceProviderEditable = computed(() => isConfigurableProvider(serviceForm.value.provider));
const capabilityTagOptions = [
  { label: '文本对话', value: '文本对话' },
  { label: '逻辑推理', value: '逻辑推理' },
  { label: '指令遵从', value: '指令遵从' },
  { label: '工具调用', value: '工具调用' },
  { label: '结构化输出', value: '结构化输出' },
  { label: '编程', value: '编程' },
  { label: '代码生成', value: '代码生成' },
  { label: '代码审查', value: '代码审查' },
  { label: '任务分配', value: '任务分配' },
  { label: '意图理解', value: '意图理解' },
  { label: '深度思考', value: '深度思考' },
  { label: '视觉理解', value: '视觉理解' },
  { label: 'image', value: 'image' }
];
const capabilityTagValueSet = new Set(capabilityTagOptions.map((item) => item.value));
const capabilityInputOptions = [
  { label: 'text', value: 'text' },
  { label: 'vision', value: 'vision' },
  { label: 'audio', value: 'audio' },
  { label: 'file', value: 'file' }
];
const capabilityOutputOptions = [
  { label: 'text', value: 'text' },
  { label: 'structured_output', value: 'structured_output' },
  { label: 'tool_calling', value: 'tool_calling' }
];
const capabilityInputValueSet = new Set(capabilityInputOptions.map((item) => item.value));
const capabilityOutputValueSet = new Set(capabilityOutputOptions.map((item) => item.value));
const appSettingsLoading = ref(false);
const appSettingsSaving = ref(false);
const appSettingsError = ref('');
const appSettingsSuccess = ref(false);
const appSettings = ref<AppSettingsConfig>({
  promptsDir: '',
  workspacesDir: '',
  runtimeDir: '',
  loggingConfigPath: '',
  maxSteps: 200,
  maxToolRounds: 20000,
  httpPort: 3000,
  contextLimit: {
    maxTokens: 60000,
    warningThreshold: 0.7,
    criticalThreshold: 0.9,
    hardLimitThreshold: 0.95
  },
  skills: {
    enabled: true,
    providers: {},
    runtime: {
      bunPath: '',
      pythonPath: '',
      projectPythonVenvDir: 'Python',
      allowSystemPythonFallback: true
    }
  },
  agentMemory: {
    enabled: true,
    maxEntries: 10000,
    llm: {
      provider: 'openai',
      baseUrl: '',
      model: '',
      apiKey: '',
      temperature: 0.7
    },
    embedding: {
      modelPath: '',
      dimensions: 1024
    },
    recall: {
      limit: 5,
      minConfidence: 0.7
    }
  }
});
const originalAppSettings = ref<AppSettingsConfig>(JSON.parse(JSON.stringify(appSettings.value)));

// 计算属性：LLM 配置是否有变更
const hasLlmChanges = computed(() => {
  return JSON.stringify(llmConfig.value) !== JSON.stringify(originalLlmConfig.value);
});
const hasAppSettingsChanges = computed(() => {
  return JSON.stringify(appSettings.value) !== JSON.stringify(originalAppSettings.value);
});

/**
 * 规范化主 LLM 的能力标签。
 * UI 未提供该字段时，回退到默认值，确保默认模型仍被视为支持工具调用。
 */
const normalizeLlmCapabilityTags = (capabilityTags: unknown): string[] => {
  const normalized = Array.isArray(capabilityTags)
    ? capabilityTags.filter((item): item is string => typeof item === 'string' && llmCapabilityTagValueSet.has(item))
    : [];
  return normalized.length > 0 ? [...new Set(normalized)] : createDefaultLlmCapabilityTags();
};

/**
 * 规范化主 LLM 的输入输出能力。
 * 这里与后端保持同一默认语义，避免前端保存时把 tool_calling 丢掉。
 */
const normalizeLlmCapabilities = (capabilities: unknown): ModelCapabilities => {
  const input = Array.isArray((capabilities as any)?.input)
    ? (capabilities as any).input.filter((item: unknown): item is string => typeof item === 'string' && capabilityInputValueSet.has(item))
    : [];
  const output = Array.isArray((capabilities as any)?.output)
    ? (capabilities as any).output.filter((item: unknown): item is string => typeof item === 'string' && capabilityOutputValueSet.has(item))
    : [];
  return {
    input: input.length > 0 ? Array.from(new Set<string>(input)) : ['text'],
    output: output.length > 0 ? Array.from(new Set<string>(output)) : ['text', 'tool_calling']
  };
};

/**
 * 加载 LLM 配置
 */
const loadLlmConfig = async () => {
  llmLoading.value = true;
  llmError.value = '';
  try {
    const data = await configApi.getLlmConfig();
    llmConfig.value = {
      provider: data.llm.provider || 'openai',
      baseURL: data.llm.baseURL || '',
      model: data.llm.model || '',
      apiKey: data.llm.apiKey || '',
      maxTokens: data.llm.maxTokens || 4096,
      maxConcurrentRequests: data.llm.maxConcurrentRequests || 2,
      timeout: data.llm.timeout ?? 1800000,
      stream: data.llm.stream ?? true,
      capabilityTags: normalizeLlmCapabilityTags(data.llm.capabilityTags),
      capabilities: normalizeLlmCapabilities(data.llm.capabilities),
      thinking: data.llm.thinking ? { type: data.llm.thinking.type || 'disabled', budgetTokens: data.llm.thinking.budgetTokens, effort: data.llm.thinking.effort } : { type: 'disabled' }
    };
    originalLlmConfig.value = JSON.parse(JSON.stringify(llmConfig.value));
  } catch (err) {
    llmError.value = err instanceof Error ? err.message : '加载配置失败';
  } finally {
    llmLoading.value = false;
  }
};

const normalizeAppSettings = (settings: Partial<AppSettingsConfig> | undefined): AppSettingsConfig => {
  const contextLimit: any = settings?.contextLimit ?? {};
  const skills: any = settings?.skills ?? {};
  const skillsRuntime: any = skills.runtime ?? {};
  const agentMemory: any = settings?.agentMemory ?? {};
  const agentMemoryLlm: any = agentMemory.llm ?? {};
  const agentMemoryEmbedding: any = agentMemory.embedding ?? {};
  const agentMemoryRecall: any = agentMemory.recall ?? {};
  return {
    promptsDir: settings?.promptsDir || '',
    workspacesDir: settings?.workspacesDir || '',
    runtimeDir: settings?.runtimeDir || '',
    loggingConfigPath: settings?.loggingConfigPath || '',
    maxSteps: typeof settings?.maxSteps === 'number' ? settings.maxSteps : 200,
    maxToolRounds: typeof settings?.maxToolRounds === 'number' ? settings.maxToolRounds : 20000,
    httpPort: typeof settings?.httpPort === 'number' ? settings.httpPort : 3000,
    contextLimit: {
      maxTokens: typeof contextLimit.maxTokens === 'number' ? contextLimit.maxTokens : 60000,
      warningThreshold: typeof contextLimit.warningThreshold === 'number' ? contextLimit.warningThreshold : 0.7,
      criticalThreshold: typeof contextLimit.criticalThreshold === 'number' ? contextLimit.criticalThreshold : 0.9,
      hardLimitThreshold: typeof contextLimit.hardLimitThreshold === 'number' ? contextLimit.hardLimitThreshold : 0.95
    },
    skills: {
      enabled: typeof skills.enabled === 'boolean' ? skills.enabled : true,
      providers: skills.providers && typeof skills.providers === 'object' ? skills.providers : {},
      runtime: {
        bunPath: skillsRuntime.bunPath || '',
        pythonPath: skillsRuntime.pythonPath || '',
        projectPythonVenvDir: skillsRuntime.projectPythonVenvDir || 'Python',
        allowSystemPythonFallback: typeof skillsRuntime.allowSystemPythonFallback === 'boolean'
          ? skillsRuntime.allowSystemPythonFallback
          : true
      }
    },
    agentMemory: {
      enabled: typeof agentMemory.enabled === 'boolean' ? agentMemory.enabled : true,
      maxEntries: typeof agentMemory.maxEntries === 'number' ? agentMemory.maxEntries : 10000,
      llm: {
        provider: agentMemoryLlm.provider || 'openai',
        baseUrl: agentMemoryLlm.baseUrl || '',
        model: agentMemoryLlm.model || '',
        apiKey: agentMemoryLlm.apiKey || '',
        temperature: typeof agentMemoryLlm.temperature === 'number' ? agentMemoryLlm.temperature : 0.7
      },
      embedding: {
        modelPath: agentMemoryEmbedding.modelPath || '',
        dimensions: typeof agentMemoryEmbedding.dimensions === 'number' ? agentMemoryEmbedding.dimensions : 1024
      },
      recall: {
        limit: typeof agentMemoryRecall.limit === 'number' ? agentMemoryRecall.limit : 5,
        minConfidence: typeof agentMemoryRecall.minConfidence === 'number' ? agentMemoryRecall.minConfidence : 0.7
      }
    }
  };
};

const loadAppSettings = async () => {
  appSettingsLoading.value = true;
  appSettingsError.value = '';
  try {
    const data = await configApi.getAppSettings();
    const normalized = normalizeAppSettings(data.settings);
    appSettings.value = normalized;
    originalAppSettings.value = JSON.parse(JSON.stringify(normalized));
  } catch (err) {
    appSettingsError.value = err instanceof Error ? err.message : '加载应用设置失败';
  } finally {
    appSettingsLoading.value = false;
  }
};

const saveAppSettings = async () => {
  appSettingsSaving.value = true;
  appSettingsError.value = '';
  appSettingsSuccess.value = false;
  try {
    await configApi.saveAppSettings(appSettings.value);
    originalAppSettings.value = JSON.parse(JSON.stringify(appSettings.value));
    appSettingsSuccess.value = true;
    setTimeout(() => {
      appSettingsSuccess.value = false;
    }, 3000);
  } catch (err) {
    appSettingsError.value = err instanceof Error ? err.message : '保存应用设置失败';
  } finally {
    appSettingsSaving.value = false;
  }
};

const resetAppSettings = () => {
  appSettings.value = JSON.parse(JSON.stringify(originalAppSettings.value));
  appSettingsError.value = '';
  appSettingsSuccess.value = false;
};

/**
 * 判断 API Key 是否为掩码格式
 */
const isMaskedApiKey = (key: string | undefined): boolean => {
  return !!key && key.startsWith('****');
};

/**
 * 保存 LLM 配置
 */
const saveLlmConfig = async () => {
  llmSaving.value = true;
  llmError.value = '';
  llmSuccess.value = false;
  
  try {
    const normalizedCapabilities = normalizeLlmCapabilities(llmConfig.value.capabilities);

    // 构造保存数据，如果 apiKey 是掩码格式则不传递
    const saveData: any = {
      provider: resolveProviderForSave(llmConfig.value.provider, llmProviderType.value),
      baseURL: llmConfig.value.baseURL,
      model: llmConfig.value.model,
      maxTokens: llmConfig.value.maxTokens,
      maxConcurrentRequests: llmConfig.value.maxConcurrentRequests,
      timeout: llmConfig.value.timeout ?? 1800000,
      stream: llmConfig.value.stream ?? true,
      capabilityTags: normalizeLlmCapabilityTags(llmConfig.value.capabilityTags),
      capabilities: normalizedCapabilities,
      thinking: llmConfig.value.thinking ?? undefined
    };

    // 只有 apiKey 不是掩码格式时才传递
    if (!isMaskedApiKey(llmConfig.value.apiKey)) {
      saveData.apiKey = llmConfig.value.apiKey;
    }

    await configApi.saveLlmConfig(saveData);

    // 保存成功后，更新原始配置（保留掩码格式的 apiKey）
    llmConfig.value.provider = saveData.provider;
    llmConfig.value.stream = saveData.stream;
    llmConfig.value.capabilityTags = [...(saveData.capabilityTags ?? [])];
    llmConfig.value.capabilities = normalizedCapabilities;
    llmConfig.value.thinking = saveData.thinking;
    originalLlmConfig.value = JSON.parse(JSON.stringify(llmConfig.value));
    llmSuccess.value = true;
    setTimeout(() => llmSuccess.value = false, 3000);
  } catch (err) {
    llmError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    llmSaving.value = false;
  }
};

/**
 * 重置 LLM 配置
 */
const resetLlmConfig = () => {
  llmConfig.value = JSON.parse(JSON.stringify(originalLlmConfig.value));
  llmError.value = '';
  llmSuccess.value = false;
};

/**
 * 打开添加服务对话框
 */
const openAddServiceDialog = () => {
  isEditingService.value = false;
  serviceForm.value = {
    id: '',
    name: '',
    provider: 'openai',
    baseURL: 'http://127.0.0.1:1234/v1',
    model: '',
    apiKey: '',
    maxTokens: 4096,
    maxConcurrentRequests: 2,
    timeout: 1800000,
    stream: true,
    capabilityTags: ['文本对话'],
    description: '',
    capabilities: { input: ['text'], output: ['text'] },
    thinking: { type: 'disabled' },
    enabled: true
  };
  serviceError.value = '';
  serviceDialogVisible.value = true;
};

/**
 * 打开编辑服务对话框
 */
const openEditServiceDialog = (service: any) => {
  const normalizedCapabilities = normalizeServiceCapabilities(service.capabilities);
  isEditingService.value = true;
  serviceForm.value = {
    id: service.id || '',
    name: service.name || '',
    provider: service.provider || 'openai',
    baseURL: service.baseURL || '',
    model: service.model || '',
    apiKey: service.apiKey || '',
    maxTokens: service.maxTokens || 4096,
    maxConcurrentRequests: service.maxConcurrentRequests || 2,
    timeout: service.timeout ?? 1800000,
    stream: service.stream ?? true,
    capabilityTags: Array.isArray(service.capabilityTags)
      ? service.capabilityTags.filter((tag: string) => capabilityTagValueSet.has(tag))
      : [],
    description: service.description || '',
    capabilities: normalizedCapabilities,
    thinking: service.thinking ? { type: service.thinking.type || 'disabled', budgetTokens: service.thinking.budgetTokens, effort: service.thinking.effort } : { type: 'disabled' },
    enabled: typeof service.enabled === 'boolean' ? service.enabled : true
  };
  serviceError.value = '';
  serviceDialogVisible.value = true;
};

/**
 * 判断 API Key 是否为掩码格式
 */
const isServiceApiKeyMasked = (key: string | undefined): boolean => {
  return !!key && key.startsWith('****');
};

const normalizeServiceCapabilities = (capabilities: any) => {
  const input = Array.isArray(capabilities?.input)
    ? capabilities.input.filter((item: unknown): item is string => typeof item === 'string' && capabilityInputValueSet.has(item))
    : [];
  const output = Array.isArray(capabilities?.output)
    ? capabilities.output.filter((item: unknown): item is string => typeof item === 'string' && capabilityOutputValueSet.has(item))
    : [];
  return {
    input: input.length > 0 ? input : ['text'],
    output: output.length > 0 ? output : ['text']
  };
};

/**
 * 保存服务
 */
const saveService = async () => {
  serviceSaving.value = true;
  serviceError.value = '';
  
  try {
    // 验证必填字段
    if (!serviceForm.value.id.trim()) {
      throw new Error('服务 ID 不能为空');
    }
    if (!serviceForm.value.name.trim()) {
      throw new Error('服务名称不能为空');
    }
    if (!serviceForm.value.baseURL.trim()) {
      throw new Error('API 地址不能为空');
    }
    if (!serviceForm.value.model.trim()) {
      throw new Error('模型名称不能为空');
    }
    const normalizedCapabilities = normalizeServiceCapabilities(serviceForm.value.capabilities);
    
    // 构造保存数据
    const saveData: any = {
      id: serviceForm.value.id.trim(),
      name: serviceForm.value.name.trim(),
      provider: resolveProviderForSave(serviceForm.value.provider, serviceProviderType.value),
      baseURL: serviceForm.value.baseURL.trim(),
      model: serviceForm.value.model.trim(),
      maxTokens: serviceForm.value.maxTokens,
      maxConcurrentRequests: serviceForm.value.maxConcurrentRequests,
      timeout: serviceForm.value.timeout ?? 1800000,
      stream: serviceForm.value.stream ?? true,
      capabilityTags: serviceForm.value.capabilityTags,
      description: serviceForm.value.description.trim(),
      capabilities: normalizedCapabilities,
      thinking: serviceForm.value.thinking ?? undefined,
      enabled: serviceForm.value.enabled ?? true
    };
    
    // 只有 apiKey 不是掩码格式时才传递
    if (!isServiceApiKeyMasked(serviceForm.value.apiKey)) {
      saveData.apiKey = serviceForm.value.apiKey;
    }
    
    if (isEditingService.value) {
      await configApi.updateLlmService(serviceForm.value.id, saveData);
    } else {
      await configApi.addLlmService(saveData);
    }
    
    // 保存成功后刷新列表
    await loadLlmServices();
    serviceDialogVisible.value = false;
  } catch (err) {
    serviceError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    serviceSaving.value = false;
  }
};

/**
 * 打开删除服务确认对话框
 */
const openDeleteServiceConfirm = (serviceId: string) => {
  pendingDeleteServiceId.value = serviceId;
  showDeleteServiceConfirm.value = true;
};

/**
 * 确认删除服务
 */
const handleDeleteServiceConfirmed = async () => {
  const serviceId = pendingDeleteServiceId.value;
  if (!serviceId) return;

  try {
    await configApi.deleteLlmService(serviceId);
    await loadLlmServices();
  } catch (err) {
    console.error('删除服务失败:', err);
    toast.add({ severity: 'error', summary: '删除失败', detail: err instanceof Error ? err.message : '删除失败', life: 3000 });
  } finally {
    showDeleteServiceConfirm.value = false;
  }
};

/**
 * 打开"设置为默认"确认对话框
 */
const openSetDefaultConfirm = (service: any) => {
  pendingSetDefaultService.value = service;
  showSetDefaultConfirm.value = true;
};

/**
 * 确认将服务配置设为默认 LLM
 */
const handleSetDefaultConfirmed = async () => {
  const service = pendingSetDefaultService.value;
  if (!service) return;

  setDefaultSaving.value = true;
  try {
    await configApi.setDefaultLlm(service.id);
    await loadLlmConfig();

    toast.add({ severity: 'success', summary: '设置成功', detail: `已将 "${service.name}" 的配置设为默认大模型`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: '设置失败', detail: err instanceof Error ? err.message : '操作失败', life: 5000 });
  } finally {
    showSetDefaultConfirm.value = false;
    setDefaultSaving.value = false;
    pendingSetDefaultService.value = null;
  }
};

/**
 * 切换服务启用/禁用状态
 */
const toggleServiceEnabled = async (service: any) => {
  try {
    const updateData = {
      id: service.id,
      name: service.name,
      provider: service.provider,
      baseURL: service.baseURL,
      model: service.model,
      maxConcurrentRequests: service.maxConcurrentRequests,
      timeout: service.timeout,
      stream: service.stream,
      capabilityTags: service.capabilityTags,
      description: service.description,
      capabilities: service.capabilities,
      enabled: service.enabled === false
    };
    console.log('[toggleServiceEnabled] 发送数据:', JSON.stringify(updateData, null, 2));
    const response = await configApi.updateLlmService(service.id, updateData);
    console.log('[toggleServiceEnabled] 响应:', response);
    service.enabled = !(service.enabled !== false);
  } catch (err) {
    console.error('[toggleServiceEnabled] 错误:', err);
    if (err instanceof Error) {
      console.error('[toggleServiceEnabled] 错误消息:', err.message);
    }
    // @ts-ignore
    if (err?.response) {
      try {
        // @ts-ignore
        console.error('[toggleServiceEnabled] 响应体:', JSON.stringify(err.response, null, 2));
      } catch {}
    }
    console.error('切换服务状态失败:', err);
    toast.add({ severity: 'error', summary: '切换状态失败', detail: err instanceof Error ? err.message : '切换状态失败', life: 3000 });
    await loadLlmServices();
  }
};

/**
 * 加载 LLM 服务列表
 */
const loadLlmServices = async () => {
  servicesLoading.value = true;
  try {
    const data = await configApi.getLlmServicesConfig();
    llmServices.value = (data.services || []).map((service: any) => ({
      ...service,
      stream: service?.stream ?? true
    }));
  } catch (err) {
    console.warn('加载 LLM 服务列表失败:', err);
    llmServices.value = [];
  } finally {
    servicesLoading.value = false;
  }
};

// 组件挂载时加载配置
onMounted(() => {
  loadLlmConfig();
  loadLlmServices();
  loadAppSettings();
});
</script>

<template>
  <div class="flex flex-col h-[600px] bg-transparent overflow-hidden rounded-b-xl text-[var(--text-1)]">
    <Tabs value="llm" class="h-full min-h-0 flex flex-col">
      <TabList class="relative z-10 shrink-0 px-4 border-b border-[var(--border)]">
        <!-- 首次运行时只显示 LLM 配置标签 -->
        <Tab v-if="!isFirstRun" value="general" class="flex items-center gap-2">
          <Settings class="w-4 h-4" />
          <span>常规设置</span>
        </Tab>
        <Tab v-if="!isFirstRun" value="appsettings" class="flex items-center gap-2">
          <span>应用</span>
        </Tab>
        <Tab value="llm" class="flex items-center gap-2">
          <Server class="w-4 h-4" />
          <span>大模型配置</span>
        </Tab>
        <Tab v-if="!isFirstRun" value="services" class="flex items-center gap-2">
          <Cpu class="w-4 h-4" />
          <span>模型服务</span>
        </Tab>
        <Tab v-if="!isFirstRun" value="about" class="flex items-center gap-2;">
          <Info class="w-4 h-4" />
          <span>关于系统</span>
        </Tab>
      </TabList>

      <!-- 让标签内容区在固定高度容器内独立滚动，避免高内容面板挤压并覆盖标签栏 -->
      <TabPanels class="min-h-0 flex-1 overflow-hidden !p-0">
        <!-- 常规设置 -->
        <TabPanel v-if="!isFirstRun" value="general" class="h-full overflow-y-auto p-6 space-y-8">
          <section>
            <h3 class="text-sm font-bold text-[var(--text-1)] mb-4 flex items-center gap-2">
              外观展示
            </h3>
            <div class="space-y-4">
              <div class="flex items-center justify-between p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
                <div>
                  <p class="font-medium text-[var(--text-1)]">深色模式</p>
                  <p class="text-xs text-[var(--text-3)]">调整应用界面的显示主题</p>
                </div>
                <div class="flex items-center gap-2">
                  <Button
                    v-for="opt in themeOptions"
                    :key="opt.value"
                    :variant="appStore.theme === opt.value ? 'primary' : 'text'"
                    size="small"
                    @click="appStore.setTheme(opt.value as any)"
                    class="!px-3 !py-1.5"
                    :class="[appStore.theme === opt.value ? 'bg-[var(--primary)] text-white' : 'text-[var(--text-2)]']"
                  >
                    <component :is="opt.icon" class="w-4 h-4 mr-2" />
                    {{ opt.label }}
                  </Button>
                </div>
              </div>
              <div class="flex items-center justify-between p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
                <div>
                  <p class="font-medium text-[var(--text-1)]">字体大小</p>
                  <p class="text-xs text-[var(--text-3)]">调整对话内容的文字大小</p>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-xs text-[var(--text-3)]">A</span>
                  <input type="range" min="12" max="24" step="1"
                    :value="appStore.chatFontSize"
                    @input="(e) => appStore.setChatFontSize(Number((e.target as HTMLInputElement).value))"
                    class="w-24"
                  />
                  <span class="text-sm text-[var(--text-3)]">A</span>
                  <span class="text-xs text-[var(--text-2)] min-w-[36px] text-right">{{ appStore.chatFontSize }}px</span>
                </div>
              </div>
              <div class="flex items-center justify-between p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
                <div>
                  <p class="font-medium text-[var(--text-1)]">智能体心情颜色</p>
                  <p class="text-xs text-[var(--text-3)]">用 5×5 颜色网格替代通用图标，LLM 会根据对话内容自动设置心情颜色</p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer select-none">
                  <input type="checkbox" class="sr-only peer" role="switch"
                    :checked="appStore.moodColorsEnabled"
                    @change="appStore.saveMoodColorsSetting(($event.target as HTMLInputElement).checked)"
                  />
                  <div class="w-11 h-6 bg-[var(--surface-3)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--primary-weak)] rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
                  <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
                </label>
              </div>
            </div>
          </section>
        </TabPanel>

        <TabPanel v-if="!isFirstRun" value="appsettings" class="h-full overflow-y-auto p-6">
          <section>
            <div v-if="appSettingsError" class="p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">
              {{ appSettingsError }}
            </div>
            <div v-if="appSettingsSuccess" class="p-3 rounded-lg border border-green-200 bg-green-50 text-green-700 text-sm">
              应用设置已保存到 app.local.json，重启后生效
            </div>
            <div class="p-3 rounded-lg border border-yellow-200 bg-yellow-50 text-yellow-700 text-sm">
              应用设置变更在重启后生效。
            </div>

            <div v-if="appSettingsLoading" class="flex items-center justify-center py-12">
              <Loader2 class="w-6 h-6 animate-spin text-[var(--text-3)]" />
            </div>

            <div v-else class="space-y-6">
            <div class="p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] space-y-4">
              <h3 class="text-sm font-bold text-[var(--text-1)]">路径配置</h3>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">promptsDir</label>
                <InputText v-model="appSettings.promptsDir" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">workspacesDir</label>
                <InputText v-model="appSettings.workspacesDir" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">runtimeDir</label>
                <InputText v-model="appSettings.runtimeDir" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">loggingConfigPath</label>
                <InputText v-model="appSettings.loggingConfigPath" class="w-full" />
              </div>
            </div>

            <div class="p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] space-y-4">
              <h3 class="text-sm font-bold text-[var(--text-1)]">运行限制</h3>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">maxSteps</label>
                  <InputNumber v-model="appSettings.maxSteps" :min="1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">maxToolRounds</label>
                  <InputNumber v-model="appSettings.maxToolRounds" :min="1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">httpPort</label>
                  <InputNumber v-model="appSettings.httpPort" :min="1" :max="65535" class="w-full" />
                </div>
              </div>
            </div>

            <div class="p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] space-y-4">
              <h3 class="text-sm font-bold text-[var(--text-1)]">上下文限制</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">maxTokens</label>
                  <InputNumber v-model="appSettings.contextLimit!.maxTokens" :min="1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">warningThreshold</label>
                  <InputNumber v-model="appSettings.contextLimit!.warningThreshold" :min="0" :max="1" :min-fraction-digits="2" :max-fraction-digits="2" :step="0.01" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">criticalThreshold</label>
                  <InputNumber v-model="appSettings.contextLimit!.criticalThreshold" :min="0" :max="1" :min-fraction-digits="2" :max-fraction-digits="2" :step="0.01" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">hardLimitThreshold</label>
                  <InputNumber v-model="appSettings.contextLimit!.hardLimitThreshold" :min="0" :max="1" :min-fraction-digits="2" :max-fraction-digits="2" :step="0.01" class="w-full" />
                </div>
              </div>
            </div>

            <div class="p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] space-y-4">
              <h3 class="text-sm font-bold text-[var(--text-1)]">记忆系统</h3>
              <div class="flex items-center justify-between">
                <span class="text-sm text-[var(--text-1)]">agentMemory.enabled</span>
                <label class="relative inline-flex items-center cursor-pointer select-none">
                  <input
                    v-model="appSettings.agentMemory!.enabled"
                    type="checkbox"
                    class="sr-only peer"
                    aria-label="启用记忆系统"
                    role="switch"
                    :aria-checked="appSettings.agentMemory!.enabled"
                  />
                  <div class="w-11 h-6 bg-[var(--surface-3)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--primary-weak)] rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
                  <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
                </label>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.maxEntries</label>
                  <InputNumber v-model="appSettings.agentMemory!.maxEntries" :min="1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.llm.temperature</label>
                  <InputNumber v-model="appSettings.agentMemory!.llm.temperature" :min="0" :max="2" :min-fraction-digits="1" :max-fraction-digits="2" :step="0.1" class="w-full" />
                </div>
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.llm.provider</label>
                <InputText v-model="appSettings.agentMemory!.llm.provider" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.llm.baseUrl</label>
                <InputText v-model="appSettings.agentMemory!.llm.baseUrl" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.llm.model</label>
                <InputText v-model="appSettings.agentMemory!.llm.model" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.llm.apiKey</label>
                <InputText v-model="appSettings.agentMemory!.llm.apiKey" type="password" class="w-full" />
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.embedding.modelPath</label>
                <InputText v-model="appSettings.agentMemory!.embedding.modelPath" class="w-full" />
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.embedding.dimensions</label>
                  <InputNumber v-model="appSettings.agentMemory!.embedding.dimensions" :min="1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.recall.limit</label>
                  <InputNumber v-model="appSettings.agentMemory!.recall.limit" :min="1" class="w-full" />
                </div>
              </div>
              <div>
                <label class="block text-sm text-[var(--text-1)] mb-1.5">agentMemory.recall.minConfidence</label>
                <InputNumber v-model="appSettings.agentMemory!.recall.minConfidence" :min="0" :max="1" :min-fraction-digits="2" :max-fraction-digits="2" :step="0.01" class="w-full" />
              </div>
            </div>

              <div class="flex items-center gap-3 pt-4 border-t border-[var(--border)]">
                <Button
                  variant="primary"
                  :disabled="!hasAppSettingsChanges || appSettingsSaving"
                  :loading="appSettingsSaving"
                  @click="saveAppSettings"
                >
                  <Save class="w-4 h-4 mr-2" />
                  保存应用设置
                </Button>
                <Button
                  variant="text"
                  :disabled="!hasAppSettingsChanges || appSettingsSaving"
                  @click="resetAppSettings"
                >
                  重置
                </Button>
                <span v-if="hasAppSettingsChanges" class="text-xs text-orange-500 ml-auto">
                  有未保存的修改
                </span>
              </div>
            </div>
          </section>
        </TabPanel>

        <!-- LLM 配置 -->
        <TabPanel value="llm" class="h-full overflow-y-auto p-6 space-y-6">
          <!-- 首次运行提示 -->
          <div v-if="isFirstRun" class="p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
            <AlertCircle class="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p class="font-medium text-blue-700">首次运行配置</p>
              <p class="text-sm text-blue-600 mt-1">
                这是您第一次运行系统。请配置大模型参数后保存，系统将创建 app.local.json 配置文件。
                配置保存后系统将自动连接大模型服务。
              </p>
            </div>
          </div>

          <!-- 状态提示 -->
          <Message v-if="llmError" severity="error" class="mb-4">{{ llmError }}</Message>
          <Message v-if="llmSuccess" severity="success" class="mb-4">配置已保存到 app.local.json</Message>

          <!-- 加载状态 -->
          <div v-if="llmLoading" class="flex items-center justify-center py-12">
            <Loader2 class="w-6 h-6 animate-spin text-[var(--text-3)]" />
          </div>

          <!-- 配置表单 -->
          <div v-else class="space-y-6">
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                接口类型
              </label>
              <select
                v-model="llmProviderType"
                class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-weak)] disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="!isLlmProviderEditable"
              >
                <option
                  v-for="option in llmProviderOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
              <p v-if="isLlmProviderEditable" class="text-xs text-[var(--text-3)] mt-1">
                OpenAI Chat 使用 `/chat/completions`，Responses 使用 `/responses`，Anthropic 使用 `/messages`。默认 Chat。
              </p>
              <p v-else class="text-xs text-[var(--text-3)] mt-1">
                当前 provider 为 {{ llmConfig.provider }}。该选项仅对支持 provider 生效，保存时会保留现有 provider。
              </p>
            </section>

            <!-- 服务地址 -->
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                <Globe class="w-4 h-4 inline-block mr-1" />
                API 地址
              </label>
              <InputText
                v-model="llmConfig.baseURL"
                placeholder="http://127.0.0.1:1234/v1"
                class="w-full"
              />
              <p class="text-xs text-[var(--text-3)] mt-1">
                大模型服务的 API 地址，支持 OpenAI 兼容格式
              </p>
            </section>

            <!-- 模型名称 -->
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                <Server class="w-4 h-4 inline-block mr-1" />
                模型名称
              </label>
              <InputText
                v-model="llmConfig.model"
                placeholder="model-name"
                class="w-full"
              />
              <p class="text-xs text-[var(--text-3)] mt-1">
                要使用的模型标识符
              </p>
            </section>

            <!-- API Key -->
            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                <Key class="w-4 h-4 inline-block mr-1" />
                API Key
              </label>
              <InputText
                v-model="llmConfig.apiKey"
                placeholder="sk-..."
                type="password"
                class="w-full"
              />
              <p class="text-xs text-[var(--text-3)] mt-1">
                访问大模型服务的密钥，本地部署可填 NOT_NEEDED
              </p>
            </section>

            <!-- 高级设置 -->
            <section class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                  最大 Token 数
                </label>
                <InputNumber
                  v-model="llmConfig.maxTokens"
                  :min="1"
                  class="w-full"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                  最大并发请求
                </label>
                <InputNumber
                  v-model="llmConfig.maxConcurrentRequests"
                  :min="1"
                  class="w-full"
                />
              </div>
            </section>

            <!-- 超时时间 -->
            <section class="mt-4">
              <div>
                <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                  请求超时时间（毫秒）
                </label>
                <InputNumber
                  v-model="llmConfig.timeout"
                  :min="60000"
                  :step="60000"
                  class="w-full"
                />
                <p class="text-xs text-[var(--text-3)] mt-1">
                  默认 1800000（30分钟），生成大量内容时需要更长的超时时间
                </p>
              </div>
            </section>

            <section>
              <div class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                <div class="pr-4">
                  <p class="text-sm font-medium text-[var(--text-1)]">stream 字段</p>
                  <p class="mt-1 text-xs text-[var(--text-3)]">
                    发送模型请求时始终附带 `stream` 字段。默认开启，兼容要求 `stream=true` 的服务。
                  </p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer select-none">
                  <input
                    v-model="llmConfig.stream"
                    type="checkbox"
                    class="sr-only peer"
                    aria-label="切换默认大模型配置的 stream 字段"
                  />
                  <div class="h-6 w-11 rounded-full bg-[var(--surface-3)] transition-colors peer-checked:bg-[var(--primary-weak)]"></div>
                  <div class="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></div>
                </label>
              </div>
            </section>

            <section>
              <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                能力标签
              </label>
              <MultiSelect
                v-model="llmConfig.capabilityTags"
                :options="llmCapabilityTagOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="请选择能力标签"
                display="chip"
                class="w-full"
              />
              <p class="text-xs text-[var(--text-3)] mt-1">
                默认应包含 tool_calling。保存时会保留该配置，避免误判为不支持工具调用。
              </p>
            </section>

            <section class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                  输入能力
                </label>
                <MultiSelect
                  v-model="llmConfig.capabilities!.input"
                  :options="capabilityInputOptions"
                  optionLabel="label"
                  optionValue="value"
                  placeholder="请选择输入能力"
                  display="chip"
                  class="w-full"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-[var(--text-1)] mb-2">
                  输出能力
                </label>
                <MultiSelect
                  v-model="llmConfig.capabilities!.output"
                  :options="capabilityOutputOptions"
                  optionLabel="label"
                  optionValue="value"
                  placeholder="请选择输出能力"
                  display="chip"
                  class="w-full"
                />
              </div>
            </section>

            <!-- Thinking 模式（Anthropic / OpenAI 接口均支持） -->
            <section v-if="isLlmProviderEditable">
              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 space-y-3">
                <div class="flex items-center justify-between">
                  <div class="pr-4">
                    <p class="text-sm font-medium text-[var(--text-1)]">Thinking / Reasoning 模式</p>
                    <p class="mt-1 text-xs text-[var(--text-3)]">
                      控制模型的深度思考行为。Anthropic 接口传递 thinking 块，OpenAI 接口传递 reasoningEffort。
                    </p>
                  </div>
                  <select
                    v-model="llmConfig.thinking.type"
                    class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-1)] outline-none"
                  >
                    <option value="disabled">关闭</option>
                    <option value="enabled">启用</option>
                    <option value="adaptive">自适应</option>
                  </select>
                </div>
                <div v-if="llmConfig.thinking?.type === 'enabled'" class="flex flex-col gap-3 pt-2 border-t border-[var(--border)]">
                  <div class="flex items-center gap-3">
                    <label class="text-sm text-[var(--text-2)] shrink-0">思考 Token 预算</label>
                    <InputNumber
                      v-model="llmConfig.thinking.budgetTokens"
                      :min="1024"
                      :step="1024"
                      class="w-full"
                    />
                  </div>
                  <div class="flex items-center gap-3">
                    <label class="text-sm text-[var(--text-2)] shrink-0">思考深度</label>
                    <select
                      v-model="llmConfig.thinking.effort"
                      class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-1)] outline-none"
                    >
                      <option value="high">高 (high)</option>
                      <option value="max">最高 (max)</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            <!-- 操作按钮 -->
            <div class="flex items-center gap-3 pt-4 border-t border-[var(--border)]">
              <Button
                variant="primary"
                :disabled="!hasLlmChanges || llmSaving"
                :loading="llmSaving"
                @click="saveLlmConfig"
              >
                <Save class="w-4 h-4 mr-2" />
                保存配置
              </Button>
              <Button
                variant="text"
                :disabled="!hasLlmChanges || llmSaving"
                @click="resetLlmConfig"
              >
                重置
              </Button>
              <span v-if="hasLlmChanges" class="text-xs text-orange-500 ml-auto">
                有未保存的修改
              </span>
            </div>
          </div>
        </TabPanel>

        <!-- LLM 服务管理 -->
        <TabPanel v-if="!isFirstRun" value="services" class="h-full overflow-y-auto p-6">
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-bold text-[var(--text-1)]">模型服务列表</h3>
              <Button variant="text" size="small" @click="openAddServiceDialog">
                <Plus class="w-4 h-4 mr-1" />
                添加服务
              </Button>
            </div>
            
            <div v-if="servicesLoading" class="flex items-center justify-center py-12">
              <Loader2 class="w-6 h-6 animate-spin text-[var(--text-3)]" />
            </div>
            
            <div v-else class="grid grid-cols-1 gap-4">
              <div
                v-for="service in llmServices"
                :key="service.id"
                class="rounded-xl bg-[var(--surface-2)] border border-[var(--border)]"
              >
                <!-- 顶行：图标、信息、启用开关 -->
                <div class="flex items-start gap-3 p-4">
                  <div class="w-10 h-10 rounded-lg bg-[var(--surface-3)] flex items-center justify-center text-[var(--primary)] shrink-0">
                    <Cpu class="w-5 h-5" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <p class="font-medium text-[var(--text-1)] truncate">{{ service.name }}</p>
                      <span class="text-xs text-[var(--text-3)] shrink-0">{{ service.id }}</span>
                    </div>
                    <p v-if="service.description" class="text-xs text-[var(--text-3)] mt-1 truncate">{{ service.description }}</p>
                    <div class="flex gap-1 mt-1.5">
                      <span
                        v-for="tag in service.capabilityTags?.slice(0, 4)"
                        :key="tag"
                        class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--primary-weak)] text-[var(--primary)]"
                      >
                        {{ tag }}
                      </span>
                    </div>
                  </div>
                  <label class="relative inline-flex items-center cursor-pointer select-none shrink-0" :title="service.enabled !== false ? '已启用' : '已禁用'">
                    <input
                      type="checkbox"
                      :checked="service.enabled !== false"
                      class="sr-only peer"
                      role="switch"
                      :aria-label="service.enabled !== false ? '禁用' + service.name : '启用' + service.name"
                      @change="toggleServiceEnabled(service)"
                    />
                    <div class="w-11 h-6 bg-[var(--surface-3)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--primary-weak)] rounded-full peer peer-checked:bg-[var(--primary-weak)] transition-colors"></div>
                    <div class="absolute left-[2px] top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"></div>
                  </label>
                </div>
                <!-- 底行：操作按钮分隔线 -->
                <div class="flex items-center justify-end gap-2 px-4 py-2 border-t border-[var(--border)] bg-[var(--surface-1)] rounded-b-xl">
                  <span class="text-xs text-[var(--text-3)] mr-auto">{{ service.enabled !== false ? '已启用' : '已禁用' }}</span>
                  <Button variant="text" size="small" @click="openEditServiceDialog(service)">
                    编辑
                  </Button>
                  <Button variant="text" size="small" @click="openSetDefaultConfirm(service)">
                    设置为默认
                  </Button>
                  <Button variant="text" size="small" class="!text-red-500" @click="openDeleteServiceConfirm(service.id)">
                    删除
                  </Button>
                </div>
              </div>
              
              <div v-if="llmServices.length === 0" class="text-center py-12 text-[var(--text-3)]">
                <Cpu class="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>暂无自定义模型服务</p>
                <p class="text-xs mt-1">点击上方按钮添加</p>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- 关于系统 -->
        <TabPanel v-if="!isFirstRun" value="about" class="h-full overflow-y-auto p-6 flex flex-col items-center justify-center space-y-4;">
          <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--primary-hover)] flex items-center justify-center shadow-lg shadow-[var(--primary-weak)]">
            <span class="text-white text-3xl font-bold">AS</span>
          </div>
          <div class="text-center">
            <h2 class="text-xl font-bold text-[var(--text-1)]">Agent Society</h2>
            <p class="text-sm text-[var(--text-3)]">版本 1.0.0-alpha</p>
          </div>
          <p class="text-sm text-center text-[var(--text-2)] max-w-[300px] leading-relaxed">
            一个基于大模型的智能体自组织社会化系统，致力于探索智能体协作的新边界。
          </p>
          <div class="pt-4 flex gap-4">
            <Button label="检查更新" variant="text" size="small" />
            <Button label="用户手册" variant="text" size="small" />
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <!-- 服务编辑对话框 -->
    <Dialog
      v-model:visible="serviceDialogVisible"
      :header="isEditingService ? '编辑服务' : '添加服务'"
      :style="{ width: '520px' }"
      :modal="false"
      :dismissable-mask="false"
      :closable="!serviceSaving"
      :close-on-escape="false"
      :keep-in-viewport="false"
      pt:content:class="!p-0"
    >
      <div class="px-6 py-4 space-y-5 max-h-[60vh] overflow-y-auto">
        <!-- 错误提示 -->
        <Message v-if="serviceError" severity="error">{{ serviceError }}</Message>

        <!-- 服务 ID -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            服务 ID <span class="text-red-500">*</span>
          </label>
          <InputText
            v-model="serviceForm.id"
            placeholder="my-service"
            class="w-full"
            :disabled="isEditingService"
          />
          <p class="text-xs text-[var(--text-3)] mt-1">
            唯一标识符，保存后不可修改
          </p>
        </section>

        <!-- 服务名称 -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            服务名称 <span class="text-red-500">*</span>
          </label>
          <InputText
            v-model="serviceForm.name"
            placeholder="我的服务"
            class="w-full"
          />
        </section>

        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            接口类型
          </label>
          <select
            v-model="serviceProviderType"
            class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-weak)] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!isServiceProviderEditable"
          >
            <option
              v-for="option in llmProviderOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <p v-if="isServiceProviderEditable" class="text-xs text-[var(--text-3)] mt-1">
            OpenAI Chat 使用 `/chat/completions`，Responses 使用 `/responses`，Anthropic 使用 `/messages`。默认 Chat。
          </p>
          <p v-else class="text-xs text-[var(--text-3)] mt-1">
            当前 provider 为 {{ serviceForm.provider }}。该选项仅对支持 provider 生效，保存时会保留现有 provider。
          </p>
        </section>

        <!-- API 地址 -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            API 地址 <span class="text-red-500">*</span>
          </label>
          <InputText
            v-model="serviceForm.baseURL"
            placeholder="http://127.0.0.1:1234/v1"
            class="w-full"
          />
        </section>

        <!-- 模型名称 -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            模型名称 <span class="text-red-500">*</span>
          </label>
          <InputText
            v-model="serviceForm.model"
            placeholder="model-name"
            class="w-full"
          />
        </section>

        <!-- API Key -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            API Key
          </label>
          <InputText
            v-model="serviceForm.apiKey"
            placeholder="sk-..."
            type="password"
            class="w-full"
          />
          <p class="text-xs text-[var(--text-3)] mt-1">
            {{ isEditingService ? '留空表示不修改原值' : '本地部署可填写 NOT_NEEDED' }}
          </p>
        </section>

        <!-- 高级设置 -->
        <section class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
              最大 Token 数
            </label>
            <InputNumber
              v-model="serviceForm.maxTokens"
              :min="1"
              class="w-full"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
              最大并发请求
            </label>
            <InputNumber
              v-model="serviceForm.maxConcurrentRequests"
              :min="1"
              class="w-full"
            />
          </div>
        </section>

        <!-- 超时时间 -->
        <section class="mt-4">
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            请求超时时间（毫秒）
          </label>
          <InputNumber
            v-model="serviceForm.timeout"
            :min="60000"
            :step="60000"
            class="w-full"
          />
          <p class="text-xs text-[var(--text-3)] mt-1">
            默认 1800000（30分钟），生成大量内容时需要更长的超时时间
          </p>
        </section>

        <section>
          <div class="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <div class="pr-4">
              <p class="text-sm font-medium text-[var(--text-1)]">stream 字段</p>
              <p class="mt-1 text-xs text-[var(--text-3)]">
                该模型服务的请求会带上 `stream` 字段。默认开启，适用于必须要求 `stream=true` 的服务端。
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer select-none">
              <input
                v-model="serviceForm.stream"
                type="checkbox"
                class="sr-only peer"
                aria-label="切换模型服务的 stream 字段"
              />
              <div class="h-6 w-11 rounded-full bg-[var(--surface-3)] transition-colors peer-checked:bg-[var(--primary-weak)]"></div>
              <div class="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"></div>
            </label>
          </div>
        </section>

        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            能力标签
          </label>
          <MultiSelect
            v-model="serviceForm.capabilityTags"
            :options="capabilityTagOptions"
            optionLabel="label"
            optionValue="value"
            placeholder="请选择能力标签"
            display="chip"
            class="w-full"
          />
          <p class="text-xs text-[var(--text-3)] mt-1">
            仅支持从预设能力中选择，避免自由输入导致能力识别异常
          </p>
        </section>

        <section class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
              输入能力
            </label>
            <MultiSelect
              v-model="serviceForm.capabilities.input"
              :options="capabilityInputOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="请选择输入能力"
              display="chip"
              class="w-full"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
              输出能力
            </label>
            <MultiSelect
              v-model="serviceForm.capabilities.output"
              :options="capabilityOutputOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="请选择输出能力"
              display="chip"
              class="w-full"
            />
          </div>
        </section>

        <!-- Thinking 模式（Anthropic / OpenAI 接口均支持） -->
        <section v-if="isServiceProviderEditable">
          <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 space-y-3">
            <div class="flex items-center justify-between">
              <div class="pr-4">
                <p class="text-sm font-medium text-[var(--text-1)]">Thinking / Reasoning 模式</p>
                <p class="mt-1 text-xs text-[var(--text-3)]">
                  控制模型的深度思考行为。Anthropic 接口传递 thinking 块，OpenAI 接口传递 reasoningEffort。
                </p>
              </div>
              <select
                v-model="serviceForm.thinking.type"
                class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-1)] outline-none"
              >
                <option value="disabled">关闭</option>
                <option value="enabled">启用</option>
                <option value="adaptive">自适应</option>
              </select>
            </div>
            <div v-if="serviceForm.thinking?.type === 'enabled'" class="flex flex-col gap-3 pt-2 border-t border-[var(--border)]">
              <div class="flex items-center gap-3">
                <label class="text-sm text-[var(--text-2)] shrink-0">思考 Token 预算</label>
                <InputNumber
                  v-model="serviceForm.thinking.budgetTokens"
                  :min="1024"
                  :step="1024"
                  class="w-full"
                />
              </div>
              <div class="flex items-center gap-3">
                <label class="text-sm text-[var(--text-2)] shrink-0">思考深度</label>
                <select
                  v-model="serviceForm.thinking.effort"
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-1)] outline-none"
                >
                  <option value="high">高 (high)</option>
                  <option value="max">最高 (max)</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <!-- 描述 -->
        <section>
          <label class="block text-sm font-medium text-[var(--text-1)] mb-1.5">
            描述
          </label>
          <Textarea
            v-model="serviceForm.description"
            placeholder="服务描述..."
            rows="2"
            class="w-full resize-none"
          />
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2 px-6 py-3">
          <Button
            variant="text"
            :disabled="serviceSaving"
            @click="serviceDialogVisible = false"
          >
            取消
          </Button>
          <Button
            variant="primary"
            :loading="serviceSaving"
            @click="saveService"
          >
            <Save class="w-4 h-4 mr-1" />
            {{ isEditingService ? '保存' : '添加' }}
          </Button>
        </div>
      </template>
    </Dialog>
    <!-- 删除服务确认对话框 -->
    <ConfirmDialog
      v-model:visible="showDeleteServiceConfirm"
      title="删除服务"
      message="确定要删除此服务吗？"
      confirm-label="删除"
      cancel-label="取消"
      confirm-severity="danger"
      @confirm="handleDeleteServiceConfirmed"
    />

    <!-- 设置默认服务确认对话框 -->
    <ConfirmDialog
      v-model:visible="showSetDefaultConfirm"
      title="设置为默认大模型"
      :message="setDefaultConfirmMessage"
      confirm-label="确定设置"
      cancel-label="取消"
      confirm-severity="primary"
      :loading="setDefaultSaving"
      @confirm="handleSetDefaultConfirmed"
    />
  </div>
</template>

