/**
 * 工具 Schema 定义 — 从 tool_executor.js 提取
 * @module runtime/工具 Schema 定义
 */


export class ToolSchema {
  constructor(runtime, modelTools) {
    this.runtime = runtime;
    this.modelTools = modelTools;
  }

  getToolDefinitions() {
    const runtime = this.runtime;

    // 基础工具定义（始终可用）
    const baseTools = [
      // 岗位查找
      {
        type: "function",
        function: {
          name: "find_role_by_name",
          description: "按岗位名查找岗位，返回 role 或 null。",
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"]
          }
        }
      },
      // 岗位创建
      {
        type: "function",
        function: {
          name: "create_role",
          description: "创建岗位（Role），必须提供岗位名与岗位提示词。可选指定工具组列表，限制该岗位可用的工具函数。",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              rolePrompt: { type: "string" },
              orgPrompt: {
                type: "string",
                description: "仅用于root智能体：用于描述组织架构的提示词。若传入，将被记录在该岗位上；后续由该岗位创建的下级岗位，在未显式传入 orgPrompt 时会默认继承该值。"
              },
              toolGroups: {
                type: "array",
                items: { type: "string" },
                description: runtime._generateToolGroupsDescription?.() ?? "工具组标识符列表，限制该岗位可用的工具函数。不指定则使用全部工具组。"
              }
            },
            required: ["name", "rolePrompt"]
          }
        }
      },
      // 岗位删除
      {
        type: "function",
        function: {
          name: "delete_role",
          description: "删除岗位。只能删除自己创建的岗位。删除岗位会级联删除该岗位下的所有智能体，以及这些智能体创建的所有子岗位和子智能体。这是一个破坏性操作，请谨慎使用。",
          parameters: {
            type: "object",
            properties: {
              roleId: { type: "string", description: "要删除的岗位ID" },
              reason: { type: "string", description: "删除原因（可选）" }
            },
            required: ["roleId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_org_template_infos",
          description: "列出所有组织架构模板的简介（org/[orgName]/info.md）。只读取 info.md，不读取 org.md。",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "get_org_template_org",
          description: "按 orgName 读取组织架构模板的完整内容（org/[orgName]/org.md）。",
          parameters: {
            type: "object",
            properties: {
              orgName: { type: "string", description: "模板目录名（org/[orgName]/）" }
            },
            required: ["orgName"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_org_structure",
          description: "获取组织结构摘要（按工作空间组织区分自己与其他组织）：返回 self（当前智能体信息）、selfOrg（自己组织的岗位与智能体列表）、otherOrgs（其他组织）。每个 role 返回 agents[{id,name,status}]，status 表示该智能体当前的计算状态：idle（闲置）表示可接收新任务，processing/waiting_llm/retrying（忙碌）表示正在处理中。默认只包含未删除的智能体。agentId可以用于send_message 目标。",
          parameters: {
            type: "object",
            properties: {
              includeTerminated: {
                type: "boolean",
                description: "是否包含已删除的智能体，默认 false。",
                default: false
              }
            }
          }
        }
      },

      // 创建智能体并发送任务
      {
        type: "function",
        function: {
          name: "spawn_agent_with_task",
          description: "创建智能体实例并立即发送任务消息（二合一接口）。相当于创建智能体 + 发送消息，省去一次工具调用。推荐在需要立即分配任务时使用。",
          parameters: {
            type: "object",
            properties: {
              roleId: { type: "string", description: "岗位ID" },
              name: {
                type: "string",
                description: "智能体姓名（可选）。除非用户有要求，否则不要传递名字,让系统自动生成即可。如果用户明确要求了名字，必须使用该名字。如果你正在构建一个关系网，必须先设定名字，那么你需要设置这个参数，否则系统会随机生成一个参数，导致你的关系网不可控。"
              },
              taskBrief: {
                type: "object",
                description: "任务委托书",
                properties: {
                  objective: { type: "string" },
                  constraints: {
                    oneOf: [
                      { type: "string" },
                      { type: "array", items: { type: "string" } }
                    ]
                  },
                  inputs: { type: "string" },
                  outputs: { type: "string" },
                  completionCriteria: { type: "string" },
                  collaborators: {
                    oneOf: [
                      { type: "string", description: "单个协作者标识" },
                      { type: "array", items: { type: "object" } }
                    ]
                  },
                  references: {
                    oneOf: [
                      { type: "string", description: "单个参考资料" },
                      { type: "array", items: { type: "string" } }
                    ]
                  },
                  priority: { type: "string" }
                },
                required: ["objective", "constraints", "inputs", "outputs", "completionCriteria"]
              },
              initialMessage: {
                  type: "string",
                  description: "任务消息的纯文本内容。创建智能体后立即发送给它的第一条消息，用于说明具体任务内容、目标、交付要求等。示例：\"你的任务是访问gitee.com，遍历所有链接并截图保存。注意：使用Chrome浏览器操作，完成后向我汇报。\"",
              },
            },
            required: ["roleId", "taskBrief", "initialMessage"]
          }
        }
      },
      // 发送消息
      {
        type: "function",
        function: {
          name: "send_message",
          description: "发送异步消息。from 默认使用当前智能体 id。支持单个收件人或多个收件人。组织中存在的智能体可以作为收件人，可以通过 get_org_structure 工具获取组织结构信息来查找智能体 ID。发送消息后会立即返回，不等待消息被处理。消息会进入收件人的消息队列，等待其处理。可以通过 delayMs 参数设置延迟投递时间，支持定时提醒等场景。快速回复建议列表是可选的，收件人可以选择使用这些建议快速回复，也可以完全自定义回复内容。建议列表最多支持10个选项。优先传 payload，例如 {\"text\":\"你好\"}；也兼容直接传 message 或 text 字符串。",
          parameters: {
            type: "object",
            properties: {
              to: {
                oneOf: [
                  { type: "string", description: "单个收件人agentID" },
                  { type: "array", items: { type: "string" }, description: "收件人agentID数组" }
                ],
                description: "收件人agentID，可以是单个字符串或字符串数组"
              },
              payload: { type: "object" },
              message: {
                type: "string",
                description: "纯文本消息内容。为了兼容旧提示词，系统会自动包装成 payload.text。"
              },
              text: {
                type: "string",
                description: "纯文本消息内容。系统会自动包装成 payload.text。"
              },
              delayMs: {
                type: "number",
                description: "延迟投递时间（毫秒），消息将在指定时间后才进入收件人队列。不指定或为0则立即投递。可以用于一段时间之后的提醒，比如闹钟、计划任务等。"
              },
              quickReplies: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
                description: "可选的快速回复建议列表。这些只是建议选项，收件方可以从中选择一个快速回复，也可以完全忽略这些建议自行编写回复内容。最多10个选项。"
              }
            },
            required: ["to"]
          }
        }
      },
      // 删除智能体
      {
        type: "function",
        function: {
          name: "delete_agent",
          description: "删除指定的子智能体实例并回收资源。只能删除自己创建的子智能体。删除后该智能体的所有数据（包括对话历史、技能等）将被清理。",
          parameters: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "要删除的智能体ID" },
              reason: { type: "string", description: "删除原因（可选）" }
            },
            required: ["agentId"]
          }
        }
      },
      // JavaScript 执行
      {
        type: "function",
        function: {
          name: "run_javascript",
          description: "在完全独立干净的浏览器环境中运行 JavaScript 代码，完全隔离，无法访问任何其他页面的上下文。支持异步代码（可使用 await 和返回 Promise）。涉及严格计算/精确数值/统计/日期时间/格式转换等必须可复现的结果时，优先调用本工具用代码计算。每次调用都是全新执行环境（新标签页）。参数 input 会作为变量 input 传入代码。code 必须是脚本形式的代码，需要显式 return 一个可 JSON 序列化的值。-- 支持 Canvas 绘图功能：调用 getCanvas(path, width, height) 获取 Canvas 元素，绘图后图像会自动导出保存为工件，不必再次保存工件，函数会自动保存好文件。path 参数必选，用于指定工件在工作空间中的完整路径（可包含文件夹），必须以 .png 结尾，例如 'charts/bar-chart.png'。getCanvas 是一个独立的、完整的绘图功能，图片会自动保存，不需要下载，只要成功调用就可以了。-- 文件下载功能：调用 async downloadToWorkspace(filepath, mimeType, content) 将内容保存到工作区，filepath 是相对工作区根的子路径（不能用..向上），mimeType 是文件 MIME 类型，content 支持字符串、ArrayBuffer、TypedArray、Blob 等类型。你可以自己生成二进制或者文本内容，比如 wav mp3 mp4 png jpg js 等。-- 较大的文件必须下载下来，不要通过返回值，返回值不允许超过10k，也不支持二进制。",
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "要执行的 JavaScript 代码（函数体形式）" },
              input: { description: "传入代码的输入参数，在代码中通过 input 变量访问" }
            },
            required: ["code"]
          }
        }
      },
      // 上下文状态
      {
        type: "function",
        function: {
          name: "get_context_status",
          description: "查询当前智能体的上下文使用状态。",
          parameters: { type: "object", properties: {} }
        }
      },
      // HTTP 请求
      {
        type: "function",
        function: {
          name: "http_request",
          description: "发起 HTTPS 请求访问外部 API 或网页。仅支持 HTTPS 协议。",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "请求 URL，必须是 HTTPS 协议" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
              headers: { type: "object" },
              body: {},
              timeoutMs: { type: "number" }
            },
            required: ["url"]
          }
        }
      },
      // 文件读取
      {
        type: "function",
        function: {
          name: "file_read_lines",
          description: "按行号范围读取文件内容，避免全文撑爆上下文。返回指定行的内容数组（不含换行符）。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              start_line: { type: "number", description: "起始行号（1-based，含），默认为 1" },
              end_line: { type: "number", description: "结束行号（1-based，含），超过自动截断到末尾。默认为 500" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_search",
          description: "在单个文件内搜索字符串或正则表达式，返回匹配位置及该行的完整内容，适合精确定位后构造 edit_file 的 old_string。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              pattern: { type: "string", description: "搜索文本或正则表达式" },
              is_regex: { type: "boolean", description: "是否按正则匹配，默认为 false" },
              max_results: { type: "number", description: "最大返回结果数，默认 100" },
              context_lines: { type: "number", description: "每个匹配项返回的前后上下文行数，默认为 0" }
            },
            required: ["path", "pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_line_count",
          description: "获取文件的总行数，用于读取前了解文件规模。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_read",
          description: "按字节范围读取文件内容，支持工作区相对路径或已授权的外部绝对路径。适合需要精确 offset/length 的大文件或二进制文件读取。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              offset: { type: "number", description: "起始字节偏移，默认为 0" },
              length: { type: "number", description: "读取字节数，默认 500，最大不超过 256KB" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_info",
          description: "获取文件大小、行数和类型估算信息，不读取文件内容。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_stats",
          description: "按规则对文本文件进行流式统计，返回每个规则匹配的行数和占比。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              rules: {
                type: "array",
                description: "统计规则数组，每项包含 name、pattern，可选 is_regex",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "规则名称" },
                    pattern: { type: "string", description: "匹配文本或正则表达式" },
                    is_regex: { type: "boolean", description: "是否按正则匹配，默认 false" }
                  },
                  required: ["name", "pattern"]
                }
              },
              line_range: {
                type: "object",
                description: "可选行号范围，如 { start: 10, end: 20 }",
                properties: {
                  start: { type: "number" },
                  end: { type: "number" }
                }
              }
            },
            required: ["path", "rules"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_json_tree",
          description: "流式解析大型 JSON 文件，按路径表达式返回指定子树。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              path_expr: { type: "string", description: "点分路径表达式，如 users.0.name；空字符串或 . 表示根节点" },
              max_depth: { type: "number", description: "子树展开最大深度，默认 2" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_json_keys",
          description: "流式读取 JSON 文件，返回指定路径下的对象键名或数组索引范围。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              path_expr: { type: "string", description: "点分路径表达式，空字符串或 . 表示根节点" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_jsonl_filter",
          description: "流式扫描 JSONL 文件，按字段值过滤匹配记录。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" },
              field: { type: "string", description: "要匹配的字段路径，如 user.name" },
              pattern: { type: "string", description: "匹配文本或正则表达式" },
              is_regex: { type: "boolean", description: "是否按正则匹配，默认 false" },
              max_results: { type: "number", description: "最大返回记录数" },
              max_chars_per_record: { type: "number", description: "每条记录最大字符数" }
            },
            required: ["path", "field", "pattern"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_create_directory",
          description: "创建目录。路径支持工作区相对路径或已授权的外部绝对路径；外部路径需要目标文件夹 write=true。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              recursive: { type: "boolean", description: "是否递归创建父目录，默认 true" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "copy_file",
          description: "复制文件。相对路径表示当前智能体工作区，绝对路径表示已授权的外部路径；支持工作区与外部路径之间的任意复制。",
          parameters: {
            type: "object",
            properties: {
              sourcePath: { type: "string", description: "源文件：工作区相对路径，或已授权且 read=true 的外部绝对路径" },
              destPath: { type: "string", description: "目标文件：工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              overwrite: { type: "boolean", description: "若目标存在是否覆盖，默认 false" }
            },
            required: ["sourcePath", "destPath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_check_permission",
          description: "检查指定路径是否可访问，以及当前智能体对路径的读取和写入权限。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "file_list_authorized_folders",
          description: "列出当前智能体可访问的外部授权文件夹及其读取/写入权限。",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "在文件内精确替换指定文本。old_string 必须与文件中原始文本逐字符精确匹配（含空白和缩进）。默认要求 old_string 在文件中唯一，除非设置 replace_all。路径支持工作区相对路径或已授权的外部绝对路径；外部路径需要目标文件夹 write=true。\n\n【重要提示】\n- 必须先通过 file_read_lines 或 file_search 读取文件，确保 old_string 精确定位\n- 连续编辑时，每次 edit_file 后不需要重新读取文件，但必须确保 old_string 基于最新文件内容\n- 使用 file_search 找到目标代码后，用其返回的完整行内容作为 old_string",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              old_string: { type: "string", description: "要替换的原始文本，必须与文件中内容逐字符完全相同（含空白、缩进、换行）" },
              new_string: { type: "string", description: "替换后的新文本" },
              replace_all: { type: "boolean", description: "是否替换所有匹配项，默认 false（仅替换第一处）" }
            },
            required: ["path", "old_string", "new_string"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "replace_file",
          description: "在工作空间内创建或修改文件。路径支持工作区相对路径或已授权的外部绝对路径；外部路径需要目标文件夹 write=true。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              content: { type: "string", description: "文件内容。如果是二进制数据，请提供 Base64 编码字符串。" },
              mimeType: {
                type: "string",
                description: "文件的 MIME 类型，如 'text/javascript', 'application/json' 等，不要使用简略名称。"
              }
            },
            required: ["path", "content","mimeType"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "append_file",
          description: "向文件末尾追加内容。如果文件不存在，则创建新文件。路径支持工作区相对路径或已授权的外部绝对路径；外部路径需要目标文件夹 write=true。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              content: { type: "string", description: "要追加的内容。如果是二进制数据，请提供 Base64 编码字符串。" },
              mimeType: {
                type: "string",
                description: "文件的 MIME 类型，如 'text/javascript', 'application/json' 等，不要使用简略名称。"
              }
            },
            required: ["path", "content", "mimeType"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_files",
          description: "列出工作空间内指定目录的文件和子目录信息。路径支持工作区相对路径或已授权的外部绝对路径。",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "工作区相对路径，或已授权的外部绝对路径；默认为工作区根目录 '.'" } }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "delete_file",
          description: "删除工作空间内的指定文件。路径支持工作区相对路径或已授权的外部绝对路径；外部路径需要目标文件夹 write=true。",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "工作区相对路径，或已授权且 write=true 的外部绝对路径" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "move_file",
          description: "移动或重命名文件。路径支持工作区相对路径或已授权的外部绝对路径；支持工作区与外部路径之间的移动，外部目标需要 write=true。",
          parameters: {
            type: "object",
            properties: {
              sourcePath: { type: "string", description: "源文件路径：工作区相对路径，或已授权的外部绝对路径" },
              destPath: { type: "string", description: "目标文件路径：工作区相对路径，或已授权且 write=true 的外部绝对路径" },
              overwrite: { type: "boolean", description: "若目标存在是否覆盖，默认 false" }
            },
            required: ["sourcePath", "destPath"]
          }
        }
      },
      // 工作空间信息
      {
        type: "function",
        function: {
          name: "get_workspace_info",
          description: "获取当前工作空间的磁盘占用和文件统计信息。",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "search_text",
          description: "在工作空间的指定子文件夹内搜索文本字符串，返回匹配的文件名、行号和列号列表。路径支持工作区相对路径或已授权的外部绝对路径；外部路径为只读递归搜索，需 read=true。",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "工作区相对路径，或已授权且 read=true 的外部绝对路径"
              },
              text: {
                type: "string",
                description: "要搜索的文本字符串"
              },
              caseSensitive: {
                type: "boolean",
                description: "是否区分大小写，默认为 true"
              },
              maxResults: {
                type: "number",
                description: "最大返回结果数，默认为 1000"
              }
            },
            required: ["path", "text"]
          }
        }
      },
      // System Prompt 追加内容管理
      {
        type: "function",
        function: {
          name: "get_system_prompt_appendix",
          description: "获取当前智能体的 system prompt 追加内容列表。",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "add_system_prompt_appendix_item",
          description: "向当前智能体的 system prompt 追加内容列表新增一条记忆。",
          parameters: {
            type: "object",
            properties: {
              item: {
                type: "string",
                description: "要新增的记忆内容"
              }
            },
            required: ["item"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "remove_system_prompt_appendix_item",
          description: "按索引删除当前智能体的一条 system prompt 记忆。索引从 0 开始。",
          parameters: {
            type: "object",
            properties: {
              index: {
                type: "number",
                description: "要删除的记忆索引（从 0 开始）"
              }
            },
            required: ["index"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "update_system_prompt_appendix_item",
          description: "按索引修改当前智能体的一条 system prompt 记忆。索引从 0 开始。",
          parameters: {
            type: "object",
            properties: {
              index: {
                type: "number",
                description: "要修改的记忆索引（从 0 开始）"
              },
              content: {
                type: "string",
                description: "修改后的记忆内容"
              }
            },
            required: ["index", "content"]
          }
        }
      },
      // 合并模块提供的工具定义
      ...runtime.moduleLoader.getToolDefinitions(),
      {
        type: "function",
        function: {
          name: "load_skill_detail",
          description: "按需加载当前智能体可见技能中的文本文件。遇到与某项技能匹配的任务时，应优先先读取技能说明再执行。默认读取完整 SKILL.md；如果 SKILL.md 提到了其他相对路径文件，也可以继续读取那些文件。当前任务里同一路径文件已读取过时，不要重复读取。",
          parameters: {
            type: "object",
            properties: {
              skill: {
                type: "string",
                description: "技能名或技能唯一标识。只能填写当前提示词列出的真实可见技能。"
              },
              path: {
                type: "string",
                description: "可选，技能包内相对路径。默认读取 SKILL.md。"
              }
            },
            required: ["skill"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "run_skill_script",
          description: "执行当前智能体可见技能中 scripts/ 目录下的脚本。JS/TS 会复用系统启动时的同一 JavaScript 运行时，Python 统一使用配置或工程内 Python。CWD 为智能体组织的工作区根目录。",
          parameters: {
            type: "object",
            properties: {
              skill: {
                type: "string",
                description: "技能名或技能唯一标识。只能填写当前提示词列出的真实可见技能。"
              },
              scriptPath: {
                type: "string",
                description: "技能包内 scripts/ 目录下的相对路径。"
              },
              args: {
                type: "array",
                items: { type: "string" },
                description: "传给脚本的参数列表"
              }
            },
            required: ["skill", "scriptPath"]
          }
        }
      },
      // ========== 自定义技能管理工具 ==========
      {
        type: "function",
        function: {
          name: "skill_list",
          description: "列出所有自定义技能，返回每个技能的标识、名称、描述等信息。",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_get",
          description: "获取指定自定义技能的详情和文件树结构。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              }
            },
            required: ["skillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_create",
          description: "创建一个空白的新自定义技能。",
          parameters: {
            type: "object",
            properties: {
              displayName: {
                type: "string",
                description: "可选，技能显示名称"
              }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_copy",
          description: "从任意已有技能（包括内置技能）复制出一个新的自定义技能。",
          parameters: {
            type: "object",
            properties: {
              sourceSkillId: {
                type: "string",
                description: "源技能的标识"
              },
              displayName: {
                type: "string",
                description: "可选，新技能的显示名称，默认使用源技能名称"
              }
            },
            required: ["sourceSkillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_read_file",
          description: "读取自定义技能中单个文件的内容。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              filePath: {
                type: "string",
                description: "技能内的文件路径，如 SKILL.md 或 scripts/run.js"
              }
            },
            required: ["skillId", "filePath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_write_file",
          description: "写入或更新自定义技能中单个文件的内容。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              filePath: {
                type: "string",
                description: "技能内的文件路径，如 SKILL.md 或 scripts/run.js"
              },
              content: {
                type: "string",
                description: "文件内容"
              }
            },
            required: ["skillId", "filePath", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_create_file",
          description: "在自定义技能中创建一个新的空文件。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              filePath: {
                type: "string",
                description: "要创建的文件路径"
              }
            },
            required: ["skillId", "filePath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_create_folder",
          description: "在自定义技能中创建一个新的文件夹。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              folderPath: {
                type: "string",
                description: "要创建的文件夹路径"
              }
            },
            required: ["skillId", "folderPath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_delete_entry",
          description: "删除自定义技能中的文件或文件夹。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              entryPath: {
                type: "string",
                description: "要删除的文件或文件夹路径"
              }
            },
            required: ["skillId", "entryPath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_rename_entry",
          description: "重命名自定义技能中的文件或文件夹。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              fromPath: {
                type: "string",
                description: "原路径"
              },
              toPath: {
                type: "string",
                description: "新路径"
              }
            },
            required: ["skillId", "fromPath", "toPath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_set_status",
          description: "启用或禁用自定义技能。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              },
              status: {
                type: "string",
                enum: ["enabled", "disabled"],
                description: "启用或禁用"
              }
            },
            required: ["skillId", "status"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_delete",
          description: "删除整个自定义技能，包括所有文件。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "自定义技能的标识"
              }
            },
            required: ["skillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_bind_to_agent",
          description: "将指定技能绑定到当前智能体，使其在系统提示词中可见并可通过 load_skill_detail / run_skill_script 调用。skillId 可以是自定义技能标识（custom:custom:xxx）或已安装技能的标识（modelscope:skill:xxx）。若技能未启用，请先调用 skill_set_status 启用后再绑定。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "要绑定的技能标识。可通过 skill_list 查看自定义技能，或通过系统提示词里列出的技能标识查找。"
              },
              enabled: {
                type: "boolean",
                description: "是否启用绑定，默认 true。传入 false 效果等同于 skill_unbind_from_agent。"
              }
            },
            required: ["skillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "skill_unbind_from_agent",
          description: "从当前智能体移除指定技能的绑定，使其不再出现在系统提示词中，不再可通过 load_skill_detail / run_skill_script 调用。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "要解绑的技能标识"
              }
            },
            required: ["skillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "forget_skill",
          description: "遗忘一个已学习的技能，使其 SKILL.md 和 SYSTEM_PROMPT.md 不再常驻 system prompt。不影响技能安装/绑定状态。",
          parameters: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "要遗忘的技能标识"
              }
            },
            required: ["skillId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "add_todo_item",
          description: "向当前智能体的待办列表中添加一个待办事项。",
          parameters: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "待办事项标题"
              },
              priority: {
                type: "string",
                description: "优先级，默认 medium",
                enum: ["high", "medium", "low"]
              }
            },
            required: ["title"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_todo_items",
          description: "列出当前智能体的待办事项。可以按状态筛选。",
          parameters: {
            type: "object",
            properties: {
              status: {
                type: "string",
                description: "按状态筛选，不传则返回全部",
                enum: ["pending", "in_progress", "completed", "cancelled"]
              }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "update_todo_item",
          description: "更新当前智能体的待办事项。至少需要提供一个要更新的字段。",
          parameters: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "待办事项的 ID"
              },
              title: {
                type: "string",
                description: "新的标题"
              },
              priority: {
                type: "string",
                description: "新的优先级",
                enum: ["high", "medium", "low"]
              },
              status: {
                type: "string",
                description: "新的状态",
                enum: ["pending", "in_progress", "completed", "cancelled"]
              }
            },
            required: ["id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "delete_todo_item",
          description: "删除当前智能体待办列表中的事项。",
          parameters: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "要删除的待办事项 ID"
              }
            },
            required: ["id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "set_org_name",
          description: "设置组织的显示名称。仅 root 智能体可用。用于为新建的组织设定一个正式、描述性的名称，方便在组织列表中识别。",
          parameters: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "组织入口智能体ID（root的直接子智能体）" },
              orgName: { type: "string", description: "组织显示名称，应正式、简洁、具有描述性" }
            },
            required: ["agentId", "orgName"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_tool_groups",
          description: "列出所有可用的工具组及其包含的工具名称。返回每个工具组的 id、描述、工具数量和工具名称列表。",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "update_my_tool_groups",
          description: "更新当前智能体所在岗位的工具组配置，限制该岗位可用的工具函数。传入空数组或不传 toolGroups 参数将恢复默认（仅 org_management）。",
          parameters: {
            type: "object",
            properties: {
              toolGroups: {
                type: "array",
                items: { type: "string" },
                description: "工具组ID列表。系统会强制追加 org_management，无需手动包含。可用工具组请见系统提示中的【可用工具组列表】。"
              }
            }
          }
        }
      },
      // ===================================================================
      // 群聊工具
      // ===================================================================
      {
        type: "function",
        function: {
          name: "create_group",
          description: "创建群聊，邀请指定成员加入。群聊用于多个智能体之间持续协作和反复沟通。创建后自动向所有成员发送入群通知，通知中包含全部成员名单和拉群原因。群聊至少需要 3 名成员（memberIds 去重后至少 3 个智能体 ID，root 和 user 不能入群）。创建者不会自动加入群聊，如需自己入群请将自己的 ID 包含在 memberIds 中。",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "群名（必填）" },
              memberIds: { type: "array", items: { type: "string" }, description: "初始成员 ID 列表（必填，去重后至少 3 个；root 和 user 不能入群）" },
              description: { type: "string", description: "群描述（可选）" },
              reason: { type: "string", description: "拉群原因（必填），说明为什么要创建这个群、需要大家协作什么。会写入首条系统消息并通知所有成员。" }
            },
            required: ["name", "memberIds", "reason"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "send_group_message",
          description: "向群聊发送消息。所有群成员都能看到此消息，并可选择是否回复。群消息不需要每条都回复——请根据消息内容是否与你的职责和当前任务相关来决定是否回复。",
          parameters: {
            type: "object",
            properties: {
              groupId: { type: "string", description: "群 ID" },
              payload: { type: "object", description: "消息内容，如 { text: '...' }" }
            },
            required: ["groupId", "payload"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "invite_to_group",
          description: "邀请成员加入群聊。所有群成员都可以邀请他人加入。被邀请的成员会收到入群通知，通知中包含当前群全部成员名单和邀请原因。",
          parameters: {
            type: "object",
            properties: {
              groupId: { type: "string", description: "群 ID" },
              memberIds: { type: "array", items: { type: "string" }, description: "要邀请的成员 ID 列表" },
              reason: { type: "string", description: "邀请原因（必填），说明为什么邀请这些成员入群。会写入系统消息并通知所有群成员。" }
            },
            required: ["groupId", "memberIds", "reason"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "leave_group",
          description: "主动退出群聊。退出后不再接收该群的消息。注意：成员退出后若群内智能体成员不足 3 人，该群将被自动解散并归档，历史消息仍可查询。",
          parameters: {
            type: "object",
            properties: {
              groupId: { type: "string", description: "群 ID" }
            },
            required: ["groupId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "dissolve_group",
          description: "解散群聊。所有群成员都可以解散群。解散后所有成员将无法再向该群发送消息。",
          parameters: {
            type: "object",
            properties: {
              groupId: { type: "string", description: "群 ID" }
            },
            required: ["groupId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_group_info",
          description: "查看群的完整信息，包括成员列表（含状态）、最近消息摘要。",
          parameters: {
            type: "object",
            properties: {
              groupId: { type: "string", description: "群 ID" }
            },
            required: ["groupId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_my_groups",
          description: "列出我所在的所有群聊（基本信息）。",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      }
    ];
    return [...baseTools, ...this.modelTools._buildCapabilityToolDefinitions()];
  }
}
