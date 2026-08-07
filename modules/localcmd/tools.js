/**
 * LocalCmd 模块工具定义
 * 
 * 【工具组说明】localcmd 工具组用于在本地执行命令行命令，支持长期运行的交互式进程。
 * 
 * 【适用场景】
 * - 执行系统命令（如 ls, cat, grep, ping 等）
 * - 运行交互式程序（如 Python REPL、Node.js 交互模式、ssh 等）
 * - 启动长期运行的服务或守护进程
 * - 与命令进行实时交互（发送输入、读取输出）
 * 
 * 【系统环境】
 * 模块会自动检测并向智能体注入当前系统环境信息（操作系统类型、Shell 类型等）。
 * 
 * 【特性】
 * - 无超时限制：进程可以长期运行
 * - 文件存储：所有输出写入独立文件，通过 seek 读取任意位置
 * - 自动清理：主进程退出时所有子进程和输出文件自动清理
 */

export function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "localcmd_spawn",
        description: [
          "启动一个新的本地进程（fire-and-forget）。调用后立即返回，不等待进程任何事件。",
          "进程可以长期运行，不会自动超时。所有输出会写入独立的日志文件。",
          "必须使用 localcmd_get_status 查看进程是否开始运行以及当前状态。",
          "必须使用 localcmd_read_output 读取进程输出。",
          "command 和 args 必须分开传递，例如 command='node', args=['-e', 'console.log(1)']。"
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "要执行的命令，如 'python'、'node'、'ping'、'ssh' 等"
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "命令参数数组，如 ['-i', 'interactive']",
              default: []
            },
            cwd: {
              type: "string",
              description: "工作目录，不指定则使用智能体隔离工作区目录"
            },
            env: {
              type: "object",
              description: "额外的环境变量，会合并到系统环境变量中"
            },
            intent: {
              type: "string",
              description: [
                "执行此命令的意图说明。必须详细解释：要解决什么问题、为什么选择执行此命令、期望达到什么结果。审核者需要这些信息来判断命令是否合理。",
                "好的示例：'智能体检测到 express 模块未安装导致 API 路由注册失败，执行 npm install 安装所有 package.json 声明的依赖以恢复 HTTP 服务正常启动'",
                "不好的示例：'安装依赖'、'运行命令'、'执行脚本'——这类笼统描述对审核者毫无参考价值，禁止使用。",
                "必须始终包含：问题描述 → 解决手段 → 预期结果 三个要素。"
              ].join(" ")
            }
          },
          required: ["command", "intent"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "localcmd_send_input",
        description: "向正在运行的进程发送输入（写入 stdin）。可用于与交互式程序通信。注意：通常需要在输入末尾添加换行符(\\n)才能触发程序处理。输入内容也会被记录到输出文件。",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "进程 ID（由 localcmd_spawn 返回的 processId）"
            },
            input: {
              type: "string",
              description: "要发送的输入内容。例如：'print(1+2)\\n' 或 'help\\n'。注意换行符！"
            }
          },
          required: ["processId", "input"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "localcmd_read_output",
        description: `读取指定进程输出文件的指定位置内容。使用 seek 定位到 offset 位置读取 window 大小的内容。

【核心概念】
- offset: 文件中的字节偏移位置，从 0 开始
- window: 读取的字符数（默认 5000）
- 文件是追加写入的，offset 不会随新内容而失效

【参数说明】
- processId: 进程 ID（由 localcmd_spawn 返回）
- offset: 读取起始偏移量（字节），默认 0 从文件开头读取
  * offset = 0: 从文件开头读取
  * offset = X: 从第 X 个字节开始读取
- window: 读取窗口大小（字符数），默认 5000

【返回值】
- content: 读取到的内容（UTF-8 字符串）
- offset: 实际读取的起始偏移量
- nextOffset: 下次读取的起始偏移量（等于 offset + 实际读取字节数）
- totalLength: 文件当前总长度（字节）
- hasMore: 是否还有更多内容可读（nextOffset < totalLength）

【使用场景】
1. 首次读取: offset=0，获取文件开头 5000 字符
2. 持续监控: 使用上次返回的 nextOffset 继续读取新内容
3. 读取末尾: 先通过 localcmd_get_status 或返回值中的 totalLength 获取文件大小，计算 offset

【示例流程】
第1次调用: localcmd_read_output(offset=0) → 返回 {content:"abc", offset:0, nextOffset:1000, totalLength:1500}
第2次调用: localcmd_read_output(offset=1000) → 读取位置 1000 之后的内容
如果 hasMore=false: 已读到文件末尾，有新输出后再继续读取

【注意事项】
- 文件使用 UTF-8 编码，offset 是字节偏移量不是字符数
- 每个输出行前会有 [STDOUT]、[STDERR]、[STDIN] 标记
- 文件在进程结束时自动清理`,
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "进程 ID（由 localcmd_spawn 返回）"
            },
            offset: {
              type: "integer",
              description: "读取起始偏移量（字节），默认 0 从文件开头读取",
              default: 0
            },
            window: {
              type: "integer",
              description: "读取窗口大小（字符数），默认 5000",
              default: 5000
            }
          },
          required: ["processId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "localcmd_get_status",
        description: "获取指定进程的当前状态（running/completed/error/killed）和退出码，以及输出文件路径",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "进程 ID（由 localcmd_spawn 返回）"
            }
          },
          required: ["processId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "localcmd_list",
        description: "列出当前所有管理的进程，包括运行中和已结束的",
        parameters: {
          type: "object",
          properties: {}
        }
      }
    },
    {
      type: "function",
      function: {
        name: "localcmd_kill",
        description: "强制终止指定的进程。发送 SIGTERM 信号，如果进程不响应会在 5 秒后强制 SIGKILL 终止。输出文件会被保留直到主进程退出。",
        parameters: {
          type: "object",
          properties: {
            processId: {
              type: "string",
              description: "进程 ID（由 localcmd_spawn 返回）"
            }
          },
          required: ["processId"]
        }
      }
    }
  ];
}
