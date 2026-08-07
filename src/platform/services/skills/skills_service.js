import path from "node:path";
import { SkillsRepository } from "./skills_repository.js";
import { SkillsBindingService } from "./skills_binding_service.js";
import { SkillsRuntimeService } from "./skills_runtime_service.js";
import { SkillsProviderRegistry } from "./skills_provider_registry.js";
import { SkillsRuntimeResolver } from "./skills_runtime_resolver.js";
import { SkillsScriptRunner } from "./skills_script_runner.js";
import { ModelScopeSkillsProvider } from "./providers/modelscope_provider.js";

/**
 * 技能系统门面。
 *
 * 责任：
 * 1. 组织来源、仓库、绑定、运行时与脚本执行模块。
 * 2. 对 HTTP 与 Runtime 提供统一接口。
 */
export class SkillsService {
  /**
   * @param {{runtime:any, dataDir:string, org:any, config?:any, logger?:any}} options
   */
  constructor(options) {
    this.runtime = options.runtime;
    this.org = options.org;
    this.config = options.config ?? {};
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    this.rootDir = path.join(options.dataDir, "skills");
    this.runtimeResolver = new SkillsRuntimeResolver({
      rootDir: this.rootDir,
      config: this.config.runtime ?? {},
      logger: this.log
    });
    this.repository = new SkillsRepository({
      rootDir: this.rootDir,
      logger: this.log
    });
    this.bindingService = new SkillsBindingService({
      org: this.org,
      logger: this.log
    });
    this.runtimeService = new SkillsRuntimeService({
      repository: this.repository,
      bindingService: this.bindingService,
      dataDir: options.dataDir,
      logger: this.log
    });
    this.providerRegistry = new SkillsProviderRegistry({ logger: this.log });
    this.scriptRunner = new SkillsScriptRunner({
      repository: this.repository,
      runtimeResolver: this.runtimeResolver,
      logger: this.log
    });
  }

  /**
   * 初始化技能系统。
   * @returns {Promise<void>}
   */
  async initialize() {
    await this.repository.initialize();
    await this.runtimeResolver.initialize();
    await this._registerProviders();
  }

  /**
   * 列出浏览目录。
   * 合并来源种子目录、仓库索引和已配置引用，保证卸载后仍可在界面看到历史配置目标。
   * @param {{query?:string}} [options]
   * @returns {Promise<any[]>}
   */
  async listCatalog(options = {}) {
    const merged = new Map();
    const rawQuery = typeof options.query === "string" ? options.query.trim() : "";
    const query = rawQuery.toLowerCase();

    for (const provider of this.providerRegistry.list()) {
      const items = await provider.listCatalog({ query: rawQuery });
      for (const item of items) {
        const skillId = this.buildSkillId(item.providerId, item.kind, item.externalId);
        merged.set(skillId, {
          skillId,
          ...item
        });
      }
    }

    for (const record of await this.repository.listKnownSkills()) {
      if (record.sourceType === "custom") {
        continue;
      }
      merged.set(record.skillId, {
        ...(merged.get(record.skillId) ?? {}),
        skillId: record.skillId,
        providerId: record.providerId,
        kind: record.kind,
        externalId: record.externalId,
        displayName: record.displayName,
        description: record.description,
        homepageUrl: record.homepageUrl,
        installUrl: record.installUrl,
        tags: record.tags,
        installState: record.installState,
        scriptEntries: record.scriptEntries
      });
    }

    for (const skillId of this.bindingService.listReferencedSkillIds()) {
      if (!merged.has(skillId)) {
        const parsed = this.parseSkillId(skillId);
        merged.set(skillId, {
          skillId,
          providerId: parsed.providerId,
          kind: parsed.kind,
          externalId: parsed.externalId,
          displayName: skillId,
          description: "已配置但当前来源目录中未提供详细元数据",
          homepageUrl: null,
          installUrl: null,
          tags: []
        });
      }
    }

    const items = [];
    for (const item of merged.values()) {
      const record = await this.repository.getSkill(item.skillId);
      const installState = record?.installState ?? item.installState ?? "uninstalled";
      const affected = this.bindingService.getUsageTargets(item.skillId);
      const normalized = {
        ...item,
        installState,
        installed: installState === "installed",
        roleUsageCount: affected.roles.length,
        agentUsageCount: affected.agents.length
      };
      const haystack = [
        normalized.skillId,
        normalized.displayName,
        normalized.description,
        normalized.externalId,
        ...(Array.isArray(normalized.tags) ? normalized.tags : [])
      ].join("\n").toLowerCase();
      if (!query || haystack.includes(query)) {
        items.push(normalized);
      }
    }

    return items.sort((left, right) => {
      if (left.installed !== right.installed) {
        return left.installed ? -1 : 1;
      }
      return String(left.displayName || left.skillId).localeCompare(String(right.displayName || right.skillId), "zh-CN");
    });
  }

