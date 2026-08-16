/**
 * 工作区文件访问 — 门面服务
 *
 * 职责：
 * - 为 FileTools、HTTP 路由、document 模块提供统一文件访问入口
 * - 通过 PathResolver 判定 workspace / external
 * - workspace 路径复用 Workspace 方法；external 路径委托 ExternalFileService
 * - 对外部路径执行权限检查、审计日志
 */

import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { registry } from "../../../core/module_registry.js";
import { PathResolver } from "./path_resolver.js";
import { ExternalConfigManager } from "./external_config_manager.js";
import { ExternalPermissionManager } from "./external_permission_manager.js";
import { ExternalAccessLogger } from "./external_access_logger.js";
import { ExternalFileService } from "./external_file_service.js";
import { BigfileService } from "./bigfile_service.js";

export class WorkspaceFileAccessService {
  /**
   * @param {object} options
   */
  constructor(options) {
    this.pathResolver = options.pathResolver;
    this.externalConfigManager = options.externalConfigManager;
    this.externalPermissionManager = options.externalPermissionManager;
    this.externalAccessLogger = options.externalAccessLogger;
    this.externalFileService = options.externalFileService;
    this.bigfileService = options.bigfileService;
    this.log = options.log;
  }

  /**
   * 解析路径，返回统一路径对象
   * @param {object} ctx
   * @param {string} rawPath
   * @param {{operation?: string}} [options]
   */
  async resolvePath(ctx, rawPath, options = {}) {
    return this.pathResolver.resolvePath(ctx, rawPath, options);
  }

  async readLines(ctx, rawPath, options = {}) {
    return this.bigfileService.readLines(ctx, {
      path: rawPath,
      start_line: options.start_line ?? 1,
      end_line: options.end_line ?? 500
    });
  }

  async searchInFile(ctx, rawPath, pattern, options = {}) {
    return this.bigfileService.search(ctx, {
      path: rawPath,
      pattern,
      is_regex: Boolean(options.is_regex),
      max_results: options.max_results ?? 100,
      context_lines: options.context_lines ?? 0
    });
  }

  async getLineCount(ctx, rawPath) {
    return this.bigfileService.getLineCount(ctx, { path: rawPath });
  }

  async read(ctx, rawPath, options = {}) {
    return this.bigfileService.read(ctx, {
      path: rawPath,
      offset: options.offset ?? 0,
      length: options.length ?? 500
    });
  }

  async getInfo(ctx, rawPath) {
    return this.bigfileService.getInfo(ctx, { path: rawPath });
  }

  async stats(ctx, rawPath, rules, options = {}) {
    return this.bigfileService.stats(ctx, {
      path: rawPath,
      rules,
      line_range: options.line_range
    });
  }

  async jsonTree(ctx, rawPath, options = {}) {
    return this.bigfileService.jsonTree(ctx, {
      path: rawPath,
      path_expr: options.path_expr ?? "",
      max_depth: options.max_depth ?? 2
    });
  }

  async jsonKeys(ctx, rawPath, options = {}) {
    return this.bigfileService.jsonKeys(ctx, {
      path: rawPath,
      path_expr: options.path_expr ?? ""
    });
  }

  async jsonlFilter(ctx, rawPath, field, pattern, options = {}) {
    return this.bigfileService.jsonlFilter(ctx, {
      path: rawPath,
      field,
      pattern,
      is_regex: Boolean(options.is_regex),
      max_results: options.max_results,
      max_chars_per_record: options.max_chars_per_record
    });
  }

  async writeFile(ctx, rawPath, content, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "write");
    const ioError = this._workspaceIOError(resolved);
    if (ioError) return ioError;

    if (resolved.scope === "workspace") {
      const result = await resolved.workspace.writeFile(resolved.relativePath, content, {
        operator: options.operator,
        messageId: options.messageId,
        mimeType: options.mimeType
      });

      return {
        ok: true,
        path: result.path ?? resolved.relativePath,
        size: result.size,
        mimeType: result.mimeType,
        versionId: result.versionId
      };
    }

