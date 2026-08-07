/**
 * message_tools 模块单元测试
 *
 * 覆盖 read_agent_messages 和 search_agent_messages 的所有逻辑分支。
 * 使用 Module 插件模式的 executeToolCall 接口测试。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeTestLogger } from "../../helpers/test_logger.js";

const TRUNCATE_LENGTH = 500;

function createMockRuntime(runtimeDir) {
  const log = makeTestLogger("MessageTools");
  return {
    config: { runtimeDir },
    loggerRoot: { forModule: () => log },
    log,
  };
}

let tmpDir;
let messagesDir;
let runtime;
let module;

function writeJsonl(agentId, lines) {
  const filePath = path.join(messagesDir, `${agentId}.jsonl`);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function sampleTextMsg(index, text, opts = {}) {
  return {
    id: `msg-${index}`,
    from: "agent-src",
    to: "agent-dst",
    taskId: `task-${index % 3}`,
    payload: { text },
    createdAt: new Date(2026, 0, 1, 10, index, 0).toISOString(),
    ...opts,
  };
}

function sampleToolMsg(index, toolName, args, result, opts = {}) {
  return {
    id: `tool-msg-${index}`,
    type: "tool_call",
    from: "agent-src",
    to: "agent-src",
    taskId: `task-${index % 3}`,
    payload: { toolName, args, result },
    createdAt: new Date(2026, 0, 1, 11, index, 0).toISOString(),
    ...opts,
  };
}

describe("message_tools 模块", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-tools-test-"));
    const webDir = path.join(tmpDir, "web");
    messagesDir = path.join(webDir, "messages");
    runtime = createMockRuntime(tmpDir);

    // 动态导入模块并初始化（绕过 ModuleLoader，直接测试模块逻辑）
    const moduleUrl = `file://${path.resolve("modules/message_tools/index.js").replace(/\\/g, "/")}`;
    module = (await import(moduleUrl)).default;
    await module.init(runtime);
  });

  afterEach(async () => {
    try {
      await module.shutdown();
    } catch (_) { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ========== read_agent_messages ==========

  describe("read_agent_messages", () => {
    it("基本范围读取", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "你好"),
        sampleTextMsg(1, "世界"),
        sampleTextMsg(2, "测试"),
      ]);

      const result = await module.executeToolCall(null, "read_agent_messages", {
        agentId: "agent1",
        startIndex: 0,
        maxCount: 2,
      });

      assert.strictEqual(result.total, 3);
      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].text, "你好");
      assert.strictEqual(result.messages[1].text, "世界");
    });

    it("默认参数读取（前 50 条）", async () => {
      const msgs = [];
      for (let i = 0; i < 60; i++) {
        msgs.push(sampleTextMsg(i, `msg ${i}`));
      }
      writeJsonl("agent1", msgs);

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });

      assert.strictEqual(result.total, 60);
      assert.strictEqual(result.startIndex, 0);
      assert.strictEqual(result.count, 50);
      assert.strictEqual(result.messages.length, 50);
      assert.strictEqual(result.messages[0].text, "msg 0");
    });

    it("maxCount=200 上限截断", async () => {
      const msgs = [];
      for (let i = 0; i < 500; i++) {
        msgs.push(sampleTextMsg(i, `msg ${i}`));
      }
      writeJsonl("agent1", msgs);

      const result = await module.executeToolCall(null, "read_agent_messages", {
        agentId: "agent1",
        maxCount: 999,
      });

      assert.strictEqual(result.count, 200);
      assert.strictEqual(result.messages.length, 200);
    });

    it("不存在的智能体返回空", async () => {
      // 删除 dir 确保文件不存在
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "web", "messages"), { recursive: true });

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "nonexistent" });

      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.messages.length, 0);
      assert.strictEqual(result.count, 0);
    });

    it("startIndex 越界返回空", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "msg"),
      ]);

      const result = await module.executeToolCall(null, "read_agent_messages", {
        agentId: "agent1",
        startIndex: 10,
      });

      assert.strictEqual(result.total, 1);
      assert.strictEqual(result.messages.length, 0);
      assert.strictEqual(result.count, 0);
    });

    it("缺失必填参数 agentId 报错", async () => {
      const result = await module.executeToolCall(null, "read_agent_messages", {});
      assert.strictEqual(result.error, "missing_agent_id");
    });

    it("空文件处理", async () => {
      writeJsonl("agent1", []);
      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });
      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.count, 0);
    });

    it("消息按 createdAt 升序排序", async () => {
      const msgs = [
        { ...sampleTextMsg(99, "third"), createdAt: "2026-06-01T10:03:00.000Z" },
        { ...sampleTextMsg(99, "first"), createdAt: "2026-06-01T10:01:00.000Z" },
        { ...sampleTextMsg(99, "second"), createdAt: "2026-06-01T10:02:00.000Z" },
      ];
      writeJsonl("agent1", msgs);

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });

      assert.strictEqual(result.messages[0].text, "first");
      assert.strictEqual(result.messages[1].text, "second");
      assert.strictEqual(result.messages[2].text, "third");
    });
  });

  // ========== search_agent_messages ==========

  describe("search_agent_messages", () => {
    it("正文搜索", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "今天天气不错"),
        sampleTextMsg(1, "明天有雨"),
        sampleTextMsg(2, "后天也是晴天"),
      ]);

      const result = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "天气",
      });

      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.results[0].text, "今天天气不错");
      assert.strictEqual(result.results[0].matchField, "text");
    });

    it("工具调用字段搜索（toolName）", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "hello"),
        sampleToolMsg(1, "create_role", { name: "test" }, { ok: true }),
        sampleToolMsg(2, "send_message", { text: "hi" }, { ok: true }),
      ]);

      const result = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "create_role",
      });

      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.results[0].toolName, "create_role");
      assert.strictEqual(result.results[0].matchField, "toolName");
    });

    it("大小写敏感搜索", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "Hello World"),
      ]);

      const sensitiveResult = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "hello",
        caseSensitive: true,
      });
      assert.strictEqual(sensitiveResult.count, 0);

      const insensitiveResult = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "hello",
        caseSensitive: false,
      });
      assert.strictEqual(insensitiveResult.count, 1);
    });

    it("maxResults 上限", async () => {
      const msgs = [];
      for (let i = 0; i < 200; i++) {
        msgs.push(sampleTextMsg(i, `包含关键词 ${i}`));
      }
      writeJsonl("agent1", msgs);

      const result = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "关键词",
        maxResults: 999,
      });

      assert.strictEqual(result.count, 100);
      assert.strictEqual(result.results.length, 100);
    });

    it("无匹配返回空", async () => {
      writeJsonl("agent1", [
        sampleTextMsg(0, "你好"),
      ]);

      const result = await module.executeToolCall(null, "search_agent_messages", {
        agentId: "agent1",
        text: "不存在的内容",
      });

      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.total, 1);
    });

    it("缺失必填参数报错", async () => {
      const result1 = await module.executeToolCall(null, "search_agent_messages", { text: "test" });
      assert.strictEqual(result1.error, "missing_agent_id");

      const result2 = await module.executeToolCall(null, "search_agent_messages", { agentId: "agent1" });
      assert.strictEqual(result2.error, "missing_text");
    });
  });

  // ========== 公共逻辑 ==========

  describe("公共逻辑", () => {
    it("畸形 JSONL 行优雅跳过", async () => {
      const filePath = path.join(messagesDir, "agent1.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        JSON.stringify(sampleTextMsg(0, "正常消息")),
        "这不是JSON{broken",
        JSON.stringify(sampleTextMsg(1, "另一条正常消息")),
      ].join("\n") + "\n", "utf-8");

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });

      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.messages[0].text, "正常消息");
      assert.strictEqual(result.messages[1].text, "另一条正常消息");
    });

    it("工具调用消息包含额外字段", async () => {
      writeJsonl("agent1", [
        sampleToolMsg(0, "run_javascript", { code: "console.log(1)" }, { result: "ok" }),
      ]);

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });

      assert.strictEqual(result.messages[0].type, "tool_call");
      assert.strictEqual(result.messages[0].toolName, "run_javascript");
      assert.ok(result.messages[0].args.includes("console.log"));
      assert.ok(result.messages[0].result.includes("ok"));
    });

    it("超长 args/result 截断到 500 字符", async () => {
      const longStr = "x".repeat(1000);
      writeJsonl("agent1", [
        sampleToolMsg(0, "test_tool", { long: longStr }, { data: longStr }),
      ]);

      const result = await module.executeToolCall(null, "read_agent_messages", { agentId: "agent1" });

      assert.ok(result.messages[0].args.length <= TRUNCATE_LENGTH + "...(truncated)".length);
      assert.ok(result.messages[0].result.length <= TRUNCATE_LENGTH + "...(truncated)".length);
      assert.ok(result.messages[0].args.endsWith("...(truncated)"));
    });
  });

  // ========== 模块接口 ==========

  describe("模块接口", () => {
    it("getToolDefinitions 返回正确的 schema", () => {
      const defs = module.getToolDefinitions();
      assert.strictEqual(defs.length, 2);
      assert.strictEqual(defs[0].function.name, "read_agent_messages");
      assert.strictEqual(defs[1].function.name, "search_agent_messages");
      assert.deepStrictEqual(defs[0].function.parameters.required, ["agentId"]);
      assert.deepStrictEqual(defs[1].function.parameters.required, ["agentId", "text"]);
    });

    it("未知工具返回 error", async () => {
      const result = await module.executeToolCall(null, "nonexistent_tool", {});
      assert.strictEqual(result.error, "unknown_tool");
    });
  });
});
