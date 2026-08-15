/**
 * 工作区文件访问管理 API 服务
 *
 * 只负责封装后端 `/api/workspaces/file-access/*` 接口。
 * Vue 组件不直接拼接 `/api` 路径，也不感知具体端点格式。
 *
 * @module services/workspaceFileAccessApi
 */

const API_BASE = '/api/workspaces/file-access';
const DEFAULT_TIMEOUT_MS = 30000;

export type WorkspaceFolderSource = 'global' | 'overridden' | 'org' | 'org_override';

export interface WorkspaceFolder {
  id: string;
  path: string;
  read: boolean;
  write: boolean;
  description: string;
  _source?: WorkspaceFolderSource;
}

export interface WorkspaceOrg {
  orgId: string;
  orgName: string;
  firstAgentName?: string;
  hasConfig: boolean;
  folderCount: number;
}

export type WorkspaceOperation =
  | 'read'
  | 'write'
  | 'list'
  | 'create_dir'
  | 'copy_to_workspace'
  | 'copy_from_workspace'
  | 'check_permission';

export interface WorkspaceAccessLog {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  operation: WorkspaceOperation;
  path: string;
  success: boolean;
  error?: string | null;
  details?: Record<string, any>;
  orgId?: string | null;
  orgName?: string | null;
}

export interface WorkspaceAccessStats {
  total: number;
  byOperation: Record<string, number>;
  byAgent: Record<string, number>;
  success: number;
  failed: number;
}

export interface WorkspaceCheckPathResult {
  ok: true;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  canRead: boolean;
  canWrite: boolean;
  folder: WorkspaceFolder | null;
}

export interface WorkspaceFolderInput {
  path?: string;
  read: boolean;
  write: boolean;
  description: string;
}

export interface WorkspaceFolderMutationResult {
  ok: boolean;
  folder?: WorkspaceFolder;
  error?: string;
  message?: string;
}

export interface WorkspaceDeleteResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface WorkspaceFoldersResponse {
  ok: boolean;
  folders?: WorkspaceFolder[];
  error?: string;
  message?: string;
}

export interface WorkspaceLogFilters {
  limit?: number;
  offset?: number;
  operation?: WorkspaceOperation | '';
  agentId?: string;
  orgId?: string;
  startTime?: string;
  endTime?: string;
}

export interface WorkspaceLogsResponse {
  logs: WorkspaceAccessLog[];
  total: number;
  error?: string;
  message?: string;
}

export interface WorkspaceStatsResponse {
  ok: boolean;
  stats?: WorkspaceAccessStats;
  error?: string;
  message?: string;
}

export interface WorkspaceRetentionResponse {
  ok: boolean;
  logRetentionDays?: number;
  error?: string;
  message?: string;
}

export interface WorkspaceOrgsResponse {
  ok: boolean;
  orgs?: WorkspaceOrg[];
  error?: string;
  message?: string;
}

export interface WorkspaceOrgConfig {
  orgId: string;
  config: {
    folders: WorkspaceFolder[];
    logRetentionDays?: number;
  };
}

export interface WorkspaceOrgConfigsResponse {
  ok: boolean;
  orgConfigs?: WorkspaceOrgConfig[];
  error?: string;
  message?: string;
}

export type WorkspaceCheckPathResponse =
  | WorkspaceCheckPathResult
  | { ok: false; error?: string; message?: string };

/**
 * 发送 HTTP 请求并解析 JSON。
 * 所有请求都会携带超时控制；非 2xx 响应统一抛出包含后端消息的 Error。
 */
