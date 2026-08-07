/**
 * 文件操作工具 — 从 tool_executor.js 提取
 *
 * 包含：file_read_lines、file_search、file_line_count、edit_file、
 *        replace_file、append_file、list_files、delete_file、move_file、
 *        get_workspace_info、search_text
 *
 * @module runtime/tools_file
 */

import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";

export class FileTools {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  async _executeFileReadLines(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要读取的文件路径。" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    return await ws.readLines(args.path, { start_line: args.start_line, end_line: args.end_line });
  }

  async _executeFileSearch(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要搜索的文件路径。" };
    }
    if (!args.pattern || typeof args.pattern !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 pattern。请提供搜索模式。" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    return await ws.searchInFile(args.path, args.pattern, {
      is_regex: Boolean(args.is_regex),
      max_results: args.max_results ?? 100
    });
  }

  async _executeFileLineCount(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    return await ws.getLineCount(args.path);
  }

  async _executeEditFile(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    if (args.old_string === undefined || args.old_string === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 old_string。请提供要替换的原始文本。" };
    }
    if (args.new_string === undefined || args.new_string === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 new_string。请提供替换后的新文本。" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    if (ws.isPathInIO(args.path)) {
      return { error: "io_access_denied", message: "不允许直接编辑 .io/ 目录中的文件（该目录由系统模块自动管理）" };
    }
    const messageId = ctx.currentMessage?.id ?? `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const operator = ctx.agent?.id;
    const result = await ws.editFile(args.path, {
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: Boolean(args.replace_all),
      operator,
      messageId
    });

    return {
      ok: true,
      path: args.path,
      occurrences: result.occurrences,
      versionId: result.versionId
    };
  }

  async _executeWriteFile(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要写入的文件路径。" };
    }
    if (args.content === undefined || args.content === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 content。请提供要写入的文件内容。" };
    }

    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    if (ws.isPathInIO(args.path)) {
      return { error: "io_access_denied", message: "不允许直接写入 .io/ 目录中的文件（该目录由系统模块自动管理）" };
    }
    const messageId = ctx.currentMessage?.id ?? `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const result = await ws.writeFile(args.path, args.content, {
      mimeType: args.mimeType,
      operator: ctx.agent?.id,
      messageId
    });

    return {
      ok: true,
      files: [{
        path: args.path,
        size: result.size,
        mimeType: result.mimeType
      }],
      versionId: result.versionId
    };
  }

  async _executeAppendFile(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要追加内容的文件路径。" };
    }
    if (args.content === undefined || args.content === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 content。请提供要追加的文件内容。" };
    }

    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    if (ws.isPathInIO(args.path)) {
      return { error: "io_access_denied", message: "不允许直接修改 .io/ 目录中的文件（该目录由系统模块自动管理）" };
    }
    const messageId = ctx.currentMessage?.id ?? `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const result = await ws.appendFile(args.path, args.content, {
      mimeType: args.mimeType,
      operator: ctx.agent?.id,
      messageId
    });

    return {
      ok: true,
      files: [{
        path: args.path,
        size: result.size,
        mimeType: result.mimeType
      }],
      versionId: result.versionId
    };
  }

  async _executeListFiles(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    return await ws.listFiles(args.path ?? ".");
  }

  async _executeDeleteFile(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }

    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    if (ws.isPathInIO(args.path)) {
      return { error: "io_access_denied", message: "不允许直接删除 .io/ 目录中的文件（该目录由系统模块自动管理）" };
    }
    const result = await ws.deleteFile(args.path, {
      operator: ctx.agent?.id,
      messageId: ctx.currentMessage?.id
    });

    return result;
  }

  /**
   * 移动/重命名文件的工具执行函数
   */
  async _executeMoveFile(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    // 兼容多种参数命名：fromPath/toPath 或 path/new_path
    const fromPath = (args?.fromPath ?? args?.path ?? args?.from ?? args?.source ?? args?.src)?.toString()?.trim();
    const toPath = (args?.toPath ?? args?.new_path ?? args?.newPath ?? args?.to ?? args?.dest ?? args?.destination ?? args?.target)?.toString()?.trim();
    if (!fromPath || !toPath) {
      return { error: "invalid_arguments", message: "缺少源或目标路径。请提供 fromPath/toPath 或 path/new_path。" };
    }
    if (ws.isPathInIO(fromPath)) {
      return { error: "io_access_denied", message: "不允许直接移动 .io/ 目录中的文件（该目录由系统模块自动管理）" };
    }
    if (ws.isPathInIO(toPath)) {
      return { error: "io_access_denied", message: "不允许将文件移动到 .io/ 目录（该目录由系统模块自动管理）" };
    }
    const result = await ws.moveFile(fromPath, toPath, {
      operator: ctx.agent?.id,
      messageId: ctx.currentMessage?.id,
      overwrite: Boolean(args.overwrite)
    });
    return result;
  }

  async _executeGetWorkspaceInfo(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }
    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    return await ws.getDiskUsage();
  }

  async _executeSearchText(ctx, args) {
    const runtime = this.runtime;
    const workspaceId = runtime.findWorkspaceIdForAgent(ctx.agent?.id);
    if (!workspaceId) {
      return { error: "workspace_not_assigned", message: "当前智能体未分配工作空间" };
    }

    if (!args.text || typeof args.text !== "string") {
      return { error: "missing_text", message: "必须提供要搜索的文本" };
    }

    const ws = await getWorkspaceManager().getWorkspace(workspaceId);
    const results = await ws.searchText(
      args.path ?? ".",
      args.text,
      {
        caseSensitive: Boolean(args.caseSensitive),
        maxResults: args.maxResults ?? 1000
      }
    );

    return {
      results,
      count: results.length,
      path: args.path ?? ".",
      text: args.text
    };
  }
}
