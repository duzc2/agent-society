/**
 * ToolExecutor — list_tool_groups / update_my_tool_groups 分发测试
 *
 * 验证 ToolExecutor 正确将新工具请求分发到 AgentTools。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

describe("ToolExecutor - 新工具分发", () => {
  let toolExecutor;

  beforeEach(() => {
    const log = makeTestLogger("ToolExecutor");
    toolExecutor = new ToolExecutor({
      log,
      toolGroupManager: {
        listGroups: () => [
          {
            id: "org_management",
            description: "组织管理工具",
            toolCount: 5,
            tools: ["find_role_by_name", "create_role"],
            isReserved: true
          },
          {
            id: "workspace",
            description: "工作空间工具",
            toolCount: 3,
            tools: ["file_read_lines", "file_search"],
            isReserved: true
          }
        ],
        getToolDefinitions: () => [],
        getAllGroupIds: () => ["org_management", "workspace"]
      },
      _agentMetaById: new Map([["agent-1", { roleId: "role-1" }]]),
      org: {
        getRole: (roleId) => {
          if (roleId === "role-1") return { id: "role-1", name: "Test", toolGroups: null };
          return null;
        },
        updateRole: async () => ({ id: "role-1", name: "Test", toolGroups: null })
      },
      moduleLoader: {
        getToolDefinitions: () => [],
        hasToolName: () => false
      }
    });
  });

  it("executeToolCall 应正确分发 list_tool_groups", async () => {
    const ctx = { agent: { id: "agent-1" } };
    const result = await toolExecutor.executeToolCall(ctx, "list_tool_groups", {});

    assert.ok(Array.isArray(result.toolGroups));
    assert.strictEqual(result.toolGroups.length, 2);
    assert.strictEqual(result.toolGroups[0].id, "org_management");
    assert.strictEqual(result.toolGroups[1].id, "workspace");
  });

  it("executeToolCall 应正确分发 update_my_tool_groups", async () => {
    const ctx = { agent: { id: "agent-1" } };
    const result = await toolExecutor.executeToolCall(ctx, "update_my_tool_groups", {
      toolGroups: ["workspace"]
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.roleId, "role-1");
  });

  it("list_tool_groups 应在工具定义中可见", () => {
    const defs = toolExecutor.getToolDefinitions();
    const names = defs.map(d => d?.function?.name).filter(Boolean);

    assert.ok(names.includes("list_tool_groups"), "list_tool_groups 应在工具列表中");
    assert.ok(names.includes("update_my_tool_groups"), "update_my_tool_groups 应在工具列表中");
  });
});
