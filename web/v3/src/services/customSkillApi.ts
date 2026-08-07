const BASE_URL = '/api';

/**
 * 自定义技能 API 请求函数。
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

export interface CustomSkillRecord {
  skillId: string;
  customSkillId: string;
  displayName: string;
  description: string;
  installState: string;
  status: 'enabled' | 'disabled';
  updatedAt: string;
  sourceType: 'custom';
  sourceSkillId?: string | null;
}

export interface CustomSkillTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: CustomSkillTreeNode[];
}

export const customSkillApi = {
  /**
   * 获取自定义技能列表。
   */
  async listCustomSkills(): Promise<CustomSkillRecord[]> {
    const data = await request('/custom-skills');
    return data.skills || [];
  },

  /**
   * 创建空白自定义技能。
   */
  async createCustomSkill(displayName?: string): Promise<any> {
    return request('/custom-skills', {
      method: 'POST',
      body: JSON.stringify({ displayName })
    });
  },

  /**
   * 从已有技能复制创建自定义技能。
   */
  async copySkillAsCustom(sourceSkillId: string, displayName?: string): Promise<any> {
    return request('/custom-skills/copy', {
      method: 'POST',
      body: JSON.stringify({ sourceSkillId, displayName })
    });
  },

  /**
   * 获取自定义技能详情。
   */
  async getCustomSkill(skillId: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}`);
  },

  /**
   * 获取文件树。
   */
  async getCustomSkillTree(skillId: string): Promise<CustomSkillTreeNode[]> {
    const data = await request(`/custom-skills/${encodeURIComponent(skillId)}/tree`);
    return data.tree || [];
  },

  /**
   * 读取文件内容。
   */
  async readCustomSkillFile(skillId: string, filePath: string): Promise<{ path: string; content: string; updatedAt: string }> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(filePath)}`);
  },

  /**
   * 创建空文件。
   */
  async createCustomSkillFile(skillId: string, filePath: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/file`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath })
    });
  },

  /**
   * 写入文件内容。
   */
  async writeCustomSkillFile(skillId: string, filePath: string, content: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath, content })
    });
  },

  /**
   * 创建子文件夹。
   */
  async createCustomSkillFolder(skillId: string, folderPath: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/folder`, {
      method: 'POST',
      body: JSON.stringify({ path: folderPath })
    });
  },

  /**
   * 删除文件或目录。
   */
  async deleteCustomSkillEntry(skillId: string, entryPath: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/entry?path=${encodeURIComponent(entryPath)}`, {
      method: 'DELETE'
    });
  },

  /**
   * 重命名文件或目录。
   */
  async renameCustomSkillEntry(skillId: string, fromPath: string, toPath: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/entry/rename`, {
      method: 'POST',
      body: JSON.stringify({ fromPath, toPath })
    });
  },

  /**
   * 更新启停状态。
   */
  async setCustomSkillStatus(skillId: string, status: 'enabled' | 'disabled'): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
  },

  /**
   * 删除整个技能。
   */
  async deleteCustomSkill(skillId: string): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE'
    });
  },

  /**
   * 调用系统文件管理器打开技能内容文件夹。
   * @param skillId 技能 ID
   * @param relativePath 工作区内路径（可选，默认打开技能根目录）
   */
  async openCustomSkillDirectory(skillId: string, relativePath: string = ''): Promise<any> {
    return request(`/custom-skills/${encodeURIComponent(skillId)}/open`, {
      method: 'POST',
      body: JSON.stringify({ path: relativePath })
    });
  }
};
