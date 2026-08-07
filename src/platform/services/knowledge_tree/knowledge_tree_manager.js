/**
 * KnowledgeTreeManager - 知识树管理器（数据层）
 *
 * 负责知识条目的文件系统 CRUD、INDEX.md 索引生成、搜索。
 * 树即文件系统，每个条目是一个 .md 文件（YAML frontmatter + Markdown 正文）。
 *
 * @module services/knowledge_tree/knowledge_tree_manager
 */

import path from "node:path";
import { mkdir, writeFile, readFile, access, unlink, rm, rename, stat, readdir } from "node:fs/promises";
import { load } from "js-yaml";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 文件名中不允许的字符，替换为 "_" */
const ILLEGAL_FILENAME_CHARS = /[\/\\:*?"<>|]/g;

/**
 * 安全化文件名，将非法字符替换为 "_"
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  return name.replace(ILLEGAL_FILENAME_CHARS, "_").trim();
}

/**
 * 规范化虚拟路径
 * - trim 首尾空格
 * - 拒绝 ".."（防目录穿越）
 * - "\" → "/"
 * - 确保以 "/" 开头
 * - 折叠连续 "/"
 * - 文件夹路径以 "/" 结尾（根目录 "/" 除外）
 *
 * @param {string} rawPath 原始路径
 * @param {boolean} [isFolder=false] 是否为文件夹路径
 * @returns {string} 规范化路径
 */
function normalizePath(rawPath, isFolder = false) {
  let p = rawPath.trim();
  if (p.includes("..")) {
    throw new Error("路径不允许包含 '..'");
  }
  p = p.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (isFolder && p !== "/" && !p.endsWith("/")) {
    p += "/";
  }
  return p;
}

/**
 * 拆分路径为段数组
 * @param {string} p
 * @returns {string[]}
 */
function splitPath(p) {
  return p.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);
}

/**
 * 获取父路径
 * @param {string} p
 * @returns {string}
 */
function parentPath(p) {
  p = p.replace(/\/$/, "");
  const idx = p.lastIndexOf("/");
  return idx === 0 ? "/" : p.slice(0, idx + 1);
}

/**
 * 获取路径末段名称
 * @param {string} p
 * @returns {string}
 */
function pathName(p) {
  return path.basename(p);
}

// ---------------------------------------------------------------------------
// YAML frontmatter 解析
// ---------------------------------------------------------------------------

/**
 * 读取并解析 .md 条目文件
 * @param {string} filePath 磁盘绝对路径
 * @returns {Promise<object>} { path, title, content, type, importance, status, sourceMessageIds }
 */
async function readEntryFile(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n");

  let frontmatterEnd = -1;
  let yamlText = "";

  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        frontmatterEnd = i;
        break;
      }
      yamlText += lines[i] + "\n";
    }
  }

  const meta = yamlText ? (load(yamlText) || {}) : {};
  const content = frontmatterEnd >= 0
    ? lines.slice(frontmatterEnd + 1).join("\n").trim()
    : raw.trim();

  return {
    title: pathName(filePath).replace(/\.md$/, ""),
    content,
    type: meta.type ?? null,
    importance: meta.importance ?? null,
    status: meta.status ?? "active",
    sourceMessageIds: Array.isArray(meta.sourceMessageIds) ? meta.sourceMessageIds : [],
  };
}

/**
 * 将 YAML frontmatter 序列化为字符串
 * @param {object} meta
 * @returns {string}
 */
