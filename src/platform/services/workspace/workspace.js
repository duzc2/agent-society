import { mkdir, readFile, writeFile, readdir, stat, unlink, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { MIME_TYPE_MAPPINGS, sanitizeMimeType, isTextFile, getMimeTypeFromExtension, getExtensionFromMimeType } from "../../utils/content/content_type_utils.js";

/**
 * 工作区对象
 * 负责具体的文件操作和元数据维护
 */
export class Workspace {
  /**
   * @param {string} id - 工作区 ID
   * @param {string} workspacesDir - 工作区根目录所在的父目录
   * @param {object} options
   */
  constructor(id, workspacesDir, options = {}) {
    if (!options.dataDir) throw new Error("Workspace 缺少必选依赖: dataDir");
    this.id = id;
    this.workspacesDir = workspacesDir;
    this._dataDir = options.dataDir;
    this.log = options.logger ;
  }

  /**
   * 动态计算工作区物理根路径
   */
  get rootPath() {
    return path.join(this.workspacesDir, this.id);
  }

  /**
   * 元数据目录路径
   */
  get metaDir() {
    return path.join(this.rootPath, ".meta");
  }

  /**
   * 版本快照目录路径
   */
  get versionsDir() {
    return path.join(this.rootPath, ".versions");
  }

  /**
   * 全局元数据文件路径
   */
  get globalMetaFile() {
    return path.join(this.metaDir, ".meta");
  }

  /**
   * IO 目录路径（模块内部使用，不受 Agent 工具写入限制）
   */
  get ioDir() {
    return path.join(this.rootPath, ".io");
  }

  /**
   * 判断路径是否在 .io/ 目录内
   * @param {string} relativePath - 相对于工作区根目录的路径
   * @returns {boolean}
   */
  isPathInIO(relativePath) {
    if (!relativePath || typeof relativePath !== "string") return false;
    const normalized = relativePath.replace(/\\/g, "/");
    return normalized === ".io" || normalized.startsWith(".io/");
  }

  /**
   * 将内容写入 .io/ 目录（仅供模块内部使用）
   * 不创建 .meta 条目，不需要 operator/messageId
   *
   * @param {string} module - 调用模块名称（如 "chrome"）
   * @param {string} source - 数据来源描述（如主机名）
   * @param {string|Buffer} content - 要写入的内容
   * @param {object} options - { mimeType? }
   * @returns {Promise<{ok: boolean, path: string, size: number, mimeType: string}>}
   */
  async writeFileToIO(module, source, content, options = {}) {
    const safeSource = String(source || "unknown")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_")
      .slice(0, 100);

    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const randomStr = Math.floor(Math.random() * 10000).toString().padStart(4, "0");

    const mimeType = options.mimeType || "application/octet-stream";
    const ext = getExtensionFromMimeType(mimeType) || "bin";

    const filename = `${module}-${safeSource}-${dateStr}${timeStr}${randomStr}.${ext}`;
    await mkdir(this.ioDir, { recursive: true });

    const fullPath = path.join(this.ioDir, filename);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    await writeFile(fullPath, buffer);

    return {
      ok: true,
      path: `.io/${filename}`,
      size: buffer.length,
      mimeType
    };
  }

  /**
   * 验证路径安全
   * @param {string} relativePath
   * @returns {boolean}
   */
  _isPathSafe(relativePath) {
    if (!relativePath || typeof relativePath !== "string") return false;
    if (path.isAbsolute(relativePath)) return false;
    const normalized = path.normalize(relativePath);
    if (normalized.startsWith("..") || normalized.includes(`${path.sep}..`)) return false;
    // 禁止访问系统内部目录 .versions
    if (normalized === ".versions" || normalized.startsWith(`.versions${path.sep}`)) return false;
    return true;
  }

  /**
   * 自动探测 MIME 类型
   * @param {string} relativePath
   * @param {Buffer} [content] - 可选的内容，用于内容嗅探（暂未实现复杂嗅探）
   * @returns {string}
   */
  _detectMimeType(relativePath, content) {
    // 优先使用统一的工具检测扩展名
    const mime = getMimeTypeFromExtension(relativePath);
    if (mime) return mime;

    // 如果没有扩展名或未识别扩展名，检查内容是否为文本
    if (content) {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      // 检查前 1024 字节是否包含空字节，如果没有通常是文本
      let isBinary = false;
      const checkLen = Math.min(buffer.length, 1024);
      for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) {
          isBinary = true;
          break;
        }
      }
      if (!isBinary) return 'text/plain';
    }

    return 'application/octet-stream';
  }

  /**
   * 规范化工作区内相对路径。
   * 统一去除反斜杠、首尾多余斜杠，便于全局元数据与接口层保持一致。
   *
   * @param {string} relativePath
   * @returns {string}
   */
  _normalizeRelativePath(relativePath) {
    return String(relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  /**
   * 将工作区内相对路径解析为磁盘绝对路径。
   * 该方法负责复用工作区自身的路径安全约束，避免 HTTP 层重复拼装路径规则。
   *
   * @param {string} [relativePath=""] 工作区内相对路径；空字符串表示工作区根目录
   * @returns {string}
   */
  resolveAbsolutePath(relativePath = "") {
    const normalizedRelativePath = this._normalizeRelativePath(relativePath);

    if (!normalizedRelativePath) {
      return this.rootPath;
    }

    if (!this._isPathSafe(normalizedRelativePath)) {
      throw new Error("invalid_path");
    }

    const resolvedPath = path.resolve(this.rootPath, normalizedRelativePath);
    const workspaceRootWithSeparator = `${this.rootPath}${path.sep}`;

    if (resolvedPath !== this.rootPath && !resolvedPath.startsWith(workspaceRootWithSeparator)) {
      throw new Error("invalid_path");
    }

    return resolvedPath;
  }

  /**
   * 获取相对路径的目录层级链。
   * 例如 a/b/c 会返回 [a, a/b, a/b/c]。
   *
   * @param {string} relativePath
   * @returns {string[]}
   */
  _getPathChain(relativePath) {
    const normalizedPath = this._normalizeRelativePath(relativePath);
    if (!normalizedPath) {
      return [];
    }

    const parts = normalizedPath.split("/");
    const results = [];

    for (let index = 0; index < parts.length; index += 1) {
      results.push(parts.slice(0, index + 1).join("/"));
    }

    return results;
  }

  /**
   * 写入文件并更新元数据
   * @param {string} relativePath
   * @param {string|Buffer} content
   * @param {object} options { operator, messageId, mimeType }
   */
  async writeFile(relativePath, content, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    // 先检查必需参数，避免文件写入后才发现参数缺失
    if (!options.operator) {
      throw new Error(`writeFile_missing_operator: ${relativePath}`);
    }
    if (!options.messageId) {
      throw new Error(`writeFile_missing_messageId: ${relativePath}`);
    }

    const fullPath = path.resolve(this.rootPath, relativePath);
    const parentDir = path.dirname(fullPath);
    
    // 确保目录存在
    await mkdir(parentDir, { recursive: true });
    await mkdir(this.metaDir, { recursive: true });

    // 注册父目录元数据（mkdir 递归创建了目录但未写入 meta）
    const normalizedPath = this._normalizeRelativePath(relativePath);
    const pathParts = normalizedPath.split("/").filter(Boolean);
    if (pathParts.length > 1) {
      const parentDirectoryPath = pathParts.slice(0, -1).join("/");
      const directoryChain = this._getPathChain(parentDirectoryPath);
      const dirTimestamp = new Date().toISOString();
      for (const directoryPath of directoryChain) {
        await this._updateDirectoryMeta(directoryPath, {
          type: "directory",
          updatedAt: dirTimestamp,
          lastOperator: options.operator,
          lastMessageId: options.messageId
        });
      }
    }

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

    // 清理 mimeType 参数，处理大模型可能传入的格式错误（两侧多余引号、空格等）
    const sanitizedMimeType = options.mimeType ? sanitizeMimeType(options.mimeType) : '';
    const mimeType = sanitizedMimeType || this._detectMimeType(relativePath, buffer);

    // 更新文件级元数据
    const existingMeta = await this.readFileMeta(relativePath);
    const fileMeta = {
      ...existingMeta,
      ...options.meta, // 保留传入的额外元数据（如图片宽高）
      path: relativePath,
      mimeType,
      deleted: false
    };

    // 版本快照：若文件已存在，读取旧内容保存为快照
    const versionIndex = fileMeta.history.length;
    const versionId = `v${versionIndex}`;
    const fileExists = existsSync(fullPath);
    if (fileExists) {
      try {
        // 仅对文本文件保存快照（二进制文件不保存快照）
        const isTextType = mimeType.startsWith('text/') ||
          mimeType === 'application/json' ||
          mimeType === 'application/javascript';
        if (isTextType) {
          const oldContent = await readFile(fullPath, 'utf8');
          const snapshotDir = path.join(this.versionsDir, relativePath);
          await mkdir(snapshotDir, { recursive: true });
          const snapshotPath = path.join(snapshotDir, `${versionIndex}.snap`);
          await writeFile(snapshotPath, oldContent, 'utf8');
        }
      } catch (_snapErr) {
        // 快照保存失败不应阻断写入，记录日志后继续
        void this.log?.warn?.("版本快照保存失败", { relativePath, error: _snapErr.message });
      }
    }

    // 写入文件
    await writeFile(fullPath, buffer);

    const record = {
      operator: options.operator,
      messageId: options.messageId,
      timestamp: new Date().toISOString(),
      action: fileExists ? 'write' : 'create',
      size: buffer.length,
      versionId
    };

    fileMeta.history.push(record);

    // 写入文件级元数据（保留完整历史和所有字段）
    await this._writeFileMeta(relativePath, fileMeta);

    // 更新全局索引（仅保留最新高频数据）
    await this._updateGlobalMeta(relativePath, {
      ...options.meta, // 同步保留到全局高频索引
      type: 'file',
      size: buffer.length,
      mimeType,
      updatedAt: record.timestamp,
      lastOperator: record.operator,
      lastMessageId: record.messageId
    });

    // 如果操作者是智能体，记录到 agent files 列表
    if (options.operator && options.operator !== 'user') {
      await this._recordAgentFileWrite(options.operator, relativePath);
    }

    return { ok: true, path: relativePath, size: buffer.length, mimeType, versionId };
  }

  /**
   * 创建目录并更新目录元数据。
   * 当前目录创建能力用于工作区管理器的新建文件夹入口，因此要求显式记录空目录。
   *
   * @param {string} relativePath
   * @param {object} options { operator, messageId }
   * @returns {Promise<{ok: boolean, path: string, existed: boolean}>}
   */
  async createDirectory(relativePath, options = {}) {
    const normalizedPath = this._normalizeRelativePath(relativePath);

    if (!normalizedPath || !this._isPathSafe(normalizedPath)) {
      throw new Error("path_traversal_blocked");
    }

    if (!options.operator) {
      throw new Error(`createDirectory_missing_operator: ${normalizedPath}`);
    }
    if (!options.messageId) {
      throw new Error(`createDirectory_missing_messageId: ${normalizedPath}`);
    }

    const fullPath = path.resolve(this.rootPath, normalizedPath);
    let existed = false;

    try {
      const currentStat = await stat(fullPath);
      if (!currentStat.isDirectory()) {
        throw new Error("target_exists");
      }
      existed = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(fullPath, { recursive: true });
    await mkdir(this.metaDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const directoryChain = this._getPathChain(normalizedPath);
    for (const directoryPath of directoryChain) {
      await this._updateDirectoryMeta(directoryPath, {
        type: "directory",
        updatedAt: timestamp,
        lastOperator: options.operator,
        lastMessageId: options.messageId
      });
    }

    return {
      ok: true,
      path: normalizedPath,
      existed
    };
  }

  /**
   * 随机读取文件内容
   * @param {string} relativePath
   * @param {object} options { offset, length }
   */
  async readFile(relativePath, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    const fullPath = path.resolve(this.rootPath, relativePath);
    let stats;
    try {
      stats = await stat(fullPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error("file_not_found");
      }
      throw e;
    }

    const total = stats.size;
    const offset = Math.max(0, options.offset || 0);
    // 默认读取 100000 字节，最大支持 10MB
    const length = Math.min(10 * 1024 * 1024, options.length || 100000);

    const fsPromises = await import('node:fs/promises');
    const handle = await fsPromises.open(fullPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const resultBuffer = buffer.subarray(0, bytesRead);
      
      const mimeType = await this.getFileInfo(relativePath).then(m => m?.mimeType).catch(() => 'application/octet-stream') || 'application/octet-stream';
      
      let content;
      if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript') {
        content = resultBuffer.toString('utf8');
      } else {
        content = resultBuffer.toString('base64');
      }

      return {
        content,
        start: offset,
        total,
        readLength: bytesRead,
        mimeType
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * 删除文件
   */
  async deleteFile(relativePath, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    if (!options.operator) {
      throw new Error(`deleteFile_missing_operator: ${relativePath}`);
    }
    if (!options.messageId) {
      throw new Error(`deleteFile_missing_messageId: ${relativePath}`);
    }

    const fullPath = path.resolve(this.rootPath, relativePath);

    // 通过全局元数据判断是文件还是目录，避免额外 stat 调用
    const globalMeta = await this._readGlobalMeta();
    const key = relativePath.replace(/\\/g, "/");
    const isDirectory = globalMeta.directories?.[key] !== undefined;

    if (isDirectory) {
      return this.deleteDirectory(relativePath, options);
    }

    // 物理文件不存在也视作成功（幂等删除）
    if (!globalMeta.files[key] && !existsSync(fullPath)) {
      return { ok: true };
    }

    // 元数据未追踪但物理存在：用 stat 判断实际类型（兜底）
    if (!globalMeta.files[key]) {
      const actualStat = await stat(fullPath).catch(() => null);
      if (actualStat?.isDirectory()) {
        return this.deleteDirectory(relativePath, options);
      }
      // 既不在 meta 也不是目录，说明元数据过期，直接 rm
      await rm(fullPath, { recursive: true, force: true });
      return { ok: true };
    }

    await unlink(fullPath);

    // 记录删除历史到元数据文件
    const existingMeta = await this.readFileMeta(relativePath);
    const fileMeta = {
      ...existingMeta,
      path: relativePath,
      deleted: true,
      deletedAt: null
    };

    const record = {
      operator: options.operator,
      messageId: options.messageId,
      timestamp: new Date().toISOString(),
      action: 'delete'
    };

    fileMeta.history.push(record);
    fileMeta.deleted = true;
    fileMeta.deletedAt = record.timestamp;

    // 写入文件级元数据（保留完整历史，不随文件物理删除而销毁）
    await this._writeFileMeta(relativePath, fileMeta);

    // 仅从全局索引中移除，让前端列表变干净，但保留文件审计历史
    await this._removeFromGlobalMeta(relativePath);

    return { ok: true };
  }

  /**
   * 删除目录。
   * 目录删除采用递归方式，保证用户在界面上删除文件夹时，物理目录与工作区索引同步清理。
   * 对目录下已有文件，会补写删除历史，避免仅删除物理文件而丢失审计信息。
   *
   * @param {string} relativePath
   * @param {object} options { operator, messageId }
   * @returns {Promise<{ok: boolean, path: string, deletedFiles: number, deletedDirectories: number}>}
   */
  async deleteDirectory(relativePath, options = {}) {
    const normalizedPath = this._normalizeRelativePath(relativePath);

    if (!normalizedPath || !this._isPathSafe(normalizedPath)) {
      throw new Error("path_traversal_blocked");
    }

    if (!options.operator) {
      throw new Error(`deleteDirectory_missing_operator: ${normalizedPath}`);
    }
    if (!options.messageId) {
      throw new Error(`deleteDirectory_missing_messageId: ${normalizedPath}`);
    }

    const fullPath = path.resolve(this.rootPath, normalizedPath);
    let directoryStat;
    try {
      directoryStat = await stat(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ok: true };
      }
      throw error;
    }

    if (!directoryStat.isDirectory()) {
      throw new Error("not_a_directory");
    }

    const meta = await this._readGlobalMeta();
    const directoryPrefix = `${normalizedPath}/`;
    const deletedFilePaths = Object.keys(meta.files).filter(filePath => (
      filePath === normalizedPath || filePath.startsWith(directoryPrefix)
    ));
    const deletedDirectoryPaths = Object.keys(meta.directories || {}).filter(directoryPath => (
      directoryPath === normalizedPath || directoryPath.startsWith(directoryPrefix)
    ));

    const deletedAt = new Date().toISOString();
    for (const filePath of deletedFilePaths) {
      const existingMeta = await this.readFileMeta(filePath);
      const fileMeta = {
        ...existingMeta,
        path: filePath,
        deleted: true,
        deletedAt
      };

      fileMeta.history.push({
        operator: options.operator,
        messageId: options.messageId,
        timestamp: deletedAt,
        action: "delete"
      });

      await this._writeFileMeta(filePath, fileMeta);
    }

    await rm(fullPath, { recursive: true, force: true });

    deletedFilePaths.forEach(filePath => {
      delete meta.files[filePath];
    });
    deletedDirectoryPaths.forEach(directoryPath => {
      delete meta.directories[directoryPath];
    });

    meta.lastSync = deletedAt;
    await mkdir(this.metaDir, { recursive: true });
    await writeFile(this.globalMetaFile, JSON.stringify(meta, null, 2));

    return {
      ok: true,
      path: normalizedPath,
      deletedFiles: deletedFilePaths.length,
      deletedDirectories: deletedDirectoryPaths.length
    };
  }

  /**
   * 移动/重命名文件
   * @param {string} fromRelativePath 源文件相对路径
   * @param {string} toRelativePath 目标文件相对路径（可含子目录）
   * @param {object} options { operator, messageId, overwrite }
   * @returns {Promise<{ok: boolean, from: string, to: string}>}
   */
  async moveFile(fromRelativePath, toRelativePath, options = {}) {
    // 路径安全校验
    if (!this._isPathSafe(fromRelativePath) || !this._isPathSafe(toRelativePath)) {
      throw new Error("path_traversal_blocked");
    }
    if (!options.operator) {
      throw new Error(`moveFile_missing_operator: ${fromRelativePath} -> ${toRelativePath}`);
    }
    if (!options.messageId) {
      throw new Error(`moveFile_missing_messageId: ${fromRelativePath} -> ${toRelativePath}`);
    }

    const fullFrom = path.resolve(this.rootPath, fromRelativePath);
    const fullTo = path.resolve(this.rootPath, toRelativePath);

    // 检查源文件存在性
    let srcStat;
    try {
      srcStat = await stat(fullFrom);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error("file_not_found");
      }
      throw e;
    }
    if (!srcStat.isFile()) {
      throw new Error("not_a_file");
    }

    // 目标存在性检查与覆盖处理
    let targetExists = false;
    try {
      const toStat = await stat(fullTo);
      if (toStat) {
        targetExists = true;
        if (toStat.isDirectory()) {
          throw new Error("target_is_directory");
        }
        if (!options.overwrite) {
          throw new Error("target_exists");
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        // 非不存在错误，抛出
        throw e;
      }
    }

    // 确保目标目录存在
    await mkdir(path.dirname(fullTo), { recursive: true });
    await mkdir(this.metaDir, { recursive: true });

    // 准备元数据
    const timestamp = new Date().toISOString();
    const moveRecord = {
      operator: options.operator,
      messageId: options.messageId,
      timestamp,
      action: "move",
      from: fromRelativePath,
      to: toRelativePath
    };

    // 读取并更新文件级元数据（在重命名文件前后都可行，这里选择先更新以保证原子性）
    const existingMeta = await this.readFileMeta(fromRelativePath);
    existingMeta.history.push(moveRecord);
    existingMeta.path = toRelativePath;
    // 写入到新位置的元数据文件
    await this._writeFileMeta(toRelativePath, existingMeta);
    // 删除旧元数据文件（若存在）
    const oldMetaPath = path.join(this.metaDir, fromRelativePath);
    if (existsSync(oldMetaPath)) {
      await rm(oldMetaPath, { force: true });
    }

    // 如需覆盖，先删除目标（兼容文件和目录）
    if (targetExists && options.overwrite) {
      await rm(fullTo, { recursive: true, force: true }).catch(() => {});
    }

    // 物理移动文件
    await rename(fullFrom, fullTo);

    // 更新全局元数据：迁移 key，更新时间与操作者信息
    const globalMeta = await this._readGlobalMeta();
    const fromKey = fromRelativePath.replace(/\\/g, "/");
    const toKey = toRelativePath.replace(/\\/g, "/");
    const oldInfo = globalMeta.files[fromKey] || {};
    // 删除旧条目
    delete globalMeta.files[fromKey];
    // 新条目（保留大小、mimeType 等信息）
    globalMeta.files[toKey] = {
      ...oldInfo,
      type: "file",
      updatedAt: timestamp,
      lastOperator: options.operator,
      lastMessageId: options.messageId
    };
    globalMeta.lastSync = timestamp;
    await writeFile(this.globalMetaFile, JSON.stringify(globalMeta, null, 2));

    return { ok: true, from: fromRelativePath, to: toRelativePath };
  }

  /**
   * 获取元数据
   */
  async getMetadata(relativePath) {
    const globalMeta = await this._readGlobalMeta();
    const info = globalMeta.files[relativePath];
    if (!info) throw new Error("file_not_found");
    return info;
  }

  /**
   * 获取文件详细历史
   */
  async getFileHistory(relativePath) {
    const fileMetaPath = path.join(this.metaDir, relativePath);
    const content = await readFile(fileMetaPath, "utf8");
    return JSON.parse(content).history;
  }

  /**
   * 获取指定版本索引的文件内容（从快照读取）
   * @param {string} relativePath - 文件相对路径
   * @param {number} versionIndex - 版本索引 (0-based, 即 history 数组索引)
   * @returns {Promise<{content: string, versionIndex: number}>}
   */
  async getFileVersion(relativePath, versionIndex) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }
    if (typeof versionIndex !== 'number' || versionIndex < 0 || !Number.isInteger(versionIndex)) {
      throw new Error("invalid_version_index");
    }

    // 版本 0 是首次创建之后的状态，需要读取创建前的快照
    // 但实际上每个快照保存的是"修改前"的旧内容
    // 所以 getFileVersion(n) 返回的是第 n 次修改后写入的内容（= versionIndex n 的快照是修改前的）
    // 快照结构：v{n}.snap 保存的是第 n 次写入前的旧内容
    const snapshotDir = path.join(this.versionsDir, relativePath);
    const snapshotPath = path.join(snapshotDir, `${versionIndex}.snap`);

    try {
      const content = await readFile(snapshotPath, 'utf8');
      return { content, versionIndex };
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error("version_not_found");
      }
      throw e;
    }
  }

  /**
   * 获取目录树（仅文件夹）
   */
  async getTree() {
    const globalMeta = await this._readGlobalMeta();
    const dirs = new Set();
    Object.keys(globalMeta.directories || {}).forEach(dirPath => {
      const normalizedPath = dirPath.replace(/\\/g, "/");
      const parts = normalizedPath.split("/");
      for (let i = 1; i <= parts.length; i += 1) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    });
    Object.keys(globalMeta.files).forEach(filePath => {
      // 统一使用正斜杠处理路径
      const normalizedPath = filePath.replace(/\\/g, "/");
      const parts = normalizedPath.split("/");
      // 如果文件在子目录下，每一级父目录都算一个目录
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    });
    return Array.from(dirs).sort();
  }

  /**
   * 向文件末尾追加内容。
   * 如果文件不存在，则等同于创建新文件。
   * @param {string} relativePath
   * @param {string|Buffer} content - 要追加的内容
   * @param {object} options { operator, messageId, mimeType }
   */
  async appendFile(relativePath, content, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    if (!options.operator) {
      throw new Error(`appendFile_missing_operator: ${relativePath}`);
    }
    if (!options.messageId) {
      throw new Error(`appendFile_missing_messageId: ${relativePath}`);
    }

    const fullPath = path.resolve(this.rootPath, relativePath);

    // 尝试读取已有内容
    let combinedContent;
    try {
      const existingBuffer = await readFile(fullPath);
      const newBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      combinedContent = Buffer.concat([existingBuffer, newBuffer]);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // 文件不存在，直接使用新内容
        combinedContent = content;
      } else {
        throw e;
      }
    }

    // 复用 writeFile 完成实际写入和元数据维护
    return this.writeFile(relativePath, combinedContent, options);
  }

  /**
   * 获取文件信息
   * @param {string} relativePath
   */
  async getFileInfo(relativePath) {
    if (!this._isPathSafe(relativePath)) throw new Error("path_traversal_blocked");
    const meta = await this._readGlobalMeta();
    const key = relativePath.replace(/\\/g, "/");
    const info = meta.files[key];
    if (!info) return null;
    
    return {
      ...this._toFileEntry(key, info),
      filename: path.basename(key),
      isBinary: !info.mimeType.startsWith('text/') &&
                info.mimeType !== 'application/json' &&
                info.mimeType !== 'application/javascript'
    };
  }

  /**
   * 列出文件和子目录
   * 
   * 根据全局元数据推断指定目录下的文件和子目录列表。
   * 子目录是通过分析文件路径中的目录层级推断出来的。
   * 
   * @param {string} subDir - 子目录路径，相对于工作区根目录，默认为根目录 "."
   * @returns {Promise<Array<{name: string, type: 'file'|'directory', [key: string]: any}>>} 文件和目录列表
   */
  async listFiles(subDir = ".") {
    const globalMeta = await this._readGlobalMeta();
    const normalizedSubDir = subDir === "." ? "" : (subDir.replace(/\\/g, "/").endsWith("/") ? subDir.replace(/\\/g, "/") : subDir.replace(/\\/g, "/") + "/");
    
    const files = [];
    const dirs = new Set();

    for (const dirPath of Object.keys(globalMeta.directories || {})) {
      if (!dirPath.startsWith(normalizedSubDir)) continue;

      const relativePath = dirPath.slice(normalizedSubDir.length);
      if (!relativePath) continue;

      const slashIndex = relativePath.indexOf("/");
      if (slashIndex === -1) {
        dirs.add(relativePath);
      } else {
        dirs.add(relativePath.slice(0, slashIndex));
      }
    }
    
    for (const [filePath, info] of Object.entries(globalMeta.files)) {
      // 只处理以指定子目录开头的路径
      if (!filePath.startsWith(normalizedSubDir)) continue;
      
      // 获取相对于指定子目录的剩余路径
      const relativePath = filePath.slice(normalizedSubDir.length);
      if (!relativePath) continue;
      
      // 检查是否还有子目录层级
      const slashIndex = relativePath.indexOf("/");
      
      if (slashIndex === -1) {
        // 这是直接位于指定目录下的文件
        files.push(this._toFileEntry(filePath, info));
      } else {
        // 这是位于指定目录下某个子目录中的文件，提取子目录名
        const dirName = relativePath.slice(0, slashIndex);
        dirs.add(dirName);
      }
    }
    
    // 构建目录结果
    const dirResults = Array.from(dirs).map(dirName => ({
      name: dirName,
      type: 'directory'
    }));
    
    // 合并目录和文件，按名称排序
    return [...dirResults, ...files].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 获取工作区摘要信息
   * @returns {Promise<{fileCount: number, dirCount: number, totalSize: number, lastModified: string}>}
   */
  async getInfo() {
    const meta = await this._readGlobalMeta();
    let totalSize = 0;
    const files = Object.keys(meta.files);
    files.forEach(f => totalSize += (meta.files[f].size || 0));

    // 计算目录数
    const dirs = new Set();
    Object.keys(meta.directories || {}).forEach(dirPath => {
      dirs.add(dirPath.replace(/\\/g, "/"));
    });
    files.forEach(f => {
      const parts = f.split("/");
      // 如果文件在子目录下，每一级父目录都算一个目录
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    });

    // 同时检查是否存在空目录（不在全局元数据 files 中的目录）
    // 虽然目前 WorkspaceManager 主要跟踪有文件的路径，但为了准确性，
    // 我们在 sync 时其实可以记录所有目录。
    // 目前 getInfo 依赖 _readGlobalMeta，所以暂时只统计包含文件的目录。
    // 如果需要统计空目录，需要扩展 globalMeta 结构。

    return {
      fileCount: files.length,
      dirCount: dirs.size,
      totalSize,
      lastModified: meta.lastSync || new Date().toISOString()
    };
  }

  /**
   * 获取磁盘占用
   */
  async getDiskUsage() {
    return this.getInfo();
  }

  /**
   * 在指定子文件夹内搜索文本
   * @param {string} subDir - 子目录路径，相对于工作区根目录
   * @param {string} searchText - 要搜索的文本
   * @param {object} options - 可选参数 { caseSensitive, maxResults }
   * @returns {Promise<Array<{file: string, line: number, col: number}>>}
   */
  async searchText(subDir, searchText, options = {}) {
    if (!this._isPathSafe(subDir)) {
      throw new Error("path_traversal_blocked");
    }

    if (!searchText || typeof searchText !== "string") {
      throw new Error("invalid_search_text");
    }

    const { caseSensitive = true, maxResults = 1000 } = options;

    const results = [];
    const searchPattern = caseSensitive ? searchText : searchText.toLowerCase();

    // 辅助函数：在单个文件中搜索
    const searchInFile = async (fullPath, relPath) => {
      const content = await readFile(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        if (results.length >= maxResults) break;

        const line = lines[lineNum];
        const searchLine = caseSensitive ? line : line.toLowerCase();

        let matchIndex = searchLine.indexOf(searchPattern);
        while (matchIndex !== -1) {
          results.push({
            file: relPath.replace(/\\/g, "/"),
            line: lineNum + 1,
            col: matchIndex + 1
          });

          matchIndex = searchLine.indexOf(searchPattern, matchIndex + 1);

          if (results.length >= maxResults) break;
        }
      }
    };

    // 确定搜索目录
    const resolvedPath = subDir === "." ? this.rootPath : path.resolve(this.rootPath, subDir);

    // 检查路径是否存在
    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return [];
      }
      throw e;
    }

    // 如果路径是文件，仅搜索该文件
    if (stats.isFile()) {
      if (isTextFile(path.basename(resolvedPath))) {
        const relPath = path.relative(this.rootPath, resolvedPath);
        try {
          await searchInFile(resolvedPath, relPath);
        } catch (e) {
          // 跳过无法读取的文件
        }
      }
      return results;
    }

    // 如果路径不是目录，报错
    if (!stats.isDirectory()) {
      throw new Error("not_a_directory");
    }

    const searchDir = resolvedPath;

    // 递归扫描目录并搜索文本文件
    const searchInDirectory = async (dir, baseRelPath = "") => {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const relPath = baseRelPath ? path.join(baseRelPath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          // 跳过 .meta 和 .io 目录
          if (entry.name === ".meta" || entry.name === ".io" || entry.name === ".versions") continue;
          await searchInDirectory(path.join(dir, entry.name), relPath);
        } else {
          // 检查文件是否为文本文件
          if (!isTextFile(entry.name)) {
            continue;
          }

          try {
            const fullPath = path.join(dir, entry.name);
            await searchInFile(fullPath, relPath);
          } catch (e) {
            // 跳过无法读取的文件
            this.log.warn(`搜索文件失败: ${relPath}`, { error: e.message, stack: e.stack, name: e?.name, code: e?.code });
          }
        }
      }
    };

    await searchInDirectory(searchDir, subDir === "." ? "" : subDir);

    return results;
  }

  /**
   * 按行号范围读取文件内容
   * @param {string} relativePath
   * @param {object} options { start_line?, end_line? }
   * @returns {Promise<{lines: string[], start_line: number, end_line: number, total_lines: number}>}
   */
  async readLines(relativePath, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    const fullPath = path.resolve(this.rootPath, relativePath);
    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const startLine = Math.max(1, options.start_line || 1);
    const endLine = Math.min(totalLines, options.end_line || 500);

    if (startLine > totalLines) {
      return { lines: [], start_line: startLine, end_line: 0, total_lines: totalLines };
    }

    return {
      lines: lines.slice(startLine - 1, endLine),
      start_line: startLine,
      end_line: Math.min(endLine, totalLines),
      total_lines: totalLines
    };
  }

  /**
   * 在单个文件内搜索字符串或正则表达式
   * @param {string} relativePath
   * @param {string} pattern - 搜索文本或正则表达式
   * @param {object} options { is_regex?, max_results? }
   * @returns {Promise<{matches: Array<{line: number, col: number, text: string}>, count: number, pattern: string}>}
   */
  async searchInFile(relativePath, pattern, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    const { is_regex = false, max_results = 100 } = options;
    const fullPath = path.resolve(this.rootPath, relativePath);

    const content = await readFile(fullPath, "utf8");
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
          matches.push({
            line: lineNum + 1,
            col: m.index + 1,
            text: line
          });
          if (m[0].length === 0) searchRegex.lastIndex++;
        }
      } else {
        let index = line.indexOf(pattern);
        while (index !== -1) {
          if (matches.length >= max_results) break;
          matches.push({
            line: lineNum + 1,
            col: index + 1,
            text: line
          });
          index = line.indexOf(pattern, index + 1);
        }
      }
    }

    return { matches, count: matches.length, pattern };
  }

  /**
   * 获取文件的总行数
   * @param {string} relativePath
   * @returns {Promise<{path: string, lines: number}>}
   */
  async getLineCount(relativePath) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    const fullPath = path.resolve(this.rootPath, relativePath);
    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/).length;

    const normalized = relativePath.replace(/\\/g, "/");
    return { path: normalized, lines };
  }

  /**
   * 在文件内精确替换指定文本（借鉴 Claude Code Edit 工具设计）
   *
   * old_string 必须与文件中原始文本逐字符精确匹配（含空白和缩进）。
   * 默认要求 old_string 在文件中唯一，除非设置 replace_all。
   *
   * @param {string} relativePath
   * @param {object} options { old_string, new_string, replace_all? }
   * @returns {Promise<{ok: boolean, path: string, occurrences: number}>}
   */
  async editFile(relativePath, options = {}) {
    if (!this._isPathSafe(relativePath)) {
      throw new Error("path_traversal_blocked");
    }

    const { old_string, new_string, replace_all = false } = options;

    if (old_string === undefined || old_string === null) {
      throw new Error("editFile_missing_old_string");
    }

    if (!options.operator) {
      throw new Error(`editFile_missing_operator: ${relativePath}`);
    }
    if (!options.messageId) {
      throw new Error(`editFile_missing_messageId: ${relativePath}`);
    }

    const fullPath = path.resolve(this.rootPath, relativePath);
    const content = await readFile(fullPath, "utf8");

    let newContent;
    let count;

    if (replace_all) {
      count = content.split(old_string).length - 1;
      if (count === 0) throw new Error("old_string_not_found");
      newContent = content.replaceAll(old_string, new_string);
    } else {
      const index = content.indexOf(old_string);
      if (index === -1) throw new Error("old_string_not_found");
      const secondIndex = content.indexOf(old_string, index + old_string.length);
      if (secondIndex !== -1) throw new Error("multiple_matches");
      newContent = content.slice(0, index) + new_string + content.slice(index + old_string.length);
      count = 1;
    }

    // 通过 writeFile 写入，自动处理元数据、版本快照
    const result = await this.writeFile(relativePath, newContent, {
      operator: options.operator,
      messageId: options.messageId,
      mimeType: options.mimeType
    });

    return { ok: true, path: this._normalizeRelativePath(relativePath), occurrences: count, versionId: result.versionId };
  }

  /**
   * 同步外部变更
   */
  async sync() {
    await mkdir(this.rootPath, { recursive: true });
    const { files, directories } = await this._scanDirectoryEntries(this.rootPath);
    const newFiles = {};
    const newDirectories = {};
    const existingMeta = await this._readGlobalMetaSafely();

    for (const directoryRelativePath of directories) {
      const fullDirectoryPath = path.resolve(this.rootPath, directoryRelativePath);
      const directoryStats = await stat(fullDirectoryPath);
      const directoryKey = directoryRelativePath.replace(/\\/g, "/");

      const existingDirectoryInfo = existingMeta.directories[directoryKey] || {};
      newDirectories[directoryKey] = {
        type: "directory",
        updatedAt: directoryStats.mtime.toISOString(),
        lastOperator: existingDirectoryInfo.lastOperator || null,
        lastMessageId: existingDirectoryInfo.lastMessageId || null
      };
    }
    
    for (const f of files) {
      if (f.startsWith(".meta") || f.startsWith(".io") || f.startsWith(".versions")) continue;
      const fullPath = path.resolve(this.rootPath, f);
      const stats = await stat(fullPath);
      // 统一使用正斜杠作为 key
      const key = f.replace(/\\/g, "/");
      
      // 尝试从文件级元数据中读取 mimeType 和其他信息
      let mimeType = null;
      let lastOperator = null;
      let lastMessageId = null;
      
      try {
        const fileMetaPath = path.join(this.metaDir, key);
        if (existsSync(fileMetaPath)) {
          const metaContent = await readFile(fileMetaPath, "utf8");
          const fileMeta = JSON.parse(metaContent);
          // 优先使用元数据中存储的 mimeType
          if (fileMeta.mimeType) {
            mimeType = fileMeta.mimeType;
          }
          const lastRecord = fileMeta.history?.[fileMeta.history.length - 1];
          if (lastRecord) {
            lastOperator = lastRecord.operator;
            lastMessageId = lastRecord.messageId;
          }
        }
      } catch (e) { /* ignore recovery failure */ }
      
      // 如果元数据中没有 mimeType，则通过扩展名检测
      if (!mimeType) {
        mimeType = this._detectMimeType(key);
      }
      
      newFiles[key] = {
        type: 'file',
        size: stats.size,
        mimeType,
        updatedAt: stats.mtime.toISOString(),
        lastOperator,
        lastMessageId
      };
    }

    const meta = {
      id: this.id,
      lastSync: new Date().toISOString(),
      lastScan: new Date().toISOString(),
      files: newFiles,
      directories: newDirectories
    };

    await mkdir(this.metaDir, { recursive: true });
    await writeFile(this.globalMetaFile, JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * 递归扫描目录与文件。
   * 空目录也会被显式返回，用于在工作区全局元数据中持久化目录结构。
   */
  async _scanDirectoryEntries(dir, base = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    const directories = [];

    for (const entry of entries) {
      const relPath = base ? path.join(base, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".meta" || entry.name === ".io" || entry.name === ".versions") continue;
        directories.push(relPath.replace(/\\/g, "/"));
        const childEntries = await this._scanDirectoryEntries(path.join(dir, entry.name), relPath);
        files.push(...childEntries.files);
        directories.push(...childEntries.directories);
      } else {
        files.push(relPath.replace(/\\/g, "/"));
      }
    }

    return { files, directories };
  }

  /**
   * 读取全局元数据
   */
  async _readGlobalMeta() {
    try {
      const content = await readFile(this.globalMetaFile, "utf8");
      const meta = this._normalizeGlobalMeta(JSON.parse(content));
      // 如果文件列表为空，但目录确实存在，触发一次同步补偿
      if (Object.keys(meta.files).length === 0 && Object.keys(meta.directories).length === 0) {
        if (existsSync(this.rootPath)) {
          return await this.sync();
        }
      }
      // 检查是否有外部写入（磁盘变更未被元数据记录）
      if (await this._isStale(meta)) {
        return await this.sync();
      }
      return meta;
    } catch (e) {
      // 仅在文件不存在（初始化）时触发一次同步，之后完全依赖增量更新
      return await this.sync();
    }
  }

  /**
   * 容错读取全局元数据。
   * 同步流程需要读取旧目录信息，但不希望在缺少元数据时触发二次扫描。
   *
   * @returns {Promise<{id?: string, lastSync?: string, files: object, directories: object}>}
   */
  async _readGlobalMetaSafely() {
    try {
      const content = await readFile(this.globalMetaFile, "utf8");
      return this._normalizeGlobalMeta(JSON.parse(content));
    } catch {
      return this._normalizeGlobalMeta({});
    }
  }

  /**
   * 检查元数据是否过期（磁盘有未被元数据记录的变更）。
   *
   * 扫描工作区根目录的一级条目，取最大 mtimeMs。
   * 若最大值晚于 meta.lastScan，说明外部写入发生了，元数据可能过期。
   *
   * @param {object} meta
   * @returns {Promise<boolean>}
   */
  async _isStale(meta) {
    if (!meta.lastScan) return true;
    const lastScanTime = new Date(meta.lastScan).getTime();
    let maxMtime = 0;
    try {
      const entries = await readdir(this.rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".meta" || entry.name === ".io" || entry.name === ".versions") continue;
        try {
          const entryPath = path.join(this.rootPath, entry.name);
          const entryStat = await stat(entryPath);
          if (entryStat.mtimeMs > maxMtime) {
            maxMtime = entryStat.mtimeMs;
          }
        } catch (_e) {
          // 条目可能已被删除，跳过
        }
      }
    } catch (_e) {
      // 根目录读取出错，保守处理：不触发同步
      return false;
    }
    return maxMtime > lastScanTime;
  }

  /**
   * 规范化全局元数据结构。
   * 兼容旧版本只包含 files 的存储格式，避免目录新字段导致读取分支变复杂。
   *
   * @param {any} meta
   * @returns {{id?: string, lastSync?: string, files: object, directories: object}}
   */
  _normalizeGlobalMeta(meta) {
    const rawFiles = meta?.files && typeof meta.files === "object" ? meta.files : {};
    const directories = meta?.directories && typeof meta.directories === "object" ? meta.directories : {};

    const files = {};
    for (const key of Object.keys(rawFiles)) {
      const info = rawFiles[key];
      files[key] = {
        type: info?.type || "file",
        size: typeof info?.size === "number" ? info.size : 0,
        mimeType: info?.mimeType || this._detectMimeType(key) || "application/octet-stream",
        updatedAt: info?.updatedAt || new Date(0).toISOString(),
        lastOperator: info?.lastOperator || "unknown",
        lastMessageId: info?.lastMessageId || ""
      };
    }

    return { ...(meta || {}), files, directories };
  }

  /**
   * 将文件元数据映射为统一的文件条目对象。
   * 供 listFiles / getFileInfo / getAgentFiles 等内部方法复用。
   *
   * @param {string} filePath - 规范化后的文件相对路径
   * @param {object} info     - 全局元数据中的文件信息对象
   * @returns {{name: string, path: string, type: string, size: number, mimeType: string, extension: string, modifiedAt: string, lastOperator: string, lastMessageId: string}}
   */
  _toFileEntry(filePath, info) {
    return {
      name: path.basename(filePath),
      path: filePath,
      type: info.type,
      size: info.size,
      mimeType: info.mimeType,
      extension: path.extname(filePath).toLowerCase(),
      modifiedAt: info.updatedAt,
      lastOperator: info.lastOperator,
      lastMessageId: info.lastMessageId
    };
  }

  /**
   * 获取工作区摘要信息（名称、时间、文件统计）。
   * 替换原先在 HTTP 层重复的 _readGlobalMeta() + getDiskUsage() 模式。
   *
   * @returns {Promise<{name: string, createdAt: string, modifiedAt: string, fileCount: number, totalSize: number, metadata: object}>}
   */
  async getSummary() {
    const meta = await this._readGlobalMeta();
    const usage = await this.getDiskUsage();
    return {
      name: meta.name || this.id,
      createdAt: meta.createdAt || meta.lastSync,
      modifiedAt: meta.lastSync,
      fileCount: usage.fileCount,
      totalSize: usage.totalSize,
      metadata: meta
    };
  }

  /**
   * 获取完整的文件与目录列表（供 GET /api/workspaces/:id 使用）。
   *
   * @returns {Promise<{name: string, files: Array, directories: Array, tree: string[], fileCount: number, directoryCount: number, metadata: object}>}
   */
  async getFileListing() {
    const meta = await this._readGlobalMeta();
    const tree = await this.getTree();

    // 兼容旧数据：若 meta.directories 为空，从文件路径中自动发现目录
    let directoriesMeta = meta.directories || {};
    if (Object.keys(directoriesMeta).length === 0) {
      const dirSet = new Set();
      for (const filePath of Object.keys(meta.files || {})) {
        const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }
      }
      for (const dir of dirSet) {
        directoriesMeta[dir] = { type: 'directory', updatedAt: new Date().toISOString() };
      }
    }

    const files = Object.entries(meta.files)
      .filter(([filePath]) => !(filePath === '.versions' || filePath.startsWith('.versions/')))
      .map(([filePath, info]) => ({
        ...this._toFileEntry(filePath, info),
        createdAt: info.updatedAt,
        meta: info
      }));
    files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    const directories = Object.entries(directoriesMeta)
      .filter(([directoryPath]) => !(directoryPath === '.versions' || directoryPath.startsWith('.versions/')))
      .map(([directoryPath, info]) => ({
        name: directoryPath.split("/").pop(),
        path: directoryPath,
        modifiedAt: info.updatedAt
      }));
    directories.sort((a, b) => a.path.localeCompare(b.path));

    return {
      name: meta.name || this.id,
      files,
      directories,
      tree,
      fileCount: files.length,
      directoryCount: directories.length,
      metadata: meta
    };
  }

  /**
   * 组合搜索：按文件名 / 全文搜索工作区文件。
   * 替换原先在 HTTP 搜索路由中的内联搜索逻辑。
   *
   * @param {string}  query
   * @param {string}  [type="filename"] - "filename" | "fulltext"
   * @param {number}  [maxResults=200]
   * @returns {Promise<{results: Array, workspaceId: string, count: number}>}
   */
  async searchFiles(query, type = "filename", maxResults = 200) {
    const meta = await this._readGlobalMeta();
    const q = query.trim().toLowerCase();
    const results = [];

    // 文件名搜索
    const allFiles = Object.entries(meta.files || {})
      .filter(([filePath]) => !(filePath === '.versions' || filePath.startsWith('.versions/')))
      .map(([filePath, info]) =>
        this._toFileEntry(filePath, info)
      );
    const filenameMatches = allFiles.filter(f => f.name.toLowerCase().includes(q));
    for (const file of filenameMatches) {
      results.push({ ...file, matchType: "filename", matches: null });
    }

    // 全文搜索
    if (type === "fulltext" && q.length > 0) {
      try {
        const textResults = await this.searchText(".", query, { caseSensitive: false, maxResults });
        for (const r of textResults) {
          const existing = results.find(item => item.path === r.file && item.matchType === "filename");
          if (existing) {
            if (!existing.matches) existing.matches = [];
            existing.matches.push({ line: r.line, col: r.col });
            existing.matchType = "both";
          } else {
            const fileMeta = meta.files[r.file];
            if (fileMeta) {
              const entry = this._toFileEntry(r.file, fileMeta);
              results.push({
                ...entry,
                matchType: "content",
                matches: [{ line: r.line, col: r.col }]
              });
            }
          }
        }
      } catch (e) {
        // searchText already logs internally
      }
    }

    return {
      results: results.slice(0, maxResults),
      workspaceId: this.id,
      count: Math.min(results.length, maxResults)
    };
  }

  /**
   * 更新全局元数据
   */
  async _updateGlobalMeta(relativePath, info) {
    const meta = await this._readGlobalMeta();
    // 强制转换为正斜杠存储，确保 API 和 getTree 逻辑一致
    const key = relativePath.replace(/\\/g, "/");
    meta.files[key] = {
      ...(meta.files[key] || {}),
      ...info
    };
    meta.lastSync = new Date().toISOString();
    await mkdir(this.metaDir, { recursive: true });
    await writeFile(this.globalMetaFile, JSON.stringify(meta, null, 2));
  }

  /**
   * 更新目录到全局元数据。
   * 目录与文件分开存储，避免空目录在仅靠文件推断时被丢失。
   *
   * @param {string} relativePath
   * @param {object} info
   */
  async _updateDirectoryMeta(relativePath, info) {
    const meta = await this._readGlobalMeta();
    const key = relativePath.replace(/\\/g, "/");
    meta.directories[key] = {
      ...(meta.directories[key] || {}),
      ...info
    };
    meta.lastSync = new Date().toISOString();
    await mkdir(this.metaDir, { recursive: true });
    await writeFile(this.globalMetaFile, JSON.stringify(meta, null, 2));
  }

  /**
   * 从全局元数据中移除
   */
  async _removeFromGlobalMeta(relativePath) {
    const meta = await this._readGlobalMeta();
    const key = relativePath.replace(/\\/g, "/");
    delete meta.files[key];
    await writeFile(this.globalMetaFile, JSON.stringify(meta, null, 2));
  }

  /**
   * 读取文件级元数据
   */
  async readFileMeta(relativePath) {
    const fileMetaPath = path.join(this.metaDir, relativePath);
    try {
      const content = await readFile(fileMetaPath, "utf8");
      return JSON.parse(content);
    } catch (e) {
      return {
        path: relativePath,
        history: [],
        deleted: false
      };
    }
  }

  /**
   * 写入文件级元数据
   * @private
   */
  async _writeFileMeta(relativePath, meta) {
    const fileMetaPath = path.join(this.metaDir, relativePath);
    await mkdir(path.dirname(fileMetaPath), { recursive: true });
    await writeFile(fileMetaPath, JSON.stringify(meta, null, 2));
  }

  // ============================================================
  // Agent files 追踪（files.json）
  // ============================================================

  /**
   * 获取智能体的 files.json 文件路径
   * @param {string} agentId
   * @returns {string}
   * @private
   */
  _agentFilesPath(agentId) {
    return path.join(this._dataDir, "agents", String(agentId), "files.json");
  }

  /**
   * 读取智能体编辑过的文件列表
   * @param {string} agentId
   * @returns {Promise<{ editedFiles: string[] }>}
   */
  async readAgentFiles(agentId) {
    try {
      const content = await readFile(this._agentFilesPath(agentId), "utf8");
      return JSON.parse(content);
    } catch (e) {
      if (e.code === "ENOENT") {
        return { editedFiles: [] };
      }
      throw e;
    }
  }

  /**
   * 写入智能体的 files.json
   * @param {string} agentId
   * @param {{ editedFiles: string[] }} data
   * @returns {Promise<void>}
   * @private
   */
  async _writeAgentFiles(agentId, data) {
    const filePath = this._agentFilesPath(agentId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * 记录智能体对文件的写入操作。
   * 移除旧路径（去重），把最新文件插到 editedFiles 最前面。
   *
   * @param {string} agentId
   * @param {string} filePath
   * @returns {Promise<void>}
   * @private
   */
  async _recordAgentFileWrite(agentId, filePath) {
    const normalizedPath = this._normalizeRelativePath(filePath);
    const data = await this.readAgentFiles(agentId);
    // 移除旧路径（去重）
    data.editedFiles = data.editedFiles.filter(p => p !== normalizedPath);
    // 插入到最前面
    data.editedFiles.unshift(normalizedPath);
    await this._writeAgentFiles(agentId, data);
  }

  /**
   * 获取智能体编辑过的文件列表（供 API 使用）。
   * 从 files.json 读取路径列表，再从 globalMeta 获取文件的完整信息。
   *
   * @param {string} agentId
   * @returns {Promise<Array<{name: string, path: string, size: number, extension: string, modifiedAt: string, mimeType: string, lastOperator: string, lastMessageId: string}>>}
   */
  async getAgentFiles(agentId) {
    const data = await this.readAgentFiles(agentId);
    const meta = await this._readGlobalMeta();

    const files = data.editedFiles
      .map(filePath => {
        const key = filePath.replace(/\\/g, "/");
        const info = meta.files[key];
        if (!info) return null;
        return this._toFileEntry(filePath, info);
      })
      .filter(Boolean);

    return files;
  }
}
