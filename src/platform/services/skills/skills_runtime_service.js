/**
 * 技能运行时装配服务。
 *
 * 责任：
 * 1. 计算智能体可见 Skill。
 * 2. 生成 system prompt 中的技能摘要。
 * 3. 读取可见 Skill 详情。
 * 4. 管理已学习技能的常驻 prompt 注入与持久化。
 *
 * 缓存策略：
 * - 内存只缓存 skillId 集合（Set），不缓存文件内容。
 * - 每次 _buildLearnedContent 从磁盘实时读取 SKILL.md / SYSTEM_PROMPT.md，
 *   保证用户编辑后立即生效。
 * - 文件读取相对 LLM 请求可忽略不计（微秒级 vs 秒级）。
 */
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export class SkillsRuntimeService {
  /**
   * @param {{repository:any, bindingService:any, dataDir:string, logger?:any}} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.bindingService = options.bindingService;
    this._dataDir = options.dataDir;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    /** @type {Map<string, Set<string>>} agentId → Set<skillId>（只存 ID，不存内容） */
    this._learnedByAgent = new Map();
  }

  /**
   * 获取智能体的 Skill 视图。
   * @param {string} agentId
   * @returns {Promise<any[]>}
   */
  async getAgentSkillView(agentId) {
    const resolvedBindings = this.bindingService.resolveAgentBindings(agentId);
    const result = [];
    for (const item of resolvedBindings) {
      const record = await this.repository.getSkill(item.skillId);
      const installState = record?.installState ?? "uninstalled";
      const enabled = record?.sourceType === "custom" || record?.sourceType === "git" ? record?.status === "enabled" : true;
      const visible = item.configuredEnabled === true && installState === "installed" && enabled;
      let missingReason = null;
      if (item.configuredEnabled === true) {
        if (installState !== "installed") {
          missingReason = installState === "corrupted" ? "包损坏" : "未安装";
        } else if (!enabled) {
          missingReason = "已停用";
        }
      }
      result.push({
        skillId: item.skillId,
        displayName: record?.displayName || item.skillId,
        description: record?.description || "",
        installState,
        configuredEnabled: item.configuredEnabled === true,
        visible,
        missingReason,
        source: item.source,
        roleConfiguredEnabled: item.roleConfiguredEnabled,
        agentConfiguredEnabled: item.agentConfiguredEnabled,
        scriptEntries: Array.isArray(record?.scriptEntries) ? record.scriptEntries : [],
        homepageUrl: record?.homepageUrl || null,
        tags: Array.isArray(record?.tags) ? record.tags : []
      });
    }
    return result.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  /**
   * 列出智能体可见 Skill。
   * @param {string} agentId
   * @returns {Promise<any[]>}
   */
  async listVisibleSkills(agentId) {
    const view = await this.getAgentSkillView(agentId);
    return view.filter((item) => item.visible);
  }

  /**
   * 生成提示词摘要。
   * 返回 { prompt, warnings }，其中 prompt 为字符串，warnings 为加载失败的 skillId 列表。
   * @param {string} agentId
   * @returns {Promise<{prompt:string, warnings:string[]}>}
   */
  async buildAgentSkillPrompt(agentId) {
    const visibleSkills = await this.listVisibleSkills(agentId);

    // 加载已学习技能 ID（用于标注和内容注入）
    const { failedIds } = await this._buildLearnedContent(agentId);
    const learnedIds = this._learnedByAgent.get(agentId);

    let summaryPrompt = "";

    if (visibleSkills.length > 0) {
      const lines = [
        "如果当前任务与下列技能直接相关，先调用 load_skill_detail 读取对应技能说明，再开始执行。",
        "同一任务里，同一份技能文件加载过后不要重复加载，除非需要读取该技能包中的其他文件。",
        "下面每个技能都给出了读取其 SKILL.md 的标准调用方式，只能使用列表中真实存在的技能，不要臆造不存在的技能标识。"
      ];

      for (const skill of visibleSkills) {
        const description = skill.description || "无描述";
        const loadInstruction = `load_skill_detail({ skill: "${skill.skillId}" })`;
        const learnedTag = learnedIds?.has(skill.skillId) ? "（已学习）" : "";
        lines.push(
          `- ${skill.displayName}${learnedTag}（标识：${skill.skillId}）：${description}。加载 SKILL.md：${loadInstruction}`
        );
      }

      summaryPrompt = `【当前可见技能】\n${lines.join("\n")}`;
    }

    // 构建已学习技能内容（实时读文件）
    const { content: learnedContent } = await this._buildLearnedContent(agentId);

    const prompt = [summaryPrompt, learnedContent].filter(Boolean).join("\n");

    return { prompt, warnings: failedIds };
  }

  /**
   * 读取智能体可见 Skill 详情。
   * @param {string} agentId
   * @param {string} identifier
   * @param {string} [relativePath]
   * @returns {Promise<any|null>}
   */
  async getVisibleSkillDetail(agentId, identifier, relativePath = "SKILL.md") {
    const target = await this.resolveVisibleSkill(agentId, identifier);
    if (!target) {
      return null;
    }
    const file = await this.repository.readSkillFile(target.skillId, relativePath);
    if (!file) {
      return null;
    }
    return {
      skillId: target.skillId,
      displayName: target.displayName,
      path: file.resolvedPath,
      content: file.content,
      manifest: file.manifest
    };
  }

  /**
   * 根据 skillId 或技能名解析当前智能体可见技能。
   * @param {string} agentId
   * @param {string} identifier
   * @returns {Promise<any|null>}
   */
  async resolveVisibleSkill(agentId, identifier) {
    const normalized = String(identifier ?? "").trim();
    if (!normalized) {
      return null;
    }

    const visibleSkills = await this.listVisibleSkills(agentId);
    const bySkillId = visibleSkills.find((item) => item.skillId === normalized);
    if (bySkillId) {
      return bySkillId;
    }

    const lower = normalized.toLowerCase();
    return visibleSkills.find((item) => String(item.displayName ?? "").trim().toLowerCase() === lower) ?? null;
  }

  // ========== 已学习技能管理 ==========

  /**
   * 获取智能体 skills.json 文件路径。
   * @param {string} agentId
   * @returns {string}
   */
  _getSkillsFilePath(agentId) {
    return path.join(this._dataDir, "agents", agentId, "skills.json");
  }

  /**
   * 懒加载智能体的已学习技能 ID 到内存。
   * 首次调用从 skills.json 读取 ID 列表，并验证技能包存在性。
   * 不缓存文件内容 — 内容由 _buildLearnedContent 每次实时读取。
   * 加载失败的技能自动卸载（从磁盘剔除）。
   * @param {string} agentId
   * @returns {Promise<{failedIds:string[]}>}
   */
  async _loadLearned(agentId) {
    if (this._learnedByAgent.has(agentId)) {
      return { failedIds: [] };
    }

    const skillIds = new Set();
    const failedIds = [];

    try {
      const filePath = this._getSkillsFilePath(agentId);
      let learnedSkillIds = [];

      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.learnedSkillIds)) {
          learnedSkillIds = parsed.learnedSkillIds;
        }
      } catch {
        // 文件不存在或解析失败，视为空列表
      }

      for (const skillId of learnedSkillIds) {
        try {
          // 仅验证技能包存在，不缓存内容
          const sysPrompt = await this.repository.readSkillFile(skillId, "SYSTEM_PROMPT.md");
          if (sysPrompt?.content) {
            skillIds.add(skillId);
            continue;
          }
          const skillMd = await this.repository.readSkillFile(skillId, "SKILL.md");
          if (skillMd?.content) {
            skillIds.add(skillId);
            continue;
          }
          // 两者都不存在，标记失败
          failedIds.push(skillId);
          this.log.warn("已学习技能加载失败，包不存在或已损坏", { agentId, skillId });
        } catch (err) {
          failedIds.push(skillId);
          this.log.warn("已学习技能加载失败", { agentId, skillId, error: err?.message, stack: err?.stack });
        }
      }
    } catch (err) {
      this.log.error("加载已学习技能列表失败", { agentId, error: err?.message, stack: err?.stack });
    }

    this._learnedByAgent.set(agentId, skillIds);

    // 若有加载失败的技能，自动卸载并更新磁盘
    if (failedIds.length > 0) {
      await this._saveLearned(agentId);
    }

    return { failedIds };
  }

  /**
   * 将内存中的已学习技能 ID 集合写入 skills.json。
   * @param {string} agentId
   * @returns {Promise<void>}
   */
  async _saveLearned(agentId) {
    const skillIds = this._learnedByAgent.get(agentId);
    if (!skillIds) return;

    const idList = Array.from(skillIds);
    const filePath = this._getSkillsFilePath(agentId);
    const dir = path.dirname(filePath);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, JSON.stringify({ learnedSkillIds: idList }, null, 2), "utf-8");
    } catch (err) {
      this.log.error("保存已学习技能列表失败", { agentId, filePath, error: err?.message, stack: err?.stack });
    }
  }

  /**
   * 标记技能为已学习。
   * 验证技能包存在，但不缓存内容。
   * @param {string} agentId
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async markSkillLearned(agentId, skillId) {
    await this._loadLearned(agentId);
    const skillIds = this._learnedByAgent.get(agentId);

    if (skillIds.has(skillId)) {
      return; // 已学习，跳过
    }

    try {
      // 验证技能包存在（不缓存内容）
      const sysPrompt = await this.repository.readSkillFile(skillId, "SYSTEM_PROMPT.md");
      if (sysPrompt?.content) {
        skillIds.add(skillId);
        await this._saveLearned(agentId);
        return;
      }
      const skillMd = await this.repository.readSkillFile(skillId, "SKILL.md");
      if (skillMd?.content) {
        skillIds.add(skillId);
        await this._saveLearned(agentId);
        return;
      }
      // 两者都不存在，不记录
      this.log.warn("markSkillLearned 技能无可读内容", { agentId, skillId });
    } catch (err) {
      this.log.error("markSkillLearned 失败", { agentId, skillId, error: err?.message, stack: err?.stack });
    }
  }

  /**
   * 遗忘技能，从持久化记录中移除。
   * @param {string} agentId
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async forgetSkill(agentId, skillId) {
    await this._loadLearned(agentId);
    const skillIds = this._learnedByAgent.get(agentId);

    if (!skillIds.has(skillId)) {
      return; // 未学习，静默返回
    }

    skillIds.delete(skillId);
    await this._saveLearned(agentId);
  }

  /**
   * 构建已学习技能的内容块。
   * 每次调用从磁盘实时读取文件内容，保证用户编辑后立即生效。
   * @param {string} agentId
   * @returns {Promise<{content:string, failedIds:string[]}>}
   */
  async _buildLearnedContent(agentId) {
    const { failedIds } = await this._loadLearned(agentId);
    const skillIds = this._learnedByAgent.get(agentId);

    if (!skillIds || skillIds.size === 0) {
      return { content: "", failedIds };
    }

    const blocks = [];
    for (const skillId of skillIds) {
      // 每次实时读文件，不缓存
      const sysPrompt = await this.repository.readSkillFile(skillId, "SYSTEM_PROMPT.md");
      if (sysPrompt?.content) {
        blocks.push(`## 技能：${skillId}\n${sysPrompt.content}`);
        continue;
      }
      const skillMd = await this.repository.readSkillFile(skillId, "SKILL.md");
      if (skillMd?.content) {
        blocks.push(`## 技能：${skillId}\n${skillMd.content}`);
      }
    }

    if (blocks.length === 0) {
      return { content: "", failedIds };
    }

    return {
      content: `【已学习技能 — 以下为常驻提示词，每次对话均生效】\n\n${blocks.join("\n\n")}\n\n【已学习技能结束】`,
      failedIds
    };
  }
}
