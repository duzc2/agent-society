/**
 * 配置管理器
 *
 * 职责：
 * - 管理授权文件夹列表
 * - 通过 configService 注册默认值、加载合并配置、持久化变更
 * - 验证文件夹路径合法性
 * - 提供文件夹查询接口
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULTS = {
  folders: [],
  logRetentionDays: 30,
  orgConfigs: {}
};

/**
 * 配置管理器类
 */
export class ConfigManager {
  /**
   * @param {{configService: any, log: any}} options
   */
  constructor(options) {
    this.configService = options.configService;
    this.log = options.log;

    /** @type {Array<{id: string, path: string, read: boolean, write: boolean, description: string}>} */
    this.folders = [];

    /** @type {number} */
    this.logRetentionDays = 30;

    /** @type {Map<string, {folders: Array, logRetentionDays?: number}>} */
    this.orgConfigs = new Map();

    /** @type {boolean} */
    this._initialized = false;
  }

  /**
   * 初始化：注册默认值 → 与 config/modules/localfile.json 合并 → 应用到实例
   */
  async init() {
    if (this._initialized) return;

    if (this.configService) {
      this.configService.registerModuleConfig('localfile', DEFAULTS);
      const merged = await this.configService.getModuleConfig('localfile');
      this.folders = Array.isArray(merged.folders) ? [...merged.folders] : [];
      this.logRetentionDays = merged.logRetentionDays;

      // 加载组织配置
      const rawOrgConfigs = merged.orgConfigs;
      if (rawOrgConfigs && typeof rawOrgConfigs === "object" && !Array.isArray(rawOrgConfigs)) {
        for (const [orgId, orgConfig] of Object.entries(rawOrgConfigs)) {
          if (!orgConfig || typeof orgConfig !== "object") continue;
          const folders = Array.isArray(orgConfig.folders)
            ? orgConfig.folders.filter(f => this._validateOrgFolder(f))
            : [];
          const entry = { folders };
          if (typeof orgConfig.logRetentionDays === "number" && !isNaN(orgConfig.logRetentionDays) && orgConfig.logRetentionDays >= 1) {
            entry.logRetentionDays = orgConfig.logRetentionDays;
          }
          this.orgConfigs.set(orgId, entry);
        }
      }
    }

    // 验证并规范化文件夹配置
    this.folders = this.folders.filter(folder => this._validateFolder(folder));

    this._initialized = true;

    this.log.info("[LocalFile] 配置管理器初始化完成", {
      folderCount: this.folders.length,
      orgCount: this.orgConfigs.size
    });
  }

  /**
   * 持久化当前配置到 configService
   * @private
   */
  async _persist() {
    if (!this.configService) return;

    try {
      const orgConfigsObj = {};
      for (const [orgId, config] of this.orgConfigs) {
        orgConfigsObj[orgId] = {
          folders: config.folders,
          ...(config.logRetentionDays !== undefined ? { logRetentionDays: config.logRetentionDays } : {})
        };
      }

      await this.configService.saveModuleConfig('localfile', {
        folders: this.folders,
        logRetentionDays: this.logRetentionDays,
        orgConfigs: orgConfigsObj
      });
    } catch (error) {
      this.log.error("[LocalFile] 保存配置失败", { error: error.message });
      throw error;
    }
  }

  /**
   * 验证文件夹配置
   * @private
   * @param {any} folder
   * @returns {boolean}
   */
  _validateFolder(folder) {
    if (!folder || typeof folder !== "object") return false;
    if (typeof folder.path !== "string" || !folder.path) return false;

    // 确保有ID
    if (!folder.id) {
      folder.id = randomUUID();
    }

    // 规范化权限
    folder.read = Boolean(folder.read);
    folder.write = Boolean(folder.write);
    folder.description = String(folder.description ?? "");

    return true;
  }

  /**
   * 验证组织级文件夹配置（允许覆盖时省略 path）
   * @private
   * @param {any} folder
   * @returns {boolean}
   */
  _validateOrgFolder(folder) {
    if (!folder || typeof folder !== "object") return false;

    // 必须有 id
    if (!folder.id || typeof folder.id !== "string") return false;

    // 如果有 path，验证 path 是否为非空字符串，并解析为绝对路径
    if (folder.path !== undefined) {
      if (typeof folder.path !== "string" || !folder.path) return false;
      folder.path = path.resolve(folder.path);
    }

    // 规范化权限
    folder.read = Boolean(folder.read);
    folder.write = Boolean(folder.write);
    folder.description = String(folder.description ?? "");

    return true;
  }

