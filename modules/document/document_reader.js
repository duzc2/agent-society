/**
 * 文档读取器
 * 协调文档类型检测、解析和结果输出。
 */

import { stat } from "node:fs/promises";
import { detectType, getSupportedExtensions } from "./parser/type_detector.js";
import { parsePdf, getPdfMetadata } from "./parser/pdf_parser.js";
import { parseOffice, getOfficeMetadata } from "./parser/office_parser.js";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

/** 文件大小上限：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** 内容截断字符数 */
const MAX_CONTENT_CHARS = 200000;

/**
 * 文档读取器
 * 负责将相对路径解析为绝对路径、检测类型、调用对应解析器。
 */
export class DocumentReader {
  /**
   * @param {object} options
   * @param {any} options.log - 日志对象
   * @param {(agentId: string) => string|null} options.findWorkspaceIdForAgent - 查找工作区ID
   */
  constructor({ log, findWorkspaceIdForAgent }) {
    this._log = log;
    this._findWorkspaceIdForAgent = findWorkspaceIdForAgent;
  }

  /**
   * 读取文档文本内容。
   * @param {any} ctx - 调用上下文（含 ctx.agent.id）
   * @param {object} args - 参数 { path, format, pages, sheet, slides }
   * @returns {Promise<object>}
   */
  async read(ctx, args) {
    const workspace = await this._resolveWorkspace(ctx);
    if (workspace.error) return workspace;

    const absPath = this._resolvePath(workspace, args.path);
    if (absPath.error) return absPath;

    const typeInfo = detectType(args.path);
    if (!typeInfo) {
      return {
        error: "unsupported_format",
        message: `不支持的文件格式，仅支持: ${getSupportedExtensions().join(", ")}`,
      };
    }

    const sizeCheck = await this._checkFileSize(absPath);
    if (sizeCheck.error) return sizeCheck;

    let result;
    if (typeInfo.parser === "pdf") {
      result = await parsePdf({ filePath: absPath, log: this._log });
    } else {
      result = await parseOffice({
        filePath: absPath,
        type: typeInfo.type,
        format: args.format || "text",
        log: this._log,
      });
    }

    if (result.error) return result;

    // 截断过长内容
    if (result.content.length > MAX_CONTENT_CHARS) {
      result.content = result.content.slice(0, MAX_CONTENT_CHARS);
      result.metadata.truncated = true;
      result.metadata.totalChars = result.content.length;
      result.metadata.note = `内容已截断至 ${MAX_CONTENT_CHARS} 字符`;
    }

    return result;
  }

  /**
   * 获取文档元数据。
   * @param {any} ctx
   * @param {object} args - { path }
   * @returns {Promise<object>}
   */
  async info(ctx, args) {
    const workspace = await this._resolveWorkspace(ctx);
    if (workspace.error) return workspace;

    const absPath = this._resolvePath(workspace, args.path);
    if (absPath.error) return absPath;

    const typeInfo = detectType(args.path);
    if (!typeInfo) {
      return {
        error: "unsupported_format",
        message: `不支持的文件格式，仅支持: ${getSupportedExtensions().join(", ")}`,
      };
    }

    try {
      const fileStat = await stat(absPath);
      const metadata = {
        type: typeInfo.type,
        size: fileStat.size,
        sizeFormatted: this._formatBytes(fileStat.size),
      };

      if (typeInfo.parser === "pdf") {
        const pdfMeta = await getPdfMetadata({ filePath: absPath, log: this._log });
        if (pdfMeta.ok) Object.assign(metadata, pdfMeta.metadata);
      } else {
        const officeMeta = await getOfficeMetadata({ filePath: absPath, type: typeInfo.type, log: this._log });
        if (officeMeta.ok) Object.assign(metadata, officeMeta.metadata);
      }

      return { ok: true, metadata };
    } catch (err) {
      this._log.error("[DocumentReader] 获取文件信息失败", {
        path: absPath,
        message: err.message,
        stack: err.stack,
      });
      return {
        error: "file_not_found",
        message: `文件不存在或无法读取: ${args.path}`,
      };
    }
  }

  /**
   * 在文档中搜索关键字。
   * @param {any} ctx
   * @param {object} args - { path, keyword, caseSensitive, contextLines }
   * @returns {Promise<object>}
   */
  async search(ctx, args) {
    // 先读取全文
    const readResult = await this.read(ctx, {
      path: args.path,
      format: args.format || "text",
    });

    if (readResult.error) return readResult;

    const content = readResult.content;
    const caseSensitive = args.caseSensitive === true;
    const contextLines = Math.min(Math.max(args.contextLines ?? 2, 0), 10);

    const lines = content.split("\n");
    const matches = [];
    const searchPattern = caseSensitive ? args.keyword : args.keyword.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const compareLine = caseSensitive ? line : line.toLowerCase();
      if (compareLine.includes(searchPattern)) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        matches.push({
          line: i + 1,
          context: lines.slice(start, end).map((l, idx) => ({
            line: start + idx + 1,
            text: l,
            isMatch: start + idx === i,
          })),
        });
      }
    }

    return {
      ok: true,
      matches,
      totalMatches: matches.length,
      metadata: readResult.metadata,
    };
  }

  // ---- 内部方法 ----

  /**
   * 根据 ctx 解析 workspace 对象。
   * @param {any} ctx
   * @returns {import("../../src/platform/services/workspace/workspace.js").Workspace | { error: string, message: string }}
   */
  async _resolveWorkspace(ctx) {
    const agentId = ctx?.agent?.id;
    if (!agentId) {
      return { error: "no_workspace", message: "无法获取智能体 ID" };
    }
    const wsId = this._findWorkspaceIdForAgent(agentId);
    if (!wsId) {
      return { error: "no_workspace", message: "该智能体没有关联的工作区" };
    }
    const wm = getWorkspaceManager();
    if (!wm) {
      return { error: "no_workspace", message: "工作区管理器未初始化" };
    }
    return await wm.getWorkspace(wsId);
  }

  /**
   * 解析安全绝对路径。
   * @param {object} workspace - Workspace 实例
   * @param {string} relativePath - 工作区相对路径
   * @returns {string | { error: string, message: string }}
   */
  _resolvePath(workspace, relativePath) {
    try {
      return workspace.resolveAbsolutePath(relativePath);
    } catch (err) {
      return {
        error: "file_not_found",
        message: `路径无效或越权: ${relativePath}`,
      };
    }
  }

  /**
   * 检查文件大小是否在上限内。
   * @param {string} absPath
   * @returns {Promise<{ error?: string, message?: string }>}
   */
  async _checkFileSize(absPath) {
    try {
      const fileStat = await stat(absPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        return {
          error: "file_too_large",
          message: `文件过大 (${this._formatBytes(fileStat.size)})，上限为 ${this._formatBytes(MAX_FILE_SIZE)}`,
        };
      }
      return {};
    } catch (err) {
      return {
        error: "file_not_found",
        message: `文件不存在: ${absPath}`,
      };
    }
  }

  /**
   * 格式化字节数为可读字符串。
   * @param {number} bytes
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
}
