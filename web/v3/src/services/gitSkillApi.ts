const BASE_URL = '/api';

/**
 * Git 技能 API 请求函数。
 * @param {string} endpoint
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function request(endpoint: string, options?: RequestInit): Promise<any> {
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

/** Git 技能记录 */
export interface GitSkillRecord {
  skillId: string;
  gitSkillId: string;
  displayName: string;
  description: string;
  installState: string;
  status: 'enabled' | 'disabled';
  gitUrl: string;
  branch: string;
  commitId: string;
  updatedAt: string;
  sourceType: 'git';
}

/** Git 技能元信息 */
export interface GitSkillMeta {
  gitUrl: string;
  branch: string;
  subDir: string;
  commitId: string;
  commitDate: string;
  importedAt: string;
  updatedAt?: string;
}

export const gitSkillApi = {
  /**
   * 获取 git 导入技能列表。
   */
  async listGitSkills(): Promise<GitSkillRecord[]> {
    const data = await request('/git-skills');
    return data.skills || [];
  },

  /**
   * 从 git 地址导入技能。
   */
  async importFromGit(payload: {
    gitUrl: string;
    branch?: string;
    subDir?: string;
    displayName?: string;
  }): Promise<any> {
    return request('/git-skills/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  /**
   * 更新（pull）git 技能。
   */
  async updateGitSkill(skillId: string): Promise<any> {
    return request(`/git-skills/${encodeURIComponent(skillId)}/update`, {
      method: 'POST'
    });
  },

  /**
   * 获取 git 技能详情。
   */
  async getGitSkill(skillId: string): Promise<any> {
    return request(`/git-skills/${encodeURIComponent(skillId)}`);
  },

  /**
   * 读取 git 技能文件内容。
   */
  async readGitSkillFile(skillId: string, filePath: string = 'SKILL.md'): Promise<{ path: string; content: string; updatedAt: string }> {
    return request(`/git-skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(filePath)}`);
  },

  /**
   * 更新启停状态。
   */
  async setGitSkillStatus(skillId: string, status: 'enabled' | 'disabled'): Promise<any> {
    return request(`/git-skills/${encodeURIComponent(skillId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
  },

  /**
   * 删除整个 git 技能。
   */
  async deleteGitSkill(skillId: string): Promise<any> {
    return request(`/git-skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE'
    });
  }
};