async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      let detail: any = null;
      try {
        detail = await response.json();
      } catch {
        // 响应体不是 JSON 时使用状态码兜底
      }

      const message =
        detail?.message ||
        detail?.error ||
        `HTTP 错误: ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function orgFoldersPath(orgId?: string): string {
  return orgId ? `/org-configs/${encodeURIComponent(orgId)}/folders` : '/folders';
}

function orgFolderPath(folderId: string, orgId?: string): string {
  const base = orgId ? `/org-configs/${encodeURIComponent(orgId)}/folders` : '/folders';
  return `${base}/${encodeURIComponent(folderId)}`;
}

function orgRetentionPath(orgId?: string): string {
  return orgId
    ? `/org-configs/${encodeURIComponent(orgId)}/settings/retention`
    : '/settings/retention';
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const workspaceFileAccessApi = {
  /**
   * 获取全局或组织有效授权文件夹列表。
   */
  async getFolders(orgId?: string): Promise<WorkspaceFoldersResponse> {
    return request<WorkspaceFoldersResponse>(orgFoldersPath(orgId));
  },

  /**
   * 添加全局或组织授权文件夹。
   */
  async addFolder(input: WorkspaceFolderInput, orgId?: string): Promise<WorkspaceFolderMutationResult> {
    return request<WorkspaceFolderMutationResult>(orgFoldersPath(orgId), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /**
   * 更新全局或组织授权文件夹的权限与描述。
   */
  async updateFolder(
    folderId: string,
    input: Pick<WorkspaceFolderInput, 'read' | 'write' | 'description'>,
    orgId?: string,
  ): Promise<WorkspaceFolderMutationResult> {
    return request<WorkspaceFolderMutationResult>(orgFolderPath(folderId, orgId), {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  /**
   * 删除全局或组织授权文件夹。
   */
  async deleteFolder(folderId: string, orgId?: string): Promise<WorkspaceDeleteResult> {
    return request<WorkspaceDeleteResult>(orgFolderPath(folderId, orgId), {
      method: 'DELETE',
    });
  },

  /**
   * 查询访问日志。
   */
  async getLogs(filters: WorkspaceLogFilters = {}): Promise<WorkspaceLogsResponse> {
    const query = toQueryString({
      limit: filters.limit,
      offset: filters.offset,
      operation: filters.operation,
      agentId: filters.agentId,
      orgId: filters.orgId,
      startTime: filters.startTime,
      endTime: filters.endTime,
    });
    return request<WorkspaceLogsResponse>(`/logs${query}`);
  },

  /**
   * 获取访问统计。
   */
  async getStats(range: { startTime?: string; endTime?: string } = {}): Promise<WorkspaceStatsResponse> {
    const query = toQueryString({
      startTime: range.startTime,
      endTime: range.endTime,
    });
    return request<WorkspaceStatsResponse>(`/stats${query}`);
  },

  /**
   * 获取全局或组织有效日志保留天数。
   */
  async getRetentionDays(orgId?: string): Promise<WorkspaceRetentionResponse> {
    return request<WorkspaceRetentionResponse>(orgRetentionPath(orgId));
  },

  /**
   * 保存全局或组织日志保留天数。
   */
  async saveRetentionDays(days: number, orgId?: string): Promise<WorkspaceDeleteResult> {
    return request<WorkspaceDeleteResult>(orgRetentionPath(orgId), {
      method: 'PUT',
      body: JSON.stringify({ days }),
    });
  },

  /**
   * 获取可供配置的组织列表。
   */
  async getOrgs(): Promise<WorkspaceOrgsResponse> {
    return request<WorkspaceOrgsResponse>('/orgs');
  },

  /**
   * 获取所有已保存的组织配置。
   */
  async getOrgConfigs(): Promise<WorkspaceOrgConfigsResponse> {
    return request<WorkspaceOrgConfigsResponse>('/org-configs');
  },

  /**
   * 删除指定组织的全部文件访问配置。
   */
  async deleteOrgConfig(orgId: string): Promise<WorkspaceDeleteResult> {
    return request<WorkspaceDeleteResult>(`/org-configs/${encodeURIComponent(orgId)}`, {
      method: 'DELETE',
    });
  },

  /**
   * 测试路径是否存在以及当前进程对该路径的读写权限。
   */
  async checkPath(path: string): Promise<WorkspaceCheckPathResponse> {
    return request<WorkspaceCheckPathResponse>('/check-path', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },
};
