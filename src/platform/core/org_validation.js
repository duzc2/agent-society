/**
 * 验证岗位数据结构
 * @param {any} role
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateRole(role) {
  const errors = [];
  if (!role || typeof role !== "object") {
    errors.push("岗位必须是对象");
    return { valid: false, errors };
  }
  if (typeof role.id !== "string" || role.id.length === 0) {
    errors.push("岗位ID必须是非空字符串");
  }
  if (typeof role.name !== "string" || role.name.length === 0) {
    errors.push("岗位名称必须是非空字符串");
  }
  if (typeof role.rolePrompt !== "string") {
    errors.push("岗位提示词必须是字符串");
  }
  if (role.orgPrompt !== undefined && role.orgPrompt !== null && typeof role.orgPrompt !== "string") {
    errors.push("岗位组织架构提示词必须是字符串或null");
  }
  // toolGroups 是可选的，如果存在则必须是字符串数组或 null
  if (role.toolGroups !== undefined && role.toolGroups !== null) {
    if (!Array.isArray(role.toolGroups)) {
      errors.push("岗位工具组必须是数组或null");
    } else if (!role.toolGroups.every(g => typeof g === "string")) {
      errors.push("岗位工具组数组元素必须是字符串");
    }
  }
  if (role.skillBindings !== undefined && role.skillBindings !== null) {
    if (!Array.isArray(role.skillBindings)) {
      errors.push("岗位 skillBindings 必须是数组");
    } else if (!role.skillBindings.every((item) => typeof item?.skillId === "string" && typeof item?.enabled === "boolean")) {
      errors.push("岗位 skillBindings 条目必须包含 skillId 和 enabled");
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 验证智能体数据结构
 * @param {any} agent
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateAgent(agent) {
  const errors = [];
  if (!agent || typeof agent !== "object") {
    errors.push("智能体必须是对象");
    return { valid: false, errors };
  }
  if (typeof agent.id !== "string" || agent.id.length === 0) {
    errors.push("智能体ID必须是非空字符串");
  }
  if (typeof agent.roleId !== "string" || agent.roleId.length === 0) {
    errors.push("智能体roleId必须是非空字符串");
  }
  if (typeof agent.parentAgentId !== "string" || agent.parentAgentId.length === 0) {
    errors.push("智能体parentAgentId必须是非空字符串");
  }
  if (agent.skillBindings !== undefined && agent.skillBindings !== null) {
    if (!Array.isArray(agent.skillBindings)) {
      errors.push("智能体 skillBindings 必须是数组");
    } else if (!agent.skillBindings.every((item) => typeof item?.skillId === "string" && typeof item?.enabled === "boolean")) {
      errors.push("智能体 skillBindings 条目必须包含 skillId 和 enabled");
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 验证删除记录数据结构
 * @param {any} deletion
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateDeletion(deletion) {
  const errors = [];
  if (!deletion || typeof deletion !== "object") {
    errors.push("删除记录必须是对象");
    return { valid: false, errors };
  }
  if (typeof deletion.agentId !== "string" || deletion.agentId.length === 0) {
    errors.push("删除记录agentId必须是非空字符串");
  }
  if (typeof deletion.deletedBy !== "string" || deletion.deletedBy.length === 0) {
    errors.push("删除记录deletedBy必须是非空字符串");
  }
  if (typeof deletion.deletedAt !== "string" || deletion.deletedAt.length === 0) {
    errors.push("删除记录deletedAt必须是非空字符串");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 验证联系人条目数据结构
 * @param {any} contact
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateOrgNames(orgNames) {
  const errors = [];
  /** @type {Object<string, string>} */
  const validOrgNames = {};

  if (orgNames === undefined || orgNames === null) {
    return { valid: true, errors, validOrgNames };
  }

  if (typeof orgNames !== "object" || Array.isArray(orgNames)) {
    errors.push("orgNames必须是对象");
    return { valid: false, errors, validOrgNames };
  }

  for (const [agentId, orgName] of Object.entries(orgNames)) {
    if (typeof agentId !== "string" || agentId.length === 0) {
      errors.push(`orgNames key "${agentId}" 必须是非空字符串`);
    } else if (typeof orgName !== "string" || orgName.length === 0) {
      errors.push(`orgNames["${agentId}"] 必须是非空字符串`);
    } else {
      validOrgNames[agentId] = orgName;
    }
  }

  return { valid: errors.length === 0, errors, validOrgNames };
}

/**
 * 验证完整的组织状态数据结构
 * @param {any} data
 * @returns {{valid: boolean, errors: string[], validRoles: any[], validAgents: any[], validDeletions: any[]}}
 */
export function validateOrgState(data) {
  const errors = [];
  const validRoles = [];
  const validAgents = [];
  const validDeletions = [];
  /** @type {Object<string, string>} */
  let validOrgNames = {};

  if (!data || typeof data !== "object") {
    errors.push("组织状态必须是对象");
    return { valid: false, errors, validRoles, validAgents, validDeletions, validOrgNames };
  }

  // 验证roles数组
  if (!Array.isArray(data.roles)) {
    errors.push("roles必须是数组");
  } else {
    for (let i = 0; i < data.roles.length; i++) {
      const role = data.roles[i];
      const result = validateRole(role);
      if (result.valid) {
        validRoles.push(role);
      } else {
        errors.push(`roles[${i}]: ${result.errors.join(", ")}`);
      }
    }
  }

  // 验证agents数组
  if (!Array.isArray(data.agents)) {
    errors.push("agents必须是数组");
  } else {
    for (let i = 0; i < data.agents.length; i++) {
      const agent = data.agents[i];
      const result = validateAgent(agent);
      if (result.valid) {
        validAgents.push(agent);
      } else {
        errors.push(`agents[${i}]: ${result.errors.join(", ")}`);
      }
    }
  }

  // 验证deletions数组
  if (data.deletions !== undefined && !Array.isArray(data.deletions)) {
    errors.push("deletions必须是数组");
  } else if (Array.isArray(data.deletions)) {
    for (let i = 0; i < data.deletions.length; i++) {
      const deletion = data.deletions[i];
      const result = validateDeletion(deletion);
      if (result.valid) {
        validDeletions.push(deletion);
      } else {
        errors.push(`deletions[${i}]: ${result.errors.join(", ")}`);
      }
    }
  }

  // 验证orgNames对象
  const orgNamesResult = validateOrgNames(data.orgNames);
  if (!orgNamesResult.valid) {
    errors.push(...orgNamesResult.errors);
  }
  validOrgNames = orgNamesResult.validOrgNames;

  return {
    valid: errors.length === 0,
    errors,
    validRoles,
    validAgents,
    validDeletions,
    validOrgNames
  };
}
