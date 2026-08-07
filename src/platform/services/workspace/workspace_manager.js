import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Workspace } from "./workspace.js";
import { registry } from "../../core/module_registry.js";
import { getMimeTypeFromExtension } from "../../utils/content/content_type_utils.js";
import { openPathInFileManager } from "../../utils/process/open_in_file_manager.js";

/**
 * 工作区管理器
 * 负责工作区的生命周期管理和实例索引
 */
export class WorkspaceManager {
  /**
   * @param {object} options { workspacesDir, dataDir, logger }
   */
  constructor(options = {}) {
    if (!options.dataDir) throw new Error("WorkspaceManager 缺少必选依赖: dataDir");
    // 基础工作区目录，默认为项目根目录下的 data/workspaces
    this.workspacesDir = options.workspacesDir || path.resolve(process.cwd(), "data/workspaces");
    this.dataDir = options.dataDir;
    this.log = options.logger ;

    /** @type {Map<string, Workspace>} */
    this._workspaces = new Map();
  }

  /**
   * 获取工作区对象 (单例管理)
   * @param {string} workspaceId
   * @returns {Promise<Workspace>}
   */
  async getWorkspace(workspaceId) {
    if (!workspaceId || typeof workspaceId !== "string") {
      throw new Error("invalid_workspace_id");
    }

    if (this._workspaces.has(workspaceId)) {
      return this._workspaces.get(workspaceId);
    }

    const ws = new Workspace(workspaceId, this.workspacesDir, {
      logger: this.log,
      dataDir: this.dataDir
    });
    this._workspaces.set(workspaceId, ws);

    return ws;
  }

  /**
   * 创建并返回工作区对象
   * @param {string} workspaceId
   * @param {object} options
   * @returns {Promise<Workspace>}
   */
  async createWorkspace(workspaceId, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    await ws.sync(); // 初始化元数据
    return ws;
  }

  /**
   * 删除工作区
   * @param {string} workspaceId
   * @returns {Promise<{ok: boolean}>}
   */
  async deleteWorkspace(workspaceId) {
    if (!workspaceId) throw new Error("invalid_workspace_id");

    const ws = await this.getWorkspace(workspaceId);
    await rm(ws.rootPath, { recursive: true, force: true });
    this._workspaces.delete(workspaceId);

    void this.log.info("工作区已删除", { workspaceId });
    return { ok: true };
  }

  /**
   * 检查工作区是否存在
   * @param {string} workspaceId
   * @returns {boolean}
   */
  checkWorkspaceExists(workspaceId) {
    if (!workspaceId) return false;
    if (this._workspaces.has(workspaceId)) return true;

    const fullPath = path.join(this.workspacesDir, workspaceId);
    const exists = existsSync(fullPath);
    return exists;
  }

  /**
   * 设置工作区基础目录
   * @param {string} dir
   */
  setWorkspacesDir(dir) {
    this.workspacesDir = dir;
    // 如果目录发生变化，清空已缓存的工作区实例，以便下次获取时重新创建
    this._workspaces.clear();
    void this.log.info("工作区基础目录已更新", { dir });
  }

