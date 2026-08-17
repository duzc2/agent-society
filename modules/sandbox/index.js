/**
 * 沙箱模块
 * 在隔离的 Node.js 环境中执行 JavaScript 代码。
 * 通过 node --permission 在 OS 层保证安全隔离。
 */

import { SandboxManager } from "./sandbox_manager.js";
import { getToolDefinitions } from "./tools.js";
import { getWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

/** @type {SandboxManager|null} */
let sandboxManager = null;

/** @type {any} */
let runtime = null;

/** @type {any} */
let log = null;

export default {
  name: "sandbox",
  toolGroupId: "sandbox",
  toolGroupDescription:
    "安全沙箱 - 在隔离的 Node.js 环境中运行 JavaScript 代码，无法访问网络和工作区外的文件；" +
    "工作区或其他已授权的路径下文件自动化处理优先使用本工具组（无需用户单独授权），优于 localcmd",

  /**
   * 初始化模块
   * @param {any} rt - 运行时实例
   * @returns {Promise<void>}
   */
  async init(rt) {
    runtime = rt;
    log = runtime.loggerRoot.forModule("sandbox");

    const dataDir = runtime.dataDir;

    sandboxManager = new SandboxManager({
      log,
      dataDir,
    });

    if (runtime.registerSystemPromptProvider) {
      runtime.registerSystemPromptProvider("sandbox", () => {
        return _getSystemPrompt();
      });
      log.info("[Sandbox] 已注册系统提示词注入");
    }

    log.info("[Sandbox] 模块初始化完成");
  },

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
      switch (toolName) {
        case "sandbox_spawn": {
          if (!args.code || typeof args.code !== "string" || args.code.trim().length === 0) {
            return { error: "code_must_be_non_empty_string" };
          }
          if (args.code.length > 10 * 1024 * 1024) {
            return { error: "code_too_long", maxLength: 10 * 1024 * 1024 };
          }

          const agentId = ctx.agent.id;
          const orgId = ctx.runtime.findWorkspaceIdForAgent(agentId);

          // 获取工作区路径
          let workspacePath = process.cwd();
          if (orgId) {
            try {
              const wm = getWorkspaceManager();
              if (wm) {
                workspacePath = wm.getWorkspacePath(orgId);
              }
            } catch (err) {
              log.warn("[Sandbox] 无法获取工作区路径，使用 cwd", { error: err?.message });
            }
          }

          return sandboxManager.spawn(args.code, workspacePath, agentId);
        }

        case "sandbox_read_output":
          return await sandboxManager.readOutput(
            args.processId,
            args.offset ?? 0,
            args.window ?? 5000
          );

        case "sandbox_get_status":
          return sandboxManager.getStatus(args.processId);

        case "sandbox_kill":
          return sandboxManager.kill(args.processId);

        default:
          return { error: "unknown_tool", toolName };
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      log.error("[Sandbox] 工具调用失败", { toolName, error: message, stack: err?.stack });
      return { error: "tool_error", toolName, message };
    }
  },

  /**
   * 关闭模块并释放资源
   * @returns {Promise<void>}
   */
  async shutdown() {
    log.info("[Sandbox] 模块开始关闭");

    if (sandboxManager) {
      await sandboxManager.killAll();
    }

    sandboxManager = null;
    runtime = null;

    log.info("[Sandbox] 模块已关闭");
  },
};

/**
 * 构建系统提示词
 * @returns {string}
 * @private
 */
function _getSystemPrompt() {
  return `【JS 代码沙箱环境】
你可以在隔离的 Node.js 沙箱中执行 JavaScript 代码，用于文件处理、数据处理等任务。

使用优先级（重要）：
- 在工作区内自动化处理文件（读取、转换、生成、批量修改文件等）时，应优先使用 sandbox_* 工具，而不是 localcmd。
- 原因：localcmd 需要权限审核，可能被拒绝或需要用户确认而中断自动化流程；sandbox 无需权限，直接读写工作区文件，适合无人值守的自动化处理。
- 仅在 sandbox 无法完成（需要网络、需要调用外部程序或命令行、需要运行非 JavaScript 程序）时，才回退到 localcmd。

运行环境：
- Node.js（ESM）工作目录为工作区根目录，可 import 工作区内的 .mjs 文件
- 可以读写工作区内的文件

安全限制：
- 完全无法访问网络
- 无法访问工作区以外的任何文件或目录
- 无法创建子进程或 Worker 线程

使用方法：
1. sandbox_spawn(code) 启动执行
2. sandbox_read_output(processId) 读取输出
3. sandbox_get_status(processId) 查看状态
4. sandbox_kill(processId) 终止执行

代码必须完整可独立运行，含所有 import/require。不传代码片段或孤立函数。`;
}