    return this.externalFileService.writeFile(ctx, resolved.absolutePath, content, {
      mimeType: options.mimeType
    });
  }

  async appendFile(ctx, rawPath, content, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "write");
    const ioError = this._workspaceIOError(resolved);
    if (ioError) return ioError;

    if (resolved.scope === "workspace") {
      const result = await resolved.workspace.appendFile(resolved.relativePath, content, {
        operator: options.operator,
        messageId: options.messageId,
        mimeType: options.mimeType
      });

      return {
        ok: true,
        path: result.path ?? resolved.relativePath,
        size: result.size,
        mimeType: result.mimeType,
        versionId: result.versionId
      };
    }

    return this.externalFileService.appendFile(ctx, resolved.absolutePath, content, {
      mimeType: options.mimeType
    });
  }

  async listFiles(ctx, rawPath = ".") {
    const resolved = await this._resolve(ctx, rawPath, "read");
    if (resolved.scope === "workspace") {
      return resolved.workspace.listFiles(resolved.relativePath);
    }

    const result = await this.externalFileService.listDirectory(ctx, resolved.absolutePath);
    return result.ok ? result.entries : result;
  }

  async editFile(ctx, rawPath, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "write");
    const ioError = this._workspaceIOError(resolved);
    if (ioError) return ioError;

    if (resolved.scope === "workspace") {
      const result = await resolved.workspace.editFile(resolved.relativePath, {
        old_string: options.old_string,
        new_string: options.new_string,
        replace_all: Boolean(options.replace_all),
        operator: options.operator,
        messageId: options.messageId,
        mimeType: options.mimeType
      });

      return {
        ok: true,
        path: result.path,
        occurrences: result.occurrences,
        versionId: result.versionId
      };
    }

    return this.externalFileService.editFile(ctx, resolved.absolutePath, {
      old_string: options.old_string,
      new_string: options.new_string,
      replace_all: Boolean(options.replace_all),
      mimeType: options.mimeType
    });
  }

  async deleteFile(ctx, rawPath, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "write");
    const ioError = this._workspaceIOError(resolved);
    if (ioError) return ioError;

    if (resolved.scope === "workspace") {
      return resolved.workspace.deleteFile(resolved.relativePath, {
        operator: options.operator,
        messageId: options.messageId
      });
    }

    return this.externalFileService.deleteFile(ctx, resolved.absolutePath);
  }

  async moveFile(ctx, sourcePath, destPath, options = {}) {
    const fromResolved = await this._resolve(ctx, sourcePath, "write");
    const toResolved = await this._resolve(ctx, destPath, "write");

    const ioError = this._workspaceIOError(fromResolved);
    if (ioError) return ioError;

    const targetIoError = this._workspaceIOError(toResolved);
    if (targetIoError) return targetIoError;

    if (fromResolved.scope !== toResolved.scope) {
      return this._moveAcrossScopes(ctx, fromResolved, toResolved, options);
    }

    if (fromResolved.scope === "workspace") {
      return fromResolved.workspace.moveFile(fromResolved.relativePath, toResolved.relativePath, {
        operator: options.operator,
        messageId: options.messageId,
        overwrite: Boolean(options.overwrite)
      });
    }

    return this.externalFileService.moveFile(ctx, fromResolved.absolutePath, toResolved.absolutePath, {
      overwrite: Boolean(options.overwrite)
    });
  }

  async searchText(ctx, rawPath, text, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "read");
    let results;

    if (resolved.scope === "workspace") {
      results = await resolved.workspace.searchText(resolved.relativePath, text, {
        caseSensitive: Boolean(options.caseSensitive),
        maxResults: options.maxResults ?? 1000
      });
    } else {
      const result = await this.externalFileService.searchText(ctx, resolved.absolutePath, text, {
        caseSensitive: Boolean(options.caseSensitive),
        maxResults: options.maxResults ?? 1000
      });
      if (!result.ok) return result;
      results = result.results;
    }

    return {
      ok: true,
      results,
      count: results.length,
      path: rawPath || ".",
      text
    };
  }

  async getWorkspaceInfo(ctx) {
    const resolved = await this._resolve(ctx, ".", "read");
    return resolved.workspace.getDiskUsage();
  }

  async checkPermission(ctx, rawPath) {
    const resolved = await this._resolve(ctx, rawPath, "read");
    if (resolved.scope === "workspace") {
      return {
        ok: true,
        scope: "workspace",
        canRead: true,
        canWrite: true,
        exists: true,
        folder: null
      };
    }

    return this.externalFileService.checkPermission(ctx, resolved.absolutePath);
  }

  getAuthorizedFolders(ctx) {
    return this.externalFileService.getAuthorizedFolders(ctx);
  }

  async createDirectory(ctx, rawPath, options = {}) {
    const resolved = await this._resolve(ctx, rawPath, "write");
    const ioError = this._workspaceIOError(resolved);
    if (ioError) return ioError;

    if (resolved.scope === "workspace") {
      const result = await resolved.workspace.createDirectory(resolved.relativePath, {
        operator: options.operator,
        messageId: options.messageId
      });

      return {
        ok: true,
        path: result.path ?? resolved.relativePath,
        existed: result.existed
      };
    }

    return this.externalFileService.createDirectory(ctx, resolved.absolutePath, {
      recursive: options.recursive
    });
  }

  /**
   * 复制文件。相对路径表示工作区，绝对路径表示已授权外部路径。
   */
  async copyFile(ctx, sourcePath, destPath, options = {}) {
    try {
      if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
        return { ok: false, error: "invalid_path", message: "源路径不能为空" };
      }
      if (typeof destPath !== "string" || destPath.trim() === "") {
        return { ok: false, error: "invalid_path", message: "目标路径不能为空" };
      }

      const sourceResolved = await this._resolve(ctx, sourcePath, "read");
      const destResolved = await this._resolve(ctx, destPath, "write");

      return await this._copyResolved(ctx, sourceResolved, destResolved, options, {
        rawSourcePath: sourcePath,
        rawDestPath: destPath
      });
    } catch (error) {
      this.log.error("[WorkspaceFileAccess] 复制文件失败", {
        agentId: ctx?.agent?.id ?? "unknown",
        operation: "copyFile",
        sourcePath,
        destPath,
        message: error.message,
        stack: error.stack
      });
      return { ok: false, error: "copy_failed", message: error.message };
    }
  }

  /**
   * 复制文件核心流程，所有复制组合共用。
   * @private
   */
  async _copyResolved(ctx, sourceResolved, destResolved, options = {}, _raw = {}) {
    const sourceIoError = this._workspaceIOError(sourceResolved);
    if (sourceIoError) return sourceIoError;
    const destIoError = this._workspaceIOError(destResolved);
    if (destIoError) return destIoError;

    const sourceDisplay = sourceResolved.scope === "workspace" ? sourceResolved.relativePath : sourceResolved.absolutePath;
    const destDisplay = destResolved.scope === "workspace" ? destResolved.relativePath : destResolved.absolutePath;
    const hasExternal = sourceResolved.scope === "external" || destResolved.scope === "external";

    const logCopy = async (success, error = null) => {
      if (!hasExternal) return;
      await this.externalAccessLogger.logCopy(ctx, sourceDisplay, destDisplay, success, error);
    };

    if (sourceResolved.scope === "external") {
      const sourcePermission = await this.externalPermissionManager.checkReadPermission(
        sourceResolved.absolutePath,
        sourceResolved.orgId
      );
      if (!sourcePermission.allowed) {
        await logCopy(false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限读取源文件" };
      }
    }

    if (!existsSync(sourceResolved.absolutePath)) {
      await logCopy(false, "source_not_found");
      return { ok: false, error: "source_not_found", message: "源文件不存在" };
    }

    if (statSync(sourceResolved.absolutePath).isDirectory()) {
      await logCopy(false, "source_is_directory");
      return { ok: false, error: "source_is_directory", message: "源路径是目录，不是文件" };
    }

    if (destResolved.scope === "external") {
      const destPermission = await this.externalPermissionManager.checkWritePermission(
        destResolved.absolutePath,
        destResolved.orgId
      );
      if (!destPermission.allowed) {
        await logCopy(false, "access_denied");
        return { ok: false, error: "access_denied", message: "没有权限写入目标位置" };
      }
    }

    if (existsSync(destResolved.absolutePath)) {
      if (statSync(destResolved.absolutePath).isDirectory()) {
        await logCopy(false, "target_is_directory");
        return { ok: false, error: "target_is_directory", message: "目标路径是目录" };
      }
      if (!options.overwrite) {
        await logCopy(false, "target_exists");
        return { ok: false, error: "target_exists", message: "目标文件已存在" };
      }
    }

    const targetDir = path.dirname(destResolved.absolutePath);
    if (destResolved.scope === "external" && !existsSync(targetDir)) {
      const dirPermission = await this.externalPermissionManager.checkWritePermission(
        targetDir,
        destResolved.orgId
      );
      if (!dirPermission.allowed) {
        await logCopy(false, "cannot_create_dir");
        return { ok: false, error: "cannot_create_dir", message: "无法创建目标目录，超出授权范围" };
      }
    }

    await mkdir(targetDir, { recursive: true });
    await copyFile(sourceResolved.absolutePath, destResolved.absolutePath);

    const size = statSync(destResolved.absolutePath).size;
    await logCopy(true);

    return { ok: true, from: sourceDisplay, to: destDisplay, size };
  }

  /**
   * 跨 scope 移动：先复制再删除源文件。
   * @private
   */
  async _moveAcrossScopes(ctx, fromResolved, toResolved, options) {
    const copyResult = await this._copyResolved(ctx, fromResolved, toResolved, options, {
      rawSourcePath: fromResolved.absolutePath,
      rawDestPath: toResolved.absolutePath
    });
    if (!copyResult.ok) {
      return copyResult;
    }

    let deleteResult;
    try {
      if (fromResolved.scope === "workspace") {
        deleteResult = await fromResolved.workspace.deleteFile(fromResolved.relativePath, {
          operator: options.operator,
          messageId: options.messageId
        });
      } else {
        deleteResult = await this.externalFileService.deleteFile(ctx, fromResolved.absolutePath);
      }
    } catch (error) {
      this.log.error("[WorkspaceFileAccess] 跨 scope 移动删除源文件失败", {
        agentId: ctx?.agent?.id ?? "unknown",
        operation: "moveAcrossScopes",
        from: fromResolved.absolutePath,
        to: toResolved.absolutePath,
        message: error.message,
        stack: error.stack
      });
      return { ok: false, error: "move_failed", message: error.message };
    }

    if (!deleteResult?.ok) {
      const message = deleteResult?.message ?? "删除源文件失败";
      this.log.error("[WorkspaceFileAccess] 跨 scope 移动删除源文件失败", {
        agentId: ctx?.agent?.id ?? "unknown",
        operation: "moveAcrossScopes",
        from: fromResolved.absolutePath,
        to: toResolved.absolutePath,
        error: deleteResult?.error,
        message
      });
      return { ok: false, error: "move_failed", message };
    }

    return { ok: true, from: copyResult.from, to: copyResult.to };
  }

  /**
   * @private
   */
  async _resolve(ctx, rawPath, operation) {
    return this.pathResolver.resolvePath(ctx, rawPath, { operation });
  }

  /**
   * workspace 路径禁止直接操作 .io/ 系统内部目录。
   * @private
   */
  _workspaceIOError(resolved) {
    if (resolved.scope !== "workspace") return null;
    if (resolved.workspace.isPathInIO(resolved.relativePath)) {
      return {
        error: "io_access_denied",
        message: "不允许直接操作 .io/ 目录中的文件（该目录由系统模块自动管理）"
      };
    }
    return null;
  }
}

