/**
 * Bigfile 工具定义
 *
 * 职责：
 * - 定义所有大文件处理工具的接口规范
 * - 提供工具描述和参数定义
 * - 为大模型提供工具使用指导
 */

/**
 * 获取工具定义列表
 * @returns {Array} 工具定义数组
 */
export function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "bigfile_read",
        description:
          "字节范围读取大文件。通过 offset 和 length 参数精确控制读取范围，支持大规模文件的局部读取。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件在工作区内的相对路径" },
            offset: {
              type: "number",
              description: "读取起始偏移量（字节），默认为 0",
              default: 0
            },
            length: {
              type: "number",
              description: "读取长度（字节），默认为 500，最多返回 256KB",
              default: 500
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_get_info",
        description:
          "获取大文件的基本元数据，包括总大小、总行数、扩展名和推测的文件类型。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件在工作区内的相对路径" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_read_lines",
        description: "按行号范围读取大文件中的指定行。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件在工作区内的相对路径" },
            start_line: {
              type: "number",
              description: "起始行号（从 1 开始）"
            },
            end_line: {
              type: "number",
              description: "结束行号（包含）"
            }
          },
          required: ["path", "start_line", "end_line"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_search",
        description:
          "在大文件中搜索文本或正则表达式模式，返回匹配行及上下文行。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件在工作区内的相对路径" },
            pattern: {
              type: "string",
              description: "搜索模式（文本或正则表达式）"
            },
            is_regex: {
              type: "boolean",
              description: "是否将 pattern 视为正则表达式，默认为 false",
              default: false
            },
            max_results: {
              type: "number",
              description: "最大返回结果数，默认为 100",
              default: 100
            },
            context_lines: {
              type: "number",
              description: "每个匹配结果上下文的行数，默认为 0",
              default: 0
            }
          },
          required: ["path", "pattern"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_stats",
        description:
          "对大文件进行规则化统计，按指定规则匹配每一行，返回各规则的匹配行数和匹配率。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件在工作区内的相对路径" },
            rules: {
              type: "array",
              description: '统计规则数组，每个规则包含 name（名称）、pattern（模式）、is_regex（是否正则）',
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "规则名称" },
                  pattern: { type: "string", description: "匹配模式" },
                  is_regex: {
                    type: "boolean",
                    description: "是否正则表达式模式",
                    default: false
                  }
                },
                required: ["name", "pattern"]
              }
            },
            line_range: {
              type: "object",
              description: "可选的行号范围 {start, end}，仅统计指定范围内的行",
              properties: {
                start: { type: "number", description: "起始行号" },
                end: { type: "number", description: "结束行号" }
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
        name: "bigfile_json_tree",
        description:
          "以树形结构导航 JSON 文件，通过点分隔路径表达式访问指定节点，控制展开深度。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "JSON 文件在工作区内的相对路径" },
            path_expr: {
              type: "string",
              description:
                'JSON 点分隔路径表达式，如 "" 或 "." 表示根，\'users.0.name\' 访问嵌套属性'
            },
            max_depth: {
              type: "number",
              description: "最大展开深度，默认为 2。超过此深度的对象/数组会被替换为类型描述字符串",
              default: 2
            }
          },
          required: ["path", "path_expr"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_json_keys",
        description:
          "探索 JSON 文件中指定路径下的键名列表、数组索引范围或值的类型信息。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "JSON 文件在工作区内的相对路径" },
            path_expr: {
              type: "string",
              description:
                'JSON 点分隔路径表达式，如 "" 表示根，\'users\' 访问 users 键'
            }
          },
          required: ["path", "path_expr"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "bigfile_jsonl_filter",
        description:
          "在 JSONL（每行一个 JSON 对象）文件中按字段值过滤记录，支持嵌套字段和正则匹配。",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "JSONL 文件在工作区内的相对路径"
            },
            field: {
              type: "string",
              description: '要匹配的字段路径，如 "level" 或 "user.name"'
            },
            pattern: { type: "string", description: "匹配模式（文本或正则表达式）" },
            is_regex: {
              type: "boolean",
              description: "是否将 pattern 视为正则表达式，默认为 false",
              default: false
            },
            max_results: {
              type: "number",
              description: "最大返回记录数，默认为 50",
              default: 50
            },
            max_chars_per_record: {
              type: "number",
              description: "每条记录最大字符数（截断后），默认为 2000",
              default: 2000
            }
          },
          required: ["path", "field", "pattern"]
        }
      }
    }
  ];
}

export default getToolDefinitions;
