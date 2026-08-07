import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * 技能仓库。
 *
 * 责任：
 * 1. 管理全局技能包与索引。
 * 2. 维护安装状态与历史元数据。
 * 3. 提供包内容读取能力。
 */
export class SkillsRepository {
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
    this.registryDir = path.join(this.rootDir, "registry", "skills");
    this.customDir = path.join(this.rootDir, "custom");
    this.gitDir = path.join(this.rootDir, "git");
    this.indexDir = path.join(this.rootDir, "indexes");
    this.tmpDir = path.join(this.rootDir, "tmp");
    this.indexPath = path.join(this.indexDir, "skills-by-id.json");
    this.indexCache = null;
  }

  /**
   * 初始化仓库目录与索引。
   * @returns {Promise<void>}
   */
  async initialize() {
    await mkdir(this.registryDir, { recursive: true });
    await mkdir(this.customDir, { recursive: true });
    await mkdir(this.gitDir, { recursive: true });
    await mkdir(this.indexDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    await this._ensureIndexLoaded();
    await this._sanitizeInstallRecords();
  }

  /**
   * 创建安装临时目录。
   * @returns {Promise<string>}
   */
  async createInstallTempDir() {
    const tempDir = path.join(this.tmpDir, `install-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  /**
   * 清理安装临时目录。
   * @param {string} tempDir
   * @returns {Promise<void>}
   */
  async removeTempDir(tempDir) {
    if (!tempDir) {
      return;
    }
    await rm(tempDir, { recursive: true, force: true });
  }

  /**
   * 保存安装好的 Skill。
   * @param {{request:any, catalogItem:any, packageDir:string}} options
   * @returns {Promise<any>}
   */
  async saveInstalledSkill(options) {
    const index = await this._ensureIndexLoaded();
    const skillId = this._buildSkillId(options.request.providerId, options.request.kind, options.request.externalId);
    const uid = this._buildSkillUid(skillId);
    const skillRoot = path.join(this.registryDir, uid);
    const packageRoot = path.join(skillRoot, "package");
    const manifest = await this._buildManifest({
      skillId,
      uid,
      request: options.request,
      catalogItem: options.catalogItem,
      packageDir: options.packageDir
    });

    await rm(skillRoot, { recursive: true, force: true });
    await mkdir(skillRoot, { recursive: true });
    await cp(options.packageDir, packageRoot, { recursive: true, force: true });
    await writeFile(path.join(skillRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(path.join(skillRoot, "source.json"), JSON.stringify(options.catalogItem, null, 2), "utf8");

    const installRecord = {
      skillId,
      installState: "installed",
      installer: "startup-js-runtime-skills-add",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await writeFile(path.join(skillRoot, "install.json"), JSON.stringify(installRecord, null, 2), "utf8");

    index.records[skillId] = this._hydrateRecord({
      ...manifest,
      installState: "installed",
      installedAt: installRecord.installedAt,
      updatedAt: installRecord.updatedAt
    });
    await this._saveIndex(index);
    return index.records[skillId];
  }

  /**
   * 将 Skill 标记为卸载。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async uninstallSkill(skillId) {
    const index = await this._ensureIndexLoaded();
    const record = index.records[skillId];
    if (!record) {
      return null;
    }

    const skillRoot = record.uid ? path.join(this.registryDir, record.uid) : null;
    if (skillRoot) {
      await rm(skillRoot, { recursive: true, force: true });
    }

    index.records[skillId] = this._hydrateRecord({
      ...record,
      installState: "uninstalled",
      updatedAt: new Date().toISOString()
    });
    await this._saveIndex(index);
    return index.records[skillId];
  }

  /**
   * 获取单个技能记录。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getSkill(skillId) {
    const index = await this._ensureIndexLoaded();
    const record = index.records[skillId] ?? null;
    return record ? this._hydrateRecord(record) : null;
  }

  /**
   * 判断技能是否已安装。
   * @param {string} skillId
   * @returns {Promise<boolean>}
   */
  async isInstalled(skillId) {
    const record = await this.getSkill(skillId);
    return record?.installState === "installed";
  }

  /**
   * 列出已知技能。
   * @returns {Promise<any[]>}
   */
  async listKnownSkills() {
    const index = await this._ensureIndexLoaded();
    return Object.values(index.records).map((record) => this._hydrateRecord(record)).sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.installedAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.installedAt || 0).getTime();
      return rightTime - leftTime;
    });
  }

  /**
   * 列出已安装技能。
   * @returns {Promise<any[]>}
   */
  async listInstalledSkills() {
    const skills = await this.listKnownSkills();
    return skills.filter((skill) => skill.installState === "installed");
  }

  /**
   * 写入或更新技能记录。
   * @param {any} record
   * @returns {Promise<any>}
   */
  async saveSkillRecord(record) {
    const index = await this._ensureIndexLoaded();
    const normalized = this._hydrateRecord({
      ...record,
      updatedAt: record?.updatedAt || new Date().toISOString()
    });
    index.records[normalized.skillId] = normalized;
    await this._saveIndex(index);
    return this._hydrateRecord(index.records[normalized.skillId]);
  }

  /**
   * 删除技能记录。
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async deleteSkillRecord(skillId) {
    const index = await this._ensureIndexLoaded();
    delete index.records[skillId];
    await this._saveIndex(index);
  }

  /**
   * 读取 Skill 文档。
   * @param {string} skillId
   * @returns {Promise<{skillMd:string, referenceMd:string|null, manifest:any}|null>}
   */
  async readSkillDocs(skillId) {
    const skillMd = await this.readSkillFile(skillId, "SKILL.md");
    if (!skillMd) {
      return null;
    }
    const referenceMd = await this.readSkillFile(skillId, "reference.md");
    return {
      skillMd: skillMd.content,
      referenceMd: referenceMd?.content ?? null,
      manifest: skillMd.manifest
    };
  }

  /**
   * 读取技能包内的文本文件。
   * 设计约束：
   * 1. 默认入口为 SKILL.md，与 Claude Code 的技能正文入口保持一致。
   * 2. 允许按需读取 skill 根目录下的相对文件，用于渐进披露加载 references 等文档。
   * 3. 严格限制访问范围，不允许跳出技能包目录。
   * @param {string} skillId
   * @param {string} [relativePath]
   * @returns {Promise<{content:string, resolvedPath:string, manifest:any}|null>}
   */
  async readSkillFile(skillId, relativePath = "SKILL.md") {
    const resolved = await this.resolveSkillPackageFile(skillId, relativePath);
    if (!resolved) {
      return null;
    }
    const content = await readFile(resolved.absolutePath, "utf8");
    return {
      content,
      resolvedPath: resolved.relativePath,
      manifest: resolved.manifest
    };
  }

  /**
   * 解析脚本路径。
   * @param {string} skillId
   * @param {string} relativeScriptPath
   * @returns {Promise<{absolutePath:string, manifest:any}|null>}
   */
  async resolveSkillScript(skillId, relativeScriptPath) {
    const resolved = await this.resolveSkillPackageFile(skillId, relativeScriptPath);
    if (!resolved || !resolved.relativePath.startsWith("scripts/")) {
      return null;
    }
    return {
      absolutePath: resolved.absolutePath,
      manifest: resolved.manifest
    };
  }

  /**
   * 解析技能包内相对文件路径。
   * @param {string} skillId
   * @param {string} relativePath
   * @returns {Promise<{absolutePath:string, relativePath:string, manifest:any}|null>}
   */
  async resolveSkillPackageFile(skillId, relativePath) {
    const record = await this.getSkill(skillId);
    if (!record || record.installState !== "installed" || !record.packageRoot) {
      return null;
    }

    const normalized = String(relativePath ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();
    if (!normalized) {
      return null;
    }

    const absolutePath = path.resolve(record.packageRoot, normalized);
    const packageRoot = path.resolve(record.packageRoot);
    if (!absolutePath.startsWith(packageRoot)) {
      return null;
    }
    if (!existsSync(absolutePath)) {
      return null;
    }

    return {
      absolutePath,
      relativePath: normalized,
      manifest: record
    };
  }

  /**
   * 生成标准 Skill ID。
   * @param {string} providerId
   * @param {string} kind
   * @param {string} externalId
   * @returns {string}
   */
  _buildSkillId(providerId, kind, externalId) {
    return `${providerId}:${kind}:${externalId}`;
  }

  /**
   * 生成稳定 UID。
   * @param {string} skillId
   * @returns {string}
   */
  _buildSkillUid(skillId) {
    return createHash("sha1").update(skillId).digest("hex");
  }

  /**
   * 构建仓库 Manifest。
   * @param {{skillId:string, uid:string, request:any, catalogItem:any, packageDir:string}} options
   * @returns {Promise<any>}
   */
  async _buildManifest(options) {
    const packageFiles = [];
    await this._collectPackageFiles(options.packageDir, options.packageDir, packageFiles);
    const skillDoc = await readFile(path.join(options.packageDir, "SKILL.md"), "utf8");
    const parsedFrontmatter = this._parseFrontmatter(skillDoc);
    const scriptEntries = packageFiles.filter((file) => file.startsWith("scripts/"));

    return {
      skillId: options.skillId,
      uid: options.uid,
      providerId: options.request.providerId,
      kind: options.request.kind,
      externalId: options.request.externalId,
      displayName: parsedFrontmatter.name || options.catalogItem.displayName || options.request.externalId,
      description: parsedFrontmatter.description || options.catalogItem.description || "",
      homepageUrl: options.catalogItem.homepageUrl || options.request.homepageUrl || null,
      installUrl: options.catalogItem.installUrl || options.request.installUrl || null,
      tags: Array.isArray(options.catalogItem.tags) ? options.catalogItem.tags : [],
      hasScripts: scriptEntries.length > 0,
      scriptEntries,
      hasResources: packageFiles.some((file) => file.startsWith("resources/")),
      packageFiles,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * 递归收集包文件。
   * @param {string} rootDir
   * @param {string} currentDir
   * @param {string[]} output
   * @returns {Promise<void>}
   */
  async _collectPackageFiles(rootDir, currentDir, output) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await this._collectPackageFiles(rootDir, absolutePath, output);
        continue;
      }
      output.push(relativePath);
    }
  }

  /**
   * 解析 SKILL.md Frontmatter。
   * @param {string} content
   * @returns {{name:string, description:string}}
   */
  _parseFrontmatter(content) {
    const text = String(content ?? "");
    const match = text.match(/^---\s*([\s\S]*?)\s*---/);
    if (!match) {
      return { name: "", description: "" };
    }
    const lines = match[1].split(/\r?\n/);
    const result = { name: "", description: "" };
    for (const line of lines) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key === "name") {
        result.name = value;
      }
      if (key === "description") {
        result.description = value;
      }
    }
    return result;
  }

  /**
   * 确保索引已加载。
   * @returns {Promise<any>}
   */
  async _ensureIndexLoaded() {
    if (this.indexCache) {
      return this.indexCache;
    }
    if (!existsSync(this.indexPath)) {
      this.indexCache = { records: {} };
      await this._saveIndex(this.indexCache);
      return this.indexCache;
    }
    try {
      const raw = await readFile(this.indexPath, "utf8");
      this.indexCache = JSON.parse(raw);
      if (!this.indexCache || typeof this.indexCache !== "object" || typeof this.indexCache.records !== "object") {
        this.indexCache = { records: {} };
      }
    } catch {
      this.indexCache = { records: {} };
    }
    const sanitizedRecords = Object.fromEntries(
      Object.entries(this.indexCache.records).map(([skillId, record]) => [skillId, this._dehydrateRecord(record)])
    );
    const needsMigration = JSON.stringify(sanitizedRecords) !== JSON.stringify(this.indexCache.records);
    this.indexCache.records = sanitizedRecords;
    if (needsMigration) {
      await this._saveIndex(this.indexCache);
    }
    return this.indexCache;
  }

  /**
   * 保存索引。
   * @param {any} index
   * @returns {Promise<void>}
   */
  async _saveIndex(index) {
    this.indexCache = index;
    const persisted = {
      ...index,
      records: Object.fromEntries(
        Object.entries(index.records ?? {}).map(([skillId, record]) => [skillId, this._dehydrateRecord(record)])
      )
    };
    await writeFile(this.indexPath, JSON.stringify(persisted, null, 2), "utf8");
  }

  /**
   * 清理旧版 install.json 中不该持久化的字段。
   * @returns {Promise<void>}
   */
  async _sanitizeInstallRecords() {
    const skillRoots = await readdir(this.registryDir, { withFileTypes: true });
    for (const entry of skillRoots) {
      if (!entry.isDirectory()) {
        continue;
      }
      const installPath = path.join(this.registryDir, entry.name, "install.json");
      if (!existsSync(installPath)) {
        continue;
      }
      try {
        const installRecord = JSON.parse(await readFile(installPath, "utf8"));
        if (!installRecord || typeof installRecord !== "object" || !Object.prototype.hasOwnProperty.call(installRecord, "bunPath")) {
          continue;
        }
        const sanitized = { ...installRecord };
        delete sanitized.bunPath;
        await writeFile(installPath, JSON.stringify(sanitized, null, 2), "utf8");
      } catch (err) {
        void this.log.warn("清理技能 install.json 失败", {
          installPath,
          error: err?.message,
          stack: err?.stack
        });
      }
    }
  }

  /**
   * 构造技能根目录。
   * @param {string} uid
   * @returns {string}
   */
  _buildSkillRoot(uid) {
    return path.join(this.registryDir, uid);
  }

  /**
   * 把持久化记录恢复成运行时记录。
   * 设计约束：
   * 1. 绝对路径不持久化，只在运行时根据 uid 重新计算。
   * 2. 兼容旧版本已经写入的 packageRoot，便于平滑迁移。
   * @param {any} record
   * @returns {any}
   */
  _hydrateRecord(record) {
    if (!record || typeof record !== "object") {
      return record;
    }
    const hydrated = { ...record };
    if (hydrated.sourceType === "custom") {
      const customSkillId = typeof hydrated.customSkillId === "string" && hydrated.customSkillId
        ? hydrated.customSkillId
        : this._parseCustomSkillId(hydrated.skillId);
      hydrated.customSkillId = customSkillId;
      const customPackageRoot = customSkillId
        ? path.join(this.customDir, customSkillId)
        : null;
      hydrated.packageRoot = customPackageRoot && existsSync(customPackageRoot)
        ? customPackageRoot
        : null;
      return hydrated;
    }
    // git 类型技能：根据 gitSkillId 恢复 packageRoot
    if (hydrated.sourceType === "git") {
      const gitSkillId = typeof hydrated.gitSkillId === "string" && hydrated.gitSkillId
        ? hydrated.gitSkillId
        : this._parseGitSkillId(hydrated.skillId);
      hydrated.gitSkillId = gitSkillId;
      const gitPackageRoot = gitSkillId
        ? path.join(this.gitDir, gitSkillId)
        : null;
      hydrated.packageRoot = gitPackageRoot && existsSync(gitPackageRoot)
        ? gitPackageRoot
        : null;
      return hydrated;
    }
    const computedPackageRoot = typeof hydrated.uid === "string" && hydrated.uid
      ? path.join(this._buildSkillRoot(hydrated.uid), "package")
      : null;
    if (computedPackageRoot && existsSync(computedPackageRoot)) {
      hydrated.packageRoot = computedPackageRoot;
      return hydrated;
    }
    if (typeof hydrated.packageRoot === "string" && hydrated.packageRoot && existsSync(hydrated.packageRoot)) {
      return hydrated;
    }
    hydrated.packageRoot = null;
    return hydrated;
  }

  /**
   * 把运行时记录裁剪成可持久化记录。
   * @param {any} record
   * @returns {any}
   */
  _dehydrateRecord(record) {
    if (!record || typeof record !== "object") {
      return record;
    }
    const cloned = { ...record };
    delete cloned.packageRoot;
    return cloned;
  }

  /**
   * 从自定义技能 skillId 中提取物理目录标识。
   * @param {string} skillId
   * @returns {string|null}
   */
  _parseCustomSkillId(skillId) {
    const match = String(skillId ?? "").match(/^custom:skill:(.+)$/);
    return match?.[1] ? match[1] : null;
  }

  /**
   * 从 git 技能 skillId 中提取物理目录标识。
   * @param {string} skillId
   * @returns {string|null}
   */
  _parseGitSkillId(skillId) {
    const match = String(skillId ?? "").match(/^git:skill:(.+)$/);
    return match?.[1] ? match[1] : null;
  }
}
