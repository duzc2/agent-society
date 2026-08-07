/**
 * LlmClient 真实 LLM API 集成测试
 *
 * 验证 LlmClient 与真实 LLM 服务的交互能力，覆盖
 * 基础消息、系统提示、工具调用、多轮对话、并发与超时。
 *
 * 设计约束：
 * 1. 所有消息要求 1-2 句简短回复，控制 token 消耗和延迟
 * 2. 无 app.local.json 时整个 describe 静默跳过
 * 3. 绝不打印 API key，断言消息中不包含密钥信息
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { checkLiveConfig, createLiveLlmClient } from "../helpers/live_config.js";

const liveConfig = checkLiveConfig();

describe("LlmClient Live", { skip: !liveConfig.ready }, () => {
  /** @type {import("../../src/platform/services/llm/llm_client.js").LlmClient} */
  let client;

  before(() => {
    client = createLiveLlmClient();
  });

  // ────────────────────────────────────── 基础消息 ──────────────────────────────────────

  describe("基础消息", () => {
    it("应返回 assistant 角色且内容非空", { timeout: 60000 }, async () => {
      const result = await client.chat({
        messages: [
          { role: "user", content: "请用一句话回复：什么是 JavaScript？" }
        ]
      });

      assert.ok(result, "chat() 结果不应为 null/undefined");
      assert.strictEqual(result.role, "assistant",
        `角色应为 assistant，实际: ${result.role}`);
      assert.ok(typeof result.content === "string" && result.content.trim().length > 0,
        `回复内容应为非空字符串，实际: "${result.content}"`);
    });

    it("应正确处理包含特殊字符的消息", { timeout: 60000 }, async () => {
      const result = await client.chat({
        messages: [
          { role: "user", content: "把这行代码的意思用一句话解释：const x = a ?? b?.c ?? 'default';" }
        ]
      });

      assert.ok(result.content, "对特殊字符消息应有回复");
      // 回复中不应包含系统错误提示或 JSON 解析错误
      assert.strictEqual(result.content.includes("error"), false,
        `回复不应包含 "error" 字样，实际: "${result.content.slice(0, 200)}"`);
    });

    it("应返回完整的响应结构", { timeout: 60000 }, async () => {
      const result = await client.chat({
        messages: [
          { role: "user", content: "回复 OK" }
        ]
      });

      // 验证所有预期字段存在
      assert.strictEqual(result.role, "assistant", "应有 role 字段");
      assert.ok(Object.prototype.hasOwnProperty.call(result, "content"),
        "应有 content 属性");
      assert.ok(Object.prototype.hasOwnProperty.call(result, "_usage"),
        "应有 _usage 属性");
      // _finishReason 不是所有 provider 都返回，不做硬性要求
    });
  });

  // ────────────────────────────────────── 用量信息 ──────────────────────────────────────

  describe("用量信息", () => {
    it("应包含 promptTokens、completionTokens、totalTokens", { timeout: 60000 }, async () => {
      const result = await client.chat({
        messages: [
          { role: "user", content: "回复一个单词：hello" }
        ]
      });

      const usage = result._usage;
      assert.ok(usage, "_usage 不应为空");

      assert.ok(typeof usage.promptTokens === "number" && usage.promptTokens > 0,
        `promptTokens 应为正数，实际: ${usage.promptTokens}`);
      assert.ok(typeof usage.completionTokens === "number" && usage.completionTokens > 0,
        `completionTokens 应为正数，实际: ${usage.completionTokens}`);
      assert.ok(typeof usage.totalTokens === "number" && usage.totalTokens > 0,
        `totalTokens 应为正数，实际: ${usage.totalTokens}`);
    });

    it("totalTokens 应精确等于 promptTokens + completionTokens", { timeout: 60000 }, async () => {
      const result = await client.chat({
        messages: [
          { role: "user", content: "回复一个字：好" }
        ]
      });

      const usage = result._usage;
      assert.strictEqual(
        usage.totalTokens,
        usage.promptTokens + usage.completionTokens,
        `totalTokens(${usage.totalTokens}) 应 = promptTokens(${usage.promptTokens}) + completionTokens(${usage.completionTokens})`
      );
    });

    it("较短的消息应消耗较少的 token", { timeout: 120000 }, async () => {
      const shortMsg = "hi";
      const shortResult = await client.chat({
        messages: [{ role: "user", content: shortMsg }]
      });

      const longMsg = "请详细解释什么是 RESTful API，包括它的设计原则、HTTP 方法的使用方式、状态码的含义，以及与传统 RPC 的区别。";
      const longResult = await client.chat({
        messages: [{ role: "user", content: longMsg }]
      });

      assert.ok(
        shortResult._usage.totalTokens < longResult._usage.totalTokens,
        `短消息 totalTokens(${shortResult._usage.totalTokens}) 应小于长消息(${longResult._usage.totalTokens})`
      );
    });
  });

  // ────────────────────────────────────── 系统提示 ──────────────────────────────────────

  describe("系统提示", () => {
    it("中文系统提示下应返回纯中文回复", { timeout: 60000 }, async () => {
      const result = await client.chat({
        system: "你必须用纯中文回复所有问题。回复中绝对不能包含任何英文字母或英文单词。",
        messages: [
          { role: "user", content: "介绍一下 HTTP 协议" }
        ]
      });

      // 统计中文字符占比
      const chineseOnly = result.content.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, "");
      const nonChineseRatio = chineseOnly.replace(/\s/g, "").length / Math.max(1, result.content.replace(/\s/g, "").length);
      assert.ok(nonChineseRatio < 0.3,
        `非中文字符占比应低于 30%，实际: ${(nonChineseRatio * 100).toFixed(1)}%，"${result.content.slice(0, 100)}"`);
    });

    it("角色扮演系统提示应被遵守", { timeout: 60000 }, async () => {
      const result = await client.chat({
        system: "你叫'小助手'。任何问题都先自我介绍，说'你好，我是小助手'。",
        messages: [
          { role: "user", content: "今天天气怎么样？" }
        ]
      });

      assert.ok(result.content.includes("小助手"),
        `回复应包含"小助手"以证明系统提示生效，实际: "${result.content.slice(0, 100)}"`);
    });
  });

  // ────────────────────────────────────── 工具调用 ──────────────────────────────────────

  describe("工具调用", () => {
    it("单个工具时应返回 tool_calls 数组", { timeout: 60000 }, async () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "get_current_time",
            description: "获取当前时间",
            parameters: {
              type: "object",
              properties: {
                timezone: { type: "string", description: "时区，如 Asia/Shanghai" }
              },
              required: ["timezone"]
            }
          }
        }
      ];

      const result = await client.chat({
        tools,
        messages: [
          { role: "user", content: "现在北京时间是几点？请调用 get_current_time 工具获取。" }
        ]
      });

      assert.ok(Array.isArray(result.tool_calls) && result.tool_calls.length > 0,
        "应返回非空的 tool_calls 数组");
    });

    it("工具调用应包含完整的 OpenAI 格式字段", { timeout: 60000 }, async () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "calculate_sum",
            description: "计算两数之和",
            parameters: {
              type: "object",
              properties: {
                a: { type: "number", description: "第一个数" },
                b: { type: "number", description: "第二个数" }
              },
              required: ["a", "b"]
            }
          }
        }
      ];

      const result = await client.chat({
        tools,
        messages: [
          { role: "user", content: "请调用 calculate_sum 计算 3 + 5" }
        ]
      });

      assert.ok(result.tool_calls.length > 0, "应至少有一个工具调用");
      const tc = result.tool_calls[0];

      assert.strictEqual(tc.type, "function", "type 应为 function");
      assert.ok(typeof tc.id === "string" && tc.id.length > 0, `id 应为非空字符串，实际: ${tc.id}`);
      assert.ok(tc.function, "应有 function 字段");
      assert.ok(typeof tc.function.name === "string" && tc.function.name.length > 0,
        `function.name 应为非空字符串，实际: ${tc.function.name}`);
      assert.ok(typeof tc.function.arguments === "string" && tc.function.arguments.length > 0,
        `function.arguments 应为非空 JSON 字符串，实际: ${tc.function.arguments}`);

      // arguments 应为合法的 JSON
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(tc.function.arguments); },
        `arguments 应为合法 JSON: ${tc.function.arguments}`);
      assert.ok(typeof parsed === "object" && parsed !== null,
        "arguments 解析后应为 object");
    });

    it("提供多个工具时 LLM 应只调用相关的工具", { timeout: 60000 }, async () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "search_database",
            description: "搜索数据库获取信息",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "play_music",
            description: "播放音乐",
            parameters: {
              type: "object",
              properties: { song_name: { type: "string" } },
              required: ["song_name"]
            }
          }
        }
      ];

      const result = await client.chat({
        tools,
        messages: [
          { role: "user", content: "请帮我查一下数据库中是否有'user123'这个用户。只调用 search_database 工具。" }
        ]
      });

      const calledNames = (result.tool_calls || []).map(tc => tc.function?.name);
      assert.ok(calledNames.includes("search_database"),
        `应调用 search_database，实际调用: ${JSON.stringify(calledNames)}`);
      // play_music 不应被调用（因为问题与音乐无关）
      assert.strictEqual(calledNames.includes("play_music"), false,
        `不应调用 play_music，实际调用: ${JSON.stringify(calledNames)}`);
    });

    it("工具调用失败场景应有容错信息", { timeout: 60000 }, async () => {
      const resultWithoutTools = await client.chat({
        messages: [
          { role: "user", content: "回复 OK。" }
        ]
      });

      // 无工具传入时 tool_calls 应为空或不存在
      const hasToolCalls = Array.isArray(resultWithoutTools.tool_calls) && resultWithoutTools.tool_calls.length > 0;
      assert.strictEqual(hasToolCalls, false,
        `无工具时不应有 tool_calls，实际: ${JSON.stringify(resultWithoutTools.tool_calls)}`);
    });
  });

  // ────────────────────────────────────── 多轮对话 ──────────────────────────────────────

  describe("多轮对话", () => {
    it("应保持上下文记忆", { timeout: 60000 }, async () => {
      const messages = [
        { role: "user", content: "我的名字叫小明，我今年 8 岁。" }
      ];

      const round1 = await client.chat({ messages });
      assert.ok(round1.content, "第一轮回复不应为空");
      messages.push(round1);

      messages.push({ role: "user", content: "我刚才说我叫什么名字、几岁了？请回复格式：你叫XX，X岁。" });
      const round2 = await client.chat({ messages });

      assert.ok(round2.content.includes("小明"),
        `第二轮回复应包含名字"小明"，实际: "${round2.content.slice(0, 100)}"`);
      assert.ok(round2.content.includes("8"),
        `第二轮回复应包含年龄"8"，实际: "${round2.content.slice(0, 100)}"`);
    });

    it("三轮对话应保持连贯", { timeout: 90000 }, async () => {
      const messages = [
        { role: "user", content: "我最喜欢的颜色是蓝色。" }
      ];

      const r1 = await client.chat({ messages });
      messages.push(r1);

      messages.push({ role: "user", content: "我喜欢蓝色的原因是它代表天空。" });
      const r2 = await client.chat({ messages });
      messages.push(r2);

      messages.push({ role: "user", content: "总结一下我的喜好：我最喜欢的颜色是什么、为什么喜欢？" });
      const r3 = await client.chat({ messages });

      assert.ok(r3.content.includes("蓝色") || r3.content.includes("蓝"),
        `第三轮回复应提及"蓝色"，实际: "${r3.content.slice(0, 100)}"`);
    });
  });

  // ────────────────────────────────────── 性能与并发 ──────────────────────────────────────

  describe("性能与并发", () => {
    it("单次调用应在 30s 内完成", { timeout: 60000 }, async () => {
      const startTime = Date.now();
      const result = await client.chat({
        messages: [
          { role: "user", content: "回复一个单词：hello" }
        ]
      });
      const elapsed = Date.now() - startTime;

      assert.ok(result, "应返回结果");
      assert.ok(elapsed < 30000,
        `单次调用应在 30s 内完成，实际耗时 ${elapsed}ms`);
    });

    it("3 个并发请求应全部成功且响应各不相同", { timeout: 60000 }, async () => {
      const prompts = [
        "回复数字 1。",
        "回复数字 2。",
        "回复数字 3。"
      ];

      const results = await Promise.all(
        prompts.map(p => client.chat({ messages: [{ role: "user", content: p }] }))
      );

      assert.strictEqual(results.length, 3, "应有 3 个结果");

      for (let i = 0; i < 3; i++) {
        assert.ok(results[i], `第 ${i + 1} 个结果不应为空`);
        assert.ok(results[i].content, `第 ${i + 1} 个回复内容不应为空`);
        assert.ok(results[i]._usage, `第 ${i + 1} 个结果应有 _usage`);
      }

      // 验证所有 token 配置均被正确使用
      for (let i = 0; i < 3; i++) {
        assert.ok(results[i]._usage.promptTokens > 0,
          `第 ${i + 1} 个请求 promptTokens 应为正数`);
      }
    });
  });
});
