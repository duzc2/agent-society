import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 自定义技能文件夹仓库。
 *
 * 责任：
 * 1. 管理 skills/custom 下的技能目录。
 * 2. 提供文件树、文件读写、目录复制等文件系统能力。
 */
export class CustomSkillRepository {
  /**
   * @param {{rootDir:string, logger?:any}} options
   */
  constructor(options) {
    this.rootDir = options.rootDir;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.customDir = path.join(this.rootDir, "custom");
  }

  /**
   * 初始化自定义技能目录。
   * @returns {Promise<void>}
   */
  async initialize() {
    await mkdir(this.customDir, { recursive: true });
  }

  /**
   * 返回自定义技能根目录。
   * @param {string} customSkillId
   * @returns {string}
   */
  getSkillDir(customSkillId) {
    return path.join(this.customDir, customSkillId);
  }

  /**
   * 创建空白自定义技能目录和 SKILL 模板。
   * @param {{customSkillId:string, displayName:string}} options
   * @returns {Promise<void>}
   */
  async createBlankSkill(options) {
    const skillDir = this.getSkillDir(options.customSkillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), this._buildSkillTemplate(options.displayName), "utf8");
  }

  /**
   * 从来源目录复制整个技能目录。
   * @param {{sourceDir:string, customSkillId:string, displayName:string, skillId:string}} options
   * @returns {Promise<void>}
   */
  async copySkillDirectory(options) {
    const targetDir = this.getSkillDir(options.customSkillId);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await cp(options.sourceDir, targetDir, { recursive: true, force: true });
    await this._rewriteCopiedSkillFiles({
      targetDir,
      skillId: options.skillId,
      displayName: options.displayName
    });
  }

  /**
   * 读取技能文件树。
   * @param {string} customSkillId
   * @returns {Promise<any[]>}
   */
  async readFileTree(customSkillId) {
    const skillDir = this.getSkillDir(customSkillId);
    if (!existsSync(skillDir)) {
      return [];
    }
    return this._scanDirectory(skillDir, "");
  }

  /**
   * 读取技能目录中的单个文本文件。
   * @param {string} customSkillId
   * @param {string} filePath
   * @returns {Promise<string|null>}
   */
  async readFile(customSkillId, filePath) {
    const resolved = this._resolveEntryPath(customSkillId, filePath);
    if (!existsSync(resolved)) {
      return null;
    }
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return null;
    }
    return readFile(resolved, "utf8");
  }

  /**
   * 创建空文件。
   * @param {string} customSkillId
   * @param {string} filePath
   * @returns {Promise<void>}
   */
  async createFile(customSkillId, filePath) {
    const resolved = this._resolveEntryPath(customSkillId, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    if (!existsSync(resolved)) {
      await writeFile(resolved, "", "utf8");
    }
  }

  /**
   * 创建子文件夹。
   * @param {string} customSkillId
   * @param {string} folderPath
   * @returns {Promise<void>}
   */
  async createFolder(customSkillId, folderPath) {
    const resolved = this._resolveEntryPath(customSkillId, folderPath);
    await mkdir(resolved, { recursive: true });
  }

  /**
   * 覆盖写入文件。
   * @param {string} customSkillId
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeFile(customSkillId, filePath, content) {
    const resolved = this._resolveEntryPath(customSkillId, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, String(content ?? ""), "utf8");
  }

  /**
   * 删除文件或目录。
   * @param {string} customSkillId
   * @param {string} entryPath
   * @returns {Promise<void>}
   */
  async deleteEntry(customSkillId, entryPath) {
    const resolved = this._resolveEntryPath(customSkillId, entryPath);
    await rm(resolved, { recursive: true, force: true });
  }

  /**
   * ?????????
   * @param {string} customSkillId
   * @param {string} fromPath
   * @param {string} toPath
   * @returns {Promise<void>}
   */
  async renameEntry(customSkillId, fromPath, toPath) {
    const fromResolved = this._resolveEntryPath(customSkillId, fromPath);
    const toResolved = this._resolveEntryPath(customSkillId, toPath);
    await mkdir(path.dirname(toResolved), { recursive: true });
    await rename(fromResolved, toResolved);
  }

  /**
   * 删除整个自定义技能目录。
   * @param {string} customSkillId
   * @returns {Promise<void>}
   */
  async deleteSkill(customSkillId) {
    const skillDir = this.getSkillDir(customSkillId);
    await rm(skillDir, { recursive: true, force: true });
  }

  /**
   * 递归扫描目录，生成前端可直接消费的树结构。
   * @param {string} absoluteDir
   * @param {string} relativeDir
   * @returns {Promise<any[]>}
   */
  async _scanDirectory(absoluteDir, relativeDir) {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const sortedEntries = [...entries].sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
    const result = [];
    for (const entry of sortedEntries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: relativePath,
          type: "directory",
          children: await this._scanDirectory(absolutePath, relativePath)
        });
        continue;
      }
      result.push({
        name: entry.name,
        path: relativePath,
        type: "file"
      });
    }
    return result;
  }

  /**
   * 规范化并校验目标路径，阻止跳出技能目录。
   * @param {string} customSkillId
   * @param {string} entryPath
   * @returns {string}
   */
  _resolveEntryPath(customSkillId, entryPath) {
    const skillDir = path.resolve(this.getSkillDir(customSkillId));
    const normalized = String(entryPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized) {
      throw new Error("invalid_entry_path");
    }
    const resolved = path.resolve(skillDir, normalized);
    if (!resolved.startsWith(skillDir)) {
      throw new Error("invalid_entry_path");
    }
    return resolved;
  }

  /**
   * 生成空白技能模板。
   * @param {string} displayName
   * @returns {string}
   */
  _buildSkillTemplate(displayName) {
    return [
      "---",
      `name: ${displayName}`,
      "description: 请填写技能描述",
      "---",
      "",
      `# ${displayName}`,
      "",
      "## 触发场景",
      "",
      "请填写这个技能适合处理的场景。",
      "",
      "## 执行规则",
      "",
      "请填写这个技能需要遵循的规则。"
    ].join("\n");
  }

  /**
   * 在复制后修正顶层常见文件中的技能标识和名称。
   * @param {{targetDir:string, skillId:string, displayName:string}} options
   * @returns {Promise<void>}
   */
  async _rewriteCopiedSkillFiles(options) {
    const skillMdPath = path.join(options.targetDir, "SKILL.md");
    if (existsSync(skillMdPath)) {
      const content = await readFile(skillMdPath, "utf8");
      const updated = this._rewriteSkillFrontmatter(content, options.displayName);
      await writeFile(skillMdPath, updated, "utf8");
    }

    const metadataPath = path.join(options.targetDir, "metadata.json");
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        const nextMetadata = {
          ...metadata,
          skillId: options.skillId,
          displayName: options.displayName,
          name: options.displayName
        };
        await writeFile(metadataPath, JSON.stringify(nextMetadata, null, 2), "utf8");
      } catch (error) {
        void this.log.warn("复制技能后更新 metadata.json 失败", {
          targetDir: options.targetDir,
          error: error?.message,
          stack: error?.stack
        });
      }
    }
  }

  /**
   * 更新或补齐 SKILL.md frontmatter 中的 name 字段。
   * @param {string} content
   * @param {string} displayName
   * @returns {string}
   */
  _rewriteSkillFrontmatter(content, displayName) {
    const text = String(content ?? "");
    const frontmatterMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!frontmatterMatch) {
      return [`---`, `name: ${displayName}`, `description: 请填写技能描述（任务目标和触发时机等）`, `---`, "", text].join("\n");
    }

    const lines = frontmatterMatch[1].split(/\r?\n/);
    let replaced = false;
    const nextLines = lines.map((line) => {
      if (!line.trim().startsWith("name:")) {
        return line;
      }
      replaced = true;
      return `name: ${displayName}`;
    });
    if (!replaced) {
      nextLines.unshift(`name: ${displayName}`);
    }
    return `---\n${nextLines.join("\n")}\n---\n\n${text.slice(frontmatterMatch[0].length)}`;
  }
}