  /**
   * 获取所有授权文件夹
   * @returns {Array<{id: string, path: string, read: boolean, write: boolean, description: string}>}
   */
  getFolders() {
    return this.folders.map(f => ({ ...f }));
  }

  /**
   * 根据ID获取文件夹
   * @param {string} folderId
   * @returns {{id: string, path: string, read: boolean, write: boolean, description: string}|null}
   */
  getFolder(folderId) {
    const folder = this.folders.find(f => f.id === folderId);
    return folder ? { ...folder } : null;
  }

  /**
   * 添加授权文件夹
   * @param {{path: string, read?: boolean, write?: boolean, description?: string}} folderConfig
   * @returns {{ok: boolean, folder?: object, error?: string}}
   */
  async addFolder(folderConfig) {
    try {
      if (!folderConfig.path || typeof folderConfig.path !== "string") {
        return { ok: false, error: "invalid_path" };
      }

      const normalizedPath = path.resolve(folderConfig.path);

      const exists = this.folders.some(f =>
        path.resolve(f.path) === normalizedPath
      );
      if (exists) {
        return { ok: false, error: "path_already_exists" };
      }

      try {
        await access(normalizedPath);
      } catch {
        return { ok: false, error: "path_not_accessible" };
      }

      const folder = {
        id: randomUUID(),
        path: normalizedPath,
        read: Boolean(folderConfig.read),
        write: Boolean(folderConfig.write),
        description: String(folderConfig.description ?? "")
      };

      this.folders.push(folder);
      await this._persist();

      this.log.info("[LocalFile] 添加授权文件夹", {
        folderId: folder.id,
        path: folder.path
      });

      return { ok: true, folder: { ...folder } };

    } catch (error) {
      this.log.error("[LocalFile] 添加文件夹失败", { error: error.message });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 更新授权文件夹
   * @param {string} folderId
   * @param {{read?: boolean, write?: boolean, description?: string}} updates
   * @returns {{ok: boolean, folder?: object, error?: string}}
   */
  async updateFolder(folderId, updates) {
    try {
      const folder = this.folders.find(f => f.id === folderId);
      if (!folder) {
        return { ok: false, error: "folder_not_found" };
      }

      if (updates.read !== undefined) {
        folder.read = Boolean(updates.read);
      }
      if (updates.write !== undefined) {
        folder.write = Boolean(updates.write);
      }
      if (updates.description !== undefined) {
        folder.description = String(updates.description);
      }

      await this._persist();

      this.log.info("[LocalFile] 更新授权文件夹", { folderId });

      return { ok: true, folder: { ...folder } };

    } catch (error) {
      this.log.error("[LocalFile] 更新文件夹失败", { error: error.message });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 删除授权文件夹
   * @param {string} folderId
   * @returns {{ok: boolean, error?: string}}
   */
  async removeFolder(folderId) {
    try {
      const index = this.folders.findIndex(f => f.id === folderId);
      if (index === -1) {
        return { ok: false, error: "folder_not_found" };
      }

      const folder = this.folders[index];
      this.folders.splice(index, 1);
      await this._persist();

      this.log.info("[LocalFile] 删除授权文件夹", {
        folderId,
        path: folder.path
      });

      return { ok: true };

    } catch (error) {
      this.log.error("[LocalFile] 删除文件夹失败", { error: error.message });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 获取日志保留天数
   * @returns {number}
   */
  getLogRetentionDays() {
    return this.logRetentionDays;
  }

  /**
   * 设置日志保留天数
   * @param {number} days
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async setLogRetentionDays(days) {
    try {
      const numDays = parseInt(days, 10);
      if (isNaN(numDays) || numDays < 1) {
        return { ok: false, error: "invalid_days" };
      }

      this.logRetentionDays = numDays;
      await this._persist();

      return { ok: true };
    } catch (error) {
      this.log.error("[LocalFile] 设置日志保留天数失败", { error: error.message });
      return { ok: false, error: "save_failed" };
    }
  }

  // =========================================================================
  // 组织级配置方法
  // =========================================================================

  /**
   * 获取指定组织的有效文件夹列表（继承 + 覆盖 + 新增）
   * @param {string|null|undefined} orgId - 组织ID，null/undefined/"" 返回全局
   * @returns {Array<{id: string, path: string, read: boolean, write: boolean, description: string, _source?: string}>}
   */
  getEffectiveFolders(orgId) {
    if (!orgId) {
      return this.getFolders().map(f => ({ ...f, _source: "global" }));
    }

    const orgConfig = this.orgConfigs.get(orgId);
    if (!orgConfig || !Array.isArray(orgConfig.folders) || orgConfig.folders.length === 0) {
      return this.getFolders().map(f => ({ ...f, _source: "global" }));
    }

    const orgFolders = orgConfig.folders;
    // 构建全局路径 → global folder 的映射（按 normalized path）
    const globalPathSet = new Set();
    for (const gf of this.folders) {
      globalPathSet.add(path.resolve(gf.path));
    }

    const orgPathSet = new Set();
    for (const of of orgFolders) {
      if (of.path) {
        orgPathSet.add(path.resolve(of.path));
      }
    }

    const result = [];

    // 第一遍：处理全局文件夹，按路径匹配覆盖
    for (const gf of this.folders) {
      const globalPath = path.resolve(gf.path);
      if (orgPathSet.has(globalPath)) {
        result.push({ ...gf, _source: "overridden" });
      } else {
        result.push({ ...gf, _source: "global" });
      }
    }

    // 第二遍：处理 org 文件夹（覆盖 + 新增）
    for (const of of orgFolders) {
      if (!of.path) continue;
      const orgPath = path.resolve(of.path);
      if (globalPathSet.has(orgPath)) {
        result.push({ ...of, _source: "org_override" });
      } else {
        result.push({ ...of, _source: "org" });
      }
    }

    return result;
  }

  /**
   * 获取指定组织的有效日志保留天数
   * @param {string|null|undefined} orgId
   * @returns {number}
   */
  getEffectiveLogRetentionDays(orgId) {
    if (!orgId) return this.logRetentionDays;
    const orgConfig = this.orgConfigs.get(orgId);
    if (orgConfig && typeof orgConfig.logRetentionDays === "number" && !isNaN(orgConfig.logRetentionDays)) {
      return orgConfig.logRetentionDays;
    }
    return this.logRetentionDays;
  }

  /**
   * 为组织添加文件夹
   * @param {string} orgId
   * @param {{path: string, read?: boolean, write?: boolean, description?: string}|null} folderConfig
   * @returns {{ok: boolean, folder?: object, error?: string}}
   */
  async addFolderToOrg(orgId, folderConfig) {
    try {
      if (!folderConfig || !folderConfig.path || typeof folderConfig.path !== "string") {
        return { ok: false, error: "invalid_path" };
      }

      const normalizedPath = path.resolve(folderConfig.path);

      // 获取或创建 org 配置
      let orgConfig = this.orgConfigs.get(orgId);
      if (!orgConfig) {
        orgConfig = { folders: [] };
        this.orgConfigs.set(orgId, orgConfig);
      }

      // 检查同 org 内是否已存在该路径
      const exists = orgConfig.folders.some(f =>
        path.resolve(f.path) === normalizedPath
      );
      if (exists) {
        return { ok: false, error: "path_already_exists" };
      }

      try {
        await access(normalizedPath);
      } catch {
        return { ok: false, error: "path_not_accessible" };
      }

      const folder = {
        id: randomUUID(),
        path: normalizedPath,
        read: Boolean(folderConfig.read),
        write: Boolean(folderConfig.write),
        description: String(folderConfig.description ?? "")
      };

      orgConfig.folders.push(folder);
      await this._persist();

      this.log.info("[LocalFile] 为组织添加授权文件夹", {
        orgId,
        folderId: folder.id,
        path: folder.path
      });

      return { ok: true, folder: { ...folder } };

    } catch (error) {
      this.log.error("[LocalFile] 为组织添加文件夹失败", {
        orgId,
        error: error.message,
        stack: error.stack
      });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 更新组织中的文件夹
   * @param {string} orgId
   * @param {string} folderId
   * @param {{read?: boolean, write?: boolean, description?: string}} updates
   * @returns {{ok: boolean, folder?: object, error?: string}}
   */
  async updateFolderInOrg(orgId, folderId, updates) {
    try {
      const orgConfig = this.orgConfigs.get(orgId);
      if (!orgConfig) {
        return { ok: false, error: "folder_not_found" };
      }

      const folder = orgConfig.folders.find(f => f.id === folderId);
      if (!folder) {
        return { ok: false, error: "folder_not_found" };
      }

      if (updates.read !== undefined) {
        folder.read = Boolean(updates.read);
      }
      if (updates.write !== undefined) {
        folder.write = Boolean(updates.write);
      }
      if (updates.description !== undefined) {
        folder.description = String(updates.description);
      }

      await this._persist();

      this.log.info("[LocalFile] 更新组织授权文件夹", { orgId, folderId });

      return { ok: true, folder: { ...folder } };

    } catch (error) {
      this.log.error("[LocalFile] 更新组织文件夹失败", {
        orgId,
        folderId,
        error: error.message,
        stack: error.stack
      });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 从组织中移除文件夹
   * @param {string} orgId
   * @param {string} folderId
   * @returns {{ok: boolean, error?: string}}
   */
  async removeFolderFromOrg(orgId, folderId) {
    try {
      const orgConfig = this.orgConfigs.get(orgId);
      if (!orgConfig) {
        return { ok: false, error: "folder_not_found" };
      }

      const index = orgConfig.folders.findIndex(f => f.id === folderId);
      if (index === -1) {
        return { ok: false, error: "folder_not_found" };
      }

      orgConfig.folders.splice(index, 1);
      await this._persist();

      this.log.info("[LocalFile] 从组织移除授权文件夹", { orgId, folderId });

      return { ok: true };

    } catch (error) {
      this.log.error("[LocalFile] 从组织移除文件夹失败", {
        orgId,
        folderId,
        error: error.message,
        stack: error.stack
      });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 设置组织的日志保留天数
   * @param {string} orgId
   * @param {number} days
   * @returns {{ok: boolean, error?: string}}
   */
  async setLogRetentionDaysForOrg(orgId, days) {
    try {
      const numDays = parseInt(days, 10);
      if (isNaN(numDays) || numDays < 1) {
        return { ok: false, error: "invalid_days" };
      }

      let orgConfig = this.orgConfigs.get(orgId);
      if (!orgConfig) {
        orgConfig = { folders: [] };
        this.orgConfigs.set(orgId, orgConfig);
      }

      orgConfig.logRetentionDays = numDays;
      await this._persist();

      this.log.info("[LocalFile] 设置组织日志保留天数", { orgId, days: numDays });

      return { ok: true };

    } catch (error) {
      this.log.error("[LocalFile] 设置组织日志保留天数失败", {
        orgId,
        error: error.message,
        stack: error.stack
      });
      return { ok: false, error: "save_failed" };
    }
  }

  /**
   * 获取所有组织配置（快照副本）
   * @returns {Array<{orgId: string, config: object}>}
   */
  getAllOrgConfigs() {
    const result = [];
    for (const [orgId, config] of this.orgConfigs) {
      result.push({
        orgId,
        config: {
          folders: config.folders.map(f => ({ ...f })),
          ...(config.logRetentionDays !== undefined ? { logRetentionDays: config.logRetentionDays } : {})
        }
      });
    }
    return result;
  }

  /**
   * 移除组织的全部配置（惰性清理）
   * @param {string} orgId
   * @returns {{ok: boolean, error?: string}}
   */
  async removeOrgConfig(orgId) {
    try {
      if (this.orgConfigs.has(orgId)) {
        this.orgConfigs.delete(orgId);
        await this._persist();
        this.log.info("[LocalFile] 移除组织配置", { orgId });
      }
      return { ok: true };

    } catch (error) {
      this.log.error("[LocalFile] 移除组织配置失败", {
        orgId,
        error: error.message,
        stack: error.stack
      });
      return { ok: false, error: "save_failed" };
    }
  }
}

export default ConfigManager;
