/**
 * 消息查阅模块 — 智能体互相查看对话记录
 *
 * 提供 read_agent_messages 和 search_agent_messages 两个工具。
 * 消息数据来源于 web/messages/<agentId>.jsonl（用于前端展示的完整消息日志）。
 *
 * 遵循与 get_org_structure 相同的透明度原则：任何智能体都能读取任何其他智能体的消息记录。
 */

import fs from "node:fs";
import path from "node:path";

const MAX_COUNT = 200;
const MAX_RESULTS = 100;
const TRUNCATE_LENGTH = 500;

let runtime = null;
let log = null;

function truncate(value) {
  if (typeof value !== "string") return value;
  if (value.length <= TRUNCATE_LENGTH) return value;
  return value.slice(0, TRUNCATE_LENGTH) + "...(truncated)";
}

function getMessagesDir() {
  return path.join(runtime.config.runtimeDir, "web", "messages");
}

function loadMessages(agentId) {
  const filePath = path.join(getMessagesDir(), `${agentId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      const formatted = formatMessage(msg, i);
      if (formatted) {
        messages.push(formatted);
      }
    } catch (_err) {
      void log.debug("跳过畸形 JSONL 行", {
        agentId,
        lineIndex: i,
        error: _err?.message ?? String(_err),
        line: lines[i]?.substring?.(0, 200) ?? String(lines[i])
      });
    }
  }

  // 按 createdAt 升序排序
  messages.sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0;
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  // 重新分配排序后的 index
  messages.forEach((m, idx) => { m.index = idx; });

  return messages;
}

function formatMessage(msg, index) {
  if (!msg || typeof msg !== "object") return null;

  const isToolCall = msg.type === "tool_call";
  const payload = msg.payload || {};

  return {
    index,
    id: msg.id ?? null,
    from: msg.from ?? null,
    to: msg.to ?? null,
    type: isToolCall ? "tool_call" : "text",
    text: typeof payload.text === "string" ? payload.text : null,
    reasoning_content: typeof msg.reasoning_content === "string" ? msg.reasoning_content : null,
    createdAt: msg.createdAt ?? null,
    taskId: msg.taskId ?? null,
    ...(isToolCall
      ? {
          toolName: typeof payload.toolName === "string" ? payload.toolName : null,
          args: payload.args !== undefined ? truncate(typeof payload.args === "string" ? payload.args : JSON.stringify(payload.args)) : null,
          result: payload.result !== undefined ? truncate(typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result)) : null,
        }
      : {}),
  };
}

function executeReadAgentMessages(args) {
  if (!args.agentId || typeof args.agentId !== "string") {
    return { error: "missing_agent_id", message: "缺少必需参数 agentId。请提供目标智能体ID。" };
  }

  const startIndex = typeof args.startIndex === "number" && args.startIndex >= 0
    ? args.startIndex
    : 0;
  const maxCount = Math.min(
    typeof args.maxCount === "number" && args.maxCount > 0 ? args.maxCount : 50,
    MAX_COUNT
  );

  const messages = loadMessages(args.agentId);

  void log.debug("read_agent_messages", {
    agentId: args.agentId,
    totalMessages: messages.length,
    startIndex,
    maxCount
  });

  if (messages.length === 0) {
    return { messages: [], total: 0, agentId: args.agentId, startIndex: 0, count: 0 };
  }

  if (startIndex >= messages.length) {
    return { messages: [], total: messages.length, agentId: args.agentId, startIndex, count: 0 };
  }

  const slice = messages.slice(startIndex, startIndex + maxCount);

  return {
    messages: slice,
    total: messages.length,
    agentId: args.agentId,
    startIndex,
    count: slice.length
  };
}

function executeSearchAgentMessages(args) {
  if (!args.agentId || typeof args.agentId !== "string") {
    return { error: "missing_agent_id", message: "缺少必需参数 agentId。请提供目标智能体ID。" };
  }

  if (!args.text || typeof args.text !== "string") {
    return { error: "missing_text", message: "缺少必需参数 text。请提供搜索文本。" };
  }

  const caseSensitive = Boolean(args.caseSensitive);
  const maxResults = Math.min(
    typeof args.maxResults === "number" && args.maxResults > 0 ? args.maxResults : 20,
    MAX_RESULTS
  );

  const messages = loadMessages(args.agentId);

  void log.debug("search_agent_messages", {
    agentId: args.agentId,
    totalMessages: messages.length,
    text: args.text,
    caseSensitive,
    maxResults
  });

  if (messages.length === 0) {
    return { results: [], total: 0, agentId: args.agentId, text: args.text, count: 0 };
  }

  const searchText = caseSensitive ? args.text : args.text.toLowerCase();

  const matchFields = [
    { key: "text", label: "text" },
    { key: "toolName", label: "toolName" },
    { key: "args", label: "args" },
    { key: "result", label: "result" },
    { key: "reasoning_content", label: "reasoning_content" }
  ];

  const results = [];

  for (const msg of messages) {
    if (results.length >= maxResults) break;

    for (const field of matchFields) {
      const value = msg[field.key];
      if (typeof value !== "string" || value.length === 0) continue;

      const compareValue = caseSensitive ? value : value.toLowerCase();
      if (compareValue.includes(searchText)) {
        results.push({ ...msg, matchField: field.label });
        break;
      }
    }
  }

  return {
    results,
    total: messages.length,
    agentId: args.agentId,
    text: args.text,
    count: results.length
  };
}

export default {
  name: "message_tools",

  getToolDefinitions() {
    return [
      {
        type: "function",
        function: {
          name: "read_agent_messages",
          description: "按索引范围读取指定智能体的对话记录。返回消息列表（index, id, from, to, type, text, reasoning_content, createdAt, taskId），工具调用消息额外返回 toolName, args, result（各字段截断到 500 字符）。数据来源为 web/messages/<agentId>.jsonl。",
          parameters: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "目标智能体 ID（通过 get_org_structure 获取）" },
              startIndex: { type: "number", description: "起始消息索引（0-based），默认 0" },
              maxCount: { type: "number", description: "最大返回条数，默认 50，上限 200" }
            },
            required: ["agentId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_agent_messages",
          description: "搜索指定智能体的对话记录，查找包含指定文本的消息。搜索范围：payload.text、payload.toolName、payload.args、payload.result、reasoning_content。返回匹配消息及 matchField 字段。数据来源为 web/messages/<agentId>.jsonl。",
          parameters: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "目标智能体 ID（通过 get_org_structure 获取）" },
              text: { type: "string", description: "搜索文本" },
              caseSensitive: { type: "boolean", description: "是否区分大小写，默认 false" },
              maxResults: { type: "number", description: "最大结果数，默认 20，上限 100" }
            },
            required: ["agentId", "text"]
          }
        }
      }
    ];
  },

  async init(rt) {
    runtime = rt;
    log = runtime.loggerRoot.forModule("message_tools");
    log.info("message_tools 模块初始化完成");
  },

  async executeToolCall(_ctx, toolName, args) {
    switch (toolName) {
      case "read_agent_messages":
        return executeReadAgentMessages(args);
      case "search_agent_messages":
        return executeSearchAgentMessages(args);
      default:
        return { error: "unknown_tool", toolName };
    }
  },

  async shutdown() {
    log.info("message_tools 模块关闭");
    runtime = null;
    log = null;
  }
};
