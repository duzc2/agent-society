/**
 * 步骤 5: setTimeout(async) → Promise 链 测试
 *
 * 验证以下场景：
 * 1. async IIFE + setTimeout Promise 链中的异常被正确捕获
 * 2. Promise 最终为 resolved 状态（不是 rejected / unhandledRejection）
 * 3. 正常的 async 操作不受影响
 * 4. 防抖取消模式正确工作
 */

import { describe, it } from "node:test";
import assert from "node:assert";

describe("步骤5: setTimeout(async) → Promise 链", () => {

  // ==================== 1. 异常被正确捕获 ====================

  it("async IIFE 内部异常应被 try-catch 捕获，不会变成 unhandledRejection", async () => {
    let errorCaught = false;
    let unhandledRejection = false;

    const rejectionHandler = () => { unhandledRejection = true; };
    process.on("unhandledRejection", rejectionHandler);

    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        throw new Error("test error inside IIFE");
      } catch {
        errorCaught = true;
      }
    })();

    // 等待 async IIFE 执行完成
    await new Promise(resolve => setTimeout(resolve, 20));
    process.removeListener("unhandledRejection", rejectionHandler);

    assert.strictEqual(errorCaught, true);
    assert.strictEqual(unhandledRejection, false);
  });

  // ==================== 2. Promise 链 resolve 而非 reject ====================

  it("async IIFE 即使内部操作失败，外层 Promise 也应 resolve", async () => {
    let resolved = false;

    const promise = (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        throw new Error("inner failure");
      } catch {
        resolved = true;
      }
    })();

    await promise.catch(() => {});
    // 即使内部抛异常，catch 块已经处理，Promise 本身不应该 reject
    assert.strictEqual(resolved, true);
  });

  // ==================== 3. 正常操作不受影响 ====================

  it("正常 async 操作应正确完成", async () => {
    let completed = false;

    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        completed = true;
      } catch {
        // 不应进入
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(completed, true);
  });

  // ==================== 4. 防抖取消模式（模拟 conversation_manager） ====================

  it("防抖取消：第二次调用应取消第一次的 pending 操作", async () => {
    /** @type {Map<string, {cancelled: boolean}>} */
    const pendingSaves = new Map();
    const executionLog = [];

    function persistConversation(agentId, label) {
      const prev = pendingSaves.get(agentId);
      if (prev) {
        prev.cancelled = true;
      }

      const entry = { cancelled: false };
      pendingSaves.set(agentId, entry);

      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (entry.cancelled) return;
          pendingSaves.delete(agentId);
          executionLog.push(label);
        } catch {
          // ignore
        }
      })();
    }

    persistConversation("agent-1", "first");
    persistConversation("agent-1", "second");

    await new Promise(resolve => setTimeout(resolve, 50));

    // "first" 应该被取消，只有 "second" 执行
    assert.strictEqual(executionLog.length, 1);
    assert.strictEqual(executionLog[0], "second");
    assert.strictEqual(pendingSaves.has("agent-1"), false);
  });

  // ==================== 5. persistConversationNow 取消 pending ====================

  it("立即保存应取消 pending 防抖", async () => {
    /** @type {Map<string, {cancelled: boolean}>} */
    const pendingSaves = new Map();
    const executionLog = [];

    function persistConversation(agentId) {
      const prev = pendingSaves.get(agentId);
      if (prev) prev.cancelled = true;

      const entry = { cancelled: false };
      pendingSaves.set(agentId, entry);

      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (entry.cancelled) return;
          pendingSaves.delete(agentId);
          executionLog.push("debounced");
        } catch { /* ignore */ }
      })();
    }

    function persistConversationNow(agentId) {
      const prev = pendingSaves.get(agentId);
      if (prev) {
        prev.cancelled = true;
        pendingSaves.delete(agentId);
      }
      executionLog.push("immediate");
    }

    persistConversation("agent-1");
    persistConversationNow("agent-1");

    await new Promise(resolve => setTimeout(resolve, 50));

    // 防抖应该被取消，只有 immediate 执行
    assert.strictEqual(executionLog.length, 1);
    assert.strictEqual(executionLog[0], "immediate");
  });

  // ==================== 6. flushAll 取消所有 pending ====================

  it("flushAll 应取消所有 pending 防抖并立即保存", async () => {
    /** @type {Map<string, {cancelled: boolean}>} */
    const pendingSaves = new Map();
    const executionLog = [];

    function persistConversation(agentId) {
      const prev = pendingSaves.get(agentId);
      if (prev) prev.cancelled = true;

      const entry = { cancelled: false };
      pendingSaves.set(agentId, entry);

      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (entry.cancelled) return;
          pendingSaves.delete(agentId);
          executionLog.push("debounced:" + agentId);
        } catch { /* ignore */ }
      })();
    }

    function flushAll() {
      for (const [agentId, entry] of pendingSaves) {
        entry.cancelled = true;
        executionLog.push("flushed:" + agentId);
      }
      pendingSaves.clear();
    }

    persistConversation("a");
    persistConversation("b");
    persistConversation("c");
    flushAll();

    await new Promise(resolve => setTimeout(resolve, 50));

    // flushAll 应该立即保存所有，debounced 回调被取消
    assert.strictEqual(executionLog.length, 3);
    assert.ok(executionLog.includes("flushed:a"));
    assert.ok(executionLog.includes("flushed:b"));
    assert.ok(executionLog.includes("flushed:c"));
    assert.strictEqual(pendingSaves.size, 0);
  });

  // ==================== 7. 内部操作异常不应影响其他 pending ====================

  it("一个 agent 的保存失败不应影响其他 agent 的 pending 保存", async () => {
    /** @type {Map<string, {cancelled: boolean}>} */
    const pendingSaves = new Map();
    const executionLog = [];

    function persistConversation(agentId, shouldFail = false) {
      const prev = pendingSaves.get(agentId);
      if (prev) prev.cancelled = true;

      const entry = { cancelled: false };
      pendingSaves.set(agentId, entry);

      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 1));
          if (entry.cancelled) return;
          pendingSaves.delete(agentId);
          if (shouldFail) throw new Error("save failed");
          executionLog.push("ok:" + agentId);
        } catch (err) {
          executionLog.push("error:" + agentId + ":" + (err?.message ?? "unknown"));
        }
      })();
    }

    persistConversation("agent-fail", true);
    persistConversation("agent-ok", false);

    await new Promise(resolve => setTimeout(resolve, 30));

    assert.ok(executionLog.includes("ok:agent-ok"));
    assert.ok(executionLog.length >= 2); // one ok + one error
  });

  // ==================== 8. 不同 agentId 的防抖互不影响 ====================

  it("不同 agentId 的防抖应独立运作", async () => {
    /** @type {Map<string, {cancelled: boolean}>} */
    const pendingSaves = new Map();
    const executionLog = [];

    function persistConversation(agentId) {
      const prev = pendingSaves.get(agentId);
      if (prev) prev.cancelled = true;

      const entry = { cancelled: false };
      pendingSaves.set(agentId, entry);

      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (entry.cancelled) return;
          pendingSaves.delete(agentId);
          executionLog.push(agentId);
        } catch { /* ignore */ }
      })();
    }

    persistConversation("agent-a");
    persistConversation("agent-b");

    await new Promise(resolve => setTimeout(resolve, 30));

    assert.strictEqual(executionLog.length, 2);
    assert.ok(executionLog.includes("agent-a"));
    assert.ok(executionLog.includes("agent-b"));
  });

  // ==================== 9. 0ms 延迟的 setTimeout 替换 ====================

  it("delayMs=0 的 async IIFE 模式应正确工作", async () => {
    let executed = false;
    let outerError = null;

    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        executed = true;
      } catch (err) {
        outerError = err;
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(executed, true);
    assert.strictEqual(outerError, null);
  });
});
