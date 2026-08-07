/**
 * AgentTools — list_tool_groups 与 update_my_tool_groups 测试
 *
 * 验证：
 * 1. _executeListToolGroups 返回正确的结构
 * 2. _executeUpdateMyToolGroups 正常更新、空数组处理、无效组ID拦截
 * 3. _executeUpdateMyToolGroups 错误分支：缺少 agent、元数据缺失、岗位不存在
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AgentTools } from "../../../src/platform/runtime/tools_agent.js";
import { ToolGroupManager } from "../../../src/platform/extensions/tool_group_manager.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

describe("AgentTools - list_tool_groups", () => {
  let agentTools;
  let toolGroupManager;

  beforeEach(() => {
    const log = makeTestLogger("AgentTools");
    toolGroupManager = new ToolGroupManager({ logger: log, registerBuiltins: true });
    agentTools = new AgentTools({
      toolGroupManager,
      log
    });
  });

  it("应返回所有内置工具组", () => {
    const result = agentTools._executeListToolGroups({});

    assert.ok(Array.isArray(result.toolGroups), "应返回 toolGroups 数组");
    assert.ok(result.toolGroups.length > 0, "应至少有一个工具组");

    const orgMgmt = result.toolGroups.find(g => g.id === "org_management");
    assert.ok(orgMgmt, "应包含 org_management 组");
    assert.strictEqual(typeof orgMgmt.description, "string");
    assert.strictEqual(typeof orgMgmt.toolCount, "number");
    assert.ok(Array.isArray(orgMgmt.tools), "tools 应为数组");
    assert.strictEqual(typeof orgMgmt.isReserved, "boolean");
  });

  it("每个工具组应包含完整的结构字段", () => {
    const result = agentTools._executeListToolGroups({});

    for (const g of result.toolGroups) {
      assert.strictEqual(typeof g.id, "string", "id 应为字符串");
      assert.strictEqual(typeof g.description, "string", "description 应为字符串");
      assert.strictEqual(typeof g.toolCount, "number", "toolCount 应为数字");
      assert.ok(Array.isArray(g.tools), "tools 应为数组");
      assert.strictEqual(typeof g.isReserved, "boolean", "isReserved 应为布尔值");
    }
  });

  it("每个工具组的 tools 数组中元素应为字符串", () => {
    const result = agentTools._executeListToolGroups({});

    for (const g of result.toolGroups) {
      for (const toolName of g.tools) {
        assert.strictEqual(typeof toolName, "string", `${g.id}.tools 中元素应为字符串`);
      }
    }
  });

  it("应包含 workspace 和 network 工具组", () => {
    const result = agentTools._executeListToolGroups({});
    const ids = result.toolGroups.map(g => g.id);

    assert.ok(ids.includes("workspace"));
    assert.ok(ids.includes("network"));
    assert.ok(ids.includes("command"));
  });
});

describe("AgentTools - update_my_tool_groups", () => {
  /**
   * @param {{agentMocks?: object, roleMocks?: object}} options
   */
  function makeAgentTools(options = {}) {
    const log = makeTestLogger("AgentTools");
    const toolGroupManager = new ToolGroupManager({ logger: log, registerBuiltins: true });
    const runtime = {
      toolGroupManager,
      log,
      _agentMetaById: options.agentMocks ?? new Map(),
      org: {
        getRole: () => null,
        updateRole: async () => null,
        ...options.roleMocks
      }
    };
    return new AgentTools(runtime);
  }

  it("应成功更新有效工具组", async () => {
    let updateCall = null;
    const role = { id: "role-1", name: "Test", toolGroups: null };

    const agentTools = makeAgentTools({
      agentMocks: new Map([["agent-1", { roleId: "role-1" }]]),
      roleMocks: {
        getRole(id) { return id === "role-1" ? role : null; },
        async updateRole(id, updates) {
          updateCall = { id, updates };
          role.toolGroups = Array.isArray(updates.toolGroups) && updates.toolGroups.length > 0
            ? updates.toolGroups : null;
          return { ...role };
        }
      }
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, { toolGroups: ["workspace", "network"] });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.roleId, "role-1");
    assert.deepStrictEqual(result.toolGroups, ["workspace", "network"]);
    assert.ok(updateCall, "updateRole 应被调用");
  });

  it("传入空数组时应将 toolGroups 设为 null", async () => {
    const role = { id: "role-1", name: "Test", toolGroups: null };

    const agentTools = makeAgentTools({
      agentMocks: new Map([["agent-1", { roleId: "role-1" }]]),
      roleMocks: {
        getRole(id) { return id === "role-1" ? role : null; },
        async updateRole(id, updates) {
          role.toolGroups = Array.isArray(updates.toolGroups) && updates.toolGroups.length > 0
            ? updates.toolGroups : null;
          return { ...role };
        }
      }
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, { toolGroups: [] });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.toolGroups, null);
  });

  it("传入无效工具组ID应返回错误", async () => {
    let updateCalled = false;
    const role = { id: "role-1", name: "Test", toolGroups: null };

    const agentTools = makeAgentTools({
      agentMocks: new Map([["agent-1", { roleId: "role-1" }]]),
      roleMocks: {
        getRole(id) { return id === "role-1" ? role : null; },
        async updateRole() { updateCalled = true; return { ...role }; }
      }
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, { toolGroups: ["不存在的组", "workspace"] });

    assert.strictEqual(result.error, "invalid_tool_groups");
    assert.ok(result.message.includes("不存在的组"), "错误消息应包含无效组名");
    assert.strictEqual(updateCalled, false, "不应调用 updateRole");
  });

  it("缺少智能体上下文时应返回错误", async () => {
    const agentTools = makeAgentTools();

    const result = await agentTools._executeUpdateMyToolGroups({ agent: null }, { toolGroups: ["workspace"] });

    assert.strictEqual(result.error, "missing_agent_context");
  });

  it("智能体元数据缺失时应返回错误", async () => {
    const agentTools = makeAgentTools({
      agentMocks: new Map()  // 没有 agent-1 的元数据
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, { toolGroups: ["workspace"] });

    assert.strictEqual(result.error, "agent_meta_not_found");
  });

  it("岗位不存在时应返回错误", async () => {
    const agentTools = makeAgentTools({
      agentMocks: new Map([["agent-1", { roleId: "role-1" }]]),
      roleMocks: {
        getRole() { return null; }  // 岗位不存在
      }
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, { toolGroups: ["workspace"] });

    assert.strictEqual(result.error, "role_not_found");
  });

  it("不传 toolGroups 参数时应将岗位工具组设为 null", async () => {
    const role = { id: "role-1", name: "Test", toolGroups: ["workspace"] };

    const agentTools = makeAgentTools({
      agentMocks: new Map([["agent-1", { roleId: "role-1" }]]),
      roleMocks: {
        getRole(id) { return id === "role-1" ? role : null; },
        async updateRole(id, updates) {
          role.toolGroups = Array.isArray(updates.toolGroups) && updates.toolGroups.length > 0
            ? updates.toolGroups : null;
          return { ...role };
        }
      }
    });

    const ctx = { agent: { id: "agent-1" } };
    const result = await agentTools._executeUpdateMyToolGroups(ctx, {});

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.toolGroups, null);
  });
});
