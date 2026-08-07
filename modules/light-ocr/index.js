/**
 * light-ocr 模块入口
 *
 * 职责：
 * - 提供工作区图片OCR文字识别工具
 * - 通过 DI 注入 logRoot 和 findWorkspaceIdForAgent
 * - 使用离线 PP-OCRv6 引擎，无需联网
 */

import { registry } from "../../src/platform/core/module_registry.js";
import { OcrService } from "./ocr_engine.js";
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {OcrService|null} */
let _ocr = null;

/** @type {any} */
let _log = null;

registry.declare({
  name: "light-ocr-module",
  requires: ["logRoot", "findWorkspaceIdForAgent"],
  provides: [],
  async init(deps) {
    _log = deps.logRoot.forModule("light-ocr");
    _ocr = new OcrService({
      log: _log,
      findWorkspaceIdForAgent: deps.findWorkspaceIdForAgent,
    });
    _log.info("[LightOcr] OCR 模块初始化完成");
  },
});

export default {
  name: "light-ocr",
  toolGroupId: "light_ocr",
  toolGroupDescription: "图片文字识别 (OCR) — png/jpg/bmp/webp/tiff",

  async init(_rt) {},

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "light_ocr",
          description: "识别工作区内图片文件中的文字。使用离线 PP-OCRv6 引擎，无需联网。支持 png、jpg、jpeg、bmp、webp、tiff 格式。返回丰富的排版信息：每行文字及四角坐标、包围矩形、中心点；段落分组；列检测；阅读方向；置信度统计；行高统计；页面文字密度；耗时明细。可选用 includeDiagnostics 获取引擎内部诊断信息（被拒行、检测pass、批次形状等）。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，如 \"screenshot.png\"、\"images/receipt.jpg\"" },
              includeDiagnostics: { type: "boolean", description: "是否返回引擎内部诊断信息（被拒行、检测pass详情、识别批次形状、引擎警告）。默认 false。" },
            },
            required: ["path"],
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
    if (!_ocr) {
      return { error: "module_not_ready", message: "OCR 模块尚未初始化" };
    }
    try {
      switch (toolName) {
        case "light_ocr": {
          const err = validateParams(args, ["path"]);
          if (err) return err;
          return await _ocr.recognize(ctx, args);
        }
        default:
          return { error: "unknown_tool", message: `未知工具: ${toolName}` };
      }
    } catch (err) {
      _log.error("[LightOcr] 工具调用异常", {
        toolName, args, message: err.message, stack: err.stack,
      });
      return { error: "internal_error", message: err.message };
    }
  },

  /**
   * 关闭模块
   */
  async shutdown() {
    if (_ocr) {
      await _ocr.close();
    }
    _ocr = null;
    _log = null;
  },
};
