/**
 * 文档读取器
 * 协调文档类型检测、解析和结果输出。
 *
 * 路径解析统一走 workspace_file_access 的 PathResolver：
 * - 工作区路径行为保持不变。
 * - 外部授权路径只读访问，且必须通过 read 权限检查。
 */

import { stat } from "node:fs/promises";
import { detectType, getSupportedExtensions } from "./parser/type_detector.js";
import { parsePdf, getPdfMetadata } from "./parser/pdf_parser.js";
import { parseOffice, getOfficeMetadata } from "./parser/office_parser.js";

/** 文件大小上限：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** 内容截断字符数 */
const MAX_CONTENT_CHARS = 200000;

/**
 * 文档读取器
 * 负责将原始路径解析为安全绝对路径、检测类型、调用对应解析器。
 */
export class DocumentReader {
  /**
   * @param {object} options
   * @param {any} options.log - 日志对象
   * @param {import("../../src/platform/services/workspace/file_access/path_resolver.js").PathResolver} options.pathResolver
   * @param {import("../../src/platform/services/workspace/file_access/external_permission_manager.js").ExternalPermissionManager} options.permissionManager
   */
  constructor({ log, pathResolver, permissionManager }) {
    this._log = log;
    this._pathResolver = pathResolver;
    this._permissionManager = permissionManager;
  }

  /**
   * 读取文档文本内容。
   * @param {any} ctx - 调用上下文（含 ctx.agent.id）
   * @param {object} args - 参数 { path, format, pages, sheet, slides }
   * @returns {Promise<object>}
   */
  async read(ctx, args) {
    const resolved = await this._resolveDocumentPath(ctx, args.path);
    if (resolved.error) return resolved;

    const absPath = resolved.absolutePath;
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
    const resolved = await this._resolveDocumentPath(ctx, args.path);
    if (resolved.error) return resolved;

    const absPath = resolved.absolutePath;
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
   * 将原始路径解析为可安全读取的绝对路径。
   * 工作区路径由 PathResolver 复用 workspace.resolveAbsolutePath；
   * 外部路径额外执行 read 权限检查。
   *
   * @param {any} ctx
   * @param {string} rawPath
   * @returns {Promise<{ absolutePath: string } | { error: string, message: string }>}
   */
  async _resolveDocumentPath(ctx, rawPath) {
    try {
      const resolved = await this._pathResolver.resolvePath(ctx, rawPath, {
        operation: "read",
      });

      if (resolved.scope === "workspace") {
        return { absolutePath: resolved.absolutePath };
      }

      const permission = await this._permissionManager.checkReadPermission(
        resolved.absolutePath,
        resolved.orgId
      );
      if (!permission.allowed) {
        return {
          error: "access_denied",
          message: `没有权限读取外部文档: ${rawPath}`,
        };
      }

      return { absolutePath: resolved.absolutePath };
    } catch (err) {
      this._log.error("[DocumentReader] 解析文档路径失败", {
        path: rawPath,
        message: err.message,
        stack: err.stack,
      });

      if (err.message === "forbidden_path_segment") {
        return {
          error: "forbidden_path_segment",
          message: "路径包含受保护的 .io / .versions 目录段",
        };
      }

      return {
        error: "path_resolve_failed",
        message: `路径解析失败: ${err.message}`,
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
