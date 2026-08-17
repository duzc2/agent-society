/**
 * 沙箱模块工具定义
 * 提供 4 个工具：sandbox_spawn / sandbox_read_output / sandbox_get_status / sandbox_kill
 */

export function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "sandbox_spawn",
        description:
          "在隔离的 Node.js 沙箱中执行 JavaScript 代码。" +
          "运行环境：Node.js（ESM），工作目录为工作区根目录，可用于文件处理、数据处理等任务。" +
          "限制：无法访问网络、无法访问工作区外的文件、无法创建子进程或 Worker。" +
          "代码必须是完整的、可独立运行的程序，包含所有 import/require 语句。" +
          "进程将持续运行直到完成或调用 sandbox_kill 终止。" +
          "需要自动化处理工作区或其他已授权的路径下文件时，优先用本工具而非 localcmd（无需用户单独授权、不中断流程）。",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "完整的 JavaScript 源代码，含所有 import/require。ESM 模块格式。",
            },
          },
          required: ["code"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sandbox_read_output",
        description:
          "读取沙箱进程的输出内容。通过 offset 参数支持增量读取。" +
          "首次读取使用 offset=0，后续使用返回的 nextOffset 继续读取新内容。",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "沙箱进程 ID（由 sandbox_spawn 返回）",
            },
            offset: {
              type: "number",
              description: "读取起始位置（字符偏移量），默认 0",
              default: 0,
            },
            window: {
              type: "number",
              description: "单次读取的最大字符数，默认 5000",
              default: 5000,
            },
          },
          required: ["processId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sandbox_get_status",
        description:
          "查询沙箱进程的当前状态。返回 running/completed/error/killed 等状态以及退出码。",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "沙箱进程 ID",
            },
          },
          required: ["processId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sandbox_kill",
        description:
          "强制终止指定的沙箱进程。进程会被 SIGTERM 信号终止，" +
          "5 秒后仍未退出则发送 SIGKILL。",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "要终止的沙箱进程 ID",
            },
          },
          required: ["processId"],
        },
      },
    },
  ];
}
