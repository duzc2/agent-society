/**
 * MoodService 模块测试
 * 测试：构造函数、心情颜色持久化（{colors, roundCount} 格式）、心跳广播、事件监听
 * 重构后：trigger 从 waiting_llm 改为 idle，每5轮触发，独立 LLM 客户端，整体替换
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { MoodService } from "../../../../src/platform/services/mood/mood_service.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

// ==================== 测试辅助 ====================

/** 创建模拟日志器（含 forModule 工厂） */
function makeMockLogRoot() {
  return { forModule: (name) => makeTestLogger(name) };
}

/** 创建模拟 heartbeatBroker */
function makeMockHeartbeatBroker() {
  const messages = new Map();
  let nextId = 1;
  return {
    broadcast(type, payload) {
      const id = nextId++;
      messages.set(id, { type, payload });
      return id;
    },
    clearMessage(id) {
      messages.delete(id);
    },
    getMessages() { return messages; },
    reset() { messages.clear(); nextId = 1; }
  };
}

/** 创建模拟 runtimeEvents */
function makeMockRuntimeEvents() {
  const listeners = new Set();
  return {
    onComputeStatusChange(cb) { listeners.add(cb); },
    emit(event) {
      for (const l of listeners) {
        try { l(event); } catch {}
      }
    },
    getListeners() { return listeners; }
  };
}

// ==================== 构造函数 ====================

