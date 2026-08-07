const BASE_URL = '/api';

/**
 * 技能 API 服务。
 * 负责技能浏览、安装、卸载、总览与岗位/智能体技能配置请求。
 */
async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  });

  if (!response.ok) {
    let detail: any = null;
    try {
      detail = await response.json();
    } catch {
      detail = null;
    }
    throw new Error(detail?.message || detail?.error || `HTTP 错误: ${response.status}`);
  }

  return response.json();
}

export interface SkillCatalogItem {
  skillId: string;
  providerId: string;
  kind: string;
  externalId: string;
  displayName: string;
  description: string;
  homepageUrl?: string | null;
  installUrl?: string | null;
  sourceUrl?: string | null;
  tags: string[];
  installState: string;
  installed: boolean;
  roleUsageCount: number;
  agentUsageCount: number;
}

export interface SkillBinding {
  skillId: string;
  enabled: boolean;
}

export interface SkillBindingEntry {
  skillId: string;
  displayName: string;
  description: string;
  installState: string;
  configuredEnabled: boolean;
  visible: boolean;
  missingReason: string | null;
  source: string;
  roleConfiguredEnabled?: boolean | null;
  agentConfiguredEnabled?: boolean | null;
  homepageUrl?: string | null;
  tags: string[];
}

export interface SkillBindingView {
  targetType: 'role' | 'agent';
  targetId: string;
  bindings: SkillBinding[];
  entries: SkillBindingEntry[];
}

export interface SkillOverviewResponse {
  skill: SkillCatalogItem;
  roles: Array<{
    roleId: string;
    roleName: string;
    configuredEnabled: boolean;
    visible: boolean;
    missingReason: string | null;
  }>;
  agents: Array<{
    agentId: string;
    agentName: string;
    roleId: string;
    roleName: string;
    configuredEnabled: boolean;
    source: string;
    visible: boolean;
    missingReason: string | null;
    workspaceId: string;
  }>;
  counts: {
    roles: number;
    agents: number;
  };
}

export interface SkillContentResponse {
  skill: SkillCatalogItem;
  installed: boolean;
  manifest: {
    hasScripts?: boolean;
    scriptEntries?: string[];
    hasResources?: boolean;
    packageFiles?: string[];
  } | null;
  skillMd: string;
  referenceMd: string;
}

export const skillApi = {
  async listSkills(query = ''): Promise<SkillCatalogItem[]> {
    const search = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    const data = await request<{ skills: SkillCatalogItem[] }>(`/skills${search}`);
    return data.skills || [];
  },

  async installSkill(payload: { providerId?: string; externalId?: string; installUrl?: string }): Promise<any> {
    return request('/skills/install', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async uninstallSkill(skillId: string): Promise<any> {
    return request('/skills/uninstall', {
      method: 'POST',
      body: JSON.stringify({ skillId })
    });
  },

  async getSkillOverview(skillId: string): Promise<SkillOverviewResponse> {
    return request(`/skills/${encodeURIComponent(skillId)}`);
  },

  async getSkillContent(skillId: string): Promise<SkillContentResponse> {
    return request(`/skills/${encodeURIComponent(skillId)}/content`);
  },

  async getRuntimeInfo(): Promise<any> {
    return request('/skills/runtime');
  },

  async getRoleSkills(roleId: string): Promise<SkillBindingView> {
    return request(`/role/${encodeURIComponent(roleId)}/skills`);
  },

  async updateRoleSkills(roleId: string, bindings: SkillBinding[]): Promise<SkillBindingView> {
    return request(`/role/${encodeURIComponent(roleId)}/skills`, {
      method: 'PUT',
      body: JSON.stringify({ bindings })
    });
  },

  async getAgentSkills(agentId: string): Promise<SkillBindingView> {
    return request(`/agent/${encodeURIComponent(agentId)}/skills`);
  },

  async updateAgentSkills(agentId: string, bindings: SkillBinding[]): Promise<SkillBindingView> {
    return request(`/agent/${encodeURIComponent(agentId)}/skills`, {
      method: 'PUT',
      body: JSON.stringify({ bindings })
    });
  }
};
