/**
 * 配置管理 API 服务
 * 
 * 提供与系统配置相关的后端接口调用，包括 LLM 配置、LLM 服务管理等
 * 
 * @module services/configApi
 */

const BASE_URL = '/api';
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 发送 HTTP 请求的基础函数
 * @param endpoint - API 端点路径
 * @param options - 请求配置选项
 * @returns 解析后的 JSON 数据
 * @throws 请求失败或超时时抛出错误
 */
async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch {
        // 忽略 JSON 解析错误
      }
      const message = detail?.message || (detail?.details ? JSON.stringify(detail.details) : null) || detail?.error || `HTTP 错误: ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * LLM 配置接口
 */
export interface ModelCapabilities {
  input: string[];
  output: string[];
}

export interface ThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budgetTokens?: number;
  effort?: "high" | "max";
}

export interface LlmConfig {
  provider?: string;
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  maxConcurrentRequests: number;
  timeout?: number;
  stream?: boolean;
  capabilityTags?: string[];
  capabilities?: ModelCapabilities;
  thinking: ThinkingConfig;
}

/**
 * 配置状态接口
 */
export interface ConfigStatus {
  hasLocalConfig: boolean;
  llmStatus: string;
  lastError: string | null;
}

export interface ModuleCatalogItem {
  name: string;
  enabled: boolean;
  config: Record<string, any>;
  defaultConfig: Record<string, any>;
  hasWebComponent: boolean;
  hasHttpHandler: boolean;
  toolCount: number;
  toolGroupId: string;
  toolGroupDescription: string;
}

export interface AppSettingsConfig {
  promptsDir: string;
  workspacesDir: string;
  runtimeDir: string;
  loggingConfigPath: string;
  maxSteps: number;
  maxToolRounds: number;
  httpPort: number;
  contextLimit: {
    maxTokens: number;
    warningThreshold: number;
    criticalThreshold: number;
    hardLimitThreshold: number;
  } | null;
  skills: {
    enabled: boolean;
    providers: Record<string, any>;
    runtime: {
      bunPath: string;
      pythonPath: string;
      projectPythonVenvDir: string;
      allowSystemPythonFallback: boolean;
    };
  } | null;
  agentMemory: {
    enabled: boolean;
    maxEntries: number;
    llm: {
      provider: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
      temperature?: number;
    };
    embedding: {
      modelPath: string;
      dimensions: number;
    };
    recall: {
      limit: number;
      minConfidence: number;
    };
  } | null;
  moodColors?: {
    enabled: boolean;
  } | null;
}

/**
 * 配置相关 API 接口
 */
export const configApi = {
  /**
   * 获取配置状态
   * 
   * 调用后端接口: GET /api/config/status
   * 
   * @returns 配置状态，包括是否为首次运行
   * @throws 获取失败时抛出错误
   */
  async getConfigStatus(): Promise<ConfigStatus> {
    return request<ConfigStatus>('/config/status');
  },

  /**
   * 获取 LLM 配置
   * 
   * 调用后端接口: GET /api/config/llm
   * 如果没有本地配置，返回 app.json 中的默认配置
   * 
   * @returns LLM 配置对象
   * @throws 获取失败时抛出错误
   */
  async getLlmConfig(): Promise<{ llm: LlmConfig; source: string }> {
    return request<{ llm: LlmConfig; source: string }>('/config/llm');
  },

  /**
   * 保存 LLM 配置
   * 
   * 调用后端接口: POST /api/config/llm
   * 保存时会自动创建 app.local.json（如果不存在）
   * 
   * @param config - LLM 配置对象
   * @throws 保存失败时抛出错误
   */
  async saveLlmConfig(config: Partial<LlmConfig>): Promise<void> {
    await request<void>('/config/llm', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  async getModulesConfig(): Promise<{
    modules: Record<string, any>;
    source: string;
    catalog: ModuleCatalogItem[];
    enableAll: boolean;
    enabled: string[];
  }> {
    return request<{
      modules: Record<string, any>;
      source: string;
      catalog: ModuleCatalogItem[];
      enableAll: boolean;
      enabled: string[];
    }>('/config/modules');
  },

  async saveModulesConfig(data: { enableAll: boolean; enabled: string[] }): Promise<void> {
    await request<void>('/config/modules', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async getAppSettings(): Promise<{ source: string; settings: AppSettingsConfig }> {
    return request<{ source: string; settings: AppSettingsConfig }>('/config/app-settings');
  },

  async saveAppSettings(settings: AppSettingsConfig): Promise<void> {
    await request<void>('/config/app-settings', {
      method: 'POST',
      body: JSON.stringify({ settings }),
    });
  },

  /**
   * 获取 LLM 服务列表配置
   * 
   * 调用后端接口: GET /api/config/llm-services
   * 
   * @returns LLM 服务列表
   * @throws 获取失败时抛出错误
   */
  async getLlmServicesConfig(): Promise<{ services: any[]; source: string }> {
    return request<{ services: any[]; source: string }>('/config/llm-services');
  },

  /**
   * 添加 LLM 服务
   * 
   * 调用后端接口: POST /api/config/llm-services
   * 
   * @param service - 服务配置对象
   * @throws 添加失败时抛出错误
   */
  async addLlmService(service: any): Promise<void> {
    await request<void>('/config/llm-services', {
      method: 'POST',
      body: JSON.stringify(service),
    });
  },

  /**
   * 更新 LLM 服务
   * 
   * 调用后端接口: POST /api/config/llm-services/:serviceId
   * 
   * @param serviceId - 服务 ID
   * @param service - 服务配置对象
   * @throws 更新失败时抛出错误
   */
  async updateLlmService(serviceId: string, service: any): Promise<void> {
    await request<void>(`/config/llm-services/${encodeURIComponent(serviceId)}`, {
      method: 'POST',
      body: JSON.stringify(service),
    });
  },

  /**
   * 删除 LLM 服务
   *
   * 调用后端接口: DELETE /api/config/llm-services/:serviceId
   *
   * @param serviceId - 服务 ID
   * @throws 删除失败时抛出错误
   */
  async deleteLlmService(serviceId: string): Promise<void> {
    await request<void>(`/config/llm-services/${encodeURIComponent(serviceId)}`, {
      method: 'DELETE',
    });
  },

  /**
   * 将指定服务配置设为默认 LLM 配置
   *
   * 调用后端接口: POST /api/config/llm/set-default
   *
   * @param serviceId - 服务 ID
   * @throws 操作失败时抛出错误
   */
  async setDefaultLlm(serviceId: string): Promise<void> {
    await request<void>('/config/llm/set-default', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    });
  },

  /**
   * 获取聊天配置
   *
   * 调用后端接口: GET /api/config/chat
   *
   * @returns 聊天配置（字体大小等）
   * @throws 获取失败时抛出错误
   */
  async getChatConfig(): Promise<{ fontSize: number; source: string }> {
    return request<{ fontSize: number; source: string }>('/config/chat');
  },

  /**
   * 保存聊天配置
   *
   * 调用后端接口: POST /api/config/chat
   *
   * @param config - 聊天配置对象（字体大小等）
   * @throws 保存失败时抛出错误
   */
  async saveChatConfig(config: { fontSize: number }): Promise<void> {
    await request<void>('/config/chat', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },
};