function serializeFrontmatter(meta) {
  const lines = ["---"];
  if (meta.type != null) lines.push(`type: ${meta.type}`);
  if (meta.importance != null) lines.push(`importance: ${meta.importance}`);
  if (meta.status != null) lines.push(`status: ${meta.status}`);
  if (meta.sourceMessageIds?.length) {
    lines.push("sourceMessageIds:");
    for (const id of meta.sourceMessageIds) {
      lines.push(`  - ${id}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Manager 类
// ---------------------------------------------------------------------------

export class KnowledgeTreeManager {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    this.runtime = runtime;
    /** @type {object|null} */
    this._config = null;
    /** @type {string|null} */
    this._dataDir = null;
    /** @type {boolean} */
    this._initialized = false;
    /** @type {boolean} */
    this._autoCreateFolders = true;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  /**
   * 读取独立配置文件，初始化 Manager
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      const configPath = path.join(this.runtime.dataDir, "..", "config", "knowledge_tree.json");
      let config = {};
      try {
        const raw = await readFile(configPath, "utf-8");
        config = JSON.parse(raw);
      } catch {
        // 配置文件不存在，使用默认值
        this.runtime.log.info("[KnowledgeTreeManager] 配置文件不存在，使用默认值");
      }

      if (config.enabled === false) {
        this._config = null;
        this.runtime.log.info("[KnowledgeTreeManager] 知识树已禁用");
        return;
      }

      this._config = config;
      this._dataDir = path.join(this.runtime.dataDir, "agents");
      this._autoCreateFolders = config.autoCreateFolders !== false;
      await mkdir(this._dataDir, { recursive: true });
      this._initialized = true;
      this.runtime.log.info("[KnowledgeTreeManager] 初始化完成");
    } catch (err) {
      this._config = null;
      this.runtime.log.warn("[KnowledgeTreeManager] 初始化失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code });
    }
  }

  // -------------------------------------------------------------------------
  // 私有：路径映射
  // -------------------------------------------------------------------------

  /**
   * 虚拟路径 → 磁盘绝对路径
   * @param {string} agentId
   * @param {string} virtualPath 如 "/项目A/技术选型/数据库选型" 或 "/项目A/技术选型/"
   * @returns {string}
   */
  _entryPathToDiskPath(agentId, virtualPath) {
    const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
    const relative = virtualPath.replace(/^\//, "");
    // 文件夹以 "/" 结尾不加 .md, 条目加 .md
    const diskRelative = virtualPath.endsWith("/")
      ? relative
      : relative + ".md";
    const fullPath = path.resolve(baseDir, diskRelative);
    // 防路径穿越
    if (!fullPath.startsWith(path.resolve(baseDir))) {
      throw new Error("路径穿越拒绝");
    }
    return fullPath;
  }

  /**
   * 确保智能体的 knowledge-tree/ 目录存在
   * @param {string} agentId
   */
  async _ensureAgentDir(agentId) {
    const dirPath = path.join(this._dataDir, agentId, "knowledge-tree");
    await mkdir(dirPath, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // 公开：CRUD
  // -------------------------------------------------------------------------

  /**
   * 创建知识条目
   * @param {string} agentId
   * @param {{ path: string, title: string, content: string, type?: string, importance?: string, sourceMessageIds?: string[] }} params
   * @returns {Promise<{ ok: boolean, error?: string, path?: string, title?: string }>}
   */
  async createEntry(agentId, { path: p, title, content, type, importance, sourceMessageIds }) {
    try {
      this._ensureEnabled();

      // 校验
      if (!title || !title.trim()) return { ok: false, error: "标题不能为空" };
      if (!content) return { ok: false, error: "内容不能为空" };
      if (Buffer.byteLength(content, "utf-8") > 50 * 1024) return { ok: false, error: "内容超限（最大 50KB）" };
      const VALID_TYPES = new Set([null, "fact", "decision", "event", "knowledge", "summary", "action"]);
      if (type != null && !VALID_TYPES.has(type)) return { ok: false, error: `无效的类型: ${type}` };
      const VALID_IMPORTANCE = new Set([null, "high", "medium", "low"]);
      if (importance != null && !VALID_IMPORTANCE.has(importance)) return { ok: false, error: `无效的重要性: ${importance}` };

      await this._ensureAgentDir(agentId);

      const safeFileName = sanitizeFileName(title) + ".md";
      const parentPath = normalizePath(p ?? "/", true);
      const parentDiskPath = this._entryPathToDiskPath(agentId, parentPath);

      // 确保父目录存在
      try { await access(parentDiskPath); } catch {
        if (this._autoCreateFolders) {
          await mkdir(parentDiskPath, { recursive: true });
        } else {
          return { ok: false, error: "父路径不存在" };
        }
      }

      // 冲突检查
      const filePath = path.join(parentDiskPath, safeFileName);
      try { await access(filePath); return { ok: false, error: "条目已存在" }; } catch { /* ok */ }
      // 检查同名目录
      const dirConflict = path.join(parentDiskPath, sanitizeFileName(title));
      try { await stat(dirConflict); return { ok: false, error: "同名文件夹已存在" }; } catch { /* ok */ }

      const virtualPath = normalizePath(parentPath, false) + title;

      // 组装 .md 内容
      const frontmatter = serializeFrontmatter({
        type: type ?? null,
        importance: importance ?? null,
        status: "active",
        sourceMessageIds: sourceMessageIds ?? [],
      });
      await writeFile(filePath, frontmatter + "\n" + content, "utf-8");

      // 异步更新索引
      this._updateIndexCreateOrUpdate(agentId, virtualPath, title, type, importance, content).catch(err => {
        this.runtime.log.warn("[KnowledgeTreeManager] 索引更新失败", { agentId, path: virtualPath, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
      });

      return { ok: true, path: virtualPath, title, type: type ?? null, importance: importance ?? null };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] createEntry 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, title });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 获取条目
   * @param {string} agentId
   * @param {string} entryPath 虚拟路径
   * @returns {Promise<{ ok: boolean, error?: string, entry?: object }>}
   */
  async getEntry(agentId, entryPath) {
    try {
      this._ensureEnabled();
      let diskPath = this._entryPathToDiskPath(agentId, entryPath);
      try { await access(diskPath); } catch { return { ok: false, error: "条目不存在" }; }

      // 如果路径指向目录（以 "/" 结尾），则读取该目录下的 index.md
      const st = await stat(diskPath);
      if (st.isDirectory()) {
        diskPath = path.join(diskPath, "index.md");
        try { await access(diskPath); } catch { return { ok: false, error: "条目不存在（目录下缺少 index.md）" }; }
      }

      const entry = await readEntryFile(diskPath);
      entry.path = entryPath;
      return { ok: true, entry };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] getEntry 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, entryPath });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 更新条目
   * @param {string} agentId
   * @param {string} entryPath 虚拟路径
   * @param {{ title?: string, content?: string, type?: string, importance?: string }} params
   * @returns {Promise<{ ok: boolean, error?: string, path?: string, title?: string }>}
   */
  async updateEntry(agentId, entryPath, { title, content, type, importance }) {
    try {
      this._ensureEnabled();
      let diskPath = this._entryPathToDiskPath(agentId, entryPath);
      let entry;
      try {
        entry = await readEntryFile(diskPath);
      } catch {
        return { ok: false, error: "条目不存在" };
      }

      // 构造新内容
      const newTitle = title ?? entry.title;
      const newContent = content ?? entry.content;
      const newType = type !== undefined ? type : entry.type;
      const newImportance = importance !== undefined ? importance : entry.importance;

      const frontmatter = serializeFrontmatter({
        type: newType,
        importance: newImportance,
        status: entry.status,
        sourceMessageIds: entry.sourceMessageIds,
      });
      const mdContent = frontmatter + "\n" + newContent;

      // 标题变化 → 重命名文件
      if (title != null && title !== entry.title) {
        const dir = path.dirname(diskPath);
        const newDiskPath = path.join(dir, sanitizeFileName(newTitle) + ".md");
        try { await access(newDiskPath); return { ok: false, error: "目标文件名已存在" }; } catch { /* ok */ }
        await rename(diskPath, newDiskPath);
        diskPath = newDiskPath;
        await writeFile(diskPath, mdContent, "utf-8");
      } else {
        await writeFile(diskPath, mdContent, "utf-8");
      }

      const newVirtualPath = parentPath(entryPath) + newTitle;

      // 异步更新索引
      this._updateIndexCreateOrUpdate(agentId, newVirtualPath, newTitle, newType, newImportance, newContent).catch(err => {
        this.runtime.log.warn("[KnowledgeTreeManager] 索引更新失败", { agentId, path: newVirtualPath, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
      });

      return { ok: true, path: newVirtualPath, title: newTitle };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] updateEntry 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, entryPath });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 删除条目或文件夹
   * @param {string} agentId
   * @param {string} entryPath 虚拟路径
   * @param {boolean} [recursive=false]
   * @returns {Promise<{ ok: boolean, error?: string, deletedCount?: number }>}
   */
  async deleteNode(agentId, entryPath, recursive = false) {
    try {
      this._ensureEnabled();
      if (entryPath === "/") return { ok: false, error: "不能删除根目录" };

      const diskPath = this._entryPathToDiskPath(agentId, entryPath);
      let isDir;
      try {
        const s = await stat(diskPath);
        isDir = s.isDirectory();
      } catch {
        return { ok: false, error: "路径不存在" };
      }

      let deletedCount = 1;
      if (isDir) {
        if (!recursive) {
          const entries = await readdir(diskPath);
          if (entries.length > 0) return { ok: false, error: "文件夹非空，需要 recursive=true" };
        }
        // 计数 .md 文件数
        if (recursive) {
          deletedCount = await this._countMdFiles(diskPath);
        }
        await rm(diskPath, { recursive: true, force: true });
      } else {
        await unlink(diskPath);
      }

      // 异步更新索引
      this._updateIndexDelete(agentId, entryPath).catch(err => {
        this.runtime.log.warn("[KnowledgeTreeManager] 索引删除更新失败", { agentId, path: entryPath, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
      });

      return { ok: true, deletedCount };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] deleteNode 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, entryPath });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 移动条目或文件夹
   * @param {string} agentId
   * @param {string} sourcePath 源虚拟路径
   * @param {string} targetPath 目标虚拟路径（父文件夹）
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async moveNode(agentId, sourcePath, targetPath) {
    try {
      this._ensureEnabled();
      const srcDiskPath = this._entryPathToDiskPath(agentId, sourcePath);
      try { await stat(srcDiskPath); } catch { return { ok: false, error: "源路径不存在" }; }

      const targetParentPath = normalizePath(targetPath, true);
      const targetParentDisk = this._entryPathToDiskPath(agentId, targetParentPath);

      // 确保目标父目录存在
      try { await access(targetParentDisk); } catch {
        if (this._autoCreateFolders) {
          await mkdir(targetParentDisk, { recursive: true });
        } else {
          return { ok: false, error: "目标父路径不存在" };
        }
      }

      const srcName = path.basename(srcDiskPath);
      const targetDiskPath = path.join(targetParentDisk, srcName);
      try { await access(targetDiskPath); return { ok: false, error: "目标路径已存在" }; } catch { /* ok */ }

      await rename(srcDiskPath, targetDiskPath);

      // 全量重建索引
      this._rebuildIndex(agentId).catch(err => {
        this.runtime.log.warn("[KnowledgeTreeManager] 移动后索引重建失败", { agentId, error: err.message, stack: err.stack, name: err?.name, code: err?.code });
      });

      return { ok: true, sourcePath, targetPath };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] moveNode 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, sourcePath, targetPath });
      return { ok: false, error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // 公开：搜索
  // -------------------------------------------------------------------------

  /**
   * 搜索知识树
   * @param {string} agentId
   * @param {{ query?: string, type?: string, importance?: string, status?: string }} filters
   * @returns {Promise<{ ok: boolean, error?: string, results?: object[], count?: number }>}
   */
  async search(agentId, { query, type, importance, status } = {}) {
    try {
      this._ensureEnabled();
      const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
      const indexPath = path.join(baseDir, "INDEX.md");

      let results = [];
      try {
        const indexContent = await readFile(indexPath, "utf-8");
        results = this._searchInIndex(indexContent, query, type, importance);
      } catch {
        // INDEX.md 不存在，尝试全文搜索
      }

      // 状态过滤需要读文件
      if (status != null) {
        results = await this._filterByStatus(baseDir, results, status);
      }

      // fallback 全文搜索
      if (!query && !type && !importance && results.length === 0) {
        // 无过滤条件时返回空
      }
      if (query && (results.length === 0 || results.length < 3)) {
        const fullResults = await this._fullTextSearch(agentId, query);
        // 合并去重
        const paths = new Set(results.map(r => r.path));
        for (const fr of fullResults) {
          if (!paths.has(fr.path)) {
            results.push(fr);
            paths.add(fr.path);
          }
        }
      }

      // 过滤
      if (type) results = results.filter(r => r.type === type);
      if (importance) results = results.filter(r => r.importance === importance);

      return { ok: true, results, count: results.length };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] search 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId, filters: { query, type, importance, status } });
      return { ok: false, error: err.message, results: [], count: 0 };
    }
  }

  /**
   * 在 INDEX.md 内容中搜索
   * @param {string} indexContent
   * @param {string} [query]
   * @param {string} [type]
   * @param {string} [importance]
   * @returns {object[]}
   */
  _searchInIndex(indexContent, query, type, importance) {
    const results = [];
    const lines = indexContent.split("\n");
    let currentGroup = "/";

    for (const line of lines) {
      const groupMatch = line.match(/^##\s+(.+)/);
      if (groupMatch) {
        currentGroup = groupMatch[1].trim();
        continue;
      }

      const entryMatch = line.match(/^-\s+\*\*(.+?)\*\*\s+\[(\w+)\]\s+(\[(\w+)\]\s+)?(.+)$/);
      if (!entryMatch) continue;

      const title = entryMatch[1];
      const entryType = entryMatch[2];
      const entryImportance = entryMatch[4] ?? null;
      const description = entryMatch[5];

      if (type && entryType !== type) continue;
      if (importance && entryImportance !== importance) continue;
      if (query) {
        const q = query.toLowerCase();
        if (!title.toLowerCase().includes(q) && !description.toLowerCase().includes(q)) continue;
      }

      results.push({
        path: currentGroup + title,
        title,
        type: entryType,
        importance: entryImportance,
        confidence: query ? 0.9 : 1,
      });
    }

    return results;
  }

  /**
   * 按状态过滤结果（需要读取 .md 文件）
   */
  async _filterByStatus(baseDir, results, status) {
    const filtered = [];
    for (const r of results) {
      try {
        const diskPath = path.join(baseDir, r.path.replace(/^\//, "") + ".md");
        const entry = await readEntryFile(diskPath);
        if (entry.status === status) filtered.push(r);
      } catch { /* skip */ }
    }
    return filtered;
  }

  /**
   * 递归遍历 .md 文件进行全文搜索
   * @param {string} agentId
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  async _fullTextSearch(agentId, query) {
    const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
    const results = [];
    const q = query.toLowerCase();

    try {
      const allFiles = await readdir(baseDir, { recursive: true });
      const mdFiles = allFiles
        .filter(f => f.endsWith(".md") && f !== "INDEX.md")
        .map(f => path.join(baseDir, f));

      for (const filePath of mdFiles) {
        try {
          const entry = await readEntryFile(filePath);
          const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/").replace(/\.md$/, "");
          const virtualPath = "/" + relativePath;

          if (entry.title.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q)) {
            // 摘取 snippet
            const idx = entry.content.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 40);
            const snippet = (start > 0 ? "..." : "") + entry.content.slice(start, start + 120) + "...";

            results.push({
              path: virtualPath,
              title: entry.title,
              type: entry.type,
              importance: entry.importance,
              status: entry.status,
              confidence: entry.title.toLowerCase().includes(q) ? 0.7 : 0.5,
              snippet,
            });
          }
        } catch { /* skip corrupted files */ }
      }
    } catch { /* baseDir may not exist */ }

    return results;
  }

  /**
   * 递归计数目录下 .md 文件数
   */
  async _countMdFiles(dirPath) {
    let count = 0;
    try {
      const entries = await readdir(dirPath, { recursive: true });
      count = entries.filter(f => f.endsWith(".md") && f !== "INDEX.md").length;
    } catch { /* ignore */ }
    return count;
  }

  // -------------------------------------------------------------------------
  // 公开：获取完整树结构
  // -------------------------------------------------------------------------

  /**
   * 遍历文件系统，构建树结构（供前端 API）
   * @param {string} agentId
   * @returns {Promise<{ ok: boolean, error?: string, tree?: object }>}
   */
  async listTree(agentId) {
    try {
      this._ensureEnabled();
      const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
      const root = { name: "/", isFolder: true, children: [] };
      await this._walkDir(baseDir, "", root);
      return { ok: true, tree: root };
    } catch (err) {
      this.runtime.log.warn("[KnowledgeTreeManager] listTree 失败", { error: err.message, stack: err.stack, name: err?.name, code: err?.code, agentId });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 递归遍历目录
   */
  async _walkDir(baseDir, relativePath, parentNode) {
    const currentPath = path.join(baseDir, relativePath);
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of entries) {
      if (dirent.name === "INDEX.md" || dirent.name === "_extraction_state.json") continue;

      if (dirent.isDirectory()) {
        const folderNode = { name: dirent.name, isFolder: true, children: [] };
        parentNode.children.push(folderNode);
        await this._walkDir(baseDir, path.join(relativePath, dirent.name), folderNode);
      } else if (dirent.name.endsWith(".md")) {
        const filePath = path.join(currentPath, dirent.name);
        try {
          const entry = await readEntryFile(filePath);
          parentNode.children.push({
            name: entry.title,
            isFolder: false,
            type: entry.type,
            importance: entry.importance,
            status: entry.status,
            content: entry.content,
            sourceMessageIds: entry.sourceMessageIds,
          });
        } catch {
          parentNode.children.push({ name: dirent.name.replace(/\.md$/, ""), isFolder: false });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 索引生成
  // -------------------------------------------------------------------------

  /**
   * 创建或更新 INDEX.md 中某个条目的行
   */
  async _updateIndexCreateOrUpdate(agentId, entryPath, title, type, importance, content) {
    const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
    const indexPath = path.join(baseDir, "INDEX.md");
    const folderPath = parentPath(entryPath);

    // 获取话题描述（LLM）
    let description;
    try {
      description = await this._generateIndexDescription(title, content);
    } catch {
      description = title; // fallback
    }

    let indexContent = "# 知识树索引\n\n";
    try {
      indexContent = await readFile(indexPath, "utf-8");
    } catch { /* 新建 */ }

    const entryLine = `- **${title}** [${type ?? "-"}] [${importance ?? "-"}] ${description}`;

    // 在对应分组下更新
    const MAX_INDEX_LINES = 100_000;
    const lines = indexContent.split("\n");
    if (lines.length > MAX_INDEX_LINES) {
      throw new Error(`INDEX.md 行数 (${lines.length}) 超出上限 (${MAX_INDEX_LINES})，请检查文件是否异常`);
    }
    const newLines = [];
    let inTargetGroup = false;
    let groupInserted = false;
    let existingEntryIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## " + folderPath)) {
        inTargetGroup = true;
        groupInserted = true;
        newLines.push(line);

        // 查找该分组下是否已有同名条目
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith("## ") || j === lines.length - 1) break;
          if (lines[j].includes(`**${title}**`)) {
            existingEntryIdx = j;
            break;
          }
        }

        if (existingEntryIdx > 0) {
          // 替换已有行
          for (let k = i + 1; k < existingEntryIdx; k++) {
            const l = lines[k];
            if (l.trim()) newLines.push(l);
          }
          newLines.push(entryLine);
          // 跳过原行
          i = existingEntryIdx;
          continue;
        }
        continue;
      }

      if (inTargetGroup && (line.startsWith("## ") || i === lines.length - 1)) {
        if (!groupInserted || existingEntryIdx < 0) {
          newLines.push(entryLine);
        }
        inTargetGroup = false;
      }

      if (i === existingEntryIdx) continue; // 跳过被替换的旧行

      newLines.push(line);
    }

    // 分组不存在则追加
    if (!groupInserted) {
      if (newLines[newLines.length - 1]?.trim()) newLines.push("");
      newLines.push(`## ${folderPath}`);
      newLines.push(entryLine);
    }

    await writeFile(indexPath, newLines.join("\n"), "utf-8");
  }

  /**
   * 从 INDEX.md 删除条目行
   */
  async _updateIndexDelete(agentId, entryPath) {
    const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
    const indexPath = path.join(baseDir, "INDEX.md");

    let indexContent;
    try {
      indexContent = await readFile(indexPath, "utf-8");
    } catch {
      return;
    }

    const title = pathName(entryPath);
    const folderPath = parentPath(entryPath);
    const lines = indexContent.split("\n");
    const newLines = [];

    let inTargetGroup = false;
    let groupHeaderIdx = -1;
    let groupHasOtherEntries = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line === `## ${folderPath}`) {
        inTargetGroup = true;
        groupHeaderIdx = newLines.length;
        newLines.push(line);
        continue;
      }

      if (inTargetGroup && line.startsWith("## ")) {
        inTargetGroup = false;
        if (!groupHasOtherEntries && groupHeaderIdx >= 0) {
          // 移除空分组标题
          newLines.splice(groupHeaderIdx, 1);
        }
        newLines.push(line);
        continue;
      }

      if (inTargetGroup && line.includes(`**${title}**`)) {
        continue; // 删除此行
      }

      if (inTargetGroup && line.startsWith("- **")) {
        groupHasOtherEntries = true;
      }

      newLines.push(line);
    }

    // 处理最后一组
    if (inTargetGroup && !groupHasOtherEntries && groupHeaderIdx >= 0) {
      newLines.splice(groupHeaderIdx, 1);
    }

    await writeFile(indexPath, newLines.join("\n"), "utf-8");
  }

  /**
   * 全量重建 INDEX.md
   */
  async _rebuildIndex(agentId) {
    const baseDir = path.join(this._dataDir, agentId, "knowledge-tree");
    const indexPath = path.join(baseDir, "INDEX.md");

    // 收集所有条目按文件夹分组
    const groups = new Map();
    try {
      const allFiles = await readdir(baseDir, { recursive: true });
      const mdFiles = allFiles
        .filter(f => f.endsWith(".md") && f !== "INDEX.md")
        .map(f => path.join(baseDir, f));

      for (const filePath of mdFiles) {
        try {
          const entry = await readEntryFile(filePath);
          const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/").replace(/\.md$/, "");
          const fullPath = "/" + relativePath;
          const folder = parentPath(fullPath);

          if (!groups.has(folder)) groups.set(folder, []);
          groups.get(folder).push({
            title: entry.title,
            type: entry.type ?? "-",
            importance: entry.importance ?? "-",
            // 不重新生成描述，保留原标题作为描述
            description: entry.title,
          });
        } catch { /* skip */ }
      }
    } catch { /* empty */ }

    const lines = ["# 知识树索引", ""];
    const sortedFolders = [...groups.keys()].sort();
    for (const folder of sortedFolders) {
      lines.push(`## ${folder}`);
      for (const e of groups.get(folder)) {
        lines.push(`- **${e.title}** [${e.type}] [${e.importance}] ${e.description}`);
      }
      lines.push("");
    }

    await writeFile(indexPath, lines.join("\n"), "utf-8");
  }

  /**
   * 调用 LLM 生成条目的话题描述
   */
  async _generateIndexDescription(title, content) {
    const llmClient = await this._getLlmForIndex();
    if (!llmClient) return title;

    const prompt = `请为以下知识条目生成一句话话题描述（只描述涉及什么话题，不描述具体结论和原因）：\n标题：${title}\n内容：${content}`;
    const resp = await llmClient.chat({
      messages: [{ role: "user", content: prompt }],
    });

    return (resp?.content ?? title).trim();
  }

  /**
   * 获取索引生成的 LLM 客户端
   */
  async _getLlmForIndex() {
    try {
      const services = (await this.runtime.llmServiceRegistry?.getServices?.()) ?? [];
      const match = services.find(s =>
        s.capabilityTags?.some(tag => tag === "摘要" || tag === "summarization")
      );
      if (match) {
        return await this.runtime.getLlmClientForService?.(match.id);
      }
    } catch { /* fallback */ }
    return this.runtime.llm ?? null;
  }

  // -------------------------------------------------------------------------
  // 私有：辅助
  // -------------------------------------------------------------------------

  /** @throws 如果尚未初始化或已禁用 */
  _ensureEnabled() {
    if (!this._initialized || !this._config) {
      throw new Error("知识树未启用或未初始化");
    }
  }
}
