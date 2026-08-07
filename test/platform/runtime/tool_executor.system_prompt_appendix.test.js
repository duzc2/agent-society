import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

describe("工具执行器 - system prompt 记忆管理", () => {
  let toolExecutor;
  let mockCtx;

  beforeEach(() => {
    toolExecutor = new ToolExecutor({
      log: makeTestLogger("ToolExecutor"),
      moduleLoader: {
        getToolDefinitions: () => [],
        hasToolName: () => false
      }
    });

    mockCtx = {
      agent: {
        id: "agent-1",
        systemPromptAppendix: []
      },
      org: {
        setAgentSystemPromptAppendix: async (_agentId, items) => ({
          success: true,
          items
        })
      }
    };
  });

  it("工具定义应提供增删改接口", () => {
    const tools = toolExecutor.getToolDefinitions();
    const toolNames = tools.map((tool) => tool.function?.name);

    assert.ok(toolNames.includes("get_system_prompt_appendix"));
    assert.ok(toolNames.includes("add_system_prompt_appendix_item"));
    assert.ok(toolNames.includes("remove_system_prompt_appendix_item"));
    assert.ok(toolNames.includes("update_system_prompt_appendix_item"));
    assert.ok(!toolNames.includes("set_system_prompt_appendix"));
  });

  it("应新增一条记忆", async () => {
    const result = await toolExecutor._executeAddSystemPromptAppendixItem(mockCtx, {
      item: "记忆A"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.index, 0);
    assert.deepStrictEqual(result.items, ["记忆A"]);
    assert.deepStrictEqual(mockCtx.agent.systemPromptAppendix, ["记忆A"]);
  });

  it("应删除指定索引的记忆", async () => {
    mockCtx.agent.systemPromptAppendix = ["记忆A", "记忆B"];

    const result = await toolExecutor._executeRemoveSystemPromptAppendixItem(mockCtx, {
      index: 0
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, "记忆A");
    assert.deepStrictEqual(result.items, ["记忆B"]);
    assert.deepStrictEqual(mockCtx.agent.systemPromptAppendix, ["记忆B"]);
  });

  it("应修改指定索引的记忆", async () => {
    mockCtx.agent.systemPromptAppendix = ["记忆A", "记忆B"];

    const result = await toolExecutor._executeUpdateSystemPromptAppendixItem(mockCtx, {
      index: 1,
      content: "记忆B-更新"
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.index, 1);
    assert.strictEqual(result.item, "记忆B-更新");
    assert.deepStrictEqual(result.items, ["记忆A", "记忆B-更新"]);
    assert.deepStrictEqual(mockCtx.agent.systemPromptAppendix, ["记忆A", "记忆B-更新"]);
  });

  it("应返回记忆列表", () => {
    mockCtx.agent.systemPromptAppendix = ["记忆A", "记忆B"];
    const result = toolExecutor._executeGetSystemPromptAppendix(mockCtx);

    assert.deepStrictEqual(result.items, ["记忆A", "记忆B"]);
    assert.strictEqual(result.count, 2);
  });

  it("应拒绝越界删除", async () => {
    mockCtx.agent.systemPromptAppendix = ["记忆A"];
    const result = await toolExecutor._executeRemoveSystemPromptAppendixItem(mockCtx, {
      index: 2
    });

    assert.strictEqual(result.error, "index_out_of_range");
  });
});