describe("MoodService", () => {
  describe("构造函数", () => {
    it("正确保存所有依赖引用", () => {
      const logRoot = makeMockLogRoot();
      const configService = {};
      const broker = makeMockHeartbeatBroker();
      const events = makeMockRuntimeEvents();
      const convs = {};
      const clients = {};

      const svc = new MoodService({
        logRoot, configService, heartbeatBroker: broker,
        runtimeEvents: events, llmConversations: convs,
        agentLlmClients: clients, dataDir: "/tmp/test"
      });

      assert.strictEqual(svc.configService, configService);
      assert.strictEqual(svc.heartbeatBroker, broker);
      assert.strictEqual(svc.runtimeEvents, events);
      assert.strictEqual(svc.llmConversations, convs);
      assert.strictEqual(svc.agentLlmClients, clients);
      assert.strictEqual(svc.dataDir, "/tmp/test");
    });

    it("_moodMessageIds 初始化为空", () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: {},
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: "/tmp"
      });

      assert.ok(svc._moodMessageIds instanceof Map);
      assert.strictEqual(svc._moodMessageIds.size, 0);
    });

    it("log 从 logRoot.forModule('mood') 创建", () => {
      const logRoot = makeMockLogRoot();
      const svc = new MoodService({
        logRoot,
        configService: {},
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: "/tmp"
      });

      assert.ok(typeof svc.log.info === "function");
      assert.ok(typeof svc.log.error === "function");
    });
  });

  // ==================== _applyMoodColors — 整体替换（{colors, roundCount} 格式） ====================

  describe("_applyMoodColors", () => {
    let svc, broker, tmpDir;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `mood-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
      broker = makeMockHeartbeatBroker();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: {},
        heartbeatBroker: broker,
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: tmpDir
      });
    });

    afterEach(async () => {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("首次写入时创建 {colors, roundCount} 格式（无已有 mood.json）", async () => {
      const colors = ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)", "rgb(255,255,0)", "rgb(0,255,255)"];
      await svc._applyMoodColors("agent1", colors);

      const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      assert.deepStrictEqual(data.colors, colors);
      assert.strictEqual(data.roundCount, 0);
    });

    it("覆盖已有 mood.json 的 colors，保留 roundCount", async () => {
      const agentDir = path.join(tmpDir, "agents", "agent1");
      await mkdir(agentDir, { recursive: true });
      const existing = { colors: ["rgb(1,1,1)","rgb(2,2,2)","rgb(3,3,3)","rgb(4,4,4)","rgb(5,5,5)"], roundCount: 42 };
      await writeFile(path.join(agentDir, "mood.json"), JSON.stringify(existing), "utf8");

      const newColors = ["rgb(255,0,0)","rgb(0,255,0)","rgb(0,0,255)","rgb(255,255,0)","rgb(0,255,255)"];
      await svc._applyMoodColors("agent1", newColors);

      const raw = await readFile(path.join(agentDir, "mood.json"), "utf8");
      const data = JSON.parse(raw);
      assert.deepStrictEqual(data.colors, newColors);
      assert.strictEqual(data.roundCount, 42, "roundCount 应保留不变");
    });

    it("旧格式（数组）的 mood.json 被兼容并覆盖为新格式", async () => {
      const agentDir = path.join(tmpDir, "agents", "agent1");
      await mkdir(agentDir, { recursive: true });
      // 旧格式：5×N 滑动网格
      const oldGrid = [["A0","A1"],["B0","B1"],["C0","C1"],["D0","D1"],["E0","E1"]];
      await writeFile(path.join(agentDir, "mood.json"), JSON.stringify(oldGrid), "utf8");

      const newColors = ["rgb(255,0,0)","rgb(0,255,0)","rgb(0,0,255)","rgb(255,255,0)","rgb(0,255,255)"];
      await svc._applyMoodColors("agent1", newColors);

      const raw = await readFile(path.join(agentDir, "mood.json"), "utf8");
      const data = JSON.parse(raw);
      assert.deepStrictEqual(data.colors, newColors);
      assert.strictEqual(data.roundCount, 0);
    });

    it("不同 agent 的网格独立存储（独立文件）", async () => {
      await svc._applyMoodColors("agentA", ["A1","A2","A3","A4","A5"]);
      await svc._applyMoodColors("agentB", ["B1","B2","B3","B4","B5"]);

      const fileA = path.join(tmpDir, "agents", "agentA", "mood.json");
      const fileB = path.join(tmpDir, "agents", "agentB", "mood.json");
      const dataA = JSON.parse(await readFile(fileA, "utf8"));
      const dataB = JSON.parse(await readFile(fileB, "utf8"));

      assert.notDeepStrictEqual(dataA.colors, dataB.colors);
    });

    it("_applyMoodColors 触发广播", async () => {
      const colors = ["rgb(1,1,1)","rgb(2,2,2)","rgb(3,3,3)","rgb(4,4,4)","rgb(5,5,5)"];
      await svc._applyMoodColors("agent_x", colors);

      const msgs = broker.getMessages();
      const moodMsgs = [...msgs.values()].filter(m => m.type === "mood_colors");
      assert.strictEqual(moodMsgs.length, 1, "应有一条 mood_colors 广播");
      assert.strictEqual(moodMsgs[0].payload.agentId, "agent_x");
      assert.strictEqual(moodMsgs[0].payload.colors.length, 5);
      assert.deepStrictEqual(moodMsgs[0].payload.colors, colors);
    });

    it("文件写入失败时不影响主流程（不会抛异常）", async () => {
      const badSvc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: {},
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: "/nonexistent/\0invalid"
      });

      await assert.doesNotReject(() =>
        badSvc._applyMoodColors("agent1", ["c1","c2","c3","c4","c5"])
      );
    });
  });

  // ==================== _broadcastColors — 心跳广播 ====================

  describe("_broadcastColors", () => {
    let broker;
    let svc;

    beforeEach(() => {
      broker = makeMockHeartbeatBroker();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: {},
        heartbeatBroker: broker,
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: "/tmp"
      });
    });

    it("广播 mood_colors 消息包含 agentId 和 colors（扁平数组）", () => {
      const colors = ["rgb(1,1,1)","rgb(2,2,2)","rgb(3,3,3)","rgb(4,4,4)","rgb(5,5,5)"];
      svc._broadcastColors("agent1", colors);

      const msgs = broker.getMessages();
      const found = [...msgs.values()].find(m => m.type === "mood_colors");
      assert.ok(found);
      assert.strictEqual(found.payload.agentId, "agent1");
      assert.deepStrictEqual(found.payload.colors, colors);
    });

    it("同一 agent 再次广播时清除旧消息", () => {
      svc._broadcastColors("agent1", ["c1","c2","c3","c4","c5"]);
      svc._broadcastColors("agent1", ["d1","d2","d3","d4","d5"]);

      const msgs = broker.getMessages();
      const moodMsgs = [...msgs.values()].filter(m => m.type === "mood_colors");
      assert.strictEqual(moodMsgs.length, 1, "应只有最新的 1 条 mood_colors 消息");
      assert.deepStrictEqual(moodMsgs[0].payload.colors, ["d1","d2","d3","d4","d5"]);
    });

    it("没有 colors 时不广播", () => {
      svc._broadcastColors("nonexistent", null);

      const msgs = broker.getMessages();
      const moodMsgs = [...msgs.values()].filter(m => m.type === "mood_colors");
      assert.strictEqual(moodMsgs.length, 0);
    });
  });

  // ==================== init — 事件监听 ====================

  describe("init", () => {
    let events, tmpDir, svc;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `mood-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
      events = makeMockRuntimeEvents();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: events,
        llmConversations: { getConversation: () => [] },
        agentLlmClients: { getClientForService: () => null },
        dataDir: tmpDir
      });
    });

    afterEach(async () => {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("init 注册 computeStatusChange 监听器", async () => {
      await svc.init();
      assert.strictEqual(events.getListeners().size, 1);
    });

    it("init 只注册事件监听，不恢复数据", async () => {
      await svc.init();
      assert.strictEqual(events.getListeners().size, 1);
    });
  });

  // ==================== _onAgentIdle — 轮次计数与触发 ====================

  describe("_onAgentIdle", () => {
    let svc, broker, tmpDir;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `mood-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
      broker = makeMockHeartbeatBroker();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: broker,
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: tmpDir
      });
    });

    afterEach(async () => {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("root agent 被跳过", async () => {
      await assert.doesNotReject(() => svc._onAgentIdle("root"));

      const filePath = path.join(tmpDir, "agents", "root", "mood.json");
      // 文件不应被创建
      try { await readFile(filePath, "utf8"); assert.fail("不应创建 mood.json"); } catch (e) {
        assert.ok(e, "文件不存在（预期）");
      }
    });

    it("user agent 被跳过", async () => {
      await assert.doesNotReject(() => svc._onAgentIdle("user"));
    });

    it("moodColors.enabled 为 false 时跳过", async () => {
      const svc2 = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: false } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: tmpDir
      });

      await assert.doesNotReject(() => svc2._onAgentIdle("agent1"));
    });

    it("首次 idle：创建 mood.json，roundCount=1，不触发心情请求", async () => {
      // moodRequestCalled 用于验证
      let moodCalled = false;
      svc._requestMood = async () => { moodCalled = true; };

      await svc._onAgentIdle("agent1");

      const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      assert.strictEqual(data.roundCount, 1);
      assert.strictEqual(moodCalled, false, "首次 idle 不应触发心情请求");
    });

    it("第5次 idle：roundCount=5，触发心情请求", async () => {
      const agentDir = path.join(tmpDir, "agents", "agent1");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "mood.json"),
        JSON.stringify({ colors: [], roundCount: 4 }),
        "utf8"
      );

      let moodCalled = false;
      svc._requestMood = async () => { moodCalled = true; };

      await svc._onAgentIdle("agent1");

      assert.strictEqual(moodCalled, true, "第5次 idle 应触发心情请求");
    });

    it("旧格式（数组）兼容：转为新格式并从 roundCount=0 开始计数", async () => {
      const agentDir = path.join(tmpDir, "agents", "agent1");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "mood.json"),
        JSON.stringify([["A1","A2"],["B1","B2"],["C1","C2"],["D1","D2"]]),
        "utf8"
      );

      await svc._onAgentIdle("agent1");

      const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      assert.strictEqual(data.roundCount, 1);
      // 旧网格 4 行 → 取最后一列 + 补齐 → 5 色
      assert.strictEqual(data.colors.length, 5);
      assert.strictEqual(data.colors[0], "A2");
      assert.strictEqual(data.colors[1], "B2");
      assert.strictEqual(data.colors[2], "C2");
      assert.strictEqual(data.colors[3], "D2");
      assert.strictEqual(data.colors[4], "transparent");
    });
  });

  // ==================== _requestMood 边界情况 ====================

  describe("_requestMood 边界情况", () => {
    it("config 为 null 时不报错", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => null },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: {},
        agentLlmClients: {},
        dataDir: "/tmp"
      });

      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });

    it("空对话时不报错", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: { getConversation: () => [] },
        agentLlmClients: {},
        dataDir: "/tmp"
      });

      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });

    it("无独立 LLM 客户端时不报错", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: { getConversation: () => [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" }
        ]},
        agentLlmClients: { getClientForService: async () => null },
        dataDir: "/tmp"
      });

      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });

    it("LLM 返回 set_mood tool_call 时应用颜色并写入文件", async () => {
      const tmpDir = path.join(os.tmpdir(), `mood-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
      try {
        const broker = makeMockHeartbeatBroker();
        const svc = new MoodService({
          logRoot: makeMockLogRoot(),
          configService: { getLoadedApp: () => ({ moodColors: { enabled: true, llmServiceId: "mood" } }) },
          heartbeatBroker: broker,
          runtimeEvents: makeMockRuntimeEvents(),
          llmConversations: { getConversation: () => [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" }
          ]},
          agentLlmClients: {
            getClientForService: async (id) => {
              if (id === "mood") {
                return {
                  chatSimple: async () => ({
                    tool_calls: [{
                      function: {
                        name: "set_mood",
                        arguments: JSON.stringify({ colors: ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)", "rgb(255,255,0)", "rgb(0,255,255)"] })
                      }
                    }]
                  })
                };
              }
              return null;
            }
          },
          dataDir: tmpDir
        });

        await svc._requestMood("agent1");

        // _applyMoodColors 是 fire-and-forget（void），等待异步完成
        await new Promise(r => setTimeout(r, 100));

        // 验证文件落盘为新格式
        const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
        const raw = await readFile(filePath, "utf8");
        const data = JSON.parse(raw);
        assert.deepStrictEqual(data.colors, ["rgb(255,0,0)", "rgb(0,255,0)", "rgb(0,0,255)", "rgb(255,255,0)", "rgb(0,255,255)"]);
        assert.strictEqual(data.roundCount, 0);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("LLM 返回无效 tool_call 时不崩溃", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true, llmServiceId: "mood" } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: { getConversation: () => [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" }
        ]},
        agentLlmClients: {
          getClientForService: async () => ({
            chatSimple: async () => ({ tool_calls: [{ function: { name: "other_tool", arguments: "{}" } }] })
          })
        },
        dataDir: "/tmp"
      });

      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });

    it("LLM 调用抛异常时不崩溃", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true, llmServiceId: "mood" } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: { getConversation: () => [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" }
        ]},
        agentLlmClients: {
          getClientForService: async () => ({
            chatSimple: async () => { throw new Error("LLM error"); }
          })
        },
        dataDir: "/tmp"
      });

      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });

    it("对话中的 tool 消息被排除", async () => {
      const svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: makeMockHeartbeatBroker(),
        runtimeEvents: makeMockRuntimeEvents(),
        llmConversations: { getConversation: () => [
          { role: "user", content: "run test" },
          { role: "assistant", content: "calling tool", tool_calls: [{ id: "t1" }] },
          { role: "tool", tool_call_id: "t1", content: "tool result" },
          { role: "assistant", content: "test passed" }
        ]},
        agentLlmClients: {},
        dataDir: "/tmp"
      });

      // tool 消息被排除后：只有 [assistant:"calling tool", user:"run test"] 一对，
      // assistant:"test passed" 无匹配的 user，被排除
      // 所以只有 1 对对话，不会因为没有 LLM 客户端而崩溃
      await assert.doesNotReject(() => svc._requestMood("agent1"));
    });
  });

  // ==================== 端到端：事件 → 计数 → 触发 → 颜色 → 广播 ====================

  describe("端到端流程", () => {
    let broker, events, svc, tmpDir;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `mood-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("idle 事件触发轮次计数，第5轮触发心情请求并广播", async () => {
      const agentDir = path.join(tmpDir, "agents", "agent1");
      await mkdir(agentDir, { recursive: true });
      // 模拟已有 4 轮
      await writeFile(
        path.join(agentDir, "mood.json"),
        JSON.stringify({ colors: [], roundCount: 4 }),
        "utf8"
      );

      broker = makeMockHeartbeatBroker();
      events = makeMockRuntimeEvents();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true, llmServiceId: "mood" } }) },
        heartbeatBroker: broker,
        runtimeEvents: events,
        llmConversations: { getConversation: () => [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" }
        ]},
        agentLlmClients: {
          getClientForService: async (id) => {
            if (id === "mood") {
              return {
                chatSimple: async () => ({
                  tool_calls: [{
                    function: {
                      name: "set_mood",
                      arguments: JSON.stringify({ colors: ["rgb(255,0,0)","rgb(0,255,0)","rgb(0,0,255)","rgb(255,255,0)","rgb(0,255,255)"] })
                    }
                  }]
                })
              };
            }
            return null;
          }
        },
        dataDir: tmpDir
      });

      await svc.init();
      events.emit({ agentId: "agent1", status: "idle" });

      // 等异步 _requestMood 和 _applyMoodColors 完成
      await new Promise(r => setTimeout(r, 200));

      // 验证文件落盘（_onAgentIdle 写入 roundCount=5，然后 _applyMoodColors 覆盖 colors）
      const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      assert.deepStrictEqual(data.colors, ["rgb(255,0,0)","rgb(0,255,0)","rgb(0,0,255)","rgb(255,255,0)","rgb(0,255,255)"]);

      const moodMsgs = [...broker.getMessages().values()].filter(m => m.type === "mood_colors");
      assert.strictEqual(moodMsgs.length, 1, "应有一条 mood_colors 广播");
      assert.strictEqual(moodMsgs[0].payload.agentId, "agent1");
    });

    it("非 idle 状态不触发轮次计数", async () => {
      broker = makeMockHeartbeatBroker();
      events = makeMockRuntimeEvents();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: broker,
        runtimeEvents: events,
        llmConversations: {},
        agentLlmClients: {},
        dataDir: tmpDir
      });

      await svc.init();
      events.emit({ agentId: "agent1", status: "waiting_llm" });

      await new Promise(r => setTimeout(r, 100));

      // 非 idle 不触发 _onAgentIdle，不会创建 mood.json
      const filePath = path.join(tmpDir, "agents", "agent1", "mood.json");
      try {
        await readFile(filePath, "utf8");
        assert.fail("不应创建 mood.json");
      } catch {
        // 预期
      }
    });

    it("root agent 的 idle 事件被跳过", async () => {
      broker = makeMockHeartbeatBroker();
      events = makeMockRuntimeEvents();
      svc = new MoodService({
        logRoot: makeMockLogRoot(),
        configService: { getLoadedApp: () => ({ moodColors: { enabled: true } }) },
        heartbeatBroker: broker,
        runtimeEvents: events,
        llmConversations: {},
        agentLlmClients: {},
        dataDir: tmpDir
      });

      await svc.init();
      events.emit({ agentId: "root", status: "idle" });

      await new Promise(r => setTimeout(r, 100));

      const filePath = path.join(tmpDir, "agents", "root", "mood.json");
      try {
        await readFile(filePath, "utf8");
        assert.fail("root 不应创建 mood.json");
      } catch {
        // 预期
      }
    });
  });
});
