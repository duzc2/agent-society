/**
 * 消息格式转换工具
 * 
 * 负责 OpenAI 和 Anthropic 消息格式之间的双向转换
 * 
 * 格式差异：
 * - OpenAI: system 在 messages 数组中，tools 使用 tool_calls/tool 角色
 * - Anthropic: system 是独立参数，使用 content blocks (text/tool_use/tool_result)
 */

/**
 * OpenAI 消息格式
 * @typedef {Object} OpenAiMessage
 * @property {string} role - 'system' | 'user' | 'assistant' | 'tool'
 * @property {string} [content] - 消息内容
 * @property {string} [tool_call_id] - tool 消息的工具调用 ID
 * @property {Array} [tool_calls] - assistant 消息的工具调用列表
 */

/**
 * Anthropic content block
 * @typedef {Object} AnthropicContentBlock
 * @property {string} type - 'text' | 'tool_use' | 'tool_result' | 'thinking'
 * @property {string} [text] - 文本内容（type=text 时）
 * @property {string} [id] - 工具调用 ID（type=tool_use 时）
 * @property {string} [name] - 工具名称（type=tool_use 时）
 * @property {Object} [input] - 工具输入参数（type=tool_use 时）
 * @property {string} [tool_use_id] - 工具调用 ID（type=tool_result 时）
 * @property {string} [content] - 工具结果内容（type=tool_result 时）
 * @property {string} [thinking] - 思考内容（type=thinking 时）
 * @property {string} [signature] - 签名（type=thinking 时）
 */

/**
 * Anthropic 消息格式
 * @typedef {Object} AnthropicMessage
 * @property {string} role - 'user' | 'assistant'
 * @property {string|Array<AnthropicContentBlock>} content - 内容或 content blocks
 */

/**
 * Anthropic 请求参数
 * @typedef {Object} AnthropicChatParams
 * @property {string|null} system - system prompt（独立参数）
 * @property {Array<AnthropicMessage>} messages - 消息列表
 */

/**
 * 将 OpenAI 格式消息转换为 Anthropic 格式
 * 
 * 转换规则：
 * 1. system 消息提取为独立参数
 * 2. user 消息保持原样
 * 3. assistant 消息中的 tool_calls 转为 tool_use content blocks
 * 4. tool 消息转为 tool_result content blocks，并包装为 user 消息
 * 
 * @param {Array<OpenAiMessage>} openAiMessages - OpenAI 格式消息
 * @returns {AnthropicChatParams} Anthropic 格式参数
 * 
 * @example
 * // 输入
 * [{ role: "system", content: "You are helpful" }]
 * // 输出
 * { system: "You are helpful", messages: [] }
 * 
 * @example
 * // 输入 tool 消息
 * [{ role: "tool", tool_call_id: "call_123", content: '{"result": 42}' }]
 * // 输出
 * { system: null, messages: [{ 
 *   role: "user", 
 *   content: [{ type: "tool_result", tool_use_id: "call_123", content: '{"result": 42}' }]
 * }]}
 */
export function toAnthropicMessages(openAiMessages) {
  if (!Array.isArray(openAiMessages)) {
    return { system: null, messages: [] };
  }

  /** @type {string|null} */
  let system = null;
  /** @type {Array<AnthropicMessage>} */
  const messages = [];

  for (const msg of openAiMessages) {
    // 跳过无效消息
    if (!msg || typeof msg !== "object") {
      continue;
    }

    // System 消息提取为独立参数
    // Anthropic 的 system 是字符串，多个 system 消息合并
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        system = system ? `${system}\n${msg.content}` : msg.content;
      }
      continue;
    }

    // User 消息 - 保持简单格式
    if (msg.role === "user") {
      // Anthropic 支持 string 或 content blocks
      // 为简单起见，优先使用 string 格式
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        // 已经是 content blocks 格式
        messages.push({
          role: "user",
          content: msg.content,
        });
      }
      continue;
    }

    // Assistant 消息 - 需要处理 tool_calls 和 thinking blocks
    if (msg.role === "assistant") {
      /** @type {Array<AnthropicContentBlock>} */
      const content = [];

      // 保留 thinking blocks（DeepSeek 等启用了 thinking mode 的 API 要求必须回传）
      if (Array.isArray(msg._thinking) && msg._thinking.length > 0) {
        for (const tb of msg._thinking) {
          content.push({
            type: "thinking",
            thinking: tb.thinking,
            signature: tb.signature,
          });
        }
      }

      // 文本内容
      if (msg.content && typeof msg.content === "string") {
        content.push({
          type: "text",
          text: msg.content,
        });
      }

      // Tool calls 转换为 tool_use blocks
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input: safeJsonParse(tc.function?.arguments, {}),
          });
        }
      }

      messages.push({
        role: "assistant",
        content: content.length === 1 ? content[0] : content,
      });
      continue;
    }

    // Tool 消息转换为 tool_result block
    // Anthropic 要求 tool_result 必须放在 user 消息的 content 中
    if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
    }
  }

  return { system, messages };
}