  /**
   * 获取文件信息
   * @param {string} workspaceId
   * @param {string} relativePath
   */
  async getFileInfo(workspaceId, relativePath) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.getFileInfo(relativePath);
  }

  /**
   * 获取工作区详细信息 (兼容旧版)
   * @param {string} workspaceId
   */
  async getWorkspaceInfo(workspaceId) {
    try {
      const ws = await this.getWorkspace(workspaceId);
      // 先同步一下，确保信息是最新的
      await ws.sync();
      return await ws.getInfo();
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 按行号范围读取文件
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {object} options
   */
  async readLines(workspaceId, relativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.readLines(relativePath, options);
  }

  /**
   * 在单个文件内搜索字符串或正则
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {string} pattern
   * @param {object} options
   */
  async searchInFile(workspaceId, relativePath, pattern, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.searchInFile(relativePath, pattern, options);
  }

  /**
   * 获取文件行数
   * @param {string} workspaceId
   * @param {string} relativePath
   */
  async getLineCount(workspaceId, relativePath) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.getLineCount(relativePath);
  }

  /**
   * 在文件内精确替换指定文本
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {object} options
   */
  async editFile(workspaceId, relativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.editFile(relativePath, options);
  }

  /**
   * 获取文件修改历史
   * @param {string} workspaceId
   * @param {string} relativePath
   */
  async getFileHistory(workspaceId, relativePath) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.getFileHistory(relativePath);
  }

  /**
   * 获取指定版本的文件内容
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {number} versionIndex
   */
  async getFileVersion(workspaceId, relativePath, versionIndex) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.getFileVersion(relativePath, versionIndex);
  }

  /**
   * 写入文件
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {string|Buffer} content
   * @param {object} options
   */
  async writeFile(workspaceId, relativePath, content, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.writeFile(relativePath, content, options);
  }

  /**
   * 创建目录
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {object} options
   */
  async createDirectory(workspaceId, relativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.createDirectory(relativePath, options);
  }

  /**
   * 删除文件
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {object} options
   */
  async deleteFile(workspaceId, relativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.deleteFile(relativePath, options);
  }

  /**
   * 删除目录
   * @param {string} workspaceId
   * @param {string} relativePath
   * @param {object} options
   */
  async deleteDirectory(workspaceId, relativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.deleteDirectory(relativePath, options);
  }

  /**
   * 移动/重命名文件
   * @param {string} workspaceId
   * @param {string} fromRelativePath
   * @param {string} toRelativePath
   * @param {object} options
   */
  async moveFile(workspaceId, fromRelativePath, toRelativePath, options = {}) {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.moveFile(fromRelativePath, toRelativePath, options);
  }

  /**
   * 列出文件
   * @param {string} workspaceId
   * @param {string} subDir
   */
  async listFiles(workspaceId, subDir = ".") {
    const ws = await this.getWorkspace(workspaceId);
    return await ws.listFiles(subDir);
  }

  /**
   * 列出所有工作区
   * @returns {Promise<Array<{id: string, updatedAt: number}>>}
   */
  async listWorkspaces() {
    const { readdir } = await import("node:fs/promises");
    const { statSync, existsSync } = await import("node:fs");

    if (!existsSync(this.workspacesDir)) {
      return [];
    }

    const entries = await readdir(this.workspacesDir, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const workspacePath = path.join(this.workspacesDir, entry.name);
        const stat = statSync(workspacePath);
        results.push({
          id: entry.name,
          updatedAt: stat.mtimeMs
        });
      }
    }

    // 按修改时间降序
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // --- 以下为兼容旧版代码保留的方法，后续迁移完成后可删除 ---

  /**
   * 为任务绑定工作空间 (兼容旧版)
   */
  async bindWorkspace(taskId, workspacePath) {
    // 旧版绑定逻辑，在重构期间暂时重定向到 getWorkspace
    await this.getWorkspace(taskId);
    return { ok: true };
  }

  /**
   * 获取任务的工作空间路径 (兼容旧版)
   */
  getWorkspacePath(taskId) {
    return path.join(this.workspacesDir, taskId);
  }

  /**
   * 检查工作空间是否已分配 (兼容旧版)
   */
  hasWorkspace(workspaceId) {
    return this.checkWorkspaceExists(workspaceId);
  }
}

// ============================================================
// 模块单例 & getter
// ============================================================

/** @type {WorkspaceManager|null} */
let _instance = null;

/**
 * 获取 WorkspaceManager 模块单例（供非 registry 消费方直接 import）。
 * @returns {WorkspaceManager}
 */
export function getWorkspaceManager() { return _instance; }

/** @internal - 仅用于测试，重置模块单例 */
export function _resetWorkspaceManager() { _instance = null; }

/** @internal - 仅用于测试，设置模块单例 */
export function _setTestWorkspaceManager(instance) { _instance = instance; }

