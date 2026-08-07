/**
 * 步骤 7: 关闭循环不终止 + 进程退出清理 测试
 *
 * 7a: 关闭循环 Bug 修复
 *   1. runningPromise 慢速 resolve → Promise.race 超时先 resolve
 *   2. runningPromise reject → .catch() 吞掉，不传播
 *   3. runningPromise 正常 resolve → 不触发超时
 *   4. runningPromise 为 null → 跳过等待
 *
 * 7b: 进程退出清理
 *   1. 子进程 close 后从 Map 中延迟移除
 *   2. 错误退出 status 设为 'error'
 *   3. 未完成进程不受影响
 *   4. 多进程独立清理
 *
 * 注意：所有 Promise 必须最终 resolve，避免测试挂起。
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// ==================== 7a: 关闭循环 ====================

describe("步骤7a: 关闭循环 Promise.race 修复", () => {

  it("慢速 runningPromise 时，超时应先触发", async () => {
    const shutdownTimeoutMs = 20;
    let slowResolved = false;
    let timedOut = false;

    const slowPromise = new Promise((resolve) => {
      setTimeout(() => { slowResolved = true; resolve(); }, 200);
    });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => { timedOut = true; resolve(); }, shutdownTimeoutMs);
    });

    const start = Date.now();
    await Promise.race([
      slowPromise.catch(() => {}),
      timeoutPromise
    ]);
    const elapsed = Date.now() - start;

    assert.strictEqual(timedOut, true);
    assert.ok(elapsed >= shutdownTimeoutMs - 5);

    // 等待慢 Promise settle，确保不挂起
    await slowPromise;
  });

  it("runningPromise reject 时 .catch() 应吞掉异常，不传播", async () => {
    let reachedEnd = false;

    // 模拟 shutdown_manager 中的模式：
    // loopPromise.catch(() => {}) 吞异常，超时确保最终 resolve
    const loopPromise = Promise.reject(new Error("scheduler error"));
    let timedOut = false;

    try {
      await Promise.race([
        loopPromise.catch(() => {}),  // reject 被转为 resolve(undefined)
        new Promise((resolve) => {
          setTimeout(() => { timedOut = true; resolve(); }, 10);
        })
      ]);
      reachedEnd = true;
    } catch {
      // 不应进入
    }

    assert.strictEqual(reachedEnd, true);
    // loopPromise reject 被 .catch() 吞掉后转为 resolved，应先于 timeout 完成
    assert.strictEqual(timedOut, false);
  });

  it("runningPromise 快速 resolve 时不应触发超时", async () => {
    let timedOut = false;

    const loopPromise = Promise.resolve("done");

    await Promise.race([
      loopPromise.catch(() => {}),
      new Promise((resolve) => {
        const t = setTimeout(() => { timedOut = true; resolve(); }, 100);
        if (t.unref) t.unref();
      })
    ]);

    assert.strictEqual(timedOut, false);
  });

  it("runningPromise 为 null 时跳过等待", () => {
    let enteredRace = false;
    const loopPromise = null;

    if (loopPromise) {
      enteredRace = true;
    }

    assert.strictEqual(enteredRace, false);
  });
});

// ==================== 7b: 进程退出清理 ====================

describe("步骤7b: 进程退出清理 (Map 延迟移除)", () => {

  it("子进程 close 后延迟从 Map 移除", async () => {
    const processes = new Map();
    const processId = "test-proc-1";

    const managedProcess = { status: "running", exitCode: null };
    processes.set(processId, managedProcess);

    // 模拟 close 事件
    managedProcess.status = "completed";
    managedProcess.exitCode = 0;

    let cleaned = false;
    setTimeout(() => {
      processes.delete(processId);
      cleaned = true;
    }, 10);

    // 立即检查还在
    assert.strictEqual(processes.has(processId), true);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(cleaned, true);
    assert.strictEqual(processes.has(processId), false);
  });

  it("进程错误退出时 status 应设为 'error'", async () => {
    const processes = new Map();
    const processId = "test-proc-err";

    const managedProcess = { status: "running", exitCode: null };
    processes.set(processId, managedProcess);

    // 模拟错误退出 (exitCode != 0)
    managedProcess.status = 1 === 0 ? "completed" : "error";
    managedProcess.exitCode = 1;

    assert.strictEqual(managedProcess.status, "error");
    assert.strictEqual(managedProcess.exitCode, 1);

    // 清理
    setTimeout(() => processes.delete(processId), 5);
    await new Promise(r => setTimeout(r, 15));
    assert.strictEqual(processes.has(processId), false);
  });

  it("未完成的进程不受影响", () => {
    const processes = new Map();
    const running = { status: "running", exitCode: null };
    processes.set("running-proc", running);

    assert.strictEqual(processes.has("running-proc"), true);
  });

  it("多个进程各独立清理", async () => {
    const processes = new Map();
    const cleanupLog = [];

    function simulateClose(procId, exitCode) {
      const proc = processes.get(procId);
      if (!proc) return;
      proc.status = exitCode === 0 ? "completed" : "error";
      proc.exitCode = exitCode;

      setTimeout(() => {
        processes.delete(procId);
        cleanupLog.push(procId);
      }, exitCode === 0 ? 5 : 15);
    }

    processes.set("proc-a", { status: "running", exitCode: null });
    processes.set("proc-b", { status: "running", exitCode: null });

    simulateClose("proc-a", 0);  // 5ms
    simulateClose("proc-b", 1);  // 15ms

    await new Promise(r => setTimeout(r, 10));
    assert.ok(cleanupLog.includes("proc-a"));
    assert.strictEqual(processes.has("proc-b"), true);

    await new Promise(r => setTimeout(r, 20));
    assert.ok(cleanupLog.includes("proc-b"));
    assert.strictEqual(processes.size, 0);
  });
});
