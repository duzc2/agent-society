/**
 * RuntimeEvents 模块测试
 * 测试事件系统的注册/注销/发射，4 种事件类型
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { RuntimeEvents } from "../../../src/platform/runtime/runtime_events.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

describe("RuntimeEvents", () => {
  // ==================== 构造函数 ====================

  describe("构造函数", () => {
    it("无参数创建实例（logger = null）", () => {
      const events = new RuntimeEvents();
      assert.notStrictEqual(events, undefined);
      assert.strictEqual(events.log, null);
    });

    it("传入 logger 选项", () => {
      const log = makeTestLogger("RuntimeEvents");
      const events = new RuntimeEvents({ logger: log });
      assert.strictEqual(events.log, log);
    });

    it("初始化 4 个 listeners Set", () => {
      const events = new RuntimeEvents();
      assert.ok(events._toolCallListeners instanceof Set);
      assert.ok(events._errorListeners instanceof Set);
      assert.ok(events._llmRetryListeners instanceof Set);
      assert.ok(events._computeStatusListeners instanceof Set);
    });

    it("log 属性默认为 null", () => {
      const events = new RuntimeEvents();
      assert.strictEqual(events.log, null);
    });
  });

  // ==================== ToolCall 事件 ====================

  describe("onToolCall / emitToolCall / offToolCall", () => {
    let events, log;

    beforeEach(() => {
      log = makeTestLogger("RuntimeEvents");
      events = new RuntimeEvents({ logger: log });
    });

    it("onToolCall 注册 listener → emitToolCall 触发", () => {
      let received = null;
      events.onToolCall((e) => { received = e; });
      const event = { agentId: "a1", toolName: "t1", args: {}, result: "ok", taskId: null };
      events.emitToolCall(event);
      assert.deepStrictEqual(received, event);
    });

    it("多个 listener 均被触发", () => {
      const results = [];
      events.onToolCall((e) => results.push("a:" + e.agentId));
      events.onToolCall((e) => results.push("b:" + e.agentId));
      events.emitToolCall({ agentId: "a1" });
      assert.deepStrictEqual(results, ["a:a1", "b:a1"]);
    });

    it("listener 抛错不影响其他 listener", () => {
      const results = [];
      let warned = false;
      log.warn = (msg, data) => { warned = true; };
      events.onToolCall(() => { throw new Error("boom"); });
      events.onToolCall((e) => results.push(e.agentId));
      events.emitToolCall({ agentId: "a1" });
      assert.deepStrictEqual(results, ["a1"]);
      assert.strictEqual(warned, true);
    });

    it("offToolCall 移除 listener → 不再触发", () => {
      let count = 0;
      const fn = () => { count++; };
      events.onToolCall(fn);
      events.offToolCall(fn);
      events.emitToolCall({ agentId: "a1" });
      assert.strictEqual(count, 0);
    });

    it("emitToolCall 传递所有 event 属性", () => {
      let captured = null;
      events.onToolCall((e) => { captured = e; });
      const event = { agentId: "x", toolName: "y", args: { k: 1 }, result: "r", taskId: "t1" };
      events.emitToolCall(event);
      assert.strictEqual(captured.agentId, "x");
      assert.strictEqual(captured.toolName, "y");
      assert.deepStrictEqual(captured.args, { k: 1 });
      assert.strictEqual(captured.result, "r");
      assert.strictEqual(captured.taskId, "t1");
    });
  });

  // ==================== Error 事件 ====================

  describe("onError / emitError / offError", () => {
    let events, log;

    beforeEach(() => {
      log = makeTestLogger("RuntimeEvents");
      events = new RuntimeEvents({ logger: log });
    });

    it("onError 注册 → emitError 触发", () => {
      let received = null;
      events.onError((e) => { received = e; });
      const event = { agentId: "a1", errorType: "timeout", message: "timeout", timestamp: "now" };
      events.emitError(event);
      assert.deepStrictEqual(received, event);
    });

    it("多个 error listener 均被触发", () => {
      const results = [];
      events.onError((e) => results.push(e.agentId));
      events.onError((e) => results.push(e.errorType));
      events.emitError({ agentId: "a1", errorType: "e1" });
      assert.ok(results.includes("a1"));
      assert.ok(results.includes("e1"));
    });

    it("listener 抛错隔离", () => {
      const results = [];
      let warned = false;
      log.warn = (msg, data) => { warned = true; };
      events.onError(() => { throw new Error("boom"); });
      events.onError((e) => results.push(e.agentId));
      events.emitError({ agentId: "a2" });
      assert.deepStrictEqual(results, ["a2"]);
      assert.strictEqual(warned, true);
    });

    it("offError 移除", () => {
      let count = 0;
      const fn = () => { count++; };
      events.onError(fn);
      events.offError(fn);
      events.emitError({});
      assert.strictEqual(count, 0);
    });

    it("emitError 传递 event 属性", () => {
      let captured = null;
      events.onError((e) => { captured = e; });
      const event = { agentId: "a", errorType: "e", message: "m", timestamp: "t" };
      events.emitError(event);
      assert.strictEqual(captured.agentId, "a");
      assert.strictEqual(captured.errorType, "e");
      assert.strictEqual(captured.message, "m");
      assert.strictEqual(captured.timestamp, "t");
    });
  });

  // ==================== LLM Retry 事件 ====================

  describe("onLlmRetry / emitLlmRetry / offLlmRetry", () => {
    let events, log;

    beforeEach(() => {
      log = makeTestLogger("RuntimeEvents");
      events = new RuntimeEvents({ logger: log });
    });

    it("onLlmRetry 注册 → emitLlmRetry 触发", () => {
      let received = null;
      events.onLlmRetry((e) => { received = e; });
      const event = { agentId: "a1", attempt: 1, maxRetries: 3, delayMs: 100, errorMessage: "err", timestamp: "t" };
      events.emitLlmRetry(event);
      assert.deepStrictEqual(received, event);
    });

    it("多个 listener 触发", () => {
      const results = [];
      events.onLlmRetry((e) => results.push(e.attempt));
      events.onLlmRetry((e) => results.push(e.maxRetries));
      events.emitLlmRetry({ agentId: "a", attempt: 2, maxRetries: 5 });
      assert.ok(results.includes(2));
      assert.ok(results.includes(5));
    });

    it("offLlmRetry 移除", () => {
      let count = 0;
      const fn = () => { count++; };
      events.onLlmRetry(fn);
      events.offLlmRetry(fn);
      events.emitLlmRetry({});
      assert.strictEqual(count, 0);
    });

    it("emitLlmRetry 传递 event 属性", () => {
      let captured = null;
      events.onLlmRetry((e) => { captured = e; });
      const event = { agentId: "a", attempt: 3, maxRetries: 7, delayMs: 200, errorMessage: "timeout", timestamp: "t" };
      events.emitLlmRetry(event);
      assert.strictEqual(captured.agentId, "a");
      assert.strictEqual(captured.attempt, 3);
      assert.strictEqual(captured.maxRetries, 7);
      assert.strictEqual(captured.delayMs, 200);
      assert.strictEqual(captured.errorMessage, "timeout");
    });
  });

  // ==================== ComputeStatusChange 事件 ====================

  describe("onComputeStatusChange / emitComputeStatusChange / offComputeStatusChange", () => {
    let events;

    beforeEach(() => {
      events = new RuntimeEvents();
    });

    it("onComputeStatusChange 注册 → emitComputeStatusChange 触发", () => {
      let received = null;
      events.onComputeStatusChange((e) => { received = e; });
      events.emitComputeStatusChange("a1", "processing");
      assert.strictEqual(received.agentId, "a1");
      assert.strictEqual(received.status, "processing");
      assert.notStrictEqual(received.timestamp, undefined);
      assert.strictEqual(typeof received.timestamp, "string");
    });

    it("emitComputeStatusChange 自动附加 timestamp", () => {
      let received = null;
      events.onComputeStatusChange((e) => { received = e; });
      events.emitComputeStatusChange("a1", "idle");
      assert.ok(received.timestamp);
      // timestamp 应该包含时间格式字符串
      assert.ok(/\d/.test(received.timestamp));
    });

    it("多个 listener 触发", () => {
      const results = [];
      events.onComputeStatusChange((e) => results.push(e.status));
      events.onComputeStatusChange((e) => results.push(e.agentId));
      events.emitComputeStatusChange("a1", "processing");
      assert.ok(results.includes("processing"));
      assert.ok(results.includes("a1"));
    });

    it("offComputeStatusChange 移除", () => {
      let count = 0;
      const fn = () => { count++; };
      events.onComputeStatusChange(fn);
      events.offComputeStatusChange(fn);
      events.emitComputeStatusChange("a1", "idle");
      assert.strictEqual(count, 0);
    });
  });

  // ==================== getListenerCounts ====================

  describe("getListenerCounts", () => {
    it("初始 counts 全为 0", () => {
      const events = new RuntimeEvents();
      const counts = events.getListenerCounts();
      assert.strictEqual(counts.toolCall, 0);
      assert.strictEqual(counts.error, 0);
      assert.strictEqual(counts.llmRetry, 0);
      assert.strictEqual(counts.computeStatusChange, 0);
    });

    it("注册 listener 后 counts 正确", () => {
      const events = new RuntimeEvents();
      events.onToolCall(() => {});
      events.onToolCall(() => {});
      events.onError(() => {});
      assert.strictEqual(events.getListenerCounts().toolCall, 2);
      assert.strictEqual(events.getListenerCounts().error, 1);
    });

    it("移除 listener 后 counts 递减", () => {
      const events = new RuntimeEvents();
      const fn = () => {};
      events.onToolCall(fn);
      assert.strictEqual(events.getListenerCounts().toolCall, 1);
      events.offToolCall(fn);
      assert.strictEqual(events.getListenerCounts().toolCall, 0);
    });
  });

  // ==================== removeAllListeners ====================

  describe("removeAllListeners", () => {
    it("清空所有 4 种事件类型的 listeners", () => {
      const events = new RuntimeEvents();
      events.onToolCall(() => {});
      events.onError(() => {});
      events.onLlmRetry(() => {});
      events.onComputeStatusChange(() => {});
      events.removeAllListeners();
      const counts = events.getListenerCounts();
      assert.strictEqual(counts.toolCall, 0);
      assert.strictEqual(counts.error, 0);
      assert.strictEqual(counts.llmRetry, 0);
      assert.strictEqual(counts.computeStatusChange, 0);
    });

    it("调用后 getListenerCounts 全为 0", () => {
      const events = new RuntimeEvents();
      events.onToolCall(() => {});
      events.onError(() => {});
      events.removeAllListeners();
      const counts = events.getListenerCounts();
      assert.strictEqual(counts.toolCall, 0);
      assert.strictEqual(counts.error, 0);
    });
  });

  // ==================== 边界情况 ====================

  describe("边界情况", () => {
    it("emit 到空 listeners 集合不抛错", () => {
      const events = new RuntimeEvents();
      assert.doesNotThrow(() => events.emitToolCall({ agentId: "a" }));
      assert.doesNotThrow(() => events.emitError({}));
      assert.doesNotThrow(() => events.emitLlmRetry({}));
      assert.doesNotThrow(() => events.emitComputeStatusChange("a", "idle"));
    });

    it("off 未注册的 listener 不抛错", () => {
      const events = new RuntimeEvents();
      assert.doesNotThrow(() => events.offToolCall(() => {}));
      assert.doesNotThrow(() => events.offError(() => {}));
      assert.doesNotThrow(() => events.offLlmRetry(() => {}));
      assert.doesNotThrow(() => events.offComputeStatusChange(() => {}));
    });
  });
});
