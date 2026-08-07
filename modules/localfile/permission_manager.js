/**
 * 权限管理器
 * 
 * 职责：
 * - 检查文件访问权限
 * - 验证路径是否在授权范围内
 * - 解析相对路径
 * - 防止路径遍历攻击
 */

import path from "node:path";
import { access, constants } from "node:fs/promises";

/**
 * 权限管理器类
 */
export class PermissionManager {
  /**
   * @param {{configManager: ConfigManager, log: any}} options
   */
  constructor(options) {
    this.configManager = options.configManager;
    this.log = options.log;
  }

  /**
   * 检查文件读取权限（最长路径优先）
   * @param {string} filePath - 文件路径
   * @param {string|null} [orgId] - 组织ID，null 使用全局
   * @returns {{allowed: boolean, folder?: object, error?: string}}
   */
  async checkReadPermission(filePath, orgId = null) {
    try {
      const normalizedPath = this._normalizePath(filePath);
      if (!normalizedPath) {
        return { allowed: false, error: "invalid_path" };
      }

      const folders = this.configManager.getEffectiveFolders(orgId);
      const bestMatch = this._findBestMatch(normalizedPath, folders);
      if (!bestMatch) {
        return { allowed: false, error: "access_denied" };
      }

      if (bestMatch.read) {
        return { allowed: true, folder: bestMatch };
      }
      return { allowed: false, error: "access_denied" };

    } catch (error) {
      this.log.error("[LocalFile] 检查读取权限失败", {
        path: filePath,
        error: error.message
      });
      return { allowed: false, error: "check_failed" };
    }
  }

  /**
   * 检查文件写入权限（最长路径优先）
   * @param {string} filePath - 文件路径
   * @param {string|null} [orgId] - 组织ID，null 使用全局
   * @returns {{allowed: boolean, folder?: object, error?: string}}
   */
  async checkWritePermission(filePath, orgId = null) {
    try {
      const normalizedPath = this._normalizePath(filePath);
      if (!normalizedPath) {
        return { allowed: false, error: "invalid_path" };
      }

      const folders = this.configManager.getEffectiveFolders(orgId);
      const bestMatch = this._findBestMatch(normalizedPath, folders);
      if (!bestMatch) {
        return { allowed: false, error: "access_denied" };
      }

      if (bestMatch.write) {
        return { allowed: true, folder: bestMatch };
      }
      return { allowed: false, error: "access_denied" };

    } catch (error) {
      this.log.error("[LocalFile] 检查写入权限失败", {
        path: filePath,
        error: error.message
      });
      return { allowed: false, error: "check_failed" };
    }
  }

  /**
   * 检查目录列出权限
   * @param {string} dirPath - 目录路径
   * @param {string|null} [orgId] - 组织ID，null 使用全局
   * @returns {{allowed: boolean, folder?: object, error?: string}}
   */
  async checkListPermission(dirPath, orgId = null) {
    // 列目录使用读取权限
    return this.checkReadPermission(dirPath, orgId);
  }

  /**
   * 获取文件的详细权限信息（最长路径优先）
   * @param {string} filePath - 文件路径
   * @param {string|null} [orgId] - 组织ID，null 使用全局
   * @returns {{canRead: boolean, canWrite: boolean, folder?: object}}
   */
  async getPermissionInfo(filePath, orgId = null) {
    const normalizedPath = this._normalizePath(filePath);
    if (!normalizedPath) {
      return { canRead: false, canWrite: false };
    }

    const folders = this.configManager.getEffectiveFolders(orgId);
    const bestMatch = this._findBestMatch(normalizedPath, folders);

    if (!bestMatch) {
      return { canRead: false, canWrite: false };
    }

    return {
      canRead: Boolean(bestMatch.read),
      canWrite: Boolean(bestMatch.write),
      folder: bestMatch
    };
  }

  /**
   * 规范化路径
   * @private
   * @param {string} filePath
   * @returns {string|null}
   */
  _normalizePath(filePath) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }

    try {
      // 解析为绝对路径
      let resolved = path.resolve(filePath);
      
      // 检查路径遍历攻击
      // 虽然 path.resolve 已经处理了 .. 和 .，但我们还是做额外检查
      const normalized = path.normalize(resolved);
      
      return normalized;
    } catch (error) {
      this.log.error("[LocalFile] 路径规范化失败", { 
        path: filePath, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * 检查子路径是否在父路径内
   * @private
   * @param {string} childPath - 子路径
   * @param {string} parentPath - 父路径
   * @returns {boolean}
   */
  _isPathWithin(childPath, parentPath) {
    // 确保路径以分隔符结尾，避免前缀匹配问题
    const normalizedChild = childPath.endsWith(path.sep)
      ? childPath
      : childPath + path.sep;
    const normalizedParent = parentPath.endsWith(path.sep)
      ? parentPath
      : parentPath + path.sep;

    return normalizedChild.startsWith(normalizedParent) || childPath === parentPath;
  }

  /**
   * 在所有匹配的文件夹中按最长路径优先选择最佳匹配
   * 同路径长度时按 _source 优先级：org_override > org > overridden > global
   * @private
   * @param {string} targetPath - 已规范化的目标路径
   * @param {Array<object>} folders - 有效文件夹列表
   * @returns {object|null}
   */
  _findBestMatch(targetPath, folders) {
    const _SOURCE_PRIORITY = { org_override: 4, org: 3, overridden: 2, global: 1 };

    let bestMatch = null;
    let bestLen = -1;
    let bestPriority = -1;

    for (const folder of folders) {
      const folderPath = path.resolve(folder.path);
      if (!this._isPathWithin(targetPath, folderPath)) continue;

      const folderLen = folderPath.length;
      const priority = _SOURCE_PRIORITY[folder._source] ?? 0;

      // 更长路径优先；同长度时更高优先级胜出
      if (folderLen > bestLen || (folderLen === bestLen && priority > bestPriority)) {
        bestMatch = folder;
        bestLen = folderLen;
        bestPriority = priority;
      }
    }

    return bestMatch;
  }

  /**
   * 获取文件相对于授权文件夹的路径
   * @param {string} filePath - 文件路径
   * @param {string} folderId - 授权文件夹ID
   * @returns {string|null}
   */
  getRelativePath(filePath, folderId) {
    const folder = this.configManager.getFolder(folderId);
    if (!folder) return null;

    const normalizedPath = this._normalizePath(filePath);
    const folderPath = path.resolve(folder.path);

    if (!this._isPathWithin(normalizedPath, folderPath)) {
      return null;
    }

    return path.relative(folderPath, normalizedPath);
  }

  /**
   * 获取所有授权文件夹的汇总信息
   * @param {string|null} [orgId] - 组织ID，null 使用全局
   * @returns {Array<{id: string, path: string, read: boolean, write: boolean}>}
   */
  getAuthorizedFolders(orgId = null) {
    return this.configManager.getEffectiveFolders(orgId);
  }

  /**
   * 检查路径是否存在且可访问
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async pathExists(filePath) {
    try {
      const normalizedPath = this._normalizePath(filePath);
      if (!normalizedPath) return false;
      
      await access(normalizedPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查路径是否是目录
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async isDirectory(filePath) {
    try {
      const { statSync } = await import("node:fs");
      const normalizedPath = this._normalizePath(filePath);
      if (!normalizedPath) return false;
      
      const stats = statSync(normalizedPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}

export default PermissionManager;
