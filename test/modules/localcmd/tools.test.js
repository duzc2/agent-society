/**
 * localcmd 工具 schema 回归测试
 *
 * 验证 spawn 新增的 pushEvents 参数与描述说明，其余工具 schema 关键结构不变。
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import { getToolDefinitions } from "../../../modules/localcmd/tools.js";

describe("localcmd tools schema", () => {
  it("工具数量与名称保持不变（6 个）", () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 6);
    assert.deepStrictEqual(
      defs.map(d => d.function.name),
      [
        "localcmd_spawn",
        "localcmd_send_input",
        "localcmd_read_output",
        "localcmd_get_status",
        "localcmd_list",
        "localcmd_kill"
      ]
    );
  });

  it("localcmd_spawn 含 pushEvents 参数（boolean，默认 true）", () => {
    const spawn = getToolDefinitions().find(d => d.function.name === "localcmd_spawn");
    assert.ok(spawn, "应存在 localcmd_spawn");

    const props = spawn.function.parameters.properties;
    assert.ok(props.pushEvents, "应包含 pushEvents 参数");
    assert.strictEqual(props.pushEvents.type, "boolean");
    assert.strictEqual(props.pushEvents.default, true);

    // required 保持 ["command", "intent"] 不变
    assert.deepStrictEqual(spawn.function.parameters.required, ["command", "intent"]);
  });

  it("localcmd_spawn 描述说明主动推送行为（30 秒 / 150 行 / 关闭方式）", () => {
    const spawn = getToolDefinitions().find(d => d.function.name === "localcmd_spawn");
    const desc = spawn.function.description;
    assert.ok(desc.includes("推送"), "描述应说明主动推送");
    assert.ok(desc.includes("30 秒"), "描述应说明 30 秒批量推送");
    assert.ok(desc.includes("150 行"), "描述应说明 150 行截断");
    assert.ok(desc.includes("2KB"), "描述应说明 2KB 截断");
    assert.ok(desc.includes("pushEvents=false"), "描述应说明关闭推送的方式");
    // fire-and-forget 语义保留
    assert.ok(desc.includes("立即返回"), "描述应保留立即返回语义");
  });

  it("localcmd_read_output 关键参数不变", () => {
    const read = getToolDefinitions().find(d => d.function.name === "localcmd_read_output");
    assert.ok(read, "应存在 localcmd_read_output");
    const props = read.function.parameters.properties;
    assert.ok(props.processId, "processId 参数应存在");
    assert.ok(props.offset, "offset 参数应存在");
    assert.ok(props.window, "window 参数应存在");
  });
});