/**
 * 将 Anthropic 响应转换为 OpenAI 格式
 * 
 * Anthropic 响应特点：
 * - content 是数组，包含多种类型的 blocks
 * - 可能有 text blocks 和 tool_use blocks 同时存在
 * - stop_reason 可能是 "end_turn" | "max_tokens" | "stop_sequence" | "tool_use"
 * 
 * 转换为 OpenAI 格式：
 * - content: 所有 text blocks 拼接的字符串
 * - tool_calls: 所有 tool_use blocks 转换的数组
 * - _usage: Token 使用量
 * 
 * @param {Object} anthropicResp - Anthropic API 响应
 * @param {Array} [anthropicResp.content] - Content blocks
 * @param {Object} [anthropicResp.usage] - Token 使用量
 * @returns {Object} OpenAI 格式的 message
 * 
 * @example
 * // 输入 Anthropic 响应
 * {
 *   content: [
 *     { type: "text", text: "I'll calculate that" },
 *     { type: "tool_use", id: "tool_123", name: "calculator", input: { a: 1, b: 2 } }
 *   ],
 *   usage: { input_tokens: 100, output_tokens: 50 }
 * }
 * 
 * // 输出 OpenAI 格式
 * {
 *   role: "assistant",
 *   content: "I'll calculate that",
 *   tool_calls: [{
 *     id: "tool_123",
 *     type: "function",
 *     function: { name: "calculator", arguments: '{"a":1,"b":2}' }
 *   }],
 *   _usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
 * }
 */
export function fromAnthropicResponse(anthropicResp) {
  if (!anthropicResp || !Array.isArray(anthropicResp.content)) {
    return {
      role: "assistant",
      content: null,
    };
  }

  const content = anthropicResp.content;

  // 分类 content blocks
  const textBlocks = content.filter((c) => c?.type === "text");
  const toolUseBlocks = content.filter((c) => c?.type === "tool_use");
  const thinkingBlocks = content.filter((c) => c?.type === "thinking");

  /** @type {Object} */
  const message = {
    role: "assistant",
    content: null,
  };

  // 提取文本内容
  if (textBlocks.length > 0) {
    message.content = textBlocks.map((b) => b.text).join("");
  } else if (thinkingBlocks.length > 0) {
    // text 为空但有 thinking 时，用 thinking 内容作为 text，并清空 thinking
    message.content = thinkingBlocks.map((b) => b.thinking).join("");
    thinkingBlocks.length = 0; // 清空，防止后续被保留为推理内容
  }

  // 转换 tool_use 为 OpenAI 的 tool_calls
  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map((b) => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: safeJsonStringify(b.input),
      },
    }));
  }

  // 附加 token 使用量
  const usage = anthropicResp.usage || {};
  message._usage = {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };

  // 保留 thinking blocks 以便回传给 API
  // DeepSeek 等启用了 thinking mode 的 API 要求后续请求必须包含前一轮的 thinking 块
  if (thinkingBlocks.length > 0) {
    message._thinking = thinkingBlocks.map((b) => ({
      thinking: b.thinking,
      signature: b.signature,
    }));
  }

  return message;
}

/**
 * 将 OpenAI tools 格式转换为 Anthropic tools 格式
 * 
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 * 
 * @param {Array} openAiTools - OpenAI 格式工具定义
 * @returns {Array} Anthropic 格式工具定义
 */
export function convertToolsToAnthropic(openAiTools) {
  if (!Array.isArray(openAiTools) || openAiTools.length === 0) {
    return undefined;
  }

  return openAiTools
    .filter((t) => t?.type === "function" && t.function)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

/**
 * 将 Anthropic tools 格式转换为 OpenAI tools 格式
 * 
 * @param {Array} anthropicTools - Anthropic 格式工具定义
 * @returns {Array} OpenAI 格式工具定义
 */
export function convertToolsFromAnthropic(anthropicTools) {
  if (!Array.isArray(anthropicTools)) {
    return undefined;
  }

  return anthropicTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ============ 工具函数 ============

/**
 * 安全解析 JSON
 * @param {string} str 
 * @param {*} defaultValue 
 * @returns {*}
 */
function safeJsonParse(str, defaultValue = {}) {
  if (typeof str !== "string") {
    return defaultValue;
  }
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * 安全序列化为 JSON
 * @param {*} value 
 * @param {string} defaultValue 
 * @returns {string}
 */
function safeJsonStringify(value, defaultValue = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return defaultValue;
  }
}