  /**
   * 安装单个 Skill。
   * @param {{providerId?:string, externalId?:string, installUrl?:string}} input
   * @returns {Promise<any>}
   */
  async installSkill(input) {
    const providerId = typeof input?.providerId === "string" && input.providerId.trim()
      ? input.providerId.trim()
      : "modelscope";
    const provider = this.providerRegistry.get(providerId);
    if (!provider) {
      throw new Error("skills_provider_not_found");
    }

    const request = provider.normalizeInstallRequest(input);
    const skillId = this.buildSkillId(request.providerId, request.kind, request.externalId);
    if (await this.repository.isInstalled(skillId)) {
      return await this.repository.getSkill(skillId);
    }

    const tempDir = await this.repository.createInstallTempDir();
    try {
      const installResult = await provider.installToDirectory({ request, tempDir });
      return await this.repository.saveInstalledSkill({
        request,
        catalogItem: installResult.catalogItem,
        packageDir: installResult.packageDir
      });
    } finally {
      await this.repository.removeTempDir(tempDir);
    }
  }

  /**
   * 卸载 Skill。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async uninstallSkill(skillId) {
    return this.repository.uninstallSkill(skillId);
  }

  /**
   * 获取 Skill 总览。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getSkillOverview(skillId) {
    const skill = await this._resolveSkillCatalogItem(skillId);
    if (!skill) {
      return null;
    }

    const usage = this.bindingService.getUsageTargets(skillId);
    const skillEnabled = this._isSkillEnabled(skill);
    const roles = usage.roles.map((item) => ({
      roleId: item.roleId,
      roleName: item.roleName,
      configuredEnabled: item.binding.enabled === true,
      visible: item.binding.enabled === true && skill.installState === "installed" && skillEnabled,
      missingReason: item.binding.enabled === true
        ? this._resolveMissingReason(skill.installState, skillEnabled)
        : null
    }));

    const agents = usage.agents.map((item) => {
      const resolved = this.bindingService.resolveAgentBindings(item.agentId).find((entry) => entry.skillId === skillId) ?? null;
      const configuredEnabled = resolved?.configuredEnabled === true;
      return {
        agentId: item.agentId,
        agentName: item.agentName,
        roleId: item.roleId,
        roleName: this.org.getRole(item.roleId)?.name ?? item.roleId,
        configuredEnabled,
        source: resolved?.source ?? "agent",
        visible: configuredEnabled && skill.installState === "installed" && skillEnabled,
        missingReason: configuredEnabled
          ? this._resolveMissingReason(skill.installState, skillEnabled)
          : null,
        workspaceId: this.runtime.findWorkspaceIdForAgent(item.agentId) ?? item.agentId
      };
    });

    return {
      skill,
      roles,
      agents,
      counts: {
        roles: roles.length,
        agents: agents.length
      }
    };
  }

  /**
   * 获取技能详情内容。
   * 面向技能管理界面，优先返回已安装技能包内的 SKILL.md 与 reference.md。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getSkillContent(skillId) {
    const skill = await this._resolveSkillCatalogItem(skillId);
    if (!skill) {
      return null;
    }

    const docs = await this.repository.readSkillDocs(skillId);
    const remoteContent = await this._loadRemoteSkillContent(skill);
    const mergedSkill = {
      ...skill,
      displayName: remoteContent?.displayName || docs?.manifest?.displayName || skill.displayName,
      description: remoteContent?.description || docs?.manifest?.description || skill.description,
      homepageUrl: remoteContent?.homepageUrl || docs?.manifest?.homepageUrl || skill.homepageUrl || null,
      installUrl: remoteContent?.installUrl || docs?.manifest?.installUrl || skill.installUrl || null,
      sourceUrl: remoteContent?.sourceUrl || null
    };

    return {
      skill: mergedSkill,
      installed: skill.installState === "installed",
      manifest: docs?.manifest ?? null,
      skillMd: docs?.skillMd ?? remoteContent?.skillMd ?? "",
      referenceMd: docs?.referenceMd ?? ""
    };
  }

  /**
   * 获取岗位技能配置视图。
   * @param {string} roleId
   * @returns {Promise<any>}
   */
  async getRoleSkillBindingsView(roleId) {
    const installedSkills = await this.repository.listInstalledSkills();
    const bindingMap = new Map(this.bindingService.getRoleBindings(roleId).map((item) => [item.skillId, item]));
    return {
      targetType: "role",
      targetId: roleId,
      bindings: Array.from(bindingMap.values()),
      entries: installedSkills.map((item) => ({
        skillId: item.skillId,
        displayName: item.displayName || item.skillId,
        description: item.description || "",
        installState: item.installState,
        configuredEnabled: bindingMap.get(item.skillId)?.enabled === true,
        visible: bindingMap.get(item.skillId)?.enabled === true && item.installState === "installed" && this._isSkillEnabled(item),
        missingReason: bindingMap.get(item.skillId)?.enabled === true
          ? this._resolveMissingReason(item.installState, this._isSkillEnabled(item))
          : null,
        source: bindingMap.has(item.skillId) ? "role" : "none",
        homepageUrl: item.homepageUrl || null,
        tags: item.tags || []
      }))
    };
  }

