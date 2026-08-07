import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { GitSkillRepository } from "./git_skill_repository.js";

/**
 * Git 技能导入服务。
 *
 * 责任：
 * 1. 通过 git clone 从远程仓库导入技能。
 * 2. 管理 git 导入技能的启停、删除。
 * 3. 维护 git 技能在技能索引中的记录。
 * 4. 支持更新（pull）已导入的技能。
 */
export class GitSkillService {
  /**
   * @param {{rootDir:string, skillsRepository:any, logger?:any}} options
   */
  constructor(options) {
    this.rootDir = options.rootDir;
    this.skillsRepository = options.skillsRepository;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.repository = new GitSkillRepository({
      rootDir: this.rootDir,
      logger: this.log
    });
  }

  /**
   * 初始化目录。
   * @returns {Promise<void>}
   */
  async initialize() {
    await this.repository.initialize();
  }

  /**
   * 列出所有 git 导入技能。
   * @returns {Promise<any[]>}
   */
  async listGitSkills() {
    const records = await this.skillsRepository.listKnownSkills();
    return records
      .filter((record) => record.sourceType === "git")
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "zh-CN"));
  }

  /**
   * 从 git 地址导入技能。
   * @param {{gitUrl:string, branch?:string, subDir?:string, displayName?:string}} payload
   * @returns {Promise<any>}
   */
  async importFromGit(payload) {
    const gitUrl = String(payload?.gitUrl ?? "").trim();
    if (!gitUrl) {
      throw new Error("missing_git_url");
    }

    // 检查是否已导入同一个 git 地址
    const existing = await this._findByGitUrl(gitUrl);
    if (existing) {
      throw new Error("git_skill_already_exists");
    }

    const gitSkillId = randomUUID();
    const skillId = this._buildSkillId(gitSkillId);
    const branch = payload.branch || "";
    const subDir = payload.subDir || "";
    const displayName = payload.displayName || this._extractRepoName(gitUrl);

    // 直接在最终技能目录中 clone，不需要临时目录和复制过程
    const targetDir = this.repository.getSkillDir(gitSkillId);
    await this._gitClone(gitUrl, branch, targetDir);

    // 验证 SKILL.md 存在（考虑 subDir）
    const skillMdPath = subDir ? path.join(targetDir, subDir, "SKILL.md") : path.join(targetDir, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      const errorDir = subDir ? path.join(targetDir, subDir) : targetDir;
      if (subDir && !existsSync(errorDir)) {
        throw new Error("git_subdir_not_found");
      }
      throw new Error("git_skill_md_not_found");
    }

    // 获取 commit 信息（直接从技能目录读取）
    const commitInfo = await this._getCommitInfo(targetDir);

    // 写入元信息
    const meta = {
      gitUrl,
      branch,
      subDir,
      commitId: commitInfo.commitId,
      commitDate: commitInfo.commitDate,
      importedAt: new Date().toISOString()
    };
    await this.repository.writeMeta(gitSkillId, meta);

    // 从 SKILL.md 读取 description
    const description = await this._readSkillDescription(gitSkillId);
    const packageFiles = await this._collectPackageFiles(gitSkillId);

    // 注册到技能索引
    const record = await this.skillsRepository.saveSkillRecord(this._buildRecord({
      gitSkillId,
      skillId,
      displayName,
      description,
      packageFiles,
      gitUrl,
      branch,
      commitId: commitInfo.commitId,
      status: "disabled"
    }));

    return {
      skill: record,
      tree: await this.repository.readFileTree(gitSkillId)
    };
  }

  /**
   * 更新（pull）git 技能。
   * @param {string} skillId
   * @returns {Promise<any>}
   */
  async updateGitSkill(skillId) {
    const record = await this._requireGitSkillRecord(skillId);
    const meta = await this.repository.readMeta(record.gitSkillId);
    if (!meta) {
      throw new Error("git_skill_meta_not_found");
    }

    // 在技能目录内执行 git pull
    const skillDir = this.repository.getSkillDir(record.gitSkillId);
    await this._gitPull(skillDir);

    // 获取最新 commit 信息
    const commitInfo = await this._getCommitInfo(skillDir);
    const updatedMeta = {
      ...meta,
      commitId: commitInfo.commitId,
      commitDate: commitInfo.commitDate,
      updatedAt: new Date().toISOString()
    };
    await this.repository.writeMeta(record.gitSkillId, updatedMeta);

    // 更新索引
    const description = await this._readSkillDescription(record.gitSkillId);
    const packageFiles = await this._collectPackageFiles(record.gitSkillId);
    return this.skillsRepository.saveSkillRecord({
      ...record,
      description: description || record.description,
      packageFiles,
      hasScripts: packageFiles.some((item) => item.startsWith("scripts/")),
      scriptEntries: packageFiles.filter((item) => item.startsWith("scripts/")),
      hasResources: packageFiles.some((item) => item.startsWith("resources/")),
      commitId: commitInfo.commitId,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * 获取 git 技能详情和文件树。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getGitSkill(skillId) {
    const record = await this._getGitSkillRecord(skillId);
    if (!record) {
      return null;
    }
    return {
      skill: record,
      tree: await this.repository.readFileTree(record.gitSkillId),
      meta: await this.repository.readMeta(record.gitSkillId)
    };
  }

  /**
   * 读取 git 技能单个文件。
   * @param {string} skillId
   * @param {string} filePath
   * @returns {Promise<any|null>}
   */
  async readGitSkillFile(skillId, filePath) {
    const record = await this._getGitSkillRecord(skillId);
    if (!record) {
      return null;
    }
    const content = await this.repository.readFile(record.gitSkillId, filePath);
    if (content === null) {
      return null;
    }
    return {
      path: filePath,
      content,
      updatedAt: record.updatedAt
    };
  }

  /**
   * 更新启停状态。
   * @param {string} skillId
   * @param {'enabled'|'disabled'} status
   * @returns {Promise<any>}
   */
  async setGitSkillStatus(skillId, status) {
    const record = await this._requireGitSkillRecord(skillId);
    const normalizedStatus = status === "enabled" ? "enabled" : "disabled";
    return this.skillsRepository.saveSkillRecord({
      ...record,
      status: normalizedStatus,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * 删除整个 git 技能。
   * @param {string} skillId
   * @returns {Promise<boolean>}
   */
  async deleteGitSkill(skillId) {
    const record = await this._getGitSkillRecord(skillId);
    if (!record) {
      return false;
    }
    await this.repository.deleteSkill(record.gitSkillId);
    await this.skillsRepository.deleteSkillRecord(skillId);
    return true;
  }

  /**
   * 执行 git clone。
   * @param {string} gitUrl
   * @param {string} branch
   * @param {string} targetDir
   * @returns {Promise<void>}
   */
  async _gitClone(gitUrl, branch, targetDir) {
    const args = ["clone", "--depth", "1"];
    if (branch) {
      args.push("--branch", branch);
    }
    args.push(gitUrl, targetDir);

    await this._execGit(args, { cwd: path.dirname(targetDir) });
  }

  /**
   * 执行 git pull。
   * @param {string} repoDir
   * @returns {Promise<void>}
   */
  async _gitPull(repoDir) {
    // 浅克隆仓库用 fetch + reset 代替 pull
    await this._execGit(["fetch", "--depth", "1", "origin"], { cwd: repoDir });
    await this._execGit(["reset", "--hard", "FETCH_HEAD"], { cwd: repoDir });
  }

  /**
   * 获取当前 commit 信息。
   * @param {string} repoDir
   * @returns {Promise<{commitId:string, commitDate:string}>}
   */
  async _getCommitInfo(repoDir) {
    try {
      const commitId = await this._execGit(["rev-parse", "HEAD"], { cwd: repoDir });
      const commitDate = await this._execGit(["log", "-1", "--format=%ci"], { cwd: repoDir });
      return {
        commitId: (commitId || "").trim(),
        commitDate: (commitDate || "").trim()
      };
    } catch {
      return { commitId: "unknown", commitDate: "" };
    }
  }

  /**
   * 执行 git 命令。
   * @param {string[]} args
   * @param {{cwd:string}} options
   * @returns {Promise<string>}
   */
  async _execGit(args, options) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: options.cwd, timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || error.message || "git command failed";
          reject(new Error(`git_error: ${message}`));
          return;
        }
        resolve(stdout || "");
      });
    });
  }

  /**
   * 通过 git 地址查找已导入的技能。
   * @param {string} gitUrl
   * @returns {Promise<any|null>}
   */
  async _findByGitUrl(gitUrl) {
    const all = await this.listGitSkills();
    return all.find((item) => item.gitUrl === gitUrl) || null;
  }

  /**
   * 构造 git 技能索引记录。
   * @param {{gitSkillId:string, skillId:string, displayName:string, description?:string, packageFiles:string[], gitUrl:string, branch?:string, commitId?:string, status:'enabled'|'disabled'}} options
   * @returns {any}
   */
  _buildRecord(options) {
    const now = new Date().toISOString();
    return {
      skillId: options.skillId,
      uid: options.gitSkillId,
      gitSkillId: options.gitSkillId,
      sourceType: "git",
      providerId: "git",
      kind: "skill",
      externalId: options.gitSkillId,
      displayName: options.displayName,
      description: options.description || "通过 Git 导入的技能",
      homepageUrl: null,
      installUrl: options.gitUrl,
      gitUrl: options.gitUrl,
      branch: options.branch || "",
      commitId: options.commitId || "",
      tags: ["git"],
      hasScripts: options.packageFiles.some((item) => item.startsWith("scripts/")),
      scriptEntries: options.packageFiles.filter((item) => item.startsWith("scripts/")),
      hasResources: options.packageFiles.some((item) => item.startsWith("resources/")),
      packageFiles: options.packageFiles,
      installState: "installed",
      status: options.status,
      installedAt: now,
      updatedAt: now
    };
  }

  /**
   * 生成 git 技能 skillId。
   * @param {string} gitSkillId
   * @returns {string}
   */
  _buildSkillId(gitSkillId) {
    return gitSkillId;
  }

  /**
   * 通过 skillId 获取 git 技能记录。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async _getGitSkillRecord(skillId) {
    const record = await this.skillsRepository.getSkill(skillId);
    if (!record || record.sourceType !== "git") {
      return null;
    }
    return record;
  }

  /**
   * 通过 skillId 获取 git 技能记录，缺失时抛错。
   * @param {string} skillId
   * @returns {Promise<any>}
   */
  async _requireGitSkillRecord(skillId) {
    const record = await this._getGitSkillRecord(skillId);
    if (!record) {
      throw new Error("git_skill_not_found");
    }
    return record;
  }

  /**
   * 从 SKILL.md 的 frontmatter 中读取 description。
   * @param {string} gitSkillId
   * @returns {Promise<string>}
   */
  async _readSkillDescription(gitSkillId) {
    try {
      const meta = await this.repository.readMeta(gitSkillId);
      const skillMdPath = meta?.subDir ? `${meta.subDir}/SKILL.md` : "SKILL.md";
      const content = await this.repository.readFile(gitSkillId, skillMdPath);
      if (!content) {
        return "";
      }
      return this._parseDescriptionFromContent(content);
    } catch {
      return "";
    }
  }

  /**
   * 从内容中解析 description。
   * @param {string} content
   * @returns {string}
   */
  _parseDescriptionFromContent(content) {
    if (!content) {
      return "";
    }
    const frontmatterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!frontmatterMatch) {
      return "";
    }
    const lines = frontmatterMatch[1].split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*description:\s*(.*)$/);
      if (match) {
        let desc = match[1].trim();
        // 剥离首尾成对的引号（" 或 '）
        if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
          desc = desc.slice(1, -1);
        }
        return desc;
      }
    }
    return "";
  }

  /**
   * 收集技能目录下的所有文件路径。
   * @param {string} gitSkillId
   * @returns {Promise<string[]>}
   */
  async _collectPackageFiles(gitSkillId) {
    const meta = await this.repository.readMeta(gitSkillId);
    let tree = await this.repository.readFileTree(gitSkillId);

    // 如果指定了 subDir，导航到子目录子树并 strip 前缀
    let stripPrefix = "";
    if (meta?.subDir) {
      stripPrefix = meta.subDir + "/";
      const parts = meta.subDir.split("/");
      for (const part of parts) {
        const child = tree.find((n) => n.name === part && n.type === "directory");
        if (!child) {
          return [];
        }
        tree = child.children || [];
      }
    }

    const output = [];
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.type === "file") {
          output.push(stripPrefix ? node.path.slice(stripPrefix.length) : node.path);
          continue;
        }
        visit(node.children || []);
      }
    };
    visit(tree);
    return output;
  }

  /**
   * 从 git URL 中提取仓库名作为默认技能名。
   * @param {string} gitUrl
   * @returns {string}
   */
  _extractRepoName(gitUrl) {
    try {
      // 提取最后一段路径，去掉 .git 后缀
      const parts = gitUrl.replace(/\.git$/, "").split("/");
      const name = parts[parts.length - 1] || "git-skill";
      return name;
    } catch {
      return "git-skill";
    }
  }
}
