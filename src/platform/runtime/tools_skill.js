/**
 * 技能管理工具 — 从 tool_executor.js 提取
 * @module runtime/技能管理工具
 */

import { getErrorMessage } from "../utils/error_utils.js";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";

export class SkillTools {
  constructor(runtime) {
    this.runtime = runtime;
  }

/**
   * 加载技能详情。
   * @param {object} ctx - 智能体上下文
   * @param {{skill?: string, skillId?: string, path?: string}} args - 工具参数
   * @returns {Promise<{skillId:string, skillName:string, path:string, content:string} | {error: string, message: string}>}
   */
  async _executeLoadSkillDetail(ctx, args) {
    const runtime = this.runtime;
    const agent = ctx.agent;

    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }

    if (!runtime.skillsService) {
      return { error: "skills_not_initialized", message: "技能系统未初始化" };
    }

    const skillIdentifier = typeof args?.skill === "string"
      ? args.skill.trim()
      : (typeof args?.skillId === "string" ? args.skillId.trim() : "");
    const relativePath = typeof args?.path === "string" && args.path.trim()
      ? args.path.trim()
      : "SKILL.md";
    if (!skillIdentifier) {
      return { error: "invalid_skill_identifier", message: "skill 不能为空" };
    }

    try {
      // 先检查技能是否可见
      const resolved = await runtime.skillsService.resolveVisibleSkill(agent.id, skillIdentifier);
      if (!resolved) {
        return { error: "skill_not_visible", message: `技能 ${skillIdentifier} 当前不可见或不允许访问` };
      }

      // 再检查文件是否存在
      const file = await runtime.skillsService.repository.readSkillFile(resolved.skillId, relativePath);
      if (!file) {
        return { error: "file_not_found", message: `技能 ${skillIdentifier} 中文件 "${relativePath}" 不存在` };
      }

      // 标记为已学习，使该技能常驻 system prompt
      await runtime.skillsService.markSkillLearned(agent.id, resolved.skillId);

      return {
        skillId: resolved.skillId,
        skillName: resolved.displayName,
        path: file.resolvedPath,
        content: file.content
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "load_skill_failed", message };
    }
  }

