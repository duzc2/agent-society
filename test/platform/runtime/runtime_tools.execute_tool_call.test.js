/**
 * RuntimeTools — executeToolCall 执行入口工具组归属拦截测试
 *
 * 验证：
 * 1. 未授权工具调用在唯一执行漏斗上被拒绝，返回 tool_not_authorized
 * 2. 授权工具正常放行并透传结果
 * 3. 始终允许工具（get_org_structure）直接执行
 * 4. ctx 缺少 agent 时失败关闭（拒绝执行）
 * 5. root 智能体仅能执行 org_management 工具
 * 6. 模块工具（chrome_*）按岗位 toolGroups 拦截/放行
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeTools } from "../../../src/platform/runtime/runtime_tools.js";

/**
 * 构建 mock runtime。
 * @param {{toolGroups?: string[]|null, toolNameToGroup?: object}} options
 */
function makeRuntime(options = {}) {
  const toolGroups = options.toolGroups !== undefined ? options.toolGroups : null;
  const toolNameToGroup = options.toolNameToGroup ?? {
    find_role_by_name: "org_management",
    get_org_structure: "org_management",
    file_read_lines: "workspace",
    chrome_new_tab: "chrome"
  };

  const errorLogs = [];
  let executeCount = 0;

  const runtime = {
    log: {
      debug() {},
      info() {},
      warn() {},
      error(...args) { errorLogs.push(args); }
    },
    _agentMetaById: new Map([["agent-1", { roleId: "role-1" }]]),
    org: {
      getRole: () => ({ toolGroups })
    },
    toolGroupManager: {
      isToolInGroups(toolName, groupIds) {
        const group = toolNameToGroup[toolName];
        return group ? groupIds.includes(group) : false;
      }
    },
    _toolExecutor: {
      async executeToolCall() {
        executeCount += 1;
        return { ok: true };
      }
    }
  };

  return { runtime, errorLogs, getExecuteCount: () => executeCount };
}

describe("RuntimeTools - executeToolCall 工具组归属拦截", () => {
  it("未授权工具调用应被拒绝，且不进入执行器", async () => {
    const { runtime, getExecuteCount } = makeRuntime({ toolGroups: null });
    const runtimeTools = new RuntimeTools(runtime);

    const result = await runtimeTools.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1", taskId: "t1" } },
      "file_read_lines",
      { path: "x.txt" }
    );

    assert.strictEqual(result.error, "tool_not_authorized", "应返回未授权错误");
    assert.strictEqual(result.toolName, "file_read_lines");
    assert.strictEqual(getExecuteCount(), 0, "执行器不应被调用");
  });

  it("未授权拦截必须记录完整错误日志（含业务上下文）", async () => {
    const { runtime, errorLogs } = makeRuntime({ toolGroups: null });
    const runtimeTools = new RuntimeTools(runtime);

    await runtimeTools.executeToolCall(
      { agent: { id: "agent-1" }, currentMessage: { id: "m1" } },
      "file_read_lines",
      { path: "x.txt" }
    );

    assert.strictEqual(errorLogs.length, 1, "应记录一条错误日志");
    const logEntry = errorLogs[0][1];
    assert.strictEqual(logEntry.code, "tool_not_authorized");
    assert.strictEqual(logEntry.agentId, "agent-1");
    assert.strictEqual(logEntry.toolName, "file_read_lines");
    assert.strictEqual(logEntry.messageId, "m1");
    assert.ok(typeof logEntry.message === "string" && logEntry.message.length > 0, "应有错误消息");
    assert.ok(typeof logEntry.stack === "string" && logEntry.stack.length > 0, "应有堆栈");
  });

  it("授权工具应放行并透传执行结果", async () => {
    const { runtime, getExecuteCount } = makeRuntime({ toolGroups: ["workspace"] });
    const runtimeTools = new RuntimeTools(runtime);

    const result = await runtimeTools.executeToolCall(
      { agent: { id: "agent-1" } },
      "file_read_lines",
      { path: "x.txt" }
    );

    assert.deepStrictEqual(result, { ok: true }, "应透传执行结果");
    assert.strictEqual(getExecuteCount(), 1, "执行器应被调用一次");
  });

  it("get_org_structure 始终允许执行", async () => {
    const { runtime, getExecuteCount } = makeRuntime({ toolGroups: null });
    const runtimeTools = new RuntimeTools(runtime);

    const result = await runtimeTools.executeToolCall({ agent: { id: "agent-1" } }, "get_org_structure", {});

    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(getExecuteCount(), 1);
  });

  it("ctx 缺少 agent 时应失败关闭（拒绝执行）", async () => {
    const { runtime, getExecuteCount } = makeRuntime({ toolGroups: null });
    const runtimeTools = new RuntimeTools(runtime);

    const result = await runtimeTools.executeToolCall({}, "find_role_by_name", {});

    assert.strictEqual(result.error, "tool_not_authorized", "缺少 agent 上下文必须拒绝");
    assert.strictEqual(getExecuteCount(), 0);
  });

  it("root 智能体仅能执行 org_management 工具", async () => {
    const { runtime, getExecuteCount } = makeRuntime({ toolGroups: ["workspace", "chrome"] });
    const runtimeTools = new RuntimeTools(runtime);

    const orgResult = await runtimeTools.executeToolCall({ agent: { id: "root" } }, "find_role_by_name", {});
    assert.deepStrictEqual(orgResult, { ok: true }, "root 应能执行 org_management 工具");

    const deniedResult = await runtimeTools.executeToolCall({ agent: { id: "root" } }, "file_read_lines", {});
    assert.strictEqual(deniedResult.error, "tool_not_authorized", "root 不应能执行 workspace 工具");

    const chromeResult = await runtimeTools.executeToolCall({ agent: { id: "root" } }, "chrome_new_tab", {});
    assert.strictEqual(chromeResult.error, "tool_not_authorized", "root 不应能执行 chrome 工具");

    assert.strictEqual(getExecuteCount(), 1, "只有授权的调用进入执行器");
  });

  it("模块工具（chrome_*）按岗位 toolGroups 拦截/放行", async () => {
    // 未分配 chrome 组 → 拒绝
    const denied = makeRuntime({ toolGroups: null });
    const deniedTools = new RuntimeTools(denied.runtime);
    const deniedResult = await deniedTools.executeToolCall({ agent: { id: "agent-1" } }, "chrome_new_tab", {});
    assert.strictEqual(deniedResult.error, "tool_not_authorized", "未分配 chrome 组必须拒绝");
    assert.strictEqual(denied.getExecuteCount(), 0);

    // 分配 chrome 组 → 放行
    const allowed = makeRuntime({ toolGroups: ["chrome"] });
    const allowedTools = new RuntimeTools(allowed.runtime);
    const allowedResult = await allowedTools.executeToolCall({ agent: { id: "agent-1" } }, "chrome_new_tab", {});
    assert.deepStrictEqual(allowedResult, { ok: true }, "分配 chrome 组应放行");
    assert.strictEqual(allowed.getExecuteCount(), 1);
  });
});