registry.declare({
  name: "workspace-file-access",
  requires: [
    "workspaceManager",
    "configService",
    "findWorkspaceIdForAgent",
    "logRoot",
    "dataDir"
  ],
  provides: ["workspaceFileAccessService"],
  async init(deps) {
    const log = deps.logRoot.forModule("workspace-file-access");

    const pathResolver = new PathResolver({
      runtime: { findWorkspaceIdForAgent: deps.findWorkspaceIdForAgent },
      log
    });

    const externalConfigManager = new ExternalConfigManager({
      configService: deps.configService,
      log
    });
    await externalConfigManager.init();

    const externalPermissionManager = new ExternalPermissionManager({
      configManager: externalConfigManager,
      log
    });

    const externalAccessLogger = new ExternalAccessLogger({
      logDir: path.join(deps.dataDir, "workspace_file_access", "logs"),
      configManager: externalConfigManager,
      log
    });
    await externalAccessLogger.init();

    const externalFileService = new ExternalFileService({
      permissionManager: externalPermissionManager,
      accessLogger: externalAccessLogger,
      runtime: { findWorkspaceIdForAgent: deps.findWorkspaceIdForAgent },
      log
    });

    const bigfileService = new BigfileService({
      pathResolver,
      permissionManager: externalPermissionManager,
      log
    });

    const service = new WorkspaceFileAccessService({
      pathResolver,
      externalConfigManager,
      externalPermissionManager,
      externalAccessLogger,
      externalFileService,
      bigfileService,
      log
    });

    return { workspaceFileAccessService: service };
  }
});

export default WorkspaceFileAccessService;