/**
   * 执行技能脚本。
   * @param {object} ctx - 智能体上下文
   * @param {{skill?: string, skillId?: string, scriptPath: string, args?: string[]}} args - 工具参数
   * @returns {Promise<any>}
   */
  async _executeRunSkillScript(ctx, args) {
    const runtime = this.runtime;
    const agent = ctx.agent;

    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }

    if (!runtime.skillsService) {
      return { error: "skills_not_initialized", message: "技能系统未初始化" };
    }

    const skillIdentifier = typeof args?.skill === "string"
      ? args.skill.trim()
      : (typeof args?.skillId === "string" ? args.skillId.trim() : "");
    const scriptPath = typeof args?.scriptPath === "string" ? args.scriptPath.trim() : "";
    const scriptArgs = Array.isArray(args?.args) ? args.args.map((item) => String(item)) : [];

    if (!skillIdentifier) {
      return { error: "invalid_skill_identifier", message: "skill 不能为空" };
    }
    if (!scriptPath) {
      return { error: "invalid_script_path", message: "scriptPath 不能为空" };
    }

    const visibleSkill = await runtime.skillsService.resolveVisibleSkill(agent.id, skillIdentifier);
    if (!visibleSkill) {
      return { error: "skill_not_visible", message: `技能 ${skillIdentifier} 当前不可见或不存在` };
    }

    const orgId = ctx.runtime.findWorkspaceIdForAgent(agent.id);
    const skillCwd = orgId ? getWorkspaceManager().getWorkspacePath(orgId) : undefined;

    try {
      return await runtime.skillsService.runSkillScript({
        skillId: visibleSkill.skillId,
        scriptPath,
        args: scriptArgs,
        cwd: skillCwd
      });
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "run_skill_script_failed", message };
    }
  }

  _simplifySkillRecord(record) {
    return {
      skillId: record.skillId,
      displayName: record.displayName,
      description: record.description || "",
      status: record.status,
      hasScripts: record.hasScripts || false,
      packageFiles: record.packageFiles || []
    };
  }

  async _executeSkillList(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    try {
      const skills = await runtime.customSkillService.listCustomSkills();
      const simplified = skills.map((s) => this._simplifySkillRecord(s));
      return { ok: true, skills: simplified };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "list_custom_skills_failed", message };
    }
  }

  async _executeSkillGet(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    try {
      const result = await runtime.customSkillService.getCustomSkill(skillId);
      if (!result) {
        return { error: "skill_not_found", message: `自定义技能 ${skillId} 不存在` };
      }
      return {
        ok: true,
        skill: this._simplifySkillRecord(result.skill),
        tree: result.tree
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "get_custom_skill_failed", message };
    }
  }

  async _executeSkillCreate(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    try {
      const result = await runtime.customSkillService.createCustomSkill({
        displayName: typeof args?.displayName === "string" ? args.displayName.trim() : undefined
      });
      return {
        ok: true,
        skill: this._simplifySkillRecord(result.skill),
        tree: result.tree
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "create_custom_skill_failed", message };
    }
  }

  async _executeSkillCopy(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const sourceSkillId = typeof args?.sourceSkillId === "string" ? args.sourceSkillId.trim() : "";
    if (!sourceSkillId) {
      return { error: "invalid_source_skill_id", message: "sourceSkillId 不能为空" };
    }
    try {
      const result = await runtime.customSkillService.copySkillAsCustom({
        sourceSkillId,
        displayName: typeof args?.displayName === "string" ? args.displayName.trim() : undefined
      });
      return {
        ok: true,
        skill: this._simplifySkillRecord(result.skill),
        tree: result.tree
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "copy_skill_as_custom_failed", message };
    }
  }

  async _executeSkillReadFile(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const filePath = typeof args?.filePath === "string" ? args.filePath.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!filePath) {
      return { error: "invalid_file_path", message: "filePath 不能为空" };
    }
    try {
      const result = await runtime.customSkillService.readCustomSkillFile(skillId, filePath);
      if (!result) {
        return { error: "file_not_found", message: `文件 ${filePath} 不存在` };
      }
      // 简化返回，只保留关键字段
      return {
        ok: true,
        path: result.path,
        content: result.content
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "read_custom_skill_file_failed", message };
    }
  }

  async _executeSkillWriteFile(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const filePath = typeof args?.filePath === "string" ? args.filePath.trim() : "";
    const content = typeof args?.content === "string" ? args.content : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!filePath) {
      return { error: "invalid_file_path", message: "filePath 不能为空" };
    }
    try {
      await runtime.customSkillService.writeCustomSkillFile(skillId, filePath, content);
      return { ok: true, message: "文件已保存" };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "write_custom_skill_file_failed", message };
    }
  }

  async _executeSkillCreateFile(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const filePath = typeof args?.filePath === "string" ? args.filePath.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!filePath) {
      return { error: "invalid_file_path", message: "filePath 不能为空" };
    }
    try {
      await runtime.customSkillService.createCustomSkillFile(skillId, filePath);
      return { ok: true, message: "文件已创建", path: filePath };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "create_custom_skill_file_failed", message };
    }
  }

  async _executeSkillCreateFolder(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const folderPath = typeof args?.folderPath === "string" ? args.folderPath.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!folderPath) {
      return { error: "invalid_folder_path", message: "folderPath 不能为空" };
    }
    try {
      await runtime.customSkillService.createCustomSkillFolder(skillId, folderPath);
      return { ok: true, message: "文件夹已创建", path: folderPath };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "create_custom_skill_folder_failed", message };
    }
  }

  async _executeSkillDeleteEntry(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const entryPath = typeof args?.entryPath === "string" ? args.entryPath.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!entryPath) {
      return { error: "invalid_entry_path", message: "entryPath 不能为空" };
    }
    try {
      await runtime.customSkillService.deleteCustomSkillEntry(skillId, entryPath);
      return { ok: true, message: "已删除", path: entryPath };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "delete_custom_skill_entry_failed", message };
    }
  }

  async _executeSkillRenameEntry(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const fromPath = typeof args?.fromPath === "string" ? args.fromPath.trim() : "";
    const toPath = typeof args?.toPath === "string" ? args.toPath.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (!fromPath) {
      return { error: "invalid_from_path", message: "fromPath 不能为空" };
    }
    if (!toPath) {
      return { error: "invalid_to_path", message: "toPath 不能为空" };
    }
    try {
      await runtime.customSkillService.renameCustomSkillEntry(skillId, fromPath, toPath);
      return { ok: true, message: "已重命名", from: fromPath, to: toPath };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "rename_custom_skill_entry_failed", message };
    }
  }

  async _executeSkillSetStatus(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    const status = typeof args?.status === "string" ? args.status.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    if (status !== "enabled" && status !== "disabled") {
      return { error: "invalid_status", message: "status 必须是 enabled 或 disabled" };
    }
    try {
      await runtime.customSkillService.setCustomSkillStatus(skillId, status);
      return { ok: true, message: `技能已${status === "enabled" ? "启用" : "禁用"}` };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "set_custom_skill_status_failed", message };
    }
  }

  async _executeSkillDelete(ctx, args) {
    const runtime = this.runtime;
    if (!runtime.customSkillService) {
      return { error: "custom_skills_not_initialized", message: "自定义技能系统未初始化" };
    }
    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }
    try {
      await runtime.customSkillService.deleteCustomSkill(skillId);
      return { ok: true, message: "技能已删除" };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "delete_custom_skill_failed", message };
    }
  }

  async _executeSkillBindToAgent(ctx, args) {
    const runtime = this.runtime;
    const agent = ctx.agent;

    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }

    if (!runtime.skillsService) {
      return { error: "skills_not_initialized", message: "技能系统未初始化" };
    }

    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }

    const enabled = args?.enabled !== undefined ? Boolean(args.enabled) : true;

    try {
      // 获取当前智能体的绑定，这里包含默认的绑定，并且手动添加的绑定也会被保留
      const currentBindings = runtime.skillsService.bindingService.getAgentBindings(agent.id);

      // 构建新的绑定列表：保留所有已存在的绑定，更新或添加指定的 skillId
      const bindingMap = new Map(currentBindings.map((b) => [b.skillId, b]));
      bindingMap.set(skillId, { skillId, enabled });
      const mergedBindings = Array.from(bindingMap.values());

      const result = await runtime.skillsService.setAgentSkillBindings(agent.id, mergedBindings);
      if (!result) {
        return { error: "bind_skill_failed", message: "绑定技能失败，智能体可能不存在" };
      }

      // 验证技能是否已安装并可见
      const isVisible = result.entries.find(
        (e) => e.skillId === skillId && e.visible === true
      );

      if (!isVisible) {
        return {
          ok: true,
          skillId,
          enabled,
          bound: true,
          message: `技能 ${skillId} 已绑定到当前智能体，但技能尚未安装或已被停用（需要安装并启用后才能实际调用）。`
        };
      }

      return {
        ok: true,
        skillId,
        enabled,
        bound: true,
        visible: true,
        message: `技能 ${skillId} 已绑定到当前智能体，下次对话即可通过 load_skill_detail 加载该技能。`
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "bind_skill_to_agent_failed", message };
    }
  }

  async _executeSkillUnbindFromAgent(ctx, args) {
    const runtime = this.runtime;
    const agent = ctx.agent;

    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }

    if (!runtime.skillsService) {
      return { error: "skills_not_initialized", message: "技能系统未初始化" };
    }

    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }

    try {
      const currentBindings = runtime.skillsService.bindingService.getAgentBindings(agent.id);

      // 过滤掉要移除的技能
      const filteredBindings = currentBindings.filter((b) => b.skillId !== skillId);

      if (filteredBindings.length === currentBindings.length) {
        return {
          ok: true,
          skillId,
          bound: false,
          message: `技能 ${skillId} 未绑定到当前智能体，无需解绑。`
        };
      }

      await runtime.skillsService.setAgentSkillBindings(agent.id, filteredBindings);

      return {
        ok: true,
        skillId,
        bound: false,
        message: `技能 ${skillId} 已从当前智能体解绑。`
      };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "unbind_skill_from_agent_failed", message };
    }
  }

  async _executeForgetSkill(ctx, args) {
    const runtime = this.runtime;
    const agent = ctx.agent;

    if (!agent) {
      return { error: "agent_not_found", message: "当前智能体不存在" };
    }

    if (!runtime.skillsService) {
      return { error: "skills_not_initialized", message: "技能系统未初始化" };
    }

    const skillId = typeof args?.skillId === "string" ? args.skillId.trim() : "";
    if (!skillId) {
      return { error: "invalid_skill_id", message: "skillId 不能为空" };
    }

    try {
      await runtime.skillsService.forgetSkill(agent.id, skillId);
      return { ok: true, message: `已遗忘技能 ${skillId}` };
    } catch (err) {
      const message = getErrorMessage(err);
      return { error: "forget_skill_failed", message };
    }
  }
}