/** @internal - 在 bootstrap 阶段初始化模块单例（早于 registry.declare） */
export function _bootstrapWorkspaceManager(options = {}) {
  if (_instance) return _instance;
  _instance = new WorkspaceManager({
    workspacesDir: options.workspacesDir,
    dataDir: options.dataDir,
    logger: options.logger
  });
  return _instance;
}

// ============================================================
// 工作区 Hono 路由
// ============================================================

/**
 * 注册工作空间相关的 Hono 路由。
 * @param {{ app: import('hono').Hono, log: any }} deps
 */
function registerWorkspaceRoutes({ app, log }) {
  const workspaceManager = getWorkspaceManager();

  // ==========================================================
  // GET /api/workspaces — 列出所有工作空间
  // ==========================================================
  app.get('/api/workspaces', async (c) => {
    try {
      const list = await workspaceManager.listWorkspaces();
      const workspaces = [];

      for (const item of list) {
        const ws = await workspaceManager.getWorkspace(item.id);
        const summary = await ws.getSummary();
        workspaces.push({ id: item.id, ...summary, diskUsage: summary.totalSize });
      }

      void log.debug("HTTP查询工作空间列表", { count: workspaces.length });
      return c.json({ workspaces, count: workspaces.length });
    } catch (err) {
      void log.error("查询工作空间列表失败", { error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId — 获取工作空间文件列表
  // ==========================================================
  app.get('/api/workspaces/:workspaceId', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const listing = await ws.getFileListing();

      void log.debug("HTTP查询工作空间文件列表", { workspaceId, count: listing.fileCount });
      return c.json({ workspaceId, ...listing, count: listing.fileCount });
    } catch (err) {
      void log.error("查询工作空间文件列表失败", { workspaceId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // ==========================================================
  // DELETE /api/workspaces/:workspaceId — 删除工作空间
  // ==========================================================
  app.delete('/api/workspaces/:workspaceId', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    try {
      await workspaceManager.deleteWorkspace(workspaceId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/file?path=xxx — 获取文件元数据
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/file', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const fileInfo = await ws.getFileInfo(filePath);

      void log.debug("HTTP获取工作空间文件元数据", { workspaceId, filePath });
      return c.json({
        workspaceId,
        path: filePath,
        name: path.basename(filePath),
        mimeType: fileInfo.mimeType,
        size: fileInfo.size,
        mtime: fileInfo.mtime
      });
    } catch (err) {
      void log.error("获取工作空间文件元数据失败", { workspaceId, filePath, error: err.message, stack: err.stack });
      const statusCode = err.message === "file_not_found" ? 404 : (err.message === "path_traversal_blocked" ? 403 : 500);
      return c.json({ error: err.message }, statusCode);
    }
  });

  // ==========================================================
  // POST /api/workspaces/:workspaceId/file?path=xxx — 写入文件
  // ==========================================================
  app.post('/api/workspaces/:workspaceId/file', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    try {
      const { content, mimeType, operator, messageId, offset } = body;
      if (content === undefined) {
        return c.json({ error: "content_required" }, 400);
      }

      const ws = await workspaceManager.getWorkspace(workspaceId);
      const result = await ws.writeFile(filePath, content, { mimeType, operator, messageId, offset });

      void log.info("HTTP写入工作空间文件", { workspaceId, filePath, size: result.size, offset });
      return c.json({ ok: true, ...result });
    } catch (err) {
      void log.error("写入工作空间文件失败", { workspaceId, filePath, error: err.message, stack: err.stack });
      return c.json({ error: err.message }, 500);
    }
  });

  // ==========================================================
  // DELETE /api/workspaces/:workspaceId/file?path=xxx — 删除文件
  // ==========================================================
  app.delete('/api/workspaces/:workspaceId/file', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      await ws.deleteFile(filePath, {
        operator: "user",
        messageId: `delete_file_${Date.now()}`
      });

      void log.info("HTTP删除工作空间文件", { workspaceId, filePath });
      return c.json({ ok: true });
    } catch (err) {
      void log.error("删除工作空间文件失败", { workspaceId, filePath, error: err.message, stack: err.stack });
      return c.json({ error: err.message }, 500);
    }
  });

  // ==========================================================
  // POST /api/workspaces/:workspaceId/directory — 创建目录
  // ==========================================================
  app.post('/api/workspaces/:workspaceId/directory', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }
    try {
      const directoryPath = typeof body?.path === "string" ? body.path.trim() : "";
      if (!directoryPath) {
        return c.json({ error: "invalid_path", message: "目录路径不能为空" }, 400);
      }

      const result = await workspaceManager.createDirectory(workspaceId, directoryPath, {
        operator: body?.operator || "user",
        messageId: body?.messageId || `create_directory_${Date.now()}`
      });

      void log.info("HTTP创建工作空间目录", { workspaceId, directoryPath, existed: result.existed });
      return c.json(result);
    } catch (createError) {
      void log.error("创建工作空间目录失败", { workspaceId, error: createError.message, stack: createError.stack });
      const statusCode = createError.message === "path_traversal_blocked" ? 403 : 500;
      return c.json({ error: createError.message }, statusCode);
    }
  });

  // ==========================================================
  // DELETE /api/workspaces/:workspaceId/directory?path=xxx — 删除目录
  // ==========================================================
  app.delete('/api/workspaces/:workspaceId/directory', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const directoryPath = c.req.query("path") || "";
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const result = await ws.deleteDirectory(directoryPath, {
        operator: "user",
        messageId: `delete_directory_${Date.now()}`
      });

      void log.info("HTTP删除工作空间目录", {
        workspaceId,
        directoryPath,
        deletedFiles: result.deletedFiles,
        deletedDirectories: result.deletedDirectories
      });
      return c.json(result);
    } catch (err) {
      void log.error("删除工作空间目录失败", { workspaceId, directoryPath, error: err.message, stack: err.stack });
      return c.json({ error: err.message }, 500);
    }
  });

  // ==========================================================
  // POST /api/workspaces/:workspaceId/open — 打开系统文件管理器
  // ==========================================================
  app.post('/api/workspaces/:workspaceId/open', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    let body;
    try {
      body = await c.req.json();
    } catch (parseErr) {
      return c.json({ error: "invalid_json", message: parseErr.message }, 400);
    }

    try {
      const workspace = await workspaceManager.getWorkspace(workspaceId);
      const relativePath = typeof body?.path === "string" ? body.path : "";
      const targetPath = workspace.resolveAbsolutePath(relativePath);
      const targetStat = await stat(targetPath);

      if (!targetStat.isDirectory()) {
        return c.json({ error: "invalid_path", message: "只能打开工作区目录" }, 400);
      }

      await openPathInFileManager(targetPath);
      void log.info("HTTP调用文件管理器打开工作区目录", { workspaceId, relativePath, targetPath });
      return c.json({
        ok: true,
        workspaceId,
        path: relativePath,
        targetPath
      });
    } catch (openError) {
      const isInvalidPath = openError?.message === "invalid_path";
      const isMissingPath = openError?.code === "ENOENT";
      const statusCode = isInvalidPath ? 400 : (isMissingPath ? 404 : 500);
      const message = isInvalidPath
        ? "工作区路径非法"
        : (isMissingPath ? "工作区目录不存在" : "打开系统文件管理器失败");

      void log.error("打开工作区目录失败", {
        workspaceId,
        path: body?.path,
        error: openError?.message,
        stack: openError?.stack
      });
      return c.json({
        error: isInvalidPath ? "invalid_path" : (isMissingPath ? "directory_not_found" : "open_file_manager_failed"),
        message
      }, statusCode);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/meta — 获取元信息
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/meta', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const summary = await ws.getSummary();

      void log.debug("HTTP查询工作空间元信息", { workspaceId });
      return c.json({ workspaceId, ...summary, diskUsage: summary.totalSize });
    } catch (err) {
      void log.error("查询工作空间元信息失败", { workspaceId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/disk-usage — 获取磁盘占用
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/disk-usage', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const usage = await ws.getDiskUsage();
      return c.json(usage);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/agent-files/:agentId — 智能体修改的文件
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/agent-files/:agentId', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const agentId = decodeURIComponent(c.req.param('agentId'));
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const files = await ws.getAgentFiles(agentId);

      void log.debug("HTTP查询智能体文件列表", { workspaceId, agentId, count: files.length });
      return c.json({
        workspaceId,
        agentId,
        files,
        count: files.length
      });
    } catch (err) {
      void log.error("查询智能体文件列表失败", { workspaceId, agentId, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/search?q=xxx&type=filename|fulltext
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/search', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const query = c.req.query("q") || "";
    const searchType = c.req.query("type") || "filename";
    const maxResults = parseInt(c.req.query("maxResults") || "200", 10);

    if (!query.trim()) {
      return c.json({ error: "missing_query", message: "搜索关键词不能为空" }, 400);
    }

    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const result = await ws.searchFiles(query, searchType, maxResults);
      return c.json(result);
    } catch (err) {
      void log.error("搜索工作空间文件失败", { workspaceId, error: err.message, stack: err.stack });
      const statusCode = err.message === "workspace_not_found" ? 404 : 500;
      return c.json({ error: "internal_error", message: err.message }, statusCode);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/file-history?path=xxx — 文件修改历史
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/file-history', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const history = await ws.getFileHistory(filePath);
      void log.debug("HTTP获取文件修改历史", { workspaceId, filePath, count: history.length });
      return c.json({ history });
    } catch (err) {
      void log.error("获取文件修改历史失败", { workspaceId, filePath, error: err.message, stack: err.stack });
      const statusCode = err.message === "file_not_found" ? 404 : 500;
      return c.json({ error: err.message }, statusCode);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/file-meta?path=xxx — 文件完整元数据
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/file-meta', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const meta = await ws.readFileMeta(filePath);
      void log.debug("HTTP获取文件完整元数据", { workspaceId, filePath });
      return c.json(meta);
    } catch (err) {
      void log.error("获取文件完整元数据失败", { workspaceId, filePath, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
  });

  // ==========================================================
  // GET /api/workspaces/:workspaceId/file-version?path=xxx&index=N — 获取指定版本文件内容
  // ==========================================================
  app.get('/api/workspaces/:workspaceId/file-version', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.query("path") || "";
    const versionIndex = parseInt(c.req.query("index") || "", 10);
    try {
      if (isNaN(versionIndex) || versionIndex < 0) {
        return c.json({ error: "invalid_version_index", message: "versionIndex 必须为非负整数" }, 400);
      }
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const result = await ws.getFileVersion(filePath, versionIndex);
      void log.debug("HTTP获取文件版本内容", { workspaceId, filePath, versionIndex });
      return c.text(result.content, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (err) {
      void log.error("获取文件版本内容失败", { workspaceId, filePath, versionIndex, error: err.message, stack: err.stack });
      const statusCode = err.message === "version_not_found" ? 404
        : (err.message === "invalid_version_index" ? 400 : 500);
      return c.json({ error: err.message }, statusCode);
    }
  });

  // ==========================================================
  // GET /workspace-files/:workspaceId/:filePath{.+} — 静态文件服务
  // ==========================================================
  app.get('/workspace-files/:workspaceId/:filePath{.+}', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const filePath = c.req.param('filePath');
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const result = await ws.readFile(filePath, { offset: 0, length: 10 * 1024 * 1024 });

      if (result.mimeType.startsWith('text/') || result.mimeType === 'application/json' || result.mimeType === 'application/javascript') {
        return c.text(result.content, 200, { 'Content-Type': result.mimeType });
      } else {
        return c.body(Buffer.from(result.content, 'base64'), 200, { 'Content-Type': result.mimeType });
      }
    } catch (err) {
      if (err.message === "file_not_found") {
        void log.warn("读取工作空间文件失败", { error: err.message });
      } else {
        void log.error("读取工作空间文件失败", { error: err.message, stack: err.stack });
      }
      const statusCode = err.message === "file_not_found" ? 404 : 500;
      return c.json({ error: err.message }, statusCode);
    }
  });

  // ==========================================================
  // POST /api/upload — multipart 文件上传
  // ==========================================================
  app.post('/api/upload', async (c) => {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      void log.warn("文件上传失败: Content-Type 错误", { contentType });
      return c.json({ error: "invalid_content_type", message: "Content-Type 必须是 multipart/form-data" }, 400);
    }

    try {
      const formData = await c.req.formData();
      const fileEntry = formData.get('file');

      // 允许 0 字节文件 — 新建文本文件复用上传接口，以空字符串作为文件内容
      if (!fileEntry || !(fileEntry instanceof File)) {
        return c.json({ error: "missing_file", message: "请求中缺少文件" }, 400);
      }

      const buffer = Buffer.from(await fileEntry.arrayBuffer());

      const workspaceId = formData.get('workspaceId')?.toString() || "default";
      const filename = formData.get('filename')?.toString() || fileEntry.name || `upload_${Date.now()}`;
      const relativePath = formData.get('path')?.toString() || filename;

      const detectedMimeType = getMimeTypeFromExtension(filename);
      const finalMimeType = detectedMimeType || fileEntry.type || "application/octet-stream";

      const writeResult = await workspaceManager.writeFile(
        workspaceId,
        relativePath,
        buffer,
        {
          operator: formData.get('operator')?.toString() || 'user',
          messageId: `upload_${Date.now()}`,
          mimeType: finalMimeType
        }
      );

      void log.info("文件上传成功", {
        workspaceId,
        path: relativePath,
        filename,
        size: buffer.length,
        mimeType: finalMimeType
      });

      return c.json({
        ok: true,
        path: relativePath,
        metadata: writeResult
      });
    } catch (err) {
      void log.error("文件上传失败", { error: err.message, stack: err.stack });
      return c.json({ error: "upload_failed", message: err.message }, 500);
    }
  });

  // ==========================================================
  // POST /api/workspaces/:workspaceId/sync — 手动触发工作区同步
  // ==========================================================
  app.post('/api/workspaces/:workspaceId/sync', async (c) => {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    try {
      const ws = await workspaceManager.getWorkspace(workspaceId);
      const meta = await ws.sync();
      const fileCount = Object.keys(meta.files).length;

      void log.info("手动触发工作区同步", { workspaceId, fileCount });
      return c.json({ ok: true, syncedAt: meta.lastSync, fileCount });
    } catch (err) {
      void log.error("工作区同步失败", { workspaceId, error: err.message, stack: err.stack });
      return c.json({ error: "sync_failed", message: err.message }, 500);
    }
  });
}

// ============================================================
// 声明式注册：workspace-manager 自行管理生命周期
// ============================================================

registry.declare({
  name: 'workspace-manager',
  requires: ['workspacesDir', 'dataDir', 'logRoot', 'app', 'log'],
  provides: ['workspaceManager'],
  async init(deps) {
    // 如果 bootstrap 阶段已经创建了实例，直接复用（否则创建一个新的）
    if (!_instance) {
      _instance = new WorkspaceManager({
        workspacesDir: deps.workspacesDir,
        dataDir: deps.dataDir,
        logger: deps.logRoot.forModule('workspace')
      });
    } else if (deps.workspacesDir && typeof _instance.setWorkspacesDir === 'function') {
      // 如果 workspacesDir 不同，更新目录（仅当实例有该方法，避免测试 mock 污染）
      _instance.setWorkspacesDir(deps.workspacesDir);
    }
    registerWorkspaceRoutes({ app: deps.app, log: deps.log });
    return { workspaceManager: _instance };
  }
});
