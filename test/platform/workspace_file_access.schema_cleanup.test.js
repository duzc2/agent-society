/**
 * 工作区文件访问 — Schema 清理与工具定义断言
 *
 * 覆盖：
 *   - 新增 file_* 工具均出现在 ToolSchema 中
 *   - 旧 bigfile_* / localfile_* 工具名不再出现在 Schema 中
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolSchema } from "../../src/platform/runtime/tools_schema.js";

function makeSchema() {
  return new ToolSchema(
    {
      moduleLoader: {
        getToolDefinitions: () => []
      }
    },
    {
      _buildCapabilityToolDefinitions: () => []
    }
  );
}

function toolNames(schema) {
  return schema
    .getToolDefinitions()
    .map(def => def?.function?.name)
    .filter(Boolean);
}

describe("ToolSchema 文件工具清理", () => {
  it("新增 file_* 工具全部存在", () => {
    const schema = makeSchema();
    const names = toolNames(schema);

    const expected = [
      "file_read",
      "file_info",
      "file_stats",
      "file_json_tree",
      "file_json_keys",
      "file_jsonl_filter",
      "file_create_directory",
      "copy_file",
      "file_check_permission",
      "file_list_authorized_folders"
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `缺少工具 ${name}`);
    }
  });

  it("扩展的 workspace 文件工具仍存在", () => {
    const schema = makeSchema();
    const names = toolNames(schema);

    const expected = [
      "file_read_lines",
      "file_search",
      "file_line_count",
      "edit_file",
      "replace_file",
      "append_file",
      "list_files",
      "delete_file",
      "move_file",
      "search_text"
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `缺少工具 ${name}`);
    }
  });

  it("不再包含 bigfile_* / localfile_* 旧工具", () => {
    const schema = makeSchema();
    const names = toolNames(schema);

    const stale = names.filter(name => name.startsWith("bigfile_") || name.startsWith("localfile_"));
    assert.deepStrictEqual(stale, []);
  });
});
