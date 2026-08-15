/**
 * RuntimeTools — workspace 工具组映射补全测试
 *
 * 验证 file_* / delete_file / move_file / search_text 正确归入 workspace 工具组。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { RuntimeTools } from "../../src/platform/runtime/runtime_tools.js";

function makeToolDef(name) {
  return {
    type: "function",
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } }
  };
}

describe("RuntimeTools - workspace 工具组映射", () => {
  it("file_* / delete_file / move_file / search_text 归入 workspace", () => {
    const definitions = [
      makeToolDef("file_read_lines"),
      makeToolDef("file_search"),
      makeToolDef("file_line_count"),
      makeToolDef("file_read"),
      makeToolDef("file_info"),
      makeToolDef("file_stats"),
      makeToolDef("file_json_tree"),
      makeToolDef("file_json_keys"),
      makeToolDef("file_jsonl_filter"),
      makeToolDef("file_create_directory"),
      makeToolDef("file_copy_to_workspace"),
      makeToolDef("file_copy_from_workspace"),
      makeToolDef("file_check_permission"),
      makeToolDef("file_list_authorized_folders"),
      makeToolDef("delete_file"),
      makeToolDef("move_file"),
      makeToolDef("search_text")
    ];

    const updated = {};
    const runtime = {
      _toolExecutor: {
        getToolDefinitions: () => definitions
      },
      toolGroupManager: {
        updateGroupTools(groupId, tools) {
          updated[groupId] = tools.map(tool => tool.function.name);
        }
      },
      log: {
        debug() {}
      }
    };

    new RuntimeTools(runtime).registerBuiltinToolGroups();

    assert.ok(updated.workspace, "应注册 workspace 工具组");
    for (const name of [
      "file_read_lines",
      "file_search",
      "file_line_count",
      "file_read",
      "file_info",
      "file_stats",
      "file_json_tree",
      "file_json_keys",
      "file_jsonl_filter",
      "file_create_directory",
      "file_copy_to_workspace",
      "file_copy_from_workspace",
      "file_check_permission",
      "file_list_authorized_folders",
      "delete_file",
      "move_file",
      "search_text"
    ]) {
      assert.ok(updated.workspace.includes(name), `${name} 应归入 workspace 工具组`);
    }
  });
});
