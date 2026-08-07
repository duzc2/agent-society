import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Git 技能仓库。
 *
 * 责任：
 * 1. 管理 skills/git 下的从 git 仓库导入的技能目录。
 * 2. 提供文件树、文件读取等文件系统能力。
 * 3. 维护每个 git 技能的元信息（来源地址、分支、commit 等）。
 */
export class GitSkillRepository {
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
    this.gitDir = path.join(this.rootDir, "git");
  }

  /**
   * 初始化 git 技能目录。
   * @returns {Promise<void>}
   */
  async initialize() {
    await mkdir(this.gitDir, { recursive: true });
  }

  /**
   * 返回 git 技能根目录。
   * @param {string} gitSkillId
   * @returns {string}
   */
  getSkillDir(gitSkillId) {
    return path.join(this.gitDir, gitSkillId);
  }

  /**
   * 读取 git 技能元信息。
   * @param {string} gitSkillId
   * @returns {Promise<any|null>}
   */
  async readMeta(gitSkillId) {
    const metaPath = path.join(this.getSkillDir(gitSkillId), ".git-skill.json");
    if (!existsSync(metaPath)) {
      return null;
    }
    try {
      return JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 写入 git 技能元信息。
   * @param {string} gitSkillId
   * @param {any} meta
   * @returns {Promise<void>}
   */
  async writeMeta(gitSkillId, meta) {
    const skillDir = this.getSkillDir(gitSkillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, ".git-skill.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );
  }

  /**
   * 读取技能文件树。
   * @param {string} gitSkillId
   * @returns {Promise<any[]>}
   */
  async readFileTree(gitSkillId) {
    const skillDir = this.getSkillDir(gitSkillId);
    if (!existsSync(skillDir)) {
      return [];
    }
    return this._scanDirectory(skillDir, "");
  }

  /**
   * 读取技能目录中的单个文本文件。
   * @param {string} gitSkillId
   * @param {string} filePath
   * @returns {Promise<string|null>}
   */
  async readFile(gitSkillId, filePath) {
    const resolved = this._resolveEntryPath(gitSkillId, filePath);
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
   * 删除整个 git 技能目录。
   * @param {string} gitSkillId
   * @returns {Promise<void>}
   */
  async deleteSkill(gitSkillId) {
    const skillDir = this.getSkillDir(gitSkillId);
    await rm(skillDir, { recursive: true, force: true });
  }

  /**
   * 递归扫描目录，生成前端可直接消费的树结构。
   * 过滤掉 .git 目录和 .git-skill.json 元信息文件。
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
      // 过滤 .git 目录
      if (entry.name === ".git") {
        continue;
      }
      // 过滤元信息文件
      if (entry.name === ".git-skill.json" && !relativeDir) {
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
   * @param {string} gitSkillId
   * @param {string} entryPath
   * @returns {string}
   */
  _resolveEntryPath(gitSkillId, entryPath) {
    const skillDir = path.resolve(this.getSkillDir(gitSkillId));
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
}
