import { randomUUID } from "node:crypto";
import { CustomSkillRepository } from "./custom_skill_repository.js";

/**
 * 自定义技能服务。
 *
 * 责任：
 * 1. 组织自定义技能的创建、复制、编辑和删除。
 * 2. 维护自定义技能在现有技能索引中的记录。
 * 3. 为界面和智能体提供统一的自定义技能操作入口。
 */
export class CustomSkillService {
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
    this.repository = new CustomSkillRepository({
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
   * 列出所有自定义技能。
   * @returns {Promise<any[]>}
   */
  async listCustomSkills() {
    const records = await this.skillsRepository.listKnownSkills();
    return records
      .filter((record) => record.sourceType === "custom")
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""), "zh-CN"));
  }

  /**
   * 创建空白自定义技能。
   * @param {{displayName?:string}} payload
   * @returns {Promise<any>}
   */
  async createCustomSkill(payload = {}) {
    const customSkillId = randomUUID();
    const skillId = this._buildSkillId(customSkillId);
    const displayName = this._normalizeDisplayName(payload.displayName, customSkillId);
    await this.repository.createBlankSkill({ customSkillId, displayName });
    // 从创建的 SKILL.md 模板中读取 description
    const description = await this._readSkillDescriptionFromFile(customSkillId);
    const record = await this.skillsRepository.saveSkillRecord(this._buildRecord({
      customSkillId,
      skillId,
      displayName,
      description,
      packageFiles: ["SKILL.md"],
      sourceSkillId: null,
      status: "disabled"
    }));
    return {
      skill: record,
      tree: await this.repository.readFileTree(customSkillId)
    };
  }

  /**
   * 从已有技能复制出自定义技能。
   * @param {{sourceSkillId:string, displayName?:string}} payload
   * @returns {Promise<any>}
   */
  async copySkillAsCustom(payload) {
    const sourceSkillId = String(payload?.sourceSkillId ?? "").trim();
    if (!sourceSkillId) {
      throw new Error("missing_source_skill_id");
    }

    void this.log.info("[copySkillAsCustom] 开始复制技能", { sourceSkillId });
    const sourceRecord = await this.findSkill(sourceSkillId);
    void this.log.info("[copySkillAsCustom] findSkill 结果", {
      sourceSkillId,
      found: !!sourceRecord,
      recordSkillId: sourceRecord?.skillId,
      displayName: sourceRecord?.displayName,
      packageRoot: sourceRecord?.packageRoot
    });
    if (!sourceRecord?.packageRoot) {
      throw new Error("source_skill_not_found");
    }

    const customSkillId = randomUUID();
    const skillId = this._buildSkillId(customSkillId);
    const displayName = this._normalizeDisplayName(payload?.displayName, customSkillId, sourceRecord.displayName);
    await this.repository.copySkillDirectory({
      sourceDir: sourceRecord.packageRoot,
      customSkillId,
      displayName,
      skillId
    });
    const packageFiles = await this._collectPackageFiles(customSkillId);
    // 从复制的 SKILL.md 中读取 description
    const description = await this._readSkillDescriptionFromFile(customSkillId);
    const record = await this.skillsRepository.saveSkillRecord(this._buildRecord({
      customSkillId,
      skillId,
      displayName,
      description,
      packageFiles,
      sourceSkillId,
      status: "disabled"
    }));
    return {
      skill: record,
      tree: await this.repository.readFileTree(customSkillId)
    };
  }

  /**
   * 获取自定义技能详情和文件树。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getCustomSkill(skillId) {
    // 先尝试精确匹配
    let record = await this._getCustomSkillRecord(skillId);
    // 如果找不到，尝试用 findSkill 处理 @ 前缀和 displayName 匹配
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      return null;
    }
    return {
      skill: record,
      tree: await this.repository.readFileTree(record.customSkillId)
    };
  }

  /**
   * 获取自定义技能文件树。
   * @param {string} skillId
   * @returns {Promise<any[]|null>}
   */
  async getCustomSkillTree(skillId) {
    let record = await this._getCustomSkillRecord(skillId);
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      return null;
    }
    return this.repository.readFileTree(record.customSkillId);
  }

  /**
   * 读取自定义技能全部文件内容。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getCustomSkillFiles(skillId) {
    let record = await this._getCustomSkillRecord(skillId);
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      return null;
    }
    const files = {};
    const allPaths = await this._flattenFilePaths(record.customSkillId);
    for (const filePath of allPaths) {
      files[filePath] = await this.repository.readFile(record.customSkillId, filePath);
    }
    return files;
  }

  /**
   * 读取单个文件。
   * @param {string} skillId
   * @param {string} filePath
   * @returns {Promise<any|null>}
   */
  async readCustomSkillFile(skillId, filePath) {
    let record = await this._getCustomSkillRecord(skillId);
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      return null;
    }
    const content = await this.repository.readFile(record.customSkillId, filePath);
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
   * 创建空文件。
   * @param {string} skillId
   * @param {string} filePath
   * @returns {Promise<any>}
   */
  async createCustomSkillFile(skillId, filePath) {
    const record = await this._requireCustomSkillRecord(skillId);
    await this.repository.createFile(record.customSkillId, filePath);
    return this._touchRecord(record);
  }

  /**
   * 创建子文件夹。
   * @param {string} skillId
   * @param {string} folderPath
   * @returns {Promise<any>}
   */
  async createCustomSkillFolder(skillId, folderPath) {
    const record = await this._requireCustomSkillRecord(skillId);
    await this.repository.createFolder(record.customSkillId, folderPath);
    return this._touchRecord(record);
  }

  /**
   * 写文件。
   * @param {string} skillId
   * @param {string} filePath
   * @param {string} content
   * @returns {Promise<any>}
   */
  async writeCustomSkillFile(skillId, filePath, content) {
    const record = await this._requireCustomSkillRecord(skillId);
    await this.repository.writeFile(record.customSkillId, filePath, content);

    // 如果写入的是 SKILL.md，同步更新 description 到索引
    if (filePath === "SKILL.md") {
      const description = this._parseDescriptionFromContent(content);
      void this.log.info("writeCustomSkillFile: SKILL.md saved", {
        skillId,
        customSkillId: record.customSkillId,
        parsedDescription: description,
        contentPreview: content?.substring(0, 200)
      });
      const packageFiles = await this._collectPackageFiles(record.customSkillId);
      return this.skillsRepository.saveSkillRecord({
        ...record,
        description: description || record.description,
        packageFiles,
        hasScripts: packageFiles.some((item) => item.startsWith("scripts/")),
        scriptEntries: packageFiles.filter((item) => item.startsWith("scripts/")),
        hasResources: packageFiles.some((item) => item.startsWith("resources/")),
        updatedAt: new Date().toISOString()
      });
    }

    return this._touchRecord(record);
  }

  /**
   * 删除文件或目录。
   * @param {string} skillId
   * @param {string} entryPath
   * @returns {Promise<any>}
   */
  async deleteCustomSkillEntry(skillId, entryPath) {
    const record = await this._requireCustomSkillRecord(skillId);
    await this.repository.deleteEntry(record.customSkillId, entryPath);
    return this._touchRecord(record);
  }

  /**
   * ?????????
   * @param {string} skillId
   * @param {string} fromPath
   * @param {string} toPath
   * @returns {Promise<any>}
   */
  async renameCustomSkillEntry(skillId, fromPath, toPath) {
    const record = await this._requireCustomSkillRecord(skillId);
    await this.repository.renameEntry(record.customSkillId, fromPath, toPath);
    return this._touchRecord(record);
  }

  /**
   * 更新启停状态。
   * @param {string} skillId
   * @param {'enabled'|'disabled'} status
   * @returns {Promise<any>}
   */
  async setCustomSkillStatus(skillId, status) {
    const record = await this._requireCustomSkillRecord(skillId);
    const normalizedStatus = status === "enabled" ? "enabled" : "disabled";
    return this.skillsRepository.saveSkillRecord({
      ...record,
      status: normalizedStatus,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * 删除整个自定义技能。
   * @param {string} skillId
   * @returns {Promise<boolean>}
   */
  async deleteCustomSkill(skillId) {
    let record = await this._getCustomSkillRecord(skillId);
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      return false;
    }
    await this.repository.deleteSkill(record.customSkillId);
    await this.skillsRepository.deleteSkillRecord(skillId);
    return true;
  }

  /**
   * 构造自定义技能索引记录。
   * @param {{customSkillId:string, skillId:string, displayName:string, description?:string, packageFiles:string[], sourceSkillId:string|null, status:'enabled'|'disabled'}} options
   * @returns {any}
   */
  _buildRecord(options) {
    const now = new Date().toISOString();
    return {
      skillId: options.skillId,
      uid: options.customSkillId,
      customSkillId: options.customSkillId,
      sourceType: "custom",
      providerId: "custom",
      kind: "skill",
      externalId: options.customSkillId,
      displayName: options.displayName,
      description: options.description || "用户自定义技能",
      homepageUrl: null,
      installUrl: null,
      tags: ["custom"],
      hasScripts: options.packageFiles.some((item) => item.startsWith("scripts/")),
      scriptEntries: options.packageFiles.filter((item) => item.startsWith("scripts/")),
      hasResources: options.packageFiles.some((item) => item.startsWith("resources/")),
      packageFiles: options.packageFiles,
      installState: "installed",
      status: options.status,
      sourceSkillId: options.sourceSkillId,
      installedAt: now,
      updatedAt: now
    };
  }

  /**
   * 通过 skillId 获取自定义技能记录。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async _getCustomSkillRecord(skillId) {
    const record = await this.skillsRepository.getSkill(skillId);
    if (!record || record.sourceType !== "custom") {
      return null;
    }
    return record;
  }

  /**
   * 通过 skillId 获取自定义技能记录，缺失时抛错。
   * @param {string} skillId
   * @returns {Promise<any>}
   */
  async _requireCustomSkillRecord(skillId) {
    let record = await this._getCustomSkillRecord(skillId);
    if (!record) {
      record = await this.findSkill(skillId);
    }
    if (!record || !record.customSkillId) {
      throw new Error("custom_skill_not_found");
    }
    return record;
  }

  /**
   * 查找技能，支持通过 ID 或 displayName 查找。
   * 处理 @ 前缀被大模型忽略的情况，以及 providerId/skillName -> providerId:skill:skillName 的转换。
   * @param {string} identifier - 技能 ID 或 displayName
   * @returns {Promise<any|null>}
   */
  async findSkill(identifier) {
    if (!identifier || typeof identifier !== "string") {
      return null;
    }
    const trimmed = identifier.trim();
    if (!trimmed) {
      return null;
    }

    void this.log.info("[findSkill] 开始查找", { identifier: trimmed });

    // 1. 先尝试直接通过 ID 查找
    let record = await this.skillsRepository.getSkill(trimmed);
    void this.log.info("[findSkill] 步骤1直接查找", { id: trimmed, found: !!record });
    if (record) {
      return record;
    }

    // 2. 如果输入没有 @ 前缀，尝试加上 @ 前缀查找
    if (!trimmed.startsWith("@")) {
      record = await this.skillsRepository.getSkill(`@${trimmed}`);
      void this.log.info("[findSkill] 步骤2加@前缀", { id: `@${trimmed}`, found: !!record });
      if (record) {
        return record;
      }
    }

    // 3. 如果输入以 @ 开头，去掉 @ 再试（双重保险）
    let withoutAt = trimmed;
    if (withoutAt.startsWith("@")) {
      withoutAt = withoutAt.slice(1).trim();
      if (withoutAt) {
        record = await this.skillsRepository.getSkill(withoutAt);
        void this.log.info("[findSkill] 步骤3去@前缀", { id: withoutAt, found: !!record });
        if (record) {
          return record;
        }
      }
    }

    // 4. 处理 providerId/skillName -> providerId:skill:skillName 的转换
    // 例如 "evan-acg/character-profile-skill" -> "evan-acg:skill:character-profile-skill"
    let normalizedId = withoutAt || trimmed;
    void this.log.info("[findSkill] 检查转换", {
      normalizedId,
      hasSlash: normalizedId.includes("/"),
      hasColon: normalizedId.includes(":")
    });
    if (normalizedId.includes("/") && !normalizedId.includes(":")) {
      const parts = normalizedId.split("/");
      if (parts.length === 2) {
        normalizedId = `${parts[0]}:skill:${parts[1]}`;
        void this.log.info("[findSkill] 步骤4转换后尝试", { normalizedId });
        record = await this.skillsRepository.getSkill(normalizedId);
        if (record) {
          return record;
        }
        // 也尝试带 @ 前缀
        record = await this.skillsRepository.getSkill(`@${normalizedId}`);
        void this.log.info("[findSkill] 步骤4加@前缀", { id: `@${normalizedId}`, found: !!record });
        if (record) {
          return record;
        }
      }
    }

    // 5. 尝试在所有已知技能中通过 displayName 匹配
    void this.log.info("[findSkill] 步骤5遍历所有技能");
    const allSkills = await this.skillsRepository.listKnownSkills();
    void this.log.info("[findSkill] 系统中的技能数量", { count: allSkills.length });
    const lowerIdentifier = withoutAt.toLowerCase();
    const normalizedForMatch = normalizedId.toLowerCase();

    // 提取用户输入中的 skillName 部分（例如 "evan-acg/character-profile-skill" -> "character-profile-skill"）
    const identifierParts = withoutAt.split("/");
    const skillNameFromInput = identifierParts.length >= 2 ? identifierParts[identifierParts.length - 1] : withoutAt;

    for (const skill of allSkills) {
      void this.log.info("[findSkill] 检查技能", { skillId: skill.skillId, displayName: skill.displayName });
      const displayName = skill.displayName || "";

      // 5.1 精确匹配 displayName
      if (displayName.toLowerCase() === lowerIdentifier ||
          displayName.toLowerCase() === withoutAt.toLowerCase()) {
        void this.log.info("[findSkill] 步骤5.1 displayName 匹配成功", { skillId: skill.skillId, displayName });
        return skill;
      }

      // 5.2 检查 skillId 是否包含用户输入（处理 modelscope:skill:@evan-acg/character-profile-skill 格式）
      const skillId = skill.skillId || "";
      const skillIdLower = skillId.toLowerCase();

      // 5.2.1 直接比较 skillId
      if (skillIdLower === normalizedForMatch ||
          skillIdLower === withoutAt.toLowerCase()) {
        void this.log.info("[findSkill] 步骤5.2.1 skillId 直接匹配成功", { skillId: skill.skillId });
        return skill;
      }

      // 5.2.2 检查 skillId 是否包含用户输入的关键部分
      // 例如: "modelscope:skill:@evan-acg/character-profile-skill" 包含 "@evan-acg/character-profile-skill"
      if (skillIdLower.includes(`@${lowerIdentifier}`) ||
          skillIdLower.includes(lowerIdentifier) ||
          skillIdLower.includes(normalizedForMatch)) {
        void this.log.info("[findSkill] 步骤5.2.2 skillId 包含匹配成功", { skillId: skill.skillId });
        return skill;
      }

      // 5.3 检查 externalId 是否匹配
      const externalId = skill.externalId || "";
      if (externalId.toLowerCase() === lowerIdentifier ||
          externalId.toLowerCase() === withoutAt.toLowerCase() ||
          externalId.toLowerCase() === `@${lowerIdentifier}`) {
        void this.log.info("[findSkill] 步骤5.3 externalId 匹配成功", { skillId: skill.skillId, externalId });
        return skill;
      }

      // 5.4 检查 displayName 是否包含用户输入的 skillName 部分
      // 例如: displayName "character-profile" 匹配输入 "evan-acg/character-profile-skill" 中的 "character-profile"
      if (skillNameFromInput && displayName.toLowerCase().includes(skillNameFromInput.toLowerCase())) {
        void this.log.info("[findSkill] 步骤5.4 displayName 包含 skillName 匹配成功", {
          skillId: skill.skillId,
          displayName,
          skillNameFromInput
        });
        return skill;
      }
    }

    return null;
  }

  /**
   * 更新时间并刷新包文件列表。
   * @param {any} record
   * @returns {Promise<any>}
   */
  async _touchRecord(record) {
    const packageFiles = await this._collectPackageFiles(record.customSkillId);
    return this.skillsRepository.saveSkillRecord({
      ...record,
      packageFiles,
      hasScripts: packageFiles.some((item) => item.startsWith("scripts/")),
      scriptEntries: packageFiles.filter((item) => item.startsWith("scripts/")),
      hasResources: packageFiles.some((item) => item.startsWith("resources/")),
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * 拉平当前技能的所有文件路径。
   * @param {string} customSkillId
   * @returns {Promise<string[]>}
   */
  async _flattenFilePaths(customSkillId) {
    const tree = await this.repository.readFileTree(customSkillId);
    const output = [];
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.type === "file") {
          output.push(node.path);
          continue;
        }
        visit(node.children || []);
      }
    };
    visit(tree);
    return output;
  }

  /**
   * 收集技能目录下的所有文件路径。
   * @param {string} customSkillId
   * @returns {Promise<string[]>}
   */
  async _collectPackageFiles(customSkillId) {
    return this._flattenFilePaths(customSkillId);
  }

  /**
   * 生成自定义技能 skillId。
   * @param {string} customSkillId
   * @returns {string}
   */
  _buildSkillId(customSkillId) {
    return customSkillId;
  }

  /**
   * 归一化技能名。
   * @param {string|undefined} displayName
   * @param {string} customSkillId
   * @param {string} [fallbackName]
   * @returns {string}
   */
  _normalizeDisplayName(displayName, customSkillId, fallbackName = "") {
    const trimmed = typeof displayName === "string" ? displayName.trim() : "";
    if (trimmed) {
      return trimmed;
    }
    if (fallbackName && String(fallbackName).trim()) {
      return `${String(fallbackName).trim()}-副本`;
    }
    return `自定义技能-${customSkillId.slice(0, 8)}`;
  }

  /**
   * 从 SKILL.md 的 frontmatter 中读取 description。
   * @param {string} customSkillId
   * @returns {Promise<string>}
   */
  async _readSkillDescriptionFromFile(customSkillId) {
    try {
      const content = await this.repository.readFile(customSkillId, "SKILL.md");
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
    // 解析 frontmatter 中的 description
    const frontmatterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!frontmatterMatch) {
      return "";
    }
    const lines = frontmatterMatch[1].split(/\r?\n/);
    for (const line of lines) {
      // 支持 description 前可能有空格的情况
      const match = line.match(/^\s*description:\s*(.*)$/);
      if (match) {
        const desc = match[1].trim();
        // 如果是默认占位符，返回空字符串
        if (desc === "请填写技能描述") {
          return "";
        }
        return desc;
      }
    }
    return "";
  }
}
