/**
 * FileTools / ToolExecutor — 文件工具参数校验、服务委托与分发测试
 *
 * 覆盖：
 *   - FileTools 对必需参数的校验
 *   - FileTools 未注入 workspaceFileAccessService 时拒绝执行
 *   - FileTools 正确委托给 WorkspaceFileAccessService
 *   - ToolExecutor 将新 file_* 工具分发到 fileTools
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { FileTools } from "../../../src/platform/runtime/tools_file.js";
import { ToolExecutor } from "../../../src/platform/runtime/tool_executor.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

function ctx() {
  return { agent: { id: "agent1" }, currentMessage: { id: "msg-1" } };
}

describe("FileTools 参数校验", () => {
  it("file_read 缺少 path 返回 invalid_arguments", async () => {
    const tools = new FileTools({});
    const result = await tools._executeFileRead(ctx(), {});
    assert.strictEqual(result.error, "invalid_arguments");
  });

  it("file_jsonl_filter 缺少 field 或 pattern 返回 invalid_arguments", async () => {
    const tools = new FileTools({});
    const noField = await tools._executeFileJsonlFilter(ctx(), { path: "/a", pattern: "x" });
    assert.strictEqual(noField.error, "invalid_arguments");

    const noPattern = await tools._executeFileJsonlFilter(ctx(), { path: "/a", field: "x" });
    assert.strictEqual(noPattern.error, "invalid_arguments");
  });

  it("copy_file 缺少 sourcePath / destPath 返回 invalid_arguments", async () => {
    const tools = new FileTools({});
    const noSource = await tools._executeFileCopy(ctx(), { destPath: "/b" });
    assert.strictEqual(noSource.error, "invalid_arguments");

    const noDest = await tools._executeFileCopy(ctx(), { sourcePath: "/a" });
    assert.strictEqual(noDest.error, "invalid_arguments");
  });

  it("file_move_file 缺少源或目标路径返回 invalid_arguments", async () => {
    const tools = new FileTools({});
    const result = await tools._executeMoveFile(ctx(), {});
    assert.strictEqual(result.error, "invalid_arguments");
  });

  it("search_text 缺少 text 返回 missing_text", async () => {
    const tools = new FileTools({});
    const result = await tools._executeSearchText(ctx(), {});
    assert.strictEqual(result.error, "missing_text");
  });

  it("未注入 workspaceFileAccessService 时拒绝执行", async () => {
    const tools = new FileTools({});
    await assert.rejects(
      () => tools._executeFileRead(ctx(), { path: "/a" }),
      /workspaceFileAccessService_not_initialized/
    );
  });
});

describe("FileTools 服务委托", () => {
  it("将 file_read_lines 参数委托给 service.readLines", async () => {
    const calls = [];
    const service = {
      readLines: async (...args) => {
        calls.push(["readLines", ...args]);
        return { ok: true };
      }
    };
    const tools = new FileTools({ workspaceFileAccessService: service });
    const result = await tools._executeFileReadLines(ctx(), { path: "a.txt", start_line: 2, end_line: 5 });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], "readLines");
    assert.strictEqual(calls[0][2], "a.txt");
    assert.deepStrictEqual(calls[0][3], { start_line: 2, end_line: 5 });
  });

  it("将 file_create_directory 参数委托给 service.createDirectory", async () => {
    const calls = [];
    const service = {
      createDirectory: async (...args) => {
        calls.push(["createDirectory", ...args]);
        return { ok: true };
      }
    };
    const tools = new FileTools({ workspaceFileAccessService: service });
    const result = await tools._executeFileCreateDirectory(ctx(), { path: "dir", recursive: false });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls[0][2], "dir");
    assert.strictEqual(calls[0][3].recursive, false);
  });

  it("file_check_permission 和 file_list_authorized_folders 委托正确", async () => {
    const calls = [];
    const service = {
      checkPermission: async (...args) => {
        calls.push(["checkPermission", ...args]);
        return { ok: true, canRead: true, canWrite: false };
      },
      getAuthorizedFolders: (...args) => {
        calls.push(["getAuthorizedFolders", ...args]);
        return [{ path: "/authorized" }];
      }
    };
    const tools = new FileTools({ workspaceFileAccessService: service });

    const check = await tools._executeFileCheckPermission(ctx(), { path: "/authorized/x.txt" });
    assert.strictEqual(check.ok, true);
    assert.strictEqual(calls[0][2], "/authorized/x.txt");

    const folders = await tools._executeFileListAuthorizedFolders(ctx(), {});
    assert.strictEqual(folders.ok, true);
    assert.deepStrictEqual(folders.folders, [{ path: "/authorized" }]);
  });
});

describe("ToolExecutor file_* 工具分发", () => {
  function makeToolExecutor() {
    const log = makeTestLogger("ToolExecutor");
    const runtime = {
      log,
      moduleLoader: {
        hasToolName: () => false,
        getToolDefinitions: () => [],
        executeToolCall: async () => ({})
      },
      toolGroupManager: {
        listGroups: () => [],
        getToolDefinitions: () => [],
        getAllGroupIds: () => []
      },
      _agentMetaById: new Map(),
      org: {
        getRole: () => null,
        updateRole: async () => ({})
      },
      workspaceFileAccessService: {}
    };

    const executor = new ToolExecutor(runtime);
    const dispatched = [];
    const fileTools = {};

    const newToolNames = [
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
    const existingToolNames = [
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

    const allToolNames = [...newToolNames, ...existingToolNames];
    const methodNames = {
      file_read_lines: "_executeFileReadLines",
      file_search: "_executeFileSearch",
      file_line_count: "_executeFileLineCount",
      file_read: "_executeFileRead",
      file_info: "_executeFileInfo",
      file_stats: "_executeFileStats",
      file_json_tree: "_executeFileJsonTree",
      file_json_keys: "_executeFileJsonKeys",
      file_jsonl_filter: "_executeFileJsonlFilter",
      file_create_directory: "_executeFileCreateDirectory",
      copy_file: "_executeFileCopy",
      file_check_permission: "_executeFileCheckPermission",
      file_list_authorized_folders: "_executeFileListAuthorizedFolders",
      edit_file: "_executeEditFile",
      replace_file: "_executeWriteFile",
      append_file: "_executeAppendFile",
      list_files: "_executeListFiles",
      delete_file: "_executeDeleteFile",
      move_file: "_executeMoveFile",
      search_text: "_executeSearchText"
    };

    for (const toolName of allToolNames) {
      const methodName = methodNames[toolName];
      fileTools[methodName] = async (callCtx, callArgs) => {
        dispatched.push({ toolName, args: callArgs, ctxAgentId: callCtx?.agent?.id });
        return { ok: true, dispatchedTool: toolName };
      };
    }

    executor.fileTools = fileTools;
    return { executor, dispatched, allToolNames };
  }

  it("将新增 file_* 工具和扩展 workspace 工具分发到 fileTools", async () => {
    const { executor, dispatched, allToolNames } = makeToolExecutor();
    const context = ctx();

    for (const toolName of allToolNames) {
      const result = await executor.executeToolCall(context, toolName, { toolName });
      assert.strictEqual(result.dispatchedTool, toolName, `工具 ${toolName} 未正确分发`);
    }

    assert.strictEqual(dispatched.length, allToolNames.length);
    for (const call of dispatched) {
      assert.strictEqual(call.ctxAgentId, "agent1");
      assert.strictEqual(call.args.toolName, call.toolName);
    }
  });
});
