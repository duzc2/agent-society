/**
 * Bigfile 模块入口
 *
 * 职责：
 * - 模块初始化和生命周期管理
 * - 工具定义导出
 * - 工具调用路由分发
 *
 * 设计说明：
 * - 纯工具模块，无 Web UI，无 HTTP handler
 * - 遵循 localfile 模块的生命周期模式
 * - 通过 switch(toolName) 分发工具调用
 */

import { getToolDefinitions } from "./tools.js";
import { BigfileService } from "./bigfile_service.js";
import { validateParams } from "../../src/platform/utils/validate_params.js";

/** @type {any} 运行时实例 */
let runtime = null;

/** @type {any} 日志对象 */
let log = null;

/** @type {BigfileService} */
let bigfileService = null;

/**
 * Bigfile 模块导出
 */
export default {
  name: "bigfile",

  toolGroupId: "bigfile",

  toolGroupDescription:
    "大文件处理工具 - 提供大日志、JSON、JSONL 文件的读取、搜索、统计和导航能力",

  /**
   * 初始化模块
   * @param {any} rt - 运行时实例
   * @returns {Promise<void>}
   */
  async init(rt) {
    runtime = rt;
    log = runtime.loggerRoot.forModule("bigfile");

    log.info("[Bigfile] 模块初始化开始");

    bigfileService = new BigfileService({ runtime, log });

    log.info("[Bigfile] 模块初始化完成");
  },

  /**
   * 获取工具定义列表
   * @returns {Array<{type: string, function: object}>}
   */
  getToolDefinitions() {
    return getToolDefinitions();
  },

  /**
   * 执行工具调用
   * @param {any} ctx - 调用上下文
   * @param {string} toolName - 工具名称
   * @param {any} args - 工具参数
   * @returns {Promise<any>}
   */
  async executeToolCall(ctx, toolName, args) {
    try {
      log.debug("[Bigfile] 执行工具调用", { toolName, args });

      switch (toolName) {
        case "bigfile_read": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await bigfileService.read(ctx, args);
        }

        case "bigfile_get_info": {
          const validationError = validateParams(args, ["path"]);
          if (validationError) return validationError;
          return await bigfileService.getInfo(ctx, args);
        }

        case "bigfile_read_lines": {
          const validationError = validateParams(args, ["path", "start_line", "end_line"]);
          if (validationError) return validationError;
          return await bigfileService.readLines(ctx, args);
        }

        case "bigfile_search": {
          const validationError = validateParams(args, ["path", "pattern"]);
          if (validationError) return validationError;
          return await bigfileService.search(ctx, args);
        }

        case "bigfile_stats": {
          const validationError = validateParams(args, ["path", "rules"]);
          if (validationError) return validationError;
          return await bigfileService.stats(ctx, args);
        }

        case "bigfile_json_tree": {
          const validationError = validateParams(args, ["path", "path_expr"]);
          if (validationError) return validationError;
          return await bigfileService.jsonTree(ctx, args);
        }

        case "bigfile_json_keys": {
          const validationError = validateParams(args, ["path", "path_expr"]);
          if (validationError) return validationError;
          return await bigfileService.jsonKeys(ctx, args);
        }

        case "bigfile_jsonl_filter": {
          const validationError = validateParams(args, ["path", "field", "pattern"]);
          if (validationError) return validationError;
          return await bigfileService.jsonlFilter(ctx, args);
        }

        default:
          return {
            error: "unknown_tool",
            message: `未知的工具: ${toolName}`
          };
      }
    } catch (error) {
      log.error("[Bigfile] 工具调用失败", {
        toolName,
        args,
        error: error.message,
        stack: error.stack
      });
      return {
        error: "execution_error",
        message: `工具执行失败: ${error.message}`
      };
    }
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info("[Bigfile] 模块开始关闭");

    bigfileService = null;
    runtime = null;

    log.info("[Bigfile] 模块已关闭");
  }
};
