/**
 * 文件操作工具 — 从 tool_executor.js 提取
 *
 * 包含：file_read_lines、file_search、file_line_count、edit_file、
 *        replace_file、append_file、list_files、delete_file、move_file、
 *        get_workspace_info、search_text
 *
 * 这些工具不再自行查找工作区；统一委托给 WorkspaceFileAccessService，
 * 由该服务根据路径解析结果分发到 workspace 或 external 实现。
 *
 * @module runtime/tools_file
 */

export class FileTools {
  /**
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
  }

  _service() {
    const service = this.runtime.workspaceFileAccessService;
    if (!service) {
      throw new Error("workspaceFileAccessService_not_initialized");
    }
    return service;
  }

  _messageId(ctx) {
    return ctx.currentMessage?.id ?? `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async _executeFileReadLines(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要读取的文件路径。" };
    }
    return this._service().readLines(ctx, args.path, {
      start_line: args.start_line,
      end_line: args.end_line
    });
  }

  async _executeFileSearch(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要搜索的文件路径。" };
    }
    if (!args.pattern || typeof args.pattern !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 pattern。请提供搜索模式。" };
    }
    return this._service().searchInFile(ctx, args.path, args.pattern, {
      is_regex: Boolean(args.is_regex),
      max_results: args.max_results ?? 100,
      context_lines: args.context_lines ?? 0
    });
  }

  async _executeFileLineCount(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    return this._service().getLineCount(ctx, args.path);
  }

  async _executeFileRead(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要读取的文件路径。" };
    }
    return this._service().read(ctx, args.path, {
      offset: args.offset,
      length: args.length
    });
  }

  async _executeFileInfo(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    return this._service().getInfo(ctx, args.path);
  }

  async _executeFileStats(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    if (!Array.isArray(args.rules) || args.rules.length === 0) {
      return { error: "invalid_arguments", message: "缺少必需参数 rules。请提供至少一个统计规则。" };
    }
    return this._service().stats(ctx, args.path, args.rules, {
      line_range: args.line_range
    });
  }

  async _executeFileJsonTree(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供 JSON 文件路径。" };
    }
    return this._service().jsonTree(ctx, args.path, {
      path_expr: args.path_expr,
      max_depth: args.max_depth
    });
  }

  async _executeFileJsonKeys(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供 JSON 文件路径。" };
    }
    return this._service().jsonKeys(ctx, args.path, {
      path_expr: args.path_expr
    });
  }

  async _executeFileJsonlFilter(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供 JSONL 文件路径。" };
    }
    if (!args.field || typeof args.field !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 field。请提供要过滤的字段名。" };
    }
    if (!args.pattern || typeof args.pattern !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 pattern。请提供过滤模式。" };
    }
    return this._service().jsonlFilter(ctx, args.path, args.field, args.pattern, {
      is_regex: Boolean(args.is_regex),
      max_results: args.max_results,
      max_chars_per_record: args.max_chars_per_record
    });
  }

  async _executeFileCreateDirectory(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要创建的目录路径。" };
    }

    return this._service().createDirectory(ctx, args.path, {
      recursive: args.recursive !== false,
      operator: ctx.agent?.id,
      messageId: this._messageId(ctx)
    });
  }

  async _executeFileCopyToWorkspace(ctx, args) {
    if (!args.sourcePath || typeof args.sourcePath !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 sourcePath。请提供外部源文件路径。" };
    }
    if (!args.destPath || typeof args.destPath !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 destPath。请提供工作区目标路径。" };
    }

    return this._service().copyToWorkspace(ctx, args.sourcePath, args.destPath);
  }

  async _executeFileCopyFromWorkspace(ctx, args) {
    if (!args.sourcePath || typeof args.sourcePath !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 sourcePath。请提供工作区源文件路径。" };
    }
    if (!args.destPath || typeof args.destPath !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 destPath。请提供外部目标路径。" };
    }

    return this._service().copyFromWorkspace(ctx, args.sourcePath, args.destPath);
  }

  async _executeFileCheckPermission(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要检查的文件路径。" };
    }

    return this._service().checkPermission(ctx, args.path);
  }

  async _executeFileListAuthorizedFolders(ctx, _args) {
    const folders = this._service().getAuthorizedFolders(ctx);
    return { ok: true, folders };
  }

  async _executeEditFile(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供文件路径。" };
    }
    if (args.old_string === undefined || args.old_string === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 old_string。请提供要替换的原始文本。" };
    }
    if (args.new_string === undefined || args.new_string === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 new_string。请提供替换后的新文本。" };
    }

    const result = await this._service().editFile(ctx, args.path, {
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: Boolean(args.replace_all),
      operator: ctx.agent?.id,
      messageId: this._messageId(ctx)
    });

    if (result.ok) {
      return {
        ok: true,
        path: args.path,
        occurrences: result.occurrences,
        versionId: result.versionId
      };
    }
    return result;
  }

  async _executeWriteFile(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要写入的文件路径。" };
    }
    if (args.content === undefined || args.content === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 content。请提供要写入的文件内容。" };
    }

    const result = await this._service().writeFile(ctx, args.path, args.content, {
      mimeType: args.mimeType,
      operator: ctx.agent?.id,
      messageId: this._messageId(ctx)
    });

    if (result.ok) {
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
    return result;
  }

  async _executeAppendFile(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要追加内容的文件路径。" };
    }
    if (args.content === undefined || args.content === null) {
      return { error: "invalid_arguments", message: "缺少必需参数 content。请提供要追加的文件内容。" };
    }

    const result = await this._service().appendFile(ctx, args.path, args.content, {
      mimeType: args.mimeType,
      operator: ctx.agent?.id,
      messageId: this._messageId(ctx)
    });

    if (result.ok) {
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
    return result;
  }

  async _executeListFiles(ctx, args) {
    return this._service().listFiles(ctx, args.path ?? ".");
  }

  async _executeDeleteFile(ctx, args) {
    if (!args.path || typeof args.path !== "string") {
      return { error: "invalid_arguments", message: "缺少必需参数 path。请提供要删除的文件路径。" };
    }

    return this._service().deleteFile(ctx, args.path, {
      operator: ctx.agent?.id,
      messageId: ctx.currentMessage?.id
    });
  }

  /**
   * 移动/重命名文件的工具执行函数
   */
  async _executeMoveFile(ctx, args) {
    // 兼容多种参数命名：fromPath/toPath 或 path/new_path
    const fromPath = (args?.fromPath ?? args?.path ?? args?.from ?? args?.source ?? args?.src)?.toString()?.trim();
    const toPath = (args?.toPath ?? args?.new_path ?? args?.newPath ?? args?.to ?? args?.dest ?? args?.destination ?? args?.target)?.toString()?.trim();
    if (!fromPath || !toPath) {
      return { error: "invalid_arguments", message: "缺少源或目标路径。请提供 fromPath/toPath 或 path/new_path。" };
    }

    return this._service().moveFile(ctx, fromPath, toPath, {
      operator: ctx.agent?.id,
      messageId: ctx.currentMessage?.id,
      overwrite: Boolean(args.overwrite)
    });
  }

  async _executeGetWorkspaceInfo(ctx, _args) {
    return this._service().getWorkspaceInfo(ctx);
  }

  async _executeSearchText(ctx, args) {
    if (!args.text || typeof args.text !== "string") {
      return { error: "missing_text", message: "必须提供要搜索的文本" };
    }

    return this._service().searchText(ctx, args.path ?? ".", args.text, {
      caseSensitive: Boolean(args.caseSensitive),
      maxResults: args.maxResults ?? 1000
    });
  }
}
