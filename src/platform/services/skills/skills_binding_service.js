/**
 * 技能绑定服务。
 *
 * 责任：
 * 1. 维护岗位与智能体上的 Skill 配置关系。
 * 2. 计算智能体最终配置结果。
 * 3. 保留已配置但未安装的 Skill 标识。
 */
export class SkillsBindingService {
  /**
   * @param {{org:any, logger?:any}} options
   */
  constructor(options) {
    this.org = options.org;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
  }

  /**
   * 读取岗位绑定。
   * @param {string} roleId
   * @returns {any[]}
   */
  getRoleBindings(roleId) {
    const role = this.org.getRole(roleId);
    return this._normalizeBindings(role?.skillBindings);
  }

  /**
   * 更新岗位绑定。
   * @param {string} roleId
   * @param {any[]} bindings
   * @returns {Promise<any|null>}
   */
  async setRoleBindings(roleId, bindings) {
    const normalized = this._normalizeBindings(bindings);
    return this.org.updateRole(roleId, { skillBindings: normalized });
  }

  /**
   * 读取智能体绑定。
   * @param {string} agentId
   * @returns {any[]}
   */
  getAgentBindings(agentId) {
    const agent = this.org.getAgent(agentId);
    return this._normalizeBindings(agent?.skillBindings);
  }

  /**
   * 更新智能体绑定。
   * @param {string} agentId
   * @param {any[]} bindings
   * @returns {Promise<any|null>}
   */
  async setAgentBindings(agentId, bindings) {
    const normalized = this._normalizeBindings(bindings);
    return this.org.setAgentSkillBindings(agentId, normalized);
  }

  /**
   * 计算智能体最终配置结果。
   * 规则：agent 显式配置优先于 role 配置。
   * @param {string} agentId
   * @returns {any[]}
   */
  resolveAgentBindings(agentId) {
    const agent = this.org.getAgent(agentId);
    if (!agent) {
      return [];
    }

    const roleBindings = this.getRoleBindings(agent.roleId);
    const agentBindings = this.getAgentBindings(agentId);
    const roleMap = new Map(roleBindings.map((binding) => [binding.skillId, binding]));
    const agentMap = new Map(agentBindings.map((binding) => [binding.skillId, binding]));
    const skillIds = new Set([...roleMap.keys(), ...agentMap.keys()]);
    const entries = [];

    for (const skillId of skillIds) {
      const agentBinding = agentMap.get(skillId) ?? null;
      const roleBinding = roleMap.get(skillId) ?? null;
      if (agentBinding) {
        entries.push({
          skillId,
          configuredEnabled: agentBinding.enabled === true,
          source: "agent",
          roleConfiguredEnabled: roleBinding?.enabled === true,
          agentConfiguredEnabled: agentBinding.enabled === true
        });
        continue;
      }
      entries.push({
        skillId,
        configuredEnabled: roleBinding?.enabled === true,
        source: roleBinding ? "role" : "none",
        roleConfiguredEnabled: roleBinding?.enabled === true,
        agentConfiguredEnabled: null
      });
    }

    return entries.sort((left, right) => left.skillId.localeCompare(right.skillId, "zh-CN"));
  }

  /**
   * 列出所有被配置引用的 Skill ID。
   * @returns {string[]}
   */
  listReferencedSkillIds() {
    const result = new Set();
    const roles = this.org.listRoles() ?? [];
    const agents = this.org.listAgents() ?? [];

    for (const role of roles) {
      for (const binding of this._normalizeBindings(role?.skillBindings)) {
        result.add(binding.skillId);
      }
    }
    for (const agent of agents) {
      for (const binding of this._normalizeBindings(agent?.skillBindings)) {
        result.add(binding.skillId);
      }
    }
    return Array.from(result.values()).sort((left, right) => left.localeCompare(right, "zh-CN"));
  }

  /**
   * 查询某个 Skill 的岗位/智能体引用。
   * @param {string} skillId
   * @returns {{roles:any[], agents:any[]}}
   */
  getUsageTargets(skillId) {
    const roles = (this.org.listRoles() ?? [])
      .filter((role) => role.status !== "deleted")
      .map((role) => ({
        roleId: role.id,
        roleName: role.name,
        binding: this._normalizeBindings(role.skillBindings).find((item) => item.skillId === skillId) ?? null
      }))
      .filter((item) => item.binding);

    const agents = (this.org.listAgents() ?? [])
      .filter((agent) => agent.status !== "deleted")
      .map((agent) => {
        const resolved = this.resolveAgentBindings(agent.id).find((item) => item.skillId === skillId) ?? null;
        return {
          agentId: agent.id,
          roleId: agent.roleId,
          agentName: agent.name || agent.id,
          binding: resolved
        };
      })
      .filter((item) => item.binding?.configuredEnabled === true);

    return { roles, agents };
  }

  /**
   * 归一化绑定列表。
   * @param {any} bindings
   * @returns {{skillId:string, enabled:boolean}[]}
   */
  _normalizeBindings(bindings) {
    if (!Array.isArray(bindings)) {
      return [];
    }
    const map = new Map();
    for (const item of bindings) {
      const skillId = typeof item?.skillId === "string" ? item.skillId.trim() : "";
      if (!skillId) {
        continue;
      }
      map.set(skillId, {
        skillId,
        enabled: item?.enabled !== false
      });
    }
    return Array.from(map.values()).sort((left, right) => left.skillId.localeCompare(right.skillId, "zh-CN"));
  }
}
