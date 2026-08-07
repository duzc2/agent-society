/**
 * Document 模块入口
 *
 * 职责：
 * - 提供 Office/PDF 文档文本读取工具
 * - 支持 .docx .xlsx .pptx .pdf 格式
 * - 文档信息查询和关键字搜索
 */

import { registry } from "../../src/platform/core/module_registry.js";
import { DocumentReader } from "./document_reader.js";
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {DocumentReader|null} */
let _reader = null;

/** @type {any} */
let _log = null;

registry.declare({
  name: "document-module",
  requires: ["logRoot", "findWorkspaceIdForAgent"],
  provides: [],
  async init(deps) {
    _log = deps.logRoot.forModule("document");
    _reader = new DocumentReader({
      log: _log,
      findWorkspaceIdForAgent: deps.findWorkspaceIdForAgent,
    });
    _log.info("[Document] 文档模块初始化完成");
  },
});

export default {
  name: "document",
  toolGroupId: "document_processing",
  toolGroupDescription: "Office 文档读取 — .docx/.xlsx/.pptx/.pdf",

  async init(_rt) {},

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "document_read",
          description: "读取工作区内 Office 或 PDF 文件的文本内容。支持 .docx .xlsx .pptx .pdf。自动根据扩展名识别类型。超过 200000 字符自动截断。",
          parameters: {
            type: "object",
            properties: {
              path:   { type: "string", description: "工作区相对路径，如 \"report.pdf\"、\"data/销售.xlsx\"" },
              format: { type: "string", enum: ["text", "markdown"], description: "text 纯文本，markdown 保留标题和表格结构。默认 text" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "document_info",
          description: "获取文档元数据：类型、页数/工作表数/幻灯片数。不提取全文。",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "工作区相对路径" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "document_search",
          description: "在文档中搜索关键字，返回匹配位置及上下文。",
          parameters: {
            type: "object",
            properties: {
              path:          { type: "string", description: "工作区相对路径" },
              keyword:       { type: "string", description: "搜索关键字" },
              caseSensitive: { type: "boolean", description: "默认 false (不区分大小写)" },
              contextLines:  { type: "number", description: "匹配前后上下文行数。默认 2，最大 10" },
            },
            required: ["path", "keyword"],
          },
        },
      },
    ];
  },

  /**
   * 执行工具调用
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<object>}
   */
  async executeToolCall(ctx, toolName, args) {
    if (!_reader) {
      return { error: "module_not_ready", message: "文档模块尚未初始化" };
    }
    try {
      switch (toolName) {
        case "document_read": {
          const err = validateParams(args, ["path"]);
          if (err) return err;
          return await _reader.read(ctx, args);
        }
        case "document_info": {
          const err = validateParams(args, ["path"]);
          if (err) return err;
          return await _reader.info(ctx, args);
        }
        case "document_search": {
          const err = validateParams(args, ["path", "keyword"]);
          if (err) return err;
          return await _reader.search(ctx, args);
        }
        default:
          return { error: "unknown_tool", message: `未知工具: ${toolName}` };
      }
    } catch (err) {
      _log.error("[Document] 工具调用异常", {
        toolName, args, message: err.message, stack: err.stack,
      });
      return { error: "internal_error", message: err.message };
    }
  },

  /**
   * 关闭模块
   */
  async shutdown() {
    _reader = null;
    _log = null;
  },
};