  /**
   * 更新岗位技能配置。
   * @param {string} roleId
   * @param {any[]} bindings
   * @returns {Promise<any>}
   */
  async setRoleSkillBindings(roleId, bindings) {
    const updated = await this.bindingService.setRoleBindings(roleId, bindings);
    if (!updated) {
      return null;
    }
    return this.getRoleSkillBindingsView(roleId);
  }

  /**
   * 获取智能体技能配置视图。
   * @param {string} agentId
   * @returns {Promise<any>}
   */
  async getAgentSkillBindingsView(agentId) {
    const installedSkills = await this.repository.listInstalledSkills();
    const directMap = new Map(this.bindingService.getAgentBindings(agentId).map((item) => [item.skillId, item]));
    const effectiveMap = new Map(this.bindingService.resolveAgentBindings(agentId).map((item) => [item.skillId, item]));
    return {
      targetType: "agent",
      targetId: agentId,
      bindings: Array.from(directMap.values()),
      entries: installedSkills.map((item) => {
        const direct = directMap.get(item.skillId) ?? null;
        const effective = effectiveMap.get(item.skillId) ?? null;
        const configuredEnabled = effective?.configuredEnabled === true;
        return {
          skillId: item.skillId,
          displayName: item.displayName || item.skillId,
          description: item.description || "",
          installState: item.installState,
          configuredEnabled,
          visible: configuredEnabled && item.installState === "installed" && this._isSkillEnabled(item),
          missingReason: configuredEnabled
            ? this._resolveMissingReason(item.installState, this._isSkillEnabled(item))
            : null,
          source: effective?.source ?? "none",
          roleConfiguredEnabled: effective?.roleConfiguredEnabled === true,
          agentConfiguredEnabled: direct ? direct.enabled === true : null,
          homepageUrl: item.homepageUrl || null,
          tags: item.tags || []
        };
      })
    };
  }

