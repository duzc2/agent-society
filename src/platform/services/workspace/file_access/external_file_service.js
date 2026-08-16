/**
 * 工作区文件访问 — 外部路径文件服务
 *
 * 职责：
 * - 在统一路径解析器确认目标为 external 后，执行实际的外部文件操作
 * - 所有读写/列目录/建目录均先经过权限管理器
 * - 记录完整审计日志，失败时保留业务上下文与异常堆栈
 * - 跨 scope 复制/移动由 WorkspaceFileAccessService 统一处理
 */

import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  rename
} from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 外部路径文件服务类
 */
export class ExternalFileService {
  /**
   * @param {{permissionManager: any, accessLogger: any, runtime: any, log: any}} options
   */
  constructor(options) {
    this.permissionManager = options.permissionManager;
    this.accessLogger = options.accessLogger;
    this.runtime = options.runtime;
    this.log = options.log;
  }

  /**
   * 读取外部文件
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {object} [options]
   * @returns {Promise<{ok: boolean, content?: string, path?: string, size?: number, error?: string, message?: string}>}
   */
  async readFile(ctx, filePath, options = {}) {
    const operation = "readFile";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkReadPermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logRead(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限读取此文件" };
      }

      if (!existsSync(filePath)) {
        await this.accessLogger.logRead(ctx, filePath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "文件不存在" };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        await this.accessLogger.logRead(ctx, filePath, false, "is_directory");
        return { ok: false, error: "is_directory", message: "路径是目录，不是文件" };
      }

      const content = await readFile(filePath, options.encoding ?? "utf8");

      await this.accessLogger.logRead(ctx, filePath, true);

      return {
        ok: true,
        content,
        path: filePath,
        size: stats.size
      };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logRead(ctx, filePath, false, error.message);
      return { ok: false, error: "read_failed", message: error.message };
    }
  }

  /**
   * 按行读取外部文件
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {object} [options] - { start_line?, end_line? }
   * @returns {Promise<{ok: boolean, lines?: string[], start_line?: number, end_line?: number, total_lines?: number, error?: string, message?: string}>}
   */
  async readLines(ctx, filePath, options = {}) {
    const operation = "readLines";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkReadPermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logRead(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限读取此文件" };
      }

      if (!existsSync(filePath)) {
        await this.accessLogger.logRead(ctx, filePath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "文件不存在" };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        await this.accessLogger.logRead(ctx, filePath, false, "is_directory");
        return { ok: false, error: "is_directory", message: "路径是目录，不是文件" };
      }

      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;
      const startLine = Math.max(1, options.start_line || 1);
      const endLine = Math.min(totalLines, options.end_line || 500);

      await this.accessLogger.logRead(ctx, filePath, true);

      if (startLine > totalLines) {
        return { ok: true, lines: [], start_line: startLine, end_line: 0, total_lines: totalLines };
      }

      return {
        ok: true,
        lines: lines.slice(startLine - 1, endLine),
        start_line: startLine,
        end_line: Math.min(endLine, totalLines),
        total_lines: totalLines
      };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logRead(ctx, filePath, false, error.message);
      return { ok: false, error: "read_failed", message: error.message };
    }
  }

  /**
   * 在单个外部文件内搜索字符串或正则表达式
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {string} pattern - 搜索文本或正则表达式
   * @param {object} [options] - { is_regex?, max_results? }
   * @returns {Promise<{ok: boolean, matches?: Array<{line: number, col: number, text: string}>, count?: number, pattern?: string, error?: string, message?: string}>}
   */
  async searchInFile(ctx, filePath, pattern, options = {}) {
    const operation = "searchInFile";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkReadPermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logRead(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限搜索此文件" };
      }

      if (!existsSync(filePath)) {
        await this.accessLogger.logRead(ctx, filePath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "文件不存在" };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        await this.accessLogger.logRead(ctx, filePath, false, "is_directory");
        return { ok: false, error: "is_directory", message: "路径是目录，不是文件" };
      }

      const { is_regex = false, max_results = 100 } = options;
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const matches = [];

      let searchRegex;
      if (is_regex) {
        searchRegex = new RegExp(pattern, "g");
      }

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        if (matches.length >= max_results) break;

        const line = lines[lineNum];
        if (is_regex) {
          searchRegex.lastIndex = 0;
          let m;
          while ((m = searchRegex.exec(line)) !== null) {
            if (matches.length >= max_results) break;
            matches.push({ line: lineNum + 1, col: m.index + 1, text: line });
            if (m[0].length === 0) searchRegex.lastIndex++;
          }
        } else {
          let index = line.indexOf(pattern);
          while (index !== -1) {
            if (matches.length >= max_results) break;
            matches.push({ line: lineNum + 1, col: index + 1, text: line });
            index = line.indexOf(pattern, index + 1);
          }
        }
      }

      await this.accessLogger.logRead(ctx, filePath, true);

      return { ok: true, matches, count: matches.length, pattern };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logRead(ctx, filePath, false, error.message);
      return { ok: false, error: "search_failed", message: error.message };
    }
  }

  /**
   * 获取外部文件总行数
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @returns {Promise<{ok: boolean, path?: string, lines?: number, error?: string, message?: string}>}
   */
  async getLineCount(ctx, filePath) {
    const operation = "getLineCount";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkReadPermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logRead(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限读取此文件" };
      }

      if (!existsSync(filePath)) {
        await this.accessLogger.logRead(ctx, filePath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "文件不存在" };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        await this.accessLogger.logRead(ctx, filePath, false, "is_directory");
        return { ok: false, error: "is_directory", message: "路径是目录，不是文件" };
      }

      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/).length;

      await this.accessLogger.logRead(ctx, filePath, true);

      return { ok: true, path: filePath, lines };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logRead(ctx, filePath, false, error.message);
      return { ok: false, error: "line_count_failed", message: error.message };
    }
  }

  /**
   * 递归搜索外部目录中的文本
   * @param {object} ctx - 智能体上下文
   * @param {string} dirPath - 已规范化的外部绝对路径
   * @param {string} text - 要搜索的文本
   * @param {object} [options] - { caseSensitive?, maxResults? }
   * @returns {Promise<{ok: boolean, results?: Array<{file: string, line: number, col: number}>, error?: string, message?: string}>}
   */
  async searchText(ctx, dirPath, text, options = {}) {
    const operation = "searchText";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkReadPermission(dirPath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logRead(ctx, dirPath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限搜索此目录" };
      }

      if (!existsSync(dirPath)) {
        await this.accessLogger.logRead(ctx, dirPath, false, "directory_not_found");
        return { ok: false, error: "directory_not_found", message: "目录不存在" };
      }

      const stats = statSync(dirPath);
      if (stats.isFile()) {
        const fileResult = await this.searchInFile(ctx, dirPath, text, {
          is_regex: false,
          max_results: options.maxResults ?? 1000
        });
        if (!fileResult.ok) return fileResult;

        const results = fileResult.matches.map(match => ({
          file: path.relative(dirPath, dirPath) || path.basename(dirPath),
          line: match.line,
          col: match.col
        }));
        return { ok: true, results };
      }

      if (!stats.isDirectory()) {
        await this.accessLogger.logRead(ctx, dirPath, false, "not_a_directory");
        return { ok: false, error: "not_a_directory", message: "路径不是目录" };
      }

      const { caseSensitive = true, maxResults = 1000 } = options;
      const results = [];
      const searchText = caseSensitive ? text : text.toLowerCase();

      const searchFile = async (fullPath, relPath) => {
        if (results.length >= maxResults) return;
        const content = await readFile(fullPath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          if (results.length >= maxResults) break;
          const line = lines[lineNum];
          const haystack = caseSensitive ? line : line.toLowerCase();
          let index = haystack.indexOf(searchText);
          while (index !== -1) {
            results.push({ file: relPath, line: lineNum + 1, col: index + 1 });
            index = haystack.indexOf(searchText, index + 1);
            if (results.length >= maxResults) break;
          }
        }
      };

      const walk = async (dir, baseRelPath) => {
        if (results.length >= maxResults) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) return;
          const fullPath = path.join(dir, entry.name);
          const relPath = baseRelPath ? `${baseRelPath}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            if (entry.name === ".io" || entry.name === ".versions" || entry.name === ".meta") continue;
            await walk(fullPath, relPath);
          } else if (entry.isFile()) {
            try {
              await searchFile(fullPath, relPath);
            } catch (error) {
              this.log.warn("[WorkspaceFileAccess] 搜索外部文件失败", {
                path: fullPath,
                error: error.message,
                stack: error.stack
              });
            }
          }
        }
      };

      await walk(dirPath, "");
      await this.accessLogger.logRead(ctx, dirPath, true);

      return { ok: true, results };
    } catch (error) {
      this._logError(ctx, operation, dirPath, error);
      await this.accessLogger.logRead(ctx, dirPath, false, error.message);
      return { ok: false, error: "search_failed", message: error.message };
    }
  }

  /**
   * 写入外部文件
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {string|Buffer} content - 文件内容
   * @param {object} [options] - { encoding?, mimeType? }
   * @returns {Promise<{ok: boolean, path?: string, size?: number, isNew?: boolean, error?: string, message?: string}>}
   */
  async writeFile(ctx, filePath, content, options = {}) {
    const operation = "writeFile";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkWritePermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logWrite(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限写入此文件" };
      }

      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        const dirPermission = await this.permissionManager.checkWritePermission(dir, orgId);
        if (!dirPermission.allowed) {
          await this.accessLogger.logWrite(ctx, filePath, false, "cannot_create_dir");
          return { ok: false, error: "cannot_create_dir", message: "无法创建目录，超出授权范围" };
        }
        await mkdir(dir, { recursive: true });
      }

      const isNew = !existsSync(filePath);
      const encoding = options.encoding ?? "utf8";
      await writeFile(filePath, content, encoding);
      const size = Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(content, encoding);

      await this.accessLogger.logWrite(ctx, filePath, true, null, {
        isNew,
        size,
        mimeType: options.mimeType ?? null
      });

      return {
        ok: true,
        path: filePath,
        size,
        isNew,
        mimeType: options.mimeType ?? null
      };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logWrite(ctx, filePath, false, error.message);
      return { ok: false, error: "write_failed", message: error.message };
    }
  }

  /**
   * 向外部文件追加内容
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {string|Buffer} content - 要追加的内容
   * @param {object} [options] - { encoding?, mimeType? }
   * @returns {Promise<{ok: boolean, path?: string, size?: number, error?: string, message?: string}>}
   */
  async appendFile(ctx, filePath, content, options = {}) {
    const operation = "appendFile";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkWritePermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logWrite(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限写入此文件" };
      }

      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        const dirPermission = await this.permissionManager.checkWritePermission(dir, orgId);
        if (!dirPermission.allowed) {
          await this.accessLogger.logWrite(ctx, filePath, false, "cannot_create_dir");
          return { ok: false, error: "cannot_create_dir", message: "无法创建目录，超出授权范围" };
        }
        await mkdir(dir, { recursive: true });
      }

      const encoding = options.encoding ?? "utf8";
      const newBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, encoding);
      let combined = newBuffer;
      if (existsSync(filePath)) {
        const existing = await readFile(filePath);
        combined = Buffer.concat([existing, newBuffer]);
      }

      await writeFile(filePath, combined);
      const size = combined.length;

      await this.accessLogger.logWrite(ctx, filePath, true, null, {
        size,
        mimeType: options.mimeType ?? null
      });

      return {
        ok: true,
        path: filePath,
        size,
        mimeType: options.mimeType ?? null
      };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logWrite(ctx, filePath, false, error.message);
      return { ok: false, error: "append_failed", message: error.message };
    }
  }

  /**
   * 列出外部目录
   * @param {object} ctx - 智能体上下文
   * @param {string} dirPath - 已规范化的外部绝对路径
   * @returns {Promise<{ok: boolean, entries?: Array<object>, path?: string, error?: string, message?: string}>}
   */
  async listDirectory(ctx, dirPath) {
    const operation = "listDirectory";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkListPermission(dirPath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logList(ctx, dirPath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限访问此目录" };
      }

      if (!existsSync(dirPath)) {
        await this.accessLogger.logList(ctx, dirPath, false, "directory_not_found");
        return { ok: false, error: "directory_not_found", message: "目录不存在" };
      }

      const stats = statSync(dirPath);
      if (!stats.isDirectory()) {
        await this.accessLogger.logList(ctx, dirPath, false, "is_file");
        return { ok: false, error: "is_file", message: "路径是文件，不是目录" };
      }

      const entries = await readdir(dirPath, { withFileTypes: true });
      const formattedEntries = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        path: path.join(dirPath, entry.name)
      }));

      await this.accessLogger.logList(ctx, dirPath, true);

      return {
        ok: true,
        entries: formattedEntries,
        path: dirPath
      };
    } catch (error) {
      this._logError(ctx, operation, dirPath, error);
      await this.accessLogger.logList(ctx, dirPath, false, error.message);
      return { ok: false, error: "list_failed", message: error.message };
    }
  }

  /**
   * 创建外部目录
   * @param {object} ctx - 智能体上下文
   * @param {string} dirPath - 已规范化的外部绝对路径
   * @param {object} [options] - { recursive? }
   * @returns {Promise<{ok: boolean, path?: string, error?: string, message?: string}>}
   */
  async createDirectory(ctx, dirPath, options = {}) {
    const operation = "createDirectory";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkWritePermission(dirPath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logCreateDir(ctx, dirPath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限在此位置创建目录" };
      }

      if (existsSync(dirPath)) {
        const stats = statSync(dirPath);
        if (stats.isDirectory()) {
          await this.accessLogger.logCreateDir(ctx, dirPath, false, "already_exists");
          return { ok: false, error: "already_exists", message: "目录已存在" };
        }
        await this.accessLogger.logCreateDir(ctx, dirPath, false, "path_is_file");
        return { ok: false, error: "path_is_file", message: "同路径的文件已存在" };
      }

      const recursive = options.recursive !== false;
      await mkdir(dirPath, { recursive });

      await this.accessLogger.logCreateDir(ctx, dirPath, true);

      return { ok: true, path: dirPath };
    } catch (error) {
      this._logError(ctx, operation, dirPath, error);
      await this.accessLogger.logCreateDir(ctx, dirPath, false, error.message);
      return { ok: false, error: "create_failed", message: error.message };
    }
  }

  /**
   * 删除外部文件
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @returns {Promise<{ok: boolean, path?: string, error?: string, message?: string}>}
   */
  async deleteFile(ctx, filePath) {
    const operation = "deleteFile";
    try {
      const orgId = this._getOrgId(ctx);
      const permission = await this.permissionManager.checkWritePermission(filePath, orgId);
      if (!permission.allowed) {
        await this.accessLogger.logWrite(ctx, filePath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限删除此文件" };
      }

      if (!existsSync(filePath)) {
        await this.accessLogger.logWrite(ctx, filePath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "文件不存在" };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        await this.accessLogger.logWrite(ctx, filePath, false, "is_directory");
        return { ok: false, error: "is_directory", message: "路径是目录，请使用删除目录能力" };
      }

      await unlink(filePath);
      await this.accessLogger.logWrite(ctx, filePath, true, null, { action: "delete" });

      return { ok: true, path: filePath };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      await this.accessLogger.logWrite(ctx, filePath, false, error.message);
      return { ok: false, error: "delete_failed", message: error.message };
    }
  }

  /**
   * 移动/重命名外部文件（仅同 scope 内移动）
   * @param {object} ctx - 智能体上下文
   * @param {string} fromPath - 已规范化的外部源绝对路径
   * @param {string} toPath - 已规范化的外部目标绝对路径
   * @param {object} [options] - { overwrite? }
   * @returns {Promise<{ok: boolean, from?: string, to?: string, error?: string, message?: string}>}
   */
  async moveFile(ctx, fromPath, toPath, options = {}) {
    const operation = "moveFile";
    try {
      const orgId = this._getOrgId(ctx);
      const fromPermission = await this.permissionManager.checkWritePermission(fromPath, orgId);
      if (!fromPermission.allowed) {
        await this.accessLogger.logWrite(ctx, fromPath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限移动源文件" };
      }

      const toPermission = await this.permissionManager.checkWritePermission(toPath, orgId);
      if (!toPermission.allowed) {
        await this.accessLogger.logWrite(ctx, toPath, false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限写入目标位置" };
      }

      if (!existsSync(fromPath)) {
        await this.accessLogger.logWrite(ctx, fromPath, false, "file_not_found");
        return { ok: false, error: "file_not_found", message: "源文件不存在" };
      }

      const fromStats = statSync(fromPath);
      if (!fromStats.isFile()) {
        await this.accessLogger.logWrite(ctx, fromPath, false, "not_a_file");
        return { ok: false, error: "not_a_file", message: "源路径不是文件" };
      }

      if (existsSync(toPath)) {
        const toStats = statSync(toPath);
        if (toStats.isDirectory()) {
          await this.accessLogger.logWrite(ctx, toPath, false, "target_is_directory");
          return { ok: false, error: "target_is_directory", message: "目标路径是目录" };
        }
        if (!options.overwrite) {
          await this.accessLogger.logWrite(ctx, toPath, false, "target_exists");
          return { ok: false, error: "target_exists", message: "目标文件已存在" };
        }
      }

      const targetDir = path.dirname(toPath);
      if (!existsSync(targetDir)) {
        const dirPermission = await this.permissionManager.checkWritePermission(targetDir, orgId);
        if (!dirPermission.allowed) {
          await this.accessLogger.logWrite(ctx, toPath, false, "cannot_create_dir");
          return { ok: false, error: "cannot_create_dir", message: "无法创建目标目录，超出授权范围" };
        }
        await mkdir(targetDir, { recursive: true });
      }

      await rename(fromPath, toPath);
      await this.accessLogger.logWrite(ctx, toPath, true, null, {
        action: "move",
        source: fromPath
      });

      return { ok: true, from: fromPath, to: toPath };
    } catch (error) {
      this._logError(ctx, operation, `${fromPath} -> ${toPath}`, error);
      await this.accessLogger.logWrite(ctx, toPath, false, error.message);
      return { ok: false, error: "move_failed", message: error.message };
    }
  }

  /**
   * 在外部文件中精确替换文本（供 edit_file 使用）
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @param {object} options - { old_string, new_string, replace_all?, mimeType? }
   * @returns {Promise<{ok: boolean, path?: string, occurrences?: number, error?: string, message?: string}>}
   */
  async editFile(ctx, filePath, options = {}) {
    const operation = "editFile";
    try {
      const readResult = await this.readFile(ctx, filePath);
      if (!readResult.ok) return readResult;

      const { old_string, new_string, replace_all = false } = options;
      if (old_string === undefined || old_string === null) {
        return { ok: false, error: "editFile_missing_old_string", message: "缺少要替换的原始文本" };
      }

      const content = readResult.content;
      let newContent;
      let count;

      if (replace_all) {
        count = content.split(old_string).length - 1;
        if (count === 0) {
          return { ok: false, error: "old_string_not_found", message: "未找到要替换的文本" };
        }
        newContent = content.replaceAll(old_string, new_string);
      } else {
        const index = content.indexOf(old_string);
        if (index === -1) {
          return { ok: false, error: "old_string_not_found", message: "未找到要替换的文本" };
        }
        const secondIndex = content.indexOf(old_string, index + old_string.length);
        if (secondIndex !== -1) {
          return { ok: false, error: "multiple_matches", message: "匹配到多处，请提供更精确的 old_string" };
        }
        newContent = content.slice(0, index) + new_string + content.slice(index + old_string.length);
        count = 1;
      }

      const writeResult = await this.writeFile(ctx, filePath, newContent, { mimeType: options.mimeType });
      if (!writeResult.ok) return writeResult;

      return { ok: true, path: filePath, occurrences: count };
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      return { ok: false, error: "edit_failed", message: error.message };
    }
  }

  /**
   * 检查外部路径权限
   * @param {object} ctx - 智能体上下文
   * @param {string} filePath - 已规范化的外部绝对路径
   * @returns {Promise<{ok: boolean, canRead?: boolean, canWrite?: boolean, folder?: object, exists?: boolean, error?: string, message?: string}>}
   */
  async checkPermission(ctx, filePath) {
    const operation = "checkPermission";
    try {
      const orgId = this._getOrgId(ctx);
      const info = await this.permissionManager.getPermissionInfo(filePath, orgId);

      await this.accessLogger.logCheckPermission(ctx, filePath, info.canRead, info.canWrite);

      const result = {
        ok: true,
        canRead: info.canRead,
        canWrite: info.canWrite,
        folder: info.folder
      };

      // 只有在调用方至少拥有读或写权限时才允许探测文件是否存在，
      // 避免通过 file_check_permission 枚举无权限路径的存在性。
      if (info.canRead || info.canWrite) {
        result.exists = existsSync(filePath);
      }

      return result;
    } catch (error) {
      this._logError(ctx, operation, filePath, error);
      return {
        ok: false,
        error: "check_failed",
        message: error.message,
        canRead: false,
        canWrite: false
      };
    }
  }

  /**
   * 获取授权文件夹列表
   * @param {object} ctx - 智能体上下文
   * @returns {Array<object>}
   */
  getAuthorizedFolders(ctx) {
    const orgId = this._getOrgId(ctx);
    return this.permissionManager.getAuthorizedFolders(orgId);
  }

  /**
   * 从上下文获取组织 ID
   * @private
   * @param {object} ctx
   * @returns {string|null}
   */
  _getOrgId(ctx) {
    const agentId = ctx.agent.id;
    return this.runtime.findWorkspaceIdForAgent(agentId);
  }

  /**
   * 记录完整异常日志
   * @private
   * @param {object} ctx
   * @param {string} operation
   * @param {string} targetPath
   * @param {Error} error
   */
  _logError(ctx, operation, targetPath, error) {
    this.log.error("[WorkspaceFileAccess] 外部文件操作失败", {
      agentId: ctx?.agent?.id ?? "unknown",
      operation,
      path: targetPath,
      message: error?.message ?? String(error),
      stack: error?.stack ?? "no_stack"
    });
  }
}

export default ExternalFileService;