  /**
   * 更新智能体技能配置。
   * @param {string} agentId
   * @param {any[]} bindings
   * @returns {Promise<any>}
   */
  async setAgentSkillBindings(agentId, bindings) {
    const updated = await this.bindingService.setAgentBindings(agentId, bindings);
    if (!updated) {
      return null;
    }
    return this.getAgentSkillBindingsView(agentId);
  }

  /**
   * 获取智能体技能摘要提示词。
   * @param {string} agentId
   * @returns {Promise<string>}
   */
  async buildAgentSkillPrompt(agentId) {
    const result = await this.runtimeService.buildAgentSkillPrompt(agentId);
    if (result.warnings && result.warnings.length > 0) {
      for (const skillId of result.warnings) {
        this.runtime.heartbeatBroker?.broadcast("error_event", {
          agentId,
          errorType: "skill_auto_unloaded",
          message: `已学习技能 "${skillId}" 包不存在或已损坏，已自动卸载`,
          timestamp: Date.now()
        });
      }
    }
    return result.prompt;
  }

  /**
   * 标记技能为已学习。
   * @param {string} agentId
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async markSkillLearned(agentId, skillId) {
    return this.runtimeService.markSkillLearned(agentId, skillId);
  }

  /**
   * 遗忘技能。
   * @param {string} agentId
   * @param {string} skillId
   * @returns {Promise<void>}
   */
  async forgetSkill(agentId, skillId) {
    return this.runtimeService.forgetSkill(agentId, skillId);
  }

  /**
   * 获取智能体可见 Skill 详情。
   * @param {string} agentId
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async getVisibleSkillDetail(agentId, skillId) {
    return this.runtimeService.getVisibleSkillDetail(agentId, skillId);
  }

  /**
   * 按 skillId 或技能名解析智能体当前可见技能。
   * @param {string} agentId
   * @param {string} identifier
   * @returns {Promise<any|null>}
   */
  async resolveVisibleSkill(agentId, identifier) {
    return this.runtimeService.resolveVisibleSkill(agentId, identifier);
  }

  /**
   * 执行技能脚本。
   * @param {{skillId:string, scriptPath:string, args?:string[]}} options
   * @returns {Promise<any>}
   */
  async runSkillScript(options) {
    return this.scriptRunner.runSkillScript(options);
  }

  /**
   * 获取运行时环境信息。
   * @returns {Promise<any>}
   */
  async getRuntimeInfo() {
    return {
      javascript: await this.runtimeResolver.getJavaScriptRuntimeInfo(),
      python: await this.runtimeResolver.getPythonPolicy()
    };
  }

  /**
   * 构造 Skill ID。
   * @param {string} providerId
   * @param {string} kind
   * @param {string} externalId
   * @returns {string}
   */
  buildSkillId(providerId, kind, externalId) {
    return `${providerId}:${kind}:${externalId}`;
  }

  /**
   * 解析 Skill ID。
   * @param {string} skillId
   * @returns {{providerId:string, kind:string, externalId:string}}
   */
  parseSkillId(skillId) {
    const [providerId = "unknown", kind = "skill", ...rest] = String(skillId ?? "").split(":");
    return {
      providerId,
      kind,
      externalId: rest.join(":")
    };
  }

  /**
   * 注册来源。
   * @returns {Promise<void>}
   */
  async _registerProviders() {
    this.providerRegistry.register(new ModelScopeSkillsProvider({
      config: this.config.providers?.modelscope ?? {},
      runtimeResolver: this.runtimeResolver,
      logger: this.log
    }));
  }

  /**
   * 按来源加载远端技能说明。
   * 这里只做界面展示用途，失败时降级为空，避免影响安装与本地已安装能力。
   * @param {any} skill
   * @returns {Promise<any|null>}
   */
  async _loadRemoteSkillContent(skill) {
    const provider = this.providerRegistry.get(skill?.providerId);
    if (!provider || typeof provider.getRemoteSkillContent !== "function") {
      return null;
    }

    try {
      return await provider.getRemoteSkillContent({
        externalId: skill.externalId,
        installUrl: skill.installUrl,
        homepageUrl: skill.homepageUrl,
        sourceUrl: skill.sourceUrl || null
      });
    } catch (err) {
      console.error("[SkillsService] 加载远端技能说明失败", {
        skillId: skill?.skillId,
        providerId: skill?.providerId,
        externalId: skill?.externalId,
        error: err?.message,
        stack: err?.stack
      });
      void this.log.warn("加载远端技能说明失败", {
        skillId: skill?.skillId,
        providerId: skill?.providerId,
        externalId: skill?.externalId,
        error: err?.message,
        stack: err?.stack
      });
      return null;
    }
  }

  /**
   * 按 skillId 解析技能目录项。
   * 设计约束：
   * 1. 已安装、已绑定、默认目录中的技能优先复用已有目录数据。
   * 2. 对于“远端搜索返回、但尚未安装”的技能，也必须能仅凭 skillId 继续查看详情。
   * 3. 这里不做远端搜索，只做稳定的本地恢复与 provider 规范化补全。
   * @param {string} skillId
   * @returns {Promise<any|null>}
   */
  async _resolveSkillCatalogItem(skillId) {
    const catalog = await this.listCatalog();
    const existing = catalog.find((item) => item.skillId === skillId) ?? null;
    if (existing) {
      return existing;
    }

    const parsed = this.parseSkillId(skillId);
    const provider = this.providerRegistry.get(parsed.providerId);
    if (!provider) {
      return null;
    }

    let normalizedRequest = null;
    try {
      normalizedRequest = provider.normalizeInstallRequest({
        externalId: parsed.externalId
      });
    } catch {
      normalizedRequest = null;
    }
    if (!normalizedRequest) {
      return null;
    }

    const record = await this.repository.getSkill(skillId);
    const usage = this.bindingService.getUsageTargets(skillId);
    const installState = record?.installState ?? "uninstalled";
    return {
      skillId,
      providerId: parsed.providerId,
      kind: parsed.kind,
      externalId: parsed.externalId,
      displayName: record?.displayName || parsed.externalId,
      description: record?.description || "",
      homepageUrl: record?.homepageUrl || normalizedRequest.homepageUrl || null,
      installUrl: record?.installUrl || normalizedRequest.installUrl || null,
      sourceUrl: record?.sourceUrl || normalizedRequest.sourceUrl || null,
      tags: Array.isArray(record?.tags) ? record.tags : [],
      installState,
      installed: installState === "installed",
      roleUsageCount: usage.roles.length,
      agentUsageCount: usage.agents.length
    };
  }

  /**
   * 判断技能当前是否处于可用启用状态。
   * @param {any} skill
   * @returns {boolean}
   */
  _isSkillEnabled(skill) {
    // custom 和 git 类型的技能有启停状态
    if (skill?.sourceType === "custom" || skill?.sourceType === "git") {
      return skill?.status === "enabled";
    }
    return true;
  }

  /**
   * 根据安装状态和启停状态计算缺失原因。
   * @param {string} installState
   * @param {boolean} enabled
   * @returns {string|null}
   */
  _resolveMissingReason(installState, enabled) {
    if (installState !== "installed") {
      return installState === "corrupted" ? "包损坏" : "未安装";
    }
    if (!enabled) {
      return "已停用";
    }
    return null;
  }
}
